const path = require('path');
// Carregar variáveis de ambiente do .env.test explicitamente
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const fs = require('fs').promises;
const { newOrder, getPrice } = require('../api');
const { 
  getDatabaseInstance, 
  insertPosition, 
  insertNewOrder, 
  insertWebhookSignal,
  formatDateForMySQL  // Adicione esta função ao import
} = require('../db/conexao');

// Mock do módulo de WebSockets e API
jest.mock('../websockets', () => ({
  ensurePriceWebsocketExists: jest.fn(),
  stopPriceMonitoring: jest.fn(),
  setMonitoringCallbacks: jest.fn()
}));

jest.mock('../api', () => ({
  newOrder: jest.fn().mockResolvedValue({ data: { orderId: '12345678' } }),
  getPrice: jest.fn().mockResolvedValue(40000),
  cancelOrder: jest.fn().mockResolvedValue(true),
  newStopOrder: jest.fn().mockImplementation((symbol, side, quantity, price, stopPrice, reduceOnly = false) => {
    return Promise.resolve({ 
      data: { 
        orderId: Math.floor(Math.random() * 1000000).toString() 
      } 
    });
  }),
  changeInitialLeverage: jest.fn().mockResolvedValue(true),
  changeMarginType: jest.fn().mockResolvedValue(true),
  getFuturesAccountBalanceDetails: jest.fn().mockResolvedValue({
    data: [{ asset: 'USDT', availableBalance: '1000' }]
  }),
  getPrecision: jest.fn().mockResolvedValue({ quantityPrecision: 3, pricePrecision: 2 })
}));

