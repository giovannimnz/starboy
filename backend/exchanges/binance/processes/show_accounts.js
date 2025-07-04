/**
 * Script para mostrar contas disponíveis e instruções de uso
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function showAvailableAccounts() {
  try {
    console.log('🎯 === STARBOY POSTGRES - CONTAS DISPONÍVEIS ===\n');
    
    const db = await getDatabaseInstance();
    
    // Buscar contas com informações da corretora
    const result = await db.query(`
      SELECT c.id, c.nome, c.ativa, cor.corretora, cor.ambiente 
      FROM contas c 
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id 
      ORDER BY c.id
    `);
    
    const accounts = result.rows;
    
    console.log(`📊 Total de contas encontradas: ${accounts.length}\n`);
    
    if (accounts.length === 0) {
      console.log('❌ NENHUMA CONTA ENCONTRADA!');
      console.log('💡 Execute: node setup_basic_data.js para criar dados básicos\n');
      return;
    }
    
    console.log('📋 CONTAS DISPONÍVEIS:');
    console.log('═'.repeat(80));
    
    const activeAccounts = [];
    
    accounts.forEach(account => {
      const status = account.ativa ? '✅ ATIVA' : '❌ INATIVA';
      const broker = account.corretora || 'N/A';
      const env = account.ambiente || 'N/A';
      
      console.log(`🏦 ID: ${account.id} | Nome: ${account.nome || 'N/A'} | ${status}`);
      console.log(`   📡 Corretora: ${broker} (${env})`);
      console.log('─'.repeat(50));
      
      if (account.ativa) {
        activeAccounts.push(account.id);
      }
    });
    
    console.log('\n🚀 COMANDOS PARA EXECUTAR:');
    console.log('═'.repeat(80));
    
    if (activeAccounts.length > 0) {
      console.log('✅ Contas ativas encontradas! Use um dos comandos abaixo:\n');
      
      activeAccounts.forEach(accountId => {
        const account = accounts.find(a => a.id === accountId);
        console.log(`💻 node orchMonitor.js --account ${accountId}  # ${account.nome}`);
      });
      
      console.log('\n📝 EXEMPLO RECOMENDADO:');
      console.log(`🎯 cd "c:\\Users\\muniz\\Documents\\GitHub\\starboy_postgres\\backend\\exchanges\\binance\\monitoring"`);
      console.log(`🎯 node orchMonitor.js --account ${activeAccounts[0]}`);
      
    } else {
      console.log('❌ Nenhuma conta ativa encontrada!');
      console.log('💡 Verifique os dados das contas no banco de dados.');
    }
    
    console.log('\n' + '═'.repeat(80));
    console.log('✅ Sistema PostgreSQL funcionando corretamente!');
    
  } catch (error) {
    console.error('❌ Erro ao buscar contas:', error.message);
    console.error('📋 Stack:', error.stack);
  }
}

showAvailableAccounts();
