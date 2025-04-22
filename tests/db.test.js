const {
  getDatabaseInstance, insertPosition, getPositionIdBySymbol,
  insertNewOrder, getOrdersFromDb, updateOrderStatus,
  moveClosedPositionsAndOrders, disconnectDatabase, initializeDatabase
} = require('../db/conexao');
const path = require('path');

// Configuração antes de todos os testes
beforeAll(async () => {
  await initializeDatabase();
  console.log('Banco de dados inicializado para testes');
});

// Limpeza após todos os testes
afterAll(async () => {
  await disconnectDatabase();
  console.log('Conexão com banco de dados encerrada');
});

describe('Testes do Banco de Dados MySQL', () => {
  let db;
  let positionId;
  let orderId;
  const testSymbol = 'BTCUSDT';
  
  test('Deve conectar ao banco de dados', async () => {
    db = await getDatabaseInstance();
    expect(db).toBeDefined();
    console.log('Conectado ao banco de dados de teste');
  });
  
  test('Deve inserir uma posição', async () => {
    const position = {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: 40000,
      preco_entrada: 40000,
      preco_corrente: 40000,
      status: 'OPEN',
      data_hora_abertura: new Date().toISOString(),
      side: 'BUY',
      leverage: 10,
      data_hora_ultima_atualizacao: new Date().toISOString()
    };
    
    positionId = await insertPosition(db, position);
    expect(positionId).toBeDefined();
    expect(typeof positionId).toBe('number');
    console.log(`Posição inserida com ID: ${positionId}`);
  });
  
  test('Deve obter o ID da posição pelo símbolo', async () => {
    const id = await getPositionIdBySymbol(db, testSymbol);
    expect(id).toBe(positionId);
    console.log(`ID da posição para ${testSymbol}: ${id}`);
  });
  
  test('Deve inserir uma ordem', async () => {
    const order = {
      tipo_ordem: 'LIMIT',
      preco: 40000,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: new Date().toISOString(),
      id_externo: 12345678,
      side: 'BUY',
      simbolo: testSymbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: new Date().toISOString()
    };
    
    orderId = await insertNewOrder(db, order);
    expect(orderId).toBeDefined();
    expect(typeof orderId).toBe('number');
    console.log(`Ordem inserida com ID: ${orderId}`);
  });
  
  test('Deve consultar ordens com filtros', async () => {
    const orders = await getOrdersFromDb(db, { tipo_ordem_bot: 'ENTRADA' });
    expect(Array.isArray(orders)).toBe(true);
    expect(orders.length).toBeGreaterThan(0);
    console.log(`Encontradas ${orders.length} ordens do tipo ENTRADA`);
  });
  
  test('Deve atualizar o status de uma ordem', async () => {
    await updateOrderStatus(db, orderId, 'FILLED');
    const orders = await getOrdersFromDb(db, { id: orderId });
    expect(orders[0].status).toBe('FILLED');
    console.log(`Status da ordem ${orderId} atualizado para FILLED`);
  });
  
  test('Deve mover posições e ordens fechadas para tabelas históricas', async () => {
    try {
      await moveClosedPositionsAndOrders(db, positionId);
      const positions = await db.query(`SELECT * FROM posicoes WHERE id = ?`, [positionId]);
      expect(positions[0].length).toBe(0);
      console.log(`Posição ${positionId} movida com sucesso para tabela histórica`);
    } catch (error) {
      console.error('Erro ao mover posição:', error);
      throw error;
    }
  });
});