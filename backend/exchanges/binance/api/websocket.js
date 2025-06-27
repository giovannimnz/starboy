const WebSocket = require('ws');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDatabaseInstance } = require('../../../core/database/conexao');
const api = require('../api/rest');
const { getAccountConnectionState } = api;

// Variáveis para as bibliotecas Ed25519
let nobleEd25519SignFunction = null;
let tweetnaclInstance = null;

// Função para carregar @noble/ed25519 dinamicamente
async function loadNobleEd25519() {
  if (nobleEd25519SignFunction) return true;
  try {
    const nobleModule = await import('@noble/ed25519');
    if (nobleModule && typeof nobleModule.sign === 'function') {
      nobleEd25519SignFunction = nobleModule.sign;
      console.log('[WS-API] @noble/ed25519 carregado dinamicamente com sucesso.');
      return true;
    }
    console.log('[WS-API] @noble/ed25519 carregado, mas a função sign não foi encontrada.');
    return false;
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') {
        console.warn('[WS-API] Falha ao carregar @noble/ed25519 dinamicamente:', e.message);
    } else {
        console.log('[WS-API] @noble/ed25519 não instalado, pulando.');
    }
    return false;
  }
}

// Carregar tweetnacl
try {
  tweetnaclInstance = require('tweetnacl');
  console.log('[WS-API] tweetnacl carregado com sucesso.');
} catch (e) {
  console.log('[WS-API] tweetnacl não disponível, será usado apenas crypto nativo ou @noble/ed25519 (se disponível).');
}

// Mapa local para WebSockets de preço por conta
const priceWebsocketsByAccount = new Map();

/**
 * Obtém ou cria o mapa de WebSockets de preço para uma conta
 */
function getPriceWebsockets(accountId, create = false) {
  if (!priceWebsocketsByAccount.has(accountId) && create) {
    priceWebsocketsByAccount.set(accountId, new Map());
  }
  return priceWebsocketsByAccount.get(accountId) || new Map();
}

/**
 * Função de compatibilidade - redireciona para api.js
 */
function getAllAccountConnections() {
  return api.getAllAccountConnections();
}

/**
 * Cria assinatura Ed25519
 */
async function createEd25519Signature(payload, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiSecret) {
    throw new Error(`Chave privada Ed25519 (ws_api_secret no formato PEM) não encontrada para conta ${accountId}`);
  }
  
  const pemPrivateKey = accountState.wsApiSecret;
  console.log(`[WS-API] Gerando assinatura Ed25519 para conta ${accountId}`);
  
  const payloadBuffer = Buffer.from(payload, 'ascii');

  try {
    if (typeof pemPrivateKey !== 'string' || !pemPrivateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Chave privada não está no formato PEM string esperado.');
    }
    
    const privateKeyObject = crypto.createPrivateKey({
      key: pemPrivateKey,
      format: 'pem'
    });
    
    const signatureBuffer = crypto.sign(null, payloadBuffer, privateKeyObject);
    const signature = signatureBuffer.toString('base64');
    console.log(`[WS-API] ✅ Assinatura Ed25519 criada com crypto nativo para conta ${accountId}`);
    return signature;
  } catch (nativeCryptoError) {
    console.warn(`[WS-API] Falha ao assinar com crypto nativo para conta ${accountId}: ${nativeCryptoError.message}`);
    throw nativeCryptoError;
  }
}

/**
 * Cria uma requisição assinada para a API WebSocket
 */
