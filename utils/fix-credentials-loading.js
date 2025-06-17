const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo carregamento de credenciais e estado da conta...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.credentials-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Corrigir api.js - problema no loadCredentialsFromDatabase
console.log('1️⃣ Corrigindo api.js - loadCredentialsFromDatabase...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Corrigir loadCredentialsFromDatabase completamente
const newLoadCredentialsFromDatabase = `async function loadCredentialsFromDatabase(accountId) {
  console.log(\`[API] Carregando credenciais do banco para conta \${accountId} (chamado de api.js)...\`);
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = \`AccountId deve ser um número válido para carregar credenciais: \${String(accountId)} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  const accountState = getAccountConnectionState(accountId, true); // Garante que o estado exista em api.js
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

  // Atualizar o estado com as credenciais carregadas
  accountState.accountId = accountId;
  accountState.apiKey = creds.api_key;
  accountState.secretKey = creds.api_secret;
  accountState.wsApiKey = creds.ws_api_key;
  accountState.wsApiSecret = creds.ws_api_secret; // Chave privada Ed25519
  accountState.privateKey = creds.ws_api_secret; // Alias para wsApiSecret
  accountState.apiUrl = creds.futures_rest_api_url;
  accountState.wsUrl = creds.futures_ws_market_url; // Para bookTicker, klines, etc.
  accountState.wsApiUrl = creds.futures_ws_api_url; // Para WebSocket API de trading
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
  
  return accountState; // Retorna o estado atualizado
}`;

// Substituir a função loadCredentialsFromDatabase
apiContent = apiContent.replace(
  /async function loadCredentialsFromDatabase\([^{]*\{[\s\S]*?^}/m,
  newLoadCredentialsFromDatabase
);

// Verificar se getAccountConnectionState está retornando o estado corretamente
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
  }
  
  const state = accountConnections.get(accountId) || null;
  
  if (state) {
    console.log(\`[API_STATE] Estado da conta \${accountId} encontrado:\`);
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

// Substituir a função getAccountConnectionState
apiContent = apiContent.replace(
  /function getAccountConnectionState\([^{]*\{[\s\S]*?^}/m,
  improvedGetAccountConnectionState
);

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ api.js corrigido');

// 2. Criar um teste mais específico
console.log('\n2️⃣ Criando teste mais específico...');

const detailedTestScript = `// Teste detalhado do carregamento de credenciais
const api = require('./api');

async function testDetailedCredentials() {
  console.log('🧪 Testando carregamento detalhado de credenciais...');
  
  try {
    console.log('\\n=== TESTE 1: Verificação inicial do estado ===');
    let initialState = api.getAccountConnectionState(1);
    console.log('Estado inicial:', initialState ? 'EXISTE' : 'NÃO EXISTE');
    
    console.log('\\n=== TESTE 2: Carregamento de credenciais ===');
    const credentials = await api.loadCredentialsFromDatabase(1);
    console.log('Credenciais retornadas:', {
      accountId: credentials.accountId,
      apiKey: credentials.apiKey ? 'OK' : 'MISSING',
      secretKey: credentials.secretKey ? 'OK' : 'MISSING',
      wsApiKey: credentials.wsApiKey ? 'OK' : 'MISSING',
      wsApiSecret: credentials.wsApiSecret ? 'OK' : 'MISSING',
      apiUrl: credentials.apiUrl || 'MISSING',
      wsUrl: credentials.wsUrl || 'MISSING',
      wsApiUrl: credentials.wsApiUrl || 'MISSING',
      ambiente: credentials.ambiente || 'MISSING',
      corretora: credentials.corretora || 'MISSING'
    });
    
    console.log('\\n=== TESTE 3: Verificação do estado após carregamento ===');
    const stateAfterLoad = api.getAccountConnectionState(1);
    console.log('Estado após carregamento existe:', !!stateAfterLoad);
    
    if (stateAfterLoad) {
      console.log('Detalhes do estado:');
      console.log('  - accountId:', stateAfterLoad.accountId);
      console.log('  - apiKey:', stateAfterLoad.apiKey ? stateAfterLoad.apiKey.substring(0, 8) + '...' : 'MISSING');
      console.log('  - secretKey:', stateAfterLoad.secretKey ? 'OK' : 'MISSING');
      console.log('  - apiUrl:', stateAfterLoad.apiUrl || 'MISSING');
      console.log('  - wsUrl:', stateAfterLoad.wsUrl || 'MISSING');
      
      if (stateAfterLoad.apiKey && stateAfterLoad.secretKey && stateAfterLoad.apiUrl) {
        console.log('\\n=== TESTE 4: Testando API calls ===');
        
        try {
          console.log('4.1 Testando getPrice...');
          const price = await api.getPrice('BTCUSDT', 1);
          console.log('   ✅ Preço BTCUSDT:', price || 'FALHOU');
        } catch (priceError) {
          console.error('   ❌ Erro no getPrice:', priceError.message);
        }
        
        try {
          console.log('4.2 Testando getAllOpenPositions...');
          const positions = await api.getAllOpenPositions(1);
          console.log('   ✅ Posições encontradas:', positions.length);
        } catch (posError) {
          console.error('   ❌ Erro no getAllOpenPositions:', posError.message);
        }
      } else {
        console.log('❌ Estado incompleto, não é possível testar API calls');
      }
    } else {
      console.log('❌ Estado não foi criado após carregamento de credenciais');
    }
    
    console.log('\\n🎉 Teste detalhado concluído!');
    
  } catch (error) {
    console.error('❌ Erro no teste detalhado:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  testDetailedCredentials();
}

module.exports = { testDetailedCredentials };`;

fs.writeFileSync(path.join(__dirname, 'test-detailed-credentials.js'), detailedTestScript);
console.log('✅ Arquivo de teste detalhado criado: test-detailed-credentials.js');

// 3. Verificar se a tabela corretoras tem os dados necessários
console.log('\n3️⃣ Criando script para verificar tabela corretoras...');

const checkCorretorasScript = `// Script para verificar e corrigir tabela corretoras
const { getDatabaseInstance } = require('./db/conexao');

async function checkCorretoras() {
  console.log('🔍 Verificando tabela corretoras...');
  
  try {
    const db = await getDatabaseInstance();
    
    console.log('\\n=== VERIFICANDO CORRETORA ID 1 ===');
    const [corretoras] = await db.query('SELECT * FROM corretoras WHERE id = 1');
    
    if (corretoras.length === 0) {
      console.log('❌ Corretora ID 1 não encontrada!');
      
      console.log('\\n🔧 Criando corretora padrão...');
      await db.query(\`
        INSERT INTO corretoras (id, corretora, ambiente, futures_rest_api_url, futures_ws_market_url, futures_ws_api_url)
        VALUES (1, 'binance', 'prd', 'https://fapi.binance.com/fapi', 'wss://fstream.binance.com', 'wss://ws-fapi.binance.com/ws-fapi/v1')
        ON DUPLICATE KEY UPDATE
        corretora = VALUES(corretora),
        ambiente = VALUES(ambiente),
        futures_rest_api_url = VALUES(futures_rest_api_url),
        futures_ws_market_url = VALUES(futures_ws_market_url),
        futures_ws_api_url = VALUES(futures_ws_api_url)
      \`);
      
      console.log('✅ Corretora criada/atualizada com sucesso!');
    } else {
      const corretora = corretoras[0];
      console.log('✅ Corretora ID 1 encontrada:');
      console.log('  - Nome:', corretora.corretora);
      console.log('  - Ambiente:', corretora.ambiente);
      console.log('  - REST API URL:', corretora.futures_rest_api_url);
      console.log('  - WS Market URL:', corretora.futures_ws_market_url);
      console.log('  - WS API URL:', corretora.futures_ws_api_url);
      
      // Verificar se URLs estão corretas para o ambiente
      const isProduction = corretora.ambiente === 'prd';
      const hasTestnetUrls = corretora.futures_rest_api_url?.includes('testnet') || 
                            corretora.futures_ws_api_url?.includes('testnet') ||
                            corretora.futures_ws_market_url?.includes('testnet');
      
      if (isProduction && hasTestnetUrls) {
        console.log('⚠️ PROBLEMA: Ambiente de produção usando URLs de testnet!');
        console.log('🔧 Corrigindo URLs...');
        
        await db.query(\`
          UPDATE corretoras 
          SET futures_rest_api_url = 'https://fapi.binance.com/fapi',
              futures_ws_market_url = 'wss://fstream.binance.com',
              futures_ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi/v1'
          WHERE id = 1
        \`);
        
        console.log('✅ URLs corrigidas para produção!');
      } else if (!isProduction && !hasTestnetUrls) {
        console.log('⚠️ PROBLEMA: Ambiente de testnet usando URLs de produção!');
        console.log('🔧 Corrigindo URLs...');
        
        await db.query(\`
          UPDATE corretoras 
          SET futures_rest_api_url = 'https://testnet.binancefuture.com/fapi',
              futures_ws_market_url = 'wss://stream.binancefuture.com',
              futures_ws_api_url = 'wss://testnet.binancefuture.com/ws-fapi/v1'
          WHERE id = 1
        \`);
        
        console.log('✅ URLs corrigidas para testnet!');
      } else {
        console.log('✅ URLs estão corretas para o ambiente');
      }
    }
    
    console.log('\\n=== VERIFICANDO CONTA ID 1 ===');
    const [contas] = await db.query(\`
      SELECT c.id, c.nome, c.id_corretora, c.ativa,
             c.api_key IS NOT NULL as has_api_key,
             c.api_secret IS NOT NULL as has_api_secret,
             c.ws_api_key IS NOT NULL as has_ws_api_key,
             c.ws_api_secret IS NOT NULL as has_ws_api_secret
      FROM contas c 
      WHERE c.id = 1
    \`);
    
    if (contas.length === 0) {
      console.log('❌ Conta ID 1 não encontrada!');
    } else {
      const conta = contas[0];
      console.log('✅ Conta ID 1 encontrada:');
      console.log('  - Nome:', conta.nome);
      console.log('  - ID Corretora:', conta.id_corretora);
      console.log('  - Ativa:', conta.ativa);
      console.log('  - API Key:', conta.has_api_key ? 'PRESENTE' : 'AUSENTE');
      console.log('  - API Secret:', conta.has_api_secret ? 'PRESENTE' : 'AUSENTE');
      console.log('  - WS API Key:', conta.has_ws_api_key ? 'PRESENTE' : 'AUSENTE');
      console.log('  - WS API Secret:', conta.has_ws_api_secret ? 'PRESENTE' : 'AUSENTE');
    }
    
    console.log('\\n🎉 Verificação concluída!');
    
  } catch (error) {
    console.error('❌ Erro na verificação:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  checkCorretoras();
}

module.exports = { checkCorretoras };`;

fs.writeFileSync(path.join(__dirname, 'check-corretoras.js'), checkCorretorasScript);
console.log('✅ Arquivo de verificação criado: check-corretoras.js');

console.log('\n🎉 Correção de credenciais concluída!');
console.log('\n📋 Resumo das correções:');
console.log('1. ✅ api.js - Melhorado loadCredentialsFromDatabase com logs detalhados');
console.log('2. ✅ api.js - Melhorado getAccountConnectionState com logs de debug');
console.log('3. ✅ Criado teste detalhado de credenciais');
console.log('4. ✅ Criado verificador da tabela corretoras');

console.log('\n🧪 Execute os testes na ordem:');
console.log('1. node check-corretoras.js     (verificar/corrigir tabela corretoras)');
console.log('2. node test-detailed-credentials.js  (teste detalhado)');
console.log('3. node posicoes/monitoramento.js --account 1  (teste final)');

console.log('\n💾 Backups criados para todos os arquivos alterados.');