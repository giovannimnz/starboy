console.log('Ì∑™ Teste r√°pido ap√≥s corre√ß√µes...');

try {
  const api = require('./api');
  console.log('‚úÖ api.js carregado sem erro');
  
  // Verificar fun√ß√µes principais
  console.log('- makeAuthenticatedRequest:', typeof api.makeAuthenticatedRequest);
  console.log('- loadCredentialsFromDatabase:', typeof api.loadCredentialsFromDatabase);
  console.log('- newLimitMakerOrder:', typeof api.newLimitMakerOrder);
  console.log('- getTickSize:', typeof api.getTickSize);
  console.log('- roundPriceToTickSize:', typeof api.roundPriceToTickSize);
  
  console.log('\n‚úÖ Todos os m√≥dulos principais funcionando!');
  console.log('\nÌ∫Ä Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
} catch (error) {
  console.error('‚ùå Erro:', error.message);
  console.error('Stack:', error.stack);
}
