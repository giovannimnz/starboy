// Teste final do sistema corrigido
const api = require('./api');

async function testFinalSystem() {
  console.log('🧪 Teste final do sistema corrigido...');
  
  try {
    console.log('\n=== TESTE 1: Estado inicial ===');
    const initialState = api.getAccountConnectionState(1);
    console.log('Estado inicial existe:', !!initialState);
    
    console.log('\n=== TESTE 2: Carregamento de credenciais ===');
    const result = await api.loadCredentialsFromDatabase(1);
    
    console.log('\nResultado do carregamento:');
    console.log('- Tipo do resultado:', typeof result);
    console.log('- accountId:', result?.accountId);
    console.log('- apiKey:', result?.apiKey ? 'OK' : 'MISSING');
    console.log('- secretKey:', result?.secretKey ? 'OK' : 'MISSING');
    console.log('- apiUrl:', result?.apiUrl || 'MISSING');
    console.log('- wsUrl:', result?.wsUrl || 'MISSING');
    
    console.log('\n=== TESTE 3: Verificação do estado após carregamento ===');
    const stateAfterLoad = api.getAccountConnectionState(1);
    console.log('Estado existe após carregamento:', !!stateAfterLoad);
    
    if (stateAfterLoad && stateAfterLoad.apiKey && stateAfterLoad.apiUrl) {
      console.log('\n=== TESTE 4: Testando funções da API ===');
      
      try {
        console.log('4.1 Testando getPrice...');
        const price = await api.getPrice('BTCUSDT', 1);
        console.log('   ✅ Preço BTCUSDT:', price);
        
        if (price && price > 0) {
          console.log('4.2 Testando getAllOpenPositions...');
          const positions = await api.getAllOpenPositions(1);
          console.log('   ✅ Posições encontradas:', positions.length);
          
          console.log('\n🎉 TODOS OS TESTES PASSARAM!');
          console.log('✅ Sistema está funcionando corretamente');
        } else {
          console.log('⚠️ getPrice não retornou valor válido');
        }
      } catch (apiError) {
        console.error('❌ Erro nos testes de API:', apiError.message);
      }
    } else {
      console.log('❌ Estado incompleto após carregamento');
      console.log('Estado atual:', {
        exists: !!stateAfterLoad,
        hasApiKey: !!stateAfterLoad?.apiKey,
        hasApiUrl: !!stateAfterLoad?.apiUrl
      });
    }
    
  } catch (error) {
    console.error('❌ Erro no teste final:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testFinalSystem();
}

module.exports = { testFinalSystem };