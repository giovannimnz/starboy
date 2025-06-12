const axios = require("axios");
const crypto = require("crypto");
require('dotenv').config();
const { getDatabaseInstance } = require('./db/conexao');

const apiKey = process.env.API_KEY;
const apiSecret = process.env.API_SECRET;
const apiUrl = process.env.API_URL;
const apiUrlSpot = process.env.API_URL_SPOT;

async function newEntryOrder(symbol, quantity, side) {
  try {
    console.log(`[API] Enviando ordem: ${symbol}, ${quantity}, ${side}`);
    
    // Validar quantidade
    if (quantity <= 0 || isNaN(quantity)) {
      throw new Error(`Quantidade inválida: ${quantity}`);
    }
    
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

    console.log(`[API] Enviando ordem de entrada a mercado: ${symbol}, ${quantity}, ${side}`);
    const result = await axios({
      method: "POST",
      url: `${apiUrl}/v1/order${qs}`,
      headers: { "X-MBX-APIKEY": apiKey },
    });

    // Log da resposta completa
    console.log(`[API] Resposta da ordem: ${JSON.stringify(result.data)}`);

    // Processar a resposta para extrair preço e quantidade executada
    const avgPrice = result.data.avgPrice
        ? parseFloat(result.data.avgPrice)
        : result.data.fills && result.data.fills.length > 0
            ? parseFloat(result.data.fills[0].price)
            : null;

    return {
      orderId: result.data.orderId,
      executedQty: result.data.executedQty,
      cummulativeQuoteQty: result.data.cummulativeQuoteQty,
      price: avgPrice // Garantir que o preço seja retornado
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

async function newLimitMakerOrder(symbol, quantity, side, price) {
  try {
    // Validações de quantidade e preço podem ser adicionadas aqui
    // Arredondar o preço para o tickSize correto usando sua função roundPriceToTickSize
    const { pricePrecision } = await getPrecision(symbol); // Assumindo que getPrecision retorna pricePrecision
    const roundedPrice = await roundPriceToTickSize(symbol, price); // Sua função existente

    const data = {
      symbol,
      side,
      type: "LIMIT",
      quantity,
      price: roundedPrice.toFixed(pricePrecision), // Garanta a formatação correta do preço
      timeInForce: "GTX", // ESSENCIAL: Garante que a ordem seja Post-Only (Maker)
      newOrderRespType: "RESULT" // Para obter mais detalhes na resposta
    };

    const timestamp = Date.now();
    const recvWindow = 60000; // Binance recomenda até 60000 para Futuros

    const signature = crypto
        .createHmac("sha256", apiSecret)
        .update(`${new URLSearchParams({ ...data, timestamp, recvWindow }).toString()}`)
        .digest("hex");

    const newData = { ...data, timestamp, recvWindow, signature };
    const qs = `?${new URLSearchParams(newData).toString()}`;

    console.log(`[API] Enviando Ordem LIMIT MAKER: ${symbol}, Qtd: ${quantity}, Lado: ${side}, Preço: ${roundedPrice}, TimeInForce: GTX`);
    const result = await axios({
      method: "POST",
      url: `${apiUrl}/v1/order${qs}`, // CORREÇÃO AQUI - remover as tags HTML
      headers: { "X-MBX-APIKEY": apiKey },
    });

    console.log(`[API] Resposta da Ordem LIMIT MAKER: ${JSON.stringify(result.data)}`);
    return result.data; // Retorna a resposta completa da API

  } catch (error) {
    console.error(`[API] ERRO DETALHADO ao criar Ordem LIMIT MAKER para ${symbol}:`);
    if (error.response) {
      console.error(`[API] Status: ${error.response.status}`);
      console.error(`[API] Dados: ${JSON.stringify(error.response.data)}`);
      // Código -2010: "Order would immediately match and take." - Isso é esperado se a ordem GTX seria taker.
      if (error.response.data && error.response.data.code === -2010) {
        return { ...error.response.data, status: 'REJECTED_POST_ONLY' }; // Identifica rejeição por ser taker
      }
    } else {
      console.error(`[API] Mensagem: ${error.message}`);
    }
    throw error; // Relança outros erros
  }
}

async function editOrder(symbol, orderId, newPrice, side, quantity = null) {
  try {
    console.log(`[API] Editando ordem ${orderId} para ${symbol}: novo preço ${newPrice}, lado ${side}`);
    
    // Preparar dados para a requisição
    const data = {
      symbol,
      orderId,
      side, // Parâmetro side adicionado - ESSENCIAL
      timestamp: Date.now(),
      recvWindow: 60000
    };
    
    // Adicionar novo preço (obrigatório)
    data.price = newPrice;
    
    // Adicionar nova quantidade (opcional)
    if (quantity !== null) {
      data.quantity = quantity;
    }

    const queryString = new URLSearchParams(data).toString();
    const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(queryString)
        .digest('hex');

    const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

    const result = await axios({
      method: "PUT",  // Método PUT para editar ordens
      url: url,
      headers: { "X-MBX-APIKEY": apiKey }
    });

    console.log(`[API] Ordem ${orderId} editada com sucesso para preço ${newPrice}`);
    return result.data;
  } catch (error) {
    console.error(`[API] Erro ao editar ordem ${orderId}:`, error.response ? error.response.data : error.message);
    throw error;
  }
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
  try {
    price = await roundPriceToTickSize(symbol, price);
    
    // Garantir que a quantidade esteja no formato correto
    const { quantityPrecision } = await getPrecision(symbol);
    const formattedQuantity = parseFloat(quantity.toFixed(quantityPrecision));
    
    console.log(`[API] Enviando ordem LIMIT reduce-only: ${symbol}, ${side}, qty=${formattedQuantity}, price=${price}`);
    
    const data = {
      symbol,
      side,
      type: "LIMIT",
      quantity: formattedQuantity,
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

    console.log(`[API] Ordem LIMIT reduce-only criada com sucesso: orderId=${result.data.orderId}`);
    return result;
  } catch (error) {
    console.error(`[API] Erro ao criar ordem LIMIT reduce-only:`, error.message);
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

    //console.log(`[API] Resposta da ordem ${orderType}:`, result.data);
    return { data: result.data }; // Garantir estrutura consistente { data: {...} }
  } catch (error) {
    console.error(`[API] Erro ao enviar ordem ${price ? 'TAKE_PROFIT_MARKET' : 'STOP_MARKET'}:`,
        error.response ? error.response.data : error.message);
    throw error;
  }
}

async function newStopOrTpLimitOrder(symbol, quantity, side, orderType, stopPrice, limitExecutionPrice, options = {}) {
    try {
        const { pricePrecision, quantityPrecision } = await getPrecision(symbol);

        const formattedQuantity = parseFloat(quantity).toFixed(quantityPrecision);
        const formattedStopPrice = parseFloat(stopPrice).toFixed(pricePrecision); // Preço de ativação
        const formattedLimitExecutionPrice = parseFloat(limitExecutionPrice).toFixed(pricePrecision); // Preço limite da ordem após ativação

        const data = {
            symbol,
            side, // Lado para FECHAR a posição (SELL para LONG, BUY para SHORT)
            type: orderType, // "STOP_LIMIT" ou "TAKE_PROFIT_LIMIT"
            quantity: formattedQuantity,
            price: formattedLimitExecutionPrice, // O preço LIMITE da ordem
            stopPrice: formattedStopPrice,       // O preço de GATILHO (trigger)
            timeInForce: options.timeInForce || 'GTC', // Geralmente GTC para SL/TP
            reduceOnly: options.reduceOnly === undefined ? true : options.reduceOnly, // Default para true
            newOrderRespType: options.newOrderRespType || "RESULT",
            timestamp: Date.now(),
            recvWindow: options.recvWindow || 60000,
        };

        const signature = crypto
            .createHmac("sha256", apiSecret)
            .update(`${new URLSearchParams(data).toString()}`)
            .digest("hex");

        const newData = { ...data, signature };
        const qs = `?${new URLSearchParams(newData).toString()}`;

        console.log(`[API] Enviando ${orderType}: ${symbol}, Qtd: ${quantity}, Lado: ${side}, Gatilho(stopPrice): ${stopPrice}, PreçoLimite(price): ${limitExecutionPrice}, ReduceOnly: ${data.reduceOnly}`);
        const result = await axios({
            method: "POST",
            url: `${apiUrl}/v1/order${qs}`,
            headers: { "X-MBX-APIKEY": apiKey },
        });

        console.log(`[API] Resposta ${orderType}:`, result.data);
        return result.data; // Retorna o objeto completo da resposta da ordem
    } catch (error) {
        console.error(`[API] Erro ao enviar ordem ${orderType} para ${symbol}:`, error.response?.data || error.message);
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
    console.log(`[API] Obtendo informações do símbolo ${symbol}...`);
    const response = await axios.get(`${apiUrl}/v1/exchangeInfo?symbol=${symbol}`);
    
    if (!response.data || !response.data.symbols || !response.data.symbols.length) {
      throw new Error(`Nenhuma informação encontrada para o símbolo ${symbol}`);
    }
    
    const symbolInfo = response.data.symbols.find(s => s.symbol === symbol);
    if (!symbolInfo) {
      throw new Error(`Símbolo ${symbol} não encontrado`);
    }
    
    // Obter informações de filtros
    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    if (!priceFilter) {
      throw new Error(`Filtro de preço não encontrado para ${symbol}`);
    }
    
    return {
      tickSize: priceFilter.tickSize,
      minPrice: priceFilter.minPrice,
      maxPrice: priceFilter.maxPrice
    };
  } catch (error) {
    console.error(`[API] Erro ao obter tick size para ${symbol}: ${error.message}`);
    throw error;
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

async function getOrderStatus(symbol, orderId) {
  try {
    if (!symbol || !orderId) {
      console.error(`[API] Parâmetros inválidos para getOrderStatus: Symbol=${symbol}, OrderId=${orderId}`);
      throw new Error(`Parâmetros inválidos para getOrderStatus`);
    }
    
    // Verificar se orderId e symbol estão na ordem correta
    // Se orderId parece ser um símbolo, trocar os parâmetros
    if (typeof orderId === 'string' && orderId.includes('USDT') && !symbol.includes('USDT')) {
      console.log(`[API] Detectada troca de parâmetros. Corrigindo symbol=${orderId}, orderId=${symbol}`);
      [symbol, orderId] = [orderId, symbol];
    }

    const timestamp = Date.now();
    const recvWindow = 60000;

    const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(queryString)
      .digest("hex");
    const url = `${apiUrl}/v1/order?${queryString}&signature=${signature}`;

    // Adicionar timeout mais curto para evitar bloqueios longos
    const response = await axios.get(url, { 
      headers: { "X-MBX-APIKEY": apiKey },
      timeout: 5000 // 5 segundos de timeout
    });
    
    return response.data;
  } catch (error) {
    // Tratar o erro de forma mais detalhada
    if (error.response) {
      // Se a ordem não existe mais (já foi executada/cancelada)
      if (error.response.status === 400 && error.response.data && error.response.data.code === -2013) {
        return { status: 'UNKNOWN', reason: 'Order does not exist' };
      }
    }
    
    console.error(`[API] Erro ao obter status da ordem ${orderId} para ${symbol}: ${error.message}`);
    throw error;
  }
}

async function getRecentOrders(symbol, limit = 50) {
  try {
    const timestamp = Date.now();
    const recvWindow = 60000;

    const queryString = `symbol=${symbol}&limit=${limit}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = crypto.createHmac("sha256", apiSecret)
        .update(queryString)
        .digest("hex");
    const url = `${apiUrl}/v1/allOrders?${queryString}&signature=${signature}`;

    const response = await axios.get(url, { headers: { 'X-MBX-APIKEY': apiKey } });
    return response.data;
  } catch (error) {
    console.error(`Erro ao obter ordens recentes para ${symbol}: ${error.message}`);
    throw error;
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

    // Filtrar posições com quantidade diferente de zero e formatar resposta
    let positions = response.data.filter(pos => parseFloat(pos.positionAmt) !== 0).map(pos => {
      return {
        simbolo: pos.symbol,
        quantidade: Math.abs(parseFloat(pos.positionAmt)),
        preco_entrada: parseFloat(pos.entryPrice),
        preco_corrente: parseFloat(pos.markPrice),
        data_hora_abertura: new Date(pos.updateTime),
        side: pos.positionSide,
        leverage: parseFloat(pos.leverage),
        maint_margin: Math.abs(parseFloat(pos.notional) / parseFloat(pos.leverage)),
        isolated_margin: Math.abs(parseFloat(pos.isolatedMargin || 0)),
        margin_type: pos.marginType,
        data_hora_ultima_atualizacao: new Date().toISOString(),
        preco_medio: parseFloat(pos.entryPrice)
      };
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
    //console.error('[API] Erro ao alterar o tipo de margem:', error.message);
    if (error.response && error.response.data) {
      //console.error('[API] Detalhes do erro:', error.response.data);
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

/**
 * Atualiza informações de alavancagem (leverage brackets) no banco de dados
 * @param {boolean} forceUpdate - Se true, força atualização mesmo se dados recentes existirem
 * @returns {Promise<number>} - Número de registros processados
 */
async function updateLeverageBracketsInDatabase(forceUpdate = false) {
  try {
    //console.log('[API] Atualizando dados de alavancagem no banco de dados...');

    // 1. Obter conexão com o banco de dados
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error('Não foi possível conectar ao banco de dados');
    }

    // 2. Verificar última atualização (evitar chamadas excessivas à API)
    if (!forceUpdate) {
      const [lastUpdate] = await db.query(`
        SELECT MAX(UNIX_TIMESTAMP(updated_at)) as last_update 
        FROM alavancagem
        WHERE corretora = 'binance'
      `);

      const currentTime = Math.floor(Date.now() / 1000);
      const lastUpdateTime = lastUpdate[0].last_update || 0;

      // Se dados foram atualizados nas últimas 24 horas, retornar
      if (lastUpdateTime > 0 && (currentTime - lastUpdateTime) < 24 * 60 * 60) {
        //console.log('[API] Dados de alavancagem já atualizados nas últimas 24 horas');

        // Verificar número de registros já existentes
        const [count] = await db.query(`
          SELECT COUNT(*) as total FROM alavancagem WHERE corretora = 'binance'
        `);
        return count[0].total;
      }
    }

    // 3. Buscar dados da API da Binance
    const brackets = await getAllLeverageBrackets();
    if (!brackets || brackets.length === 0) {
      throw new Error('Não foi possível obter dados de alavancagem da Binance');
    }

    console.log(`[API] Recebidos dados de ${brackets.length} símbolos`);

    // 4. Iniciar transação para inserções em massa
    const connection = await db.getConnection();
    await connection.beginTransaction();

    let recordCount = 0;

    try {
      // 5. Processar cada símbolo e seus brackets
      for (const item of brackets) {
        const symbol = item.symbol;

        if (!symbol || !item.brackets || !Array.isArray(item.brackets)) {
          console.log(`[API] Dados inválidos ou incompletos para símbolo: ${symbol || 'desconhecido'}`);
          continue;
        }

        for (const bracket of item.brackets) {
          // Verificar se todos os campos necessários existem
          if (
              bracket.bracket === undefined ||
              bracket.initialLeverage === undefined ||
              bracket.notionalCap === undefined ||
              bracket.notionalFloor === undefined ||
              bracket.maintMarginRatio === undefined ||
              bracket.cum === undefined
          ) {
            console.log(`[API] Dados de bracket incompletos para ${symbol}`, bracket);
            continue;
          }

          // Prepare the query with placeholders (? for each value)
          const query = `
            INSERT INTO alavancagem 
            (symbol, corretora, bracket, initial_leverage, notional_cap, 
             notional_floor, maint_margin_ratio, cum, updated_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE 
              initial_leverage = VALUES(initial_leverage), 
              notional_cap = VALUES(notional_cap), 
              notional_floor = VALUES(notional_floor), 
              maint_margin_ratio = VALUES(maint_margin_ratio), 
              cum = VALUES(cum),
              updated_at = NOW()
          `;

          // Execute a inserção/atualização
          await connection.query(query, [
            symbol,
            'binance',
            bracket.bracket,
            bracket.initialLeverage,
            bracket.notionalCap,
            bracket.notionalFloor,
            bracket.maintMarginRatio,
            bracket.cum
          ]);

          recordCount++;
        }
      }

      // 6. Confirmar transação
      await connection.commit();
      console.log(`[API] ${recordCount} registros de alavancagem atualizados no banco de dados`);

      return recordCount;
    } catch (error) {
      // Em caso de erro, reverter transação
      await connection.rollback();
      console.error('[API] Erro ao atualizar dados de alavancagem no banco:', error);
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('[API] Falha na atualização de dados de alavancagem:', error);
    throw error;
  }
}

/**
 * Obtem informações de alavancagem do banco para um símbolo específico
 * @param {string} symbol - Símbolo para consultar (ex: BTCUSDT)
 * @returns {Promise<Array>} - Array de brackets para o símbolo
 */
async function getLeverageBracketsFromDb(symbol) {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error('Não foi possível conectar ao banco de dados');
    }

    // Verificar se o símbolo existe no banco
    const [rows] = await db.query(`
      SELECT * FROM alavancagem 
      WHERE symbol = ? AND corretora = 'binance'
      ORDER BY bracket ASC
    `, [symbol]);

    // Se não encontrar dados para o símbolo, tentar atualizar o banco
    if (rows.length === 0) {
      console.log(`[API] Não foram encontrados dados de alavancagem para ${symbol}, atualizando banco...`);
      await updateLeverageBracketsInDatabase(true);

      // Consultar novamente após atualização
      const [updatedRows] = await db.query(`
        SELECT * FROM alavancagem 
        WHERE symbol = ? AND corretora = 'binance'
        ORDER BY bracket ASC
      `, [symbol]);

      // Mapear para o formato esperado pelo sistema
      return formatBracketsFromDb(updatedRows);
    }

    // Mapear para o formato esperado pelo sistema
    return formatBracketsFromDb(rows);
  } catch (error) {
    console.error(`[API] Erro ao obter dados de alavancagem para ${symbol}:`, error);
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
      bracket: row.bracket,
      initialLeverage: row.initial_leverage,
      notionalCap: parseFloat(row.notional_cap),
      notionalFloor: parseFloat(row.notional_floor),
      maintMarginRatio: parseFloat(row.maint_margin_ratio),
      cum: parseFloat(row.cum)
    });
  }

  // Converter o mapa em array
  return Object.values(symbolsMap);
}

async function cancelPendingEntry(db, positionId, status, reason) {
  try {
    console.log(`[MONITOR] Cancelando entrada pendente ID ${positionId}: ${status} - ${reason}`);
    
    // 1. Obter informações para notificação antes de mover a posição
    const [webhookInfo] = await db.query(`
      SELECT w.id as webhook_id, w.chat_id, p.simbolo as symbol 
      FROM webhook_signals w
      JOIN posicoes p ON w.position_id = p.id
      WHERE w.position_id = ? LIMIT 1
    `, [positionId]);
    
    if (webhookInfo.length === 0) {
      console.error(`[MONITOR] Não foi possível encontrar informações do webhook para posição ${positionId}`);
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
    await movePositionToHistory(db, positionId, 'CANCELED', reason);
    
    // 4. Enviar notificação ao Telegram se chat_id estiver disponível
    if (webhookInfo[0].chat_id) {
      try {
        await bot.telegram.sendMessage(webhookInfo[0].chat_id,
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
function load_leverage_brackets(symbol = null) {
  return getLeverageBracketsFromDb(symbol);
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
  cancelPendingEntry
};

