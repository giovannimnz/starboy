const { getDatabaseInstance, formatDateForMySQL } = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
const { sendTelegramMessage, formatEntryMessage, formatErrorMessage } = require('./telegramBot');

// Conjunto para controlar sinais em processamento
const processingSignals = new Set();

/**
 * Processa um sinal de entrada
 * @param {Object} db - Conexão com banco
 * @param {Object} signal - Dados do sinal
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function processSignal(db, signal, currentPrice, accountId) {
  // Verificar se já está sendo processado
  if (processingSignals.has(signal.id)) {
    console.log(`[SIGNAL] Sinal ${signal.id} já está sendo processado`);
    return { success: false, error: 'Sinal já em processamento' };
  }
  
  processingSignals.add(signal.id);
  let connection;
  
  try {
    // CORREÇÃO CRÍTICA: Validar accountId no início
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em processSignal: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    console.log(`[SIGNAL] Processando sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} a ${signal.entry_price}`);
    
    connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();

      const {
        id, symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, timeframe
      } = signal;

      // Verificar se já existe uma posição aberta para este símbolo
      const [existingPositions] = await connection.query(
        `SELECT id FROM posicoes 
         WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
        [symbol, accountId]
      );

      if (existingPositions.length > 0) {
        throw new Error(`Posição já existe para ${symbol}`);
      }

      // Verificar se o símbolo e preço são válidos
      if (!symbol || !entry_price || parseFloat(entry_price) <= 0) {
        throw new Error(`Parâmetros inválidos: symbol=${symbol}, entry_price=${entry_price}`);
      }

      // Configurar alavancagem e tipo de margem
      try {
        const api = require('../api');
        
        const currentLeverage = await api.getCurrentLeverage(symbol, accountId);
        if (currentLeverage !== parseInt(leverage)) {
          await api.changeInitialLeverage(symbol, parseInt(leverage), accountId);
        }

        const currentMarginType = await api.getCurrentMarginType(symbol, accountId);
        if (currentMarginType !== 'cross') {
          await api.changeMarginType(symbol, 'cross', accountId);
        }
      } catch (configError) {
        console.warn(`[SIGNAL] Aviso ao configurar alavancagem/margem para ${symbol}:`, configError.message);
      }

      // Iniciar monitoramento de preço via WebSocket
      const websockets = require('../websockets');
      websockets.ensurePriceWebsocketExists(symbol, accountId);

      // Atualizar status no banco
      await connection.query(
        `UPDATE webhook_signals SET status = 'EXECUTANDO' WHERE id = ?`,
        [id]
      );
      
      await connection.commit();
      
      // Executar entrada usando limitMakerEntry
      console.log(`[SIGNAL] Chamando executeLimitMakerEntry para sinal ID ${id}`);
      const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, accountId);
      
      if (entryResult && entryResult.success) {
        console.log(`[SIGNAL] Entrada executada com sucesso para sinal ${id}`);
        
        // Enviar notificação via Telegram se configurado
        if (chat_id) {
          const message = formatEntryMessage(signal, entryResult.filledQuantity, entryResult.averagePrice, entryResult.filledQuantity * entryResult.averagePrice);
          await sendTelegramMessage(accountId, chat_id, message);
        }
        
        return entryResult;
      } else {
        const errorMsg = entryResult?.error || 'Erro desconhecido na execução';
        console.error(`[SIGNAL] Erro na execução do sinal ${id}: ${errorMsg}`);
        
        // Enviar notificação de erro
        if (chat_id) {
          const errorMessage = formatErrorMessage(signal, errorMsg);
          await sendTelegramMessage(accountId, chat_id, errorMessage);
        }
        
        return { success: false, error: errorMsg };
      }
    } catch (error) {
      console.error(`[SIGNAL] Erro ao processar sinal ID ${signal.id}:`, error);
      
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error(`[SIGNAL] Erro no rollback:`, rollbackError);
        }
      }
      
      // Atualizar status para ERROR
      try {
        await db.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [String(error.message).substring(0, 250), signal.id]
        );
      } catch (updateError) {
        console.error(`[SIGNAL] Erro ao atualizar status para ERROR:`, updateError);
      }
      
      // Enviar notificação de erro
      if (signal.chat_id) {
        const errorMessage = formatErrorMessage(signal, error.message);
        await sendTelegramMessage(accountId, signal.chat_id, errorMessage);
      }
      
      return { success: false, error: error.message };
    } finally {
      if (connection) {
        connection.release();
      }
    }
  } finally {
    processingSignals.delete(signal.id);
  }
}

/**
 * Processa um sinal de entrada
 * @param {Object} db - Conexão com banco
 * @param {Object} signal - Dados do sinal
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function processSignal(db, signal, currentPrice, accountId) {
  // Verificar se já está sendo processado
  if (processingSignals.has(signal.id)) {
    console.log(`[SIGNAL] Sinal ${signal.id} já está sendo processado`);
    return;
  }
  
  processingSignals.add(signal.id);
  
  try {
    console.log(`[SIGNAL] Processando sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} a ${signal.entry_price}`);
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();

      const {
        id, symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, timeframe
      } = signal;

      // Verificar se já existe uma posição aberta para este símbolo
      const [existingPositions] = await connection.query(
        `SELECT id FROM posicoes 
         WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
        [symbol, accountId]
      );

      if (existingPositions.length > 0) {
        throw new Error(`Posição já existe para ${symbol}`);
      }

      // Verificar se o símbolo e preço são válidos
      if (!symbol || !entry_price || parseFloat(entry_price) <= 0) {
        throw new Error(`Parâmetros inválidos: symbol=${symbol}, entry_price=${entry_price}`);
      }

      // Configurar alavancagem e tipo de margem
      try {
        const api = require('../api');
        
        const currentLeverage = await api.getCurrentLeverage(symbol, accountId);
        if (currentLeverage !== parseInt(leverage)) {
          await api.changeInitialLeverage(symbol, parseInt(leverage), accountId);
        }

        const currentMarginType = await api.getCurrentMarginType(symbol, accountId);
        if (currentMarginType !== 'cross') {
          await api.changeMarginType(symbol, 'cross', accountId);
        }
      } catch (configError) {
        console.warn(`[SIGNAL] Aviso ao configurar alavancagem/margem para ${symbol}:`, configError.message);
      }

      // Iniciar monitoramento de preço via WebSocket
      const websockets = require('../websockets');
      websockets.ensurePriceWebsocketExists(symbol, accountId);

      // Atualizar status no banco
      await connection.query(
        `UPDATE webhook_signals SET status = 'EXECUTANDO' WHERE id = ?`,
        [id]
      );
      
      await connection.commit();
      
      // Executar entrada usando limitMakerEntry
      console.log(`[SIGNAL] Chamando executeLimitMakerEntry para sinal ID ${id}`);
      const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, accountId);
      
      if (entryResult && entryResult.success) {
        console.log(`[SIGNAL] Entrada executada com sucesso para sinal ${id}`);
        
        // Enviar notificação via Telegram se configurado
        if (chat_id) {
          const message = formatEntryMessage(signal, entryResult.filledQuantity, entryResult.averagePrice, entryResult.filledQuantity * entryResult.averagePrice);
          await sendTelegramMessage(accountId, chat_id, message);
        }
      } else {
        const errorMsg = entryResult?.error || 'Erro desconhecido na execução';
        console.error(`[SIGNAL] Erro na execução do sinal ${id}: ${errorMsg}`);
        
        // Enviar notificação de erro
        if (chat_id) {
          const errorMessage = formatErrorMessage(signal, errorMsg);
          await sendTelegramMessage(accountId, chat_id, errorMessage);
        }
      }
    } catch (error) {
      console.error(`[SIGNAL] Erro ao processar sinal ID ${signal.id}:`, error);
      
      if (connection) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error(`[SIGNAL] Erro no rollback:`, rollbackError);
        }
      }
      
      // Atualizar status para ERROR
      try {
        await db.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [String(error.message).substring(0, 250), signal.id]
        );
      } catch (updateError) {
        console.error(`[SIGNAL] Erro ao atualizar status para ERROR:`, updateError);
      }
      
      // Enviar notificação de erro
      if (signal.chat_id) {
        const errorMessage = formatErrorMessage(signal, error.message);
        await sendTelegramMessage(accountId, signal.chat_id, errorMessage);
      }
      
      throw error;
    } finally {
      if (connection) {
        connection.release();
      }
    }
  } finally {
    processingSignals.delete(signal.id);
  }
}

/**
 * Verifica e processa sinais pendentes
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function checkNewTrades(accountId) {
  try {
    // CORREÇÃO CRÍTICA: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em checkNewTrades: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    const { getDatabaseInstance } = require('../db/conexao');
    const db = await getDatabaseInstance(accountId);
    
    if (!db) {
      console.error(`[CHECK_TRADES] Erro ao conectar ao banco para conta ${accountId}`);
      return;
    }

    // Buscar sinais pendentes para esta conta específica
    const [signals] = await db.query(`
      SELECT 
        id, symbol, side, leverage, entry_price, sl_price, tp_price,
        capital_pct, timeframe, created_at, timeout_at, max_lifetime_minutes,
        conta_id, chat_id
      FROM webhook_signals 
      WHERE status = 'PENDING' 
        AND conta_id = ?
      ORDER BY created_at ASC
      LIMIT 10
    `, [accountId]);

    if (!signals || signals.length === 0) {
      //console.log(`[CHECK_TRADES] Nenhum sinal pendente encontrado para conta ${accountId}`);
      return;
    }

    console.log(`[CHECK_TRADES] Processando ${signals.length} sinais pendentes para conta ${accountId}...`);

    for (const signal of signals) {
      try {
        // CORREÇÃO: Verificar se o sinal pertence à conta correta
        if (signal.conta_id !== accountId) {
          console.warn(`[CHECK_TRADES] Sinal ${signal.id} pertence à conta ${signal.conta_id}, pulando...`);
          continue;
        }
        
        // Verificar timeout do sinal
        if (signal.timeout_at && new Date() > new Date(signal.timeout_at)) {
          console.log(`[CHECK_TRADES] Sinal ${signal.id} expirado, marcando como ERROR`);
          
          await db.query(`
            UPDATE webhook_signals 
            SET status = 'ERROR', error_message = 'Sinal expirado' 
            WHERE id = ?
          `, [signal.id]);
          
          continue;
        }

        // Obter preço atual via WebSocket ou API
        const websockets = require('../websockets');
        let currentPrice;
        
        try {
          // CORREÇÃO: Usar função adequada para obter preço
          const { getPrice } = require('../api');
          currentPrice = await getPrice(signal.symbol, accountId);
          
          if (!currentPrice) {
            console.log(`[CHECK_TRADES] Preço não disponível para ${signal.symbol}, pulando...`);
            continue;
          }
        } catch (priceError) {
          console.warn(`[CHECK_TRADES] Erro ao obter preço para ${signal.symbol}:`, priceError.message);
          continue;
        }

        if (!currentPrice || currentPrice <= 0) {
          console.warn(`[CHECK_TRADES] Preço inválido para ${signal.symbol}: ${currentPrice}`);
          continue;
        }

        // CORREÇÃO CRÍTICA: Passar accountId explicitamente
        const result = await processSignal(db, signal, currentPrice, accountId);
        
        if (result && !result.success) {
          console.warn(`[CHECK_TRADES] Falha ao processar sinal ${signal.id}: ${result.error}`);
          
          // Marcar como erro no banco
          await db.query(`
            UPDATE webhook_signals 
            SET status = 'ERROR', error_message = ? 
            WHERE id = ?
          `, [result.error, signal.id]);
        }

      } catch (signalError) {
        console.error(`[CHECK_TRADES] Erro ao processar sinal ${signal.id}:`, signalError.message);
        
        // Marcar como erro no banco
        try {
          await db.query(`
            UPDATE webhook_signals 
            SET status = 'ERROR', error_message = ? 
            WHERE id = ?
          `, [signalError.message, signal.id]);
        } catch (updateError) {
          console.error(`[CHECK_TRADES] Erro ao atualizar status do sinal ${signal.id}:`, updateError.message);
        }
      }
    }

  } catch (error) {
    console.error(`[CHECK_TRADES] Erro geral ao verificar sinais para conta ${accountId}:`, error.message);
    console.error('[CHECK_TRADES] Stack trace:', error.stack);
    
    // CORREÇÃO: Não relançar erro para evitar shutdown
    return;
  }
}

/**
 * Força o processamento de sinais pendentes
 * @param {number} accountId - ID da conta
 */
