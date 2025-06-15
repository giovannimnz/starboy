const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { getDatabaseInstance } = require('./db/conexao');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Cache para armazenar credenciais por conta
const accountCredentialsCache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hora em ms
let lastCacheTime = 0;

// Variáveis por conta
const wsConnections = new Map(); // Mapeia accountId -> { wsApiConnection, userDataWebSocket, etc }
const priceWebsocketsByAccount = new Map(); // Mapeia accountId -> { symbol -> websocket }

// Declare object para inicialização básica
function getAccountConnectionState(accountId = 1, create = false) {
  if (!wsConnections.has(accountId) && create) {
    wsConnections.set(accountId, {
      wsApiConnection: null,
      wsApiAuthenticated: false,
      pingInterval: null,
      lastPongTime: Date.now(),
      requestCallbacks: new Map(),
      userDataWebSocket: null,
      currentListenKey: null,
      listenKeyKeepAliveInterval: null,
      handlers: {},
      dbInstance: null,
      apiKey: null,
      apiSecret: null,
      privateKey: null,
      apiUrl: process.env.API_URL || 'https://fapi.binance.com/fapi',
      wsApiUrl: process.env.WS_API_URL || 'wss://ws-fapi.binance.com/ws-fapi',
      wssMarketUrl: process.env.WS_URL || 'wss://fstream.binance.com/ws'
    });
  }
  return wsConnections.get(accountId);
}

// Inicializar mapa de websockets de preço por conta
function getPriceWebsockets(accountId = 1, create = false) {
  if (!priceWebsocketsByAccount.has(accountId) && create) {
    priceWebsocketsByAccount.set(accountId, new Map());
  }
  return priceWebsocketsByAccount.get(accountId) || new Map();
}

async function loadCredentialsFromDatabase(options = {}) {
  try {
    const accountId = options.accountId || 1;
    const forceRefresh = options.forceRefresh || false;
    const currentTime = Date.now();
    
    console.log('[WEBSOCKETS] Iniciando carregamento de credenciais para conta ID:', accountId);
    
    // Usar cache se disponível e não expirado
    if (accountCredentialsCache.has(accountId) && !forceRefresh && 
        (currentTime - lastCacheTime < CACHE_TTL)) {
      console.log(`[WEBSOCKETS] Usando credenciais em cache para conta ${accountId}`);
      return accountCredentialsCache.get(accountId);
    }
    
    const db = await getDatabaseInstance(accountId);
    
    if (!db) {
      throw new Error(`Não foi possível obter conexão com o banco de dados para conta ${accountId}`);
    }
    
    // Query corrigida para usar os nomes corretos das colunas
    const [rows] = await db.query(`
      SELECT 
        c.id,
        c.api_key, 
        c.api_secret, 
        c.ws_api_key, 
        c.ws_api_secret,
        c.id_corretora,
        cor.spot_rest_api_url,
        cor.futures_rest_api_url,
        cor.futures_ws_market_url,
        cor.futures_ws_api_url,
        cor.corretora,
        cor.ambiente
      FROM contas c
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1 AND cor.ativa = 1`,
      [accountId]
    );
    
    if (rows.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }

    const accountData = rows[0];
    
    // Atualizar estado da conexão para esta conta específica
    const accountState = getAccountConnectionState(accountId, true);
    
    accountState.apiKey = accountData.api_key;
    accountState.apiSecret = accountData.api_secret;
    accountState.privateKey = accountData.ws_api_secret;
    accountState.apiUrl = accountData.futures_rest_api_url;
    accountState.wsApiUrl = accountData.futures_ws_api_url;
    accountState.wssMarketUrl = accountData.futures_ws_market_url;
    accountState.ambiente = accountData.ambiente;
    
    // Criar objeto de credenciais para o cache
    const credentials = {
      apiKey: accountState.apiKey,
      apiSecret: accountState.apiSecret,
      privateKey: accountState.privateKey,
      apiUrl: accountState.apiUrl,
      wsApiUrl: accountState.wsApiUrl,
      wssMarketUrl: accountState.wssMarketUrl,
      corretora: accountData.corretora,
      ambiente: accountData.ambiente,
      corretoraId: accountData.id_corretora,
      accountId
    };
    
    // Armazenar no cache
    accountCredentialsCache.set(accountId, credentials);
    lastCacheTime = currentTime;
    
    console.log(`[WEBSOCKETS] Credenciais inicializadas com sucesso para conta ${accountId} (corretora: ${accountData.corretora}, ambiente: ${accountData.ambiente})`);
    return credentials;
  } catch (error) {
    console.error(`[CONFIG] Erro ao carregar credenciais do banco de dados para conta ${options.accountId || 1}:`, error.message);
    throw error;
  }
}

/**
 * Cria uma assinatura Ed25519 para autenticação na API
 * @param {string} payload - Dados a serem assinados
 * @param {number} accountId - ID da conta
 * @returns {string} - Assinatura codificada em base64 ou hex
 */
