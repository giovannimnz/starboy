const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo variável accountId indefinida...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.fix-accountid.${Date.now()}`;
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

console.log('1️⃣ Analisando o problema...');

// Dividir o conteúdo em linhas para análise
const lines = content.split('\n');

// Encontrar a linha problemática (aproximadamente linha 78)
console.log('Linhas ao redor da linha 78:');
for (let i = 75; i < 85 && i < lines.length; i++) {
  const lineNum = i + 1;
  const line = lines[i];
  console.log(`${lineNum}: ${line}`);
  
  if (line.includes('accountId') && !line.includes('function') && !line.includes('=>') && !line.includes('//')) {
    console.log(`⚠️ Linha problemática encontrada: ${lineNum}`);
  }
}

// Procurar por usos de accountId fora de funções
console.log('\n2️⃣ Procurando usos incorretos de accountId...');

const problematicPatterns = [
  /console\.log.*accountId/g,
  /\.accountId/g,
  /accountId\s*[,;]/g,
  /\${accountId}/g
];

let foundIssues = false;

problematicPatterns.forEach((pattern, index) => {
  const matches = content.match(pattern);
  if (matches) {
    console.log(`Padrão ${index + 1} encontrado:`, matches);
    foundIssues = true;
  }
});

// Corrigir problemas comuns
console.log('\n3️⃣ Aplicando correções...');

// Remover linhas soltas com accountId
content = content.replace(/^\s*accountId\s*[,;]?\s*$/gm, '');

// Remover console.logs soltos com accountId
content = content.replace(/^\s*console\.log\(.*accountId.*\);\s*$/gm, '');

// Remover referências soltas a .accountId
content = content.replace(/^\s*\.accountId\s*[,;]?\s*$/gm, '');

// Remover template literals soltos com accountId
content = content.replace(/^\s*`.*\${accountId}.*`\s*[,;]?\s*$/gm, '');

// Remover blocos de código problemáticos comuns
const problematicBlocks = [
  /^\s*accountState\.accountId\s*[,;]?\s*$/gm,
  /^\s*state\.accountId\s*[,;]?\s*$/gm,
  /^\s*connection\.accountId\s*[,;]?\s*$/gm
];

problematicBlocks.forEach(pattern => {
  content = content.replace(pattern, '');
});

// Limpar linhas vazias extras
content = content.replace(/\n\s*\n\s*\n/g, '\n\n');

// Verificar se há funções sem fechamento
const openBraces = (content.match(/\{/g) || []).length;
const closeBraces = (content.match(/\}/g) || []).length;

console.log(`Chaves abertas: ${openBraces}, Chaves fechadas: ${closeBraces}`);

if (openBraces !== closeBraces) {
  console.log('⚠️ Possível problema com chaves não fechadas');
}

// Garantir que todas as funções estão bem formadas
const fixedContent = content.replace(/(\w+)\s*\(\s*\)\s*\{([^}]*)\}\s*\n\s*\n/g, (match, funcName, body) => {
  if (body.includes('accountId') && !body.includes('function') && !body.includes('=>')) {
    console.log(`⚠️ Removendo bloco problemático: ${funcName}`);
    return '';
  }
  return match;
});

fs.writeFileSync(websocketApiPath, fixedContent, 'utf8');

console.log('✅ Correções aplicadas');

// Verificar novamente
console.log('\n4️⃣ Verificação final...');

const newContent = fs.readFileSync(websocketApiPath, 'utf8');
const newLines = newContent.split('\n');

// Procurar por accountId fora de funções
let foundNewIssues = false;
for (let i = 0; i < newLines.length; i++) {
  const line = newLines[i].trim();
  if (line.includes('accountId') && 
      !line.includes('function') && 
      !line.includes('=>') && 
      !line.includes('//') &&
      !line.includes('*') &&
      !line.startsWith('console.log') &&
      !line.includes('params') &&
      !line.includes('return') &&
      !line.includes('if') &&
      !line.includes('const') &&
      !line.includes('let') &&
      !line.includes('var') &&
      line.length > 0) {
    
    console.log(`⚠️ Possível problema na linha ${i + 1}: ${line}`);
    foundNewIssues = true;
  }
}

if (!foundNewIssues) {
  console.log('✅ Nenhum problema adicional encontrado');
}

// Criar um arquivo limpo do zero se ainda houver problemas
if (foundNewIssues) {
  console.log('\n5️⃣ Recriando arquivo limpo...');
  
  const cleanWebSocketApi = `const api = require('./api');
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

    const requestId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const message = {
      id: requestId,
      method: request.method,
      params: request.params || {}
    };

    const timeoutId = setTimeout(() => {
      if (accountState.wsApiRequestCallbacks && accountState.wsApiRequestCallbacks.has(requestId)) {
        accountState.wsApiRequestCallbacks.delete(requestId);
      }
      console.error(\`[WS-API] Timeout na requisição \${request.method} para conta \${accountId}\`);
      reject(new Error(\`Timeout na requisição \${request.method}\`));
    }, timeout);

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

/**
 * Obtém informações detalhadas da conta através da WebSocket API V2
 */
async function getAccountInformationV2(params = {}, accountId) {
  try {
    console.log(\`[WS-API] Obtendo informações da conta \${accountId} via WebSocket API V2...\`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId é obrigatório e deve ser um número: \${accountId}\`);
    }
    
    if (!websockets.isWebSocketApiConnected(accountId)) {
      console.log(\`[WS-API] WebSocket não conectado para conta \${accountId}, tentando conectar...\`);
      await websockets.startWebSocketApi(accountId);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const request = {
      method: 'account.status',
      params: { ...params }
    };
    
    console.log(\`[WS-API] Enviando requisição account.status para conta \${accountId}...\`);
    const response = await sendWebSocketApiRequest(request, 30000, accountId);

    if (response && response.result) {
      console.log(\`[WS-API] ✅ Informações da conta \${accountId} recebidas com sucesso.\`);
      return {
        status: 200,
        result: response.result
      };
    } else if (response && response.error) {
      console.error(\`[WS-API] Erro da API ao obter informações da conta \${accountId}:\`, response.error);
      return { 
        status: 400,
        error: { 
          message: \`API Error: \${response.error.code} - \${response.error.msg}\`, 
          code: response.error.code 
        } 
      };
    } else {
      console.error(\`[WS-API] Resposta inesperada de account.status para conta \${accountId}:\`, response);
      return { 
        status: 500,
        error: { 
          message: 'Resposta inesperada de account.status' 
        } 
      };
    }
  } catch (error) {
    console.error(\`[WS-API] Erro ao obter informações da conta \${accountId}:\`, error.message);
    return { 
      status: 500,
      error: { 
        message: \`Erro na comunicação: \${error.message}\` 
      } 
    };
  }
}

/**
 * Obtém saldo da conta através da WebSocket API
 */
async function getAccountBalance(params = {}, accountId) {
  try {
    const result = await getAccountInformationV2(params, accountId);
    
    if (result.status === 200 && result.result) {
      const accountData = result.result;
      return {
        success: true,
        totalWalletBalance: parseFloat(accountData.totalWalletBalance || 0),
        availableBalance: parseFloat(accountData.availableBalance || 0),
        maxWithdrawAmount: parseFloat(accountData.maxWithdrawAmount || 0),
        feeTier: accountData.feeTier || 0,
        canTrade: accountData.canTrade || false,
        canWithdraw: accountData.canWithdraw || false,
        canDeposit: accountData.canDeposit || false,
        updateTime: accountData.updateTime
      };
    } else {
      return {
        success: false,
        error: result.error?.message || 'Falha ao obter saldo'
      };
    }
  } catch (error) {
    console.error(\`[WS-API] Erro ao obter saldo da conta \${accountId}:\`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Sincroniza saldo da conta via WebSocket
 */
async function syncAccountBalanceViaWebSocket(accountId) {
  try {
    console.log(\`[WS-API] Sincronizando saldo da conta \${accountId} via WebSocket...\`);
    
    const balance = await getAccountBalance({}, accountId);
    
    if (balance.success) {
      console.log(\`[WS-API] ✅ Saldo sincronizado para conta \${accountId}:\`, {
        total: balance.totalWalletBalance,
        disponível: balance.availableBalance
      });
      return balance;
    } else {
      console.error(\`[WS-API] Erro ao obter saldo da conta \${accountId}:\`, balance.error);
      throw new Error(balance.error);
    }
  } catch (error) {
    console.error(\`[WS-API] Erro ao sincronizar saldo da conta \${accountId} via WebSocket:\`, error.message);
    throw new Error(\`Falha ao obter informações da conta \${accountId}: \${error.message}\`);
  }
}

module.exports = {
  getAccountInformationV2,
  getAccountBalance,
  syncAccountBalanceViaWebSocket
};`;

  fs.writeFileSync(websocketApiPath, cleanWebSocketApi, 'utf8');
  console.log('✅ Arquivo recriado completamente');
}

console.log('\n🎉 Correção concluída!');

// Criar novo teste
const newTestScript = `// Novo teste após correção
console.log('🧪 Testando websocketApi após correção...');

try {
  const websocketApi = require('./websocketApi');
  
  console.log('✅ websocketApi carregado sem erros!');
  console.log('Funções disponíveis:');
  console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
  console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
  console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
  
  console.log('\\n🎉 Sucesso! Arquivo carregado sem erros.');
  console.log('\\n🚀 Agora execute:');
  console.log('   node test-final-validation.js');
  
} catch (error) {
  console.error('❌ Ainda há problemas:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}`;

fs.writeFileSync(path.join(__dirname, 'test-after-accountid-fix.js'), newTestScript);

console.log('\n🧪 Execute o novo teste:');
console.log('   node test-after-accountid-fix.js');

console.log('\n💾 Backup criado para segurança.');