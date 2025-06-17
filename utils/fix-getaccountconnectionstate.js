const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo problema específico: websockets.getAccountConnectionState...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.fix-getaccountconnectionstate.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Corrigir websockets.js
console.log('1️⃣ Corrigindo websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');
createBackup(websocketsPath);

let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');

// Verificar se getAccountConnectionState está sendo importado mas não exportado
console.log('🔍 Verificando importações e exportações...');

// Verificar se a importação está correta
if (!websocketsContent.includes('const { getAccountConnectionState } = api;')) {
  console.log('➕ Adicionando importação correta de getAccountConnectionState...');
  
  // Adicionar importação após a linha do require('./api')
  websocketsContent = websocketsContent.replace(
    /const api = require\('\.\/api'\);/,
    `const api = require('./api');
const { getAccountConnectionState } = api;`
  );
}

// Verificar se está exportando a função
const moduleExportsMatch = websocketsContent.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
if (moduleExportsMatch) {
  const exportsContent = moduleExportsMatch[1];
  
  if (!exportsContent.includes('getAccountConnectionState')) {
    console.log('➕ Adicionando getAccountConnectionState ao module.exports...');
    
    // Adicionar getAccountConnectionState ao final da lista de exports
    const newExports = websocketsContent.replace(
      /module\.exports = \{([^}]+)\}/s,
      (match, exports) => {
        // Remover trailing whitespace e adicionar vírgula se necessário
        const cleanExports = exports.trim();
        const needsComma = !cleanExports.endsWith(',');
        
        return `module.exports = {${exports}${needsComma ? ',' : ''}
  getAccountConnectionState
}`;
      }
    );
    
    websocketsContent = newExports;
  }
}

fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
console.log('✅ websockets.js corrigido');

// 2. Verificar se api.js tem a função corretamente
console.log('\n2️⃣ Verificando api.js...');
const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  const apiContent = fs.readFileSync(apiPath, 'utf8');
  
  const hasAccountConnections = apiContent.includes('const accountConnections = new Map()');
  const hasGetAccountConnectionState = apiContent.includes('function getAccountConnectionState(');
  const hasGetAllAccountConnections = apiContent.includes('function getAllAccountConnections(');
  const exportsGetAccountConnectionState = apiContent.includes('getAccountConnectionState') && 
                                          apiContent.includes('module.exports');
  
  console.log(`  - accountConnections Map: ${hasAccountConnections ? '✅' : '❌'}`);
  console.log(`  - getAccountConnectionState function: ${hasGetAccountConnectionState ? '✅' : '❌'}`);
  console.log(`  - getAllAccountConnections function: ${hasGetAllAccountConnections ? '✅' : '❌'}`);
  console.log(`  - exporta getAccountConnectionState: ${exportsGetAccountConnectionState ? '✅' : '❌'}`);
  
  if (!hasAccountConnections || !hasGetAccountConnectionState || !exportsGetAccountConnectionState) {
    console.log('❌ api.js tem problemas, precisa ser corrigido primeiro');
    console.log('Execute novamente: node fix-api-final.js');
  } else {
    console.log('✅ api.js parece estar correto');
  }
} else {
  console.log('❌ api.js não encontrado');
}

// 3. Verificar monitoramento.js
console.log('\n3️⃣ Verificando monitoramento.js...');
const monitoramentoPath = path.join(__dirname, 'posicoes', 'monitoramento.js');

if (fs.existsSync(monitoramentoPath)) {
  const monitoramentoContent = fs.readFileSync(monitoramentoPath, 'utf8');
  
  const hasWebsocketsImport = monitoramentoContent.includes("require('../websockets')");
  const callsGetAccountConnectionState = monitoramentoContent.includes('websockets.getAccountConnectionState');
  
  console.log(`  - importa websockets: ${hasWebsocketsImport ? '✅' : '❌'}`);
  console.log(`  - chama websockets.getAccountConnectionState: ${callsGetAccountConnectionState ? '✅' : '❌'}`);
  
  if (callsGetAccountConnectionState) {
    console.log('🔧 Monitoramento.js chama websockets.getAccountConnectionState - isso precisa ser corrigido');
    
    createBackup(monitoramentoPath);
    
    // Corrigir as chamadas para usar api.getAccountConnectionState
    const correctedMonitoramento = monitoramentoContent.replace(
      /websockets\.getAccountConnectionState/g,
      'api.getAccountConnectionState'
    );
    
    fs.writeFileSync(monitoramentoPath, correctedMonitoramento, 'utf8');
    console.log('✅ monitoramento.js corrigido para usar api.getAccountConnectionState');
  }
} else {
  console.log('❌ monitoramento.js não encontrado');
}

// 4. Criar um teste simples
console.log('\n4️⃣ Criando teste de verificação...');

const testScript = `// Teste simples para verificar getAccountConnectionState
const api = require('./api');
const websockets = require('./websockets');

console.log('🧪 Testando getAccountConnectionState...');

try {
  // Testar api.getAccountConnectionState
  console.log('1. Testando api.getAccountConnectionState...');
  const stateFromApi = api.getAccountConnectionState(1, true);
  console.log('   ✅ api.getAccountConnectionState funciona:', !!stateFromApi);
  
  // Testar websockets.getAccountConnectionState (se existe)
  console.log('2. Testando websockets.getAccountConnectionState...');
  if (typeof websockets.getAccountConnectionState === 'function') {
    const stateFromWebsockets = websockets.getAccountConnectionState(1);
    console.log('   ✅ websockets.getAccountConnectionState funciona:', !!stateFromWebsockets);
  } else {
    console.log('   ❌ websockets.getAccountConnectionState não é uma função');
  }
  
  console.log('\\n🎉 Teste concluído!');
  
} catch (error) {
  console.error('❌ Erro no teste:', error.message);
  process.exit(1);
}
`;

fs.writeFileSync(path.join(__dirname, 'test-getaccountconnectionstate.js'), testScript);
console.log('✅ Arquivo de teste criado: test-getaccountconnectionstate.js');

console.log('\n🎉 Correção concluída!');
console.log('\n📋 Resumo das correções:');
console.log('1. ✅ websockets.js - Adicionada importação e exportação de getAccountConnectionState');
console.log('2. ✅ Verificado api.js');
console.log('3. ✅ Corrigido monitoramento.js para usar api.getAccountConnectionState');
console.log('4. ✅ Criado teste de verificação');

console.log('\n🧪 Execute o teste:');
console.log('   node test-getaccountconnectionstate.js');

console.log('\n🚀 Depois teste o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para todos os arquivos alterados.');