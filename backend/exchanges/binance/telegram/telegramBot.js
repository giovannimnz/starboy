const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../../../core/database/conexao');
const { roundPriceToTickSize, getPrecisionCached } = require('../api/rest');

// Mapa simples para bots
const activeBots = new Map();

/**
 * ✅ INICIALIZAÇÃO SIMPLIFICADA BASEADA NO STARBOY_DEV
 */
async function initializeTelegramBot(accountId, forceRestart = false) {
  try {
    console.log(`[TELEGRAM] 🚀 Inicializando bot SIMPLIFICADO para conta ${accountId}...`);
    
    accountId = Number(accountId);
    if (!accountId || isNaN(accountId)) {
      throw new Error('AccountId inválido');
    }
    
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
    
    // ✅ INICIAR APENAS POLLING MANUAL (NÃO TENTAR PADRÃO)
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
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (pollingError) {
          if (isPolling) {
            console.error(`[TELEGRAM] Erro no polling manual:`, pollingError.message);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }
    };
    bot.stopManualPolling = () => {
      console.log(`[TELEGRAM] 🛑 Parando polling manual...`);
      isPolling = false;
    };
    // Iniciar polling manual SEM tentar o padrão
    startManualPolling().catch(err => {
      console.error(`[TELEGRAM] Erro no polling manual:`, err.message);
    });
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
  // Removido: Defesa contra inversão de argumentos
  try {
    console.log(`[TELEGRAM][DEBUG] 📤 Enviando mensagem para accountId=`, accountId, `(typeof: ${typeof accountId})`);
    console.log(`[TELEGRAM][DEBUG] 📤 Mensagem a ser enviada:\n${message}`);
    // Obter configurações
    const db = await getDatabaseInstance();
    //console.log(`[TELEGRAM][DEBUG] Executando query: SELECT telegram_bot_token, telegram_chat_id FROM contas WHERE id = ? [${accountId}]`);
    const [rows] = await db.query(
      'SELECT telegram_bot_token, telegram_chat_id FROM contas WHERE id = ?',
      [accountId]
    );
    //console.log(`[TELEGRAM][DEBUG] Resultado da query:`, rows);
    if (rows.length === 0) {
      console.error(`[TELEGRAM][DEBUG] Nenhuma conta encontrada para id=`, accountId, `(typeof: ${typeof accountId})`);
      throw new Error('Conta não encontrada');
    }
    const { telegram_bot_token: token, telegram_chat_id: dbChatId } = rows[0];
    const finalChatId = chatId || dbChatId;
    //console.log(`[TELEGRAM][DEBUG] Token:`, token ? token.substring(0, 8) + '...' : 'NULO', `| ChatId:`, finalChatId);
    if (!token || !finalChatId) {
      console.error(`[TELEGRAM][DEBUG] Token ou ChatId não configurado. Token:`, token, `ChatId:`, finalChatId);
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
    console.error(`[TELEGRAM][DEBUG] ❌ Erro no envio:`, error.message, '| accountId:', accountId, '| typeof:', typeof accountId);
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
async function formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId) {
  const { roundPriceToTickSize, getPrecisionCached } = require('../api/rest');
  // Buscar precisão e tick size
  const precisionInfo = await getPrecisionCached(signal.symbol, accountId);
  const pricePrecision = precisionInfo.pricePrecision || 2;
  // Alvos (TPs)
  const tps = [
    signal.tp1_price, signal.tp2_price, signal.tp3_price,
    signal.tp4_price, signal.tp5_price || signal.tp_price
  ].filter(tp => tp !== undefined && tp !== null);

  let tpsText = '';
  for (let idx = 0; idx < tps.length; idx++) {
    let tp = tps[idx];
    const tpEmoji = idx < tps.length - 1 ? '🟢' : '🔵';
    if (tp !== undefined && tp !== null) {
      tp = (await roundPriceToTickSize(signal.symbol, parseFloat(tp), accountId)).toFixed(pricePrecision);
    } else {
      tp = 'N/A';
    }
    tpsText += `├ ${tpEmoji} TP${idx + 1}: $${tp}\n`;
  }
  // SL
  let sl = signal.sl_price || 'N/A';
  if (sl !== 'N/A') {
    sl = (await roundPriceToTickSize(signal.symbol, parseFloat(sl), accountId)).toFixed(pricePrecision);
  }
  tpsText += `└ 🔴 SL: $${sl}\n`;

  const side = signal.side.toUpperCase() === 'BUY' || signal.side.toUpperCase() === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
  const leverage = signal.leverage || 1;
  const roundedAvgPrice = (await roundPriceToTickSize(signal.symbol, averagePrice, accountId)).toFixed(pricePrecision);
  const roundedQty = parseFloat(filledQuantity).toString().replace(/\.?0+$/, '');

  return (
    `🎯 <b>ENTRADA EXECUTADA</b>\n\n` +
    `📊 <b>${signal.symbol}</b>\n` +
    `${side} | ${leverage}x\n\n` +
    `💰 <b>Execução:</b>\n` +
    `├ Quantidade: ${roundedQty}\n` +
    `├ Preço médio: $${roundedAvgPrice}\n` +
    `└ Valor: $${totalValue.toFixed(2)} USDT\n\n` +
    `🎯 <b>Alvos:</b>\n` +
    `${tpsText}\n` +
    `⏰ ${new Date().toLocaleString('pt-BR')}`
  );
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
 * Só retorna mensagem se a mudança for >= 0.01 em valor absoluto
 */
function formatBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange = null) {
  const change = balanceChange !== null ? balanceChange : (newBalance - previousBalance);
  
  // ✅ VERIFICAR SE A MUDANÇA É SIGNIFICATIVA (>= 0.01)
  if (Math.abs(change) < 0.01) {
    console.log(`[TELEGRAM] 📊 Mudança de saldo insignificante (${change.toFixed(4)}), mensagem não enviada`);
    return null; // Não enviar mensagem para mudanças menores que 0.01
  }
  
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
 * Aceita objeto da posição (preferencial) ou parâmetros separados
 */
async function formatPositionClosedMessage(positionOrSymbol, side, quantity, entryPrice, exitPrice, pnl, accountId) {
  const { roundPriceToTickSize, getPrecisionCached } = require('../api/rest');
  let symbol, _side, _quantity, _entry, _exit, _pnl;

  if (typeof positionOrSymbol === 'object' && positionOrSymbol !== null) {
    const pos = positionOrSymbol;
    symbol = pos.simbolo;
    _side = pos.side;
    _quantity = parseFloat(pos.quantidade).toString().replace(/\.?0+$/, '');
    _entry = typeof pos.preco_entrada === 'number' ? pos.preco_entrada : parseFloat(pos.preco_entrada || '0');
    _exit = typeof pos.preco_corrente === 'number' ? pos.preco_corrente : parseFloat(pos.preco_corrente || '0');
    _pnl = typeof pos.liquid_pnl === 'number' ? pos.liquid_pnl : parseFloat(pos.liquid_pnl || '0');
  } else {
    symbol = positionOrSymbol;
    _side = side;
    _quantity = parseFloat(quantity).toString().replace(/\.?0+$/, '');
    _entry = entryPrice;
    _exit = exitPrice;
    _pnl = pnl;
  }

  // Buscar precisão
  const precisionInfo = await getPrecisionCached(symbol, accountId);
  const pricePrecision = precisionInfo.pricePrecision || 2;

  // Arredondar entrada e saída
  const roundedEntry = (await roundPriceToTickSize(symbol, _entry, accountId)).toFixed(pricePrecision);
  const roundedExit = (await roundPriceToTickSize(symbol, _exit, accountId)).toFixed(pricePrecision);

  const pnlIcon = _pnl >= 0 ? '💰' : '💸';
  const pnlColor = _pnl >= 0 ? '🟢' : '🔴';
  const sideIcon = _side === 'BUY' ? '🟢' : '🔴';

  return `${pnlIcon} <b>POSIÇÃO FECHADA</b>\n\n` +
         `📊 <b>${symbol}</b>\n` +
         `${sideIcon} ${_side}\n\n` +
         `💰 <b>Resultado:</b>\n` +
         `├ Quantidade: ${_quantity}\n` +
         `├ Entrada: $${roundedEntry}\n` +
         `├ Saída: $${roundedExit}\n` +
         `└ ${pnlColor} PnL: ${_pnl >= 0 ? '+' : ''}${_pnl.toFixed(2)} USDT\n\n` +
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

/**
 * Formata mensagem de sinal registrado
 */
function formatSignalRegisteredMessage(signal, grupoOrigemNome = 'Divap') {
  const side = (signal.side || '').toUpperCase();
  const sideStr = side === 'BUY' || side === 'COMPRA' ? 'COMPRA' : 'VENDA';
  const leverage = signal.leverage || 1;
  const capital = signal.capital_pct ? `${parseFloat(signal.capital_pct).toFixed(2)}%` : 'N/A';
  const timeframe = signal.timeframe || '15m';
  const nomeGrupo = grupoOrigemNome || 'Divap';

  // Alvos (TPs)
  const tps = [
    signal.tp1_price, signal.tp2_price, signal.tp3_price,
    signal.tp4_price, signal.tp5_price
  ].filter(tp => tp !== undefined && tp !== null && tp !== '');

  let tpsText = '';
  tps.forEach((tp, idx) => {
    tpsText += `\nALVO ${idx + 1}: ${tp}`;
  });

  return (
    `#${signal.symbol}  ${sideStr}\n` +
    `${timeframe}\n` +
    `${nomeGrupo}\n\n` +
    `ALAVANCAGEM: ${leverage}x\n` +
    `MARGEM: CRUZADA\n` +
    `CAPITAL: ${capital}\n\n` +
    `ENTRADA: ${signal.entry_price}\n` +
    `${tpsText}\n\n` +
    `STOP LOSS: ${signal.sl_price}`
  );
}

// ✅ ATUALIZAR module.exports PARA INCLUIR AS NOVAS FUNÇÕES:
module.exports = {
  initializeTelegramBot,
  sendTelegramMessage,
  stopTelegramBot,
  testTelegramBotFixed,
  stopAllTelegramBots,
  listActiveBots,
  
  // FUNÇÕES DE FORMATAÇÃO:
  formatEntryMessage,
  formatErrorMessage,
  formatOrderMessage,
  formatBalanceMessage,
  formatPositionClosedMessage,
  formatAlertMessage,
  formatSignalRegisteredMessage,
};