const api = require('../api/rest');
const websockets = require('../api/websocket');
const { getDatabaseInstance } = require('../../../core/database/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
const { sendTelegramMessage } = require('./telegramBot');

// Set para rastrear sinais em processamento
const processingSignals = new Set();

// Cache de preços
const priceCache = new Map();
const PRICE_CACHE_TTL = 30000; // 30 segundos

/**
 * ✅ CACHE DE PREÇOS
 */
function updatePriceCache(symbol, price, accountId) {
  try {
    if (!symbol || !price || price <= 0) return false;
    
    const cacheKey = `${symbol}_${accountId || 'global'}`;
    priceCache.set(cacheKey, {
      price: parseFloat(price),
      timestamp: Date.now(),
      symbol: symbol,
      accountId: accountId
    });
    
    return true;
  } catch (error) {
    console.error(`[PRICE_CACHE] Erro ao atualizar cache:`, error.message);
    return false;
  }
}

function getPriceFromCache(symbol, accountId = null, maxAge = PRICE_CACHE_TTL) {
  try {
    const cacheKey = `${symbol}_${accountId || 'global'}`;
    const cacheData = priceCache.get(cacheKey);
    
    if (!cacheData) return null;
    
    const age = Date.now() - cacheData.timestamp;
    if (age > maxAge) {
      priceCache.delete(cacheKey);
      return null;
    }
    
    return {
      price: cacheData.price,
      age: age,
      timestamp: cacheData.timestamp,
      symbol: cacheData.symbol
    };
  } catch (error) {
    return null;
  }
}

/**
 * ✅ CONVERSÃO DE TIMEFRAME PARA MILISSEGUNDOS
 */
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  const match = timeframe.match(/^(\d+)([mhdwMy])$/i);
  if (!match) return 0;

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  switch(unit.toLowerCase()) {
    case 'm': return numValue * 60 * 1000;                    // minutos
    case 'h': return numValue * 60 * 60 * 1000;               // horas
    case 'd': return numValue * 24 * 60 * 60 * 1000;          // dias
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000;      // semanas
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000;     // meses
    case 'y': return numValue * 365 * 24 * 60 * 60 * 1000;    // anos
    default: return 0;
  }
}

/**
 * ✅ NORMALIZA LADO DO SINAL
 */
function normalizeSide(side) {
  if (!side) return null;
  
  const normalizedSide = side.toString().toUpperCase();
  
  if (['BUY', 'COMPRA', 'LONG'].includes(normalizedSide)) {
    return 'BUY';
  } else if (['SELL', 'VENDA', 'SHORT'].includes(normalizedSide)) {
    return 'SELL';
  }
  
  return null;
}

/**
 * ✅ CANCELA UM SINAL COM NOTIFICAÇÃO
 */
