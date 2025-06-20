const { getDatabaseInstance } = require('../db/conexao');
const api = require('../api');
const { movePositionToHistory } = require('./positionHistory');
const websockets = require('../websockets');
const { checkOrderTriggers } = require('./trailingStopLoss');
const { checkExpiredSignals } = require('./signalTimeout');
const { cleanupOrphanSignals, forceCloseGhostPositions } = require('./cleanup');

/**
 * Atualiza preços das posições com trailing stop
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ENHANCED] AccountId inválido: ${accountId}`);
      return;
    }
    
    // Buscar posições abertas para o símbolo
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      // Atualizar preço corrente
      await db.query(`
        UPDATE posicoes 
        SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
        WHERE id = ?
      `, [currentPrice, position.id]);
      
      // Verificar trailing stops
      try {
        await checkOrderTriggers(db, position, currentPrice, accountId);
      } catch (trailingError) {
        console.error(`[ENHANCED] Erro no trailing stop para posição ${position.id}:`, trailingError.message);
      }
    }
    
  } catch (error) {
    console.error(`[ENHANCED] Erro ao atualizar preços para ${symbol} conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ VERIFICAÇÃO ESPECÍFICA DE ORDERS E POSIÇÕES COMO NO _DEV
 */
async function logOpenPositionsAndOrders(accountId) {
  try {
    console.log('\n=== 🔍 DIAGNÓSTICO DE SINCRONIZAÇÃO ===');
    
    const db = await getDatabaseInstance();
    
    // Posições do banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, preco_entrada, side, status 
      FROM posicoes WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    // Posições da corretora  
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    console.log(`[SYNC_CHECK] 📊 Banco: ${dbPositions.length} posições | Corretora: ${exchangePositions.length} posições`);
    
    // ✅ DETECTAR DISCREPÂNCIAS
    const discrepancies = [];
    
    dbPositions.forEach(dbPos => {
      const exchangePos = exchangePositions.find(ex => ex.simbolo === dbPos.simbolo);
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        discrepancies.push({
          type: 'MISSING_ON_EXCHANGE',
          symbol: dbPos.simbolo,
          dbId: dbPos.id,
          dbQty: dbPos.quantidade
        });
      }
    });
    
    exchangePositions.forEach(exPos => {
      if (Math.abs(parseFloat(exPos.quantidade)) > 0.000001) {
        const dbPos = dbPositions.find(db => db.simbolo === exPos.simbolo);
        if (!dbPos) {
          discrepancies.push({
            type: 'MISSING_ON_DB',
            symbol: exPos.simbolo,
            exchangeQty: exPos.quantidade
          });
        }
      }
    });
    
    if (discrepancies.length > 0) {
      console.log(`[SYNC_CHECK] ⚠️ ENCONTRADAS ${discrepancies.length} DISCREPÂNCIAS:`);
      discrepancies.forEach(disc => {
        if (disc.type === 'MISSING_ON_EXCHANGE') {
          console.log(`  🚨 ${disc.symbol}: Existe no banco (ID: ${disc.dbId}, Qty: ${disc.dbQty}) mas NÃO na corretora`);
        } else {
          console.log(`  🚨 ${disc.symbol}: Existe na corretora (Qty: ${disc.exchangeQty}) mas NÃO no banco`);
        }
      });
    } else {
      console.log(`[SYNC_CHECK] ✅ Banco e corretora estão sincronizados`);
    }
    
    console.log('===========================================\n');
  } catch (error) {
    console.error(`[SYNC_CHECK] ❌ Erro na verificação de sincronização:`, error.message);
  }
}

