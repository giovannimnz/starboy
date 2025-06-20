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
 * ✅ FUNÇÃO MELHORADA DE MONITORAMENTO COMPLETO
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
    
    // ✅ 2. VERIFICAR CADA POSIÇÃO DO BANCO
    for (const position of dbPositions) {
      try {
        console.log(`[ADVANCED_MONITOR] 🔍 Verificando posição ${position.simbolo} (ID: ${position.id})...`);
        checkedCount++;
        
        const exchangePos = exchangePositionsMap.get(position.simbolo);
        
        if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
          console.log(`[ADVANCED_MONITOR] ⚠️ Posição ${position.simbolo} (ID: ${position.id}) NÃO EXISTE na corretora!`);
          
          // ✅ 2.1. VERIFICAR ORDENS RELACIONADAS ANTES DE MOVER
          const [relatedOrders] = await db.query(`
            SELECT id_externo, simbolo, tipo_ordem_bot, status 
            FROM ordens 
            WHERE id_posicao = ? 
              AND status IN ('NEW', 'PARTIALLY_FILLED') 
              AND conta_id = ?
          `, [position.id, accountId]);
          
          if (relatedOrders.length > 0) {
            console.log(`[ADVANCED_MONITOR] 🗑️ Encontradas ${relatedOrders.length} ordens relacionadas para limpar...`);
            
            // ✅ MARCAR ORDENS COMO CANCELED
            for (const order of relatedOrders) {
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
                `📅 Aberta em: ${position.data_hora_abertura}`
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
    
    // ✅ 4. VERIFICAR SE HÁ POSIÇÕES NA CORRETORA SEM REGISTRO NO BANCO
    const missingInDb = [];
    for (const exchangePos of exchangePositions) {
      if (Math.abs(parseFloat(exchangePos.quantidade)) > 0.000001) {
        const dbPos = dbPositions.find(db => db.simbolo === exchangePos.simbolo);
        if (!dbPos) {
          missingInDb.push(exchangePos);
        }
      }
    }
    
    if (missingInDb.length > 0) {
      console.log(`[ADVANCED_MONITOR] 🆕 Encontradas ${missingInDb.length} posições na corretora sem registro no banco:`);
      missingInDb.forEach(pos => {
        console.log(`[ADVANCED_MONITOR]   - ${pos.simbolo}: ${pos.quantidade} (${pos.lado})`);
      });
      
      // ✅ CRIAR POSIÇÕES EXTERNAS NO BANCO
      const { insertPosition } = require('../db/conexao');
      const { formatDateForMySQL } = require('../db/conexao');
      
      for (const extPos of missingInDb) {
        try {
          const positionData = {
            simbolo: extPos.simbolo,
            quantidade: Math.abs(parseFloat(extPos.quantidade)),
            preco_medio: parseFloat(extPos.precoEntrada || extPos.precoAtual || 0),
            status: 'OPEN',
            data_hora_abertura: formatDateForMySQL(new Date()),
            side: parseFloat(extPos.quantidade) > 0 ? 'BUY' : 'SELL',
            leverage: parseFloat(extPos.leverage || 1),
            data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
            preco_entrada: parseFloat(extPos.precoEntrada || extPos.precoAtual || 0),
            preco_corrente: parseFloat(extPos.precoAtual || extPos.precoEntrada || 0),
            orign_sig: 'EXTERNAL_DETECTED',
            quantidade_aberta: Math.abs(parseFloat(extPos.quantidade)),
            conta_id: accountId
          };
          
          const newPositionId = await insertPosition(db, positionData);
          console.log(`[ADVANCED_MONITOR] ✅ Posição externa ${extPos.simbolo} criada com ID ${newPositionId}`);
          
        } catch (createError) {
          console.error(`[ADVANCED_MONITOR] ❌ Erro ao criar posição externa ${extPos.simbolo}:`, createError.message);
        }
      }
    }
    
    console.log(`[ADVANCED_MONITOR] ✅ Monitoramento completo concluído para conta ${accountId}:`);
    console.log(`[ADVANCED_MONITOR]   - Posições verificadas: ${checkedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições movidas para histórico: ${closedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições externas detectadas: ${missingInDb.length}`);
    
    return { checked: checkedCount, closed: closedCount, external: missingInDb.length };
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro no monitoramento completo para conta ${accountId}:`, error.message);
    return { checked: 0, closed: 0, external: 0 };
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
 * ✅ OUTRAS FUNÇÕES DE MONITORAMENTO
 */
async function runPeriodicCleanup(accountId) {
  console.log(`[CLEANUP] 🧹 Executando limpeza periódica para conta ${accountId}...`);
  // Implementar lógica de limpeza
}

async function monitorWebSocketHealth(accountId) {
  console.log(`[WS_HEALTH] 🔗 Verificando saúde dos WebSockets para conta ${accountId}...`);
  // Implementar verificação de WebSocket
}

async function updatePositionPricesWithTrailing(db, symbol, price, accountId) {
  try {
    // Atualizar preços e verificar trailing stops
    console.log(`[TRAILING] 📈 Atualizando ${symbol} @ ${price} para conta ${accountId}`);
    
    const { checkOrderTriggers } = require('./trailingStopLoss');
    
    // Buscar posições abertas para este símbolo
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      await checkOrderTriggers(db, position, price, accountId);
    }
    
  } catch (error) {
    console.error(`[TRAILING] ❌ Erro ao atualizar trailing para ${symbol}:`, error.message);
  }
}

// ✅ EXPORTS CORRETOS
module.exports = {
  runAdvancedPositionMonitoring,
  logOpenPositionsAndOrders,
  runPeriodicCleanup,
  monitorWebSocketHealth,
  updatePositionPricesWithTrailing
};