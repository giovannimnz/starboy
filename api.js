const axios = require("axios");
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
 * @param {number} accountId - ID da conta (padrão: 1)
 * @param {boolean} forceRefresh - Se deve forçar atualização do cache
 * @returns {Promise<Object>} - Objeto com as credenciais
 */
async function loadCredentialsFromDatabase(accountId = 1, forceRefresh = false) {
  try {
    const currentTime = Date.now();
    
    // Usar cache se disponível e não expirado, a menos que forceRefresh seja true
    if (accountCredentials.has(accountId) && !forceRefresh && (currentTime - lastCacheTime < CACHE_TTL)) {
      console.log(`[API] Usando credenciais em cache para conta ${accountId}`);
      return accountCredentials.get(accountId);
    }
    
    const db = await getDatabaseInstance();
    
    if (!db) {
      throw new Error('Não foi possível obter conexão com o banco de dados');
    }
    
    // Buscar credenciais desta conta específica
    const [rows] = await db.query(`
      SELECT 
        api_key, 
        api_secret, 
        ws_api_key, 
        ws_api_secret, 
        api_url, 
        ws_url, 
        ws_api_url 
      FROM contas WHERE id = ? AND ativa = 1`,
      [accountId]
    );
    
    if (rows.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }

    const credentials = {
      apiKey: rows[0].api_key,
      apiSecret: rows[0].api_secret,
      wsApiKey: rows[0].ws_api_key,
      wsApiSecret: rows[0].ws_api_secret,
      apiUrl: rows[0].api_url || process.env.API_URL || 'https://fapi.binance.com/fapi',
      wsUrl: rows[0].ws_url || process.env.WS_URL || 'wss://fstream.binance.com/ws',
      wsApiUrl: rows[0].ws_api_url || process.env.WS_API_URL || 'wss://ws-fapi.binance.com/ws-fapi',
      apiUrlSpot: (rows[0].api_url || process.env.API_URL || 'https://fapi.binance.com/fapi').replace('/fapi', '/sapi')
    };
    
    // Armazenar no cache
    accountCredentials.set(accountId, credentials);
    lastCacheTime = currentTime;
    
    console.log(`[API] Credenciais carregadas do banco de dados para conta ${accountId}`);
    return credentials;
  } catch (error) {
    console.error(`[API] Erro ao carregar credenciais para conta ${accountId}:`, error.message);
    throw error;
  }
}

