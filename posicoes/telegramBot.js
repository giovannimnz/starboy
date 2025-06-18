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
    console.log(`[TELEGRAM] 🤖 Iniciando inicialização do bot para conta ${accountId}...`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[TELEGRAM] ❌ Não foi possível conectar ao banco de dados para conta ${accountId}`);
      return null;
    }

    // Buscar dados completos da conta incluindo chat_id
    const [rows] = await db.query(
      'SELECT telegram_bot_token, telegram_chat_id, nome FROM contas WHERE id = ? AND ativa = 1',
      [accountId]
    );

    if (rows.length === 0) {
      console.log(`[TELEGRAM] ⚠️ Conta ${accountId} não encontrada ou inativa`);
      return null;
    }

    const { telegram_bot_token: botToken, telegram_chat_id: chatId, nome: accountName } = rows[0];

    if (!botToken) {
      console.log(`[TELEGRAM] ⚠️ Token do bot não encontrado para conta ${accountId} (${accountName})`);
      return null;
    }

    if (!chatId) {
      console.log(`[TELEGRAM] ⚠️ Chat ID não encontrado para conta ${accountId} (${accountName})`);
      return null;
    }

    console.log(`[TELEGRAM] 📋 Dados encontrados:`);
    console.log(`[TELEGRAM]   - Conta: ${accountName} (ID: ${accountId})`);
    console.log(`[TELEGRAM]   - Token: ${botToken.substring(0, 8)}...`);
    console.log(`[TELEGRAM]   - Chat ID: ${chatId}`);
    
    // Verificar se já temos um bot para este token
    const existingBot = telegramBots.get(accountId);
    if (existingBot && existingBot.token === botToken) {
      console.log(`[TELEGRAM] ✅ Bot já existe e está ativo para conta ${accountId}`);
      return existingBot;
    }
    
    // Criar nova instância do bot
    console.log(`[TELEGRAM] 🔧 Criando nova instância do bot para conta ${accountId}...`);
    const bot = new Telegraf(botToken);
    
    // Configurar tratamento de erros
    bot.catch((err, ctx) => {
      console.error(`[TELEGRAM] ❌ Erro no bot da conta ${accountId}:`, err);
      if (ctx) {
        console.error(`[TELEGRAM] Context:`, ctx.update);
      }
    });

    // Configurar comando /start básico
    bot.start((ctx) => {
      console.log(`[TELEGRAM] 📨 Comando /start recebido de ${ctx.from.id} para conta ${accountId}`);
      ctx.reply(`🤖 Bot da conta ${accountName} (ID: ${accountId}) está ativo!`);
    });

    // Configurar comando /status
    bot.command('status', (ctx) => {
      console.log(`[TELEGRAM] 📊 Comando /status recebido de ${ctx.from.id} para conta ${accountId}`);
      ctx.reply(`✅ Bot operacional para conta ${accountName}\n📊 Chat ID: ${chatId}\n⏰ ${new Date().toLocaleString('pt-BR')}`);
    });
    
    // Testar conexão antes de inicializar
    try {
      console.log(`[TELEGRAM] 🔍 Testando conexão do bot...`);
      const botInfo = await bot.telegram.getMe();
      console.log(`[TELEGRAM] ✅ Bot conectado com sucesso:`);
      console.log(`[TELEGRAM]   - Nome: ${botInfo.first_name}`);
      console.log(`[TELEGRAM]   - Username: @${botInfo.username}`);
      console.log(`[TELEGRAM]   - ID: ${botInfo.id}`);
    } catch (testError) {
      console.error(`[TELEGRAM] ❌ Erro ao testar conexão do bot:`, testError.message);
      throw new Error(`Token inválido ou conexão falhará: ${testError.message}`);
    }
    
    // Iniciar o bot
    console.log(`[TELEGRAM] 🚀 Iniciando bot...`);
    await bot.launch({
      polling: {
        timeout: 30,
        limit: 100,
        allowedUpdates: ['message', 'callback_query']
      }
    });
    
    console.log(`[TELEGRAM] ✅ Bot iniciado com sucesso para conta ${accountId}`);
    
    // Armazenar no mapa
    const botInstance = { 
      bot, 
      token: botToken, 
      chatId, 
      accountId, 
      accountName,
      startedAt: new Date()
    };
    telegramBots.set(accountId, botInstance);
    
    // Enviar mensagem de teste
    try {
      const testMessage = `🤖 <b>Bot Inicializado</b>\n\n` +
                         `📊 Conta: <b>${accountName}</b>\n` +
                         `🆔 ID: <b>${accountId}</b>\n` +
                         `⏰ Horário: <b>${new Date().toLocaleString('pt-BR')}</b>\n` +
                         `✅ Status: <b>Operacional</b>`;
      
      await sendTelegramMessage(accountId, chatId, testMessage);
      console.log(`[TELEGRAM] ✅ Mensagem de teste enviada para chat ${chatId}`);
    } catch (testMessageError) {
      console.error(`[TELEGRAM] ⚠️ Erro ao enviar mensagem de teste:`, testMessageError.message);
    }
    
    return botInstance;
    
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao inicializar bot do Telegram para conta ${accountId}:`, error.message);
    console.error(`[TELEGRAM] Stack trace:`, error.stack);
    return null;
  }
}

