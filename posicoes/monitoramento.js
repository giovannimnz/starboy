const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newEntryOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode, getOpenOrders, getOrderStatus, getAllOpenPositions, updateLeverageBracketsInDatabase, cancelPendingEntry } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, formatDateForMySQL, getBaseCalculoBalance, updateAccountBalance} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();
const processingSignals = new Set();
const websocketEmptyCheckCounter = {};

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Adicionar variável para armazenar os jobs
let scheduledJobs = {};

// Atualizar dados de alavancagem ao iniciar o sistema
(async () => {
  try {
    await updateLeverageBracketsInDatabase();
    //console.log('Dados de alavancagem atualizados com sucesso.');
  } catch (error) {
    console.error('Erro ao atualizar dados de alavancagem:', error);
  }
})();

// Função para inicializar o monitoramento
async function initializeMonitoring() {
  //console.log('[MONITOR] Inicializando sistema de monitoramento...');

  // Sincronizar saldo da conta - ADICIONADO
  try {
    //console.log('[MONITOR] Sincronizando saldo da conta com a corretora...');
    const result = await syncAccountBalance();
    if (result) {
      console.log(`\n[MONITOR] Saldo: ${result.saldo.toFixed(2)} USDT | Saldo Base Calculo: ${result.saldo_base_calculo.toFixed(2)} USDT\n`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao sincronizar saldo da conta:', error);
  }

  // Configurar callbacks para WebSockets
  websockets.setMonitoringCallbacks({
    handleOrderUpdate,
    handleAccountUpdate,
    onPriceUpdate,
    getDbConnection: getDatabaseInstance
  });

  // Iniciar WebSocket para dados do usuário
  await websockets.startUserDataStream(getDatabaseInstance);

  // Sincronizar saldo da conta logo após conexão
  try {
    //console.log('[MONITOR] Sincronizando saldo inicial...');
    const result = await syncAccountBalance();
    if (result) {
      //console.log(`\n[MONITOR] Saldo inicial: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT\n`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao sincronizar saldo inicial:', error);
  }

  // Agendar verificação periódica de novas operações
  scheduledJobs.checkNewTrades = schedule.scheduleJob('*/10 * * * * *', async () => {
    try {
      await checkNewTrades();
    } catch (error) {
      console.error('[MONITOR] Erro ao verificar novas operações:', error);
    }
  });

  // Adicionar job de sincronização a cada 1 minuto
  // scheduledJobs.syncWithExchange = schedule.scheduleJob('*/1 * * * *', async () => {
  //   try {
  //     await syncWithExchange();
  //   } catch (error) {
  //     console.error('[MONITOR] Erro na sincronização periódica:', error);
  //   }
  // });

  // NOVO JOB: Atualização diária dos dados de alavancagem às 2:00 da manhã
  scheduledJobs.updateLeverageBrackets = schedule.scheduleJob('0 2 * * *', async () => {
    try {
      console.log('[MONITOR] Iniciando atualização diária dos dados de alavancagem...');
      const recordsUpdated = await updateLeverageBracketsInDatabase(true); // true = forçar atualização
      console.log(`[MONITOR] Atualização diária concluída. ${recordsUpdated} registros de alavancagem atualizados.`);
    } catch (error) {
      console.error('[MONITOR] Erro na atualização diária de dados de alavancagem:', error);
    }
  });

  // Adicionar job para verificar ordens expiradas a cada 5 minutos
  scheduledJobs.checkExpiredOrders = schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      await checkExpiredOrders();
    } catch (error) {
      console.error('[MONITOR] Erro ao verificar ordens expiradas:', error);
    }
  });

  // Sincronizar saldo a cada hora
  scheduledJobs.syncAccountBalance = schedule.scheduleJob('0 * * * *', async () => {
    try {
      //console.log('[MONITOR] Sincronizando saldo (job periódico)...');
      await syncAccountBalance();
    } catch (error) {
      console.error('[MONITOR] Erro na sincronização periódica de saldo:', error);
    }
  });

  scheduledJobs.syncPositionsWithExchange = schedule.scheduleJob('*/30 * * * * *', async () => {
    try {
      //console.log('[MONITOR] Sincronizando posições com a corretora (job periódico)...'); // Adicionado log para identificar a chamada do job
      await syncPositionsWithExchange();
    } catch (error) {
      // O erro já é logado dentro de syncPositionsWithExchange ou no catch mais específico dele
      // Mas podemos adicionar um log genérico aqui se desejado, ou apenas deixar que a função interna lide com o log.
      console.error('[MONITOR] Erro geral no job de sincronizar posições:', error);
    }
  });
  // ***** FIM DA IMPLEMENTAÇÃO SOLICITADA *****

  // Iniciar monitoramento de preços para posições abertas
  try {
    await startPriceMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
  }

  //console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
}

// ***** INÍCIO DA IMPLEMENTAÇÃO SOLICITADA *****
// Nova função para sincronizar posições:
async function syncPositionsWithExchange() {
  try {
    const db = await getDatabaseInstance(); // Presume que getDatabaseInstance() está definida
    if (!db) {
        console.error('[SYNC] Não foi possível obter instância do banco de dados.');
        return;
    }

    // 1. Obter posições abertas do banco
    // Adicionado um log para a query, caso seja útil para debug
    // console.log('[SYNC] Buscando posições abertas no banco de dados...');
    const [dbPositions] = await db.query(`SELECT id, simbolo, quantidade FROM posicoes WHERE status = 'OPEN'`);

    // 2. Obter posições da corretora
    // console.log('[SYNC] Buscando posições abertas na corretora...');
    const exchangePositions = await getAllOpenPositions(); // Presume que getAllOpenPositions() está definida

    //console.log(`[SYNC] Verificando ${dbPositions.length} posições abertas no banco vs ${exchangePositions.length} na corretora...`);

    // 3. Mapear posições da corretora por símbolo
    const exchangePositionsMap = {};
    exchangePositions.forEach(pos => {
      exchangePositionsMap[pos.simbolo] = pos;
    });

    // 4. Verificar posições que existem no banco mas não na corretora (fechadas)
    for (const dbPos of dbPositions) {
      if (!exchangePositionsMap[dbPos.simbolo]) {
        console.log(`[SYNC] Posição ${dbPos.simbolo} [DB ID: ${dbPos.id}] não encontrada na corretora. Fazendo verificação adicional...`);
        
        // ADICIONAR AQUI: Verificação adicional para confirmar que a posição realmente não existe
        try {
          // Fazer uma chamada direta à API para verificar esta posição específica
          const positionDetails = await getPositionDetails(dbPos.simbolo);
          const hasOpenPosition = positionDetails && positionDetails.some(pos => 
              parseFloat(pos.quantidade) > 0);
              
          if (hasOpenPosition) {
            console.log(`[SYNC] Segunda verificação confirmou que ${dbPos.simbolo} ainda está aberta. Mantendo registro.`);
            continue; // Pular para o próximo item do loop
          }
          
          // Se chegou aqui, a posição realmente não existe
          console.log(`[SYNC] Segunda verificação confirmou que ${dbPos.simbolo} está fechada. Movendo para histórico.`);
        } catch (detailsError) {
          console.error(`[SYNC] Erro ao verificar detalhes da posição ${dbPos.simbolo}:`, detailsError);
          // Se ocorreu erro na verificação adicional, não fechar a posição para ser seguro
          console.log(`[SYNC] Devido ao erro na verificação, mantendo posição ${dbPos.simbolo} no banco.`);
          continue;
        }
        
        await movePositionToHistory(db, dbPos.id, 'CLOSED', 'Fechada na corretora (detectado por sincronização)');
        console.log(`[SYNC] Posição ${dbPos.simbolo} [DB ID: ${dbPos.id}] movida para o histórico.`);
        
        // Verificar e fechar websocket
        setTimeout(async () => {
          try {
            await checkAndCloseWebsocket(db, dbPos.simbolo);
          } catch (wsError) {
            console.error(`[SYNC] Erro ao tentar fechar websocket para ${dbPos.simbolo}:`, wsError);
          }
        }, 5000);
      }
    }
  } catch (error) {
    console.error(`[SYNC] Erro crítico ao sincronizar posições com a corretora: ${error.message}`, error.stack || error);
  }
}

// Função para iniciar monitoramento de preços para posições abertas
async function startPriceMonitoring() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Obter posições abertas ou com ordens de entrada pendentes
    const [pendingEntries] = await db.query(`
      SELECT o.simbolo
      FROM ordens o
      WHERE o.tipo_ordem_bot = 'ENTRADA' AND o.status = 'OPEN'
      GROUP BY o.simbolo
    `);

    const [openPositions] = await db.query(`
      SELECT simbolo
      FROM posicoes
      WHERE status = 'OPEN'
    `);

    // NOVO: Obter sinais em AGUARDANDO_ACIONAMENTO
    const [pendingSignals] = await db.query(`
      SELECT symbol, timeframe, created_at, timeout_at, max_lifetime_minutes
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO'
    `);

    //console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para monitoramento`);

    const symbols = new Set();

    // Adicionar símbolos com ordens pendentes
    pendingEntries.forEach(entry => symbols.add(entry.simbolo));

    // Adicionar símbolos com posições abertas
    openPositions.forEach(position => symbols.add(position.simbolo));

    // NOVO: Adicionar símbolos com sinais pendentes
    pendingSignals.forEach(signal => symbols.add(signal.symbol));

    // Iniciar websockets para cada símbolo
    for (const symbol of symbols) {
      console.log(`[MONITOR] Iniciando monitoramento de preço para ${symbol}`);
      websockets.ensurePriceWebsocketExists(symbol);
    }

    // NOVO: Verificar sinais expirados durante o período offline
    if (pendingSignals.length > 0) {
      console.log(`[MONITOR] Verificando se há sinais expirados durante período offline...`);
      const now = new Date();
      
      for (const signal of pendingSignals) {
        // Verificar timeout usando campo timeout_at direto
        if (signal.timeout_at && new Date(signal.timeout_at) < now) {
          console.log(`[MONITOR] Sinal expirado para ${signal.symbol} (timeframe: ${signal.timeframe})`);
          await db.query(`
            UPDATE webhook_signals 
            SET status = 'CANCELED', 
                error_message = ? 
            WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'`,
            [`Sinal expirado durante período offline (timeout: ${signal.max_lifetime_minutes} min)`, signal.symbol]
          );
        } else {
          // Obter preço atual para verificar se o SL foi atingido durante o período offline
          try {
            const price = await getCurrentPrice(signal.symbol);
            if (price) {
              // Acionar callback onPriceUpdate para verificar condições
              await onPriceUpdate(signal.symbol, price, db);
            }
          } catch (priceError) {
            console.error(`[MONITOR] Erro ao obter preço atual para ${signal.symbol}:`, priceError);
          }
        }
      }
    }

  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
  }
}

// Função auxiliar para obter preço atual via API
async function getCurrentPrice(symbol) {
  try {
    const response = await axios.get(`${process.env.API_URL}/v1/ticker/price?symbol=${symbol}`);
    if (response.data && response.data.price) {
      return parseFloat(response.data.price);
    }
    return null;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter preço atual para ${symbol}:`, error);
    return null;
  }
}

// Função para verificar novas operações e criar ordens
async function checkNewTrades() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Verificar apenas sinais PENDING na tabela webhook_signals
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
    `);

    //console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para processar`);

    for (const signal of pendingSignals) {
      // Atualizar status para PROCESSANDO antes de processar para evitar duplicação
      await db.query(
          'UPDATE webhook_signals SET status = "PROCESSANDO" WHERE id = ?',
          [signal.id]
      );

      // Processar o sinal
      await processSignal(db, signal);
    }

  } catch (error) {
    console.error('[MONITOR] Erro ao verificar novas operações:', error);
  }
}

