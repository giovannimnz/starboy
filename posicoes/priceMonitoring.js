const axios = require('axios');
const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets');

// Cache de preços por símbolo
const latestPrices = new Map();
const priceCache = new Map();

// Mapa para armazenar últimas atualizações de log de preço
const lastPriceLogTime = {};

// Intervalo para log de preços (ms)
const PRICE_LOG_INTERVAL = 60000; // 1 minuto

// Constante para verificações vazias
const MAX_EMPTY_CHECKS = 10;

// Contador para verificar quando fechar websockets sem atividade
const websocketEmptyCheckCounter = {};

/**
 * Inicia monitoramento de preços para posições abertas
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Número de símbolos sendo monitorados
 */
async function startPriceMonitoring(accountId) {
  try {
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em startPriceMonitoring: ${accountId} (tipo: ${typeof accountId})`);
    }

    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[PRICE] Não foi possível conectar ao banco para conta ${accountId}`);
      return 0;
    }

    // Obter posições abertas ou com ordens de entrada pendentes
    const [pendingEntries] = await db.query(`
      SELECT o.simbolo
      FROM ordens o
      WHERE o.tipo_ordem_bot = 'ENTRADA' AND o.status = 'OPEN' AND o.conta_id = ?
      GROUP BY o.simbolo
    `, [accountId]);

    const [openPositions] = await db.query(`
      SELECT simbolo
      FROM posicoes
      WHERE status = 'OPEN' AND conta_id = ?
      GROUP BY simbolo
    `, [accountId]);

    // Obter sinais em AGUARDANDO_ACIONAMENTO ou PENDING
    const [pendingSignals] = await db.query(`
      SELECT symbol, timeframe, created_at, timeout_at, max_lifetime_minutes
      FROM webhook_signals
      WHERE (status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING') AND conta_id = ?
    `, [accountId]);

    console.log(`[PRICE] Encontrados ${pendingSignals.length} sinais pendentes para monitoramento (conta ${accountId})`);

    const symbols = new Set();

    // Adicionar símbolos com ordens pendentes
    pendingEntries.forEach(entry => symbols.add(entry.simbolo));

    // Adicionar símbolos com posições abertas
    openPositions.forEach(position => symbols.add(position.simbolo));

    // Adicionar símbolos com sinais pendentes
    pendingSignals.forEach(signal => symbols.add(signal.symbol));

    // Iniciar websockets para cada símbolo
    for (const symbol of symbols) {
      await websockets.ensurePriceWebsocketExists(symbol, accountId);
    }

    console.log(`[PRICE] Monitoramento iniciado para ${symbols.size} símbolos (conta ${accountId}): ${Array.from(symbols).join(', ')}`);
    return symbols.size;
  } catch (error) {
    console.error(`[PRICE] Erro ao iniciar monitoramento de preços para conta ${accountId}:`, error);
    throw error;
  }
}

/**
 * Atualiza cache de preços
 * @param {string} symbol - Símbolo
 * @param {number} price - Preço
 */
function updatePriceCache(symbol, price) {
  try {
    priceCache.set(symbol, {
      price: parseFloat(price),
      timestamp: Date.now()
    });
    
    latestPrices.set(symbol, parseFloat(price));
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar cache para ${symbol}:`, error);
  }
}

/**
 * Atualiza preços das posições abertas
 * @param {Object} db - Conexão com banco
 * @param {string} symbol - Símbolo
 * @param {number} currentPrice - Preço atual
 */
async function updatePositionPrices(db, symbol, currentPrice) {
  try {
    await db.query(`
      UPDATE posicoes 
      SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
      WHERE simbolo = ? AND status = 'OPEN'
    `, [currentPrice, symbol]);
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar preços das posições para ${symbol}:`, error);
  }
}

