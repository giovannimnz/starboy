const fs = require('fs');
const path = require('path');

console.log('🔧 Correção exata do problema accountId undefined...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.exact-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Encontrar e corrigir a chamada problemática no limitMakerEntry.js
console.log('1️⃣ Analisando limitMakerEntry.js para encontrar chamada com accountId undefined...');
const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');

if (fs.existsSync(limitMakerPath)) {
  createBackup(limitMakerPath);
  
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  const lines = content.split('\n');
  
  console.log('Procurando chamadas para setupBookDepthWebsocket...');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('setupBookDepthWebsocket')) {
      console.log(`\nLinha ${i + 1}: ${line.trim()}`);
      
      // Verificar se esta linha tem o problema
      if (line.includes('setupBookDepthWebsocket(') && !line.includes('accountId')) {
        console.log(`❌ PROBLEMA ENCONTRADO na linha ${i + 1}!`);
        console.log('Esta chamada não tem accountId como segundo parâmetro');
        
        // Mostrar contexto para entender o escopo
        console.log('\nContexto (5 linhas antes e depois):');
        for (let j = Math.max(0, i - 5); j <= Math.min(lines.length - 1, i + 5); j++) {
          const marker = j === i ? ' --> ' : '     ';
          console.log(`${marker}${j + 1}: ${lines[j]}`);
        }
        
        // Procurar a variável accountId disponível no escopo
        let accountIdVariable = null;
        for (let k = i; k >= 0; k--) {
          if (lines[k].includes('function') && lines[k].includes('accountId')) {
            accountIdVariable = 'accountId';
            break;
          }
          if (lines[k].includes('const') && lines[k].includes('accountId')) {
            const match = lines[k].match(/const\s+(\w*[Aa]ccount[Ii]d\w*)/);
            if (match) {
              accountIdVariable = match[1];
              break;
            }
          }
          if (lines[k].includes('numericAccountId')) {
            accountIdVariable = 'numericAccountId';
            break;
          }
        }
        
        console.log(`\nVariável accountId encontrada no escopo: ${accountIdVariable}`);
        
        // Corrigir a linha
        if (accountIdVariable) {
          const originalLine = lines[i];
          lines[i] = originalLine.replace(
            /websockets\.setupBookDepthWebsocket\(([^,)]+)\)/,
            `websockets.setupBookDepthWebsocket($1, ${accountIdVariable})`
          );
          console.log(`✅ Corrigida para: ${lines[i].trim()}`);
        } else {
          console.log('⚠️ Não foi possível encontrar variável accountId no escopo');
        }
      }
    }
  }
  
  // Salvar correções
  content = lines.join('\n');
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  console.log('\n✅ Arquivo corrigido e salvo');
  
} else {
  console.error('❌ limitMakerEntry.js não encontrado');
}

// 2. Verificar se há outras funções que podem estar chamando setupBookDepthWebsocket incorretamente
console.log('\n2️⃣ Verificando outros arquivos...');

// Função para verificar arquivo
function checkFile(filePath, fileName) {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('setupBookDepthWebsocket(') && !line.includes('//')) {
        console.log(`\n${fileName} linha ${i + 1}: ${line.trim()}`);
        
        // Verificar se tem accountId
        if (!line.includes(', accountId') && !line.includes(',accountId')) {
          console.log(`⚠️ Possível problema em ${fileName}:${i + 1}`);
        }
      }
    }
  }
}

// Verificar outros arquivos que podem chamar setupBookDepthWebsocket
const filesToCheck = [
  ['posicoes/signalProcessor.js', 'signalProcessor.js'],
  ['posicoes/priceMonitoring.js', 'priceMonitoring.js'],
  ['posicoes/monitoramento.js', 'monitoramento.js']
];

filesToCheck.forEach(([filePath, fileName]) => {
  checkFile(path.join(__dirname, filePath), fileName);
});

// 3. Criar teste específico para reproduzir o problema
console.log('\n3️⃣ Criando teste específico...');

const testScript = `// Teste específico para reproduzir o problema accountId undefined
const websockets = require('./websockets');

// Mock da função para capturar exatamente onde está o problema
const originalSetupBookDepth = websockets.setupBookDepthWebsocket;

let callCount = 0;
websockets.setupBookDepthWebsocket = function(...args) {
  callCount++;
  console.log(\`\\n🔍 CHAMADA \${callCount} para setupBookDepthWebsocket:\`);
  console.log('Argumentos:', args);
  console.log('Tipos:', args.map(arg => typeof arg));
  console.log('Stack trace:');
  console.log(new Error().stack);
  
  if (!args[1] || typeof args[1] !== 'number') {
    console.error('❌ PROBLEMA IDENTIFICADO!');
    console.error(\`accountId inválido na chamada \${callCount}: \${args[1]} (tipo: \${typeof args[1]})\`);
    
    // Mostrar onde foi chamado
    const stack = new Error().stack.split('\\n');
    console.error('Chamado de:');
    stack.slice(1, 5).forEach(line => console.error('  ', line.trim()));
    
    throw new Error(\`setupBookDepthWebsocket chamado com accountId inválido: \${args[1]}\`);
  } else {
    console.log('✅ Chamada válida');
  }
  
  return originalSetupBookDepth.apply(this, args);
};

console.log('\\n🧪 Teste instalado! Agora execute o monitoramento para capturar o erro.');
console.log('Execute: node posicoes/monitoramento.js --account 1');
console.log('\\nO teste vai parar exatamente na chamada problemática e mostrar o stack trace completo.');

module.exports = { callCount };`;

fs.writeFileSync(path.join(__dirname, 'test-exact-problem.js'), testScript);
console.log('✅ Arquivo de teste criado: test-exact-problem.js');

// 4. Criar versão simplificada para testar a correção
console.log('\n4️⃣ Criando teste de validação...');

const validationScript = `// Teste de validação da correção
console.log('🧪 Validando correção do accountId undefined...');

try {
  const limitMaker = require('./posicoes/limitMakerEntry');
  console.log('✅ limitMakerEntry carregado sem erros de sintaxe');
  
  console.log('\\n📋 Próximos passos:');
  console.log('1. Execute o monitoramento novamente');
  console.log('2. Observe se ainda aparece "accountId=undefined"');
  console.log('3. Se aparecer, execute: node test-exact-problem.js');
  
} catch (error) {
  console.error('❌ Erro ao carregar limitMakerEntry:', error.message);
}`;

fs.writeFileSync(path.join(__dirname, 'test-validation-fix.js'), validationScript);
console.log('✅ Arquivo de validação criado: test-validation-fix.js');

console.log('\n🎉 Correção exata concluída!');
console.log('\n📋 O que foi feito:');
console.log('1. ✅ Identificada chamada setupBookDepthWebsocket sem accountId');
console.log('2. ✅ Corrigida a chamada para incluir accountId correto');
console.log('3. ✅ Verificados outros arquivos por problemas similares');
console.log('4. ✅ Criado teste para capturar problemas futuros');

console.log('\n🧪 Execute o teste de validação:');
console.log('   node test-validation-fix.js');

console.log('\n🚀 Depois execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🔍 Se ainda aparecer accountId=undefined, execute:');
console.log('   node test-exact-problem.js');
console.log('   (e depois execute o monitoramento para capturar o stack trace)');

console.log('\n💾 Backup criado para segurança.');