async function cancelSignal(db, signalId, status, reason, accountId) {
  try {
    console.log(`[SIGNAL] Cancelando sinal ${signalId} para conta ${accountId}: ${reason}`);
    
    // Obter dados do sinal antes de cancelar
    const [signalData] = await db.query(`
      SELECT symbol, side, leverage, entry_price
      FROM webhook_signals
      WHERE id = ? AND conta_id = ?
    `, [signalId, accountId]);
    
    await db.query(`
      UPDATE webhook_signals
      SET status = ?,
          error_message = ?,
          updated_at = NOW()
      WHERE id = ? AND conta_id = ?
    `, [status, reason, signalId, accountId]);
    
    // Notificação Telegram
    try {
      if (signalData.length > 0) {
        const signal = signalData[0];
        const side = signal.side === 'BUY' ? '🟢 COMPRA' : '🔴 VENDA';
        const message = `⏰ <b>SINAL CANCELADO</b>\n\n` +
                       `📊 <b>${signal.symbol}</b>\n` +
                       `${side} | ${signal.leverage}x\n` +
                       `💰 Entrada: $${signal.entry_price}\n\n` +
                       `📝 <b>Motivo:</b>\n${reason}\n\n` +
                       `🆔 Sinal: #${signalId}\n` +
                       `⏰ ${new Date().toLocaleString('pt-BR')}`;
        
        await sendTelegramMessage(accountId, message);
      }
    } catch (telegramError) {
      console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação Telegram:`, telegramError.message);
    }
    
  } catch (error) {
    console.error(`[SIGNAL] Erro ao cancelar sinal ${signalId}:`, error.message);
  }
}

/**
 * ✅ VERIFICA GATILHOS DE ENTRADA BASEADOS NO PREÇO
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

    if (pendingSignals.length === 0) return;

    const now = new Date();

    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price || 0);
      const slPrice = parseFloat(signal.sl_price || 0);
      const side = signal.side.toUpperCase();
      
      // ✅ VERIFICAR TIMEOUT BASEADO NO TIMEFRAME
      let isTimedOut = false;
      if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        const maxLifetime = timeframeMs * 3; // 3x o timeframe
        const createdAt = new Date(signal.created_at);
        const ageMs = now.getTime() - createdAt.getTime();
        
        if (ageMs > maxLifetime) {
          isTimedOut = true;
        }
      } else if (signal.timeout_at && now >= new Date(signal.timeout_at)) {
        isTimedOut = true;
      } else if (signal.max_lifetime_minutes) {
        const createdAt = new Date(signal.created_at);
        const maxLifetimeMs = signal.max_lifetime_minutes * 60 * 1000;
        const ageMs = now.getTime() - createdAt.getTime();
        
        if (ageMs > maxLifetimeMs) {
          isTimedOut = true;
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
      }

      // ✅ VERIFICAR SE PREÇO DE ENTRADA FOI ATINGIDO (GATILHO)
      let entryTriggered = false;
      if (entryPrice > 0) {
        if (side === 'BUY' || side === 'COMPRA') {
          entryTriggered = currentPrice >= entryPrice;
        } else if (side === 'SELL' || side === 'VENDA') {
          entryTriggered = currentPrice <= entryPrice;
        }
      }

      // ✅ TOMAR AÇÕES BASEADAS NAS VERIFICAÇÕES
      if (isTimedOut) {
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY', 
          `Sinal expirou (timeframe: ${signal.timeframe})`, accountId);
        
      } else if (stopLossHit) {
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY', 
          `Stop loss (${slPrice}) atingido antes da entrada (preço atual: ${currentPrice})`, accountId);
        
      } else if (entryTriggered) {
        console.log(`[SIGNAL] 🚀 Processando entrada para sinal ${signal.id}...`);
        
        try {
          // Atualizar status para PROCESSANDO
          await db.query(
            'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
            ['PROCESSANDO', signal.id]
          );
          
          // Processar o sinal
          await processSignal(signal, db, accountId);
          
        } catch (processError) {
          console.error(`[SIGNAL] ❌ Erro ao processar sinal ${signal.id}:`, processError.message);
          
          // Reverter status em caso de erro
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', processError.message.substring(0, 250), signal.id]
          );
        }
      }
    }

  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar gatilhos para ${symbol}:`, error.message);
  }
}

/**
 * ✅ PROCESSA UM SINAL ESPECÍFICO
 */
