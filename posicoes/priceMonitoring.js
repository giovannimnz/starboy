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
    
    // ✅ NOVO: Verificar gatilhos de entrada PRIMEIRO
    await checkSignalTriggers(symbol, currentPrice, db, accountId);
    
    // RESTO DA FUNÇÃO MANTIDA COMO ESTAVA...
    await updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId);

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
 * ✅ FUNÇÃO DE GATILHO DE ENTRADA BASEADA NO PREÇO - VERSÃO DO _DEV
 * Verifica se o preço atingiu o preço de entrada para acionar o sinal
 * @param {string} symbol - Símbolo
 * @param {number} currentPrice - Preço atual
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function checkSignalTriggers(symbol, currentPrice, db, accountId) {
  try {
    // Buscar sinais AGUARDANDO_ACIONAMENTO para este símbolo
    const [pendingSignals] = await db.query(`
      SELECT 
        id, symbol, side, entry_price, sl_price, timeframe, 
        created_at, timeout_at, max_lifetime_minutes, status
      FROM webhook_signals
      WHERE symbol = ? 
        AND conta_id = ? 
        AND status = 'AGUARDANDO_ACIONAMENTO'
      ORDER BY created_at ASC
    `, [symbol, accountId]);

    if (pendingSignals.length === 0) {
      return;
    }

    console.log(`[PRICE_TRIGGER] 🔍 Verificando ${pendingSignals.length} sinais pendentes para ${symbol} @ ${currentPrice}`);

    const now = new Date();

    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price || 0);
      const slPrice = parseFloat(signal.sl_price || 0);
      const side = signal.side.toUpperCase();
      
      console.log(`[PRICE_TRIGGER] 📊 Sinal ${signal.id}: ${side} @ ${entryPrice} (SL: ${slPrice || 'N/A'})`);

      // ✅ VERIFICAR TIMEOUT BASEADO NO TIMEFRAME
      let isTimedOut = false;
      if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        const maxLifetime = timeframeMs * 3; // 3x o timeframe
        const createdAt = new Date(signal.created_at);
        const ageMs = now.getTime() - createdAt.getTime();
        
        if (ageMs > maxLifetime) {
          isTimedOut = true;
          console.log(`[PRICE_TRIGGER] ⏰ Sinal ${signal.id} expirou por timeframe (${signal.timeframe} * 3 = ${maxLifetime/1000/60}min)`);
        }
      } else if (signal.timeout_at && now >= new Date(signal.timeout_at)) {
        isTimedOut = true;
        console.log(`[PRICE_TRIGGER] ⏰ Sinal ${signal.id} expirou por timeout_at`);
      } else if (signal.max_lifetime_minutes) {
        const createdAt = new Date(signal.created_at);
        const maxLifetimeMs = signal.max_lifetime_minutes * 60 * 1000;
        const ageMs = now.getTime() - createdAt.getTime();
        
        if (ageMs > maxLifetimeMs) {
          isTimedOut = true;
          console.log(`[PRICE_TRIGGER] ⏰ Sinal ${signal.id} expirou por max_lifetime_minutes`);
        }
      }

      // ✅ VERIFICAR SE STOP LOSS FOI ATINGIDO ANTES DA ENTRADA
      let stopLossHit = false;
      if (slPrice > 0) {
        if (side === 'BUY' || side === 'COMPRA') {
          stopLossHit = currentPrice <= slPrice;
        } else if (side === 'SELL' || side === 'VENDA') {
          stopLossHit = currentPrice >= slPrice;
        }
        
        if (stopLossHit) {
          console.log(`[PRICE_TRIGGER] 🛑 Stop Loss atingido ANTES da entrada para sinal ${signal.id}: ${currentPrice} vs SL ${slPrice}`);
        }
      }

      // ✅ VERIFICAR SE PREÇO DE ENTRADA FOI ATINGIDO (GATILHO)
      let entryTriggered = false;
      if (entryPrice > 0) {
        if (side === 'BUY' || side === 'COMPRA') {
          entryTriggered = currentPrice >= entryPrice;
        } else if (side === 'SELL' || side === 'VENDA') {
          entryTriggered = currentPrice <= entryPrice;
        }
        
        if (entryTriggered) {
          console.log(`[PRICE_TRIGGER] 🎯 Entrada acionada para sinal ${signal.id}: ${currentPrice} ${side === 'BUY' ? '>=' : '<='} ${entryPrice}`);
        }
      }

      // ✅ TOMAR AÇÕES BASEADAS NAS VERIFICAÇÕES
      if (isTimedOut) {
        const { cancelSignal } = require('./signalTimeout');
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY', 
          `Sinal expirou (timeframe: ${signal.timeframe}, idade: ${Math.round((now.getTime() - new Date(signal.created_at).getTime()) / 60000)}min)`, 
          accountId);
        
      } else if (stopLossHit) {
        const { cancelSignal } = require('./signalTimeout');
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY', 
          `Stop loss (${slPrice}) atingido antes da entrada (preço atual: ${currentPrice})`, 
          accountId);
        
      } else if (entryTriggered) {
        console.log(`[PRICE_TRIGGER] 🚀 Processando entrada para sinal ${signal.id}...`);
        
        try {
          // Atualizar status para PROCESSANDO
          await db.query(
            'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
            ['PROCESSANDO', signal.id]
          );
          
          // Processar o sinal
          const { processSignal } = require('./signalProcessor');
          await processSignal(signal, db, accountId);
          
        } catch (processError) {
          console.error(`[PRICE_TRIGGER] ❌ Erro ao processar sinal ${signal.id}:`, processError.message);
          
          // Reverter status em caso de erro
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', processError.message.substring(0, 250), signal.id]
          );
        }
      }
    }

  } catch (error) {
    console.error(`[PRICE_TRIGGER] ❌ Erro ao verificar gatilhos para ${symbol} conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ CONVERSÃO DE TIMEFRAME PARA MILISSEGUNDOS
 */
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) return 0;

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  switch(unit) {
    case 'm': return numValue * 60 * 1000;           // minutos
    case 'h': return numValue * 60 * 60 * 1000;      // horas
    case 'd': return numValue * 24 * 60 * 60 * 1000; // dias
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000; // semanas
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000; // meses (aprox.)
    default: return 0;
  }
}

// ✅ ADICIONAR AO module.exports:
module.exports = {
  startPriceMonitoring,
  onPriceUpdate,
  updatePriceCache,
  getPriceFromCache,
  checkAndCloseWebsocket,
  checkSignalTriggers, // ✅ NOVA FUNÇÃO
  timeframeToMs        // ✅ NOVA FUNÇÃO
};