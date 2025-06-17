const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo erro de importação no api.js...\n');

function createBackup(filePath) {
  const backupPath = `${filePath}.backup.import-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  createBackup(apiPath);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('Removendo importação inexistente...');
  
  // Remover a importação problemática
  content = content.replace(/const \{ getAccountState \} = require\('\.\/utils\/accountState'\);\s*/g, '');
  
  // Garantir que accountStates está declarado corretamente
  if (!content.includes('const accountStates = new Map()')) {
    // Adicionar após os requires existentes
    content = content.replace(
      /(const.*require.*\n)+/,
      '$&\n// Map para armazenar estados das contas\nconst accountStates = new Map();\n'
    );
  }
  
  // Garantir que a função makeAuthenticatedRequest está correta
  const correctedFunction = `
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
    
    // Obter estado da conta do Map global
    let accountState = accountStates.get(accountId);
    
    if (!accountState) {
      console.log(\`[API] Estado não encontrado no Map, carregando credenciais para conta \${accountId}...\`);
      await loadCredentialsFromDatabase(accountId);
      accountState = accountStates.get(accountId);
    }
    
    if (!accountState) {
      throw new Error(\`Estado da conta \${accountId} não encontrado mesmo após carregamento\`);
    }
    
    const { apiKey, secretKey, apiUrl } = accountState;
    
    if (!apiKey || !secretKey || !apiUrl) {
      throw new Error(\`Credenciais incompletas para conta \${accountId}: apiKey=\${!!apiKey}, secretKey=\${!!secretKey}, apiUrl=\${!!apiUrl}\`);
    }
    
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
    correctedFunction.trim()
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ api.js corrigido - importação removida');
}

console.log('\n🎉 ERRO DE IMPORTAÇÃO CORRIGIDO!');
console.log('\n📋 O que foi feito:');
console.log('1. ✅ Removida importação inexistente');
console.log('2. ✅ accountStates declarado internamente');
console.log('3. ✅ makeAuthenticatedRequest funcional');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');