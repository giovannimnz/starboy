const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config(); // Garante que dotenv é carregado antes de acessar process.env

// Variáveis globais
const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;
const apiUrl = process.env.API_URL;
const ws_apiUrl = process.env.WS_URL;

// Verificações de segurança
if (!apiKey || !apiSecret || !apiUrl || !ws_apiUrl) {
  console.error('[ERRO] Variáveis de ambiente necessárias não foram carregadas:');
  console.error(`API_KEY: ${apiKey ? 'OK' : 'FALTANDO'}`);
  console.error(`API_SECRET: ${apiSecret ? 'OK' : 'FALTANDO'}`);
  console.error(`API_URL: ${apiUrl ? 'OK' : 'FALTANDO'}`);
  console.error(`WS_URL: ${ws_apiUrl ? 'OK' : 'FALTANDO'}`);
  process.exit(1);
}

// Variável para armazenar os websockets de preço
const priceWebsockets = {};

// Funções que serão atribuídas dinamicamente depois
let handleOrderUpdate;
let handleAccountUpdate;
let onPriceUpdate;

// Função para definir as funções de callback do monitoramento
function setMonitoringCallbacks(callbacks) {
  handleOrderUpdate = callbacks.handleOrderUpdate;
  handleAccountUpdate = callbacks.handleAccountUpdate;
  onPriceUpdate = callbacks.onPriceUpdate;
}

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

// Função para encerrar o listenKey
async function closeListenKey(listenKey) {
    await axios.delete(`${apiUrl}/api/v3/userDataStream?listenKey=${listenKey}`, {
        headers: {
            'X-MBX-APIKEY': apiKey
        }
    });
}

// Função para iniciar o WebSocket de dados do usuário
async function startUserDataStream(getDatabaseInstance) {
  console.log('[WEBSOCKET] Iniciando conexão com WebSocket de dados do usuário');
  
  try {
    const listenKey = await createListenKey();
    console.log(`[WEBSOCKET] Listen Key obtido: ${listenKey.substring(0, 10)}...`);
    
    const ws = new WebSocket(`${ws_apiUrl}/ws/${listenKey}`);
    
    ws.on('open', () => {
      console.log('[WEBSOCKET] Conexão estabelecida com sucesso');
    });
    
    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data);
        const db = getDatabaseInstance();
        
        if (message.e === 'executionReport') {
          console.log(`[WEBSOCKET] Atualização de ordem: ${message.s} | ${message.i} | ${message.X}`);
          await handleOrderUpdate(message, db);
        } else if (message.e === 'outboundAccountPosition') {
          console.log('[WEBSOCKET] Atualização de posição na conta');
          await handleAccountUpdate(message, db);
        } else if (message.e === 'ACCOUNT_UPDATE') {
          console.log('[WEBSOCKET] Atualização de conta');
          await handleAccountUpdate(message, db);
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
        console.log('[WEBSOCKET] Keep-alive enviado para o Listen Key');
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

// Função para garantir que um websocket de preço existe para o símbolo
function ensurePriceWebsocketExists(symbol) {
  if (priceWebsockets[symbol]) {
    return; // Websocket já existe
  }
  
  console.log(`[WEBSOCKET] Iniciando monitoramento de preço para ${symbol}`);
  
  const wsUrl = `${ws_apiUrl}/ws/${symbol.toLowerCase()}@bookTicker`;
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

// Função para verificar se um símbolo ainda precisa ser monitorado
async function needsMonitoring(symbol) {
  try {
    const positionsFile = path.join(__dirname, 'posicoes.json');
    const content = await fs.readFile(positionsFile, 'utf8');
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

// Função para lidar com atualizações de preço
async function handlePriceUpdate(symbol, tickerData) {
  try {
    const positionsFile = path.join(__dirname, 'posicoes.json');
    const content = await fs.readFile(positionsFile, 'utf8');
    const positions = JSON.parse(content);
    
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
    await onPriceUpdate(symbol, currentPrice, relevantTrades, positions);
    
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao processar atualização de preço para ${symbol}:`, error);
  }
}

// Exportar as funções necessárias
module.exports = {
  startUserDataStream,
  ensurePriceWebsocketExists,
  setMonitoringCallbacks // Nova função para configurar callbacks
};