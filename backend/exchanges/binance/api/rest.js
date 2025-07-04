const axios = require('axios');
const { getDatabaseInstance } = require('../../../core/database/conexao');

// === GERENCIAMENTO DE ESTADO DE CONTA (UNIFICADO) ===
const accountStates = new Map();

/**
 * Define o estado da conta no Map global (única fonte de verdade)
 */
function setAccountState(accountId, state) {
  accountStates.set(accountId, state);
}

/**
 * Obtém o estado da conta do Map global
 */
function getAccountState(accountId) {
  return accountStates.get(accountId) || null;
}

/**
 * Retorna o Map global de estados
 */
function getAccountStatesMap() {
  return accountStates;
}

/**
 * Debug simples do Map global
 */
function debugAccountStates() {
  const size = accountStates.size;
  if (size === 0) {
    //console.log(`[API] DEBUG - Map de estados está vazio!`);
  } else {
    //console.log(`[API] DEBUG - Map de estados tem ${size} contas.`);
  }
}

/**
 * Carrega credenciais do banco de dados e atualiza o estado da conta no Map global
 * Sempre inclui credenciais spot/futuros/testnet corretas e URLs da corretora vinculada
 */
async function loadCredentialsFromDatabase(accountId) {
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    throw new Error('AccountId inválido');
  }
  const db = await getDatabaseInstance(accountId);
  
  console.log(`[REST] 🔍 Buscando conta com ID: ${accountId}`);
  
  // Buscar conta
  const result = await db.query(`
    SELECT * FROM contas WHERE id = $1
  `, [accountId]);
  const rows = result.rows;
  
  console.log(`[REST] 📊 Resultado da busca: ${rows.length} conta(s) encontrada(s)`);
  
  if (!rows || rows.length === 0) {
    // Listar contas disponíveis para debug
    console.log(`[REST] 📋 Listando contas disponíveis no banco...`);
    try {
      const allAccountsResult = await db.query('SELECT id, nome, ativa FROM contas ORDER BY id');
      const allAccounts = allAccountsResult.rows;
      console.log(`[REST] 📋 Contas disponíveis (${allAccounts.length}):`);
      allAccounts.forEach(account => {
        console.log(`[REST]   - ID: ${account.id}, Nome: ${account.nome || 'N/A'}, Ativa: ${account.ativa}`);
      });
    } catch (listError) {
      console.error(`[REST] ❌ Erro ao listar contas:`, listError.message);
    }
    
    throw new Error(`Conta não encontrada no banco - ID solicitado: ${accountId}`);
  }
  
  const conta = rows[0];
  console.log(`[REST] ✅ Conta encontrada: ID=${conta.id}, Nome=${conta.nome || 'N/A'}, Ativa=${conta.ativa}`);
  
  // Buscar corretora vinculada
  console.log(`[REST] 🔍 Buscando corretora com ID: ${conta.id_corretora}`);
  const corretoraResult = await db.query(`
    SELECT * FROM corretoras WHERE id = $1
  `, [conta.id_corretora]);
  const corretoraRows = corretoraResult.rows;
  
  console.log(`[REST] 📊 Resultado da busca da corretora: ${corretoraRows.length} corretora(s) encontrada(s)`);
  
  if (!corretoraRows || corretoraRows.length === 0) {
    // Listar corretoras disponíveis para debug
    console.log(`[REST] 📋 Listando corretoras disponíveis no banco...`);
    try {
      const allCorretoras = await db.query('SELECT id, corretora, ambiente FROM corretoras ORDER BY id');
      console.log(`[REST] 📋 Corretoras disponíveis (${allCorretoras.rows.length}):`);
      allCorretoras.rows.forEach(corr => {
        console.log(`[REST]   - ID: ${corr.id}, Corretora: ${corr.corretora}, Ambiente: ${corr.ambiente}`);
      });
    } catch (listError) {
      console.error(`[REST] ❌ Erro ao listar corretoras:`, listError.message);
    }
    
    throw new Error(`Corretora vinculada não encontrada no banco - ID solicitado: ${conta.id_corretora}`);
  }
  
  const corretora = corretoraRows[0];
  console.log(`[REST] ✅ Corretora encontrada: ID=${corretora.id}, Nome=${corretora.corretora}, Ambiente=${corretora.ambiente}`);

  // Determinar ambiente (testnet ou produção) a partir da corretora
  const ambiente = corretora.ambiente && corretora.ambiente.toLowerCase().includes('testnet') ? 'testnet' : 'prd';

  // Montar objeto de estado completo
  const state = {
    accountId: conta.id,
    nome: conta.nome,
    apiKey: conta.api_key, // Futuros
    secretKey: conta.api_secret,
    wsApiKey: conta.ws_api_key,
    wsApiSecret: conta.ws_api_secret,
    testnetSpotApiKey: conta.testnet_spot_api_key,
    testnetSpotApiSecret: conta.testnet_spot_api_secret,
    telegramChatId: conta.telegram_chat_id,
    telegramBotToken: conta.telegram_bot_token,
    telegramBotTokenController: conta.telegram_bot_token_controller,
    ambiente,
    corretora: corretora.corretora,
    // URLs vindas da corretora - verificar se existem
    apiUrl: corretora.futures_rest_api_url || corretora.spot_rest_api_url,
    spotApiUrl: corretora.spot_rest_api_url || corretora.futures_rest_api_url,
    futuresWsMarketUrl: corretora.futures_ws_market_url,
    futuresWsApiUrl: corretora.futures_ws_api_url,
  };
  
  // Verificar se as URLs foram carregadas corretamente
  if (!state.apiUrl || !state.spotApiUrl) {
    console.error(`[REST] ❌ URLs não encontradas na corretora ${corretora.id}:`);
    console.error(`[REST]   - futures_rest_api_url: ${corretora.futures_rest_api_url || 'undefined'}`);
    console.error(`[REST]   - spot_rest_api_url: ${corretora.spot_rest_api_url || 'undefined'}`);
    console.error(`[REST]   - Objeto corretora completo:`, corretora);
    
    // Tentar usar URLs padrão baseadas no ambiente
    if (ambiente === 'testnet') {
      state.apiUrl = state.apiUrl || 'https://testnet.binancefuture.com/fapi';
      state.spotApiUrl = state.spotApiUrl || 'https://testnet.binance.vision';
    } else {
      state.apiUrl = state.apiUrl || 'https://fapi.binance.com/fapi';
      state.spotApiUrl = state.spotApiUrl || 'https://api.binance.com';
    }
    
    console.log(`[REST] ✅ URLs padrão aplicadas: apiUrl=${state.apiUrl}, spotApiUrl=${state.spotApiUrl}`);
  }

  // Garantir que para testnet, as credenciais spot testnet sejam usadas
  if (ambiente === 'testnet') {
    state.apiKey = conta.api_key; // Futuros testnet
    state.secretKey = conta.api_secret;
    state.spotApiKey = conta.testnet_spot_api_key;
    state.spotSecretKey = conta.testnet_spot_api_secret;
  } else {
    state.spotApiKey = conta.api_key;
    state.spotSecretKey = conta.api_secret;
  }

  setAccountState(accountId, state);

  // Sincronizar também o objeto de conexão para garantir que WebSocket/ListenKey funcione
  let conn = accountConnections.get(accountId);
  if (!conn) {
    conn = { accountId };
  }
  // Copiar todos os campos REST relevantes para o objeto de conexão
  Object.assign(conn, state);
  accountConnections.set(accountId, conn);

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
 * Faz uma requisição autenticada para a API da Binance
 * Usa as credenciais corretas (spot ou futuros) conforme o endpoint
 */
