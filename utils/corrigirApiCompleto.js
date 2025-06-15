const fs = require('fs').promises;
const path = require('path');

async function corrigirApiCompleto() {
  try {
    console.log('=== CORRIGINDO ARQUIVO API.JS COMPLETO ===');
    
    const apiPath = path.join(__dirname, '..', 'api.js');
    
    // Criar o conteúdo completo do arquivo api.js corrigido
    const conteudoCompleto = `const axios = require("axios");
const crypto = require("crypto");
require('dotenv').config();
const { getDatabaseInstance } = require('./db/conexao');

let websockets;
try {
  websockets = require('./websockets');
} catch (e) {
  console.log('WebSockets não carregado:', e.message);
}

// Cache para armazenar credenciais por conta
const accountCredentials = new Map();
// Cache TTL em milissegundos (1 hora)
const CACHE_TTL = 60 * 60 * 1000;
// Timestamp da última atualização do cache
let lastCacheTime = 0;

/**
 * Carrega credenciais do banco de dados para uma conta específica
 * @param {Object} options - Opções de carregamento
 * @returns {Promise<Object>} - Objeto com as credenciais
 */
async function loadCredentialsFromDatabase(options = {}) {
  try {
    const { accountId = 1, forceRefresh = false } = options;
    
    console.log(\`[API] Carregando credenciais para conta ID: \${accountId}\`);
    
    // Usar cache se disponível e não forçar atualização
    if (!forceRefresh && accountCredentials.has(accountId) && 
        (Date.now() - lastCacheTime < CACHE_TTL)) {
      console.log(\`[API] Usando credenciais em cache para conta \${accountId}\`);
      return accountCredentials.get(accountId);
    }
    
    const db = await getDatabaseInstance(accountId);
    
    // Buscar conta e JOIN com a tabela corretoras para obter as URLs corretas
    const [rows] = await db.query(\`
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
      WHERE c.id = ? AND c.ativa = 1 AND cor.ativa = 1\`,
      [accountId]
    );
    
    if (!rows || rows.length === 0) {
      throw new Error(\`Conta ID \${accountId} não encontrada ou não está ativa\`);
    }
    
    const account = rows[0];
    
    // Criar objeto de credenciais
    const credentials = {
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      wsApiKey: account.ws_api_key,
      wsApiSecret: account.ws_api_secret,
      apiUrl: account.futures_rest_api_url,
      wsApiUrl: account.futures_ws_api_url,
      wssMarketUrl: account.futures_ws_market_url,
      corretora: account.corretora,
      ambiente: account.ambiente,
      corretoraId: account.id_corretora,
      accountId
    };
    
    // Armazenar no cache
    accountCredentials.set(accountId, credentials);
    lastCacheTime = Date.now();
    
    console.log(\`[API] Credenciais carregadas com sucesso para conta \${accountId} (corretora: \${account.corretora}, ambiente: \${account.ambiente})\`);
    return credentials;
  } catch (error) {
    console.error(\`[API] Erro ao carregar credenciais para conta \${options.accountId || 1}:\`, error.message);
    throw error;
  }
}

/**
 * Cria assinatura HMAC SHA256 para requisições autenticadas
 * @param {string} queryString - String de query para assinar
 * @param {string} secret - Chave secreta da API
 * @returns {string} - Assinatura hexadecimal
 */
function createSignature(queryString, secret) {
  return crypto
    .createHmac('sha256', secret)
    .update(queryString)
    .digest('hex');
}

/**
 * Faz requisição autenticada para a API da Binance
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function makeAuthenticatedRequest(endpoint, params = {}, method = 'GET', accountId = 1) {
  try {
    const credentials = await loadCredentialsFromDatabase({ accountId });
    
    // Adicionar timestamp
    params.timestamp = Date.now();
    
    // Criar query string
    const queryString = new URLSearchParams(params).toString();
    
    // Criar assinatura
    const signature = createSignature(queryString, credentials.apiSecret);
    
    // Adicionar assinatura
    params.signature = signature;
    
    // Configurar headers
    const headers = {
      'X-MBX-APIKEY': credentials.apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    
    // Fazer requisição
    const config = {
      method,
      url: \`\${credentials.apiUrl}\${endpoint}\`,
      headers,
      timeout: 10000
    };
    
    if (method === 'GET') {
      config.params = params;
    } else {
      config.data = new URLSearchParams(params).toString();
    }
    
    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error(\`[API] Erro na requisição autenticada (\${endpoint}):\`, error.message);
    throw error;
  }
}

/**
 * Obtém detalhes do saldo da conta de futuros
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Detalhes do saldo
 */
async function getFuturesAccountBalanceDetails(accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v2/account', {}, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter detalhes do saldo para conta \${accountId}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém alavancagem máxima para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Alavancagem máxima
 */
async function getMaxLeverage(symbol, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v1/leverageBracket', { symbol }, 'GET', accountId);
    return response[0]?.brackets[0]?.initialLeverage || 20;
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem máxima para \${symbol}:\`, error.message);
    return 20; // Default
  }
}

/**
 * Obtém alavancagem atual para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Alavancagem atual
 */
async function getCurrentLeverage(symbol, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v2/positionRisk', { symbol }, 'GET', accountId);
    return parseInt(response[0]?.leverage || 20);
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem atual para \${symbol}:\`, error.message);
    return 20; // Default
  }
}

/**
 * Obtém tipo de margem atual
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - Tipo de margem
 */
async function getCurrentMarginType(symbol, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v2/positionRisk', { symbol }, 'GET', accountId);
    return response[0]?.marginType || 'cross';
  } catch (error) {
    console.error(\`[API] Erro ao obter tipo de margem para \${symbol}:\`, error.message);
    return 'cross'; // Default
  }
}

/**
 * Altera alavancagem inicial
 * @param {string} symbol - Símbolo do par
 * @param {number} leverage - Nova alavancagem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function changeInitialLeverage(symbol, leverage, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v1/leverage', { symbol, leverage }, 'POST', accountId);
    console.log(\`[API] Alavancagem alterada para \${leverage}x em \${symbol} (conta \${accountId})\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar alavancagem para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Altera tipo de margem
 * @param {string} symbol - Símbolo do par
 * @param {string} marginType - Tipo de margem ('cross' ou 'isolated')
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function changeMarginType(symbol, marginType, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v1/marginType', { symbol, marginType }, 'POST', accountId);
    console.log(\`[API] Tipo de margem alterado para \${marginType} em \${symbol} (conta \${accountId})\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar tipo de margem para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Cria uma nova ordem
 * @param {Object} orderParams - Parâmetros da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function newOrder(orderParams, accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v1/order', orderParams, 'POST', accountId);
    console.log(\`[API] Nova ordem criada: \${response.orderId} para \${orderParams.symbol}\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao criar nova ordem:\`, error.message);
    throw error;
  }
}

/**
 * Cria ordem de entrada
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem (BUY/SELL)
 * @param {number} quantity - Quantidade
 * @param {number} price - Preço
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function newEntryOrder(symbol, side, quantity, price, accountId = 1) {
  const orderParams = {
    symbol,
    side,
    type: 'LIMIT',
    quantity: quantity.toString(),
    price: price.toString(),
    timeInForce: 'GTC'
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Cria ordem LIMIT MAKER
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {number} quantity - Quantidade
 * @param {string} side - Lado da ordem
 * @param {number} price - Preço
 * @returns {Promise<Object>} - Resposta da API
 */
async function newLimitMakerOrder(accountId, symbol, quantity, side, price) {
  const orderParams = {
    symbol,
    side,
    type: 'LIMIT',
    quantity: quantity.toString(),
    price: price.toString(),
    timeInForce: 'GTX' // Good Till Crossing (Maker only)
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Edita uma ordem existente
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} orderId - ID da ordem
 * @param {number} quantity - Nova quantidade
 * @param {number} price - Novo preço
 * @returns {Promise<Object>} - Resposta da API
 */
async function editOrder(accountId, symbol, orderId, quantity, price) {
  try {
    const params = {
      symbol,
      orderId,
      quantity: quantity.toString(),
      price: price.toString(),
      side: 'BUY' // Será substituído pela ordem original
    };
    
    const response = await makeAuthenticatedRequest('/v1/order', params, 'PUT', accountId);
    console.log(\`[API] Ordem \${orderId} editada com sucesso\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao editar ordem \${orderId}:\`, error.message);
    throw error;
  }
}

/**
 * Cria ordem reduce-only
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem
 * @param {number} quantity - Quantidade
 * @param {number} price - Preço
 * @returns {Promise<Object>} - Resposta da API
 */
async function newReduceOnlyOrder(accountId, symbol, side, quantity, price) {
  const orderParams = {
    symbol,
    side,
    type: 'LIMIT',
    quantity: quantity.toString(),
    price: price.toString(),
    timeInForce: 'GTC',
    reduceOnly: 'true'
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Cria ordem de stop
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem
 * @param {number} quantity - Quantidade
 * @param {number} stopPrice - Preço de stop
 * @returns {Promise<Object>} - Resposta da API
 */
async function newStopOrder(accountId, symbol, side, quantity, stopPrice) {
  const orderParams = {
    symbol,
    side,
    type: 'STOP_MARKET',
    quantity: quantity.toString(),
    stopPrice: stopPrice.toString(),
    reduceOnly: 'true'
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Cria ordem de stop ou take profit com limite
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem
 * @param {number} quantity - Quantidade
 * @param {number} price - Preço limite
 * @param {number} stopPrice - Preço de stop
 * @param {string} orderType - Tipo da ordem (STOP ou TAKE_PROFIT)
 * @returns {Promise<Object>} - Resposta da API
 */
async function newStopOrTpLimitOrder(accountId, symbol, side, quantity, price, stopPrice, orderType = 'STOP') {
  const orderParams = {
    symbol,
    side,
    type: orderType === 'STOP' ? 'STOP' : 'TAKE_PROFIT',
    quantity: quantity.toString(),
    price: price.toString(),
    stopPrice: stopPrice.toString(),
    timeInForce: 'GTC',
    reduceOnly: 'true'
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Cria ordem de take profit
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem
 * @param {number} quantity - Quantidade
 * @param {number} stopPrice - Preço de take profit
 * @returns {Promise<Object>} - Resposta da API
 */
async function newTakeProfitOrder(accountId, symbol, side, quantity, stopPrice) {
  const orderParams = {
    symbol,
    side,
    type: 'TAKE_PROFIT_MARKET',
    quantity: quantity.toString(),
    stopPrice: stopPrice.toString(),
    reduceOnly: 'true'
  };
  
  return await newOrder(orderParams, accountId);
}

/**
 * Obtém tick size para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações do tick size
 */
async function getTickSize(symbol, accountId = 1) {
  try {
    const credentials = await loadCredentialsFromDatabase({ accountId });
    const response = await axios.get(\`\${credentials.apiUrl}/v1/exchangeInfo\`);
    
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
    if (!symbolInfo) {
      throw new Error(\`Símbolo \${symbol} não encontrado\`);
    }
    
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    return {
      tickSize: priceFilter.tickSize,
      minPrice: priceFilter.minPrice,
      maxPrice: priceFilter.maxPrice
    };
  } catch (error) {
    console.error(\`[API] Erro ao obter tick size para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Arredonda preço para o tick size correto
 * @param {string} symbol - Símbolo do par
 * @param {number} price - Preço a ser arredondado
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Preço arredondado
 */
async function roundPriceToTickSize(symbol, price, accountId = 1) {
  try {
    const tickInfo = await getTickSize(symbol, accountId);
    const tickSize = parseFloat(tickInfo.tickSize);
    
    return Math.round(price / tickSize) * tickSize;
  } catch (error) {
    console.error(\`[API] Erro ao arredondar preço para \${symbol}:\`, error.message);
    return price; // Retorna preço original em caso de erro
  }
}

/**
 * Obtém precisão para um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações de precisão
 */
async function getPrecision(symbol, accountId = 1) {
  try {
    const credentials = await loadCredentialsFromDatabase({ accountId });
    const response = await axios.get(\`\${credentials.apiUrl}/v1/exchangeInfo\`);
    
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
    if (!symbolInfo) {
      throw new Error(\`Símbolo \${symbol} não encontrado\`);
    }
    
    return {
      quantityPrecision: symbolInfo.quantityPrecision,
      pricePrecision: symbolInfo.pricePrecision,
      baseAssetPrecision: symbolInfo.baseAssetPrecision,
      quotePrecision: symbolInfo.quotePrecision
    };
  } catch (error) {
    console.error(\`[API] Erro ao obter precisão para \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém ordens abertas
 * @param {string} symbol - Símbolo do par (opcional)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Lista de ordens abertas
 */
async function getOpenOrders(symbol, accountId = 1) {
  try {
    const params = symbol ? { symbol } : {};
    const response = await makeAuthenticatedRequest('/v1/openOrders', params, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter ordens abertas:\`, error.message);
    throw error;
  }
}

/**
 * Obtém ordens recentes
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {number} limit - Limite de ordens
 * @returns {Promise<Array>} - Lista de ordens recentes
 */
async function getRecentOrders(accountId, symbol, limit = 500) {
  try {
    const params = { symbol, limit };
    const response = await makeAuthenticatedRequest('/v1/allOrders', params, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter ordens recentes:\`, error.message);
    throw error;
  }
}

/**
 * Obtém status de uma ordem
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} orderId - ID da ordem
 * @returns {Promise<Object>} - Status da ordem
 */
async function getOrderStatus(accountId, symbol, orderId) {
  try {
    const params = { symbol, orderId };
    const response = await makeAuthenticatedRequest('/v1/order', params, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter status da ordem \${orderId}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém status de múltiplas ordens
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {Array} orderIds - IDs das ordens
 * @returns {Promise<Array>} - Status das ordens
 */
async function getMultipleOrderStatus(accountId, symbol, orderIds) {
  try {
    const promises = orderIds.map(orderId => getOrderStatus(accountId, symbol, orderId));
    return await Promise.all(promises);
  } catch (error) {
    console.error(\`[API] Erro ao obter status de múltiplas ordens:\`, error.message);
    throw error;
  }
}

/**
 * Obtém detalhes da posição
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Detalhes da posição
 */
async function getPositionDetails(symbol, accountId = 1) {
  try {
    const params = symbol ? { symbol } : {};
    const response = await makeAuthenticatedRequest('/v2/positionRisk', params, 'GET', accountId);
    
    if (symbol) {
      return response.find(pos => pos.symbol === symbol) || null;
    }
    
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter detalhes da posição:\`, error.message);
    throw error;
  }
}

/**
 * Obtém todas as posições abertas
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo específico (opcional)
 * @returns {Promise<Array>} - Lista de posições abertas
 */
async function getAllOpenPositions(accountId = 1, symbol = null) {
  try {
    const params = symbol ? { symbol } : {};
    const response = await makeAuthenticatedRequest('/v2/positionRisk', params, 'GET', accountId);
    
    // Filtrar apenas posições com quantidade diferente de zero
    const openPositions = response
      .filter(pos => parseFloat(pos.positionAmt) !== 0)
      .map(pos => ({
        simbolo: pos.symbol,
        quantidade: parseFloat(pos.positionAmt),
        precoEntrada: parseFloat(pos.entryPrice),
        precoAtual: parseFloat(pos.markPrice),
        pnlNaoRealizado: parseFloat(pos.unRealizedProfit),
        lado: parseFloat(pos.positionAmt) > 0 ? 'BUY' : 'SELL',
        alavancagem: parseInt(pos.leverage),
        tipoMargem: pos.marginType
      }));
    
    return openPositions;
  } catch (error) {
    console.error(\`[API] Erro ao obter posições abertas:\`, error.message);
    throw error;
  }
}

/**
 * Obtém saldo da posição
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Saldo total
 */
async function obterSaldoPosicao(accountId = 1) {
  try {
    const response = await getFuturesAccountBalanceDetails(accountId);
    
    // Encontrar saldo de USDT
    const usdtAsset = response.assets.find(asset => asset.asset === 'USDT');
    return usdtAsset ? parseFloat(usdtAsset.walletBalance) : 0;
  } catch (error) {
    console.error(\`[API] Erro ao obter saldo da posição:\`, error.message);
    throw error;
  }
}

/**
 * Cancela uma ordem
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @param {string} orderId - ID da ordem
 * @returns {Promise<Object>} - Resposta da API
 */
async function cancelOrder(accountId, symbol, orderId) {
  try {
    const params = { symbol, orderId };
    const response = await makeAuthenticatedRequest('/v1/order', params, 'DELETE', accountId);
    console.log(\`[API] Ordem \${orderId} cancelada com sucesso\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao cancelar ordem \${orderId}:\`, error.message);
    throw error;
  }
}

/**
 * Transfere fundos entre contas
 * @param {string} asset - Ativo a ser transferido
 * @param {number} amount - Quantidade
 * @param {number} type - Tipo de transferência
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function transferBetweenAccounts(asset, amount, type, accountId = 1) {
  try {
    const params = { asset, amount: amount.toString(), type };
    const response = await makeAuthenticatedRequest('/v1/futures/transfer', params, 'POST', accountId);
    console.log(\`[API] Transferência de \${amount} \${asset} realizada\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro na transferência:\`, error.message);
    throw error;
  }
}

/**
 * Cancela todas as ordens abertas
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo do par
 * @returns {Promise<Object>} - Resposta da API
 */
async function cancelAllOpenOrders(accountId, symbol) {
  try {
    const params = { symbol };
    const response = await makeAuthenticatedRequest('/v1/allOpenOrders', params, 'DELETE', accountId);
    console.log(\`[API] Todas as ordens para \${symbol} foram canceladas\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao cancelar todas as ordens:\`, error.message);
    throw error;
  }
}

/**
 * Encerra uma posição
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function encerrarPosicao(symbol, accountId = 1) {
  try {
    // Obter detalhes da posição atual
    const position = await getPositionDetails(symbol, accountId);
    
    if (!position || parseFloat(position.positionAmt) === 0) {
      throw new Error(\`Nenhuma posição aberta encontrada para \${symbol}\`);
    }
    
    const quantity = Math.abs(parseFloat(position.positionAmt));
    const side = parseFloat(position.positionAmt) > 0 ? 'SELL' : 'BUY';
    
    // Criar ordem de mercado para fechar
    const orderParams = {
      symbol,
      side,
      type: 'MARKET',
      quantity: quantity.toString(),
      reduceOnly: 'true'
    };
    
    const response = await newOrder(orderParams, accountId);
    console.log(\`[API] Posição \${symbol} encerrada com ordem \${response.orderId}\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao encerrar posição \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém brackets de alavancagem
 * @param {string} symbol - Símbolo do par (opcional)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Brackets de alavancagem
 */
async function getAllLeverageBrackets(symbol, accountId = 1) {
  try {
    const params = symbol ? { symbol } : {};
    const response = await makeAuthenticatedRequest('/v1/leverageBracket', params, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter brackets de alavancagem:\`, error.message);
    throw error;
  }
}

/**
 * Define modo de posição
 * @param {boolean} dualSidePosition - true para hedge mode, false para one-way mode
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function setPositionMode(dualSidePosition, accountId = 1) {
  try {
    const params = { dualSidePosition: dualSidePosition.toString() };
    const response = await makeAuthenticatedRequest('/v1/positionSide/dual', params, 'POST', accountId);
    console.log(\`[API] Modo de posição alterado para \${dualSidePosition ? 'hedge' : 'one-way'}\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar modo de posição:\`, error.message);
    throw error;
  }
}

/**
 * Obtém modo de posição atual
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Modo de posição atual
 */
async function getPositionMode(accountId = 1) {
  try {
    const response = await makeAuthenticatedRequest('/v1/positionSide/dual', {}, 'GET', accountId);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter modo de posição:\`, error.message);
    throw error;
  }
}

/**
 * Fecha posição usando closePosition=true
 * @param {string} symbol - Símbolo do par
 * @param {string} side - Lado da ordem (BUY/SELL)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function closePosition(symbol, side, accountId = 1) {
  try {
    const orderParams = {
      symbol,
      side,
      type: 'MARKET',
      closePosition: 'true'
    };
    
    const response = await newOrder(orderParams, accountId);
    console.log(\`[API] Posição \${symbol} fechada com closePosition=true\`);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao fechar posição \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Obtém preço atual de um símbolo
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Preço atual
 */
async function getPrice(symbol, accountId = 1) {
  try {
    const credentials = await loadCredentialsFromDatabase({ accountId });
    const response = await axios.get(\`\${credentials.apiUrl}/v1/ticker/price?symbol=\${symbol}\`);
    return parseFloat(response.data.price);
  } catch (error) {
    console.error(\`[API] Erro ao obter preço de \${symbol}:\`, error.message);
    throw error;
  }
}

/**
 * Atualiza brackets de alavancagem no banco de dados
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function updateLeverageBracketsInDatabase(exchange = 'binance', accountId = 1) {
  try {
    console.log(\`[API] Atualizando brackets de alavancagem para \${exchange}...\`);
    
    const db = await getDatabaseInstance(accountId);
    
    // Verificar última atualização
    const [lastUpdate] = await db.query(
      'SELECT MAX(data_atualizacao) as ultima_atualizacao FROM alavancagem_brackets WHERE exchange = ?',
      [exchange]
    );
    
    const lastUpdateTime = lastUpdate[0]?.ultima_atualizacao;
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    
    if (lastUpdateTime && new Date(lastUpdateTime) > sixHoursAgo) {
      const timeDiff = Math.round((now - new Date(lastUpdateTime)) / (1000 * 60 * 60 * 10)) / 100;
      console.log(\`[API] Última atualização de alavancagem para \${exchange} foi há \${timeDiff} horas\`);
      console.log(\`[API] Brackets de alavancagem foram atualizados recentemente. Pulando atualização.\`);
      return;
    }
    
    // Obter brackets da API
    const brackets = await getAllLeverageBrackets(null, accountId);
    
    // Limpar dados antigos
    await db.query('DELETE FROM alavancagem_brackets WHERE exchange = ?', [exchange]);
    
    // Inserir novos dados
    for (const bracket of brackets) {
      for (const levelBracket of bracket.brackets) {
        await db.query(
          \`INSERT INTO alavancagem_brackets 
           (exchange, symbol, notional_floor, notional_cap, maint_margin_ratio, cum, initial_leverage, data_atualizacao)
           VALUES (?, ?, ?, ?, ?, ?, ?, NOW())\`,
          [
            exchange,
            bracket.symbol,
            parseFloat(levelBracket.notionalFloor),
            parseFloat(levelBracket.notionalCap),
            parseFloat(levelBracket.maintMarginRatio),
            parseFloat(levelBracket.cum),
            parseInt(levelBracket.initialLeverage)
          ]
        );
      }
    }
    
    console.log(\`[API] Brackets de alavancagem atualizados com sucesso para \${exchange}\`);
  } catch (error) {
    console.error(\`[API] Erro ao atualizar brackets de alavancagem:\`, error.message);
    // Não re-throw o erro para não quebrar a inicialização
  }
}

/**
 * Obtém brackets de alavancagem do banco de dados
 * @param {string} symbol - Símbolo do par
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Brackets do banco de dados
 */
async function getLeverageBracketsFromDb(symbol, exchange = 'binance', accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    const [brackets] = await db.query(
      \`SELECT * FROM alavancagem_brackets 
       WHERE symbol = ? AND exchange = ? 
       ORDER BY notional_floor ASC\`,
      [symbol, exchange]
    );
    
    return brackets;
  } catch (error) {
    console.error(\`[API] Erro ao obter brackets do banco para \${symbol}:\`, error.message);
    return [];
  }
}

/**
 * Cancela entrada pendente
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se cancelado com sucesso
 */
async function cancelPendingEntry(symbol, accountId = 1) {
  try {
    const openOrders = await getOpenOrders(symbol, accountId);
    
    // Filtrar ordens de entrada
    const entryOrders = openOrders.filter(order => 
      order.type === 'LIMIT' && !order.reduceOnly
    );
    
    if (entryOrders.length === 0) {
      return false;
    }
    
    // Cancelar todas as ordens de entrada
    for (const order of entryOrders) {
      await cancelOrder(accountId, symbol, order.orderId);
    }
    
    console.log(\`[API] \${entryOrders.length} ordens de entrada canceladas para \${symbol}\`);
    return true;
  } catch (error) {
    console.error(\`[API] Erro ao cancelar entrada pendente para \${symbol}:\`, error.message);
    return false;
  }
}

/**
 * Verifica e corrige inconsistências de ambiente
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se correções foram feitas
 */
async function verifyAndFixEnvironmentConsistency(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Obter informações da conta e corretora
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
    
    const account = accountInfo[0];
    
    // Verificar se o ambiente da corretora está consistente com suas URLs
    const isEnvProduction = account.ambiente === 'prd';
    const hasTestnetUrls = account.futures_rest_api_url.includes('testnet') || 
                          account.futures_ws_api_url.includes('testnet') ||
                          account.futures_ws_market_url.includes('testnet');
    
    let correctionsMade = false;
    
    if (isEnvProduction && hasTestnetUrls) {
      console.log(\`[API] ⚠️ CORREÇÃO CRÍTICA: Corretora \${account.corretora} (ID: \${account.id_corretora}) 
                  está em ambiente PRODUÇÃO mas usando URLs de TESTNET\`);
      
      // Corrigir URLs para ambiente de produção
      await db.query(\`
        UPDATE corretoras 
        SET futures_rest_api_url = 'https://fapi.binance.com/fapi',
            futures_ws_market_url = 'wss://fstream.binance.com',
            futures_ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi/v1'
        WHERE id = ?\`,
        [account.id_corretora]
      );
      
      console.log(\`[API] ✅ URLs corrigidas para ambiente de PRODUÇÃO\`);
      correctionsMade = true;
    } else if (!isEnvProduction && !hasTestnetUrls) {
      console.log(\`[API] ⚠️ CORREÇÃO CRÍTICA: Corretora \${account.corretora} (ID: \${account.id_corretora}) 
                  está em ambiente TESTNET mas usando URLs de PRODUÇÃO\`);
      
      // Corrigir URLs para ambiente testnet
      await db.query(\`
        UPDATE corretoras 
        SET futures_rest_api_url = 'https://testnet.binancefuture.com/fapi',
            futures_ws_market_url = 'wss://stream.binancefuture.com',
            futures_ws_api_url = 'wss://testnet.binancefuture.com/ws-fapi/v1'
        WHERE id = ?\`,
        [account.id_corretora]
      );
      
      console.log(\`[API] ✅ URLs corrigidas para ambiente de TESTNET\`);
      correctionsMade = true;
    }
    
    // Se correções foram feitas, limpar cache
    if (correctionsMade) {
      // Limpar cache de credenciais
      accountCredentials.delete(accountId);
      lastCacheTime = 0;
      
      // Recarregar credenciais
      await loadCredentialsFromDatabase({ accountId, forceRefresh: true });
    }
    
    return correctionsMade;
  } catch (error) {
    console.error(\`[API] Erro ao verificar consistência de ambiente: \${error.message}\`);
    return false;
  }
}

module.exports = {
  getFuturesAccountBalanceDetails,
  getMaxLeverage,
  getCurrentLeverage,
  getCurrentMarginType,
  changeInitialLeverage,
  changeMarginType,
  newOrder,
  newEntryOrder,
  newLimitMakerOrder,
  editOrder,
  newReduceOnlyOrder,
  newStopOrder,
  newStopOrTpLimitOrder,
  newTakeProfitOrder,
  getTickSize,
  roundPriceToTickSize,
  getPrecision,
  getOpenOrders,
  getRecentOrders,
  getOrderStatus,
  getMultipleOrderStatus,
  getPositionDetails,
  getAllOpenPositions,
  obterSaldoPosicao,
  cancelOrder,
  transferBetweenAccounts,
  cancelAllOpenOrders,
  encerrarPosicao,
  getAllLeverageBrackets,
  setPositionMode,
  getPositionMode,
  closePosition,
  getPrice,
  updateLeverageBracketsInDatabase,
  getLeverageBracketsFromDb,
  cancelPendingEntry,
  loadCredentialsFromDatabase,
  verifyAndFixEnvironmentConsistency
};`;

    // Escrever o arquivo corrigido
    await fs.writeFile(apiPath, conteudoCompleto, 'utf8');
    console.log('✅ Arquivo api.js corrigido e recriado com todas as funções necessárias!');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir api.js:', error);
  }
}

corrigirApiCompleto();