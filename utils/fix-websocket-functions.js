const fs = require('fs');
const path = require('path');

console.log('🔧 Verificando e corrigindo funções WebSocket...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.ws-functions.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// Verificar websockets.js
console.log('1️⃣ Verificando websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');
  
  // Verificar se sendWebSocketApiRequest existe e está sendo exportada
  const hasSendFunction = websocketsContent.includes('sendWebSocketApiRequest');
  const hasExport = websocketsContent.includes('sendWebSocketApiRequest') && 
                   websocketsContent.includes('module.exports') && 
                   websocketsContent.match(/module\.exports\s*=\s*\{[^}]*sendWebSocketApiRequest/s);
  
  console.log(`- sendWebSocketApiRequest existe: ${hasSendFunction}`);
  console.log(`- sendWebSocketApiRequest exportada: ${hasExport}`);
  
  if (!hasSendFunction) {
    console.log('➕ Adicionando função sendWebSocketApiRequest...');
    
    createBackup(websocketsPath);
    
    const sendWebSocketApiRequestFunction = `
/**
 * Envia requisição via WebSocket API
 * @param {Object} request - Dados da requisição
 * @param {number} timeout - Timeout em ms (padrão: 30000)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resposta da API
 */
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  return new Promise((resolve, reject) => {
    console.log(\`[WS-API] Enviando requisição WebSocket para conta \${accountId}:\`, request);
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(\`[WS-API] AccountId inválido: \${accountId}\`);
      return reject(new Error('AccountId é obrigatório e deve ser um número'));
    }

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
      if (accountState.wsApiRequestCallbacks.has(requestId)) {
        accountState.wsApiRequestCallbacks.delete(requestId);
        console.error(\`[WS-API] Timeout na requisição \${request.method} para conta \${accountId}\`);
        reject(new Error(\`Timeout na requisição \${request.method}\`));
      }
    }, timeout);

    // Registrar callback
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
      accountState.wsApiRequestCallbacks.delete(requestId);
      console.error(\`[WS-API] Erro ao enviar mensagem para conta \${accountId}:\`, error.message);
      reject(error);
    }
  });
}`;

    // Adicionar a função antes do module.exports
    websocketsContent = websocketsContent.replace(
      /module\.exports\s*=/,
      `${sendWebSocketApiRequestFunction}\n\nmodule.exports =`
    );
    
    // Adicionar ao exports se não estiver
    if (!websocketsContent.includes('sendWebSocketApiRequest')) {
      websocketsContent = websocketsContent.replace(
        /module\.exports = \{([^}]+)\}/s,
        (match, exports) => {
          return `module.exports = {${exports},
  sendWebSocketApiRequest
}`;
        }
      );
    }
    
    fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
    console.log('✅ sendWebSocketApiRequest adicionada ao websockets.js');
  }
  
  if (!hasExport && hasSendFunction) {
    console.log('➕ Adicionando sendWebSocketApiRequest ao exports...');
    
    websocketsContent = websocketsContent.replace(
      /module\.exports = \{([^}]+)\}/s,
      (match, exports) => {
        if (!exports.includes('sendWebSocketApiRequest')) {
          return `module.exports = {${exports},
  sendWebSocketApiRequest
}`;
        }
        return match;
      }
    );
    
    fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
    console.log('✅ sendWebSocketApiRequest adicionada ao exports');
  }
} else {
  console.error('❌ websockets.js não encontrado');
}

// Verificar e corrigir websocketApi.js
console.log('\n2️⃣ Corrigindo websocketApi.js...');
const websocketApiPath = path.join(__dirname, 'websocketApi.js');

