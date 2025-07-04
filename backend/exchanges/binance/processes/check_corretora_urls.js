/**
 * Script simples para verificar e corrigir URLs das corretoras
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function simpleFixCorretorUrls() {
  try {
    console.log('🔧 === VERIFICAÇÃO SIMPLES DAS CORRETORAS ===');
    
    const db = await getDatabaseInstance();
    
    // Verificar corretoras atuais
    console.log('\n📊 Verificando corretoras atuais...');
    const corretorasResult = await db.query('SELECT * FROM corretoras ORDER BY id');
    const corretoras = corretorasResult.rows;
    
    console.log(`📊 Corretoras encontradas: ${corretoras.length}`);
    
    corretoras.forEach(corretora => {
      console.log(`\n📊 Corretora ID: ${corretora.id}`);
      console.log(`   - Nome: ${corretora.corretora}`);
      console.log(`   - Ambiente: ${corretora.ambiente}`);
      console.log(`   - spot_rest_api_url: ${corretora.spot_rest_api_url || 'NULL'}`);
      console.log(`   - futures_rest_api_url: ${corretora.futures_rest_api_url || 'NULL'}`);
      console.log(`   - futures_ws_market_url: ${corretora.futures_ws_market_url || 'NULL'}`);
      console.log(`   - futures_ws_api_url: ${corretora.futures_ws_api_url || 'NULL'}`);
      console.log(`   - Ativa: ${corretora.ativa}`);
      
      // Verificar se há URLs vazias
      if (!corretora.spot_rest_api_url || !corretora.futures_rest_api_url) {
        console.log(`⚠️ Corretora ${corretora.id} tem URLs vazias!`);
      } else {
        console.log(`✅ Corretora ${corretora.id} tem todas as URLs preenchidas`);
      }
    });
    
    console.log('\n🎯 === ANÁLISE CONCLUÍDA ===');
    
    // Testar carregamento de credenciais
    console.log('\n🧪 Testando carregamento de credenciais...');
    const { loadCredentialsFromDatabase } = require('../api/rest');
    
    try {
      const credentials = await loadCredentialsFromDatabase(5);
      console.log('✅ Credenciais carregadas com sucesso:');
      console.log(`   - apiUrl: ${credentials.apiUrl || 'undefined'}`);
      console.log(`   - spotApiUrl: ${credentials.spotApiUrl || 'undefined'}`);
      console.log(`   - ambiente: ${credentials.ambiente || 'undefined'}`);
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
    }
    
  } catch (error) {
    console.error('❌ Erro geral:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Executar se for chamado diretamente
if (require.main === module) {
  simpleFixCorretorUrls();
}

module.exports = { simpleFixCorretorUrls };
