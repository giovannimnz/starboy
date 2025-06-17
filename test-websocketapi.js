// Teste específico para websocketApi
const websocketApi = require('./websocketApi');

async function testWebSocketApi() {
  console.log('🧪 Testando websocketApi...');
  
  try {
    console.log('\n=== TESTE 1: Verificar se funções existem ===');
    console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
    console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
    
    console.log('\n=== TESTE 2: Testar getAccountInformationV2 ===');
    
    try {
      const result = await websocketApi.getAccountInformationV2({}, 1);
      console.log('Resultado:', {
        status: result?.status,
        hasResult: !!result?.result,
        hasError: !!result?.error,
        errorMessage: result?.error?.message
      });
      
      if (result && result.status === 200 && result.result) {
        console.log('✅ getAccountInformationV2 funcionando!');
        
        console.log('\n=== TESTE 3: Testar getAccountBalance ===');
        const balance = await websocketApi.getAccountBalance({}, 1);
        console.log('Saldo:', {
          success: balance?.success,
          totalWalletBalance: balance?.totalWalletBalance,
          availableBalance: balance?.availableBalance
        });
        
        if (balance && balance.success) {
          console.log('✅ getAccountBalance funcionando!');
        }
      }
      
    } catch (testError) {
      console.error('❌ Erro no teste:', testError.message);
    }
    
    console.log('\n🎉 Teste concluído!');
    
  } catch (error) {
    console.error('❌ Erro geral no teste:', error.message);
    console.error('Stack:', error.stack);
  }
}

if (require.main === module) {
  testWebSocketApi();
}

module.exports = { testWebSocketApi };