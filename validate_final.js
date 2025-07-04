/**
 * Script de validação final do projeto
 */

const path = require('path');
const fs = require('fs');

console.log('🏁 === VALIDAÇÃO FINAL DO PROJETO STARBOY ===');
console.log('📅 Data:', new Date().toISOString());

// Verificar se todas as correções foram aplicadas
const checks = [
  {
    name: 'Arquivo de conexão PostgreSQL',
    file: 'backend/core/database/conexao.js',
    check: (content) => content.includes('pg') && content.includes('Pool')
  },
  {
    name: 'Rest API com PostgreSQL',
    file: 'backend/exchanges/binance/api/rest.js',
    check: (content) => content.includes('result.rows') && content.includes('$1')
  },
  {
    name: 'Monitor com correções',
    file: 'backend/exchanges/binance/monitoring/orchMonitor.js',
    check: (content) => content.includes('result.rows') && !content.includes('[rows]')
  },
  {
    name: 'Stub do TelegramBot',
    file: 'backend/exchanges/binance/monitoring/telegramBot.js',
    check: (content) => content.includes('module.exports')
  },
  {
    name: 'Setup de dados básicos',
    file: 'backend/exchanges/binance/processes/setup_basic_data.js',
    check: (content) => content.includes('checkAndCreateBasicData')
  }
];

console.log('\n🔍 Verificando correções aplicadas...');

let allChecksPass = true;

checks.forEach(check => {
  try {
    if (!fs.existsSync(check.file)) {
      console.log(`❌ ${check.name} - Arquivo não encontrado: ${check.file}`);
      allChecksPass = false;
      return;
    }
    
    const content = fs.readFileSync(check.file, 'utf8');
    const passes = check.check(content);
    
    console.log(`${passes ? '✅' : '❌'} ${check.name}`);
    
    if (!passes) {
      allChecksPass = false;
    }
    
  } catch (error) {
    console.log(`❌ ${check.name} - Erro ao verificar: ${error.message}`);
    allChecksPass = false;
  }
});

// Testar conexão com banco
async function testDatabaseConnection() {
  try {
    console.log('\n🗃️ Testando conexão com banco...');
    
    const { getDatabaseInstance } = require('./backend/core/database/conexao');
    const db = await getDatabaseInstance();
    
    if (db) {
      console.log('✅ Conexão com banco estabelecida');
      
      // Testar query PostgreSQL
      const result = await db.query('SELECT version() as version');
      const rows = result.rows;
      
      if (rows && rows.length > 0) {
        console.log('✅ Query PostgreSQL executada com sucesso');
        console.log(`📊 Versão do banco: ${rows[0].version.split(' ')[0]}`);
        return true;
      } else {
        console.log('⚠️ Query retornou resultado inesperado');
        return false;
      }
      
    } else {
      console.log('❌ Não foi possível estabelecer conexão com banco');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erro ao testar banco:', error.message);
    return false;
  }
}

// Testar se existem contas no banco
async function testAccountsInDatabase() {
  try {
    console.log('\n🏦 Verificando contas no banco...');
    
    const { getDatabaseInstance } = require('./backend/core/database/conexao');
    const db = await getDatabaseInstance();
    
    const result = await db.query(`
      SELECT c.id, c.nome, c.ativa, cor.corretora, cor.ambiente 
      FROM contas c 
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id 
      WHERE c.ativa = true
      ORDER BY c.id
    `);
    
    const rows = result.rows;
    
    if (rows && rows.length > 0) {
      console.log(`✅ ${rows.length} conta(s) ativa(s) encontrada(s)`);
      rows.forEach(account => {
        console.log(`   - ID: ${account.id}, Nome: ${account.nome}, Corretora: ${account.corretora} (${account.ambiente})`);
      });
      return true;
    } else {
      console.log('⚠️ Nenhuma conta ativa encontrada');
      return false;
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar contas:', error.message);
    return false;
  }
}

// Executar validação
async function runValidation() {
  try {
    console.log('\n🧪 Executando testes de validação...');
    
    const dbConnected = await testDatabaseConnection();
    const accountsFound = await testAccountsInDatabase();
    
    console.log('\n📋 === RESUMO DA VALIDAÇÃO ===');
    console.log(`📁 Verificações de arquivo: ${allChecksPass ? 'PASSOU' : 'FALHOU'}`);
    console.log(`🗃️ Conexão com banco: ${dbConnected ? 'PASSOU' : 'FALHOU'}`);
    console.log(`🏦 Contas no banco: ${accountsFound ? 'PASSOU' : 'FALHOU'}`);
    
    if (allChecksPass && dbConnected && accountsFound) {
      console.log('\n🎉 === VALIDAÇÃO CONCLUÍDA COM SUCESSO ===');
      console.log('✅ O projeto está pronto para uso!');
      console.log('\n📖 Próximos passos:');
      console.log('1. Configure as credenciais da API no banco de dados');
      console.log('2. Execute: node backend/exchanges/binance/monitoring/orchMonitor.js --account 5');
      console.log('3. Monitore os logs para verificar o funcionamento');
    } else {
      console.log('\n⚠️ === VALIDAÇÃO PARCIAL ===');
      console.log('❌ Alguns testes falharam, verifique os logs acima');
    }
    
  } catch (error) {
    console.error('❌ Erro durante validação:', error.message);
    process.exit(1);
  }
}

runValidation();
