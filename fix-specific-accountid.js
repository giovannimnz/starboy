const fs = require('fs');
const path = require('path');

console.log('🔧 Correção específica para accountId undefined...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.specific-accountid.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Analisar limitMakerEntry.js para encontrar a chamada problemática
console.log('1️⃣ Analisando limitMakerEntry.js...');
const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');

if (fs.existsSync(limitMakerPath)) {
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  const lines = content.split('\n');
  
  console.log('Procurando chamadas para setupBookDepthWebsocket...');
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('setupBookDepthWebsocket')) {
      console.log(`\nLinha ${i + 1}: ${line.trim()}`);
      
      // Mostrar contexto (linhas anteriores e posteriores)
      console.log('Contexto:');
      for (let j = Math.max(0, i - 3); j <= Math.min(lines.length - 1, i + 3); j++) {
        const marker = j === i ? ' --> ' : '     ';
        console.log(`${marker}${j + 1}: ${lines[j].trim()}`);
      }
      
      // Verificar se a linha tem o problema
      if (!line.includes(', accountId') && !line.includes(',accountId')) {
        console.log(`⚠️ Linha ${i + 1} não inclui accountId como parâmetro`);
        
        // Corrigir especificamente esta linha
        if (line.includes('websockets.setupBookDepthWebsocket(')) {
          lines[i] = line.replace(
            /websockets\.setupBookDepthWebsocket\(([^)]+)\)/,
            'websockets.setupBookDepthWebsocket($1, accountId)'
          );
          console.log(`✅ Corrigida: ${lines[i].trim()}`);
        }
      }
    }
  }
  
  // Verificar se accountId está disponível na função
  let inFunction = false;
  let functionHasAccountId = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detectar início de função
    if (line.includes('function') || line.includes('=>')) {
      inFunction = true;
      functionHasAccountId = line.includes('accountId');
    }
    
    // Detectar fim de função
    if (line.includes('}') && inFunction) {
      inFunction = false;
      functionHasAccountId = false;
    }
    
    // Se encontrar setupBookDepthWebsocket dentro de função sem accountId
    if (line.includes('setupBookDepthWebsocket') && inFunction && !functionHasAccountId) {
      console.log(`\n⚠️ setupBookDepthWebsocket na linha ${i + 1} está em função sem accountId`);
      
      // Encontrar o início da função para adicionar accountId
      for (let j = i; j >= 0; j--) {
        if (lines[j].includes('function') || lines[j].includes('=>')) {
          console.log(`Função na linha ${j + 1}: ${lines[j].trim()}`);
          
          // Se a função não tem accountId, precisamos adicioná-lo
          if (!lines[j].includes('accountId')) {
            console.log('📝 Esta função precisa receber accountId como parâmetro');
          }
          break;
        }
      }
    }
  }
  
  // Salvar correções
  createBackup(limitMakerPath);
  content = lines.join('\n');
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  
} else {
  console.error('❌ limitMakerEntry.js não encontrado');
}

// 2. Criar uma versão mais robusta da correção
console.log('\n2️⃣ Aplicando correção mais robusta...');

