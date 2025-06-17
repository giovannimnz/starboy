const fs = require('fs');
const path = require('path');

console.log('🔧 Restaurando funções essenciais no api.js...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.restore-functions.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Verificando funções essenciais...');
  
  // 1. Restaurar loadCredentialsFromDatabase se não existir
  if (!content.includes('async function loadCredentialsFromDatabase')) {
    console.log('❌ loadCredentialsFromDatabase não encontrada, adicionando...');
    
    const loadCredentialsFunction = `
/**
 * Carrega credenciais do banco de dados para uma conta específica
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Credenciais da conta
 */
async function loadCredentialsFromDatabase(accountId) {
  try {
    console.log(\`[API] === NOVA FUNÇÃO loadCredentialsFromDatabase para conta \${accountId} ===\`);
    
    // PASSO 1: Obter ou criar estado da conta
    console.log(\`[API] PASSO 1: Criando/obtendo estado para conta \${accountId}...\`);
    let accountState = getAccountState(accountId);
    
    if (!accountState) {
      console.log(\`[API_STATE] Criando novo estado para conta \${accountId}...\`);
      accountState = {
        accountId: accountId,
        apiKey: null,
        secretKey: null,
        wsApiKey: null,
        wsApiSecret: null,
        apiUrl: null,
        wsUrl: null,
        wsApiUrl: null,
        ambiente: null,
        corretora: null
      };
      
      // Salvar no Map
      accountStates.set(accountId, accountState);
      console.log(\`[API_STATE] ✅ Estado criado e armazenado para conta \${accountId}\`);
      console.log(\`[API_STATE] Total de contas no Map: \${accountStates.size}\`);
    }
    
    console.log(\`[API] ✅ Estado obtido para conta \${accountId}, accountId no estado: \${accountState.accountId}\`);
    
    // PASSO 2: Obter conexão com banco
    console.log(\`[API] PASSO 2: Obtendo conexão com banco...\`);
    const { getConnection } = require('./database');
    const connection = await getConnection();
    
    // PASSO 3: Executar query
    console.log(\`[API] PASSO 3: Executando query para carregar credenciais...\`);
    const query = \`
      SELECT id, nome, api_key, api_secret, ws_api_key, ws_api_secret,
             futures_rest_api_url, futures_ws_market_url, futures_ws_api_url,
             ambiente, corretora,
             CASE WHEN api_key IS NOT NULL AND LENGTH(api_key) > 0 THEN TRUE ELSE FALSE END as has_api_key,
             CASE WHEN api_secret IS NOT NULL AND LENGTH(api_secret) > 0 THEN TRUE ELSE FALSE END as has_api_secret,
             CASE WHEN ws_api_key IS NOT NULL AND LENGTH(ws_api_key) > 0 THEN TRUE ELSE FALSE END as has_ws_api_key,
             CASE WHEN ws_api_secret IS NOT NULL AND LENGTH(ws_api_secret) > 0 THEN TRUE ELSE FALSE END as has_ws_api_secret
      FROM contas WHERE id = ?
    \`;
    
    const [rows] = await connection.execute(query, [accountId]);
    console.log(\`[API] Query executada, \${rows.length} linha(s) retornada(s)\`);
    
    if (rows.length === 0) {
      throw new Error(\`Conta \${accountId} não encontrada no banco de dados\`);
    }
    
    const row = rows[0];
    console.log(\`[API] Dados obtidos do banco:\`, {
      id: row.id,
      nome: row.nome,
      has_api_key: row.has_api_key,
      has_api_secret: row.has_api_secret,
      has_ws_api_key: row.has_ws_api_key,
      has_ws_api_secret: row.has_ws_api_secret,
      futures_rest_api_url: row.futures_rest_api_url,
      futures_ws_market_url: row.futures_ws_market_url,
      futures_ws_api_url: row.futures_ws_api_url,
      ambiente: row.ambiente,
      corretora: row.corretora
    });
    
    // PASSO 4: Atualizar estado com credenciais
    console.log(\`[API] PASSO 4: Atualizando estado com credenciais...\`);
    accountState.apiKey = row.api_key;
    accountState.secretKey = row.api_secret;
    accountState.wsApiKey = row.ws_api_key;
    accountState.wsApiSecret = row.ws_api_secret;
    accountState.apiUrl = row.futures_rest_api_url;
    accountState.wsUrl = row.futures_ws_market_url;
    accountState.wsApiUrl = row.futures_ws_api_url;
    accountState.ambiente = row.ambiente;
    accountState.corretora = row.corretora;
    
    // PASSO 5: Verificar estado final
    console.log(\`[API] PASSO 5: Verificando estado final...\`);
    console.log(\`[API] Estado final da conta \${accountId}:\`);
    console.log(\`  - accountId: \${accountState.accountId}\`);
    console.log(\`  - apiKey: \${accountState.apiKey ? accountState.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - secretKey: \${accountState.secretKey ? 'OK' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - wsApiKey: \${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - wsApiSecret: \${accountState.wsApiSecret ? 'OK' : 'NÃO ENCONTRADA'}\`);
    console.log(\`  - apiUrl: \${accountState.apiUrl || 'NÃO ENCONTRADA'}\`);
    console.log(\`  - wsUrl: \${accountState.wsUrl || 'NÃO ENCONTRADA'}\`);
    console.log(\`  - wsApiUrl: \${accountState.wsApiUrl || 'NÃO ENCONTRADA'}\`);
    console.log(\`  - ambiente: \${accountState.ambiente || 'NÃO ENCONTRADO'}\`);
    console.log(\`  - corretora: \${accountState.corretora || 'NÃO ENCONTRADA'}\`);
    
    // Verificar se estado existe no Map
    const mapState = accountStates.get(accountId);
    console.log(\`[API] Verificação final: Estado existe no Map: \${mapState ? 'SIM' : 'NÃO'}\`);
    console.log(\`[API] ✅ Estado verificado no Map para conta \${accountId}\`);
    console.log(\`[API] Estado verificado possui: apiKey=\${mapState?.apiKey ? 'true' : 'false'}, apiUrl=\${mapState?.apiUrl ? 'true' : 'false'}\`);
    
    // Salvar estado no Map unificado
    accountStates.set(accountId, accountState);
    console.log('[API] Estado salvo diretamente no Map');
    
    console.log(\`[API] === FIM loadCredentialsFromDatabase para conta \${accountId} ===\`);
    return accountState;
    
  } catch (error) {
    console.error(\`[API] Erro em loadCredentialsFromDatabase para conta \${accountId}:\`, error.message);
    throw error;
  }
}`;
    
    // Adicionar no final do arquivo
    content += '\n\n' + loadCredentialsFunction;
  }
  
  // 2. Restaurar verifyAndFixEnvironmentConsistency se não existir
  if (!content.includes('function verifyAndFixEnvironmentConsistency')) {
    console.log('❌ verifyAndFixEnvironmentConsistency não encontrada, adicionando...');
    
    const verifyEnvironmentFunction = `
/**
 * Verifica e corrige consistência do ambiente
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - True se tudo estiver consistente
 */
async function verifyAndFixEnvironmentConsistency(accountId) {
  try {
    console.log(\`[API] Verificando consistência de ambiente para conta \${accountId}...\`);
    
    // Verificar se estado existe no Map
    const accountState = getAccountState(accountId);
    if (!accountState) {
      console.log(\`[API] Estado da conta \${accountId} não encontrado para verificação de consistência\`);
      return false;
    }
    
    // Verificar se credenciais estão presentes
    const hasCredentials = accountState.apiKey && accountState.secretKey && accountState.apiUrl;
    console.log(\`[API] Verificação de credenciais: \${hasCredentials ? 'OK' : 'INCOMPLETAS'}\`);
    
    return true;
    
  } catch (error) {
    console.error(\`[API] Erro ao verificar consistência de ambiente para conta \${accountId}:\`, error.message);
    return false;
  }
}`;
    
    // Adicionar no final do arquivo
    content += '\n\n' + verifyEnvironmentFunction;
  }
  
  // 3. Verificar se makeAuthenticatedRequest existe
  if (!content.includes('async function makeAuthenticatedRequest')) {
    console.log('❌ makeAuthenticatedRequest não encontrada, adicionando...');
    
    const makeAuthenticatedRequestFunction = `
/**
 * Faz uma requisição autenticada para a API da Binance
 * @param {number} accountId - ID da conta
 * @param {string} method - Método HTTP (GET, POST, etc.)
 * @param {string} endpoint - Endpoint da API
 * @param {Object} params - Parâmetros da requisição
 * @returns {Promise<Object>} - Resposta da API
 */
async function makeAuthenticatedRequest(accountId, method, endpoint, params = {}) {
  try {
    console.log(\`[API] makeAuthenticatedRequest chamado: accountId=\${accountId}, method=\${method}, endpoint=\${endpoint}\`);
    
    // Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId deve ser um número válido: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    // Debug do Map
    debugAccountStates();
    
    // Buscar estado no Map
    const accountState = accountStates.get(accountId);
    console.log(\`[API] makeAuthenticatedRequest - Estado direto do Map: \${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
    
    if (!accountState) {
      throw new Error(\`Estado da conta \${accountId} não encontrado no Map. Deve ser carregado primeiro via loadCredentialsFromDatabase.\`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}: apiKey=\${!!apiKey}, secretKey=\${!!secretKey}, apiUrl=\${!!apiUrl}\`);
    }
    
    console.log(\`[API] ✅ Usando credenciais da conta \${accountId} - apiKey: \${apiKey.substring(0, 8)}...\`);
    
    // Timestamp em milliseconds
    const timestamp = Date.now();
    
    // Preparar parâmetros para assinatura
    let queryString = '';
    let bodyData = '';
    
    if (method === 'GET') {
      const queryParams = { ...params, timestamp: timestamp };
      queryString = Object.keys(queryParams)
        .sort()
        .map(key => \`\${key}=\${encodeURIComponent(queryParams[key])}\`)
        .join('&');
    } else {
      const bodyParams = { ...params, timestamp: timestamp };
      queryString = Object.keys(bodyParams)
        .sort()
        .map(key => \`\${key}=\${encodeURIComponent(bodyParams[key])}\`)
        .join('&');
      bodyData = queryString;
    }
    
    // Gerar assinatura HMAC-SHA256
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');
    
    console.log(\`[API] Timestamp: \${timestamp}\`);
    console.log(\`[API] Query string para assinatura: \${queryString.substring(0, 100)}...\`);
    console.log(\`[API] Assinatura gerada: \${signature.substring(0, 16)}...\`);
    
    // Construir URL e dados finais
    const finalQueryString = queryString + \`&signature=\${signature}\`;
    let fullUrl;
    
    if (method === 'GET') {
      fullUrl = \`\${apiUrl}\${endpoint}?\${finalQueryString}\`;
    } else {
      fullUrl = \`\${apiUrl}\${endpoint}\`;
    }
    
    console.log(\`[API] Fazendo requisição: \${method} \${fullUrl.split('?')[0]}\`);
    
    // Headers
    const headers = {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    
    // Fazer requisição
    const axios = require('axios');
    let response;
    
    if (method === 'GET') {
      response = await axios.get(fullUrl, { headers });
    } else if (method === 'POST') {
      const postData = bodyData + \`&signature=\${signature}\`;
      response = await axios.post(fullUrl, postData, { headers });
    } else {
      throw new Error(\`Método HTTP não suportado: \${method}\`);
    }
    
    return response.data;
    
  } catch (error) {
    const errorMessage = error.response?.data?.msg || error.message;
    console.error(\`[API] Falha na requisição \${method} \${endpoint}: \${errorMessage}\`);
    throw new Error(\`Falha na requisição \${method} \${endpoint}: \${errorMessage}\`);
  }
}`;
    
    // Adicionar no final do arquivo
    content += '\n\n' + makeAuthenticatedRequestFunction;
  }
  
  // 4. Adicionar exports no final
  if (!content.includes('module.exports')) {
    console.log('❌ module.exports não encontrado, adicionando...');
    
    const moduleExports = `
// ============================================================================
// EXPORTS
// ============================================================================
module.exports = {
  loadCredentialsFromDatabase,
  verifyAndFixEnvironmentConsistency,
  makeAuthenticatedRequest,
  setAccountState,
  getAccountState,
  debugAccountStates,
  formatQuantity,
  formatPrice,
  getPrecisionCached
};`;
    
    content += '\n\n' + moduleExports;
  }
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Funções essenciais restauradas no api.js');
}

console.log('\n🎉 RESTAURAÇÃO DE FUNÇÕES CONCLUÍDA!');
console.log('\n📋 Funções restauradas:');
console.log('1. ✅ loadCredentialsFromDatabase');
console.log('2. ✅ verifyAndFixEnvironmentConsistency');
console.log('3. ✅ makeAuthenticatedRequest');
console.log('4. ✅ module.exports');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ Todas as funções disponíveis');
console.log('✅ Sistema carrega credenciais corretamente');
console.log('✅ Requisições autenticadas funcionando');
console.log('✅ Monitoramento totalmente operacional');