/**
 * Obtém o bot do Telegram para uma conta específica
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Instância do bot ou null
 */
function getTelegramBot(accountId) {
  const botInstance = telegramBots.get(accountId);
  if (!botInstance) {
    console.warn(`[TELEGRAM] ⚠️ Bot não encontrado para conta ${accountId}`);
    return null;
  }
  
  // Verificar se o bot ainda está ativo
  try {
    if (!botInstance.bot || !botInstance.bot.telegram) {
      console.warn(`[TELEGRAM] ⚠️ Bot inválido para conta ${accountId}`);
      telegramBots.delete(accountId);
      return null;
    }
    return botInstance;
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao verificar bot para conta ${accountId}:`, error.message);
    telegramBots.delete(accountId);
    return null;
  }
}

/**
 * Envia mensagem via Telegram
 * @param {number} accountId - ID da conta
 * @param {string} chatId - ID do chat (opcional, usa o da conta se não fornecido)
 * @param {string} message - Mensagem a ser enviada
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTelegramMessage(accountId, chatId = null, message) {
  try {
    const botInstance = getTelegramBot(accountId);
    if (!botInstance) {
      console.warn(`[TELEGRAM] ⚠️ Bot não disponível para conta ${accountId}`);
      return false;
    }

    // Usar chatId fornecido ou o da conta
    const targetChatId = chatId || botInstance.chatId;
    if (!targetChatId) {
      console.error(`[TELEGRAM] ❌ Chat ID não disponível para conta ${accountId}`);
      return false;
    }

    console.log(`[TELEGRAM] 📤 Enviando mensagem para conta ${accountId}, chat ${targetChatId}...`);
    
    await botInstance.bot.telegram.sendMessage(targetChatId, message, { 
      parse_mode: 'HTML',
      disable_web_page_preview: true 
    });
    
    console.log(`[TELEGRAM] ✅ Mensagem enviada com sucesso para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao enviar mensagem para conta ${accountId}:`, error.message);
    
    // Se for erro de bot não encontrado, tentar reinicializar
    if (error.message.includes('bot') || error.code === 401) {
      console.log(`[TELEGRAM] 🔄 Tentando reinicializar bot para conta ${accountId}...`);
      telegramBots.delete(accountId);
      
      try {
        await initializeTelegramBot(accountId);
        console.log(`[TELEGRAM] ✅ Bot reinicializado, tentando enviar mensagem novamente...`);
        return await sendTelegramMessage(accountId, chatId, message);
      } catch (reinitError) {
        console.error(`[TELEGRAM] ❌ Falha ao reinicializar bot:`, reinitError.message);
      }
    }
    
    return false;
  }
}

/**
 * Formata mensagem de entrada executada
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
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de erro para Telegram
 */
function formatErrorMessage(signal, errorMessage) {
  return `🚨 <b>ERRO</b> no Sinal ${signal.id}\n\n` +
         `📊 Par: <b>${signal.symbol}</b>\n` +
         `📈 Lado: <b>${signal.side}</b>\n` +
         `💰 Preço: <b>${signal.entry_price || signal.price}</b>\n` +
         `❌ Erro: <code>${errorMessage}</code>\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Para todos os bots ativos
 */
async function stopAllTelegramBots() {
  console.log(`[TELEGRAM] 🛑 Parando todos os bots do Telegram...`);
  
  for (const [accountId, botInstance] of telegramBots.entries()) {
    try {
      if (botInstance.bot && typeof botInstance.bot.stop === 'function') {
        await botInstance.bot.stop();
        console.log(`[TELEGRAM] ✅ Bot da conta ${accountId} parado`);
      }
    } catch (error) {
      console.error(`[TELEGRAM] ❌ Erro ao parar bot da conta ${accountId}:`, error.message);
    }
  }
  
  telegramBots.clear();
  console.log(`[TELEGRAM] ✅ Todos os bots foram parados`);
}

/**
 * Lista bots ativos
 */
function listActiveBots() {
  const activeBots = [];
  for (const [accountId, botInstance] of telegramBots.entries()) {
    activeBots.push({
      accountId,
      accountName: botInstance.accountName,
      chatId: botInstance.chatId,
      startedAt: botInstance.startedAt,
      token: botInstance.token.substring(0, 8) + '...'
    });
  }
  return activeBots;
}

module.exports = {
  initializeTelegramBot,
  getTelegramBot,
  sendTelegramMessage,
  formatEntryMessage,
  formatErrorMessage,
  stopAllTelegramBots,
  listActiveBots
};