/**
 * Teste simples para verificar se as correções funcionaram
 */

const path = require('path');

// Testar importação dos módulos corrigidos
try {
  console.log('🧪 === TESTE DE IMPORTAÇÃO DOS MÓDULOS ===');
  
  // Testar rest.js
  console.log('📦 Testando rest.js...');
  const rest = require('../api/rest');
  console.log('✅ rest.js importado com sucesso');
  
  // Testar orchMonitor.js
  console.log('📦 Testando orchMonitor.js...');
  const orchMonitor = require('../monitoring/orchMonitor');
  console.log('✅ orchMonitor.js importado com sucesso');
  
  // Testar telegramBot.js
  console.log('📦 Testando telegramBot.js...');
  const telegramBot = require('../monitoring/telegramBot');
  console.log('✅ telegramBot.js importado com sucesso');
  
  console.log('\n🎉 Todos os módulos foram importados com sucesso!');
  console.log('✅ As correções de sintaxe funcionaram corretamente');
  
} catch (error) {
  console.error('❌ Erro ao importar módulos:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}

// Testar conexão com banco
async function testDatabase() {
  try {
    console.log('\n🗃️ === TESTE DE CONEXÃO COM BANCO ===');
    
    const { getDatabaseInstance } = require('../../../core/database/conexao');
    const db = await getDatabaseInstance();
    
    if (db) {
      console.log('✅ Conexão com banco estabelecida');
      
      // Testar uma query simples
      const result = await db.query('SELECT 1 as test');
      const rows = result.rows;
      
      if (rows && rows.length > 0 && rows[0].test === 1) {
        console.log('✅ Query de teste executada com sucesso');
      } else {
        console.log('⚠️ Query de teste retornou resultado inesperado');
      }
      
    } else {
      console.log('❌ Não foi possível estabelecer conexão com banco');
    }
    
  } catch (error) {
    console.error('❌ Erro ao testar banco:', error.message);
  }
}

testDatabase();
