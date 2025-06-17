// Teste específico da sintaxe do priceMonitoring
console.log('🧪 Testando sintaxe do priceMonitoring.js...');

try {
  // Tentar carregar apenas o priceMonitoring
  const priceMonitoring = require('../posicoes/priceMonitoring');
  console.log('✅ priceMonitoring.js carregado sem erro de sintaxe!');
  
  // Verificar se é um objeto válido
  if (typeof priceMonitoring === 'object') {
    console.log('✅ priceMonitoring é um objeto válido');
    
    // Listar funções disponíveis
    const functions = Object.keys(priceMonitoring).filter(key => typeof priceMonitoring[key] === 'function');
    console.log(`✅ ${functions.length} funções encontradas: ${functions.join(', ')}`);
  }
  
  console.log('\n🎉 Sintaxe do priceMonitoring corrigida!');
  
  // Agora testar todos os módulos
  console.log('\n🔄 Testando todos os módulos...');
  
  const api = require('../api');
  console.log('✅ api.js OK');
  
  const websockets = require('../websockets');
  console.log('✅ websockets.js OK');
  
  console.log('\n🚀 Todos os módulos carregados com sucesso!');
  console.log('\n Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
} catch (error) {
  console.error('❌ Ainda há erro de sintaxe:', error.message);
  
  // Mostrar informações específicas do erro
  if (error.stack) {
    const errorLines = error.stack.split('\n');
    const syntaxError = errorLines.find(line => line.includes('SyntaxError') || line.includes('.js:'));
    if (syntaxError) {
      console.error('Localização do erro:', syntaxError);
    }
  }
}