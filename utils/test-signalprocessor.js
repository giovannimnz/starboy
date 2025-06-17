// Teste específico do signalProcessor
const { checkNewTrades } = require('./posicoes/signalProcessor');

async function testSignalProcessor() {
  console.log('🧪 Testando signalProcessor...');
  
  try {
    console.log('\n=== TESTE: checkNewTrades ===');
    
    // Testar com accountId válido
    await checkNewTrades(1);
    console.log('✅ checkNewTrades executado sem erros de sintaxe');
    
    console.log('\n🎉 signalProcessor funcionando corretamente!');
    
  } catch (error) {
    console.error('❌ Erro no teste do signalProcessor:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testSignalProcessor();
}

module.exports = { testSignalProcessor };