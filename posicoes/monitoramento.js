const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getTickSize, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode, getOpenOrders, getOrderStatus, getAllOpenPositions, updateLeverageBracketsInDatabase } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, initializeDatabase, formatDateForMySQL, getBaseCalculoBalance, updateAccountBalance} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();

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
    console.log('[MONITOR] Sincronizando saldo inicial...');
    const result = await syncAccountBalance();
    if (result) {
      console.log(`\n[MONITOR] Saldo inicial: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT\n`);
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
  scheduledJobs.syncWithExchange = schedule.scheduleJob('*/1 * * * *', async () => {
    try {
      await syncWithExchange();
    } catch (error) {
      console.error('[MONITOR] Erro na sincronização periódica:', error);
    }
  });

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

    const symbols = new Set();

    // Adicionar símbolos com ordens pendentes
    pendingEntries.forEach(entry => symbols.add(entry.simbolo));

    // Adicionar símbolos com posições abertas
    openPositions.forEach(position => symbols.add(position.simbolo));

    // Iniciar websockets para cada símbolo
    for (const symbol of symbols) {
      //console.log(`[MONITOR] Iniciando monitoramento de preço para ${symbol}`);
      websockets.ensurePriceWebsocketExists(symbol);
    }

  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
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
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const {
      id,
      symbol,
      side,
      leverage,
      capital_pct,
      entry_price,
      tp_price,
      sl_price,
      chat_id,
      timeframe
    } = signal;

    console.log(`[MONITOR] Processando sinal para ${symbol}: ${side} a ${entry_price}`);

    // 1. Verificar se já existe uma posição aberta para este símbolo
    const positionExists = await checkPositionExists(db, symbol);
    if (positionExists) {
      console.log(`[MONITOR] Já existe uma posição aberta para ${symbol}. Ignorando sinal.`);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Posição já existe' WHERE id = ?`,
          [id]
      );
      await connection.commit();
      return;
    }

    // 2. Configurar alavancagem e tipo de margem
    try {
      await changeInitialLeverage(symbol, parseInt(leverage));
      try {
        await changeMarginType(symbol, 'CROSSED');
      } catch (marginError) {
        // Verificar se é o erro específico de "já está configurado"
        if (marginError.response &&
            marginError.response.data &&
            marginError.response.data.code === -4046) {
          console.log(`[MONITOR] Margem já configurada como CROSSED para ${symbol}, continuando...`);
        } else {
          // Se for outro erro, propagar
          throw marginError;
        }
      }
    } catch (error) {
      console.error(`[MONITOR] Erro ao configurar alavancagem/margem para ${symbol}:`, error);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [`Erro na alavancagem: ${error.message}`, id]
      );
      await connection.commit();
      return;
    }

    // 3. Criar entrada no banco para posição com status PENDING_ENTRY
    const positionData = {
      simbolo: symbol,
      quantidade: 0, // Será atualizado quando a ordem for preenchida
      preco_medio: parseFloat(entry_price),
      status: 'PENDING_ENTRY', // Novo status para aguardar acionamento da entrada
      data_hora_abertura: new Date().toISOString(),
      side: side === 'COMPRA' ? 'BUY' : 'SELL',
      leverage: parseInt(leverage),
      data_hora_ultima_atualizacao: new Date().toISOString(),
      preco_entrada: parseFloat(entry_price),
      preco_corrente: parseFloat(entry_price),
      orign_sig: `WEBHOOK_${id}`
    };

    const positionId = await insertPosition(connection, positionData);

    if (!positionId) {
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Falha ao inserir posição' WHERE id = ?`,
          [id]
      );
      await connection.commit();
      return;
    }

    // 4. Atualizar webhook_signals para AGUARDANDO_ACIONAMENTO
    await connection.query(
        `UPDATE webhook_signals SET
                                  status = 'AGUARDANDO_ACIONAMENTO',
                                  position_id = ?
         WHERE id = ?`,
        [positionId, id]
    );

    // 5. Iniciar monitoramento de preço para este símbolo
    websockets.ensurePriceWebsocketExists(symbol);

    // 6. Enviar confirmação ao Telegram se chat_id estiver disponível
    if (chat_id) {
      try {
        const triggerCondition = side === 'COMPRA'
            ? `preço acima de ${entry_price}`
            : `preço abaixo de ${entry_price}`;

        await bot.telegram.sendMessage(chat_id,
            `🔄 Sinal registrado para ${symbol}\n\n` +
            `Direção: ${side}\n` +
            `Entrada será acionada quando: ${triggerCondition}\n` +
            `TP: ${tp_price}\n` +
            `SL: ${sl_price}\n` +
            `Alavancagem: ${leverage}x`
        );
      } catch (telegramError) {
        console.error(`[MONITOR] Erro ao enviar mensagem Telegram:`, telegramError);
      }
    }

    await connection.commit();
    console.log(`[MONITOR] Sinal para ${symbol} registrado com sucesso. Aguardando acionamento.`);

  } catch (error) {
    console.error('[MONITOR] Erro ao processar sinal:', error);
    await connection.rollback();
  } finally {
    connection.release();
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
            true,            // reduceOnly = true
            false            // closePosition = false
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
            true,     // reduceOnly = true
            false     // closePosition = false
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

// Verifique também se a função onPriceUpdate está definida
async function onPriceUpdate(symbol, currentPrice, relevantTrades, positions) {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error(`[PRICE UPDATE] Não foi possível obter conexão com o banco de dados`);
      return;
    }

    // Log para depuração
    console.log(`[PRICE UPDATE] Símbolo: ${symbol}, Preço atual: ${currentPrice}`);

    // PARTE 1: Verificar entradas pendentes para acionar
    // Buscar posições em status PENDING_ENTRY para este símbolo
    const [pendingEntries] = await db.query(`
      SELECT p.id as position_id, p.side, p.preco_entrada, p.simbolo,
             w.id as webhook_id, w.sl_price, w.tp_price, w.leverage, w.capital_pct, w.chat_id
      FROM posicoes p
             JOIN webhook_signals w ON w.position_id = p.id
      WHERE p.simbolo = ?
        AND p.status = 'PENDING_ENTRY'
        AND w.status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);

    // Log para depuração - número de entradas pendentes encontradas
    console.log(`[PRICE UPDATE] Encontradas ${pendingEntries.length} entradas pendentes para ${symbol}`);

    // Processar cada entrada pendente
    for (const entry of pendingEntries) {
      const entryPrice = parseFloat(entry.preco_entrada);
      const slPrice = parseFloat(entry.sl_price);
      const tpPrice = parseFloat(entry.tp_price);
      const side = entry.side;

      console.log(`[PRICE UPDATE] Avaliando entrada pendente: ${entry.simbolo}, Side: ${side}, Preço entrada: ${entryPrice}, Preço atual: ${currentPrice}`);

      // Verificar se o preço ultrapassou o nível de entrada
      // Side pode estar como "COMPRA"/"VENDA" ou "BUY"/"SELL" - normalizar
      const normalizedSide = side.toUpperCase();
      const isBuy = normalizedSide === 'BUY' || normalizedSide === 'COMPRA';
      const isSell = normalizedSide === 'SELL' || normalizedSide === 'VENDA';

      const shouldTrigger = (isBuy && currentPrice > entryPrice) ||
          (isSell && currentPrice < entryPrice);

      // Verificar se SL foi atingido (cancelar a entrada)
      const slHit = (isBuy && currentPrice <= slPrice) ||
          (isSell && currentPrice >= slPrice);

      // Verificar se TP foi atingido (cancelar a entrada)
      const tpHit = (isBuy && currentPrice >= tpPrice) ||
          (isSell && currentPrice <= tpPrice);

      console.log(`[PRICE UPDATE] Condições: shouldTrigger=${shouldTrigger}, slHit=${slHit}, tpHit=${tpHit}`);

      if (shouldTrigger) {
        console.log(`[PRICE UPDATE] ✅ Preço ${currentPrice} atingiu nível para acionar entrada ${side} a ${entryPrice} para ${symbol}`);
        // Acionar a entrada a mercado
        await triggerMarketEntry(db, entry, currentPrice);
      }
      else if (slHit) {
        console.log(`[PRICE UPDATE] ❌ SL ${slPrice} atingido antes da entrada ser acionada para ${symbol}. Preço atual: ${currentPrice}`);
        // Cancelar a entrada porque SL foi atingido
        await cancelPendingEntry(db, entry.position_id, 'SL ATINGIDO',
            `Stop loss (${slPrice}) atingido antes da entrada ser acionada. Preço atual: ${currentPrice}`);
      }
      else if (tpHit) {
        console.log(`[PRICE UPDATE] ❌ TP ${tpPrice} atingido antes da entrada ser acionada para ${symbol}. Preço atual: ${currentPrice}`);
        // Cancelar a entrada porque TP foi atingido
        await cancelPendingEntry(db, entry.position_id, 'TP ATINGIDO',
            `Take profit (${tpPrice}) atingido antes da entrada ser acionada. Preço atual: ${currentPrice}`);
      }
    }

    // PARTE 2: Verificar ordens de entrada pendentes tradicionais (código existente)
    const [pendingOrders] = await db.query(`
      SELECT o.*, p.id as position_id, p.status as position_status,
             w.tp_price, w.sl_price, w.side, w.chat_id
      FROM ordens o
             JOIN posicoes p ON o.id_posicao = p.id
             LEFT JOIN webhook_signals w ON w.position_id = p.id
      WHERE o.simbolo = ?
        AND o.tipo_ordem_bot = 'ENTRADA'
        AND o.status = 'OPEN'
        AND (p.status = 'PENDING' OR p.status = 'OPEN')
      ORDER BY o.data_hora_criacao DESC
    `, [symbol]);

    // 2. Para cada ordem de entrada, verificar se TP ou SL foi atingido antes da entrada
    for (const entry of pendingOrders) {
      const entryPrice = parseFloat(entry.preco);
      const tpPrice = parseFloat(entry.tp_price);
      const slPrice = parseFloat(entry.sl_price);
      const side = entry.side === 'COMPRA' ? 'BUY' : 'SELL';

      // VERIFICAÇÃO DO TP (código existente)
      if ((side === 'BUY' && currentPrice >= tpPrice) ||
          (side === 'SELL' && currentPrice <= tpPrice)) {

        console.log(`[PRICE UPDATE] TP atingido antes da entrada para ${symbol}`);
        console.log(`[PRICE UPDATE] Preço atual: ${currentPrice}, TP: ${tpPrice}, Entrada: ${entryPrice}`);

        // Verificar se já processamos esta ordem
        if (cancelledOrders.has(entry.id_externo)) {
          console.log(`[PRICE UPDATE] Ordem ${entry.id_externo} já cancelada anteriormente`);
          continue;
        }

        // Cancelar a ordem na corretora
        try {
          await cancelOrder(entry.id_externo, symbol);
          cancelledOrders.add(entry.id_externo);

          // Atualizar status da ordem para CANCELED
          await updateOrderStatus(db, entry.id, 'CANCELED');

          // Mover para histórico com motivo
          await movePositionToHistory(db, entry.position_id, 'CANCELED', 'TP_REACHED_BEFORE_ENTRY');

          // Atualizar webhook_signal
          await db.query(`
            UPDATE webhook_signals
            SET status = 'CANCELED',
                error_message = 'TP atingido antes da entrada'
            WHERE position_id = ?
          `, [entry.position_id]);

          // Enviar notificação ao Telegram (se configurado)
          if (entry.chat_id) {
            try {
              await bot.telegram.sendMessage(entry.chat_id,
                  `⚠️ Ordem para ${symbol} CANCELADA ⚠️\n\n` +
                  `O preço-alvo (${tpPrice}) foi atingido antes do ponto de entrada (${entryPrice}).\n\n` +
                  `Preço atual: ${currentPrice}`
              );
            } catch (telegramError) {
              console.error(`[PRICE UPDATE] Erro ao enviar notificação Telegram:`, telegramError);
            }
          }
        } catch (error) {
          console.error(`[PRICE UPDATE] Erro ao cancelar ordem ${entry.id_externo}:`, error);
        }
      }

      // NOVA VERIFICAÇÃO DO SL
      else if ((side === 'BUY' && currentPrice <= slPrice) ||
          (side === 'SELL' && currentPrice >= slPrice)) {

        console.log(`[PRICE UPDATE] SL atingido antes da entrada para ${symbol}`);
        console.log(`[PRICE UPDATE] Preço atual: ${currentPrice}, SL: ${slPrice}, Entrada: ${entryPrice}`);

        // Verificar se já processamos esta ordem
        if (cancelledOrders.has(entry.id_externo)) {
          console.log(`[PRICE UPDATE] Ordem ${entry.id_externo} já cancelada anteriormente`);
          continue;
        }

        // Cancelar a ordem na corretora
        try {
          await cancelOrder(entry.id_externo, symbol);
          cancelledOrders.add(entry.id_externo);

          // Atualizar status da ordem para CANCELED
          await updateOrderStatus(db, entry.id, 'CANCELED');

          // Mover para histórico com motivo
          await movePositionToHistory(db, entry.position_id, 'CANCELED', 'SL_REACHED_BEFORE_ENTRY');

          // Atualizar webhook_signal
          await db.query(`
            UPDATE webhook_signals
            SET status = 'CANCELED',
                error_message = 'SL atingido antes da entrada'
            WHERE position_id = ?
          `, [entry.position_id]);

          // Enviar notificação ao Telegram (se configurado)
          if (entry.chat_id) {
            try {
              await bot.telegram.sendMessage(entry.chat_id,
                  `⚠️ Ordem para ${symbol} CANCELADA ⚠️\n\n` +
                  `O stop loss (${slPrice}) foi atingido antes do ponto de entrada (${entryPrice}).\n\n` +
                  `Preço atual: ${currentPrice}`
              );
            } catch (telegramError) {
              console.error(`[PRICE UPDATE] Erro ao enviar notificação Telegram:`, telegramError);
            }
          }
        } catch (error) {
          console.error(`[PRICE UPDATE] Erro ao cancelar ordem ${entry.id_externo}:`, error);
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao processar atualização de preço:`, error);
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

      // 5. Registrar ordem de entrada no banco
      const orderData = {
        tipo_ordem: 'MARKET',
        preco: executedPrice,
        quantidade: executedQty,
        id_posicao: entry.position_id,
        status: 'FILLED', // Já preenchida por ser ordem de mercado
        data_hora_criacao: new Date().toISOString(),
        id_externo: orderId,
        side: binanceSide,
        simbolo: entry.simbolo,
        tipo_ordem_bot: 'ENTRADA',
        target: null,
        reduce_only: false,
        close_position: false,
        last_update: new Date().toISOString(),
        orign_sig: position.orign_sig
      };

      await insertNewOrder(connection, orderData);

      // 6. Atualizar status da posição para OPEN
      await connection.query(
          `UPDATE posicoes SET
                             status = 'OPEN',
                             quantidade = ?,
                             preco_medio = ?,
                             data_hora_ultima_atualizacao = ?
           WHERE id = ?`,
          [executedQty, executedPrice, new Date().toISOString(), entry.position_id]
      );

      // 7. Atualizar webhook_signals
      await connection.query(
          `UPDATE webhook_signals SET
                                    status = 'EXECUTADO',
                                    entry_order_id = ?
           WHERE id = ?`,
          [orderId, entry.webhook_id]
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
            true,           // reduceOnly = true
            false           // closePosition = false
        );

        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada: ${slResponse.data.orderId}`);

        // Registrar ordem SL no banco
        const slOrderData = {
          tipo_ordem: 'STOP_MARKET',
          preco: slPriceVal,
          quantidade: executedQty,
          id_posicao: entry.position_id,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: slResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: entry.simbolo,
          tipo_ordem_bot: 'STOP_LOSS',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: new Date().toISOString(),
          orign_sig: position.orign_sig
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
            true,            // reduceOnly = true
            false            // closePosition = false
        );

        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada: ${tpResponse.data.orderId}`);

        // Registrar ordem TP no banco
        const tpOrderData = {
          tipo_ordem: 'TAKE_PROFIT_MARKET',
          preco: tpPriceVal,
          quantidade: executedQty,
          id_posicao: entry.position_id,
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
          orign_sig: position.orign_sig
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
              `✅ Entrada ACIONADA para ${entry.simbolo}\n\n` +
              `Direção: ${position.side}\n` +
              `Preço de execução: ${executedPrice}\n` +
              `TP: ${tpPriceVal}\n` +
              `SL: ${slPriceVal}\n` +
              `Quantidade: ${executedQty}\n` +
              `Alavancagem: ${entry.leverage}x`
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

    // PARTE 1: Verificar entradas pendentes com timeout baseado no timeframe
    const [pendingEntries] = await db.query(`
      SELECT p.id as position_id, p.simbolo, p.side, p.preco_entrada, p.data_hora_abertura,
             w.id as webhook_id, w.timeframe, w.chat_id
      FROM posicoes p
             JOIN webhook_signals w ON w.position_id = p.id
      WHERE p.simbolo = ?
        AND p.status = 'PENDING_ENTRY'
        AND w.status = 'AGUARDANDO_ACIONAMENTO'
        AND w.timeframe IS NOT NULL AND w.timeframe != ''
    `, [symbol]);

    const now = new Date();
    let cancelCount = 0;

    for (const entry of pendingEntries) {
      // Pular se não tiver timeframe
      if (!entry.timeframe) continue;

      // Calcular o tempo máximo de vida da entrada (3x o timeframe)
      const timeframeMs = timeframeToMs(entry.timeframe);
      const maxLifetimeMs = timeframeMs * 3;

      // Se o timeframe não for válido ou for zero, pular
      if (maxLifetimeMs <= 0) {
        console.log(`[MONITOR] Timeframe inválido para posição ${entry.position_id}: ${entry.timeframe}`);
        continue;
      }

      // Calcular há quanto tempo a entrada foi criada
      const createdAt = new Date(entry.data_hora_abertura);
      const entryAgeMs = now.getTime() - createdAt.getTime();

      // Se a entrada estiver expirada (idade > 3x timeframe)
      if (entryAgeMs > maxLifetimeMs) {
        console.log(`[MONITOR] Entrada pendente para ${entry.simbolo} expirada por timeout`);
        console.log(`[MONITOR] Idade: ${(entryAgeMs / (60 * 1000)).toFixed(2)} min, Máximo: ${(maxLifetimeMs / (60 * 1000)).toFixed(2)} min (${entry.timeframe} * 3)`);

        // Cancelar a entrada pendente
        await cancelPendingEntry(db, entry.position_id, 'TIMEOUT',
            `Entrada não acionada dentro do limite de tempo (${entry.timeframe} * 3)`);

        cancelCount++;
      }
    }

    // PARTE 2: Verificar ordens abertas de entrada (código existente)
    // ...

    if (cancelCount > 0) {
      console.log(`[MONITOR] ${cancelCount} entradas pendentes canceladas por timeout de timeframe`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar ordens expiradas:', error);
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
    console.log('[MONITOR] Obtendo saldo atualizado da corretora...');
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');

    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na corretora');
    }

    // Obter o valor do saldo disponível
    const realSaldo = parseFloat(usdtBalance.availableBalance);

    console.log(`[MONITOR] Saldo real na corretora: ${realSaldo.toFixed(2)} USDT`);

    // Obter saldo atual e base de cálculo do banco
    const [currentBalance] = await db.query('SELECT saldo, saldo_base_calculo FROM conta WHERE id = 1');

    const currentSaldo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo || 0) : 0;
    const currentBaseCalculo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo_base_calculo || 0) : 0;

    console.log(`[MONITOR] Saldo atual no banco: ${currentSaldo.toFixed(2)} USDT | Base Cálculo: ${currentBaseCalculo.toFixed(2)} USDT`);

    // Atualizar saldo no banco de dados e possivelmente o saldo_base_calculo
    // A função updateAccountBalance já implementa a lógica de só aumentar o saldo_base_calculo
    const result = await updateAccountBalance(db, realSaldo);

    if (result) {
      console.log(`[MONITOR] Saldo atualizado para: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT`);

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

  console.log(`[MONITOR] Convertendo timeframe: ${timeframe}`);

  // Extrair número e unidade
  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) {
    console.log(`[MONITOR] Formato de timeframe inválido: ${timeframe}`);
    return 0;
  }

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  // Converter para milissegundos com base na unidade
  let result = 0;
  switch(unit) {
    case 'm': result = numValue * 60 * 1000; break; // minutos
    case 'h': result = numValue * 60 * 60 * 1000; break; // horas
    case 'd': result = numValue * 24 * 60 * 60 * 1000; break; // dias
    case 'w': result = numValue * 7 * 24 * 60 * 60 * 1000; break; // semanas
    case 'M': result = numValue * 30 * 24 * 60 * 60 * 1000; break; // meses (aproximado)
    default: result = 0;
  }

  console.log(`[MONITOR] Timeframe ${timeframe} convertido para ${result}ms (${result/(60*1000)} minutos)`);
  return result;
}

