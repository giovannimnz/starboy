const { getDatabaseInstance, formatDateForMySQL } = require('../../../core/database/conexao');
const api = require('../api/rest');
const { sendTelegramMessage, formatPositionClosedMessage, formatAlertMessage } = require('../telegram/telegramBot');

/**
 * Limpa sinais órfãos e inconsistências
 */
async function cleanupOrphanSignals(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return;
    }
    
    const db = await getDatabaseInstance();
    
    // Resetar sinais em PROCESSANDO há mais de 5 minutos
    const [resetResult] = await db.query(`
      UPDATE webhook_signals 
      SET status = 'PENDING', 
          error_message = NULL,
          updated_at = NOW()
      WHERE status = 'PROCESSANDO' 
        AND conta_id = ?
        AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [accountId]);
    
    if (resetResult.affectedRows > 0) {
      console.log(`[CLEANUP] ${resetResult.affectedRows} sinais resetados para conta ${accountId}`);
    }

    // Limpar sinais com erro de "not defined"
    await db.query(`
      UPDATE webhook_signals 
      SET status = 'ERROR', 
          error_message = CONCAT(IFNULL(error_message, ''), ' | Limpo durante cleanup') 
      WHERE error_message LIKE '%not defined%' 
        AND conta_id = ?
        AND status NOT IN ('ERROR', 'CANCELED')
    `, [accountId]);

  } catch (error) {
    console.error(`[CLEANUP] Erro na limpeza de sinais órfãos para conta ${accountId}:`, error.message);
  }
}

/**
 * Força fechamento de posições detectadas como fechadas na corretora
 */
async function forceCloseGhostPositions(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    if (dbPositions.length === 0) {
      return 0;
    }
    
    // Obter posições abertas na corretora
    const exchangePositions = await getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // Posição não existe na corretora ou tem quantidade zero
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = NOW(),
              observacao = 'Fechada via cleanup - não encontrada na corretora'
          WHERE id = ?
        `, [dbPos.id]);
        
        console.log(`[CLEANUP] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[CLEANUP] Erro ao fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ VERSÃO SIMPLIFICADA: Verifica se ordem existe na corretora pelo id_externo
 * Se não existir na corretora = órfã (atualizar banco)
 */
async function cancelOrphanOrders(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    // ✅ VERIFICAR SE SISTEMA ESTÁ EM SHUTDOWN
    if (global.isShuttingDown || process.env.NODE_ENV === 'shutdown') {
      console.log(`[CLEANUP] 🛑 Sistema em shutdown - cancelando verificação de órfãs para conta ${accountId}`);
      return 0;
    }
   
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR APENAS ORDENS ATIVAS (excluir já finalizadas)
    const [activeOrders] = await db.query(`
      SELECT id_externo, simbolo, tipo_ordem_bot, quantidade, preco, status, id_posicao, orign_sig
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
        AND conta_id = ?
    `, [accountId]);

    if (activeOrders.length === 0) {
      return 0;
    }

    console.log(`[CLEANUP] 🔍 Verificando ${activeOrders.length} ordens ATIVAS para órfãs (conta ${accountId})...`);

    let orphanCount = 0;
    let preservedCount = 0;

    for (const order of activeOrders) {
      try {
        // ✅ VERIFICAR SE ORDEM EXISTE NA CORRETORA
        const orderStatus = await getOrderStatus(order.simbolo, order.id_externo, accountId);

        if (orderStatus && orderStatus.orderId) {
          const exchangeStatus = orderStatus.status;
          
          // ✅ SE STATUS MUDOU PARA FINALIZADO, MOVER IMEDIATAMENTE
          if (['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(exchangeStatus)) {
            console.log(`[CLEANUP] 🎯 Ordem ${order.id_externo} finalizada na corretora (${exchangeStatus}) - movendo...`);
            
            // Atualizar status no banco primeiro
            await db.query(`
              UPDATE ordens 
              SET status = ?, last_update = NOW()
              WHERE id_externo = ? AND conta_id = ?
            `, [exchangeStatus, order.id_externo, accountId]);
            
            // Mover automaticamente
            const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
            const moved = await autoMoveOrderOnCompletion(order.id_externo, exchangeStatus, accountId);
            
            if (moved) {
              console.log(`[CLEANUP] ✅ Ordem finalizada ${order.id_externo} movida para histórico`);
              orphanCount++; // Contar como processada
            }
            
          } else if (exchangeStatus !== order.status) {
            // ✅ SINCRONIZAR STATUS SEM MOVER
            console.log(`[CLEANUP] 🔄 Sincronizando status: ${order.status} → ${exchangeStatus}`);
            await db.query(`
              UPDATE ordens 
              SET status = ?, last_update = NOW()
              WHERE id_externo = ? AND conta_id = ?
            `, [exchangeStatus, order.id_externo, accountId]);
            preservedCount++;
          } else {
            // ✅ ORDEM OK - PRESERVAR
            preservedCount++;
          }
          
        } else {
          // ✅ ORDEM NÃO EXISTE = ÓRFÃ
          console.log(`[CLEANUP] 🗑️ Ordem órfã detectada: ${order.id_externo} - marcando como CANCELED`);
          
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', 
                last_update = NOW(),
                observacao = CONCAT(
                  IFNULL(observacao, ''), 
                  ' | Órfã - não existe na corretora'
                )
            WHERE id_externo = ? AND conta_id = ?
          `, [order.id_externo, accountId]);
          
          // ✅ MOVER ÓRFÃ PARA HISTÓRICO IMEDIATAMENTE
          const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
          const moved = await autoMoveOrderOnCompletion(order.id_externo, 'CANCELED', accountId);
          
          if (moved) {
            orphanCount++;
            console.log(`[CLEANUP] ✅ Órfã ${order.id_externo} movida para histórico`);
          }
        }

      } catch (orderError) {
        console.error(`[CLEANUP] ⚠️ Erro ao verificar ordem ${order.id_externo}:`, orderError.message);
        preservedCount++;
      }
    }

    console.log(`[CLEANUP] 📊 Resumo para conta ${accountId}:`);
    console.log(`  - Ordens processadas/movidas: ${orphanCount}`);
    console.log(`  - Ordens preservadas (ativas): ${preservedCount}`);

    return orphanCount;

  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro ao processar ordens para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO MELHORADA: Mover ordens para histórico (CANCELED + FILLED órfãs)
 */
