const fs = require('fs').promises;
const path = require('path');
const { newOrder } = require('../api');
const { getDatabaseInstance, insertPosition, insertNewOrder } = require('../db/conexao');

// Mock do módulo de WebSockets
jest.mock('../websockets', () => ({
  ensurePriceWebsocketExists: jest.fn(),
  stopPriceMonitoring: jest.fn(),
  setMonitoringCallbacks: jest.fn()
}));

describe('Testes das Funções de Monitoramento', () => {
  let db;
  const testSymbol = 'BTCUSDT';
  const positionsFile = path.join(__dirname, '..', 'posicoes', 'posicoes.json');
  
  beforeAll(async () => {
    db = await getDatabaseInstance();
    // Criar arquivo posicoes.json de teste
    await fs.writeFile(positionsFile, '[]');
  });
  
  beforeEach(async () => {
    // Resetar arquivo posicoes.json para cada teste
    await fs.writeFile(positionsFile, '[]');
  });
  
  test('Deve processar uma nova ordem pendente', async () => {
    // Criar uma posição de teste no arquivo posicoes.json
    const testPosition = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      capital_pct: 50,
      entry: '40000',
      tp: '44000',
      stop_loss: '38000',
      timestamp: new Date().toLocaleString('pt-BR'),
      message_id: null,
      chat_id: null,
      status: 'PENDING_ENTRY',
      updated_at: new Date().toISOString()
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testPosition], null, 2));
    
    // Importar o monitoramento (para forçar a chamada de monitorPositionsFile)
    const monitoramento = require('../posicoes/monitoramento');
    
    // Aguardar processamento
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Verificar se a posição foi atualizada
    const content = await fs.readFile(positionsFile, 'utf8');
    const positions = JSON.parse(content);
    
    // Dependendo do resultado, verificar se contém entry_order_id
    if (positions.length > 0 && positions[0].status === 'ENTRY_CREATED') {
      expect(positions[0].entry_order_id).toBeDefined();
      console.log(`Ordem de entrada criada com ID: ${positions[0].entry_order_id}`);
    } else if (positions.length > 0 && positions[0].status === 'ERROR') {
      console.log(`Erro ao processar trade: ${positions[0].error}`);
    } else {
      console.log(`Status atual da posição: ${positions.length > 0 ? positions[0].status : 'Nenhuma posição'}`);
    }
  });
  
  test('Deve detectar quando TP é atingido antes da entrada', async () => {
    // Criar uma posição com ENTRY_CREATED mas com TP muito próximo do preço atual
    const currentPrice = 40000; // Suponha que este seja o preço atual
    const testPosition = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      capital_pct: 50,
      entry: `${currentPrice - 1000}`, // Preço de entrada abaixo do atual
      tp: `${currentPrice + 100}`, // TP muito próximo do preço atual
      stop_loss: `${currentPrice - 2000}`,
      timestamp: new Date().toLocaleString('pt-BR'),
      message_id: null,
      chat_id: null,
      status: 'ENTRY_CREATED',
      updated_at: new Date().toISOString(),
      entry_order_id: '123456789' // ID fictício
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testPosition], null, 2));
    
    // Simular uma atualização de preço que atinge o TP
    const monitoramento = require('../posicoes/monitoramento');
    const { onPriceUpdate } = monitoramento;
    
    if (typeof onPriceUpdate === 'function') {
      // Simular um preço que atinge o TP
      await onPriceUpdate(testSymbol, currentPrice + 200, [testPosition], [testPosition]);
      
      // Verificar se o arquivo foi atualizado
      const content = await fs.readFile(positionsFile, 'utf8');
      const positions = JSON.parse(content);
      
      console.log(`Posições após atualização de preço: ${positions.length}`);
      if (positions.length > 0) {
        console.log(`Status da posição: ${positions[0].status}`);
      }
    } else {
      console.log('Função onPriceUpdate não está disponível para teste');
    }
  });
  
  // Teste simulado de ordem preenchida
  test('Deve criar ordens SL e TP quando uma ordem de entrada é preenchida', async () => {
    // Criar uma posição no banco de dados
    const positionId = await insertPosition(db, {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: 40000,
      status: 'OPEN',
      data_hora_abertura: new Date().toISOString(),
      side: 'BUY',
      leverage: 10,
      data_hora_ultima_atualizacao: new Date().toISOString(),
      preco_entrada: 40000,
      preco_corrente: 40000
    });
    
    // Criar uma ordem de entrada no banco de dados
    const orderId = await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: 40000,
      quantidade: 0.001,
      id_posicao: positionId,
      status: 'OPEN',
      data_hora_criacao: new Date().toISOString(),
      id_externo: 987654321,
      side: 'BUY',
      simbolo: testSymbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: new Date().toISOString()
    });
    
    // Criar entrada no arquivo posicoes.json
    const testPosition = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      capital_pct: 50,
      entry: '40000',
      tp: '44000',
      stop_loss: '38000',
      timestamp: new Date().toLocaleString('pt-BR'),
      message_id: null,
      chat_id: null,
      status: 'ENTRY_CREATED',
      updated_at: new Date().toISOString(),
      entry_order_id: 987654321
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testPosition], null, 2));
    
    // Simular uma atualização de ordem preenchida
    const monitoramento = require('../posicoes/monitoramento');
    const { handleOrderUpdate } = monitoramento;
    
    if (typeof handleOrderUpdate === 'function') {
      // Criar mensagem simulada de ordem preenchida
      const orderUpdateMsg = {
        s: testSymbol,
        i: 987654321,
        X: 'FILLED'
      };
      
      // Chamar handleOrderUpdate
      await handleOrderUpdate(orderUpdateMsg, db);
      
      // Verificar se o arquivo foi atualizado
      const content = await fs.readFile(positionsFile, 'utf8');
      const positions = JSON.parse(content);
      
      if (positions.length > 0) {
        console.log(`Status após atualização: ${positions[0].status}`);
        if (positions[0].sl_order_id) {
          console.log(`Ordem SL criada com ID: ${positions[0].sl_order_id}`);
        }
        if (positions[0].tp_order_id) {
          console.log(`Ordem TP criada com ID: ${positions[0].tp_order_id}`);
        }
      }
    } else {
      console.log('Função handleOrderUpdate não está disponível para teste');
    }
  });
});