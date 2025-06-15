const axios = require('axios');
const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets');
const { processSignalTrigger } = require('./signalProcessor');

// Cache de preços por símbolo
const latestPrices = new Map();

// Mapa para armazenar últimas atualizações de log de preço
const lastPriceLogTime = {};

// Intervalo para log de preços (ms)
const PRICE_LOG_INTERVAL = 60000; // 1 minuto

// Contador para verificar quando fechar websockets sem atividade
const websocketEmptyCheckCounter = {};

/**
 * Inicia monitoramento de preços para posições abertas
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Número de símbolos sendo monitorados
 */
async function startPriceMonitoring(accountId = 1) {
  try {
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

    return symbols.size;
  } catch (error) {
    console.error(`[PRICE] Erro ao iniciar monitoramento de preços para conta ${accountId}:`, error);
    throw error;
  }
}

/**
 * Função para obter preço atual via REST API
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number|null>} - Preço atual ou null se falhar
 */
async function getCurrentPrice(symbol, accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase({ accountId });
    
    if (!credentials || !credentials.apiUrl) {
      console.error(`[PRICE] Credenciais não encontradas para conta ${accountId}`);
      return null;
    }
    
    // Construir URL completa
    const url = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    console.log(`[PRICE] Obtendo preço atual via REST API: ${url}`);
    
    const response = await axios.get(url);
    if (response.data && response.data.price) {
      const price = parseFloat(response.data.price);
      console.log(`[PRICE] Preço atual de ${symbol} obtido via REST API: ${price}`);
      return price;
    }
    
    console.error(`[PRICE] Resposta da API sem preço:`, response.data);
    return null;
  } catch (error) {
    console.error(`[PRICE] Erro ao obter preço atual para ${symbol}:`, error);
    return null;
  }
}

/**
 * Obtém preço usando WebSocket cache com fallback para REST API
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @param {number} maxAgeMs - Idade máxima do preço em cache (ms)
 * @returns {Promise<number|null>} - Preço atual
 */
