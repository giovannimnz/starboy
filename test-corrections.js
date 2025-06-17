// Teste de validação das correções
const websocketApi = require('./websocketApi');

async function testCorrections() {
  console.log('🧪 Testando correções...');
  
  try {
    console.log('\n=== TESTE 1: WebSocket API com timestamp ===');
    
    const result = await websocketApi.getAccountInformationV2({}, 1);
    
    console.log('Resultado WebSocket API:');
    console.log('- Status:', result?.status);
    console.log('- Tem resultado:', !!result?.result);
    console.log('- Tem erro:', !!result?.error);
    console.log('- Erro (se houver):', result?.error?.message);
    
    if (result?.error?.message?.includes('timestamp')) {
      console.log('❌ Ainda há problema de timestamp');
      return false;
    } else {
      console.log('✅ Problema de timestamp corrigido');
    }
    
    console.log('\n=== TESTE 2: Imports ===');
    
    try {
      const signalProcessor = require('./posicoes/signalProcessor');
      console.log('✅ signalProcessor carregado sem erros');
    } catch (importError) {
      console.error('❌ Erro ao importar signalProcessor:', importError.message);
      return false;
    }
    
    try {
      const limitMakerEntry = require('./posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry carregado sem erros');
    } catch (importError) {
      console.error('❌ Erro ao importar limitMakerEntry:', importError.message);
      return false;
    }
    
    console.log('\n✅ Todas as correções validadas com sucesso!');
    return true;
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    return false;
  }
}

if (require.main === module) {
  testCorrections().then(success => {
    if (success) {
      console.log('\n🎉 Correções bem-sucedidas!');
      console.log('\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\n📊 O sistema deve processar sinais corretamente agora!');
    } else {
      console.log('\n❌ Ainda há problemas a resolver');
      process.exit(1);
    }
  });
}

module.exports = { testCorrections };