// Função para processar um sinal recebido via webhook
async function processSignal(db, signal) {
  const connection = await db.getConnection(); // Get a connection from the pool

  try {
    await connection.beginTransaction(); // Start a transaction

    const {
      id, symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, timeframe,
      message_id: originalMessageId // <<< Extract originalMessageId from signal
    } = signal;

    console.log(`[MONITOR] Processando sinal ID ${id} para ${symbol}: ${side} a ${entry_price}`);

    const positionExists = await checkPositionExists(connection, symbol);
    if (positionExists) {
      console.log(`[MONITOR] Já existe uma posição aberta para ${symbol}. Ignorando sinal ID ${id}.`);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Posição já existe para o símbolo' WHERE id = ?`,
          [id]
      );
      await connection.commit();
      return;
    }

    // 2. Configurar alavancagem e tipo de margem
    try {
      await changeInitialLeverage(symbol, parseInt(leverage));
      try {
        await changeMarginType(symbol, 'CROSSED'); // Or 'ISOLATED' as per your strategy
      } catch (marginError) {
        if (marginError.response && marginError.response.data && marginError.response.data.code === -4046) { // -4046: "No need to change margin type"
          console.log(`[MONITOR] Margem para ${symbol} já está como CROSSED (ou o tipo desejado), continuando...`);
        } else {
          throw marginError; // Re-throw other margin errors
        }
      }
    } catch (configError) {
      console.error(`[MONITOR] Erro ao configurar alavancagem/margem para ${symbol} (Sinal ID ${id}):`, configError.message);
      let errorMessage = `Erro config.: ${configError.message}`;
      if (configError.response && configError.response.data && configError.response.data.msg) {
        errorMessage = `Erro config. API: ${configError.response.data.msg}`;
      }
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [errorMessage, id]
      );
      await connection.commit();
      return;
    }

    // 3. Atualizar webhook_signals para 'AGUARDANDO_ACIONAMENTO' (inicialmente)
    await connection.query(
        `UPDATE webhook_signals SET
            status = 'AGUARDANDO_ACIONAMENTO'
         WHERE id = ?`,
        [id]
    );

    // 4. Iniciar monitoramento de preço para este símbolo (se não estiver ativo)
    websockets.ensurePriceWebsocketExists(symbol);

    if (chat_id) {
      try {
        const triggerCondition = side.toUpperCase() === 'COMPRA' || side.toUpperCase() === 'BUY'
            ? `Acima de ${entry_price}`
            : `Abaixo de ${entry_price}`;

        // Opções de envio com reply_to_message_id se originalMessageId (vindo de signal.message_id) estiver disponível
        const telegramOptions = originalMessageId ? { reply_to_message_id: originalMessageId } : {};
        
        const sentMessage = await bot.telegram.sendMessage(chat_id,
            `🔄 Sinal Registrado para ${symbol}!\n\n` +
            `🆔 Sinal Ref: WEBHOOK_${id}\n` +
            `Direção: ${side}\n` +
            `Alavancagem: ${leverage}x\n\n` +
            `Entrada: ${triggerCondition.replace(entry_price, formatDecimal(entry_price))}\n` +
            `TP: ${formatDecimal(tp_price)}\n` +
            `SL: ${formatDecimal(sl_price)}\n\n` +
            `Aguardando gatilho de preço...`,
            telegramOptions
        );
        
        // Salvar o ID da mensagem de confirmação no banco de dados
        if (sentMessage && sentMessage.message_id) {
          await connection.query(
              `UPDATE webhook_signals SET registry_message_id = ? WHERE id = ?`,
              [sentMessage.message_id, id]
          );
          console.log(`[MONITOR] Mensagem de confirmação (${sentMessage.message_id}) enviada e ID salvo para sinal ${id}.`);
        }
      } catch (telegramError) {
        console.error(`[MONITOR] Erro ao enviar mensagem de confirmação Telegram para sinal ID ${id}:`, telegramError);
      }
    }

    // 6. Calcular e registrar o tempo de timeout e atualizar o sinal novamente
    let timeoutAt = null;
    let maxLifetimeMinutes = null;

    if (timeframe) {
        const timeframeMs = timeframeToMs(timeframe); // Garanta que timeframeToMs está definida
        if (timeframeMs > 0) {
            const maxLifetimeMs = timeframeMs * 3; // Exemplo: timeout é 3x o timeframe do sinal
            const now = new Date();
            timeoutAt = new Date(now.getTime() + maxLifetimeMs);
            maxLifetimeMinutes = Math.floor(maxLifetimeMs / (60 * 1000));
            
            console.log(`[MONITOR] Timeout para sinal ID ${id} (${symbol}) definido para: ${timeoutAt.toISOString()} (${maxLifetimeMinutes} min)`);
        } else {
            console.log(`[MONITOR] Timeframe inválido ou zero para sinal ID ${id} (${symbol}). Timeout não será definido.`);
        }
    } else {
        console.log(`[MONITOR] Timeframe não fornecido para sinal ID ${id} (${symbol}). Timeout não será definido.`);
    }

    await connection.query(
        `UPDATE webhook_signals SET
            status = 'AGUARDANDO_ACIONAMENTO', 
            timeout_at = ?,
            max_lifetime_minutes = ?
         WHERE id = ?`,
        [timeoutAt, maxLifetimeMinutes, id]
    );

    await connection.commit(); // Comita a transação
    console.log(`[MONITOR] Sinal ID ${id} para ${symbol} registrado com sucesso. Status: AGUARDANDO_ACIONAMENTO.`);

  } catch (error) {
    console.error(`[MONITOR] Erro crítico ao processar sinal ID ${signal.id || 'N/A'} para ${signal.symbol || 'N/A'}:`, error);
    if (connection) { // Garante que connection existe antes de tentar rollback
        try {
            await connection.rollback(); // Reverte a transação em caso de erro
            console.log(`[MONITOR] Rollback efetuado para sinal ID ${signal.id || 'N/A'}.`);
        } catch (rollbackError) {
            console.error(`[MONITOR] Erro crítico ao tentar fazer rollback para sinal ID ${signal.id || 'N/A'}:`, rollbackError);
        }
    }

  } finally {
    if (connection) { // Garante que connection existe antes de tentar release
        connection.release(); // Libera a conexão de volta para o pool
    }
  }
}

// Função para calcular tamanho da ordem baseado no capital disponível
function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, precision) {
  const capital = availableBalance * capitalPercentage;
  const size = (capital * leverage) / entryPrice;

  // Converter para string com a precisão correta
  const sizeString = size.toFixed(precision);

  // Remover zeros à direita desnecessários e converter de volta para número
  // Isso evita problemas com a precisão exata
  const formattedSize = parseFloat(sizeString);

  // Log adicional para depuração
  console.log(`[MONITOR] Tamanho calculado: ${size}, Precisão: ${precision}, Formatado: ${formattedSize}`);

  return formattedSize;
}

/**
 * Obtém o saldo disponível para cálculo de novas operações
 * Usa o saldo_base_calculo em vez do saldo real da corretora
 * @returns {Promise<number>} Saldo base para cálculos
 */
