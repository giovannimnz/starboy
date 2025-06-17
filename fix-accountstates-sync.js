const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo sincronização do accountStates...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.sync-fix.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Identificando problema de sincronização...');
  
  // O problema é que loadCredentialsFromDatabase e makeAuthenticatedRequest
  // podem estar usando Maps diferentes ou referências diferentes
  
  // Vou garantir que há apenas UM accountStates global compartilhado
  const fixedContent = `
// Map global para estados das contas - DEVE SER O MESMO EM TODO LUGAR
const accountStates = new Map();

// Tornar disponível globalmente
if (typeof global !== 'undefined') {
  global.accountStates = accountStates;
}

/**
 * Obtém o Map de estados de forma consistente
 * @returns {Map} - Map de estados das contas
 */
function getAccountStatesMap() {
  // Sempre retornar a mesma referência
  return accountStates;
}

/**
 * Define um estado de conta no Map global
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(\`[API] Definindo estado para conta \${accountId} no Map global\`);
  accountStates.set(accountId, state);
  
  // Garantir que está disponível globalmente também
  if (typeof global !== 'undefined') {
    if (!global.accountStates) {
      global.accountStates = accountStates;
    }
    global.accountStates.set(accountId, state);
  }
  
  console.log(\`[API] Estado definido. Map agora tem \${accountStates.size} contas\`);
}

/**
 * Obtém um estado de conta do Map global
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  let state = accountStates.get(accountId);
  
  if (!state && typeof global !== 'undefined' && global.accountStates) {
    state = global.accountStates.get(accountId);
    if (state) {
      console.log(\`[API] Estado encontrado no global, copiando para Map local\`);
      accountStates.set(accountId, state);
    }
  }
  
  console.log(\`[API] getAccountState(\${accountId}): \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  return state;
}`;

  // Remover declarações antigas de accountStates
  content = content.replace(/const accountStates = new Map\(\);\s*/g, '');
  content = content.replace(/global\.accountStates = accountStates;\s*/g, '');
  
  // Adicionar o código fixo no início do arquivo (após os requires)
  const requiresMatch = content.match(/((?:const.*require.*\n)+)/);
  if (requiresMatch) {
    content = content.replace(requiresMatch[1], requiresMatch[1] + '\n' + fixedContent + '\n');
  } else {
    content = fixedContent + '\n' + content;
  }
  
  // Corrigir loadCredentialsFromDatabase para usar as funções helpers
  content = content.replace(
    /accountStates\.set\(accountId, finalState\);/g,
    'setAccountState(accountId, finalState);'
  );
  
  // Corrigir makeAuthenticatedRequest para usar as funções helpers
  const newMakeAuthenticatedRequest = `
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
    
    // CORREÇÃO: Usar função helper para obter estado
    let accountState = getAccountState(accountId);
    
    // Se não encontrou, tentar recarregar
    if (!accountState) {
      console.log(\`[API] Estado não encontrado, recarregando credenciais...\`);
      try {
        await loadCredentialsFromDatabase(accountId);
        accountState = getAccountState(accountId);
      } catch (loadError) {
        console.error(\`[API] Erro ao recarregar credenciais: \${loadError.message}\`);
      }
    }
    
    if (!accountState) {
      throw new Error(\`Estado da conta \${accountId} não encontrado mesmo após recarregamento\`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}: apiKey=\${!!apiKey}, secretKey=\${!!secretKey}, apiUrl=\${!!apiUrl}\`);
    }
    
    console.log(\`[API] ✅ Estado encontrado - usando apiKey: \${apiKey.substring(0, 8)}...\`);
    
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
    newMakeAuthenticatedRequest.trim()
  );
  
  // Adicionar as funções helper ao exports
  content = content.replace(
    /module\.exports\s*=\s*{/,
    `module.exports = {
  getAccountStatesMap,
  setAccountState,
  getAccountState,`
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Sincronização do accountStates corrigida');
}

console.log('\n🎉 CORREÇÃO DE SINCRONIZAÇÃO APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ Map accountStates unificado e global');
console.log('2. ✅ Funções helper para gerenciar estado');
console.log('3. ✅ loadCredentialsFromDatabase usa setAccountState');
console.log('4. ✅ makeAuthenticatedRequest usa getAccountState');
console.log('5. ✅ Sincronização entre local e global');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ loadCredentialsFromDatabase armazena estado');
console.log('✅ makeAuthenticatedRequest encontra estado');
console.log('✅ Estado sincronizado entre chamadas');
console.log('✅ Requisições funcionam corretamente');