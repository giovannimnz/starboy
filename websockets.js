const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { getDatabaseInstance, getApiCredentials } = require('./db/conexao');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Variáveis para armazenar credenciais
let apiKey = null;
let privateKey = null;
let apiSecret = null;

// Inicialização das URLs com valores padrão seguros
let apiUrl = process.env.API_URL || 'https://fapi.binance.com/fapi';
let ws_apiUrl = process.env.WS_API_URL || 'wss://ws-fapi.binance.com/ws-fapi';
let wss_market_Url = process.env.WS_URL || 'wss://fstream.binance.com/ws';

// Outras variáveis globais
let wsApiConnection = null;
let wsApiAuthenticated = false;
let pingInterval = null;
let lastPongTime = Date.now();
const requestCallbacks = new Map();
const priceWebsockets = {};
let userDataWebSocket = null;
let currentListenKey = null;
let listenKeyKeepAliveInterval = null;
let handlers = {};
let dbInstance = null;

async function createListenKey() {
  try {
    // Garantir que as credenciais estão carregadas
    if (!apiKey || !apiUrl) {
      await loadCredentialsFromDatabase();
      
      // Verificação adicional após tentar carregar
      if (!apiUrl) {
        throw new Error('API URL não definida após carregar credenciais');
      }
    }
    
    const endpoint = '/v1/listenKey';
    const fullUrl = `${apiUrl}${endpoint}`;

    console.log(`[WEBSOCKET] Obtendo listenKey via: ${fullUrl}`);

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
    }
    throw error;
  }
}

async function loadCredentialsFromDatabase() {
  try {
    // 1. Obter as credenciais da conta
    const credentials = await getApiCredentials();
    
    // 2. Obter as URLs da nova tabela corretoras com base na corretora e ambiente
    const db = await getDatabaseInstance();
    
    if (!db) {
      throw new Error('Não foi possível obter instância do banco de dados');
    }
    
    const [corretoras] = await db.query(`
      SELECT * 
      FROM corretoras 
      WHERE corretora = ? AND ambiente = ? AND ativa = 1
      LIMIT 1
    `, [credentials.corretora, credentials.ambiente]);
    
    if (corretoras.length === 0) {
      throw new Error(`Configuração de URLs não encontrada para corretora=${credentials.corretora}, ambiente=${credentials.ambiente}`);
    }
    
    const urlConfig = corretoras[0];
    
    // Definir as variáveis com os valores do banco de dados
    apiKey = credentials.wsApiKey;
    apiSecret = credentials.restSecretKey;
    privateKey = credentials.wsSecretKey;
    
    // Definir as URLs com base na tabela corretoras
    apiUrl = urlConfig.futures_rest_api_url;
    ws_apiUrl = urlConfig.futures_ws_api_url;
    wss_market_Url = urlConfig.futures_ws_market_url;
    
    console.log(`[CONFIG] Credenciais carregadas do banco de dados (Corretora: ${credentials.corretora}, Ambiente: ${credentials.ambiente})`);
    console.log(`[CONFIG] URLs configuradas - API: ${apiUrl}, WS API: ${ws_apiUrl}, WS Market: ${wss_market_Url}`);
    
    return true;
  } catch (error) {
    console.error('[CONFIG] Erro ao carregar credenciais do banco de dados:', error.message);
       
    return false;
  }
}

