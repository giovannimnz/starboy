const { getDatabaseInstance } = require('../db/conexao');
const { checkOrderTriggers } = require('./trailingStopLoss');
const { checkExpiredSignals } = require('./signalTimeout');
const { cleanupOrphanSignals, forceCloseGhostPositions } = require('./cleanup');

// Cache de preços para evitar logs excessivos
const lastPriceLogTime = {};
const PRICE_LOG_INTERVAL = 60000; // 1 minuto

/**
 * Atualiza preços das posições com trailing stop
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    // Atualizar preços das posições
    const [positions] = await db.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN" AND conta_id = ?',
      [symbol, accountId]
    );

    if (positions.length === 0) {
      return;
    }

    // Log de preço com controle de frequência
    const logKey = `${symbol}_${accountId}`;
    const currentTime = Date.now();
    const shouldLog = !lastPriceLogTime[logKey] || 
                      (currentTime - lastPriceLogTime[logKey] >= PRICE_LOG_INTERVAL);
    
    if (shouldLog) {
      console.log(`[PRICE] ${symbol}: ${currentPrice} (${positions.length} posições)`);
      lastPriceLogTime[logKey] = currentTime;
    }

    // Atualizar cada posição
    for (const position of positions) {
      await db.query(
        `UPDATE posicoes SET 
         preco_corrente = ?, 
         data_hora_ultima_atualizacao = ? 
         WHERE id = ?`,
        [currentPrice, new Date(), position.id]
      );
      
      // Verificar trailing stops
      await checkOrderTriggers(db, position, currentPrice, accountId);
    }
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar preços para ${symbol}:`, error.message);
  }
}

/**
 * Job de limpeza periódica
 */
async function runPeriodicCleanup(accountId) {
  try {
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
    console.error(`[CLEANUP] Erro na limpeza periódica:`, error.message);
  }
}

/**
 * Monitora saúde dos WebSockets
 */
function monitorWebSocketHealth(accountId) {
  const websockets = require('../websockets');
  
  try {
    const activeConnections = websockets.getActiveConnections(accountId);
    console.log(`[HEALTH] WebSockets ativos para conta ${accountId}: ${activeConnections.length}`);
    
    // Verificar conexões com problemas
    for (const ws of activeConnections) {
      if (ws.readyState !== 1) { // WebSocket.OPEN
        console.warn(`[HEALTH] WebSocket ${ws.symbol} não está aberto (state: ${ws.readyState})`);
        // Tentar reconectar
        websockets.ensurePriceWebsocketExists(ws.symbol, accountId);
      }
    }
  } catch (error) {
    console.error(`[HEALTH] Erro ao monitorar WebSockets:`, error.message);
  }
}

module.exports = {
  updatePositionPricesWithTrailing,
  runPeriodicCleanup,
  monitorWebSocketHealth
};