const fs = require('fs');
const path = require('path');

console.log('🔧 Correção final do carregamento de credenciais...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.final-credentials.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// Corrigir api.js - problema específico no loadCredentialsFromDatabase
console.log('1️⃣ Corrigindo api.js - loadCredentialsFromDatabase...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Substituir a função loadCredentialsFromDatabase completamente
const newLoadCredentialsFromDatabase = `async function loadCredentialsFromDatabase(accountId) {
  console.log(\`[API] Carregando credenciais do banco para conta \${accountId} (chamado de api.js)...\`);
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = \`AccountId deve ser um número válido para carregar credenciais: \${String(accountId)} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  // CORREÇÃO CRÍTICA: Criar estado ANTES de fazer a query
  const accountState = getAccountConnectionState(accountId, true);
  const db = await getDatabaseInstance(accountId);

  console.log(\`[API] Executando query para carregar credenciais da conta \${accountId}...\`);
  
  const [rows] = await db.query(
    \`SELECT c.id, c.nome, c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, 
            co.ambiente, co.corretora, co.futures_rest_api_url, co.futures_ws_market_url, co.futures_ws_api_url
     FROM contas c
     JOIN corretoras co ON c.id_corretora = co.id
     WHERE c.id = ? AND c.ativa = 1\`,
    [accountId]
  );

  console.log(\`[API] Query executada, linhas retornadas: \${rows.length}\`);
  
  if (rows.length === 0) {
    throw new Error(\`Conta \${accountId} não encontrada, inativa ou sem corretora associada.\`);
  }
  
  const creds = rows[0];
  console.log(\`[API] Dados brutos da query:\`, {
    id: creds.id,
    nome: creds.nome,
    api_key: creds.api_key ? creds.api_key.substring(0, 8) + '...' : 'NULL',
    api_secret: creds.api_secret ? 'PRESENTE' : 'NULL',
    ws_api_key: creds.ws_api_key ? creds.ws_api_key.substring(0, 8) + '...' : 'NULL',
    ws_api_secret: creds.ws_api_secret ? 'PRESENTE' : 'NULL',
    futures_rest_api_url: creds.futures_rest_api_url,
    futures_ws_market_url: creds.futures_ws_market_url,
    futures_ws_api_url: creds.futures_ws_api_url,
    ambiente: creds.ambiente,
    corretora: creds.corretora
  });

  // CORREÇÃO CRÍTICA: Atualizar o estado com as credenciais carregadas
  accountState.accountId = accountId;
  accountState.apiKey = creds.api_key;
  accountState.secretKey = creds.api_secret;
  accountState.wsApiKey = creds.ws_api_key;
  accountState.wsApiSecret = creds.ws_api_secret;
  accountState.privateKey = creds.ws_api_secret; // Alias para wsApiSecret
  accountState.apiUrl = creds.futures_rest_api_url;
  accountState.wsUrl = creds.futures_ws_market_url;
  accountState.wsApiUrl = creds.futures_ws_api_url;
  accountState.ambiente = creds.ambiente;
  accountState.corretora = creds.corretora;
  accountState.nomeConta = creds.nome;

  console.log(\`[API] ✅ Credenciais carregadas e estado atualizado em api.js para conta \${accountId}\`);
  console.log(\`[API] Estado atualizado:\`);
  console.log(\`  - accountId: \${accountState.accountId}\`);
  console.log(\`  - apiKey: \${accountState.apiKey ? accountState.apiKey.substring(0, 8) + '...' : 'MISSING'}\`);
  console.log(\`  - secretKey: \${accountState.secretKey ? 'OK' : 'MISSING'}\`);
  console.log(\`  - wsApiKey: \${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'MISSING'}\`);
  console.log(\`  - wsApiSecret: \${accountState.wsApiSecret ? 'OK' : 'MISSING'}\`);
  console.log(\`  - apiUrl: \${accountState.apiUrl || 'MISSING'}\`);
  console.log(\`  - wsUrl: \${accountState.wsUrl || 'MISSING'}\`);
  console.log(\`  - wsApiUrl: \${accountState.wsApiUrl || 'MISSING'}\`);
  console.log(\`  - ambiente: \${accountState.ambiente || 'MISSING'}\`);
  console.log(\`  - corretora: \${accountState.corretora || 'MISSING'}\`);
  
  // CORREÇÃO CRÍTICA: Retornar o estado atualizado, não só as credenciais
  return accountState;
}`;

// Encontrar e substituir a função loadCredentialsFromDatabase
const functionMatch = apiContent.match(/async function loadCredentialsFromDatabase\([^{]*\{[\s\S]*?^}/m);
if (functionMatch) {
  apiContent = apiContent.replace(functionMatch[0], newLoadCredentialsFromDatabase);
  console.log('✅ Função loadCredentialsFromDatabase substituída');
} else {
  console.log('❌ Função loadCredentialsFromDatabase não encontrada para substituição');
}

// Verificar se getAccountConnectionState está implementado corretamente
const improvedGetAccountConnectionState = `function getAccountConnectionState(accountId, createIfMissing = false) {
  if (!accountId || typeof accountId !== 'number') {
    console.warn(\`[API_STATE] AccountId inválido em getAccountConnectionState: \${accountId} (tipo: \${typeof accountId})\`);
    return null;
  }

  if (!accountConnections.has(accountId) && createIfMissing) {
    console.log(\`[API_STATE] Criando novo estado para conta \${accountId} em api.js\`);
    accountConnections.set(accountId, {
      accountId: accountId,
      apiKey: null,
      secretKey: null,
      wsApiKey: null,
      wsApiSecret: null,
      privateKey: null,
      apiUrl: null,
      wsUrl: null,
      wsApiUrl: null,
      isAuthenticated: false,
      wsApiAuthenticated: false,
      wsApiConnection: null,
      wsApiRequestCallbacks: new Map(),
      wsApiKeepAliveInterval: null,
      lastWsApiActivity: 0,
      userDataStream: null,
      listenKey: null,
      userDataKeepAliveInterval: null,
      lastUserDataStreamKeepAlive: 0,
      priceWebsockets: new Map(),
      monitoringCallbacks: null,
      isShuttingDown: false,
      dbInstance: null,
      lastPongTime: 0,
      pingInterval: null,
      ambiente: null,
      corretora: null,
      nomeConta: null,
    });
    console.log(\`[API_STATE] ✅ Estado criado para conta \${accountId}\`);
  }
  
  const state = accountConnections.get(accountId) || null;
  
  if (state) {
    console.log(\`[API_STATE] Estado da conta \${accountId} encontrado:\`);
    console.log(\`  - accountId: \${state.accountId}\`);
    console.log(\`  - API Key: \${state.apiKey ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - Secret Key: \${state.secretKey ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - WS API Key: \${state.wsApiKey ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - Private Key: \${state.wsApiSecret ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - API URL: \${state.apiUrl || 'NÃO ENCONTRADA'}\`);
    console.log(\`  - WS URL: \${state.wsUrl || 'NÃO ENCONTRADA'}\`);
  } else {
    console.log(\`[API_STATE] Estado da conta \${accountId} NÃO encontrado\`);
  }
  
  return state;
}`;

// Substituir getAccountConnectionState se necessário
const stateMatch = apiContent.match(/function getAccountConnectionState\([^{]*\{[\s\S]*?^}/m);
if (stateMatch) {
  apiContent = apiContent.replace(stateMatch[0], improvedGetAccountConnectionState);
  console.log('✅ Função getAccountConnectionState melhorada');
}

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ api.js corrigido');

// Criar um teste final para verificar se tudo está funcionando
console.log('\n2️⃣ Criando teste final...');

const finalTestScript = `// Teste final do sistema corrigido
const api = require('./api');

async function testFinalSystem() {
  console.log('🧪 Teste final do sistema corrigido...');
  
  try {
    console.log('\\n=== TESTE 1: Estado inicial ===');
    const initialState = api.getAccountConnectionState(1);
    console.log('Estado inicial existe:', !!initialState);
    
    console.log('\\n=== TESTE 2: Carregamento de credenciais ===');
    const result = await api.loadCredentialsFromDatabase(1);
    
    console.log('\\nResultado do carregamento:');
    console.log('- Tipo do resultado:', typeof result);
    console.log('- accountId:', result?.accountId);
    console.log('- apiKey:', result?.apiKey ? 'OK' : 'MISSING');
    console.log('- secretKey:', result?.secretKey ? 'OK' : 'MISSING');
    console.log('- apiUrl:', result?.apiUrl || 'MISSING');
    console.log('- wsUrl:', result?.wsUrl || 'MISSING');
    
    console.log('\\n=== TESTE 3: Verificação do estado após carregamento ===');
    const stateAfterLoad = api.getAccountConnectionState(1);
    console.log('Estado existe após carregamento:', !!stateAfterLoad);
    
    if (stateAfterLoad && stateAfterLoad.apiKey && stateAfterLoad.apiUrl) {
      console.log('\\n=== TESTE 4: Testando funções da API ===');
      
      try {
        console.log('4.1 Testando getPrice...');
        const price = await api.getPrice('BTCUSDT', 1);
        console.log('   ✅ Preço BTCUSDT:', price);
        
        if (price && price > 0) {
          console.log('4.2 Testando getAllOpenPositions...');
          const positions = await api.getAllOpenPositions(1);
          console.log('   ✅ Posições encontradas:', positions.length);
          
          console.log('\\n🎉 TODOS OS TESTES PASSARAM!');
          console.log('✅ Sistema está funcionando corretamente');
        } else {
          console.log('⚠️ getPrice não retornou valor válido');
        }
      } catch (apiError) {
        console.error('❌ Erro nos testes de API:', apiError.message);
      }
    } else {
      console.log('❌ Estado incompleto após carregamento');
      console.log('Estado atual:', {
        exists: !!stateAfterLoad,
        hasApiKey: !!stateAfterLoad?.apiKey,
        hasApiUrl: !!stateAfterLoad?.apiUrl
      });
    }
    
  } catch (error) {
    console.error('❌ Erro no teste final:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testFinalSystem();
}

module.exports = { testFinalSystem };`;

fs.writeFileSync(path.join(__dirname, 'test-final-system.js'), finalTestScript);
console.log('✅ Arquivo de teste final criado: test-final-system.js');

console.log('\n🎉 Correção final concluída!');
console.log('\n📋 Principais correções aplicadas:');
console.log('1. ✅ Estado da conta é criado ANTES da query');
console.log('2. ✅ accountId é definido corretamente no estado');
console.log('3. ✅ Função retorna o estado atualizado, não só credenciais');
console.log('4. ✅ Logs detalhados para debug');

console.log('\n🧪 Execute o teste final:');
console.log('   node test-final-system.js');

console.log('\n🚀 Se o teste passar, execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backup criado para segurança.');