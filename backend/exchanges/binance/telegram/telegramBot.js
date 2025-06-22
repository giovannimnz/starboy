const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../../../core/database/conexao');

// Mapa simples para bots
const activeBots = new Map();

/**
 * ✅ INICIALIZAÇÃO SIMPLIFICADA BASEADA NO STARBOY_DEV
 */
async function initializeTelegramBot(accountId, forceRestart = false) {
  try {
    console.log(`[TELEGRAM] 🚀 Inicializando bot SIMPLIFICADO para conta ${accountId}...`);
    
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    // Limpar bot existente se necessário
    if (forceRestart && activeBots.has(accountId)) {
      const existingBot = activeBots.get(accountId);
      try {
        if (existingBot && typeof existingBot.stop === 'function') {
          await existingBot.stop();
        }
      } catch (stopError) {
        console.warn(`[TELEGRAM] ⚠️ Erro ao parar bot existente:`, stopError.message);
      }
      activeBots.delete(accountId);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Verificar se já existe e está funcional
    if (!forceRestart && activeBots.has(accountId)) {
      const existingBot = activeBots.get(accountId);
      try {
        await existingBot.telegram.getMe();
        console.log(`[TELEGRAM] ♻️ Bot existente funcional para conta ${accountId}`);
        return existingBot;
      } catch (testError) {
        console.warn(`[TELEGRAM] ⚠️ Bot existente não funcional, recriando...`);
        activeBots.delete(accountId);
      }
    }
    
    // Obter configurações do banco
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
    
    console.log(`[TELEGRAM] 📋 Conta: ${accountName}, Chat ID: ${chatId || 'não configurado'}`);
    
    // Validar token primeiro
    console.log(`[TELEGRAM] 🔍 Validando token...`);
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const result = await response.json();
    
    if (!result.ok) {
      throw new Error(`Token inválido: ${result.description}`);
    }
    
    console.log(`[TELEGRAM] ✅ Token válido: @${result.result.username}`);
    
    // Limpar webhook
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ drop_pending_updates: true })
      });
      console.log(`[TELEGRAM] 🧹 Webhook limpo`);
    } catch (webhookError) {
      console.warn(`[TELEGRAM] ⚠️ Erro ao limpar webhook:`, webhookError.message);
    }
    
    // ✅ CRIAR BOT SEM POLLING AUTOMÁTICO (COMO NO _DEV)
    const bot = new Telegraf(token);
    
    // Configurar handlers básicos
    bot.start(async (ctx) => {
      try {
        const welcomeMsg = `🤖 Bot da conta ${accountName} ativo!\n\n` +
                         `📊 Conta ID: ${accountId}\n` +
                         `👤 Usuário: ${ctx.from.username || ctx.from.first_name}\n` +
                         `🆔 Chat ID: ${ctx.chat.id}\n\n` +
                         `Digite /help para comandos disponíveis.`;
        
        await ctx.reply(welcomeMsg);
        
        // Salvar chat ID se necessário
        if (!chatId) {
          await db.query(
            'UPDATE contas SET telegram_chat_id = ? WHERE id = ?',
            [ctx.chat.id, accountId]
          );
          console.log(`[TELEGRAM] ✅ Chat ID salvo: ${ctx.chat.id}`);
        }
      } catch (error) {
        console.error(`[TELEGRAM] Erro no /start:`, error.message);
      }
    });
    
    bot.command('ping', (ctx) => ctx.reply('🏓 Pong!'));
    bot.command('status', (ctx) => {
      const statusMsg = `✅ Bot ativo - Conta ${accountName}\n⏰ ${new Date().toLocaleString('pt-BR')}`;
      ctx.reply(statusMsg);
    });
    
    bot.catch((err) => {
      console.error(`[TELEGRAM] Bot error:`, err.message);
    });
    
    // ✅ IMPLEMENTAR POLLING MANUAL COMO FALLBACK
    let isPolling = false;
    let offset = 0;
    
    const startManualPolling = async () => {
      if (isPolling) return;
      isPolling = true;
      
      console.log(`[TELEGRAM] 🔄 Iniciando polling manual...`);
      
      while (isPolling) {
        try {
          const updates = await bot.telegram.getUpdates({
            offset: offset,
            limit: 10,
            timeout: 3
          });
          
          for (const update of updates) {
            offset = update.update_id + 1;
            
            try {
              await bot.handleUpdate(update);
            } catch (updateError) {
              console.error(`[TELEGRAM] Erro ao processar update:`, updateError.message);
            }
          }
          
          // Pequena pausa
          await new Promise(resolve => setTimeout(resolve, 1000));
          
        } catch (pollingError) {
          if (isPolling) {
            console.error(`[TELEGRAM] Erro no polling manual:`, pollingError.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }
    };
    
    // Adicionar método para parar o polling
    bot.stopManualPolling = () => {
      console.log(`[TELEGRAM] 🛑 Parando polling manual...`);
      isPolling = false;
    };
    
    // ✅ TENTAR POLLING PADRÃO PRIMEIRO, COM FALLBACK PARA MANUAL
    try {
      console.log(`[TELEGRAM] 🚀 Tentando polling padrão...`);
      
      await Promise.race([
        bot.launch({
          polling: {
            timeout: 2,
            limit: 5
          }
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Timeout padrão')), 5000)
        )
      ]);
      
      console.log(`[TELEGRAM] ✅ Polling padrão funcionando!`);
      
    } catch (launchError) {
      console.log(`[TELEGRAM] ⚠️ Polling padrão falhou, usando manual: ${launchError.message}`);
      
      // Iniciar polling manual em background
      startManualPolling().catch(err => {
        console.error(`[TELEGRAM] Erro no polling manual:`, err.message);
      });
    }
    
    // Testar se bot está respondendo
    try {
      const botInfo = await bot.telegram.getMe();
      console.log(`[TELEGRAM] ✅ Bot ativo: @${botInfo.username}`);
    } catch (testError) {
      throw new Error(`Bot não está respondendo: ${testError.message}`);
    }
    
    // Salvar no mapa
    activeBots.set(accountId, bot);
    
    console.log(`[TELEGRAM] 🎉 Bot inicializado para conta ${accountId} (${accountName})`);
    
    return bot;
    
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro na inicialização para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * ✅ ENVIO DIRETO VIA API (MAIS CONFIÁVEL)
 */
async function sendTelegramMessage(accountId, message, chatId = null) {
  try {
    console.log(`[TELEGRAM] 📤 Enviando mensagem para conta ${accountId}...`);
    
    // Obter configurações
    const db = await getDatabaseInstance();
    const [rows] = await db.query(
      'SELECT telegram_bot_token, telegram_chat_id FROM contas WHERE id = ?',
      [accountId]
    );
    
    if (rows.length === 0) {
      throw new Error('Conta não encontrada');
    }
    
    const { telegram_bot_token: token, telegram_chat_id: dbChatId } = rows[0];
    const finalChatId = chatId || dbChatId;
    
    if (!token || !finalChatId) {
      throw new Error('Token ou Chat ID não configurado');
    }
    
    // ✅ ENVIO DIRETO VIA API (MAIS ESTÁVEL QUE VIA BOT)
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: finalChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    
    const result = await response.json();
    
    if (result.ok) {
      console.log(`[TELEGRAM] ✅ Mensagem enviada com sucesso`);
      return true;
    } else {
      console.error(`[TELEGRAM] ❌ Erro da API:`, result.description);
      return false;
    }
    
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro no envio:`, error.message);
    return false;
  }
}

/**
 * ✅ PARAR BOT
 */
async function stopTelegramBot(accountId) {
  try {
    console.log(`[TELEGRAM] 🛑 Parando bot para conta ${accountId}...`);
    
    const bot = activeBots.get(accountId);
    if (bot) {
      try {
        // Parar polling manual se existir
        if (typeof bot.stopManualPolling === 'function') {
          bot.stopManualPolling();
        }
        
        // Parar bot
        if (typeof bot.stop === 'function') {
          await Promise.race([
            bot.stop(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Stop timeout')), 3000)
            )
          ]);
        }
      } catch (stopError) {
        console.warn(`[TELEGRAM] ⚠️ Erro ao parar bot:`, stopError.message);
      }
      
      activeBots.delete(accountId);
      console.log(`[TELEGRAM] ✅ Bot parado para conta ${accountId}`);
    } else {
      console.log(`[TELEGRAM] ℹ️ Nenhum bot ativo para conta ${accountId}`);
    }
  } catch (error) {
    console.error(`[TELEGRAM] ❌ Erro ao parar bot:`, error.message);
  }
}

/**
 * ✅ TESTE SIMPLIFICADO
 */
async function testTelegramBotFixed(accountId) {
  console.log(`[TELEGRAM_TEST] 🧪 Testando versão corrigida para conta ${accountId}...`);
  
  try {
    // Parar bot existente
    await stopTelegramBot(accountId);
    
    // Inicializar novo
    const bot = await initializeTelegramBot(accountId, true);
    
    if (!bot) {
      throw new Error('Falha na inicialização');
    }
    
    // Aguardar um momento
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Testar envio direto
    const testMessage = `🧪 <b>Teste Bot Corrigido</b>\n\n` +
                       `🏦 Conta: ${accountId}\n` +
                       `⏰ ${new Date().toLocaleString('pt-BR')}\n\n` +
                       `✅ Sistema funcionando!`;
    
    const messageSent = await sendTelegramMessage(accountId, testMessage);
    
    console.log(`[TELEGRAM_TEST] 📊 Resultados:`);
    console.log(`[TELEGRAM_TEST] ✅ Inicialização: Sucesso`);
    console.log(`[TELEGRAM_TEST] ${messageSent ? '✅' : '❌'} Envio direto: ${messageSent ? 'Sucesso' : 'Falha'}`);
    
    return {
      success: true,
      bot: bot,
      messageSent: messageSent
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
 * ✅ FUNÇÃO PARA PARAR TODOS OS BOTS (PARA GRACEFUL SHUTDOWN)
 */
async function stopAllTelegramBots() {
  console.log(`[TELEGRAM] 🛑 Parando todos os bots...`);
  
  const accounts = Array.from(activeBots.keys());
  for (const accountId of accounts) {
    await stopTelegramBot(accountId);
  }
  
  console.log(`[TELEGRAM] ✅ Todos os bots parados`);
}

/**
 * ✅ LISTAR BOTS ATIVOS
 */
function listActiveBots() {
  console.log(`[TELEGRAM] 📋 Bots ativos: ${activeBots.size}`);
  for (const [accountId, bot] of activeBots) {
    console.log(`[TELEGRAM] - Conta ${accountId}: ${bot ? 'Ativo' : 'Inativo'}`);
  }
  return Array.from(activeBots.keys());
}

/**
 * Formata mensagem de entrada executada
 */
function formatEntryMessage(signal, filledQuantity, averagePrice, totalValue) {
  const side = signal.side.toUpperCase() === 'BUY' || signal.side.toUpperCase() === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
  const leverage = signal.leverage || 1;
  
  return `🎯 <b>ENTRADA EXECUTADA</b>\n\n` +
         `📊 <b>${signal.symbol}</b>\n` +
         `${side} | ${leverage}x\n\n` +
         `💰 <b>Execução:</b>\n` +
         `├ Quantidade: ${filledQuantity.toFixed(6)}\n` +
         `├ Preço médio: $${averagePrice.toFixed(4)}\n` +
         `└ Valor total: $${totalValue.toFixed(2)}\n\n` +
         `🎯 <b>Alvos:</b>\n` +
         `├ 🟢 TP1: $${signal.tp1_price || 'N/A'}\n` +
         `├ 🟢 TP2: $${signal.tp2_price || 'N/A'}\n` +
         `├ 🟢 TP3: $${signal.tp3_price || 'N/A'}\n` +
         `└ 🔴 SL: $${signal.sl_price || 'N/A'}\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de erro
 */
function formatErrorMessage(signal, errorMsg) {
  const side = signal.side.toUpperCase() === 'BUY' || signal.side.toUpperCase() === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
  
  return `❌ <b>ERRO NA ENTRADA</b>\n\n` +
         `📊 <b>${signal.symbol}</b>\n` +
         `${side} | ${signal.leverage || 1}x\n\n` +
         `🚫 <b>Motivo:</b>\n` +
         `${errorMsg}\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de ordem executada
 */
function formatOrderMessage(symbol, side, orderType, quantity, price, status) {
  const sideIcon = side === 'BUY' ? '🟢' : '🔴';
  const statusIcon = status === 'FILLED' ? '✅' : status === 'PARTIALLY_FILLED' ? '🔄' : '📋';
  
  return `${statusIcon} <b>ORDEM ${status}</b>\n\n` +
         `📊 <b>${symbol}</b>\n` +
         `${sideIcon} ${side} ${orderType}\n\n` +
         `💰 <b>Detalhes:</b>\n` +
         `├ Quantidade: ${quantity}\n` +
         `└ Preço: $${price}\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de mudança de saldo
 */
function formatBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange = null) {
  const change = balanceChange !== null ? balanceChange : (newBalance - previousBalance);
  const changeText = change >= 0 ? `+${change.toFixed(4)}` : change.toFixed(4);
  const emoji = change >= 0 ? '📈' : '📉';
  
  let reasonText = reason;
  switch (reason) {
    case 'FUNDING_FEE':
      reasonText = 'Taxa de Financiamento';
      break;
    case 'REALIZED_PNL':
      reasonText = 'PnL Realizado';
      break;
    case 'ORDER':
      reasonText = 'Execução de Ordem';
      break;
    case 'COMMISSION':
      reasonText = 'Comissão';
      break;
    default:
      reasonText = reason;
  }
  
  return `${emoji} **Atualização de Saldo**
  
💰 **Saldo Anterior:** ${previousBalance.toFixed(2)} USDT
💰 **Novo Saldo:** ${newBalance.toFixed(2)} USDT
📊 **Mudança:** ${changeText} USDT

🔍 **Motivo:** ${reasonText}
📋 **Conta:** ${accountId}
⏰ **Horário:** ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de posição fechada
 */
function formatPositionClosedMessage(symbol, side, quantity, entryPrice, exitPrice, pnl) {
  const pnlIcon = pnl >= 0 ? '💰' : '💸';
  const pnlColor = pnl >= 0 ? '🟢' : '🔴';
  const sideIcon = side === 'BUY' ? '🟢' : '🔴';
  
  return `${pnlIcon} <b>POSIÇÃO FECHADA</b>\n\n` +
         `📊 <b>${symbol}</b>\n` +
         `${sideIcon} ${side}\n\n` +
         `💰 <b>Resultado:</b>\n` +
         `├ Quantidade: ${quantity}\n` +
         `├ Entrada: $${entryPrice.toFixed(4)}\n` +
         `├ Saída: $${exitPrice.toFixed(4)}\n` +
         `└ ${pnlColor} PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

/**
 * Formata mensagem de alerta
 */
function formatAlertMessage(title, message, level = 'INFO') {
  const icons = {
    'INFO': 'ℹ️',
    'WARNING': '⚠️',
    'ERROR': '❌',
    'SUCCESS': '✅'
  };
  
  return `${icons[level] || 'ℹ️'} <b>${title}</b>\n\n${message}\n\n⏰ ${new Date().toLocaleString('pt-BR')}`;
}

// ✅ ATUALIZAR module.exports PARA INCLUIR AS NOVAS FUNÇÕES:
module.exports = {
  initializeTelegramBot,
  sendTelegramMessage,
  stopTelegramBot,
  testTelegramBotFixed,
  stopAllTelegramBots,
  listActiveBots,
  // ✅ NOVAS FUNÇÕES DE FORMATAÇÃO:
  formatEntryMessage,
  formatErrorMessage,
  formatOrderMessage,
  formatBalanceMessage,
  formatPositionClosedMessage,
  formatAlertMessage
};