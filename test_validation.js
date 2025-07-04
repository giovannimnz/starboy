/**
 * Script simples de teste da validação
 */

console.log('🔍 TESTE DE VALIDAÇÃO SIMPLIFICADO');
console.log('================================\n');

// Teste 1: Verificar se arquivos críticos existem
const fs = require('fs');
const path = require('path');

const criticalFiles = [
  'backend/core/database/conexao.js',
  'backend/exchanges/binance/monitoring/orchMonitor.js',
  'backend/exchanges/binance/api/rest.js'
];

console.log('📋 Verificando arquivos críticos...');
let filesOk = 0;

criticalFiles.forEach(file => {
  if (fs.existsSync(file)) {
    console.log(`✅ ${file}`);
    filesOk++;
  } else {
    console.log(`❌ ${file}`);
  }
});

console.log(`\n📊 Resultado: ${filesOk}/${criticalFiles.length} arquivos encontrados`);

// Teste 2: Conexão com banco
console.log('\n🗄️ Testando conexão com banco...');
try {
  const { getDatabaseInstance } = require('./backend/core/database/conexao');
  
  getDatabaseInstance().then(db => {
    console.log('✅ Banco conectado com sucesso');
    
    // Testar query simples
    return db.query('SELECT 1 as test');
  }).then(result => {
    console.log('✅ Query de teste executada');
    console.log('\n🎉 SISTEMA FUNCIONANDO CORRETAMENTE!');
  }).catch(error => {
    console.error('❌ Erro no banco:', error.message);
  });
  
} catch (error) {
  console.error('❌ Erro ao importar conexão:', error.message);
}

// Teste 3: Package.json
console.log('\n📦 Verificando package.json...');
try {
  const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  
  const requiredDeps = ['pg', 'express', 'node-telegram-bot-api'];
  let depsOk = 0;
  
  requiredDeps.forEach(dep => {
    if (packageJson.dependencies && packageJson.dependencies[dep]) {
      console.log(`✅ ${dep}`);
      depsOk++;
    } else {
      console.log(`❌ ${dep}`);
    }
  });
  
  console.log(`📊 Dependências: ${depsOk}/${requiredDeps.length} OK`);
  
} catch (error) {
  console.error('❌ Erro ao verificar package.json:', error.message);
}