async function createSignedRequest(method, params = {}, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    console.warn(`[WS-API] Estado da conta ${accountId} não encontrado em createSignedRequest.`);
    await api.loadCredentialsFromDatabase(accountId);
    const newState = getAccountConnectionState(accountId);
    if (!newState) {
      throw new Error(`Estado da conexão não encontrado para conta ${accountId}.`);
    }
  }
  
  const currentAccountState = getAccountConnectionState(accountId);
  if (!currentAccountState) {
      throw new Error(`Estado da conexão não encontrado para conta ${accountId}.`);
  }

  const requestId = uuidv4();
  
  // Métodos que não precisam de assinatura
  if (method === 'ping' || method === 'pong' || method === 'session.status') {
    return {
      id: requestId,
      method,
      params: params || {}
    };
  }
  
  const requestParams = {
    ...params,
    apiKey: currentAccountState.wsApiKey || currentAccountState.apiKey,
    timestamp: Date.now()
  };
  
  const sortedParams = Object.keys(requestParams)
    .filter(key => key !== 'signature')
    .sort()
    .map(key => `${key}=${requestParams[key]}`)
    .join('&');
  
  const signature = await createEd25519Signature(sortedParams, accountId);
  requestParams.signature = signature;
  
  return {
    id: requestId,
    method,
    params: requestParams
  };
}

/**
 * Inicia conexão WebSocket API para uma conta
 */
async function startWebSocketApi(accountId) {
  try {
    await api.loadCredentialsFromDatabase(accountId);
    let accountState = getAccountConnectionState(accountId);

    if (!accountState || !accountState.wsApiKey || !accountState.wsApiUrl) {
      console.error(`[WS-API] Credenciais ou URL da WebSocket API não encontradas para conta ${accountId}`);
      return false;
    }

    if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
      console.log(`[WS-API] Conexão WebSocket API já está ativa para conta ${accountId}`);
      return true;
    }

    console.log(`[WS-API] Iniciando WebSocket API para conta ${accountId}...`);
    const endpoint = accountState.wsApiUrl;

    return new Promise((resolve, reject) => {
      const wsInstance = new WebSocket(endpoint);
      accountState.wsApiConnection = wsInstance;

      const connectionTimeout = setTimeout(() => {
        if (wsInstance.readyState !== WebSocket.OPEN) {
          console.error(`[WS-API] Timeout ao conectar WebSocket API para conta ${accountId}`);
          wsInstance.terminate();
          reject(new Error(`Timeout ao conectar WebSocket API para conta ${accountId}`));
        }
      }, 30000);

      wsInstance.on('open', async () => {
        clearTimeout(connectionTimeout);
        console.log(`[WS-API] ✅ Conexão WebSocket API estabelecida para conta ${accountId}`);
        
        try {
          const authenticated = await authenticateWebSocketApi(wsInstance, accountId);
          resolve(authenticated);
        } catch (authError) {
          console.error(`[WS-API] Erro durante a autenticação para conta ${accountId}:`, authError.message);
          wsInstance.close(1008, "Authentication Error");
          reject(authError);
        }
      });

      wsInstance.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleWebSocketApiMessage(message, accountId);
        } catch (e) {
          console.error('[WS-API] Erro ao parsear mensagem JSON:', e, data.toString().substring(0, 500));
        }
      });

      wsInstance.on('error', (error) => {
        clearTimeout(connectionTimeout);
        console.error(`[WS-API] Erro na conexão WebSocket API para conta ${accountId}: ${error.message}`);
        reject(error);
      });

      wsInstance.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        console.log(`[WS-API] Conexão WebSocket API fechada para conta ${accountId}. Code: ${code}`);
        cleanupWebSocketApi(accountId);
      });
    });

  } catch (error) {
    console.error(`[WS-API] Erro ao iniciar WebSocket API para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Processa mensagens recebidas via WebSocket API - VERSÃO MELHORADA
 */
function handleWebSocketApiMessage(message, accountId) {
  try {
    const accountState = api.getAccountConnectionState(accountId);
    if (!accountState) {
      console.error(`[WS-API] Estado da conta ${accountId} não encontrado ao processar mensagem`);
      return;
    }
    
    // Parse da mensagem se for string
    let parsedMessage;
    try {
      parsedMessage = typeof message === 'string' ? JSON.parse(message) : message;
    } catch (parseError) {
      console.error(`[WS-API] Erro ao fazer parse da mensagem para conta ${accountId}:`, parseError.message);
      return;
    }
    
    // Processar diferentes tipos de mensagem
    if (parsedMessage.id) {
      // Resposta de requisição específica
      if (accountState.wsApiRequestCallbacks && accountState.wsApiRequestCallbacks.has(parsedMessage.id)) {
        const callback = accountState.wsApiRequestCallbacks.get(parsedMessage.id);
        accountState.wsApiRequestCallbacks.delete(parsedMessage.id);
        
        if (callback && typeof callback === 'function') {
          callback(parsedMessage);
        } else if (callback && callback.resolve) {
          callback.resolve(parsedMessage);
        }
      }
    } else if (parsedMessage.method === 'ping') {
      // Responder a ping
      sendPong(parsedMessage.id, accountId);
    } else if (parsedMessage.stream) {
      // Stream data
      console.log(`[WS-API] Dados de stream recebidos para conta ${accountId}: ${parsedMessage.stream}`);
    } else {
      console.log(`[WS-API] Mensagem não processada para conta ${accountId}:`, parsedMessage);
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao processar mensagem para conta ${accountId}:`, error.message);
  }
}

