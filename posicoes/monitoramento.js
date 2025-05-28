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
//  scheduledJobs.syncWithExchange = schedule.scheduleJob('*/1 * * * *', async () => {
//    try {
//      await syncWithExchange();
//    } catch (error) {
//      console.error('[MONITOR] Erro na sincronização periódica:', error);
//    }
//  });

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

  // Adicionar dentro da função initializeMonitoring(), junto com os outros jobs
  // Sincronizar saldo a cada hora
  scheduledJobs.syncAccountBalance = schedule.scheduleJob('0 * * * *', async () => {
    try {
      console.log('[MONITOR] Sincronizando saldo (job periódico)...');
      await syncAccountBalance();
    } catch (error) {
      console.error('[MONITOR] Erro na sincronização periódica de saldo:', error);
    }
  });

  // Iniciar monitoramento de preços para posições abertas
  try {
    await startPriceMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
  }

  console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
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

    console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para monitoramento`);

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
            `Alavancagem: ${leverage}x\n` +
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
    console.log(`[ORDER UPDATE] Symbol: ${orderMsg.s}, OrderID: ${orderMsg.i}, Status: ${orderMsg.X}, ExecutionType: ${orderMsg.x}`);

    // Buscar a ordem no banco de dados
    const [orders] = await db.query(
        'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ?',
        [orderMsg.i, orderMsg.s]
    );

    if (orders.length === 0) {
      console.log(`[MONITOR] Ordem ${orderMsg.i} não encontrada no banco de dados`);
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

        // Se a ordem foi preenchida, atualizar o status da posição
        if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
          await updatePositionStatus(db, order.simbolo, { status: 'OPEN' });
          console.log(`[MONITOR] Posição ${order.id_posicao} atualizada para OPEN após preenchimento da ordem`);
        }

        return;
      }

      console.log(`[MONITOR] Criando ordens SL/TP para posição ${order.id_posicao} após ordem ${orderMsg.X}`);

      // 1. Obter a posição relacionada
      const [positions] = await db.query('SELECT * FROM posicoes WHERE id = ?', [order.id_posicao]);
      if (positions.length === 0) {
        console.log(`[MONITOR] Posição ${order.id_posicao} não encontrada`);
        return;
      }

      const position = positions[0];

      // 2. Se a ordem foi preenchida, atualizar status da posição para OPEN
      if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
        await updatePositionStatus(db, position.simbolo, { status: 'OPEN' });
      }

      // 3. Obter as configurações de TP/SL do webhook_signals, se existir
      let tpPrice, slPrice;
      const [signals] = await db.query(
          'SELECT * FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1',
          [order.id_posicao]
      );

      const entryPrice = parseFloat(position.preco_entrada || order.preco);

      if (signals.length > 0 && signals[0].tp_price && signals[0].sl_price) {
        tpPrice = parseFloat(signals[0].tp_price);
        slPrice = parseFloat(signals[0].sl_price);
        console.log(`[MONITOR] Usando preços TP/SL do sinal: TP=${tpPrice}, SL=${slPrice}`);
      } else {
        // Calcular preços de TP/SL padrão (1% de diferença)
        if (position.side === 'BUY') {
          tpPrice = entryPrice * 1.01; // TP 1% acima
          slPrice = entryPrice * 0.99; // SL 1% abaixo
        } else {
          tpPrice = entryPrice * 0.99; // TP 1% abaixo
          slPrice = entryPrice * 1.01; // SL 1% acima
        }
        console.log(`[MONITOR] Calculando preços TP/SL padrão: TP=${tpPrice}, SL=${slPrice}`);
      }

      // 4. Determinar o side oposto para as ordens de TP/SL
      const oppositeSide = position.side === 'BUY' ? 'SELL' : 'BUY';

      // 5. Criar e enviar ordem de SL para a corretora (usando STOP_MARKET)
      try {
        // IMPORTANTE: Aqui enviamos stopPrice sem price para ordem SL
        const slResponse = await newStopOrder(
            position.simbolo,
            parseFloat(position.quantidade || order.quantidade),
            oppositeSide,
            slPrice,
            null,            // price = null para STOP_MARKET
            false,            // reduceOnly = true
            true            // closePosition = false
        );

        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada na corretora: ${slResponse.data.orderId}`);

        // 6. Registrar ordem SL no banco de dados
        await insertNewOrder(db, {
          tipo_ordem: 'STOP_MARKET',
          preco: slPrice,
          quantidade: position.quantidade || order.quantidade,
          id_posicao: position.id,
          status: 'OPEN',
          data_hora_criacao: formatDateForMySQL(new Date()),
          id_externo: slResponse.data.orderId,
          side: oppositeSide,
          simbolo: position.simbolo,
          tipo_ordem_bot: 'STOP_LOSS',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: formatDateForMySQL(new Date()),
          orign_sig: position.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem SL: ${error.message}`);
      }

      // 7. Criar e enviar ordem de TP para a corretora (usando TAKE_PROFIT_MARKET)
      try {
        const tpResponse = await newStopOrder(
            position.simbolo,
            parseFloat(position.quantidade || order.quantidade),
            oppositeSide,
            tpPrice,
            tpPrice,  // stopPrice igual ao price para TP
            false,     // reduceOnly = true
            true     // closePosition = false
        );

        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada na corretora: ${tpResponse.data.orderId}`);

        // 8. Registrar ordem TP no banco de dados
        await insertNewOrder(db, {
          tipo_ordem: 'TAKE_PROFIT_MARKET',
          preco: tpPrice,
          quantidade: position.quantidade || order.quantidade,
          id_posicao: position.id,
          status: 'OPEN',
          data_hora_criacao: formatDateForMySQL(new Date()),
          id_externo: tpResponse.data.orderId,
          side: oppositeSide,
          simbolo: position.simbolo,
          tipo_ordem_bot: 'TAKE_PROFIT',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: formatDateForMySQL(new Date()),
          orign_sig: position.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem TP: ${error.message}`);
      }

    } else if ((order.tipo_ordem_bot === 'TAKE_PROFIT' || order.tipo_ordem_bot === 'STOP_LOSS') && orderMsg.X === 'FILLED') {
      // Lógica para quando TP/SL é preenchido (manter o código original)
      console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} executada completamente, fechando posição ${order.id_posicao}`);

      // Cancelar outras ordens abertas para esta posição
      const [otherOrders] = await db.query(
          'SELECT * FROM ordens WHERE id_posicao = ? AND id != ? AND status = "OPEN"',
          [order.id_posicao, order.id]
      );

      for (const otherOrder of otherOrders) {
        try {
          await cancelOrder(otherOrder.id_externo, otherOrder.simbolo);
          await updateOrderStatus(db, otherOrder.id, "CANCELED");
          console.log(`[MONITOR] Ordem ${otherOrder.id_externo} cancelada`);
        } catch (error) {
          console.error(`[MONITOR] Erro ao cancelar ordem ${otherOrder.id_externo}: ${error.message}`);
        }
      }

      // Mover registros para tabelas fechadas
      try {
        await moveClosedPositionsAndOrders(db, order.id_posicao);
        console.log(`[MONITOR] Posição ${order.id_posicao} fechada e movida para histórico`);

        // Sincronizar saldo após fechamento de posição - ADICIONADO
        try {
          await syncAccountBalance();
        } catch (syncError) {
          console.error('[MONITOR] Erro ao sincronizar saldo após fechamento de posição:', syncError);
        }
      } catch (error) {
        console.error(`[MONITOR] Erro ao mover registros para histórico: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[MONITOR] Erro ao processar atualização de ordem: ${error.message}`);
  }
}

// Função para processar atualizações de conta via WebSocket
async function handleAccountUpdate(message, db) {
  try {
    console.log('[ACCOUNT UPDATE] Recebido atualização de conta');

    // Se não houver conexão com o banco, tentar estabelecer
    if (!db) {
      db = await getDatabaseInstance();
      if (!db) {
        console.error('[ACCOUNT UPDATE] Não foi possível obter conexão com o banco de dados');
        return;
      }
    }

    // Verificar se há atualizações de posição no evento
    if (message.a && message.a.P) {
      const positions = message.a.P;

      for (const position of positions) {
        const symbol = position.s;
        const amount = parseFloat(position.pa);

        // Ignorar posições zeradas ou muito pequenas
        if (Math.abs(amount) <= 0.000001) {
          continue;
        }

        console.log(`[ACCOUNT UPDATE] Posição atualizada: ${symbol}, quantidade: ${amount}`);

        // Atualizar posição no banco de dados
        try {
          // Obter ID da posição
          const positionId = await getPositionIdBySymbol(db, symbol);

          if (positionId) {
            const entryPrice = parseFloat(position.ep);
            const markPrice = parseFloat(position.mp);
            const leverage = parseInt(position.l);

            // Atualizar dados da posição
            await updatePositionInDb(db, positionId, amount, entryPrice, markPrice, leverage);
          }
        } catch (error) {
          console.error(`[ACCOUNT UPDATE] Erro ao atualizar posição ${symbol}:`, error);
        }
      }
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
    // Busca sinais pendentes para o símbolo atual
    // Assumindo que db.query retorna [rows, fields] ou similar, onde rows é o primeiro elemento.
    const [pendingSignalsResult] = await db.query(`
      SELECT id, symbol, side, leverage, capital_pct, entry_price,
             tp_price, sl_price, chat_id, timeframe, created_at
      FROM webhook_signals
      WHERE symbol = ?
        AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    // Se pendingSignalsResult for undefined (nenhuma linha), trate como array vazio.
    const pendingSignals = pendingSignalsResult || [];

    console.log(`[PRICE UPDATE] Encontrados ${pendingSignals.length} sinais pendentes para ${symbol}`);

    // --- INÍCIO DAS MODIFICAÇÕES SUGERIDAS (do seu código original) ---
    if (pendingSignals.length === 0) {
      // Adicionar um contador para controlar quantas vezes vimos "0 sinais" para este símbolo
      if (!websocketEmptyCheckCounter[symbol]) { // websocketEmptyCheckCounter deve estar definido no escopo acessível
        websocketEmptyCheckCounter[symbol] = 1;
      } else {
        websocketEmptyCheckCounter[symbol]++;
      }

      console.log(`[MONITOR] Símbolo ${symbol} sem sinais pendentes, verificação ${websocketEmptyCheckCounter[symbol]}/3.`);

      // Após 3 verificações sem sinais, tentar fechar o WebSocket
      if (websocketEmptyCheckCounter[symbol] >= 3) {
        console.log(`[MONITOR] Símbolo ${symbol} sem sinais pendentes por 3 verificações consecutivas. Tentando fechar WebSocket.`);
        // A função checkAndCloseWebsocket precisa ser definida em outro lugar
        await checkAndCloseWebsocket(db, symbol);
        delete websocketEmptyCheckCounter[symbol]; // Limpar o contador após tentar fechar
      }

      return; // Retornar cedo para evitar processamento desnecessário
    } else {
      // Reiniciar o contador se encontrarmos sinais
      if (websocketEmptyCheckCounter && websocketEmptyCheckCounter[symbol]) { // Adicionada verificação de existência de websocketEmptyCheckCounter
        console.log(`[MONITOR] Sinais pendentes encontrados para ${symbol}. Resetando contador de WebSocket.`);
        delete websocketEmptyCheckCounter[symbol];
      }
    }
    // --- FIM DAS MODIFICAÇÕES SUGERIDAS (do seu código original) ---

    // Para cada sinal pendente, verifica os gatilhos (Restante do código original)
    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price);
      const slPrice = parseFloat(signal.sl_price);
      const side = signal.side;

      // Define gatilhos com base na direção
      const normalizedSide = side.toUpperCase();
      const isBuy = normalizedSide === 'BUY' || normalizedSide === 'COMPRA';
      const isSell = normalizedSide === 'SELL' || normalizedSide === 'VENDA';

      // GATILHO DE ENTRADA: verifica se preço ultrapassou nível de entrada
      const shouldTrigger = (isBuy && currentPrice >= entryPrice) || // Ajuste para >= em BUY e <= em SELL se a entrada é no toque/rompimento
                            (isSell && currentPrice <= entryPrice);

      // Verificar se SL foi atingido (cancelar a entrada)
      const slHit = (isBuy && currentPrice <= slPrice) ||
                    (isSell && currentPrice >= slPrice);

      // Verificar se o tempo máximo foi excedido (timeout)
      const createdAt = new Date(signal.created_at);
      const now = new Date();
      const signalAgeMs = now.getTime() - createdAt.getTime();
      // timeframeToMs deve estar definida no escopo acessível
      const timeframeMs = timeframeToMs(signal.timeframe);
      const maxLifetimeMs = timeframeMs > 0 ? timeframeMs * 3 : 0; // Evitar NaN se timeframeMs for 0
      const timeoutHit = maxLifetimeMs > 0 && signalAgeMs > maxLifetimeMs;

      // Calcular o tempo restante em minutos (para log)
      const elapsedMin = Math.floor(signalAgeMs / (60 * 1000));
      const maxLifetimeMin = maxLifetimeMs > 0 ? Math.floor(maxLifetimeMs / (60 * 1000)) : 0;
      const timeRemainingMin = timeoutHit || maxLifetimeMs === 0 ? 0 : Math.floor((maxLifetimeMs - signalAgeMs) / (60 * 1000));

      console.log(`[PRICE UPDATE] Sinal ${signal.id} (${symbol}): Preço Atual=${currentPrice}, Entrada=${entryPrice}, SL=${slPrice}. Gatilhos: Trigger=${shouldTrigger}, SLHit=${slHit}, Timeout=${timeoutHit} | Tempo: ${elapsedMin}/${maxLifetimeMin} min`);

      if (shouldTrigger) {
        const signalKey = `${signal.id}_${signal.symbol}`;

        // processingSignals deve estar definido no escopo acessível
        if (processingSignals.has(signalKey)) {
          console.log(`[PRICE UPDATE] Sinal ${signalKey} já está sendo processado, aguardando...`);
          continue;
        }

        processingSignals.add(signalKey);

        try {
          console.log(`[PRICE UPDATE] ACIONANDO entrada para sinal ${signalKey} a ${currentPrice}`);
          // executeEntryOrder deve estar definida no escopo acessível e lidar com a mudança de status do sinal
          await executeEntryOrder(db, signal, currentPrice);
        } catch (error) {
          console.error(`[PRICE UPDATE] Erro ao executar entrada para ${signalKey}: ${error.message}`);
          // Considere se precisa atualizar o status do sinal para ERRO aqui também ou se executeEntryOrder já faz
        } finally {
          // Remover da lista de processamento após um tempo para permitir nova tentativa ou liberar
          // Ajuste o tempo conforme necessidade. 5 segundos pode ser muito curto ou muito longo.
          setTimeout(() => {
            processingSignals.delete(signalKey);
            console.log(`[PRICE UPDATE] Sinal ${signalKey} removido do processamento após timeout.`);
          }, 5000);
        }
      // ***** INÍCIO DA IMPLEMENTAÇÃO SOLICITADA *****
      } else if (slHit) {
        console.log(`[PRICE UPDATE] ❌ SL ${formatDecimal(slPrice, 4)} atingido antes da entrada para ${signal.id} (${symbol}).`); // Linha modificada conforme sua solicitação
        // cancelSignal deve estar definida no escopo acessível
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY',
          `Stop loss (${formatDecimal(slPrice, 4)}) atingido antes da entrada. Preço: ${formatDecimal(currentPrice, 4)}`); // Linha modificada conforme sua solicitação
      // ***** FIM DA IMPLEMENTAÇÃO SOLICITADA *****
      } else if (timeoutHit) {
        console.log(`[PRICE UPDATE] ⏱️ TIMEOUT para sinal ${signal.id} (${symbol}). Ativo por ${elapsedMin} min (máx: ${maxLifetimeMin} min). Cancelando.`);
        // cancelSignal deve estar definida no escopo acessível
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY',
          `Entrada não acionada dentro do limite de tempo (${signal.timeframe} * 3 = ${maxLifetimeMin} min)`);
      } else {
        if (maxLifetimeMs > 0) {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando. Tempo restante: ${timeRemainingMin} min (${elapsedMin}/${maxLifetimeMin} min)`);
        } else {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando (sem timeout definido).`);
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro fatal ao processar atualização de preço para ${symbol}:`, error);
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
              `Preço de execução: ${executedPrice}\n` +
              `TP: ${tpPriceVal}\n` +
              `SL: ${slPriceVal}\n` +
              `Quantidade: ${executedQty}\n`,
              
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

    console.log(`[MONITOR] Verificando ${pendingSignals.length} sinais pendentes com timeframe`);
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
    console.log(`[MONITOR] Iniciando verificação para encerrar websocket do símbolo: ${symbol}`);

    // 1. Verificar se ainda existem sinais pendentes para o símbolo
    const [pendingSignalsRows] = await db.query(`
      SELECT COUNT(*) as count FROM webhook_signals 
      WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    const pendingSignalsCount = (pendingSignalsRows && pendingSignalsRows[0]) ? pendingSignalsRows[0].count : 0;

    // 2. Verificar se ainda existem posições abertas para o símbolo
    const [activePositionsRows] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' 
    `, [symbol]); 
                 
    const activePositionsCount = (activePositionsRows && activePositionsRows[0]) ? activePositionsRows[0].count : 0;
    
    // 3. Verificar se ainda existem ordens (SL/TP) pendentes/abertas
    const [pendingOrdersRows] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'OPEN' 
    `, [symbol]);
    const pendingOrdersCount = (pendingOrdersRows && pendingOrdersRows[0]) ? pendingOrdersRows[0].count : 0;
    
    console.log(`[MONITOR] Estado para ${symbol}: Sinais Pendentes=${pendingSignalsCount}, Posições Abertas=${activePositionsCount}, Ordens Abertas=${pendingOrdersCount}`);

    if (pendingSignalsCount === 0 && 
        activePositionsCount === 0 && 
        pendingOrdersCount === 0) {
        
      console.log(`[MONITOR] Nenhuma atividade (sinais, posições, ordens) para ${symbol}. Tentando encerrar websocket.`);
      
      // Verificar se o websocket para este símbolo existe no nosso gerenciador
      if (websockets.priceWebsockets && websockets.priceWebsockets[symbol]) {
        if (websockets.stopPriceMonitoring(symbol)) {
          console.log(`[MONITOR] Websocket para ${symbol} encerrado com sucesso.`);
          return true;
        } else {
          console.warn(`[MONITOR] Tentativa de encerrar websocket para ${symbol} falhou (método stopPriceMonitoring retornou false).`);
        }
      } else {
        console.log(`[MONITOR] Websocket para ${symbol} já não estava ativo ou não é gerenciado aqui.`);
      }
    } else {
      console.log(`[MONITOR] Websocket para ${symbol} mantido ativo devido a: Sinais Pendentes=${pendingSignalsCount}, Posições Abertas=${activePositionsCount}, Ordens Abertas=${pendingOrdersCount}.`);
    }
    
    return false;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar e encerrar websocket para ${symbol}: ${error.message}`, error);
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
              `Alavancagem: ${signal.leverage}x` +
              `Entrada: ${executedPrice.toFixed(pricePrecision || 2)}\n` +
              `Take Profit: ${tpPrice.toFixed(pricePrecision || 2)}\n` +
              `Stop Loss: ${slPrice.toFixed(pricePrecision || 2)}\n` +
              `Quantidade: ${formatDecimal(amountInUsdt, 2)} USDT\n`,
              telegramOptions
          );
          console.log(`[MONITOR] Notificação de execução enviada para Sinal ID ${signal.id} (reply to: ${replyToMessageId || 'N/A'}).`);
        } catch (telegramError) {
          console.error(`[MONITOR] Erro ao enviar mensagem Telegram de execução para Sinal ID ${signal.id}:`, telegramError);
        }
      }
      // --- FIM DA LÓGICA DE NOTIFICAÇÃO TELEGRAM MODIFICADA ---

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