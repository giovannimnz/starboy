console.log('🔍 [DEBUG] Carregando telegramApi.js...');

const { getDatabaseInstance } = require('../core/database/conexao');

console.log('✅ [DEBUG] Todas as dependências importadas com sucesso');

class TelegramApiService {
  constructor() {
    this.bots = new Map(); // accountId -> bot instance
    this.tokens = new Map(); // accountId -> token
    this.chatIds = new Map(); // accountId -> chatId
  }

  /**
   * Inicializar bot para uma conta específica (lazy loading)
   */
  async initializeBotForAccount(accountId) {
    try {
      if (this.tokens.has(accountId)) {
        return { 
          token: this.tokens.get(accountId), 
          chatId: this.chatIds.get(accountId) 
        };
      }

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
        throw new Error(`Token não configurado para conta ${accountId}`);
      }

      if (!chatId) {
        throw new Error(`Chat ID não configurado para conta ${accountId}`);
      }

      // Validar token
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const result = await response.json();

      if (!result.ok) {
        throw new Error(`Token inválido para conta ${accountId}: ${result.description}`);
      }

      // Salvar dados
      this.tokens.set(accountId, token);
      this.chatIds.set(accountId, chatId);

      console.log(`[TELEGRAM_API] ✅ Bot configurado para conta ${accountId} (${accountName})`);
      return { token, chatId, accountName };

    } catch (error) {
      console.error(`[TELEGRAM_API] ❌ Erro ao inicializar bot para conta ${accountId}:`, error.message);
      throw error;
    }
  }

  /**
   * Enviar mensagem via API direta (mais confiável)
   */
  async sendMessage(accountId, message, chatId = null, replyToMessageId = null) {
    try {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegramApi.js | FUNÇÃO: sendMessage`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Parâmetros: Conta=${accountId}, ChatId=${chatId || 'padrão'}, ReplyTo=${replyToMessageId || 'null'}`);
      
      // ✅ VALIDAR SE A MENSAGEM É UMA PROMISE NÃO RESOLVIDA
      if (message && typeof message === 'object' && typeof message.then === 'function') {
        console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | ERRO CRÍTICO: Promise não resolvida detectada!`);
        console.error(`[TELEGRAM_DISPATCHER] 🔍 Tipo da mensagem:`, typeof message);
        console.error(`[TELEGRAM_DISPATCHER] 🔍 Conteúdo:`, message);
        throw new Error('Promise não resolvida foi passada como mensagem para o Telegram');
      }
      
      // ✅ GARANTIR QUE A MENSAGEM É UMA STRING VÁLIDA
      if (typeof message !== 'string' || message.trim() === '') {
        console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | ERRO: Mensagem inválida (tipo: ${typeof message})`);
        throw new Error(`Mensagem inválida: esperado string, recebido ${typeof message}`);
      }
      
      // Garantir que o bot está inicializado
      await this.initializeBotForAccount(accountId);

      const token = this.tokens.get(accountId);
      const finalChatId = chatId || this.chatIds.get(accountId);

      if (!token || !finalChatId) {
        const errorMsg = `Token ou Chat ID não configurado para conta ${accountId}`;
        console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramApi.js | ${errorMsg}`);
        throw new Error(errorMsg);
      }

      console.log(`[TELEGRAM_DISPATCHER] � Token configurado: ${token.substring(0, 10)}... | Chat: ${finalChatId}`);
      console.log(`[TELEGRAM_DISPATCHER] 📝 Mensagem (${message?.length || 0} chars): ${message?.substring(0, 100)}...`);

      const requestBody = {
        chat_id: finalChatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      };

      // ✅ ADICIONAR reply_to_message_id SE FORNECIDO
      if (replyToMessageId) {
        requestBody.reply_to_message_id = replyToMessageId;
        console.log(`[TELEGRAM_DISPATCHER] 🔗 Adicionando reply_to_message_id: ${replyToMessageId}`);
      }

      console.log(`[TELEGRAM_DISPATCHER] 📡 Enviando para Telegram API: https://api.telegram.org/bot${token.substring(0, 10)}.../sendMessage`);
      console.log(`[TELEGRAM_DISPATCHER] 📦 Request body:`, JSON.stringify(requestBody, null, 2));

      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      const result = await response.json();

      console.log(`[TELEGRAM_DISPATCHER] 📤 Resposta da API do Telegram (HTTP ${response.status}):`, JSON.stringify(result, null, 2));

      if (result.ok) {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.log(`[TELEGRAM_DISPATCHER] ✅ ${timestamp} | telegramApi.js | Mensagem enviada com SUCESSO para conta ${accountId}${replyToMessageId ? ' como resposta' : ''}`);
        console.log(`[TELEGRAM_DISPATCHER] 📨 Message ID retornado: ${result.result.message_id}`);
        return { success: true, messageId: result.result.message_id, result: result.result };
      } else {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramApi.js | ERRO da API do Telegram para conta ${accountId}:`, result.description);
        console.error(`[TELEGRAM_DISPATCHER] 🔍 Código de erro:`, result.error_code);
        return { success: false, error: result.description, error_code: result.error_code };
      }

    } catch (error) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegramApi.js | ERRO CRÍTICO ao enviar mensagem para conta ${accountId}:`, error.message);
      console.error(`[TELEGRAM_DISPATCHER] 📋 Stack trace:`, error.stack);
      return { success: false, error: error.message };
    }
  }

  /**
   * Remover bot de uma conta
   */
  removeBotForAccount(accountId) {
    this.bots.delete(accountId);
    this.tokens.delete(accountId);
    this.chatIds.delete(accountId);
    console.log(`[TELEGRAM_API] 🗑️ Bot removido para conta ${accountId}`);
  }

  /**
   * Limpar todos os bots
   */
  clearAllBots() {
    this.bots.clear();
    this.tokens.clear();
    this.chatIds.clear();
    console.log(`[TELEGRAM_API] 🧹 Todos os bots removidos`);
  }

  /**
   * Listar contas com bots ativos
   */
  listActiveBots() {
    return Array.from(this.tokens.keys());
  }

  /**
   * ✅ NOVA FUNÇÃO: Atualizar registry_message_id na tabela webhook_signals
   */
  async updateSignalRegistryMessageId(signalId, messageId) {
    try {
      const db = await getDatabaseInstance();
      
      let updateTries = 0;
      while (updateTries < 100) {
        try {
          await db.query(
            'UPDATE webhook_signals SET registry_message_id = ? WHERE id = ?',
            [messageId, signalId]
          );
          
          console.log(`[TELEGRAM_API] ✅ registry_message_id ${messageId} atualizado para sinal ${signalId}`);
          return true;
          
        } catch (error) {
          if (error.message && error.message.includes('Deadlock found when trying to get lock') && updateTries < 99) {
            updateTries++;
            console.warn(`[TELEGRAM_API] ⚠️ Deadlock ao atualizar registry_message_id, tentativa ${updateTries}/100...`);
            await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
            continue;
          }
          throw error;
        }
      }
      
      return false;
      
    } catch (error) {
      console.error(`[TELEGRAM_API] ❌ Erro ao atualizar registry_message_id:`, error.message);
      return false;
    }
  }
}

