const fs = require('fs').promises;
const path = require('path');

async function corrigirWebsockets() {
  try {
    console.log('=== CORRIGINDO WEBSOCKETS.JS ===');
    
    const websocketsPath = path.join(__dirname, '..', 'websockets.js');
    let conteudo = await fs.readFile(websocketsPath, 'utf8');
    
    // 1. Corrigir endpoint do listenKey (case sensitive)
    conteudo = conteudo.replace(
      /\/v1\/listenkey/g,
      '/v1/listenKey'
    );
    
    // 2. Corrigir determinação de URL da WebSocket API
    const wsApiEndpointFix = `
    // Determinar a URL correta baseada no ambiente da conta
    let wsApiEndpoint;
    if (accountState.ambiente === 'prd') {
      wsApiEndpoint = accountState.wsApiUrl || 'wss://ws-fapi.binance.com/ws-fapi/v1';
    } else {
      wsApiEndpoint = 'wss://testnet.binancefuture.com/ws-fapi/v1';
    }`;
    
    conteudo = conteudo.replace(
      /const wsApiEndpoint = process\.env\.NODE_ENV === 'production'[\s\S]*?'wss:\/\/testnet\.binancefuture\.com\/ws-fapi\/v1';/,
      wsApiEndpointFix.trim()
    );
    
    // 3. Corrigir URL do WebSocket Market Stream
    conteudo = conteudo.replace(
      /const wsUrl = `\$\{updatedAccountState\.wssMarketUrl\}\/\$\{symbol\.toLowerCase\(\)\}@bookTicker`;/,
      'const wsUrl = `${updatedAccountState.wssMarketUrl}/ws/${symbol.toLowerCase()}@bookTicker`;'
    );
    
    // 4. Garantir que as credenciais sejam carregadas corretamente
    const loadCredentialsImprovement = `
async function loadCredentialsFromDatabase(options = {}) {
  try {
    const accountId = options.accountId || 1;
    const forceRefresh = options.forceRefresh || false;
    const currentTime = Date.now();
    
    console.log('[WEBSOCKETS] Iniciando carregamento de credenciais para conta ID:', accountId);
    
    // Usar cache se disponível e não expirado
    if (accountCredentialsCache.has(accountId) && !forceRefresh && 
        (currentTime - lastCacheTime < CACHE_TTL)) {
      console.log(\`[WEBSOCKETS] Usando credenciais em cache para conta \${accountId}\`);
      return accountCredentialsCache.get(accountId);
    }
    
    const db = await getDatabaseInstance(accountId);
    
    if (!db) {
      throw new Error(\`Não foi possível obter conexão com o banco de dados para conta \${accountId}\`);
    }
    
    // Query corrigida para usar os nomes corretos das colunas
    const [rows] = await db.query(\`
      SELECT 
        c.id,
        c.api_key, 
        c.api_secret, 
        c.ws_api_key, 
        c.ws_api_secret,
        c.id_corretora,
        cor.spot_rest_api_url,
        cor.futures_rest_api_url,
        cor.futures_ws_market_url,
        cor.futures_ws_api_url,
        cor.corretora,
        cor.ambiente
      FROM contas c
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1 AND cor.ativa = 1\`,
      [accountId]
    );
    
    if (rows.length === 0) {
      throw new Error(\`Conta ID \${accountId} não encontrada ou não está ativa\`);
    }

    const accountData = rows[0];
    
    // Atualizar estado da conexão para esta conta específica
    const accountState = getAccountConnectionState(accountId, true);
    
    accountState.apiKey = accountData.api_key;
    accountState.apiSecret = accountData.api_secret;
    accountState.privateKey = accountData.ws_api_secret;
    accountState.apiUrl = accountData.futures_rest_api_url;
    accountState.wsApiUrl = accountData.futures_ws_api_url;
    accountState.wssMarketUrl = accountData.futures_ws_market_url;
    accountState.ambiente = accountData.ambiente;
    
    // Criar objeto de credenciais para o cache
    const credentials = {
      apiKey: accountState.apiKey,
      apiSecret: accountState.apiSecret,
      privateKey: accountState.privateKey,
      apiUrl: accountState.apiUrl,
      wsApiUrl: accountState.wsApiUrl,
      wssMarketUrl: accountState.wssMarketUrl,
      corretora: accountData.corretora,
      ambiente: accountData.ambiente,
      corretoraId: accountData.id_corretora,
      accountId
    };
    
    // Armazenar no cache
    accountCredentialsCache.set(accountId, credentials);
    lastCacheTime = currentTime;
    
    console.log(\`[WEBSOCKETS] Credenciais inicializadas com sucesso para conta \${accountId} (corretora: \${accountData.corretora}, ambiente: \${accountData.ambiente})\`);
    return credentials;
  } catch (error) {
    console.error(\`[CONFIG] Erro ao carregar credenciais do banco de dados para conta \${options.accountId || 1}:\`, error.message);
    throw error;
  }
}`;
    
    // Substituir a função loadCredentialsFromDatabase
    conteudo = conteudo.replace(
      /async function loadCredentialsFromDatabase\(options = \{\}\)[\s\S]*?^}/m,
      loadCredentialsImprovement.trim()
    );
    
    await fs.writeFile(websocketsPath, conteudo, 'utf8');
    console.log('✅ Arquivo websockets.js corrigido com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir websockets.js:', error);
  }
}

corrigirWebsockets();