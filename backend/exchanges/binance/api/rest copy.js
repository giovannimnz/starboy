const axios = require('axios');
const { getDatabaseInstance } = require('../../../core/database/conexao');
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
 * Faz uma requisição autenticada para a API da Binance
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


// ✅ MODULE.EXPORTS COMPLETO
module.exports = {
  // Gerenciamento de Estados
  setAccountState,
  getAccountState,
  getAccountStatesMap,
  debugAccountStates,
  getAccountConnectionState,
  getAllAccountConnections,
  
  // Autenticação e Credenciais
  loadCredentialsFromDatabase,
  makeAuthenticatedRequest,
  verifyAndFixEnvironmentConsistency,
  
  // Informações de Mercado
  getPrice,
  getPrecision,
  getPrecisionCached,
  getTickSize,
  roundPriceToTickSize,
  
  // Formatação
  formatQuantityCorrect,
  formatPrice,
  
  // Validação
  validateQuantity,
  adjustQuantityToRequirements,
  
  // Posições e Saldos
  getAllOpenPositions,
  getFuturesAccountBalanceDetails,
  
  // Configurações de Conta
  getCurrentLeverage,
  changeInitialLeverage,
  getCurrentMarginType,
  changeMarginType,
  
  // Ordens
  newLimitMakerOrder,
  newMarketOrder,
  newReduceOnlyOrder,
  newStopOrder,
  editOrder,
  getOpenOrders,
  getOrderStatus,
  cancelOrder,
  getRecentOrders,
  
  // WebSocket
  getListenKey
};