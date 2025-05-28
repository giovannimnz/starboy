const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');

// Corrigir o caminho do .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Variáveis de ambiente para API da Binance
const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;
const apiUrl = process.env.API_URL;  // Deve ser https://fapi.binance.com/fapi
const ws_apiUrl = process.env.WS_URL;

// Variável para armazenar os websockets de preço
const priceWebsockets = {};

// Variável para armazenar os handlers de monitoramento
let handlers = {
    handleOrderUpdate: null,
    handleAccountUpdate: null,
    onPriceUpdate: null,
    getDbConnection: null
};

// Armazenar a instância de conexão com o banco de dados
let dbInstance = null;

// Definir handlers de callbacks do monitoramento
function setMonitoringCallbacks(callbacks) {
    handlers = callbacks;
}

// Função para criar o listenKey - CONFIRMADO PARA API DE FUTUROS
async function createListenKey() {
    try {
        // Endpoint correto para API de Futuros da Binance (USDT-M)
        const endpoint = '/v1/listenKey';
        const fullUrl = `${apiUrl}${endpoint}`;

        const response = await axios.post(fullUrl, null, {
            headers: {
                'X-MBX-APIKEY': apiKey
            }
        });

        console.log(`[WEBSOCKET] ListenKey obtido com sucesso: ${response.data.listenKey.substring(0, 10)}...`);
        return response.data.listenKey;
    } catch (error) {
        console.error('[WEBSOCKET] Erro ao criar listenKey:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
            console.error('Request URL:', error.config.url);
        }
        throw error;
    }
}

// Função para manter o listenKey vivo - CORRIGIDO O ENDPOINT
async function keepAliveListenKey(listenKey) {
    const endpoint = '/v1/listenKey';
    return axios.put(`${apiUrl}${endpoint}?listenKey=${listenKey}`, null, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
}

// Função para encerrar o listenKey - CORRIGIDO O ENDPOINT
async function closeListenKey(listenKey) {
    const endpoint = '/v1/listenKey';
    return axios.delete(`${apiUrl}${endpoint}?listenKey=${listenKey}`, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
}

// Função para iniciar o WebSocket de dados do usuário - CORRIGIDO O FORMATO DA URL
async function startUserDataStream(getDatabaseInstance) {
    try {
        // Armazenar a função de obtenção do banco de dados
        if (!dbInstance && typeof getDatabaseInstance === 'function') {
            dbInstance = await getDatabaseInstance();
        }

        const listenKey = await createListenKey();

        // URL CORRIGIDA para conexão do WebSocket usando o listenKey
        // Formato correto para Futuros USDT-M: wss://fstream.binance.com/ws/<listenKey>
        const wsUrl = `${ws_apiUrl}/ws/${listenKey}`;

        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('[WEBSOCKET] Conexão estabelecida com sucesso');
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                console.log('[WEBSOCKET] Mensagem recebida:', JSON.stringify(message)); // Adicione este log

                if (message.e === 'ORDER_TRADE_UPDATE') { // CORREÇÃO AQUI - use ORDER_TRADE_UPDATE em vez de executionReport
                    console.log(`[WEBSOCKET] Atualização de ordem: ${message.o.s} | ${message.o.i} | ${message.o.X}`);
                    if (handlers.handleOrderUpdate) {
                        await handlers.handleOrderUpdate(message.o, dbInstance); // Passe message.o para o handler
                    }
                } else if (message.e === 'ACCOUNT_UPDATE' || message.e === 'outboundAccountPosition') {
                    console.log('[WEBSOCKET] Atualização de posição na conta');
                    if (handlers.handleAccountUpdate) {
                        await handlers.handleAccountUpdate(message, dbInstance);
                    }
                } else if (message.e === 'listenKeyExpired') {
                    console.log('[WEBSOCKET] Listen Key expirado - reconectando...');
                    setTimeout(() => startUserDataStream(getDatabaseInstance), 1000);
                }
            } catch (error) {
                console.error('[WEBSOCKET] Erro ao processar mensagem:', error);
            }
        });

        ws.on('error', (error) => {
            console.error('[WEBSOCKET] Erro na conexão:', error);
            setTimeout(() => startUserDataStream(getDatabaseInstance), 5000);
        });

        ws.on('close', () => {
            console.log('[WEBSOCKET] Conexão fechada - tentando reconectar em 5 segundos');
            setTimeout(() => startUserDataStream(getDatabaseInstance), 5000);
        });

        // Manter o listenKey ativo
        const keepAliveInterval = setInterval(async () => {
            try {
                await keepAliveListenKey(listenKey);
            } catch (error) {
                console.error('[WEBSOCKET] Erro ao manter Listen Key:', error);
                clearInterval(keepAliveInterval);
                setTimeout(() => startUserDataStream(getDatabaseInstance), 1000);
            }
        }, 10 * 60 * 1000); // A cada 10 minutos

        // Limpar o intervalo se o processo for encerrado
        process.on('SIGINT', async () => {
            console.log('[WEBSOCKET] Encerrando conexão e Listen Key');
            clearInterval(keepAliveInterval);
            await closeListenKey(listenKey);
            process.exit();
        });

        return ws;
    } catch (error) {
        console.error('[WEBSOCKET] Erro ao iniciar WebSocket:', error);
        setTimeout(() => startUserDataStream(getDatabaseInstance), 5000);
    }
}

