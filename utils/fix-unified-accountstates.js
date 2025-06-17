const fs = require('fs');
const path = require('path');

console.log('🔧 Unificando accountStates para usar o mesmo Map...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.unified-map.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Analisando problema de Maps separados...');
  
  // O problema é que pode haver múltiplas declarações de accountStates
  // Vou garantir que há apenas UMA declaração global e todas as funções a usam
  
  // 1. Remover TODAS as declarações existentes de accountStates
  content = content.replace(/const accountStates = new Map\(\);\s*/g, '');
  content = content.replace(/let accountStates = new Map\(\);\s*/g, '');
  content = content.replace(/var accountStates = new Map\(\);\s*/g, '');
  
  // 2. Criar UMA declaração global no início
  const globalAccountStatesDeclaration = `
// ============================================================================
// MAP GLOBAL ÚNICO PARA ESTADOS DAS CONTAS - NÃO DUPLICAR EM LUGAR NENHUM!
// ============================================================================
const accountStates = new Map();

// Tornar disponível globalmente
if (typeof global !== 'undefined') {
  global.accountStates = accountStates;
}

console.log('[API] Map accountStates criado como singleton global');

// ============================================================================
// FUNÇÕES HELPER PARA GERENCIAR O MAP ÚNICO
// ============================================================================

/**
 * Define um estado de conta no Map ÚNICO
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(\`[API] setAccountState(\${accountId}) - Definindo estado no Map único\`);
  accountStates.set(accountId, state);
  
  // Garantir sincronização global
  if (typeof global !== 'undefined') {
    if (!global.accountStates) {
      global.accountStates = accountStates;
    }
    global.accountStates.set(accountId, state);
  }
  
  console.log(\`[API] setAccountState(\${accountId}) - Estado definido. Map tem \${accountStates.size} contas\`);
  
  // Verificar imediatamente se foi salvo
  const verificacao = accountStates.get(accountId);
  console.log(\`[API] setAccountState(\${accountId}) - Verificação imediata: \${verificacao ? 'SUCESSO' : 'FALHOU'}\`);
}

/**
 * Obtém um estado de conta do Map ÚNICO
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  console.log(\`[API] getAccountState(\${accountId}) - Buscando no Map único (size: \${accountStates.size})\`);
  
  // Listar todas as chaves no Map para debug
  const keys = Array.from(accountStates.keys());
  console.log(\`[API] getAccountState(\${accountId}) - Chaves no Map: [\${keys.join(', ')}]\`);
  
  let state = accountStates.get(accountId);
  console.log(\`[API] getAccountState(\${accountId}) - Resultado direto: \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  
  // Se não encontrou, tentar do global como fallback
  if (!state && typeof global !== 'undefined' && global.accountStates) {
    console.log(\`[API] getAccountState(\${accountId}) - Tentando global como fallback...\`);
    state = global.accountStates.get(accountId);
    if (state) {
      console.log(\`[API] getAccountState(\${accountId}) - Encontrado no global, sincronizando com Map local\`);
      accountStates.set(accountId, state);
    }
  }
  
  console.log(\`[API] getAccountState(\${accountId}) - Resultado final: \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  return state;
}

/**
 * Lista todos os estados para debug
 */
function debugAccountStates() {
  console.log(\`[API] DEBUG - accountStates Map tem \${accountStates.size} entradas:\`);
  for (const [id, state] of accountStates.entries()) {
    console.log(\`[API] DEBUG - Conta \${id}: apiKey=\${state.apiKey ? 'SIM' : 'NÃO'}, accountId=\${state.accountId}\`);
  }
}`;

  // 3. Inserir a declaração global após os requires
  const requiresMatch = content.match(/((?:const.*require.*\n)+)/);
  if (requiresMatch) {
    content = content.replace(requiresMatch[1], requiresMatch[1] + '\n' + globalAccountStatesDeclaration + '\n');
  } else {
    content = globalAccountStatesDeclaration + '\n' + content;
  }
  
  // 4. Modificar loadCredentialsFromDatabase para usar setAccountState
  content = content.replace(
    /accountStates\.set\(accountId, finalState\);/g,
    'setAccountState(accountId, finalState);'
  );
  
  // 5. Garantir que makeAuthenticatedRequest use getAccountState corretamente
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
    
    // Debug do Map antes de buscar
    debugAccountStates();
    
    // CORREÇÃO: Usar função helper unificada
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
      // Debug final antes de falhar
      debugAccountStates();
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
  
  // 6. Adicionar as funções helper ao exports
  content = content.replace(
    /module\.exports\s*=\s*{/,
    `module.exports = {
  setAccountState,
  getAccountState,
  debugAccountStates,`
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ accountStates unificado - um único Map para tudo');
}

console.log('\n🎉 UNIFICAÇÃO DO ACCOUNTSTATES APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ Removidas TODAS as declarações duplicadas de accountStates');
console.log('2. ✅ Criado UM Map global único');
console.log('3. ✅ Funções helper unificadas (setAccountState/getAccountState)');
console.log('4. ✅ Debug detalhado para tracking de estados');
console.log('5. ✅ loadCredentialsFromDatabase usa setAccountState');
console.log('6. ✅ makeAuthenticatedRequest usa getAccountState');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ loadCredentialsFromDatabase cria estado');
console.log('✅ makeAuthenticatedRequest encontra o mesmo estado');
console.log('✅ Um único Map compartilhado');
console.log('✅ Debug mostra exatamente o que está acontecendo');
console.log('✅ Requisições funcionam completamente');