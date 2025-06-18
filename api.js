const axios = require('axios');
const { getDatabaseInstance } = require('./db/conexao');
const accountStates = new Map();

console.log('[API] Map accountStates criado como singleton global (versão ultra-simples)');

/**
 * Define um estado de conta no Map - VERSÃO ULTRA-SIMPLES
 */
function setAccountState(accountId, state) {
  // OPERAÇÃO DIRETA SEM NENHUM LOG QUE POSSA CAUSAR RECURSÃO
  accountStates.set(accountId, state);
  return true;
}

/**
 * Obtém um estado de conta do Map - VERSÃO ULTRA-SIMPLES
 */
function getAccountState(accountId) {
  return accountStates.get(accountId) || null;
}

/**
 * Debug do Map - VERSÃO ULTRA-SIMPLES
 */
function debugAccountStates() {
  const size = accountStates.size;
  console.log(`[API] DEBUG - Map tem ${size} entradas`);
  if (size === 0) {
    console.log(`[API] DEBUG - Map está vazio!`);
  } else {
    for (const [id] of accountStates.entries()) {
      console.log(`[API] DEBUG - Conta ${id}: OK`);
    }
  }
}


/**
 * Formatar quantidade respeitando a precisão máxima
 * @param {number} quantity - Quantidade a ser formatada
 * @param {number} precision - Precisão (casas decimais)
 * @returns {string} - Quantidade formatada
 */

/**
 * Formatar quantidade CORRETA para cada símbolo
 * @param {number} quantity - Quantidade a ser formatada
 * @param {number} precision - Precisão (casas decimais)
 * @param {string} symbol - Símbolo (para regras específicas)
 * @returns {string} - Quantidade formatada
 */
function formatQuantityCorrect(quantity, precision, symbol) {
  // VALIDAÇÃO CRÍTICA
  if (typeof quantity !== 'number' || typeof precision !== 'number') {
    console.error(`[API] ERRO - Parâmetros inválidos para formatQuantityCorrect: quantity=${quantity} (${typeof quantity}), precision=${precision} (${typeof precision}), symbol=${symbol}`);
    return '0';
  }
  
  if (quantity <= 0 || isNaN(quantity)) {
    console.error(`[API] ERRO - Quantidade inválida: ${quantity}`);
    return '0';
  }
   
  // Para outros símbolos, usar precisão normal
  const validPrecision = Math.max(0, Math.min(8, Math.floor(precision)));
  const formatted = parseFloat(quantity.toFixed(validPrecision));
  const result = formatted.toString();
  
  console.log(`[API] Quantidade formatada: ${quantity} → ${result} (precisão: ${validPrecision})`);
  return result;
}

function formatPrice(price, precision) {
  if (typeof price !== 'number' || typeof precision !== 'number') {
    console.error(`[API] Parâmetros inválidos para formatPrice: price=${price}, precision=${precision}`);
    return '0';
  }
  
  // Garantir que precision seja válida (0-8)
  const validPrecision = Math.max(0, Math.min(8, Math.floor(precision)));
  
  // Formatar com precisão exata
  const formatted = parseFloat(price.toFixed(validPrecision));
  
  // Converter para string removendo zeros desnecessários
  const result = formatted.toString();
  
  console.log(`[API] Preço formatado: ${price} → ${result} (precisão: ${validPrecision})`);
  return result;
}


// Map global para estados das contas - DEVE SER O MESMO EM TODO LUGAR
// Tornar disponível globalmente
if (typeof global !== 'undefined') {
  global.accountStates = accountStates;
}

/**
 * Obtém o Map de estados de forma consistente
 * @returns {Map} - Map de estados das contas
 */
function getAccountStatesMap() {
  // Sempre retornar a mesma referência
  return accountStates;
}

/**
 * Define um estado de conta no Map global
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(`[API] Definindo estado para conta ${accountId} no Map global`);
  setAccountState(accountId, state);
  
  // Garantir que está disponível globalmente também
  if (typeof global !== 'undefined') {
    if (!global.accountStates) {
      global.accountStates = accountStates;
    }
    global.setAccountState(accountId, state);
  }
  
  console.log(`[API] Estado definido. Map agora tem ${accountStates.size} contas`);
}

/**
 * Obtém um estado de conta do Map global
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  let state = getAccountState(accountId);
  
  if (!state && typeof global !== 'undefined' && global.accountStates) {
    state = global.getAccountState(accountId);
    if (state) {
      console.log(`[API] Estado encontrado no global, copiando para Map local`);
      setAccountState(accountId, state);
    }
  }
  
  console.log(`[API] getAccountState(${accountId}): ${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
  return state;
}

// Map para armazenar estados das contas
// Mapa global para armazenar estados das conexões de cada conta
const accountConnections = new Map();

/**
 * Obtém ou cria o estado de conexão para uma conta
 */
