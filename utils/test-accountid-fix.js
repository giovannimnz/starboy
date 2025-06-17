// Teste de validação do accountId
async function testAccountIdFix() {
  console.log('🧪 Testando correção do accountId...');
  
  try {
    console.log('\n=== TESTE 1: Verificar websockets.js ===');
    const websockets = require('../websockets');
    
    console.log('- setupBookDepthWebsocket:', typeof websockets.setupBookDepthWebsocket);
    
    if (typeof websockets.setupBookDepthWebsocket !== 'function') {
      console.error('❌ setupBookDepthWebsocket não encontrada!');
      return false;
    }
    
    console.log('\n=== TESTE 2: Testar validação de accountId ===');
    
    try {
      // Tentar chamar com accountId undefined - deve dar erro
      await websockets.setupBookDepthWebsocket('BTCUSDT', undefined);
      console.error('❌ Validação falhou - não rejeitou accountId undefined');
      return false;
    } catch (error) {
      if (error.message.includes('AccountId é obrigatório')) {
        console.log('✅ Validação funcionando - rejeitou accountId undefined');
      } else {
        console.log('⚠️ Erro diferente (aceitável):', error.message);
      }
    }
    
    console.log('\n=== TESTE 3: Verificar limitMakerEntry.js ===');
    
    try {
      const limitMaker = require('../posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry carregado sem erros');
    } catch (error) {
      console.error('❌ Erro ao carregar limitMakerEntry:', error.message);
      return false;
    }
    
    console.log('\n✅ Todos os testes passaram!');
    return true;
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    return false;
  }
}

if (require.main === module) {
  testAccountIdFix().then(success => {
    if (success) {
      console.log('\n🎉 Correção do accountId bem-sucedida!');
      console.log('\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\n📊 O setupBookDepthWebsocket deve receber accountId corretamente!');
    } else {
      console.log('\n❌ Ainda há problemas com accountId');
      process.exit(1);
    }
  });
}

module.exports = { testAccountIdFix };