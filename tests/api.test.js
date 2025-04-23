const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const { 
  getMaxLeverage, changeInitialLeverage, changeMarginType, 
  newOrder, newStopOrder, cancelOrder, getOpenOrders,
  getPositionDetails, getAllOpenPositions, setPositionMode, getPositionMode
} = require('../api');

// Log inicial para verificar configuração do testnet
console.log(`Testando API com URL: ${process.env.API_URL}`);

// Configuração antes de todos os testes
beforeAll(async () => {
  // Configurar modo de posição para one-way
  await setPositionMode(false);
  console.log('Modo de posição definido como one-way para testes');
});

describe('Testes da API da Binance', () => {
  // Variáveis para uso nos testes
  const symbol = 'BTCUSDT';
  let orderId;
  
  test('Deve obter a alavancagem máxima para BTCUSDT', async () => {
    const maxLeverage = await getMaxLeverage(symbol);
    expect(maxLeverage).toBeGreaterThan(0);
    console.log(`Alavancagem máxima para ${symbol}: ${maxLeverage}`);
  });
  
  test('Deve alterar a alavancagem para 10x', async () => {
    const response = await changeInitialLeverage(symbol, 10);
    expect(response).toHaveProperty('leverage');
    expect(response.leverage).toBe(10);
    console.log(`Alavancagem alterada para ${response.leverage}x`);
  });
  
  test('Deve alterar o tipo de margem para isolada', async () => {
    const response = await changeMarginType(symbol, 'ISOLATED');
    expect(response).toBeDefined();
    console.log(`Tipo de margem alterado: ${JSON.stringify(response)}`);
  });
  
  test('Deve criar uma ordem limite', async () => {
    // Obter preço atual e calcular preço abaixo
    const positions = await getAllOpenPositions(symbol);
    const currentPrice = positions.length > 0 ? positions[0].preco_corrente : 40000; // Valor padrão se não houver posição
    const orderPrice = Math.round(currentPrice * 0.9); // 10% abaixo do preço atual
    
    const response = await newOrder(symbol, 0.001, 'BUY', orderPrice);
    expect(response.data).toHaveProperty('orderId');
    orderId = response.data.orderId;
    console.log(`Ordem limite criada com ID: ${orderId}`);
  });
  
  test('Deve cancelar uma ordem', async () => {
    if (!orderId) {
      console.warn('Nenhuma ordem disponível para cancelar');
      return;
    }
    
    const response = await cancelOrder(orderId, symbol);
    expect(response).toBeDefined();
    console.log(`Ordem ${orderId} cancelada: ${JSON.stringify(response)}`);
  });
  
  test('Deve obter ordens abertas', async () => {
    const orders = await getOpenOrders(symbol);
    expect(Array.isArray(orders)).toBe(true);
    console.log(`Total de ordens abertas para ${symbol}: ${orders.length}`);
  });
  
  test('Deve verificar o modo de posição', async () => {
    const mode = await getPositionMode();
    expect(typeof mode).toBe('boolean');
    console.log(`Modo de posição: ${mode ? 'Hedge Mode' : 'One-way Mode'}`);
  });
  
  test('Deve obter detalhes da posição', async () => {
    const positions = await getPositionDetails(symbol);
    expect(Array.isArray(positions)).toBe(true);
    if (positions.length > 0) {
      console.log(`Detalhes da posição para ${symbol}:`, positions[0]);
    } else {
      console.log(`Nenhuma posição aberta para ${symbol}`);
    }
  });
});