/**
 * Envia pong em resposta a ping - VERSÃO CORRIGIDA
 */
function sendPong(pingId, accountId) {
  const accountState = api.getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiConnection) {
    console.warn(`[WS-API] Não foi possível enviar pong para conta ${accountId}: conexão não disponível`);
    return;
  }
  
  try {
    const pongRequest = { 
      method: 'pong',
      id: pingId || uuidv4()
    };
    
    accountState.wsApiConnection.send(JSON.stringify(pongRequest));
    console.log(`[WS-API] Pong enviado para conta ${accountId}`);
  } catch (error) {
    console.error(`[WS-API] Erro ao enviar pong para conta ${accountId}:`, error.message);
  }
}

/**
 * Carrega credenciais do banco para uma conta específica
 */
async function loadCredentialsFromDatabase(accountId) {
  try {
    console.log(`[WEBSOCKETS] Carregando credenciais para conta ${accountId}...`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }
    
    // Usar api.loadCredentialsFromDatabase que é mais robusto
    const credentials = await api.loadCredentialsFromDatabase(accountId);
    
    if (!credentials) {
      throw new Error(`Não foi possível carregar credenciais para conta ${accountId}`);
    }
    
    console.log(`[WEBSOCKETS] ✅ Credenciais carregadas para conta ${accountId}`);
    return credentials;
    
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao carregar credenciais para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Limpa recursos do WebSocket API
 */
function cleanupWebSocketApi(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;

  if (accountState.pingInterval) {
    clearInterval(accountState.pingInterval);
    accountState.pingInterval = null;
  }

  const wsConn = accountState.wsApiConnection;
  if (wsConn) {
    wsConn.removeAllListeners();
    if (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING) {
      try {
        wsConn.terminate();
      } catch (e) {
        console.warn(`[WS-API] Erro ao terminar conexão para conta ${accountId}: ${e.message}`);
      }
    }
  }
  accountState.wsApiConnection = null;
  accountState.wsApiAuthenticated = false;
  
  if (accountState.wsApiRequestCallbacks) {
    accountState.wsApiRequestCallbacks.clear();
  }
}

/**
 * Verifica o status da sessão
 */
async function checkSessionStatus(accountId) {
  try {
    const request = await createSignedRequest('session.status', {}, accountId);
    const response = await sendWebSocketApiRequest(request, 30000, accountId);
    
    const accountState = getAccountConnectionState(accountId, true);
    if (response && response.result) {
      accountState.wsApiAuthenticated = response.result.apiKey !== null;
    } else {
      accountState.wsApiAuthenticated = false;
    }
    
    return response;
  } catch (error) {
    console.error(`[WS-API] Erro ao verificar status da sessão para conta ${accountId}:`, error.message);
    return null;
  }
}

/**
 * Autentica na WebSocket API
 */
async function authenticateWebSocketApi(ws, accountId) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiKey || !accountState.wsApiSecret) {
      throw new Error(`Credenciais WebSocket incompletas para conta ${accountId}`);
    }

    console.log(`[WS-API] Iniciando autenticação para conta ${accountId}...`);

    const timestamp = Date.now();
    const authParams = {
      apiKey: accountState.wsApiKey,
      timestamp: timestamp
    };

    const sortedKeys = Object.keys(authParams).sort();
    const payload = sortedKeys.map(key => `${key}=${authParams[key]}`).join('&');
    const signature = await createEd25519Signature(payload, accountId);

    const authRequest = {
      id: `auth-${timestamp}-${accountId}`,
      method: 'session.logon',
      params: {
        apiKey: authParams.apiKey,
        signature: signature,
        timestamp: authParams.timestamp
      }
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Timeout na autenticação WebSocket API`));
      }, 30000);

      accountState.wsApiRequestCallbacks.set(authRequest.id, (responseMessage) => {
        clearTimeout(timeoutId);
        
        if (responseMessage.status === 200 && responseMessage.result) {
          console.log(`[WS-API] ✅ Autenticação bem-sucedida para conta ${accountId}`);
          accountState.wsApiAuthenticated = true;
          resolve(true);
        } else {
          const errorMsg = responseMessage.error?.msg || 'Erro na autenticação';
          console.error(`[WS-API] Falha na autenticação para conta ${accountId}:`, errorMsg);
          reject(new Error(`Falha na autenticação: ${errorMsg}`));
        }
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(authRequest));
      } else {
        clearTimeout(timeoutId);
        accountState.wsApiRequestCallbacks.delete(authRequest.id);
        reject(new Error('WebSocket não está aberto para autenticação.'));
      }
    });

  } catch (error) {
    console.error(`[WS-API] Erro na autenticação para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Envia requisição via WebSocket API
 */
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiConnection) {
    throw new Error(`WebSocket API não conectado para conta ${accountId}`);
  }

  const requestId = request.id || uuidv4();
  request.id = requestId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      accountState.wsApiRequestCallbacks.delete(requestId);
      reject(new Error(`Timeout para requisição ${requestId}`));
    }, timeout);

    accountState.wsApiRequestCallbacks.set(requestId, { resolve, reject, timer });

    try {
      if (accountState.wsApiConnection.readyState === WebSocket.OPEN) {
        accountState.wsApiConnection.send(JSON.stringify(request));
      } else {
        clearTimeout(timer);
        accountState.wsApiRequestCallbacks.delete(requestId);
        reject(new Error('WebSocket connection closed'));
      }
    } catch (error) {
      clearTimeout(timer);
      accountState.wsApiRequestCallbacks.delete(requestId);
      reject(error);
    }
  });
}

