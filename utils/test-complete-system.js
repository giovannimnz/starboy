// Teste completo do sistema
const api = require('./api');

async function testSystem() {
  console.log('🧪 Testando sistema completo...');
  
  try {
    console.log('1. Testando carregamento de credenciais...');
    const credentials = await api.loadCredentialsFromDatabase(1);
    console.log('   ✅ Credenciais carregadas:', {
      apiKey: credentials.apiKey ? 'OK' : 'MISSING',
      secretKey: credentials.secretKey ? 'OK' : 'MISSING',
      apiUrl: credentials.apiUrl || 'MISSING'
    });
    
    console.log('2. Testando getAccountConnectionState...');
    const state = api.getAccountConnectionState(1);
    console.log('   ✅ Estado da conta:', {
      exists: !!state,
      apiKey: state?.apiKey ? 'OK' : 'MISSING',
      apiUrl: state?.apiUrl || 'MISSING'
    });
    
    if (state && state.apiKey && state.apiUrl) {
      console.log('3. Testando getPrice...');
      const price = await api.getPrice('BTCUSDT', 1);
      console.log('   ✅ Preço BTCUSDT:', price || 'FALHOU');
      
      console.log('4. Testando getAllOpenPositions...');
      const positions = await api.getAllOpenPositions(1);
      console.log('   ✅ Posições encontradas:', positions.length);
    } else {
      console.log('❌ Estado da conta incompleto, pulando testes de API');
    }
    
    console.log('\n🎉 Teste concluído!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  testSystem();
}

module.exports = { testSystem };