// Modificar a função createEd25519Signature para usar a chave privada do banco
function createEd25519Signature(payload) {
  try {
    if (!privateKey) {
      throw new Error('Chave privada Ed25519 não está disponível');
    }
    
    try {
      // Converter o payload para Buffer
      const messageBuffer = Buffer.from(payload);
      
      // Ed25519 não usa o método createSign com digest
      // Em vez disso, usamos diretamente sign com a chave privada
      const signature = crypto.sign(null, messageBuffer, privateKey);
      
      // Converter a assinatura para base64
      return signature.toString('base64');
    } catch (signError) {
      console.error('[WS-API] Erro específico ao assinar com Ed25519:', signError);
      
      // Fallback para compatibilidade: se falhar com Ed25519, tentar com HMAC SHA256 
      console.log('[WS-API] Tentando fallback para HMAC-SHA256');
      
      if (!apiSecret) {
        throw new Error('API_SECRET não está disponível para fallback');
      }
      
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(payload)
        .digest('hex');
        
      return signature;
    }
  } catch (error) {
    console.error('[WS-API] Erro ao criar assinatura Ed25519:', error);
    throw error;
  }
}

// Atualizar a função createListenKey para usar o apiKey do banco
async function createListenKey() {
  try {
    // Garantir que as credenciais estão carregadas
    if (!apiKey) {
      await loadCredentialsFromDatabase();
    }
    
    const endpoint = '/v1/listenKey';
    const fullUrl = `${apiUrl}${endpoint}`;

    console.log(`[WEBSOCKET] Obtendo listenKey via: ${fullUrl}`);

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
    }
    throw error;
  }
}

// Atualizar a função keepAliveListenKey para usar o apiKey do banco
async function keepAliveListenKey(listenKey) {
  try {
    // Garantir que as credenciais estão carregadas
    if (!apiKey) {
      await loadCredentialsFromDatabase();
    }
    
    const endpoint = '/v1/listenKey';
    return axios.put(`${apiUrl}${endpoint}?listenKey=${listenKey}`, null, {
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });
  } catch (error) {
    console.error('[WEBSOCKET] Erro ao manter listenKey ativo:', error.message);
    throw error;
  }
}

// Atualizar a função closeListenKey para usar o apiKey do banco
async function closeListenKey(listenKey) {
  try {
    // Garantir que as credenciais estão carregadas
    if (!apiKey) {
      await loadCredentialsFromDatabase();
    }
    
    const endpoint = '/v1/listenKey';
    return axios.delete(`${apiUrl}${endpoint}?listenKey=${listenKey}`, {
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });
  } catch (error) {
    console.error('[WEBSOCKET] Erro ao fechar listenKey:', error.message);
    throw error;
  }
}

