const { telegramClient } = require('../../../services/telegramClient');

/**
 * Wrapper para compatibilidade com código existente
 */
async function sendTelegramMessage(accountId, message, chatId = null) {
  return await telegramClient.sendMessage(accountId, message, chatId);
}

async function formatAndSendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue) {
  return await telegramClient.sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue);
}

async function formatAndSendPositionClosed(accountId, position) {
  return await telegramClient.sendPositionClosed(accountId, position);
}

module.exports = {
  sendTelegramMessage,
  formatAndSendEntryMessage,
  formatAndSendPositionClosed
};