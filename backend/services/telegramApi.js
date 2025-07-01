const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../core/database/conexao');
const { roundPriceToTickSize, getPrecisionCached } = require('../exchanges/binance/api/rest');

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
      if (this.bots.has(accountId)) {
        return this.bots.get(accountId);
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
        console.warn(`[TELEGRAM_API] Token não configurado para conta ${accountId}`);
        return null;
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
      return null;
    }
  }

  /**
   * Enviar mensagem via API direta (mais confiável)
   */
  async sendMessage(accountId, message, chatId = null) {
    try {
      // Garantir que o bot está inicializado
      await this.initializeBotForAccount(accountId);

      const token = this.tokens.get(accountId);
      const finalChatId = chatId || this.chatIds.get(accountId);

      if (!token || !finalChatId) {
        throw new Error(`Token ou Chat ID não configurado para conta ${accountId}`);
      }

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
        console.log(`[TELEGRAM_API] ✅ Mensagem enviada para conta ${accountId}`);
        return { success: true, messageId: result.result.message_id };
      } else {
        console.error(`[TELEGRAM_API] ❌ Erro da API para conta ${accountId}:`, result.description);
        return { success: false, error: result.description };
      }

    } catch (error) {
      console.error(`[TELEGRAM_API] ❌ Erro ao enviar mensagem para conta ${accountId}:`, error.message);
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
}

// Instância singleton
const telegramApiService = new TelegramApiService();

// Funções de formatação (mantidas do arquivo original)
async function formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId) {
  const precisionInfo = await getPrecisionCached(signal.symbol, accountId);
  const pricePrecision = precisionInfo.pricePrecision || 2;
  
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

async function formatPositionClosedMessage(positionOrSymbol, side, quantity, entryPrice, exitPrice, pnl, accountId) {
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

  const precisionInfo = await getPrecisionCached(symbol, accountId);
  const pricePrecision = precisionInfo.pricePrecision || 2;

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

module.exports = {
  telegramApiService,
  formatEntryMessage,
  formatPositionClosedMessage,
  formatErrorMessage,
  formatAlertMessage
};