/**
 * Garante que existe um websocket de preço para o símbolo
 */
async function ensurePriceWebsocketExists(symbol, accountId) {
  const priceWebsockets = getPriceWebsockets(accountId, true);
  
  if (priceWebsockets.has(symbol) && priceWebsockets.get(symbol).readyState === WebSocket.OPEN) {
    console.log(`[WEBSOCKET] WebSocket para ${symbol} já existe e está ativo`);
    return;
  }

  let accountState = getAccountConnectionState(accountId, true);
  if (!accountState.wsUrl) {
    console.log(`[WEBSOCKET] Carregando credenciais para conta ${accountId}...`);
    await api.loadCredentialsFromDatabase(accountId);
    accountState = getAccountConnectionState(accountId);
  }
  
  if (!accountState || !accountState.wsUrl) {
      console.error(`[WEBSOCKET] URL de mercado não encontrada para conta ${accountId} após carregar credenciais`);
      console.error(`[WEBSOCKET] Estado da conta: ${JSON.stringify(accountState, null, 2)}`);
      return;
  }

  console.log(`[WEBSOCKET] 🔄 Iniciando monitoramento de preço para ${symbol} (conta ${accountId})`);
  console.log(`[WEBSOCKET] Usando URL: ${accountState.wsUrl}`);

  // ✅ CORREÇÃO: Usar ticker em vez de bookTicker para garantir dados mais frequentes
  const wsEndpointUrl = `${accountState.wsUrl}/ws/${symbol.toLowerCase()}@ticker`;
  console.log(`[WEBSOCKET] Endpoint: ${wsEndpointUrl}`);
  
  const ws = new WebSocket(wsEndpointUrl);

  ws.on('open', () => {
    console.log(`[WEBSOCKET] ✅ Conexão de preço aberta para ${symbol} (conta ${accountId})`);
  });

  ws.on('message', async (data) => {
    try {
      const tickerData = JSON.parse(data);
      
      await handlePriceUpdate(symbol, tickerData, accountId);
    } catch (error) {
      console.error(`[WEBSOCKET] ❌ Erro ao processar dados de preço para ${symbol}:`, error.message);
    }
  });

  ws.on('error', (error) => {
    console.error(`[WEBSOCKET] ❌ Erro na conexão de preço para ${symbol}:`, error.message);
  });

  ws.on('close', (code, reason) => {
    console.log(`[WEBSOCKET] 🔌 Conexão de preço fechada para ${symbol}. Code: ${code}, Reason: ${reason}`);
    priceWebsockets.delete(symbol);
  });

  priceWebsockets.set(symbol, ws);
  console.log(`[WEBSOCKET] 💾 WebSocket armazenado para ${symbol} (conta ${accountId})`);
}

