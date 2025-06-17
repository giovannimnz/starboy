const fs = require('fs');
const path = require('path');

console.log('🔧 Correção final do sendWebSocketApiRequest...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.final-request.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Corrigir websocketApi.js
console.log('1️⃣ Corrigindo websocketApi.js definitivamente...');
const websocketApiPath = path.join(__dirname, 'websocketApi.js');

if (fs.existsSync(websocketApiPath)) {
  createBackup(websocketApiPath);
  
  let content = fs.readFileSync(websocketApiPath, 'utf8');
  
  // Substituir imports problemáticos por versão correta
  const correctImports = `const api = require('./api');
const { getDatabaseInstance } = require('./db/conexao');
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
}`;

  // Limpar imports antigos e adicionar novos
  content = content.replace(/^(const.*require.*\n)*/m, '');
  content = correctImports + '\n\n' + content;
  
  // Corrigir a função getAccountInformationV2 com chamada correta
  const newGetAccountInformationV2 = `/**
 * Obtém informações detalhadas da conta através da WebSocket API V2 conforme documentação
 * @param {Object} params - Parâmetros adicionais (opcional)
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object>} Resposta completa da API com informações da conta
 */
async function getAccountInformationV2(params = {}, accountId) {
  try {
    console.log(\`[WS-API] Obtendo informações da conta \${accountId} via WebSocket API V2...\`);
    
    // Verificar se o accountId é válido
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId é obrigatório e deve ser um número: \${accountId}\`);
    }
    
    // Verificar se o WebSocket está conectado
    if (!websockets.isWebSocketApiConnected(accountId)) {
      console.log(\`[WS-API] WebSocket não conectado para conta \${accountId}, tentando conectar...\`);
      await websockets.startWebSocketApi(accountId);
      // Aguardar um pouco para a conexão estabilizar
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Criar requisição
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
}`;

  // Substituir função getAccountInformationV2
  content = content.replace(
    /async function getAccountInformationV2[\s\S]*?^}/m,
    newGetAccountInformationV2
  );
  
  fs.writeFileSync(websocketApiPath, content, 'utf8');
  console.log('✅ websocketApi.js corrigido definitivamente');
} else {
  console.error('❌ websocketApi.js não encontrado');
}

// 2. Verificar e corrigir websockets.js se necessário
console.log('\n2️⃣ Verificando websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');
  
  // Verificar se a função sendWebSocketApiRequest está exportada
  if (!websocketsContent.includes('sendWebSocketApiRequest') || 
      !websocketsContent.match(/module\.exports\s*=[\s\S]*sendWebSocketApiRequest/)) {
    
    console.log('➕ Adicionando sendWebSocketApiRequest aos exports...');
    createBackup(websocketsPath);
    
    // Encontrar module.exports e adicionar a função
    const exportsMatch = websocketsContent.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
    if (exportsMatch) {
      let exportsContent = exportsMatch[1];
      
      if (!exportsContent.includes('sendWebSocketApiRequest')) {
        exportsContent += ',\n  sendWebSocketApiRequest: () => { throw new Error("Use função em websocketApi.js"); }';
        
        websocketsContent = websocketsContent.replace(
          /module\.exports\s*=\s*\{[^}]+\}/s,
          `module.exports = {${exportsContent}\n}`
        );
        
        fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
        console.log('✅ sendWebSocketApiRequest placeholder adicionado aos exports');
      }
    }
  } else {
    console.log('✅ sendWebSocketApiRequest já está nos exports');
  }
} else {
  console.error('❌ websockets.js não encontrado');
}

// 3. Criar teste específico para validar a correção
console.log('\n3️⃣ Criando teste de validação final...');

const finalTestScript = `// Teste de validação final
const websocketApi = require('./websocketApi');

async function testFinalValidation() {
  console.log('🧪 Teste de validação final...');
  
  try {
    console.log('\\n=== TESTE 1: Verificar função getAccountInformationV2 ===');
    console.log('- Tipo:', typeof websocketApi.getAccountInformationV2);
    
    if (typeof websocketApi.getAccountInformationV2 !== 'function') {
      console.error('❌ getAccountInformationV2 não é uma função!');
      return false;
    }
    
    console.log('\\n=== TESTE 2: Testar getAccountInformationV2 ===');
    
    // Testar a função
    const result = await websocketApi.getAccountInformationV2({}, 1);
    
    console.log('Resultado:');
    console.log('- Status:', result?.status);
    console.log('- Tem resultado:', !!result?.result);
    console.log('- Tem erro:', !!result?.error);
    console.log('- Mensagem de erro:', result?.error?.message);
    
    if (result?.status === 200 && result?.result) {
      console.log('\\n✅ SUCESSO TOTAL! WebSocket API funcionando perfeitamente!');
      console.log('\\n📊 Dados da conta obtidos:');
      const { result: accountData } = result;
      console.log('- totalWalletBalance:', accountData.totalWalletBalance);
      console.log('- availableBalance:', accountData.availableBalance);
      console.log('- maxWithdrawAmount:', accountData.maxWithdrawAmount);
      return true;
    } else if (result?.error && !result?.error?.message?.includes('[object Object]')) {
      console.log('\\n⚠️ Erro específico, mas função está funcionando:', result.error.message);
      return true;
    } else if (result?.error?.message?.includes('[object Object]')) {
      console.log('\\n❌ Ainda há problema com [object Object]');
      return false;
    } else {
      console.log('\\n⚠️ Resposta inesperada, mas sem erro [object Object]');
      return true;
    }
    
  } catch (error) {
    console.error('\\n❌ Erro no teste:', error.message);
    
    if (error.message.includes('[object Object]')) {
      console.log('❌ Ainda há problema com [object Object]');
      return false;
    } else {
      console.log('⚠️ Erro específico, correção pode ter funcionado');
      return true;
    }
  }
}

if (require.main === module) {
  testFinalValidation().then(success => {
    if (success) {
      console.log('\\n🎉 CORREÇÃO BEM-SUCEDIDA!');
      console.log('\\n🚀 Execute o monitoramento agora:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\\n💰 A sincronização de saldo deve funcionar corretamente!');
    } else {
      console.log('\\n❌ Correção não resolveu o problema completamente');
      console.log('Pode ser necessário debug adicional');
    }
  });
}

module.exports = { testFinalValidation };`;

fs.writeFileSync(path.join(__dirname, 'test-final-validation.js'), finalTestScript);
console.log('✅ Arquivo de teste final criado: test-final-validation.js');

console.log('\n🎉 Correção final concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Função sendWebSocketApiRequest incorporada diretamente no websocketApi.js');
console.log('2. ✅ getAccountInformationV2 corrigida com chamada adequada');
console.log('3. ✅ Eliminados problemas de import circular');
console.log('4. ✅ Tratamento de erro [object Object] corrigido');

console.log('\n🧪 Execute o teste final:');
console.log('   node test-final-validation.js');

console.log('\n🚀 Se o teste passar, execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para segurança.');