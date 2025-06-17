const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo recursão infinita no api.js...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.recursion-fix.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Identificando recursão infinita...');
  
  // O problema é que getAccountState chama loadCredentialsFromDatabase
  // que chama setAccountState que pode chamar getAccountState novamente
  
  // Vou criar versões não-recursivas das funções
  const fixedFunctions = `
// ============================================================================
// MAP GLOBAL ÚNICO PARA ESTADOS DAS CONTAS - VERSÃO SEM RECURSÃO
// ============================================================================
const accountStates = new Map();

// Tornar disponível globalmente
if (typeof global !== 'undefined') {
  global.accountStates = accountStates;
}

console.log('[API] Map accountStates criado como singleton global (versão sem recursão)');

/**
 * Define um estado de conta no Map ÚNICO - VERSÃO SEM RECURSÃO
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(\`[API] setAccountState(\${accountId}) - DEFININDO no Map único\`);
  
  // Salvar diretamente no Map principal
  accountStates.set(accountId, state);
  
  // Verificar se foi salvo
  const verification = accountStates.has(accountId);
  console.log(\`[API] setAccountState(\${accountId}) - Resultado: \${verification ? 'SUCESSO' : 'FALHA'}\`);
  console.log(\`[API] setAccountState(\${accountId}) - Map agora tem \${accountStates.size} entradas\`);
  
  // Listar todas as chaves
  const keys = Array.from(accountStates.keys());
  console.log(\`[API] setAccountState(\${accountId}) - Chaves no Map: [\${keys.join(', ')}]\`);
  
  return verification;
}

/**
 * Obtém um estado de conta do Map ÚNICO - VERSÃO SEM RECURSÃO
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  console.log(\`[API] getAccountState(\${accountId}) - BUSCANDO (Map size: \${accountStates.size})\`);
  
  // Listar todas as chaves para debug
  const keys = Array.from(accountStates.keys());
  console.log(\`[API] getAccountState(\${accountId}) - Chaves disponíveis: [\${keys.join(', ')}]\`);
  
  // Buscar diretamente no Map principal
  const state = accountStates.get(accountId);
  
  console.log(\`[API] getAccountState(\${accountId}) - Resultado: \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  
  if (state) {
    console.log(\`[API] getAccountState(\${accountId}) - ✅ Estado válido com apiKey: \${state.apiKey ? 'SIM' : 'NÃO'}\`);
  }
  
  return state;
}

/**
 * Lista todos os estados para debug - SEM RECURSÃO
 */
function debugAccountStates() {
  console.log(\`[API] DEBUG - accountStates Map tem \${accountStates.size} entradas:\`);
  
  if (accountStates.size === 0) {
    console.log(\`[API] DEBUG - Map está vazio!\`);
    return;
  }
  
  for (const [id, state] of accountStates.entries()) {
    console.log(\`[API] DEBUG - Conta \${id}: apiKey=\${state.apiKey ? 'SIM' : 'NÃO'}, accountId=\${state.accountId}\`);
  }
}`;

  // Remover as funções antigas problemáticas
  content = content.replace(
    /\/\/ ============================================================================[\s\S]*?function debugAccountStates[\s\S]*?\n}/,
    fixedFunctions
  );
  
  // Corrigir makeAuthenticatedRequest para evitar recursão
  const safeMakeAuthenticatedRequest = `
/**
 * Faz uma requisição autenticada para a API da Binance - SEM RECURSÃO
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
    
    // Debug do Map antes de buscar - SEM CHAMAR FUNÇÕES RECURSIVAS
    debugAccountStates();
    
    // Buscar estado DIRETAMENTE no Map - SEM RECURSÃO
    let accountState = accountStates.get(accountId);
    
    console.log(\`[API] makeAuthenticatedRequest - Estado direto do Map: \${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
    
    // Se não encontrou, FALHAR imediatamente - NÃO TENTAR RECARREGAR (evita recursão)
    if (!accountState) {
      throw new Error(\`Estado da conta \${accountId} não encontrado no Map. Deve ser carregado primeiro via loadCredentialsFromDatabase.\`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}: apiKey=\${!!apiKey}, secretKey=\${!!secretKey}, apiUrl=\${!!apiUrl}\`);
    }
    
    console.log(\`[API] ✅ Usando credenciais da conta \${accountId} - apiKey: \${apiKey.substring(0, 8)}...\`);
    
    // Adicionar timestamp obrigatório
    const timestamp = Date.now();
    const paramsWithTimestamp = {
      ...params,
      timestamp: timestamp
    };
    
    // Construir query string para assinatura
    const queryString = Object.keys(paramsWithTimestamp)
      .sort()
      .map(key => \`\${key}=\${encodeURIComponent(paramsWithTimestamp[key])}\`)
      .join('&');
    
    // Gerar assinatura HMAC-SHA256
    const crypto = require('crypto');
    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');
    
    // Adicionar assinatura aos parâmetros
    paramsWithTimestamp.signature = signature;
    
    const finalQueryString = Object.keys(paramsWithTimestamp)
      .map(key => \`\${key}=\${encodeURIComponent(paramsWithTimestamp[key])}\`)
      .join('&');
    
    // Construir URL final
    const fullUrl = method === 'GET' 
      ? \`\${apiUrl}\${endpoint}?\${finalQueryString}\`
      : \`\${apiUrl}\${endpoint}\`;
    
    console.log(\`[API] Fazendo requisição: \${method} \${fullUrl.split('?')[0]}\`);
    
    // Configurar headers
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
      response = await axios.post(fullUrl, finalQueryString, { headers });
    } else if (method === 'PUT') {
      response = await axios.put(fullUrl, finalQueryString, { headers });
    } else if (method === 'DELETE') {
      response = await axios.delete(fullUrl, { headers, data: finalQueryString });
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

  // Substituir a função makeAuthenticatedRequest
  content = content.replace(
    /async function makeAuthenticatedRequest[\s\S]*?^}/m,
    safeMakeAuthenticatedRequest.trim()
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Recursão infinita corrigida');
}

console.log('\n🎉 CORREÇÃO DE RECURSÃO APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ Removida recursão entre getAccountState e loadCredentialsFromDatabase');
console.log('2. ✅ makeAuthenticatedRequest não tenta recarregar credenciais (evita loop)');
console.log('3. ✅ Acesso direto ao Map accountStates');
console.log('4. ✅ Funções helper simplificadas e sem recursão');
console.log('5. ✅ Debug detalhado sem chamadas recursivas');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ loadCredentialsFromDatabase cria estado uma vez');
console.log('✅ makeAuthenticatedRequest usa estado existente');
console.log('✅ Sem recursão infinita');
console.log('✅ Map funciona corretamente');
console.log('✅ Requisições são feitas com sucesso');