// Teste simples para verificar getAccountConnectionState
const api = require('./api');
const websockets = require('./websockets');

console.log('🧪 Testando getAccountConnectionState...');

try {
  // Testar api.getAccountConnectionState
  console.log('1. Testando api.getAccountConnectionState...');
  const stateFromApi = api.getAccountConnectionState(1, true);
  console.log('   ✅ api.getAccountConnectionState funciona:', !!stateFromApi);
  
  // Testar websockets.getAccountConnectionState (se existe)
  console.log('2. Testando websockets.getAccountConnectionState...');
  if (typeof websockets.getAccountConnectionState === 'function') {
    const stateFromWebsockets = websockets.getAccountConnectionState(1);
    console.log('   ✅ websockets.getAccountConnectionState funciona:', !!stateFromWebsockets);
  } else {
    console.log('   ❌ websockets.getAccountConnectionState não é uma função');
  }
  
  console.log('\n🎉 Teste concluído!');
  
} catch (error) {
  console.error('❌ Erro no teste:', error.message);
  process.exit(1);
}
