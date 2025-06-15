const fs = require('fs').promises;
const path = require('path');

async function corrigirWebsocketsPrivateKey() {
  try {
    console.log('=== CORRIGINDO WEBSOCKETS.JS PARA USAR WS_API_SECRET ===');
    
    const websocketsPath = path.join(__dirname, '..', 'websockets.js');
    let conteudo = await fs.readFile(websocketsPath, 'utf8');
    
    // 1. Corrigir a função loadCredentialsFromDatabase
    const funcaoCorrigida = `
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
    // CORREÇÃO: usar ws_api_secret como privateKey
    accountState.privateKey = accountData.ws_api_secret;
    accountState.apiUrl = accountData.futures_rest_api_url;
    accountState.wsApiUrl = accountData.futures_ws_api_url;
    accountState.wssMarketUrl = accountData.futures_ws_market_url;
    accountState.ambiente = accountData.ambiente;
    
    // Criar objeto de credenciais para o cache
    const credentials = {
      apiKey: accountState.apiKey,
      apiSecret: accountState.apiSecret,
      // CORREÇÃO: usar ws_api_secret como privateKey
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
      funcaoCorrigida.trim()
    );
    
    await fs.writeFile(websocketsPath, conteudo, 'utf8');
    console.log('✅ websockets.js corrigido para usar ws_api_secret como privateKey');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir websockets.js:', error);
  }
}

corrigirWebsocketsPrivateKey();