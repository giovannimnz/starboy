const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../db/conexao');

// Mapa para armazenar instâncias de bots por conta
const telegramBots = new Map();

// ✅ CONSTANTES PARA CONTROLE OTIMIZADAS
const BOT_TIMEOUT = 15000; // Reduzido para 15 segundos
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 3000; // Reduzido para 3 segundos
const POLLING_TIMEOUT = 10; // Timeout do polling em segundos

/**
 * ✅ FUNÇÃO PARA LIMPAR WEBHOOK (resolve conflitos)
 */
async function clearBotWebhook(token) {
  try {
    console.log(`[TELEGRAM] 🧹 Limpando webhook para token...`);
    
    const response = await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ drop_pending_updates: true })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log(`[TELEGRAM] ✅ Webhook limpo com sucesso`);
      return true;
    } else {
      console.warn(`[TELEGRAM] ⚠️ Falha ao limpar webhook:`, result.description);
      return false;
    }
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao limpar webhook:`, error.message);
    return false;
  }
}

/**
 * ✅ FUNÇÃO PARA VALIDAR TOKEN
 */
async function validateTelegramToken(token) {
  try {
    console.log(`[TELEGRAM] 🔍 Validando token...`);
    
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      method: 'GET'
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log(`[TELEGRAM] ✅ Token válido - Bot: ${result.result.username} (${result.result.first_name})`);
      return {
        valid: true,
        botInfo: result.result
      };
    } else {
      console.error(`[TELEGRAM] ❌ Token inválido:`, result.description);
      return {
        valid: false,
        error: result.description
      };
    }
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro na validação do token:`, error.message);
    return {
      valid: false,
      error: error.message
    };
  }
}

/**
 * ✅ FUNÇÃO PARA PARAR BOT EXISTENTE (evita conflitos)
 */