function createEd25519Signature(payload, accountId = 1) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.privateKey) {
      throw new Error(`Chave privada não carregada para conta ${accountId}`);
    }
    
    // Verificar se a chave privada está no formato correto
    let privateKey = accountState.privateKey;
    
    // Remover prefixos se existirem
    if (privateKey.startsWith('0x')) {
      privateKey = privateKey.slice(2);
    }
    
    // Converter para Buffer se for string hex
    const keyBuffer = Buffer.from(privateKey, 'hex');
    
    // Verificar se o tamanho está correto (32 bytes para Ed25519)
    if (keyBuffer.length !== 32) {
      throw new Error(`Tamanho inválido da chave privada: ${keyBuffer.length} bytes (esperado: 32)`);
    }
    
    // Criar assinatura usando crypto nativo do Node.js
    const sign = crypto.createSign('SHA256');
    sign.update(payload);
    sign.end();
    
    // Para Ed25519, use o método sign com a chave
    const signature = crypto.sign(null, Buffer.from(payload), {
      key: keyBuffer,
      type: 'ed25519'
    });
    
    return signature.toString('base64');
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao criar assinatura Ed25519 para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Cria um novo listenKey para monitoramento de eventos da conta
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - ListenKey gerado pela API
 */
async function createListenKey(accountId = 1) {
  try {
    // Garantir que as credenciais estão carregadas
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiKey) {
      await loadCredentialsFromDatabase({ accountId });
    }
    
    const accountState2 = getAccountConnectionState(accountId);
    if (!accountState2.apiKey || !accountState2.apiUrl) {
      throw new Error(`Credenciais não carregadas corretamente para conta ${accountId}`);
    }
    
    const endpoint = '/v1/listenKey';
    const fullUrl = `${accountState2.apiUrl}${endpoint}`;

    console.log(`[WEBSOCKET] Obtendo listenKey via: ${fullUrl} para conta ${accountId}`);

    const response = await axios.post(fullUrl, null, {
      headers: {
        'X-MBX-APIKEY': accountState2.apiKey
      }
    });

    console.log(`[WEBSOCKET] ListenKey obtido com sucesso para conta ${accountId}: ${response.data.listenKey.substring(0, 10)}...`);
    return response.data.listenKey;
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao criar listenKey para conta ${accountId}:`, error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

/**
 * Prolonga a validade de um listenKey existente
 * @param {string} listenKey - ListenKey a ser prolongado
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function keepAliveListenKey(listenKey, accountId = 1) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiKey) {
      await loadCredentialsFromDatabase({ accountId });
    }
    
    const updatedAccountState = getAccountConnectionState(accountId);
    
    const endpoint = '/v1/listenKey';
    return axios.put(`${updatedAccountState.apiUrl}${endpoint}?listenKey=${listenKey}`, null, {
      headers: {
        'X-MBX-APIKEY': updatedAccountState.apiKey
      }
    });
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao manter listenKey ativo para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Inicia o processo de manter o listenKey ativo
 * @param {string} listenKey - ListenKey a ser mantido
 * @param {number} accountId - ID da conta
 */
function startListenKeyKeepAlive(listenKey, accountId = 1) {
  const accountState = getAccountConnectionState(accountId, true);
  
  // Limpar intervalo anterior se existir
  if (accountState.listenKeyKeepAliveInterval) {
    clearInterval(accountState.listenKeyKeepAliveInterval);
  }
  
  // Criar novo intervalo para esta conta específica
  accountState.listenKeyKeepAliveInterval = setInterval(async () => {
    try {
      await keepAliveListenKey(listenKey, accountId);
      console.log(`[WEBSOCKET] ListenKey para conta ${accountId} mantido ativo`);
    } catch (error) {
      console.error(`[WEBSOCKET] Erro ao renovar listenKey para conta ${accountId}:`, error.message);
    }
  }, 30 * 60 * 1000); // A cada 30 minutos (recomendado: menos de 60 min)
}

/**
 * Fecha um listenKey quando não mais necessário
 * @param {string} listenKey - ListenKey a ser fechado
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function closeListenKey(listenKey, accountId = 1) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiKey) {
      await loadCredentialsFromDatabase({ accountId });
    }
    
    const updatedAccountState = getAccountConnectionState(accountId);
    
    const endpoint = '/v1/listenKey';
    return axios.delete(`${updatedAccountState.apiUrl}${endpoint}?listenKey=${listenKey}`, {
      headers: {
        'X-MBX-APIKEY': updatedAccountState.apiKey
      }
    });
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao fechar listenKey para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Inicia a conexão com a WebSocket API da Binance
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Conexão WebSocket
 */
async function startWebSocketApi(accountId = 1) {
  // Garantir que as credenciais estão carregadas
  await loadCredentialsFromDatabase({ accountId });
  
  // Obter ou criar estado para esta conta
  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState.apiKey) {
    throw new Error(`API Key não disponível para conta ${accountId}. Impossível iniciar WebSocket API`);
  }
  
  if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
    return accountState.wsApiConnection;
  }

  try {
    console.log(`[WS-API] Iniciando conexão com API WebSocket para conta ${accountId}...`);
    
    // Determinar a URL correta
    // Determinar a URL correta baseada no ambiente da conta
    let wsApiEndpoint;
    if (accountState.ambiente === 'prd') {
      wsApiEndpoint = accountState.wsApiUrl || 'wss://ws-fapi.binance.com/ws-fapi/v1';
    } else {
      wsApiEndpoint = 'wss://testnet.binancefuture.com/ws-fapi/v1';
    }
    
    console.log(`[WS-API] Conectando ao endpoint: ${wsApiEndpoint} para conta ${accountId}`);
    
    // Returna uma promessa que se resolve quando a conexão estiver pronta
    return new Promise((resolve, reject) => {
      // Criar a conexão WebSocket
      const ws = new WebSocket(wsApiEndpoint);
      
      // Configurar um timeout para a conexão
      const connectionTimeout = setTimeout(() => {
        reject(new Error(`[WS-API] Timeout ao estabelecer conexão WebSocket API para conta ${accountId}`));
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.terminate();
        }
      }, 15000); // 15 segundos de timeout
      
      // Configurar manipuladores de eventos
      ws.on('open', () => {
        console.log(`[WS-API] Conexão WebSocket API estabelecida com sucesso para conta ${accountId}`);
        clearTimeout(connectionTimeout);
        accountState.wsApiConnection = ws;
        
        // Iniciar heartbeat para esta conta
        startHeartbeat(accountId);
        
        // Agora que a conexão está estabelecida, resolvemos a promessa
        resolve(ws);
      });
      
      ws.on('message', (data) => {
        try {
          const response = JSON.parse(data);
          
          // Verificar se é um ping e responder com pong
          if (response.id === 'ping') {
            sendPong(response.result?.pong || 'pong', accountId);
            return;
          }
          
          // Se temos um callback registrado para este ID de requisição
          if (response.id && accountState.requestCallbacks.has(response.id)) {
            const { resolve, reject, timer } = accountState.requestCallbacks.get(response.id);
            
            // Limpar o timeout
            if (timer) clearTimeout(timer);
            
            // Resolver ou rejeitar a promessa com base no status
            if (response.status === 200) {
              resolve(response);
            } else {
              reject(response);
            }
            
            // Remover o callback da lista
            accountState.requestCallbacks.delete(response.id);
          }
          
          // Notificar outros manipuladores sobre a resposta
          if (accountState.handlers.onWebSocketApiResponse) {
            accountState.handlers.onWebSocketApiResponse(response);
          }
          
        } catch (error) {
          console.error(`[WS-API] Erro ao processar resposta para conta ${accountId}:`, error);
        }
      });
      
      ws.on('pong', () => {
        accountState.lastPongTime = Date.now();
      });
      
      ws.on('ping', () => {
        ws.pong();
        accountState.lastPongTime = Date.now();
      });
      
      ws.on('error', (error) => {
        console.error(`[WS-API] Erro na conexão WebSocket API para conta ${accountId}:`, error);
        clearTimeout(connectionTimeout);
        cleanupWebSocketApi(accountId);
        reject(error);
      });
      
      ws.on('close', () => {
        console.log(`[WS-API] Conexão WebSocket API fechada para conta ${accountId} - tentando reconectar...`);
        clearTimeout(connectionTimeout);
        cleanupWebSocketApi(accountId);
      });
    });
  } catch (error) {
    console.error(`[WS-API] Erro ao iniciar WebSocket API para conta ${accountId}:`, error);
    cleanupWebSocketApi(accountId);
    throw error;
  }
}

/**
 * Limpa recursos do WebSocket API para uma conta específica
 * @param {number} accountId - ID da conta
 */
function cleanupWebSocketApi(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;
  
  if (accountState.pingInterval) {
    clearInterval(accountState.pingInterval);
    accountState.pingInterval = null;
  }
  
  accountState.wsApiConnection = null;
  accountState.wsApiAuthenticated = false;
  
  // Rejeitar todas as promessas pendentes
  for (const [id, { reject, timer }] of accountState.requestCallbacks.entries()) {
    if (timer) clearTimeout(timer);
    reject({ error: 'Connection closed', id });
  }
  
  accountState.requestCallbacks.clear();
}

/**
 * Inicia o heartbeat do WebSocket API para uma conta específica
 * @param {number} accountId - ID da conta
 */
function startHeartbeat(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;
  
  if (accountState.pingInterval) {
    clearInterval(accountState.pingInterval);
  }
  
  // Enviar ping a cada 3 minutos
  accountState.pingInterval = setInterval(() => {
    if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
      const pingRequest = {
        id: 'ping',
        method: 'ping'
      };
      
      try {
        accountState.wsApiConnection.send(JSON.stringify(pingRequest));
        
        // Verificar se recebemos pong dentro de um tempo razoável
        const timeSinceLastPong = Date.now() - accountState.lastPongTime;
        if (timeSinceLastPong > 5 * 60 * 1000) { // 5 minutos
          console.warn(`[WS-API] Nenhum pong recebido por mais de 5 minutos para conta ${accountId}. Reconectando...`);
          accountState.wsApiConnection.terminate();
          cleanupWebSocketApi(accountId);
          setTimeout(() => startWebSocketApi(accountId), 1000);
        }
      } catch (error) {
        console.error(`[WS-API] Erro ao enviar ping para conta ${accountId}:`, error);
      }
    }
  }, 3 * 60 * 1000); // 3 minutos
}

/**
 * Envia pong em resposta a ping
 * @param {string} payload - Payload a ser enviado com o pong
 * @param {number} accountId - ID da conta
 */
function sendPong(payload = '', accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;
  
  if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
    try {
      const pongRequest = {
        id: 'pong',
        method: 'pong',
        params: { pong: payload }
      };
      
      accountState.wsApiConnection.send(JSON.stringify(pongRequest));
    } catch (error) {
      console.error(`[WS-API] Erro ao enviar pong para conta ${accountId}:`, error);
    }
  }
}

/**
 * Verifica o status da sessão da WebSocket API
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da sessão
 */
async function checkSessionStatus(accountId = 1) {
  try {
    const response = await sendWebSocketApiRequest({
      method: 'session.status'
    }, 30000, accountId);
    
    const accountState = getAccountConnectionState(accountId, true);
    
    if (response && response.result) {
      accountState.wsApiAuthenticated = response.result.apiKey !== null;
    }
    
    return response;
  } catch (error) {
    console.error(`[WS-API] Erro ao verificar status da sessão para conta ${accountId}:`, error);
    return { authenticated: false, error };
  }
}

/**
 * Autentica a conexão da WebSocket API
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se autenticado com sucesso
 */
async function authenticateWebSocketApi(accountId = 1) {
  try {
    const accountState = getAccountConnectionState(accountId, true);
    
    // Garantir que a conexão está estabelecida
    if (!accountState.wsApiConnection || accountState.wsApiConnection.readyState !== WebSocket.OPEN) {
      console.log(`[WS-API] Conexão não está aberta para conta ${accountId}. Iniciando nova conexão...`);
      accountState.wsApiConnection = await startWebSocketApi(accountId);
      
      // Pequena pausa para garantir que a conexão está totalmente ativa
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Verificar se já está autenticado
    const sessionStatus = await checkSessionStatus(accountId);
    if (sessionStatus && sessionStatus.result && sessionStatus.result.apiKey) {
      console.log(`[WS-API] Sessão já está autenticada para conta ${accountId}`);
      accountState.wsApiAuthenticated = true;
      return true;
    }
    
    // Criar parâmetros para autenticação
    const timestamp = Date.now();
    
    // Criar string para assinar
    const payload = `apiKey=${accountState.apiKey}&timestamp=${timestamp}`;
    
    // Assinar usando Ed25519
    const signature = createEd25519Signature(payload, accountId);
    
    // Preparar parâmetros com assinatura
    const params = {
      apiKey: accountState.apiKey,
      timestamp,
      signature
    };
    
    // Enviar requisição de autenticação
    try {
      const response = await sendWebSocketApiRequest({
        method: 'session.logon',
        params
      }, 30000, accountId);
      
      if (response && response.status === 200) {
        accountState.wsApiAuthenticated = true;
        console.log(`[WS-API] Autenticação Ed25519 bem-sucedida para conta ${accountId}`);
        return true;
      } else {
        // Tratamento para erro do Ed25519
        if (response.error) {
          console.error(`[WS-API] Erro de autenticação Ed25519 para conta ${accountId}: ${response.error.code} - ${response.error.msg}`);
          
          // Caso específico para "Ed25519 API key not supported" (código similar ao -4056)
          if (response.error.code === -4056 || response.error.msg.includes('Ed25519')) {
            console.log(`[WS-API] Autenticação Ed25519 não suportada para conta ${accountId}. Continuando em modo não autenticado.`);
            accountState.wsApiAuthenticated = false;
            return false;
          }
        }
        
        console.error(`[WS-API] Falha na autenticação para conta ${accountId}:`, response);
        return false;
      }
    } catch (authError) {
      console.error(`[WS-API] Erro durante autenticação Ed25519 para conta ${accountId}:`, authError);
      return false;
    }
  } catch (error) {
    console.error(`[WS-API] Erro durante autenticação Ed25519 para conta ${accountId}:`, error);
    return false;
  }
}

/**
 * Envia uma requisição via WebSocket API
 * @param {Object} request - Objeto de requisição
 * @param {number} timeout - Tempo limite em ms
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function sendWebSocketApiRequest(request, timeout = 30000, accountId = 1) {
  const accountState = getAccountConnectionState(accountId, true);
  
  // Garantir que a conexão está ativa
  if (!accountState.wsApiConnection || accountState.wsApiConnection.readyState !== WebSocket.OPEN) {
    console.log(`[WS-API] Conexão não está aberta para conta ${accountId}. Esperando estabelecer conexão...`);
    try {
      accountState.wsApiConnection = await startWebSocketApi(accountId);
      
      // Pequena pausa para garantir estabilidade após abertura
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (connError) {
      console.error(`[WS-API] Falha ao estabelecer conexão para conta ${accountId}:`, connError);
      throw new Error(`Não foi possível estabelecer conexão WebSocket API para conta ${accountId}`);
    }
  }
  
  // Adicionar assinatura Ed25519 para cada requisição se não estivermos autenticados
  if (!accountState.wsApiAuthenticated && 
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
      request.params.apiKey = accountState.apiKey;
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
      const signature = createEd25519Signature(queryString, accountId);
      
      // Adicionar assinatura
      request.params.signature = signature;
    } catch (error) {
      console.error(`[WS-API] Erro ao gerar assinatura Ed25519 para requisição (conta ${accountId}):`, error);
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
        if (accountState.requestCallbacks.has(requestId)) {
          accountState.requestCallbacks.delete(requestId);
          reject({ error: 'Timeout', id: requestId });
        }
      }, timeout);
      
      accountState.requestCallbacks.set(requestId, { resolve, reject, timer: timeoutTimer });
      
      // Enviar a requisição
      accountState.wsApiConnection.send(JSON.stringify(request));
    } catch (error) {
      // Se ocorrer um erro ao enviar, remover o callback e rejeitar
      accountState.requestCallbacks.delete(requestId);
      console.error(`[WS-API] Erro ao enviar requisição ${requestId} para conta ${accountId}:`, error);
      reject(error);
    }
  });
}

/**
 * Cria uma requisição assinada para a API WebSocket
 * @param {string} method - Método da API
 * @param {Object} params - Parâmetros da requisição
 * @param {number} accountId - ID da conta
 * @returns {Object} - Requisição pronta para envio
 */
function createSignedRequest(method, params = {}, accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    throw new Error(`Estado da conexão não encontrado para conta ${accountId}. Chame loadCredentialsFromDatabase primeiro.`);
  }
  
  // Criar um ID único para a requisição
  const requestId = uuidv4();
  
  // Se a API estiver autenticada, podemos enviar requisições simples para métodos que não exigem autenticação
  if (accountState.wsApiAuthenticated && (method === 'ping' || method === 'pong' || method === 'session.status')) {
    return {
      id: requestId,
      method,
      params: params || {}
    };
  }
  
  // Para métodos que exigem autenticação, adicionar apiKey e timestamp
  const requestParams = {
    ...params,
    apiKey: accountState.apiKey,
    timestamp: Date.now()
  };
  
  // Ordenar parâmetros alfabeticamente e criar string para assinatura
  const queryString = Object.keys(requestParams)
    .sort()
    .filter(key => key !== 'signature')
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');
  
  // Assinar com Ed25519
  const signature = createEd25519Signature(queryString, accountId);
  
  // Adicionar assinatura aos parâmetros
  requestParams.signature = signature;
  
  // Retornar objeto de requisição completo
  return {
    id: requestId,
    method,
    params: requestParams
  };
}

/**
 * Garante que existe um websocket de preço para o símbolo
 * @param {string} symbol - Símbolo para monitorar
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function ensurePriceWebsocketExists(symbol, accountId = 1) {
  // Obter ou criar mapa de websockets para esta conta
  const priceWebsockets = getPriceWebsockets(accountId, true);
  
  // Verificar se já existe websocket ativo
  if (priceWebsockets.has(symbol) && priceWebsockets.get(symbol).readyState === WebSocket.OPEN) {
    return;
  }

  // Fechar websocket existente se não estiver aberto
  if (priceWebsockets.has(symbol)) {
    try {
      priceWebsockets.get(symbol).close();
    } catch (e) {
      // Ignorar erros ao fechar
    }
    priceWebsockets.delete(symbol);
  }

  // Garantir que temos as credenciais
  const accountState = getAccountConnectionState(accountId, true);
  if (!accountState.wssMarketUrl) {
    await loadCredentialsFromDatabase({ accountId });
  }
  
  const updatedAccountState = getAccountConnectionState(accountId);

  console.log(`[WEBSOCKET] Iniciando monitoramento de preço para ${symbol} (conta ${accountId})`);

  const wsUrl = `${updatedAccountState.wssMarketUrl}/ws/${symbol.toLowerCase()}@bookTicker`;
  console.log(`[WEBSOCKET] URL para monitoramento de preço: ${wsUrl}`);

  const ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.log(`[WEBSOCKET] Conexão de preço aberta para ${symbol} (conta ${accountId})`);
  });

  ws.on('message', async (data) => {
    const tickerData = JSON.parse(data);
    await handlePriceUpdate(symbol, tickerData, accountId);
  });

  ws.on('error', (error) => {
    console.error(`[WEBSOCKET] Erro na conexão de preço para ${symbol} (conta ${accountId}):`, error);

    setTimeout(() => {
      if (priceWebsockets.get(symbol) === ws) {
        priceWebsockets.delete(symbol);
        ensurePriceWebsocketExists(symbol, accountId);
      }
    }, 5000);
  });

  ws.on('close', () => {
    console.log(`[WEBSOCKET] Conexão de preço fechada para ${symbol} (conta ${accountId})`);

    setTimeout(() => {
      if (priceWebsockets.get(symbol) === ws) {
        priceWebsockets.delete(symbol);
        ensurePriceWebsocketExists(symbol, accountId);
      }
    }, 5000);
  });

  // Armazenar no mapa de websockets desta conta
  priceWebsockets.set(symbol, ws);
}

/**
 * Processa atualizações de preço recebidas via websocket
 * @param {string} symbol - Símbolo do par de negociação
 * @param {Object} tickerData - Dados recebidos pelo websocket
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function handlePriceUpdate(symbol, tickerData, accountId = 1) {
  try {
    const accountState = getAccountConnectionState(accountId, true);
    let db = accountState.dbInstance;
    
    // Se não tiver DB no estado, tentar obter do handler ou diretamente
    if (!db) {
      if (accountState.handlers && accountState.handlers.getDbConnection) {
        try {
          db = await accountState.handlers.getDbConnection();
          accountState.dbInstance = db;
        } catch (dbHandlerError) {
          console.error(`[WEBSOCKET] Erro ao obter DB via handler para ${symbol}: ${dbHandlerError.message}`);
        }
      }
      
      // Se ainda não tiver DB, tentar obter diretamente
      if (!db) {
        try {
          const { getDatabaseInstance } = require('./db/conexao');
          db = await getDatabaseInstance(accountId);
          accountState.dbInstance = db;
        } catch (directDbError) {
          console.error(`[WEBSOCKET] Erro ao obter DB diretamente para ${symbol}: ${directDbError.message}`);
        }
      }
    }

    if (!db) {
      console.error(`[WEBSOCKET] Não foi possível obter conexão com o banco de dados para ${symbol} (conta ${accountId})`);
      return;
    }

    const bestBid = parseFloat(tickerData.b);
    const bestAsk = parseFloat(tickerData.a);
    const currentPrice = (bestBid + bestAsk) / 2;

    if (accountState.handlers && accountState.handlers.onPriceUpdate) {
      await accountState.handlers.onPriceUpdate(symbol, currentPrice, db, accountId);
    }
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao processar atualização de preço para ${symbol} (conta ${accountId}):`, error);
  }
}

