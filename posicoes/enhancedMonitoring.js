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
 * ✅ FUNÇÃO COMPLETA DE MONITORAMENTO COMO NO _DEV
 * Combina trailing stops, verificação de posições fechadas e limpeza
 */
async function runAdvancedPositionMonitoring(accountId) {
  try {
    console.log(`[ADVANCED_MONITOR] 🔄 Executando monitoramento avançado para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    
    // ✅ 1. VERIFICAR POSIÇÕES ABERTAS NO BANCO
    const [openPositions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    console.log(`[ADVANCED_MONITOR] 📊 Encontradas ${openPositions.length} posições abertas no banco para conta ${accountId}`);
    
    if (openPositions.length === 0) {
      console.log(`[ADVANCED_MONITOR] ℹ️ Nenhuma posição aberta para verificar na conta ${accountId}`);
      return;
    }
    
    // ✅ 2. OBTER POSIÇÕES DA CORRETORA
    console.log(`[ADVANCED_MONITOR] 🏦 Verificando posições na corretora...`);
    const exchangePositions = await api.getAllOpenPositions(accountId);
    console.log(`[ADVANCED_MONITOR] 🏦 Encontradas ${exchangePositions.length} posições na corretora para conta ${accountId}`);
    
    const exchangePositionsMap = new Map();
    exchangePositions.forEach(pos => {
      exchangePositionsMap.set(pos.simbolo, pos);
      console.log(`[ADVANCED_MONITOR]   - ${pos.simbolo}: ${pos.quantidade} (${pos.lado})`);
    });
    
    let checkedCount = 0;
    let closedCount = 0;
    
    // ✅ 3. VERIFICAR CADA POSIÇÃO DO BANCO
    for (const position of openPositions) {
      try {
        console.log(`[ADVANCED_MONITOR] 🔍 Verificando posição ${position.simbolo} (ID: ${position.id})...`);
        checkedCount++;
        
        // Verificar se posição ainda existe na corretora
        const exchangePos = exchangePositionsMap.get(position.simbolo);
        
        if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
          console.log(`[ADVANCED_MONITOR] ⚠️ Posição ${position.simbolo} (ID: ${position.id}) NÃO EXISTE mais na corretora!`);
          console.log(`[ADVANCED_MONITOR] 📝 Banco: ${position.quantidade} | Corretora: ${exchangePos ? exchangePos.quantidade : 'N/A'}`);
          
          const moved = await movePositionToHistory(
            db, 
            position.id, 
            'CLOSED', 
            'Monitoramento automático - posição fechada na corretora',
            accountId
          );
          
          if (moved) {
            closedCount++;
            console.log(`[ADVANCED_MONITOR] ✅ Posição ${position.simbolo} (ID: ${position.id}) movida para histórico`);
          } else {
            console.error(`[ADVANCED_MONITOR] ❌ Falha ao mover posição ${position.simbolo} (ID: ${position.id}) para histórico`);
          }
          
          continue;
        } else {
          console.log(`[ADVANCED_MONITOR] ✅ Posição ${position.simbolo} confirmada na corretora: ${exchangePos.quantidade}`);
        }
        
        // ✅ 4. VERIFICAR TRAILING STOPS PARA POSIÇÕES EXISTENTES
        if (exchangePos) {
          const currentPrice = await api.getPrice(position.simbolo, accountId);
          
          if (currentPrice && currentPrice > 0) {
            const { checkOrderTriggers } = require('./trailingStopLoss');
            await checkOrderTriggers(db, position, currentPrice, accountId);
            
            console.log(`[ADVANCED_MONITOR] ✅ ${position.simbolo} @ ${currentPrice} - trailing verificado`);
          }
        }
        
        // Pequena pausa entre verificações
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (posError) {
        console.error(`[ADVANCED_MONITOR] ❌ Erro ao verificar posição ${position.simbolo}:`, posError.message);
      }
    }
    
    console.log(`[ADVANCED_MONITOR] ✅ Monitoramento concluído para conta ${accountId}:`);
    console.log(`[ADVANCED_MONITOR]   - Posições verificadas: ${checkedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições movidas para histórico: ${closedCount}`);
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro no monitoramento avançado para conta ${accountId}:`, error.message);
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