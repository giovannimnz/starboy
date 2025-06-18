// Movidos para o topo do arquivo
const api = require('../api');
const websockets = require('../websockets');
const { getDatabaseInstance } = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
const { getAllOpenPositions } = require('../api');
const { sendTelegramMessage } = require('./telegramBot');

// Conjunto para controlar sinais em processamento
const processingSignals = new Set();

/**
 * Processa um sinal específico
 */
async function processSignal(signal, db, accountId) {
  console.log(`[SIGNAL] Processando sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} a ${signal.entry_price || signal.price}`);
  
  try {
    // Atualizar status para PROCESSANDO
    await db.query(
      'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
      ['PROCESSANDO', signal.id]
    );
    
    // Verificar se já existe posição aberta
    const openPositions = await getAllOpenPositions(accountId);
    const existingPosition = openPositions.find(pos => pos.simbolo === signal.symbol);
    
    if (existingPosition) {
      console.log(`[SIGNAL] ⚠️ Já existe posição aberta para ${signal.symbol}, ignorando sinal`);
      
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['IGNORED', 'Posição já aberta para este símbolo', signal.id]
      );
      
      return;
    }
    
    // CORREÇÃO: Normalizar o lado do sinal - ACEITAR "VENDA"
    let normalizedSide = signal.side;
    
    if (typeof signal.side === 'string') {
      const upperSide = signal.side.toUpperCase();
      
      // Mapear diferentes formatos para o padrão esperado pelo limitMakerEntry
      const sideMapping = {
        'BUY': 'COMPRA',
        'SELL': 'VENDA', 
        'LONG': 'COMPRA',
        'SHORT': 'VENDA',
        'COMPRA': 'COMPRA',
        'VENDA': 'VENDA'
      };
      
      if (sideMapping[upperSide]) {
        normalizedSide = sideMapping[upperSide];
        console.log(`[SIGNAL] Lado normalizado: ${signal.side} → ${normalizedSide}`);
      } else {
        throw new Error(`Lado do sinal não reconhecido: "${signal.side}". Valores aceitos: BUY, SELL, LONG, SHORT, COMPRA, VENDA`);
      }
    }
    
    // Processar entrada com lado normalizado
    if (normalizedSide === 'COMPRA' || normalizedSide === 'VENDA') {
      const signalForEntry = {
        ...signal,
        side: normalizedSide,
        price: signal.entry_price || signal.price
      };
      
      console.log(`[SIGNAL] Executando ${normalizedSide} para ${signal.symbol}`);
      console.log(`[SIGNAL] Parâmetros para limitMakerEntry: signal.id=${signalForEntry.id}, accountId=${accountId}`);
      
      // CORREÇÃO CRÍTICA: Chamar executeLimitMakerEntry com assinatura correta
      // Verificar no código atual qual é a assinatura esperada
      const api = require('../api');
      const currentPrice = await api.getPrice(signal.symbol, accountId);
      
      // ASSINATURA CORRETA: executeLimitMakerEntry(signal, accountId)
      await executeLimitMakerEntry(signalForEntry, accountId);
      
      // Atualizar status para COMPLETED
      await db.query(
        'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
        ['COMPLETED', signal.id]
      );
      
      console.log(`[SIGNAL] ✅ Sinal ${signal.id} processado com sucesso`);
    } else {
      throw new Error(`Lado do sinal inválido após normalização: ${normalizedSide}`);
    }
    
  } catch (error) {
    console.error(`[SIGNAL] Erro na execução do sinal ${signal.id}: ${error.message}`);
    
    // Usar chat ID específico do sinal
    try {
      const errorMessage = `🚨 ERRO no Sinal ${signal.id}\n` +
                          `📊 Par: ${signal.symbol}\n` +
                          `📈 Lado: ${signal.side}\n` +
                          `💰 Preço: ${signal.entry_price || signal.price || 'N/A'}\n` +
                          `❌ Erro: ${error.message}\n` +
                          `⏰ Hora: ${new Date().toLocaleString('pt-BR')}`;
      
      const chatId = await getChatIdForSignal(signal, accountId);
      if (chatId) {
        const sent = await sendTelegramMessage(accountId, chatId, errorMessage);
        if (!sent) {
          console.warn(`[TELEGRAM] Falha ao enviar mensagem de erro para sinal ${signal.id} (chat: ${chatId})`);
        } else {
          console.log(`[TELEGRAM] ✅ Mensagem de erro enviada para sinal ${signal.id} (chat: ${chatId})`);
        }
      } else {
        console.warn(`[TELEGRAM] Nenhum chat ID disponível para enviar erro do sinal ${signal.id}`);
      }
    } catch (telegramError) {
      console.error(`[TELEGRAM] Erro ao enviar mensagem de erro do sinal ${signal.id}:`, telegramError.message);
    }
    
    // Atualizar status para ERROR
    await db.query(
      'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
      ['ERROR', error.message, signal.id]
    );
  }
}

/**
 * Obtém o chat ID do Telegram para uma conta
 */
async function getChatIdForAccount(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    const [rows] = await db.query(
      'SELECT telegram_chat_id FROM contas WHERE id = ? AND ativa = 1',
      [accountId]
    );
    
    if (rows.length > 0 && rows[0].telegram_chat_id) {
      return rows[0].telegram_chat_id;
    }
    
    console.warn(`[TELEGRAM] Chat ID não encontrado para conta ${accountId}`);
    return null;
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao obter chat ID para conta ${accountId}:`, error.message);
    return null;
  }
}

/**
 * Verifica e processa novos sinais
 */
async function checkNewTrades(accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para checkNewTrades: ${accountId}`);
  }

  try {
    const db = await getDatabaseInstance(accountId);
    
    // Buscar sinais pendentes para a conta específica
    const [signals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE status = 'PENDING' 
        AND conta_id = ?
      ORDER BY created_at ASC 
      LIMIT 5
    `, [accountId]);

    if (signals.length === 0) {
      return;
    }

    console.log(`[SIGNAL] ${signals.length} sinais pendentes encontrados para conta ${accountId}`);

    for (const signal of signals) {
      try {
        await processSignal(signal, db, accountId);
      } catch (signalError) {
        console.error(`[SIGNAL] Erro ao processar sinal ${signal.id}:`, signalError.message);
      }
    }
  } catch (error) {
    console.error(`[SIGNAL] Erro ao verificar novos sinais para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Força processamento de sinais pendentes (para debug)
 */
async function forceProcessPendingSignals(accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para forceProcessPendingSignals: ${accountId}`);
  }

  try {
    console.log(`[SIGNAL] Forçando processamento de sinais pendentes para conta ${accountId}...`);
    
    const db = await getDatabaseInstance(accountId);
    
    // Reset sinais em processamento há mais de 5 minutos
    await db.query(`
      UPDATE webhook_signals 
      SET status = 'PENDING', 
          error_message = NULL,
          updated_at = NOW()
      WHERE status = 'PROCESSANDO' 
        AND conta_id = ?
        AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [accountId]);
    
    await checkNewTrades(accountId);
    console.log(`[SIGNAL] ✅ Processamento forçado concluído para conta ${accountId}`);
    
  } catch (error) {
    console.error(`[SIGNAL] Erro no processamento forçado para conta ${accountId}:`, error.message);
    throw error;
  }
}

module.exports = {
  processSignal,
  checkNewTrades,
  forceProcessPendingSignals,
  getChatIdForAccount
};