/**
 * Configura websocket para monitoramento de BookTicker em tempo real
 * @param {string} symbol - Símbolo do par de negociação
 * @param {function} callback - Função callback para processar atualizações
 * @param {number} accountId - ID da conta
 * @returns {WebSocket} Objeto websocket
 */
function setupBookDepthWebsocket(symbol, callback, accountId = 1) {
  // Garantir que temos as credenciais
  const accountState = getAccountConnectionState(accountId, true);
  
  const wsEndpoint = `${accountState.wssMarketUrl}/${symbol.toLowerCase()}@bookTicker`;
  console.log(`[WEBSOCKET] Conectando ao BookTicker em tempo real: ${wsEndpoint} (conta ${accountId})`);
  
  let ws = new WebSocket(wsEndpoint);
  let connectionTimeout = null;
  let heartbeatInterval = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;

  connectionTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error(`[WEBSOCKET] Timeout ao estabelecer conexão para ${symbol} BookTicker (conta ${accountId})`);
      ws.terminate();
    }
  }, 10000);

  ws.on('open', () => {
    console.log(`[WEBSOCKET] BookTicker WebSocket conectado para ${symbol} (conta ${accountId})`);
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
          console.log(`[WEBSOCKET] Valores numéricos inválidos em BookTicker para ${symbol} (conta ${accountId}): bid=${bestBid}, ask=${bestAsk}`);
        }
      } else {
        console.log(`[WEBSOCKET] Formato inesperado de dados BookTicker para ${symbol} (conta ${accountId})`);
      }
    } catch (error) {
      console.error(`[WEBSOCKET] Erro ao processar BookTicker para ${symbol} (conta ${accountId}):`, error.message);
    }
  });
  
  ws.on('error', (error) => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatInterval);
    console.error(`[WEBSOCKET] Erro na conexão BookTicker para ${symbol} (conta ${accountId}):`, error.message);
  });
  
  ws.on('close', () => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatInterval);
    console.log(`[WEBSOCKET] BookTicker WebSocket fechado para ${symbol} (conta ${accountId})`);

    // Lógica de reconexão desativada para evitar múltiplas conexões
    const shouldReconnect = false;
    
    if (shouldReconnect && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
      // Código de reconexão (omitido para maior clareza)
    }   
  });
  
  return ws;
}

