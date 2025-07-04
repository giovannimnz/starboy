const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

class TelegramClient {
  constructor(apiBaseUrl) {
    const port = process.env.API_PORT;
    this.apiBaseUrl = apiBaseUrl || `http://localhost:${port}`;
  }

  async sendMessage(accountId, message, chatId = null) {
    try {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramClient.js | FUNÇÃO: sendMessage`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Request para: ${this.apiBaseUrl}/api/telegram/send-message`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Body: { accountId: ${accountId}, chatId: ${chatId || 'null'}, messageLength: ${message$1.length || 0} }`);
      
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-message`, {
        accountId,
        message,
        chatId
      });
      
      console.log(`[TELEGRAM_DISPATCHER] 📤 Resposta HTTP ${response.status}:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramClient.js | ERRO em sendMessage:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendEntryMessage(accountId, signal, filledQuantity, averagePrice, totalValue) {
    try {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramClient.js | FUNÇÃO: sendEntryMessage`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Request para: ${this.apiBaseUrl}/api/telegram/send-entry-message`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Body: { accountId: ${accountId}, signal: ${signal$1.id}, symbol: ${signal$2.symbol} }`);
      
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-entry-message`, {
        accountId,
        signal,
        filledQuantity,
        averagePrice,
        totalValue
      });
      
      console.log(`[TELEGRAM_DISPATCHER] 📤 Resposta HTTP ${response.status}:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramClient.js | ERRO em sendEntryMessage:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendPositionClosed(accountId, position, replyToMessageId = null) {
    try {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramClient.js | FUNÇÃO: sendPositionClosed`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Request para: ${this.apiBaseUrl}/api/telegram/send-position-closed`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Body: { accountId: ${accountId}, position: ${position$1.id}, replyToMessageId: ${replyToMessageId || 'null'} }`);
      
      const requestBody = {
        accountId,
        position
      };
      
      // ✅ ADICIONAR replyToMessageId SE FORNECIDO
      if (replyToMessageId) {
        requestBody.replyToMessageId = replyToMessageId;
      }
      
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-position-closed`, requestBody);
      
      console.log(`[TELEGRAM_DISPATCHER] 📤 Resposta HTTP ${response.status}:`, JSON.stringify(response.data, null, 2));
      return response.data;
    } catch (error) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramClient.js | ERRO em sendPositionClosed:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendOrderMessage(accountId, symbol, side, orderType, quantity, price, status) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-order-message`, {
        accountId,
        symbol,
        side,
        orderType,
        quantity,
        price,
        status
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem de ordem:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange = null) {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-balance-message`, {
        accountId,
        previousBalance,
        newBalance,
        reason,
        balanceChange
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem de saldo:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }

  async sendSignalRegistered(accountId, signal, grupoOrigemNome = 'Divap') {
    try {
      const response = await axios.post(`${this.apiBaseUrl}/api/telegram/send-signal-registered`, {
        accountId,
        signal,
        grupoOrigemNome
      });
      
      return response.data;
    } catch (error) {
      console.error(`[TELEGRAM_CLIENT] Erro ao enviar mensagem de sinal:`, error.response$1.data || error.message);
      return { success: false, error: error.message };
    }
  }
}

// Instância singleton
const telegramClient = new TelegramClient();

module.exports = { TelegramClient, telegramClient };