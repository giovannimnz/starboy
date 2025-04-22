const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;

// Corrigir o caminho do .env
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Função para obter posições do arquivo
async function getPositionsFromFile() {
    try {
        const positionsFile = path.join(__dirname, 'posicoes', 'posicoes.json');
        const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
        
        if (!fileExists) {
            console.log(`[WEBSOCKET] Arquivo de posições não encontrado: ${positionsFile}`);
            return [];
        }
        
        const content = await fs.readFile(positionsFile, 'utf8');
        if (!content.trim()) {
            return [];
        }
        
        return JSON.parse(content);
    } catch (error) {
        console.error(`[WEBSOCKET] Erro ao ler arquivo de posições:`, error);
        return [];
    }
}

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
    onPriceUpdate: null
};

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
        
        //console.log(`[WEBSOCKET] Chamando endpoint para criar listenKey: ${fullUrl}`);
        
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
    //console.log('[WEBSOCKET] Iniciando conexão com WebSocket de dados do usuário');
    
    try {
        const listenKey = await createListenKey();
        
        // URL CORRIGIDA para conexão do WebSocket usando o listenKey
        // Formato correto para Futuros USDT-M: wss://fstream.binance.com/ws/<listenKey>
        const wsUrl = `${ws_apiUrl}/ws/${listenKey}`;
        //console.log(`[WEBSOCKET] Conectando ao WebSocket URL: ${wsUrl}`);
        
        const ws = new WebSocket(wsUrl);
        
        ws.on('open', () => {
            console.log('[WEBSOCKET] Conexão estabelecida com sucesso');
        });
        
        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data);
                const db = getDatabaseInstance();
                
                if (message.e === 'executionReport') {
                    console.log(`[WEBSOCKET] Atualização de ordem: ${message.s} | ${message.i} | ${message.X}`);
                    if (handlers.handleOrderUpdate) {
                        await handlers.handleOrderUpdate(message, db);
                    }
                } else if (message.e === 'ACCOUNT_UPDATE' || message.e === 'outboundAccountPosition') {
                    console.log('[WEBSOCKET] Atualização de posição na conta');
                    if (handlers.handleAccountUpdate) {
                        await handlers.handleAccountUpdate(message, db);
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
                //console.log('[WEBSOCKET] Keep-alive enviado para o Listen Key');
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
    if (priceWebsockets[symbol]) {
        return; // Websocket já existe
    }
    
    console.log(`[WEBSOCKET] Iniciando monitoramento de preço para ${symbol}`);
    
    // URL CORRIGIDA para Futuros USDT-M
    // Formato correto: wss://fstream.binance.com/ws/<symbol>@bookTicker
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
    });
    
    ws.on('close', () => {
        console.log(`[WEBSOCKET] Conexão de preço fechada para ${symbol}`);
        delete priceWebsockets[symbol];
        
        // Tentar reconectar após um breve intervalo
        setTimeout(() => {
            needsMonitoring(symbol).then(needed => {
                if (needed) {
                    ensurePriceWebsocketExists(symbol);
                }
            });
        }, 5000);
    });
    
    priceWebsockets[symbol] = ws;
}

// Função para verificar se um símbolo ainda precisa ser monitorado - CORRIGIDO CAMINHO DO ARQUIVO
async function needsMonitoring(symbol) {
    try {
        // CORRIGIDO: usa posicoes/posicoes.json em vez de posicoes.json na raiz
        const positionsFile = path.join(__dirname, 'posicoes', 'posicoes.json');
        const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
        
        if (!fileExists) {
            console.log(`[WEBSOCKET] Arquivo de posições não encontrado: ${positionsFile}`);
            return false;
        }
        
        const content = await fs.readFile(positionsFile, 'utf8');
        if (!content.trim()) {
            return false;
        }
        
        const positions = JSON.parse(content);
        
        return positions.some(pos => 
            pos.symbol === symbol && 
            (pos.status === 'ENTRY_CREATED' || pos.status === 'ENTRY_FILLED')
        );
    } catch (error) {
        console.error(`[MONITOR] Erro ao verificar necessidade de monitoramento para ${symbol}:`, error);
        return false;
    }
}

// Função para lidar com atualizações de preço - Modificada para fechar o websocket após o processamento
async function handlePriceUpdate(symbol, tickerData) {
    try {
        const positions = await getPositionsFromFile();
        
        // Encontrar trades para este símbolo que precisam ser monitorados
        const relevantTrades = positions.filter(pos => 
            pos.symbol === symbol && 
            (pos.status === 'ENTRY_CREATED' || pos.status === 'ENTRY_FILLED')
        );
        
        if (relevantTrades.length === 0) {
            // Não há mais trades relevantes para este símbolo
            if (priceWebsockets[symbol]) {
                console.log(`[WEBSOCKET] Fechando websocket de preço para ${symbol} - não há mais trades relevantes`);
                priceWebsockets[symbol].close();
                delete priceWebsockets[symbol];
            }
            return;
        }
        
        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        const currentPrice = (bestBid + bestAsk) / 2;
        
        // Exportar a lógica da análise de preço para o monitoramento.js
        // Chamar a função exportada do monitoramento.js
        if (handlers.onPriceUpdate) {
            await handlers.onPriceUpdate(symbol, currentPrice, relevantTrades, positions);
        }
        
        // Após chamar onPriceUpdate, verificar novamente se o websocket deve continuar
        const updatedPositions = await getPositionsFromFile(); // Recarregar as posições após possíveis mudanças
        const stillRelevant = updatedPositions.some(pos => 
            pos.symbol === symbol && 
            (pos.status === 'ENTRY_CREATED' || pos.status === 'ENTRY_FILLED')
        );
        
        if (!stillRelevant && priceWebsockets[symbol]) {
            console.log(`[WEBSOCKET] Fechando websocket de preço para ${symbol} - trade cancelado ou concluído`);
            priceWebsockets[symbol].close();
            delete priceWebsockets[symbol];
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
    stopPriceMonitoring
};