/**
 * Interrompe o monitoramento de preço para um símbolo
 * @param {string} symbol - Símbolo do par de negociação
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se foi fechado com sucesso
 */
function stopPriceMonitoring(symbol, accountId = 1) {
  const priceWebsockets = getPriceWebsockets(accountId);
  if (!priceWebsockets) return false;
  
  if (priceWebsockets.has(symbol)) {
    console.log(`[WEBSOCKET] Fechando websocket de preço para ${symbol} (conta ${accountId}) por solicitação externa`);
    priceWebsockets.get(symbol).close();
    priceWebsockets.delete(symbol);
    return true;
  }
  return false;
}

/**
 * Inicia o stream de dados do usuário
 * @param {Object} db - Conexão com o banco de dados (opcional)
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - O listenKey gerado
 */
/**
 * Inicia o stream de dados do usuário
 * @param {Object} db - Conexão com o banco de dados (opcional)
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - O listenKey gerado
 */
async function startUserDataStream(db, accountId = 1) {
  try {
    // Garantir que as credenciais estão carregadas
    await loadCredentialsFromDatabase({ accountId });
    
    const accountState = getAccountConnectionState(accountId, true);
    
    // Verificar se já existe uma conexão ativa
    if (accountState.userDataWebSocket && 
        accountState.userDataWebSocket.readyState === WebSocket.OPEN) {
      console.log(`[WEBSOCKET] UserDataStream já está ativo para conta ${accountId}`);
      return accountState.currentListenKey;
    }
    
    // Obter um novo listenKey
    const listenKey = await createListenKey(accountId);
    accountState.currentListenKey = listenKey;
    
    if (listenKey) {
      // Construir URL correta para o WebSocket UserData
      const wsUrl = `${accountState.wssMarketUrl}/ws/${listenKey}`;
      console.log(`[WEBSOCKET] Conectando UserDataStream para conta ${accountId}: ${wsUrl}`);
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        console.log(`[WEBSOCKET] UserDataStream conectado para conta ${accountId}`);
        accountState.userDataWebSocket = ws;
        
        // Iniciar keep-alive do listenKey
        startListenKeyKeepAlive(listenKey, accountId);
      });
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data);
          
          // Processar diferentes tipos de eventos
          if (message.e === 'ORDER_TRADE_UPDATE') {
            console.log(`[WEBSOCKET] Atualização de ordem recebida para conta ${accountId}:`, message.o.i);
            if (accountState.handlers && accountState.handlers.handleOrderUpdate) {
              await accountState.handlers.handleOrderUpdate(message.o, db, accountId);
            }
          } else if (message.e === 'ACCOUNT_UPDATE') {
            console.log(`[WEBSOCKET] Atualização de conta recebida para conta ${accountId}`);
            if (accountState.handlers && accountState.handlers.handleAccountUpdate) {
              await accountState.handlers.handleAccountUpdate(message, db, accountId);
            }
          }
        } catch (parseError) {
          console.error(`[WEBSOCKET] Erro ao processar mensagem UserData para conta ${accountId}:`, parseError);
        }
      });
      
      ws.on('error', (error) => {
        console.error(`[WEBSOCKET] Erro na conexão de dados do usuário para conta ${accountId}:`, error);
        
        // Limpar estado
        accountState.userDataWebSocket = null;
        if (accountState.listenKeyKeepAliveInterval) {
          clearInterval(accountState.listenKeyKeepAliveInterval);
          accountState.listenKeyKeepAliveInterval = null;
        }
        
        // NÃO tentar reconectar automaticamente para evitar loop infinito
        console.log(`[WEBSOCKET] UserDataStream será reiniciado apenas quando necessário para conta ${accountId}`);
      });
      
      ws.on('close', () => {
        console.log(`[WEBSOCKET] Conexão de dados do usuário fechada para conta ${accountId}`);
        
        // Limpar estado
        accountState.userDataWebSocket = null;
        if (accountState.listenKeyKeepAliveInterval) {
          clearInterval(accountState.listenKeyKeepAliveInterval);
          accountState.listenKeyKeepAliveInterval = null;
        }
      });
      
      return listenKey;
    } else {
      throw new Error(`Falha ao obter listenKey para conta ${accountId}`);
    }
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao iniciar stream de dados do usuário para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Reinicia o stream de dados do usuário após um tempo
 * @param {Object} db - Conexão com o banco de dados (opcional)
 * @param {number} accountId - ID da conta
 */