/**
 * Processa atualizações de preço
 */
async function handlePriceUpdate(symbol, tickerData, accountId) {
  try {

    const accountState = getAccountConnectionState(accountId, true);
    let db = accountState.dbInstance;
    
    if (!db) {
      try {
        db = await getDatabaseInstance(accountId);
        accountState.dbInstance = db;
      } catch (dbError) {
        console.error(`[WEBSOCKETS] Erro ao obter DB para ${symbol}:`, dbError.message);
        return;
      }
    }

    // ✅ CORREÇÃO CRÍTICA: Calcular preço corretamente baseado no tipo de ticker
    let currentPrice;
    
    if (tickerData.e === 'ticker' || tickerData.e === '24hrTicker') {
      // Ticker de 24h - usar preço de fechamento atual
      currentPrice = parseFloat(tickerData.c);
      //console.log(`[WEBSOCKET] 💰 Usando preço de ticker 24h: ${currentPrice}`);
    } else {
      // BookTicker ou outros - usar média de bid/ask
      const bestBid = parseFloat(tickerData.b);
      const bestAsk = parseFloat(tickerData.a);
      
      if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid > 0 && bestAsk > 0) {
        currentPrice = (bestBid + bestAsk) / 2;
        //console.log(`[WEBSOCKET] 💰 Usando média bid/ask: ${currentPrice} (bid: ${bestBid}, ask: ${bestAsk})`);
      } else {
        console.warn(`[WEBSOCKET] ⚠️ Preços inválidos para ${symbol}: bid=${bestBid}, ask=${bestAsk}`);
        return;
      }
    }

    // ✅ VALIDAÇÃO FINAL DO PREÇO
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.warn(`[WEBSOCKET] ⚠️ Preço calculado inválido para ${symbol}: ${currentPrice}`);
      return;
    }

    //console.log(`[WEBSOCKET] ✅ Preço final calculado para ${symbol}: ${currentPrice}`);

    // ✅ CHAMAR CALLBACK onPriceUpdate
    if (accountState.monitoringCallbacks && accountState.monitoringCallbacks.onPriceUpdate) {
      //console.log(`[WEBSOCKET] 🔄 Chamando onPriceUpdate para ${symbol}...`);
      await accountState.monitoringCallbacks.onPriceUpdate(symbol, currentPrice, db, accountId);
      //console.log(`[WEBSOCKET] ✅ onPriceUpdate executado para ${symbol}`);
    } else {
      console.warn(`[WEBSOCKET] ⚠️ Callback onPriceUpdate não encontrado para conta ${accountId}`);
      console.warn(`[WEBSOCKET] Estado dos callbacks:`, {
        hasCallbacks: !!accountState.monitoringCallbacks,
        hasOnPriceUpdate: !!(accountState.monitoringCallbacks?.onPriceUpdate),
        callbackType: typeof accountState.monitoringCallbacks?.onPriceUpdate
      });
    }
  } catch (error) {
    console.error(`[WEBSOCKETS] ❌ Erro ao processar atualização de preço para ${symbol}:`, error.message);
    console.error(`[WEBSOCKETS] Stack trace:`, error.stack);
  }
}

