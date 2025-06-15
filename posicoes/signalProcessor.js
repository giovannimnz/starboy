const { getDatabaseInstance, formatDateForMySQL } = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
const { sendTelegramMessage, formatEntryMessage, formatErrorMessage } = require('./telegramBot');

// Conjunto para controlar sinais em processamento
const processingSignals = new Set();

/**
 * Verifica se um sinal deve ser acionado baseado no preço atual
 * @param {Object} signal - Dados do sinal
 * @param {number} currentPrice - Preço atual
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function processSignalTrigger(signal, currentPrice, db, accountId = 1) {
  const entryPrice = parseFloat(signal.entry_price);
  const side = signal.side.toUpperCase();
  
  let shouldTrigger = false;
  
  // Verificar condições de acionamento baseado no lado
  if (side === 'BUY' || side === 'COMPRA') {
    // Para compra, acionar quando preço atual <= preço de entrada
    shouldTrigger = currentPrice <= entryPrice;
  } else if (side === 'SELL' || side === 'VENDA') {
    // Para venda, acionar quando preço atual >= preço de entrada
    shouldTrigger = currentPrice >= entryPrice;
  }
  
  console.log(`[PRICE_CHECK] Sinal ID ${signal.id}: ${signal.symbol} ${side} @ ${entryPrice} - Atual: ${currentPrice} - Acionar: ${shouldTrigger ? 'SIM' : 'NÃO'}`);
  
  if (shouldTrigger) {
    await processSignal(db, signal, currentPrice, accountId);
  }
}

/**
 * Processa um sinal de entrada
 * @param {Object} db - Conexão com banco
 * @param {Object} signal - Dados do sinal
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function processSignal(db, signal, currentPrice, accountId = 1) {
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
 * Verifica sinais pendentes e os processa
 * @param {number} accountId - ID da conta
 */
async function checkNewTrades(accountId = 1) {
  try {
    const startTime = Date.now();
    //console.log(`[SIGNAL] Verificando sinais pendentes para conta ${accountId} às ${new Date().toLocaleString()}`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[SIGNAL] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Verificar sinais PENDING na tabela webhook_signals
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING' AND (conta_id = ? OR conta_id IS NULL)
      ORDER BY created_at ASC
    `, [accountId]);

    if (pendingSignals.length === 0) {
      //console.log(`[SIGNAL] Nenhum sinal pendente encontrado para conta ${accountId}`);
      return;
    }

    console.log(`[SIGNAL] Encontrados ${pendingSignals.length} sinais pendentes para processar (Conta ${accountId})`);

    // Processar cada sinal pendente
    for (const signal of pendingSignals) {
      try {
        // Obter preço atual
        const { getWebSocketPrice } = require('./priceMonitoring');
        const currentPrice = await getWebSocketPrice(signal.symbol, accountId);
        
        if (currentPrice) {
          await processSignal(db, signal, currentPrice, accountId);
        } else {
          console.warn(`[SIGNAL] Não foi possível obter preço para ${signal.symbol}`);
        }
      } catch (signalError) {
        console.error(`[SIGNAL] Erro ao processar sinal ${signal.id}:`, signalError);
      }
    }
    
    const endTime = Date.now();
    console.log(`[SIGNAL] Verificação de sinais concluída em ${(endTime - startTime)/1000} segundos`);
  } catch (error) {
    console.error(`[SIGNAL] Erro ao verificar sinais pendentes:`, error);
  }
}

/**
 * Força processamento de sinais pendentes
 * @param {number} accountId - ID da conta
 */
async function forceProcessPendingSignals(accountId = 1) {
  console.log(`[SIGNAL] Forçando processamento de sinais pendentes para conta ${accountId}...`);
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[SIGNAL] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Selecionar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING' AND (conta_id = ? OR conta_id IS NULL)
      ORDER BY created_at ASC
    `, [accountId]);

    console.log(`[SIGNAL] Encontrados ${pendingSignals.length} sinais pendentes para processamento forçado`);

    if (pendingSignals.length === 0) {
      console.log(`[SIGNAL] Não há sinais pendentes para processar para conta ${accountId}`);
      return;
    }

    // Processar cada sinal pendente
    for (const signal of pendingSignals) {
      try {
        // Obter preço atual via API se necessário
        const { getCurrentPrice } = require('./priceMonitoring');
        const currentPrice = await getCurrentPrice(signal.symbol, accountId);
        
        if (currentPrice) {
          await processSignal(db, signal, currentPrice, accountId);
        } else {
          console.warn(`[SIGNAL] Não foi possível obter preço para ${signal.symbol}`);
        }
      } catch (signalError) {
        console.error(`[SIGNAL] Erro ao processar sinal ${signal.id}:`, signalError);
      }
    }
  } catch (error) {
    console.error(`[SIGNAL] Erro ao forçar processamento de sinais:`, error);
    throw error;
  }
}

module.exports = {
  processSignalTrigger,
  processSignal,
  checkNewTrades,
  forceProcessPendingSignals
};