// Atualizar a função startWebSocketApi para garantir que as credenciais sejam carregadas
async function startWebSocketApi() {
  // Garantir que as credenciais estão carregadas antes de iniciar a conexão
  await loadCredentialsFromDatabase();
  
  if (!apiKey) {
    throw new Error('API Key não está disponível. Impossível iniciar WebSocket API');
  }
  
  if (wsApiConnection && wsApiConnection.readyState === WebSocket.OPEN) {
    //console.log('[WS-API] Conexão WebSocket API já está ativa');
    return wsApiConnection;
  }

  try {
    console.log('[WS-API] Iniciando conexão com API WebSocket...');
    
    // Determinar a URL correta com base no ambiente (testnet ou produção)
    const wsApiEndpoint = process.env.NODE_ENV === 'production' 
      ? 'wss://ws-fapi.binance.com/ws-fapi/v1'
      : 'wss://testnet.binancefuture.com/ws-fapi/v1';
    
    console.log(`[WS-API] Conectando ao endpoint: ${wsApiEndpoint}`);
    
    // IMPORTANTE: Agora retornamos uma Promessa que se resolve quando a conexão estiver pronta
    return new Promise((resolve, reject) => {
      // Criar a conexão WebSocket
      const ws = new WebSocket(wsApiEndpoint);
      
      // Configurar um timeout para a conexão
      const connectionTimeout = setTimeout(() => {
        reject(new Error('[WS-API] Timeout ao estabelecer conexão WebSocket API'));
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.terminate();
        }
      }, 15000); // 15 segundos de timeout
      
      // Configurar manipuladores de eventos
      ws.on('open', () => {
        console.log('[WS-API] Conexão WebSocket API estabelecida com sucesso');
        clearTimeout(connectionTimeout);
        wsApiConnection = ws;
        
        // Iniciar heartbeat
        startHeartbeat();
        
        // Agora que a conexão está estabelecida, resolvemos a promessa
        resolve(ws);
      });
      
      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data);
          //console.log('[WS-API] Resposta recebida:', JSON.stringify(response));
          
          // Verificar se é um ping e responder com pong
          if (response.id === 'ping') {
            sendPong(response.result?.pong || 'pong');
            return;
          }
          
          // Se temos um callback registrado para este ID de requisição
          if (response.id && requestCallbacks.has(response.id)) {
            const { resolve, reject, timer } = requestCallbacks.get(response.id);
            
            // Limpar o timeout
            if (timer) clearTimeout(timer);
            
            // Resolver ou rejeitar a promessa com base no status
            if (response.status === 200) {
              resolve(response);
            } else {
              reject(response);
            }
            
            // Remover o callback da lista
            requestCallbacks.delete(response.id);
          }
          
          // Notificar outros manipuladores sobre a resposta
          if (handlers.onWebSocketApiResponse) {
            handlers.onWebSocketApiResponse(response);
          }
          
        } catch (error) {
          console.error('[WS-API] Erro ao processar resposta:', error);
        }
      });
      
      ws.on('pong', () => {
        //console.log('[WS-API] Pong recebido do servidor');
        lastPongTime = Date.now();
      });
      
      ws.on('ping', () => {
        //console.log('[WS-API] Ping recebido do servidor, respondendo com pong');
        ws.pong();
        lastPongTime = Date.now();
      });
      
      ws.on('error', (error) => {
        console.error('[WS-API] Erro na conexão WebSocket API:', error);
        clearTimeout(connectionTimeout);
        cleanupWebSocketApi();
        reject(error);
      });
      
      ws.on('close', () => {
        console.log('[WS-API] Conexão WebSocket API fechada - tentando reconectar...');
        clearTimeout(connectionTimeout);
        cleanupWebSocketApi();
        
        // Não rejeitamos aqui se já resolvemos a promessa antes
        // porque pode ser um fechamento posterior ao sucesso inicial
      });
    });
  } catch (error) {
    console.error('[WS-API] Erro ao iniciar WebSocket API:', error);
    cleanupWebSocketApi();
    throw error;
  }
}

// Função para limpar recursos do WebSocket API
function cleanupWebSocketApi() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
    
    wsApiConnection = null;
    wsApiAuthenticated = false;
    
    // Rejeitar todas as promessas pendentes
    for (const [id, { reject, timer }] of requestCallbacks.entries()) {
        if (timer) clearTimeout(timer);
        reject({ error: 'Connection closed', id });
    }
    
    requestCallbacks.clear();
}

// Função para iniciar o heartbeat do WebSocket API
function startHeartbeat() {
    if (pingInterval) {
        clearInterval(pingInterval);
    }
    
    // Enviar ping a cada 3 minutos
    pingInterval = setInterval(() => {
        if (wsApiConnection && wsApiConnection.readyState === WebSocket.OPEN) {
            const pingRequest = {
                id: 'ping',
                method: 'ping'
            };
            
            try {
                wsApiConnection.send(JSON.stringify(pingRequest));
                //console.log('[WS-API] Ping enviado');
                
                // Verificar se recebemos pong dentro de um tempo razoável
                const timeSinceLastPong = Date.now() - lastPongTime;
                if (timeSinceLastPong > 5 * 60 * 1000) { // 5 minutos
                    console.warn('[WS-API] Nenhum pong recebido por mais de 5 minutos. Reconectando...');
                    wsApiConnection.terminate();
                    cleanupWebSocketApi();
                    setTimeout(startWebSocketApi, 1000);
                }
            } catch (error) {
                console.error('[WS-API] Erro ao enviar ping:', error);
            }
        }
    }, 3 * 60 * 1000); // 3 minutos
}