/**
 * Configura websocket para BookTicker com validação robusta
 */
function bookTicker(symbol, callback, accountId) {
  // CORREÇÃO: Validação rigorosa do accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(`[WEBSOCKET] ❌ ERRO: accountId inválido para bookTicker: ${accountId} (tipo: ${typeof accountId})`);
    throw new Error(`bookTicker: accountId é obrigatório e deve ser um número, recebido: ${accountId}`);
  }
  
  console.log(`[WEBSOCKET] Configurando BookTicker para ${symbol} (conta ${accountId})`);
  
  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState || !accountState.wsUrl) {
    console.error(`[WEBSOCKET] Estado da conta ${accountId} ou wsUrl não encontrado`);
    return null;
  }
  
  // CORREÇÃO: Usar formato da versão antiga que funcionava
  const wsEndpoint = `${accountState.wsUrl}/ws/${symbol.toLowerCase()}@bookTicker`;
  console.log(`[WEBSOCKET] Conectando BookTicker: ${wsEndpoint}`);
  
  let ws = new WebSocket(wsEndpoint);
  let connectionTimeout = null;
  let heartbeatInterval = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;
  
  // CORREÇÃO: Timeout aumentado para 10 segundos como na versão antiga
  connectionTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error(`[WEBSOCKET] Timeout ao estabelecer conexão BookTicker para ${symbol}`);
      ws.terminate();
    }
  }, 10000);
  
  ws.on('open', () => {
    console.log(`[WEBSOCKET] ✅ BookTicker conectado para ${symbol} (conta ${accountId})`);
    clearTimeout(connectionTimeout);
    reconnectAttempt = 0;

    // CORREÇÃO: Adicionar heartbeat como na versão antiga
    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15000);
  });
  
  ws.on('message', (data) => {
    try {
      const tickerData = JSON.parse(data);
      
      // CORREÇÃO: Validação completa como na versão antiga
      if (tickerData && 
          (tickerData.e === 'bookTicker' || tickerData.e === undefined) && 
          typeof tickerData.b === 'string' && 
          typeof tickerData.a === 'string') {
        
        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        const bestBidQty = parseFloat(tickerData.B || '0');
        const bestAskQty = parseFloat(tickerData.A || '0');
        
        // VALIDAÇÃO ADICIONAL: Verificar se bid < ask e valores são positivos
        if (!isNaN(bestBid) && !isNaN(bestAsk) && 
            bestBid > 0 && bestAsk > 0 && bestBid < bestAsk) {
          
          //console.log(`[WEBSOCKET] BookTicker dados válidos ${symbol}: Bid=${bestBid}, Ask=${bestAsk}`);
          
          callback({
            bestBid, 
            bestAsk,
            bestBidQty,
            bestAskQty,
            timestamp: tickerData.E || Date.now()
          }, accountId); // CORREÇÃO: Passar accountId para callback
          
        } else {
          console.warn(`[WEBSOCKET] Dados BookTicker inválidos para ${symbol}: Bid=${bestBid}, Ask=${bestAsk}`);
        }
      } else {
        console.warn(`[WEBSOCKET] Formato inesperado de dados BookTicker para ${symbol}:`, JSON.stringify(tickerData).substring(0, 200));
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
  
  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatInterval);
    console.log(`[WEBSOCKET] BookTicker fechado para ${symbol}. Code: ${code}, Reason: ${reason}`);
    
    // CORREÇÃO: Reconexão opcional (pode ativar se necessário)
    const shouldReconnect = false; // Manter false por enquanto para debug
    
    if (shouldReconnect && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
      reconnectAttempt++;
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempt - 1), 30000);
      console.log(`[WEBSOCKET] Tentando reconectar BookTicker para ${symbol} em ${delay/1000}s (tentativa ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
      
      setTimeout(() => {
        try {
          ws = new WebSocket(wsEndpoint);
          // ... lógica de reconexão ...
        } catch (reconnectError) {
          console.error(`[WEBSOCKET] Erro ao reconectar BookTicker para ${symbol}:`, reconnectError.message);
        }
      }, delay);
    }
  });
  
  return ws;
}

/**
 * Para o monitoramento de preço
 */
function stopPriceMonitoring(symbol, accountId) {
  // ✅ CORREÇÃO: Remover código de debug duplicado e conflitante
  console.log(`[WEBSOCKET] Parando monitoramento de preço para ${symbol} (conta ${accountId})`);
  
  // Validação do accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(`[WEBSOCKET] AccountId inválido para stopPriceMonitoring: ${accountId} (tipo: ${typeof accountId})`);
    throw new Error(`AccountId é obrigatório e deve ser um número, recebido: ${accountId}`);
  }

  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets && priceWebsockets.has(symbol)) {
    const ws = priceWebsockets.get(symbol);
    try {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close(1000, 'Monitoring stopped');
      }
      priceWebsockets.delete(symbol);
      console.log(`[WEBSOCKET] ✅ Monitoramento parado para ${symbol} (conta ${accountId})`);
      return true;
    } catch (error) {
      console.error(`[WEBSOCKET] Erro ao parar monitoramento de ${symbol}:`, error.message);
      return false;
    }
  }
  return false;
}

/**
 * Inicia stream de dados do usuário
 */
async function startUserDataStream(db, accountId) {
  try {
    const listenKey = await api.getListenKey(accountId);
    if (!listenKey) {
      throw new Error(`Falha ao obter ListenKey para conta ${accountId}`);
    }

    const accountState = getAccountConnectionState(accountId, true);
    const userDataEndpoint = `${accountState.wsUrl}/ws/${listenKey}`;
    
    const ws = new WebSocket(userDataEndpoint);
    accountState.userDataStream = ws;

    ws.on('open', () => {
      console.log(`[WEBSOCKET] UserDataStream conectado para conta ${accountId}`);
    });

    ws.on('message', async (data) => {
      try {
        await handleUserDataMessage(data, accountId, db);
      } catch (e) {
        console.error(`[WEBSOCKET] Erro no UserDataStream:`, e.message);
      }
    });

    ws.on('error', (error) => {
      console.error(`[WEBSOCKET] Erro no UserDataStream:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WEBSOCKET] UserDataStream fechado para conta ${accountId}`);
    });

  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao iniciar UserDataStream:`, error.message);
    throw error;
  }
}

