const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const { getDatabaseInstance } = require('./db/conexao');

require('dotenv').config({ path: path.join(__dirname, '.env') });

// Tentar importar biblioteca Ed25519 mais robusta
let ed25519Noble = null;
let tweetnacl = null;

try {
    ed25519Noble = require('@noble/ed25519');
    console.log('[WS-API] @noble/ed25519 carregado com sucesso');
} catch (e) {
    console.log('[WS-API] @noble/ed25519 não disponível:', e.message);
    try {
        tweetnacl = require('tweetnacl');
        console.log('[WS-API] tweetnacl carregado como fallback');
    } catch (e2) {
        console.log('[WS-API] tweetnacl também não disponível:', e2.message);
        console.log('[WS-API] ⚠️ AVISO: Nenhuma biblioteca Ed25519 disponível - WebSocket API pode não funcionar');
    }
}

// Cache para armazenar credenciais por conta
const accountCredentialsCache = new Map();

// CORREÇÃO: Unificar mapas de conexão
const accountConnections = new Map(); // Mapa principal
const priceWebsocketsByAccount = new Map(); // Mapeia accountId -> { symbol -> websocket }

// CORREÇÃO: Função unificada para obter estado
function getAccountConnectionState(accountId, create = false) {
  // CORREÇÃO: Validar accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(`[WEBSOCKETS] ID da conta inválido: ${accountId} (tipo: ${typeof accountId})`);
    return null;
  }

  // Verificar se existe no mapa principal
  if (accountConnections.has(accountId)) {
    return accountConnections.get(accountId);
  }
  
  // Se create=true, criar novo estado
  if (create) {
    console.log(`[WEBSOCKETS] Criando novo estado para conta ${accountId}`);
    const newState = {
      // Dados de conexão
      wsApiConnection: null,
      wsApi: null, // Alias para compatibilidade
      wsApiAuthenticated: false,
      isAuthenticated: false,
      
      // Credenciais
      apiKey: null,
      secretKey: null,
      wsApiKey: null,
      wsApiSecret: null,
      privateKey: null,
      
      // URLs
      apiUrl: process.env.API_URL || 'https://fapi.binance.com/fapi',
      wsApiUrl: process.env.WS_API_URL || 'wss://ws-fapi.binance.com/ws-fapi/v1',
      wsUrl: process.env.WS_URL || 'wss://fstream.binance.com/ws',
      
      // Controle de conexão
      pingInterval: null,
      lastPongTime: Date.now(),
      requestCallbacks: new Map(),
      
      // User Data Stream
      userDataWebSocket: null,
      currentListenKey: null,
      listenKeyKeepAliveInterval: null,
      
      // Outros
      handlers: {},
      dbInstance: null,
      environment: 'prd',
      messageQueue: []
    };
    
    accountConnections.set(accountId, newState);
    return newState;
  }
  
  return null;
}

function getAllAccountConnections() {
  return accountConnections;
}

// Inicializar mapa de websockets de preço por conta
function getPriceWebsockets(accountId, create = false) {
  if (!priceWebsocketsByAccount.has(accountId) && create) {
    priceWebsocketsByAccount.set(accountId, new Map());
  }
  return priceWebsocketsByAccount.get(accountId) || new Map();
}

/**
 * Carrega credenciais do banco de dados para uma conta
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Credenciais carregadas
 */
