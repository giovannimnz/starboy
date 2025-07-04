const { onPriceUpdate } = require('./backend/exchanges/binance/monitoring/signalProcessor');
const { getDatabaseInstance } = require('./backend/core/database/conexao');

async function testSignalProcessing() {
  console.log('🧪 Testando processamento de sinais...');
  
  try {
    // Testar conexão com banco
    const db = await getDatabaseInstance();
    console.log('✅ Conectado ao banco de dados');
    
    // Simular atualização de preço
    const symbol = 'BTCUSDT';
    const currentPrice = 50000;
    const accountId = 1;
    
    console.log(`📊 Simulando atualização de preço: ${symbol} = ${currentPrice} para conta ${accountId}`);
    
    // Chamar a função de processamento de sinais
    await onPriceUpdate(symbol, currentPrice, db, accountId);
    
    console.log('✅ Teste concluído com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.error('Stack:', error.stack);
  }
  
  process.exit(0);
}

testSignalProcessing();
