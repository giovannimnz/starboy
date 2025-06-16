const { getDatabaseInstance } = require('../db/conexao');

async function verificarTabelaContas() {
  try {
    console.log('🔍 Verificando tabela de contas...');
    
    const db = await getDatabaseInstance();
    
    // Verificar se existe tabela 'contas'
    const [contasTable] = await db.query("SHOW TABLES LIKE 'contas'");
    console.log(`📋 Tabela 'contas': ${contasTable.length > 0 ? '✅ Existe' : '❌ Não existe'}`);
    
    // Verificar se existe tabela 'conta'
    const [contaTable] = await db.query("SHOW TABLES LIKE 'conta'");
    console.log(`📋 Tabela 'conta': ${contaTable.length > 0 ? '✅ Existe' : '❌ Não existe'}`);
    
    // Verificar todas as tabelas com 'conta' no nome
    const [allContaTables] = await db.query("SHOW TABLES LIKE '%conta%'");
    
    if (allContaTables.length > 0) {
      console.log('\n📊 Tabelas encontradas com "conta" no nome:');
      allContaTables.forEach(table => {
        const tableName = Object.values(table)[0];
        console.log(`- ${tableName}`);
      });
      
      // Se existe 'contas', mostrar estrutura
      if (contasTable.length > 0) {
        console.log('\n📋 Estrutura da tabela "contas":');
        const [structure] = await db.query('DESCRIBE contas');
        structure.forEach(field => {
          console.log(`- ${field.Field}: ${field.Type} ${field.Null === 'NO' ? '(NOT NULL)' : ''}`);
        });
      }
      
      // Verificar se há dados na conta 1
      try {
        const [conta1] = await db.query('SELECT id, saldo, saldo_base_calculo FROM contas WHERE id = 1');
        if (conta1.length > 0) {
          console.log('\n💰 Dados da conta 1:');
          console.log(`- ID: ${conta1[0].id}`);
          console.log(`- Saldo: ${conta1[0].saldo || 'NULL'}`);
          console.log(`- Saldo Base Cálculo: ${conta1[0].saldo_base_calculo || 'NULL'}`);
        } else {
          console.log('\n⚠️ Conta 1 não encontrada na tabela contas');
        }
      } catch (selectError) {
        console.error('\n❌ Erro ao consultar conta 1:', selectError.message);
      }
      
    } else {
      console.log('\n❌ Nenhuma tabela com "conta" no nome foi encontrada!');
      
      // Listar todas as tabelas do banco
      const [allTables] = await db.query('SHOW TABLES');
      console.log('\n📋 Todas as tabelas do banco:');
      allTables.forEach(table => {
        const tableName = Object.values(table)[0];
        console.log(`- ${tableName}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar tabela de contas:', error.message);
  }
}

// Executar se chamado diretamente
if (require.main === module) {
  verificarTabelaContas()
    .then(() => {
      console.log('\n✅ Verificação concluída!');
      process.exit(0);
    })
    .catch(error => {
      console.error('\n❌ Verificação falhou:', error.message);
      process.exit(1);
    });
}

module.exports = { verificarTabelaContas };