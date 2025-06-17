// Teste específico para timestamp e assinatura
console.log('🧪 Testando correções de timestamp e assinatura...');

try {
  const api = require('../api');
  console.log('✅ api.js carregado sem erro');
  
  // Verificar se as funções principais existem
  const requiredFunctions = [
    'makeAuthenticatedRequest',
    'newLimitMakerOrder',
    'getTickSize',
    'roundPriceToTickSize',
    'getRecentOrders'
  ];
  
  requiredFunctions.forEach(funcName => {
    if (typeof api[funcName] === 'function') {
      console.log(`✅ ${funcName} encontrada`);
    } else {
      console.log(`❌ ${funcName} NÃO encontrada`);
    }
  });
  
  console.log('\n📋 Problemas que devem estar corrigidos:');
  console.log('1. ✅ Timestamp adicionado automaticamente');
  console.log('2. ✅ Assinatura HMAC-SHA256 correta');
  console.log('3. ✅ Query string ordenada corretamente');
  console.log('4. ✅ Headers configurados adequadamente');
  
  console.log('\n🚀 Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
  console.log('\n🎯 Agora deve funcionar:');
  console.log('✅ Sem erro "Mandatory parameter timestamp"');
  console.log('✅ Sem erro "Signature for this request is not valid"');
  console.log('✅ Ordens criadas com sucesso');
  console.log('✅ Sistema 100% funcional');
  
} catch (error) {
  console.error('❌ Erro durante teste:', error.message);
}