// Teste debug para capturar chamada com accountId undefined
const websockets = require('./websockets');

// Mock da função para capturar chamadas
const originalSetupBookDepth = websockets.setupBookDepthWebsocket;

websockets.setupBookDepthWebsocket = function(...args) {
  console.log('\n🔍 INTERCEPTADA chamada setupBookDepthWebsocket:');
  console.log('Argumentos:', args);
  console.log('Tipos:', args.map(arg => typeof arg));
  
  if (!args[1] || typeof args[1] !== 'number') {
    console.error('❌ PROBLEMA ENCONTRADO! accountId inválido:', args[1]);
    console.error('Stack trace:');
    console.error(new Error().stack);
  }
  
  return originalSetupBookDepth.apply(this, args);
};

// Simular execução do limitMakerEntry
async function simulateExecution() {
  try {
    console.log('🧪 Simulando execução que causa o erro...');
    
    // Tentar importar e usar limitMakerEntry
    const limitMaker = require('./posicoes/limitMakerEntry');
    
    console.log('✅ limitMakerEntry importado sem erro');
    console.log('\n⚠️ Para testar completamente, execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    
  } catch (error) {
    console.error('❌ Erro na simulação:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

if (require.main === module) {
  simulateExecution();
}

module.exports = { simulateExecution };