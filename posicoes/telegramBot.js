const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../db/conexao');

// Mapa para armazenar instâncias de bots por conta
const telegramBots = new Map();

/**
 * Inicializa o bot do Telegram para uma conta específica
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object|null>} - Instância do bot ou null
 */
async function initializeTelegramBot(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[TELEGRAM] Não foi possível conectar ao banco de dados para conta ${accountId}`);
      return null;
    }

    // Buscar token do bot no banco de dados
    const [rows] = await db.query(
      'SELECT telegram_bot_token FROM contas WHERE id = ?',
      [accountId]
    );

    if (rows.length === 0 || !rows[0].telegram_bot_token) {
      console.log(`[TELEGRAM] Token do bot não encontrado para conta ${accountId}`);
      return null;
    }

    const botToken = rows[0].telegram_bot_token;
    
    // Verificar se já temos um bot para este token
    const existingBot = Array.from(telegramBots.values())
      .find(b => b.token === botToken);
    
    if (existingBot) {
      console.log(`[TELEGRAM] Bot já existe para token ${botToken.substring(0, 8)}... (conta ${accountId})`);
      telegramBots.set(accountId, existingBot);
      return existingBot.bot;
    }
    
    // Criar nova instância do bot
    console.log(`[TELEGRAM] Inicializando bot do Telegram para conta ${accountId} com token: ${botToken.substring(0, 8)}...`);
    const bot = new Telegraf(botToken);
    
    // Configurar handlers básicos
    bot.catch((err) => {
      console.error(`[TELEGRAM] Erro no bot da conta ${accountId}:`, err);
    });
    
    // Iniciar o bot
    await bot.launch();
    console.log(`[TELEGRAM] Bot do Telegram inicializado com sucesso para conta ${accountId}`);
    
    // Armazenar no mapa
    telegramBots.set(accountId, { bot, token: botToken });
    
    return bot;
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao inicializar bot do Telegram para conta ${accountId}:`, error);
    return null;
  }
}

/**
 * Obtém o bot do Telegram para uma conta específica
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Instância do bot ou null
 */
function getTelegramBot(accountId) {
  const botInfo = telegramBots.get(accountId);
  return botInfo ? botInfo.bot : null;
}

/**
 * Envia mensagem via Telegram
 * @param {number} accountId - ID da conta
 * @param {string} chatId - ID do chat
 * @param {string} message - Mensagem a ser enviada
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTelegramMessage(accountId, chatId, message) {
  try {
    const bot = getTelegramBot(accountId);
    if (!bot) {
      console.warn(`[TELEGRAM] Bot não disponível para conta ${accountId}`);
      return false;
    }

    await bot.telegram.sendMessage(chatId, message, { parse_mode: 'HTML' });
    return true;
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao enviar mensagem para conta ${accountId}:`, error);
    return false;
  }
}

/**
 * Formata mensagem de entrada executada
 * @param {Object} signal - Dados do sinal
 * @param {number} filledQuantity - Quantidade preenchida
 * @param {number} averagePrice - Preço médio de entrada
 * @param {number} amountInUsdt - Valor em USDT
 * @returns {string} - Mensagem formatada
 */
function formatEntryMessage(signal, filledQuantity, averagePrice, amountInUsdt) {
  const displaySide = signal.side === 'BUY' || signal.side === 'COMPRA' ? 'Compra' : 'Venda';
  
  return `🎯 <b>ENTRADA EXECUTADA</b>\n\n` +
         `📊 Par: <b>${signal.symbol}</b>\n` +
         `📈 Direção: <b>${displaySide}</b>\n` +
         `💰 Quantidade: <b>${filledQuantity.toFixed(8)}</b>\n` +
         `💵 Preço Médio: <b>${averagePrice.toFixed(4)}</b>\n` +
         `🔢 Valor Total: <b>${amountInUsdt.toFixed(2)} USDT</b>\n` +
         `⚡ Alavancagem: <b>${signal.leverage}x</b>\n\n` +
         `⏰ ${new Date().toLocaleString()}`;
}

/**
 * Formata mensagem de erro
 * @param {Object} signal - Dados do sinal
 * @param {string} errorMessage - Mensagem de erro
 * @returns {string} - Mensagem formatada
 */
function formatErrorMessage(signal, errorMessage) {
  return `❌ <b>ERRO NA ENTRADA</b>\n\n` +
         `📊 Par: <b>${signal.symbol}</b>\n` +
         `📈 Direção: <b>${signal.side}</b>\n` +
         `❗ Erro: <b>${errorMessage}</b>\n\n` +
         `⏰ ${new Date().toLocaleString()}`;
}

module.exports = {
  initializeTelegramBot,
  getTelegramBot,
  sendTelegramMessage,
  formatEntryMessage,
  formatErrorMessage
};