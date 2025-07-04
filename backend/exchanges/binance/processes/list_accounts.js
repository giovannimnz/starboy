/**
 * Script simples para listar contas no banco
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function listAccounts() {
  try {
    console.log('🔍 Conectando ao banco...');
    const db = await getDatabaseInstance();
    
    console.log('📋 Listando contas...');
    const result = await db.query('SELECT id, nome, ativa FROM contas ORDER BY id');
    
    console.log(`📊 Total de contas: ${result.rows.length}`);
    
    if (result.rows.length === 0) {
      console.log('❌ Nenhuma conta encontrada no banco!');
      console.log('💡 Você precisa criar contas primeiro.');
    } else {
      console.log('📋 Contas disponíveis:');
      result.rows.forEach(account => {
        console.log(`   - ID: ${account.id}, Nome: ${account.nome || 'N/A'}, Ativa: ${account.ativa}`);
      });
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

listAccounts();