/**
 * Processa mensagens do UserDataStream
 */
async function handleUserDataMessage(jsonData, accountId, db) {
  try {
    const message = JSON.parse(jsonData.toString());
    const accountState = getAccountConnectionState(accountId);
    
    if (!accountState || !accountState.monitoringCallbacks) {
      return;
    }

    const { handleOrderUpdate, handleAccountUpdate } = accountState.monitoringCallbacks;

    if (message.e) {
      switch (message.e) {
        case 'ORDER_TRADE_UPDATE':
          if (handleOrderUpdate) {
            await handleOrderUpdate(message, db);
          }
          break;
        case 'ACCOUNT_UPDATE':
          if (handleAccountUpdate) {
            await handleAccountUpdate(message, db);
          }
          break;
      }
    }
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao processar UserDataStream:`, error.message);
  }
}

/**
 * Para o UserDataStream
 */
function stopUserDataStream(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (accountState && accountState.userDataStream) {
    accountState.userDataStream.close();
    accountState.userDataStream = null;
  }
}

/**
 * Define callbacks de monitoramento
 */
function setMonitoringCallbacks(callbackHandlers, accountId) {
  const accountState = getAccountConnectionState(accountId, true);
  accountState.monitoringCallbacks = { ...accountState.monitoringCallbacks, ...callbackHandlers };
  return accountState.monitoringCallbacks;
}

/**
 * Obtém handlers
 */
function getHandlers(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState ? accountState.monitoringCallbacks : {};
}

/**
 * Obtém credenciais
 */
function getCredentials(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    return null;
  }
  
  return {
    accountId: accountState.accountId,
    apiKey: accountState.apiKey,
    secretKey: accountState.secretKey,
    wsApiKey: accountState.wsApiKey,
    wsApiSecret: accountState.wsApiSecret,
    apiUrl: accountState.apiUrl,
    wsUrl: accountState.wsUrl,
    wsApiUrl: accountState.wsApiUrl
  };
}

/**
 * Garante que WebSocket API existe
 */
async function ensureWebSocketApiExists(accountId) {
  try {
    let accountState = getAccountConnectionState(accountId);
    
    if (!accountState || !accountState.wsApiKey) {
      await api.loadCredentialsFromDatabase(accountId);
      accountState = getAccountConnectionState(accountId);
      
      if (!accountState || !accountState.wsApiKey) {
        return false;
      }
    }

    if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
      return accountState.wsApiAuthenticated;
    }

    return await startWebSocketApi(accountId);
    
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao garantir WebSocket API:`, error.message);
    return false;
  }
}

