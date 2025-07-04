/**
 * Stub para telegramBot para evitar erros no shutdown
 * TODO: Implementar bot do Telegram completo
 */

/**
 * Para o bot do Telegram para uma conta específica
 * @param {number} accountId - ID da conta
 */
async function stopTelegramBot(accountId) {
  console.log(`[TELEGRAM-BOT] 🤖 Parando bot do Telegram para conta ${accountId} (stub - não implementado)`);
  // Implementação futura do bot do Telegram
}

module.exports = {
  stopTelegramBot
};