/**
 * Processa atualização de preço
 * @param {string} symbol - Símbolo do par
 * @param {number} currentPrice - Preço atual
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function onPriceUpdate(symbol, currentPrice, db, accountId) {
  try {
    // Validação robusta dos parâmetros
    if (!symbol || typeof symbol !== 'string') {
      console.error(`[PRICE] Símbolo inválido em onPriceUpdate: ${symbol}`);
      return;
    }
    
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.error(`[PRICE] Preço inválido em onPriceUpdate: symbol=${symbol}, currentPrice=${currentPrice}, tipo=${typeof currentPrice}`);
      return;
    }
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[PRICE] AccountId inválido em onPriceUpdate: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }
    
    if (!db) {
      console.error(`[PRICE] Conexão DB inválida em onPriceUpdate para ${symbol}`);
      return;
    }
    
    // Converter currentPrice para número se necessário
    const validPrice = parseFloat(currentPrice);
    if (isNaN(validPrice) || validPrice <= 0) {
      console.error(`[PRICE] Não foi possível converter preço para número válido: ${currentPrice}`);
      return;
    }

    // Atualizar cache de preços
    updatePriceCache(symbol, validPrice);
    
    // Atualizar preços das posições
    await updatePositionPrices(db, symbol, validPrice);

    // Log periódico de preços
    const now = Date.now();
    if (!lastPriceLogTime[symbol] || (now - lastPriceLogTime[symbol] > PRICE_LOG_INTERVAL)) {
      lastPriceLogTime[symbol] = now;
      console.log(`[PRICE] ${symbol}: ${validPrice}`);
    }

    // Buscar sinais pendentes para este símbolo
    const [pendingSignalsResult] = await db.query(`
      SELECT 
      id, symbol, timeframe, side, leverage, capital_pct, 
      entry_price, 
      tp_price, sl_price, 
      tp1_price, tp2_price, tp3_price, tp4_price, tp5_price,
      status, error_message, position_id, entry_order_id, 
      tp_order_id, sl_order_id, chat_id, message_id, created_at, 
      updated_at, timeout_at, max_lifetime_minutes, 
      registry_message_id, message_id_orig, message_source, conta_id
      FROM webhook_signals
      WHERE symbol = ? AND conta_id = ? AND 
      (status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING')
    `, [symbol, accountId]);
    
    const pendingSignals = pendingSignalsResult || [];

    // Verificar se há posições abertas ou ordens pendentes
    const [openPositionsResult] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    const [pendingOrdersResult] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'NEW' AND conta_id = ?
    `, [symbol, accountId]);

    const openPositionsCount = (openPositionsResult?.[0]?.count) || 0;
    const pendingOrdersCount = (pendingOrdersResult?.[0]?.count) || 0;

    // Verificar se precisamos manter o WebSocket ativo
    if (pendingSignals.length === 0 && 
        openPositionsCount === 0 && 
        pendingOrdersCount === 0) {
      
      if (!websocketEmptyCheckCounter[symbol]) {
        websocketEmptyCheckCounter[symbol] = 0;
      }
      websocketEmptyCheckCounter[symbol]++;
      
      if (websocketEmptyCheckCounter[symbol] >= MAX_EMPTY_CHECKS) {
        console.log(`[PRICE] ${symbol}: Sem atividade por ${MAX_EMPTY_CHECKS} verificações. Removendo WebSocket.`);
        websockets.stopPriceMonitoring(symbol, accountId);
        delete websocketEmptyCheckCounter[symbol];
        latestPrices.delete(symbol);
        delete lastPriceLogTime[symbol];
        return; 
      }
    } else {
      websocketEmptyCheckCounter[symbol] = 0;
    }

    // Processar sinais pendentes
    if (pendingSignals.length > 0) {
      const { processSignal } = require('./signalProcessor');
      
      for (const signal of pendingSignals) {
        try {
          console.log(`[PRICE] Processando sinal ${signal.id} para ${signal.symbol} com preço ${validPrice}`);
          await processSignal(db, signal, validPrice, accountId);
        } catch (signalError) {
          console.error(`[PRICE] Erro ao processar sinal ${signal.id}:`, signalError);
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE] Erro no processamento de preço para ${symbol} (conta ${accountId}):`, error);
  }
}

/**
 * Verifica e fecha websockets sem atividade
 * @param {Object} db - Conexão com banco
 * @param {string} symbol - Símbolo a verificar
 * @param {number} accountId - ID da conta
 */
async function checkAndCloseWebsocket(db, symbol, accountId) {
  try {
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[PRICE] AccountId inválido em checkAndCloseWebsocket: ${accountId}`);
      return;
    }

    // Verificar se ainda há atividade para este símbolo
    const [pendingSignals] = await db.query(
      `SELECT COUNT(*) as count FROM webhook_signals 
       WHERE symbol = ? AND conta_id = ? AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')`,
      [symbol, accountId]
    );
    
    const [openPositions] = await db.query(
      `SELECT COUNT(*) as count FROM posicoes 
       WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN'`,
      [symbol, accountId]
    );
    
    const [pendingOrders] = await db.query(
      `SELECT COUNT(*) as count FROM ordens
       WHERE simbolo = ? AND conta_id = ? AND status = 'NEW'`,
      [symbol, accountId]
    );

    const totalActivity = 
      (pendingSignals[0]?.count || 0) + 
      (openPositions[0]?.count || 0) + 
      (pendingOrders[0]?.count || 0);

    if (totalActivity === 0) {
      console.log(`[PRICE] Fechando websocket de ${symbol} para conta ${accountId} - sem atividade restante`);
      websockets.stopPriceMonitoring(symbol, accountId);
      latestPrices.delete(symbol);
      delete lastPriceLogTime[symbol];
      delete websocketEmptyCheckCounter[symbol];
    }
  } catch (error) {
    console.error(`[PRICE] Erro ao verificar atividade para ${symbol} (conta ${accountId}):`, error);
  }
}

/**
 * Obtém preço do cache
 * @param {string} symbol - Símbolo
 * @returns {number|null} - Preço ou null se não encontrado
 */
function getPriceFromCache(symbol) {
  const cached = priceCache.get(symbol);
  if (cached && (Date.now() - cached.timestamp) < 30000) { // 30 segundos
    return cached.price;
  }
  return null;
}

module.exports = {
  startPriceMonitoring,
  onPriceUpdate,
  updatePriceCache,
  getPriceFromCache,
  checkAndCloseWebsocket
};