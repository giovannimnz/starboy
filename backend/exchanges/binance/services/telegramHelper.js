const { telegramClient } = require('../../../services/telegramClient');

/**
 * Wrapper para compatibilidade com código existente
 */
async function sendTelegramMessage(accountId, message, chatId = null) {
  const timestamp = new Date().toLocaleString('pt-BR');
  console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramHelper.js | FUNÇÃO: sendTelegramMessage`);
  console.log(`[TELEGRAM_DISPATCHER] 📋 Parâmetros: Conta=${accountId}, ChatId=${chatId || 'padrão'}, MessageLength=${message$1.length || 0}`);
  
  const result = await telegramClient.sendMessage(accountId, message, chatId);
  
  console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado de sendTelegramMessage:`, JSON.stringify(result, null, 2));
  return result;
}

async function formatAndSendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue) {
  const timestamp = new Date().toLocaleString('pt-BR');
  console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramHelper.js | FUNÇÃO: formatAndSendEntryMessage`);
  console.log(`[TELEGRAM_DISPATCHER] 📋 Parâmetros: Conta=${accountId}, Signal=${signal$1.id}, Symbol=${signal$2.symbol}`);
  
  const result = await telegramClient.sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue);
  
  console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado de formatAndSendEntryMessage:`, JSON.stringify(result, null, 2));
  return result;
}

async function formatAndSendPositionClosed(accountId, position, replyToMessageId = null) {
  const timestamp = new Date().toLocaleString('pt-BR');
  console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramHelper.js | FUNÇÃO: formatAndSendPositionClosed`);
  console.log(`[TELEGRAM_DISPATCHER] 📋 Parâmetros: Conta=${accountId}, Position=${position$1.id}, Symbol=${position$2.simbolo}, ReplyTo=${replyToMessageId}`);
  
  const result = await telegramClient.sendPositionClosed(accountId, position, replyToMessageId);
  
  console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado de formatAndSendPositionClosed:`, JSON.stringify(result, null, 2));
  return result;
}

// ✅ NOVAS FUNÇÕES:
async function formatAndSendOrderMessage(accountId, symbol, side, orderType, quantity, price, status) {
  return await telegramClient.sendOrderMessage(accountId, symbol, side, orderType, quantity, price, status);
}

async function formatAndSendBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange = null) {
  return await telegramClient.sendBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange);
}

async function formatAndSendSignalRegistered(accountId, signal, grupoOrigemNome = 'Divap') {
  return await telegramClient.sendSignalRegistered(accountId, signal, grupoOrigemNome);
}

// Funções de compatibilidade para código legado
async function formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId) {
  return await telegramClient.sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue);
}

async function formatEntryMessageWithPrecision(signal, filledQuantity, averagePrice, totalValue, accountId) {
  return await telegramClient.sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue);
}

async function formatErrorMessage(accountId, message) {
  return await telegramClient.sendMessage(accountId, `❌ Erro: ${message}`);
}

async function formatAlertMessage(accountId, message) {
  return await telegramClient.sendMessage(accountId, `⚠️ Alerta: ${message}`);
}

async function formatOrderMessage(accountId, symbol, side, orderType, quantity, price, status) {
  return await telegramClient.sendOrderMessage(accountId, symbol, side, orderType, quantity, price, status);
}

async function formatBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange = null) {
  return await telegramClient.sendBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange);
}

async function formatSignalRegistered(accountId, signal, grupoOrigemNome = 'Divap') {
  return await telegramClient.sendSignalRegistered(accountId, signal, grupoOrigemNome);
}

module.exports = {
  sendTelegramMessage,
  formatAndSendEntryMessage,
  formatAndSendPositionClosed,
  formatAndSendOrderMessage,      // ✅ NOVO
  formatAndSendBalanceMessage,    // ✅ NOVO
  formatAndSendSignalRegistered,  // ✅ NOVO
  formatEntryMessage,
  formatEntryMessageWithPrecision,
  formatErrorMessage,
  formatAlertMessage,
  formatOrderMessage,
  formatBalanceMessage,
  formatSignalRegistered
};