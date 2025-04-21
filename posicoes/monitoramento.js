const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config(); // Garante que dotenv é carregado
const { Telegraf } = require("telegraf");
const { newOrder, cancelOrder, newStopOrder, cancelAllOpenOrders } = require('../api');
const { getAllLeverageBrackets } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders } = require('../db/conexao');
const websockets = require('../websockets');

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Definir funções de callback
async function handleOrderUpdate(message, db) {
    const orderId = message.i;
    const status = message.X;
    const symbol = message.s;
  
    console.log(`[ORDER UPDATE] Symbol: ${symbol}, OrderID: ${orderId}, Status: ${status}`);
  
    try {
        // Código existente...
    } catch (error) {
        console.error('[ORDER UPDATE] Erro ao processar atualização de ordem:', error);
    }
}

async function handleAccountUpdate(message, db) {
    try {
        // Código existente...
    } catch (error) {
        console.error('[ACCOUNT UPDATE] Erro ao processar atualização de conta:', error);
    }
}

// Nova função para processar atualizações de preço (chamada pelo websocket.js)
async function onPriceUpdate(symbol, currentPrice, relevantTrades, positions) {
    try {
        const positionsFile = path.join(__dirname, 'posicoes.json');
        let needsUpdate = false;
        
        // Verificar cada trade relevante
        for (const trade of relevantTrades) {
            // Para trades com entrada criada, verificar se o preço atingiu o TP antes da entrada
            if (trade.status === 'ENTRY_CREATED') {
                const entryPrice = parseFloat(trade.entry);
                const tpPrice = parseFloat(trade.tp);
                const side = trade.side === 'COMPRA' ? 'BUY' : 'SELL';
                
                // Se o preço atingiu o TP antes da entrada ser preenchida
                if ((side === 'BUY' && currentPrice >= tpPrice) || 
                    (side === 'SELL' && currentPrice <= tpPrice)) {
                    console.log(`[MONITOR] TP atingido antes da entrada para ${symbol} - cancelando ordens`);
                    
                    // Cancelar a ordem de entrada
                    await cancelOrder(trade.entry_order_id, symbol);
                    
                    // Atualizar status
                    trade.status = 'CANCELLED_TP_REACHED';
                    trade.updated_at = new Date().toISOString();
                    
                    // Enviar mensagem para o Telegram
                    await bot.telegram.sendMessage(trade.chat_id, 
                        `⚠️ Ordem para ${symbol} CANCELADA ⚠️\n\n` +
                        `O preço-alvo (${tpPrice}) foi atingido antes do ponto de entrada (${entryPrice}).\n\n` +
                        `Preço atual: ${currentPrice}`
                    );
                    
                    needsUpdate = true;
                }
            }
        }
        
        // Salvar atualizações no arquivo se necessário
        if (needsUpdate) {
            await fs.writeFile(positionsFile, JSON.stringify(positions, null, 2));
        }
    } catch (error) {
        console.error(`[MONITOR] Erro ao processar atualização de preço para ${symbol}:`, error);
    }
}

// Função que realiza as verificações e atualizações necessárias
async function checkAndUpdateOrders() {
    const db = getDatabaseInstance();
    const partialOrders = await getOrdersFromDb(db, { tipo_ordem_bot: "REDUCAO PARCIAL", target: "1", status: "FILLED", renew_sl_firs: "NULL" });

    for (let order of partialOrders) {
        // Cancelar a ordem de stop loss existente
        await cancelOrder(order.id_externo, order.simbolo);

        // Obter preço médio da posição
        const position = await getPositionById(db, order.id_posicao);
        const averagePrice = position.preco_medio;

        // Determinar o lado oposto para a nova ordem de stop loss
        const side = order.side === 'BUY' ? 'SELL' : 'BUY';

        // Enviar nova ordem de stop loss com o preço médio
        const newStopLossResult = await newStopOrder(order.simbolo, order.quantidade, side, averagePrice);
        if (newStopLossResult.data && newStopLossResult.data.orderId) {
            // Inserir a nova ordem no banco de dados
            const id_posicao = await getPositionIdBySymbol(db, order.simbolo);
            await insertNewOrder(db, {
                tipo_ordem: 'STOP LOSS',
                preco: averagePrice,
                quantidade: order.quantidade,
                id_posicao: id_posicao,
                status: 'OPEN',
                data_hora_criacao: new Date().toISOString(),
                id_externo: newStopLossResult.data.orderId,
                side: side,
                simbolo: order.simbolo,
                tipo_ordem_bot: 'STOP LOSS',
                target: null,
                reduce_only: true,
                close_position: true,
                last_update: new Date().toISOString()
            });
            console.log(`New stop loss order created with ID: ${newStopLossResult.data.orderId}`);
        } else {
            console.error("Error creating new stop loss order on Binance.");
        }

        // Atualizar o banco de dados para refletir que o stop loss foi renovado
        await updateOrderRenewFlag(db, order.id);
    }
}

