const path = require('path');
const api = require('./api');
const { getDatabaseInstance, formatDateForMySQL } = require('./backend/core/database/conexao');
const websockets = require('./websockets');

// Carregar configurações de ambiente
require('dotenv').config({ path: path.resolve(__dirname, '../../../../config/.env') });

// Configuração da WebSocket API
const ENABLE_WS_API = process.env.ENABLE_WS_API === 'true';

/**
 * Verifica se a WebSocket API está habilitada
 */
function isWebSocketApiEnabled() {
  return ENABLE_WS_API;
}

/**
 * Envia uma nova ordem via WebSocket API - VERSÃO CORRIGIDA
 */
async function placeOrderViaWebSocket(orderParams, accountId) {
  // Verificar se WebSocket API está habilitada
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada via configuração. Pulando...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }

  // CORREÇÃO CRÍTICA: Validar accountId
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para placeOrderViaWebSocket: ${accountId}`);
  }

  // Verificar se WebSocket API está conectado
  if (!websockets.isWebSocketApiConnected(accountId)) {
    console.log(`[WS-API] WebSocket não conectado para conta ${accountId}, tentando conectar...`);
    await websockets.startWebSocketApi(accountId);
    
    // Aguardar conexão
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    if (!websockets.isWebSocketApiConnected(accountId)) {
      throw new Error(`Não foi possível conectar WebSocket API para conta ${accountId}`);
    }
  }
  
  try {
    // Validar parâmetros obrigatórios
    validateOrderParams(orderParams);
    
    // Criar requisição assinada para ordem
    const request = await websockets.createSignedRequest('order.place', orderParams, accountId);
    
    console.log(`[WS-API] Enviando ordem ${orderParams.type} via WebSocket API para conta ${accountId}: ${orderParams.symbol}, ${orderParams.side}, ${orderParams.quantity || ''} @ ${orderParams.price || ''}`);
    
    // Enviar requisição e aguardar resposta
    const response = await websockets.sendWebSocketApiRequest(request, 30000, accountId);
    
    if (response.status === 200 && response.result) {
      console.log(`[WS-API] ✅ Ordem criada com sucesso para conta ${accountId}: ${response.result.orderId}`);
      return response;
    } else {
      throw new Error(`Erro na resposta da API: ${response.error?.msg || 'Resposta inválida'}`);
    }
  } catch (error) {
    const errorMessage = error.error?.msg || error.message || 'Erro desconhecido';
    console.error(`[WS-API] Erro ao enviar ordem via WebSocket API para conta ${accountId}: ${errorMessage}`);
    throw error;
  }
}

/**
 * Envia uma ordem LIMIT MAKER via WebSocket API
 */
async function placeLimitMakerOrderViaWebSocket(symbol, quantity, side, price, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando placeLimitMakerOrderViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para placeLimitMakerOrderViaWebSocket');
  }
  
  return await placeOrderViaWebSocket({
    symbol,
    side,
    type: 'LIMIT',
    quantity,
    price,
    timeInForce: 'GTX', // GTX garante que seja uma ordem LIMIT_MAKER (Post Only)
    newOrderRespType: 'RESULT'
  }, accountId);
}

/**
 * Envia uma ordem STOP_MARKET via WebSocket API
 */
async function placeStopMarketOrderViaWebSocket(symbol, quantity, side, stopPrice, closePosition = false, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando placeStopMarketOrderViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para placeStopMarketOrderViaWebSocket');
  }
  
  const params = {
    symbol,
    side,
    type: 'STOP_MARKET',
    stopPrice,
    newOrderRespType: 'RESULT'
  };
  
  if (closePosition) {
    params.closePosition = 'true';
  } else {
    params.quantity = quantity;
    params.reduceOnly = 'true';
  }
  
  return await placeOrderViaWebSocket(params, accountId);
}

/**
 * Envia uma ordem TAKE_PROFIT_MARKET via WebSocket API
 */
async function placeTakeProfitMarketOrderViaWebSocket(symbol, quantity, side, stopPrice, closePosition = false, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando placeTakeProfitMarketOrderViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para placeTakeProfitMarketOrderViaWebSocket');
  }
  if (!accountId) {
    throw new Error('AccountId é obrigatório para placeTakeProfitMarketOrderViaWebSocket');
  }
  
  const params = {
    symbol,
    side,
    type: 'TAKE_PROFIT_MARKET',
    stopPrice,
    newOrderRespType: 'RESULT'
  };
  
  if (closePosition) {
    params.closePosition = 'true';
  } else {
    params.quantity = quantity;
    params.reduceOnly = 'true';
  }
  
  return await placeOrderViaWebSocket(params, accountId);
}

/**
 * Modifica uma ordem existente via WebSocket API
 */
async function modifyOrderViaWebSocket(modifyParams, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando modifyOrderViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para modifyOrderViaWebSocket');
  }
  
  if (!websockets.isWebSocketApiConnected(accountId)) {
    await websockets.startWebSocketApi(accountId);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  try {
    validateModifyOrderParams(modifyParams);
    
    const request = await websockets.createSignedRequest('order.modify', modifyParams, accountId);
    
    console.log(`[WS-API] Modificando ordem ${modifyParams.orderId || modifyParams.origClientOrderId} para conta ${accountId}: novo preço ${modifyParams.price}, quantidade ${modifyParams.quantity}`);
    
    const response = await websockets.sendWebSocketApiRequest(request, 30000, accountId);
    
    if (response.status === 200 && response.result) {
      console.log(`[WS-API] ✅ Ordem modificada com sucesso para conta ${accountId}`);
      return response;
    } else {
      throw new Error(`Erro na modificação: ${response.error?.msg || 'Resposta inválida'}`);
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao modificar ordem via WebSocket API para conta ${accountId}: ${error.message}`);
    throw error;
  }
}

