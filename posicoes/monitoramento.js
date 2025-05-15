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
  console.log('[MONITOR] Inicializando sistema de monitoramento...');
  
  // Sincronizar saldo da conta - ADICIONADO
  try {
    console.log('[MONITOR] Sincronizando saldo da conta com a corretora...');
    const result = await syncAccountBalance();
    if (result) {
      console.log(`[MONITOR] Saldo: ${result.saldo.toFixed(2)} USDT Saldo Base Calculo: ${result.saldo_base_calculo.toFixed(2)} USDT`);
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
      chat_id
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
    
    // 3. Criar entrada no banco para posição
    const positionData = {
      simbolo: symbol,
      quantidade: 0, // Será atualizado quando a ordem for preenchida
      preco_medio: parseFloat(entry_price),
      status: 'PENDING',
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
    
    // 4. Calcular tamanho da ordem
    const { quantityPrecision } = await getPrecision(symbol);
    
    // Obter saldo disponível (implementar esta função conforme sua lógica de negócio)
    const availableBalance = await getAvailableBalance();
    
    // Calcular quantidade baseada na alavancagem e % do capital
    const orderSize = calculateOrderSize(
      availableBalance,
      parseFloat(capital_pct) / 100,
      parseFloat(entry_price),
      parseInt(leverage),
      quantityPrecision
    );
    
    // 5. Criar e enviar ordem de entrada para a corretora
    try {
      const binanceSide = side === 'COMPRA' ? 'BUY' : 'SELL';
      const orderResponse = await newOrder(
        symbol,
        orderSize,
        binanceSide,
        parseFloat(entry_price),
        'LIMIT'
      );
      
      if (!orderResponse || !orderResponse.data || !orderResponse.data.orderId) {
        throw new Error('Resposta inválida da corretora');
      }
      
      const orderId = orderResponse.data.orderId;
      
      // 6. Registrar ordem de entrada no banco
      const orderData = {
        tipo_ordem: 'LIMIT',
        preco: parseFloat(entry_price),
        quantidade: parseFloat(orderSize),
        id_posicao: positionId,
        status: 'OPEN',
        data_hora_criacao: new Date().toISOString(),
        id_externo: orderId,
        side: binanceSide,
        simbolo: symbol,
        tipo_ordem_bot: 'ENTRADA',
        target: null,
        reduce_only: false,
        close_position: false,
        last_update: new Date().toISOString(),
        orign_sig: `WEBHOOK_${id}`
      };
      
      await insertNewOrder(connection, orderData);
      
      // 7.1. Criar e enviar ordens de SL/TP imediatamente após a entrada
      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const tpPriceVal = parseFloat(tp_price);
      const slPriceVal = parseFloat(sl_price);

      let slResponse = null;
      let tpResponse = null;

      // Criar ordem SL
      try {
        const slResponse = await newStopOrder(
          symbol,
          parseFloat(orderSize),
          binanceOppositeSide,
          slPriceVal,
          null,           // price = null para STOP_MARKET
          true,           // reduceOnly = true
          false           // closePosition = false
        );
        
        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada na corretora: ${slResponse.data.orderId}`);
        
        // Registrar ordem SL no banco
        const slOrderData = {
          tipo_ordem: 'STOP_MARKET', 
          preco: slPriceVal,
          quantidade: parseFloat(orderSize),
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: slResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: symbol,
          tipo_ordem_bot: 'STOP_LOSS',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${id}`
        };
        
        await insertNewOrder(connection, slOrderData);
      } catch (slError) {
        console.error(`[MONITOR] Erro ao criar ordem SL: ${slError.message}`);
      }

      // Criar ordem TP
      try {
        const tpResponse = await newStopOrder(
          symbol,
          parseFloat(orderSize),
          binanceOppositeSide,
          tpPriceVal,
          tpPriceVal,      // price igual a stopPrice para TAKE_PROFIT_MARKET
          true,            // reduceOnly = true
          false            // closePosition = false
        );
        
        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada na corretora: ${tpResponse.data.orderId}`);
        
        // Registrar ordem TP no banco
        const tpOrderData = {
          tipo_ordem: 'TAKE_PROFIT_MARKET',
          preco: tpPriceVal,
          quantidade: parseFloat(orderSize),
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: tpResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: symbol,
          tipo_ordem_bot: 'TAKE_PROFIT',
          target: null,
          reduce_only: true,
          close_position: false,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${id}`
        };
        
        await insertNewOrder(connection, tpOrderData);
      } catch (tpError) {
        console.error(`[MONITOR] Erro ao criar ordem TP: ${tpError.message}`);
      }

      // Criar variável para contar ordens criadas (opcional)
      let createdOrdersCount = 1; // Já temos a ordem de entrada
      if (slResponse && slResponse.data) createdOrdersCount++;
      if (tpResponse && tpResponse.data) createdOrdersCount++;
      console.log(`[MONITOR] Total de ordens criadas: ${createdOrdersCount}`);

      // 7. Atualizar status do sinal no webhook
      await connection.query(
        `UPDATE webhook_signals SET 
         status = 'ENVIADO', 
         position_id = ?, 
         entry_order_id = ? 
         WHERE id = ?`, 
        [positionId, orderId, id]
      );
      
      // 8. Iniciar monitoramento de preço para este símbolo
      websockets.ensurePriceWebsocketExists(symbol);
      
      // 9. Enviar confirmação ao Telegram se chat_id estiver disponível
      if (chat_id) {
        try {
          await bot.telegram.sendMessage(chat_id, 
            `✅ Ordem enviada para ${symbol}\n\n` +
            `Direção: ${side}\n` +
            `Entrada: ${entry_price}\n` +
            `TP: ${tp_price}\n` +
            `SL: ${sl_price}\n` +
            `Alavancagem: ${leverage}x`
          );
        } catch (telegramError) {
          console.error(`[MONITOR] Erro ao enviar mensagem Telegram:`, telegramError);
        }
      }
      
      await connection.commit();
      console.log(`[MONITOR] Ordem de entrada para ${symbol} criada com sucesso. ID: ${orderId}`);
      
      // Sincronizar saldo após criar ordem - ADICIONADO
      try {
        await syncAccountBalance();
      } catch (syncError) {
        console.error('[MONITOR] Erro ao sincronizar saldo após criar ordem:', syncError);
      }
      
    } catch (orderError) {
      console.error(`[MONITOR] Erro ao criar ordem para ${symbol}:`, orderError);
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`, 
        [`Erro ao criar ordem: ${orderError.message}`, id]
      );
      await connection.rollback();
    }
    
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
    // Em vez de usar o parâmetro relevantTrades, buscar do banco de dados
    const db = await getDatabaseInstance();
    if (!db) {
      console.error(`[PRICE UPDATE] Não foi possível obter conexão com o banco de dados`);
      return;
    }
    
    // 1. Buscar ordens de entrada pendentes para este símbolo
    const [pendingEntries] = await db.query(`
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
    
    // 2. Para cada ordem de entrada, verificar se TP foi atingido antes da entrada
    for (const entry of pendingEntries) {
      const entryPrice = parseFloat(entry.preco);
      const tpPrice = parseFloat(entry.tp_price);
      const side = entry.side === 'COMPRA' ? 'BUY' : 'SELL';
      
      // Verificar se o TP foi atingido antes da entrada
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
          console.error(`[PRICE UPDATE] Erro ao cancelar ordem ${entry.id_externo}: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao processar atualização de preço: ${error}`);
  }
}

// Função para verificar e fechar o WebSocket se não houver mais posições/ordens para um símbolo
async function checkAndCloseWebsocket(db, symbol) {
  try {
    // Verificar se ainda existem posições abertas para este símbolo
    const [openPositions] = await db.query(
      `SELECT COUNT(*) as count FROM posicoes 
       WHERE simbolo = ? AND (status = 'OPEN' OR status = 'PENDING')`,
      [symbol]
    );
    
    // Verificar se ainda existem ordens abertas para este símbolo
    const [openOrders] = await db.query(
      `SELECT COUNT(*) as count FROM ordens 
       WHERE simbolo = ? AND status = 'OPEN'`,
      [symbol]
    );
    
    const hasOpenPositions = openPositions[0].count > 0;
    const hasOpenOrders = openOrders[0].count > 0;
    
    // Se não houver posições ou ordens abertas, podemos fechar o WebSocket
    if (!hasOpenPositions && !hasOpenOrders) {
      console.log(`[MONITOR] Fechando monitoramento de preço para ${symbol} - não há mais posições/ordens ativas`);
      websockets.stopPriceMonitoring(symbol);
      return true; // Monitoramento encerrado
    }
    
    return false; // Monitoramento mantido
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar monitoramento para ${symbol}: ${error}`);
    return false;
  }
}

// Função para sincronizar ordens e posições
async function syncWithExchange() {
  //console.log('[MONITOR] Iniciando sincronização com a corretora...');
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }
    
    // 1. Sincronizar ordens (orders com mais de 1 minuto)
    await syncOrders(db);
    
    // 2. Sincronizar posições (após sincronizar ordens)
    await syncPositions(db);
    
    //console.log('[MONITOR] Sincronização com corretora concluída');
  } catch (error) {
    console.error('[MONITOR] Erro na sincronização com a corretora:', error);
  }
}

// Sincronização de ordens
async function syncOrders(db) {
  try {
    // Buscar ordens no banco com mais de 1 minuto
    const [dbOrders] = await db.query(`
      SELECT * FROM ordens 
      WHERE status = 'OPEN' 
      AND data_hora_criacao < DATE_SUB(NOW(), INTERVAL 1 MINUTE)
    `);
    
    if (dbOrders.length === 0) {
      //console.log('[MONITOR] Nenhuma ordem antiga para verificar');
      return;
    }
    
    console.log(`[MONITOR] Verificando ${dbOrders.length} ordens antigas no banco`);
    
    // Agrupar ordens por símbolo para otimizar chamadas à API
    const ordersBySymbol = dbOrders.reduce((acc, order) => {
      if (!acc[order.simbolo]) acc[order.simbolo] = [];
      acc[order.simbolo].push(order);
      return acc;
    }, {});
    
    // Processar cada símbolo
    for (const symbol of Object.keys(ordersBySymbol)) {
      // Obter ordens abertas deste símbolo na corretora
      const exchangeOrders = await getOpenOrders(symbol);
      const exchangeOrdersMap = new Map(
        exchangeOrders.map(order => [order.orderId.toString(), order])
      );
      
      // Verificar cada ordem do banco
      for (const dbOrder of ordersBySymbol[symbol]) {
        // Se a ordem não existe na corretora ou tem status terminal
        if (!exchangeOrdersMap.has(dbOrder.id_externo)) {
          console.log(`[SYNC] Ordem ${dbOrder.id_externo} não encontrada na corretora ou já concluída`);
          
          // Verificar status real na corretora (para ordens recentes)
          try {
            const orderStatus = await getOrderStatus(dbOrder.id_externo, symbol);
            if (orderStatus && ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(orderStatus)) {
              console.log(`[SYNC] Ordem ${dbOrder.id_externo} com status ${orderStatus} na corretora`);
              
              // Atualizar status no banco
              await updateOrderStatus(db, dbOrder.id, orderStatus);
              
              // Se preenchida e ordem de entrada, atualizar status da posição
              if (orderStatus === 'FILLED' && dbOrder.tipo_ordem_bot === 'ENTRADA') {
                await updatePositionStatus(db, symbol, { status: 'OPEN' });
              }
              
              // Se posição associada estiver fechada ou ordem não for de entrada, mover para histórico
              const [positionInfo] = await db.query(
                'SELECT status FROM posicoes WHERE id = ?', 
                [dbOrder.id_posicao]
              );
              
              if (positionInfo.length > 0 && 
                  (positionInfo[0].status === 'CLOSED' || dbOrder.tipo_ordem_bot !== 'ENTRADA')) {
                await moveOrderToHistory(db, dbOrder.id);
              }
            } else {
              // Ordem não existe mais e não tem status definido, marcar como cancelada
              await updateOrderStatus(db, dbOrder.id, 'CANCELED');
              await moveOrderToHistory(db, dbOrder.id);
            }
          } catch (error) {
            console.error(`[SYNC] Erro ao verificar status da ordem ${dbOrder.id_externo}:`, error);
          }
        }
      }
    }
  } catch (error) {
    console.error('[SYNC] Erro ao sincronizar ordens:', error);
  }
}

// Sincronização de posições
async function syncPositions(db) {
  try {
    // Buscar posições abertas no banco com mais de 1 minuto
    const [dbPositions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE status = 'OPEN' 
      AND data_hora_abertura < DATE_SUB(NOW(), INTERVAL 1 MINUTE)
    `);
    
    if (dbPositions.length === 0) {
      return;
    }
    
    console.log(`[MONITOR] Verificando ${dbPositions.length} posições antigas no banco`);
    
    // Verificar cada posição do banco
    for (const dbPosition of dbPositions) {
      const symbol = dbPosition.simbolo;
      
      try {
        // Verificar se a posição existe na corretora
        const exchangePositions = await getAllOpenPositions(symbol);
        const positionExists = exchangePositions && exchangePositions.length > 0;
        
        // Verificar se há uma ordem de entrada preenchida
        const [entryOrders] = await db.query(
          `SELECT * FROM ordens 
           WHERE id_posicao = ? AND tipo_ordem_bot = 'ENTRADA' 
           AND status = 'FILLED' AND reduce_only = 0`,
          [dbPosition.id]
        );
        
        const hasFilledEntry = entryOrders.length > 0;
        
        // Se há uma ordem de entrada preenchida mas a posição não existe na corretora
        if (hasFilledEntry && !positionExists) {
          console.log(`[SYNC] Posição ${symbol} (ID: ${dbPosition.id}) foi encerrada manualmente na corretora`);
          
          // 1. Verificar ordens abertas na corretora para este símbolo
          const exchangeOrders = await getOpenOrders(symbol);
          
          // 2. Cancelar ordens abertas na corretora
          if (exchangeOrders && exchangeOrders.length > 0) {
            console.log(`[SYNC] Cancelando ${exchangeOrders.length} ordens abertas na corretora para ${symbol}`);
            
            for (const order of exchangeOrders) {
              try {
                await cancelOrder(order.orderId, symbol);
                console.log(`[SYNC] Ordem ${order.orderId} cancelada com sucesso`);
              } catch (cancelError) {
                console.error(`[SYNC] Erro ao cancelar ordem ${order.orderId}: ${cancelError.message}`);
              }
            }
          }
          
          // 3. Verificar e atualizar status de ordens no banco de dados
          const [activeOrders] = await db.query(
            'SELECT id, id_externo FROM ordens WHERE id_posicao = ? AND status = "OPEN"',
            [dbPosition.id]
          );
          
          if (activeOrders.length > 0) {
            console.log(`[SYNC] Atualizando ${activeOrders.length} ordens ativas no banco para ${symbol}`);
            
            for (const order of activeOrders) {
              try {
                await moveOrderToHistory(db, order.id);
                console.log(`[SYNC] Ordem ${order.id} movida para histórico`);
              } catch (error) {
                console.error(`[SYNC] Erro ao mover ordem ${order.id}: ${error.message}`);
              }
            }
          }
          
          // 4. Mover a posição para fechadas
          try {
            await movePositionToHistory(db, dbPosition.id, 'CLOSED', 'MANUALLY_CLOSED_ON_EXCHANGE');
            console.log(`[SYNC] Posição ${dbPosition.id} (${symbol}) movida para histórico - fechada manualmente`);
          } catch (error) {
            console.error(`[SYNC] Erro ao mover posição ${dbPosition.id}: ${error.message}`);
          }
        }
        // Verificar posições que não existem na corretora (lógica original)
        else if (!positionExists) {
          console.log(`[SYNC] Posição para ${symbol} não encontrada na corretora`);
          
          // Verificar se todas as ordens desta posição estão fechadas ou podem ser fechadas
          const [activeOrders] = await db.query(
            'SELECT id, id_externo FROM ordens WHERE id_posicao = ? AND status = "OPEN"',
            [dbPosition.id]
          );
          
          if (activeOrders.length > 0) {
            console.log(`[SYNC] Posição ${dbPosition.id} ainda tem ${activeOrders.length} ordens ativas`);
            
            // Verificar cada ordem ativa
            for (const order of activeOrders) {
              try {
                await moveOrderToHistory(db, order.id);
                console.log(`[SYNC] Ordem ${order.id} movida para histórico`);
              } catch (error) {
                console.error(`[SYNC] Erro ao mover ordem ${order.id}: ${error.message}`);
              }
            }
          }
          
          // Agora podemos mover a posição para histórico
          try {
            await movePositionToHistory(db, dbPosition.id, 'CLOSED', 'CLOSED_ON_EXCHANGE');
            console.log(`[SYNC] Posição ${dbPosition.id} (${symbol}) movida para histórico`);
          } catch (error) {
            console.error(`[SYNC] Erro ao mover posição ${dbPosition.id}: ${error.message}`);
          }
        }
      } catch (error) {
        console.error(`[SYNC] Erro ao processar símbolo ${symbol}: ${error.message}`);
        // Continuar com o próximo símbolo em vez de interromper toda a sincronização
        continue;
      }
    }
  } catch (error) {
    console.error('[SYNC] Erro ao sincronizar posições:', error);
    throw error;
  }
}