/**
 * ✅ ATUALIZAÇÃO COMPLETA DE PREÇOS COM TRAILING E GATILHOS
 * Combina todas as verificações de preço em uma só função
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ENHANCED] AccountId inválido: ${accountId}`);
      return;
    }
    
    // ✅ 1. VERIFICAR GATILHOS DE ENTRADA PRIMEIRO
    const { checkSignalTriggers } = require('./priceMonitoring');
    await checkSignalTriggers(symbol, currentPrice, db, accountId);
    
    // ✅ 2. ATUALIZAR PREÇOS DAS POSIÇÕES
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      // Atualizar preço corrente
      await db.query(`
        UPDATE posicoes 
        SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
        WHERE id = ?
      `, [currentPrice, position.id]);
      
      // ✅ 3. VERIFICAR TRAILING STOPS
      try {
        const { checkOrderTriggers } = require('./trailingStopLoss');
        await checkOrderTriggers(db, position, currentPrice, accountId);
      } catch (trailingError) {
        console.error(`[ENHANCED] Erro no trailing stop para posição ${position.id}:`, trailingError.message);
      }
    }
    
    // ✅ 4. LOG PERIÓDICO (APENAS A CADA MINUTO)
    const now = Date.now();
    const lastLogKey = `${symbol}_${accountId}`;
    if (!global.lastPriceLog) global.lastPriceLog = {};
    
    if (!global.lastPriceLog[lastLogKey] || (now - global.lastPriceLog[lastLogKey]) > 60000) {
      if (positions.length > 0) {
        console.log(`[ENHANCED] 📊 ${symbol} @ ${currentPrice} - ${positions.length} posições ativas (conta ${accountId})`);
      }
      global.lastPriceLog[lastLogKey] = now;
    }
    
  } catch (error) {
    console.error(`[ENHANCED] ❌ Erro ao atualizar preços para ${symbol} conta ${accountId}:`, error.message);
  }
}

/**
 * Job de limpeza periódica
 */
async function runPeriodicCleanup(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return;
    }
    
    //console.log(`[CLEANUP] Executando limpeza periódica para conta ${accountId}...`);
    
    // Verificar sinais expirados
    await checkExpiredSignals(accountId);
    
    // Limpar sinais órfãos
    await cleanupOrphanSignals(accountId);
    
    // A cada 10 minutos, verificar posições fantasma
    const now = new Date();
    if (now.getMinutes() % 10 === 0) {
      await forceCloseGhostPositions(accountId);
    }
    
    //console.log(`[CLEANUP] ✅ Limpeza periódica concluída para conta ${accountId}`);
  } catch (error) {
    console.error(`[CLEANUP] Erro na limpeza periódica para conta ${accountId}:`, error.message);
  }
}

/**
 * Monitora saúde dos WebSockets
 */
