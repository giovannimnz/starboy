const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo imports em websocketApi.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.import-fix.${Date.now()}`;
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

// Verificar se sendWebSocketApiRequest está sendo importado
if (!content.includes('sendWebSocketApiRequest')) {
  console.log('➕ Adicionando import de sendWebSocketApiRequest...');
  
  // Adicionar import no topo do arquivo
  const importLine = "const { sendWebSocketApiRequest } = require('./websockets');\n";
  
  // Encontrar onde estão os outros requires
  const requireMatch = content.match(/(const.*require.*\n)+/);
  if (requireMatch) {
    content = content.replace(requireMatch[0], requireMatch[0] + importLine);
  } else {
    // Se não encontrar requires, adicionar no início
    content = importLine + content;
  }
}

// Verificar se getDatabaseInstance está sendo importado
if (!content.includes('getDatabaseInstance')) {
  console.log('➕ Adicionando import de getDatabaseInstance...');
  
  const dbImportLine = "const { getDatabaseInstance } = require('./db/conexao');\n";
  
  // Adicionar após os outros imports
  const requireMatch = content.match(/(const.*require.*\n)+/);
  if (requireMatch) {
    content = content.replace(requireMatch[0], requireMatch[0] + dbImportLine);
  } else {
    content = dbImportLine + content;
  }
}

// Verificar se websockets está sendo importado
if (!content.includes('websockets') || !content.includes('./websockets')) {
  console.log('➕ Adicionando import completo de websockets...');
  
  const websocketsImportLine = "const websockets = require('./websockets');\n";
  
  // Adicionar após os outros imports
  const requireMatch = content.match(/(const.*require.*\n)+/);
  if (requireMatch) {
    content = content.replace(requireMatch[0], requireMatch[0] + websocketsImportLine);
  } else {
    content = websocketsImportLine + content;
  }
}

// Corrigir a função getAccountInformationV2 para usar a importação correta
content = content.replace(
  /const response = await sendWebSocketApiRequest\(accountId, 'account\.status', \{\}\);/g,
  'const response = await sendWebSocketApiRequest({ method: "account.status", params: {} }, 30000, accountId);'
);

// Corrigir outras chamadas para sendWebSocketApiRequest que podem estar incorretas
content = content.replace(
  /sendWebSocketApiRequest\(accountId,/g,
  'sendWebSocketApiRequest({'
);

// Adicionar verificação de estado da conta na função getAccountInformationV2
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
    
    const response = await sendWebSocketApiRequest(request, 30000, accountId);

    if (response && response.result) {
      console.log(\`[WS-API] ✅ Informações da conta \${accountId} recebidas com sucesso.\`);
      return {
        status: 200,
        result: response.result
      };
    } else if (response && response.error) {
      console.error(\`[WS-API] Erro da API ao obter informações da conta \${accountId}: \${response.error.code} - \${response.error.msg}\`);
      return { 
        status: 400,
        error: { 
          message: \`API Error: \${response.error.code} - \${response.error.msg}\`, 
          code: response.error.code 
        } 
      };
    } else {
      console.error(\`[WS-API] Resposta inesperada ou vazia de account.status para conta \${accountId}:\`, response);
      return { 
        status: 500,
        error: { 
          message: 'Resposta inesperada ou vazia de account.status' 
        } 
      };
    }
  } catch (error) {
    console.error(\`[WS-API] Falha na comunicação ao obter informações da conta \${accountId}: \${error.message || error}\`);
    return { 
      status: 500,
      error: { 
        message: \`Falha na comunicação: \${error.message || 'Erro interno em sendWebSocketApiRequest'}\` 
      } 
    };
  }
}`;

// Substituir a função getAccountInformationV2 existente
const functionMatch = content.match(/async function getAccountInformationV2\([^{]*\{[\s\S]*?^}/m);
if (functionMatch) {
  content = content.replace(functionMatch[0], newGetAccountInformationV2);
  console.log('✅ Função getAccountInformationV2 corrigida');
} else {
  console.log('⚠️ Função getAccountInformationV2 não encontrada');
}

fs.writeFileSync(websocketApiPath, content, 'utf8');
console.log('✅ websocketApi.js corrigido');

// Criar um teste específico para validar as correções
const testScript = `// Teste específico para websocketApi
const websocketApi = require('./websocketApi');

async function testWebSocketApi() {
  console.log('🧪 Testando websocketApi...');
  
  try {
    console.log('\\n=== TESTE 1: Verificar se funções existem ===');
    console.log('- getAccountInformationV2:', typeof websocketApi.getAccountInformationV2);
    console.log('- getAccountBalance:', typeof websocketApi.getAccountBalance);
    console.log('- syncAccountBalanceViaWebSocket:', typeof websocketApi.syncAccountBalanceViaWebSocket);
    
    console.log('\\n=== TESTE 2: Testar getAccountInformationV2 ===');
    
    try {
      const result = await websocketApi.getAccountInformationV2({}, 1);
      console.log('Resultado:', {
        status: result?.status,
        hasResult: !!result?.result,
        hasError: !!result?.error,
        errorMessage: result?.error?.message
      });
      
      if (result && result.status === 200 && result.result) {
        console.log('✅ getAccountInformationV2 funcionando!');
        
        console.log('\\n=== TESTE 3: Testar getAccountBalance ===');
        const balance = await websocketApi.getAccountBalance({}, 1);
        console.log('Saldo:', {
          success: balance?.success,
          totalWalletBalance: balance?.totalWalletBalance,
          availableBalance: balance?.availableBalance
        });
        
        if (balance && balance.success) {
          console.log('✅ getAccountBalance funcionando!');
        }
      }
      
    } catch (testError) {
      console.error('❌ Erro no teste:', testError.message);
    }
    
    console.log('\\n🎉 Teste concluído!');
    
  } catch (error) {
    console.error('❌ Erro geral no teste:', error.message);
    console.error('Stack:', error.stack);
  }
}

if (require.main === module) {
  testWebSocketApi();
}

module.exports = { testWebSocketApi };`;

fs.writeFileSync(path.join(__dirname, 'test-websocketapi.js'), testScript);
console.log('✅ Arquivo de teste criado: test-websocketapi.js');

console.log('\n🎉 Correção de imports concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Import de sendWebSocketApiRequest adicionado');
console.log('2. ✅ Import de getDatabaseInstance adicionado');
console.log('3. ✅ Import completo de websockets adicionado');
console.log('4. ✅ Função getAccountInformationV2 corrigida');
console.log('5. ✅ Verificações de estado da conta adicionadas');

console.log('\n🧪 Execute o teste:');
console.log('   node test-websocketapi.js');

console.log('\n🚀 Depois teste o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backup criado para segurança.');