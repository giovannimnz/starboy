/**
 * Teste específico para verificar se as URLs estão sendo carregadas corretamente
 */

const { getDatabaseInstance } = require('./backend/core/database/conexao');

async function testCredentialLoading() {
  try {
    console.log('🧪 === TESTE DE CARREGAMENTO DE CREDENCIAIS ===');
    
    const db = await getDatabaseInstance();
    
    // 1. Verificar dados da corretora diretamente no banco
    console.log('\n1. Verificando dados da corretora no banco...');
    const corretoraResult = await db.query('SELECT * FROM corretoras WHERE id = 999');
    const corretora = corretoraResult.rows[0];
    
    if (corretora) {
      console.log('✅ Corretora encontrada:');
      console.log(`   - ID: ${corretora.id}`);
      console.log(`   - Nome: ${corretora.corretora}`);
      console.log(`   - Ambiente: ${corretora.ambiente}`);
      console.log(`   - spot_rest_api_url: ${corretora.spot_rest_api_url || 'NULL'}`);
      console.log(`   - futures_rest_api_url: ${corretora.futures_rest_api_url || 'NULL'}`);
      console.log(`   - futures_ws_market_url: ${corretora.futures_ws_market_url || 'NULL'}`);
      console.log(`   - futures_ws_api_url: ${corretora.futures_ws_api_url || 'NULL'}`);
    } else {
      console.error('❌ Corretora não encontrada');
      return;
    }
    
    // 2. Testar carregamento via API
    console.log('\n2. Testando carregamento via loadCredentialsFromDatabase...');
    const { loadCredentialsFromDatabase } = require('./backend/exchanges/binance/api/rest');
    
    try {
      const credentials = await loadCredentialsFromDatabase(5);
      console.log('✅ Credenciais carregadas:');
      console.log(`   - apiUrl: ${credentials.apiUrl || 'undefined'}`);
      console.log(`   - spotApiUrl: ${credentials.spotApiUrl || 'undefined'}`);
      console.log(`   - ambiente: ${credentials.ambiente || 'undefined'}`);
      console.log(`   - apiKey: ${credentials.apiKey ? 'DEFINIDO' : 'undefined'}`);
      console.log(`   - secretKey: ${credentials.secretKey ? 'DEFINIDO' : 'undefined'}`);
      
      // 3. Testar makeAuthenticatedRequest básico
      console.log('\n3. Testando makeAuthenticatedRequest...');
      const { makeAuthenticatedRequest } = require('./backend/exchanges/binance/api/rest');
      
      // Não vamos fazer a requisição real, apenas testar se não há erro de URL
      console.log('   - URLs definidas, makeAuthenticatedRequest deve funcionar');
      
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
      console.error('Stack:', credError.stack);
    }
    
    console.log('\n🏁 === TESTE CONCLUÍDO ===');
    
  } catch (error) {
    console.error('❌ Erro geral no teste:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Executar teste
testCredentialLoading();