function monitorWebSocketHealth(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[HEALTH] AccountId inválido: ${accountId}`);
      return;
    }
    
    console.log(`[HEALTH] Verificando saúde dos WebSockets para conta ${accountId}...`);
    
    const isApiConnected = websockets.isWebSocketApiConnected(accountId);
    const isApiAuthenticated = websockets.isWebSocketApiAuthenticated(accountId);
    
    console.log(`[HEALTH] Conta ${accountId}:`);
    console.log(`  - WebSocket API conectado: ${isApiConnected ? '✅' : '❌'}`);
    console.log(`  - WebSocket API autenticado: ${isApiAuthenticated ? '✅' : '❌'}`);
    
    // Reconectar se necessário
    if (!isApiConnected || !isApiAuthenticated) {
      console.log(`[HEALTH] ⚠️ Problemas detectados na conta ${accountId}, tentando reconectar...`);
      websockets.startWebSocketApi(accountId).catch(error => {
        console.error(`[HEALTH] Erro ao reconectar conta ${accountId}:`, error.message);
      });
    }
    
  } catch (error) {
    console.error(`[HEALTH] Erro ao monitorar WebSockets para conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ FUNÇÃO MELHORADA - MOVER POSIÇÕES FISICAMENTE PARA HISTÓRICO
 */
async function runAdvancedPositionMonitoring(accountId) {
  try {
    console.log(`[ADVANCED_MONITOR] 🔄 Executando monitoramento completo para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    
    // ✅ 1. VERIFICAR POSIÇÕES DO BANCO vs CORRETORA (INCLUIR CLOSED)
    const [dbPositions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE status IN ('OPEN', 'CLOSED') AND conta_id = ?
    `, [accountId]);
    
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    console.log(`[ADVANCED_MONITOR] 📊 Banco: ${dbPositions.length} posições (OPEN+CLOSED) | Corretora: ${exchangePositions.length} posições`);
    
    const exchangePositionsMap = new Map();
    exchangePositions.forEach(pos => {
      exchangePositionsMap.set(pos.simbolo, pos);
    });
    
    let checkedCount = 0;
    let positionsMovedCount = 0;
    let filledOrdersMovedCount = 0;
    
    // ✅ 2. VERIFICAR CADA POSIÇÃO DO BANCO (OPEN E CLOSED)
    for (const position of dbPositions) {
      try {
        console.log(`[ADVANCED_MONITOR] 🔍 Verificando posição ${position.simbolo} (ID: ${position.id}, Status: ${position.status})...`);
        checkedCount++;
        
        const exchangePos = exchangePositionsMap.get(position.simbolo);
        
        // ✅ LÓGICA DIFERENTE PARA POSIÇÕES OPEN VS CLOSED
        if (position.status === 'CLOSED') {
          // Posição já marcada como CLOSED no banco, deve ser movida para histórico
          console.log(`[ADVANCED_MONITOR] 📚 Posição ${position.simbolo} (ID: ${position.id}) já está CLOSED, movendo para histórico...`);
          
          // ✅ PROCESSAR ORDENS RELACIONADAS
          const [relatedOrders] = await db.query(`
            SELECT id_externo, simbolo, tipo_ordem_bot, status, preco_executado, quantidade_executada 
            FROM ordens 
            WHERE id_posicao = ? AND conta_id = ?
          `, [position.id, accountId]);
          
          if (relatedOrders.length > 0) {
            console.log(`[ADVANCED_MONITOR] 🗑️ Processando ${relatedOrders.length} ordens relacionadas para posição CLOSED...`);
            
            for (const order of relatedOrders) {
              const moved = await moveOrderToHistoryPhysically(db, order.id_externo, accountId);
              if (moved) {
                filledOrdersMovedCount++;
                console.log(`[ADVANCED_MONITOR] ✅ Ordem ${order.id_externo} (${order.status}) movida para histórico`);
              }
            }
          }
          
          // ✅ MOVER POSIÇÃO PARA HISTÓRICO
          const moved = await movePositionToHistoryPhysically(
            db, 
            position.id, 
            'CLOSED', 
            position.observacoes || 'Movida automaticamente - status CLOSED detectado',
            accountId
          );
          
          if (moved) {
            positionsMovedCount++;
            console.log(`[ADVANCED_MONITOR] ✅ Posição CLOSED ${position.simbolo} (ID: ${position.id}) movida para histórico`);
          }
          
        } else if (position.status === 'OPEN') {
          // Lógica original para posições OPEN
          if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
            console.log(`[ADVANCED_MONITOR] ⚠️ Posição OPEN ${position.simbolo} (ID: ${position.id}) NÃO EXISTE na corretora!`);
            
            // Processar ordens relacionadas e mover posição (lógica existente)
            const [relatedOrders] = await db.query(`
              SELECT id_externo, simbolo, tipo_ordem_bot, status, preco_executado, quantidade_executada 
              FROM ordens 
              WHERE id_posicao = ? AND conta_id = ?
            `, [position.id, accountId]);
            
            if (relatedOrders.length > 0) {
              console.log(`[ADVANCED_MONITOR] 🗑️ Processando ${relatedOrders.length} ordens relacionadas...`);
              
              for (const order of relatedOrders) {
                if (order.status === 'FILLED') {
                  const moved = await moveOrderToHistoryPhysically(db, order.id_externo, accountId);
                  if (moved) {
                    filledOrdersMovedCount++;
                    console.log(`[ADVANCED_MONITOR] ✅ Ordem FILLED ${order.id_externo} movida para ordens_fechadas`);
                  }
                  
                } else if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
                  await db.query(`
                    UPDATE ordens 
                    SET status = 'CANCELED', 
                        last_update = NOW(),
                        observacao = 'Auto-cancelada - posição fechada na corretora'
                    WHERE id_externo = ? AND conta_id = ?
                  `, [order.id_externo, accountId]);
                  
                  const moved = await moveOrderToHistoryPhysically(db, order.id_externo, accountId);
                  if (moved) {
                    console.log(`[ADVANCED_MONITOR] ✅ Ordem ${order.id_externo} (${order.tipo_ordem_bot}) cancelada e movida para histórico`);
                  }
                }
              }
            }
            
            // Mover posição para histórico
            const moved = await movePositionToHistoryPhysically(
              db, 
              position.id, 
              'CLOSED', 
              'Monitoramento automático - posição não existe na corretora',
              accountId
            );
            
            if (moved) {
              positionsMovedCount++;
              console.log(`[ADVANCED_MONITOR] ✅ Posição ${position.simbolo} (ID: ${position.id}) movida fisicamente para posicoes_fechadas`);
            }
            
          } else {
            // ✅ VERIFICAR TRAILING STOPS PARA POSIÇÕES ATIVAS
            const currentPrice = await api.getPrice(position.simbolo, accountId);
            
            if (currentPrice && currentPrice > 0) {
              const { checkOrderTriggers } = require('./trailingStopLoss');
              await checkOrderTriggers(db, position, currentPrice, accountId);
            }
          }
        }
        
        // Pausa entre verificações
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (posError) {
        console.error(`[ADVANCED_MONITOR] ❌ Erro ao verificar posição ${position.simbolo}:`, posError.message);
      }
    }
    
    console.log(`[ADVANCED_MONITOR] ✅ Monitoramento completo concluído para conta ${accountId}:`);
    console.log(`[ADVANCED_MONITOR]   - Posições verificadas: ${checkedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições movidas fisicamente: ${positionsMovedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Ordens movidas: ${filledOrdersMovedCount}`);
    
    return { checked: checkedCount, positionsMoved: positionsMovedCount, ordersMoved: filledOrdersMovedCount };
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro no monitoramento completo para conta ${accountId}:`, error.message);
    return { checked: 0, positionsMoved: 0, ordersMoved: 0 };
  }
}

/**
 * ✅ NOVA FUNÇÃO: Mover posição fisicamente para posicoes_fechadas
 */
async function movePositionToHistoryPhysically(db, positionId, status, reason, accountId) {
  try {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // ✅ 1. BUSCAR POSIÇÃO PARA MOVER
      const [positionToMove] = await connection.query(`
        SELECT * FROM posicoes 
        WHERE id = ? AND conta_id = ?
      `, [positionId, accountId]);
      
      if (positionToMove.length === 0) {
        await connection.rollback();
        connection.release();
        return false;
      }
      
      const position = positionToMove[0];
      
      // ✅ 2. VERIFICAR COLUNAS DA TABELA DESTINO
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM posicoes_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
      // ✅ 3. PREPARAR DADOS PARA INSERÇÃO
      const now = new Date();
      const insertData = {
        simbolo: position.simbolo,
        quantidade: position.quantidade,
        preco_medio: position.preco_medio,
        status: status || 'CLOSED',
        data_hora_abertura: position.data_hora_abertura,
        data_hora_fechamento: now,
        side: position.side,
        leverage: position.leverage,
        data_hora_ultima_atualizacao: now,
        preco_entrada: position.preco_entrada,
        preco_corrente: position.preco_corrente,
        conta_id: position.conta_id,
        observacoes: reason || 'Movida automaticamente'
      };
      
      // ✅ 4. ADICIONAR CAMPOS OPCIONAIS SE EXISTIREM
      if (destColumnNames.includes('orign_sig') && position.orign_sig) {
        insertData.orign_sig = position.orign_sig;
      }
      if (destColumnNames.includes('quantidade_aberta') && position.quantidade_aberta) {
        insertData.quantidade_aberta = position.quantidade_aberta;
      }
      if (destColumnNames.includes('trailing_stop_level') && position.trailing_stop_level) {
        insertData.trailing_stop_level = position.trailing_stop_level;
      }
      if (destColumnNames.includes('pnl_corrente') && position.pnl_corrente) {
        insertData.pnl_corrente = position.pnl_corrente;
      }
      
      // ✅ 5. CONSTRUIR QUERY DINÂMICA
      const columns = Object.keys(insertData).filter(key => 
        destColumnNames.includes(key) && insertData[key] !== undefined
      );
      const values = columns.map(col => insertData[col]);
      const placeholders = columns.map(() => '?').join(', ');
      
      // ✅ 6. INSERIR NA TABELA FECHADAS
      await connection.query(
        `INSERT INTO posicoes_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
        values
      );
      
      // ✅ 7. REMOVER DA TABELA ATIVA
      await connection.query(
        'DELETE FROM posicoes WHERE id = ? AND conta_id = ?',
        [positionId, accountId]
      );
      
      await connection.commit();
      connection.release();
      
      console.log(`[ADVANCED_MONITOR] ✅ Posição ${position.simbolo} (ID: ${positionId}) movida fisicamente para posicoes_fechadas`);
      return true;
      
    } catch (moveError) {
      await connection.rollback();
      connection.release();
      throw moveError;
    }
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro ao mover posição ${positionId} para histórico:`, error.message);
    return false;
  }
}

/**
 * ✅ NOVA FUNÇÃO: Mover ordem fisicamente para ordens_fechadas
 */
async function moveOrderToHistoryPhysically(db, orderId, accountId) {
  try {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // ✅ BUSCAR ORDEM PARA MOVER
      const [orderToMove] = await connection.query(`
        SELECT * FROM ordens 
        WHERE id_externo = ? AND conta_id = ?
      `, [orderId, accountId]);
      
      if (orderToMove.length === 0) {
        await connection.rollback();
        connection.release();
        return false;
      }
      
      const order = orderToMove[0];
      
      // ✅ VERIFICAR COLUNAS DA TABELA DESTINO
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
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
        observacao: order.observacao || 'Movida automaticamente'
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
        [orderId, accountId]
      );
      
      await connection.commit();
      connection.release();
      
      return true;
      
    } catch (moveError) {
      await connection.rollback();
      connection.release();
      throw moveError;
    }
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro ao mover ordem ${orderId} para histórico:`, error.message);
    return false;
  }
}