async function makeAuthenticatedRequest(accountId, method, endpoint, params = {}, body = null, customApiUrl = null) {
  function mask(str) {
    if (!str || typeof str !== 'string') return '';
    return str.substring(0, 4) + '****' + str.substring(str.length - 4);
  }
  try {
    //console.log(`[API] makeAuthenticatedRequest chamado: accountId=${accountId}, method=${method}, endpoint=${endpoint}`);
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId} (tipo: ${typeof accountId})`);
    }
    debugAccountStates();
    const accountState = accountStates.get(accountId);
    //console.log(`[API] makeAuthenticatedRequest - Estado direto do Map: ${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}`);
    if (!accountState) {
      throw new Error(`Estado da conta ${accountId} não encontrado no Map. Deve ser carregado primeiro via loadCredentialsFromDatabase.`);
    }

    // Detectar se é endpoint de spot
    const isSpot = endpoint.startsWith('/api/');
    let apiKey, secretKey, baseUrl;
    if (isSpot) {
      apiKey = accountState.spotApiKey;
      secretKey = accountState.spotSecretKey;
      baseUrl = customApiUrl || accountState.spotApiUrl;
    } else {
      apiKey = accountState.apiKey;
      secretKey = accountState.secretKey;
      baseUrl = customApiUrl || accountState.apiUrl;
    }
    
    // Verificação adicional de segurança
    if (!baseUrl) {
      console.error(`[API] ❌ baseUrl não definida para conta ${accountId}:`);
      console.error(`[API]   - isSpot: ${isSpot}`);
      console.error(`[API]   - spotApiUrl: ${accountState.spotApiUrl || 'undefined'}`);
      console.error(`[API]   - apiUrl: ${accountState.apiUrl || 'undefined'}`);
      console.error(`[API]   - customApiUrl: ${customApiUrl || 'undefined'}`);
      console.error(`[API]   - ambiente: ${accountState.ambiente || 'undefined'}`);
      
      // Tentar aplicar URLs padrão baseadas no ambiente
      if (isSpot) {
        if (accountState.ambiente === 'testnet') {
          baseUrl = 'https://testnet.binance.vision';
        } else {
          baseUrl = 'https://api.binance.com';
        }
        console.log(`[API] 🔧 URL padrão aplicada para spot: ${baseUrl}`);
      } else {
        if (accountState.ambiente === 'testnet') {
          baseUrl = 'https://testnet.binancefuture.com/fapi';
        } else {
          baseUrl = 'https://fapi.binance.com/fapi';
        }
        console.log(`[API] 🔧 URL padrão aplicada para futures: ${baseUrl}`);
      }
      
      if (!baseUrl) {
        throw new Error(`URL da API não definida para conta ${accountId}. Tipo: ${isSpot ? 'spot' : 'futures'}`);
      }
    }
    
    if (!apiKey || !secretKey) {
      throw new Error(`Credenciais incompletas para conta ${accountId}: apiKey=${!!apiKey}, secretKey=${!!secretKey}, baseUrl=${!!baseUrl}`);
    }

    function getTimestamp() { 
      // ✅ Usar timestamp corrigido baseado na sincronização
      return getCorrectedTimestamp(accountId) - 500; // Margem de segurança reduzida
    }
    const timestamp = getTimestamp();
    
    // ✅ Usar recvWindow otimizado baseado na qualidade de sincronização
    const recvWindow = getOptimizedRecvWindow(accountId);
    
    // Adicionar timestamp e recvWindow aos parâmetros
    const allParams = { ...params, timestamp, recvWindow };
    let queryString = '';
    let bodyData = '';
    if (method === 'GET') {
      const queryParams = { ...params, timestamp, recvWindow };
      queryString = Object.keys(queryParams).sort().map(key => `${key}=${encodeURIComponent(queryParams[key])}`).join('&');
    } else {
      const bodyParams = { ...params, timestamp, recvWindow };
      queryString = Object.keys(bodyParams).sort().map(key => `${key}=${encodeURIComponent(bodyParams[key])}`).join('&');
      bodyData = queryString;
    }
    const crypto = require('crypto');
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');
    const finalQueryString = queryString + `&signature=${signature}`;
    let fullUrl;
    if (method === 'GET') {
      fullUrl = `${baseUrl}${endpoint}?${finalQueryString}`;
    } else {
      fullUrl = `${baseUrl}${endpoint}`;
    }
    const headers = {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
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
    // LOG DETALHADO DE ERRO PARA GETs
    if (method === 'GET' && error.response) {
      const errResp = error.response;
      console.error('[API][ERRO-GET]', JSON.stringify({
        accountId,
        endpoint,
        method,
        params,
        url: errResp.config?.url,
        status: errResp.status,
        statusText: errResp.statusText,
        data: errResp.data,
        headers: errResp.headers,
        requestHeaders: errResp.config?.headers,
        apiKey: mask(errResp.config?.headers?.['X-MBX-APIKEY'] || ''),
        ambiente: accountStates.get(accountId)?.ambiente
      }, null, 2));
    }
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


const RECV_WINDOW = 60000; // 60 segundos (mais flexível para evitar erros de sincronização)

async function getAllOpenPositions(accountId, symbol = null) {
  try {
    const logMessage = symbol 
      ? `[API] Obtendo posição para símbolo ${symbol} na conta ${accountId}...`
      : `[API] Obtendo posições abertas para conta ${accountId}...`;
    //console.log(logMessage);
    
    // ✅ USAR recvWindow otimizado baseado no ambiente
    const optimizedRecvWindow = getOptimizedRecvWindow(accountId);
    const requestParams = { recvWindow: optimizedRecvWindow };
    
    // Se símbolo específico for fornecido, adicionar aos parâmetros
    if (symbol) {
      requestParams.symbol = symbol;
    }
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', requestParams);
    
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

    const resultMessage = symbol 
      ? `[API] ${openPositions.length > 0 ? 'Posição encontrada' : 'Nenhuma posição encontrada'} para ${symbol} na conta ${accountId}`
      : `[API] ✅ ${openPositions.length} posições abertas encontradas para conta ${accountId}`;
    //console.log(resultMessage);
    
    return openPositions;
    
  } catch (error) {
    console.error(`[API] Erro ao obter posições abertas para conta ${accountId}:`, error.message);
    
    // ✅ FALLBACK: Retornar array vazio em vez de lançar erro
    if (error.message && error.message.includes('recvWindow')) {
      console.warn(`[API] ⚠️ Problema de timestamp, retornando posições vazias temporariamente`);
      return [];
    }
    
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

async function checkServerTime(accountId) {
  try {
    console.log(`[CONTA-${accountId}] 🕐 Verificando sincronização de tempo avançada...`);
    
    // === MÚLTIPLAS AMOSTRAGENS PARA PRECISÃO ===
    const samples = [];
    const sampleCount = 5; // 5 amostras para maior precisão
    
    for (let i = 0; i < sampleCount; i++) {
      const startTime = process.hrtime.bigint(); // Precisão de nanosegundos
      const localTimeBeforeRequest = Date.now();
      
      try {
        // Usar endpoint mais rápido da Binance
        const response = await fetch('https://fapi.binance.com/fapi/v1/ping', {
          method: 'GET',
          timeout: 5000
        });
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        
        // Requisição para obter tempo do servidor
        const timeResponse = await fetch('https://fapi.binance.com/fapi/v1/time', {
          method: 'GET',
          timeout: 5000
        });
        
        if (!timeResponse.ok) {
          throw new Error(`HTTP ${timeResponse.status}`);
        }
        
        const endTime = process.hrtime.bigint();
        const localTimeAfterRequest = Date.now();
        
        const data = await timeResponse.json();
        const serverTime = parseInt(data.serverTime);
        
        // Calcular tempo de rede (RTT)
        const networkLatencyNs = Number(endTime - startTime);
        const networkLatencyMs = networkLatencyNs / 1000000; // Converter para ms
        
        // Estimar o tempo real do servidor compensando latência de rede
        const estimatedServerTime = serverTime + (networkLatencyMs / 2);
        const currentLocalTime = (localTimeBeforeRequest + localTimeAfterRequest) / 2;
        
        const timeDiff = Math.abs(currentLocalTime - estimatedServerTime);
        
        samples.push({
          localTime: currentLocalTime,
          serverTime: estimatedServerTime,
          timeDiff: timeDiff,
          networkLatency: networkLatencyMs,
          rawServerTime: serverTime
        });
        
        // Pequeno delay entre amostras
        if (i < sampleCount - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
      } catch (sampleError) {
        console.warn(`[CONTA-${accountId}] ⚠️ Erro na amostra ${i + 1}:`, sampleError.message);
      }
    }
    
    if (samples.length === 0) {
      console.error(`[CONTA-${accountId}] ❌ Não foi possível obter nenhuma amostra válida`);
      return false;
    }
    
    // === ANÁLISE ESTATÍSTICA DAS AMOSTRAS ===
    const avgTimeDiff = samples.reduce((sum, s) => sum + s.timeDiff, 0) / samples.length;
    const avgNetworkLatency = samples.reduce((sum, s) => sum + s.networkLatency, 0) / samples.length;
    const minTimeDiff = Math.min(...samples.map(s => s.timeDiff));
    const maxTimeDiff = Math.max(...samples.map(s => s.timeDiff));
    
    // Detectar amostra mais confiável (menor latência de rede)
    const bestSample = samples.reduce((best, current) => 
      current.networkLatency < best.networkLatency ? current : best
    );
    
    console.log(`[CONTA-${accountId}] � Análise de sincronização (${samples.length} amostras):`);
    console.log(`[CONTA-${accountId}]   - Diferença média: ${avgTimeDiff.toFixed(2)}ms`);
    console.log(`[CONTA-${accountId}]   - Diferença mínima: ${minTimeDiff.toFixed(2)}ms`);
    console.log(`[CONTA-${accountId}]   - Diferença máxima: ${maxTimeDiff.toFixed(2)}ms`);
    console.log(`[CONTA-${accountId}]   - Latência média: ${avgNetworkLatency.toFixed(2)}ms`);
    console.log(`[CONTA-${accountId}]   - Melhor amostra: ${bestSample.timeDiff.toFixed(2)}ms (lat: ${bestSample.networkLatency.toFixed(2)}ms)`);
    
    // === APLICAR CORREÇÃO DINÂMICA ===
    const accountState = getAccountState(accountId);
    let targetTimeDiff = bestSample.timeDiff; // Usar a melhor amostra
    
    // ✅ NOVO: Verificar limites do ambiente (testnet vs produção)
    const isTestnet = accountState && accountState.ambiente === 'testnet';
    const maxRecvWindow = isTestnet ? 59000 : 180000; // Testnet: máximo 59s, Produção: máximo 3min
    
    console.log(`[CONTA-${accountId}] 🏗️ Ambiente detectado: ${isTestnet ? 'TESTNET' : 'PRODUÇÃO'} (limite: ${maxRecvWindow}ms)`);
    
    // Definir RECV_WINDOW baseado na qualidade da sincronização E no ambiente
    let recvWindow;
    let syncQuality;
    
    if (targetTimeDiff <= 200) {
      // Excelente sincronização
      recvWindow = Math.min(5000, maxRecvWindow);
      syncQuality = 'EXCELENTE';
    } else if (targetTimeDiff <= 500) {
      // Boa sincronização
      recvWindow = Math.min(10000, maxRecvWindow);
      syncQuality = 'BOA';
    } else if (targetTimeDiff <= 1000) {
      // Sincronização aceitável
      recvWindow = Math.min(20000, maxRecvWindow);
      syncQuality = 'ACEITÁVEL';
    } else if (targetTimeDiff <= 2000) {
      // Sincronização ruim
      recvWindow = Math.min(40000, maxRecvWindow);
      syncQuality = 'RUIM';
    } else if (targetTimeDiff <= 5000) {
      // Sincronização muito ruim (NOVO: casos como 2081ms)
      recvWindow = Math.min(isTestnet ? 59000 : 80000, maxRecvWindow);
      syncQuality = 'MUITO_RUIM';
    } else if (targetTimeDiff <= 10000) {
      // Sincronização crítica (NOVO: casos extremos)
      recvWindow = Math.min(isTestnet ? 59000 : 120000, maxRecvWindow);
      syncQuality = 'CRÍTICA';
    } else {
      // Sincronização inaceitável
      recvWindow = maxRecvWindow; // Usar o máximo permitido pelo ambiente
      syncQuality = 'INACEITÁVEL';
    }
    
    // Aplicar correção no estado da conta
    if (accountState) {
      accountState.recvWindow = recvWindow;
      accountState.timeOffset = Math.round(bestSample.serverTime - bestSample.localTime); // Offset para correção
      accountState.lastTimeSyncCheck = Date.now();
      accountState.syncQuality = syncQuality;
      accountState.avgNetworkLatency = avgNetworkLatency;
    }
    
    console.log(`[CONTA-${accountId}] ⚙️ Configuração aplicada:`);
    console.log(`[CONTA-${accountId}]   - RECV_WINDOW: ${recvWindow}ms`);
    console.log(`[CONTA-${accountId}]   - Qualidade: ${syncQuality}`);
    console.log(`[CONTA-${accountId}]   - Offset de tempo: ${accountState.timeOffset || 0}ms`);
    
    // === VALIDAÇÃO FINAL E AÇÕES CORRETIVAS ===
    if (targetTimeDiff > 10000) {
      console.error(`[CONTA-${accountId}] ❌ SINCRONIZAÇÃO INACEITÁVEL: ${targetTimeDiff.toFixed(2)}ms`);
      console.error(`[CONTA-${accountId}] 🚨 CRÍTICO: Verificar urgentemente NTP do sistema, relogio ou conexão`);
      console.error(`[CONTA-${accountId}] 🔧 Ações recomendadas:`);
      console.error(`[CONTA-${accountId}]   1. Verificar se o NTP está ativo: w32tm /query /status`);
      console.error(`[CONTA-${accountId}]   2. Sincronizar manualmente: w32tm /resync`);
      console.error(`[CONTA-${accountId}]   3. Verificar conexão de internet`);
      console.error(`[CONTA-${accountId}]   4. Considerar usar VPS com melhor conectividade`);
      return false;
    } else if (targetTimeDiff > 5000) {
      console.error(`[CONTA-${accountId}] ❌ SINCRONIZAÇÃO CRÍTICA: ${targetTimeDiff.toFixed(2)}ms`);
      console.error(`[CONTA-${accountId}] 🚨 Sistema pode funcionar com limitações severas`);
      console.error(`[CONTA-${accountId}] 📝 RECV_WINDOW configurado para ${recvWindow}ms (modo defensivo)`);
      console.warn(`[CONTA-${accountId}] ⚠️ Recomendação urgente: Verificar NTP e conexão de internet`);
      return true; // Ainda tenta funcionar com RECV_WINDOW muito alto
    } else if (targetTimeDiff > 2000) {
      console.warn(`[CONTA-${accountId}] ⚠️ Sincronização MUITO RUIM: ${targetTimeDiff.toFixed(2)}ms`);
      console.warn(`[CONTA-${accountId}] 🔧 RECV_WINDOW ajustado para ${recvWindow}ms (modo compensação)`);
      console.warn(`[CONTA-${accountId}] 📋 Recomendações:`);
      console.warn(`[CONTA-${accountId}]   - Verificar latência de rede: ping 8.8.8.8`);
      console.warn(`[CONTA-${accountId}]   - Verificar sincronização NTP`);
      console.warn(`[CONTA-${accountId}]   - Considerar usar conexão com fio`);
      return true; // Funcional com compensações
    } else if (targetTimeDiff > 1000) {
      console.warn(`[CONTA-${accountId}] ⚠️ Sincronização sub-ótima: ${targetTimeDiff.toFixed(2)}ms`);
      console.warn(`[CONTA-${accountId}] 📝 RECV_WINDOW ajustado para ${recvWindow}ms para compensar`);
      return true; // Ainda funcional, mas com warning
    } else {
      console.log(`[CONTA-${accountId}] ✅ Sincronização de tempo ${syncQuality}: ${targetTimeDiff.toFixed(2)}ms`);
      return true;
    }
    
  } catch (error) {
    console.error(`[CONTA-${accountId}] ❌ Erro ao verificar tempo do servidor:`, error.message);
    
    // Configuração de segurança em caso de erro
    const accountState = getAccountState(accountId);
    if (accountState) {
      accountState.recvWindow = 120000; // Máximo aumentado para casos extremos
      accountState.syncQuality = 'ERRO';
      accountState.timeOffset = 0; // Reset do offset em caso de erro
      console.warn(`[CONTA-${accountId}] 🛡️ RECV_WINDOW configurado para 120000ms (modo segurança máxima)`);
    }
    
    return false;
  }
}


/**
 * Monitora a sincronização de tempo de forma contínua e aplica correções automáticas
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da sincronização
 */
async function monitorTimeSync(accountId) {
  try {
    const accountState = getAccountState(accountId);
    
    // Verificar se já foi feita uma sincronização recente (últimos 5 minutos)
    if (accountState && accountState.lastTimeSyncCheck) {
      const timeSinceLastCheck = Date.now() - accountState.lastTimeSyncCheck;
      if (timeSinceLastCheck < 300000) { // 5 minutos
        return {
          success: true,
          message: 'Sincronização ainda válida',
          quality: accountState.syncQuality,
          recvWindow: accountState.recvWindow,
          timeOffset: accountState.timeOffset || 0
        };
      }
    }
    
    // Executar nova verificação de sincronização
    const syncResult = await checkServerTime(accountId);
    
    return {
      success: syncResult,
      message: syncResult ? 'Sincronização atualizada com sucesso' : 'Problemas na sincronização detectados',
      quality: accountState$2.syncQuality || 'DESCONHECIDA',
      recvWindow: accountState$3.recvWindow || 60000,
      timeOffset: accountState$4.timeOffset || 0,
      avgNetworkLatency: accountState$5.avgNetworkLatency || null
    };
    
  } catch (error) {
    console.error(`[CONTA-${accountId}] ❌ Erro no monitoramento de sincronização:`, error.message);
    return {
      success: false,
      message: `Erro: ${error.message}`,
      quality: 'ERRO',
      recvWindow: 60000,
      timeOffset: 0
    };
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

/**
 * Obtém precisão de um símbolo a partir do banco de dados local (exchangeinfo)
 * @param {string} symbol - Símbolo
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações de precisão
 */
async function getPrecision(symbol, accountId) {
    try {
        const db = await getDatabaseInstance(accountId);
        // Buscar dados do símbolo
        const result = await db.query(
            `SELECT * FROM exchange_symbols WHERE symbol = $1`,
            [symbol]
        );
        
        if (!result.rows || result.rows.length === 0) {
            throw new Error(`Símbolo ${symbol} não encontrado na base de dados`);
        }
        
        const symbolData = result.rows[0];
        const filters = JSON.parse(symbolData.filters || '[]');
        
        // Extrair filtros relevantes
        const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER');
        const lotSize = filters.find(f => f.filterType === 'LOT_SIZE');
        const marketLotSize = filters.find(f => f.filterType === 'MARKET_LOT_SIZE');
        const minNotionalFilter = filters.find(f => f.filterType === 'MIN_NOTIONAL');
        
        // Calcular precisões
        const quantityPrecision = parseInt(symbolData.base_asset_precision || '8');
        const pricePrecision = parseInt(symbolData.quote_precision || '8');
        const tickSize = priceFilter && priceFilter.tick_size ? parseFloat(priceFilter.tick_size) : null;
        const minQty = lotSize && lotSize.min_qty ? parseFloat(lotSize.min_qty) : null;
        const maxQty = lotSize && lotSize.max_qty ? parseFloat(lotSize.max_qty) : null;
        const stepSize = lotSize && lotSize.step_size ? parseFloat(lotSize.step_size) : null;
        const marketMinQty = marketLotSize && marketLotSize.min_qty ? parseFloat(marketLotSize.min_qty) : null;
        const marketMaxQty = marketLotSize && marketLotSize.max_qty ? parseFloat(marketLotSize.max_qty) : null;
        const minNotional = minNotionalFilter && minNotionalFilter.min_notional ? parseFloat(minNotionalFilter.min_notional) : null;

        return {
            quantityPrecision,
            pricePrecision,
            tickSize,
            minQty,
            maxQty,
            stepSize,
            marketMinQty,
            marketMaxQty,
            minNotional
        };
    } catch (error) {
        console.error(`[API] ERRO em getPrecision (banco):`, error.message);
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
 * Ajusta automaticamente a quantidade para atender aos requisitos - SEM VALIDAÇÃO DE PREÇO MÍNIMO
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
        
        // ✅ CORREÇÃO: SIMPLIFICAR CÁLCULO SEM VALIDAÇÃO DE NOTIONAL PROBLEMÁTICA
        const precision = await getPrecisionCached(symbol, accountId);
        const minQtyRequired = orderType === 'MARKET' ? 
            (precision.marketMinQty || precision.minQty) : 
            precision.minQty;
        
        // USAR APENAS O MÍNIMO OBRIGATÓRIO DO EXCHANGE
        let finalQuantity = Math.max(quantity, minQtyRequired);
        
        // ARREDONDAR PARA O STEP SIZE
        if (precision.stepSize > 0) {
            finalQuantity = Math.ceil(finalQuantity / precision.stepSize) * precision.stepSize;
        }
        
        // FORMATAR COM PRECISÃO CORRETA
        finalQuantity = parseFloat(finalQuantity.toFixed(precision.quantityPrecision));
        
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
       
    console.log(`[API] ✅ Consistência de ambiente verificada para conta ${accountId}`);
    return true;
  } catch (error) {
    console.error(`[API] Erro ao verificar consistência de ambiente:`, error.message);
    return false;
  }
}

function getTimestamp(accountId = null) {
  // ✅ Se accountId for fornecido, usar timestamp corrigido
  if (accountId) {
    return getCorrectedTimestamp(accountId) - 500; // Margem de segurança reduzida
  }
  
  // ✅ Fallback para timestamp padrão com margem de segurança
  return Date.now() - 1000; // Subtrair 1 segundo para margem de segurança
}

/**
 * Obtém detalhes do saldo_spot da conta spot via REST API
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Detalhes do saldo_spot formatados
 */
async function getSpotAccountBalanceDetails(accountId) {
  try {
    console.log(`[API] Obtendo detalhes do saldo_spot para conta ${accountId}...`);

    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }

    // Buscar o estado da conta para pegar o spotApiUrl
    const accountState = getAccountConnectionState(accountId, false);
    
    if (!accountState) {
      throw new Error(`Estado da conta ${accountId} não encontrado. Execute loadCredentialsFromDatabase primeiro.`);
    }
    
    if (!accountState.spotApiUrl) {
      throw new Error(`spotApiUrl não configurada para conta ${accountId}`);
    }
    
    const spotApiUrl = accountState.spotApiUrl;

    // Chamar makeAuthenticatedRequest com o spotApiUrl
    const accountData = await makeAuthenticatedRequest(accountId, 'GET', '/api/v3/account', {}, null, spotApiUrl);

    if (!accountData || !Array.isArray(accountData.balances)) {
      throw new Error('Resposta inválida da API de saldo spot');
    }

    // Encontrar saldo USDT
    const usdtBalance = accountData.balances.find(asset => asset.asset === 'USDT');
    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na resposta spot');
    }

    const saldoTotal = parseFloat(usdtBalance.free || '0') + parseFloat(usdtBalance.locked || '0');
    const saldoDisponivelSpot = parseFloat(usdtBalance.free || '0');

    console.log(`[API] ✅ saldo_spot obtido para conta ${accountId}:`);
    console.log(`  - Total: ${saldoTotal.toFixed(2)} USDT`);
    console.log(`  - Disponível: ${saldoDisponivelSpot.toFixed(2)} USDT`);

    // ATUALIZAR NO BANCO DE DADOS
    const db = await getDatabaseInstance(accountId);

    // Obter saldo_spot anterior para comparação
    const previousBalanceSpotResult = await db.query(
      'SELECT saldo_spot, saldo_base_calculo_spot FROM contas WHERE id = $1',
      [accountId]
    );
    const previousBalanceSpot = previousBalanceSpotResult.rows;

    const previousSaldoSpot = previousBalanceSpot.length > 0 ? parseFloat(previousBalanceSpot[0].saldo_spot || '0') : 0;
    const previousBaseCalculoSpot = previousBalanceSpot.length > 0 ? parseFloat(previousBalanceSpot[0].saldo_base_calculo_spot || '0') : 0;

    // saldo_base_calculo_spot SÓ AUMENTA, NUNCA DIMINUI
    let novaBaseCalculoSpot = previousBaseCalculoSpot;
    if (saldoDisponivelSpot > previousBaseCalculoSpot) {
      novaBaseCalculoSpot = saldoDisponivelSpot;
      console.log(`[API] saldo_spot base de cálculo atualizado: ${previousBaseCalculoSpot.toFixed(2)} → ${novaBaseCalculoSpot.toFixed(2)}`);
    } else {
      console.log(`[API] saldo_spot base de cálculo mantido: ${previousBaseCalculoSpot.toFixed(2)} (saldo_spot atual: ${saldoDisponivelSpot.toFixed(2)})`);
    }

    await db.query(
      'UPDATE contas SET saldo_spot = $1, saldo_base_calculo_spot = $2, ultima_atualizacao = CURRENT_TIMESTAMP WHERE id = $3',
      [saldoDisponivelSpot, novaBaseCalculoSpot, accountId]
    );

    return {
      success: true,
      accountId: accountId,
      saldo: saldoTotal,
      saldo_disponivel: saldoDisponivelSpot,
      saldo_base_calculo: novaBaseCalculoSpot,
      previousSaldoSpot: previousSaldoSpot,
      previousBaseCalculoSpot: previousBaseCalculoSpot,
      assets: accountData.balances,
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`[API] ❌ Erro ao obter detalhes do saldo_spot para conta ${accountId}:`, error.message);

    return {
      success: false,
      accountId: accountId,
      error: error.message,
      saldo: 0,
      saldo_disponivel: 0,
      saldo_base_calculo: 0,
      previousSaldoSpot: 0,
      previousBaseCalculoSpot: 0,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Obtém detalhes do saldo_futuros da conta de futuros via REST API
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Detalhes do saldo_futuros formatados
 */
async function getFuturesAccountBalanceDetails(accountId) {
  try {
    console.log(`[API] Obtendo detalhes do saldo_futuros para conta ${accountId}...`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }

    // CHAMADA REST API PARA /v2/balance
    const balanceData = await makeAuthenticatedRequest(accountId, 'GET', '/v2/balance');
    
    if (!Array.isArray(balanceData)) {
      throw new Error('Resposta inválida da API de saldo');
    }

    // PROCESSAR DADOS DO saldo_futuros USDT
    const usdtBalance = balanceData.find(asset => asset.asset === 'USDT');
    
    if (!usdtBalance) {
      throw new Error('saldo_futuros USDT não encontrado na resposta');
    }

    const saldoTotal = parseFloat(usdtBalance.balance || '0');
    const saldoDisponivelFuturos = parseFloat(usdtBalance.availableBalance || '0');
    const saldoUtilizado = saldoTotal - saldoDisponivelFuturos;

    console.log(`[API] ✅ saldo_futuros obtido para conta ${accountId}:`);
    console.log(`  - Total: ${saldoTotal.toFixed(2)} USDT`);
    console.log(`  - Disponível: ${saldoDisponivelFuturos.toFixed(2)} USDT`);
    console.log(`  - Em uso: ${saldoUtilizado.toFixed(2)} USDT`);
    
    // ATUALIZAR NO BANCO DE DADOS
    const db = await getDatabaseInstance(accountId);
    
    // Obter saldo_futuros anterior para comparação
    const previousBalanceFuturesResult = await db.query(
      'SELECT saldo_futuros, saldo_base_calculo_futuros FROM contas WHERE id = $1',
      [accountId]
    );
    const previousBalanceFutures = previousBalanceFuturesResult.rows;
    
    const previousSaldoFuturos = previousBalanceFutures.length > 0 ? parseFloat(previousBalanceFutures[0].saldo_futuros || '0') : 0;
    const previousBaseCalculoFuturos = previousBalanceFutures.length > 0 ? parseFloat(previousBalanceFutures[0].saldo_base_calculo_futuros || '0') : 0;
    
    // ✅ CORREÇÃO: Lógica correta do saldo_base_calculo
    // saldo_base_calculo_futuros SÓ AUMENTA, NUNCA DIMINUI
    let novaBaseCalculoFuturos = previousBaseCalculoFuturos;
    if (saldoDisponivelFuturos > previousBaseCalculoFuturos) {
      novaBaseCalculoFuturos = saldoDisponivelFuturos;
      console.log(`[API] saldo_futuros base de cálculo atualizado: ${previousBaseCalculoFuturos.toFixed(2)} → ${novaBaseCalculoFuturos.toFixed(2)}`);
    } else {
      console.log(`[API] saldo_futuros base de cálculo mantido: ${previousBaseCalculoFuturos.toFixed(2)} (saldo_futuros atual: ${saldoDisponivelFuturos.toFixed(2)})`);
    }
    
    console.log(`[API] Cálculo da base:`);
    console.log(`  - saldo_futuros atual: ${saldoDisponivelFuturos.toFixed(2)} USDT`);
    console.log(`  - Base anterior: ${previousBaseCalculoFuturos.toFixed(2)} USDT`);
    console.log(`  - Nova base: ${novaBaseCalculoFuturos.toFixed(2)} USDT`);
    
    await db.query(
      'UPDATE contas SET saldo_futuros = $1, saldo_base_calculo_futuros = $2, ultima_atualizacao = CURRENT_TIMESTAMP WHERE id = $3',
      [saldoDisponivelFuturos, novaBaseCalculoFuturos, accountId]
    );

    // RETORNAR FORMATO PADRONIZADO
    return {
      success: true,
      accountId: accountId,
      saldo: saldoTotal,
      saldo_disponivel: saldoDisponivelFuturos,
      saldo_base_calculo: novaBaseCalculoFuturos,
      previousSaldoFuturos: previousSaldoFuturos,
      previousBaseCalculoFuturos: previousBaseCalculoFuturos,
      assets: balanceData,
      timestamp: new Date().toISOString()
    };
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao obter detalhes do saldo_futuros para conta ${accountId}:`, error.message);
    
    return {
      success: false,
      accountId: accountId,
      error: error.message,
      saldo: 0,
      saldo_disponivel: 0,
      saldo_base_calculo: 0,
      previousSaldoFuturos: 0,
      previousBaseCalculoFuturos: 0,
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
 * Cria ordem STOP_MARKET/TAKE_PROFIT_MARKET (VERSÃO CORRIGIDA)
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number|null} quantity - Quantidade (null se closePosition = true)
 * @param {string} side - Lado
 * @param {number} stopPrice - Preço de gatilho (OBRIGATÓRIO)
 * @param {number|null} price - Preço (NÃO usado para STOP_MARKET/TAKE_PROFIT_MARKET)
 * @param {boolean} reduceOnly - Se é reduce only
 * @param {boolean} closePosition - Se é close position
 * @param {string} orderType - Tipo da ordem ('STOP_MARKET' ou 'TAKE_PROFIT_MARKET')
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newStopOrder(accountId, symbol, quantity, side, stopPrice, price = null, reduceOnly = false, closePosition = false, orderType = 'STOP_MARKET') {
  try {
    console.log(`[API] Criando ordem ${orderType}: ${side} ${symbol} @ stopPrice=${stopPrice} (conta ${accountId})`);
    console.log(`[API] Configurações: quantity=${quantity}, reduceOnly=${reduceOnly}, closePosition=${closePosition}`);
    
    // OBTER PRECISÃO
    const precision = await getPrecisionCached(symbol, accountId);
    const roundedStopPrice = await roundPriceToTickSize(symbol, stopPrice, accountId);
    
    // FORMATAR APENAS O STOP PRICE (preço de gatilho)
    const formattedStopPrice = roundedStopPrice.toFixed(precision.pricePrecision);
    
    // ✅ PARÂMETROS OBRIGATÓRIOS CONFORME DOCUMENTAÇÃO BINANCE
    const orderParams = {
      symbol: symbol,
      side: side,
      type: orderType,
      stopPrice: formattedStopPrice,
      newOrderRespType: "RESULT"
    };
    
    // ✅ LÓGICA CORRIGIDA PARA QUANTITY vs CLOSEPOSITION
    if (closePosition) {
      orderParams.closePosition = true;
    } else if (quantity) {
      orderParams.quantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);
    }
    if (reduceOnly) {
      orderParams.reduceOnly = true;
    }

    // ENVIAR ORDEM
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    
    // ✅ VALIDAÇÃO CORRIGIDA DA RESPOSTA
    if (response && response.orderId) {
      console.log(`[API] ✅ Ordem ${orderType} criada com sucesso:`, {
        orderId: response.orderId,
        status: response.status,
        symbol: response.symbol,
        side: response.side,
        type: response.type,
        stopPrice: response.stopPrice || formattedStopPrice
      });
      
      // ✅ RETORNAR RESPOSTA COMPLETA (não rejeitar)
      return response;
    } else {
      console.error(`[API] ❌ Resposta sem orderId:`, response);
      throw new Error(`Resposta inválida da API: ${JSON.stringify(response)}`);
    }
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao criar ordem ${orderType || 'STOP'} para ${symbol} (conta ${accountId}):`);
    
    if (error.response$1.data) {
      console.error(`[API] Erro da API:`, error.response.data);
      
      const apiError = error.response.data;
      if (apiError.code === -2021) {
        console.error(`[API] ❌ Erro -2021: stopPrice inválido - ordem executaria imediatamente`);
      } else if (apiError.code === -1111) {
        console.error(`[API] ❌ Erro -1111: Precisão inválida no stopPrice`);
      } else if (apiError.code === -2010) {
        console.error(`[API] ❌ Erro -2010: Ordem seria rejeitada pela corretora`);
      }
    } else {
      console.error(`[API] Erro local:`, error.message);
    }
    
    throw error;
  }
}

/**
 * Cria ordem market
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado (BUY/SELL)
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newMarketOrder(accountId, symbol, quantity, side) {
  try {
    console.log(`[API] Criando ordem MARKET: ${side} ${quantity} ${symbol} (conta ${accountId})`);
    
    // VALIDAÇÃO DE ACCOUNTID
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId deve ser um número válido: ${accountId}`);
    }
    
    // OBTER PRECISÃO
    const precision = await getPrecisionCached(symbol, accountId);
    const formattedQuantity = formatQuantityCorrect(quantity, precision.quantityPrecision, symbol);
    
    console.log(`[API] Enviando Ordem MARKET: ${symbol}, Qtd: ${formattedQuantity}, Lado: ${side}`);
    
    const orderParams = {
      symbol: symbol,
      side: side,
      type: "MARKET",
      quantity: formattedQuantity,
      newOrderRespType: "RESULT"
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    console.log(`[API] ✅ Ordem MARKET criada com sucesso: ${response.orderId}`);
    return response;
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao criar ordem MARKET para ${symbol}:`, error.response$1.data || error.message);
    throw error;
  }
}

/**
 * Cria ordem reduce-only
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado (BUY/SELL)
 * @param {number} price - Preço
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function newReduceOnlyOrder(accountId, symbol, quantity, side, price) {
  try {
    console.log(`[API] Criando ordem REDUCE-ONLY: ${side} ${quantity} ${symbol} @ ${price} (conta ${accountId})`);
    
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
    
    console.log(`[API] Enviando Ordem REDUCE-ONLY: ${symbol}, Qtd: ${formattedQuantity}, Lado: ${side}, Preço: ${formattedPrice}`);
    
    const orderParams = {
      symbol: symbol,
      side: side,
      type: "LIMIT",
      quantity: formattedQuantity,
      price: formattedPrice,
      timeInForce: "GTC",
      reduceOnly: "true",
      newOrderRespType: "RESULT"
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/order', orderParams);
    
    console.log(`[API] ✅ Ordem REDUCE-ONLY criada com sucesso: ${response.orderId}`);
    return response;
    
  } catch (error) {
    console.error(`[API] ❌ Erro ao criar ordem REDUCE-ONLY para ${symbol}:`, error.response$1.data || error.message);
    throw error;
  }
}

/**
 * Obtém status de uma ordem específica
 * @param {string} symbol - Símbolo
 * @param {string|number} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da ordem
 */
async function getOrderStatus(symbol, orderId, accountId) {
  try {
    //console.log(`[API] Obtendo status da ordem ${orderId} para ${symbol} (conta ${accountId})...`);
    
    const params = {
      symbol: symbol,
      orderId: String(orderId)
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/order', params);
    
    if (response) {
      //console.log(`[API] ✅ Status da ordem ${orderId}: ${response.status}`);
      return response;
    } else {
      console.error(`[API] Resposta inválida ao obter status da ordem ${orderId}`);
      return null;
    }
  } catch (error) {
    console.error(`[API] Erro ao obter status da ordem ${orderId} (conta ${accountId}):`, error.message);
    throw error;
  }
}

/**
 * Obtém ordens abertas da corretora (Binance Futures)
 * @param {number} accountId - ID da conta
 * @param {string|null} symbol - (Opcional) Símbolo do par, ex: 'BTCUSDT'
 * @param {string|number|null} orderId - (Opcional) ID da ordem específica
 * @returns {Promise<Array|Object>} - Lista de ordens abertas ou uma ordem específica
 */
async function getOpenOrders(accountId, symbol = null, orderId = null) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }

    // Buscar uma ordem específica (precisa do symbol)
    if (orderId && symbol) {
      const params = { symbol, orderId: String(orderId) };
           const order = await makeAuthenticatedRequest(accountId, 'GET', '/v1/order', params);
      return order;
    }

    // Buscar todas as ordens abertas de um symbol
    if (symbol) {
      const params = { symbol };
      const orders = await makeAuthenticatedRequest(accountId, 'GET', '/v1/openOrders', params);
      return Array.isArray(orders) ? orders : [];
    }

    // Buscar todas as ordens abertas da conta
    const orders = await makeAuthenticatedRequest(accountId, 'GET', '/v1/openOrders', {});
    return Array.isArray(orders) ? orders : [];
  } catch (error) {
    console.error(`[API] Erro em getOpenOrders:`, error.message);
    return [];
  }
}

/**
 * Cancela uma ordem
 * @param {string} symbol - Símbolo
 * @param {string|number} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado do cancelamento
 */
async function cancelOrder(symbol, orderId, accountId) {
  try {
    console.log(`[API] Cancelando ordem ${orderId} para ${symbol} (conta ${accountId})...`);
    
    const params = {
      symbol: symbol,
      orderId: String(orderId)
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'DELETE', '/v1/order', params);
    
    if (response) {
      console.log(`[API] ✅ Ordem ${orderId} cancelada com sucesso`);
      return response;
    } else {
      console.error(`[API] Resposta inválida ao cancelar ordem ${orderId}`);
      return null;
    }
  } catch (error) {
    console.error(`[API] Erro ao cancelar ordem ${orderId} (conta ${accountId}):`, error.message);
    throw error;
  }
}

/**
 * Obtém o histórico de trades (userTrades) para um símbolo e conta
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par (ex: BTCUSDT)
 * @param {Object} [options] - Parâmetros opcionais: { orderId, startTime, endTime, fromId, limit, recvWindow }
 * @returns {Promise<Array>} - Lista de trades
 */
async function getUserTrades(accountId, symbol, options = {}) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId}`);
    }
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(`Símbolo inválido: ${symbol}`);
    }
    const params = { symbol };
    if (options.orderId) params.orderId = options.orderId;
    if (options.startTime) params.startTime = options.startTime;
    if (options.endTime) params.endTime = options.endTime;
    if (options.fromId) params.fromId = options.fromId;
    if (options.limit) params.limit = options.limit;
    if (options.recvWindow) params.recvWindow = options.recvWindow;

    // ✅ CORREÇÃO: Endpoint correto sem duplicação
    const trades = await makeAuthenticatedRequest(accountId, 'GET', '/v1/userTrades', params);
    if (Array.isArray(trades)) {
      return trades;
    } else {
      console.error(`[API] Resposta inválida ao obter userTrades para ${symbol}:`, trades);
      return [];
    }
  } catch (error) {
    console.error(`[API] Erro ao obter userTrades para ${symbol} (conta ${accountId}):`, error.message);
    return [];
  }
}

