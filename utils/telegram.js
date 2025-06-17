const axios = require('axios');

/**
 * Envia mensagem via Telegram
 * @param {string} message - Mensagem a ser enviada
 * @param {number} accountId - ID da conta (opcional)
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTelegramMessage(message, accountId = null) {
  try {
    console.log(`[TELEGRAM] Enviando mensagem${accountId ? ` para conta ${accountId}` : ''}: ${message.substring(0, 100)}...`);
    
    // TODO: Implementar envio real do Telegram aqui
    // Por enquanto, apenas log
    console.log(`[TELEGRAM] 📱 Mensagem: ${message}`);
    
    return true;
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao enviar mensagem:`, error.message);
    return false;
  }
}

/**
 * Envia alerta de erro via Telegram
 * @param {string} errorMessage - Mensagem de erro
 * @param {number} accountId - ID da conta
 * @param {string} context - Contexto do erro
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendErrorAlert(errorMessage, accountId, context = '') {
  const message = `🚨 ERRO ${context ? `[${context}]` : ''}\n\nConta: ${accountId}\nErro: ${errorMessage}\nHora: ${new Date().toLocaleString('pt-BR')}`;
  return await sendTelegramMessage(message, accountId);
}

/**
 * Envia notificação de trade via Telegram
 * @param {Object} tradeInfo - Informações do trade
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTradeNotification(tradeInfo, accountId) {
  const { symbol, side, quantity, price, type } = tradeInfo;
  const message = `📈 TRADE EXECUTADO\n\nConta: ${accountId}\nSímbolo: ${symbol}\nLado: ${side}\nQuantidade: ${quantity}\nPreço: ${price}\nTipo: ${type}\nHora: ${new Date().toLocaleString('pt-BR')}`;
  return await sendTelegramMessage(message, accountId);
}

module.exports = {
  sendTelegramMessage,
  sendErrorAlert,
  sendTradeNotification
};