// Função auxiliar para mover uma ordem para histórico
async function moveOrderToHistory(db, orderId) {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // 1. Obter dados da ordem
    const [orderData] = await connection.query('SELECT * FROM ordens WHERE id = ?', [orderId]);
    if (orderData.length === 0) {
      throw new Error(`Ordem ${orderId} não encontrada`);
    }
    
    // 2. Inserir na tabela histórica
    const order = orderData[0];
    await connection.query(
      `INSERT INTO ordens_fechadas 
       (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
        id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
        last_update, renew_sl_firs, renew_sl_seco, orign_sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.tipo_ordem, order.preco, order.quantidade, order.id_posicao, 
        order.status === 'OPEN' ? 'CANCELED' : order.status, // Se ainda OPEN, marcar como CANCELED
        order.data_hora_criacao, order.id_externo, order.side, order.simbolo, 
        order.tipo_ordem_bot, order.target, order.reduce_only, order.close_position, 
        formatDateForMySQL(new Date()), // Atualizar last_update
        order.renew_sl_firs, order.renew_sl_seco, order.orign_sig
      ]
    );
    
    // 3. Remover da tabela original
    await connection.query('DELETE FROM ordens WHERE id = ?', [orderId]);
    
    await connection.commit();
    return true;
  } catch (error) {
    await connection.rollback();
    console.error(`[SYNC] Erro ao mover ordem ${orderId} para histórico: ${error.message}`);
    throw error;
  } finally {
    connection.release();
  }
}

/**
 * Sincroniza o saldo da conta no banco de dados com o saldo real da corretora
 * @returns {Promise<Object>} Objeto com os saldos atualizados
 */
async function syncAccountBalance() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return null;
    }
    
    // Obter saldo real da corretora
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
    
    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na corretora');
    }
    
    // Obter o valor do saldo disponível (inclui lucro não realizado)
    const realSaldo = parseFloat(usdtBalance.balance);
    //console.log(`[MONITOR] Saldo atual na corretora: ${realSaldo.toFixed(2)} USDT`);
    
    // Atualizar saldo no banco de dados e possivelmente o saldo_base_calculo
    return await updateAccountBalance(db, realSaldo);
  } catch (error) {
    console.error(`[MONITOR] Erro ao sincronizar saldo da conta: ${error.message}`);
    return null;
  }
}

// Função para parar o monitoramento
async function stopMonitoring() {
  console.log('[MONITOR] Parando o sistema de monitoramento...');
  
  // Cancelar todos os jobs agendados
  if (scheduledJobs.checkNewTrades) {
    scheduledJobs.checkNewTrades.cancel();
    console.log('[MONITOR] Job de verificação de novas operações cancelado');
  }
  
  if (scheduledJobs.syncWithExchange) {
    scheduledJobs.syncWithExchange.cancel();
    console.log('[MONITOR] Job de sincronização cancelado');
  }
  
  // Adicionar cancelamento do novo job
  if (scheduledJobs.updateLeverageBrackets) {
    scheduledJobs.updateLeverageBrackets.cancel();
    console.log('[MONITOR] Job de atualização diária de alavancagem cancelado');
  }
  
  // Cancelar outros jobs se houver
  Object.keys(scheduledJobs).forEach(jobName => {
    if (scheduledJobs[jobName]) {
      scheduledJobs[jobName].cancel();
      console.log(`[MONITOR] Job ${jobName} cancelado`);
    }
  });
  
  // Limpar referências
  scheduledJobs = {};
  
  // Parar bot do Telegram se estiver ativo
  if (bot && bot.telegram) {
    try {
      // Verificar se o bot está realmente em execução
      if (bot.botInfo) {
        await bot.stop();
        console.log('[MONITOR] Bot Telegram parado');
      } else {
        console.log('[MONITOR] Bot Telegram não estava em execução');
      }
    } catch (error) {
      console.error('[MONITOR] Erro ao parar bot Telegram:', error);
    }
  }
  
  // Aguardar um pouco para operações assíncronas terminarem
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('[MONITOR] Sistema de monitoramento parado com sucesso');
  return true;
}

// Inicializar o monitoramento
initializeMonitoring().catch(console.error);

module.exports = {
  handleOrderUpdate,
  onPriceUpdate,
  initializeMonitoring,
  stopMonitoring,
  checkAndCloseWebsocket  // Adicione esta linha
};
