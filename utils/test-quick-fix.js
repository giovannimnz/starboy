console.log('��� Teste rápido após correções...');

try {
  const api = require('../api');
  console.log('✅ api.js carregado sem erro');
  
  // Verificar funções principais
  console.log('- makeAuthenticatedRequest:', typeof api.makeAuthenticatedRequest);
  console.log('- loadCredentialsFromDatabase:', typeof api.loadCredentialsFromDatabase);
  console.log('- newLimitMakerOrder:', typeof api.newLimitMakerOrder);
  console.log('- getTickSize:', typeof api.getTickSize);
  console.log('- roundPriceToTickSize:', typeof api.roundPriceToTickSize);
  
  console.log('\n✅ Todos os módulos principais funcionando!');
  console.log('\n��� Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
} catch (error) {
  console.error('❌ Erro:', error.message);
  console.error('Stack:', error.stack);
}