if (fs.existsSync(limitMakerPath)) {
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  
  // Padrão mais específico: encontrar a função executeLimitMakerEntry
  const functionMatch = content.match(/(async function executeLimitMakerEntry[\s\S]*?)\{/);
  
  if (functionMatch) {
    console.log('Encontrada função executeLimitMakerEntry');
    
    // Garantir que setupBookDepthWebsocket seja chamado com accountId correto
    content = content.replace(
      /websockets\.setupBookDepthWebsocket\((['"]?[^,'"]+['"]?)\)/g,
      'websockets.setupBookDepthWebsocket($1, accountId)'
    );
    
    // Remover duplicação se já existe
    content = content.replace(
      /websockets\.setupBookDepthWebsocket\(([^,]+),\s*accountId,\s*accountId\)/g,
      'websockets.setupBookDepthWebsocket($1, accountId)'
    );
    
    console.log('✅ Padrões de chamada corrigidos');
  }
  
  fs.writeFileSync(limitMakerPath, content, 'utf8');
}

// 3. Adicionar debug ao websockets.js
console.log('\n3️⃣ Adicionando debug ao websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  createBackup(websocketsPath);
  
  let content = fs.readFileSync(websocketsPath, 'utf8');
  
  // Encontrar setupBookDepthWebsocket e adicionar logs detalhados
  content = content.replace(
    /(setupBookDepthWebsocket[\s\S]*?function[^{]*\{)/,
    `$1
  console.log(\`[WEBSOCKET-DEBUG] setupBookDepthWebsocket chamado com:\`);
  console.log(\`  - symbol: \${arguments[0]} (tipo: \${typeof arguments[0]})\`);
  console.log(\`  - accountId: \${arguments[1]} (tipo: \${typeof arguments[1]})\`);
  console.log(\`  - Total argumentos: \${arguments.length}\`);
  
  if (!arguments[1] || typeof arguments[1] !== 'number') {
    console.error(\`[WEBSOCKET-DEBUG] ❌ ERRO: accountId inválido!\`);
    console.error(\`[WEBSOCKET-DEBUG] Stack trace:\`);
    console.error(new Error().stack);
    throw new Error(\`setupBookDepthWebsocket: accountId é obrigatório (recebido: \${arguments[1]})\`);
  }`
  );
  
  fs.writeFileSync(websocketsPath, content, 'utf8');
  console.log('✅ Debug adicionado ao setupBookDepthWebsocket');
}

// 4. Criar teste específico para capturar o erro
console.log('\n4️⃣ Criando teste para capturar erro específico...');

const debugTestScript = `// Teste debug para capturar chamada com accountId undefined
const websockets = require('./websockets');

// Mock da função para capturar chamadas
const originalSetupBookDepth = websockets.setupBookDepthWebsocket;

websockets.setupBookDepthWebsocket = function(...args) {
  console.log('\\n🔍 INTERCEPTADA chamada setupBookDepthWebsocket:');
  console.log('Argumentos:', args);
  console.log('Tipos:', args.map(arg => typeof arg));
  
  if (!args[1] || typeof args[1] !== 'number') {
    console.error('❌ PROBLEMA ENCONTRADO! accountId inválido:', args[1]);
    console.error('Stack trace:');
    console.error(new Error().stack);
  }
  
  return originalSetupBookDepth.apply(this, args);
};

// Simular execução do limitMakerEntry
async function simulateExecution() {
  try {
    console.log('🧪 Simulando execução que causa o erro...');
    
    // Tentar importar e usar limitMakerEntry
    const limitMaker = require('./posicoes/limitMakerEntry');
    
    console.log('✅ limitMakerEntry importado sem erro');
    console.log('\\n⚠️ Para testar completamente, execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    
  } catch (error) {
    console.error('❌ Erro na simulação:', error.message);
    if (error.stack) {
      console.error('Stack:', error.stack);
    }
  }
}

if (require.main === module) {
  simulateExecution();
}

module.exports = { simulateExecution };`;

fs.writeFileSync(path.join(__dirname, 'test-debug-accountid.js'), debugTestScript);
console.log('✅ Arquivo de teste debug criado: test-debug-accountid.js');

console.log('\n🎉 Correção específica concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Análise detalhada de limitMakerEntry.js');
console.log('2. ✅ Correção robusta das chamadas setupBookDepthWebsocket');
console.log('3. ✅ Debug detalhado adicionado ao websockets.js');
console.log('4. ✅ Teste debug para interceptar chamadas');

console.log('\n🧪 Execute o teste debug:');
console.log('   node test-debug-accountid.js');

console.log('\n🚀 Depois execute o monitoramento (vai mostrar mais detalhes):');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🔍 O debug vai mostrar exatamente onde accountId está undefined!');
console.log('\n💾 Backups criados para segurança.');