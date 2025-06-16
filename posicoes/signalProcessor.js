// Movidos para o topo do arquivo
const api = require('../api');
const websockets = require('../websockets');
const { getDatabaseInstance } = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
//const { sendMessage } = require('./telegramBot');
//const { getConfig } = require('../utils/configManager'); // Descomente se getConfig for usado neste arquivo

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
 * Verifica e processa sinais pendentes
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function checkNewTrades(accountId) {
  try {
    // Validação mais estrita do accountId no início
    if (typeof accountId !== 'number' || isNaN(accountId)) {
      const errorMsg = `AccountId inválido em checkNewTrades: ${accountId} (tipo: ${typeof accountId})`;
      console.error(`[CHECK_TRADES] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[CHECK_TRADES] Erro ao conectar ao banco para conta ${accountId}`);
      return;
    }

    // CORREÇÃO: Modificar a query para buscar ambiente e corretora da tabela 'corretoras'
    const [signals] = await db.query(
      `SELECT s.id, s.symbol, s.side, s.leverage, s.entry_price, s.sl_price, s.tp_price,
              s.capital_pct, s.timeframe, s.created_at, s.timeout_at, s.max_lifetime_minutes,
              s.status, s.error_message, s.conta_id, s.chat_id,
              c.saldo_base_calculo, 
              co.ambiente AS conta_ambiente,       -- Selecionado da tabela corretoras (alias co)
              co.corretora AS conta_corretora_nome -- Selecionado da tabela corretoras (alias co)
       FROM webhook_signals s
       JOIN contas c ON s.conta_id = c.id
       JOIN corretoras co ON c.corretora_id = co.id -- JOIN com a tabela corretoras
       WHERE s.status = 'PENDING' AND s.conta_id = ?
       ORDER BY s.created_at ASC`,
      [accountId]
    );

    if (signals.length > 0) {
      console.log(`[CHECK_TRADES] Processando ${signals.length} sinais pendentes para conta ${accountId}...`);
    }

    for (const signal of signals) {
      // Checagem extra para garantir que o sinal pertence à conta correta
      if (signal.conta_id !== accountId) {
        console.warn(`[CHECK_TRADES] Sinal ${signal.id} (conta ${signal.conta_id}) não pertence à conta monitorada ${accountId}. Pulando.`);
        continue;
      }

      // Verificar timeout do sinal
      if (signal.timeout_at && new Date() > new Date(signal.timeout_at)) {
        console.log(`[CHECK_TRADES] Sinal ${signal.id} para ${signal.symbol} (conta ${accountId}) expirado (timeout_at), marcando como ERROR`);
        await db.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Sinal expirado (timeout_at)' WHERE id = ?`,
          [signal.id]
        );
        continue;
      }
      
      // Verificar max_lifetime_minutes
      if (signal.max_lifetime_minutes) {
        const createdAt = new Date(signal.created_at);
        const lifetimeMillis = signal.max_lifetime_minutes * 60 * 1000;
        if (Date.now() > createdAt.getTime() + lifetimeMillis) {
          console.log(`[CHECK_TRADES] Sinal ${signal.id} para ${signal.symbol} (conta ${accountId}) excedeu max_lifetime_minutes, marcando como ERROR`);
          await db.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Sinal expirado (max_lifetime_minutes)' WHERE id = ?`,
            [signal.id]
          );
          continue;
        }
      }

      let currentPrice;
      try {
        // Usar a instância 'api' importada no topo
        currentPrice = await api.getPrice(signal.symbol, accountId);
        
        if (currentPrice === null || currentPrice === undefined || currentPrice <= 0) {
          console.log(`[CHECK_TRADES] Preço inválido ou não disponível para ${signal.symbol} (conta ${accountId}): ${currentPrice}, pulando...`);
          continue;
        }
      } catch (priceError) {
        // O erro já é logado dentro de api.getPrice, aqui apenas registramos o contexto
        console.warn(`[CHECK_TRADES] Falha ao obter preço para ${signal.symbol} (conta ${accountId}) durante processamento do sinal ${signal.id}. Erro: ${priceError.message}`);
        // Considerar se deve atualizar o sinal para ERROR ou tentar novamente depois
        continue; 
      }
      
      // console.log(`[CHECK_TRADES] Preço obtido para ${signal.symbol} (conta ${accountId}): ${currentPrice}`);
      // Passar accountId explicitamente para processSignal
      await processSignal(db, signal, currentPrice, accountId);
    }
  } catch (error) {
    console.error(`[CHECK_TRADES] Erro GERAL ao verificar novos trades para conta ${accountId} (tipo: ${typeof accountId}):`, error.message, error.stack ? error.stack.substring(0, 300) : '');
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
  processSignalTrigger
};