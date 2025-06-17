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
  console.log(`[SIGNAL] Processando sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} a ${signal.price}`);
  
  try {
    // Atualizar status para PROCESSANDO
    await db.query(
      'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
      ['PROCESSANDO', signal.id]
    );
    
    // CORREÇÃO: Verificar se já existe posição aberta
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
    
    // Processar entrada
    if (signal.side === 'BUY' || signal.side === 'SELL') {
      // Converter signal.side para 'COMPRA' ou 'VENDA' se necessário
      const ladoConvertido = signal.side === 'BUY' ? 'COMPRA' : 'VENDA';
      
      const signalForEntry = {
        ...signal,
        side: ladoConvertido
      };
      
      await executeLimitMakerEntry(signalForEntry, accountId);
      
      // Atualizar status para COMPLETED
      await db.query(
        'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
        ['COMPLETED', signal.id]
      );
      
      console.log(`[SIGNAL] ✅ Sinal ${signal.id} processado com sucesso`);
    } else {
      throw new Error(`Lado do sinal inválido: ${signal.side}`);
    }
    
  } catch (error) {
    console.error(`[SIGNAL] Erro na execução do sinal ${signal.id}: ${error.message}`);
    
    // CORREÇÃO: Usar formatErrorMessage do telegramBot.js (importar se necessário)
    try {
      // Se formatErrorMessage não está disponível, criar mensagem manualmente
      const errorMessage = `🚨 ERRO no Sinal ${signal.id}\n` +
                          `📊 Par: ${signal.symbol}\n` +
                          `📈 Lado: ${signal.side}\n` +
                          `💰 Preço: ${signal.price}\n` +
                          `❌ Erro: ${error.message}\n` +
                          `⏰ Hora: ${new Date().toLocaleString('pt-BR')}`;
      
      const chatId = await getChatIdForAccount(accountId);
      if (chatId) {
        const sent = await sendTelegramMessage(accountId, chatId, errorMessage);
        if (!sent) {
          console.warn(`[TELEGRAM] Falha ao enviar mensagem de erro para conta ${accountId}`);
        }
      }
    } catch (telegramError) {
      console.error(`[TELEGRAM] Erro ao enviar mensagem:`, telegramError.message);
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