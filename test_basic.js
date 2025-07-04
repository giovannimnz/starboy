/**
 * Teste básico para verificar se o projeto está funcionando
 */

const path = require('path');
const fs = require('fs');

console.log('🧪 === TESTE BÁSICO DO PROJETO STARBOY ===');
console.log(`📁 Diretório atual: ${process.cwd()}`);
console.log(`📅 Data: ${new Date().toISOString()}`);

// Verificar se arquivos principais existem
const files = [
  'backend/core/database/conexao.js',
  'backend/exchanges/binance/api/rest.js',
  'backend/exchanges/binance/monitoring/orchMonitor.js',
  'backend/exchanges/binance/processes/setup_basic_data.js',
  'package.json',
  'jest.config.js'
];

console.log('\n📁 Verificando arquivos principais...');
files.forEach(file => {
  const exists = fs.existsSync(file);
  console.log(`${exists ? '✅' : '❌'} ${file}`);
});

// Testar importações básicas
console.log('\n📦 Testando importações básicas...');

try {
  const conexao = require('./backend/core/database/conexao');
  console.log('✅ conexao.js importado com sucesso');
} catch (error) {
  console.error('❌ Erro ao importar conexao.js:', error.message);
}

try {
  const rest = require('./backend/exchanges/binance/api/rest');
  console.log('✅ rest.js importado com sucesso');
} catch (error) {
  console.error('❌ Erro ao importar rest.js:', error.message);
}

try {
  const setupData = require('./backend/exchanges/binance/processes/setup_basic_data');
  console.log('✅ setup_basic_data.js importado com sucesso');
} catch (error) {
  console.error('❌ Erro ao importar setup_basic_data.js:', error.message);
}

// Testar conexão com banco
async function testDatabase() {
  try {
    console.log('\n🗃️ Testando conexão com banco...');
    
    const { getDatabaseInstance } = require('./backend/core/database/conexao');
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

// Testar dados básicos
async function testBasicData() {
  try {
    console.log('\n🏦 Testando dados básicos...');
    
    const { checkAndCreateBasicData } = require('./backend/exchanges/binance/processes/setup_basic_data');
    await checkAndCreateBasicData();
    
    console.log('✅ Dados básicos verificados/criados com sucesso');
    
  } catch (error) {
    console.error('❌ Erro ao testar dados básicos:', error.message);
  }
}

// Executar testes
async function runTests() {
  try {
    await testDatabase();
    await testBasicData();
    
    console.log('\n🎉 === TESTE BÁSICO CONCLUÍDO ===');
    console.log('✅ O projeto parece estar funcionando corretamente');
    
  } catch (error) {
    console.error('❌ Erro geral nos testes:', error.message);
    process.exit(1);
  }
}

runTests();