// Instância singleton
const telegramApiService = new TelegramApiService();

// Funções de formatação simplificadas (sem dependências externas)
async function formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId) {
  try {
    const tps = [
      signal.tp1_price, signal.tp2_price, signal.tp3_price,
      signal.tp4_price, signal.tp5_price || signal.tp_price
    ].filter(tp => tp !== undefined && tp !== null);

    let tpsText = '';
    for (let idx = 0; idx < tps.length; idx++) {
      let tp = tps[idx];
      const tpEmoji = idx < tps.length - 1 ? '🟢' : '🔵';
      if (tp !== undefined && tp !== null) {
        tp = parseFloat(tp).toFixed(2); // Simplificado sem roundPriceToTickSize
      } else {
        tp = 'N/A';
      }
      tpsText += `├ ${tpEmoji} TP${idx + 1}: $${tp}\n`;
    }
    
    let sl = signal.sl_price || 'N/A';
    if (sl !== 'N/A') {
      sl = parseFloat(sl).toFixed(2); // Simplificado
    }
    tpsText += `└ 🔴 SL: $${sl}\n`;

    const side = signal.side.toUpperCase() === 'BUY' || signal.side.toUpperCase() === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
    const leverage = signal.leverage || 1;
    const roundedAvgPrice = parseFloat(averagePrice).toFixed(2);
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
  } catch (error) {
    console.error('[TELEGRAM_API] Erro ao formatar mensagem de entrada:', error.message);
    // Retornar mensagem simples em caso de erro
    return `🎯 <b>ENTRADA EXECUTADA</b>\n\n📊 <b>${signal.symbol}</b>\n⏰ ${new Date().toLocaleString('pt-BR')}`;
  }
}

