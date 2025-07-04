/**
 * Teste direto das correções aplicadas
 */

const { getDatabaseInstance } = require('./backend/core/database/conexao');

async function testSystemAfterFixes() {
  try {
    console.log('🧪 === TESTE APÓS CORREÇÕES ===');
    
    const db = await getDatabaseInstance();
    
    // 1. Testar conexão com banco
    console.log('\n1. Testando conexão com banco...');
    const testResult = await db.query('SELECT 1 as test');
    console.log('✅ Conexão com banco: OK');
    
    // 2. Testar carregamento de credenciais
    console.log('\n2. Testando carregamento de credenciais...');
    const { loadCredentialsFromDatabase } = require('./backend/exchanges/binance/api/rest');
    
    try {
      const credentials = await loadCredentialsFromDatabase(5);
      console.log('✅ Credenciais carregadas:');
      console.log(`   - apiUrl: ${credentials.apiUrl || 'undefined'}`);
      console.log(`   - spotApiUrl: ${credentials.spotApiUrl || 'undefined'}`);
      console.log(`   - ambiente: ${credentials.ambiente || 'undefined'}`);
      console.log(`   - apiKey: ${credentials.apiKey ? 'DEFINIDO' : 'undefined'}`);
      console.log(`   - secretKey: ${credentials.secretKey ? 'DEFINIDO' : 'undefined'}`);
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
    }
    
    // 3. Testar função makeAuthenticatedRequest
    console.log('\n3. Testando makeAuthenticatedRequest...');
    const { checkServerTime } = require('./backend/exchanges/binance/api/rest');
    
    try {
      const timeResult = await checkServerTime(5);
      console.log('✅ Teste de tempo executado:', timeResult ? 'SUCESSO' : 'FALHA');
    } catch (timeError) {
      console.error('❌ Erro no teste de tempo:', timeError.message);
    }
    
    // 4. Testar estado da conta
    console.log('\n4. Testando estado da conta...');
    const { getAccountConnectionState } = require('./backend/exchanges/binance/api/rest');
    
    try {
      const accountState = getAccountConnectionState(5, true);
      console.log('✅ Estado da conta:', accountState ? 'CRIADO' : 'FALHA');
      
      if (accountState) {
        console.log(`   - accountId: ${accountState.accountId}`);
        console.log(`   - ambiente: ${accountState.ambiente || 'undefined'}`);
        console.log(`   - recvWindow: ${accountState.recvWindow || 'undefined'}`);
      }
    } catch (stateError) {
      console.error('❌ Erro no estado da conta:', stateError.message);
    }
    
    console.log('\n🏁 === TESTE CONCLUÍDO ===');
    
  } catch (error) {
    console.error('❌ Erro geral no teste:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Executar teste
testSystemAfterFixes();
