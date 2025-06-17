// Teste da correção do priceMonitoring
console.log('🧪 Testando priceMonitoring.js corrigido...');

try {
  const priceMonitoring = require('../posicoes/priceMonitoring');
  console.log('✅ priceMonitoring.js carregado sem erro!');
  
  console.log('Funções disponíveis:');
  Object.keys(priceMonitoring).forEach(key => {
    console.log(`  - ${key}: ${typeof priceMonitoring[key]}`);
  });
  
  const api = require('../api');
  console.log('✅ api.js carregado');
  
  const websockets = require('../websockets');
  console.log('✅ websockets.js carregado');
  
  console.log('\n🎉 Todos os módulos funcionando!');
  console.log('\n🚀 Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
} catch (error) {
  console.error('❌ Erro:', error.message);
}