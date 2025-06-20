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
 * ✅ FUNÇÃO MELHORADA - VERIFICAR ORDENS FILLED DE POSIÇÕES FECHADAS
 */
async function runAdvancedPositionMonitoring(accountId) {
  try {
    console.log(`[ADVANCED_MONITOR] 🔄 Executando monitoramento completo para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    
    // ✅ 1. VERIFICAR POSIÇÕES DO BANCO vs CORRETORA
    const [dbPositions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    console.log(`[ADVANCED_MONITOR] 📊 Banco: ${dbPositions.length} posições | Corretora: ${exchangePositions.length} posições`);
    
    const exchangePositionsMap = new Map();
    exchangePositions.forEach(pos => {
      exchangePositionsMap.set(pos.simbolo, pos);
    });
    
    let checkedCount = 0;
    let closedCount = 0;
    let filledOrdersMovedCount = 0;
    
    // ✅ 2. VERIFICAR CADA POSIÇÃO DO BANCO
    for (const position of dbPositions) {
      try {
        console.log(`[ADVANCED_MONITOR] 🔍 Verificando posição ${position.simbolo} (ID: ${position.id})...`);
        checkedCount++;
        
        const exchangePos = exchangePositionsMap.get(position.simbolo);
        
        if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
          console.log(`[ADVANCED_MONITOR] ⚠️ Posição ${position.simbolo} (ID: ${position.id}) NÃO EXISTE na corretora!`);
          
          // ✅ 2.1. VERIFICAR TODAS AS ORDENS RELACIONADAS (incluindo FILLED)
          const [relatedOrders] = await db.query(`
            SELECT id_externo, simbolo, tipo_ordem_bot, status, preco_executado, quantidade_executada 
            FROM ordens 
            WHERE id_posicao = ? AND conta_id = ?
          `, [position.id, accountId]);
          
          if (relatedOrders.length > 0) {
            console.log(`[ADVANCED_MONITOR] 🗑️ Encontradas ${relatedOrders.length} ordens relacionadas para processar...`);
            
            for (const order of relatedOrders) {
              if (order.status === 'FILLED') {
                // ✅ MOVER ORDEM FILLED PARA HISTÓRICO
                console.log(`[ADVANCED_MONITOR] 📚 Movendo ordem FILLED ${order.id_externo} para histórico...`);
                
                const moved = await moveOrderToHistory(db, order.id_externo, accountId);
                if (moved) {
                  filledOrdersMovedCount++;
                  console.log(`[ADVANCED_MONITOR] ✅ Ordem FILLED ${order.id_externo} movida para ordens_fechadas`);
                }
                
              } else if (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') {
                // ✅ MARCAR ORDENS PENDENTES COMO CANCELED
                await db.query(`
                  UPDATE ordens 
                  SET status = 'CANCELED', 
                      last_update = NOW(),
                      observacao = 'Auto-cancelada - posição fechada na corretora'
                  WHERE id_externo = ? AND conta_id = ?
                `, [order.id_externo, accountId]);
                
                console.log(`[ADVANCED_MONITOR] ✅ Ordem ${order.id_externo} (${order.tipo_ordem_bot}) marcada como CANCELED`);
              }
            }
          }
          
          // ✅ 2.2. MOVER POSIÇÃO PARA HISTÓRICO
          const { movePositionToHistory } = require('./positionHistory');
          const moved = await movePositionToHistory(
            db, 
            position.id, 
            'CLOSED', 
            'Monitoramento automático - posição não existe na corretora',
            accountId
          );
          
          if (moved) {
            closedCount++;
            console.log(`[ADVANCED_MONITOR] ✅ Posição ${position.simbolo} (ID: ${position.id}) movida para histórico`);
            
            // ✅ 2.3. NOTIFICAÇÃO TELEGRAM
            try {
              const { sendTelegramMessage, formatAlertMessage } = require('./telegramBot');
              const alertMessage = formatAlertMessage(
                'POSIÇÃO AUTO-FECHADA',
                `⚠️ <b>${position.simbolo}</b>\n\n` +
                `Posição foi detectada como fechada na corretora.\n` +
                `Movida automaticamente para histórico.\n\n` +
                `💰 Quantidade: ${position.quantidade}\n` +
                `💵 Preço médio: ${position.preco_medio}\n` +
                `📅 Aberta em: ${position.data_hora_abertura}\n` +
                `📊 Ordens relacionadas processadas: ${relatedOrders.length}`
              );
              
              await sendTelegramMessage(accountId, alertMessage);
              console.log(`[ADVANCED_MONITOR] 📱 Notificação de fechamento enviada`);
            } catch (telegramError) {
              console.warn(`[ADVANCED_MONITOR] ⚠️ Erro ao enviar notificação:`, telegramError.message);
            }
          }
          
          continue;
        }
        
        // ✅ 3. VERIFICAR TRAILING STOPS PARA POSIÇÕES ATIVAS
        if (exchangePos) {
          const currentPrice = await api.getPrice(position.simbolo, accountId);
          
          if (currentPrice && currentPrice > 0) {
            const { checkOrderTriggers } = require('./trailingStopLoss');
            await checkOrderTriggers(db, position, currentPrice, accountId);
          }
        }
        
        // Pausa entre verificações
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (posError) {
        console.error(`[ADVANCED_MONITOR] ❌ Erro ao verificar posição ${position.simbolo}:`, posError.message);
      }
    }
    
    // ✅ 4. VERIFICAR ORDENS FILLED ÓRFÃS (sem posição correspondente)
    const orphanFilledCount = await checkOrphanFilledOrders(db, accountId);
    if (orphanFilledCount > 0) {
      console.log(`[ADVANCED_MONITOR] 📚 ${orphanFilledCount} ordens FILLED órfãs adicionais movidas para histórico`);
      filledOrdersMovedCount += orphanFilledCount;
    }
    
    console.log(`[ADVANCED_MONITOR] ✅ Monitoramento completo concluído para conta ${accountId}:`);
    console.log(`[ADVANCED_MONITOR]   - Posições verificadas: ${checkedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições movidas para histórico: ${closedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Ordens FILLED movidas: ${filledOrdersMovedCount}`);
    
    return { checked: checkedCount, closed: closedCount, filledMoved: filledOrdersMovedCount };
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro no monitoramento completo para conta ${accountId}:`, error.message);
    return { checked: 0, closed: 0, filledMoved: 0 };
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
  checkOrphanFilledOrders,
  moveOrderToHistory
};