/**
 * ✅ NOVA FUNÇÃO: Verificar ordens FILLED órfãs (sem posição correspondente)
 */
async function checkOrphanFilledOrders(db, accountId) {
  try {
    console.log(`[ADVANCED_MONITOR] 🔍 Verificando ordens FILLED órfãs para conta ${accountId}...`);
    
    // Buscar ordens FILLED que não têm posição correspondente ABERTA
    const [orphanFilledOrders] = await db.query(`
      SELECT o.id_externo, o.simbolo, o.tipo_ordem_bot, o.status, o.id_posicao,
             o.preco_executado, o.quantidade_executada
      FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id AND p.status = 'OPEN'
      WHERE o.status = 'FILLED' 
        AND o.conta_id = ?
        AND p.id IS NULL
        AND o.last_update < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [accountId]);
    
    if (orphanFilledOrders.length === 0) {
      return 0;
    }
    
    console.log(`[ADVANCED_MONITOR] 📚 Encontradas ${orphanFilledOrders.length} ordens FILLED órfãs para mover...`);
    
    let movedCount = 0;
    
    for (const order of orphanFilledOrders) {
      try {
        const moved = await moveOrderToHistory(db, order.id_externo, accountId);
        if (moved) {
          movedCount++;
          console.log(`[ADVANCED_MONITOR] ✅ Ordem FILLED órfã ${order.id_externo} (${order.simbolo}) movida para histórico`);
        }
      } catch (moveError) {
        console.error(`[ADVANCED_MONITOR] ❌ Erro ao mover ordem FILLED ${order.id_externo}:`, moveError.message);
      }
    }
    
    return movedCount;
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro ao verificar ordens FILLED órfãs:`, error.message);
    return 0;
  }
}

