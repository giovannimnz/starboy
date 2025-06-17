const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo criação de estado da conta...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.state-creation.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// Corrigir api.js completamente
console.log('1️⃣ Corrigindo api.js completamente...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Verificar se o accountConnections Map existe
if (!apiContent.includes('const accountConnections = new Map()')) {
  console.log('➕ Adicionando Map de conexões...');
  // Adicionar após os requires
  apiContent = apiContent.replace(
    /(const.*require.*\n)+/,
    `$&\n// Mapa para armazenar estados das conexões de cada conta\nconst accountConnections = new Map();\n`
  );
}

// Função getAccountConnectionState corrigida
const correctGetAccountConnectionState = `function getAccountConnectionState(accountId, createIfMissing = false) {
  console.log(\`[API_STATE] getAccountConnectionState chamado: accountId=\${accountId}, createIfMissing=\${createIfMissing}\`);
  
  if (!accountId || typeof accountId !== 'number') {
    console.warn(\`[API_STATE] AccountId inválido: \${accountId} (tipo: \${typeof accountId})\`);
    return null;
  }

  // Verificar se já existe
  let state = accountConnections.get(accountId);
  console.log(\`[API_STATE] Estado existente para conta \${accountId}: \${state ? 'SIM' : 'NÃO'}\`);

  if (!state && createIfMissing) {
    console.log(\`[API_STATE] Criando novo estado para conta \${accountId}...\`);
    state = {
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
    };
    
    accountConnections.set(accountId, state);
    console.log(\`[API_STATE] ✅ Estado criado e armazenado para conta \${accountId}\`);
    console.log(\`[API_STATE] Total de contas no Map: \${accountConnections.size}\`);
  }
  
  // Verificar novamente se existe
  const finalState = accountConnections.get(accountId);
  console.log(\`[API_STATE] Estado final para conta \${accountId}: \${finalState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  
  return finalState || null;
}`;

// Substituir getAccountConnectionState
const stateMatch = apiContent.match(/function getAccountConnectionState\([^{]*\{[\s\S]*?^}/m);
if (stateMatch) {
  apiContent = apiContent.replace(stateMatch[0], correctGetAccountConnectionState);
  console.log('✅ getAccountConnectionState substituído');
} else {
  console.log('➕ Adicionando getAccountConnectionState...');
  // Adicionar antes do module.exports
  apiContent = apiContent.replace(
    /module\.exports\s*=/,
    `${correctGetAccountConnectionState}\n\nmodule.exports =`
  );
}

// Função loadCredentialsFromDatabase corrigida
const correctLoadCredentialsFromDatabase = `async function loadCredentialsFromDatabase(accountId) {
  console.log(\`[API] === INÍCIO loadCredentialsFromDatabase para conta \${accountId} ===\`);
  
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = \`AccountId deve ser um número válido: \${String(accountId)} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  // PASSO 1: Garantir que o estado existe
  console.log(\`[API] PASSO 1: Criando/obtendo estado para conta \${accountId}...\`);
  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState) {
    console.error(\`[API] ERRO: Não foi possível criar estado para conta \${accountId}\`);
    throw new Error(\`Não foi possível criar estado para conta \${accountId}\`);
  }
  
  console.log(\`[API] ✅ Estado obtido para conta \${accountId}\`);

  // PASSO 2: Obter conexão com banco
  console.log(\`[API] PASSO 2: Obtendo conexão com banco...\`);
  const db = await getDatabaseInstance(accountId);

  // PASSO 3: Executar query
  console.log(\`[API] PASSO 3: Executando query para carregar credenciais...\`);
  
  const [rows] = await db.query(
    \`SELECT c.id, c.nome, c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, 
            co.ambiente, co.corretora, co.futures_rest_api_url, co.futures_ws_market_url, co.futures_ws_api_url
     FROM contas c
     JOIN corretoras co ON c.id_corretora = co.id
     WHERE c.id = ? AND c.ativa = 1\`,
    [accountId]
  );

  console.log(\`[API] Query executada, \${rows.length} linha(s) retornada(s)\`);
  
  if (rows.length === 0) {
    throw new Error(\`Conta \${accountId} não encontrada, inativa ou sem corretora associada.\`);
  }
  
  const creds = rows[0];
  console.log(\`[API] Dados obtidos do banco:\`, {
    id: creds.id,
    nome: creds.nome,
    has_api_key: !!creds.api_key,
    has_api_secret: !!creds.api_secret,
    has_ws_api_key: !!creds.ws_api_key,
    has_ws_api_secret: !!creds.ws_api_secret,
    futures_rest_api_url: creds.futures_rest_api_url,
    futures_ws_market_url: creds.futures_ws_market_url,
    futures_ws_api_url: creds.futures_ws_api_url,
    ambiente: creds.ambiente,
    corretora: creds.corretora
  });

  // PASSO 4: Atualizar estado
  console.log(\`[API] PASSO 4: Atualizando estado com credenciais...\`);
  
  accountState.accountId = accountId;
  accountState.apiKey = creds.api_key;
  accountState.secretKey = creds.api_secret;
  accountState.wsApiKey = creds.ws_api_key;
  accountState.wsApiSecret = creds.ws_api_secret;
  accountState.privateKey = creds.ws_api_secret;
  accountState.apiUrl = creds.futures_rest_api_url;
  accountState.wsUrl = creds.futures_ws_market_url;
  accountState.wsApiUrl = creds.futures_ws_api_url;
  accountState.ambiente = creds.ambiente;
  accountState.corretora = creds.corretora;
  accountState.nomeConta = creds.nome;

  console.log(\`[API] PASSO 5: Verificando estado final...\`);
  console.log(\`[API] Estado final da conta \${accountId}:\`);
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
  
  // PASSO 6: Verificar se o estado foi salvo no Map
  const verifyState = accountConnections.get(accountId);
  console.log(\`[API] Verificação final: Estado existe no Map: \${verifyState ? 'SIM' : 'NÃO'}\`);
  
  if (verifyState) {
    console.log(\`[API] ✅ Estado verificado no Map para conta \${accountId}\`);
  } else {
    console.error(\`[API] ❌ ERRO: Estado não encontrado no Map após criação!\`);
  }
  
  console.log(\`[API] === FIM loadCredentialsFromDatabase para conta \${accountId} ===\`);
  return accountState;
}`;

// Substituir loadCredentialsFromDatabase
const loadMatch = apiContent.match(/async function loadCredentialsFromDatabase\([^{]*\{[\s\S]*?^}/m);
if (loadMatch) {
  apiContent = apiContent.replace(loadMatch[0], correctLoadCredentialsFromDatabase);
  console.log('✅ loadCredentialsFromDatabase substituído');
} else {
  console.log('➕ Adicionando loadCredentialsFromDatabase...');
  apiContent = apiContent.replace(
    /function getAccountConnectionState/,
    `${correctLoadCredentialsFromDatabase}\n\nfunction getAccountConnectionState`
  );
}

// Adicionar função getAllAccountConnections se não existir
if (!apiContent.includes('function getAllAccountConnections()')) {
  console.log('➕ Adicionando getAllAccountConnections...');
  const getAllAccountConnections = `
function getAllAccountConnections() {
  console.log(\`[API] getAllAccountConnections chamado. Total de contas: \${accountConnections.size}\`);
  return accountConnections;
}`;
  
  apiContent = apiContent.replace(
    /module\.exports\s*=/,
    `${getAllAccountConnections}\n\nmodule.exports =`
  );
}

// Verificar e corrigir exports
if (!apiContent.includes('getAccountConnectionState') || !apiContent.includes('getAllAccountConnections')) {
  console.log('➕ Corrigindo module.exports...');
  
  // Encontrar o module.exports e adicionar as funções se não estiverem
  const exportsMatch = apiContent.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
  if (exportsMatch) {
    let exportsContent = exportsMatch[1];
    
    if (!exportsContent.includes('getAccountConnectionState')) {
      exportsContent += ',\n  getAccountConnectionState';
    }
    
    if (!exportsContent.includes('getAllAccountConnections')) {
      exportsContent += ',\n  getAllAccountConnections';
    }
    
    if (!exportsContent.includes('loadCredentialsFromDatabase')) {
      exportsContent += ',\n  loadCredentialsFromDatabase';
    }
    
    apiContent = apiContent.replace(
      /module\.exports\s*=\s*\{[^}]+\}/s,
      `module.exports = {${exportsContent}\n}`
    );
  }
}

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ api.js corrigido completamente');

// Criar teste específico para debug
console.log('\n2️⃣ Criando teste de debug...');

const debugTestScript = `// Teste de debug específico
const api = require('./api');

async function debugTest() {
  console.log('🔍 Teste de debug específico...');
  
  try {
    console.log('\\n=== DEBUG 1: Verificar se funções existem ===');
    console.log('- getAccountConnectionState:', typeof api.getAccountConnectionState);
    console.log('- loadCredentialsFromDatabase:', typeof api.loadCredentialsFromDatabase);
    console.log('- getAllAccountConnections:', typeof api.getAllAccountConnections);
    
    console.log('\\n=== DEBUG 2: Chamar getAccountConnectionState diretamente ===');
    const state1 = api.getAccountConnectionState(1, true);
    console.log('Estado criado:', !!state1);
    console.log('accountId no estado:', state1?.accountId);
    
    console.log('\\n=== DEBUG 3: Verificar Map de conexões ===');
    const allConnections = api.getAllAccountConnections();
    console.log('Tamanho do Map:', allConnections.size);
    console.log('Tem conta 1:', allConnections.has(1));
    
    console.log('\\n=== DEBUG 4: Carregar credenciais ===');
    const result = await api.loadCredentialsFromDatabase(1);
    console.log('Resultado:', {
      type: typeof result,
      accountId: result?.accountId,
      hasApiKey: !!result?.apiKey,
      hasApiUrl: !!result?.apiUrl
    });
    
    console.log('\\n=== DEBUG 5: Verificar estado final ===');
    const finalState = api.getAccountConnectionState(1);
    console.log('Estado final existe:', !!finalState);
    if (finalState) {
      console.log('Estado final:', {
        accountId: finalState.accountId,
        hasApiKey: !!finalState.apiKey,
        hasApiUrl: !!finalState.apiUrl,
        apiUrl: finalState.apiUrl
      });
    }
    
    console.log('\\n🎉 Debug concluído!');
    
  } catch (error) {
    console.error('❌ Erro no debug:', error.message);
    console.error('Stack:', error.stack);
  }
}

if (require.main === module) {
  debugTest();
}

module.exports = { debugTest };`;

fs.writeFileSync(path.join(__dirname, 'debug-test.js'), debugTestScript);
console.log('✅ Arquivo de debug criado: debug-test.js');

console.log('\n🎉 Correção de estado concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Map accountConnections garantido');
console.log('2. ✅ getAccountConnectionState com logs detalhados');
console.log('3. ✅ loadCredentialsFromDatabase com verificações passo a passo');
console.log('4. ✅ Exports corrigidos');
console.log('5. ✅ Criado teste de debug específico');

console.log('\n🧪 Execute o teste de debug:');
console.log('   node debug-test.js');

console.log('\n🚀 Se o debug passar, teste o sistema final:');
console.log('   node test-final-system.js');

console.log('\n💾 Backup criado para segurança.');