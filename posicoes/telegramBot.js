const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../db/conexao');

// Mapa para armazenar instâncias de bots por conta
const telegramBots = new Map();

/**
 * Inicializa o bot do Telegram para uma conta específica
 */
async function initializeTelegramBot(accountId) {
  try {
    console.log(`[TELEGRAM] Inicializando bot para conta ${accountId}...`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }
    
    // Verificar se já existe
    if (telegramBots.has(accountId)) {
      console.log(`[TELEGRAM] Bot já existe para conta ${accountId}, retornando instância existente`);
      return telegramBots.get(accountId);
    }
    
    const db = await getDatabaseInstance();
    const [rows] = await db.query(
      'SELECT telegram_bot_token FROM contas WHERE id = ? AND ativa = 1',
      [accountId]
    );
    
    if (rows.length === 0 || !rows[0].telegram_bot_token) {
      console.log(`[TELEGRAM] Token não configurado para conta ${accountId}`);
      return null;
    }
    
    const token = rows[0].telegram_bot_token;
    const bot = new Telegraf(token);
    
    // Configurar handlers básicos
    bot.start((ctx) => {
      ctx.reply(`🤖 Bot da conta ${accountId} iniciado!`);
    });
    
    bot.help((ctx) => {
      ctx.reply('📋 Comandos disponíveis:\n/status - Status do sistema\n/saldo - Saldo da conta');
    });
    
    bot.command('status', (ctx) => {
      ctx.reply(`✅ Sistema operacional para conta ${accountId}`);
    });
    
    // Iniciar bot
    await bot.launch();
    
    telegramBots.set(accountId, bot);
    console.log(`[TELEGRAM] ✅ Bot inicializado para conta ${accountId}`);
    
    return bot;
    
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao inicializar bot para conta ${accountId}:`, error.message);
    return null;
  }
}

/**
 * Obtém o bot do Telegram para uma conta específica
 */
function getTelegramBot(accountId) {
  return telegramBots.get(accountId) || null;
}

/**
 * Envia mensagem via Telegram
 */
async function sendTelegramMessage(accountId, chatId = null, message) {
  try {
    const bot = getTelegramBot(accountId);
    if (!bot) {
      console.warn(`[TELEGRAM] ⚠️ Bot não encontrado para conta ${accountId}`);
      return false;
    }
    
    // Se chatId não fornecido, obter do banco
    if (!chatId) {
      const db = await getDatabaseInstance();
      const [rows] = await db.query(
        'SELECT telegram_chat_id FROM contas WHERE id = ?',
        [accountId]
      );
      
      if (rows.length === 0 || !rows[0].telegram_chat_id) {
        console.warn(`[TELEGRAM] Chat ID não configurado para conta ${accountId}`);
        return false;
      }
      
      chatId = rows[0].telegram_chat_id;
    }
    
    await bot.telegram.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    
    console.log(`[TELEGRAM] ✅ Mensagem enviada para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao enviar mensagem para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Para o bot do Telegram
 */
async function stopTelegramBot(accountId) {
  try {
    const bot = telegramBots.get(accountId);
    if (bot) {
      await bot.stop();
      telegramBots.delete(accountId);
      console.log(`[TELEGRAM] Bot parado para conta ${accountId}`);
    }
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao parar bot para conta ${accountId}:`, error.message);
  }
}

module.exports = {
  initializeTelegramBot,
  getTelegramBot,
  sendTelegramMessage,
  stopTelegramBot
};