async function getAvailableBalance() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return 0;
    }

    // Obter saldo_base_calculo do banco de dados
    const baseCalculo = await getBaseCalculoBalance(db);

    if (baseCalculo <= 0) {
      console.log('[MONITOR] Saldo base de cálculo não encontrado, buscando saldo real...');
      await syncAccountBalance(); // Atualizar o saldo se o base de cálculo não existe
      return await getBaseCalculoBalance(db); // Tentar novamente após atualização
    }

    console.log(`[MONITOR] Usando saldo base de cálculo: ${baseCalculo.toFixed(2)} USDT`);
    return baseCalculo;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter saldo base de cálculo: ${error.message}`);
    return 0;
  }
}

// Verificar se existe uma posição aberta para um símbolo
async function checkPositionExists(db, symbol) {
  try {
    const [rows] = await db.query(
        "SELECT id FROM posicoes WHERE simbolo = ? AND (status = 'OPEN' OR status = 'PENDING')",
        [symbol]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

// Substitua a função handleOrderUpdate existente
async function handleOrderUpdate(orderMsg, db) {
  try {
    //console.log(`[ORDER UPDATE] Symbol: ${orderMsg.s}, OrderID: ${orderMsg.i}, Status: ${orderMsg.X}, ExecutionType: ${orderMsg.x}, Price: ${orderMsg.p}, AvgPrice: ${orderMsg.ap}, Qty: ${orderMsg.q}, OrderType: ${orderMsg.o}`);

    // Buscar a ordem no banco de dados
    const [orders] = await db.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ?',
      [orderMsg.i, orderMsg.s]
    );

    // --- INÍCIO DA MELHORIA/CORREÇÃO ---
    // Se a ordem não for encontrada no banco mas está na corretora como FILLED ou PARTIALLY_FILLED,
    // verificar se temos a posição relacionada e registrar esta ordem.
    if (orders.length === 0 && (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      //console.log(`[MONITOR] Detectada ordem executada (Status: ${orderMsg.X}) na corretora que não existe no banco. OrderID: ${orderMsg.i}, Symbol: ${orderMsg.s}`);
      
      // Verificar se temos uma posição aberta para este símbolo
      // Idealmente, se for uma ordem de fechamento (TP/SL), ela deveria ter uma posição.
      // Se for uma ordem de entrada "fantasma", não haveria posição aberta antes dela.
      // A query busca uma posição que JÁ ESTARIA ABERTA se esta ordem fosse um TP/SL dela.
      const [positions] = await db.query(
        'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN" LIMIT 1', // Busca uma posição aberta para o símbolo
        [orderMsg.s]
      );
      
      if (positions.length > 0) {
        const position = positions[0];
        //console.log(`[MONITOR] Encontrada posição aberta (ID: ${position.id}) para ${orderMsg.s}. Registrando ordem executada ${orderMsg.i}.`);
        
        // Determinar o tipo de ordem do bot
        const tipoOrdemBot = determineOrderType(orderMsg);

        // Registrar a ordem com base nos dados recebidos via WebSocket
        const orderData = {
          tipo_ordem: orderMsg.o,        // Tipo de ordem da Binance (ex: MARKET, LIMIT, STOP_MARKET)
          preco: parseFloat(orderMsg.ap || orderMsg.p || 0), // Preço médio de execução ou preço da ordem
          quantidade: parseFloat(orderMsg.q), // Quantidade original da ordem
          id_posicao: position.id,      // ID da posição aberta encontrada
          status: orderMsg.X,           // Status da ordem (FILLED, PARTIALLY_FILLED)
          // Usar o tempo da transação (T) se disponível, senão o tempo da ordem (O), senão agora.
          data_hora_criacao: orderMsg.T ? formatDateForMySQL(new Date(orderMsg.T)) : (orderMsg.O ? formatDateForMySQL(new Date(orderMsg.O)) : formatDateForMySQL(new Date())),
          id_externo: String(orderMsg.i), // ID externo (orderId da Binance)
          side: orderMsg.S,             // Side (BUY/SELL)
          simbolo: orderMsg.s,          // Símbolo
          tipo_ordem_bot: tipoOrdemBot, // Tipo de ordem do bot (ENTRADA, STOP_LOSS, TAKE_PROFIT)
          target: null,                 // Target (se aplicável, geralmente para TPs múltiplos)
          // Tentar inferir reduce_only e close_position se possível a partir de orderMsg.R e orderMsg.pP
          reduce_only: orderMsg.R === true, // orderMsg.R é a flag reduceOnly
          close_position: orderMsg.pP === true, // orderMsg.pP é a flag closePosition (geralmente para ordens de TP/SL da UI da Binance)
          last_update: orderMsg.T ? formatDateForMySQL(new Date(orderMsg.T)) : formatDateForMySQL(new Date()), // Tempo da última atualização (tempo da transação)
          orign_sig: position.orign_sig || null, // Tentar herdar o orign_sig da posição, se existir
          // Campos adicionais da mensagem que podem ser úteis para auditoria:
          dados_originais_ws: JSON.stringify(orderMsg) // Salvar a mensagem original do WS
        };
        
        await insertNewOrder(db, orderData); // Sua função de inserir nova ordem
        //console.log(`[MONITOR] Ordem ${orderMsg.i} (Tipo Bot: ${tipoOrdemBot}) registrada no banco de dados para posição ${position.id}.`);
        
        // Se for uma ordem TP/SL FILLED, processar fechamento da posição
        if ((tipoOrdemBot === 'TAKE_PROFIT' || tipoOrdemBot === 'STOP_LOSS') && orderMsg.X === 'FILLED') {
          console.log(`[MONITOR] Ordem "fantasma" ${tipoOrdemBot} (ID: ${orderMsg.i}) executada, fechando posição ${position.id}`);
          // Antes de mover para o histórico, cancelar outras ordens abertas para esta posição
          const [otherLinkedOrders] = await db.query(
            'SELECT * FROM ordens WHERE id_posicao = ? AND status = "OPEN" AND id_externo != ?',
            [position.id, orderMsg.i]
          );
          for (const otherOrder of otherLinkedOrders) {
            try {
              console.log(`[MONITOR] Cancelando ordem linkada ${otherOrder.id_externo} para posição ${position.id}`);
              await cancelOrder(otherOrder.id_externo, otherOrder.simbolo); // Sua função de cancelar ordem
              await updateOrderStatus(db, otherOrder.id, "CANCELED"); // Atualiza status no seu DB
            } catch (cancelError) {
              console.error(`[MONITOR] Erro ao cancelar ordem linkada ${otherOrder.id_externo}: ${cancelError.message}`);
            }
          }
          // Mover posição para o histórico
          await movePositionToHistory(db, position.id, 'CLOSED', `Posição fechada via ${tipoOrdemBot} "fantasma" ID ${orderMsg.i}`);
          
          // Sincronizar saldo após fechamento
           try {
             await syncAccountBalance();
           } catch (syncError) {
             console.error('[MONITOR] Erro ao sincronizar saldo após fechamento de posição "fantasma":', syncError);
           }
        }
      } else {
        console.log(`[MONITOR] Nenhuma posição aberta encontrada para ${orderMsg.s}. Ordem "fantasma" ${orderMsg.i} não pôde ser associada e registrada.`);
      }
      
      return; // Finaliza o processamento aqui para ordens "fantasmas"
    }
    // --- FIM DA MELHORIA/CORREÇÃO ---

    // Código existente para ordens encontradas no banco
    if (orders.length === 0) {
      // Esta condição agora só será verdadeira se a ordem não foi encontrada E NÃO era FILLED/PARTIALLY_FILLED
      // ou se era FILLED/PARTIALLY_FILLED mas não tinha posição aberta correspondente.
      console.log(`[MONITOR] Ordem ${orderMsg.i} (Status: ${orderMsg.X}) não encontrada no banco de dados e não tratada como "fantasma" preenchida.`);
      return;
    }

    const order = orders[0];

    // Se for ordem de entrada e tiver status NEW (recém criada) ou FILLED/PARTIALLY_FILLED
    if (order.tipo_ordem_bot === 'ENTRADA' &&
        (orderMsg.X === 'NEW' || orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {

      // Verificar se já existem ordens TP/SL para esta posição
      const [existingOrders] = await db.query(
          'SELECT * FROM ordens WHERE id_posicao = ? AND tipo_ordem_bot IN ("STOP_LOSS", "TAKE_PROFIT") AND status = "OPEN"',
          [order.id_posicao]
      );

      if (existingOrders.length > 0) {
        console.log(`[MONITOR] Já existem ordens SL/TP para a posição ${order.id_posicao}, não criando novas`);

        if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
            // Apenas garantir que a ordem de entrada seja atualizada no DB se necessário
            if(order.status !== orderMsg.X) { // Se o status mudou
                await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                               [orderMsg.X, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
                console.log(`[MONITOR] Status da ordem de ENTRADA ${order.id_externo} atualizado para ${orderMsg.X}`);
            }
            // Garantir que o status da posição seja OPEN
            await updatePositionStatus(db, order.simbolo, { status: 'OPEN', id: order.id_posicao }); // Passar ID da posição
            console.log(`[MONITOR] Posição ${order.id_posicao} atualizada para OPEN após preenchimento da ordem de entrada ${order.id_externo}`);
        }
        return;
      }

      console.log(`[MONITOR] Criando ordens SL/TP para posição ${order.id_posicao} após ordem de entrada ${orderMsg.X}`);

      const [positionsDb] = await db.query('SELECT * FROM posicoes WHERE id = ?', [order.id_posicao]);
      if (positionsDb.length === 0) {
        console.log(`[MONITOR] Posição ${order.id_posicao} não encontrada para criar SL/TP`);
        return;
      }
      const currentPosition = positionsDb[0];

      if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
        // Atualizar a ordem de entrada no DB com preço de execução e novo status
        await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                       [orderMsg.X, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
        console.log(`[MONITOR] Status da ordem de ENTRADA ${order.id_externo} atualizado para ${orderMsg.X} com preço ${orderMsg.ap || order.preco}`);
        // Atualizar status da posição para OPEN
        await updatePositionStatus(db, currentPosition.simbolo, { status: 'OPEN', id: currentPosition.id });
      }

      let tpPrice, slPrice;
      const [signals] = await db.query(
          'SELECT * FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1',
          [order.id_posicao]
      );

      // Usar o preço de entrada da posição, que deve ter sido atualizado se a ordem de entrada foi FILLED.
      // Se a ordem de entrada ainda não foi FILLED (ex: status NEW), usamos o preço da ordem.
      const entryPrice = parseFloat(currentPosition.preco_entrada || order.preco);
      if (!entryPrice) {
          console.error(`[MONITOR] Preço de entrada inválido para posição ${currentPosition.id}. Não é possível criar TP/SL.`);
          return;
      }

      if (signals.length > 0 && signals[0].tp_price && signals[0].sl_price) {
        tpPrice = parseFloat(signals[0].tp_price);
        slPrice = parseFloat(signals[0].sl_price);
        console.log(`[MONITOR] Usando preços TP/SL do sinal para pos ${currentPosition.id}: TP=${tpPrice}, SL=${slPrice}`);
      } else {
        const factor = 0.01; // 1%
        if (currentPosition.side === 'BUY') {
          tpPrice = entryPrice * (1 + factor);
          slPrice = entryPrice * (1 - factor);
        } else { // SELL
          tpPrice = entryPrice * (1 - factor);
          slPrice = entryPrice * (1 + factor);
        }
        console.log(`[MONITOR] Calculando preços TP/SL padrão para pos ${currentPosition.id}: TP=${tpPrice}, SL=${slPrice} (Entrada: ${entryPrice})`);
      }
      
      // Arredondar preços para a precisão correta do símbolo (implementar getSymbolPrecision se necessário)
      // tpPrice = parseFloat(tpPrice.toFixed(getSymbolPrecision(currentPosition.simbolo, 'price')));
      // slPrice = parseFloat(slPrice.toFixed(getSymbolPrecision(currentPosition.simbolo, 'price')));

      const oppositeSide = currentPosition.side === 'BUY' ? 'SELL' : 'BUY';
      const quantityToClose = parseFloat(currentPosition.quantidade_aberta || currentPosition.quantidade || order.quantidade);

      if (!quantityToClose || quantityToClose <= 0) {
          console.error(`[MONITOR] Quantidade inválida para fechar posição ${currentPosition.id}. Não é possível criar TP/SL.`);
          return;
      }

      // Criar e enviar ordem de SL
      try {
        const slOrderParams = {
            symbol: currentPosition.simbolo,
            side: oppositeSide,
            type: 'STOP_MARKET', // Tipo de ordem para a corretora
            quantity: quantityToClose,
            stopPrice: slPrice, // Preço de disparo
            reduceOnly: true
        };
        // A função newStopOrder deve ser adaptada para aceitar um objeto de parâmetros
        // ou manter a assinatura original: newStopOrder(symbol, quantity, side, stopPrice, price, reduceOnly, closePosition)
        // Para STOP_MARKET, price é geralmente null.
        const slResponse = await newStopOrder(
            slOrderParams.symbol,
            slOrderParams.quantity,
            slOrderParams.side,
            slOrderParams.stopPrice,
            null,  // price (para STOP_MARKET, não LIMIT)
            true,  // reduceOnly
            false  // closePosition (reduceOnly=true já garante que só reduzirá)
        );
        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada na corretora para pos ${currentPosition.id}: ${slResponse.data.orderId}`);
        await insertNewOrder(db, {
          tipo_ordem: 'STOP_MARKET', preco: slPrice, quantidade: quantityToClose,
          id_posicao: currentPosition.id, status: 'NEW', // Status inicial é NEW até ser aceita pela corretora
          data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(slResponse.data.orderId),
          side: oppositeSide, simbolo: currentPosition.simbolo, tipo_ordem_bot: 'STOP_LOSS',
          reduce_only: true, last_update: formatDateForMySQL(new Date()), orign_sig: currentPosition.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem SL para pos ${currentPosition.id}: ${error.message || error}`);
      }

      // Criar e enviar ordem de TP
      try {
        const tpOrderParams = {
            symbol: currentPosition.simbolo,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET', // Tipo de ordem para a corretora
            quantity: quantityToClose,
            stopPrice: tpPrice, // Preço de disparo
            reduceOnly: true
        };
        // Para TAKE_PROFIT_MARKET, price é geralmente null (ou igual a stopPrice, dependendo da API da corretora)
        const tpResponse = await newStopOrder(
            tpOrderParams.symbol,
            tpOrderParams.quantity,
            tpOrderParams.side,
            tpOrderParams.stopPrice, // stopPrice para TAKE_PROFIT_MARKET
            tpPrice, // price (algumas corretoras usam stopPrice como trigger e executam a mercado, outras podem precisar de price para TAKE_PROFIT_LIMIT)
                      // Para TAKE_PROFIT_MARKET, o 'price' pode não ser usado ou ser igual ao stopPrice. Verifique a API.
            true,  // reduceOnly
            false  // closePosition
        );
        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada na corretora para pos ${currentPosition.id}: ${tpResponse.data.orderId}`);
        await insertNewOrder(db, {
          tipo_ordem: 'TAKE_PROFIT_MARKET', preco: tpPrice, quantidade: quantityToClose,
          id_posicao: currentPosition.id, status: 'NEW',
          data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(tpResponse.data.orderId),
          side: oppositeSide, simbolo: currentPosition.simbolo, tipo_ordem_bot: 'TAKE_PROFIT',
          reduce_only: true, last_update: formatDateForMySQL(new Date()), orign_sig: currentPosition.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem TP para pos ${currentPosition.id}: ${error.message || error}`);
      }

    } else if ((order.tipo_ordem_bot === 'TAKE_PROFIT' || order.tipo_ordem_bot === 'STOP_LOSS') && 
               (orderMsg.X === 'FILLED' || (orderMsg.X === 'EXPIRED' && orderMsg.x === 'TRADE'))) { // Adicionado EXPIRED com execução TRADE
        
        const executionType = orderMsg.x; // NEW, CANCELED, REPLACED, REJECTED, TRADE, EXPIRED
        const orderStatus = orderMsg.X;   // NEW, PARTIALLY_FILLED, FILLED, CANCELED, PENDING_CANCEL, REJECTED, EXPIRED

        console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) para posição ${order.id_posicao} teve atualização: Status=${orderStatus}, ExecType=${executionType}`);

        // Se a ordem foi preenchida (FILLED ou EXPIRED mas com TRADE)
        if (orderStatus === 'FILLED' || (orderStatus === 'EXPIRED' && executionType === 'TRADE')) {
            console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) executada (Status: ${orderStatus}). Fechando posição ${order.id_posicao}.`);

            // Atualizar o status da ordem que foi FILLED/EXECUTED
            await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                           [orderStatus, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);

            // Cancelar outras ordens abertas (TP ou SL oposto) para esta posição
            const [otherOrders] = await db.query(
                'SELECT * FROM ordens WHERE id_posicao = ? AND id_externo != ? AND status = "NEW" OR status = "OPEN" OR status = "PARTIALLY_FILLED"', // Status mais abrangentes para cancelamento
                [order.id_posicao, order.id_externo] // Usar id_externo aqui para evitar cancelar a própria ordem se o ID interno for igual
            );

            for (const otherOrder of otherOrders) {
                try {
                    console.log(`[MONITOR] Cancelando ordem oposta ${otherOrder.id_externo} (Status: ${otherOrder.status}) para posição ${order.id_posicao}`);
                    await cancelOrder(otherOrder.id_externo, otherOrder.simbolo); // Função da API da corretora
                    // O status da ordem cancelada será atualizado via WebSocket pela própria corretora.
                    // Podemos forçar uma atualização local se necessário, mas o ideal é aguardar o evento.
                    // await updateOrderStatus(db, otherOrder.id, "CANCELED"); 
                } catch (error) {
                    console.error(`[MONITOR] Erro ao cancelar ordem oposta ${otherOrder.id_externo}: ${error.message}`);
                    // Mesmo com erro no cancelamento, continuar para fechar a posição
                }
            }

            // Mover posição e suas ordens para tabelas de histórico
            try {
                await moveClosedPositionsAndOrders(db, order.id_posicao); // Sua função original
                console.log(`[MONITOR] Posição ${order.id_posicao} e suas ordens foram movidas para o histórico.`);

                // Sincronizar saldo após fechamento de posição
                try {
                    await syncAccountBalance();
                } catch (syncError) {
                    console.error('[MONITOR] Erro ao sincronizar saldo após fechamento de posição:', syncError);
                }
            } catch (error) {
                console.error(`[MONITOR] Erro ao mover registros para histórico para pos ${order.id_posicao}: ${error.message}`);
            }
        } else if (orderStatus === 'CANCELED' || orderStatus === 'REJECTED' || (orderStatus === 'EXPIRED' && executionType !== 'TRADE')) {
            // Se a ordem TP/SL foi cancelada, rejeitada ou expirou sem trade, apenas atualiza o status no DB
            console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) para posição ${order.id_posicao} teve status ${orderStatus}. Atualizando no DB.`);
            await db.query('UPDATE ordens SET status = ?, last_update = ? WHERE id = ?', 
                           [orderStatus, formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
        }
    } else if (orderMsg.X === 'CANCELED' || orderMsg.X === 'REJECTED' || (orderMsg.X === 'EXPIRED' && orderMsg.x !== 'TRADE')) {
        // Lógica para ordens de ENTRADA que foram canceladas/rejeitadas/expiradas sem fill
        if (order.tipo_ordem_bot === 'ENTRADA' && order.status !== 'FILLED' && order.status !== 'PARTIALLY_FILLED') {
            console.log(`[MONITOR] Ordem de ENTRADA (ID_EXT: ${order.id_externo}) para símbolo ${order.simbolo} teve status ${orderMsg.X}. Atualizando no DB.`);
            await db.query('UPDATE ordens SET status = ?, last_update = ? WHERE id = ?', 
                           [orderMsg.X, formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
            // Se a ordem de entrada falhou, a posição associada (se existir e estiver PENDING) pode precisar ser atualizada ou removida.
            // Isso depende da sua lógica de criação de posições.
             const [posicoesPendentes] = await db.query('SELECT * FROM posicoes WHERE id = ? AND status = "PENDING"', [order.id_posicao]);
             if (posicoesPendentes.length > 0) {
                 await db.query('UPDATE posicoes SET status = "FAILED_ENTRY", observacao = ? WHERE id = ?',
                                [`Entrada falhou: Ordem ${order.id_externo} com status ${orderMsg.X}`, order.id_posicao]);
                 console.log(`[MONITOR] Posição ${order.id_posicao} marcada como FAILED_ENTRY.`);
             }
        }
    }

  } catch (error) {
    console.error(`[MONITOR] Erro ao processar atualização de ordem (OrderID: ${orderMsg.i}): ${error.message}`, error.stack);
  }
}

// Função corrigida para processar atualizações de conta via WebSocket
async function handleAccountUpdate(message, db) {
  try {
    console.log('[ACCOUNT UPDATE] Recebido atualização de conta');

    // Se não houver conexão com o banco, tentar estabelecer
    if (!db) {
      db = await getDatabaseInstance();
      if (!db) {
        console.error('[ACCOUNT UPDATE] Falha ao obter instância do banco de dados');
        return;
      }
    }

    // Verificar se há atualizações de posição no evento
    if (message.a && message.a.P) {
      const positions = message.a.P;
      console.log(`[ACCOUNT UPDATE] Recebido atualização para ${positions.length} posições`);

      for (const position of positions) {
        const symbol = position.s;
        const positionAmt = parseFloat(position.pa);
        const entryPrice = parseFloat(position.ep);
        const updateTime = new Date(); // Timestamp atual do servidor
        
        console.log(`[ACCOUNT UPDATE] Posição atualizada: ${symbol}, Quantidade: ${positionAmt}, Preço Entrada: ${entryPrice}`);

        // Buscar posição no banco de dados
        const [posRows] = await db.query(
          'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"',
          [symbol]
        );

        if (posRows.length > 0) {
          const posicaoDb = posRows[0];
          const positionId = posicaoDb.id;
          
          // CASO 1: Posição fechada (quantidade zerada)
          if (Math.abs(positionAmt) < 0.000001) { // Considera zero com margem para erro de precisão
            console.log(`[ACCOUNT UPDATE] Posição ${symbol} [ID: ${positionId}] detectada como FECHADA`);
            
            // Mover para histórico
            await movePositionToHistory(db, positionId, 'CLOSED', 'Fechada através da corretora');
            
            // Enviar notificação ao Telegram se necessário
            try {
              const [webhookInfo] = await db.query(`
                SELECT chat_id FROM webhook_signals 
                WHERE position_id = ? ORDER BY id DESC LIMIT 1
              `, [positionId]);
              
              if (webhookInfo.length > 0 && webhookInfo[0].chat_id && bot) {
                await bot.telegram.sendMessage(
                  webhookInfo[0].chat_id,
                  `⚠️ Posição ${symbol} fechada manualmente na corretora`
                );
              }
            } catch (notifyError) {
              console.error(`[ACCOUNT UPDATE] Erro ao notificar fechamento: ${notifyError.message}`);
            }
            
            // Verificar e fechar websocket se não houver mais atividade para este símbolo
            setTimeout(async () => {
              try {
                await checkAndCloseWebsocket(db, symbol);
              } catch (wsError) {
                console.error(`[ACCOUNT UPDATE] Erro ao fechar websocket: ${wsError.message}`);
              }
            }, 5000);
            
          } 
          // CASO 2: Posição ainda aberta (atualizar quantidade e preço)
          else if (Math.abs(positionAmt) !== Math.abs(parseFloat(posicaoDb.quantidade)) || 
                  Math.abs(entryPrice - parseFloat(posicaoDb.preco_entrada)) > 0.000001) {
            
            console.log(`[ACCOUNT UPDATE] Atualizando posição ${symbol} [ID: ${positionId}] - Nova quantidade: ${positionAmt}, Novo preço: ${entryPrice}`);
            
            await db.query(`
              UPDATE posicoes
              SET quantidade = ?,
                  preco_entrada = ?,
                  preco_corrente = ?,
                  data_hora_ultima_atualizacao = ?
              WHERE id = ? AND status = 'OPEN'
            `, [
              Math.abs(positionAmt),
              entryPrice,
              entryPrice,
              formatDateForMySQL(updateTime),
              positionId
            ]);
          }
        } else {
          // Posição não encontrada no banco - pode ser uma nova posição aberta manualmente
          console.log(`[ACCOUNT UPDATE] Posição ${symbol} com quantidade ${positionAmt} não encontrada no banco de dados`);
        }
      }
    } else {
      console.log('[ACCOUNT UPDATE] Sem atualizações de posição nesta mensagem');
    }
  } catch (error) {
    console.error('[ACCOUNT UPDATE] Erro ao processar atualização da conta:', error);
  }
}

// Função para mover posição para tabelas de fechadas
async function movePositionToHistory(db, positionId, status, reason) {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Verificar se a posição existe
      const [positionResult] = await connection.query("SELECT * FROM posicoes WHERE id = ?", [positionId]);
      if (positionResult.length === 0) {
        console.log(`Posição com ID ${positionId} não encontrada.`);
        await connection.commit();
        connection.release();
        return true;
      }

      // 2. Atualizar status e tempo de fechamento
      const formattedDate = formatDateForMySQL(new Date());
      await connection.query(
          `UPDATE posicoes
           SET status = ?,
               data_hora_fechamento = ?,
               data_hora_ultima_atualizacao = ?
           WHERE id = ?`,
          [status, formattedDate, formattedDate, positionId]
      );

      // 3. Verificar todas as ordens que referenciam esta posição
      const [orderResult] = await connection.query("SELECT * FROM ordens WHERE id_posicao = ?", [positionId]);
      console.log(`Encontradas ${orderResult.length} ordens para posição ${positionId}.`);

      // 4. Se houver ordens, movê-las para fechadas
      if (orderResult.length > 0) {
        // Construir esquemas dinâmicos para mover ordens
        const [renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_firs'`);
        const [renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_seco'`);
        const [orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);

        const [dest_renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_firs'`);
        const [dest_renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_seco'`);
        const [dest_orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'orign_sig'`);

        let sourceCols = "tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, " +
            "id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, " +
            "last_update";

        let destCols = sourceCols;

        if (renew_sl_firs.length > 0 && dest_renew_sl_firs.length > 0) {
          sourceCols += ", renew_sl_firs";
          destCols += ", renew_sl_firs";
        }

        if (renew_sl_seco.length > 0 && dest_renew_sl_seco.length > 0) {
          sourceCols += ", renew_sl_seco";
          destCols += ", renew_sl_seco";
        }

        if (orign_sig.length > 0 && dest_orign_sig.length > 0) {
          sourceCols += ", orign_sig";
          destCols += ", orign_sig";
        }

        // Inserir ordens na tabela de histórico
        await connection.query(
            `INSERT INTO ordens_fechadas (${destCols})
             SELECT ${sourceCols} FROM ordens WHERE id_posicao = ?`,
            [positionId]
        );
        console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);

        // Excluir ordens originais
        await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
        console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);
      }

      // 5. Verificar se posição tem coluna orign_sig
      const [posColumns] = await connection.query(`SHOW COLUMNS FROM posicoes LIKE 'orign_sig'`);
      const hasOrignSig = posColumns.length > 0;

      // 6. Copiar posição para tabela histórica
      if (hasOrignSig) {
        await connection.query(
            `INSERT INTO posicoes_fechadas
             (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
              side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig)
             SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?,
                    side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
             FROM posicoes WHERE id = ?`,
            [formattedDate, positionId]
        );
      } else {
        await connection.query(
            `INSERT INTO posicoes_fechadas
             (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
              side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente)
             SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?,
                    side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente
             FROM posicoes WHERE id = ?`,
            [formattedDate, positionId]
        );
      }
      console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);

      // 7. Excluir posição original
      await connection.query("DELETE FROM posicoes WHERE id = ?", [positionId]);
      console.log(`Posição com id ${positionId} excluída de posicoes.`);

      // 8. Finalizar transação
      await connection.commit();
      console.log(`[SYNC] Posição ${positionId} movida para fechadas com status: ${status}, motivo: ${reason}`);

      // 9. Verificar se precisamos fechar o WebSocket de monitoramento de preço
      // Obter o símbolo da posição que foi movida
      const symbol = positionResult[0].simbolo;
      await checkAndCloseWebsocket(db, symbol);

      connection.release();
      return true;

    } catch (error) {
      await connection.rollback();

      // Se for erro de bloqueio, tentar novamente com backoff exponencial
      if (error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
          error.message.includes('Lock wait timeout') ||
          error.message.includes('Deadlock')) {

        const waitTime = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
        console.log(`[MONITOR] Bloqueio ao mover posição ${positionId}. Tentativa ${attempts}/${maxAttempts} - Aguardando ${waitTime/1000}s`);

        connection.release();
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`[MONITOR] Erro ao mover posição ${positionId} para fechadas:`, error);
        connection.release();
        throw error;
      }
    }
  }

  throw new Error(`Falha ao mover posição ${positionId} após ${maxAttempts} tentativas`);
}

async function onPriceUpdate(symbol, currentPrice, db) {
  try {
    // 1. Atualizar preços das posições abertas para este símbolo
    await updatePositionPrices(db, symbol, currentPrice);

    // 2. Buscar sinais pendentes para este símbolo
    const [pendingSignalsResult] = await db.query(`
      SELECT id, symbol, side, leverage, capital_pct, entry_price,
             tp_price, sl_price, chat_id, timeframe, created_at
      FROM webhook_signals
      WHERE symbol = ?
        AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    
    const pendingSignals = pendingSignalsResult || [];
    // Log da nova estrutura:
    console.log(`[PRICE UPDATE] Encontrados ${pendingSignals.length} sinais pendentes para ${symbol}`);

    // 3. Verificar se há posições abertas ou ordens pendentes
    const [openPositionsResult] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN'
    `, [symbol]);
    
    const [pendingOrdersResult] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'OPEN' 
    `, [symbol]); // Presume-se que ordens 'OPEN' são as que justificam manter o WS

    const openPositionsCount = (openPositionsResult && openPositionsResult[0] && openPositionsResult[0].count) || 0;
    const pendingOrdersCount = (pendingOrdersResult && pendingOrdersResult[0] && pendingOrdersResult[0].count) || 0;

    // 4. Verificar se precisamos manter o WebSocket ativo
    if (pendingSignals.length === 0 && openPositionsCount === 0 && pendingOrdersCount === 0) {
      console.log(`[MONITOR] Símbolo ${symbol} sem atividade (sinais=${pendingSignals.length}, posições=${openPositionsCount}, ordens=${pendingOrdersCount}). Tentando fechar WebSocket.`);
      
      // Fechar WebSocket diretamente, sem usar contador
      await checkAndCloseWebsocket(db, symbol);
      
      // Limpar o contador antigo, caso exista, por segurança/higiene.
      if (websocketEmptyCheckCounter && websocketEmptyCheckCounter[symbol]) {
        delete websocketEmptyCheckCounter[symbol];
      }
      // Não é necessário retornar aqui, pois o loop de pendingSignals não executará se pendingSignals.length === 0.
    } else {
      let reasons = [];
      if (pendingSignals.length > 0) reasons.push(`${pendingSignals.length} sinais pendentes`);
      if (openPositionsCount > 0) reasons.push(`${openPositionsCount} posições abertas`);
      if (pendingOrdersCount > 0) reasons.push(`${pendingOrdersCount} ordens pendentes`);
      
      console.log(`[MONITOR] Mantendo WebSocket para ${symbol}. Motivo: ${reasons.join(', ')}.`);
      
      // Se houver websocketEmptyCheckCounter para este símbolo, remover, pois a nova lógica o substitui.
      if (websocketEmptyCheckCounter && websocketEmptyCheckCounter[symbol]) {
        console.log(`[MONITOR] Removendo contador antigo websocketEmptyCheckCounter para ${symbol}.`);
        delete websocketEmptyCheckCounter[symbol];
      }
    }

    // 5. Processar sinais pendentes (se houver) - Lógica interna mantida da sua versão original
    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price);
      const slPrice = parseFloat(signal.sl_price);
      const side = signal.side;

      const normalizedSide = side.toUpperCase();
      const isBuy = normalizedSide === 'BUY' || normalizedSide === 'COMPRA';
      const isSell = normalizedSide === 'SELL' || normalizedSide === 'VENDA';

      const shouldTrigger = (isBuy && currentPrice >= entryPrice) ||
                            (isSell && currentPrice <= entryPrice);

      const slHit = (isBuy && currentPrice <= slPrice) ||
                    (isSell && currentPrice >= slPrice);

      const createdAt = new Date(signal.created_at);
      const now = new Date();
      const signalAgeMs = now.getTime() - createdAt.getTime();
      const timeframeMs = timeframeToMs(signal.timeframe); // Precisa estar definida
      const maxLifetimeMs = timeframeMs > 0 ? timeframeMs * 3 : 0;
      const timeoutHit = maxLifetimeMs > 0 && signalAgeMs > maxLifetimeMs;

      const elapsedMin = Math.floor(signalAgeMs / (60 * 1000));
      const maxLifetimeMin = maxLifetimeMs > 0 ? Math.floor(maxLifetimeMs / (60 * 1000)) : 0;
      const timeRemainingMin = timeoutHit || maxLifetimeMs === 0 ? 0 : Math.floor((maxLifetimeMs - signalAgeMs) / (60 * 1000));

      console.log(`[PRICE UPDATE] Sinal ${signal.id} (${symbol}): Preço Atual=${currentPrice}, Entrada=${entryPrice}, SL=${slPrice}. Gatilhos: Trigger=${shouldTrigger}, SLHit=${slHit}, Timeout=${timeoutHit} | Tempo: ${elapsedMin}/${maxLifetimeMin} min`);

      if (shouldTrigger) {
        const signalKey = `${signal.id}_${signal.symbol}`;
        if (processingSignals.has(signalKey)) {
          console.log(`[PRICE UPDATE] Sinal ${signalKey} já está sendo processado, aguardando...`);
          continue;
        }
        processingSignals.add(signalKey);

        try {
          console.log(`[PRICE UPDATE] ACIONANDO entrada para sinal ${signalKey} a ${currentPrice}`);
          await executeEntryOrder(db, signal, currentPrice); // Precisa estar definida
        } catch (error) {
          console.error(`[PRICE UPDATE] Erro ao executar entrada para ${signalKey}: ${error.message}`);
        } finally {
          setTimeout(() => {
            processingSignals.delete(signalKey);
            console.log(`[PRICE UPDATE] Sinal ${signalKey} removido do processamento após timeout.`);
          }, 5000);
        }
      } else if (slHit) {
        console.log(`[PRICE UPDATE] ❌ SL ${formatDecimal(slPrice, 4)} atingido antes da entrada para ${signal.id} (${symbol}).`);
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY',
          `Stop loss (${formatDecimal(slPrice, 4)}) atingido antes da entrada(${formatDecimal(currentPrice, 4)})`); // Precisa estar definida
      } else if (timeoutHit) {
        console.log(`[PRICE UPDATE] ⏱️ TIMEOUT para sinal ${signal.id} (${symbol}). Ativo por ${elapsedMin} min (máx: ${maxLifetimeMin} min). Cancelando.`);
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY',
          `Entrada não acionada dentro do limite de tempo (${signal.timeframe} * 3 = ${maxLifetimeMin} min)`); // Precisa estar definida
      } else {
        if (maxLifetimeMs > 0) {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando. Tempo restante: ${timeRemainingMin} min (${elapsedMin}/${maxLifetimeMin} min)`);
        } else {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando (sem timeout definido).`);
        }
      }
    }
  } catch (error) {
    // Catch da nova estrutura
    console.error(`[PRICE UPDATE] Erro no processamento para ${symbol}:`, error);
  }
}

