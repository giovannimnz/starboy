const fs = require('fs');
const path = require('path');

console.log('🔧 Correção completa do sistema de monitoramento...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.complete-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Corrigir api.js - problema na ordem dos parâmetros em makeAuthenticatedRequest
console.log('1️⃣ Corrigindo api.js - makeAuthenticatedRequest...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Corrigir makeAuthenticatedRequest
const newMakeAuthenticatedRequest = `async function makeAuthenticatedRequest(accountId, method = 'GET', endpoint, data = null) {
  console.log(\`[API] makeAuthenticatedRequest chamado com parâmetros: {
    accountId: \${accountId},
    accountIdType: \${typeof accountId},
    method: \${method},
    endpoint: \${endpoint},
    data: \${data ? 'presente' : 'null'}
  }\`);

  // Validar parâmetros na ordem correta
  if (!accountId || typeof accountId !== 'number') {
    const errorMsg = \`AccountId deve ser um número válido para makeAuthenticatedRequest: \${accountId} (tipo: \${typeof accountId})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  if (!endpoint || typeof endpoint !== 'string') {
    const errorMsg = \`Endpoint deve ser uma string válida: \${endpoint} (tipo: \${typeof endpoint})\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }

  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.apiKey || !accountState.secretKey) {
    console.warn(\`[API] Credenciais não encontradas para conta \${accountId}. Tentando carregar...\`);
    await loadCredentialsFromDatabase(accountId);
    const newState = getAccountConnectionState(accountId);
    if (!newState || !newState.apiKey || !newState.secretKey) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}\`);
    }
  }

  const currentState = getAccountConnectionState(accountId);
  const timestamp = Date.now();
  const params = data ? { ...data, timestamp } : { timestamp };
  
  const queryString = Object.keys(params)
    .sort()
    .map(key => \`\${key}=\${params[key]}\`)
    .join('&');
  
  const signature = crypto
    .createHmac('sha256', currentState.secretKey)
    .update(queryString)
    .digest('hex');
  
  const finalParams = { ...params, signature };
  const url = \`\${currentState.apiUrl}\${endpoint}\`;
  
  console.log(\`[API] Fazendo requisição: \${method} \${url}\`);
  
  const config = {
    method,
    url,
    headers: {
      'X-MBX-APIKEY': currentState.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  };
  
  if (method === 'GET') {
    config.params = finalParams;
  } else {
    config.data = finalParams;
  }
  
  try {
    const response = await axios(config);
    return response.data;
  } catch (error) {
    const errorMsg = \`Falha na requisição \${method} \${endpoint}: \${error.response?.data?.msg || error.message}\`;
    console.error(\`[API] \${errorMsg}\`);
    throw new Error(errorMsg);
  }
}`;

// Substituir a função makeAuthenticatedRequest
apiContent = apiContent.replace(
  /async function makeAuthenticatedRequest\([^{]*\{[\s\S]*?^}/m,
  newMakeAuthenticatedRequest
);

// Corrigir getAllOpenPositions para usar parâmetros na ordem correta
const newGetAllOpenPositions = `async function getAllOpenPositions(accountId) {
  try {
    console.log(\`[API] Obtendo posições abertas para conta \${accountId}...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v2/positionRisk', {});
    
    if (!Array.isArray(response)) {
      console.error(\`[API] Resposta inválida ao obter posições para conta \${accountId}:\`, response);
      return [];
    }

    const openPositions = response
      .filter(pos => parseFloat(pos.positionAmt) !== 0)
      .map(pos => ({
        simbolo: pos.symbol,
        quantidade: Math.abs(parseFloat(pos.positionAmt)),
        lado: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
        precoEntrada: parseFloat(pos.entryPrice),
        precoAtual: parseFloat(pos.markPrice),
        alavancagem: parseInt(pos.leverage) || 1,
        pnlNaoRealizado: parseFloat(pos.unRealizedProfit),
        margem: parseFloat(pos.isolatedMargin),
        tipo: pos.marginType === 'isolated' ? 'ISOLATED' : 'CROSS'
      }));

    console.log(\`[API] ✅ \${openPositions.length} posições abertas encontradas para conta \${accountId}\`);
    return openPositions;
  } catch (error) {
    console.error(\`[API] Erro ao obter posições abertas para conta \${accountId}:\`, error.message);
    throw error;
  }
}`;

apiContent = apiContent.replace(
  /async function getAllOpenPositions\([^{]*\{[\s\S]*?^}/m,
  newGetAllOpenPositions
);

// Corrigir getPrice
const newGetPrice = `async function getPrice(symbol, accountId) {
  try {
    console.log(\`[API_GETPRICE_DEBUG] getPrice - symbol: \${symbol}, accountId: \${accountId}, tipo accountId: \${typeof accountId}\`);
    
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Símbolo inválido: \${symbol}\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId deve ser um número válido: \${accountId} (tipo: \${typeof accountId})\`);
    }

    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiUrl) {
      console.warn(\`[API] Estado da conta \${accountId} não encontrado, tentando carregar credenciais...\`);
      await loadCredentialsFromDatabase(accountId);
      const newState = getAccountConnectionState(accountId);
      if (!newState || !newState.apiUrl) {
        throw new Error(\`Não foi possível obter URL da API para conta \${accountId}\`);
      }
    }

    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v1/ticker/price', { symbol });
    
    if (response && response.price) {
      const price = parseFloat(response.price);
      if (isNaN(price) || price <= 0) {
        console.error(\`[API] Preço inválido recebido para \${symbol}: \${response.price}\`);
        return null;
      }
      console.log(\`[API] ✅ Preço obtido para \${symbol}: \${price}\`);
      return price;
    } else {
      console.error(\`[API] Resposta inválida ao obter preço para \${symbol}:\`, response);
      return null;
    }
  } catch (error) {
    console.error(\`[API] Erro ao obter preço para \${symbol} (conta \${accountId}):\`, error.message);
    return null;
  }
}`;

apiContent = apiContent.replace(
  /async function getPrice\([^{]*\{[\s\S]*?^}/m,
  newGetPrice
);

// Melhorar loadCredentialsFromDatabase para garantir que o estado seja atualizado
const newLoadCredentialsFromDatabase = `async function loadCredentialsFromDatabase(accountId) {
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

  // Atualizar o estado com as credenciais carregadas
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

  console.log(\`[API] ✅ Credenciais carregadas e estado atualizado em api.js para conta \${accountId}\`);
  console.log(\`[API] Estado atualizado: apiKey=\${accountState.apiKey ? 'OK' : 'MISSING'}, secretKey=\${accountState.secretKey ? 'OK' : 'MISSING'}, apiUrl=\${accountState.apiUrl || 'MISSING'}\`);
  
  return accountState; // Retorna o estado atualizado
}`;

apiContent = apiContent.replace(
  /async function loadCredentialsFromDatabase\([^{]*\{[\s\S]*?^}/m,
  newLoadCredentialsFromDatabase
);

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ api.js corrigido');

// 2. Corrigir websockets.js para melhor integração com api.js
console.log('\n2️⃣ Corrigindo websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');
createBackup(websocketsPath);

let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');

// Melhorar ensurePriceWebsocketExists
const newEnsurePriceWebsocketExists = `async function ensurePriceWebsocketExists(symbol, accountId) {
  const priceWebsockets = getPriceWebsockets(accountId, true);
  
  if (priceWebsockets.has(symbol) && priceWebsockets.get(symbol).readyState === WebSocket.OPEN) {
    return;
  }

  let accountState = getAccountConnectionState(accountId, true);
  if (!accountState.wsUrl) {
    console.log(\`[WEBSOCKET] Carregando credenciais para conta \${accountId}...\`);
    await api.loadCredentialsFromDatabase(accountId);
    accountState = getAccountConnectionState(accountId);
  }
  
  if (!accountState || !accountState.wsUrl) {
      console.error(\`[WEBSOCKET] URL de mercado não encontrada para conta \${accountId} após carregar credenciais\`);
      console.error(\`[WEBSOCKET] Estado da conta: \${JSON.stringify(accountState, null, 2)}\`);
      return;
  }

  console.log(\`[WEBSOCKET] Iniciando monitoramento de preço para \${symbol} (conta \${accountId})\`);
  console.log(\`[WEBSOCKET] Usando URL: \${accountState.wsUrl}\`);

  const wsEndpointUrl = \`\${accountState.wsUrl}/ws/\${symbol.toLowerCase()}@bookTicker\`;
  const ws = new WebSocket(wsEndpointUrl);

  ws.on('open', () => {
    console.log(\`[WEBSOCKET] ✅ Conexão de preço aberta para \${symbol} (conta \${accountId})\`);
  });

  ws.on('message', async (data) => {
    try {
      const tickerData = JSON.parse(data);
      await handlePriceUpdate(symbol, tickerData, accountId);
    } catch (error) {
      console.error(\`[WEBSOCKET] Erro ao processar dados de preço para \${symbol}:\`, error);
    }
  });

  ws.on('error', (error) => {
    console.error(\`[WEBSOCKET] Erro na conexão de preço para \${symbol}:\`, error.message);
  });

  ws.on('close', () => {
    console.log(\`[WEBSOCKET] Conexão de preço fechada para \${symbol}\`);
  });

  priceWebsockets.set(symbol, ws);
}`;

websocketsContent = websocketsContent.replace(
  /async function ensurePriceWebsocketExists\([^{]*\{[\s\S]*?^}/m,
  newEnsurePriceWebsocketExists
);

fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');
console.log('✅ websockets.js corrigido');

// 3. Criar um teste simples para verificar
console.log('\n3️⃣ Criando teste de verificação...');

const testScript = `// Teste completo do sistema
const api = require('./api');

async function testSystem() {
  console.log('🧪 Testando sistema completo...');
  
  try {
    console.log('1. Testando carregamento de credenciais...');
    const credentials = await api.loadCredentialsFromDatabase(1);
    console.log('   ✅ Credenciais carregadas:', {
      apiKey: credentials.apiKey ? 'OK' : 'MISSING',
      secretKey: credentials.secretKey ? 'OK' : 'MISSING',
      apiUrl: credentials.apiUrl || 'MISSING'
    });
    
    console.log('2. Testando getAccountConnectionState...');
    const state = api.getAccountConnectionState(1);
    console.log('   ✅ Estado da conta:', {
      exists: !!state,
      apiKey: state?.apiKey ? 'OK' : 'MISSING',
      apiUrl: state?.apiUrl || 'MISSING'
    });
    
    if (state && state.apiKey && state.apiUrl) {
      console.log('3. Testando getPrice...');
      const price = await api.getPrice('BTCUSDT', 1);
      console.log('   ✅ Preço BTCUSDT:', price || 'FALHOU');
      
      console.log('4. Testando getAllOpenPositions...');
      const positions = await api.getAllOpenPositions(1);
      console.log('   ✅ Posições encontradas:', positions.length);
    } else {
      console.log('❌ Estado da conta incompleto, pulando testes de API');
    }
    
    console.log('\\n🎉 Teste concluído!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  testSystem();
}

module.exports = { testSystem };`;

fs.writeFileSync(path.join(__dirname, 'test-complete-system.js'), testScript);
console.log('✅ Arquivo de teste criado: test-complete-system.js');

console.log('\n🎉 Correção completa concluída!');
console.log('\n📋 Resumo das correções:');
console.log('1. ✅ api.js - Corrigida ordem de parâmetros em makeAuthenticatedRequest');
console.log('2. ✅ api.js - Melhorado carregamento de credenciais');
console.log('3. ✅ api.js - Corrigidas funções getPrice e getAllOpenPositions');
console.log('4. ✅ websockets.js - Melhorado ensurePriceWebsocketExists');
console.log('5. ✅ Criado teste completo do sistema');

console.log('\n🧪 Execute o teste:');
console.log('   node test-complete-system.js');

console.log('\n🚀 Depois teste o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para todos os arquivos alterados.');