async function moveOrdersToHistory(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR ORDENS PARA MOVER (CANCELED + FILLED órfãs)
    const [ordersToMove] = await db.query(`
      SELECT o.*, p.status as position_status FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.conta_id = ? 
        AND (
          (o.status = 'CANCELED' AND o.last_update > DATE_SUB(NOW(), INTERVAL 1 MINUTE))
          OR 
          (o.status = 'FILLED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < DATE_SUB(NOW(), INTERVAL 1 MINUTE))
          OR 
          (o.status = 'EXPIRED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < DATE_SUB(NOW(), INTERVAL 1 MINUTE))
        )
    `, [accountId]);
    
    if (ordersToMove.length === 0) {
      return 0;
    }
    
    const canceledOrders = ordersToMove.filter(o => o.status === 'CANCELED');
    const orphanFilledOrders = ordersToMove.filter(o => o.status === 'FILLED');
    
    console.log(`[CLEANUP] 📚 Movendo para histórico:`);
    console.log(`  - ${canceledOrders.length} ordens CANCELED`);
    console.log(`  - ${orphanFilledOrders.length} ordens FILLED órfãs`);
    
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // ✅ VERIFICAR SE TABELA DESTINO TEM COLUNAS NECESSÁRIAS
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
      let movedCount = 0;
      
      for (const order of ordersToMove) {
        // ✅ PREPARAR DADOS PARA INSERÇÃO
        const insertData = {
          tipo_ordem: order.tipo_ordem,
          preco: order.preco,
          quantidade: order.quantidade,
          id_posicao: order.id_posicao,
          status: order.status,
          data_hora_criacao: order.data_hora_criacao ? formatDateForMySQL(new Date(order.data_hora_criacao)) : null,
          id_externo: order.id_externo,
          side: order.side,
          simbolo: order.simbolo,
          tipo_ordem_bot: order.tipo_ordem_bot,
          target: order.target,
          reduce_only: order.reduce_only,
          close_position: order.close_position,
          last_update: order.last_update ? formatDateForMySQL(new Date(order.last_update)) : formatDateForMySQL(new Date()),
          conta_id: order.conta_id,
          preco_executado: order.preco_executado || 0,
          quantidade_executada: order.quantidade_executada || 0,
          observacao: order.observacao || 
            (order.status === 'CANCELED' ? 'Movida via cleanup - órfã' : 'Movida automaticamente - posição fechada'),
          orign_sig: order.orign_sig,
          dados_originais_ws: order.dados_originais_ws ? 
            (typeof order.dados_originais_ws === 'string' ? order.dados_originais_ws : JSON.stringify(order.dados_originais_ws)) : null
        };
        
        // ✅ SANITIZAR DADOS COMPLETOS
        const sanitizedData = sanitizeObjectForMySQL(insertData);
        
        // ✅ FILTRAR APENAS CAMPOS EXISTENTES
        const validData = {};
        Object.keys(sanitizedData).forEach(key => {
          if (destColumnNames.includes(key) && sanitizedData[key] !== undefined) {
            validData[key] = sanitizedData[key];
          }
        });

        const columns = Object.keys(validData);
        const values = Object.values(validData);
        const placeholders = columns.map(() => '?').join(', ');
        
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        
        await connection.query(
          'DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?',
          [order.id_externo, accountId]
        );
        
        movedCount++;
      }
      
      await connection.commit();
      console.log(`[CLEANUP] ✅ ${movedCount} ordens movidas para histórico com sucesso`);
      
      return movedCount;
      
    } catch (moveError) {
      await connection.rollback();
      console.error(`[CLEANUP] ❌ Erro ao mover ordens para histórico:`, moveError.message);
      throw moveError;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro na função moveOrdersToHistory:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO SUPER ROBUSTA: Sanitizar valores para MySQL
 */
function sanitizeValueForMySQL(value) {
  // 1. Casos null/undefined
  if (value === null || value === undefined) {
    return null;
  }
  
  // 2. Verificar se tem método toString válido
  if (value && typeof value.toString !== 'function') {
    console.warn(`[CLEANUP] ⚠️ Valor sem toString válido, convertendo para null:`, typeof value);
    return null;
  }
  
  // 3. Date objects
  if (value instanceof Date) {
    if (isNaN(value.getTime())) {
      console.warn(`[CLEANUP] ⚠️ Data inválida detectada, convertendo para null`);
      return null;
    }
    return formatDateForMySQL(value);
  }
  
  // 4. Objetos (mas não Date)
  if (typeof value === 'object' && value !== null) {
    try {
      // Tentar JSON.stringify
      const jsonString = JSON.stringify(value);
      if (jsonString === '{}' || jsonString === '[]') {
        return null; // Objetos/arrays vazios
      }
      return jsonString;
    } catch (jsonError) {
      console.warn(`[CLEANUP] ⚠️ Erro ao serializar objeto:`, jsonError.message);
      return null;
    }
  }
  
  // 5. Tipos problemáticos
  if (typeof value === 'function' || typeof value === 'symbol') {
    console.warn(`[CLEANUP] ⚠️ Tipo problemático detectado (${typeof value}), convertendo para null`);
    return null;
  }
  
  // 6. BigInt
  if (typeof value === 'bigint') {
    try {
      return value.toString();
    } catch (bigintError) {
      console.warn(`[CLEANUP] ⚠️ Erro ao converter BigInt:`, bigintError.message);
      return null;
    }
  }
  
  // 7. Verificação final para strings muito grandes
  if (typeof value === 'string' && value.length > 65535) {
    console.warn(`[CLEANUP] ⚠️ String muito grande (${value.length} chars), truncando...`);
    return value.substring(0, 65535);
  }
  
  // 8. Para números, verificar se são válidos
  if (typeof value === 'number') {
    if (isNaN(value) || !isFinite(value)) {
      console.warn(`[CLEANUP] ⚠️ Número inválido detectado (${value}), convertendo para null`);
      return null;
    }
  }
  
  // 9. Teste final de toString
  try {
    const stringValue = String(value);
    if (stringValue === '[object Object]') {
      console.warn(`[CLEANUP] ⚠️ Objeto sem serialização adequada detectado, convertendo para null`);
      return null;
    }
    return value;
  } catch (toStringError) {
    console.warn(`[CLEANUP] ⚠️ Erro final ao converter para string:`, toStringError.message);
    return null;
  }
}

/**
 * ✅ FUNÇÃO MELHORADA: Sanitizar objeto completo para inserção no MySQL
 * @param {Object} obj - Objeto a ser sanitizado
 * @returns {Object} - Objeto sanitizado
 */
function sanitizeObjectForMySQL(obj) {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }
  
  const sanitizedObj = {};
  
  for (const [key, value] of Object.entries(obj)) {
    try {
      sanitizedObj[key] = sanitizeValueForMySQL(value);
    } catch (sanitizeError) {
      console.error(`[CLEANUP] ❌ Erro ao sanitizar campo '${key}' (valor: ${typeof value}):`, sanitizeError.message);
      sanitizedObj[key] = null; // Valor seguro em caso de erro
    }
  }
  
  return sanitizedObj;
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Mover posição para histórico com debug completo
 */
async function movePositionToHistory(db, positionId, status = 'CLOSED', reason = 'Movida automaticamente', accountId) {
  let connection;
  
  try {
    console.log(`[MOVE_POSITION] 📚 Iniciando processo para posição ${positionId} (conta ${accountId})...`);
    
    // Debugging intensivo
    console.log(`[MOVE_POSITION] 🔍 PARÂMETROS RECEBIDOS:`);
    console.log(`  - positionId: ${positionId} (${typeof positionId})`);
    console.log(`  - status: ${status} (${typeof status})`);
    console.log(`  - reason: ${reason} (${typeof reason})`);
    console.log(`  - accountId: ${accountId} (${typeof accountId})`);
    
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Primeiro obter apenas o ID e símbolo (consulta mínima)
    const [basicPositionResult] = await connection.query(
      'SELECT id, simbolo FROM posicoes WHERE id = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    if (basicPositionResult.length === 0) {
      console.log(`[MOVE_POSITION] ⚠️ Posição ${positionId} não encontrada para conta ${accountId}`);
      await connection.rollback();
      return false;
    }
    
    // Usar apenas o símbolo, que é seguro
    const symbol = basicPositionResult[0].simbolo || 'UNKNOWN';
    console.log(`[MOVE_POSITION] 📋 Processando posição ${symbol} (ID: ${positionId})`);
    
    // 2. Obter apenas IDs das ordens relacionadas (sem dados complexos)
    const [orderIdsResult] = await connection.query(
      'SELECT id FROM ordens WHERE id_posicao = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    // 3. Processar cada ordem INDIVIDUALMENTE com try/catch separado
    if (orderIdsResult.length > 0) {
      console.log(`[MOVE_POSITION] 📋 Processando ${orderIdsResult.length} ordens relacionadas...`);
      
      for (const orderIdRow of orderIdsResult) {
        try {
          const orderId = orderIdRow.id;
          
          // 3.1 Primeiro copiamos apenas campos PRIMITIVOS para histórico
          await connection.query(`
            INSERT INTO ordens_fechadas 
            (tipo_ordem, preco, quantidade, id_posicao, status, id_externo, 
             side, simbolo, tipo_ordem_bot, last_update, conta_id, observacao)
            SELECT 
              IFNULL(tipo_ordem, 'UNKNOWN') as tipo_ordem, 
              IFNULL(preco, 0) as preco, 
              IFNULL(quantidade, 0) as quantidade,
              id_posicao,
              'CANCELED' as status,
              IFNULL(id_externo, '0') as id_externo,
              IFNULL(side, 'UNKNOWN') as side,
              IFNULL(simbolo, ?) as simbolo,
              IFNULL(tipo_ordem_bot, 'UNKNOWN') as tipo_ordem_bot,
              NOW() as last_update,
              ? as conta_id,
              'Movida durante fechamento da posição (Safe Mode)' as observacao
            FROM ordens WHERE id = ? AND conta_id = ?
          `, [symbol, accountId, orderId, accountId]);
          
          console.log(`[MOVE_POSITION] ✅ Ordem ${orderId} movida para histórico (modo seguro)`);
        } catch (orderError) {
          console.error(`[MOVE_POSITION] ⚠️ Erro ao processar ordem ${orderIdRow.id}:`, orderError.message);
          // Continuar processando outras ordens
        }
      }
      
      // 3.2 Deletar todas as ordens
      await connection.query(
        'DELETE FROM ordens WHERE id_posicao = ? AND conta_id = ?', 
        [positionId, accountId]
      );
      console.log(`[MOVE_POSITION] ✅ Ordens removidas da tabela ativa`);
    }
    
    // 4. USAR MÉTODO ULTRA-SEGURO PARA POSIÇÃO: Consulta direta com SELECT...INSERT
    try {
      // 4.1 Verificar se a tabela destino tem as colunas necessárias
      const [colsResult] = await connection.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = DATABASE() 
        AND table_name = 'posicoes_fechadas'
        AND column_name IN ('simbolo', 'quantidade', 'preco_medio', 'status', 'side', 
                          'leverage', 'preco_entrada', 'preco_corrente', 'conta_id', 'observacoes')
      `);
      
      if (colsResult.length < 5) {
        throw new Error(`Tabela posicoes_fechadas não tem colunas necessárias (${colsResult.length} encontradas)`);
      }
      
      // 4.2 Método ultra-seguro: Inserir usando SQL puro sem objetos complexos
      await connection.query(`
        INSERT INTO posicoes_fechadas 
        (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
         side, leverage, preco_entrada, preco_corrente, conta_id, observacoes)
        SELECT 
          ?, -- simbolo (valor seguro)
          IFNULL(quantidade, 0), -- quantidade com fallback seguro
          IFNULL(preco_medio, 0), -- preço médio com fallback
          ?, -- status (parâmetro)
          IFNULL(data_hora_abertura, NOW()), -- data abertura
          NOW(), -- data fechamento (agora)
          IFNULL(side, ''), -- side
          IFNULL(leverage, 1), -- leverage
          IFNULL(preco_entrada, 0), -- preço entrada
          IFNULL(preco_corrente, 0), -- preço corrente
          ?, -- conta_id (parâmetro)
          ? -- observações (com reason)
        FROM posicoes 
        WHERE id = ? AND conta_id = ?
        LIMIT 1
      `, [
        symbol, // símbolo (já validado)
        status, // status
        accountId, // conta_id
        `Posição fechada. ${reason || ''}`.trim(), // observações
        positionId, // filtro: id 
        accountId // filtro: conta_id
      ]);
      
      console.log(`[MOVE_POSITION] ✅ Posição ${symbol} inserida no histórico com método ultra-seguro`);
    } catch (positionInsertError) {
      console.error(`[MOVE_POSITION] ❌ Erro ao inserir posição no histórico (modo seguro):`, positionInsertError.message);
      
      // ÚLTIMA TENTATIVA: inserção manual com valores estáticos
      try {
        console.log(`[MOVE_POSITION] 🔄 Tentando inserção de emergência com valores hardcoded...`);
        
        await connection.query(`
          INSERT INTO posicoes_fechadas 
          (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
           side, leverage, preco_entrada, preco_corrente, conta_id, observacoes)
          VALUES (?, 0, 0, ?, NOW(), NOW(), '', 1, 0, 0, ?, ?)
        `, [
          symbol,
          status,
          accountId,
          `Inserção de emergência - posição ${positionId}. ${reason}`
        ]);
        
        console.log(`[MOVE_POSITION] ✅ Posição ${symbol} inserida com método de emergência`);
      } catch (emergencyError) {
        console.error(`[MOVE_POSITION] ❌ Até mesmo a inserção de emergência falhou:`, emergencyError.message);
        throw emergencyError;
      }
    }
    
    // 5. Remover posição original
    await connection.query(
      'DELETE FROM posicoes WHERE id = ? AND conta_id = ?', 
      [positionId, accountId]
    );
    console.log(`[MOVE_POSITION] ✅ Posição removida da tabela ativa`);
    
    await connection.commit();
    console.log(`[MOVE_POSITION] ✅ Posição ${symbol} (ID: ${positionId}) movida com sucesso`);
    
    return true;
    
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`[MOVE_POSITION] ❌ Erro ao mover posição ${positionId}:`, error.message);
    console.error(`[MOVE_POSITION] Stack trace:`, error.stack);
    return false;
  } finally {
    if (connection) connection.release();
  }
}

// ✅ ATUALIZAR moveOrdersToHistory também
async function moveOrdersToHistory(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    const [ordersToMove] = await db.query(`
      SELECT o.*, p.status as position_status FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.conta_id = ? 
        AND (
          (o.status = 'CANCELED' AND o.last_update > DATE_SUB(NOW(), INTERVAL 1 MINUTE))
          OR 
          (o.status = 'FILLED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < DATE_SUB(NOW(), INTERVAL 1 MINUTE))
          OR 
          (o.status = 'EXPIRED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < DATE_SUB(NOW(), INTERVAL 1 MINUTE))
        )
    `, [accountId]);
    
    if (ordersToMove.length === 0) {
      return 0;
    }
    
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
      let movedCount = 0;
      
      for (const order of ordersToMove) {
        // ✅ PREPARAR DADOS COM SANITIZAÇÃO
        const insertData = {
          tipo_ordem: order.tipo_ordem,
          preco: order.preco,
          quantidade: order.quantidade,
          id_posicao: order.id_posicao,
          status: order.status,
          data_hora_criacao: order.data_hora_criacao ? formatDateForMySQL(new Date(order.data_hora_criacao)) : null,
          id_externo: order.id_externo,
          side: order.side,
          simbolo: order.simbolo,
          tipo_ordem_bot: order.tipo_ordem_bot,
          target: order.target,
          reduce_only: order.reduce_only,
          close_position: order.close_position,
          last_update: order.last_update ? formatDateForMySQL(new Date(order.last_update)) : formatDateForMySQL(new Date()),
          conta_id: order.conta_id,
          preco_executado: order.preco_executado || 0,
          quantidade_executada: order.quantidade_executada || 0,
          observacao: order.observacao || 
            (order.status === 'CANCELED' ? 'Movida via cleanup - órfã' : 'Movida automaticamente - posição fechada'),
          orign_sig: order.orign_sig,
          dados_originais_ws: order.dados_originais_ws ? 
            (typeof order.dados_originais_ws === 'string' ? order.dados_originais_ws : JSON.stringify(order.dados_originais_ws)) : null
        };
        
        // ✅ SANITIZAR DADOS COMPLETOS
        const sanitizedData = sanitizeObjectForMySQL(insertData);
        
        // ✅ FILTRAR APENAS CAMPOS EXISTENTES
        const validData = {};
        Object.keys(sanitizedData).forEach(key => {
          if (destColumnNames.includes(key) && sanitizedData[key] !== undefined) {
            validData[key] = sanitizedData[key];
          }
        });

        const columns = Object.keys(validData);
        const values = Object.values(validData);
        const placeholders = columns.map(() => '?').join(', ');
        
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        
        await connection.query(
          'DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?',
          [order.id_externo, accountId]
        );
        
        movedCount++;
      }
      
      await connection.commit();
      console.log(`[CLEANUP] ✅ ${movedCount} ordens movidas para histórico com sucesso`);
      
      return movedCount;
      
    } catch (moveError) {
      await connection.rollback();
      console.error(`[CLEANUP] ❌ Erro ao mover ordens para histórico:`, moveError.message);
      throw moveError;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro na função moveOrdersToHistory:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Verificar se ordem específica existe na corretora
 * @param {string} symbol - Símbolo da ordem
 * @param {string} orderId - ID externo da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - { exists: boolean, status: string|null }
 */
async function checkOrderExistsOnExchange(symbol, orderId, accountId) {
  try {
    const orderStatus = await getOrderStatus(symbol, orderId, accountId);
    
    if (orderStatus && orderStatus.orderId && orderStatus.status) {
      return {
        exists: true,
        status: orderStatus.status,
        data: orderStatus
      };
    } else {
      return {
        exists: false,
        status: null,
        data: null
      };
    }
    
  } catch (error) {
    // Verificar se é erro de "ordem não existe"
    if (error.message.includes('Unknown order sent') || 
        error.message.includes('Order does not exist') ||
        error.message.includes('-2013')) {
      
      return {
        exists: false,
        status: null,
        error: 'ORDER_NOT_FOUND'
      };
    }
    
    // Outros erros (rede, etc.) - relançar
    throw error;
  }
}

/**
 * ✅ FUNÇÃO PARA VERIFICAR ORDEM INDIVIDUAL
 * Útil para verificações pontuais ou debugging
 */
async function checkSingleOrderStatus(orderId, accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar ordem no banco
    const [orderInDb] = await db.query(`
      SELECT id_externo, simbolo, tipo_ordem_bot, status, last_update
      FROM ordens 
      WHERE id_externo = ? AND conta_id = ?
    `, [orderId, accountId]);
    
    if (orderInDb.length === 0) {
      return { error: 'Ordem não encontrada no banco de dados' };
    }
    
    const order = orderInDb[0];
    
    // Verificar na corretora
    const exchangeCheck = await checkOrderExistsOnExchange(order.simbolo, orderId, accountId);
    
    const result = {
      orderId: orderId,
      symbol: order.simbolo,
      type: order.tipo_ordem_bot,
      statusInDb: order.status,
      lastUpdate: order.last_update,
      existsOnExchange: exchangeCheck.exists,
      statusOnExchange: exchangeCheck.status,
      isOrphan: !exchangeCheck.exists && ['NEW', 'PARTIALLY_FILLED'].includes(order.status)
    };
    
    console.log(`[CLEANUP] 📋 Status da ordem ${orderId}:`);
    console.log(`  - No banco: ${result.statusInDb}`);
    console.log(`  - Na corretora: ${result.existsOnExchange ? result.statusOnExchange : 'NÃO EXISTE'}`);
    console.log(`  - É órfã: ${result.isOrphan ? 'SIM' : 'NÃO'}`);
    
    return result;
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro ao verificar ordem ${orderId}:`, error.message);
    return { error: error.message };
  }
}

/**
 * ✅ FUNÇÃO PARA HISTORICO DE POSIÇÕES
 * Move posições fechadas para o histórico
 */
async function movePositionToHistory(positionId, accountId, force = false) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posição
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE id = ? AND conta_id = ?
    `, [positionId, accountId]);
    
    if (positions.length === 0) {
      return 0;
    }
    
    const position = positions[0];
    
    // Verificar se já está fechada
    if (position.status !== 'CLOSED' && !force) {
      console.log(`[HISTORICO] Posição ${positionId} não está fechada (status: ${position.status})`);
      return 0;
    }
    
    // Inserir no histórico
    await db.query(`
      INSERT INTO posicoes_historico (id_externo, simbolo, quantidade, preco_medio, lucro_prejuizo, tipo, data_hora_fechamento, conta_id)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)
    `, [
      position.id_externo,
      position.simbolo,
      position.quantidade,
      position.preco_medio,
      position.lucro_prejuizo,
      position.tipo,
      accountId
    ]);
    
    // Remover da tabela de posições
    await db.query(`
      DELETE FROM posicoes WHERE id = ?
    `, [positionId]);
    
    console.log(`[HISTORICO] Posição ${positionId} movida para histórico com sucesso`);
    
    // Enviar mensagem para o Telegram
    const message = formatPositionClosedMessage(position);
    sendTelegramMessage(message);
    
    return 1;
    
  } catch (error) {
    console.error(`[HISTORICO] Erro ao mover posição ${positionId} para histórico:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO PARA FECHAR E SINCRONIZAR POSIÇÕES "FANTASMA"
 * Fecha posições que estão abertas no banco mas não na corretora
 */
async function checkAndCloseWebsocket(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    if (dbPositions.length === 0) {
      return 0;
    }
    
    // Obter posições abertas na corretora via WebSocket
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // Posição não existe na corretora ou tem quantidade zero
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = NOW(),
              observacao = 'Fechada via WebSocket - não encontrada na corretora'
          WHERE id = ?
        `, [dbPos.id]);
        
        console.log(`[WEBSOCKET] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO PARA SINCRONIZAR E FECHAR POSIÇÕES "FANTASMA"
 * Sincroniza posições abertas na corretora e fecha as que estão abertas no banco mas não na corretora
 */
async function syncAndCloseGhostPositions(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    if (dbPositions.length === 0) {
      return 0;
    }
    
    // Obter posições abertas na corretora
    const exchangePositions = await getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos) {
        // Posição não existe na corretora
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = NOW(),
              observacao = 'Fechada via sync - não encontrada na corretora'
          WHERE id = ?
        `, [dbPos.id]);
        
        console.log(`[SYNC] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      } else {
        // Sincronizar quantidade e status
        const quantidadeDiff = Math.abs(parseFloat(exchangePos.quantidade)) - Math.abs(parseFloat(dbPos.quantidade));
        
        if (quantidadeDiff > 0.000001) {
          await db.query(`
            UPDATE posicoes 
            SET quantidade = ?, 
                status = 'OPEN', 
                data_hora_fechamento = NULL,
                observacao = 'Sincronizada com a corretora'
            WHERE id = ?
          `, [exchangePos.quantidade, dbPos.id]);
          
          console.log(`[SYNC] Posição ${dbPos.simbolo} sincronizada (nova quantidade: ${exchangePos.quantidade})`);
        }
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[SYNC] Erro ao sincronizar e fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

module.exports = {
  cleanupOrphanSignals,
  forceCloseGhostPositions,
  cancelOrphanOrders,
  moveOrdersToHistory,
  checkOrderExistsOnExchange,
  checkSingleOrderStatus,
  //Movidos do positionHistory.js
  movePositionToHistory,
  checkAndCloseWebsocket,
  syncAndCloseGhostPositions,
  // ✅ EXPORTAR NOVAS FUNÇÕES UTILITÁRIAS
  sanitizeValueForMySQL,
  sanitizeObjectForMySQL
};