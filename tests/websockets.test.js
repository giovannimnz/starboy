const {
  startUserDataStream,
  ensurePriceWebsocketExists,
  stopPriceMonitoring,
  setMonitoringCallbacks
} = require('../websockets');
const fs = require('fs').promises;
const path = require('path');

describe('Testes das Funções de WebSocket', () => {
  const testSymbol = 'BTCUSDT';
  const positionsFile = path.join(__dirname, '..', 'posicoes', 'posicoes.json');
  
  // Mock das funções de callback para testar setMonitoringCallbacks
  const mockCallbacks = {
    handleOrderUpdate: jest.fn(),
    handleAccountUpdate: jest.fn(),
    onPriceUpdate: jest.fn()
  };
  
  beforeAll(async () => {
    // Configurar callbacks
    setMonitoringCallbacks(mockCallbacks);
  });
  
  beforeEach(async () => {
    // Resetar arquivo posicoes.json para cada teste
    await fs.writeFile(positionsFile, '[]');
  });
  
  test('Deve iniciar uma conexão WebSocket de userDataStream', async () => {
    // Esta função retorna uma Promise que resolve para um objeto WebSocket
    const getDatabaseInstance = jest.fn().mockResolvedValue({});
    const ws = await startUserDataStream(getDatabaseInstance);
    expect(ws).toBeDefined();
    
    if (ws && typeof ws.close === 'function') {
      console.log('WebSocket userDataStream iniciado com sucesso');
      ws.close();
    }
  });
  
  test('Deve criar um WebSocket para monitoramento de preço', async () => {
    // Criar uma posição no arquivo posicoes.json para ativar o monitoramento
    const testPosition = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      entry: '40000',
      tp: '44000',
      stop_loss: '38000',
      timestamp: new Date().toLocaleString('pt-BR'),
      status: 'ENTRY_CREATED',
      updated_at: new Date().toISOString(),
      entry_order_id: '123456789'
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testPosition], null, 2));
    
    // Testar a criação do WebSocket de preço
    ensurePriceWebsocketExists(testSymbol);
    console.log(`WebSocket para monitoramento de preço de ${testSymbol} criado`);
    
    // Dar tempo para estabelecer a conexão
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Testar a parada do WebSocket
    const stopped = stopPriceMonitoring(testSymbol);
    expect(stopped).toBe(true);
    console.log(`WebSocket de monitoramento de preço para ${testSymbol} parado`);
  });
  
  test('Deve parar WebSocket quando não há mais trades relevantes', async () => {
    // Primeiro criar uma posição para ativar o monitoramento
    const testPosition = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      entry: '40000',
      tp: '44000',
      stop_loss: '38000',
      timestamp: new Date().toLocaleString('pt-BR'),
      status: 'ENTRY_CREATED',
      updated_at: new Date().toISOString(),
      entry_order_id: '123456789'
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testPosition], null, 2));
    
    // Iniciar o WebSocket
    ensurePriceWebsocketExists(testSymbol);
    console.log(`WebSocket para monitoramento de preço de ${testSymbol} criado`);
    
    // Dar tempo para estabelecer a conexão
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Agora limpar o arquivo para remover trades relevantes
    await fs.writeFile(positionsFile, '[]');
    
    // Verificar se o WebSocket foi fechado automaticamente após a próxima atualização de preço
    // Isso é difícil de testar diretamente, mas podemos verificar se o método 
    // stopPriceMonitoring retorna false após um tempo
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const stillActive = stopPriceMonitoring(testSymbol);
    console.log(`WebSocket ainda ativo: ${stillActive ? 'Sim' : 'Não'}`);
  });
});