async function loadCredentialsFromDatabase(accountId) {
  try {
    // CORREÇÃO: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`ID da conta inválido: ${accountId} (tipo: ${typeof accountId})`);
    }

    // Verificar cache
    const cachedCreds = accountCredentialsCache.get(accountId);
    if (cachedCreds && (Date.now() - cachedCreds.timestamp) < 300000) { // 5 minutos
      console.log(`[WEBSOCKETS] Usando credenciais em cache para conta ${accountId}`);
      
      // CORREÇÃO: Garantir que o estado da conta existe e está atualizado
      let accountState = getAccountConnectionState(accountId, true);
      accountState.apiKey = cachedCreds.apiKey;
      accountState.secretKey = cachedCreds.secretKey;
      accountState.wsApiKey = cachedCreds.wsApiKey;
      accountState.wsApiSecret = cachedCreds.wsApiSecret;
      accountState.privateKey = cachedCreds.privateKey;
      accountState.apiUrl = cachedCreds.apiUrl;
      accountState.wsApiUrl = cachedCreds.wsApiUrl;
      accountState.wsUrl = cachedCreds.wsUrl;
      accountState.environment = cachedCreds.environment;
      
      return cachedCreds;
    }

    console.log(`[WEBSOCKETS] Carregando credenciais do banco para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }

    // Query com estrutura correta
    const [rows] = await db.query(`
      SELECT 
        id,
        nome,
        api_key, 
        api_secret,
        ws_api_key, 
        ws_api_secret, 
        private_key,
        api_url,
        ws_url,
        ws_api_url,
        ativa,
        id_corretora
      FROM contas 
      WHERE id = ? AND ativa = 1
    `, [accountId]);

    if (rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada no banco de dados ou não está ativa`);
    }

    const account = rows[0];
    
    // Determinar ambiente baseado nas URLs
    let broker = 'binance';
    let environment = 'prd';
    
    if (account.api_url && account.api_url.includes('testnet')) {
      environment = 'test';
    }
    
    const credentials = {
      apiKey: account.api_key,
      secretKey: account.api_secret,
      wsApiKey: account.ws_api_key,
      wsApiSecret: account.ws_api_secret,
      privateKey: account.private_key,
      apiUrl: account.api_url || 'https://fapi.binance.com/fapi',
      wsApiUrl: account.ws_api_url || 'wss://ws-fapi.binance.com/ws-fapi/v1',
      wsUrl: account.ws_url || 'wss://fstream.binance.com/ws',
      accountId: accountId,
      accountName: account.nome,
      broker: broker,
      environment: environment,
      timestamp: Date.now()
    };

    // Cache das credenciais
    accountCredentialsCache.set(accountId, credentials);

    // CORREÇÃO: Atualizar estado da conta com as credenciais
    let accountState = getAccountConnectionState(accountId, true);
    accountState.apiKey = credentials.apiKey;
    accountState.secretKey = credentials.secretKey;
    accountState.wsApiKey = credentials.wsApiKey;
    accountState.wsApiSecret = credentials.wsApiSecret;
    accountState.privateKey = credentials.privateKey;
    accountState.apiUrl = credentials.apiUrl;
    accountState.wsApiUrl = credentials.wsApiUrl;
    accountState.wsUrl = credentials.wsUrl;
    accountState.environment = credentials.environment;

    console.log(`[WEBSOCKETS] Credenciais carregadas para conta ${accountId} (${account.nome}):`);
    console.log(`- API Key: ${credentials.apiKey ? credentials.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Secret Key: ${credentials.secretKey ? '✅ Encontrada' : '❌ Não encontrada'}`);
    console.log(`- WS API Key: ${credentials.wsApiKey ? credentials.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Private Key: ${credentials.privateKey ? '✅ Encontrada' : '❌ Não encontrada'}`);
    
    console.log(`[WEBSOCKETS] Inicializando estado da conexão para conta ${accountId}...`);
    console.log(`[WEBSOCKETS] ✅ Credenciais inicializadas com sucesso para conta ${accountId}`);

    return credentials;

  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao carregar credenciais para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Cria uma assinatura usando Ed25519 conforme documentação Binance
 * @param {string} payload - Dados a serem assinados
 * @param {number} accountId - ID da conta
 * @returns {string} Assinatura em formato base64
 */
