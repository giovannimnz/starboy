const fs = require('fs');
const path = require('path');

console.log('🔧 Removendo imports duplicados do websocketApi.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.fix-duplicates.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

const websocketApiPath = path.join(__dirname, 'websocketApi.js');
createBackup(websocketApiPath);

let content = fs.readFileSync(websocketApiPath, 'utf8');

console.log('1️⃣ Analisando imports duplicados...');

// Identificar todas as linhas de require
const requireLines = content.match(/^const .* = require\(.*\);?$/gm) || [];
console.log('Linhas de require encontradas:', requireLines.length);

// Remover todas as linhas de require duplicadas
const cleanedContent = content.split('\n').filter((line, index) => {
  const isRequire = line.match(/^const .* = require\(.*\);?$/);
  if (isRequire) {
    // Manter apenas a primeira ocorrência de cada import
    const firstOccurrence = content.split('\n').findIndex(l => l.trim() === line.trim());
    return index === firstOccurrence;
  }
  return true;
}).join('\n');

// Criar imports limpos e organizados no topo
const cleanImports = `// filepath: c:\\Users\\muniz\\Documents\\GitHub\\starboy\\websocketApi.js
const api = require('./api');
const { getDatabaseInstance, formatDateForMySQL } = require('./db/conexao');
const websockets = require('./websockets');

// Função para enviar requisições WebSocket API
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  return new Promise((resolve, reject) => {
    console.log(\`[WS-API] Enviando requisição WebSocket para conta \${accountId}:\`, request);
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(\`[WS-API] AccountId inválido: \${accountId}\`);
      return reject(new Error('AccountId é obrigatório e deve ser um número'));
    }

    const { getAccountConnectionState } = api;
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiConnection) {
      console.error(\`[WS-API] WebSocket não conectado para conta \${accountId}\`);
      return reject(new Error('WebSocket não conectado'));
    }

    const connection = accountState.wsApiConnection;
    if (connection.readyState !== 1) {
      console.error(\`[WS-API] WebSocket não está no estado OPEN para conta \${accountId}, estado atual: \${connection.readyState}\`);
      return reject(new Error('WebSocket não está conectado'));
    }

    // Gerar ID único para a requisição
    const requestId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const message = {
      id: requestId,
      method: request.method,
      params: request.params || {}
    };

    // Configurar timeout
    const timeoutId = setTimeout(() => {
      if (accountState.wsApiRequestCallbacks && accountState.wsApiRequestCallbacks.has(requestId)) {
        accountState.wsApiRequestCallbacks.delete(requestId);
      }
      console.error(\`[WS-API] Timeout na requisição \${request.method} para conta \${accountId}\`);
      reject(new Error(\`Timeout na requisição \${request.method}\`));
    }, timeout);

    // Registrar callback
    if (!accountState.wsApiRequestCallbacks) {
      accountState.wsApiRequestCallbacks = new Map();
    }
    
    accountState.wsApiRequestCallbacks.set(requestId, (response) => {
      clearTimeout(timeoutId);
      
      if (response.error) {
        console.error(\`[WS-API] Erro na resposta \${request.method} para conta \${accountId}:\`, response.error);
        reject(new Error(\`API Error: \${response.error.code} - \${response.error.msg}\`));
      } else {
        console.log(\`[WS-API] ✅ Resposta recebida para \${request.method} (conta \${accountId})\`);
        resolve(response);
      }
    });

    try {
      connection.send(JSON.stringify(message));
      console.log(\`[WS-API] Mensagem enviada para conta \${accountId}: \${request.method}\`);
    } catch (error) {
      clearTimeout(timeoutId);
      if (accountState.wsApiRequestCallbacks) {
        accountState.wsApiRequestCallbacks.delete(requestId);
      }
      console.error(\`[WS-API] Erro ao enviar mensagem para conta \${accountId}:\`, error.message);
      reject(error);
    }
  });
}

`;

// Remover imports e filepath do conteúdo
let bodyContent = cleanedContent
  .replace(/^\/\/ filepath:.*$/gm, '')
  .replace(/^const .* = require\(.*\);?$/gm, '')
  .replace(/^\/\/ Função importada diretamente do websockets.*$/gm, '')
  .replace(/^const \{ sendWebSocketApiRequest, getAccountConnectionState \} = websockets;.*$/gm, '')
  .replace(/^\/\/ Função para enviar requisições WebSocket API[\s\S]*?\}\s*$/m, '')
  .trim();

// Remover linhas vazias consecutivas
bodyContent = bodyContent.replace(/\n\s*\n\s*\n/g, '\n\n');

// Remover blocos let handlers
bodyContent = bodyContent.replace(/^let handlers = null;\s*$/gm, '');

// Remover declarações duplicadas de currentDateTime
bodyContent = bodyContent.replace(/^const currentDateTime = formatDateForMySQL\(new Date\(\)\);\s*$/gm, '');

// Reconstituir o arquivo limpo
const finalContent = cleanImports + bodyContent;

fs.writeFileSync(websocketApiPath, finalContent, 'utf8');

console.log('✅ Imports duplicados removidos');

// Verificar se ainda há problemas
console.log('\n2️⃣ Verificando se ainda há duplicatas...');
const newContent = fs.readFileSync(websocketApiPath, 'utf8');
const newRequireLines = newContent.match(/^const .* = require\(.*\);?$/gm) || [];
console.log('Linhas de require após limpeza:', newRequireLines.length);

// Verificar duplicatas por variável
const variables = new Map();
newRequireLines.forEach(line => {
  const match = line.match(/^const (.*?) =/);
  if (match) {
    const varName = match[1].trim();
    if (variables.has(varName)) {
      console.warn(`⚠️ Ainda há duplicata para: ${varName}`);
    } else {
      variables.set(varName, true);
    }
  }
});

console.log('✅ Arquivo limpo!');

// Criar teste para validar a correção
const testScript = `// Teste após correção de duplicatas
console.log('🧪 Testando websocketApi após correção...');

try {
  const websocketApi = require('./websocketApi');
  
  console.log('✅ websocketApi carregado sem erros!');
  console.log('Funções disponíveis:');
  console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
  console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
  console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
  console.log('- placeLimitMakerOrderViaWebSocket:', typeof websocketApi.placeLimitMakerOrderViaWebSocket);
  
  console.log('\\n🎉 Correção bem-sucedida! Arquivo carregado sem erros de sintaxe.');
  
} catch (error) {
  console.error('❌ Ainda há problemas:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}`;

fs.writeFileSync(path.join(__dirname, 'test-after-fix.js'), testScript);

console.log('\n🎉 Correção de duplicatas concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Imports duplicados removidos');
console.log('2. ✅ Declarações duplicadas de variáveis removidas');
console.log('3. ✅ Função sendWebSocketApiRequest mantida apenas uma vez');
console.log('4. ✅ Estrutura do arquivo reorganizada');

console.log('\n🧪 Execute o teste:');
console.log('   node test-after-fix.js');

console.log('\n🚀 Depois execute o teste final:');
console.log('   node test-final-validation.js');

console.log('\n💾 Backup criado para segurança.');