/**
 * Cancela uma ordem via WebSocket API
 */
async function cancelOrderByIdViaWebSocket(symbol, orderId, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando cancelOrderByIdViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para cancelOrderByIdViaWebSocket');
  }
  
  try {
    const cancelParams = {
      symbol,
      orderId
    };
    
    const request = await websockets.createSignedRequest('order.cancel', cancelParams, accountId);
    const response = await websockets.sendWebSocketApiRequest(request, 30000, accountId);
    
    if (response.status === 200 && response.result) {
      console.log(`[WS-API] ✅ Ordem ${orderId} cancelada com sucesso para conta ${accountId}`);
      return response;
    } else {
      throw new Error(`Erro no cancelamento: ${response.error?.msg || 'Resposta inválida'}`);
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao cancelar ordem ${orderId} para conta ${accountId}: ${error.message}`);
    throw error;
  }
}

/**
 * Obtém status de múltiplas ordens via WebSocket API
 */
async function getMultipleOrderStatusViaWebSocket(symbol, orderIds, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando getMultipleOrderStatusViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para getMultipleOrderStatusViaWebSocket');
  }
  
  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    throw new Error('orderIds deve ser um array não vazio');
  }
  
  console.log(`[WS-API] Consultando status de ${orderIds.length} ordens para ${symbol} na conta ${accountId}`);
  
  const results = [];
  const BATCH_SIZE = 5;
  
  for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
    const batch = orderIds.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(orderId => getOrderStatusViaWebSocket(symbol, orderId, accountId));
    
    try {
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    } catch (error) {
      console.error(`[WS-API] Erro no batch ${i}-${i + BATCH_SIZE} para conta ${accountId}:`, error.message);
      // Adicionar resultados de erro para manter índices
      results.push(...batch.map(orderId => ({ error: error.message, orderId })));
    }
  }
  
  return results;
}

/**
 * Obtém status de uma ordem via WebSocket API (com fallback para REST)
 */
async function getOrderStatusViaWebSocket(symbol, orderId, accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando getOrderStatusViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para getOrderStatusViaWebSocket');
  }
  
  try {
    console.log(`[WS-API] Tentando obter status da ordem ${orderId} via WebSocket para conta ${accountId}...`);
    
    // CORREÇÃO: Usar fallback para REST API por enquanto (mais confiável)
    const result = await api.getOrderStatus(symbol, orderId, accountId);
    console.log(`[WS-API] ✅ Status obtido via REST API para conta ${accountId}: ${result.status}`);
    return result;
    
  } catch (error) {
    console.error(`[WS-API] Erro ao obter status via WebSocket para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Valida parâmetros de ordem
 */
function validateOrderParams(params) {
  if (!params.symbol) throw new Error('Parâmetro obrigatório "symbol" ausente');
  if (!params.side) throw new Error('Parâmetro obrigatório "side" ausente');
  if (!params.type) throw new Error('Parâmetro obrigatório "type" ausente');
  
  // Validações específicas por tipo
  switch (params.type) {
    case 'LIMIT':
      if (!params.quantity) throw new Error('Parâmetro "quantity" obrigatório para LIMIT');
      if (!params.price) throw new Error('Parâmetro "price" obrigatório para LIMIT');
      break;
    case 'MARKET':
      if (!params.quantity) throw new Error('Parâmetro "quantity" obrigatório para MARKET');
      break;
    case 'STOP_MARKET':
    case 'TAKE_PROFIT_MARKET':
      if (!params.stopPrice) throw new Error('Parâmetro "stopPrice" obrigatório para STOP_MARKET/TAKE_PROFIT_MARKET');
      break;
  }
}

/**
 * Valida parâmetros de modificação de ordem
 */
function validateModifyOrderParams(params) {
  if (!params.symbol) throw new Error('Parâmetro obrigatório "symbol" ausente');
  if (!params.side) throw new Error('Parâmetro obrigatório "side" ausente');
  if (!params.quantity) throw new Error('Parâmetro obrigatório "quantity" ausente');
  
  if (!params.orderId && !params.origClientOrderId) {
    throw new Error('É necessário fornecer "orderId" ou "origClientOrderId"');
  }
  
  if (!params.price && !params.priceMatch) {
    throw new Error('É necessário fornecer "price" ou "priceMatch"');
  }
}

/**
 * Sincroniza saldo da conta via WebSocket API
 */
async function syncAccountBalanceViaWebSocket(accountId) {
  if (!isWebSocketApiEnabled()) {
    console.log(`[WS-API] WebSocket API está desabilitada. Pulando syncAccountBalanceViaWebSocket...`);
    throw new Error('WebSocket API está desabilitada via configuração');
  }
  
  if (!accountId) {
    throw new Error('AccountId é obrigatório para syncAccountBalanceViaWebSocket');
  }
  
  try {
    console.log(`[WS-API] Sincronizando saldo da conta ${accountId} via WebSocket...`);
    
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error('Não foi possível obter instância do banco de dados');
    }
    
    // Verificar se WebSocket API está conectado
    if (!websockets.isWebSocketApiConnected(accountId)) {
      console.log(`[WS-API] Conectando WebSocket API para sincronização de saldo da conta ${accountId}...`);
      try {
        await websockets.startWebSocketApi(accountId);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (wsError) {
        throw new Error(`Falha ao conectar WebSocket API: ${wsError.message}`);
      }
    }
    
    // Obter informações da conta
    const accountInfo = await getAccountInformationV2({}, accountId);
    
    if (!accountInfo || accountInfo.status !== 200) {
      throw new Error(`Falha ao obter informações da conta ${accountId}: ${accountInfo?.error?.message || 'Resposta inválida'}`);
    }
    
    const result = accountInfo.result;
    const realSaldo = parseFloat(result.totalWalletBalance || '0');
    const saldoDisponivel = parseFloat(result.availableBalance || '0');
    
    // Obter saldo base de cálculo atual
    const [currentData] = await db.query(
      'SELECT saldo_base_calculo_futuros FROM contas WHERE id = ?',
      [accountId]
    );
    
    const previousBaseCalculo = currentData.length > 0 ? parseFloat(currentData[0].saldo_base_calculo_futuros || '0') : 0;
    const calculoBasadaEm5Porcento = saldoDisponivel * 0.05;
    const newBaseCalculo = Math.max(calculoBasadaEm5Porcento, previousBaseCalculo);
    
    // Atualizar banco de dados
    const currentDateTime = formatDateForMySQL(new Date());
    await db.query(
      'UPDATE contas SET saldo_futuros = ?, saldo_base_calculo_futuros = ?, ultima_atualizacao = ? WHERE id = ?',
      [realSaldo, newBaseCalculo, currentDateTime, accountId]
    );
    
    console.log(`[WS-API] ✅ Saldo sincronizado para conta ${accountId}: ${realSaldo} USDT (disponível: ${saldoDisponivel}, base: ${newBaseCalculo})`);
    
    return {
      success: true,
      accountId: accountId,
      saldo: realSaldo,
      saldo_disponivel: saldoDisponivel,
      saldo_base_calculo: newBaseCalculo,
      previousBaseCalculo: previousBaseCalculo
    };
  } catch (error) {
    console.error(`[WS-API] Erro ao sincronizar saldo da conta ${accountId} via WebSocket: ${error.message}`);
    return {
      success: false,
      accountId: accountId,
      error: error.message
    };
  }
}

module.exports = {
  isWebSocketApiEnabled,
  placeOrderViaWebSocket,
  placeLimitMakerOrderViaWebSocket,
  placeStopMarketOrderViaWebSocket,
  placeTakeProfitMarketOrderViaWebSocket,
  modifyOrderViaWebSocket,
  cancelOrderByIdViaWebSocket,
  getMultipleOrderStatusViaWebSocket,
  getOrderStatusViaWebSocket,
  getAccountInformationV2,
  getAccountBalance,
  syncAccountBalanceViaWebSocket,
  validateOrderParams,
  validateModifyOrderParams
};
