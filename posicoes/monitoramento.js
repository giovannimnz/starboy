const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getTickSize, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, initializeDatabase, formatDateForMySQL} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Adicionar variável para armazenar os jobs
let scheduledJobs = {};

// Função para inicializar o monitoramento
async function initializeMonitoring() {
  console.log('[MONITOR] Inicializando sistema de monitoramento...');
  
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

// Substitua a função getAvailableBalance atual pela seguinte:

async function getAvailableBalance() {
  try {
    // Obter saldo da conta Futures
    const balanceDetails = await getFuturesAccountBalanceDetails();
    // Encontrar o saldo USDT
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
    
    if (!usdtBalance) {
      console.error('[MONITOR] Saldo USDT não encontrado');
      return 0;
    }
    
    // Usar availableBalance que já considera posições abertas e requisitos de margem
    const availableAmount = parseFloat(usdtBalance.availableBalance);
    console.log(`[MONITOR] Saldo disponível: ${availableAmount} USDT`);
    return availableAmount;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter saldo disponível: ${error.message}`);
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
      
      // Mover registros para tabelas históricas
      try {
        await moveClosedPositionsAndOrders(db, order.id_posicao);
        console.log(`[MONITOR] Posição ${order.id_posicao} fechada e movida para histórico`);
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

// Função para mover posição para histórico se não existir
async function movePositionToHistory(db, positionId, status, reason) {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    // 1. Atualizar status da posição
    await connection.query(
      `UPDATE posicoes 
       SET status = ?, 
           data_hora_fechamento = ?,
           data_hora_ultima_atualizacao = ?
       WHERE id = ?`,
      [status, new Date().toISOString(), new Date().toISOString(), positionId]
    );
    
    // 2. Mover posição e ordens para histórico
    await moveClosedPositionsAndOrders(db, positionId);
    
    // 3. Registrar o motivo em uma tabela de logs
    await connection.query(
      `INSERT INTO historico_posicoes 
       (id_posicao, tipo_evento, data_hora_evento, resultado) 
       VALUES (?, ?, ?, ?)`,
      [positionId, 'CLOSE', new Date().toISOString(), reason]
    );
    
    await connection.commit();
    console.log(`[MONITOR] Posição ${positionId} movida para histórico: ${reason}`);
    
  } catch (error) {
    await connection.rollback();
    console.error(`[MONITOR] Erro ao mover posição ${positionId} para histórico:`, error);
  } finally {
    connection.release();
  }
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
    console.error(`[PRICE UPDATE] Erro ao processar atualização de preço:`, error);
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
  stopMonitoring
};