/**
 * Verifica se WebSocket API está conectado
 */
function isWebSocketApiConnected(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState && 
         accountState.wsApiConnection && 
         accountState.wsApiConnection.readyState === WebSocket.OPEN;
}

/**
 * Verifica se WebSocket API está autenticado
 */
function isWebSocketApiAuthenticated(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState && accountState.wsApiAuthenticated === true;
}

/**
 * Reset
 */
function reset(accountId) {
  cleanupWebSocketApi(accountId);
  stopUserDataStream(accountId);
  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets) {
    for (const [symbol, ws] of priceWebsockets.entries()) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    priceWebsockets.clear();
  }
}

function monitorWebSocketHealth(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[HEALTH] AccountId inválido: ${accountId}`);
      return;
    }
    
    console.log(`[HEALTH] Verificando saúde dos WebSockets para conta ${accountId}...`);
    
    const isApiConnected = websockets.isWebSocketApiConnected(accountId);
    const isApiAuthenticated = websockets.isWebSocketApiAuthenticated(accountId);
    
    console.log(`[HEALTH] Conta ${accountId}:`);
    console.log(`  - WebSocket API conectado: ${isApiConnected ? '✅' : '❌'}`);
    console.log(`  - WebSocket API autenticado: ${isApiAuthenticated ? '✅' : '❌'}`);
    
    // Reconectar se necessário
    if (!isApiConnected || !isApiAuthenticated) {
      console.log(`[HEALTH] ⚠️ Problemas detectados na conta ${accountId}, tentando reconectar...`);
      websockets.startWebSocketApi(accountId).catch(error => {
        console.error(`[HEALTH] Erro ao reconectar conta ${accountId}:`, error.message);
      });
    }
    
  } catch (error) {
    console.error(`[HEALTH] Erro ao monitorar WebSockets para conta ${accountId}:`, error.message);
  }
}

/**
 * Limpeza completa da conta
 */
function forceCleanupAccount(accountId) {
  console.log(`[WEBSOCKET] Limpeza completa para conta ${accountId}...`);
  reset(accountId);
}


module.exports = {
  // Funções de UserDataStream
  startUserDataStream,
  handleUserDataMessage,
  stopUserDataStream,
  
  // Funções de WebSocket de preços
  ensurePriceWebsocketExists,
  handlePriceUpdate,
  bookTicker,
  stopPriceMonitoring,
  getPriceWebsockets,
  
  // Funções de WebSocket API
  startWebSocketApi,
  authenticateWebSocketApi,
  sendWebSocketApiRequest,
  createSignedRequest,
  checkSessionStatus,
  cleanupWebSocketApi,
  isWebSocketApiAuthenticated,
  isWebSocketApiConnected,
  ensureWebSocketApiExists,
  
  // Funções de callbacks e handlers
  setMonitoringCallbacks,
  getHandlers,
  getCredentials,
  
  // Funções utilitárias
  monitorWebSocketHealth,
  getAllAccountConnections,
  handleWebSocketApiMessage,
  createEd25519Signature,
  forceCleanupAccount,
  loadNobleEd25519,
  getAccountConnectionState,
  reset
};