async function formatPositionClosedMessage(positionOrSymbol, side, quantity, entryPrice, exitPrice, pnl, accountId) {
  try {
    let symbol, _side, _quantity, _entry, _exit, _pnl;

    if (typeof positionOrSymbol === 'object' && positionOrSymbol !== null) {
      const pos = positionOrSymbol;
      symbol = pos.simbolo;
      _quantity = parseFloat(pos.quantidade).toString().replace(/\.?0+$/, '');
      _pnl = typeof pos.liquid_pnl === 'number' ? pos.liquid_pnl : parseFloat(pos.liquid_pnl || '0');

      // 🔍 Buscar dados corretos da webhook_signals usando position_id
      try {
        console.log(`[TELEGRAM_API] 🔍 Buscando dados do sinal para position_id: ${pos.id}`);
        
        const db = await getDatabaseInstance();
        const [signalRows] = await db.query(
          'SELECT side, entry_price, tp5_price FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1',
          [pos.id]
        );

        if (signalRows.length > 0) {
          const signal = signalRows[0];
          
          // ✅ TRATAR OS VALORES "COMPRA" e "VENDA" da webhook_signals
          let normalizedSide = signal.side;
          if (signal.side === 'COMPRA') {
            normalizedSide = 'BUY';
          } else if (signal.side === 'VENDA') {
            normalizedSide = 'SELL';
          }
          
          _side = normalizedSide;
          _entry = signal.entry_price;
          _exit = signal.tp5_price;
          
          console.log(`[TELEGRAM_API] ✅ Dados do sinal encontrados:`, {
            position_id: pos.id,
            side_original: signal.side,
            side_normalizado: _side,
            entry_price: _entry,
            tp5_price: _exit
          });
        } else {
          console.log(`[TELEGRAM_API] ⚠️ Nenhum sinal encontrado para position_id: ${pos.id}, usando dados da posição`);
          _side = pos.side;
          _entry = typeof pos.preco_entrada === 'number' ? pos.preco_entrada : parseFloat(pos.preco_entrada || '0');
          _exit = typeof pos.preco_corrente === 'number' ? pos.preco_corrente : parseFloat(pos.preco_corrente || '0');
        }
      } catch (dbError) {
        console.error(`[TELEGRAM_API] ❌ Erro ao buscar dados do sinal:`, dbError.message);
        // Fallback para dados da posição em caso de erro
        _side = pos.side;
        _entry = typeof pos.preco_entrada === 'number' ? pos.preco_entrada : parseFloat(pos.preco_entrada || '0');
        _exit = typeof pos.preco_corrente === 'number' ? pos.preco_corrente : parseFloat(pos.preco_corrente || '0');
      }
    } else {
      symbol = positionOrSymbol;
      _side = side;
      _quantity = parseFloat(quantity).toString().replace(/\.?0+$/, '');
      _entry = entryPrice;
      _exit = exitPrice;
      _pnl = pnl;
    }

    const roundedEntry = parseFloat(_entry).toFixed(2);
    const roundedExit = parseFloat(_exit).toFixed(2);

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
  } catch (error) {
    console.error('[TELEGRAM_API] Erro ao formatar mensagem de posição fechada:', error.message);
    return `💰 <b>POSIÇÃO FECHADA</b>\n\n📊 <b>${symbol || 'N/A'}</b>\n⏰ ${new Date().toLocaleString('pt-BR')}`;
  }
}

function formatErrorMessage(signal, errorMsg) {
  const side = signal.side.toUpperCase() === 'BUY' || signal.side.toUpperCase() === 'COMPRA' ? '🟢 COMPRA' : '🔴 VENDA';
  
  return `❌ <b>ERRO NA ENTRADA</b>\n\n` +
         `📊 <b>${signal.symbol}</b>\n` +
         `${side} | ${signal.leverage || 1}x\n\n` +
         `🚫 <b>Motivo:</b>\n` +
         `${errorMsg}\n\n` +
         `⏰ ${new Date().toLocaleString('pt-BR')}`;
}

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
    console.log(`[TELEGRAM_API] 📊 Mudança de saldo insignificante (${change.toFixed(4)}), mensagem não enviada`);
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
  
  return `${emoji} <b>Atualização de Saldo</b>\n\n` +
         `💰 <b>Saldo Anterior:</b> ${previousBalance.toFixed(2)} USDT\n` +
         `💰 <b>Novo Saldo:</b> ${newBalance.toFixed(2)} USDT\n` +
         `📊 <b>Mudança:</b> ${changeText} USDT\n\n` +
         `🔍 <b>Motivo:</b> ${reasonText}\n` +
         `📋 <b>Conta:</b> ${accountId}\n` +
         `⏰ <b>Horário:</b> ${new Date().toLocaleString('pt-BR')}`;
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

module.exports = {
  telegramApiService,
  formatEntryMessage,
  formatPositionClosedMessage,
  formatErrorMessage,
  formatAlertMessage,
  formatOrderMessage,          // ✅ NOVO
  formatBalanceMessage,        // ✅ NOVO  
  formatSignalRegisteredMessage // ✅ NOVO
};