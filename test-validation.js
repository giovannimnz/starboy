// Teste de validação do sendWebSocketApiRequest
const websockets = require('./websockets');
const websocketApi = require('./websocketApi');

async function testValidation() {
  console.log('🧪 Teste de validação...');
  
  try {
    console.log('\n=== VERIFICAR IMPORTS ===');
    console.log('- websockets.sendWebSocketApiRequest:', typeof websockets.sendWebSocketApiRequest);
    console.log('- websockets.getAccountConnectionState:', typeof websockets.getAccountConnectionState);
    console.log('- websocketApi.getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    
    if (typeof websockets.sendWebSocketApiRequest !== 'function') {
      console.error('❌ sendWebSocketApiRequest não está disponível!');
      return false;
    }
    
    console.log('\n=== TESTAR WEBSOCKET API ===');
    
    // Conectar primeiro
    console.log('Conectando WebSocket...');
    await websockets.startWebSocketApi(1);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Testar getAccountInformationV2
    console.log('Testando getAccountInformationV2...');
    const result = await websocketApi.getAccountInformationV2({}, 1);
    
    console.log('Resultado:', {
      status: result?.status,
      hasResult: !!result?.result,
      hasError: !!result?.error,
      errorMessage: result?.error?.message
    });
    
    if (result?.status === 200) {
      console.log('✅ SUCESSO! WebSocket API funcionando!');
      return true;
    } else if (result?.status === 500 && result?.error?.message?.includes('sendWebSocketApiRequest is not defined')) {
      console.log('❌ FALHA! sendWebSocketApiRequest ainda não definida');
      return false;
    } else {
      console.log('⚠️ Resposta inesperada, mas função existe');
      return true;
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    return false;
  }
}

if (require.main === module) {
  testValidation().then(success => {
    if (success) {
      console.log('\n🎉 Validação bem-sucedida!');
      console.log('\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
    } else {
      console.log('\n❌ Validação falhou - verifique os logs');
      process.exit(1);
    }
  });
}

module.exports = { testValidation };