const fs = require('fs').promises;
const path = require('path');

async function corrigirApiPrivateKey() {
  try {
    console.log('=== CORRIGINDO API.JS PARA USAR WS_API_SECRET ===');
    
    const apiPath = path.join(__dirname, '..', 'api.js');
    let conteudo = await fs.readFile(apiPath, 'utf8');
    
    // Corrigir a função loadCredentialsFromDatabase no api.js
    const funcaoCorrigida = `
async function loadCredentialsFromDatabase(options = {}) {
  try {
    const { accountId = 1, forceRefresh = false } = options;
    
    console.log(\`[API] Carregando credenciais para conta ID: \${accountId}\`);
    
    // Usar cache se disponível e não forçar atualização
    if (!forceRefresh && accountCredentials.has(accountId) && 
        (Date.now() - lastCacheTime < CACHE_TTL)) {
      console.log(\`[API] Usando credenciais em cache para conta \${accountId}\`);
      return accountCredentials.get(accountId);
    }
    
    const db = await getDatabaseInstance(accountId);
    
    // Buscar conta e JOIN com a tabela corretoras para obter as URLs corretas
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
    
    if (!rows || rows.length === 0) {
      throw new Error(\`Conta ID \${accountId} não encontrada ou não está ativa\`);
    }
    
    const account = rows[0];
    
    // Criar objeto de credenciais
    const credentials = {
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      wsApiKey: account.ws_api_key,
      wsApiSecret: account.ws_api_secret,
      // CORREÇÃO: usar ws_api_secret como privateKey para WebSocket API
      privateKey: account.ws_api_secret,
      apiUrl: account.futures_rest_api_url,
      wsApiUrl: account.futures_ws_api_url,
      wssMarketUrl: account.futures_ws_market_url,
      corretora: account.corretora,
      ambiente: account.ambiente,
      corretoraId: account.id_corretora,
      accountId
    };
    
    // Armazenar no cache
    accountCredentials.set(accountId, credentials);
    lastCacheTime = Date.now();
    
    console.log(\`[API] Credenciais carregadas com sucesso para conta \${accountId} (corretora: \${account.corretora}, ambiente: \${account.ambiente})\`);
    return credentials;
  } catch (error) {
    console.error(\`[API] Erro ao carregar credenciais para conta \${options.accountId || 1}:\`, error.message);
    throw error;
  }
}`;

    // Substituir a função loadCredentialsFromDatabase
    conteudo = conteudo.replace(
      /async function loadCredentialsFromDatabase\(options = \{\}\)[\s\S]*?^}/m,
      funcaoCorrigida.trim()
    );
    
    await fs.writeFile(apiPath, conteudo, 'utf8');
    console.log('✅ api.js corrigido para usar ws_api_secret como privateKey');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir api.js:', error);
  }
}

corrigirApiPrivateKey();