async function processSignal(signal, db, accountId) {
  const signalId = signal.id;
  
  // Verificar se já está sendo processado
  if (processingSignals.has(signalId)) {
    console.log(`[SIGNAL] Sinal ${signalId} já está sendo processado, ignorando...`);
    return { success: false, error: 'Sinal já em processamento' };
  }
  
  // Adicionar ao set de processamento
  processingSignals.add(signalId);
  
  try {
    console.log(`[SIGNAL] 🔄 Processando sinal ${signalId} para ${signal.symbol}: ${signal.side} a ${signal.entry_price || signal.price}`);
    
    // Verificar se já existe posição aberta para este símbolo
    const openPositions = await api.getAllOpenPositions(accountId);
    const existingPosition = openPositions.find(pos => pos.simbolo === signal.symbol);
    
    if (existingPosition) {
      console.log(`[SIGNAL] ⚠️ Já existe posição aberta para ${signal.symbol}, ignorando sinal ${signalId}`);
      
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', 'Posição já existe para este símbolo', signalId]
      );
      
      return { success: false, error: 'Posição já existe para este símbolo' };
    }
    
    // Normalizar lado do sinal
    const normalizedSide = normalizeSide(signal.side);
    if (!normalizedSide) {
      throw new Error(`Lado do sinal inválido: ${signal.side}`);
    }
    
    // Preparar dados do sinal para execução
    const signalForEntry = {
      ...signal,
      side: normalizedSide,
      entry_price: signal.entry_price || signal.price,
      conta_id: accountId
    };
    
    // Obter preço atual
    const currentPrice = await api.getPrice(signal.symbol, accountId);
    
    if (!currentPrice || currentPrice <= 0) {
      throw new Error(`Preço inválido obtido para ${signal.symbol}: ${currentPrice}`);
    }
    
    console.log(`[SIGNAL] 💰 Preço atual obtido: ${currentPrice}`);
    
    // Executar entrada usando limitMakerEntry
    const entryResult = await executeLimitMakerEntry(signalForEntry, currentPrice, accountId);
    
    if (entryResult && entryResult.success) {
      console.log(`[SIGNAL] ✅ Entrada executada com sucesso para sinal ${signalId}`);
      
      // Atualizar status para COMPLETED
      await db.query(
        'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
        ['COMPLETED', signalId]
      );
      
      // Enviar notificação via Telegram se configurado
      try {
        const { formatEntryMessage } = require('./telegramBot');
        const totalValue = entryResult.filledQuantity * entryResult.averagePrice;
        const message = formatEntryMessage(
          signalForEntry, 
          entryResult.filledQuantity || 0, 
          entryResult.averagePrice || currentPrice, 
          totalValue || 0
        );
        
        await sendTelegramMessage(accountId, message);
        console.log(`[SIGNAL] 📱 Notificação enviada via Telegram para sinal ${signalId}`);
      } catch (telegramError) {
        console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação Telegram:`, telegramError.message);
      }
      
      return entryResult;
      
    } else {
      const errorMsg = entryResult?.error || 'Erro desconhecido na execução da entrada';
      console.error(`[SIGNAL] ❌ Erro na execução da entrada para sinal ${signalId}: ${errorMsg}`);
      
      // Atualizar status para ERROR
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', errorMsg.substring(0, 250), signalId]
      );
      
      return { success: false, error: errorMsg };
    }
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro no processamento do sinal ${signalId}:`, error.message);
    
    // Atualizar status para ERROR se ainda não foi atualizado
    try {
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ? AND status = ?',
        ['ERROR', error.message.substring(0, 250), signalId, 'PROCESSANDO']
      );
    } catch (updateError) {
      console.error(`[SIGNAL] ❌ Erro ao atualizar status de erro:`, updateError.message);
    }
    
    return { success: false, error: error.message };
    
  } finally {
    // Remover do set de processamento
    processingSignals.delete(signalId);
  }
}

/**
 * ✅ VERIFICA SINAIS EXPIRADOS
 */
