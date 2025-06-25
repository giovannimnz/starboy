const api = require('../api/rest');
const websockets = require('../api/websocket');
const { getDatabaseInstance } = require('../../../core/database/conexao');
const { executeReverse } = require('../strategies/reverse');
const { sendTelegramMessage, formatSignalRegisteredMessage } = require('../telegram/telegramBot');

// Set para rastrear sinais em processamento
const processingSignals = new Set();

// Cache de preços
const priceCache = new Map();
const PRICE_CACHE_TTL = 30000;
const lastPriceLogTime = new Map();

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
 * ✅ VERSÃO CORRIGIDA: Usa apenas WebSocket, sem consultas REST desnecessárias
 */
async function processSignal(signal, db, accountId) {
  const signalId = signal.id;

  // NOVO: Se já estiver cancelado, envie mensagem de cancelamento e finalize
  if (
    signal.status &&
    (signal.status.toUpperCase() === 'CANCELED' || signal.status.toUpperCase() === 'CANCELADO')
    && !signal.sent_msg // só envia se ainda não enviou
  ) {
    try {
      const side = signal.side === 'BUY' || signal.side === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
      const motivo = signal.error_message || 'Sinal cancelado pelo sistema';
      const tps = [
        signal.tp1_price, signal.tp2_price, signal.tp3_price,
        signal.tp4_price, signal.tp5_price
      ].filter(tp => tp !== undefined && tp !== null && tp !== '');

      let tpsText = '';
      tps.forEach((tp, idx) => {
        tpsText += `\nALVO ${idx + 1}: ${tp}`;
      });

      const cancelMsg =
        `⏰ <b>SINAL CANCELADO</b>\n\n` +
        `#${signal.symbol}  ${side}\n` +
        `${signal.timeframe || ''}\n${signal.message_source || 'Divap'}\n\n` +
        `ALAVANCAGEM: ${signal.leverage || ''}x\n` +
        `MARGEM: CRUZADA\n` +
        `CAPITAL: ${signal.capital_pct ? parseFloat(signal.capital_pct).toFixed(2) + '%' : ''}\n\n` +
        `ENTRADA: ${signal.entry_price}\n` +
        `${tpsText}\n\n` +
        `STOP LOSS: ${signal.sl_price}\n\n` +
        `📝 <b>Motivo:</b>\n${motivo}\n\n` +
        `🆔 Sinal: #${signalId}\n` +
        `⏰ ${new Date().toLocaleString('pt-BR')}`;

      await sendTelegramMessage(accountId, cancelMsg, signal.chat_id);

      // Atualizar sent_msg para não reenviar
      await db.query(
        'UPDATE webhook_signals SET sent_msg = 1, updated_at = NOW() WHERE id = ?',
        [signalId]
      );

      console.log(`[SIGNAL] 📢 Mensagem de cancelamento enviada para sinal ${signalId}`);
    } catch (err) {
      console.error(`[SIGNAL] ❌ Erro ao enviar mensagem de cancelamento para sinal ${signalId}:`, err.message);
    }
    return { success: false, error: 'Sinal já estava cancelado' };
  }

  try {
    console.log(`[SIGNAL] 🔄 Processando sinal ${signalId} para ${signal.symbol}: ${signal.side} aguardando entrada em ${signal.entry_price}`);
    
    // 1. VERIFICAR SE JÁ EXISTE POSIÇÃO (mantém consulta ao banco, não REST)
    const positionExists = await checkPositionExists(db, signal.symbol, accountId);
    if (positionExists) {
      console.log(`[SIGNAL] ⚠️ Já existe posição aberta para ${signal.symbol}, ignorando sinal ${signalId}`);
      
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', 'Posição já existe para este símbolo', signalId]
      );
      
      return { success: false, error: 'Posição já existe para este símbolo' };
    }
    
    // 2. CONFIGURAR ALAVANCAGEM (manter REST só para configuração)
    try {
      await api.changeInitialLeverage(signal.symbol, signal.leverage, accountId);
      console.log(`[SIGNAL] ✅ Alavancagem configurada: ${signal.leverage}x para ${signal.symbol}`);
    } catch (leverageError) {
      console.warn(`[SIGNAL] ⚠️ Erro ao configurar alavancagem, continuando: ${leverageError.message}`);
    }
    
    // 3. COLOCAR EM AGUARDO PARA GATILHO
    const now = new Date();
    let timeoutAt = null;
    let maxLifetimeMinutes = null;
    
    if (signal.timeframe) {
      const timeframeMs = timeframeToMs(signal.timeframe);
      if (timeframeMs > 0) {
        const maxLifetimeMs = timeframeMs * 3;
        timeoutAt = new Date(now.getTime() + maxLifetimeMs);
        maxLifetimeMinutes = Math.floor(maxLifetimeMs / (60 * 1000));
        
        console.log(`[SIGNAL] ⏰ Timeout definido para: ${timeoutAt.toISOString()} (${maxLifetimeMinutes} min)`);
      }
    }
    
    await db.query(
      `UPDATE webhook_signals SET 
        status = 'AGUARDANDO_ACIONAMENTO',
        timeout_at = ?,
        max_lifetime_minutes = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [timeoutAt, maxLifetimeMinutes, signalId]
    );
    
    // 4. ✅ INICIAR WEBSOCKET DE PREÇO E VERIFICAR SE FUNCIONOU
    console.log(`[SIGNAL] 📡 Iniciando WebSocket de preço para ${signal.symbol}...`);
    
    try {
      await websockets.ensurePriceWebsocketExists(signal.symbol, accountId);
      console.log(`[SIGNAL] ✅ WebSocket de preço solicitado para ${signal.symbol}`);
      
      // ✅ VERIFICAR SE WEBSOCKET ESTÁ REALMENTE ATIVO
      setTimeout(async () => {
        try {
          const priceWebsockets = websockets.getPriceWebsockets(accountId);
          const wsExists = priceWebsockets && priceWebsockets.has(signal.symbol);
          
          if (wsExists) {
            const ws = priceWebsockets.get(signal.symbol);
            const isOpen = ws && ws.readyState === 1; // WebSocket.OPEN
            console.log(`[SIGNAL] 🔍 Status WebSocket ${signal.symbol}: Existe=${wsExists}, Aberto=${isOpen}`);
            
            if (!isOpen) {
              console.warn(`[SIGNAL] ⚠️ WebSocket para ${signal.symbol} não está aberto! ReadyState: ${ws?.readyState}`);
            }
          } else {
            console.warn(`[SIGNAL] ⚠️ WebSocket para ${signal.symbol} não foi criado!`);
          }
        } catch (checkError) {
          console.error(`[SIGNAL] ❌ Erro ao verificar WebSocket:`, checkError.message);
        }
      }, 2000); // Verificar após 2 segundos
      
    } catch (wsError) {
      console.error(`[SIGNAL] ❌ Erro ao iniciar WebSocket para ${signal.symbol}:`, wsError.message);
      // Continuar mesmo com erro de WebSocket
    }
    
    // 5. ENVIAR NOTIFICAÇÃO TELEGRAM
    if (signal.chat_id) {
      try {
        // Use o nome do grupo se disponível, senão "Divap"
        const grupoOrigemNome = signal.grupo_origem_nome || 'Divap';
        const message = formatSignalRegisteredMessage(signal, grupoOrigemNome);
        await sendTelegramMessage(accountId, message);
        console.log(`[SIGNAL] 📱 Notificação enviada para sinal ${signalId}`);
      } catch (telegramError) {
        console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação:`, telegramError.message);
      }
    }
    
    console.log(`[SIGNAL] ✅ Sinal ${signalId} registrado. Status: AGUARDANDO_ACIONAMENTO. WebSocket ativo.`);
    return { success: true, signal: signalId };
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao processar sinal ${signalId}:`, error.message);
    
    try {
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', error.message.substring(0, 250), signalId]
      );
    } catch (updateError) {
      console.error(`[SIGNAL] ❌ Erro ao atualizar status de erro:`, updateError.message);
    }
    
    return { success: false, error: error.message };
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
 * ✅ VERSÃO CORRIGIDA: Verifica apenas sinais PENDING
 * Baseada na versão eficiente do starboy_dev
 */
async function checkNewTrades(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Buscar apenas sinais PENDING (como na versão antiga)
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE conta_id = ? 
      AND status = 'PENDING'
      ORDER BY created_at ASC
      LIMIT 10
    `, [accountId]);
    
    if (pendingSignals.length === 0) return 0;
    
    console.log(`[SIGNAL] 📋 Processando ${pendingSignals.length} sinais novos para conta ${accountId}`);
    
    for (const signal of pendingSignals) {
      try {
        // Processar o sinal (apenas registrar, não executar)
        const result = await processSignal(signal, db, accountId);
        
        if (result.success) {
          console.log(`[SIGNAL] ✅ Sinal ${signal.id} registrado com sucesso`);
        } else {
          console.log(`[SIGNAL] ⚠️ Sinal ${signal.id} falhou: ${result.error}`);
        }
        
      } catch (signalError) {
        console.error(`[SIGNAL] ❌ Erro ao processar sinal ${signal.id}:`, signalError.message);
        
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
 * ✅ VALIDAÇÕES CRÍTICAS ANTES DO PROCESSAMENTO
 */
async function validateSignalBeforeProcessing(signal, accountId, db) {
  try {
    // ✅ 1. Verificar se já expirou (sem REST)
    if (isSignalExpired(signal)) {
      return { isValid: false, reason: 'Sinal expirado antes do processamento' };
    }
    
    // ✅ 2. Verificar se já existe posição (banco de dados local)
    const positionExists = await checkPositionExists(db, signal.symbol, accountId);
    if (positionExists) {
      return { isValid: false, reason: `Posição já existe para ${signal.symbol}` };
    }
    
    // ✅ 3. Verificar Stop Loss usando cache de preços (WebSocket)
    const cachedPrice = getPriceFromCache(signal.symbol, accountId);
    if (cachedPrice && isStopLossAlreadyHit(signal, cachedPrice.price)) {
      return { isValid: false, reason: `Stop loss já atingido: preço=${cachedPrice.price}, sl=${signal.sl_price}` };
    }
    
    // ✅ 4. Verificar máximo de posições (banco local)
    const [positionCount] = await db.query(
      'SELECT COUNT(*) as count FROM posicoes WHERE conta_id = ? AND status = "OPEN"',
      [accountId]
    );
    
    if (positionCount[0].count >= 5) {
      return { isValid: false, reason: 'Limite máximo de posições atingido' };
    }
    
    return { isValid: true, reason: 'Validação passou' };
    
  } catch (error) {
    return { isValid: false, reason: `Erro na validação: ${error.message}` };
  }
}

/**
 * ✅ DETERMINA ESTRATÉGIA DE ENTRADA
 */
function determineEntryStrategy(signal) {
  // Sinal MARKET - execução imediata
  if (!signal.entry_price || signal.entry_price <= 0) {
    return 'IMMEDIATE';
  }
  
  // Sinal LIMIT com preço específico - aguardar gatilho
  if (signal.entry_price > 0) {
    return 'WAIT_FOR_TRIGGER';
  }
  
  return 'INVALID';
}

/**
 * ✅ EXECUÇÃO IMEDIATA (para sinais MARKET)
 */
async function processSignalImmediate(signal, db, accountId) {
  console.log(`[SIGNAL] 🚀 Executando entrada IMEDIATA para sinal ${signal.id}`);
  
  // Atualizar status
  await db.query(
    'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
    ['PROCESSANDO', signal.id]
  );
  
  try {
    const currentPrice = await api.getPrice(signal.symbol, accountId);
    const entryResult = await executeReverse(signal, currentPrice, accountId);
    
    if (entryResult && entryResult.success) {
      await db.query(
        'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
        ['EXECUTADO', signal.id]
      );
      
      console.log(`[SIGNAL] ✅ Entrada IMEDIATA executada com sucesso para sinal ${signal.id}`);
    } else {
      throw new Error(entryResult?.error || 'Falha na execução da entrada');
    }
    
  } catch (error) {
    await db.query(
      'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
      ['ERROR', error.message.substring(0, 250), signal.id]
    );
    
    throw error;
  }
}

/**
 * ✅ COLOCAR SINAL EM AGUARDO PARA GATILHO
 */
async function setSignalWaitingForTrigger(signal, db, accountId) {
  console.log(`[SIGNAL] ⏳ Colocando sinal ${signal.id} em aguardo para gatilho de preço: ${signal.entry_price}`);
  
  await db.query(
    'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
    ['AGUARDANDO_ACIONAMENTO', signal.id]
  );
  
  console.log(`[SIGNAL] ✅ Sinal ${signal.id} configurado para aguardar preço de entrada ${signal.entry_price}`);
}

/**
 * ✅ VERIFICAR SE SINAL EXPIROU
 */
function isSignalExpired(signal) {
  const now = new Date();
  const createdAt = new Date(signal.created_at);
  const ageMs = now.getTime() - createdAt.getTime();
  
  // Verificar timeout_at específico
  if (signal.timeout_at && now >= new Date(signal.timeout_at)) {
    return true;
  }
  
  // Verificar max_lifetime_minutes
  if (signal.max_lifetime_minutes) {
    const maxLifetimeMs = signal.max_lifetime_minutes * 60 * 1000;
    if (ageMs > maxLifetimeMs) {
      return true;
    }
  }
  
  // Verificar timeframe * 3
  if (signal.timeframe) {
    const timeframeMs = timeframeToMs(signal.timeframe);
    if (timeframeMs > 0) {
      const maxLifetime = timeframeMs * 3;
      if (ageMs > maxLifetime) {
        return true;
      }
    }
  }
  
  // Fallback: 6 horas
  if (ageMs > (6 * 60 * 60 * 1000)) {
    return true;
  }
  
  return false;
}

/**
 * ✅ VERIFICAR SE STOP LOSS JÁ FOI ATINGIDO
 */
function isStopLossAlreadyHit(signal, currentPrice) {
  if (!signal.sl_price || signal.sl_price <= 0) return false;
  
  const side = signal.side.toUpperCase();
  const slPrice = parseFloat(signal.sl_price);
  
  if (side === 'BUY' || side === 'COMPRA') {
    return currentPrice <= slPrice;
  } else if (side === 'SELL' || side === 'VENDA') {
    return currentPrice >= slPrice;
  }
  
  return false;
}

/**
 * ✅ CALCULAR CUSTO ESTIMADO DA POSIÇÃO
 */
function calculateEstimatedPositionCost(signal) {
  const leverage = parseInt(signal.leverage || 1);
  const capitalPct = parseFloat(signal.capital_pct || 1) / 100;
  const price = parseFloat(signal.entry_price || signal.price || 100);
  
  // Estimativa baseada em saldo médio de $1000
  const estimatedBalance = 1000;
  const positionValue = estimatedBalance * capitalPct;
  const marginRequired = positionValue / leverage;
  
  return marginRequired * 1.1; // 10% de margem de segurança
}

async function onPriceUpdate(symbol, currentPrice, db, accountId) {
  try {
    // ✅ LOG CONDICIONAL: Só mostrar se houver atividade relevante
    let hasRelevantActivity = false;
    
    // ✅ CORRIGIDO: Renomeado para evitar redeclaração
    const [pendingSignalsCount] = await db.query(`
      SELECT COUNT(*) as count FROM webhook_signals
      WHERE symbol = ? AND conta_id = ? AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol, accountId]);
    
    if (pendingSignalsCount[0].count > 0) {
      hasRelevantActivity = true;
      console.log(`[SIGNAL] 📊 onPriceUpdate via WebSocket: ${symbol} = ${currentPrice} (conta ${accountId}) - ${pendingSignalsCount[0].count} sinais aguardando`);
    }
    
    // Validação básica
    if (!symbol || !currentPrice || currentPrice <= 0 || !accountId) {
      if (hasRelevantActivity) {
        console.log(`[SIGNAL] ⚠️ Parâmetros inválidos: symbol=${symbol}, price=${currentPrice}, accountId=${accountId}`);
      }
      return;
    }
    
    // 1. ATUALIZAR CACHE DE PREÇOS
    const cacheUpdated = updatePriceCache(symbol, currentPrice, accountId);
    
    // 2. ATUALIZAR POSIÇÕES (usar enhancedMonitoring)
    try {
      const { updatePositionPricesWithTrailing } = require('./enhancedMonitoring');
      await updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId);
    } catch (positionError) {
      console.error(`[SIGNAL] ❌ Erro ao atualizar posições:`, positionError.message);
    }
    
    // 3. VERIFICAR SINAIS AGUARDANDO ACIONAMENTO (mantém o nome original)
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, sl_price, timeframe, 
             created_at, timeout_at, max_lifetime_minutes, chat_id
      FROM webhook_signals
      WHERE symbol = ? 
        AND conta_id = ? 
        AND status = 'AGUARDANDO_ACIONAMENTO'
      ORDER BY created_at ASC
    `, [symbol, accountId]);
    
    if (pendingSignals.length === 0) {
      // ✅ DEBUG: Mostrar quando não há sinais
      // console.log(`[SIGNAL] ℹ️ Nenhum sinal aguardando para ${symbol} (conta ${accountId})`);
      return;
    }
    
    console.log(`[SIGNAL] 🔍 Encontrados ${pendingSignals.length} sinais aguardando para ${symbol}`);
    
    const now = new Date();
    
    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price || 0);
      const slPrice = parseFloat(signal.sl_price || 0);
      const side = signal.side.toUpperCase();
      
      console.log(`[SIGNAL] 🔍 Verificando sinal ${signal.id}: ${side} ${symbol} entrada=${entryPrice}, atual=${currentPrice}, sl=${slPrice}`);
  
      // 4. VERIFICAR TIMEOUT
      let isTimedOut = false;
      if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        const maxLifetime = timeframeMs * 3;
        const createdAt = new Date(signal.created_at);
        const ageMs = now.getTime() - createdAt.getTime();
        
        if (ageMs > maxLifetime) {
          isTimedOut = true;
          console.log(`[SIGNAL] ⏰ Sinal ${signal.id} expirou por timeout: ${ageMs}ms > ${maxLifetime}ms`);
        }
      } else if (signal.timeout_at && now >= new Date(signal.timeout_at)) {
        isTimedOut = true;
        console.log(`[SIGNAL] ⏰ Sinal ${signal.id} expirou por timeout_at`);
      }
      
      // 5. VERIFICAR STOP LOSS
      let stopLossHit = false;
      if (slPrice > 0) {
        if (side === 'BUY' || side === 'COMPRA') {
          stopLossHit = currentPrice <= slPrice;
        } else if (side === 'SELL' || side === 'VENDA') {
          stopLossHit = currentPrice >= slPrice;
        }
        
        if (stopLossHit) {
          console.log(`[SIGNAL] 🛑 Stop loss atingido para sinal ${signal.id}: ${currentPrice} vs ${slPrice}`);
        }
      }
      
      // 6. ✅ VERIFICAR GATILHO DE ENTRADA (VERSÃO CORRIGIDA)
      let entryTriggered = false;
      if (entryPrice > 0) {
        if (side === 'BUY' || side === 'COMPRA') {
          entryTriggered = currentPrice >= entryPrice;
          console.log(`[SIGNAL] 🎯 LONG ${symbol}: ${currentPrice} >= ${entryPrice} = ${entryTriggered}`);
        } else if (side === 'SELL' || side === 'VENDA') {
          entryTriggered = currentPrice <= entryPrice;
          console.log(`[SIGNAL] 🎯 SHORT ${symbol}: ${currentPrice} <= ${entryPrice} = ${entryTriggered}`);
        }
      }
      
      console.log(`[SIGNAL] 📊 Status sinal ${signal.id}: timeout=${isTimedOut}, stopLoss=${stopLossHit}, gatilho=${entryTriggered}`);
      
      // 7. EXECUTAR AÇÕES
      if (isTimedOut) {
        console.log(`[SIGNAL] ⏰ Cancelando sinal ${signal.id} por timeout`);
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY', 
          `Sinal expirou (timeframe: ${signal.timeframe})`, accountId);
        
      } else if (stopLossHit) {
        console.log(`[SIGNAL] 🛑 Cancelando sinal ${signal.id} por stop loss atingido`);
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY', 
          `Stop loss (${slPrice}) atingido antes da entrada (preço atual: ${currentPrice})`, accountId);
        
      } else if (entryTriggered) {
        console.log(`[SIGNAL] 🚀 GATILHO ATIVADO! Executando entrada para sinal ${signal.id}!`);
        console.log(`[SIGNAL] 📊 Detalhes: ${side} ${symbol} - Preço atual: ${currentPrice}, Entrada: ${entryPrice}`);
        
        try {
          // Atualizar status para PROCESSANDO
          await db.query(
            'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
            ['PROCESSANDO', signal.id]
          );
          
          console.log(`[SIGNAL] 🔄 Status atualizado para PROCESSANDO, chamando executeReverse...`);
          
          // ✅ CHAMAR limitMakerEntry
          const entryResult = await executeReverse(signal, currentPrice, accountId);
          
          if (entryResult && entryResult.success) {
            console.log(`[SIGNAL] ✅ Entrada executada com sucesso para sinal ${signal.id}`);
            
            await db.query(
              'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
              ['EXECUTADO', signal.id]
            );
            
            // Enviar notificação de sucesso
            if (signal.chat_id) {
              try {
                const message = `✅ Entrada Executada\n\n` +
                               `📊 ${symbol}\n` +
                               `🎯 Preço: ${currentPrice}\n` +
                               `💰 Quantidade: ${entryResult.filledQuantity || 'N/A'}\n\n` +
                               `🆔 Sinal: #${signal.id}`;
                
                await sendTelegramMessage(accountId, message);
                console.log(`[SIGNAL] 📱 Notificação enviada para sinal ${signal.id}`);
              } catch (telegramError) {
                console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação de execução:`, telegramError.message);
              }
            }
          } else {
            console.error(`[SIGNAL] ❌ Falha na execução da entrada:`, entryResult);
            throw new Error(entryResult?.error || 'Falha na execução da entrada');
          }
          
        } catch (processError) {
          console.error(`[SIGNAL] ❌ Erro ao executar entrada para sinal ${signal.id}:`, processError.message);
          
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', processError.message.substring(0, 250), signal.id]
          );
        }
      } else {
        // ✅ LOG PERIÓDICO (A CADA 1 MINUTO)
        const logKey = `${symbol}_${signal.id}`;
        const currentTime = Date.now();
        const lastLogTime = lastPriceLogTime.get(logKey) || 0;
        
        if (currentTime - lastLogTime >= 60000) {
          const createdAt = new Date(signal.created_at);
          const elapsedMinutes = Math.round((now - createdAt) / 60000);
          const totalMinutes = signal.max_lifetime_minutes || 0;
          
          console.log(`[SIGNAL] 📊 Sinal ${signal.id} (${symbol}): Atual=${currentPrice}, Entrada=${entryPrice}, SL=${slPrice} | ${elapsedMinutes}/${totalMinutes}min`);
          
          lastPriceLogTime.set(logKey, currentTime);
        }
      }
    }
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro no processamento via WebSocket para ${symbol}:`, error.message);
    console.error(`[SIGNAL] Stack trace:`, error.stack);
  }
}

async function checkPositionExists(db, symbol, accountId) {
  try {
    const [rows] = await db.query(
      "SELECT id FROM posicoes WHERE simbolo = ? AND conta_id = ? AND (status = 'OPEN' OR status = 'PENDING')",
      [symbol, accountId]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

/**
 * ✅ FUNÇÃO UTILITÁRIA: Remove zeros à direita de números
 */
function formatNumberClean(value) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }
  
  const num = parseFloat(value);
  if (isNaN(num)) {
    return 'N/A';
  }
  
  // Converter para string e remover zeros à direita
  return num.toString();
}

/**
 * ✅ NOVA FUNÇÃO: Processa sinais que já chegaram cancelados (VERSÃO CORRIGIDA)
 */
async function checkCanceledSignals(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Buscar sinais que chegaram cancelados e ainda não enviaram mensagem
    const [canceledSignals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE conta_id = ? 
      AND status = 'CANCELED'
      AND sent_msg = 0
      ORDER BY created_at ASC
    `, [accountId]);
    
    if (canceledSignals.length === 0) return 0;
    
    console.log(`[SIGNAL] 📋 Processando ${canceledSignals.length} sinais cancelados para conta ${accountId}`);
    
    for (const signal of canceledSignals) {
      try {
        console.log(`[SIGNAL] 📢 Enviando mensagem de cancelamento para sinal ${signal.id}`);
        
        const side = signal.side === 'BUY' || signal.side === '🟢 COMPRA' ? 'COMPRA' : '🔴 VENDA';
        const motivo = signal.error_message || 'Sinal cancelado pelo sistema';
        
        // ✅ FORMATAR TPS SEM ZEROS À DIREITA
        const tps = [
          signal.tp1_price, signal.tp2_price, signal.tp3_price,
          signal.tp4_price, signal.tp5_price
        ].filter(tp => tp !== undefined && tp !== null && tp !== '');

        let tpsText = '';
        tps.forEach((tp, idx) => {
          tpsText += `\nALVO ${idx + 1}: ${formatNumberClean(tp)}`;
        });

        const cancelMsg =
          `🚫 <b>SINAL CANCELADO</b>\n\n` +
          `📊 <b>${signal.symbol}</b>\n${side}\n` +
          `📉 ${signal.timeframe} | ${signal.message_source}\n\n` +
          `💰 ENTRADA: ${formatNumberClean(signal.entry_price)}\n\n` +
          `📝 <b>Motivo:</b>\n${motivo}\n\n` +
          `🆔 Sinal: #${signal.id}\n` +
          `⏰ ${new Date().toLocaleString('pt-BR')}`;

        await sendTelegramMessage(accountId, cancelMsg, signal.chat_id);

        // Marcar como enviado
        await db.query(
          'UPDATE webhook_signals SET sent_msg = 1, updated_at = NOW() WHERE id = ?',
          [signal.id]
        );

        console.log(`[SIGNAL] ✅ Mensagem de cancelamento enviada para sinal ${signal.id}`);
        
      } catch (signalError) {
        console.error(`[SIGNAL] ❌ Erro ao processar sinal cancelado ${signal.id}:`, signalError.message);
      }
    }
    
    return canceledSignals.length;
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar sinais cancelados:`, error.message);
    return 0;
  }
}

module.exports = {
  // Funções principais
  checkNewTrades,
  processSignal,
  checkExpiredSignals,
  checkCanceledSignals,
  
  // Funções de preço
  onPriceUpdate,
  checkSignalTriggers,
  updatePriceCache,
  getPriceFromCache,
  
  // Funções utilitárias
  timeframeToMs,
  normalizeSide,
  cancelSignal,
};