// ***** INÍCIO DAS NOVAS FUNÇÕES *****

// Nova função para atualizar preços das posições
async function updatePositionPrices(db, symbol, currentPrice) {
  try {
    // 1. Buscar posições abertas para o símbolo
    const [positions] = await db.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"', // Aspas duplas em "OPEN" para consistência com SQL
      [symbol]
    );

    if (positions.length === 0) {
        // console.log(`[PRICE UPDATE] Nenhuma posição aberta encontrada para ${symbol} para atualizar preços.`);
        return; // Não há posições para atualizar
    }

    // console.log(`[PRICE UPDATE] Encontradas ${positions.length} posições abertas para ${symbol}. Atualizando preços...`);

    // 2. Para cada posição, atualizar o preço corrente
    for (const position of positions) {
      const positionId = position.id;
      
      // Evitar log excessivo se a função for chamada muito frequentemente. Pode ser útil para debug inicial.
      // console.log(`[PRICE UPDATE] Atualizando preço da posição ${positionId} (${symbol}) para ${currentPrice}`);
      
      await db.query(
        `UPDATE posicoes SET 
         preco_corrente = ?, 
         data_hora_ultima_atualizacao = ? 
         WHERE id = ?`, // Removido espaço extra antes de preco_corrente e data_hora_ultima_atualizacao
        [currentPrice, formatDateForMySQL(new Date()), positionId] // Usa o placeholder formatDateForMySQL
      );
      
      // 3. Verificar se há ordens SL/TP ativas que precisam ser monitoradas
      await checkOrderTriggers(db, position, currentPrice);
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao atualizar preços das posições para ${symbol}: ${error.message}`, error);
    // Considerar se este erro deve ser propagado para onPriceUpdate ou tratado aqui.
    // Se propagar, onPriceUpdate pode parar o processamento de sinais pendentes.
  }
}

// Nova função para verificar gatilhos de ordens
async function checkOrderTriggers(db, position, currentPrice) {
  try {
    // Buscar ordens SL/TP ativas para esta posição
    const [orders] = await db.query(
      `SELECT * FROM ordens 
       WHERE id_posicao = ? 
       AND status = "OPEN" 
       AND tipo_ordem_bot IN ("STOP_LOSS", "TAKE_PROFIT")`, // Aspas duplas para consistência
      [position.id]
    );
    
    if (orders.length === 0) {
        // console.log(`[PRICE UPDATE] Nenhuma ordem SL/TP ativa para posição ${position.id} (${position.simbolo}).`);
        return; // Não há ordens para verificar
    }
    
    // Se a posição tiver um PnL >= X% ou <= Y%, enviar notificação
    const entryPrice = parseFloat(position.preco_entrada);
    if (isNaN(entryPrice) || entryPrice === 0) { // Adicionada verificação para evitar divisão por zero ou NaN
        console.warn(`[PRICE UPDATE] Preço de entrada inválido ou zero para posição ${position.id} (${position.simbolo}). PnL não calculado.`);
        return;
    }

    const side = position.side.toUpperCase(); // Normalizar para maiúsculas
    let pnlPercent = 0;

    if (side === 'BUY' || side === 'COMPRA') { // Assumindo que 'COMPRA' também pode ser um valor
      pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
    } else if (side === 'SELL' || side === 'VENDA') { // Assumindo que 'VENDA' também pode ser um valor
      pnlPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
    } else {
        console.warn(`[PRICE UPDATE] Lado (side) desconhecido para posição ${position.id}: ${position.side}`);
        return;
    }

  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao verificar gatilhos de ordens para posição ${position.id || 'desconhecida'}: ${error.message}`, error);
  }
}

