// ✅ TESTE DO SISTEMA DE BUFFER PARA REVERSE.JS
const path = require('path');

// Mock das dependências
const mockDatabaseInstance = {
  getConnection: () => ({
    query: (sql, params) => {
      console.log(`[TEST_DB] Query: ${sql}`);
      console.log(`[TEST_DB] Params:`, params);
      return [{ insertId: Math.floor(Math.random() * 1000) }];
    },
    beginTransaction: () => console.log('[TEST_DB] Begin transaction'),
    commit: () => console.log('[TEST_DB] Commit'),
    rollback: () => console.log('[TEST_DB] Rollback'),
    release: () => console.log('[TEST_DB] Connection released')
  }),
  query: (sql, params) => {
    console.log(`[TEST_DB] Direct query: ${sql}`);
    return [[]];
  }
};

const mockInsertPosition = (data, accountId) => {
  console.log(`[TEST_MOCK] insertPosition called:`, { data: data.simbolo, accountId });
  return { insertId: 123 };
};

const mockInsertNewOrder = (data, accountId) => {
  console.log(`[TEST_MOCK] insertNewOrder called:`, { 
    orderId: data.id_externo, 
    type: data.tipo_ordem_bot, 
    accountId 
  });
  return { insertId: 456 };
};

// Simular os buffers
const positionBuffer = new Map();
const orderBuffer = new Map();

// Funções de buffer (copiadas do reverse.js)
function createPositionBuffer(signal, totalSize, averagePrice, accountId) {
  const positionData = {
    id: `signal_${signal.id}`,
    simbolo: signal.symbol,
    quantidade: totalSize,
    preco_entrada: averagePrice,
    preco_medio: averagePrice,
    preco_corrente: averagePrice,
    side: signal.side,
    status: 'OPEN',
    conta_id: accountId,
    leverage: signal.leverage,
    data_hora_abertura: new Date(),
    data_hora_ultima_atualizacao: new Date(),
    orign_sig: `WEBHOOK_${signal.id}`,
    signal_id: signal.id
  };
  
  positionBuffer.set(signal.id, positionData);
  console.log(`[BUFFER] Posição adicionada ao buffer: ${signal.symbol} (${totalSize.toFixed(8)})`);
  return positionData;
}

function addOrderToBuffer(orderData, signalId) {
  const bufferedOrder = {
    id_externo: String(orderData.orderId),
    simbolo: orderData.symbol,
    tipo_ordem: orderData.type || 'LIMIT',
    tipo_ordem_bot: orderData.orderType || 'ENTRADA',
    side: orderData.side,
    quantidade: parseFloat(orderData.quantity || orderData.origQty || 0),
    preco: parseFloat(orderData.price || 0),
    status: orderData.status || 'NEW',
    preco_stop: orderData.stopPrice ? parseFloat(orderData.stopPrice) : null,
    data_hora_criacao: new Date(),
    data_hora_ultima_atualizacao: new Date(),
    orign_sig: `WEBHOOK_${signalId}`,
    conta_id: orderData.accountId,
    quantidade_executada: parseFloat(orderData.executedQty || 0),
    preco_medio: parseFloat(orderData.avgPrice || orderData.price || 0),
    reduce_only: orderData.reduceOnly || false,
    close_position: orderData.closePosition || false,
    target: orderData.target || null,
    signal_id: signalId
  };
  
  orderBuffer.set(String(orderData.orderId), bufferedOrder);
  console.log(`[BUFFER] Ordem adicionada ao buffer: ${orderData.orderId} (${orderData.type})`);
  return bufferedOrder;
}

