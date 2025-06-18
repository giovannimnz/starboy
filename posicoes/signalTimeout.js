const { getDatabaseInstance } = require('../db/conexao');
const { sendTelegramMessage } = require('./telegramBot');

/**
 * Converte timeframe para milissegundos
 */
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) return 0;

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  switch(unit) {
    case 'm': return numValue * 60 * 1000;
    case 'h': return numValue * 60 * 60 * 1000;
    case 'd': return numValue * 24 * 60 * 60 * 1000;
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000;
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

/**
 * Cancela um sinal com notificação
 */
async function cancelSignal(db, signalId, statusParam, reason, accountId) {
  try {
    console.log(`[TIMEOUT] Cancelando sinal ${signalId}: ${reason}`);
    
    await db.query(`
      UPDATE webhook_signals
      SET status = 'CANCELED',
          error_message = ?
      WHERE id = ?
    `, [reason, signalId]);

    // Buscar dados para notificação
    const [signalInfo] = await db.query(`
      SELECT symbol, chat_id, registry_message_id
      FROM webhook_signals
      WHERE id = ?
    `, [signalId]);

    if (signalInfo.length > 0 && signalInfo[0].chat_id) {
      const signal = signalInfo[0];
      const message = `⚠️ Sinal para ${signal.symbol} Cancelado ⚠️\n(ID: ${signalId})\n\nMotivo: ${reason}`;
      
      await sendTelegramMessage(accountId, signal.chat_id, message);
    }

    return true;
  } catch (error) {
    console.error(`[TIMEOUT] Erro ao cancelar sinal ${signalId}:`, error.message);
    return false;
  }
}

/**
 * Verifica sinais expirados por timeout
 */
async function checkExpiredSignals(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, timeframe, created_at, 
             chat_id, timeout_at, max_lifetime_minutes
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING'
        AND conta_id = ?
    `, [accountId]);

    const now = new Date();
    let cancelCount = 0;

    for (const signal of pendingSignals) {
      let shouldCancel = false;
      let cancelReason = '';

      // Verificar timeout direto (campo timeout_at)
      if (signal.timeout_at && new Date(signal.timeout_at) < now) {
        shouldCancel = true;
        cancelReason = `Timeout: sinal expirou em ${signal.timeout_at}`;
      }
      // Verificar timeout por timeframe (fallback)
      else if (signal.timeframe) {
        const timeframeMs = timeframeToMs(signal.timeframe);
        const maxLifetimeMs = timeframeMs * 3;

        if (maxLifetimeMs > 0) {
          const createdAt = new Date(signal.created_at);
          const signalAgeMs = now.getTime() - createdAt.getTime();

          if (signalAgeMs > maxLifetimeMs) {
            shouldCancel = true;
            cancelReason = `Timeout: sinal ativo por ${(signalAgeMs / 60000).toFixed(1)} min (máx: ${(maxLifetimeMs / 60000).toFixed(1)} min)`;
          }
        }
      }

      if (shouldCancel) {
        await cancelSignal(db, signal.id, 'TIMEOUT', cancelReason, accountId);
        cancelCount++;
      }
    }

    if (cancelCount > 0) {
      console.log(`[TIMEOUT] ${cancelCount} sinais cancelados por timeout para conta ${accountId}`);
    }

    return cancelCount;
  } catch (error) {
    console.error(`[TIMEOUT] Erro ao verificar sinais expirados:`, error.message);
    return 0;
  }
}

module.exports = {
  timeframeToMs,
  cancelSignal,
  checkExpiredSignals
};