// Agendar a função checkAndUpdateOrders para rodar a cada 2 minutos
schedule.scheduleJob('*/2 * * * *', function() {
    console.log('Running checkAndUpdateOrders...');
    checkAndUpdateOrders();
});

// Função para atualizar o arquivo leverage.json
async function updateLeverageBrackets() {
  try {
    console.log('[SCHEDULER] Iniciando atualização dos brackets de alavancagem...');
    
    // Obter os brackets de alavancagem atualizados da API
    const brackets = await getAllLeverageBrackets();
    
    // Definir o caminho para o arquivo leverage.json
    const leverageFilePath = path.join(__dirname, '..', 'indicadores', 'leverage.json');
    
    // Salvar os brackets no arquivo leverage.json com formatação para legibilidade
    await fs.writeFile(leverageFilePath, JSON.stringify(brackets, null, 2));
    
    console.log('[SCHEDULER] Arquivo leverage.json atualizado com sucesso!');
    console.log(`[SCHEDULER] Total de símbolos atualizados: ${brackets.length}`);
    
    // Verificar se algum símbolo específico está presente para validação
    const btcBracket = brackets.find(b => b.symbol === 'BTCUSDT');
    if (btcBracket) {
      console.log('[SCHEDULER] Exemplo de bracket para BTCUSDT:', 
        btcBracket.brackets.map(b => b.cum).slice(0, 3), '...');
    }
    
    return brackets;
  } catch (error) {
    console.error('[SCHEDULER] Erro ao atualizar brackets de alavancagem:', error);
    throw error;
  }
}

// Agendar a execução diária às 03:00
schedule.scheduleJob('0 3 * * *', function() {
  console.log('[SCHEDULER] Executando atualização programada dos brackets de alavancagem...');
  updateLeverageBrackets()
    .then(() => console.log('[SCHEDULER] Atualização programada concluída com sucesso'))
    .catch(error => console.error('[SCHEDULER] Falha na atualização programada:', error));
});

// Adicionar esta linha para executar uma atualização imediata quando o script iniciar
// (Útil para garantir que temos dados atualizados desde o primeiro uso)
console.log('[INIT] Realizando primeira atualização de brackets de alavancagem ao iniciar...');
updateLeverageBrackets()
  .then(() => console.log('[INIT] Primeira atualização de brackets concluída'))
  .catch(error => console.error('[INIT] Falha na primeira atualização de brackets:', error));

// Função para monitorar o arquivo posicoes.json
async function monitorPositionsFile() {
  console.log('[MONITOR] Iniciando monitoramento do arquivo posicoes.json');
  
  try {
    // Verificar arquivo imediatamente na inicialização
    await checkNewTrades();
    
    // Agendar verificações a cada 5 segundos
    setInterval(async () => {
      await checkNewTrades();
    }, 5000);
  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento:', error);
  }
}