async function newEntryOrder(accountId, symbol, quantity, side) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Enviando ordem: ${symbol}, ${quantity}, ${side} (Conta ${accountId})`);
    
    // Validar quantidade
    if (quantity <= 0 || isNaN(quantity)) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }
    
    const data = {
      symbol,
      side,
      type: "MARKET",
      quantity,
      newOrderRespType: "RESULT"
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    console.log(`[API] Enviando ordem de entrada a mercado: ${symbol}, ${quantity}, ${side}`);
    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da ordem: ${JSON.stringify(result.data)}`);

    const avgPrice = result.data.avgPrice
      ? parseFloat(result.data.avgPrice)
      : result.data.fills && result.data.fills.length > 0
        ? parseFloat(result.data.fills[0].price)
        : null;

    return {
      orderId: result.data.orderId,
      executedQty: result.data.executedQty,
      cummulativeQuoteQty: result.data.cummulativeQuoteQty,
      price: avgPrice
    };
  } catch (error) {
    console.error(`[API] ERRO DETALHADO ao criar ordem de entrada a mercado:`);
    console.error(`[API] Mensagem: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function newLimitMakerOrder(accountId, symbol, quantity, side, price) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Enviando ordem LIMIT MAKER (Conta ${accountId}): ${symbol}, ${quantity}, ${side}, ${price}`);
    
    // Validações
    if (quantity <= 0 || isNaN(quantity)) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }
    
    if (price <= 0 || isNaN(price)) {
      throw new Error(`Preço inválido: ${price}`);
    }

    const data = {
      symbol,
      side,
      type: "LIMIT_MAKER",
      quantity,
      price,
      newOrderRespType: "RESULT",
      timeInForce: "GTX"
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da ordem LIMIT MAKER: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] ERRO DETALHADO ao criar ordem LIMIT MAKER:`, error.message);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

/**
 * Edita uma ordem existente, ou cancela e recria caso esteja parcialmente preenchida
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
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Editando ordem ${orderId} para ${symbol} (Conta ${accountId}) com novo preço: ${newPrice}`);
    
    // 1. Verificar status atual da ordem
    const orderStatus = await getOrderStatus(accountId, symbol, orderId);
    
    // Se a ordem já foi completamente preenchida ou não existe, não prosseguir
    if (orderStatus === 'FILLED' || orderStatus === 'CANCELED' || orderStatus === null) {
      throw new Error(`Não é possível editar ordem com status ${orderStatus || 'inexistente'}`);
    }
    
    // Se a ordem está parcialmente preenchida
    if (orderStatus === 'PARTIALLY_FILLED') {
      if (!retryIfPartiallyFilled) {
        throw new Error('Ordem parcialmente preenchida, não será editada');
      }
      
      // Cancelar a ordem atual
      console.log(`[API] Ordem ${orderId} está parcialmente preenchida. Cancelando para recriar...`);
      await cancelOrder(accountId, symbol, orderId);
      
      // Obter detalhes para criar nova ordem
      const orderDetails = await getOrderDetails(accountId, symbol, orderId);
      const remainingQty = parseFloat(orderDetails.origQty) - parseFloat(orderDetails.executedQty);
      
      // Criar nova ordem com a quantidade restante e novo preço
      const newOrder = await newLimitMakerOrder(accountId, symbol, remainingQty, side, newPrice);
      console.log(`[API] Nova ordem criada após cancelamento: ${JSON.stringify(newOrder.data)}`);
      return newOrder;
    }
    
    // Para ordens com status NEW, prosseguir com edição normal
    // Obter quantidade da ordem original se não foi especificada
    if (quantity === null) {
      const orderDetails = await getOrderDetails(accountId, symbol, orderId);
      quantity = parseFloat(orderDetails.origQty);
    }
    
    // 2. Enviar requisição de edição
    const data = {
      symbol,
      orderId,
      price: newPrice
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "PUT",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Ordem ${orderId} editada com sucesso para novo preço: ${newPrice}`);
    return result;
  } catch (error) {
    console.error(`[API] Erro ao editar ordem: ${error.message}`);
    console.error(`[API] Detalhes:`, error.response ? JSON.stringify(error.response.data) : 'Sem resposta');
    throw error;
  }
}

// Função auxiliar para obter detalhes de uma ordem
async function getOrderDetails(accountId, symbol, orderId) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const data = {
      symbol,
      orderId
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "GET",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    return result.data;
  } catch (error) {
    console.error(`[API] Erro ao obter detalhes da ordem: ${error.message}`);
    throw error;
  }
}

async function newOrder(accountId, symbol, quantity, side, price, type = 'LIMIT', reduceOnly = false) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Nova ordem: ${symbol}, ${side}, ${type}, ${quantity}, ${price}, reduceOnly=${reduceOnly}`);
    
    // Validações
    if (quantity <= 0 || isNaN(quantity)) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }

    const data = {
      symbol,
      side,
      type,
      quantity,
      price,
      newOrderRespType: "RESULT",
      timeInForce: "GTC"
    };

    // Adicionar reduceOnly se necessário
    if (reduceOnly) {
      data.reduceOnly = true;
    }

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da nova ordem: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] ERRO ao criar nova ordem:`, error.message);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function setPositionMode(accountId, dualSidePosition) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const dualSide = dualSidePosition ? 'true' : 'false';
    console.log(`[API] Configurando modo de posição: dualSidePosition=${dualSide}`);

    const data = {
      dualSidePosition: dualSide
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/positionSide/dual${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Modo de posição configurado com sucesso: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] Erro ao configurar modo de posição: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function newReduceOnlyOrder(accountId, symbol, quantity, side, price) {
  try {
    return await newOrder(accountId, symbol, quantity, side, price, 'LIMIT', true);
  } catch (error) {
    console.error(`[API] Erro ao criar ordem reduceOnly: ${error.message}`);
    throw error;
  }
}

async function newStopOrder(accountId, symbol, quantity, side, stopPrice, price = null, reduceOnly = false, closePosition = false) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Nova ordem STOP: ${symbol}, ${side}, ${quantity}, stopPrice=${stopPrice}, price=${price || 'N/A'}, reduceOnly=${reduceOnly}, closePosition=${closePosition}`);
    
    // Validações
    if (quantity <= 0 && !closePosition) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }

    const data = {
      symbol,
      side,
      type: closePosition ? 'STOP_MARKET' : (price ? 'STOP' : 'STOP_MARKET'),
      stopPrice,
      newOrderRespType: "RESULT",
      timeInForce: price ? "GTC" : undefined
    };

    // Verificar se é closePosition ou quantidade normal
    if (closePosition) {
      data.closePosition = true;
    } else {
      data.quantity = quantity;
      if (price) {
        data.price = price;
      }
    }

    // Adicionar reduceOnly se necessário
    if (reduceOnly) {
      data.reduceOnly = true;
    }

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da ordem STOP: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] ERRO ao criar ordem STOP:`, error.message);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getOrderStatus(accountId, symbol, orderId) {
  try {
    const orderDetails = await getOrderDetails(accountId, symbol, orderId);
    return orderDetails.status;
  } catch (error) {
    if (error.response && error.response.status === 404) {
      return null;
    }
    console.error(`[API] Erro ao obter status da ordem: ${error.message}`);
    throw error;
  }
}

async function cancelOrder(accountId, symbol, orderId) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Cancelando ordem: ${symbol}, ${orderId}`);

    const data = {
      symbol,
      orderId
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "DELETE",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Ordem cancelada com sucesso: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] Erro ao cancelar ordem: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function cancelAllOpenOrders(accountId, symbol) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Cancelando todas as ordens abertas para: ${symbol}`);

    const data = { symbol };
    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "DELETE",
      url: `${credentials.apiUrl}/v1/allOpenOrders${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Todas as ordens abertas canceladas com sucesso para ${symbol}`);
    return result.data;
  } catch (error) {
    console.error(`[API] Erro ao cancelar todas as ordens abertas: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getOpenOrders(accountId, symbol = null) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Obtendo ordens abertas${symbol ? ` para: ${symbol}` : ''}`);

    const data = symbol ? { symbol } : {};
    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "GET",
      url: `${credentials.apiUrl}/v1/openOrders${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    return result.data;
  } catch (error) {
    console.error(`[API] Erro ao obter ordens abertas: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getAllOpenPositions(accountId) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");
    
    const url = `${credentials.apiUrl}/v2/positionRisk?timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    // Filtrar posições com quantidade diferente de zero
    const openPositions = response.data
      .filter(position => parseFloat(position.positionAmt) !== 0)
      .map(position => ({
        simbolo: position.symbol,
        quantidade: Math.abs(parseFloat(position.positionAmt)),
        preco_entrada: parseFloat(position.entryPrice),
        side: parseFloat(position.positionAmt) > 0 ? 'BUY' : 'SELL',
        leverage: parseInt(position.leverage, 10)
      }));
    
    //console.log(`[API] Posições abertas encontradas: ${openPositions.length}`);
    return openPositions;
  } catch (error) {
    console.error(`[API] Erro ao obter posições abertas: ${error.message}`);
    throw error;
  }
}


async function obterSaldoPosicao(accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Obtendo saldo da posição (Conta ${accountId})...`);

    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");

    const result = await axios({
      method: "GET",
      url: `${credentials.apiUrl}/v2/balance?timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    return result.data;
  } catch (error) {
    console.error('[API] Erro ao obter saldo da posição:', error.message);
    throw error;
  }
}

