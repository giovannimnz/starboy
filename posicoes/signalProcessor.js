// Movidos para o topo do arquivo
const api = require('../api');
const websockets = require('../websockets');
const { getDatabaseInstance } = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
// CORREÇÃO: Importar getAllOpenPositions do api.js, não do positionSync.js
const { getAllOpenPositions } = require('../api');

// Set para rastrear sinais em processamento
const processingSignals = new Set();

/**
 * Normaliza o lado do sinal
 */
function normalizeSide(side) {
  if (!side) return null;
  
  const normalizedSide = side.toString().toUpperCase();
  
  if (['BUY', 'COMPRA', 'LONG'].includes(normalizedSide)) {
    return 'BUY';
  } else if (['SELL', 'VENDA', 'SHORT'].includes(normalizedSide)) {
    return 'SELL';
  }
  
  return null;
}

/**
 * Processa um sinal específico
 */
async function processSignal(signal, db, accountId) {
  const signalId = signal.id;
  
  // Verificar se já está sendo processado
  if (processingSignals.has(signalId)) {
    console.log(`[SIGNAL] Sinal ${signalId} já está sendo processado, ignorando...`);
    return { success: false, error: 'Sinal já em processamento' };
  }
  
  // Adicionar ao set de processamento
  processingSignals.add(signalId);
  
  try {
    console.log(`[SIGNAL] 🔄 Iniciando processamento do sinal ${signalId} para ${signal.symbol}: ${signal.side} a ${signal.entry_price || signal.price}`);
    
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    // Atualizar status para PROCESSANDO
    await db.query(
      'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
      ['PROCESSANDO', signalId]
    );
    
    console.log(`[SIGNAL] ✅ Status atualizado para PROCESSANDO para sinal ${signalId}`);
    
    // Verificar se já existe posição aberta para este símbolo
    //console.log(`[SIGNAL] 🔍 Verificando posições existentes para ${signal.symbol}...`);
    
    // CORREÇÃO CRÍTICA: Usar getAllOpenPositions corretamente
    const openPositions = await getAllOpenPositions(accountId);
    const existingPosition = openPositions.find(pos => pos.simbolo === signal.symbol);
    
    if (existingPosition) {
      console.log(`[SIGNAL] ⚠️ Já existe posição aberta para ${signal.symbol}, ignorando sinal ${signalId}`);
      
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', 'Posição já existe para este símbolo', signalId]
      );
      
      return { success: false, error: 'Posição já existe para este símbolo' };
    }
    
    console.log(`[SIGNAL] ✅ Nenhuma posição existente encontrada para ${signal.symbol}`);
    
    // Normalizar lado do sinal
    const normalizedSide = normalizeSide(signal.side);
    if (!normalizedSide) {
      throw new Error(`Lado do sinal inválido: ${signal.side}`);
    }
    
    console.log(`[SIGNAL] 📊 Lado normalizado: ${signal.side} -> ${normalizedSide}`);
    
    // Preparar dados do sinal para execução
    const signalForEntry = {
      ...signal,
      side: normalizedSide,
      entry_price: signal.entry_price || signal.price,
      conta_id: accountId
    };
    
    console.log(`[SIGNAL] 🎯 Preparando execução da entrada:`);
    console.log(`[SIGNAL]   - Símbolo: ${signalForEntry.symbol}`);
    console.log(`[SIGNAL]   - Lado: ${signalForEntry.side}`);
    console.log(`[SIGNAL]   - Preço entrada: ${signalForEntry.entry_price}`);
    console.log(`[SIGNAL]   - Alavancagem: ${signalForEntry.leverage}`);
    console.log(`[SIGNAL]   - Capital %: ${signalForEntry.capital_pct}`);
    
    // Executar entrada usando limitMakerEntry
    try {
      console.log(`[SIGNAL] 🚀 Chamando executeLimitMakerEntry para sinal ${signalId}...`);
      
      const { executeLimitMakerEntry } = require('./limitMakerEntry');
      
      const api = require('../api');
      const currentPrice = await api.getPrice(signal.symbol, accountId);
      
      if (!currentPrice || currentPrice <= 0) {
        throw new Error(`Preço inválido obtido para ${signal.symbol}: ${currentPrice}`);
      }
      
      console.log(`[SIGNAL] 💰 Preço atual obtido: ${currentPrice}`);
      
      // CORREÇÃO: Chamar a função com os parâmetros corretos (sem o 'db').
      // A função executeLimitMakerEntry agora obtém sua própria conexão com o banco.
      const entryResult = await executeLimitMakerEntry(signalForEntry, currentPrice, accountId);
      
      if (entryResult && entryResult.success) {
        console.log(`[SIGNAL] ✅ Entrada executada com sucesso para sinal ${signalId}`);
        console.log(`[SIGNAL] 📊 Resultado:`);
        console.log(`[SIGNAL]   - Quantidade: ${entryResult.filledQuantity || 'N/A'}`);
        console.log(`[SIGNAL]   - Preço médio: ${entryResult.averagePrice || 'N/A'}`);
        console.log(`[SIGNAL]   - Valor total: ${entryResult.totalValue || 'N/A'}`);
        
        // Atualizar status para COMPLETED
        await db.query(
          'UPDATE webhook_signals SET status = ?, updated_at = NOW() WHERE id = ?',
          ['COMPLETED', signalId]
        );
        
        // Enviar notificação via Telegram se configurado
        if (signal.chat_id) {
          try {
            const { sendTelegramMessage, formatEntryMessage } = require('./telegramBot');
            const message = formatEntryMessage(
              signalForEntry, 
              entryResult.filledQuantity || 0, 
              entryResult.averagePrice || currentPrice, 
              entryResult.totalValue || 0
            );
            
            await sendTelegramMessage(accountId, signal.chat_id, message);
            console.log(`[SIGNAL] 📱 Notificação enviada via Telegram para sinal ${signalId}`);
          } catch (telegramError) {
            console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação Telegram para sinal ${signalId}:`, telegramError.message);
          }
        }
        
        return entryResult;
        
      } else {
        const errorMsg = entryResult?.error || 'Erro desconhecido na execução da entrada';
        console.error(`[SIGNAL] ❌ Erro na execução da entrada para sinal ${signalId}: ${errorMsg}`);
        
        // Atualizar status para ERROR
        await db.query(
          'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
          ['ERROR', errorMsg.substring(0, 250), signalId]
        );
        
        // Enviar notificação de erro via Telegram
        if (signal.chat_id) {
          try {
            const { sendTelegramMessage, formatErrorMessage } = require('./telegramBot');
            const errorMessage = formatErrorMessage(signalForEntry, errorMsg);
            await sendTelegramMessage(accountId, signal.chat_id, errorMessage);
          } catch (telegramError) {
            console.warn(`[SIGNAL] ⚠️ Erro ao enviar notificação de erro via Telegram:`, telegramError.message);
          }
        }
        
        return { success: false, error: errorMsg };
      }
      
    } catch (entryError) {
      console.error(`[SIGNAL] ❌ Erro crítico na execução da entrada para sinal ${signalId}:`, entryError.message);
      console.error(`[SIGNAL] Stack trace:`, entryError.stack);
      
      // Atualizar status para ERROR
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
        ['ERROR', entryError.message.substring(0, 250), signalId]
      );
      
      throw entryError;
    }
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro no processamento do sinal ${signalId}:`, error.message);
    console.error(`[SIGNAL] Stack trace:`, error.stack);
    
    // Atualizar status para ERROR se ainda não foi atualizado
    try {
      await db.query(
        'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ? AND status = ?',
        ['ERROR', error.message.substring(0, 250), signalId, 'PROCESSANDO']
      );
    } catch (updateError) {
      console.error(`[SIGNAL] ❌ Erro ao atualizar status de erro:`, updateError.message);
    }
    
    return { success: false, error: error.message };
    
  } finally {
    // Remover do set de processamento
    processingSignals.delete(signalId);
    console.log(`[SIGNAL] 🔚 Processamento do sinal ${signalId} finalizado`);
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
  try {
    //console.log(`[SIGNAL] 🔍 Verificando novos sinais para conta ${accountId}...`);
    
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    // Buscar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE conta_id = ? 
      AND (status = 'PENDING' OR status = 'AGUARDANDO_ACIONAMENTO')
      ORDER BY created_at ASC
      LIMIT 10
    `, [accountId]);
    
    //console.log(`[SIGNAL] 📊 Encontrados ${pendingSignals.length} sinais pendentes para conta ${accountId}`);
    
    if (pendingSignals.length === 0) {
      return 0;
    }
    
    // Processar cada sinal
    for (const signal of pendingSignals) {
      try {
        console.log(`[SIGNAL] 🔄 Processando sinal ${signal.id} (${signal.symbol}) para conta ${accountId}...`);
        
        // Verificar se o sinal não expirou
        if (signal.timeout_at && new Date() > new Date(signal.timeout_at)) {
          console.log(`[SIGNAL] ⏰ Sinal ${signal.id} expirado (timeout_at), marcando como ERROR`);
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', 'Sinal expirado (timeout_at)', signal.id]
          );
          continue;
        }
        
        // Verificar max_lifetime_minutes
        if (signal.max_lifetime_minutes) {
          const createdAt = new Date(signal.created_at);
          const lifetimeMillis = signal.max_lifetime_minutes * 60 * 1000;
          if (Date.now() > createdAt.getTime() + lifetimeMillis) {
            console.log(`[SIGNAL] ⏰ Sinal ${signal.id} excedeu max_lifetime_minutes, marcando como ERROR`);
            await db.query(
              'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
              ['ERROR', 'Sinal expirado (max_lifetime_minutes)', signal.id]
            );
            continue;
          }
        }
        
        // Processar o sinal
        const result = await processSignal(signal, db, accountId);
        
        if (result.success) {
          console.log(`[SIGNAL] ✅ Sinal ${signal.id} processado com sucesso`);
        } else {
          console.log(`[SIGNAL] ⚠️ Sinal ${signal.id} falhou: ${result.error}`);
        }
        
      } catch (signalError) {
        console.error(`[SIGNAL] ❌ Erro ao processar sinal ${signal.id}:`, signalError.message);
        
        // Marcar sinal como ERROR
        try {
          await db.query(
            'UPDATE webhook_signals SET status = ?, error_message = ?, updated_at = NOW() WHERE id = ?',
            ['ERROR', signalError.message.substring(0, 250), signal.id]
          );
        } catch (updateError) {
          console.error(`[SIGNAL] ❌ Erro ao atualizar status de erro para sinal ${signal.id}:`, updateError.message);
        }
      }
    }
    
    return pendingSignals.length;
    
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro ao verificar novos sinais para conta ${accountId}:`, error.message);
    console.error(`[SIGNAL] Stack trace:`, error.stack);
    return 0;
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
    console.log(`[SIGNAL] 🔧 Forçando processamento de sinais pendentes para conta ${accountId}...`);
    
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
    
    const result = await checkNewTrades(accountId);
    console.log(`[SIGNAL] ✅ Processamento forçado concluído para conta ${accountId}: ${result} sinais processados`);
    
    return result;
  } catch (error) {
    console.error(`[SIGNAL] ❌ Erro no processamento forçado para conta ${accountId}:`, error.message);
    throw error;
  }
}

module.exports = {
  processSignal,
  checkNewTrades,
  forceProcessPendingSignals,
  normalizeSide
};