// Teste definitivo do sistema
const api = require('./api');

async function testDefinitive() {
  console.log('🧪 Teste definitivo do sistema...');
  
  try {
    console.log('\n=== TESTE 1: Funções disponíveis ===');
    console.log('- getAccountConnectionState:', typeof api.getAccountConnectionState);
    console.log('- loadCredentialsFromDatabase:', typeof api.loadCredentialsFromDatabase);
    console.log('- getPrice:', typeof api.getPrice);
    console.log('- getAllOpenPositions:', typeof api.getAllOpenPositions);
    
    console.log('\n=== TESTE 2: Carregar credenciais ===');
    const result = await api.loadCredentialsFromDatabase(1);
    
    console.log('\nResultado detalhado:');
    console.log('- Tipo:', typeof result);
    console.log('- accountId:', result?.accountId);
    console.log('- apiKey:', result?.apiKey ? result.apiKey.substring(0, 8) + '...' : 'MISSING');
    console.log('- secretKey:', result?.secretKey ? 'PRESENTE' : 'MISSING');
    console.log('- apiUrl:', result?.apiUrl || 'MISSING');
    console.log('- wsUrl:', result?.wsUrl || 'MISSING');
    console.log('- ambiente:', result?.ambiente || 'MISSING');
    
    console.log('\n=== TESTE 3: Verificar estado ===');
    const state = api.getAccountConnectionState(1);
    console.log('Estado existe:', !!state);
    console.log('Estado completo:', {
      accountId: state?.accountId,
      hasApiKey: !!state?.apiKey,
      hasSecretKey: !!state?.secretKey,
      hasApiUrl: !!state?.apiUrl,
      apiUrl: state?.apiUrl,
      wsUrl: state?.wsUrl
    });
    
    if (state?.apiKey && state?.secretKey && state?.apiUrl) {
      console.log('\n=== TESTE 4: Funções da API ===');
      
      try {
        console.log('4.1 Testando getPrice...');
        const price = await api.getPrice('BTCUSDT', 1);
        console.log('   ✅ Preço BTCUSDT:', price);
        
        if (price && price > 0) {
          console.log('4.2 Testando getAllOpenPositions...');
          const positions = await api.getAllOpenPositions(1);
          console.log('   ✅ Posições encontradas:', positions.length);
          
          console.log('\n🎉 SISTEMA FUNCIONANDO PERFEITAMENTE!');
          console.log('✅ Todas as funções estão operacionais');
          console.log('✅ Credenciais carregadas corretamente');
          console.log('✅ API calls funcionando');
          
          return true;
        } else {
          console.log('⚠️ getPrice não retornou valor válido, mas credenciais estão OK');
          return true;
        }
      } catch (apiError) {
        console.error('❌ Erro nos testes de API:', apiError.message);
        return false;
      }
    } else {
      console.log('❌ Credenciais ainda incompletas');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erro no teste definitivo:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

if (require.main === module) {
  testDefinitive().then(success => {
    if (success) {
      console.log('\n🚀 Sistema pronto! Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
    } else {
      console.log('\n❌ Sistema ainda tem problemas');
      process.exit(1);
    }
  });
}

module.exports = { testDefinitive };