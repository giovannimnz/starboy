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
 * Verifica sinais expirados por timeout
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
    const [expiredSignals] = await db.query(`
      SELECT id, symbol, timeframe, created_at, status
      FROM webhook_signals 
      WHERE conta_id = ? 
      AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO', 'ENTRADA_EM_PROGRESSO')
      AND created_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
    `, [accountId]);
    
    let canceledCount = 0;
    
    for (const signal of expiredSignals) {
      const signalAge = Date.now() - new Date(signal.created_at).getTime();
      const timeframeMs = timeframeToMs(signal.timeframe) || (15 * 60 * 1000); // 15 min default
      const maxAge = Math.max(timeframeMs * 2, 30 * 60 * 1000); // Mín 30 min
      
      if (signalAge > maxAge) {
        await cancelSignal(db, signal.id, 'CANCELED', 
          `Sinal expirado após ${Math.round(signalAge / 60000)} minutos (timeframe: ${signal.timeframe})`, 
          accountId);
        canceledCount++;
      }
    }
    
    if (canceledCount > 0) {
      console.log(`[TIMEOUT] ${canceledCount} sinais expirados cancelados para conta ${accountId}`);
    }
    
    return canceledCount;
    
  } catch (error) {
    console.error(`[TIMEOUT] Erro ao verificar sinais expirados para conta ${accountId}:`, error.message);
    return 0;
  }
}

module.exports = {
  timeframeToMs,
  cancelSignal,
  checkExpiredSignals
};