// Função para acionar entrada a mercado
async function triggerMarketEntry(db, entry, currentPrice) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    console.log(`[MONITOR] Acionando entrada a mercado para ${entry.simbolo} a ${currentPrice}`);

    // 1. Obter detalhes da posição e do sinal
    const [positionDetails] = await connection.query(
        `SELECT * FROM posicoes WHERE id = ?`,
        [entry.position_id]
    );

    if (positionDetails.length === 0) {
      throw new Error(`Posição ID ${entry.position_id} não encontrada`);
    }

    const position = positionDetails[0];

    // 2. Obter precisão da quantidade
    const { quantityPrecision } = await getPrecision(entry.simbolo);

    // 3. Calcular tamanho da ordem
    const availableBalance = await getAvailableBalance();

    const orderSize = calculateOrderSize(
        availableBalance,
        parseFloat(entry.capital_pct) / 100,
        parseFloat(entry.preco_entrada), // Usamos o preço de entrada original para cálculo
        parseInt(entry.leverage),
        quantityPrecision
    );

    // 4. Enviar ordem de mercado para a corretora
    try {
      const binanceSide = entry.side;
      const orderResponse = await newEntryOrder(
          entry.simbolo,
          orderSize,
          binanceSide
      );

      if (!orderResponse || !orderResponse.orderId) {
        throw new Error('Resposta inválida da corretora ao criar ordem de mercado');
      }

      const orderId = orderResponse.orderId;
      const executedQty = parseFloat(orderResponse.executedQty);
      const executedPrice = parseFloat(orderResponse.price);

      console.log(`[MONITOR] Ordem de mercado executada: ${entry.simbolo}, ID: ${orderId}, Preço: ${executedPrice}, Qtd: ${executedQty}`);

      // 5. ALTERAÇÃO: AGORA criamos a posição no banco
      const positionData = {
        simbolo: entry.simbolo,
        quantidade: executedQty,
        preco_medio: executedPrice,
        status: 'OPEN', // Diretamente como OPEN, não PENDING_ENTRY
        data_hora_abertura: new Date().toISOString(),
        side: binanceSide,
        leverage: parseInt(entry.leverage),
        data_hora_ultima_atualizacao: new Date().toISOString(),
        preco_entrada: executedPrice,
        preco_corrente: executedPrice,
        orign_sig: `WEBHOOK_${entry.webhook_id}`
      };

      const positionId = await insertPosition(connection, positionData);

      if (!positionId) {
        throw new Error('Falha ao inserir posição após execução da ordem');
      }

      // 6. Registrar ordem de entrada no banco
      const orderData = {
        tipo_ordem: 'MARKET',
        preco: executedPrice,
        quantidade: executedQty,
        id_posicao: positionId,
        status: 'FILLED',
        data_hora_criacao: new Date().toISOString(),
        id_externo: orderId,
        side: binanceSide,
        simbolo: entry.simbolo,
        tipo_ordem_bot: 'ENTRADA',
        target: null,
        reduce_only: false,
        close_position: false,
        last_update: new Date().toISOString(),
        orign_sig: `WEBHOOK_${entry.webhook_id}`
      };

      await insertNewOrder(connection, orderData);

      // 7. Atualizar webhook_signals
      await connection.query(
          `UPDATE webhook_signals SET
                                    status = 'EXECUTADO',
                                    position_id = ?,
                                    entry_order_id = ?
           WHERE id = ?`,
          [positionId, orderId, entry.webhook_id]
      );

      // 8. Criar e enviar ordens SL/TP
      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const tpPriceVal = parseFloat(entry.tp_price);
      const slPriceVal = parseFloat(entry.sl_price);

      // Criar ordem SL
      try {
        const slResponse = await newStopOrder(
            entry.simbolo,
            executedQty,
            binanceOppositeSide,
            slPriceVal,
            null,           // price = null para STOP_MARKET
            false,           // reduceOnly = true
            true           // closePosition = false
        );

        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada: ${slResponse.data.orderId}`);

        // Registrar ordem SL no banco
        const slOrderData = {
          tipo_ordem: 'STOP_MARKET',
          preco: slPriceVal,
          quantidade: executedQty,
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: slResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: entry.simbolo,
          tipo_ordem_bot: 'STOP_LOSS',
          target: null,
          reduce_only: false,
          close_position: true,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${entry.webhook_id}`
        };

        await insertNewOrder(connection, slOrderData);

        // Atualizar SL ID no webhook
        await connection.query(
            `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`,
            [slResponse.data.orderId, entry.webhook_id]
        );
      } catch (slError) {
        console.error(`[MONITOR] Erro ao criar ordem SL: ${slError.message}`);
      }

      // Criar ordem TP
      try {
        const tpResponse = await newStopOrder(
            entry.simbolo,
            executedQty,
            binanceOppositeSide,
            tpPriceVal,
            tpPriceVal,      // price igual a stopPrice para TAKE_PROFIT_MARKET
            false,            // reduceOnly = true
            true            // closePosition = false
        );

        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada: ${tpResponse.data.orderId}`);

        // Registrar ordem TP no banco
        const tpOrderData = {
          tipo_ordem: 'TAKE_PROFIT_MARKET',
          preco: tpPriceVal,
          quantidade: executedQty,
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: tpResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: entry.simbolo,
          tipo_ordem_bot: 'TAKE_PROFIT',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${entry.webhook_id}`
        };

        await insertNewOrder(connection, tpOrderData);

        // Atualizar TP ID no webhook
        await connection.query(
            `UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`,
            [tpResponse.data.orderId, entry.webhook_id]
        );
      } catch (tpError) {
        console.error(`[MONITOR] Erro ao criar ordem TP: ${tpError.message}`);
      }

      // 9. Enviar notificação ao Telegram
      if (entry.chat_id) {
        try {
          await bot.telegram.sendMessage(entry.chat_id,
              `✅ Entrada executada para ${entry.simbolo}\n\n` +
              `Direção: ${position.side}\n` +
              `Alavancagem: ${entry.leverage}x\n` +
              `Quantidade: ${executedQty}\n\n` +
              `Entrada: ${executedPrice}\n` +
              `TP: ${tpPriceVal}\n` +
              `SL: ${slPriceVal}\n`,
              
          );
        } catch (telegramError) {
          console.error(`[MONITOR] Erro ao enviar mensagem Telegram:`, telegramError);
        }
      }

      await connection.commit();
      console.log(`[MONITOR] Entrada a mercado executada e registrada com sucesso para ${entry.simbolo}`);

      // Sincronizar saldo após criar ordem
      try {
        await syncAccountBalance();
      } catch (syncError) {
        console.error('[MONITOR] Erro ao sincronizar saldo após criar ordem:', syncError);
      }

    } catch (orderError) {
      console.error(`[MONITOR] Erro ao criar ordem de mercado para ${entry.simbolo}:`, orderError);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [`Erro ao criar ordem de mercado: ${orderError.message}`, entry.webhook_id]
      );
      await connection.rollback();
    }

  } catch (error) {
    console.error(`[MONITOR] Erro ao acionar entrada a mercado:`, error);
    await connection.rollback();
  } finally {
    connection.release();
  }
}

