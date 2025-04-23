const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getTickSize, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, initializeDatabase} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Função para inicializar o monitoramento
async function initializeMonitoring() {
  console.log('[MONITOR] Inicializando sistema de monitoramento...');
  
  // Configurar callbacks para WebSockets
  websockets.setMonitoringCallbacks({
    handleOrderUpdate,
    handleAccountUpdate,
    onPriceUpdate
  });
  
  // Iniciar WebSocket para dados do usuário
  await websockets.startUserDataStream(getDatabaseInstance);
  
  // Agendar verificação periódica de novas operações
  schedule.scheduleJob('*/10 * * * * *', async () => {
    try {
      await checkNewTrades();
    } catch (error) {
      console.error('[MONITOR] Erro ao verificar novas operações:', error);
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
      console.log(`[MONITOR] Iniciando monitoramento de preço para ${symbol}`);
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
    
    // Verificar webhook pendentes na tabela 'webhook_signals' (supondo que você tenha essa tabela)
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals 
      WHERE status = 'PENDING' 
      ORDER BY created_at ASC
    `);
    
    for (const signal of pendingSignals) {
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
      await changeMarginType(symbol, 'ISOLATED');
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
      
      // 7. Atualizar status do sinal no webhook
      await connection.query(
        `UPDATE webhook_signals SET 
         status = 'PROCESSED', 
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
  // Arredondar para a precisão correta
  return parseFloat(size.toFixed(precision));
}

// Função para obter saldo disponível (ajuste conforme sua implementação)
async function getAvailableBalance() {
  // Implementar com sua lógica de obtenção de saldo
  // Exemplo: retornar um valor padrão por enquanto
  return 1000.0;
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

// Função para processar atualizações de ordens via WebSocket
async function handleOrderUpdate(message, db) {
  const orderId = message.i || message.orderId;
  const status = message.X || message.status;
  const symbol = message.s || message.symbol;
  const executionType = message.x || message.executionType;
  
  console.log(`[ORDER UPDATE] Symbol: ${symbol}, OrderID: ${orderId}, Status: ${status}, ExecutionType: ${executionType}`);
  
  try {
    // Se não tiver conexão com o banco, tentar estabelecer
    if (!db) {
      db = await getDatabaseInstance();
      if (!db) {
        console.error(`[ORDER UPDATE] Não foi possível obter conexão com o banco de dados`);
        return;
      }
    }
    
    // Verificar se esta é uma ordem de ENTRADA que foi PREENCHIDA
    if (status === 'FILLED') {
      console.log(`[ORDER UPDATE] Ordem ${orderId} preenchida para ${symbol}`);
      
      // Buscar a ordem no banco de dados
      const orders = await getOrdersFromDb(db, { id_externo: orderId });
      
      if (!orders || orders.length === 0) {
        console.log(`[ORDER UPDATE] Ordem ${orderId} não encontrada no banco de dados`);
        return;
      }
      
      const order = orders[0];
      console.log(`[ORDER UPDATE] Ordem encontrada: ${JSON.stringify(order)}`);
      
      // Atualizar status da ordem no banco
      await updateOrderStatus(db, order.id, 'FILLED');
      
      // Verificar tipo de ordem
      if (order.tipo_ordem_bot === 'ENTRADA') {
        // É uma ordem de entrada preenchida - precisa criar SL/TP
        await handleEntryOrderFilled(db, order, message);
      } else if (order.tipo_ordem_bot === 'TAKE_PROFIT') {
        // É uma ordem de TP preenchida - encerrar posição
        await handleTpOrderFilled(db, order);
      } else if (order.tipo_ordem_bot === 'STOP_LOSS') {
        // É uma ordem de SL preenchida - encerrar posição
        await handleSlOrderFilled(db, order);
      }
    } else if (status === 'CANCELED') {
      // Ordem cancelada - atualizar status no banco
      const orders = await getOrdersFromDb(db, { id_externo: orderId });
      
      if (!orders || orders.length === 0) {
        console.log(`[ORDER UPDATE] Ordem cancelada ${orderId} não encontrada no banco de dados`);
        return;
      }
      
      const order = orders[0];
      await updateOrderStatus(db, order.id, 'CANCELED');
      
      // Se é uma ordem de entrada, verificar se precisa cancelar a posição
      if (order.tipo_ordem_bot === 'ENTRADA') {
        // Verificar se devemos encerrar a posição inteira
        const positionId = order.id_posicao;
        const position = await getPositionById(db, positionId);
        
        if (position && position.status === 'PENDING') {
          // Posição ainda está pendente, mover para histórico com status CANCELED
          await movePositionToHistory(db, positionId, 'CANCELED', 'Ordem de entrada cancelada');
        }
      }
    }
  } catch (error) {
    console.error(`[ORDER UPDATE] Erro ao processar atualização de ordem:`, error);
  }
}

// Inicializar o monitoramento
initializeMonitoring().catch(console.error);
