const { getDatabaseInstance } = require('../../../core/database/conexao');
const { getAllOpenPositions, cancelOrder, getOrderStatus } = require('../api/rest');

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
          data_hora_criacao: order.data_hora_criacao,
          id_externo: order.id_externo,
          side: order.side,
          simbolo: order.simbolo,
          tipo_ordem_bot: order.tipo_ordem_bot,
          target: order.target,
          reduce_only: order.reduce_only,
          close_position: order.close_position,
          last_update: order.last_update,
          conta_id: order.conta_id,
          preco_executado: order.preco_executado || 0,
          quantidade_executada: order.quantidade_executada || 0,
          observacao: order.observacao || 
            (order.status === 'CANCELED' ? 'Movida via cleanup - órfã' : 'Movida automaticamente - posição fechada')
        };
        
        // ✅ ADICIONAR CAMPOS OPCIONAIS SE EXISTIREM
        if (destColumnNames.includes('orign_sig') && order.orign_sig) {
          insertData.orign_sig = order.orign_sig;
        }
        if (destColumnNames.includes('dados_originais_ws') && order.dados_originais_ws) {
          insertData.dados_originais_ws = order.dados_originais_ws;
        }
        
        // ✅ CONSTRUIR QUERY DINÂMICA
        const columns = Object.keys(insertData).filter(key => 
          destColumnNames.includes(key) && insertData[key] !== undefined
        );
        const values = columns.map(col => insertData[col]);
        const placeholders = columns.map(() => '?').join(', ');
        
        // ✅ INSERIR NA TABELA FECHADAS
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        
        // ✅ REMOVER DA TABELA ATIVA
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

module.exports = {
  cleanupOrphanSignals,
  forceCloseGhostPositions,
  cancelOrphanOrders,
  moveOrdersToHistory,
  checkOrderExistsOnExchange,
  checkSingleOrderStatus
};