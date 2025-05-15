const axios = require("axios");
const crypto = require("crypto");
require('dotenv').config();

const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;
const apiUrl = process.env.API_URL;
const apiUrlSpot = process.env.API_URL_SPOT;

async function newEntryOrder(symbol, quantity, side) {
  const data = {
    symbol,
    side,
    type: "MARKET",
    quantity,
    newOrderRespType: "RESULT" // Isso garante que o preço de execução seja retornado
  };

  const timestamp = Date.now();
  const recvWindow = 60000;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
    .digest("hex");

  const newData = { ...data, timestamp, recvWindow, signature };
  const qs = `?${new URLSearchParams(newData).toString()}`;

  const result = await axios({
    method: "POST",
    url: `${apiUrl}/v1/order${qs}`,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  return {
    orderId: result.data.orderId,
    executedQty: result.data.executedQty,
    cummulativeQuoteQty: result.data.cummulativeQuoteQty,
    price: result.data.avgPrice ? result.data.avgPrice : result.data.fills ? result.data.fills[0].price : null // Captura o preço médio de execução
  };
}

async function newOrder(symbol, quantity, side, price, type = 'LIMIT', reduceOnly = false) {
  try {
    const data = {
      symbol,
      side,
      type: type || 'LIMIT',
      quantity,
      price,
      timeInForce: 'GTC',
      reduceOnly: reduceOnly,
      timestamp: Date.now(),
      recvWindow: 60000
    };

    const queryString = new URLSearchParams(data).toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

    return axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
  } catch (error) {
    console.error('[API] Erro ao criar nova ordem:', error);
    throw error;
  }
}

async function setPositionMode(dualSidePosition) {
  const data = {
    dualSidePosition, // true para hedge mode, false para one-way mode
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v1/positionSide/dual?${queryString}&signature=${signature}`;

  try {
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    // Ignorar erro se o modo já estiver configurado
    if (error.response && error.response.data && error.response.data.code === -4059) {
      console.log("Modo de posição já configurado corretamente.");
      return { success: true };
    }
    console.error('Erro ao configurar modo de posição:', error.message);
    throw error;
  }
}

async function newReduceOnlyOrder(symbol, quantity, side, price) {
  price = await roundPriceToTickSize(symbol, price);
  const data = {
    symbol,
    side,
    type: "LIMIT",
    quantity,
    price: parseFloat(price),
    timeInForce: "GTC",
    reduceOnly: true,
  };

  const timestamp = Date.now();
  const recvWindow = 60000;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
    .digest("hex");

  const newData = { ...data, timestamp, recvWindow, signature };
  const qs = `?${new URLSearchParams(newData).toString()}`;

  const result = await axios({
    method: "POST",
    url: `${apiUrl}/v1/order${qs}`,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  return result;
}

// Substituir a função newStopOrder existente

async function newStopOrder(symbol, quantity, side, stopPrice, price = null, reduceOnly = false, closePosition = false) {
  try {
    // Definir o tipo de ordem baseado no parâmetro price
    let orderType;
    
    // Se price está definido, é TAKE_PROFIT_MARKET, senão é STOP_MARKET
    if (price !== null) {
      orderType = "TAKE_PROFIT_MARKET";
    } else {
      orderType = "STOP_MARKET";
    }
    
    // Adicionar logs para verificar valores antes e depois de arredondar
    console.log(`Preço original de stop antes de arredondar: ${stopPrice}`);
    stopPrice = await roundPriceToTickSize(symbol, stopPrice);
    console.log(`Preço de stop após arredondar: ${stopPrice}`);
    
    // Preparar dados base da ordem
    const data = {
      symbol,
      side,
      type: orderType,
      quantity,
      stopPrice: parseFloat(stopPrice),
      newOrderRespType: "ACK",
      timestamp: Date.now(),
      recvWindow: 60000
    };

    // Adicionar closePosition OU reduceOnly, mas nunca ambos
    if (closePosition) {
      data.closePosition = true;
      // Não adicionar reduceOnly quando closePosition é true
    } else if (reduceOnly) {
      data.reduceOnly = true;
    }

    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(`${new URLSearchParams(data).toString()}`)
      .digest("hex");

    const newData = { ...data, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    console.log(`[API] Enviando ordem ${orderType}: ${symbol}, ${quantity}, ${side}, ${stopPrice}, closePosition: ${closePosition}`);
    const result = await axios({
      method: "POST",
      url: `${apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": apiKey },
    });
    
    console.log(`[API] Resposta da ordem ${orderType}:`, result.data);
    return { data: result.data }; // Garantir estrutura consistente { data: {...} }
  } catch (error) {
    console.error(`[API] Erro ao enviar ordem ${price ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET'}:`, 
                 error.response ? error.response.data : error.message);
    throw error;
  }
}

async function newTakeProfitOrder(symbol, quantity, side, price, orderId) {
  price = await roundPriceToTickSize(symbol, price);
  const data = {
    symbol,
    side,
    type: "TAKE_PROFIT_MARKET",
    quantity,
    stopPrice: parseFloat(price),
    newOrderRespType: "ACK",
    closePosition: true,
    origClientOrderId: orderId,
  };

  const timestamp = Date.now();
  const recvWindow = 60000;

  const signature = crypto
    .createHmac("sha256", apiSecret)
    .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
    .digest("hex");

  const newData = { ...data, timestamp, recvWindow, signature };
  const qs = `?${new URLSearchParams(newData).toString()}`;

  const result = await axios({
    method: "POST",
    url: `${apiUrl}/v1/order${qs}`,
    headers: { "X-MBX-APIKEY": apiKey },
  });

  return result;
}

async function getMaxLeverage(symbol) {
  try {
    const timestamp = Date.now();
    const recvWindow = 60000;

    const queryString = `symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');

    const url = `${apiUrl}/v1/leverageBracket?${queryString}&signature=${signature}`;
    
    const response = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': apiKey }
    });

    const symbolInfo = response.data.find(info => info.symbol === symbol);
    if (symbolInfo && symbolInfo.brackets && symbolInfo.brackets.length > 0) {
      const maxLeverage = Math.max(...symbolInfo.brackets.map(bracket => bracket.initialLeverage));
      return maxLeverage;
    } else {
      throw new Error('Informações de alavancagem não encontradas para o símbolo: ' + symbol);
    }
  } catch (error) {
    //console.error("Erro ao obter alavancagem máxima permitida:", error.response ? error.response.data : error.message);
    console.error("Símbolo inválido:", symbol, ".");
    throw error;
  }
}

async function getTickSize(symbol) {
  try {
    const response = await axios.get(`${apiUrl}/v1/exchangeInfo?symbol=${symbol}`);
    const symbolInfo = response.data.symbols.find(info => info.symbol === symbol);
    if (symbolInfo) {
      // Obtenção de filtros específicos
      const priceFilter = symbolInfo.filters.find(filter => filter.filterType === 'PRICE_FILTER');
      const minNotionalFilter = symbolInfo.filters.find(filter => filter.filterType === 'MIN_NOTIONAL');
      const marketLotSizeFilter = symbolInfo.filters.find(filter => filter.filterType === 'MARKET_LOT_SIZE');

      if (priceFilter && minNotionalFilter && marketLotSizeFilter) {
        const { minPrice, maxPrice, tickSize } = priceFilter;
        const { notional } = minNotionalFilter;
        const { minQty } = marketLotSizeFilter;

        return {
          minPrice: parseFloat(minPrice),
          minQty: parseFloat(minQty),
          notional: parseFloat(notional),
          maxPrice: parseFloat(maxPrice),
          tickSize: parseFloat(tickSize)
        };
      }
    }
    return null;
  } catch (error) {
    console.error("Erro ao obter o tamanho do tick e filtros associados:", error);
    return null;
  }
}

async function roundPriceToTickSize(symbol, price) {
  const tickSizeData = await getTickSize(symbol);
  if (!tickSizeData) {
    throw new Error(`Could not retrieve tick size for symbol: ${symbol}`);
  }
  const { tickSize } = tickSizeData;
  const roundedPrice = Math.round(price / tickSize) * tickSize;

  const tickSizeDecimals = (tickSize.toString().split('.')[1] || []).length;
  return parseFloat(roundedPrice.toFixed(tickSizeDecimals));
}

async function getPrecision(symbol) {
  try {
    const response = await axios.get(`${apiUrl}/v1/exchangeInfo?symbol=${symbol}`);
    
    if (response.data && response.data.symbols) {
      const symbolInfo = response.data.symbols.find(
        (symbolInfo) => symbolInfo.symbol === symbol
      );

      if (!symbolInfo) {
        throw new Error(`Símbolo inválido: ${symbol}`);
      }

      const { pricePrecision, quantityPrecision } = symbolInfo;
      return { pricePrecision, quantityPrecision };
    } else {
      throw new Error(`Símbolo inválido: ${symbol}`);
    }
  } catch (error) {
    console.error(`Símbolo inválido: ${symbol}`);
    throw new Error(`Símbolo inválido: ${symbol}`);
  }
}

async function getOpenOrders(symbol = null) {
  const data = {
    timestamp: Date.now(),
    recvWindow: 60000
  };

  if (symbol) {
    data.symbol = symbol;
  }

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v1/openOrders?${queryString}&signature=${signature}`;

  try {
    //console.log('URL:', url);
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    //console.log('Open orders data:', response.data);
    return response.data; // Retorna um array de ordens abertas para o símbolo especificado ou para todos os símbolos
  } catch (error) {
    console.error('Erro ao obter ordens abertas:', error.response ? error.response.data : error.message);
    throw error;
  }
}

async function getMultipleOrderStatus(symbol, orderIds) {
  const results = [];
  const timestamp = Date.now();
  const recvWindow = 10000;

  const data = {
      symbol,
      timestamp,
      recvWindow
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac("sha256", apiSecret)
                          .update(queryString)
                          .digest("hex");
  const url = `${apiUrl}/v1/allOrders?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const filteredOrders = response.data.filter(order => orderIds.includes(order.orderId.toString()));
    filteredOrders.forEach(order => results.push({ orderId: order.orderId, status: order.status }));
    //console.log(`Ordens filtradas para o símbolo ${symbol}:`, filteredOrders); // Log para verificar as ordens
} catch (error) {
    console.error(`Erro ao obter status das ordens para o símbolo ${symbol}:`, error.response?.status, error.response?.statusText);
    console.error(`Detalhes do erro:`, error.message);
    results.push({ error: "Failed to fetch order status", details: error.message });
}
return results;
}

async function getOrderStatus(orderId, symbol) {
  const data = {
      orderId,
      symbol,
      timestamp: Date.now(),
      recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac("sha256", apiSecret)
                          .update(queryString)
                          .digest("hex");
  const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

  try {
      const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
      return response.data.status; // Retorna apenas o status da ordem
  } catch (error) {
      console.error(`Erro ao obter status da ordem ${orderId} para o símbolo ${symbol}: ${error.message}`);
      return null; // Retorna null em caso de erro
  }
}

async function getPositionDetails(symbol) {
  console.log(`\nConsultando detalhes da posição para o símbolo: ${symbol}`);
  const data = {
      symbol: String(symbol),
      timestamp: Date.now(),
      recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac("sha256", apiSecret)
                          .update(queryString)
                          .digest("hex");
  const url = `${apiUrl}/v2/positionRisk?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    if (response.data && response.data.length > 0) {
        const positions = response.data.map(pos => ({
            simbolo: pos.symbol,
            quantidade: parseFloat(pos.positionAmt),
            preco_entrada: parseFloat(pos.entryPrice),
            preco_corrente: parseFloat(pos.markPrice),
            leverage: parseFloat(pos.leverage)
        }));

        if (positions.every(pos => pos.quantidade === 0)) {
            console.log(`Não há posição aberta para ${symbol}`);
            return [];
        }
        
        return positions;
    }
      return [];
    } catch (error) {
      if (error.response && error.response.status === 400) {
          console.error(`Símbolo inválido: ${symbol}`);
          throw new Error(`Símbolo inválido: ${symbol}`);
      } else {
          //console.error('Erro ao obter detalhes da posição:', error.message);
          throw error;
      }
  }
}

async function getAllOpenPositions(symbol = null) {
  const data = {
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac("sha256", apiSecret)
                          .update(queryString)
                          .digest("hex");
  const url = `${apiUrl}/v2/positionRisk?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { "X-MBX-APIKEY": apiKey } });

    let positions = response.data.filter(pos => parseFloat(pos.positionAmt) !== 0).map(pos => {
      /*console.log(`Dados brutos da posição retornados pela API para ${pos.symbol}:`, pos);
      return {
        simbolo: pos.symbol,
        quantidade: Math.abs(parseFloat(pos.positionAmt)), // Sempre positivo
        preco_entrada: parseFloat(pos.entryPrice),
        preco_corrente: parseFloat(pos.markPrice),
        data_hora_abertura: new Date(pos.updateTime),
        side: pos.positionSide,
        leverage: parseFloat(pos.leverage),
        maint_margin: Math.abs(parseFloat(pos.notional) / parseFloat(pos.leverage)), // Sempre positivo
        isolated_margin: Math.abs(parseFloat(pos.isolatedMargin || 0)), // Sempre positivo
        margin_type: pos.marginType, // Capturando o tipo de margem (crossed ou isolada)
        data_hora_ultima_atualizacao: new Date().toISOString(),
        preco_medio: parseFloat(pos.entryPrice)
      };*/
    });

    if (symbol) {
      positions = positions.filter(pos => pos.simbolo === symbol);
    }

    return positions;
  } catch (error) {
    console.error("Erro ao obter posições abertas:", error.message);
    throw error;
  }
}


async function obterSaldoPosicao(asset) {
  try {
    const response = await axios.get(`${apiUrl}/v3/account`, {
      headers: { "X-MBX-APIKEY": apiKey }
    });

    const account = response.data.balances.find(b => b.asset === asset);
    if (!account) {
      throw new Error(`Asset ${asset} not found.`);
    }

    return account.free;
  } catch (error) {
    console.error("Erro ao obter saldo de posição:", error.message);
    throw error;
  }
}

async function cancelOrder(orderId, symbol) {
  const timestamp = Date.now();
  const recvWindow = 60000;

  const data = {
    symbol,
    orderId,
    timestamp,
    recvWindow
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

  try {
    const result = await axios({
      method: "DELETE",
      url: url,
      headers: { "X-MBX-APIKEY": apiKey }
    });
    console.log(`[API] Ordem ${orderId} para ${symbol} cancelada com sucesso.`);
    return result.data;
  } catch (error) {
    // Tratamento específico para o erro "Unknown order"
    if (error.response && error.response.data && error.response.data.code === -2011) {
      console.log(`[API] A ordem ${orderId} para ${symbol} não foi encontrada (possivelmente já executada ou cancelada).`);
      return {
        success: true,
        message: "Order already executed or cancelled",
        orderId: orderId,
        symbol: symbol
      };
    }
    
    // Outros erros
    console.error(`[API] Erro ao cancelar a ordem ${orderId} para ${symbol}:`, 
      error.response ? error.response.data : error.message);
    throw error;
  }
}

async function getFuturesAccountBalanceDetails() {
  const data = {
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v2/balance?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const balanceDetails = response.data.map(item => ({
      accountAlias: item.accountAlias,
      asset: item.asset,
      balance: item.balance,
      crossWalletBalance: item.crossWalletBalance,
      crossUnPnl: item.crossUnPnl,
      availableBalance: item.availableBalance,
      maxWithdrawAmount: item.maxWithdrawAmount,
      marginAvailable: item.marginAvailable
    }));
    return balanceDetails;
  } catch (error) {
    console.error('Erro ao obter o saldo da conta de futuros:', error.message);
    throw error;
  }
}

async function changeInitialLeverage(symbol, leverage) {
  const data = {
    symbol,
    leverage,
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v1/leverage?${queryString}&signature=${signature}`;

  try {
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    if (response.data && response.data.leverage) {
      return response.data;
    } else {
      throw new Error('Resposta inesperada ao alterar a alavancagem.');
    }
  } catch (error) {
    console.error('Erro ao alterar a alavancagem inicial:', error.message);
    throw error;
  }
}

async function getCurrentLeverage(symbol) {
  const data = {
    symbol,
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v2/positionRisk?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const position = response.data.find(pos => pos.symbol === symbol);
    if (position) {
      //console.log(`Leverage for ${symbol}: ${position.leverage}`); // Log the leverage
      return parseFloat(position.leverage);
    } else {
      throw new Error('Alavancagem atual não encontrada.');
    }
  } catch (error) {
    console.error('Erro ao obter alavancagem atual:', error.message);
    throw error;
  }
}

async function getCurrentMarginType(symbol) {
  const data = {
    symbol,
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v2/positionRisk?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    const position = response.data.find(pos => pos.symbol === symbol);
    if (position) {
      const currentMarginType = position.marginType.toLowerCase();
      console.log(`Tipo de margem atual para ${symbol}: ${currentMarginType}`);
      return currentMarginType; // Retornar em minúsculas para garantir a comparação correta
    } else {
      throw new Error('Tipo de margem atual não encontrado.');
    }
  } catch (error) {
    console.error('Erro ao obter tipo de margem atual:', error.message);
    throw error;
  }
}

async function changeMarginType(symbol, marginType) {
  try {
    // Primeiro verificar o tipo de margem atual
    const currentMarginType = await getCurrentMarginType(symbol);
    
    // Normalizar para comparação (converter para minúsculas)
    const desiredMarginType = marginType.toLowerCase();
    
    // Se o tipo de margem já é o desejado, retornar sem fazer chamada à API
    if (currentMarginType === desiredMarginType) {
      return { 
        code: 200, 
        msg: 'No need to change the margin type.',
        marginType: desiredMarginType.toUpperCase()
      };
    }
    
    // Se chegou aqui, precisamos alterar o tipo de margem
    const data = {
      symbol,
      marginType: desiredMarginType.toUpperCase(), // AQUI: Converter para MAIÚSCULAS
      timestamp: Date.now(),
      recvWindow: 60000
    };

    const queryString = new URLSearchParams(data).toString();
    const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
    const url = `${apiUrl}/v1/marginType?${queryString}&signature=${signature}`;

    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    console.error('[API] Erro ao alterar o tipo de margem:', error.message);
    if (error.response && error.response.data) {
      console.error('[API] Detalhes do erro:', error.response.data);
    }
    throw error;
  }
}

async function transferBetweenAccounts(asset, amount, type) {
  const data = {
    asset,
    amount,
    type,
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrlSpot}/v1/futures/transfer?${queryString}&signature=${signature}`;

  try {
    const response = await axios.post(url, null, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    console.error(`Erro ao transferir entre contas: ${error.response ? error.response.data : error.message}`);
    throw error;
  }
}

async function cancelAllOpenOrders(symbol) {
  const timestamp = Date.now();
  const recvWindow = 60000;

  const data = {
    symbol,
    timestamp,
    recvWindow
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${apiUrl}/v1/allOpenOrders?${queryString}&signature=${signature}`;

  try {
    const result = await axios({
      method: "DELETE",
      url: url,
      headers: { "X-MBX-APIKEY": apiKey }
    });
    return result.data;
  } catch (error) {
    console.error("Erro ao cancelar todas as ordens abertas:", error.response ? error.response.data : error.message);
    throw error;
  }
}

async function encerrarPosicao(symbol) {
  await cancelAllOpenOrders(symbol);

  const positions = await getPositionDetails(symbol);

  if (!positions || positions.length === 0) {
    throw new Error('Posição não encontrada.');
  }

  // Assume que estamos interessados apenas na primeira posição encontrada
  const position = positions[0];

  const side = position.quantidade < 0 ? "BUY" : "SELL"; // Determina o side com base na quantidade
  const quantity = Math.abs(position.quantidade); // Quantidade absoluta da posição

  const data = {
    symbol,
    side,
    type: "MARKET",
    quantity,
    positionSide: "BOTH", // Encerrar todas as posições
    timestamp: Date.now(),
    recvWindow: 60000
  };

  const queryString = new URLSearchParams(data).toString();
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

  try {
    const result = await axios.post(url, null, { headers: { "X-MBX-APIKEY": apiKey } });
    return result.data;
  } catch (error) {
    console.error("Erro ao encerrar a posição:", error.response ? error.response.data : error.message);
    throw error;
  }
}

/**
 * Obtém todos os brackets de alavancagem da API da Binance
 * @returns {Promise<Array>} Array com brackets de alavancagem para todos os símbolos
 */
async function getAllLeverageBrackets() {
  const timestamp = Date.now();
  const recvWindow = 60000;

  const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(queryString)
    .digest('hex');

  const url = `${apiUrl}/v1/leverageBracket?${queryString}&signature=${signature}`;

  try {
    //console.log('[API] Buscando todos os brackets de alavancagem da Binance...');
    const response = await axios.get(url, { 
      headers: { 'X-MBX-APIKEY': apiKey }
    });
    
    //console.log(`[API] Brackets obtidos com sucesso. Total de símbolos: ${response.data.length}`);
    return response.data;
  } catch (error) {
    console.error('[API] Erro ao obter brackets de alavancagem:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Adicione esta função antes do module.exports

// Fechar posição existente usando ordem de mercado
async function closePosition(symbol, quantity, side) {
  try {
    // Primeiro verificar se a posição ainda existe
    const positions = await getPositionDetails(symbol);
    const positionExists = positions.some(p => Math.abs(p.quantidade) > 0);
    
    if (!positionExists) {
      console.log(`[API] Posição para ${symbol} não encontrada ou já fechada`);
      return { success: true, message: "Position already closed" };
    }
    
    // Tentar enviar ordem de mercado normal em vez de closePosition
    const data = {
      symbol,
      side,
      type: "MARKET",
      quantity,
      reduceOnly: true, // Usar reduceOnly em vez de closePosition
      timestamp: Date.now(),
      recvWindow: 60000
    };

    const queryString = new URLSearchParams(data).toString();
    const signature = crypto
      .createHmac('sha256', apiSecret)
      .update(queryString)
      .digest('hex');

    const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

    console.log(`[API] Fechando posição para ${symbol}, side: ${side}, quantidade: ${quantity}`);
    const result = await axios.post(url, null, { headers: { "X-MBX-APIKEY": apiKey } });
    return { data: result.data };
  } catch (error) {
    console.error(`[API] Erro ao fechar posição: ${error.message}`);
    throw error;
  }
}

// Adicione esta função para verificar o modo de posição atual
async function getPositionMode() {
  const timestamp = Date.now();
  const recvWindow = 60000;

  const queryString = `timestamp=${timestamp}&recvWindow=${recvWindow}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
  const url = `${apiUrl}/v1/positionSide/dual?${queryString}&signature=${signature}`;

  try {
    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data.dualSidePosition; // true para hedge mode, false para one-way
  } catch (error) {
    console.error('Erro ao verificar modo de posição:', error.message);
    throw error;
  }
}

// Implemente getPrice se ainda não existir
async function getPrice(symbol) {
  try {
    const response = await axios.get(`${apiUrl}/v1/ticker/price?symbol=${symbol}`);
    return parseFloat(response.data.price);
  } catch (error) {
    console.error(`[API] Erro ao obter preço para ${symbol}: ${error.message}`);
    throw error;
  }
}

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
  newReduceOnlyOrder,
  newStopOrder,
  newTakeProfitOrder,
  getTickSize,
  getPrecision,
  getOpenOrders,
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
  getPrice // Adicione a função getPrice
};