async function insertBufferedDataToDB(signalId, accountId, connection) {
  try {
    console.log(`[BUFFER] 📤 Iniciando inserção no banco para signal ${signalId}...`);
    
    // 1. Inserir posição primeiro
    const positionData = positionBuffer.get(signalId);
    let positionId = null;
    
    if (positionData) {
      console.log(`[BUFFER] 📊 Inserindo posição: ${positionData.simbolo}`);
      
      // Vincular o sinal à posição antes de inserir
      await connection.query(
        `UPDATE webhook_signals SET status = 'EXECUTADO', position_id = ? WHERE id = ?`,
        [positionData.id, signalId]
      );
      
      const insertPositionResult = await mockInsertPosition(positionData, accountId);
      positionId = insertPositionResult.insertId;
      
      console.log(`[BUFFER] ✅ Posição inserida com ID: ${positionId}`);
      
      // Limpar buffer da posição
      positionBuffer.delete(signalId);
    }
    
    // 2. Inserir todas as ordens vinculadas ao signal
    const signalOrders = Array.from(orderBuffer.entries())
      .filter(([_, order]) => order.signal_id === signalId);
    
    console.log(`[BUFFER] 📋 Inserindo ${signalOrders.length} ordens...`);
    
    for (const [orderId, orderData] of signalOrders) {
      try {
        // Vincular ordem à posição se houver
        if (positionId) {
          orderData.id_posicao = positionId;
        }
        
        await mockInsertNewOrder(orderData, accountId);
        console.log(`[BUFFER] ✅ Ordem inserida: ${orderId} (${orderData.tipo_ordem_bot})`);
        
        // Remover do buffer após inserção
        orderBuffer.delete(orderId);
      } catch (orderError) {
        console.error(`[BUFFER] ❌ Erro ao inserir ordem ${orderId}:`, orderError.message);
      }
    }
    
    console.log(`[BUFFER] 🎉 Inserção completa para signal ${signalId}`);
    return { success: true, positionId };
    
  } catch (error) {
    console.error(`[BUFFER] ❌ Erro na inserção do buffer:`, error.message);
    throw error;
  }
}

// Teste principal
async function testBuffer() {
  console.log('\n=== 🧪 TESTE DO SISTEMA DE BUFFER ===\n');
  
  const mockSignal = {
    id: 12345,
    symbol: 'BTCUSDT',
    side: 'BUY',
    leverage: 10
  };
  
  const accountId = 1;
  const connection = mockDatabaseInstance.getConnection();
  
  // 1. Criar posição no buffer
  console.log('1️⃣ Criando posição no buffer...');
  createPositionBuffer(mockSignal, 0.5, 45000, accountId);
  
  // 2. Adicionar ordens ao buffer
  console.log('\n2️⃣ Adicionando ordens ao buffer...');
  
  // Ordem de entrada
  addOrderToBuffer({
    orderId: '1001',
    symbol: 'BTCUSDT',
    side: 'BUY',
    quantity: 0.5,
    price: 45000,
    type: 'LIMIT',
    orderType: 'ENTRADA',
    status: 'FILLED',
    accountId: accountId
  }, mockSignal.id);
  
  // Stop Loss
  addOrderToBuffer({
    orderId: '1002',
    symbol: 'BTCUSDT',
    side: 'SELL',
    quantity: null,
    price: 44000,
    stopPrice: 44000,
    type: 'STOP_MARKET',
    orderType: 'STOP_LOSS',
    status: 'NEW',
    accountId: accountId,
    reduceOnly: true,
    closePosition: true
  }, mockSignal.id);
  
  // RP1
  addOrderToBuffer({
    orderId: '1003',
    symbol: 'BTCUSDT',
    side: 'SELL',
    quantity: 0.125,
    price: 46000,
    type: 'LIMIT',
    orderType: 'REDUCAO_PARCIAL',
    status: 'NEW',
    accountId: accountId,
    reduceOnly: true,
    target: 1
  }, mockSignal.id);
  
  // Take Profit
  addOrderToBuffer({
    orderId: '1004',
    symbol: 'BTCUSDT',
    side: 'SELL',
    quantity: null,
    price: 47000,
    stopPrice: 47000,
    type: 'TAKE_PROFIT_MARKET',
    orderType: 'TAKE_PROFIT',
    status: 'NEW',
    accountId: accountId,
    reduceOnly: true,
    closePosition: true,
    target: 5
  }, mockSignal.id);
  
  // 3. Verificar estado dos buffers
  console.log('\n3️⃣ Estado dos buffers:');
  console.log(`[BUFFER_STATUS] Posições no buffer: ${positionBuffer.size}`);
  console.log(`[BUFFER_STATUS] Ordens no buffer: ${orderBuffer.size}`);
  
  // 4. Inserir dados do buffer no banco
  console.log('\n4️⃣ Inserindo dados do buffer no banco...');
  try {
    const result = await insertBufferedDataToDB(mockSignal.id, accountId, connection);
    console.log(`[TEST_RESULT] ✅ Sucesso:`, result);
  } catch (error) {
    console.log(`[TEST_RESULT] ❌ Erro:`, error.message);
  }
  
  // 5. Verificar estado final dos buffers
  console.log('\n5️⃣ Estado final dos buffers:');
  console.log(`[BUFFER_STATUS] Posições no buffer: ${positionBuffer.size}`);
  console.log(`[BUFFER_STATUS] Ordens no buffer: ${orderBuffer.size}`);
  
  console.log('\n=== ✅ TESTE CONCLUÍDO ===\n');
}

// Executar teste
if (require.main === module) {
  testBuffer().catch(console.error);
}

module.exports = { testBuffer };
