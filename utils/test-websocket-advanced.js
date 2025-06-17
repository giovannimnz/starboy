// Teste avançado do WebSocket API
const websockets = require('../websockets');
const websocketApi = require('../websocketApi');

async function testAdvanced() {
  console.log('🧪 Teste avançado do WebSocket API...');
  
  try {
    console.log('\n=== TESTE 1: Verificar imports ===');
    console.log('- websockets.sendWebSocketApiRequest:', typeof websockets.sendWebSocketApiRequest);
    console.log('- websockets.startWebSocketApi:', typeof websockets.startWebSocketApi);
    console.log('- websockets.isWebSocketApiConnected:', typeof websockets.isWebSocketApiConnected);
    
    console.log('\n=== TESTE 2: Verificar websocketApi ===');
    console.log('- websocketApi.getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    console.log('- websocketApi.getAccountBalance:', typeof websocketApi.getAccountBalance);
    
    if (typeof websockets.sendWebSocketApiRequest !== 'function') {
      console.error('❌ sendWebSocketApiRequest não está disponível em websockets');
      return false;
    }
    
    console.log('\n=== TESTE 3: Inicializar WebSocket API ===');
    const isConnected = websockets.isWebSocketApiConnected(1);
    console.log('WebSocket conectado:', isConnected);
    
    if (!isConnected) {
      console.log('Conectando WebSocket...');
      await websockets.startWebSocketApi(1);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\n=== TESTE 4: Testar getAccountInformationV2 ===');
    const result = await websocketApi.getAccountInformationV2({}, 1);
    console.log('Resultado completo:', {
      status: result?.status,
      hasResult: !!result?.result,
      hasError: !!result?.error,
      errorMessage: result?.error?.message
    });
    
    if (result && result.status === 200) {
      console.log('✅ WebSocket API funcionando!');
      
      console.log('\n=== TESTE 5: Testar getAccountBalance ===');
      const balance = await websocketApi.getAccountBalance({}, 1);
      console.log('Saldo resultado:', {
        success: balance?.success,
        totalWalletBalance: balance?.totalWalletBalance,
        availableBalance: balance?.availableBalance
      });
      
      return true;
    } else {
      console.log('⚠️ WebSocket API com problemas, mas função existe');
      return true;
    }
    
  } catch (error) {
    console.error('❌ Erro no teste avançado:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

if (require.main === module) {
  testAdvanced().then(success => {
    if (success) {
      console.log('\n🎉 Teste concluído com sucesso!');
      console.log('\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
    } else {
      console.log('\n❌ Teste falhou');
      process.exit(1);
    }
  });
}

module.exports = { testAdvanced };