async function getFuturesAccountBalanceDetails(accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");

    const result = await axios({
      method: "GET",
      url: `${credentials.apiUrl}/v2/balance?timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    // Localizar a entrada para USDT
    const usdtBalance = result.data.find(balance => balance.asset === 'USDT');
    if (usdtBalance) {
      return {
        walletBalance: parseFloat(usdtBalance.balance),
        availableBalance: parseFloat(usdtBalance.availableBalance),
        marginBalance: parseFloat(usdtBalance.balance),
        unrealizedProfit: parseFloat(usdtBalance.crossUnPnl || 0)
      };
    } else {
      throw new Error('Não foi possível encontrar saldo USDT');
    }
  } catch (error) {
    console.error('[API] Erro ao obter detalhes do saldo da conta:', error.message);
    throw error;
  }
}

async function getPrecision(symbol, accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);

    const response = await axios.get(`${credentials.apiUrl}/v1/exchangeInfo`);
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

    if (!symbolInfo) {
      throw new Error(`Símbolo ${symbol} não encontrado`);
    }

    // Nos contratos futuros, a precisão da quantidade é baseada no quantityPrecision
    const quantityPrecision = symbolInfo.quantityPrecision || 4;
    return {
      quantityPrecision,
      pricePrecision: symbolInfo.pricePrecision || 4
    };
  } catch (error) {
    console.error(`[API] Erro ao obter precisão para ${symbol}:`, error.message);
    throw error;
  }
}

async function getTickSize(symbol, accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);

    const response = await axios.get(`${credentials.apiUrl}/v1/exchangeInfo`);
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);

    if (!symbolInfo) {
      throw new Error(`Símbolo ${symbol} não encontrado`);
    }

    // Encontrar a regra de filtro para o tick size
    const priceFilter = symbolInfo.filters.find(filter => filter.filterType === 'PRICE_FILTER');
    if (!priceFilter) {
      throw new Error(`Filtro de preço não encontrado para ${symbol}`);
    }

    // Retornar o tick size
    return parseFloat(priceFilter.tickSize);
  } catch (error) {
    console.error(`[API] Erro ao obter tick size para ${symbol}:`, error.message);
    throw error;
  }
}

function roundPriceToTickSize(price, tickSize) {
  if (!tickSize) {
    return price;
  }
  
  // Converter o tick size para um múltiplo de 10
  const precision = tickSize.toString().includes('.') 
    ? tickSize.toString().split('.')[1].length 
    : 0;
  
  // Arredondar para o tick size mais próximo
  const roundedPrice = Math.round(price / tickSize) * tickSize;
  
  // Formatar para a precisão correta
  return parseFloat(roundedPrice.toFixed(precision));
}

async function changeInitialLeverage(accountId, symbol, leverage) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Alterando alavancagem para ${symbol}: ${leverage} (Conta ${accountId})`);

    const data = {
      symbol,
      leverage
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/leverage${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Alavancagem alterada para ${result.data.leverage}`);
    return result.data;
  } catch (error) {
    console.error('[API] Erro ao alterar alavancagem:', error.message);
    if (error.response) {
      console.error('[API] Status:', error.response.status);
      console.error('[API] Dados:', JSON.stringify(error.response.data));
    }
    throw error;
  }
}

async function changeMarginType(accountId, symbol, marginType) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Alterando tipo de margem para ${symbol}: ${marginType} (Conta ${accountId})`);

    const data = {
      symbol,
      marginType
    };

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/marginType${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Tipo de margem alterado para ${marginType}`);
    return result.data;
  } catch (error) {
    // Se o erro for que a posição já está nesse modo de margem, não é realmente um erro
    if (error.response && 
        error.response.data && 
        (error.response.data.code === -4046 || error.response.data.msg.includes('already'))) {
      console.log(`[API] Posição ${symbol} já está no tipo de margem ${marginType}`);
      return { code: 0, msg: `Already ${marginType}` };
    }
    
    console.error(`[API] Erro ao alterar tipo de margem para ${symbol}:`, error.message);
    if (error.response) {
      console.error('[API] Status:', error.response.status);
      console.error('[API] Dados:', JSON.stringify(error.response.data));
    }
    throw error;
  }
}

async function getCurrentMarginType(accountId, symbol) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Obtendo tipo de margem atual para ${symbol} (Conta ${accountId})...`);

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");

    const qs = `?symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`;

    const result = await axios({
      method: "GET",
      url: `${credentials.apiUrl}/v1/positionRisk${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    // A API devolve todas as posições, encontrar a correspondente ao símbolo
    const position = result.data.find(p => p.symbol === symbol);
    
    if (!position) {
      throw new Error(`Dados da posição não encontrados para ${symbol}`);
    }

    // A propriedade marginType é 'isolated' ou 'cross'
    const marginType = position.marginType;
    console.log(`[API] Tipo de margem atual para ${symbol}: ${marginType}`);
    
    return marginType;
  } catch (error) {
    console.error('[API] Erro ao obter tipo de margem atual:', error.message);
    throw error;
  }
}

async function cancelPendingEntry(accountId, symbol) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Cancelando ordens pendentes para ${symbol} (Conta ${accountId})...`);

    // Listar ordens abertas para este símbolo
    const openOrders = await getOpenOrders(accountId, symbol);
    
    if (!openOrders || openOrders.length === 0) {
      console.log(`[API] Nenhuma ordem aberta encontrada para ${symbol}`);
      return [];
    }
    
    console.log(`[API] Encontradas ${openOrders.length} ordens abertas para ${symbol}`);
    
    // Filtrar apenas ordens de entrada (não stop-loss, take-profit)
    const entryOrders = openOrders.filter(order => 
      order.type === 'LIMIT' || 
      order.type === 'LIMIT_MAKER' || 
      order.type === 'MARKET' || 
      (order.type === 'STOP' && !order.reduceOnly) || 
      (order.type === 'STOP_MARKET' && !order.reduceOnly)
    );
    
    if (entryOrders.length === 0) {
      console.log(`[API] Nenhuma ordem de entrada pendente encontrada para ${symbol}`);
      return [];
    }
    
    console.log(`[API] Encontradas ${entryOrders.length} ordens de entrada para cancelar em ${symbol}`);
    
    // Cancelar cada ordem de entrada
    const cancelPromises = entryOrders.map(order => 
      cancelOrder(accountId, symbol, order.orderId)
        .then(result => ({
          success: true,
          orderId: order.orderId,
          result
        }))
        .catch(error => ({
          success: false,
          orderId: order.orderId,
          error: error.message
        }))
    );
    
    const results = await Promise.all(cancelPromises);
    
    // Contar sucessos e falhas
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;
    
    console.log(`[API] Cancelamento concluído: ${successCount} sucesso, ${failCount} falha`);
    
    return results;
  } catch (error) {
    console.error(`[API] Erro ao cancelar ordens pendentes para ${symbol}:`, error.message);
    throw error;
  }
}

async function getPositionDetails(accountId, symbol) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");
    
    const url = `${credentials.apiUrl}/v2/positionRisk?symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    if (response.data && Array.isArray(response.data)) {
      // Verificar se há posição para este símbolo
      const positionInfo = response.data.find(p => 
        p.symbol === symbol && parseFloat(p.positionAmt) !== 0
      );
      
      if (positionInfo) {
        return {
          symbol: positionInfo.symbol,
          positionAmt: parseFloat(positionInfo.positionAmt),
          entryPrice: parseFloat(positionInfo.entryPrice),
          leverage: parseInt(positionInfo.leverage, 10),
          markPrice: parseFloat(positionInfo.markPrice),
          unRealizedProfit: parseFloat(positionInfo.unRealizedProfit),
          liquidationPrice: parseFloat(positionInfo.liquidationPrice),
          marginType: positionInfo.marginType,
          side: parseFloat(positionInfo.positionAmt) > 0 ? 'BUY' : 'SELL'
        };
      }
    }
    
    // Se não encontrou posição ou posição com quantidade zero
    return null;
  } catch (error) {
    console.error(`[API] Erro ao obter detalhes da posição para ${symbol}:`, error.message);
    throw error;
  }
}

async function getRecentOrders(accountId, symbol, limit = 10) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const queryParams = {
      symbol,
      limit,
      timestamp,
      recvWindow
    };
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(new URLSearchParams(queryParams).toString())
      .digest("hex");
    
    queryParams.signature = signature;
    
    const url = `${credentials.apiUrl}/v1/allOrders?${new URLSearchParams(queryParams).toString()}`;
    
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    return response.data;
  } catch (error) {
    console.error(`[API] Erro ao obter ordens recentes para ${symbol}:`, error.message);
    throw error;
  }
}

async function getAllLeverageBrackets(accountId) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");
    
    const url = `${credentials.apiUrl}/v1/leverageBracket?timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    return response.data;
  } catch (error) {
    console.error('[API] Erro ao obter informações de alavancagem:', error.message);
    throw error;
  }
}

