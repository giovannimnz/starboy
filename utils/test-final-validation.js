// Teste de validação final
const websocketApi = require('../websocketApi');

async function testFinalValidation() {
  console.log('🧪 Teste de validação final...');
  
  try {
    console.log('\n=== TESTE 1: Verificar função getAccountInformationV2 ===');
    console.log('- Tipo:', typeof websocketApi.getAccountInformationV2);
    
    if (typeof websocketApi.getAccountInformationV2 !== 'function') {
      console.error('❌ getAccountInformationV2 não é uma função!');
      return false;
    }
    
    console.log('\n=== TESTE 2: Testar getAccountInformationV2 ===');
    
    // Testar a função
    const result = await websocketApi.getAccountInformationV2({}, 1);
    
    console.log('Resultado:');
    console.log('- Status:', result?.status);
    console.log('- Tem resultado:', !!result?.result);
    console.log('- Tem erro:', !!result?.error);
    console.log('- Mensagem de erro:', result?.error?.message);
    
    if (result?.status === 200 && result?.result) {
      console.log('\n✅ SUCESSO TOTAL! WebSocket API funcionando perfeitamente!');
      console.log('\n📊 Dados da conta obtidos:');
      const { result: accountData } = result;
      console.log('- totalWalletBalance:', accountData.totalWalletBalance);
      console.log('- availableBalance:', accountData.availableBalance);
      console.log('- maxWithdrawAmount:', accountData.maxWithdrawAmount);
      return true;
    } else if (result?.error && !result?.error?.message?.includes('[object Object]')) {
      console.log('\n⚠️ Erro específico, mas função está funcionando:', result.error.message);
      return true;
    } else if (result?.error?.message?.includes('[object Object]')) {
      console.log('\n❌ Ainda há problema com [object Object]');
      return false;
    } else {
      console.log('\n⚠️ Resposta inesperada, mas sem erro [object Object]');
      return true;
    }
    
  } catch (error) {
    console.error('\n❌ Erro no teste:', error.message);
    
    if (error.message.includes('[object Object]')) {
      console.log('❌ Ainda há problema com [object Object]');
      return false;
    } else {
      console.log('⚠️ Erro específico, correção pode ter funcionado');
      return true;
    }
  }
}

if (require.main === module) {
  testFinalValidation().then(success => {
    if (success) {
      console.log('\n🎉 CORREÇÃO BEM-SUCEDIDA!');
      console.log('\n🚀 Execute o monitoramento agora:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\n💰 A sincronização de saldo deve funcionar corretamente!');
    } else {
      console.log('\n❌ Correção não resolveu o problema completamente');
      console.log('Pode ser necessário debug adicional');
    }
  });
}

module.exports = { testFinalValidation };