async function forceProcessPendingSignals(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[FORCE_PROCESS] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Verificar qual coluna de atualização existe
    const [tableInfo] = await db.query(`
      SHOW COLUMNS FROM webhook_signals LIKE '%update%'
    `);
    
    let updateColumn = 'last_update'; // padrão
    if (tableInfo.length > 0) {
      updateColumn = tableInfo[0].Field;
    }

    // Resetar sinais travados há mais de 5 minutos
    await db.query(`
      UPDATE webhook_signals 
      SET status = 'PENDING' 
      WHERE status = 'PROCESSANDO' 
      AND TIMESTAMPDIFF(MINUTE, ${updateColumn}, NOW()) > 5
      AND (conta_id = ? OR conta_id IS NULL)
    `, [accountId]);

    console.log(`[FORCE_PROCESS] Sinais travados resetados para conta ${accountId}`);
    await checkNewTrades(accountId);
  } catch (error) {
    console.error(`[FORCE_PROCESS] Erro para conta ${accountId}:`, error);
  }
}

/**
 * Processa trigger de sinal (chamado pelo monitoramento de preços)
 * @param {Object} signal - Dados do sinal
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado do processamento
 */
async function processSignalTrigger(signal, accountId) {
  try {
    // CORREÇÃO: Validar accountId corretamente
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em processSignalTrigger: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    console.log(`[SIGNAL_TRIGGER] Processando trigger para sinal ${signal.id} na conta ${accountId}`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    // CORREÇÃO CRÍTICA: Obter preço atual via API diretamente
    // Não usar cache pois pode não estar disponível
    let currentPrice;
    
    try {
      const { getPrice } = require('../api');
      currentPrice = await getPrice(signal.symbol, accountId);
    } catch (priceError) {
      console.error(`[SIGNAL_TRIGGER] Erro ao obter preço via API para ${signal.symbol}:`, priceError.message);
      throw new Error(`Falha ao obter preço para ${signal.symbol}: ${priceError.message}`);
    }
    
    if (!currentPrice || currentPrice <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPrice}`);
    }
    
    console.log(`[SIGNAL_TRIGGER] Preço atual obtido para ${signal.symbol}: ${currentPrice}`);
    
    // Processar sinal
    return await processSignal(db, signal, currentPrice, accountId);
    
  } catch (error) {
    console.error(`[SIGNAL_TRIGGER] Erro ao processar trigger para sinal ${signal.id}:`, error.message);
    return { success: false, error: error.message };
  }
}

// CORREÇÃO CRÍTICA: Exportar apenas funções que existem
module.exports = {
  processSignal,
  checkNewTrades,
  forceProcessPendingSignals,
  processSignalTrigger
};