// Função para garantir que um websocket de preço existe para o símbolo - CORRIGIDO FORMATO DA URL
function ensurePriceWebsocketExists(symbol) {
    if (priceWebsockets[symbol] && priceWebsockets[symbol].readyState === WebSocket.OPEN) {
        console.log(`[WEBSOCKET] WebSocket já existe e está conectado para ${symbol}`);
        return; // Websocket já existe e está conectado
    }

    // Se existe mas não está conectado, fechar para recriar
    if (priceWebsockets[symbol]) {
        console.log(`[WEBSOCKET] WebSocket existe mas não está conectado para ${symbol}, recriando...`);
        try {
            priceWebsockets[symbol].close();
        } catch (e) {
            // Ignorar erros ao fechar
        }
        delete priceWebsockets[symbol];
    }

    console.log(`[WEBSOCKET] Iniciando monitoramento de preço para ${symbol}`);

    // URL para Futuros USDT-M
    const wsUrl = `${ws_apiUrl}/ws/${symbol.toLowerCase()}@bookTicker`;
    console.log(`[WEBSOCKET] URL para monitoramento de preço: ${wsUrl}`);

    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
        console.log(`[WEBSOCKET] Conexão de preço aberta para ${symbol}`);
    });

    ws.on('message', async (data) => {
        const tickerData = JSON.parse(data);
        await handlePriceUpdate(symbol, tickerData);
    });

    ws.on('error', (error) => {
        console.error(`[WEBSOCKET] Erro na conexão de preço para ${symbol}:`, error);

        // Tentar reconectar após erro
        setTimeout(() => {
            if (priceWebsockets[symbol] === ws) {
                delete priceWebsockets[symbol]; // Remover websocket com erro
                ensurePriceWebsocketExists(symbol); // Recriar
            }
        }, 5000);
    });

    ws.on('close', () => {
        console.log(`[WEBSOCKET] Conexão de preço fechada para ${symbol}`);

        // Tentar reconectar automaticamente
        setTimeout(() => {
            if (priceWebsockets[symbol] === ws) {
                delete priceWebsockets[symbol]; // Remover websocket fechado
                ensurePriceWebsocketExists(symbol); // Recriar
            }
        }, 5000);
    });

    priceWebsockets[symbol] = ws;
}

// Função para lidar com atualizações de preço - Modificada para usar o banco de dados
async function handlePriceUpdate(symbol, tickerData) {
    try {
        // Usar a instância armazenada ou tentar obter via handlers
        let db = dbInstance;
        if (!db && handlers.getDbConnection) {
            db = await handlers.getDbConnection();
        }

        if (!db) {
            console.error(`[WEBSOCKET] Não foi possível obter conexão com o banco de dados para ${symbol}`);
            return;
        }

        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        const currentPrice = (bestBid + bestAsk) / 2;

        if (handlers.onPriceUpdate) {
            await handlers.onPriceUpdate(symbol, currentPrice, db);
        }
    } catch (error) {
        console.error(`[WEBSOCKET] Erro ao processar atualização de preço para ${symbol}:`, error);
    }
}

// Em websockets.js
function stopPriceMonitoring(symbol) {
    if (priceWebsockets[symbol]) {
        console.log(`[WEBSOCKET] Fechando websocket de preço para ${symbol} por solicitação externa`);
        priceWebsockets[symbol].close();
        delete priceWebsockets[symbol];
        return true;
    }
    return false;
}

// Exportar funções
module.exports = {
    startUserDataStream,
    setMonitoringCallbacks,
    ensurePriceWebsocketExists,
    stopPriceMonitoring,
    priceWebsockets,
    reset: function() {
        dbInstance = null;
    }
};