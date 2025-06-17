// Teste detalhado do carregamento de credenciais
const api = require('./api');

async function testDetailedCredentials() {
  console.log('🧪 Testando carregamento detalhado de credenciais...');
  
  try {
    console.log('\n=== TESTE 1: Verificação inicial do estado ===');
    let initialState = api.getAccountConnectionState(1);
    console.log('Estado inicial:', initialState ? 'EXISTE' : 'NÃO EXISTE');
    
    console.log('\n=== TESTE 2: Carregamento de credenciais ===');
    const credentials = await api.loadCredentialsFromDatabase(1);
    console.log('Credenciais retornadas:', {
      accountId: credentials.accountId,
      apiKey: credentials.apiKey ? 'OK' : 'MISSING',
      secretKey: credentials.secretKey ? 'OK' : 'MISSING',
      wsApiKey: credentials.wsApiKey ? 'OK' : 'MISSING',
      wsApiSecret: credentials.wsApiSecret ? 'OK' : 'MISSING',
      apiUrl: credentials.apiUrl || 'MISSING',
      wsUrl: credentials.wsUrl || 'MISSING',
      wsApiUrl: credentials.wsApiUrl || 'MISSING',
      ambiente: credentials.ambiente || 'MISSING',
      corretora: credentials.corretora || 'MISSING'
    });
    
    console.log('\n=== TESTE 3: Verificação do estado após carregamento ===');
    const stateAfterLoad = api.getAccountConnectionState(1);
    console.log('Estado após carregamento existe:', !!stateAfterLoad);
    
    if (stateAfterLoad) {
      console.log('Detalhes do estado:');
      console.log('  - accountId:', stateAfterLoad.accountId);
      console.log('  - apiKey:', stateAfterLoad.apiKey ? stateAfterLoad.apiKey.substring(0, 8) + '...' : 'MISSING');
      console.log('  - secretKey:', stateAfterLoad.secretKey ? 'OK' : 'MISSING');
      console.log('  - apiUrl:', stateAfterLoad.apiUrl || 'MISSING');
      console.log('  - wsUrl:', stateAfterLoad.wsUrl || 'MISSING');
      
      if (stateAfterLoad.apiKey && stateAfterLoad.secretKey && stateAfterLoad.apiUrl) {
        console.log('\n=== TESTE 4: Testando API calls ===');
        
        try {
          console.log('4.1 Testando getPrice...');
          const price = await api.getPrice('BTCUSDT', 1);
          console.log('   ✅ Preço BTCUSDT:', price || 'FALHOU');
        } catch (priceError) {
          console.error('   ❌ Erro no getPrice:', priceError.message);
        }
        
        try {
          console.log('4.2 Testando getAllOpenPositions...');
          const positions = await api.getAllOpenPositions(1);
          console.log('   ✅ Posições encontradas:', positions.length);
        } catch (posError) {
          console.error('   ❌ Erro no getAllOpenPositions:', posError.message);
        }
      } else {
        console.log('❌ Estado incompleto, não é possível testar API calls');
      }
    } else {
      console.log('❌ Estado não foi criado após carregamento de credenciais');
    }
    
    console.log('\n🎉 Teste detalhado concluído!');
    
  } catch (error) {
    console.error('❌ Erro no teste detalhado:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testDetailedCredentials();
}

module.exports = { testDetailedCredentials };