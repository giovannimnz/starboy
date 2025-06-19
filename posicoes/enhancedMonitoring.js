const { getDatabaseInstance } = require('../db/conexao');
const { checkOrderTriggers } = require('./trailingStopLoss');
const { checkExpiredSignals } = require('./signalTimeout');
const { cleanupOrphanSignals, forceCloseGhostPositions } = require('./cleanup');
const websockets = require('../websockets');

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

module.exports = {
  updatePositionPricesWithTrailing,
  runPeriodicCleanup,
  monitorWebSocketHealth
};