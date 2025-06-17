const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo problemas de timestamp e assinatura...\n');

function createBackup(filePath) {
  const backupPath = `${filePath}.backup.timestamp-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// Corrigir API.JS - função makeAuthenticatedRequest
console.log('1️⃣ Corrigindo makeAuthenticatedRequest no api.js...');
const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  createBackup(apiPath);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  // Procurar e substituir a função makeAuthenticatedRequest
  console.log('Procurando função makeAuthenticatedRequest...');
  
  // Função corrigida
  const improvedMakeAuthenticatedRequest = `
/**
 * Faz requisição autenticada para a API da Binance
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
      throw new Error(\`AccountId deve ser um número válido: \${accountId} (tipo: \${typeof 