const fs = require('fs');
const path = require('path');

console.log('🔧 Correção final do api.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.final-fix.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
}

// Corrigir api.js
console.log('1️⃣ Corrigindo api.js...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Verificar se já tem a estrutura básica
if (!apiContent.includes('const accountConnections = new Map()')) {
  console.log('❌ Estrutura básica não encontrada. Recriando api.js...');
  
  // Recriar o arquivo api.js com estrutura correta
  const newApiContent = `const axios = require("axios");
const crypto = require("crypto");
const { getDatabaseInstance } = require('./db/conexao');

// >>> INÍCIO: Estado da conexão centralizado em api.js <<<
const accountConnections = new Map();

/**
 * Retorna ou cria o estado da conexão para uma conta.
 * @param {number} accountId - ID da conta.
 * @param {boolean} createIfMissing - Criar se não existir.
 * @returns {Object|null} O estado da conta ou null.
 */
function getAccountConnectionState(accountId, createIfMissing = false) {
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[API_STATE] AccountId inválido fornecido para getAccountConnectionState: \${accountId}\`);
    return null;
  }
  if (!accountConnections.has(accountId) && createIfMissing) {
    console.log(\`[API_STATE] Criando novo estado para conta \${accountId} em api.js\`);
    accountConnections.set(accountId, {
      accountId: accountId,
      apiKey: null,
      secretKey: null,
      wsApiKey: null,
      wsApiSecret: null, // Chave privada Ed25519
      privateKey: null, // Alias para wsApiSecret
      apiUrl: null,
      wsUrl: null,
      wsApiUrl: null,
      isAuthenticated: false, // Para REST API
      wsApiAuthenticated: false, // Para WebSocket API
      wsApiConnection: null, // Instância da conexão WebSocket API
      wsApiRequestCallbacks: new Map(),
      wsApiKeepAliveInterval: null,
      lastWsApiActivity: 0,
      userDataStream: null, // Instância da conexão UserDataStream
      listenKey: null,
      userDataKeepAliveInterval: null,
      lastUserDataStreamKeepAlive: 0,
      priceWebsockets: new Map(), // Map<symbol, WebSocket>
      monitoringCallbacks: null, // Callbacks definidos por monitoramento.js
      isShuttingDown: false,
      dbInstance: null,
      lastPongTime: 0,
      pingInterval: null,
      // Adicionar outros campos conforme necessário
      ambiente: null,
      corretora: null,
      nomeConta: null,
    });
  }
  return accountConnections.get(accountId) || null;
}

/**
 * Obtém todas as conexões de contas (para compatibilidade)
 * @returns {Map} Mapa de conexões
 */
function getAllAccountConnections() {
  return accountConnections;
}
// >>> FIM: Estado da conexão centralizado em api.js <<<

async function loadCredentialsFromDatabase(accountId) {
  console.log(\`[API] Carregando credenciais do banco para conta \${accountId} (chamado de api.js)...\`);
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = \`AccountId deve ser um número válido para carregar credenciais: \${String(accountId)} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  const accountState = getAccountConnectionState(accountId, true); // Garante que o estado exista em api.js
  const db = await getDatabaseInstance(accountId);

  const [rows] = await db.query(
    \`SELECT c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, c.nome as nome_conta,
            co.ambiente, co.corretora, co.futures_rest_api_url, co.futures_ws_market_url, co.futures_ws_api_url
     FROM contas c
     JOIN corretoras co ON c.id_corretora = co.id
     WHERE c.id = ? AND c.ativa = 1\`,
    [accountId]
  );

  if (rows.length === 0) {
    throw new Error(\`Conta \${accountId} não encontrada, inativa ou sem corretora associada.\`);
  }
  const creds = rows[0];

  accountState.apiKey = creds.api_key;
  accountState.secretKey = creds.api_secret;
  accountState.wsApiKey = creds.ws_api_key;
  accountState.wsApiSecret = creds.ws_api_secret; // Chave privada Ed25519
  accountState.privateKey = creds.ws_api_secret; // Alias para wsApiSecret
  accountState.apiUrl = creds.futures_rest_api_url;
  accountState.wsUrl = creds.futures_ws_market_url; // Para bookTicker, klines, etc.
  accountState.wsApiUrl = creds.futures_ws_api_url; // Para WebSocket API de trading
  accountState.ambiente = creds.ambiente;
  accountState.corretora = creds.corretora;
  accountState.nomeConta = creds.nome_conta;

  console.log(\`[API] Credenciais carregadas e estado atualizado em api.js para conta \${accountId}\`);
  return accountState; // Retorna o estado atualizado
}

/**
 * Cria uma requisição autenticada com assinatura
 */
async function makeAuthenticatedRequest(accountId, method = 'GET', endpoint, data = null) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.secretKey) {
    console.warn(\`[API] Credenciais não encontradas para conta \${accountId}. Tentando carregar...\`);
    await loadCredentialsFromDatabase(accountId);
    const newState = getAccountConnectionState(accountId);
    if (!newState || !newState.apiKey || !newState.secretKey) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}\`);
    }
  }

  const currentState = getAccountConnectionState(accountId);
  const timestamp = Date.now();
  const params = data ? { ...data, timestamp } : { timestamp };
  
  const queryString = Object.keys(params)
    .sort()
    .map(key => \`\${key}=\${params[key]}\`)
    .join('&');
  
  const signature = crypto
    .createHmac('sha256', currentState.secretKey)
    .update(queryString)
    .digest('hex');
  
  const finalParams = { ...params, signature };
  const url = \`\${currentState.apiUrl}\${endpoint}\`;
  
  const config = {
    method,
    url,
    headers: {
      'X-MBX-APIKEY': currentState.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  };
  
  if (method === 'GET') {
    config.params = finalParams;
  } else {
    config.data = finalParams;
  }
  
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(\`[API] Erro na requisição \${method} \${endpoint}:\`, error.response?.data || error.message);
    throw error;
  }
}

/**
 * Verifica e corrige consistência de ambiente
 */
async function verifyAndFixEnvironmentConsistency(accountId) {
  const db = await getDatabaseInstance();
  const [accountInfo] = await db.query(\`
    SELECT c.id, c.id_corretora, cor.corretora, cor.ambiente, 
           cor.futures_rest_api_url, cor.futures_ws_api_url, cor.futures_ws_market_url
    FROM contas c
    JOIN corretoras cor ON c.id_corretora = cor.id
    WHERE c.id = ? AND c.ativa = 1
  \`, [accountId]);
  
  if (!accountInfo || accountInfo.length === 0) {
    throw new Error(\`Conta ID \${accountId} não encontrada\`);
  }
  
  console.log(\`[API] Verificação de consistência concluída para conta \${accountId}\`);
  return true;
}

/**
 * Obtém o preço atual de um símbolo
 */
async function getPrice(symbol, accountId) {
  try {
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Símbolo inválido: \${symbol}\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId deve ser um número válido: \${accountId}\`);
    }

    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v1/ticker/price', { symbol });
    
    if (response && response.price) {
      const price = parseFloat(response.price);
      if (isNaN(price) || price <= 0) {
        console.error(\`[API] Preço inválido recebido para \${symbol}: \${response.price}\`);
        return null;
      }
      return price;
    } else {
      console.error(\`[API] Resposta inválida ao obter preço para \${symbol}:\`, response);
      return null;
    }
  } catch (error) {
    console.error(\`[API] Erro ao obter preço para \${symbol} (conta \${accountId}):\`, error.message);
    return null;
  }
}

/**
 * Obtém informações da conta
 */
async function getAccountInfo(accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v2/account', {});
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter informações da conta \${accountId}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém todas as posições abertas
 */
async function getAllOpenPositions(accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v2/positionRisk', {});
    
    if (!Array.isArray(response)) {
      console.error(\`[API] Resposta inválida ao obter posições para conta \${accountId}:\`, response);
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

    return openPositions;
  } catch (error) {
    console.error(\`[API] Erro ao obter posições abertas para conta \${accountId}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém informações de um símbolo
 */
async function getSymbolInfo(symbol, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v1/exchangeInfo', {});
    
    if (response && response.symbols) {
      const symbolInfo = response.symbols.find(s => s.symbol === symbol);
      return symbolInfo || null;
    }
    
    return null;
  } catch (error) {
    console.error(\`[API] Erro ao obter informações do símbolo \${symbol}:\`, error.message);
    return null;
  }
}

/**
 * Obtém a precisão de um símbolo
 */
async function getPrecision(symbol, accountId) {
  try {
    const symbolInfo = await getSymbolInfo(symbol, accountId);
    
    if (!symbolInfo) {
      return { price: 2, quantity: 3 }; // Valores padrão
    }

    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');

    const pricePrecision = priceFilter ? -Math.log10(parseFloat(priceFilter.tickSize)) : 2;
    const quantityPrecision = lotSizeFilter ? -Math.log10(parseFloat(lotSizeFilter.stepSize)) : 3;

    return {
      price: Math.max(0, Math.min(8, pricePrecision)),
      quantity: Math.max(0, Math.min(8, quantityPrecision))
    };
  } catch (error) {
    console.error(\`[API] Erro ao obter precisão para \${symbol}:\`, error.message);
    return { price: 2, quantity: 3 };
  }
}

/**
 * Altera a alavancagem inicial
 */
async function changeInitialLeverage(symbol, leverage, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/leverage', {
      symbol,
      leverage
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar alavancagem para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Altera o tipo de margem
 */
async function changeMarginType(symbol, marginType, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/marginType', {
      symbol,
      marginType
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar tipo de margem para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Cria uma nova ordem
 */
async function createOrder(orderParams, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/order', orderParams);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao criar ordem:\`, error.message);
    throw error;
  }
}

/**
 * Cancela uma ordem
 */
async function cancelOrder(symbol, orderId, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'DELETE', '/fapi/v1/order', {
      symbol,
      orderId
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao cancelar ordem \${orderId}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém a alavancagem atual de um símbolo
 */
async function getCurrentLeverage(symbol, accountId) {
  try {
    const positions = await getAllOpenPositions(accountId);
    const position = positions.find(pos => pos.simbolo === symbol);
    return position ? position.alavancagem : 1;
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem atual para \${symbol}:\`, error.message);
    return 1;
  }
}

/**
 * Obtém um listenKey da Binance Futures API.
 */
async function getListenKey(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.apiUrl) {
    console.error(\`[API] API Key ou API URL não configuradas para getListenKey da conta \${accountId}.\`);
    const creds = await loadCredentialsFromDatabase(accountId);
    if (!creds || !accountState.apiKey || !accountState.apiUrl) {
        throw new Error(\`Credenciais REST incompletas para getListenKey da conta \${accountId}.\`);
    }
  }
  
  const endpoint = '/fapi/v1/listenKey';
  console.log(\`[API] Obtendo listenKey para conta \${accountId}\`);

  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', endpoint, {});
    if (response && response.listenKey) {
      return response.listenKey;
    } else {
      console.error(\`[API] Falha ao obter ListenKey para conta \${accountId}. Resposta:\`, response);
      return null;
    }
  } catch (error) {
    console.error(\`[API] Erro ao fazer requisição para obter ListenKey para conta \${accountId}: \${error.message}\`);
    return null;
  }
}

/**
 * Mantém o listenKey ativo (keep-alive).
 */
async function keepAliveListenKey(accountId, listenKeyToKeepAlive) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.apiUrl) {
    console.error(\`[API] API Key ou API URL não configuradas para keepAliveListenKey da conta \${accountId}.\`);
    const creds = await loadCredentialsFromDatabase(accountId);
    if (!creds || !accountState.apiKey || !accountState.apiUrl) {
        throw new Error(\`Credenciais REST incompletas para keepAliveListenKey da conta \${accountId}.\`);
    }
  }

  const endpoint = '/fapi/v1/listenKey';

  try {
    const response = await makeAuthenticatedRequest(accountId, 'PUT', endpoint, { listenKey: listenKeyToKeepAlive });
    if (response && typeof response === 'object' && Object.keys(response).length === 0) {
      return true;
    } else {
      console.error(\`[API] Falha ao manter ListenKey ativo para conta \${accountId}. Resposta:\`, response);
      return false;
    }
  } catch (error) {
    console.error(\`[API] Erro ao fazer requisição para manter ListenKey ativo para conta \${accountId}: \${error.message}\`);
    return false;
  }
}

module.exports = {
  getPrice,
  getAccountInfo,
  getAllOpenPositions,
  getSymbolInfo,
  getPrecision,
  changeInitialLeverage,
  changeMarginType,
  createOrder,
  cancelOrder,
  getListenKey,
  keepAliveListenKey,
  getCurrentLeverage,
  verifyAndFixEnvironmentConsistency,
  loadCredentialsFromDatabase,
  makeAuthenticatedRequest,
  getAccountConnectionState,
  getAllAccountConnections
};`;

  fs.writeFileSync(apiPath, newApiContent, 'utf8');
  console.log('✅ api.js recriado com estrutura correta');
} else {
  // Se já tem a estrutura, apenas corrigir o que está faltando
  console.log('✅ Estrutura básica encontrada. Verificando exports...');
  
  // Verificar se getAllAccountConnections está definida
  if (!apiContent.includes('function getAllAccountConnections()')) {
    console.log('➕ Adicionando função getAllAccountConnections...');
    apiContent = apiContent.replace(
      /function getAccountConnectionState\(accountId, createIfMissing = false\) \{[\s\S]*?\n\}/,
      `function getAccountConnectionState(accountId, createIfMissing = false) {
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[API_STATE] AccountId inválido fornecido para getAccountConnectionState: \${accountId}\`);
    return null;
  }
  if (!accountConnections.has(accountId) && createIfMissing) {
    console.log(\`[API_STATE] Criando novo estado para conta \${accountId} em api.js\`);
    accountConnections.set(accountId, {
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
    });
  }
  return accountConnections.get(accountId) || null;
}

/**
 * Obtém todas as conexões de contas (para compatibilidade)
 * @returns {Map} Mapa de conexões
 */
function getAllAccountConnections() {
  return accountConnections;
}`
    );
  }
  
  // Verificar se as funções básicas estão implementadas
  const requiredFunctions = ['getPrice', 'getAccountInfo', 'getAllOpenPositions', 'getSymbolInfo', 'getPrecision'];
  
  for (const func of requiredFunctions) {
    if (!apiContent.includes(`function ${func}(`)) {
      console.log(`⚠️ Função ${func} não encontrada, mas estava no exports`);
    }
  }
  
  fs.writeFileSync(apiPath, apiContent, 'utf8');
  console.log('✅ api.js atualizado');
}

console.log('\n🎉 Correção final concluída!');
console.log('\n🚀 Teste agora:');
console.log('   node posicoes/monitoramento.js --account 1');