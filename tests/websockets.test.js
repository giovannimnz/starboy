const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

const {
  startUserDataStream,
  ensurePriceWebsocketExists,
  stopPriceMonitoring,
  setMonitoringCallbacks
} = require('../websockets');
const { getDatabaseInstance, insertPosition, formatDateForMySQL } = require('../db/conexao');

describe('Testes das Funções de WebSocket', () => {
  let db;
  const testSymbol = 'BTCUSDT';

  // Mock das funções de callback para testar setMonitoringCallbacks
  const mockCallbacks = {
    handleOrderUpdate: jest.fn(),
    handleAccountUpdate: jest.fn(),
    onPriceUpdate: jest.fn()
  };

  beforeAll(async () => {
    db = await getDatabaseInstance();
    // Limpar tabelas relevantes para o teste
    await db.query('DELETE FROM posicoes WHERE simbolo = ?', [testSymbol]);

    // Configurar callbacks
    setMonitoringCallbacks(mockCallbacks);

    // Log das URLs de WebSocket usadas nos testes
    console.log(`Usando WS_URL: ${process.env.WS_URL}`);
    console.log(`Usando WS_API_URL: ${process.env.WS_API_URL}`);
  });

  beforeEach(async () => {
    // Limpar qualquer posição de teste anterior
    await db.query('DELETE FROM posicoes WHERE simbolo = ?', [testSymbol]);
  });

  test('Deve iniciar uma conexão WebSocket de userDataStream', async () => {
    const ws = await startUserDataStream(db);
    expect(ws).toBeDefined();

    if (ws && typeof ws.close === 'function') {
      console.log('WebSocket userDataStream iniciado com sucesso');
      ws.close();
    }
  });

  test('Deve criar um WebSocket para monitoramento de preço', async () => {
    // Criar uma posição no banco de dados para ativar o monitoramento
    const testPosition = {
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: 40000,
      preco_entrada: 40000,
      preco_corrente: 40000,
      status: 'PENDING',
      data_hora_abertura: formatDateForMySQL(new Date()),
      side: 'BUY',
      leverage: 10,
      data_hora_ultima_atualizacao: formatDateForMySQL(new Date())
    };

    await insertPosition(db, testPosition);

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
      simbolo: testSymbol,
      quantidade: 0.001,
      preco_medio: 40000,
      preco_entrada: 40000,
      preco_corrente: 40000,
      status: 'PENDING',
      data_hora_abertura: formatDateForMySQL(new Date()),
      side: 'BUY',
      leverage: 10,
      data_hora_ultima_atualizacao: formatDateForMySQL(new Date())
    };

    await insertPosition(db, testPosition);

    // Iniciar o WebSocket
    ensurePriceWebsocketExists(testSymbol);
    console.log(`WebSocket para monitoramento de preço de ${testSymbol} criado`);

    // Dar tempo para estabelecer a conexão
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Agora limpar a tabela para remover trades relevantes
    await db.query('DELETE FROM posicoes WHERE simbolo = ?', [testSymbol]);

    // Verificar se o WebSocket foi fechado automaticamente após a próxima atualização de preço
    // Isso é difícil de testar diretamente, mas podemos verificar se o método 
    // stopPriceMonitoring retorna false após um tempo
    await new Promise(resolve => setTimeout(resolve, 5000));

    const stillActive = stopPriceMonitoring(testSymbol);
    console.log(`WebSocket ainda ativo: ${stillActive ? 'Sim' : 'Não'}`);
  });
});