// Função para verificar novos trades no arquivo posicoes.json
async function checkNewTrades() {
  try {
    const positionsFile = path.join(__dirname, 'posicoes.json');
    
    const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
    if (!fileExists) {
      return; // Arquivo não existe ainda
    }
    
    const content = await fs.readFile(positionsFile, 'utf8');
    if (!content.trim()) {
      return; // Arquivo vazio
    }
    
    const positions = JSON.parse(content);
    
    // Filtrar trades pendentes (ainda não processados)
    const pendingTrades = positions.filter(trade => trade.status === 'PENDING_ENTRY');
    
    for (const trade of pendingTrades) {
      console.log(`[MONITOR] Processando novo trade pendente: ${trade.symbol}`);
      await processNewTrade(trade, positions);
      
      // Atualizar o arquivo após processar cada trade
      await fs.writeFile(positionsFile, JSON.stringify(positions, null, 2));
    }
    
    // Monitorar também posições abertas
    const openTrades = positions.filter(trade => trade.status === 'ENTRY_FILLED');
    for (const trade of openTrades) {
      websockets.ensurePriceWebsocketExists(trade.symbol);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar novos trades:', error);
  }
}

// Função para processar um novo trade
async function processNewTrade(trade, allPositions) {
  const db = getDatabaseInstance();
  
  try {
    // Preparar parâmetros para a ordem de entrada
    const symbol = trade.symbol;
    const side = trade.side === 'COMPRA' ? 'BUY' : 'SELL';
    const price = parseFloat(trade.entry);
    const leverage = parseInt(trade.leverage, 10);
    const capitalPct = parseFloat(trade.capital_pct);
    
    // Obter detalhes da conta
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
    const capital = parseFloat(usdtBalance.balance) * (capitalPct / 100);
    
    // Calcular quantidade
    const tickSizeData = await getTickSize(symbol);
    const { quantityPrecision } = await getPrecision(symbol);
    const totalUSDT = capital * leverage;
    const quantity = (totalUSDT / price).toFixed(quantityPrecision);
    
    // Configurar alavancagem e tipo de margem
    await changeInitialLeverage(symbol, leverage);
    await changeMarginType(symbol, 'ISOLATED');
    
    // Criar ordem LIMIT de entrada
    const entryOrderResult = await newOrder(symbol, quantity, side, price);
    console.log(`[MONITOR] Ordem de entrada criada para ${symbol} com ID: ${entryOrderResult.data.orderId}`);
    
    // Atualizar o status no array de posições
    trade.status = 'ENTRY_CREATED';
    trade.entry_order_id = entryOrderResult.data.orderId;
    trade.updated_at = new Date().toISOString();
    
    // Inserir no banco de dados
    const id_posicao = await insertPosition(db, {
      simbolo: symbol,
      quantidade: quantity,
      preco_entrada: price,
      preco_medio: price,
      status: 'PENDING',
      data_hora_abertura: new Date().toISOString(),
      side: side,
      leverage: leverage,
      data_hora_ultima_atualizacao: new Date().toISOString(),
      preco_corrente: price
    });
    
    // Inserir a ordem de entrada no banco
    await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: price,
      quantidade: quantity,
      id_posicao: id_posicao,
      status: 'OPEN',
      data_hora_criacao: new Date().toISOString(),
      id_externo: entryOrderResult.data.orderId,
      side: side,
      simbolo: symbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: new Date().toISOString()
    });
    
    // Iniciar monitoramento de preço para este símbolo
    websockets.ensurePriceWebsocketExists(symbol);
    
  } catch (error) {
    console.error(`[MONITOR] Erro ao processar novo trade para ${trade.symbol}:`, error);
    trade.status = 'ERROR';
    trade.error = error.message;
    trade.updated_at = new Date().toISOString();
  }
}

// Iniciar o monitoramento do arquivo posicoes.json
monitorPositionsFile();

// Adicionar essa linha antes de iniciar o startUserDataStream
console.log('[INIT] Iniciando monitoramento de trades e posições...');

// Registrar os callbacks no módulo websockets
websockets.setMonitoringCallbacks({
  handleOrderUpdate,
  handleAccountUpdate,
  onPriceUpdate
});

// Iniciar o monitoramento
websockets.startUserDataStream(getDatabaseInstance).catch(console.error);

// Não precisamos mais exportar estas funções
module.exports = {};