// Função para verificar ordens expiradas com base no timeframe
async function checkExpiredOrders() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // CORREÇÃO: Remover parâmetro [symbol] que causava erro
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, timeframe, created_at, chat_id
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO'
        AND timeframe IS NOT NULL AND timeframe != ''
    `);

    //console.log(`[MONITOR] Verificando ${pendingSignals.length} sinais pendentes com timeframe`);
    const now = new Date();
    let cancelCount = 0;

    for (const signal of pendingSignals) {
      // Pular se não tiver timeframe
      if (!signal.timeframe) continue;

      // Calcular o tempo máximo de vida do sinal (3x o timeframe)
      const timeframeMs = timeframeToMs(signal.timeframe);
      const maxLifetimeMs = timeframeMs * 3;

      // Se o timeframe não for válido ou for zero, pular
      if (maxLifetimeMs <= 0) {
        console.log(`[MONITOR] Timeframe inválido para sinal ${signal.id}: ${signal.timeframe}`);
        continue;
      }

      // Calcular há quanto tempo o sinal foi criado
      const createdAt = new Date(signal.created_at);
      const signalAgeMs = now.getTime() - createdAt.getTime();

      // Se o sinal estiver expirado (idade > 3x timeframe)
      if (signalAgeMs > maxLifetimeMs) {
        console.log(`[MONITOR] Sinal pendente para ${signal.symbol} expirado por timeout`);
        console.log(`[MONITOR] Idade: ${(signalAgeMs / (60 * 1000)).toFixed(2)} min, Máximo: ${(maxLifetimeMs / (60 * 1000)).toFixed(2)} min (${signal.timeframe} * 3)`);

        // Cancelar o sinal
        await cancelSignal(db, signal.id, 'TIMEOUT',
          `Entrada não acionada dentro do limite de tempo (${signal.timeframe} * 3)`);
        
        cancelCount++;
      }
    }

    if (cancelCount > 0) {
      console.log(`[MONITOR] ${cancelCount} sinais pendentes cancelados por timeout de timeframe`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar sinais expirados:', error);
  }
}

/**
 * Sincroniza o saldo da conta com a corretora e atualiza o banco de dados
 * Segue a regra: saldo_base_calculo só é atualizado quando o saldo aumenta
 * @returns {Promise<Object>} Objeto contendo saldo e saldo_base_calculo atualizados
 */
async function syncAccountBalance() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return null;
    }

    // Obter saldo real da corretora
    //console.log('[MONITOR] Obtendo saldo atualizado da corretora...');
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');

    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na corretora');
    }

    // CORREÇÃO: Usar o campo balance (saldo total) em vez de availableBalance
    const realSaldo = parseFloat(usdtBalance.balance);

    //console.log(`[MONITOR] Saldo total na corretora: ${realSaldo.toFixed(2)} USDT`);
    //console.log(`[MONITOR] Saldo disponível: ${parseFloat(usdtBalance.availableBalance).toFixed(2)} USDT`);

    // Obter saldo atual e base de cálculo do banco
    const [currentBalance] = await db.query('SELECT saldo, saldo_base_calculo FROM conta WHERE id = 1');

    const currentSaldo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo || 0) : 0;
    const currentBaseCalculo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo_base_calculo || 0) : 0;

    //console.log(`[MONITOR] Saldo atual: ${currentSaldo.toFixed(2)} USDT | Base Cálculo: ${currentBaseCalculo.toFixed(2)} USDT`);

    // Atualizar saldo no banco de dados com o saldo total
    const result = await updateAccountBalance(db, realSaldo);

    if (result) {
      //console.log(`[MONITOR] Saldo atualizado para: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT`);

      // Se o saldo base de cálculo foi alterado, exibir mensagem adicional
      if (result.saldo_base_calculo > currentBaseCalculo) {
        console.log(`[MONITOR] Base de cálculo aumentada: ${currentBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
      }
    }

    return result;
  } catch (error) {
    console.error(`[MONITOR] Erro ao sincronizar saldo da conta: ${error.message}`);
    return null;
  }
}

// Função para converter timeframe para milissegundos
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  // Extrair número e unidade
  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) {
    console.log(`[MONITOR] Formato de timeframe inválido: ${timeframe}`);
    return 0;
  }

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  // Converter para milissegundos com base na unidade
  switch(unit) {
    case 'm': return numValue * 60 * 1000; // minutos para ms
    case 'h': return numValue * 60 * 60 * 1000; // horas para ms
    case 'd': return numValue * 24 * 60 * 60 * 1000; // dias para ms
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000; // semanas para ms
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000; // meses para ms (aproximado)
    default: return 0;
  }
}

// Iniciar o monitoramento automaticamente quando o script for executado
(async () => {
  try {
    console.log('[MONITOR] Iniciando sistema de monitoramento...');
    await initializeMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao inicializar monitoramento:', error);
  }
})();

// NOVA FUNÇÃO: Verificar e encerrar websocket se não houver posições ou ordens ativas
async function checkAndCloseWebsocket(db, symbol) {
  try {
    console.log(`[MONITOR] Verificando se o WebSocket para ${symbol} pode ser fechado...`);

    // 1. Verificar se ainda existem sinais pendentes para o símbolo
    const [pendingSignalsRows] = await db.query(`
      SELECT COUNT(*) as count FROM webhook_signals 
      WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    // Acesso direto à contagem - assume que pendingSignalsRows[0] sempre existirá.
    // A versão anterior era: const pendingSignalsCount = (pendingSignalsRows && pendingSignalsRows[0]) ? pendingSignalsRows[0].count : 0;
    const pendingSignalsCount = pendingSignalsRows[0].count;

    // 2. Verificar se ainda existem posições abertas para o símbolo
    const [activePositionsRows] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN'
    `, [symbol]);
    // Acesso direto à contagem
    const activePositionsCount = activePositionsRows[0].count;
    
    // 3. Verificar se ainda existem ordens pendentes
    const [pendingOrdersRows] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'OPEN'
    `, [symbol]);
    // Acesso direto à contagem
    const pendingOrdersCount = pendingOrdersRows[0].count;
    
    console.log(`[MONITOR] Estado para ${symbol}: Sinais=${pendingSignalsCount}, Posições=${activePositionsCount}, Ordens=${pendingOrdersCount}`);

    if (pendingSignalsCount === 0 && 
        activePositionsCount === 0 && 
        pendingOrdersCount === 0) {
        
      console.log(`[MONITOR] Nenhuma atividade para ${symbol}. Fechando WebSocket.`);
      
      // Verificar se o websocket para este símbolo existe no nosso gerenciador
      // (Assumindo que 'websockets' é um objeto acessível que gerencia os websockets)
      if (websockets.priceWebsockets && websockets.priceWebsockets[symbol]) {
        if (websockets.stopPriceMonitoring(symbol)) { // Assumindo que esta função existe e retorna boolean
          console.log(`[MONITOR] WebSocket para ${symbol} fechado com sucesso.`);
          return true;
        } else {
          console.warn(`[MONITOR] Falha ao fechar WebSocket para ${symbol}.`); // Mensagem de log alterada
        }
      } else {
        console.log(`[MONITOR] WebSocket para ${symbol} já não existe.`); // Mensagem de log alterada
      }
    } else {
      console.log(`[MONITOR] Mantendo WebSocket para ${symbol} devido a: Sinais=${pendingSignalsCount}, Posições=${activePositionsCount}, Ordens=${pendingOrdersCount}`);
    }
    
    return false; // Retorna false se o websocket não foi fechado ou se deveria ser mantido
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar WebSocket para ${symbol}: ${error.message}`); // Mensagem de log alterada
    return false; // Erro durante o processo
  }
}