function restartUserDataStream(db, accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;
  
  // Limpar o keepalive atual se existir
  if (accountState.listenKeyKeepAliveInterval) {
    clearInterval(accountState.listenKeyKeepAliveInterval);
    accountState.listenKeyKeepAliveInterval = null;
  }
  
  // Aguardar um tempo antes de reconectar
  setTimeout(async () => {
    try {
      await startUserDataStream(db, accountId);
    } catch (error) {
      console.error(`[WEBSOCKET] Erro ao reiniciar stream de dados do usuário para conta ${accountId}:`, error);
    }
  }, 5000); // Tentar reconectar após 5 segundos
}

/**
 * Registra callbacks para eventos de WebSocket
 * @param {Object} callbackHandlers - Objeto com funções de callback
 * @param {number} accountId - ID da conta
 * @returns {Object} O objeto handlers atualizado
 */
function setMonitoringCallbacks(callbackHandlers, accountId = 1) {
  const accountState = getAccountConnectionState(accountId, true);
  accountState.handlers = { ...accountState.handlers, ...callbackHandlers };
  return accountState.handlers;
}

/**
 * Retorna os handlers registrados para uma conta
 * @param {number} accountId - ID da conta
 * @returns {Object} O objeto handlers atual
 */
function getHandlers(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  return accountState ? accountState.handlers : {};
}

