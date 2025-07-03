const { getDatabaseInstance } = require('../backend/core/database/conexao');
const { executeLimitMakerEntry } = require('../posicoes/limitMakerEntry');

async function testarLimitMakerEntry(accountId, symbolTest = 'BTCUSDT') {
  console.log(`🧪 TESTE: Limit Maker Entry para conta ${accountId} - ${symbolTest}`);
  
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Sinal de teste com valores válidos para BTCUSDT
    const testSignal = {
      id: 9999,
      symbol: symbolTest,
      side: 'BUY',
      capital_pct: 1, // 1% do capital
      leverage: 10,
      sl_price: 100000, // Stop Loss
      tp1_price: 110000, // TP1 - 10% acima  
      tp2_price: 115000, // TP2 - 15% acima
      tp3_price: 120000, // TP3 - 20% acima
      tp4_price: 125000, // TP4 - 25% acima
      tp_price: 130000,  // TP Final - 30% acima
      entry_price: 103979.40
    };
    
    console.log(`📋 Dados do sinal de teste:`, testSignal);
    
    const result = await executeLimitMakerEntry(testSignal, testSignal.entry_price, accountId);
    
    if (result.success) {
      console.log(`✅ TESTE PASSOU - Posição criada: ${result.positionId}`);
      console.log(`📊 Detalhes: ${result.filledQuantity} @ ${result.averagePrice}`);
    } else {
      console.log(`❌ TESTE FALHOU: ${result.error}`);
    }
    
  } catch (error) {
    console.error(`💥 ERRO NO TESTE:`, error.message);
  }
}

// Executar teste
const accountId = process.argv[2] ? parseInt(process.argv[2]) : 1;
testarLimitMakerEntry(accountId);