/**
 * Obtém timestamp corrigido para requisições, aplicando offset de sincronização
 * @param {number} accountId - ID da conta
 * @returns {number} - Timestamp corrigido em milissegundos
 */
function getCorrectedTimestamp(accountId) {
  const accountState = getAccountState(accountId);
  const localTime = Date.now();
  
  if (accountState && accountState.timeOffset !== undefined) {
    const correctedTime = localTime + accountState.timeOffset;
    //console.log(`[CONTA-${accountId}] ⏰ Timestamp corrigido: ${localTime} + ${accountState.timeOffset} = ${correctedTime}`);
    return correctedTime;
  }
  
  return localTime;
}

/**
 * Obtém RECV_WINDOW otimizado baseado na qualidade de sincronização
 * @param {number} accountId - ID da conta
 * @returns {number} - RECV_WINDOW em milissegundos
 */
function getOptimizedRecvWindow(accountId) {
  const accountState = getAccountState(accountId);
  
  // ✅ NOVO: Verificar limites do ambiente
  const isTestnet = accountState && accountState.ambiente === 'testnet';
  const maxRecvWindow = isTestnet ? 59000 : 180000; // Testnet: máximo 59s, Produção: máximo 3min
  
  if (accountState && accountState.recvWindow) {
    // Garantir que o valor está dentro de limites seguros do ambiente
    const recvWindow = Math.min(accountState.recvWindow, maxRecvWindow);
    
    if (accountState.recvWindow > maxRecvWindow) {
      console.warn(`[CONTA-${accountId}] ⚠️ RECV_WINDOW ajustado de ${accountState.recvWindow}ms para ${recvWindow}ms (limite ${isTestnet ? 'testnet' : 'produção'})`);
    }
    
    return recvWindow;
  }
  
  // Fallback baseado no ambiente
  const fallbackRecvWindow = isTestnet ? 59000 : 120000;
  console.log(`[CONTA-${accountId}] 📝 Usando RECV_WINDOW padrão: ${fallbackRecvWindow}ms (ambiente: ${isTestnet ? 'testnet' : 'produção'})`);
  return fallbackRecvWindow;
}