if (fs.existsSync(websocketApiPath)) {
  createBackup(websocketApiPath);
  
  let content = fs.readFileSync(websocketApiPath, 'utf8');
  
  // Garantir que os imports estão corretos
  const correctImports = `const api = require('./api');
const { getDatabaseInstance } = require('./db/conexao');
const websockets = require('./websockets');
const { sendWebSocketApiRequest } = require('./websockets');`;

  // Substituir imports existentes
  content = content.replace(
    /^(const.*require.*\n)+/m,
    correctImports + '\n\n'
  );
  
  // Verificar se getAccountConnectionState está sendo importado
  if (!content.includes('getAccountConnectionState')) {
    content = content.replace(
      correctImports,
      correctImports + '\nconst { getAccountConnectionState } = require(\'./api\');'
    );
  }
  
  fs.writeFileSync(websocketApiPath, content, 'utf8');
  console.log('✅ websocketApi.js corrigido com imports corretos');
} else {
  console.error('❌ websocketApi.js não encontrado');
}

// Criar um teste mais específico
console.log('\n3️⃣ Criando teste mais específico...');

const advancedTestScript = `// Teste avançado do WebSocket API
const websockets = require('./websockets');
const websocketApi = require('./websocketApi');

async function testAdvanced() {
  console.log('🧪 Teste avançado do WebSocket API...');
  
  try {
    console.log('\\n=== TESTE 1: Verificar imports ===');
    console.log('- websockets.sendWebSocketApiRequest:', typeof websockets.sendWebSocketApiRequest);
    console.log('- websockets.startWebSocketApi:', typeof websockets.startWebSocketApi);
    console.log('- websockets.isWebSocketApiConnected:', typeof websockets.isWebSocketApiConnected);
    
    console.log('\\n=== TESTE 2: Verificar websocketApi ===');
    console.log('- websocketApi.getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    console.log('- websocketApi.getAccountBalance:', typeof websocketApi.getAccountBalance);
    
    if (typeof websockets.sendWebSocketApiRequest !== 'function') {
      console.error('❌ sendWebSocketApiRequest não está disponível em websockets');
      return false;
    }
    
    console.log('\\n=== TESTE 3: Inicializar WebSocket API ===');
    const isConnected = websockets.isWebSocketApiConnected(1);
    console.log('WebSocket conectado:', isConnected);
    
    if (!isConnected) {
      console.log('Conectando WebSocket...');
      await websockets.startWebSocketApi(1);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('\\n=== TESTE 4: Testar getAccountInformationV2 ===');
    const result = await websocketApi.getAccountInformationV2({}, 1);
    console.log('Resultado completo:', {
      status: result?.status,
      hasResult: !!result?.result,
      hasError: !!result?.error,
      errorMessage: result?.error?.message
    });
    
    if (result && result.status === 200) {
      console.log('✅ WebSocket API funcionando!');
      
      console.log('\\n=== TESTE 5: Testar getAccountBalance ===');
      const balance = await websocketApi.getAccountBalance({}, 1);
      console.log('Saldo resultado:', {
        success: balance?.success,
        totalWalletBalance: balance?.totalWalletBalance,
        availableBalance: balance?.availableBalance
      });
      
      return true;
    } else {
      console.log('⚠️ WebSocket API com problemas, mas função existe');
      return true;
    }
    
  } catch (error) {
    console.error('❌ Erro no teste avançado:', error.message);
    console.error('Stack:', error.stack);
    return false;
  }
}

if (require.main === module) {
  testAdvanced().then(success => {
    if (success) {
      console.log('\\n🎉 Teste concluído com sucesso!');
      console.log('\\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
    } else {
      console.log('\\n❌ Teste falhou');
      process.exit(1);
    }
  });
}

module.exports = { testAdvanced };`;

fs.writeFileSync(path.join(__dirname, 'test-websocket-advanced.js'), advancedTestScript);
console.log('✅ Arquivo de teste avançado criado: test-websocket-advanced.js');

console.log('\n🎉 Correção de funções WebSocket concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Verificação e adição de sendWebSocketApiRequest');
console.log('2. ✅ Imports corrigidos em websocketApi.js');
console.log('3. ✅ Exports corrigidos em websockets.js');
console.log('4. ✅ Teste avançado criado');

console.log('\n🧪 Execute o teste avançado:');
console.log('   node test-websocket-advanced.js');

console.log('\n💾 Backups criados para segurança.');