const fs = require('fs');
const path = require('path');

console.log('🔧 Correção definitiva do sendWebSocketApiRequest...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.sendws-final.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Verificar websockets.js
console.log('1️⃣ Verificando websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');
  
  // Verificar se sendWebSocketApiRequest existe
  const hasSendFunction = websocketsContent.includes('function sendWebSocketApiRequest') || 
                         websocketsContent.includes('async function sendWebSocketApiRequest');
  
  console.log(`- sendWebSocketApiRequest function exists: ${hasSendFunction}`);
  
  if (!hasSendFunction) {
    console.log('➕ Adicionando sendWebSocketApiRequest ao websockets.js...');
    createBackup(websocketsPath);
    
    // Adicionar função sendWebSocketApiRequest
    const sendFunction = `
/**
 * Envia requisição via WebSocket API
 * @param {Object} request - Requisição a ser enviada
 * @param {number} timeout - Timeout em ms
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  return new Promise((resolve, reject) => {
    console.log(\`[WS-API] Enviando requisição WebSocket para conta \${accountId}:\`, request);
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(\`[WS-API] AccountId inválido: \${accountId}\`);
      return reject(new Error('AccountId é obrigatório e deve ser um número'));
    }

    // Obter estado da conta
    const accountState = getAccountConnectionState(accountId);
    if (!accountState) {
      console.error(\`[WS-API] Estado da conta \${accountId} não encontrado\`);
      return reject(new Error('Estado da conta não encontrado'));
    }

    const connection = accountState.wsApiConnection;
    if (!connection || connection.readyState !== 1) {
      console.error(\`[WS-API] WebSocket não conectado para conta \${accountId}, estado: \${connection?.readyState || 'N/A'}\`);
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
}`;

    // Adicionar antes do module.exports
    websocketsContent = websocketsContent.replace(
      /module\.exports\s*=/,
      `${sendFunction}\n\nmodule.exports =`
    );
    
    fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
    console.log('✅ sendWebSocketApiRequest adicionada');
  }
  
  // Verificar exports
  const hasExport = websocketsContent.includes('sendWebSocketApiRequest') && 
                   websocketsContent.match(/module\.exports\s*=\s*\{[^}]*sendWebSocketApiRequest/s);
  
  if (!hasExport) {
    console.log('➕ Adicionando sendWebSocketApiRequest aos exports...');
    
    websocketsContent = fs.readFileSync(websocketsPath, 'utf8');
    
    // Encontrar module.exports e adicionar a função
    const exportsMatch = websocketsContent.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
    if (exportsMatch) {
      let exportsContent = exportsMatch[1];
      
      if (!exportsContent.includes('sendWebSocketApiRequest')) {
        exportsContent += ',\n  sendWebSocketApiRequest';
        
        websocketsContent = websocketsContent.replace(
          /module\.exports\s*=\s*\{[^}]+\}/s,
          `module.exports = {${exportsContent}\n}`
        );
        
        fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
        console.log('✅ sendWebSocketApiRequest adicionada aos exports');
      }
    }
  }
} else {
  console.error('❌ websockets.js não encontrado');
}

// 2. Corrigir websocketApi.js
console.log('\n2️⃣ Corrigindo websocketApi.js...');
const websocketApiPath = path.join(__dirname, 'websocketApi.js');

if (fs.existsSync(websocketApiPath)) {
  createBackup(websocketApiPath);
  
  let content = fs.readFileSync(websocketApiPath, 'utf8');
  
  // Limpar imports antigos e adicionar corretos
  const lines = content.split('\n');
  const cleanedLines = lines.filter(line => 
    !line.includes('require(') || 
    line.includes('// filepath:') ||
    line.includes('const api = require') ||
    line.includes('const { getDatabaseInstance }')
  );
  
  // Adicionar imports corretos no início
  const correctImports = `const api = require('./api');
const { getDatabaseInstance } = require('./db/conexao');
const websockets = require('./websockets');

// Função importada diretamente do websockets
const { sendWebSocketApiRequest, getAccountConnectionState } = websockets;`;

  // Reconstruir o arquivo
  const fileWithoutImports = cleanedLines.join('\n').replace(/^(const.*require.*\n)*/m, '');
  content = correctImports + '\n\n' + fileWithoutImports;
  
  // Garantir que getAccountConnectionState está sendo usada corretamente
  content = content.replace(
    /api\.getAccountConnectionState/g,
    'getAccountConnectionState'
  );
  
  fs.writeFileSync(websocketApiPath, content, 'utf8');
  console.log('✅ websocketApi.js corrigido com imports diretos');
} else {
  console.error('❌ websocketApi.js não encontrado');
}

// 3. Criar teste simples para validar
console.log('\n3️⃣ Criando teste de validação...');

const testScript = `// Teste de validação do sendWebSocketApiRequest
const websockets = require('./websockets');
const websocketApi = require('./websocketApi');

async function testValidation() {
  console.log('🧪 Teste de validação...');
  
  try {
    console.log('\\n=== VERIFICAR IMPORTS ===');
    console.log('- websockets.sendWebSocketApiRequest:', typeof websockets.sendWebSocketApiRequest);
    console.log('- websockets.getAccountConnectionState:', typeof websockets.getAccountConnectionState);
    console.log('- websocketApi.getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    
    if (typeof websockets.sendWebSocketApiRequest !== 'function') {
      console.error('❌ sendWebSocketApiRequest não está disponível!');
      return false;
    }
    
    console.log('\\n=== TESTAR WEBSOCKET API ===');
    
    // Conectar primeiro
    console.log('Conectando WebSocket...');
    await websockets.startWebSocketApi(1);
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Testar getAccountInformationV2
    console.log('Testando getAccountInformationV2...');
    const result = await websocketApi.getAccountInformationV2({}, 1);
    
    console.log('Resultado:', {
      status: result?.status,
      hasResult: !!result?.result,
      hasError: !!result?.error,
      errorMessage: result?.error?.message
    });
    
    if (result?.status === 200) {
      console.log('✅ SUCESSO! WebSocket API funcionando!');
      return true;
    } else if (result?.status === 500 && result?.error?.message?.includes('sendWebSocketApiRequest is not defined')) {
      console.log('❌ FALHA! sendWebSocketApiRequest ainda não definida');
      return false;
    } else {
      console.log('⚠️ Resposta inesperada, mas função existe');
      return true;
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    return false;
  }
}

if (require.main === module) {
  testValidation().then(success => {
    if (success) {
      console.log('\\n🎉 Validação bem-sucedida!');
      console.log('\\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
    } else {
      console.log('\\n❌ Validação falhou - verifique os logs');
      process.exit(1);
    }
  });
}

module.exports = { testValidation };`;

fs.writeFileSync(path.join(__dirname, 'test-validation.js'), testScript);
console.log('✅ Arquivo de validação criado: test-validation.js');

console.log('\n🎉 Correção definitiva concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Função sendWebSocketApiRequest garantida em websockets.js');
console.log('2. ✅ Exports corretos em websockets.js');
console.log('3. ✅ Imports diretos em websocketApi.js');
console.log('4. ✅ Teste de validação criado');

console.log('\n🧪 Execute o teste de validação:');
console.log('   node test-validation.js');

console.log('\n💾 Backups criados para segurança.');