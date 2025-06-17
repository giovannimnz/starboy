const { 
  getMaxLeverage, changeInitialLeverage, changeMarginType, 
  newOrder, cancelOrder, getOpenOrders, getPositionDetails
} = require('../api');
const { getDatabaseInstance, initializeDatabase } = require('../db/conexao');
const fs = require('fs').promises;
const path = require('path');

describe('Testes de Integração do Fluxo Completo', () => {
  const testSymbol = 'BTCUSDT';
  const positionsFile = path.join(__dirname, '..', 'posicoes', 'posicoes.json');
  let db;
  
  beforeAll(async () => {
    await initializeDatabase();
    db = await getDatabaseInstance();
  });
  
  test('Fluxo completo: criar ordem, processar, executar SL/TP', async () => {
    // 1. Configurar alavancagem e margem
    await changeInitialLeverage(testSymbol, 10);
    await changeMarginType(testSymbol, 'ISOLATED');
    
    // 2. Criar trade no arquivo posicoes.json
    const currentPrice = 40000; // Usar um preço fictício para teste
    const testTrade = {
      id: Date.now().toString(),
      symbol: testSymbol,
      side: 'COMPRA',
      leverage: 10,
      capital_pct: 1, // Usar um valor baixo para testes
      entry: currentPrice.toString(),
      tp: (currentPrice * 1.1).toString(), // 10% acima
      stop_loss: (currentPrice * 0.9).toString(), // 10% abaixo
      timestamp: new Date().toLocaleString('pt-BR'),
      message_id: null,
      chat_id: null,
      status: 'PENDING_ENTRY',
      updated_at: new Date().toISOString()
    };
    
    await fs.writeFile(positionsFile, JSON.stringify([testTrade], null, 2));
    console.log('Trade criado no arquivo posicoes.json');
    
    // 3. Importar monitoramento para iniciar processamento
    const monitoramento = require('../posicoes/monitoramento');
    
    // 4. Aguardar processamento do trade
    console.log('Aguardando processamento do trade...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 5. Verificar se a ordem foi criada no arquivo
    const content = await fs.readFile(positionsFile, 'utf8');
    const trades = JSON.parse(content);
    
    if (trades.length > 0 && trades[0].entry_order_id) {
      const orderId = trades[0].entry_order_id;
      console.log(`Ordem de entrada criada com ID: ${orderId}`);
      
      // 6. Cancelar a ordem criada (limpeza)
      try {
        await cancelOrder(orderId, testSymbol);
        console.log(`Ordem ${orderId} cancelada com sucesso`);
      } catch (error) {
        console.log(`Erro ao cancelar ordem ${orderId}: ${error.message}`);
      }
    } else {
      console.log('Nenhuma ordem foi criada ou ocorreu um erro.');
      console.log('Estado atual do trade:', trades.length > 0 ? trades[0] : 'Nenhum trade');
    }
  });
});