function createEd25519Signature(payload, accountId) {
    try {
        // Validar accountId
        if (!accountId || typeof accountId !== 'number') {
            throw new Error(`ID da conta inválido: ${accountId} (tipo: ${typeof accountId})`);
        }

        // Obter estado da conta
        const accountState = getAccountConnectionState(accountId);
        if (!accountState) {
            throw new Error(`Estado da conta ${accountId} não encontrado. Carregue as credenciais primeiro.`);
        }

        // Obter chave privada específica da conta
        let privateKey = accountState.privateKey;
        
        if (!privateKey) {
            throw new Error(`Chave privada Ed25519 não está disponível para conta ${accountId}`);
        }
        
        console.log(`[WS-API] Gerando assinatura Ed25519 para conta ${accountId}`);
        console.log(`[WS-API] Payload: ${payload}`);
        
        try {
            // CORREÇÃO PRINCIPAL: Usar @noble/ed25519 que é mais compatível
            if (ed25519Noble) {
                console.log(`[WS-API] Usando @noble/ed25519 para conta ${accountId}`);
                
                // Determinar formato da chave privada
                let privateKeyBytes;
                
                if (privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                    // Chave no formato PEM - extrair bytes
                    const pemContent = privateKey
                        .replace('-----BEGIN PRIVATE KEY-----', '')
                        .replace('-----END PRIVATE KEY-----', '')
                        .replace(/\s/g, '');
                    
                    const derBuffer = Buffer.from(pemContent, 'base64');
                    
                    // Para Ed25519, a chave privada está nos últimos 32 bytes do DER
                    privateKeyBytes = derBuffer.slice(-32);
                } else {
                    // Chave em formato raw - tentar diferentes decodificações
                    if (privateKey.startsWith('0x')) {
                        privateKeyBytes = Buffer.from(privateKey.slice(2), 'hex');
                    } else if (privateKey.length === 64) {
                        // Provavelmente hex
                        privateKeyBytes = Buffer.from(privateKey, 'hex');
                    } else {
                        // Provavelmente base64
                        privateKeyBytes = Buffer.from(privateKey, 'base64');
                    }
                }
                
                if (privateKeyBytes.length !== 32) {
                    throw new Error(`Chave privada tem tamanho incorreto: ${privateKeyBytes.length} bytes (esperado: 32)`);
                }
                
                // Converter payload para bytes ASCII conforme documentação
                const messageBytes = Buffer.from(payload, 'ascii');
                
                // Assinar usando @noble/ed25519
                const signature = ed25519Noble.sign(messageBytes, privateKeyBytes);
                const signatureBase64 = Buffer.from(signature).toString('base64');
                
                console.log(`[WS-API] ✅ Assinatura Ed25519 criada com @noble/ed25519 para conta ${accountId}`);
                console.log(`[WS-API] Assinatura: ${signatureBase64.substring(0, 20)}...`);
                
                return signatureBase64;
                
            } else if (tweetnacl) {
                console.log(`[WS-API] Usando tweetnacl como fallback para conta ${accountId}`);
                
                // Preparar chave privada para tweetnacl
                let privateKeyBytes;
                
                if (privateKey.includes('-----BEGIN PRIVATE KEY-----')) {
                    // Extrair de PEM
                    const pemContent = privateKey
                        .replace('-----BEGIN PRIVATE KEY-----', '')
                        .replace('-----END PRIVATE KEY-----', '')
                        .replace(/\s/g, '');
                    
                    const derBuffer = Buffer.from(pemContent, 'base64');
                    privateKeyBytes = derBuffer.slice(-32);
                } else {
                    // Raw key
                    if (privateKey.startsWith('0x')) {
                        privateKeyBytes = Buffer.from(privateKey.slice(2), 'hex');
                    } else if (privateKey.length === 64) {
                        privateKeyBytes = Buffer.from(privateKey, 'hex');
                    } else {
                        privateKeyBytes = Buffer.from(privateKey, 'base64');
                    }
                }
                
                if (privateKeyBytes.length !== 32) {
                    throw new Error(`Chave privada tem tamanho incorreto: ${privateKeyBytes.length} bytes`);
                }
                
                // tweetnacl precisa da chave completa (64 bytes)
                const keyPair = tweetnacl.sign.keyPair.fromSeed(privateKeyBytes);
                const messageBytes = Buffer.from(payload, 'ascii');
                
                const signature = tweetnacl.sign.detached(messageBytes, keyPair.secretKey);
                const signatureBase64 = Buffer.from(signature).toString('base64');
                
                console.log(`[WS-API] ✅ Assinatura Ed25519 criada com tweetnacl para conta ${accountId}`);
                return signatureBase64;
                
            } else {
                throw new Error('Nenhuma biblioteca Ed25519 disponível');
            }
            
        } catch (signError) {
            console.error(`[WS-API] Erro específico ao assinar com Ed25519 para conta ${accountId}:`, signError.message);
            throw signError;
        }
        
    } catch (error) {
        console.error(`[WS-API] Erro ao criar assinatura Ed25519 para conta ${accountId}:`, error.message);
        throw error;
    }
}

/**
 * Cria um buffer DER para chave privada Ed25519 a partir de chave raw
 * @param {Buffer} rawKey - Chave privada raw de 32 bytes
 * @returns {Buffer} - Chave no formato DER
 */
function createEd25519DERFromRaw(rawKey) {
    // Ed25519 private key DER structure:
    // SEQUENCE {
    //   INTEGER 0
    //   SEQUENCE {
    //     OBJECT IDENTIFIER 1.3.101.112 (Ed25519)
    //   }
    //   OCTET STRING {
    //     OCTET STRING (32-byte private key)
    //   }
    // }
    
    const ed25519OID = Buffer.from('302a300506032b657004200420', 'hex');
    const derKey = Buffer.concat([ed25519OID, rawKey]);
    
    return derKey;
}

/**
 * Cria um novo listenKey para monitoramento de eventos da conta
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - ListenKey gerado pela API
 */
