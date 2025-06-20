const { getDatabaseInstance } = require('../../../core/database/conexao');
const { sendTelegramMessage } = require('./telegramBot');

/**
 * ✅ CONVERSÃO MELHORADA DE TIMEFRAME PARA MILISSEGUNDOS
 */
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  // Aceitar diferentes formatos: 15m, 1h, 4h, 1d, etc.
  const match = timeframe.match(/^(\d+)([mhdwMy])$/i);
  if (!match) {
    console.warn(`[TIMEOUT] Formato de timeframe inválido: ${timeframe}`);
    return 0;
  }

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  switch(unit.toLowerCase()) {
    case 'm': return numValue * 60 * 1000;                    // minutos
    case 'h': return numValue * 60 * 60 * 1000;               // horas
    case 'd': return numValue * 24 * 60 * 60 * 1000;          // dias
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000;      // semanas
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000;     // meses (aprox.)
    case 'y': return numValue * 365 * 24 * 60 * 60 * 1000;    // anos (aprox.)
    default: 
      console.warn(`[TIMEOUT] Unidade de timeframe desconhecida: ${unit}`);
      return 0;
  }
}

/**
 * Cancela um sinal com notificação
 */
async function cancelSignal(db, signalId, status, reason, accountId) {
  try {
    console.log(`[TIMEOUT] Cancelando sinal ${signalId} para conta ${accountId}: ${reason}`);
    
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
    
    // ✅ NOTIFICAÇÃO TELEGRAM MELHORADA
    try {
      const { sendTelegramMessage, formatAlertMessage } = require('./telegramBot');
      
      let message;
      if (signalData.length > 0) {
        const signal = signalData[0];
        const side = signal.side === 'BUY' ? '🟢 COMPRA' : '🔴 VENDA';
        message = `⏰ <b>SINAL CANCELADO</b>\n\n` +
                 `📊 <b>${signal.symbol}</b>\n` +
                 `${side} | ${signal.leverage}x\n` +
                 `💰 Entrada: $${signal.entry_price}\n\n` +
                 `📝 <b>Motivo:</b>\n${reason}\n\n` +
                 `🆔 Sinal: #${signalId}\n` +
                 `⏰ ${new Date().toLocaleString('pt-BR')}`;
      } else {
        message = formatAlertMessage('SINAL CANCELADO', `Sinal #${signalId}: ${reason}`, 'WARNING');
      }
      
      await sendTelegramMessage(accountId, message);
      console.log(`[TIMEOUT] 📱 Notificação de cancelamento enviada`);
    } catch (telegramError) {
      console.warn(`[TIMEOUT] ⚠️ Erro ao enviar notificação Telegram para conta ${accountId}:`, telegramError.message);
    }
    
  } catch (error) {
    console.error(`[TIMEOUT] Erro ao cancelar sinal ${signalId} para conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ VERIFICAÇÃO MELHORADA DE SINAIS EXPIRADOS
 * Usa a regra: timeframe * 3 como tempo máximo de vida
 */
async function checkExpiredSignals(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[TIMEOUT] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    const db = await getDatabaseInstance();
    if (!db) {
      console.error(`[TIMEOUT] Não foi possível conectar ao banco para conta ${accountId}`);
      return 0;
    }
    
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
    
    if (potentialExpiredSignals.length === 0) {
      return 0;
    }
    
    console.log(`[TIMEOUT] 🔍 Verificando ${potentialExpiredSignals.length} sinais para expiração (conta ${accountId})`);
    
    let canceledCount = 0;
    const now = new Date();
    
    for (const signal of potentialExpiredSignals) {
      const createdAt = new Date(signal.created_at);
      const signalAge = now.getTime() - createdAt.getTime();
      const signalAgeMinutes = Math.round(signalAge / 60000);
      
      let shouldExpire = false;
      let expireReason = '';
      
      // ✅ REGRA 1: TIMEFRAME * 3 (PRINCIPAL)
      if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        if (timeframeMs > 0) {
          const maxLifetime = timeframeMs * 3; // 3x o timeframe
          const maxLifetimeMinutes = Math.round(maxLifetime / 60000);
          
          if (signalAge > maxLifetime) {
            shouldExpire = true;
            expireReason = `Timeframe expirado (${signal.timeframe} * 3 = ${maxLifetimeMinutes}min, idade: ${signalAgeMinutes}min)`;
          }
        }
      }
      
      // ✅ REGRA 2: timeout_at específico
      if (!shouldExpire && signal.timeout_at) {
        const timeoutAt = new Date(signal.timeout_at);
        if (now >= timeoutAt) {
          shouldExpire = true;
          expireReason = `timeout_at atingido (${timeoutAt.toLocaleString('pt-BR')})`;
        }
      }
      
      // ✅ REGRA 3: max_lifetime_minutes
      if (!shouldExpire && signal.max_lifetime_minutes) {
        const maxLifetimeMs = signal.max_lifetime_minutes * 60 * 1000;
        if (signalAge > maxLifetimeMs) {
          shouldExpire = true;
          expireReason = `max_lifetime_minutes atingido (${signal.max_lifetime_minutes}min, idade: ${signalAgeMinutes}min)`;
        }
      }
      
      // ✅ REGRA 4: Fallback para sinais muito antigos (6 horas)
      if (!shouldExpire && signalAge > (6 * 60 * 60 * 1000)) {
        shouldExpire = true;
        expireReason = `Sinal muito antigo (${signalAgeMinutes}min > 360min)`;
      }
      
      // ✅ CANCELAR SINAL SE EXPIRADO
      if (shouldExpire) {
        console.log(`[TIMEOUT] ⏰ Cancelando sinal ${signal.id} (${signal.symbol}): ${expireReason}`);
        
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY', expireReason, accountId);
        canceledCount++;
      }
    }
    
    if (canceledCount > 0) {
      console.log(`[TIMEOUT] ✅ ${canceledCount} sinais expirados cancelados para conta ${accountId}`);
    }
    
    return canceledCount;
    
  } catch (error) {
    console.error(`[TIMEOUT] ❌ Erro ao verificar sinais expirados para conta ${accountId}:`, error.message);
    return 0;
  }
}

module.exports = {
  timeframeToMs,
  cancelSignal,
  checkExpiredSignals
};