/**
 * Retorna as credenciais carregadas para uma conta
 * @param {number} accountId - ID da conta
 * @returns {Object} Credenciais carregadas ou null
 */
function getCredentials(accountId = 1) {
  // Verificar se há em cache
  if (accountCredentialsCache.has(accountId)) {
    return accountCredentialsCache.get(accountId);
  }
  
  // Se não existe no cache, tentar obter do estado da conexão
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    return null;
  }
  
  return {
    apiKey: accountState.apiKey,
    apiSecret: accountState.apiSecret,
    privateKey: accountState.privateKey,
    apiUrl: accountState.apiUrl,
    wsApiUrl: accountState.wsApiUrl,
    wssMarketUrl: accountState.wssMarketUrl
  };
}

/**
 * Garante que existe uma conexão WebSocket API ativa
 * @param {number} accountId - ID da conta
 * @returns {Promise<WebSocket>} - Conexão estabelecida
 */
async function ensureWebSocketApiExists(accountId = 1) {
  const accountState = getAccountConnectionState(accountId, true);
  
  // Se já existe uma conexão WebSocket API ativa, retorná-la
  if (accountState.wsApiConnection && 
      accountState.wsApiConnection.readyState === WebSocket.OPEN) {
    return accountState.wsApiConnection;
  }
  
  // Se não existe ou não está aberta, iniciar uma nova conexão
  console.log(`[WS-API] Iniciando WebSocket API para conta ${accountId}...`);
  const wsConnection = await startWebSocketApi(accountId);
  
  // Tentar autenticar após conexão estabelecida
  try {
    const authenticated = await authenticateWebSocketApi(accountId);
    console.log(`[WS-API] Autenticação da WebSocket API ${authenticated ? 'bem-sucedida' : 'falhou'} para conta ${accountId}`);
  } catch (authError) {
    console.error(`[WS-API] Erro na autenticação da WebSocket API para conta ${accountId}:`, authError.message);
  }
  
  return wsConnection;
}

