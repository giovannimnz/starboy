const WebSocket = require('ws');
const axios = require('axios');
const schedule = require('node-schedule');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders } = require('./conexao');

const apiKey = process.env.API_KEY;
const apiUrl = process.env.API_URL;
const ws_apiUrl = process.env.WS_URL;

// Função para criar o listenKey
async function createListenKey() {
    const response = await axios.post(`${apiUrl}/api/v3/userDataStream`, null, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
    return response.data.listenKey;
}

// Função para manter o listenKey vivo
async function keepAliveListenKey(listenKey) {
    await axios.put(`${apiUrl}/api/v3/userDataStream?listenKey=${listenKey}`, null, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
}

// Função para iniciar o WebSocket e monitorar eventos
async function startUserDataStream() {
    const listenKey = await createListenKey();
    const ws = new WebSocket(`${ws_apiUrl}/${listenKey}`);

    ws.on('open', () => {
        console.log('Connected to WebSocket');
    });

    ws.on('message', async (data) => {
        const message = JSON.parse(data);
        const db = getDatabaseInstance();

        if (message.e === 'executionReport') {
            console.log('Order Update:', message);
            await handleOrderUpdate(message, db);
        } else if (message.e === 'outboundAccountPosition') {
            console.log('Account Update:', message);
            await handleAccountUpdate(message, db);
        }
    });

    ws.on('close', () => {
        console.log('WebSocket connection closed');
    });

    // Manter o listenKey ativo
    setInterval(async () => {
        await keepAliveListenKey(listenKey);
        console.log('ListenKey kept alive');
    }, 30 * 60 * 1000); // A cada 30 minutos

    // Limpar listenKey ao finalizar
    process.on('SIGINT', async () => {
        await closeListenKey(listenKey);
        disconnectDatabase(db);
        process.exit();
    });
}

// Função para encerrar o listenKey
async function closeListenKey(listenKey) {
    await axios.delete(`${apiUrl}/api/v3/userDataStream?listenKey=${listenKey}`, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
}

// Função para tratar atualizações de ordens
async function handleOrderUpdate(message, db) {
    const orderId = message.i;
    const status = message.X;

    const orderExists = await checkOrderExists(db, orderId);
    if (orderExists) {
        await updateOrderStatus(db, orderId, status);
        console.log(`Order ID ${orderId} status updated to ${status}`);
    } else {
        console.log(`Order ID ${orderId} does not exist in the database`);
    }
}

// Função para tratar atualizações de posições
async function handleAccountUpdate(message, db) {
    for (let balance of message.B) {
        const symbol = balance.a;
        const positions = await getPositionsFromDb(db, symbol);

        for (let position of positions) {
            const updatedPosition = {
                quantidade: balance.f,
                preco_entrada: position.preco_entrada,
                preco_corrente: balance.f, // Exemplo de como atualizar a posição com novos dados
                leverage: position.leverage
            };

            await updatePositionInDb(db, position.id, updatedPosition.quantidade, updatedPosition.preco_entrada, updatedPosition.preco_corrente, updatedPosition.leverage);
            console.log(`Position ID ${position.id} updated in the database`);

            if (updatedPosition.quantidade === 0) {
                await moveClosedPositionsAndOrders(db, position.id);
                console.log(`Closed position ID ${position.id} moved`);
            }
        }
    }
}

// Iniciar o monitoramento
startUserDataStream().catch(console.error);

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
