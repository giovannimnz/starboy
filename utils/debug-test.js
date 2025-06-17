// Teste de debug específico
const api = require('../api');

async function debugTest() {
  console.log('🔍 Teste de debug específico...');
  
  try {
    console.log('\n=== DEBUG 1: Verificar se funções existem ===');
    console.log('- getAccountConnectionState:', typeof api.getAccountConnectionState);
    console.log('- loadCredentialsFromDatabase:', typeof api.loadCredentialsFromDatabase);
    console.log('- getAllAccountConnections:', typeof api.getAllAccountConnections);
    
    console.log('\n=== DEBUG 2: Chamar getAccountConnectionState diretamente ===');
    const state1 = api.getAccountConnectionState(1, true);
    console.log('Estado criado:', !!state1);
    console.log('accountId no estado:', state1?.accountId);
    
    console.log('\n=== DEBUG 3: Verificar Map de conexões ===');
    const allConnections = api.getAllAccountConnections();
    console.log('Tamanho do Map:', allConnections.size);
    console.log('Tem conta 1:', allConnections.has(1));
    
    console.log('\n=== DEBUG 4: Carregar credenciais ===');
    const result = await api.loadCredentialsFromDatabase(1);
    console.log('Resultado:', {
      type: typeof result,
      accountId: result?.accountId,
      hasApiKey: !!result?.apiKey,
      hasApiUrl: !!result?.apiUrl
    });
    
    console.log('\n=== DEBUG 5: Verificar estado final ===');
    const finalState = api.getAccountConnectionState(1);
    console.log('Estado final existe:', !!finalState);
    if (finalState) {
      console.log('Estado final:', {
        accountId: finalState.accountId,
        hasApiKey: !!finalState.apiKey,
        hasApiUrl: !!finalState.apiUrl,
        apiUrl: finalState.apiUrl
      });
    }
    
    console.log('\n🎉 Debug concluído!');
    
  } catch (error) {
    console.error('❌ Erro no debug:', error.message);
    console.error('Stack:', error.stack);
  }
}

if (require.main === module) {
  debugTest();
}

module.exports = { debugTest };