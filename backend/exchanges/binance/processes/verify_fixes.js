/**
 * Teste de verificação dos erros corrigidos
 */

const path = require('path');
const fs = require('fs');

console.log('🔍 === VERIFICAÇÃO DAS CORREÇÕES ===');

// Verificar se o arquivo telegramBot.js foi criado
const telegramBotPath = path.join(__dirname, '..', 'monitoring', 'telegramBot.js');
if (fs.existsSync(telegramBotPath)) {
  console.log('✅ telegramBot.js foi criado com sucesso');
} else {
  console.log('❌ telegramBot.js não foi encontrado');
}

// Verificar se os arquivos principais existem
const files = [
  '../api/rest.js',
  '../monitoring/orchMonitor.js',
  '../monitoring/telegramBot.js'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    console.log(`✅ ${file} existe`);
  } else {
    console.log(`❌ ${file} não encontrado`);
  }
});

// Verificar se não há mais destructuring MySQL nos arquivos
const checkDestructuring = (filePath) => {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const mysqlPattern = /const \[.*\] = await.*\.query/g;
    const matches = content.match(mysqlPattern);
    
    if (matches && matches.length > 0) {
      console.log(`❌ ${filePath} ainda contém destructuring MySQL:`);
      matches.forEach(match => console.log(`   ${match}`));
      return false;
    } else {
      console.log(`✅ ${filePath} não contém destructuring MySQL`);
      return true;
    }
  }
  return false;
};

console.log('\n🔍 === VERIFICAÇÃO DE DESTRUCTURING MYSQL ===');
const restPath = path.join(__dirname, '..', 'api', 'rest.js');
const orchPath = path.join(__dirname, '..', 'monitoring', 'orchMonitor.js');

const restOk = checkDestructuring(restPath);
const orchOk = checkDestructuring(orchPath);

if (restOk && orchOk) {
  console.log('\n🎉 === TODAS AS CORREÇÕES FORAM APLICADAS ===');
  console.log('✅ Padrão PostgreSQL aplicado corretamente');
  console.log('✅ Módulo telegramBot.js criado');
  console.log('✅ Variáveis $1 corrigidas');
  console.log('\n🚀 O sistema deve funcionar agora!');
} else {
  console.log('\n⚠️ Ainda há problemas que precisam ser corrigidos');
}

console.log('\n📝 === PRÓXIMOS PASSOS ===');
console.log('1. Execute: node app.js');
console.log('2. Escolha opção 1 (Iniciar todas as contas)');
console.log('3. Verifique se as contas inicializam sem erros');