// Função para enviar pong em resposta a ping
function sendPong(payload = '') {
    if (wsApiConnection && wsApiConnection.readyState === WebSocket.OPEN) {
        try {
            const pongRequest = {
                id: 'pong',
                method: 'pong',
                params: { pong: payload }
            };
            
            wsApiConnection.send(JSON.stringify(pongRequest));
            //console.log('[WS-API] Pong enviado com payload:', payload);
        } catch (error) {
            console.error('[WS-API] Erro ao enviar pong:', error);
        }
    }
}

// Função para verificar o status da sessão
async function checkSessionStatus() {
    try {
        const response = await sendWebSocketApiRequest({
            method: 'session.status'
        });
        
        if (response && response.result) {
            wsApiAuthenticated = response.result.apiKey !== null;
            //console.log(`[WS-API] Status da sessão: ${wsApiAuthenticated ? 'Autenticado' : 'Não autenticado'}`);
        }
        
        return response;
    } catch (error) {
        console.error('[WS-API] Erro ao verificar status da sessão:', error);
        return { authenticated: false, error };
    }
}

// Função para autenticar o WebSocket API
async function authenticateWebSocketApi() {
    try {
        // Garantir que a conexão está estabelecida antes de tentar autenticar
        if (!wsApiConnection || wsApiConnection.readyState !== WebSocket.OPEN) {
            console.log('[WS-API] Conexão não está aberta. Iniciando nova conexão...');
            wsApiConnection = await startWebSocketApi();
            
            // Pequena pausa para garantir que a conexão está totalmente ativa
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Verificar se já está autenticado
        const sessionStatus = await checkSessionStatus();
        if (sessionStatus && sessionStatus.result && sessionStatus.result.apiKey) {
            console.log('[WS-API] Sessão já está autenticada');
            wsApiAuthenticated = true;
            return true;
        }
        
        // Criar parâmetros para autenticação
        const timestamp = Date.now();
        
        // Criar string para assinar
        const payload = `apiKey=${apiKey}&timestamp=${timestamp}`;
        
        // Assinar usando Ed25519
        const signature = createEd25519Signature(payload);
        
        // Preparar parâmetros com assinatura
        const params = {
            apiKey,
            timestamp,
            signature
        };
        
        // Enviar requisição de autenticação
        try {
            const response = await sendWebSocketApiRequest({
                method: 'session.logon',
                params
            });
            
            if (response && response.status === 200) {
                wsApiAuthenticated = true;
                //console.log('[WS-API] Autenticação Ed25519 bem-sucedida');
                return true;
            } else {
                // Tratamento para erro do Ed25519
                if (response.error) {
                    console.error(`[WS-API] Erro de autenticação Ed25519: ${response.error.code} - ${response.error.msg}`);
                    
                    // Caso específico para "Ed25519 API key not supported" (código similar ao -4056)
                    if (response.error.code === -4056 || response.error.msg.includes('Ed25519')) {
                        console.log('[WS-API] Autenticação Ed25519 não suportada. Continuando em modo não autenticado.');
                        wsApiAuthenticated = false;
                        return false;
                    }
                }
                
                console.error('[WS-API] Falha na autenticação:', response);
                return false;
            }
        } catch (authError) {
            console.error('[WS-API] Erro durante autenticação Ed25519:', authError);
            return false;
        }
    } catch (error) {
        console.error('[WS-API] Erro durante autenticação Ed25519:', error);
        return false;
    }
}

/**
 * Cria uma assinatura usando Ed25519
 * @param {string} payload - Dados a serem assinados
 * @returns {string} Assinatura em formato base64
 */
function createEd25519Signature(payload) {
    try {
        if (!privateKey) {
            throw new Error('Chave privada Ed25519 não está disponível');
        }
        
        //console.log(`[WS-API] Gerando assinatura Ed25519 para payload: ${payload.substring(0, 100)}...`);
        
        try {
            // Converter o payload para Buffer
            const messageBuffer = Buffer.from(payload);
            
            // Ed25519 não usa o método createSign com digest
            // Em vez disso, usamos diretamente sign com a chave privada
            const signature = crypto.sign(null, messageBuffer, privateKey);
            
            // Converter a assinatura para base64
            return signature.toString('base64');
        } catch (signError) {
            console.error('[WS-API] Erro específico ao assinar com Ed25519:', signError);
            
            // Fallback para compatibilidade: se falhar com Ed25519, tentar com HMAC SHA256 
            console.log('[WS-API] Tentando fallback para HMAC-SHA256');
            
            if (!apiSecret) {
                throw new Error('API_SECRET não está disponível para fallback');
            }
            
            const signature = crypto
                .createHmac('sha256', apiSecret)
                .update(payload)
                .digest('hex');
                
            return signature;
        }
    } catch (error) {
        console.error('[WS-API] Erro ao criar assinatura Ed25519:', error);
        throw error;
    }
}

// Função para enviar uma requisição via WebSocket API
async function sendWebSocketApiRequest(request, timeout = 30000) {
    // Garantir que a conexão está ativa
    if (!wsApiConnection || wsApiConnection.readyState !== WebSocket.OPEN) {
        console.log('[WS-API] Conexão não está aberta. Esperando estabelecer conexão antes de enviar requisição...');
        try {
            wsApiConnection = await startWebSocketApi();
            
            // Pequena pausa para garantir estabilidade após abertura
            await new Promise(resolve => setTimeout(resolve, 500));
        } catch (connError) {
            console.error('[WS-API] Falha ao estabelecer conexão:', connError);
            throw new Error('Não foi possível estabelecer conexão WebSocket API');
        }
    }
    
    // ATUALIZADO: Adicionar assinatura Ed25519 para cada requisição se não estivermos autenticados
    if (!wsApiAuthenticated && 
        request.method !== 'ping' && 
        request.method !== 'pong' && 
        request.method !== 'session.status' && 
        request.method !== 'session.logon') {
        
        // Se params não existir, inicializá-lo
        if (!request.params) {
            request.params = {};
        }
        
        // Adicionar apiKey e timestamp se não existirem
        if (!request.params.apiKey) {
            request.params.apiKey = apiKey;
        }
        
        if (!request.params.timestamp) {
            request.params.timestamp = Date.now();
        }
        
        // Ordenar parâmetros e criar string para assinatura
        const queryString = Object.keys(request.params)
            .sort()
            .filter(key => key !== 'signature') // Remover signature existente se houver
            .map(key => `${key}=${request.params[key]}`)
            .join('&');
        
        try {
            // Assinar com Ed25519
            const signature = createEd25519Signature(queryString);
            
            // Adicionar assinatura
            request.params.signature = signature;
        } catch (error) {
            console.error('[WS-API] Erro ao gerar assinatura Ed25519 para requisição:', error);
            throw new Error(`Erro ao gerar assinatura Ed25519: ${error.message}`);
        }
    }
    
    // Garantir que temos um ID para a requisição
    const requestId = request.id || uuidv4();
    request.id = requestId;
    
    return new Promise((resolve, reject) => {
        try {
            // Registrar callback para esta requisição
            const timeoutTimer = setTimeout(() => {
                if (requestCallbacks.has(requestId)) {
                    requestCallbacks.delete(requestId);
                    reject({ error: 'Timeout', id: requestId });
                }
            }, timeout);
            
            requestCallbacks.set(requestId, { resolve, reject, timer: timeoutTimer });
            
            // Log para diagnóstico em caso de problemas
            //console.log(`[WS-API] Enviando requisição ID: ${requestId}, método: ${request.method}`);
            
            // Enviar a requisição
            wsApiConnection.send(JSON.stringify(request));
        } catch (error) {
            // Se ocorrer um erro ao enviar, remover o callback e rejeitar
            requestCallbacks.delete(requestId);
            console.error(`[WS-API] Erro ao enviar requisição ${requestId}:`, error);
            reject(error);
        }
    });
}

// Função para criar e assinar uma requisição WebSocket API TRADE
function createSignedRequest(method, params = {}) {
  // Criar um ID único para a requisição
  const requestId = uuidv4();
  
  // Se a API estiver autenticada, podemos enviar requisições simples para métodos que não exigem autenticação
  if (wsApiAuthenticated && (method === 'ping' || method === 'pong' || method === 'session.status')) {
    return {
      id: requestId,
      method,
      params: params || {}
    };
  }
  
  // Para métodos que exigem autenticação, adicionar apiKey e timestamp
  const requestParams = {
    ...params,
    apiKey,
    timestamp: Date.now()
  };
  
  // Ordenar parâmetros alfabeticamente e criar string para assinatura
  const queryString = Object.keys(requestParams)
    .sort()
    .filter(key => key !== 'signature')
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');
  
  // Assinar com Ed25519
  const signature = createEd25519Signature(queryString);
  
  // Adicionar assinatura aos parâmetros
  requestParams.signature = signature;
  
  // Retornar objeto de requisição completo
  return {
    id: requestId,
    method,
    params: requestParams
  };
}

// Garantir que um websocket de preço existe para o símbolo
async function ensurePriceWebsocketExists(symbol) {
    if (priceWebsockets[symbol] && priceWebsockets[symbol].readyState === WebSocket.OPEN) {
        return;
    }

    if (priceWebsockets[symbol]) {
        try {
            priceWebsockets[symbol].close();
        } catch (e) {
            // Ignorar erros ao fechar
        }
        delete priceWebsockets[symbol];
    }

    console.log(`[WEBSOCKET] Iniciando monitoramento de preço para ${symbol}`);

    const wsUrl = `${wss_market_Url}/${symbol.toLowerCase()}@bookTicker`;
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

        setTimeout(() => {
            if (priceWebsockets[symbol] === ws) {
                delete priceWebsockets[symbol];
                ensurePriceWebsocketExists(symbol);
            }
        }, 5000);
    });

    ws.on('close', () => {
        console.log(`[WEBSOCKET] Conexão de preço fechada para ${symbol}`);

        setTimeout(() => {
            if (priceWebsockets[symbol] === ws) {
                delete priceWebsockets[symbol];
                ensurePriceWebsocketExists(symbol);
            }
        }, 5000);
    });

    priceWebsockets[symbol] = ws;
}

