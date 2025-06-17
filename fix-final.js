const fs = require('fs');
const path = require('path');

console.log('🔧 Aplicando correção final para websockets.getAccountConnectionState...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.final.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
}

// 1. Corrigir api.js - adicionar e exportar getAccountConnectionState
console.log('1️⃣ Corrigindo api.js para incluir getAccountConnectionState...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Adicionar o Map e a função se não existirem
if (!apiContent.includes('const accountConnections = new Map()')) {
  const apiAdditions = `
// >>> INÍCIO: Estado da conexão centralizado em api.js <<<
const accountConnections = new Map();

/**
 * Retorna ou cria o estado da conexão para uma conta.
 * @param {number} accountId - ID da conta.
 * @param {boolean} createIfMissing - Criar se não existir.
 * @returns {Object|null} O estado da conta ou null.
 */
function getAccountConnectionState(accountId, createIfMissing = false) {
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[API_STATE] AccountId inválido fornecido para getAccountConnectionState: \${accountId}\`);
    return null;
  }
  if (!accountConnections.has(accountId) && createIfMissing) {
    console.log(\`[API_STATE] Criando novo estado para conta \${accountId} em api.js\`);
    accountConnections.set(accountId, {
      accountId: accountId,
      apiKey: null,
      secretKey: null,
      wsApiKey: null,
      wsApiSecret: null, // Chave privada Ed25519
      privateKey: null, // Alias para wsApiSecret
      apiUrl: null,
      wsUrl: null,
      wsApiUrl: null,
      isAuthenticated: false, // Para REST API
      wsApiAuthenticated: false, // Para WebSocket API
      wsApiConnection: null, // Instância da conexão WebSocket API
      wsApiRequestCallbacks: new Map(),
      wsApiKeepAliveInterval: null,
      lastWsApiActivity: 0,
      userDataStream: null, // Instância da conexão UserDataStream
      listenKey: null,
      userDataKeepAliveInterval: null,
      lastUserDataStreamKeepAlive: 0,
      priceWebsockets: new Map(), // Map<symbol, WebSocket>
      monitoringCallbacks: null, // Callbacks definidos por monitoramento.js
      isShuttingDown: false,
      dbInstance: null,
      lastPongTime: 0,
      pingInterval: null,
      // Adicionar outros campos conforme necessário
      ambiente: null,
      corretora: null,
      nomeConta: null,
    });
  }
  return accountConnections.get(accountId) || null;
}

/**
 * Obtém todas as conexões de contas (para compatibilidade)
 * @returns {Map} Mapa de conexões
 */
function getAllAccountConnections() {
  return accountConnections;
}
// >>> FIM: Estado da conexão centralizado em api.js <<<

`;

  // Inserir após os requires
  apiContent = apiContent.replace(
    /(const crypto = require\("crypto"\);)/,
    `$1\n${apiAdditions}`
  );
}

// Atualizar loadCredentialsFromDatabase para usar o estado centralizado
apiContent = apiContent.replace(
  /async function loadCredentialsFromDatabase\(accountId\) \{[\s\S]*?return accountState;[\s\S]*?\}/,
  `async function loadCredentialsFromDatabase(accountId) {
  console.log(\`[API] Carregando credenciais do banco para conta \${accountId} (chamado de api.js)...\`);
  if (typeof accountId !== 'number' || isNaN(accountId)) {
    const errorMsg = \`AccountId deve ser um número válido para carregar credenciais: \${String(accountId)} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  const accountState = getAccountConnectionState(accountId, true); // Garante que o estado exista em api.js
  const db = await getDatabaseInstance(accountId);

  const [rows] = await db.query(
    \`SELECT c.api_key, c.api_secret, c.ws_api_key, c.ws_api_secret, c.nome as nome_conta,
            co.ambiente, co.corretora, co.futures_rest_api_url, co.futures_ws_market_url, co.futures_ws_api_url
     FROM contas c
     JOIN corretoras co ON c.id_corretora = co.id
     WHERE c.id = ? AND c.ativa = 1\`,
    [accountId]
  );

  if (rows.length === 0) {
    throw new Error(\`Conta \${accountId} não encontrada, inativa ou sem corretora associada.\`);
  }
  const creds = rows[0];

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
  accountState.nomeConta = creds.nome_conta;

  console.log(\`[API] Credenciais carregadas e estado atualizado em api.js para conta \${accountId}\`);
  return accountState; // Retorna o estado atualizado
}`
);

// Adicionar funções getListenKey e keepAliveListenKey se não existirem
if (!apiContent.includes('async function getListenKey(accountId)')) {
  const listenKeyFunctions = `
/**
 * Obtém um listenKey da Binance Futures API.
 * @param {number} accountId - ID da conta.
 * @returns {Promise<string|null>} O listenKey ou null em caso de erro.
 */
async function getListenKey(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.apiUrl) {
    console.error(\`[API] API Key ou API URL não configuradas para getListenKey da conta \${accountId}.\`);
    const creds = await loadCredentialsFromDatabase(accountId);
    if (!creds || !accountState.apiKey || !accountState.apiUrl) {
        throw new Error(\`Credenciais REST incompletas para getListenKey da conta \${accountId}.\`);
    }
  }
  
  const endpoint = '/fapi/v1/listenKey';
  const url = \`\${accountState.apiUrl}\${endpoint}\`;
  console.log(\`[API] Obtendo listenKey via: \${url} para conta \${accountId}\`);

  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', endpoint, {});
    if (response && response.listenKey) {
      return response.listenKey;
    } else {
      console.error(\`[API] Falha ao obter ListenKey para conta \${accountId}. Resposta:\`, response);
      return null;
    }
  } catch (error) {
    console.error(\`[API] Erro ao fazer requisição para obter ListenKey para conta \${accountId}: \${error.message}\`);
    return null;
  }
}

/**
 * Mantém o listenKey ativo (keep-alive).
 * @param {number} accountId - ID da conta.
 * @param {string} listenKeyToKeepAlive - O listenKey a ser mantido ativo.
 * @returns {Promise<boolean>} True se bem-sucedido, false caso contrário.
 */
async function keepAliveListenKey(accountId, listenKeyToKeepAlive) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.apiUrl) {
    console.error(\`[API] API Key ou API URL não configuradas para keepAliveListenKey da conta \${accountId}.\`);
    const creds = await loadCredentialsFromDatabase(accountId);
    if (!creds || !accountState.apiKey || !accountState.apiUrl) {
        throw new Error(\`Credenciais REST incompletas para keepAliveListenKey da conta \${accountId}.\`);
    }
  }

  const endpoint = '/fapi/v1/listenKey';
  const url = \`\${accountState.apiUrl}\${endpoint}\`;

  try {
    const response = await makeAuthenticatedRequest(accountId, 'PUT', endpoint, { listenKey: listenKeyToKeepAlive });
    if (response && typeof response === 'object' && Object.keys(response).length === 0) {
      return true;
    } else {
      console.error(\`[API] Falha ao manter ListenKey ativo para conta \${accountId}. Resposta:\`, response);
      return false;
    }
  } catch (error) {
    console.error(\`[API] Erro ao fazer requisição para manter ListenKey ativo para conta \${accountId}: \${error.message}\`);
    return false;
  }
}
`;

  // Inserir antes do module.exports
  apiContent = apiContent.replace(
    /module\.exports = \{/,
    `${listenKeyFunctions}\nmodule.exports = {`
  );
}

// Atualizar o module.exports para incluir as novas funções
apiContent = apiContent.replace(
  /module\.exports = \{[^}]*\}/s,
  `module.exports = {
  getPrice,
  getAccountInfo,
  getAllOpenPositions,
  getSymbolInfo,
  getPrecision,
  changeInitialLeverage,
  changeMarginType,
  createOrder,
  cancelOrder,
  getListenKey,
  keepAliveListenKey,
  getCurrentLeverage,
  verifyAndFixEnvironmentConsistency,
  loadCredentialsFromDatabase,
  makeAuthenticatedRequest,
  getAccountConnectionState,
  getAllAccountConnections
}`
);

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ api.js atualizado com getAccountConnectionState');

// 2. Atualizar websockets.js para NÃO exportar getAccountConnectionState (usar o de api.js)
console.log('\n2️⃣ Atualizando websockets.js para usar getAccountConnectionState de api.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');
createBackup(websocketsPath);

let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');

// Remover getAccountConnectionState das exportações se existir
websocketsContent = websocketsContent.replace(/,\s*getAccountConnectionState[^,}]*/g, '');
websocketsContent = websocketsContent.replace(/getAccountConnectionState[^,}]*,\s*/g, '');

fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
console.log('✅ websockets.js atualizado');

// 3. Verificar se signalProcessor.js tem formatErrorMessage
console.log('\n3️⃣ Verificando signalProcessor.js...');
const signalProcessorPath = path.join(__dirname, 'posicoes', 'signalProcessor.js');

if (fs.existsSync(signalProcessorPath)) {
  let signalContent = fs.readFileSync(signalProcessorPath, 'utf8');
  
  if (!signalContent.includes('function formatErrorMessage')) {
    createBackup(signalProcessorPath);
    
    const formatErrorFunction = `
// Função utilitária simples para formatar mensagens de erro
function formatErrorMessage(error) {
  if (error instanceof Error) {
    return error.message.substring(0, 255);
  }
  if (typeof error === 'string') {
    return error.substring(0, 255);
  }
  return 'Erro desconhecido'.substring(0, 255);
}

`;
    
    signalContent = signalContent.replace(
      /(const api = require\('\.\.\/api'\);)/,
      `$1\n${formatErrorFunction}`
    );
    
    fs.writeFileSync(signalProcessorPath, signalContent, 'utf8');
    console.log('✅ formatErrorMessage adicionada ao signalProcessor.js');
  } else {
    console.log('✅ signalProcessor.js já possui formatErrorMessage');
  }
} else {
  console.log('⚠️ signalProcessor.js não encontrado');
}

console.log('\n🎉 Correção final aplicada com sucesso!');
console.log('\n📋 Resumo das correções:');
console.log('1. ✅ api.js - Adicionado getAccountConnectionState e estado centralizado');
console.log('2. ✅ websockets.js - Removido getAccountConnectionState das exportações');
console.log('3. ✅ signalProcessor.js - Verificado formatErrorMessage');

console.log('\n🚀 Agora teste novamente:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para todos os arquivos alterados.');