// Adicionar à lista de exportações

/**
 * Verifica se a conexão WebSocket API está ativa
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se conectado
 */
function isWebSocketApiConnected(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return false;
  
  return accountState.wsApiConnection && 
         accountState.wsApiConnection.readyState === WebSocket.OPEN;
}


/**
 * Verifica se a conexão WebSocket API está autenticada
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se autenticado
 */
function isWebSocketApiAuthenticated(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return false;
  
  return accountState.wsApiAuthenticated === true;
}


/**
 * Reinicia as conexões WebSocket para uma conta específica
 * @param {number} accountId - ID da conta
 */
function reset(accountId = 1) {
  // Limpar WebSocket API
  cleanupWebSocketApi(accountId);
  
  // Limpar WebSockets de preço
  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets) {
    for (const [symbol, ws] of priceWebsockets.entries()) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    priceWebsockets.clear();
  }
  
  // Limpar userDataWebSocket
  const accountState = getAccountConnectionState(accountId);
  if (accountState) {
    if (accountState.userDataWebSocket && accountState.userDataWebSocket.readyState !== WebSocket.CLOSED) {
      accountState.userDataWebSocket.close();
    }
    
    accountState.userDataWebSocket = null;
    
    // Limpar keepalive do listenKey
    if (accountState.listenKeyKeepAliveInterval) {
      clearInterval(accountState.listenKeyKeepAliveInterval);
      accountState.listenKeyKeepAliveInterval = null;
    }
  }
  
  console.log(`[WEBSOCKETS] Todas as conexões WebSocket foram reiniciadas para conta ${accountId}`);
}