// Função para lidar com atualizações de preço
async function handlePriceUpdate(symbol, tickerData) {
    try {
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

function setupBookDepthWebsocket(symbol, callback) {
    const wsEndpoint = `${wss_market_Url}/${symbol.toLowerCase()}@bookTicker`;
    console.log(`[WEBSOCKET] Conectando ao BookTicker em tempo real: ${wsEndpoint}`);
    
    let ws = new WebSocket(wsEndpoint);
    let connectionTimeout = null;
    let heartbeatInterval = null;
    let reconnectAttempt = 0;
    const MAX_RECONNECT_ATTEMPTS = 5;

    connectionTimeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            console.error(`[WEBSOCKET] Timeout ao estabelecer conexão para ${symbol} BookTicker`);
            ws.terminate();
        }
    }, 10000);

    ws.on('open', () => {
        console.log(`[WEBSOCKET] BookTicker WebSocket conectado para ${symbol}`);
        clearTimeout(connectionTimeout);
        reconnectAttempt = 0;

        heartbeatInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 15000);
    });
    
    ws.on('message', (data) => {
        try {
            const tickerData = JSON.parse(data);
            
            if (tickerData && 
                (tickerData.e === 'bookTicker' || tickerData.e === undefined) && 
                typeof tickerData.b === 'string' && 
                typeof tickerData.a === 'string') {
                
                const bestBid = parseFloat(tickerData.b);
                const bestAsk = parseFloat(tickerData.a);
                const bestBidQty = parseFloat(tickerData.B || '0');
                const bestAskQty = parseFloat(tickerData.A || '0');
                
                if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid > 0 && bestAsk > 0) {
                    callback({
                        bestBid, 
                        bestAsk,
                        bestBidQty,
                        bestAskQty,
                        timestamp: tickerData.E || Date.now()
                    });
                } else {
                    console.log(`[WEBSOCKET] Valores numéricos inválidos em BookTicker para ${symbol}: bid=${bestBid}, ask=${bestAsk}`);
                }
            } else {
                console.log(`[WEBSOCKET] Formato inesperado de dados BookTicker para ${symbol}: ${JSON.stringify(tickerData).substring(0, 200)}`);
            }
        } catch (error) {
            console.error(`[WEBSOCKET] Erro ao processar BookTicker para ${symbol}:`, error.message);
        }
    });
    
    ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        clearInterval(heartbeatInterval);
        console.error(`[WEBSOCKET] Erro na conexão BookTicker para ${symbol}:`, error.message);
    });
    
    ws.on('close', () => {
        clearTimeout(connectionTimeout);
        clearInterval(heartbeatInterval);
        console.log(`[WEBSOCKET] BookTicker WebSocket fechado para ${symbol}`);
        
        const shouldReconnect = false; // Desativar reconexão automática
        
        if (shouldReconnect && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
            reconnectAttempt++;
            const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
            console.log(`[WEBSOCKET] Tentando reconectar BookTicker para ${symbol} em ${delay/1000}s (tentativa ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
            
            setTimeout(() => {
                try {
                    ws = new WebSocket(wsEndpoint);
                    
                    ws.on('open', function() {
                        console.log(`[WEBSOCKET] BookTicker WebSocket reconectado para ${symbol}`);
                        clearTimeout(connectionTimeout);
                        reconnectAttempt = 0;
                        
                        heartbeatInterval = setInterval(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.ping();
                            }
                        }, 15000);
                    });
                    
                    ws.on('message', (data) => {
                        try {
                            const tickerData = JSON.parse(data);
                            // Processamento da mensagem...
                        } catch (error) {
                            console.error(`[WEBSOCKET] Erro ao processar BookTicker para ${symbol}:`, error.message);
                        }
                    });
                    
                    ws.on('error', (err) => {
                        console.error(`[WEBSOCKET] Erro na reconexão BookTicker para ${symbol}:`, err.message);
                    });
                    
                    ws.on('close', () => {
                        console.log(`[WEBSOCKET] BookTicker reconectado foi fechado para ${symbol}`);
                    });
                    
                } catch (reconnectError) {
                    console.error(`[WEBSOCKET] Erro ao reconectar BookTicker para ${symbol}:`, reconnectError.message);
                }
            }, delay);
        }   
    });
    
    return ws;
}

function stopPriceMonitoring(symbol) {
    if (priceWebsockets[symbol]) {
        console.log(`[WEBSOCKET] Fechando websocket de preço para ${symbol} por solicitação externa`);
        priceWebsockets[symbol].close();
        delete priceWebsockets[symbol];
        return true;
    }
    return false;
}

/**
 * Inicia o stream de dados do usuário
 * @param {Object} db - Conexão com o banco de dados (opcional)
 * @returns {Promise<string>} - O listenKey gerado
 */
async function startUserDataStream(db) {
  try {
    // Garantir que as credenciais estão carregadas
    await loadCredentialsFromDatabase();
    
    // Obter um novo listenKey
    const listenKey = await createListenKey();
    
    // Iniciar o WebSocket para dados do usuário
    if (listenKey) {
      console.log(`[WEBSOCKET] Obtendo listenKey via: ${apiUrl}/v1/listenKey`);
      
      // Configuração do WebSocket
      const wsUrl = `${wss_market_Url}/${listenKey}`;
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        console.log('[WEBSOCKET] Conexão de dados do usuário estabelecida com sucesso');
        
        // Iniciar o keepalive para o listenKey
        startListenKeyKeepAlive(listenKey);
        
        // Salvar o socket e listenKey
        userDataWebSocket = ws;
        currentListenKey = listenKey;
      });
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data);
          
          // Processar diferentes tipos de eventos
          if (message.e === 'ORDER_TRADE_UPDATE') {
            if (handlers.handleOrderUpdate) {
              await handlers.handleOrderUpdate(message.o, db);
            }
          } else if (message.e === 'ACCOUNT_UPDATE') {
            if (handlers.handleAccountUpdate) {
              await handlers.handleAccountUpdate(message, db);
            }
          }
          // Outros tipos de eventos podem ser processados aqui
          
        } catch (error) {
          console.error('[WEBSOCKET] Erro ao processar mensagem:', error);
        }
      });
      
      ws.on('error', (error) => {
        console.error('[WEBSOCKET] Erro na conexão de dados do usuário:', error);
        restartUserDataStream(db);
      });
      
      ws.on('close', () => {
        console.log('[WEBSOCKET] Conexão de dados do usuário fechada');
        restartUserDataStream(db);
      });
      
      return listenKey;
    } else {
      throw new Error('Não foi possível obter listenKey');
    }
  } catch (error) {
    console.error('[WEBSOCKET] Erro ao iniciar stream de dados do usuário:', error.message);
    throw error;
  }
}

/**
 * Reinicia o stream de dados do usuário após um tempo
 * @param {Object} db - Conexão com o banco de dados (opcional)
 */
function restartUserDataStream(db) {
  // Limpar o keepalive atual se existir
  if (listenKeyKeepAliveInterval) {
    clearInterval(listenKeyKeepAliveInterval);
    listenKeyKeepAliveInterval = null;
  }
  
  // Aguardar um tempo antes de reconectar
  setTimeout(async () => {
    try {
      await startUserDataStream(db);
    } catch (error) {
      console.error('[WEBSOCKET] Erro ao reiniciar stream de dados do usuário:', error);
    }
  }, 5000); // Tentar reconectar após 5 segundos
}

/**
 * Registra callbacks para eventos de WebSocket
 * @param {Object} callbackHandlers - Objeto com funções de callback
 * @returns {Object} O objeto handlers atualizado
 */
function setMonitoringCallbacks(callbackHandlers) {
    handlers = { ...handlers, ...callbackHandlers };
    return handlers;
}

/**
 * Retorna os handlers registrados
 * @returns {Object} O objeto handlers atual
 */
function getHandlers() {
    return handlers;
}

// Inicialização imediata - garantir que as credenciais sejam carregadas
(async function initialize() {
  try {
    console.log('[WEBSOCKETS] Iniciando carregamento de credenciais');
    await loadCredentialsFromDatabase();
    console.log('[WEBSOCKETS] Credenciais inicializadas com sucesso');
  } catch (error) {
    console.error('[WEBSOCKETS] Erro na inicialização de credenciais:', error.message);
  }
})();

// Exportar funções
module.exports = {
  startUserDataStream,
  setupBookDepthWebsocket,
  ensurePriceWebsocketExists,
  stopPriceMonitoring,
  reset: function() {
    dbInstance = null;
  },
  startWebSocketApi,
  authenticateWebSocketApi,
  sendWebSocketApiRequest,
  createSignedRequest,
  checkSessionStatus,
  cleanupWebSocketApi,
  isWebSocketApiAuthenticated: () => wsApiAuthenticated,
  isWebSocketApiConnected: () => wsApiConnection && wsApiConnection.readyState === WebSocket.OPEN,
  loadCredentialsFromDatabase,
  setMonitoringCallbacks,
  getHandlers,
};