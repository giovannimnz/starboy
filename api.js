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

// Adicione mais funções da API Binance conforme necessário

module.exports = {
  loadCredentialsFromDatabase,
  newEntryOrder,
  newLimitMakerOrder,
  editOrder,
  newOrder,
  setPositionMode,
  newReduceOnlyOrder,
  newStopOrder,
  cancelOrder,
  cancelAllOpenOrders,
  getOpenOrders,
  getOrderStatus,
  getAllOpenPositions,
  // Exporte outras funções conforme necessário
};