// NOVA FUNÇÃO: Verificar e corrigir sinais pendentes
async function checkAndFixPendingSignals() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // 1. Verificar registros com datas futuras
    const [futureRecords] = await db.query(`
      SELECT id, symbol, created_at, status
      FROM webhook_signals
      WHERE created_at > NOW()
         OR updated_at > NOW()
    `);

    console.log(`[FIX] Encontrados ${futureRecords.length} registros com datas futuras`);

    // 2. Corrigir datas futuras
    for (const record of futureRecords) {
      console.log(`[FIX] Corrigindo registro ${record.id} (${record.symbol}) com data futura: ${record.created_at}`);
      await db.query(`
        UPDATE webhook_signals
        SET created_at = NOW(), updated_at = NOW()
        WHERE id = ?
      `, [record.id]);
    }

    // 3. Verificar registros pendentes que nunca foram processados
    const [pendingRecords] = await db.query(`
      SELECT id, symbol, created_at, status
      FROM webhook_signals
      WHERE status = 'PENDING'
        AND created_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
    `);

    console.log(`[FIX] Encontrados ${pendingRecords.length} registros pendentes antigos (>1h)`);

    // 4. Resetar registros pendentes antigos para serem reprocessados
    for (const record of pendingRecords) {
      console.log(`[FIX] Resetando registro ${record.id} (${record.symbol}) pendente desde: ${record.created_at}`);
      await db.query(`
        UPDATE webhook_signals
        SET updated_at = NOW()
        WHERE id = ?
      `, [record.id]);
    }

    console.log(`[FIX] Correção concluída. Registros atualizados.`);
  } catch (error) {
    console.error('[FIX] Erro ao verificar e corrigir registros:', error);
  }
}

// Executar a função
checkAndFixPendingSignals().then(() => {
  console.log('[FIX] Verificação concluída');
}).catch(err => {
  console.error('[FIX] Erro:', err);
});

// Iniciar o monitoramento automaticamente quando o script for executado
(async () => {
  try {
    console.log('[MONITOR] Iniciando sistema de monitoramento...');
    await initializeMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao inicializar monitoramento:', error);
  }
})();