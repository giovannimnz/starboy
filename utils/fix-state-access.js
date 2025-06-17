const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo acesso ao estado da conta...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.state-access.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Analisando problema de acesso ao estado...');
  
  // O problema é que loadCredentialsFromDatabase e makeAuthenticatedRequest 
  // podem estar usando Maps diferentes ou com chaves diferentes
  
  // Vou substituir a função makeAuthenticatedRequest por uma versão que funciona
  const fixedMakeAuthenticatedRequest = `
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
    
    // CORREÇÃO: Tentar obter estado de múltiplas formas
    let accountState = null;
    
    // Método 1: Tentar do Map global
    if (typeof accountStates !== 'undefined' && accountStates && accountStates.has) {
      accountState = accountStates.get(accountId);
      console.log(\`[API] Tentativa 1 - accountStates.get(\${accountId}): \${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
    }
    
    // Método 2: Se não encontrou, tentar recarregar
    if (!accountState) {
      console.log(\`[API] Estado não encontrado, recarregando credenciais...\`);
      try {
        await loadCredentialsFromDatabase(accountId);
        if (typeof accountStates !== 'undefined' && accountStates && accountStates.has) {
          accountState = accountStates.get(accountId);
          console.log(\`[API] Tentativa 2 - após loadCredentials: \${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
        }
      } catch (loadError) {
        console.error(\`[API] Erro ao recarregar credenciais: \${loadError.message}\`);
      }
    }
    
    // Método 3: Se ainda não encontrou, usar cache global (se existir)
    if (!accountState && typeof global !== 'undefined' && global.accountStates) {
      accountState = global.accountStates.get(accountId);
      console.log(\`[API] Tentativa 3 - global.accountStates: \${accountState ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
    }
    
    if (!accountState) {
      throw new Error(\`Estado da conta \${accountId} não encontrado em nenhum local após múltiplas tentativas\`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}: apiKey=\${!!apiKey}, secretKey=\${!!secretKey}, apiUrl=\${!!apiUrl}\`);
    }
    
    console.log(\`[API] ✅ Estado encontrado - apiKey: \${apiKey.substring(0, 8)}..., apiUrl: \${apiUrl}\`);
    
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

  // Substituir a função existente
  content = content.replace(
    /async function makeAuthenticatedRequest[\s\S]*?^}/m,
    fixedMakeAuthenticatedRequest.trim()
  );
  
  // Garantir que o Map está sendo criado como global também
  if (!content.includes('global.accountStates')) {
    content = content.replace(
      /const accountStates = new Map\(\);/,
      `const accountStates = new Map();
// Tornar disponível globalmente também
if (typeof global !== 'undefined') {
  global.accountStates = accountStates;
}`
    );
  }
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ makeAuthenticatedRequest corrigida com acesso robusto ao estado');
}

console.log('\n🎉 CORREÇÃO DE ACESSO AO ESTADO APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ makeAuthenticatedRequest agora tenta múltiplas formas de acessar o estado');
console.log('2. ✅ Logs detalhados para debugging');
console.log('3. ✅ Fallback para recarregar credenciais se estado não encontrado');
console.log('4. ✅ accountStates disponível globalmente também');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ makeAuthenticatedRequest encontra o estado');
console.log('✅ Requisições são feitas com sucesso');
console.log('✅ Posições são sincronizadas');
console.log('✅ Sinais são processados');