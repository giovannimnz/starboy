// Teste após correção de duplicatas
console.log('🧪 Testando websocketApi após correção...');

try {
  const websocketApi = require('../websocketApi');
  
  console.log('✅ websocketApi carregado sem erros!');
  console.log('Funções disponíveis:');
  console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
  console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
  console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
  console.log('- placeLimitMakerOrderViaWebSocket:', typeof websocketApi.placeLimitMakerOrderViaWebSocket);
  
  console.log('\n🎉 Correção bem-sucedida! Arquivo carregado sem erros de sintaxe.');
  
} catch (error) {
  console.error('❌ Ainda há problemas:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}