async function updateLeverageBracketsInDatabase(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error('Falha ao obter instância do banco de dados');
    }

    // Obter todas as informações de alavancagem da Binance
    const leverageBrackets = await getAllLeverageBrackets(accountId);
    
    console.log(`[API] Atualizando informações de alavancagem para ${leverageBrackets.length} símbolos...`);

    // Começar uma transação para garantir consistência
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // Para cada símbolo
      for (const bracketInfo of leverageBrackets) {
        const symbol = bracketInfo.symbol;

        // Para cada nível de alavancagem
        for (let i = 0; i < bracketInfo.brackets.length; i++) {
          const bracket = bracketInfo.brackets[i];
          
          // Verificar se já existe este nível para este símbolo
          const [existing] = await connection.query(
            `SELECT id FROM leverage_brackets 
             WHERE symbol = ? AND bracket_id = ? AND conta_id = ?`,
            [symbol, i, accountId]
          );
          
          if (existing.length > 0) {
            // Atualizar se já existir
            await connection.query(
              `UPDATE leverage_brackets 
               SET initial_leverage = ?, notional_cap = ?, notional_floor = ?, maint_margin_ratio = ?, cum = ? 
               WHERE symbol = ? AND bracket_id = ? AND conta_id = ?`,
              [
                bracket.initialLeverage,
                bracket.notionalCap,
                bracket.notionalFloor,
                bracket.maintMarginRatio,
                bracket.cum || 0,
                symbol,
                i,
                accountId
              ]
            );
          } else {
            // Inserir novo se não existir
            await connection.query(
              `INSERT INTO leverage_brackets 
               (symbol, bracket_id, initial_leverage, notional_cap, notional_floor, maint_margin_ratio, cum, conta_id) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                symbol,
                i,
                bracket.initialLeverage,
                bracket.notionalCap,
                bracket.notionalFloor,
                bracket.maintMarginRatio,
                bracket.cum || 0,
                accountId
              ]
            );
          }
        }
      }

      // Completar a transação
      await connection.commit();
      console.log(`[API] Alavancagens atualizadas com sucesso no banco de dados`);
      
    } catch (error) {
      await connection.rollback();
      console.error('[API] Erro durante atualização de alavancagens:', error);
      throw error;
    } finally {
      connection.release();
    }

    return { success: true, count: leverageBrackets.length };
  } catch (error) {
    console.error('[API] Erro ao atualizar alavancagens no banco:', error.message);
    throw error;
  }
}

/**
 * Obtém informações de alavancagem do banco para um símbolo específico
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo para consultar (ex: BTCUSDT)
 * @returns {Promise<Array>} - Array de brackets para o símbolo
 */
async function getLeverageBracketsFromDb(accountId = 1, symbol) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error('Não foi possível conectar ao banco de dados');
    }

    // Verificar se o símbolo existe no banco
    const [rows] = await db.query(`
      SELECT * FROM leverage_brackets 
      WHERE symbol = ? AND conta_id = ?
      ORDER BY bracket_id ASC
    `, [symbol, accountId]);

    // Se não encontrar dados para o símbolo, tentar atualizar o banco
    if (rows.length === 0) {
      console.log(`[API] Não foram encontrados dados de alavancagem para ${symbol} na conta ${accountId}, atualizando banco...`);
      await updateLeverageBracketsInDatabase(accountId);

      // Consultar novamente após atualização
      const [updatedRows] = await db.query(`
        SELECT * FROM leverage_brackets 
        WHERE symbol = ? AND conta_id = ?
        ORDER BY bracket_id ASC
      `, [symbol, accountId]);

      // Mapear para o formato esperado pelo sistema
      return formatBracketsFromDb(updatedRows);
    }

    // Mapear para o formato esperado pelo sistema
    return formatBracketsFromDb(rows);
  } catch (error) {
    console.error(`[API] Erro ao obter dados de alavancagem para ${symbol} (Conta ${accountId}):`, error.message);
    throw error;
  }
}


/**
 * Formata dados do banco para o formato esperado pelo sistema
 * @param {Array} dbRows - Linhas do banco de dados
 * @returns {Array} - Dados formatados
 */
function formatBracketsFromDb(dbRows) {
  if (!dbRows || dbRows.length === 0) return [];

  // Agrupar por símbolo
  const symbolsMap = {};

  for (const row of dbRows) {
    if (!symbolsMap[row.symbol]) {
      symbolsMap[row.symbol] = {
        symbol: row.symbol,
        brackets: []
      };
    }

    symbolsMap[row.symbol].brackets.push({
      bracket: row.bracket_id,
      initialLeverage: row.initial_leverage,
      notionalCap: parseFloat(row.notional_cap),
      notionalFloor: parseFloat(row.notional_floor),
      maintMarginRatio: parseFloat(row.maint_margin_ratio),
      cum: parseFloat(row.cum || 0)
    });
  }

  // Converter o mapa em array
  return Object.values(symbolsMap);
}

async function syncAccountBalance(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error('Falha ao obter instância do banco de dados');
    }
    
    // Obter saldo atual da exchange
    const balanceDetails = await getFuturesAccountBalanceDetails(accountId);
    
    if (!balanceDetails) {
      throw new Error('Não foi possível obter detalhes do saldo da conta');
    }
    
    console.log(`[API] Saldo recebido da Exchange (Conta ${accountId}): ${balanceDetails.walletBalance} USDT`);
    
    // Verificar se já existe um registro para esta conta
    const [rows] = await db.query(
      'SELECT id FROM contas WHERE id = ?', 
      [accountId]
    );
    
    const currentDateTime = new Date();
    
    if (rows.length === 0) {
      console.error(`[API] Conta ID ${accountId} não encontrada no banco de dados`);
      return null;
    }
    
    // Atualizar o registro existente
    const [result] = await db.query(
      `UPDATE contas 
       SET saldo = ?, 
           saldo_nao_realizado = ?, 
           ultima_atualizacao = ? 
       WHERE id = ?`,
      [
        balanceDetails.walletBalance,
        balanceDetails.unrealizedProfit,
        currentDateTime,
        accountId
      ]
    );
    
    console.log(`[API] Saldo atualizado para conta ${accountId}: ${balanceDetails.walletBalance} USDT`);
    
    // Buscar o saldo após atualização
    const [updatedAccount] = await db.query(
      'SELECT saldo, saldo_base_calculo FROM contas WHERE id = ?',
      [accountId]
    );
    
    if (updatedAccount.length === 0) {
      throw new Error(`Falha ao buscar conta ${accountId} após atualização`);
    }
    
    return {
      saldo: parseFloat(updatedAccount[0].saldo),
      saldo_base_calculo: parseFloat(updatedAccount[0].saldo_base_calculo || updatedAccount[0].saldo)
    };
  } catch (error) {
    console.error(`[API] Erro ao sincronizar saldo da conta ${accountId}:`, error.message);
    throw error;
  }
}

async function getMaxLeverage(accountId = 1, symbol, notionalValue) {
  try {
    // Obter brackets para este símbolo
    const brackets = await getLeverageBracketsFromDb(accountId, symbol);
    
    if (!brackets || !brackets[0] || !brackets[0].brackets) {
      console.error(`[API] Não foi possível encontrar brackets para ${symbol}`);
      return 20; // Valor padrão seguro
    }
    
    // Localizar o bracket apropriado com base no notionalValue
    const leverageBrackets = brackets[0].brackets;
    for (let i = 0; i < leverageBrackets.length; i++) {
      const bracket = leverageBrackets[i];
      if (notionalValue >= bracket.notionalFloor && notionalValue <= bracket.notionalCap) {
        return bracket.initialLeverage;
      }
    }
    
    // Se não encontrar um bracket específico, retornar o mais conservador
    const lastBracket = leverageBrackets[leverageBrackets.length - 1];
    return lastBracket ? lastBracket.initialLeverage : 20;
  } catch (error) {
    console.error(`[API] Erro ao obter alavancagem máxima para ${symbol}:`, error.message);
    return 20; // Valor padrão seguro em caso de erro
  }
}

async function getCurrentLeverage(accountId = 1, symbol) {
  try {
    const position = await getPositionDetails(accountId, symbol);
    return position ? position.leverage : null;
  } catch (error) {
    console.error(`[API] Erro ao obter alavancagem atual para ${symbol}:`, error.message);
    throw error;
  }
}

async function getPositionMode(accountId = 1) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`timestamp=${timestamp}&recvWindow=${recvWindow}`)
      .digest("hex");
    
    const url = `${credentials.apiUrl}/v1/positionSide/dual?timestamp=${timestamp}&recvWindow=${recvWindow}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    return response.data.dualSidePosition;
  } catch (error) {
    console.error(`[API] Erro ao obter modo de posição para conta ${accountId}:`, error.message);
    throw error;
  }
}

async function transferBetweenAccounts(accountId = 1, asset, amount, fromType, toType) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Transferindo ${amount} ${asset} de ${fromType} para ${toType} (Conta ${accountId})...`);
    
    const data = {
      asset,
      amount,
      type: 1, // 1: transfer from spot to futures
      fromAccountType: fromType, // 'SPOT', 'USDT_FUTURE', 'COIN_FUTURE'
      toAccountType: toType // 'SPOT', 'USDT_FUTURE', 'COIN_FUTURE'
    };
    
    const timestamp = Date.now();
    const recvWindow = 60000;
    
    const queryString = new URLSearchParams({
      ...data,
      timestamp,
      recvWindow
    }).toString();
    
    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(queryString)
      .digest("hex");
    
    const url = `${credentials.apiUrlSpot}/v1/futures/transfer?${queryString}&signature=${signature}`;
    
    const response = await axios.post(url, null, {
      headers: {
        "X-MBX-APIKEY": credentials.apiKey
      }
    });
    
    console.log(`[API] Transferência concluída: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error(`[API] Erro na transferência: ${error.message}`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getPrice(accountId = 1, symbol) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    const url = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    const response = await axios.get(url);
    
    if (response.data && response.data.price) {
      return parseFloat(response.data.price);
    } else {
      throw new Error(`Preço para ${symbol} não disponível`);
    }
  } catch (error) {
    console.error(`[API] Erro ao obter preço para ${symbol}:`, error.message);
    throw error;
  }
}

async function newStopOrTpLimitOrder(accountId = 1, symbol, quantity, side, stopPrice, limitPrice, reduceOnly = true, closePosition = false) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Nova ordem STOP_LIMIT: ${symbol}, ${side}, ${quantity}, stopPrice=${stopPrice}, limitPrice=${limitPrice}, reduceOnly=${reduceOnly}, closePosition=${closePosition}`);
    
    // Validações
    if (quantity <= 0 && !closePosition) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }
    
    if (!stopPrice || !limitPrice) {
      throw new Error('stopPrice e limitPrice são obrigatórios para ordens STOP_LIMIT');
    }

    const data = {
      symbol,
      side,
      type: 'STOP',
      timeInForce: 'GTC',
      price: limitPrice,
      stopPrice,
      newOrderRespType: 'RESULT'
    };

    // Verificar se é closePosition ou quantidade normal
    if (closePosition) {
      data.closePosition = true;
    } else {
      data.quantity = quantity;
    }

    // Adicionar reduceOnly se necessário
    if (reduceOnly) {
      data.reduceOnly = true;
    }

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da ordem STOP_LIMIT: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] ERRO ao criar ordem STOP_LIMIT:`, error.message);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function newTakeProfitOrder(accountId = 1, symbol, quantity, side, stopPrice, reduceOnly = true, closePosition = false) {
  try {
    // Obter credenciais da conta específica
    const credentials = await loadCredentialsFromDatabase(accountId);
    
    console.log(`[API] Nova ordem TAKE_PROFIT: ${symbol}, ${side}, ${quantity}, stopPrice=${stopPrice}, reduceOnly=${reduceOnly}, closePosition=${closePosition}`);
    
    // Validações
    if (quantity <= 0 && !closePosition) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }

    const data = {
      symbol,
      side,
      type: 'TAKE_PROFIT_MARKET',
      stopPrice,
      newOrderRespType: 'RESULT'
    };

    // Verificar se é closePosition ou quantidade normal
    if (closePosition) {
      data.closePosition = true;
    } else {
      data.quantity = quantity;
    }

    // Adicionar reduceOnly se necessário
    if (reduceOnly) {
      data.reduceOnly = true;
    }

    const timestamp = Date.now();
    const recvWindow = 60000;

    const signature = crypto
      .createHmac("sha256", credentials.apiSecret)
      .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
      .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    const result = await axios({
      method: "POST",
      url: `${credentials.apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": credentials.apiKey },
    });

    console.log(`[API] Resposta da ordem TAKE_PROFIT: ${JSON.stringify(result.data)}`);
    return result;
  } catch (error) {
    console.error(`[API] ERRO ao criar ordem TAKE_PROFIT:`, error.message);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

async function getMultipleOrderStatus(accountId = 1, symbol, orderIds) {
  try {
    if (!Array.isArray(orderIds) || orderIds.length === 0) {
      return [];
    }
    
    // Criar array de promises para as consultas de status
    const statusPromises = orderIds.map(orderId => 
      getOrderStatus(accountId, symbol, orderId)
        .then(status => ({ orderId, status }))
        .catch(error => ({ orderId, status: null, error: error.message }))
    );
    
    // Executar todas as promises em paralelo
    return await Promise.all(statusPromises);
  } catch (error) {
    console.error(`[API] Erro ao obter status de múltiplas ordens: ${error.message}`);
    throw error;
  }
}

async function closePosition(accountId = 1, symbol, leverageLevel = null) {
  try {
    // Obter detalhes da posição
    const position = await getPositionDetails(accountId, symbol);
    
    if (!position || position.positionAmt === 0) {
      console.log(`[API] Sem posição aberta para ${symbol}`);
      return { success: false, message: 'Sem posição para fechar' };
    }
    
    // Determinar o lado da ordem para fechar (oposto à posição atual)
    const closingSide = position.positionAmt > 0 ? 'SELL' : 'BUY';
    const quantity = Math.abs(position.positionAmt);
    
    // Alternar para a alavancagem especificada, se fornecida
    if (leverageLevel !== null) {
      await changeInitialLeverage(accountId, symbol, leverageLevel);
    }
    
    // Criar ordem de mercado para fechar a posição
    const result = await newEntryOrder(accountId, symbol, quantity, closingSide);
    
    console.log(`[API] Posição fechada para ${symbol}: ${JSON.stringify(result)}`);
    return { success: true, result };
  } catch (error) {
    console.error(`[API] Erro ao fechar posição para ${symbol}:`, error.message);
    throw error;
  }
}

async function encerrarPosicao(accountId = 1, posicao) {
  try {
    const { simbolo, side, quantidade, leverage } = posicao;
    
    // Determinar o lado da ordem de encerramento (oposto ao da posição)
    const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
    
    // Usar a função closePosition
    const result = await closePosition(accountId, simbolo, leverage);
    
    // Se o fechamento foi bem-sucedido, atualizar o status da posição no banco
    if (result.success) {
      const db = await getDatabaseInstance(accountId);
      if (db) {
        try {
          await db.query(
            `UPDATE posicoes SET status = 'CLOSED', data_hora_fechamento = ? WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
            [new Date(), simbolo, accountId]
          );
        } catch (dbError) {
          console.error(`[API] Erro ao atualizar status da posição no banco:`, dbError.message);
        }
      }
    }
    
    return result;
  } catch (error) {
    console.error(`[API] Erro ao encerrar posição:`, error.message);
    throw error;
  }
}

