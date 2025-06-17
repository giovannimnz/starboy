// Novo teste após correção
console.log('🧪 Testando websocketApi após correção...');

try {
  const websocketApi = require('../websocketApi');
  
  console.log('✅ websocketApi carregado sem erros!');
  console.log('Funções disponíveis:');
  console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
  console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
  console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
  
  console.log('\n🎉 Sucesso! Arquivo carregado sem erros.');
  console.log('\n🚀 Agora execute:');
  console.log('   node test-final-validation.js');
  
} catch (error) {
  console.error('❌ Ainda há problemas:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}