function getAccountConnectionState(accountId, createIfMissing = false) {
  //console.log(`[API_STATE] getAccountConnectionState chamado: accountId=${accountId}, createIfMissing=${createIfMissing}`);
  
  if (!accountId || typeof accountId !== 'number') {
    console.warn(`[API_STATE] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
    return null;
  }

  // Verificar se já existe
  let state = accountConnections.get(accountId);
  //console.log(`[API_STATE] Estado existente para conta ${accountId}: ${state ? 'SIM' : 'NÃO'}`);

  if (!state && createIfMissing) {
    console.log(`[API_STATE] Criando novo estado para conta ${accountId}...`);
    state = {
      accountId: accountId,
      apiKey: null,
      secretKey: null,
      wsApiKey: null,
      wsApiSecret: null,
      privateKey: null,
      apiUrl: null,
      wsUrl: null,
      wsApiUrl: null,
      isAuthenticated: false,
      wsApiAuthenticated: false,
      wsApiConnection: null,
      wsApiRequestCallbacks: new Map(),
      wsApiKeepAliveInterval: null,
      lastWsApiActivity: 0,
      userDataStream: null,
      listenKey: null,
      userDataKeepAliveInterval: null,
      lastUserDataStreamKeepAlive: 0,
      priceWebsockets: new Map(),
      monitoringCallbacks: null,
      isShuttingDown: false,
      dbInstance: null,
      lastPongTime: 0,
      pingInterval: null,
      ambiente: null,
      corretora: null,
      nomeConta: null,
    };
    
    accountConnections.set(accountId, state);
    console.log(`[API_STATE] ✅ Estado criado e armazenado para conta ${accountId}`);
    console.log(`[API_STATE] Total de contas no Map: ${accountConnections.size}`);
  }
  
  // Verificar novamente se existe
  const finalState = accountConnections.get(accountId);
  //console.log(`[API_STATE] Estado final para conta ${accountId}: ${finalState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
  
  return finalState || null;
}

/**
 * Retorna todas as conexões de contas
 */
function getAllAccountConnections() {
  console.log(`[API] getAllAccountConnections chamado. Total de contas: ${accountConnections.size}`);
  return accountConnections;
}

/**
 * Carrega credenciais do banco de dados e atualiza o estado da conta
 */
async function loadCredentialsFromDatabase(accountId) {
  console.log(`[API] === NOVA FUNÇÃO loadCredentialsFromDatabase para conta ${accountId} ===`);
  
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = `AccountId deve ser um número válido: ${String(accountId)} (tipo: ${typeof accountId})`;
    console.error(`[API] ${errorMsg}`);
    throw new Error(errorMsg);
  }

  // PASSO 1: Garantir que o estado existe
  console.log(`[API] PASSO 1: Criando/obtendo estado para conta ${accountId}...`);
  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState) {
    console.error(`[API] ERRO: Não foi possível criar estado para conta ${accountId}`);
    throw new Error(`Não foi possível criar estado para conta ${accountId}`);
  }
  
  console.log(`[API] ✅ Estado obtido para conta ${accountId}, accountId no estado: ${accountState.accountId}`);

  // PASSO 2: Obter conexão com banco
  console.log(`[API] PASSO 2: Obtendo conexão com banco...`);
  const db = await getDatabaseInstance(accountId);

  // PASSO 3: Executar query
  console.log(`[API] PASSO 3: Executando query para carregar credenciais...`);
  
  const [rows] = await db.query(
    `SELECT c.id, c.nome, c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, 
            co.ambiente, co.corretora, co.futures_rest_api_url, co.futures_ws_market_url, co.futures_ws_api_url
     FROM contas c
     JOIN corretoras co ON c.id_corretora = co.id
     WHERE c.id = ? AND c.ativa = 1`,
    [accountId]
  );

  console.log(`[API] Query executada, ${rows.length} linha(s) retornada(s)`);
  
  if (rows.length === 0) {
    throw new Error(`Conta ${accountId} não encontrada, inativa ou sem corretora associada.`);
  }
  
  const creds = rows[0];
  console.log(`[API] Dados obtidos do banco:`, {
    id: creds.id,
    nome: creds.nome,
    has_api_key: !!creds.api_key,
    has_api_secret: !!creds.api_secret,
    has_ws_api_key: !!creds.ws_api_key,
    has_ws_api_secret: !!creds.ws_api_secret,
    futures_rest_api_url: creds.futures_rest_api_url,
    futures_ws_market_url: creds.futures_ws_market_url,
    futures_ws_api_url: creds.futures_ws_api_url,
    ambiente: creds.ambiente,
    corretora: creds.corretora
  });

  // PASSO 4: Atualizar estado
  console.log(`[API] PASSO 4: Atualizando estado com credenciais...`);
  
  accountState.accountId = accountId;
  accountState.apiKey = creds.api_key;
  accountState.secretKey = creds.api_secret;
  accountState.wsApiKey = creds.ws_api_key;
  accountState.wsApiSecret = creds.ws_api_secret;
  accountState.privateKey = creds.ws_api_secret;
  accountState.apiUrl = creds.futures_rest_api_url;
  accountState.wsUrl = creds.futures_ws_market_url;
  accountState.wsApiUrl = creds.futures_ws_api_url;
  accountState.ambiente = creds.ambiente;
  accountState.corretora = creds.corretora;
  accountState.nomeConta = creds.nome;

  console.log(`[API] PASSO 5: Verificando estado final...`);
  console.log(`[API] Estado final da conta ${accountId}:`);
  console.log(`  - accountId: ${accountState.accountId}`);
  console.log(`  - apiKey: ${accountState.apiKey ? accountState.apiKey.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`  - secretKey: ${accountState.secretKey ? 'OK' : 'MISSING'}`);
  console.log(`  - wsApiKey: ${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'MISSING'}`);
  console.log(`  - wsApiSecret: ${accountState.wsApiSecret ? 'OK' : 'MISSING'}`);
  console.log(`  - apiUrl: ${accountState.apiUrl || 'MISSING'}`);
  console.log(`  - wsUrl: ${accountState.wsUrl || 'MISSING'}`);
  console.log(`  - wsApiUrl: ${accountState.wsApiUrl || 'MISSING'}`);
  console.log(`  - ambiente: ${accountState.ambiente || 'MISSING'}`);
  console.log(`  - corretora: ${accountState.corretora || 'MISSING'}`);
  
  // PASSO 6: Verificar se o estado foi salvo no Map
  const verifyState = accountConnections.get(accountId);
  console.log(`[API] Verificação final: Estado existe no Map: ${verifyState ? 'SIM' : 'NÃO'}`);
  
  if (verifyState) {
    console.log(`[API] ✅ Estado verificado no Map para conta ${accountId}`);
    console.log(`[API] Estado verificado possui: apiKey=${!!verifyState.apiKey}, apiUrl=${!!verifyState.apiUrl}`);
  } else {
    console.error(`[API] ❌ ERRO: Estado não encontrado no Map após criação!`);
  }
  
  // GARANTIR que o estado está no Map unificado
  // Salvar estado no Map unificado
  accountStates.set(accountId, accountState);
  console.log('[API] Estado salvo diretamente no Map');
  
  console.log(`[API] === FIM loadCredentialsFromDatabase para conta ${accountId} ===`);
  return accountState;
}

/**
 * Faz requisição autenticada para a API
 */
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance - SEM RECURSÃO
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
/**
 * Faz uma requisição autenticada para a API da Binance - VERSÃO COM ASSINATURA CORRIGIDA
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
async function makeAuthenticatedRequest(accountId, method, endpoint, params = {}) {
  try {
    console.log(`[API] makeAuthenticatedRequest chamado: accountId=${accountId}, method=${method}, endpoint=${endpoint}`);
    
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    // Debug do Map
    debugAccountStates();
    
    // Buscar estado no Map
    const accountState = accountStates.get(accountId);
    console.log(`[API] makeAuthenticatedRequest - Estado direto do Map: ${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
    
    if (!accountState) {
      throw new Error(`Estado da conta ${accountId} não encontrado no Map. Deve ser carregado primeiro via loadCredentialsFromDatabase.`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(`Credenciais incompletas para conta ${accountId}: apiKey=${!!apiKey}, secretKey=${!!secretKey}, apiUrl=${!!apiUrl}`);
    }
    
    console.log(`[API] ✅ Usando credenciais da conta ${accountId} - apiKey: ${apiKey.substring(0, 8)}...`);
    
    // CORREÇÃO CRÍTICA: Timestamp deve ser em milliseconds e recente
    const timestamp = Date.now();
    
    // CORREÇÃO CRÍTICA: Para métodos GET, incluir parâmetros na query string
    // Para métodos POST/PUT/DELETE, incluir no body
    let queryString = '';
    let bodyData = '';
    
    if (method === 'GET') {
      // Para GET: todos os parâmetros vão na query string para assinatura
      const queryParams = {
        ...params,
        timestamp: timestamp
      };
      
      queryString = Object.keys(queryParams)
        .sort() // IMPORTANTE: ordenar as chaves
        .map(key => {
          const value = queryParams[key];
          return `${key}=${encodeURIComponent(value)}`;
        })
        .join('&');
        
    } else {
      // Para POST/PUT/DELETE: parâmetros vão no body para assinatura
      const bodyParams = {
        ...params,
        timestamp: timestamp
      };
      
      queryString = Object.keys(bodyParams)
        .sort() // IMPORTANTE: ordenar as chaves
        .map(key => {
          const value = bodyParams[key];
          return `${key}=${encodeURIComponent(value)}`;
        })
        .join('&');
        
      bodyData = queryString;
    }
    
    // CORREÇÃO CRÍTICA: Gerar assinatura HMAC-SHA256 correta
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString) // Assinar a query string ordenada
      .digest('hex');
    
    console.log(`[API] Timestamp: ${timestamp}`);
    console.log(`[API] Query string para assinatura: ${queryString.substring(0, 100)}...`);
    console.log(`[API] Assinatura gerada: ${signature.substring(0, 16)}...`);
    
    // Adicionar assinatura
    const finalQueryString = queryString + `&signature=${signature}`;
    
    // Construir URL final
    let fullUrl;
    if (method === 'GET') {
      fullUrl = `${apiUrl}${endpoint}?${finalQueryString}`;
    } else {
      fullUrl = `${apiUrl}${endpoint}`;
    }
    
    console.log(`[API] Fazendo requisição: ${method} ${fullUrl.split('?')[0]}`);
    
    // Configurar headers
    const headers = {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    
    // Fazer requisição
    const axios = require('axios');
    let response;
    
    if (method === 'GET') {
      response = await axios.get(fullUrl, { headers });
    } else if (method === 'POST') {
      const postData = bodyData + `&signature=${signature}`;
      response = await axios.post(fullUrl, postData, { headers });
    } else if (method === 'PUT') {
      const putData = bodyData + `&signature=${signature}`;
      response = await axios.put(fullUrl, putData, { headers });
    } else if (method === 'DELETE') {
      const deleteData = bodyData + `&signature=${signature}`;
      response = await axios.delete(fullUrl, { headers, data: deleteData });
    } else {
      throw new Error(`Método HTTP não suportado: ${method}`);
    }
    
    return response.data;
    
  } catch (error) {
    const errorMessage = error.response?.data?.msg || error.message;
    console.error(`[API] Falha na requisição ${method} ${endpoint}: ${errorMessage}`);
    throw new Error(`Falha na requisição ${method} ${endpoint}: ${errorMessage}`);
  }
}

/**
 * Obtém preço de um símbolo
 */
async function getPrice(symbol, accountId) {
  try {
    console.log(`[API] getPrice - symbol: ${symbol}, accountId: ${accountId}`);
    
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(`Símbolo inválido: ${symbol}`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }

    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/ticker/price', { symbol });
    
    if (response && response.price) {
      const price = parseFloat(response.price);
      if (isNaN(price) || price <= 0) {
        console.error(`[API] Preço inválido recebido para ${symbol}: ${response.price}`);
        return null;
      }
      console.log(`[API] ✅ Preço obtido para ${symbol}: ${price}`);
      return price;
    } else {
      console.error(`[API] Resposta inválida ao obter preço para ${symbol}:`, response);
      return null;
    }
  } catch (error) {
    console.error(`[API] Erro ao obter preço para ${symbol} (conta ${accountId}):`, error.message);
    return null;
  }
}

/**
 * Obtém todas as posições abertas
 */
async function getAllOpenPositions(accountId) {
  try {
    console.log(`[API] Obtendo posições abertas para conta ${accountId}...`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', {});
    
    if (!Array.isArray(response)) {
      console.error(`[API] Resposta inválida ao obter posições para conta ${accountId}:`, response);
      return [];
    }

    const openPositions = response
      .filter(pos => parseFloat(pos.positionAmt) !== 0)
      .map(pos => ({
        simbolo: pos.symbol,
        quantidade: Math.abs(parseFloat(pos.positionAmt)),
        lado: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
        precoEntrada: parseFloat(pos.entryPrice),
        precoAtual: parseFloat(pos.markPrice),
        alavancagem: parseInt(pos.leverage) || 1,
        pnlNaoRealizado: parseFloat(pos.unRealizedProfit),
        margem: parseFloat(pos.isolatedMargin),
        tipo: pos.marginType === 'isolated' ? 'ISOLATED' : 'CROSS'
      }));

    //console.log(`[API] ✅ ${openPositions.length} posições abertas encontradas para conta ${accountId}`);
    return openPositions;
  } catch (error) {
    console.error(`[API] Erro ao obter posições abertas para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Obtém listen key para UserDataStream
 */
async function getListenKey(accountId) {
  try {
    console.log(`[API] Obtendo listen key para conta ${accountId}...`);
    
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiKey || !accountState.apiUrl) {
      console.log(`[API] API Key ou API URL não configuradas para getListenKey da conta ${accountId}.`);
      return null;
    }

    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/listenKey', {});
    
    if (response && response.listenKey) {
      console.log(`[API] ✅ Listen key obtido para conta ${accountId}`);
      return response.listenKey;
    } else {
      console.error(`[API] Resposta inválida ao obter listen key para conta ${accountId}:`, response);
      return null;
    }
  } catch (error) {
    console.error(`[API] Erro ao obter listen key para conta ${accountId}:`, error.message);
    return null;
  }
}


/**
 * Obtém precisão de um símbolo
 */

// Cache para precisões (evitar múltiplas chamadas)
const precisionCache = new Map();

/**
 * Obtém precisão com cache
 * @param {string} symbol - Símbolo
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações de precisão
 */
async function getPrecisionCached(symbol, accountId) {
  const cacheKey = `${symbol}_${accountId}`;
  
  if (precisionCache.has(cacheKey)) {
    const cached = precisionCache.get(cacheKey);
    console.log(`[API] Usando precisão em cache para ${symbol}`);
    return cached;
  }
  
  console.log(`[API] Obtendo precisão para ${symbol} (conta ${accountId})...`);
  const precision = await getPrecision(symbol, accountId);
  
  // Cache por 5 minutos
  precisionCache.set(cacheKey, precision);
  setTimeout(() => precisionCache.delete(cacheKey), 5 * 60 * 1000);
  
  return precision;
}

let exchangeInfoCache = null;
let lastCacheTime = 0;
const CACHE_DURATION = 10 * 60 * 1000; // 10 minutos

async function getPrecision(symbol, accountId) {
    const now = Date.now();
    try {
        if (!exchangeInfoCache || (now - lastCacheTime > CACHE_DURATION)) {
            console.log(`[API] Cache de exchangeInfo inválido/expirado. Buscando da API...`);
            const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/exchangeInfo');

            // CORREÇÃO: Aceitar tanto response.data.symbols quanto response.symbols
            let symbolsArr = null;
            if (response.data && Array.isArray(response.data.symbols)) {
                symbolsArr = response.data.symbols;
            } else if (Array.isArray(response.symbols)) {
                symbolsArr = response.symbols;
            }

            if (!symbolsArr) {
                console.error('[API] Erro Crítico: Resposta de exchangeInfo da API é inválida ou malformada.', response);
                throw new Error('Resposta inválida da API para exchangeInfo');
            }

            exchangeInfoCache = symbolsArr;
            lastCacheTime = now;
            console.log(`[API] Cache de exchangeInfo atualizado com sucesso.`);
        }

        const symbolInfo = exchangeInfoCache.find(s => s.symbol === symbol);

        if (symbolInfo) {
            const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
            const minNotionalFilter = symbolInfo.filters.find(f => f.filterType === 'MIN_NOTIONAL'); // ✅ NOVO
            const marketLotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'MARKET_LOT_SIZE'); // ✅ NOVO
            
            const quantityPrecision = lotSizeFilter ? Math.max(0, Math.log10(1 / parseFloat(lotSizeFilter.stepSize))) : 0;
            const pricePrecision = symbolInfo.pricePrecision || 2;
            const tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.01;
            
            // ✅ EXTRAIR QUANTIDADES MÍNIMAS E MÁXIMAS
            // ✅ EXTRAIR QUANTIDADES MÍNIMAS E MÁXIMAS
            const minQty = lotSizeFilter ? parseFloat(lotSizeFilter.minQty) : 0.001;
            const maxQty = lotSizeFilter ? parseFloat(lotSizeFilter.maxQty) : 10000000;
            const stepSize = lotSizeFilter ? parseFloat(lotSizeFilter.stepSize) : 0.001;
            
            // ✅ QUANTIDADE MÍNIMA PARA MARKET ORDERS
            const marketMinQty = marketLotSizeFilter ? parseFloat(marketLotSizeFilter.minQty) : minQty;
            const marketMaxQty = marketLotSizeFilter ? parseFloat(marketLotSizeFilter.maxQty) : maxQty;
            
            // ✅ VALOR NOTIONAL MÍNIMO - CORREÇÃO CRÍTICA
            let minNotional = 0;
            if (minNotionalFilter) {
              const minNotionalValue = parseFloat(minNotionalFilter.minNotional);
              minNotional = isNaN(minNotionalValue) ? 0 : minNotionalValue;
            } else {
              // FALLBACK: Para pares USDT, geralmente é 20
              if (symbol && symbol.includes('USDT')) {
                minNotional = 20; // Valor padrão para pares USDT
              }
            }
            
            // ✅ FALLBACK ADICIONAL: Se ainda for 0, usar 20 para USDT pairs
            if (minNotional === 0 && symbol && symbol.includes('USDT')) {
              minNotional = 20;
              console.log(`[API] Usando minNotional fallback de 20 USDT para ${symbol}`);
            }

            const precision = {
                quantityPrecision: Math.floor(quantityPrecision),
                pricePrecision: pricePrecision,
                tickSize: tickSize,
                // ✅ NOVOS CAMPOS PARA VALIDAÇÃO
                minQty: minQty,
                maxQty: maxQty,
                stepSize: stepSize,
                marketMinQty: marketMinQty,
                marketMaxQty: marketMaxQty,
                minNotional: minNotional // ✅ GARANTIDO QUE NÃO SEJA NaN
            };

            console.log(`[API] ✅ Precisão completa obtida para ${symbol}:`, {
                quantityPrecision: precision.quantityPrecision,
                pricePrecision: precision.pricePrecision,
                tickSize: precision.tickSize,
                minQty: precision.minQty,
                maxQty: precision.maxQty,
                minNotional: precision.minNotional, // ✅ Mostrar no log
                // ✅ DEBUG ADICIONAL
                hasMinNotionalFilter: !!minNotionalFilter,
                originalMinNotional: minNotionalFilter ? minNotionalFilter.minNotional : 'N/A'
            });
            
            return precision;
        }

        throw new Error(`Informações de precisão não encontradas para o símbolo ${symbol}`);

    } catch (error) {
        console.error(`[API] ERRO GRAVE em getPrecision para ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Valida se a quantidade atende aos requisitos mínimos do símbolo
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade a ser validada
 * @param {number} price - Preço para calcular notional
 * @param {number} accountId - ID da conta
 * @param {string} orderType - Tipo da ordem (LIMIT, MARKET, etc.)
 * @returns {Promise<Object>} - Resultado da validação
 */
async function validateQuantity(symbol, quantity, price, accountId, orderType = 'LIMIT') {
    try {
        console.log(`[API] Validando quantidade para ${symbol}: ${quantity} @ ${price} (tipo: ${orderType})`);
        
        const precision = await getPrecisionCached(symbol, accountId);
        
        // VALIDAÇÕES BÁSICAS
        if (!quantity || quantity <= 0 || isNaN(quantity)) {
            return {
                isValid: false,
                reason: 'Quantidade deve ser um número positivo',
                minRequired: precision.minQty,
                provided: quantity
            };
        }
        
        if (!price || price <= 0 || isNaN(price)) {
            return {
                isValid: false,
                reason: 'Preço deve ser um número positivo para validação de notional',
                minRequired: 0.01,
                provided: price
            };
        }
        
        // VALIDAR QUANTIDADE MÍNIMA (diferente para MARKET e LIMIT)
        let minQtyRequired;
        let maxQtyAllowed;
        
        if (orderType === 'MARKET') {
            minQtyRequired = precision.marketMinQty || precision.minQty;
            maxQtyAllowed = precision.marketMaxQty || precision.maxQty;
        } else {
            minQtyRequired = precision.minQty;
            maxQtyAllowed = precision.maxQty;
        }
        
        if (quantity < minQtyRequired) {
            return {
                isValid: false,
                reason: `Quantidade abaixo do mínimo para ${orderType}`,
                minRequired: minQtyRequired,
                provided: quantity,
                suggestion: minQtyRequired
            };
        }
        
        // VALIDAR QUANTIDADE MÁXIMA
        if (quantity > maxQtyAllowed) {
            return {
                isValid: false,
                reason: `Quantidade acima do máximo permitido para ${orderType}`,
                maxAllowed: maxQtyAllowed,
                provided: quantity,
                suggestion: maxQtyAllowed
            };
        }
        
        // VALIDAR STEP SIZE (incremento)
        const stepSize = precision.stepSize;
        if (stepSize > 0) {
            const remainder = (quantity * 1e10) % (stepSize * 1e10);
            if (Math.abs(remainder) > 1e-10) {
                const correctedQty = Math.floor(quantity / stepSize) * stepSize;
                return {
                    isValid: false,
                    reason: 'Quantidade não é múltiplo do step size',
                    stepSize: stepSize,
                    provided: quantity,
                    suggestion: parseFloat(correctedQty.toFixed(precision.quantityPrecision))
                };
            }
        }
        
        // VALIDAR VALOR NOTIONAL MÍNIMO
        const notionalValue = quantity * price;
        if (precision.minNotional > 0 && notionalValue < precision.minNotional) {
            const minQtyForNotional = precision.minNotional / price;
            return {
                isValid: false,
                reason: 'Valor notional abaixo do mínimo',
                minNotional: precision.minNotional,
                currentNotional: notionalValue,
                minQtyForNotional: parseFloat(minQtyForNotional.toFixed(precision.quantityPrecision)),
                provided: quantity,
                suggestion: Math.max(minQtyRequired, minQtyForNotional)
            };
        }
        
        console.log(`[API] ✅ Quantidade ${quantity} válida para ${symbol} (${orderType})`);
        return {
            isValid: true,
            quantity: quantity,
            notionalValue: notionalValue,
            orderType: orderType
        };
        
    } catch (error) {
        console.error(`[API] Erro ao validar quantidade para ${symbol}:`, error.message);
        return {
            isValid: false,
            reason: `Erro na validação: ${error.message}`,
            provided: quantity
        };
    }
}

/**
 * Ajusta automaticamente a quantidade para atender aos requisitos
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade original
 * @param {number} price - Preço
 * @param {number} accountId - ID da conta
 * @param {string} orderType - Tipo da ordem
 * @returns {Promise<Object>} - Quantidade ajustada
 */
async function adjustQuantityToRequirements(symbol, quantity, price, accountId, orderType = 'LIMIT') {
    try {
        const validation = await validateQuantity(symbol, quantity, price, accountId, orderType);
        
        if (validation.isValid) {
            return {
                success: true,
                originalQuantity: quantity,
                adjustedQuantity: quantity,
                wasAdjusted: false
            };
        }
        
        // SE TEM SUGESTÃO, USAR ELA
        if (validation.suggestion && validation.suggestion > 0) {
            const newValidation = await validateQuantity(symbol, validation.suggestion, price, accountId, orderType);
            
            if (newValidation.isValid) {
                console.log(`[API] Quantidade ajustada: ${quantity} → ${validation.suggestion} (${validation.reason})`);
                return {
                    success: true,
                    originalQuantity: quantity,
                    adjustedQuantity: validation.suggestion,
                    wasAdjusted: true,
                    reason: validation.reason
                };
            }
        }
        
        // SE NÃO TEM SUGESTÃO OU A SUGESTÃO FALHOU, TENTAR CALCULAR MÍNIMO VÁLIDO
        const precision = await getPrecisionCached(symbol, accountId);
        const minQtyRequired = orderType === 'MARKET' ? 
            (precision.marketMinQty || precision.minQty) : 
            precision.minQty;
        
        // ✅ CORREÇÃO CRÍTICA: GARANTIR QUE ATENDE TAMBÉM O NOTIONAL MÍNIMO
        let finalQuantity = minQtyRequired;
        if (precision.minNotional > 0) {
            const minQtyForNotional = precision.minNotional / price;
            finalQuantity = Math.max(minQtyRequired, minQtyForNotional);
            
            console.log(`[API] Cálculo de quantidade mínima:`);
            console.log(`  - minQty do exchange: ${minQtyRequired}`);
            console.log(`  - minNotional: ${precision.minNotional} USDT`);
            console.log(`  - Preço: ${price}`);
            console.log(`  - Qty para notional: ${minQtyForNotional.toFixed(8)}`);
            console.log(`  - Quantidade final: ${finalQuantity.toFixed(8)}`);
        }
        
        // ARREDONDAR PARA O STEP SIZE
        if (precision.stepSize > 0) {
            finalQuantity = Math.ceil(finalQuantity / precision.stepSize) * precision.stepSize;
        }
        
        // FORMATAR COM PRECISÃO CORRETA
        finalQuantity = parseFloat(finalQuantity.toFixed(precision.quantityPrecision));
        
        // ✅ VALIDAÇÃO FINAL: Verificar se a quantidade realmente atende o notional
        const finalNotional = finalQuantity * price;
        if (precision.minNotional > 0 && finalNotional < precision.minNotional) {
            return {
                success: false,
                originalQuantity: quantity,
                error: `Mesmo com ajuste máximo, não é possível atingir notional mínimo. Quantidade: ${finalQuantity}, Notional: ${finalNotional.toFixed(2)}, Mínimo: ${precision.minNotional}`,
                suggestedAction: `Aumente o capital ou use um símbolo com menor valor notional mínimo`
            };
        }
        
        console.log(`[API] Quantidade ajustada automaticamente: ${quantity} → ${finalQuantity}`);
        return {
            success: true,
            originalQuantity: quantity,
            adjustedQuantity: finalQuantity,
            wasAdjusted: true,
            reason: `Ajustada para atender requisitos mínimos de ${symbol}`
        };
    } catch (error) {
        console.error(`[API] Erro ao ajustar quantidade para ${symbol}:`, error.message);
        return {
            success: false,
            originalQuantity: quantity,
            error: error.message
        };
    }
}

/**
 * Obtém alavancagem atual de um símbolo
 */
async function getCurrentLeverage(symbol, accountId) {
  try {
    console.log(`[API] Obtendo alavancagem atual para ${symbol} (conta ${accountId})...`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', { symbol });
    
    if (response && Array.isArray(response) && response.length > 0) {
      const leverage = parseInt(response[0].leverage) || 20;
      console.log(`[API] ✅ Alavancagem atual para ${symbol}: ${leverage}x`);
      return leverage;
    }
    
    console.warn(`[API] Alavancagem não encontrada para ${symbol}, usando padrão 20x`);
    return 20;
  } catch (error) {
    console.error(`[API] Erro ao obter alavancagem para ${symbol}:`, error.message);
    return 20;
  }
}
/**
 * Altera alavancagem inicial de um símbolo
 */
async function changeInitialLeverage(symbol, leverage, accountId) {
  try {
    console.log(`[API] Alterando alavancagem para ${symbol}: ${leverage}x (conta ${accountId})...`);
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/leverage', {
      symbol,
      leverage
    });
    
    if (response) {
      console.log(`[API] ✅ Alavancagem alterada para ${symbol}: ${leverage}x`);
      return response;
    }
    
    throw new Error('Resposta inválida');
  } catch (error) {
    console.error(`[API] Erro ao alterar alavancagem para ${symbol}:`, error.message);
    throw error;
  }
}
/**
 * Obtém tipo de margem atual de um símbolo
 */
async function getCurrentMarginType(symbol, accountId) {
  try {
    console.log(`[API] Obtendo tipo de margem para ${symbol} (conta ${accountId})...`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', { symbol });
    
    if (response && Array.isArray(response) && response.length > 0) {
      const marginType = response[0].marginType || 'cross';
      console.log(`[API] ✅ Tipo de margem para ${symbol}: ${marginType}`);
      return marginType.toLowerCase();
    }
    
    console.warn(`[API] Tipo de margem não encontrado para ${symbol}, usando padrão 'cross'`);
    return 'cross';
  } catch (error) {
    console.error(`[API] Erro ao obter tipo de margem para ${symbol}:`, error.message);
    return 'cross';
  }
}
/**
 * Altera tipo de margem de um símbolo
 */
async function changeMarginType(symbol, marginType, accountId) {
  try {
    console.log(`[API] Alterando tipo de margem para ${symbol}: ${marginType} (conta ${accountId})...`);
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/marginType', {
      symbol,
      marginType: marginType.toUpperCase()
    });
    
    if (response) {
      console.log(`[API] ✅ Tipo de margem alterado para ${symbol}: ${marginType}`);
      return response;
    }
    
    throw new Error('Resposta inválida');
  } catch (error) {
    console.error(`[API] Erro ao alterar tipo de margem para ${symbol}:`, error.message);
    throw error;
  }
}


/**
 * Verifica e corrige consistência do ambiente
 */
async function verifyAndFixEnvironmentConsistency(accountId) {
  try {
    console.log(`[API] Verificando consistência de ambiente para conta ${accountId}...`);
    
    const accountState = getAccountConnectionState(accountId);
    if (!accountState) {
      console.warn(`[API] Estado da conta ${accountId} não encontrado para verificação de consistência`);
      return false;
    }
    
    // Verificar se URLs estão corretas para o ambiente
    const { ambiente, apiUrl, wsUrl, wsApiUrl } = accountState;
    
    if (ambiente === 'prd') {
      // Verificar se não está usando URLs de testnet
      const isTestnet = apiUrl?.includes('testnet') || wsUrl?.includes('testnet') || wsApiUrl?.includes('testnet');
      if (isTestnet) {
        console.warn(`[API] ⚠️ Ambiente de produção usando URLs de testnet para conta ${accountId}`);
        return false;
      }
    } else {
      // Verificar se não está usando URLs de produção
      const isProduction = !apiUrl?.includes('testnet') || !wsUrl?.includes('testnet') || !wsApiUrl?.includes('testnet');
      if (isProduction) {
        console.warn(`[API] ⚠️ Ambiente de testnet usando URLs de produção para conta ${accountId}`);
        return false;
      }
    }
    
    console.log(`[API] ✅ Consistência de ambiente verificada para conta ${accountId}`);
    return true;
  } catch (error) {
    console.error(`[API] Erro ao verificar consistência de ambiente:`, error.message);
    return false;
  }
}


/**
 * Obtém detalhes do saldo da conta de futuros via REST API
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Detalhes do saldo formatados
 */
async function getFuturesAccountBalanceDetails(accountId) {
  try {
    console.log(`[API] Obtendo detalhes do saldo para conta ${accountId}...`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }

    // CHAMADA REST API PARA /v2/balance
    const balanceData = await makeAuthenticatedRequest(accountId, 'GET', '/v2/balance');
    
    if (!Array.isArray(balanceData)) {
      throw new Error('Resposta inválida da API de saldo');
    }

    // PROCESSAR DADOS DO SALDO USDT
    const usdtBalance = balanceData.find(asset => asset.asset === 'USDT');
    
    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na resposta');
    }

    const saldoTotal = parseFloat(usdtBalance.balance || '0');
    const saldoDisponivel = parseFloat(usdtBalance.availableBalance || '0');
    const saldoUtilizado = saldoTotal - saldoDisponivel;

    console.log(`[API] ✅ Saldo obtido para conta ${accountId}:`);
    console.log(`  - Total: ${saldoTotal.toFixed(2)} USDT`);
    console.log(`  - Disponível: ${saldoDisponivel.toFixed(2)} USDT`);
    console.log(`  - Em uso: ${saldoUtilizado.toFixed(2)} USDT`);
    
    // ATUALIZAR NO BANCO DE DADOS
    const db = await getDatabaseInstance(accountId);
    
    // Obter saldo anterior para comparação
    const [previousBalance] = await db.query(
      'SELECT saldo, saldo_base_calculo FROM contas WHERE id = ?',
      [accountId]
    );
    
    const previousSaldo = previousBalance.length > 0 ? parseFloat(previousBalance[0].saldo || '0') : 0;
    const previousBaseCalculo = previousBalance.length > 0 ? parseFloat(previousBalance[0].saldo_base_calculo || '0') : 0;
    
    // Calcular nova base de cálculo (manter o maior entre 5% do saldo atual e base anterior)
    const calculoBaseada5Porcento = saldoDisponivel * 0.05;
    const novaBaseCalculo = Math.max(calculoBaseada5Porcento, previousBaseCalculo);
    
    console.log(`[API] Cálculo da base:`);
    console.log(`  - 5% do saldo disponível: ${calculoBaseada5Porcento.toFixed(2)} USDT`);
    console.log(`  - Base anterior: ${previousBaseCalculo.toFixed(2)} USDT`);
    console.log(`  - Nova base (maior): ${novaBaseCalculo.toFixed(2)} USDT`);
    
    // CORREÇÃO: Usar coluna 'ultima_atualizacao' em vez de 'ultima_atualizacao_saldo'
    await db.query(
      'UPDATE contas SET saldo = ?, saldo_base_calculo = ?, ultima_atualizacao = NOW() WHERE id = ?',
      [saldoTotal, novaBaseCalculo, accountId]
    );
    
    //console.log(`[API] ✅ Saldo atualizado no banco para conta ${accountId}`);
    
    // RETORNAR FORMATO PADRONIZADO
    return {
      success: true,
      accountId: accountId,
      saldo: saldoTotal,
      saldo_disponivel: saldoDisponivel,
      saldo_base_calculo: novaBaseCalculo,
      previousSaldo: previousSaldo,
      previousBaseCalculo: previousBaseCalculo,
      assets: balanceData,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao obter detalhes do saldo para conta ${accountId}:`, error.message);
    
    return {
      success: false,
      accountId: accountId,
      error: error.message,
      saldo: 0,
      saldo_disponivel: 0,
      saldo_base_calculo: 0,
      previousSaldo: 0,
      previousBaseCalculo: 0,
      timestamp: new Date().toISOString()
    };
  }
}


/**
 * Obtém ordens recentes para sincronização
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @param {number} limit - Limite de ordens (padrão: 10)
 * @returns {Promise<Array>} - Lista de ordens recentes
 */
async function getRecentOrders(accountId, symbol, limit = 10) {
  try {
    console.log(`[API] Obtendo ordens recentes para ${symbol} (conta ${accountId})...`);
    
    const params = {
      symbol: symbol,
      limit: limit
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/allOrders', params);
    
    if (Array.isArray(response)) {
      console.log(`[API] ✅ ${response.length} ordens recentes obtidas para ${symbol}`);
      return response;
    } else {
      console.error(`[API] Resposta inválida ao obter ordens recentes para ${symbol}:`, response);
      return [];
    }
  } catch (error) {
    console.error(`[API] Erro ao obter ordens recentes para ${symbol} (conta ${accountId}):`, error.message);
    return [];
  }
}

/**
 * Obtém o tick size (precisão de preço) para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Tick size (ex: 0.00001)
 */
/**
 * Obtém o tick size (precisão de preço) para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Tick size (ex: 0.00001)
 */
async function getTickSize(symbol, accountId) {
  try {
    console.log(`[API] Obtendo tick size para ${symbol} (conta ${accountId})...`);
    
    // Usar a função getPrecision existente que já obtém as informações do exchangeInfo
    const precision = await getPrecision(symbol, accountId);
    
    if (precision && typeof precision.price === 'number') {
      // Calcular tick size baseado na precisão
      // Se price precision = 7, então tick size = 0.0000001 (10^-7)
      const tickSize = Math.pow(10, -precision.price);
      
      console.log(`[API] ✅ Tick size para ${symbol}: ${tickSize} (precisão: ${precision.price})`);
      return tickSize;
    } else if (precision && typeof precision.pricePrecision === 'number') {
      // Fallback para campo alternativo
      const tickSize = Math.pow(10, -precision.pricePrecision);
      
      console.log(`[API] ✅ Tick size para ${symbol}: ${tickSize} (pricePrecision: ${precision.pricePrecision})`);
      return tickSize;
    } else {
      console.warn(`[API] Não foi possível obter precisão válida para ${symbol}, usando fallback`);
      // Fallback padrão para USDT pairs
      return 0.00001; // Padrão para a maioria dos pares USDT
    }
  } catch (error) {
    console.error(`[API] Erro ao obter tick size para ${symbol} (conta ${accountId}):`, error.message);
    // Fallback em caso de erro
    return 0.00001;
  }
}


/**
 * Arredonda preço para o tick size do símbolo
 * @param {string} symbol - Símbolo
 * @param {number} price - Preço a ser arredondado
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Preço arredondado
 */
async function roundPriceToTickSize(symbol, price, accountId) {
  try {
    console.log(`[API] Arredondando preço ${price} para ${symbol}...`);
    
    const precision = await getPrecisionCached(symbol, accountId);
    
    // CORREÇÃO CRÍTICA: Usar tickSize real do exchangeInfo em vez de calcular
    let tickSize;
    if (precision.tickSize && precision.tickSize > 0) {
      tickSize = precision.tickSize;
    } else {
      // Fallback: calcular baseado na pricePrecision
      tickSize = Math.pow(10, -precision.pricePrecision);
    }
    
    if (!tickSize || tickSize <= 0) {
      console.warn(`[API] TickSize inválido para ${symbol}, usando preço original`);
      return parseFloat(price);
    }
    
    // CORREÇÃO MATEMÁTICA: Usar arredondamento mais preciso
    const multiplier = 1 / tickSize;
    const rounded = Math.round(price * multiplier) / multiplier;
    
    // VALIDAÇÃO FINAL: Garantir que o preço é múltiplo exato do tickSize
    const remainder = (rounded * 1e10) % (tickSize * 1e10);
    
    if (Math.abs(remainder) > 1e-10) {
      // Se ainda não é múltiplo exato, forçar arredondamento
      const corrected = Math.floor(price / tickSize) * tickSize;
      console.log(`[API] Preço corrigido para múltiplo exato: ${price} → ${corrected} (tick: ${tickSize})`);
      return parseFloat(corrected.toFixed(precision.pricePrecision));
    }
    
    const finalPrice = parseFloat(rounded.toFixed(precision.pricePrecision));
    console.log(`[API] Preço ${price} arredondado para ${finalPrice} (tick size: ${tickSize})`);
    return finalPrice;
    
  } catch (error) {
    console.error(`[API] Erro ao arredondar preço para ${symbol}:`, error.message);
    return parseFloat(price);
  }
}

/**
 * Cria ordem limit maker (VERSÃO CORRIGIDA DA STARBOY_DEV)
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado (BUY/SELL)
 * @param {number} price - Preço
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newLimitMakerOrder(accountId, symbol, quantity, side, price) {
  try {
    console.log(`[API] Criando ordem LIMIT MAKER: ${side} ${quantity} ${symbol} @ ${price} (conta ${accountId})`);
    
    // VALIDAÇÃO DE ACCOUNTID
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }
    
    // OBTER PRECISÃO E ARREDONDAR PREÇO
    const precision = await getPrecisionCached(symbol, accountId);
    const roundedPrice = await roundPriceToTickSize(symbol, price, accountId);
    
    // FORMATAR QUANTIDADE E PREÇO
    const formattedQuantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);
    const formattedPrice = roundedPrice.toFixed(precision.pricePrecision);
    
    console.log(`[API] Enviando Ordem LIMIT MAKER: ${symbol}, Qtd: ${formattedQuantity}, Lado: ${side}, Preço: ${formattedPrice}, TimeInForce: GTX`);
    
    // DADOS DA ORDEM (VERSÃO STARBOY_DEV ADAPTADA)
    const orderParams = {
      symbol: symbol,
      side: side,
      type: "LIMIT",
      quantity: formattedQuantity,
      price: formattedPrice,
      timeInForce: "GTX", // ESSENCIAL: Garante que a ordem seja Post-Only (Maker)
      newOrderRespType: "RESULT" // Para obter mais detalhes na resposta
    };
    
    // USAR makeAuthenticatedRequest EM VEZ DE CREDENCIAIS GLOBAIS
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    console.log(`[API] ✅ Resposta da Ordem LIMIT MAKER: ${JSON.stringify(response)}`);
    return response; // Retorna a resposta completa da API
    
  } catch (error) {
    console.error(`[API] ❌ ERRO DETALHADO ao criar Ordem LIMIT MAKER para ${symbol}:`);
    
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
      
      // Código -2010: "Order would immediately match and take." - Isso é esperado se a ordem GTX seria taker.
      if (error.response.data && error.response.data.code === -2010) {
        console.log(`[API] Ordem rejeitada por ser TAKER (código -2010) - isso é esperado com GTX`);
        return { ...error.response.data, status: 'REJECTED_POST_ONLY' }; // Identifica rejeição por ser taker
      }
    } else {
      console.error(`[API] Mensagem: ${error.message}`);
    }
    
    throw error; // Relança outros erros
  }
}

/**
 * Edita uma ordem existente, ou cancela e recria caso esteja parcialmente preenchida
 * VERSÃO ADAPTADA DA STARBOY_DEV PARA MULTICONTA
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par de negociação
 * @param {string|number} orderId - ID da ordem a ser editada
 * @param {number} newPrice - Novo preço da ordem
 * @param {string} side - Lado da ordem (BUY/SELL)
 * @param {number} [quantity=null] - Quantidade desejada (opcional, será obtida da ordem existente)
 * @param {boolean} [retryIfPartiallyFilled=true] - Se deve recriar automaticamente ordens parcialmente preenchidas
 * @returns {Promise<Object>} Resposta da API com detalhes da ordem editada ou recriada
 */
async function editOrder(accountId, symbol, orderId, newPrice, side, quantity = null, retryIfPartiallyFilled = true) {
  try {
    console.log(`[API] Editando ordem ${orderId} para ${symbol}: novo preço ${newPrice}, lado ${side} (conta ${accountId})`);
    
    // VALIDAÇÃO DE ACCOUNTID
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }
    
    // VALIDAÇÃO DE PARÂMETROS BÁSICOS
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(`Symbol deve ser uma string válida: ${symbol}`);
    }
    
    if (!orderId) {
      throw new Error(`OrderId é obrigatório: ${orderId}`);
    }
    
    if (!newPrice || typeof newPrice !== 'number' || newPrice <= 0) {
      throw new Error(`NewPrice deve ser um número positivo: ${newPrice}`);
    }
    
    if (!side || !['BUY', 'SELL'].includes(side)) {
      throw new Error(`Side deve ser BUY ou SELL: ${side}`);
    }
    
    // VERIFICAR SE orderId E symbol ESTÃO NA ORDEM CORRETA
    // (às vezes podem ser passados trocados)
    if (typeof orderId === 'string' && orderId.includes('USDT') && 
        (typeof symbol === 'number' || !isNaN(parseInt(symbol)))) {
      console.log(`[API] Detectada troca de parâmetros. Corrigindo symbol=${orderId}, orderId=${symbol}`);
      [symbol, orderId] = [orderId, symbol];
    }
    
    // OBTER DETALHES ATUAIS DA ORDEM PARA VERIFICAÇÃO
    let orderDetails;
    try {
      console.log(`[API] Obtendo detalhes da ordem ${orderId} para validação...`);
      orderDetails = await getOrderStatus(symbol, orderId, accountId);
      
      if (!orderDetails) {
        throw new Error(`Ordem ${orderId} não encontrada`);
      }
      
      console.log(`[API] Status atual da ordem ${orderId}: ${orderDetails.status}`);
      console.log(`[API] Quantidade original: ${orderDetails.origQty}, Executada: ${orderDetails.executedQty || '0'}`);
      
    } catch (error) {
      console.error(`[API] Erro ao obter status da ordem ${orderId}:`, error.message);
      throw new Error(`Não foi possível verificar ordem ${orderId}: ${error.message}`);
    }
    
    // VERIFICAR SE A ORDEM ESTÁ PARCIALMENTE PREENCHIDA
    if (orderDetails.status === 'PARTIALLY_FILLED') {
      console.log(`[API] ⚠️ Ordem ${orderId} está parcialmente preenchida`);
      
      // Se não quiser a lógica automática para ordens parciais, retornar erro
      if (!retryIfPartiallyFilled) {
        throw {
          isPartiallyFilled: true,
          message: `Não é possível editar ordem parcialmente preenchida (${orderId}). Cancele e recrie manualmente.`,
          orderDetails,
          code: 'ORDER_PARTIALLY_FILLED'
        };
      }
      
      console.log(`[API] Executando lógica de cancelar e recriar para ordem parcial ${orderId}...`);
      
      // CALCULAR QUANTIDADE RESTANTE (não preenchida)
      const origQty = parseFloat(orderDetails.origQty);
      const executedQty = parseFloat(orderDetails.executedQty || '0');
      const remainingQty = parseFloat((origQty - executedQty).toFixed(8));
      
      if (remainingQty <= 0) {
        console.log(`[API] ✅ Ordem ${orderId} já foi totalmente preenchida. Nada a fazer.`);
        return {
          ...orderDetails,
          message: 'Ordem já totalmente preenchida',
          wasFullyFilled: true
        };
      }
      
      console.log(`[API] Quantidade restante para nova ordem: ${remainingQty}`);
      
      // CANCELAR A ORDEM PARCIAL
      try {
        console.log(`[API] Cancelando ordem parcial ${orderId}...`);
        await cancelOrder(symbol, orderId, accountId);
        console.log(`[API] ✅ Ordem parcial ${orderId} cancelada com sucesso`);
        
      } catch (cancelError) {
        // Se o erro for "ordem não encontrada", pode ser que já foi executada
        if (cancelError.message && cancelError.message.includes('does not exist')) {
          console.log(`[API] Ordem ${orderId} já não existe (provavelmente executada), continuando...`);
        } else {
          console.error(`[API] ❌ Erro ao cancelar ordem parcial ${orderId}:`, cancelError.message);
          throw new Error(`Falha ao cancelar ordem parcial: ${cancelError.message}`);
        }
      }
      
      // CRIAR NOVA ORDEM COM A QUANTIDADE RESTANTE E O NOVO PREÇO
      try {
        console.log(`[API] Criando nova ordem LIMIT MAKER para quantidade restante: ${remainingQty} @ ${newPrice}`);
        
        const newOrderResponse = await newLimitMakerOrder(
          accountId, 
          symbol, 
          remainingQty, 
          side, 
          newPrice
        );
        
        if (!newOrderResponse || !newOrderResponse.orderId) {
          throw new Error(`Falha ao criar nova ordem após cancelamento: resposta inválida`);
        }
        
        console.log(`[API] ✅ Nova ordem criada com sucesso após cancelamento da parcial: ${newOrderResponse.orderId}`);
        
        // RETORNAR INFORMAÇÃO SOBRE A ORDEM ANTIGA E NOVA
        return {
          ...newOrderResponse,
          oldOrderId: orderId,
          wasPartiallyFilled: true,
          originalQuantity: origQty,
          executedQuantity: executedQty,
          newQuantity: remainingQty,
          originalPrice: parseFloat(orderDetails.price),
          newPrice: newPrice,
          message: `Ordem parcial cancelada e recriada com quantidade restante`
        };
        
      } catch (newOrderError) {
        console.error(`[API] ❌ Erro ao criar nova ordem após cancelamento:`, newOrderError.message);
        throw new Error(`Ordem parcial ${orderId} foi cancelada mas falha ao criar nova ordem: ${newOrderError.message}`);
      }
      
    } else if (orderDetails.status !== 'NEW') {
      // Se não for NEW nem PARTIALLY_FILLED, não pode ser editada
      const validStatuses = ['NEW', 'PARTIALLY_FILLED'];
      throw new Error(
        `Ordem ${orderId} tem status '${orderDetails.status}' e não pode ser editada. ` +
        `Status válidos: ${validStatuses.join(', ')}`
      );
    }
    
    // SE CHEGOU AQUI, A ORDEM ESTÁ NO ESTADO 'NEW' E PODE SER EDITADA NORMALMENTE
    console.log(`[API] Ordem ${orderId} está no status NEW, editando normalmente...`);
    
    // SE NÃO TEMOS A QUANTIDADE E PRECISAMOS DELA, OBTÊ-LA DA ORDEM
    let orderQuantity = quantity;
    if (orderQuantity === null || orderQuantity === undefined) {
      orderQuantity = parseFloat(orderDetails.origQty);
      console.log(`[API] Usando quantidade da ordem existente ${orderId}: ${orderQuantity}`);
    }
    
    // VERIFICAR SE A QUANTIDADE É VÁLIDA
    if (orderQuantity === null || orderQuantity === undefined || isNaN(orderQuantity) || orderQuantity <= 0) {
      throw new Error(`Quantidade inválida para edição de ordem: ${orderQuantity}`);
    }
    
    // ARREDONDAR NOVO PREÇO PARA TICK SIZE
    const roundedPrice = await roundPriceToTickSize(symbol, newPrice, accountId);
    console.log(`[API] Preço ${newPrice} arredondado para ${roundedPrice}`);
    
    // OBTER PRECISÃO PARA FORMATAÇÃO
    const precision = await getPrecisionCached(symbol, accountId);
    const formattedQuantity = formatQuantityCorrect(orderQuantity, precision.quantityPrecision, symbol);
    const formattedPrice = formatPrice(roundedPrice, precision.pricePrecision);
    
    console.log(`[API] Parâmetros formatados: quantity=${formattedQuantity}, price=${formattedPrice}`);
    
    // PREPARAR PARÂMETROS PARA EDIÇÃO
    const editParams = {
      symbol: symbol,
      orderId: String(orderId),
      side: side,
      quantity: formattedQuantity,
      price: formattedPrice,
      timeInForce: 'GTC' // Assumindo GTC como padrão
    };
    
    console.log(`[API] Editando ordem com parâmetros:`, editParams);
    
    // FAZER REQUISIÇÃO DE EDIÇÃO VIA REST API
    const response = await makeAuthenticatedRequest(accountId, 'PUT', '/v1/order', editParams);
    
    console.log(`[API] ✅ Ordem ${orderId} editada com sucesso para preço ${formattedPrice}`);
    
    return {
      ...response,
      wasEdited: true,
      oldPrice: parseFloat(orderDetails.price),
      newPrice: parseFloat(formattedPrice),
      message: 'Ordem editada com sucesso'
    };
    
  } catch (error) {
    // TRATAMENTO DE ERROS ESPECÍFICOS DA BINANCE
    if (error.response && error.response.data) {
      const apiError = error.response.data;
      
      // Erro -2011: Ordem não encontrada
      if (apiError.code === -2011) {
        console.error(`[API] Ordem ${orderId} não encontrada (já executada/cancelada)`);
        throw new Error(`Ordem ${orderId} não encontrada - pode ter sido executada ou cancelada`);
      }
      
      // Erro -1013: Filtro de quantidade/preço
      if (apiError.code === -1013) {
        console.error(`[API] Parâmetros inválidos para edição:`, apiError.msg);
        throw new Error(`Parâmetros inválidos: ${apiError.msg}`);
      }
      
      // Outros erros da API
      console.error(`[API] Erro da API ao editar ordem ${orderId}:`, apiError);
      throw new Error(`Erro da API: ${apiError.msg || apiError.message || 'Erro desconhecido'}`);
    }
    
    // ERROS GERAIS
    console.error(`[API] ❌ Erro ao editar ordem ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Cria ordem STOP/TAKE_PROFIT (VERSÃO CORRIGIDA DA STARBOY_DEV)
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado
 * @param {number} stopPrice - Preço de stop
 * @param {number} price - Preço (null para STOP_MARKET)
 * @param {boolean} reduceOnly - Se é reduce only
 * @param {boolean} closePosition - Se é close position
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newStopOrder(accountId, symbol, quantity, side, stopPrice, price = null, reduceOnly = false, closePosition = false) {
  try {
    console.log(`[API] Criando ordem STOP: ${side} ${quantity} ${symbol} @ stop=${stopPrice} (conta ${accountId})`);
    
    // VALIDAÇÃO DE ACCOUNTID
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }
    
    // DEFINIR TIPO DE ORDEM BASEADO NO PARÂMETRO PRICE
    let orderType;
    if (price !== null) {
      orderType = "TAKE_PROFIT_MARKET";
    } else {
      orderType = "STOP_MARKET";
    }
    
    // ARREDONDAR PREÇO DE STOP
    console.log(`[API] Preço original de stop antes de arredondar: ${stopPrice}`);
    const roundedStopPrice = await roundPriceToTickSize(symbol, stopPrice, accountId);
    console.log(`[API] Preço de stop após arredondar: ${roundedStopPrice}`);
    
    // OBTER PRECISÃO PARA FORMATAÇÃO
    const precision = await getPrecisionCached(symbol, accountId);
    const formattedQuantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);
    
    // PREPARAR DADOS BASE DA ORDEM
    const orderParams = {
      symbol: symbol,
      side: side,
      type: orderType,
      quantity: formattedQuantity,
      stopPrice: parseFloat(roundedStopPrice),
      newOrderRespType: "RESULT" // Mudado de ACK para RESULT para mais detalhes
    };
    
    // ADICIONAR closePosition OU reduceOnly, mas nunca ambos
    if (closePosition) {
      orderParams.closePosition = true;
      // Não adicionar reduceOnly quando closePosition é true
      console.log(`[API] Usando closePosition=true para ordem ${orderType}`);
    } else if (reduceOnly) {
      orderParams.reduceOnly = true;
      console.log(`[API] Usando reduceOnly=true para ordem ${orderType}`);
    }
    
    console.log(`[API] Enviando ordem ${orderType}: ${symbol}, ${formattedQuantity}, ${side}, ${roundedStopPrice}, closePosition: ${closePosition}, reduceOnly: ${reduceOnly}`);
    
    // USAR makeAuthenticatedRequest EM VEZ DE CREDENCIAIS GLOBAIS
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    console.log(`[API] ✅ Resposta da ordem ${orderType}:`, response);
    return { data: response }; // Garantir estrutura consistente { data: {...} }
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao enviar ordem ${price ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET'}:`,
        error.response ? error.response.data : error.message);
    throw error;
  }
}

/**
 * Cria ordem LIMIT reduce-only (VERSÃO CORRIGIDA DA STARBOY_DEV)
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado
 * @param {number} price - Preço
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newReduceOnlyOrder(accountId, symbol, quantity, side, price) {
  try {
    console.log(`[API] Criando ordem LIMIT reduce-only: ${side} ${quantity} ${symbol} @ ${price} (conta ${accountId})`);
    
    // VALIDAÇÃO DE ACCOUNTID
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }
    
    // ARREDONDAR PREÇO E OBTER PRECISÃO
    const roundedPrice = await roundPriceToTickSize(symbol, price, accountId);
    const precision = await getPrecisionCached(symbol, accountId);
    
    // GARANTIR QUE A QUANTIDADE ESTEJA NO FORMATO CORRETO
    const formattedQuantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);
    
    console.log(`[API] Enviando ordem LIMIT reduce-only: ${symbol}, ${side}, qty=${formattedQuantity}, price=${roundedPrice}`);
    
    // DADOS DA ORDEM
    const orderParams = {
      symbol: symbol,
      side: side,
      type: "LIMIT",
      quantity: formattedQuantity,
      price: parseFloat(roundedPrice),
      timeInForce: "GTC",
      reduceOnly: true,
      newOrderRespType: "RESULT" // Para obter mais detalhes
    };
    
    // USAR makeAuthenticatedRequest EM VEZ DE CREDENCIAIS GLOBAIS
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    console.log(`[API] ✅ Ordem LIMIT reduce-only criada com sucesso: orderId=${response.orderId}`);
    return { data: response }; // Manter estrutura consistente
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao criar ordem LIMIT reduce-only:`, error.message);
    
    if (error.response && error.response.data) {
      console.error(`[API] Resposta da API: ${JSON.stringify(error.response.data)}`);
      
      // Se o erro for relacionado à quantidade, tornar mais claro
      if (error.response.data.code === -1013) {
        console.error(`[API] Quantidade inválida (${quantity}) para ${symbol}. A quantidade é menor que o mínimo ou não tem a precisão correta.`);
      }
    }
    
    throw error;
  }
}

async function newMarketOrder(accountId, symbol, quantity, side) {
  try {
    console.log(`[API] Criando ordem MARKET: ${side} ${quantity} ${symbol} (conta ${accountId})`);
    const precision = await getPrecisionCached(symbol, accountId);
    const formattedQuantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);

    const orderParams = {
      symbol: symbol,
      side: side,
      type: 'MARKET',
      quantity: formattedQuantity
    };

    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    console.log(`[API] ✅ Ordem MARKET criada com sucesso: ${response.orderId}`);
    return response;
  } catch (error) {
    console.error(`[API] Erro ao criar ordem MARKET para ${symbol}:`, error.message);
    throw error;
  }
}

/**
 * Obtém status de uma ordem via REST API
 * @param {string} symbol - Símbolo (ex: POLUSDT)
 * @param {string|number} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da ordem
 */
async function getOrderStatus(symbol, orderId, accountId) {
  try {
    // VALIDAÇÃO CRÍTICA: Verificar tipos e ordem dos parâmetros
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(`Symbol deve ser uma string válida. Recebido: ${symbol} (tipo: ${typeof symbol})`);
    }
    
    if (!orderId || (typeof orderId !== 'string' && typeof orderId !== 'number')) {
      throw new Error(`OrderId deve ser string ou number. Recebido: ${orderId} (tipo: ${typeof orderId})`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número. Recebido: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    console.log(`[API] Obtendo status da ordem ${orderId} para ${symbol} (conta ${accountId})...`);
    
    const params = {
      symbol: symbol,
      orderId: String(orderId) // ✅ CORREÇÃO: Garantir que o ID da ordem seja sempre uma string.
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/order', params);
    console.log(`[API] ✅ Status da ordem ${orderId}: ${response.status}`);
    return response;
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao obter status da ordem ${orderId} para ${symbol}: ${error.message}`);
    throw error;
  }
}


/**
 * Cancela uma ordem via REST API
 * @param {string} symbol - Símbolo
 * @param {string} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado do cancelamento
 */
async function cancelOrder(symbol, orderId, accountId) {
  try {
    console.log(`[API] Cancelando ordem ${orderId} para ${symbol} (conta ${accountId})...`);
    
    const params = {
      symbol: symbol,
      orderId: String(orderId) // ✅ CORREÇÃO: Garantir que o ID da ordem seja sempre uma string.
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'DELETE', '/v1/order', params);
    console.log(`[API] ✅ Ordem ${orderId} cancelada com sucesso`);
    return response;
    
  } catch (error) {
    console.error(`[API] Erro ao cancelar ordem ${orderId}:`, error.message);
    throw error;
  }
}

module.exports = {
  setAccountState,
  getAccountState,
  debugAccountStates,
  getAccountStatesMap,
  setAccountState,
  getAccountState,
  getAccountConnectionState,
  getAllAccountConnections,
  loadCredentialsFromDatabase,
  makeAuthenticatedRequest,
  getPrice,
  getAllOpenPositions,
  getListenKey,
  getPrecision,
  getPrecisionCached,
  getCurrentLeverage,
  changeInitialLeverage,
  getCurrentMarginType,
  changeMarginType,
  verifyAndFixEnvironmentConsistency,
  getFuturesAccountBalanceDetails,
  getRecentOrders,
  getTickSize,
  roundPriceToTickSize,
  newLimitMakerOrder,
  newReduceOnlyOrder,
  newMarketOrder,
  newStopOrder,
  editOrder,
  getOrderStatus,
  cancelOrder,
  validateQuantity,
  adjustQuantityToRequirements,
};