async function getWebSocketPrice(symbol, accountId = 1, maxAgeMs = 5000) {
  try {
    // Se não temos o símbolo no cache, iniciar websocket
    if (!latestPrices.has(symbol)) {
      await websockets.ensurePriceWebsocketExists(symbol, accountId);
      
      // Aguardar um momento para o websocket conectar
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Verificar se temos uma atualização recente no cache
    const priceEntry = latestPrices.get(symbol);
    const now = Date.now();
    
    if (priceEntry && (now - priceEntry.timestamp) < maxAgeMs) {
      return priceEntry.price;
    }

    // Se o preço for muito antigo, tentar obter via REST
    console.log(`[PRICE] Preço de ${symbol} não disponível via WebSocket (ou antigo)`);
    
    const restPrice = await getCurrentPrice(symbol, accountId);
    
    // Atualizar cache com o preço da REST API
    if (restPrice) {
      updatePriceCache(symbol, restPrice);
      return restPrice;
    }
    
    // Se ainda temos algum preço em cache, retorná-lo como último recurso
    if (priceEntry) {
      console.warn(`[PRICE] Usando preço antigo para ${symbol}: ${priceEntry.price}`);
      return priceEntry.price;
    }
    
    return null;
  } catch (error) {
    console.error(`[PRICE] Erro ao obter preço para ${symbol}:`, error);
    return null;
  }
}

/**
 * Atualiza cache de preços
 * @param {string} symbol - Símbolo do par
 * @param {number|Object} priceData - Preço ou dados do BookTicker
 */
function updatePriceCache(symbol, priceData) {
  try {
    let price;
    
    if (typeof priceData === 'number') {
      price = priceData;
    } else if (priceData && (priceData.bidPrice || priceData.b)) {
      // BookTicker data
      const bid = parseFloat(priceData.bidPrice || priceData.b);
      const ask = parseFloat(priceData.askPrice || priceData.a);
      
      if (!isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) {
        price = (bid + ask) / 2;
      } else {
        return;
      }
    } else {
      return;
    }
    
    latestPrices.set(symbol, {
      price: price,
      timestamp: Date.now()
    });
    
    console.log(`[PRICE] ${symbol}: ${price}`);
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar cache para ${symbol}:`, error);
  }
}

/**
 * Processa atualização de preço
 * @param {string} symbol - Símbolo do par
 * @param {number} currentPrice - Preço atual
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function onPriceUpdate(symbol, currentPrice, db, accountId = 1) {
  try {
    // Atualizar cache de preços
    updatePriceCache(symbol, currentPrice);
    
    // Atualizar preços das posições
    await updatePositionPrices(db, symbol, currentPrice);

    // Log periódico de preços
    const now = Date.now();
    if (!lastPriceLogTime[symbol] || (now - lastPriceLogTime[symbol] > PRICE_LOG_INTERVAL)) {
      lastPriceLogTime[symbol] = now;
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
      
      // Incrementar contador de verificações vazias
      websocketEmptyCheckCounter[symbol] = (websocketEmptyCheckCounter[symbol] || 0) + 1;
      
      // Se não há atividade por 5 verificações consecutivas, fechar websocket
      if (websocketEmptyCheckCounter[symbol] >= 5) {
        console.log(`[PRICE] Fechando websocket de ${symbol} - sem atividade (conta ${accountId})`);
        websockets.stopPriceMonitoring(symbol, accountId);
        delete websocketEmptyCheckCounter[symbol];
        delete lastPriceLogTime[symbol];
        latestPrices.delete(symbol);
      }
    } else {
      // Reset contador se há atividade
      websocketEmptyCheckCounter[symbol] = 0;
    }

    // Processar sinais pendentes
    for (const signal of pendingSignals) {
      try {
        await processSignalTrigger(signal, currentPrice, db, accountId);
      } catch (signalError) {
        console.error(`[PRICE] Erro ao processar sinal ${signal.id}:`, signalError);
      }
    }
  } catch (error) {
    console.error(`[PRICE] Erro no processamento de preço para ${symbol}:`, error);
  }
}

/**
 * Atualiza preços das posições no banco
 * @param {Object} db - Conexão com banco
 * @param {string} symbol - Símbolo do par
 * @param {number} currentPrice - Preço atual
 */
async function updatePositionPrices(db, symbol, currentPrice) {
  try {
    // Buscar posições abertas para o símbolo
    const [positions] = await db.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"',
      [symbol]
    );

    if (positions.length === 0) {
      return;
    }

    // Para cada posição, atualizar o preço corrente
    for (const position of positions) {
      const now = new Date();
      const formattedDate = now.toISOString().replace('T', ' ').substring(0, 19);
      
      try {
        await db.query(
          `UPDATE posicoes 
           SET preco_corrente = ?, data_hora_ultima_atualizacao = ?
           WHERE id = ?`,
          [currentPrice, formattedDate, position.id]
        );
      } catch (updateError) {
        console.error(`[PRICE] Erro ao atualizar preço da posição ${position.id}:`, updateError);
      }
    }
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar preços das posições para ${symbol}:`, error);
  }
}

/**
 * Verifica e fecha websockets sem atividade
 * @param {Object} db - Conexão com banco
 * @param {string} symbol - Símbolo a verificar
 */
async function checkAndCloseWebsocket(db, symbol) {
  try {
    // Verificar se ainda há atividade para este símbolo
    const [pendingSignals] = await db.query(
      `SELECT COUNT(*) as count FROM webhook_signals 
       WHERE symbol = ? AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')`,
      [symbol]
    );
    
    const [openPositions] = await db.query(
      `SELECT COUNT(*) as count FROM posicoes 
       WHERE simbolo = ? AND status = 'OPEN'`,
      [symbol]
    );
    
    const [pendingOrders] = await db.query(
      `SELECT COUNT(*) as count FROM ordens
       WHERE simbolo = ? AND status = 'NEW'`,
      [symbol]
    );

    const totalActivity = 
      (pendingSignals[0]?.count || 0) + 
      (openPositions[0]?.count || 0) + 
      (pendingOrders[0]?.count || 0);

    if (totalActivity === 0) {
      console.log(`[PRICE] Fechando websocket de ${symbol} - sem atividade restante`);
      websockets.stopPriceMonitoring(symbol);
      latestPrices.delete(symbol);
      delete lastPriceLogTime[symbol];
      delete websocketEmptyCheckCounter[symbol];
    }
  } catch (error) {
    console.error(`[PRICE] Erro ao verificar atividade para ${symbol}:`, error);
  }
}

module.exports = {
  startPriceMonitoring,
  getCurrentPrice,
  getWebSocketPrice,
  updatePriceCache,
  onPriceUpdate,
  updatePositionPrices,
  checkAndCloseWebsocket
};