async function verificarChavePrivada() {
  try {
    console.log('=== VERIFICAÇÃO DA CHAVE PRIVADA ED25519 ===');
    
    const db = await getDatabaseInstance();
    
    // Verificar credenciais da conta 1
    const [contas] = await db.query(`
      SELECT c.id, c.nome, c.api_key, c.api_secret, 
             c.ws_api_key, c.ws_api_secret, c.private_key,
             cor.corretora, cor.ambiente
      FROM contas c 
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = 1
    `);
    
    if (contas.length === 0) {
      console.log('❌ Conta ID 1 não encontrada');
      return;
    }
    
    const conta = contas[0];
    console.log('Informações da Conta:');
    console.log(`- ID: ${conta.id}`);
    console.log(`- Nome: ${conta.nome}`);
    console.log(`- Corretora: ${conta.corretora} (${conta.ambiente})`);
    console.log(`- API Key: ${conta.api_key ? `${conta.api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- API Secret: ${conta.api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    console.log(`- WS API Key: ${conta.ws_api_key ? `${conta.ws_api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- WS API Secret: ${conta.ws_api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    console.log(`- Private Key: ${conta.private_key ? '✅ Configurada' : '❌ Não configurada'}`);
    
    // Verificar se private_key está vazia ou null
    if (!conta.private_key || conta.private_key.trim() === '') {
      console.log('\n⚠️ PROBLEMA IDENTIFICADO: Private Key está vazia!');
      console.log('\nSoluções possíveis:');
      console.log('1. Se você tem uma chave privada Ed25519, atualize o banco de dados');
      console.log('2. Se você só tem API Key/Secret padrão, desabilite WebSocket API');
      console.log('3. Gere uma nova chave Ed25519 na Binance');
      
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('\nDeseja desabilitar temporariamente a WebSocket API? (s/n): ', async (resposta) => {
        if (resposta.toLowerCase() === 's' || resposta.toLowerCase() === 'sim') {
          // Atualizar para copiar api_secret para private_key temporariamente
          await db.query(
            'UPDATE contas SET private_key = ? WHERE id = 1',
            [conta.api_secret || 'temp_disabled']
          );
          console.log('✅ Private key temporária configurada');
          console.log('⚠️ WebSocket API pode não funcionar corretamente');
        } else {
          console.log('Para configurar uma chave privada Ed25519:');
          console.log('1. Acesse sua conta Binance');
          console.log('2. Vá em API Management');
          console.log('3. Gere uma nova API Key com Ed25519');
          console.log('4. Atualize o banco: UPDATE contas SET private_key = "SUA_CHAVE_PRIVADA" WHERE id = 1;');
        }
        rl.close();
        process.exit(0);
      });
    } else {
      // Verificar se a chave privada tem o tamanho correto
      let privateKey = conta.private_key;
      if (privateKey.startsWith('0x')) {
        privateKey = privateKey.slice(2);
      }
      
      const keyBuffer = Buffer.from(privateKey, 'hex');
      console.log(`\nTamanho da chave privada: ${keyBuffer.length} bytes`);
      
      if (keyBuffer.length === 32) {
        console.log('✅ Chave privada Ed25519 tem tamanho correto');
      } else {
        console.log('❌ Chave privada Ed25519 tem tamanho incorreto (esperado: 32 bytes)');
        console.log('A chave pode ser uma API Secret normal, não uma chave Ed25519');
      }
    }
    
  } catch (error) {
    console.error('Erro:', error);
  }
}

module.exports = {
  startUserDataStream,
  setupBookDepthWebsocket,
  ensurePriceWebsocketExists,
  stopPriceMonitoring,
  reset,
  startWebSocketApi,
  authenticateWebSocketApi,
  sendWebSocketApiRequest,
  createSignedRequest,
  checkSessionStatus,
  cleanupWebSocketApi,
  isWebSocketApiAuthenticated,
  isWebSocketApiConnected,
  loadCredentialsFromDatabase,
  setMonitoringCallbacks,
  getHandlers,
  getAccountConnectionState,
  getCredentials,  // Adicionar esta função
  ensureWebSocketApiExists,  // Adicionar esta função
};