/**
 * ✅ NOVA FUNÇÃO: Mover ordem específica para histórico
 */
async function moveOrderToHistory(db, orderId, accountId) {
  try {
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // ✅ BUSCAR ORDEM PARA MOVER
      const [orderToMove] = await connection.query(`
        SELECT * FROM ordens 
        WHERE id_externo = ? AND conta_id = ?
      `, [orderId, accountId]);
      
      if (orderToMove.length === 0) {
        await connection.rollback();
        connection.release();
        return false;
      }
      
      const order = orderToMove[0];
      
      // ✅ VERIFICAR COLUNAS DA TABELA DESTINO
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
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
        observacao: order.observacao || 'Movida automaticamente - posição fechada'
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
        [orderId, accountId]
      );
      
      await connection.commit();
      connection.release();
      
      return true;
      
    } catch (moveError) {
      await connection.rollback();
      connection.release();
      throw moveError;
    }
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro ao mover ordem ${orderId} para histórico:`, error.message);
    return false;
  }
}

module.exports = {
  runAdvancedPositionMonitoring,
  logOpenPositionsAndOrders,
  runPeriodicCleanup,
  monitorWebSocketHealth,
  updatePositionPricesWithTrailing,
  movePositionToHistoryPhysically,
  moveOrderToHistoryPhysically
};