async function createListenKey(accountId) {
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
async function keepAliveListenKey(listenKey, accountId) {
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
function startListenKeyKeepAlive(listenKey, accountId) {
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
async function closeListenKey(listenKey, accountId) {
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
 * Inicia conexão WebSocket API para uma conta conforme documentação Binance
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se conectado com sucesso
 */
async function startWebSocketApi(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[WS-API] ID da conta inválido: ${accountId}`);
      return false;
    }

    console.log(`[WS-API] Iniciando WebSocket API para conta ${accountId}...`);
    
    // Garantir que as credenciais estão carregadas
    let accountState = getAccountConnectionState(accountId, true);
    
    if (!accountState.wsApiKey) {
      await loadCredentialsFromDatabase(accountId);
      accountState = getAccountConnectionState(accountId);
    }
    
    if (!accountState || !accountState.wsApiKey) {
      console.error(`[WS-API] wsApiKey não encontrada para conta ${accountId}`);
      return false;
    }

    let endpoint;
    const isTestnet = accountState.environment === 'test' || accountState.environment === 'testnet';
    
    if (isTestnet) {
      endpoint = 'wss://testnet.binancefuture.com/ws-fapi/v1'; // CORREÇÃO: Endpoint testnet oficial
    } else {
      endpoint = 'wss://ws-fapi.binance.com/ws-fapi/v1'; // CORREÇÃO: Endpoint produção oficial
    }
    
    console.log(`[WS-API] Conectando ao endpoint oficial: ${endpoint} para conta ${accountId}`);

    // Criar conexão WebSocket
    const ws = new WebSocket(endpoint);
    
    accountState.wsApiConnection = ws;
    accountState.wsApi = ws;

    return new Promise((resolve) => {
      const connectionTimeout = setTimeout(() => {
        console.error(`[WS-API] Timeout na conexão para conta ${accountId}`);
        ws.close();
        resolve(false);
      }, 10000);

      ws.on('open', async () => {
        clearTimeout(connectionTimeout);
        console.log(`[WS-API] ✅ Conexão WebSocket API estabelecida para conta ${accountId}`);
        
        // CORREÇÃO: Implementar autenticação session.logon
        const authSuccess = await authenticateWebSocketApi(ws, accountId);
        
        if (authSuccess) {
          console.log(`[WS-API] ✅ WebSocket API totalmente funcional para conta ${accountId}`);
        } else {
          console.log(`[WS-API] ⚠️ WebSocket API conectada mas não autenticada para conta ${accountId}`);
        }
        
        resolve(authSuccess);
      });

      ws.on('error', (error) => {
        clearTimeout(connectionTimeout);
        console.error(`[WS-API] Erro na conexão para conta ${accountId}:`, error.message);
        resolve(false);
      });

      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleWebSocketApiMessage(message, accountId);
        } catch (parseError) {
          console.error(`[WS-API] Erro ao processar mensagem para conta ${accountId}:`, parseError.message);
        }
      });

      ws.on('close', () => {
        console.log(`[WS-API] Conexão WebSocket API fechada para conta ${accountId}`);
        if (accountState) {
          accountState.wsApiConnection = null;
          accountState.wsApi = null;
          accountState.isAuthenticated = false;
          accountState.wsApiAuthenticated = false;
        }
      });
    });

  } catch (error) {
    console.error(`[WS-API] Erro ao iniciar WebSocket API para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Processa mensagens recebidas via WebSocket API
 * @param {Object} message - Mensagem recebida
 * @param {number} accountId - ID da conta
 */
function handleWebSocketApiMessage(message, accountId) {
    try {
        // Log da mensagem para debug
        //console.log(`[WS-API] Mensagem recebida para conta ${accountId}:`, JSON.stringify(message, null, 2));
        
        const accountState = getAccountConnectionState(accountId);
        if (!accountState) {
            console.error(`[WS-API] Estado da conta ${accountId} não encontrado para processar mensagem`);
            return;
        }
        
        // Processar diferentes tipos de mensagem
        if (message.id) {
            // Resposta a uma requisição específica
            const callback = accountState.requestCallbacks.get(message.id);
            
            if (callback) {
                // Remover callback do mapa
                accountState.requestCallbacks.delete(message.id);
                
                // Limpar timer se existir
                if (callback.timer) {
                    clearTimeout(callback.timer);
                }
                
                // Chamar resolve ou reject baseado na resposta
                if (message.status === 200) {
                    if (callback.resolve) {
                        callback.resolve(message);
                    }
                } else {
                    if (callback.reject) {
                        callback.reject(message);
                    }
                }
            } else {
                console.log(`[WS-API] Callback não encontrado para ID ${message.id} na conta ${accountId}`);
            }
        } else if (message.method === 'ping') {
            // Responder ao ping com pong
            sendPong(message.params, accountId);
        } else if (message.method === 'pong') {
            // Atualizar timestamp do último pong
            accountState.lastPongTime = Date.now();
            console.log(`[WS-API] Pong recebido para conta ${accountId}`);
        } else {
            // Mensagem não solicitada (eventos, etc.)
            console.log(`[WS-API] Evento não solicitado para conta ${accountId}:`, message);
        }
        
    } catch (error) {
        console.error(`[WS-API] Erro ao processar mensagem para conta ${accountId}:`, error.message);
    }
}

/**
 * Limpa recursos do WebSocket API para uma conta específica
 * @param {number} accountId - ID da conta
 */
function cleanupWebSocketApi(accountId) {
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
 * Envia pong em resposta a ping
 * @param {string} payload - Payload a ser enviado com o pong
 * @param {number} accountId - ID da conta
 */
function sendPong(payload = '', accountId) {
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
async function checkSessionStatus(accountId) {
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
 * Autentica na WebSocket API usando session.logon conforme documentação Binance
 * @param {WebSocket} ws - Conexão WebSocket
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se autenticação bem-sucedida
 */
async function authenticateWebSocketApi(ws, accountId) {
  try {
    console.log(`[WS-API] Iniciando autenticação session.logon para conta ${accountId}...`);
    
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiKey || !accountState.privateKey) {
      throw new Error(`Credenciais WebSocket API incompletas para conta ${accountId}`);
    }
    
    // CORREÇÃO: Implementar session.logon conforme documentação
    const timestamp = Date.now();
    const params = {
      apiKey: accountState.wsApiKey,
      timestamp: timestamp
    };
    
    // Criar payload para assinatura (ordenado alfabeticamente)
    const payload = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join('&');
    
    // Assinar com Ed25519
    const signature = createEd25519Signature(payload, accountId);
    params.signature = signature;
    
    // Criar requisição de autenticação
    const authRequest = {
      id: `auth-${Date.now()}`,
      method: 'session.logon',
      params: params
    };
    
    console.log(`[WS-API] Enviando session.logon para conta ${accountId}...`);
    
    // Enviar requisição de autenticação
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout na autenticação WebSocket API'));
      }, 10000);
      
      const messageHandler = (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.id === authRequest.id) {
            clearTimeout(timeout);
            ws.removeListener('message', messageHandler);
            
            if (message.status === 200) {
              console.log(`[WS-API] ✅ Autenticação bem-sucedida para conta ${accountId}`);
              console.log(`[WS-API] API Key autenticada: ${message.result.apiKey.substring(0, 8)}...`);
              resolve(true);
            } else {
              console.error(`[WS-API] Erro na autenticação para conta ${accountId}:`, message.error);
              reject(new Error(`Autenticação falhou: ${JSON.stringify(message.error)}`));
            }
          }
        } catch (parseError) {
          // Ignorar mensagens que não são JSON válido
        }
      };
      
      ws.on('message', messageHandler);
      ws.send(JSON.stringify(authRequest));
    });
    
    // Marcar como autenticado
    accountState.wsApiAuthenticated = true;
    accountState.isAuthenticated = true;
    
    return true;
    
  } catch (error) {
    console.error(`[WS-API] Erro na autenticação para conta ${accountId}:`, error.message);
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
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
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
 * Cria uma requisição assinada para a API WebSocket conforme documentação Binance
 * @param {string} method - Método da API
 * @param {Object} params - Parâmetros da requisição
 * @param {number} accountId - ID da conta
 * @returns {Object} - Requisição pronta para envio
 */
function createSignedRequest(method, params = {}, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    throw new Error(`Estado da conexão não encontrado para conta ${accountId}. Chame loadCredentialsFromDatabase primeiro.`);
  }
  
  // Criar um ID único para a requisição
  const requestId = uuidv4();
  
  // Para métodos que não exigem autenticação
  if (method === 'ping' || method === 'pong' || method === 'session.status') {
    return {
      id: requestId,
      method,
      params: params || {}
    };
  }
  
  // CORREÇÃO: Para métodos que exigem autenticação, seguir formato da documentação
  const requestParams = {
    ...params,
    apiKey: accountState.wsApiKey, // CORREÇÃO: Usar wsApiKey para WebSocket API
    timestamp: Date.now()
  };
  
  // CORREÇÃO: Ordenar parâmetros alfabeticamente conforme documentação
  const sortedParams = Object.keys(requestParams)
    .filter(key => key !== 'signature') // Excluir signature do payload
    .sort() // Ordenação alfabética
    .map(key => `${key}=${requestParams[key]}`) // CORREÇÃO: Formato simples sem encodeURIComponent
    .join('&');
  
  console.log(`[WS-API] Payload para assinatura: ${sortedParams}`);
  
  // CORREÇÃO: Assinar com Ed25519 conforme documentação
  const signature = createEd25519Signature(sortedParams, accountId);
  
  // Adicionar assinatura aos parâmetros
  requestParams.signature = signature;
  
  // Retornar objeto de requisição completo conforme formato da documentação
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
async function ensurePriceWebsocketExists(symbol, accountId) {
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
async function handlePriceUpdate(symbol, tickerData, accountId) {
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
          console.error(`[WEBSOCKETS] Erro ao obter DB via handler para ${symbol}: ${dbHandlerError.message}`);
        }
      }
      
      // Se ainda não tiver DB, tentar obter diretamente
      if (!db) {
        try {
          const { getDatabaseInstance } = require('./db/conexao');
          db = await getDatabaseInstance(accountId);
          accountState.dbInstance = db;
        } catch (directDbError) {
          console.error(`[WEBSOCKETS] Erro ao obter DB diretamente para ${symbol}: ${directDbError.message}`);
        }
      }
    }

    if (!db) {
      console.error(`[WEBSOCKETS] Não foi possível obter conexão com o banco de dados para ${symbol} (conta ${accountId})`);
      return;
    }

    const bestBid = parseFloat(tickerData.b);
    const bestAsk = parseFloat(tickerData.a);
    const currentPrice = (bestBid + bestAsk) / 2;

    if (accountState.handlers && accountState.handlers.onPriceUpdate) {
      await accountState.handlers.onPriceUpdate(symbol, currentPrice, db, accountId);
    }
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao processar atualização de preço para ${symbol} (conta ${accountId}):`, error);
  }
}

/**
 * Configura websocket para monitoramento de BookTicker em tempo real
 * @param {string} symbol - Símbolo do par de negociação
 * @param {function} callback - Função callback para processar atualizações
 * @param {number} accountId - ID da conta
 * @returns {WebSocket} Objeto websocket
 */
function setupBookDepthWebsocket(symbol, callback, accountId) {
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
      console.error(`[WEBSOCKETS] Timeout ao estabelecer conexão para ${symbol} BookTicker (conta ${accountId})`);
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
function stopPriceMonitoring(symbol, accountId) {
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
 * Inicia stream de dados do usuário para uma conta
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se iniciado com sucesso
 */
async function startUserDataStream(db, accountId) {
  try {
    // CORREÇÃO: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`ID da conta inválido: ${accountId} (tipo: ${typeof accountId})`);
    }

    console.log(`[WEBSOCKETS] Iniciando stream de dados do usuário para conta ${accountId}...`);
    
    // Carregar credenciais se não estiverem em cache
    if (!accountCredentialsCache.has(accountId)) {
      await loadCredentialsFromDatabase(accountId); // CORREÇÃO: Passar accountId diretamente
    }
    
    const credentials = accountCredentialsCache.get(accountId);
    if (!credentials) {
      throw new Error(`Credenciais não encontradas para conta ${accountId}`);
    }
    
    // Obter listenKey
    const listenKeyUrl = credentials.apiUrl ? 
      `${credentials.apiUrl}/v1/listenKey` : 
      `https://fapi.binance.com/fapi/v1/listenKey`;
    
    console.log(`[WEBSOCKET] Obtendo listenKey via: ${listenKeyUrl} para conta ${accountId}`);
    
    const timestamp = Date.now();
    const headers = {
      'X-MBX-APIKEY': credentials.apiKey
    };

    const response = await axios.post(listenKeyUrl, {}, { headers });
    const listenKey = response.data.listenKey;
    
    console.log(`[WEBSOCKET] ListenKey obtido com sucesso para conta ${accountId}: ${listenKey.substring(0, 10)}...`);

    // Determinar URL do WebSocket
    const wsUrl = credentials.wsUrl ? 
      `${credentials.wsUrl}/ws/${listenKey}` : 
      `wss://fstream.binance.com/ws/${listenKey}`;
    
    console.log(`[WEBSOCKETS] Conectando UserDataStream para conta ${accountId}: ${wsUrl}`);

    // Criar conexão WebSocket
    const ws = new WebSocket(wsUrl);
    
    // Armazenar no estado da conta
    let accountState = getAccountConnectionState(accountId);
    if (!accountState) {
      accountConnections.set(accountId, {
        ...credentials,
        userDataStream: ws,
        listenKey: listenKey,
        isAuthenticated: false,
        wsApi: null,
        requestCallbacks: new Map(),
        messageQueue: []
      });
    } else {
      accountState.userDataStream = ws;
      accountState.listenKey = listenKey;
    }

    // Configurar handlers
    ws.on('open', () => {
      console.log(`[WEBSOCKET] UserDataStream conectado para conta ${accountId}`);
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());
        await handleUserDataMessage(message, db, accountId);
      } catch (parseError) {
        console.error(`[WEBSOCKET] Erro ao processar mensagem UserDataStream para conta ${accountId}:`, parseError.message);
      }
    });

    ws.on('error', (error) => {
      console.error(`[WEBSOCKET] Erro no UserDataStream para conta ${accountId}:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WEBSOCKET] UserDataStream fechado para conta ${accountId}`);
    });

    return true;

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
function restartUserDataStream(db, accountId) {
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
function setMonitoringCallbacks(callbackHandlers, accountId) {
  const accountState = getAccountConnectionState(accountId, true);
  accountState.handlers = { ...accountState.handlers, ...callbackHandlers };
  return accountState.handlers;
}

/**
 * Retorna os handlers registrados para uma conta
 * @param {number} accountId - ID da conta
 * @returns {Object} O objeto handlers atual
 */
function getHandlers(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState ? accountState.handlers : {};
}

/**
 * Retorna as credenciais carregadas para uma conta
 * @param {number} accountId - ID da conta
 * @returns {Object} Credenciais carregadas ou null
 */
function getCredentials(accountId) {
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
 * Garante que existe uma conexão WebSocket API para a conta
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se WebSocket API está disponível
 */
async function ensureWebSocketApiExists(accountId) {
  try {
    // CORREÇÃO: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[WEBSOCKETS] ID da conta inválido: ${accountId} (tipo: ${typeof accountId})`);
      return false;
    }

    console.log(`[WEBSOCKETS] Verificando WebSocket API para conta ${accountId}...`);

    // CORREÇÃO PRINCIPAL: Garantir que o estado da conta existe
    let accountState = getAccountConnectionState(accountId);
    
    if (!accountState) {
      console.log(`[WEBSOCKETS] Estado da conta ${accountId} não existe, inicializando...`);
      
      // Tentar carregar credenciais primeiro
      try {
        await loadCredentialsFromDatabase(accountId);
        accountState = getAccountConnectionState(accountId);
        
        if (!accountState) {
          console.error(`[WEBSOCKETS] Falha ao inicializar estado da conta ${accountId} mesmo após carregar credenciais`);
          return false;
        }
        
        console.log(`[WEBSOCKETS] ✅ Estado da conta ${accountId} inicializado com sucesso`);
      } catch (credError) {
        console.error(`[WEBSOCKETS] Erro ao carregar credenciais para conta ${accountId}:`, credError.message);
        return false;
      }
    }

    // Verificar se as credenciais necessárias estão disponíveis
    if (!accountState.wsApiKey) {
      console.error(`[WEBSOCKETS] wsApiKey não encontrada para conta ${accountId}`);
      return false;
    }

    // Se WebSocket já existe e está conectado
    if (accountState.wsApi && accountState.wsApi.readyState === WebSocket.OPEN) {
      if (accountState.isAuthenticated) {
        console.log(`[WEBSOCKETS] WebSocket API já está conectado e autenticado para conta ${accountId}`);
        return true;
      } else {
        console.log(`[WEBSOCKETS] WebSocket API conectado mas não autenticado para conta ${accountId}, tentando autenticar...`);
        return await authenticateWebSocketApi(accountState.wsApi, accountId);
      }
    }

    // Criar nova conexão WebSocket API
    console.log(`[WEBSOCKETS] Criando nova conexão WebSocket API para conta ${accountId}...`);
    return await startWebSocketApi(accountId);
    
  } catch (error) {
    console.error(`[WEBSOCKETS] Erro ao garantir WebSocket API para conta ${accountId}:`, error.message);
    return false;
  }
}

// Adicionar à lista de exportações

/**
 * Verifica se a conexão WebSocket API está ativa
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se conectado
 */
function isWebSocketApiConnected(accountId) {
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
function isWebSocketApiAuthenticated(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return false;
  
  return accountState.wsApiAuthenticated === true;
}


/**
 * Reinicia as conexões WebSocket para uma conta específica
 * @param {number} accountId - ID da conta
 */
function reset(accountId) {
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

/**
 * Autentica na WebSocket API usando session.logon conforme documentação Binance
 * @param {WebSocket} ws - Conexão WebSocket
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se autenticação bem-sucedida
 */
async function authenticateWebSocketApi(ws, accountId) {
  try {
    console.log(`[WS-API] Iniciando autenticação session.logon para conta ${accountId}...`);
    
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiKey || !accountState.privateKey) {
      throw new Error(`Credenciais WebSocket API incompletas para conta ${accountId}`);
    }
    
    // Implementar session.logon conforme documentação exata
    const timestamp = Date.now();
    const params = {
      apiKey: accountState.wsApiKey,
      timestamp: timestamp
    };
    
    // CORREÇÃO: Ordenar parâmetros alfabeticamente conforme documentação
    const sortedKeys = Object.keys(params).sort();
    const payload = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
    
    console.log(`[WS-API] Payload para assinatura: ${payload}`);
    
    // Assinar com Ed25519
    const signature = createEd25519Signature(payload, accountId);
    params.signature = signature;
    
    // Criar requisição de autenticação conforme formato da documentação
    const authRequest = {
      id: `auth-${Date.now()}`,
      method: 'session.logon',
      params: params
    };
    
    console.log(`[WS-API] Enviando session.logon para conta ${accountId}:`, JSON.stringify(authRequest, null, 2));
    
    // Enviar requisição de autenticação
    const response = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout na autenticação WebSocket API'));
      }, 10000);
      
      const messageHandler = (data) => {
        try {
          const message = JSON.parse(data.toString());
          console.log(`[WS-API] Resposta recebida para autenticação:`, JSON.stringify(message, null, 2));
          
          if (message.id === authRequest.id) {
            clearTimeout(timeout);
            ws.removeListener('message', messageHandler);
            
            if (message.status === 200) {
              console.log(`[WS-API] ✅ Autenticação bem-sucedida para conta ${accountId}`);
              console.log(`[WS-API] API Key autenticada: ${message.result.apiKey.substring(0, 8)}...`);
              resolve(true);
            } else {
              console.error(`[WS-API] Erro na autenticação para conta ${accountId}:`, message.error);
              resolve(false); // CORREÇÃO: Não rejeitar, apenas retornar false
            }
          }
        } catch (parseError) {
          // Ignorar mensagens que não são JSON válido
        }
      };
      
      ws.on('message', messageHandler);
      ws.send(JSON.stringify(authRequest));
    });
    
    if (response) {
      // Marcar como autenticado
      accountState.wsApiAuthenticated = true;
      accountState.isAuthenticated = true;
    }
    
    return response;
    
  } catch (error) {
    console.error(`[WS-API] Erro na autenticação para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Limpa completamente todas as conexões para uma conta
 * @param {number} accountId - ID da conta
 */
function forceCleanupAccount(accountId) {
  console.log(`[WEBSOCKET] 🧹 Limpeza completa para conta ${accountId}...`);
  
  try {
    // Limpar WebSocket API
    cleanupWebSocketApi(accountId);
    
    // Limpar WebSockets de preço
    const priceWebsockets = getPriceWebsockets(accountId);
    if (priceWebsockets) {
      for (const [symbol, ws] of priceWebsockets.entries()) {
        if (ws && ws.readyState !== WebSocket.CLOSED) {
          ws.close(1000, 'Graceful shutdown');
        }
      }
      priceWebsockets.clear();
    }
    
    // Limpar userDataWebSocket
    const accountState = getAccountConnectionState(accountId);
    if (accountState) {
      if (accountState.userDataWebSocket && accountState.userDataWebSocket.readyState !== WebSocket.CLOSED) {
        accountState.userDataWebSocket.close(1000, 'Graceful shutdown');
      }
      
      // Limpar keepalive do listenKey
      if (accountState.listenKeyKeepAliveInterval) {
        clearInterval(accountState.listenKeyKeepAliveInterval);
        accountState.listenKeyKeepAliveInterval = null;
      }
      
      // Remover estado da conta
      accountConnections.delete(accountId);
    }
    
    console.log(`[WEBSOCKET] ✅ Limpeza completa concluída para conta ${accountId}`);
    
  } catch (error) {
    console.error(`[WEBSOCKET] ❌ Erro durante limpeza da conta ${accountId}:`, error.message);
  }
}

// Atualizar função reset para usar o novo cleanup
function reset(accountId) {
  forceCleanupAccount(accountId);
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
  getCredentials,
  ensureWebSocketApiExists,
  getAccountConnectionState,
  getAllAccountConnections,
  handleWebSocketApiMessage,
  createEd25519Signature,
  createEd25519DERFromRaw,
  forceCleanupAccount,
  reset,
};