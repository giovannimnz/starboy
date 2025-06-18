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
      console.error(`[PRICE] Símbolo inválido: ${symbol}`);
      return;
    }
    
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.error(`[PRICE] Preço inválido: ${currentPrice}`);
      return;
    }
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[PRICE] AccountId inválido: ${accountId}`);
      return;
    }
    
    // NOVO: Usar função melhorada com trailing stops
    await updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId);

    // Buscar sinais pendentes
    const [pendingSignalsResult] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE symbol = ? AND conta_id = ? AND 
      (status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING')
    `, [symbol, accountId]);
    
    const pendingSignals = pendingSignalsResult || [];

    // Processar cada sinal pendente
    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price);
      const slPrice = parseFloat(signal.sl_price);
      
      // Verificar condições de acionamento
      const isTriggered = (signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY') 
        ? currentPrice >= entryPrice 
        : currentPrice <= entryPrice;
      
      const isStopLossHit = slPrice > 0 && (
        (signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY') 
          ? currentPrice <= slPrice 
          : currentPrice >= slPrice
      );

      // Verificar timeout
      const now = new Date();
      const timeoutAt = signal.timeout_at ? new Date(signal.timeout_at) : null;
      const isTimedOut = timeoutAt && now >= timeoutAt;

      if (isTriggered) {
        console.log(`[PRICE] ✅ Gatilho acionado para ${signal.symbol} @ ${currentPrice}`);
        
        try {
          const { processSignal } = require('./signalProcessor');
          await processSignal(signal, db, accountId);
        } catch (processError) {
          console.error(`[PRICE] Erro ao processar sinal ${signal.id}:`, processError.message);
        }
      } else if (isStopLossHit) {
        console.log(`[PRICE] ❌ SL atingido antes da entrada para ${signal.symbol}`);
        
        const { cancelSignal } = require('./signalTimeout');
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY',
          `Stop loss (${slPrice}) atingido antes da entrada (${currentPrice})`, accountId);
      } else if (isTimedOut) {
        console.log(`[PRICE] ⏱️ Timeout para sinal ${signal.id} (${signal.symbol})`);
        
        const { cancelSignal } = require('./signalTimeout');
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY',
          `Entrada não acionada dentro do limite de tempo`, accountId);
      }
    }

    // Verificar se deve fechar WebSocket
    const [counts] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM webhook_signals WHERE symbol = ? AND conta_id = ? AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')) as signals,
        (SELECT COUNT(*) FROM posicoes WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN') as positions,
        (SELECT COUNT(*) FROM ordens WHERE simbolo = ? AND conta_id = ? AND status = 'NEW') as orders
    `, [symbol, accountId, symbol, accountId, symbol, accountId]);

    const totalActivity = (counts[0]?.signals || 0) + (counts[0]?.positions || 0) + (counts[0]?.orders || 0);

    if (totalActivity === 0) {
      const websockets = require('../websockets');
      websockets.stopPriceMonitoring(symbol, accountId);
      console.log(`[PRICE] WebSocket fechado para ${symbol} (conta ${accountId}) - sem atividade`);
    }

  } catch (error) {
    console.error(`[PRICE] Erro no processamento para ${symbol} (conta ${accountId}):`, error);
  }
}

/**
 * Atualiza preços das posições abertas com suporte a trailing stops
 * @param {Object} db - Conexão com banco
 * @param {string} symbol - Símbolo
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    // Obter todas as posições abertas para o símbolo
    const [positions] = await db.query(`
      SELECT * FROM posicoes
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      const { id, tipo, preco_abertura, stop_loss, take_profit } = position;
      
      let newStopLoss = stop_loss;
      let newTakeProfit = take_profit;
      let updateNeeded = false;
      
      // Ajustar stop loss para cima se for uma posição de compra
      if (tipo === 'COMPRA' || tipo === 'BUY') {
        if (currentPrice > preco_abertura) {
          const trailingStop = currentPrice - (preco_abertura * 0.02); // Exemplo: 2% abaixo do preço atual
          if (trailingStop > stop_loss) {
            newStopLoss = trailingStop;
            updateNeeded = true;
          }
        }
      } 
      // Ajustar stop loss para baixo se for uma posição de venda
      else if (tipo === 'VENDA' || tipo === 'SELL') {
        if (currentPrice < preco_abertura) {
          const trailingStop = currentPrice + (preco_abertura * 0.02); // Exemplo: 2% acima do preço atual
          if (trailingStop < stop_loss) {
            newStopLoss = trailingStop;
            updateNeeded = true;
          }
        }
      }

      // Atualizar stop loss na base de dados se necessário
      if (updateNeeded) {
        await db.query(`
          UPDATE posicoes
          SET stop_loss = ?, data_hora_ultima_atualizacao = NOW()
          WHERE id = ?
        `, [newStopLoss, id]);
        
        console.log(`[PRICE] Stop loss atualizado para posição ${id} (${symbol}): ${newStopLoss}`);
      }
    }
  } catch (error) {
    console.error(`[PRICE] Erro ao atualizar posições com trailing stops para ${symbol}:`, error);
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