async function checkExpiredSignals(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar sinais que podem ter expirado
    const [potentialExpiredSignals] = await db.query(`
      SELECT 
        id, symbol, timeframe, created_at, status, entry_price, sl_price, side,
        timeout_at, max_lifetime_minutes
      FROM webhook_signals 
      WHERE conta_id = ? 
        AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO', 'ENTRADA_EM_PROGRESSO')
        AND created_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
      ORDER BY created_at ASC
    `, [accountId]);
    
    if (potentialExpiredSignals.length === 0) return 0;
    
    let canceledCount = 0;
    const now = new Date();
    
    for (const signal of potentialExpiredSignals) {
      const createdAt = new Date(signal.created_at);
      const signalAge = now.getTime() - createdAt.getTime();
      const signalAgeMinutes = Math.round(signalAge / 60000);
      
      let shouldExpire = false;
      let expireReason = '';
      
      // REGRA 1: TIMEFRAME * 3 (PRINCIPAL)
      if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        if (timeframeMs > 0) {
          const maxLifetime = timeframeMs * 3;
          const maxLifetimeMinutes = Math.round(maxLifetime / 60000);
          
          if (signalAge > maxLifetime) {
            shouldExpire = true;
            expireReason = `Timeframe expirado (${signal.timeframe} * 3 = ${maxLifetimeMinutes}min, idade: ${signalAgeMinutes}min)`;
          }
        }
      }
      
      // REGRA 2: timeout_at específico
      if (!shouldExpire && signal.timeout_at) {
        const timeoutAt = new Date(signal.timeout_at);
        if (now >= timeoutAt) {
          shouldExpire = true;
          expireReason = `timeout_at atingido`;
        }
      }
      
      // REGRA 3: max_lifetime_minutes
      if (!shouldExpire && signal.max_lifetime_minutes) {
        const maxLifetimeMs = signal.max_lifetime_minutes * 60 * 1000;
        if (signalAge > maxLifetimeMs) {
          shouldExpire = true;
          expireReason = `max_lifetime_minutes atingido`;
        }
      }
      
      // REGRA 4: Fallback para sinais muito antigos (6 horas)
      if (!shouldExpire && signalAge > (6 * 60 * 60 * 1000)) {
        shouldExpire = true;
        expireReason = `Sinal muito antigo (${signalAgeMinutes}min > 360min)`;
      }
      
      // CANCELAR SINAL SE EXPIRADO
      if (shouldExpire) {
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY', expireReason, accountId);
        canceledCount++;
      }
    }
    
    return canceledCount;
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar sinais expirados:`, error.message);
    return 0;
  }
}

/**
 * ✅ VERIFICA E PROCESSA NOVOS SINAIS
 */
async function checkNewTrades(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Buscar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE conta_id = ? 
      AND (status = 'PENDING' OR status = 'AGUARDANDO_ACIONAMENTO')
      ORDER BY created_at ASC
      LIMIT 10
    `, [accountId]);
    
    if (pendingSignals.length === 0) return 0;
    
    // Processar cada sinal
    for (const signal of pendingSignals) {
      try {
        // Verificar se o sinal não expirou
        if (signal.timeout_at && new Date() > new Date(signal.timeout_at)) {
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', 'Sinal expirado (timeout_at)', signal.id]
          );
          continue;
        }
        
        // Processar o sinal
        const result = await processSignal(signal, db, accountId);
        
        if (result.success) {
          console.log(`[SIGNAL] ✅ Sinal ${signal.id} processado com sucesso`);
        } else {
          console.log(`[SIGNAL] ⚠️ Sinal ${signal.id} falhou: ${result.error}`);
        }
        
      } catch (signalError) {
        console.error(`[SIGNAL] ❌ Erro ao processar sinal ${signal.id}:`, signalError.message);
        
        // Marcar sinal como ERROR
        try {
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', signalError.message.substring(0, 250), signal.id]
          );
        } catch (updateError) {
          console.error(`[SIGNAL] ❌ Erro ao atualizar status de erro:`, updateError.message);
        }
      }
    }
    
    return pendingSignals.length;
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar novos sinais:`, error.message);
    return 0;
  }
}

/**
 * ✅ PROCESSA ATUALIZAÇÃO DE PREÇO
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
    
    // Atualizar cache de preços
    updatePriceCache(symbol, currentPrice, accountId);
    
    // Verificar gatilhos de entrada PRIMEIRO
    await checkSignalTriggers(symbol, currentPrice, db, accountId);
    
    // Atualizar preços das posições com trailing
    const { updatePositionPricesWithTrailing } = require('./enhancedMonitoring');
    await updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId);

  } catch (error) {
    console.error(`[PRICE] Erro no processamento para ${symbol}:`, error);
  }
}

module.exports = {
  // Funções principais
  processSignal,
  checkNewTrades,
  checkExpiredSignals,
  
  // Funções de preço
  onPriceUpdate,
  checkSignalTriggers,
  updatePriceCache,
  getPriceFromCache,
  
  // Funções utilitárias
  timeframeToMs,
  normalizeSide,
  cancelSignal
};