describe('Testes das Funções de Monitoramento', () => {
  let db;
  const testSymbol = 'BTCUSDT';
  
  beforeAll(async () => {
    db = await getDatabaseInstance();
    // Limpar tabelas relevantes para o teste - ORDEM CORRETA
    await db.query('DELETE FROM webhook_signals');
    await db.query('DELETE FROM ordens'); // ⚠️ Primeiro remove as ordens
    await db.query('DELETE FROM posicoes'); // Depois remove as posições
    await db.query('DELETE FROM posicoes_fechadas');
    await db.query('DELETE FROM ordens_fechadas');
  });
  
  afterEach(async () => {
    // Limpar tabelas após cada teste - ORDEM CORRETA
    await db.query('DELETE FROM webhook_signals');
    await db.query('DELETE FROM ordens'); // ⚠️ Primeiro remove as ordens
    await db.query('DELETE FROM posicoes'); // Depois remove as posições
    await db.query('DELETE FROM posicoes_fechadas');
    await db.query('DELETE FROM ordens_fechadas');
  });
  
  test('Deve processar um novo webhook e criar ordem de entrada', async () => {
    // 1. Inserir webhook signal no banco
    const currentPrice = 40000;
    const signalId = await insertWebhookSignal(db, {
      symbol: testSymbol,
      side: 'COMPRA',
      capital_pct: 1, // 1% do capital
      leverage: 100,  // 100x
      status: 'PENDING',
      created_at: new Date().toISOString(),
      chat_id: '123456789'
    });
    
    // 2. Importar o monitoramento e executar verificação
    const monitoramento = require('../posicoes/monitoramento');
    const { processSignal } = monitoramento;
    
    // Simular getPrice
    getPrice.mockResolvedValue(currentPrice);
    
    // 3. Processar o sinal
    await processSignal(db, { id: signalId, symbol: testSymbol, side: 'COMPRA', leverage: 100, capital_pct: 1, chat_id: '123456789' });
    
    // 4. Verificar se a posição foi criada no banco
    const [positions] = await db.query('SELECT * FROM posicoes WHERE status = "PENDING"');
    expect(positions.length).toBe(1);
    
    // 5. Verificar se a ordem de entrada foi criada com preço 0.05% abaixo do preço atual
    const [orders] = await db.query('SELECT * FROM ordens WHERE tipo_ordem_bot = "ENTRADA"');
    expect(orders.length).toBe(1);
    
    const entryOrder = orders[0];
    const expectedEntryPrice = currentPrice * 0.9995; // 0.05% abaixo
    expect(parseFloat(entryOrder.preco)).toBeCloseTo(expectedEntryPrice, 1);
    
    // 6. Verificar status do webhook_signal
    const [webhookUpdated] = await db.query('SELECT * FROM webhook_signals WHERE id = ?', [signalId]);
    expect(webhookUpdated[0].status).toBe('PROCESSED');
  });
  
  test('Deve detectar quando TP é atingido antes da entrada', async () => {
    // 1. Criar posição pendente no banco
    const currentPrice = 40000;
    const entryPrice = currentPrice * 0.9995; // 0.05% abaixo
    const tpPrice = entryPrice * 1.0025; // 0.25% acima do preço de entrada
    const slPrice = entryPrice * 0.9975; // 0.25% abaixo do preço de entrada
    
    const positionId = await insertPosition(db, {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: entryPrice,
      status: 'PENDING',
      data_hora_abertura: formatDateForMySQL(new Date()),
      side: 'BUY',
      leverage: 100,
      data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
      preco_entrada: entryPrice,
      preco_corrente: currentPrice
    });
    
    // 2. Criar ordem de entrada no banco
    const orderId = '123456789';
    await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: entryPrice,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: formatDateForMySQL(new Date()),
      id_externo: orderId,
      side: 'BUY',
      simbolo: testSymbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: formatDateForMySQL(new Date())
    });
    
    // 3. Criar registro na tabela webhook_signals com preços de TP e SL
    await db.query(`
      INSERT INTO webhook_signals 
      (symbol, side, leverage, capital_pct, status, created_at, position_id, entry_order_id, tp_price, sl_price) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [testSymbol, 'COMPRA', 100, 1, 'PROCESSED', new Date().toISOString(), positionId, orderId, tpPrice, slPrice]);
    
    // 4. Simular uma atualização de preço que atinge o TP
    const monitoramento = require('../posicoes/monitoramento');
    const { onPriceUpdate } = monitoramento;
    
    // Simular um preço que supera o TP
    await onPriceUpdate(testSymbol, tpPrice + 10, [], []);
    
    // 5. Verificar se a ordem foi cancelada e movida para histórico
    const [openOrders] = await db.query('SELECT * FROM ordens WHERE id_externo = ?', [orderId]);
    const [closedOrders] = await db.query('SELECT * FROM ordens_fechadas WHERE id_externo = ?', [orderId]);
    const [closedPositions] = await db.query('SELECT * FROM posicoes_fechadas WHERE id = ?', [positionId]);
    
    expect(openOrders.length).toBe(0);
    expect(closedOrders.length).toBe(1);
    expect(closedPositions.length).toBe(1);
    expect(closedPositions[0].status).toBe('CANCELED');
  });
  
  test('Deve criar ordens SL e TP quando uma ordem de entrada é preenchida', async () => {
    // 1. Criar posição no banco de dados
    const currentPrice = 40000;
    const entryPrice = currentPrice * 0.9995; // 0.05% abaixo
    const tpPrice = entryPrice * 1.0025; // 0.25% acima do preço de entrada
    const slPrice = entryPrice * 0.9975; // 0.25% abaixo do preço de entrada
    
    const positionId = await insertPosition(db, {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: entryPrice,
      status: 'PENDING',
      data_hora_abertura: formatDateForMySQL(new Date()),
      side: 'BUY',
      leverage: 100,
      data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
      preco_entrada: entryPrice,
      preco_corrente: currentPrice
    });
    
    // 2. Criar uma ordem de entrada no banco de dados
    const orderId = '987654321';
    await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: entryPrice,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: formatDateForMySQL(new Date()),
      id_externo: orderId,
      side: 'BUY',
      simbolo: testSymbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: formatDateForMySQL(new Date())
    });
    
    // 3. Criar registro na tabela webhook_signals com preços de TP e SL
    await db.query(`
      INSERT INTO webhook_signals 
      (symbol, side, leverage, capital_pct, status, created_at, position_id, entry_order_id, tp_price, sl_price) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [testSymbol, 'COMPRA', 100, 1, 'PROCESSED', new Date().toISOString(), positionId, orderId, tpPrice, slPrice]);
    
    // 4. Simular uma atualização de ordem preenchida
    const monitoramento = require('../posicoes/monitoramento');
    const { handleOrderUpdate } = monitoramento;
    
    // Criar mensagem simulada de ordem preenchida
    const orderUpdateMsg = {
      s: testSymbol,
      i: orderId,
      X: 'FILLED'
    };
    
    // Chamar handleOrderUpdate
    await handleOrderUpdate(orderUpdateMsg, db);
    
    // 5. Verificar se as ordens de TP e SL foram criadas
    const [orders] = await db.query('SELECT * FROM ordens WHERE id_posicao = ? AND tipo_ordem_bot IN ("TAKE_PROFIT", "STOP_LOSS")', [positionId]);
    const tpOrders = orders.filter(o => o.tipo_ordem_bot === 'TAKE_PROFIT');
    const slOrders = orders.filter(o => o.tipo_ordem_bot === 'STOP_LOSS');
    
    expect(tpOrders.length).toBe(1);
    expect(slOrders.length).toBe(1);
    
    // 6. Verificar se a posição foi atualizada para OPEN
    const [positions] = await db.query('SELECT * FROM posicoes WHERE id = ?', [positionId]);
    expect(positions[0].status).toBe('OPEN');
  });
  
  test('Deve fechar posição quando ordem TP é preenchida', async () => {
    // 1. Criar posição OPEN no banco
    const currentPrice = 40000;
    const entryPrice = currentPrice * 0.9995;
    const tpPrice = entryPrice * 1.0025;
    const slPrice = entryPrice * 0.9975;
    
    const positionId = await insertPosition(db, {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: entryPrice,
      status: 'OPEN',
      data_hora_abertura: formatDateForMySQL(new Date()),
      side: 'BUY',
      leverage: 100,
      data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
      preco_entrada: entryPrice,
      preco_corrente: currentPrice
    });
    
    // 2. Criar ordens de TP e SL
    const tpOrderId = 'tp12345';
    await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: tpPrice,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: formatDateForMySQL(new Date()),
      id_externo: tpOrderId,
      side: 'SELL',
      simbolo: testSymbol,
      tipo_ordem_bot: 'TAKE_PROFIT',
      target: null,
      reduce_only: true,
      close_position: false,
      last_update: formatDateForMySQL(new Date())
    });
    
    const slOrderId = 'sl12345';
    await insertNewOrder(db, {
      tipo_ordem: 'STOP_MARKET',
      preco: slPrice,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: formatDateForMySQL(new Date()),
      id_externo: slOrderId,
      side: 'SELL',
      simbolo: testSymbol,
      tipo_ordem_bot: 'STOP_LOSS',
      target: null,
      reduce_only: true,
      close_position: false,
      last_update: formatDateForMySQL(new Date())
    });
    
    // 3. Simular uma atualização de ordem TP preenchida
    const monitoramento = require('../posicoes/monitoramento');
    const { handleOrderUpdate } = monitoramento;
    
    const orderUpdateMsg = {
      s: testSymbol,
      i: tpOrderId,
      X: 'FILLED'
    };
    
    // Chamar handleOrderUpdate
    await handleOrderUpdate(orderUpdateMsg, db);
    
    // 4. Verificar se a posição foi movida para fechadas
    const [openPositions] = await db.query('SELECT * FROM posicoes WHERE id = ?', [positionId]);
    const [closedPositions] = await db.query('SELECT * FROM posicoes_fechadas WHERE id = ?', [positionId]);
    
    expect(openPositions.length).toBe(0);
    expect(closedPositions.length).toBe(1);
    expect(closedPositions[0].status).toBe('CLOSED');
    
    // 5. Verificar se a ordem SL foi cancelada e movida para fechadas
    const [openSlOrders] = await db.query('SELECT * FROM ordens WHERE id_externo = ?', [slOrderId]);
    const [closedSlOrders] = await db.query('SELECT * FROM ordens_fechadas WHERE id_externo = ?', [slOrderId]);
    
    expect(openSlOrders.length).toBe(0);
    expect(closedSlOrders.length).toBe(1);
    expect(closedSlOrders[0].status).toBe('CANCELED');
  });
});