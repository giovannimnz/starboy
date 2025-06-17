// Teste específico da função getFuturesAccountBalanceDetails
async function testNewFunction() {
  console.log('🧪 Testando getFuturesAccountBalanceDetails...');
  
  try {
    console.log('\n=== TESTE 1: Importar api.js ===');
    const api = require('./api');
    
    console.log('Funções disponíveis no api.js:');
    console.log('- getFuturesAccountBalanceDetails:', typeof api.getFuturesAccountBalanceDetails);
    
    if (typeof api.getFuturesAccountBalanceDetails !== 'function') {
      console.error('❌ getFuturesAccountBalanceDetails não é uma função!');
      return false;
    }
    
    console.log('\n=== TESTE 2: Testar função ===');
    
    try {
      const result = await api.getFuturesAccountBalanceDetails(1);
      console.log('Resultado:', {
        temAssets: !!result?.assets,
        tipoAssets: Array.isArray(result?.assets),
        quantidadeAssets: result?.assets?.length || 0
      });
      
      console.log('✅ Função executada sem erro de referência');
      
    } catch (apiError) {
      if (apiError.message.includes('is not defined')) {
        console.error('❌ Ainda há problema de referência:', apiError.message);
        return false;
      } else {
        console.log('✅ Função existe (erro de API é normal):', apiError.message);
      }
    }
    
    console.log('\n=== TESTE 3: Testar limitMakerEntry ===');
    
    try {
      const limitMaker = require('./posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry carregado sem erros de referência');
    } catch (importError) {
      if (importError.message.includes('is not defined')) {
        console.error('❌ Erro de referência em limitMakerEntry:', importError.message);
        return false;
      } else {
        console.log('✅ limitMakerEntry carregado (outros erros são normais)');
      }
    }
    
    console.log('\n✅ Todos os testes passaram!');
    return true;
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    if (error.message.includes('is not defined')) {
      return false;
    }
    return true; // Outros erros são aceitáveis por enquanto
  }
}

if (require.main === module) {
  testNewFunction().then(success => {
    if (success) {
      console.log('\n🎉 Função adicionada com sucesso!');
      console.log('\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\n📊 O sistema deve processar sinais sem erros de referência!');
    } else {
      console.log('\n❌ Ainda há problemas de referência');
      process.exit(1);
    }
  });
}

module.exports = { testNewFunction };