async function forceStopExistingBot(accountId) {
  try {
    if (telegramBots.has(accountId)) {
      console.log(`[TELEGRAM] 🛑 Parando bot existente para conta ${accountId}...`);
      
      const existingBot = telegramBots.get(accountId);
      
      // Tentar parar graciosamente
      try {
        if (existingBot && typeof existingBot.stop === 'function') {
          await Promise.race([
            existingBot.stop(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Stop timeout')), 3000)
            )
          ]);
        }
      } catch (stopError) {
        console.warn(`[TELEGRAM] ⚠️ Erro ao parar bot graciosamente:`, stopError.message);
      }
      
      // Remover do mapa
      telegramBots.delete(accountId);
      
      console.log(`[TELEGRAM] ✅ Bot existente removido para conta ${accountId}`);
      
      // Aguardar um pouco para limpeza completa
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao parar bot existente:`, error.message);
    // Continuar mesmo com erro
  }
}

/**
 * ✅ INICIALIZA BOT COM POLLING E DEBUGGING COMPLETO
 */
async function initializeTelegramBot(accountId, forceRestart = false) {
  let attempt = 0;
  
  while (attempt < MAX_RETRY_ATTEMPTS) {
    attempt++;
    
    try {
      console.log(`[TELEGRAM] 🚀 Tentativa ${attempt}/${MAX_RETRY_ATTEMPTS} - Inicializando bot para conta ${accountId}...`);
      
      // ✅ VALIDAÇÃO DE ENTRADA
      if (!accountId || typeof accountId !== 'number') {
        throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      }
      
      // ✅ VERIFICAR SE JÁ EXISTE (e não é restart forçado)
      if (!forceRestart && telegramBots.has(accountId)) {
        const existingBot = telegramBots.get(accountId);
        console.log(`[TELEGRAM] ♻️ Bot já existe para conta ${accountId}, testando conexão...`);
        
        try {
          // Testar se o bot ainda está funcional
          const botInfo = await existingBot.telegram.getMe();
          console.log(`[TELEGRAM] ✅ Bot existente funcional: ${botInfo.username}`);
          return existingBot;
        } catch (testError) {
          console.warn(`[TELEGRAM] ⚠️ Bot existente não funcional, recriando...`);
          await forceStopExistingBot(accountId);
        }
      } else if (forceRestart) {
        await forceStopExistingBot(accountId);
      }
      
      // ✅ OBTER CONFIGURAÇÕES DO BANCO
      console.log(`[TELEGRAM] 📊 Obtendo configurações para conta ${accountId}...`);
      const db = await getDatabaseInstance();
      const [rows] = await db.query(
        'SELECT telegram_bot_token, telegram_chat_id, nome FROM contas WHERE id = ? AND ativa = 1',
        [accountId]
      );
      
      if (rows.length === 0) {
        throw new Error(`Conta ${accountId} não encontrada ou inativa`);
      }
      
      const { telegram_bot_token: token, telegram_chat_id: chatId, nome: accountName } = rows[0];
      
      if (!token || token.trim() === '') {
        console.warn(`[TELEGRAM] ⚠️ Token não configurado para conta ${accountId} (${accountName})`);
        return null;
      }
      
      console.log(`[TELEGRAM] 📋 Configurações obtidas - Conta: ${accountName}, Chat ID: ${chatId || 'não configurado'}`);
      
      // ✅ VALIDAR TOKEN
      const tokenValidation = await validateTelegramToken(token);
      if (!tokenValidation.valid) {
        throw new Error(`Token inválido: ${tokenValidation.error}`);
      }
      
      // ✅ LIMPAR WEBHOOK (evita conflitos)
      await clearBotWebhook(token);
      
      // ✅ CRIAR BOT COM CONFIGURAÇÕES OTIMIZADAS
      console.log(`[TELEGRAM] 🤖 Criando instância do bot com polling...`);
      const bot = new Telegraf(token);
      
      // ✅ CONFIGURAR HANDLERS BÁSICOS
      bot.start(async (ctx) => {
        try {
          const welcomeMsg = `🤖 <b>Bot da conta ${accountName} iniciado!</b>\n\n` +
                           `📊 Conta ID: ${accountId}\n` +
                           `👤 Usuario: ${ctx.from.username || ctx.from.first_name}\n` +
                           `🆔 Chat ID: ${ctx.chat.id}\n\n` +
                           `Digite /help para ver os comandos disponíveis.`;
          
          await ctx.reply(welcomeMsg, { parse_mode: 'HTML' });
          
          // Salvar chat ID se não estiver configurado
          if (!chatId) {
            await db.query(
              'UPDATE contas SET telegram_chat_id = ? WHERE id = ?',
              [ctx.chat.id, accountId]
            );
            console.log(`[TELEGRAM] ✅ Chat ID salvo: ${ctx.chat.id} para conta ${accountId}`);
          }
          
        } catch (error) {
          console.error(`[TELEGRAM] Erro no handler /start:`, error.message);
        }
      });
      
      bot.help(async (ctx) => {
        try {
          const helpMsg = `📋 <b>Comandos disponíveis:</b>\n\n` +
                         `🔸 /status - Status do sistema\n` +
                         `🔸 /test - Teste de conexão\n` +
                         `🔸 /ping - Teste simples`;
          
          await ctx.reply(helpMsg, { parse_mode: 'HTML' });
        } catch (error) {
          console.error(`[TELEGRAM] Erro no handler /help:`, error.message);
        }
      });
      
      bot.command('status', async (ctx) => {
        try {
          const statusMsg = `✅ <b>Sistema operacional</b>\n\n` +
                           `🏦 Conta: ${accountName} (ID: ${accountId})\n` +
                           `🤖 Bot: ${tokenValidation.botInfo.username}\n` +
                           `⏰ ${new Date().toLocaleString('pt-BR')}`;
          
          await ctx.reply(statusMsg, { parse_mode: 'HTML' });
        } catch (error) {
          console.error(`[TELEGRAM] Erro no handler /status:`, error.message);
        }
      });
      
      bot.command('test', async (ctx) => {
        try {
          await ctx.reply(`🧪 <b>Teste de conexão</b>\n\n✅ Bot funcionando corretamente!\n⏰ ${new Date().toLocaleString('pt-BR')}`, { parse_mode: 'HTML' });
        } catch (error) {
          console.error(`[TELEGRAM] Erro no handler /test:`, error.message);
        }
      });
      
      bot.command('ping', async (ctx) => {
        try {
          await ctx.reply('🏓 Pong!');
        } catch (error) {
          console.error(`[TELEGRAM] Erro no handler /ping:`, error.message);
        }
      });
      
      // ✅ HANDLER GLOBAL DE ERROS
      bot.catch((err, ctx) => {
        console.error(`[TELEGRAM] Erro no bot da conta ${accountId}:`, err);
        try {
          if (ctx && ctx.reply) {
            ctx.reply(`❌ Erro interno do bot. Tente novamente.`);
          }
        } catch (replyError) {
          console.error(`[TELEGRAM] Erro ao enviar mensagem de erro:`, replyError.message);
        }
      });
      
      // ✅ INICIAR BOT COM POLLING E TIMEOUT
      console.log(`[TELEGRAM] 🚀 Iniciando bot com polling (timeout: ${POLLING_TIMEOUT}s)...`);
      
      // ✅ CONFIGURAÇÃO DE POLLING OTIMIZADA
      const launchOptions = {
        polling: {
          timeout: POLLING_TIMEOUT,
          limit: 100,
          allowed_updates: ['message', 'callback_query']
        }
      };
      
      await Promise.race([
        bot.launch(launchOptions),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout na inicialização do polling')), BOT_TIMEOUT)
        )
      ]);
      
      // ✅ AGUARDAR UM MOMENTO PARA ESTABILIZAR
      console.log(`[TELEGRAM] ⏳ Aguardando estabilização do polling...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // ✅ TESTAR CONEXÃO
      console.log(`[TELEGRAM] 🧪 Testando conexão do bot...`);
      const botInfo = await bot.telegram.getMe();
      console.log(`[TELEGRAM] ✅ Bot conectado: @${botInfo.username} (${botInfo.first_name})`);
      
      // ✅ SALVAR NO MAPA
      telegramBots.set(accountId, bot);
      
      console.log(`[TELEGRAM] 🎉 Bot inicializado com sucesso para conta ${accountId} (${accountName})`);
      
      return bot;
      
    } catch (error) {
      console.error(`[TELEGRAM] ❌ Tentativa ${attempt} falhou para conta ${accountId}:`, error.message);
      
      // Limpar bot com falha
      if (telegramBots.has(accountId)) {
        await forceStopExistingBot(accountId);
      }
      
      if (attempt < MAX_RETRY_ATTEMPTS) {
        console.log(`[TELEGRAM] ⏳ Aguardando ${RETRY_DELAY/1000}s antes da próxima tentativa...`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
      } else {
        console.error(`[TELEGRAM] 💥 Falha definitiva na inicialização do bot para conta ${accountId}`);
        throw error;
      }
    }
  }
  
  return null;
}

/**
 * ✅ FUNÇÃO MELHORADA PARA OBTER BOT
 */
function getTelegramBot(accountId) {
  const bot = telegramBots.get(accountId);
  if (bot) {
    console.log(`[TELEGRAM] ✅ Bot encontrado para conta ${accountId}`);
  } else {
    console.warn(`[TELEGRAM] ⚠️ Bot não encontrado para conta ${accountId}`);
  }
  return bot || null;
}

/**
 * ✅ FUNÇÃO MELHORADA PARA ENVIAR MENSAGENS
 */
async function sendTelegramMessage(accountId, chatId = null, message) {
  try {
    console.log(`[TELEGRAM] 📤 Enviando mensagem para conta ${accountId}...`);
    
    let bot = getTelegramBot(accountId);
    if (!bot) {
      console.warn(`[TELEGRAM] ⚠️ Bot não encontrado para conta ${accountId}, tentando inicializar...`);
      bot = await initializeTelegramBot(accountId);
      if (!bot) {
        console.error(`[TELEGRAM] ❌ Falha ao inicializar bot para conta ${accountId}`);
        return false;
      }
    }
    
    // Se chatId não fornecido, obter do banco
    if (!chatId) {
      console.log(`[TELEGRAM] 🔍 Obtendo chat ID do banco...`);
      const db = await getDatabaseInstance();
      const [rows] = await db.query(
        'SELECT telegram_chat_id FROM contas WHERE id = ?',
        [accountId]
      );
      
      if (rows.length === 0 || !rows[0].telegram_chat_id) {
        console.warn(`[TELEGRAM] ⚠️ Chat ID não configurado para conta ${accountId}`);
        return false;
      }
      
      chatId = rows[0].telegram_chat_id;
    }
    
    console.log(`[TELEGRAM] 📨 Enviando para chat ${chatId}...`);
    
    await bot.telegram.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });
    
    console.log(`[TELEGRAM] ✅ Mensagem enviada com sucesso para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao enviar mensagem para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * ✅ FUNÇÃO MELHORADA PARA PARAR BOT
 */
async function stopTelegramBot(accountId) {
  try {
    console.log(`[TELEGRAM] 🛑 Parando bot para conta ${accountId}...`);
    
    const bot = telegramBots.get(accountId);
    if (bot) {
      try {
        await Promise.race([
          bot.stop(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Stop timeout')), 5000)
          )
        ]);
      } catch (stopError) {
        console.warn(`[TELEGRAM] ⚠️ Timeout ao parar bot, forçando remoção...`);
      }
      
      telegramBots.delete(accountId);
      console.log(`[TELEGRAM] ✅ Bot parado para conta ${accountId}`);
    } else {
      console.log(`[TELEGRAM] ℹ️ Nenhum bot ativo para conta ${accountId}`);
    }
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao parar bot para conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ FUNÇÃO DE TESTE COMPLETO
 */
async function testTelegramBot(accountId) {
  console.log(`[TELEGRAM_TEST] 🧪 Iniciando teste completo para conta ${accountId}...`);
  
  try {
    // 1. Parar bot existente
    await stopTelegramBot(accountId);
    
    // 2. Inicializar novo
    const bot = await initializeTelegramBot(accountId, true);
    
    if (!bot) {
      throw new Error('Falha na inicialização');
    }
    
    // 3. Testar envio de mensagem (só se houver chat_id configurado)
    console.log(`[TELEGRAM_TEST] 🧪 Verificando se há chat_id configurado...`);
    const db = await getDatabaseInstance();
    const [rows] = await db.query(
      'SELECT telegram_chat_id FROM contas WHERE id = ?',
      [accountId]
    );
    
    let messageSent = false;
    if (rows.length > 0 && rows[0].telegram_chat_id) {
      console.log(`[TELEGRAM_TEST] 📨 Chat ID encontrado, testando envio...`);
      
      const testMessage = `🧪 <b>Teste de Bot</b>\n\n` +
                         `🏦 Conta: ${accountId}\n` +
                         `⏰ ${new Date().toLocaleString('pt-BR')}\n\n` +
                         `✅ Bot funcionando corretamente!`;
      
      messageSent = await sendTelegramMessage(accountId, null, testMessage);
    } else {
      console.log(`[TELEGRAM_TEST] ⚠️ Chat ID não configurado - mensagem de teste não enviada`);
      console.log(`[TELEGRAM_TEST] 💡 Para testar envio, inicie o bot no Telegram com /start`);
    }
    
    console.log(`[TELEGRAM_TEST] 📊 Resultado do teste:`);
    console.log(`[TELEGRAM_TEST] ✅ Inicialização: Sucesso`);
    console.log(`[TELEGRAM_TEST] ${messageSent ? '✅' : 'ℹ️'} Envio de mensagem: ${messageSent ? 'Sucesso' : 'Chat ID não configurado'}`);
    
    return {
      success: true,
      bot: bot,
      messageSent: messageSent,
      chatConfigured: rows.length > 0 && rows[0].telegram_chat_id
    };
    
  } catch (error) {
    console.error(`[TELEGRAM_TEST] ❌ Teste falhou:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * ✅ FUNÇÃO PARA LISTAR TODOS OS BOTS ATIVOS
 */
function listActiveBots() {
  console.log(`[TELEGRAM] 📋 Bots ativos: ${telegramBots.size}`);
  for (const [accountId, bot] of telegramBots) {
    console.log(`[TELEGRAM] - Conta ${accountId}: ${bot ? 'Ativo' : 'Inativo'}`);
  }
  return Array.from(telegramBots.keys());
}

module.exports = {
  initializeTelegramBot,
  getTelegramBot,
  sendTelegramMessage,
  stopTelegramBot,
  testTelegramBot,
  listActiveBots,
  clearBotWebhook,
  validateTelegramToken
};