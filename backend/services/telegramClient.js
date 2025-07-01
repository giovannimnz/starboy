const axios = require('axios');

class TelegramClient {
  constructor(apiBaseUrl = 'http://localhost:8001') {
    this.apiBaseUrl = apiBaseUrl;
  }

  async sendMessage(accountId, message, chatId = null) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-message`, {
        accountId,
        message,
        chatId
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem:`, error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-entry-message`, {
        accountId,
        signal,
        filledQuantity,
        averagePrice,
        totalValue
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem de entrada:`, error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendPositionClosed(accountId, position) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-position-closed`, {
        accountId,
        position
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem de posição fechada:`, error.response?.data || error.message);
      return { success: false, error: error.message };
    }
  }
}

// Instância singleton
const telegramClient = new TelegramClient();

module.exports = { TelegramClient, telegramClient };