// Função load_leverage_brackets atualizada para usar o accountId
function load_leverage_brackets(accountId = 1, symbol = null) {
  return getLeverageBracketsFromDb(accountId, symbol);
}

// Cancelamento de entrada pendente adaptado para multi-conta
async function cancelPendingEntry(accountId = 1, db, positionId, status, reason) {
  try {
    console.log(`[MONITOR] Cancelando entrada pendente ID ${positionId}: ${status} - ${reason} (Conta ${accountId})`);
    
    if (!db) {
      db = await getDatabaseInstance(accountId);
    }
    
    // 1. Obter informações para notificação antes de mover a posição
    const [webhookInfo] = await db.query(`
      SELECT w.id as webhook_id, w.chat_id, p.simbolo as symbol 
      FROM webhook_signals w
      JOIN posicoes p ON w.position_id = p.id
      WHERE w.position_id = ? AND p.conta_id = ? LIMIT 1
    `, [positionId, accountId]);
    
    if (webhookInfo.length === 0) {
      console.error(`[MONITOR] Não foi possível encontrar informações do webhook para posição ${positionId} na conta ${accountId}`);
      return false;
    }
    
    // 2. Atualizar status no webhook_signals ANTES de mover a posição
    await db.query(`
      UPDATE webhook_signals
      SET status = 'CANCELED',
          error_message = ?
      WHERE id = ?
    `, [reason, webhookInfo[0].webhook_id]);
    
    // 3. Mover posição para histórico
    await movePositionToHistory(db, positionId, 'CANCELED', reason, accountId);
    
    // 4. Enviar notificação ao Telegram se chat_id estiver disponível
    const telegramBot = getTelegramBot(accountId);
    if (webhookInfo[0].chat_id && telegramBot) {
      try {
        await telegramBot.telegram.sendMessage(webhookInfo[0].chat_id,
          `⚠️ Ordem para ${webhookInfo[0].symbol} CANCELADA ⚠️\n\n` +
          `Motivo: ${reason}`
        );
      } catch (telegramError) {
        console.error(`[MONITOR] Erro ao enviar notificação Telegram:`, telegramError);
      }
    }
    
    return true;
  } catch (error) {
    console.error(`[MONITOR] Erro ao cancelar entrada pendente: ${error.message}`);
    return false;
  }
}

// Atualizar função load_leverage_brackets para usar o banco de dados
//function load_leverage_brackets(accountId = 1, symbol = null) {
//  return getLeverageBracketsFromDb(accountId, symbol);
//}

// Modificar o module.exports para incluir as novas funções
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
  closePosition, // Adicione a nova função aqui
  getPrice, // Adicione a função getPrice
  updateLeverageBracketsInDatabase, // Adicione a função updateLeverageBracketsInDatabase
  getLeverageBracketsFromDb, // Adicione a função getLeverageBracketsFromDb
  load_leverage_brackets, // Adicione a função load_leverage_brackets
  cancelPendingEntry,
  loadCredentialsFromDatabase
};