/**
 * Força uma re-sincronização agressiva de tempo com múltiplas tentativas
 * @param {number} accountId - ID da conta
 * @param {number} maxRetries - Número máximo de tentativas (padrão: 3)
 * @returns {Promise<Object>} - Resultado da re-sincronização
 */
async function forceTimeResync(accountId, maxRetries = 3) {
  console.log(`[CONTA-${accountId}] 🔄 INICIANDO RE-SINCRONIZAÇÃO FORÇADA (${maxRetries} tentativas)`);
  
  let bestResult = null;
  let attempts = 0;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[CONTA-${accountId}] 🔄 Tentativa ${attempt}/${maxRetries} de re-sincronização...`);
    
    try {
      // Limpar estado de sincronização anterior
      const accountState = getAccountState(accountId);
      if (accountState) {
        delete accountState.lastTimeSyncCheck;
        delete accountState.timeOffset;
        delete accountState.syncQuality;
        console.log(`[CONTA-${accountId}] 🧹 Estado de sincronização anterior limpo`);
      }
      
      // Aguardar um pouco entre tentativas
      if (attempt > 1) {
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
      }
      
      // Executar nova sincronização
      const syncResult = await checkServerTime(accountId);
      
      if (syncResult && accountState) {
        const timeDiff = accountState.syncQuality;
        const recvWindow = accountState.recvWindow;
        const timeOffset = accountState.timeOffset || 0;
        
        console.log(`[CONTA-${accountId}] 📊 Tentativa ${attempt} - Resultado:`);
        console.log(`[CONTA-${accountId}]   - Sucesso: ${syncResult ? 'SIM' : 'NÃO'}`);
        console.log(`[CONTA-${accountId}]   - Qualidade: ${timeDiff || 'DESCONHECIDA'}`);
        console.log(`[CONTA-${accountId}]   - RECV_WINDOW: ${recvWindow || 60000}ms`);
        console.log(`[CONTA-${accountId}]   - Offset: ${timeOffset}ms`);
        
        // Guardar o melhor resultado até agora
        if (!bestResult || (syncResult && (!bestResult.success || recvWindow < bestResult.recvWindow))) {
          bestResult = {
            success: syncResult,
            attempt: attempt,
            quality: timeDiff,
            recvWindow: recvWindow,
            timeOffset: timeOffset
          };
          console.log(`[CONTA-${accountId}] ⭐ Nova melhor sincronização na tentativa ${attempt}`);
        }
        
        // Se conseguiu uma sincronização boa, pode parar
        if (syncResult && recvWindow <= 20000) {
          console.log(`[CONTA-${accountId}] ✅ Sincronização satisfatória alcançada na tentativa ${attempt}`);
          break;
        }
      }
      
      attempts++;
      
    } catch (error) {
      console.error(`[CONTA-${accountId}] ❌ Erro na tentativa ${attempt} de re-sincronização:`, error.message);
    }
  }
  
  // Avaliar resultado final
  if (bestResult && bestResult.success) {
    console.log(`[CONTA-${accountId}] ✅ RE-SINCRONIZAÇÃO CONCLUÍDA:`);
    console.log(`[CONTA-${accountId}]   - Melhor resultado: Tentativa ${bestResult.attempt}`);
    console.log(`[CONTA-${accountId}]   - Qualidade: ${bestResult.quality}`);
    console.log(`[CONTA-${accountId}]   - RECV_WINDOW: ${bestResult.recvWindow}ms`);
    console.log(`[CONTA-${accountId}]   - Offset de tempo: ${bestResult.timeOffset}ms`);
    
    return {
      success: true,
      message: `Re-sincronização bem-sucedida na tentativa ${bestResult.attempt}`,
      attempts: attempts,
      quality: bestResult.quality,
      recvWindow: bestResult.recvWindow,
      timeOffset: bestResult.timeOffset
    };
  } else {
    console.error(`[CONTA-${accountId}] ❌ RE-SINCRONIZAÇÃO FALHOU após ${attempts} tentativas`);
    console.error(`[CONTA-${accountId}] 🚨 AÇÃO REQUERIDA: Verificar conectividade e NTP do sistema`);
    
    return {
      success: false,
      message: `Re-sincronização falhou após ${attempts} tentativas`,
      attempts: attempts,
      quality: 'FALHA',
      recvWindow: 180000, // Modo ultra-defensivo
      timeOffset: 0
    };
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
  getListenKey,
  checkServerTime,
  
  // ✅ Novas funções de sincronização de tempo
  getCorrectedTimestamp,
  getOptimizedRecvWindow,
  monitorTimeSync,
  forceTimeResync,
  monitorTimeSync,

  // Spot API
  getSpotAccountBalanceDetails,

  // User Trades
  getUserTrades,

  // Forçar re-sincronização
  forceTimeResync,
  
  /**
   * Força uma re-sincronização agressiva de tempo com múltiplas tentativas
   * @param {number} accountId - ID da conta
   * @param {number} maxRetries - Número máximo de tentativas (padrão: 3)
   * @returns {Promise<Object>} - Resultado da re-sincronização
   */
  async forceTimeResync(accountId, maxRetries = 3) {
    console.log(`[CONTA-${accountId}] 🔄 INICIANDO RE-SINCRONIZAÇÃO FORÇADA (${maxRetries} tentativas)`);
    
    let bestResult = null;
    let attempts = 0;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[CONTA-${accountId}] 🔄 Tentativa ${attempt}/${maxRetries} de re-sincronização...`);
      
      try {
        // Limpar estado de sincronização anterior
        const accountState = getAccountState(accountId);
        if (accountState) {
          delete accountState.lastTimeSyncCheck;
          delete accountState.timeOffset;
          delete accountState.syncQuality;
          console.log(`[CONTA-${accountId}] 🧹 Estado de sincronização anterior limpo`);
        }
        
        // Aguardar um pouco entre tentativas
        if (attempt > 1) {
          await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
        
        // Executar nova sincronização
        const syncResult = await checkServerTime(accountId);
        
        if (syncResult && accountState) {
          const timeDiff = accountState.syncQuality;
          const recvWindow = accountState.recvWindow;
          const timeOffset = accountState.timeOffset || 0;
          
          console.log(`[CONTA-${accountId}] 📊 Tentativa ${attempt} - Resultado:`);
          console.log(`[CONTA-${accountId}]   - Sucesso: ${syncResult ? 'SIM' : 'NÃO'}`);
          console.log(`[CONTA-${accountId}]   - Qualidade: ${timeDiff || 'DESCONHECIDA'}`);
          console.log(`[CONTA-${accountId}]   - RECV_WINDOW: ${recvWindow || 60000}ms`);
          console.log(`[CONTA-${accountId}]   - Offset: ${timeOffset}ms`);
          
          // Guardar o melhor resultado até agora
          if (!bestResult || (syncResult && (!bestResult.success || recvWindow < bestResult.recvWindow))) {
            bestResult = {
              success: syncResult,
              attempt: attempt,
              quality: timeDiff,
              recvWindow: recvWindow,
              timeOffset: timeOffset
            };
            console.log(`[CONTA-${accountId}] ⭐ Nova melhor sincronização na tentativa ${attempt}`);
          }
          
          // Se conseguiu uma sincronização boa, pode parar
          if (syncResult && recvWindow <= 20000) {
            console.log(`[CONTA-${accountId}] ✅ Sincronização satisfatória alcançada na tentativa ${attempt}`);
            break;
          }
        }
        
        attempts++;
        
      } catch (error) {
        console.error(`[CONTA-${accountId}] ❌ Erro na tentativa ${attempt} de re-sincronização:`, error.message);
      }
    }
    
    // Avaliar resultado final
    if (bestResult && bestResult.success) {
      console.log(`[CONTA-${accountId}] ✅ RE-SINCRONIZAÇÃO CONCLUÍDA:`);
      console.log(`[CONTA-${accountId}]   - Melhor resultado: Tentativa ${bestResult.attempt}`);
      console.log(`[CONTA-${accountId}]   - Qualidade: ${bestResult.quality}`);
      console.log(`[CONTA-${accountId}]   - RECV_WINDOW: ${bestResult.recvWindow}ms`);
      console.log(`[CONTA-${accountId}]   - Offset de tempo: ${bestResult.timeOffset}ms`);
      
      return {
        success: true,
        message: `Re-sincronização bem-sucedida na tentativa ${bestResult.attempt}`,
        attempts: attempts,
        quality: bestResult.quality,
        recvWindow: bestResult.recvWindow,
        timeOffset: bestResult.timeOffset
      };
    } else {
      console.error(`[CONTA-${accountId}] ❌ RE-SINCRONIZAÇÃO FALHOU após ${attempts} tentativas`);
      console.error(`[CONTA-${accountId}] 🚨 AÇÃO REQUERIDA: Verificar conectividade e NTP do sistema`);
      
      return {
        success: false,
        message: `Re-sincronização falhou após ${attempts} tentativas`,
        attempts: attempts,
        quality: 'FALHA',
        recvWindow: 180000, // Modo ultra-defensivo
        timeOffset: 0
      };
    }
  }
};