// NOVA FUNÇÃO: Executar ordem de entrada
async function executeEntryOrder(db, signal, currentPrice) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    console.log(`[MONITOR] Executando entrada para Sinal ID ${signal.id} (${signal.symbol}) a ${currentPrice}`);

    // 1. Obter precisão da quantidade e adicionar log
    const precisionInfo = await getPrecision(signal.symbol);
    console.log(`[MONITOR] Precisão obtida para ${signal.symbol}: ${JSON.stringify(precisionInfo)}`);
    const { quantityPrecision, pricePrecision } = precisionInfo; // Adicionado pricePrecision aqui

    // 2. Obter saldo e adicionar log
    const availableBalance = await getAvailableBalance();
    console.log(`[MONITOR] Saldo base de cálculo: ${availableBalance.toFixed(2)} USDT`);
    
    // 3. Calcular tamanho da ordem e adicionar log detalhado
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage);
    console.log(`[MONITOR] Parâmetros de cálculo para Sinal ID ${signal.id}: ${capitalPercentage * 100}% do capital, alavancagem ${leverage}x`);
    
    const orderSize = calculateOrderSize(
        availableBalance,
        capitalPercentage,
        currentPrice,
        leverage,
        quantityPrecision
    );

    // 4. Validar tamanho da ordem antes de enviar
    if (orderSize <= 0 || isNaN(orderSize)) {
      throw new Error(`Tamanho da ordem inválido para Sinal ID ${signal.id}: ${orderSize}`);
    }
    
    console.log(`[MONITOR] Enviando ordem para Sinal ID ${signal.id}: ${signal.symbol}, Qtd: ${orderSize}, Side: ${signal.side}`);
    
    // 5. Enviar ordem e processar (Início do try específico para a chamada da API e DB ops)
    try { 
      const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
      const orderResponse = await newEntryOrder(
          signal.symbol,
          orderSize,
          binanceSide
      );

      console.log(`[MONITOR] Resposta da API para ordem de entrada (Sinal ID ${signal.id}): ${JSON.stringify(orderResponse)}`);

      if (!orderResponse || !orderResponse.orderId) {
        throw new Error(`Resposta inválida da corretora ao criar ordem de mercado para Sinal ID ${signal.id}`);
      }

      const orderId = orderResponse.orderId;
      const executedQty = parseFloat(orderResponse.executedQty);
      const executedPrice = parseFloat(orderResponse.avgPrice || orderResponse.price) || currentPrice; // Usar avgPrice se disponível para ordens de mercado

      console.log(`[MONITOR] Ordem de mercado executada para Sinal ID ${signal.id}: ${signal.symbol}, ID Externo: ${orderId}, Preço Médio: ${executedPrice}, Qtd: ${executedQty}`);

      const positionData = {
        simbolo: signal.symbol,
        quantidade: executedQty,
        preco_medio: executedPrice,
        status: 'OPEN',
        data_hora_abertura: new Date().toISOString(),
        side: binanceSide,
        leverage: parseInt(signal.leverage),
        data_hora_ultima_atualizacao: new Date().toISOString(),
        preco_entrada: executedPrice,
        preco_corrente: executedPrice,
        orign_sig: `WEBHOOK_${signal.id}`
      };

      const positionId = await insertPosition(connection, positionData);

      if (!positionId) {
        throw new Error(`Falha ao inserir posição no DB para Sinal ID ${signal.id} após execução da ordem`);
      }
      console.log(`[MONITOR] Posição ID ${positionId} inserida no DB para Sinal ID ${signal.id}.`);

      const orderData = {
        tipo_ordem: 'MARKET', // ou o tipo real retornado pela API, se disponível
        preco: executedPrice,
        quantidade: executedQty,
        id_posicao: positionId,
        status: orderResponse.status || 'FILLED', // Usar status da API se disponível
        data_hora_criacao: orderResponse.updateTime ? new Date(orderResponse.updateTime).toISOString() : new Date().toISOString(),
        id_externo: orderId,
        side: binanceSide,
        simbolo: signal.symbol,
        tipo_ordem_bot: 'ENTRADA',
        target: null, // Definir conforme necessidade
        reduce_only: false,
        close_position: false,
        last_update: new Date().toISOString(),
        orign_sig: `WEBHOOK_${signal.id}`
      };

      await insertNewOrder(connection, orderData);
      console.log(`[MONITOR] Ordem de entrada registrada no DB para Posição ID ${positionId} (Sinal ID ${signal.id}).`);

      await connection.query(
          `UPDATE webhook_signals SET
              status = 'EXECUTADO',
              position_id = ?,
              entry_order_id = ? 
           WHERE id = ?`,
          [positionId, orderId, signal.id]
      );
      console.log(`[MONITOR] Sinal ID ${signal.id} atualizado para EXECUTADO no DB.`);

      const oppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const tpPrice = parseFloat(signal.tp_price);
      const slPrice = parseFloat(signal.sl_price);

      // Criar ordem SL
      try {
        const slResponse = await newStopOrder(signal.symbol, executedQty, oppositeSide, slPrice, null, false, true); // Ajustar parâmetros conforme sua newStopOrder
        if (slResponse && slResponse.data && slResponse.data.orderId) {
            const slOrderData = { simbolo: signal.symbol, side: oppositeSide, quantidade: executedQty, preco: slPrice, status: 'NEW', tipo_ordem: 'STOP_MARKET', tipo_ordem_bot: 'STOP_LOSS', id_posicao: positionId, id_externo: slResponse.data.orderId, data_hora_criacao: (slResponse.data && slResponse.data.transactTime) ? new Date(slResponse.data.transactTime).toISOString() : new Date().toISOString(), last_update: new Date().toISOString(), orign_sig: `WEBHOOK_${signal.id}`, reduce_only: true, close_position: true };
            await insertNewOrder(connection, slOrderData);
            await connection.query(`UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`, [slResponse.data.orderId, signal.id]);
            console.log(`[MONITOR] Ordem SL criada e registrada para Sinal ID ${signal.id}. ID Externo: ${slResponse.data.orderId}`);
        } else {
            console.warn(`[MONITOR] Resposta inválida ao criar ordem SL para Sinal ID ${signal.id}. Posição aberta sem SL programado via API.`);
             // Notificar usuário sobre falha na criação do SL
            if(signal.chat_id && bot) {
                await bot.telegram.sendMessage(signal.chat_id, `⚠️ Atenção: A ordem de entrada para ${signal.symbol} (Sinal ID ${signal.id}) foi executada, mas houve um problema ao programar o Stop Loss. Verifique manualmente.`);
            }
        }
      } catch (slError) {
        console.error(`[MONITOR] Erro ao criar ordem SL para ${signal.symbol} (Sinal ID: ${signal.id}): ${slError.message}. A posição pode estar sem SL.`, slError);
        if(signal.chat_id && bot) {
            await bot.telegram.sendMessage(signal.chat_id, `⚠️ Erro Crítico: Falha ao criar Stop Loss para ${signal.symbol} (Sinal ID ${signal.id}) após entrada. Motivo: ${slError.message}. Verifique imediatamente!`);
        }
      }

      try {
        const tpResponse = await newStopOrder(signal.symbol, executedQty, oppositeSide, tpPrice, tpPrice, false, true); // Ajustar parâmetros
        if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
            const tpOrderData = { simbolo: signal.symbol, side: oppositeSide, quantidade: executedQty, preco: tpPrice, status: 'NEW', tipo_ordem: 'TAKE_PROFIT_MARKET', tipo_ordem_bot: 'TAKE_PROFIT', id_posicao: positionId, id_externo: tpResponse.data.orderId, data_hora_criacao: (tpResponse.data && tpResponse.data.transactTime) ? new Date(tpResponse.data.transactTime).toISOString() : new Date().toISOString(), last_update: new Date().toISOString(), orign_sig: `WEBHOOK_${signal.id}`, reduce_only: true, close_position: true };
            await insertNewOrder(connection, tpOrderData);
            await connection.query(`UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`, [tpResponse.data.orderId, signal.id]);
            console.log(`[MONITOR] Ordem TP criada e registrada para Sinal ID ${signal.id}. ID Externo: ${tpResponse.data.orderId}`);
        } else {
            console.warn(`[MONITOR] Resposta inválida ao criar ordem TP para Sinal ID ${signal.id}. Posição aberta sem TP programado via API.`);
            if(signal.chat_id && bot) {
                await bot.telegram.sendMessage(signal.chat_id, `⚠️ Atenção: A ordem de entrada para ${signal.symbol} (Sinal ID ${signal.id}) foi executada, mas houve um problema ao programar o Take Profit. Verifique manualmente.`);
            }
        }
      } catch (tpError) {
        console.error(`[MONITOR] Erro ao criar ordem TP para ${signal.symbol} (Sinal ID: ${signal.id}): ${tpError.message}. A posição pode estar sem TP.`, tpError);
         if(signal.chat_id && bot) {
            await bot.telegram.sendMessage(signal.chat_id, `⚠️ Erro Crítico: Falha ao criar Take Profit para ${signal.symbol} (Sinal ID ${signal.id}) após entrada. Motivo: ${tpError.message}. Verifique imediatamente!`);
        }
      }

      let replyToMessageId = null;
      try {        
          const [messageInfoRows] = await db.query(` 
            SELECT registry_message_id FROM webhook_signals WHERE id = ? LIMIT 1 
          `, [signal.id]); // Supondo que o ID da mensagem de registro é 'registry_message_id'

          if (messageInfoRows && messageInfoRows.length > 0 && messageInfoRows[0].registry_message_id) {
            replyToMessageId = messageInfoRows[0].registry_message_id;
          }
      } catch(e) {
          console.error(`[MONITOR] Erro ao buscar ID da mensagem de registro para Sinal ID ${signal.id}: ${e.message}`);
      }
      
      if (signal.chat_id && bot) { // Adicionado 'bot' na condição para segurança
        try {
          const telegramOptions = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {};
          
          // Calcular o valor em USDT
          const amountInUsdt = executedQty * executedPrice;

          await bot.telegram.sendMessage(signal.chat_id,
              `✅ Entrada EXECUTADA para ${signal.symbol} \n(Sinal ID ${signal.id})\n\n` +
              `Direção: ${signal.side}\n` +
              `Alavancagem: ${signal.leverage}x\n` +
              `Quantidade: ${formatDecimal(amountInUsdt, 2)} USDT\n\n` +
              `Entrada: ${executedPrice.toFixed(pricePrecision || 2)}\n` +
              `Take Profit: ${tpPrice.toFixed(pricePrecision || 2)}\n` +
              `Stop Loss: ${slPrice.toFixed(pricePrecision || 2)}\n`,
              telegramOptions
          );
          console.log(`[MONITOR] Notificação de execução enviada para Sinal ID ${signal.id} (reply to: ${replyToMessageId || 'N/A'}).`);
        } catch (telegramError) {
          console.error(`[MONITOR] Erro ao enviar mensagem Telegram de execução para Sinal ID ${signal.id}:`, telegramError);
        }
      }

      await connection.commit();
      console.log(`[MONITOR] Entrada a mercado executada e transação commitada com sucesso para ${signal.symbol} (Sinal ID: ${signal.id})`);

      try {
        await syncAccountBalance();
      } catch (syncError) {
        console.error(`[MONITOR] Erro ao sincronizar saldo após criar ordem para Sinal ID ${signal.id}:`, syncError);
      }

      // Verificar e fechar websocket se necessário (lógica já existente)
      try {
        const [remainingSignalsRows] = await db.query(`
          SELECT COUNT(*) as count FROM webhook_signals
          WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'
        `, [signal.symbol]);
        const count = (remainingSignalsRows && remainingSignalsRows[0]) ? remainingSignalsRows[0].count : 0;
        if (count === 0) {
          console.log(`[MONITOR] Não há mais sinais 'AGUARDANDO_ACIONAMENTO' para ${signal.symbol} após execução do Sinal ID ${signal.id}. Agendando verificação de websocket.`);
          setTimeout(async () => {
            console.log(`[MONITOR] Executando checkAndCloseWebsocket para ${signal.symbol} (agendado após execução do Sinal ID ${signal.id}).`);
            await checkAndCloseWebsocket(db, signal.symbol);
          }, 5000);
        } else {
          console.log(`[MONITOR] Ainda existem ${count} sinais 'AGUARDANDO_ACIONAMENTO' para ${signal.symbol}. Websocket para ${signal.symbol} permanecerá ativo.`);
        }
      } catch (checkError) {
        console.error(`[MONITOR] Erro ao verificar sinais restantes para ${signal.symbol} (Sinal ID ${signal.id}):`, checkError);
      }

    } catch (apiError) { // Catch para erros da API ou operações de DB dentro do try aninhado
      console.error(`[MONITOR] ERRO API/DB INTERNO (Sinal ID: ${signal.id}, Símbolo: ${signal.symbol}): ${apiError.message}`, apiError);
      if (apiError.response && apiError.response.data) {
        console.error(`[MONITOR] Detalhes do erro API: ${JSON.stringify(apiError.response.data)}`);
      }
      // Notificar usuário sobre falha na ordem, se possível respondendo à mensagem original
      if (signal.chat_id && bot) {
          let replyToIdForError = null;
          try {
              const [msgErrInfo] = await db.query(`SELECT registry_message_id FROM webhook_signals WHERE id = ? LIMIT 1`, [signal.id]);
              if (msgErrInfo && msgErrInfo.length > 0) replyToIdForError = msgErrInfo[0].registry_message_id;
          } catch(e) { /* ignore */ }

          const errorOptions = replyToIdForError ? { reply_to_message_id: replyToIdForError } : {};
          let userErrorMessage = `⚠️ Falha ao executar ordem para ${signal.symbol} (Sinal ID ${signal.id}).`;
          if (apiError.message && (apiError.message.includes('MIN_NOTIONAL') || apiError.message.includes('size < minQty') || apiError.message.includes('minQty'))) {
            userErrorMessage += ` Motivo: O tamanho da ordem calculado (${orderSize}) é menor que o mínimo permitido pela corretora. Verifique o capital alocado ou o preço do ativo.`;
          } else if (apiError.message) {
            userErrorMessage += ` Motivo: ${apiError.message}`;
          }
          try {
            await bot.telegram.sendMessage(signal.chat_id, userErrorMessage, errorOptions);
          } catch (telegramError) {
            console.error(`[MONITOR] Erro ao enviar mensagem de ERRO API/DB no Telegram para Sinal ID ${signal.id}:`, telegramError);
          }
      }
      throw apiError; // Re-throw para ser capturado pelo catch externo que fará o rollback
    }
    // Fim do try específico

  } catch (error) { // Catch externo/geral
    console.error(`[MONITOR] ERRO GERAL ao executar entrada para ${signal.symbol} (Sinal ID: ${signal.id}):`, error);
    if (connection) {
        try {
            await connection.rollback();
            console.log(`[MONITOR] Rollback da transação para Sinal ID ${signal.id} efetuado devido a erro.`);
        } catch (rollbackError) {
            console.error(`[MONITOR] Erro crítico ao tentar fazer rollback para Sinal ID ${signal.id}:`, rollbackError);
        }
    }
    try {
      await db.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ? AND status != 'EXECUTADO'`,
          [`Erro ao executar entrada: ${error.message.substring(0, 250)}`, signal.id] // Limitar tamanho da msg de erro
      );
    } catch (updateError) {
      console.error(`[MONITOR] Erro ao atualizar status do Sinal ID ${signal.id} para ERROR após falha:`, updateError);
    }
  } finally {
    if (connection) {
        connection.release();
    }
  }
}

const cancelingSignals = new Set();

async function cancelSignal(db, signalId, statusParam, reason) {
  // Verificar se este sinal já está sendo cancelado
  const lockKey = `cancel_${signalId}`;
  if (cancelingSignals.has(lockKey)) {
    console.log(`[MONITOR] Sinal ID ${signalId} já está sendo cancelado, ignorando chamada duplicada.`);
    return false; // Evitar processamento duplicado
  }

  try {
    // Adicionar à lista de sinais em processamento
    cancelingSignals.add(lockKey);

    console.log(`[MONITOR] Iniciando cancelamento do sinal ID ${signalId} (Status informado no parâmetro: ${statusParam}): ${reason}`);

    // Verificar se o sinal já não está cancelado no banco de dados
    const [currentStatusRows] = await db.query(`
      SELECT status FROM webhook_signals WHERE id = ?
    `, [signalId]);

    if (currentStatusRows.length === 0) {
      console.warn(`[MONITOR] Sinal ID ${signalId} não encontrado no banco de dados para cancelamento.`);
    } else if (currentStatusRows[0].status === 'CANCELED') {
      console.log(`[MONITOR] Sinal ID ${signalId} já está com status CANCELED no banco de dados.`);
    }

    const [updateResult] = await db.query(`
      UPDATE webhook_signals
      SET status = 'CANCELED',
          error_message = ?
      WHERE id = ?
    `, [reason, signalId]);

    if (updateResult.affectedRows === 0) {
      console.warn(`[MONITOR] Tentativa de atualizar sinal ID ${signalId} para CANCELED, mas nenhum registro foi afetado. O sinal pode não existir ou já estar cancelado.`);
    } else {
      console.log(`[MONITOR] Sinal ID ${signalId} atualizado para CANCELED no banco de dados.`);
    }

    let signalData = null;
    let symbolToVerify = null;

    const [signalInfoRows] = await db.query(`
      SELECT symbol, chat_id, registry_message_id
      FROM webhook_signals
      WHERE id = ? LIMIT 1
    `, [signalId]);

    if (signalInfoRows && signalInfoRows.length > 0) {
      signalData = signalInfoRows[0];
      symbolToVerify = signalData.symbol;
    }

    // Início da implementação da formatação de preço
    if (signalData && signalData.chat_id && bot) { // Assumindo que 'bot' é uma variável global/acessível
      try {
        const telegramOptions = signalData.registry_message_id
          ? { reply_to_message_id: signalData.registry_message_id }
          : {};

        // Extrair preço do motivo se existir para formatar corretamente
        let formattedReason = reason;
        if (reason && reason.includes('\nPreço:')) { // Adicionada verificação se 'reason' existe
          // Extrair valores numéricos para formatação
          formattedReason = reason.replace(/(\d+\.\d+)/g, match => {
            // Certifique-se que formatDecimal está definida e funciona como esperado
            return formatDecimal(parseFloat(match), 4); // Usando 4 casas decimais como no seu exemplo
          });
        }

        await bot.telegram.sendMessage(signalData.chat_id,
          `⚠️ Sinal para ${signalData.symbol || 'N/A'} Cancelado ⚠️ \n(ID: ${signalId})\n\n` +
          `Motivo: ${formattedReason}`, // Usando formattedReason aqui
          telegramOptions
        );
        console.log(`[MONITOR] Notificação de cancelamento enviada para Sinal ID ${signalId} (reply to: ${signalData.registry_message_id || 'N/A'}).`);
      } catch (telegramError) {
        // Atualizado o log de erro para ser mais consistente com o seu exemplo
        console.error(`[MONITOR] Erro ao enviar notificação Telegram para cancelamento do sinal ID ${signalId}: ${telegramError.message}`, telegramError);
      }
    } else {
      let logMessage = `[MONITOR] Não foi possível enviar notificação de cancelamento para o sinal ID ${signalId}: `;
      if (!signalData) logMessage += "informações do sinal não encontradas (pode ter sido deletado). ";
      if (signalData && !signalData.chat_id) logMessage += "chat_id não encontrado. ";
      if (!bot) logMessage += "instância do bot não disponível. ";
      console.log(logMessage.trim());
    }
    // Fim da implementação da formatação de preço

    if (symbolToVerify) {
      try {
        const [remainingSignalsRows] = await db.query(`
          SELECT COUNT(*) as count
          FROM webhook_signals
          WHERE symbol = ?
            AND status = 'AGUARDANDO_ACIONAMENTO'
        `, [symbolToVerify]);

        const count = (remainingSignalsRows && remainingSignalsRows[0]) ? remainingSignalsRows[0].count : 0;

        if (count === 0) {
          console.log(`[MONITOR] Não há mais sinais 'AGUARDANDO_ACIONAMENTO' para ${symbolToVerify} após cancelamento do sinal ID ${signalId}. Agendando verificação de websocket.`);
          setTimeout(async () => {
            try {
                console.log(`[MONITOR] Executando checkAndCloseWebsocket para ${symbolToVerify} (agendado após cancelamento do sinal ID ${signalId}).`);
                if (typeof checkAndCloseWebsocket === 'function') {
                    await checkAndCloseWebsocket(db, symbolToVerify);
                } else {
                    console.error(`[MONITOR] Função checkAndCloseWebsocket não está definida ou não é uma função.`);
                }
            } catch (websocketCheckError) {
                console.error(`[MONITOR] Erro dentro do setTimeout ao executar checkAndCloseWebsocket para ${symbolToVerify} (Sinal ID ${signalId}):`, websocketCheckError);
            }
          }, 5000);
        } else {
          console.log(`[MONITOR] Ainda existem ${count} sinais 'AGUARDANDO_ACIONAMENTO' para ${symbolToVerify} após cancelamento do sinal ID ${signalId}. Websocket para ${symbolToVerify} permanecerá ativo.`);
        }
      } catch (checkError) {
        console.error(`[MONITOR] Erro ao verificar sinais restantes para ${symbolToVerify} (referente ao sinal cancelado ID ${signalId}):`, checkError);
      }
    } else {
      console.log(`[MONITOR] Símbolo não encontrado para o sinal ID ${signalId}. Não foi possível verificar o estado do websocket com base neste cancelamento.`);
    }

    cancelingSignals.delete(lockKey);
    return true;
  } catch (error) {
    console.error(`[MONITOR] Erro geral ao cancelar sinal ID ${signalId}: ${error.message}`, error);
    cancelingSignals.delete(lockKey);
    return false;
  }
}

// Adicione temporariamente este código para limpar entradas pendentes antigas
async function cleanUpExistingEntries() {
  try {
    const db = await getDatabaseInstance(); // Supondo que getDatabaseInstance() retorna a conexão/pool
    if (!db) {
        console.error("[CLEANUP] Instância do banco de dados não obtida.");
        return;
    }
    
    // Cancelar todos os sinais em AGUARDANDO_ACIONAMENTO que têm position_id
    const [pendingSignalsRows] = await db.query(`
      SELECT id, symbol, position_id 
      FROM webhook_signals 
      WHERE status = 'AGUARDANDO_ACIONAMENTO' 
        AND position_id IS NOT NULL
    `);
    
    const pendingSignals = pendingSignalsRows; // O resultado já é um array de objetos

    console.log(`[CLEANUP] Encontrados ${pendingSignals.length} sinais pendentes com posições`);
    
    for (const signal of pendingSignals) {
      await cancelSignal(db, signal.id, 'CLEANUP', 
        `Limpeza de sistema: nova versão não usa posições pendentes`);
    }
    
    console.log(`[CLEANUP] Limpeza concluída`);
  } catch (error) {
    console.error(`[CLEANUP] Erro durante limpeza:`, error);
  }
}

/**
 * Formata um valor decimal removendo zeros desnecessários à direita
 * @param {number} value - O valor a ser formatado
 * @param {number} maxPrecision - Precisão máxima (opcional)
 * @return {string} Valor formatado sem zeros desnecessários
 */
function formatDecimal(value, maxPrecision = 8) {
  if (value === undefined || value === null) return '0';
  
  // Primeiro formata com a precisão máxima
  const formatted = parseFloat(value).toFixed(maxPrecision);
  
  // Depois remove zeros desnecessários e pontos decimais isolados
  return parseFloat(formatted).toString();
}

// Execute a limpeza (se necessário, chame esta função no início do seu script)
// cleanUpExistingEntries();