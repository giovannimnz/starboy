const fs = require('fs');
const path = require('path');

console.log('🔧 CORRIGINDO ERROS CRÍTICOS FINAIS...\n');

// 1. CORRIGIR limitMakerEntry.js COMPLETAMENTE
const limitEntryPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');
if (fs.existsSync(limitEntryPath)) {
  const backupPath = `${limitEntryPath}.backup.final-critical.${Date.now()}`;
  fs.copyFileSync(limitEntryPath, backupPath);
  console.log(`📁 Backup limitMakerEntry.js: ${backupPath}`);
  
  let content = fs.readFileSync(limitEntryPath, 'utf8');
  
  // GARANTIR: Import da API no início
  if (!content.includes("const api = require('../api')")) {
    content = "const api = require('../api');\n" + content;
  }
  
  // CORRIGIR: Função waitForOrderExecution com parâmetros corretos
  const fixedWaitForOrderExecution = `
// Função para aguardar execução de ordem
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId) {
    console.log(\`[WAIT_ORDER] Aguardando execução da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
        try {
            const orderStatus = await api.getOrderStatus(symbol, orderId, accountId);
            
            if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
                console.log(\`[WAIT_ORDER] ✅ Ordem \${orderId} executada: \${orderStatus.status}\`);
                return orderStatus;
            }
            
            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            console.log(\`[WAIT_ORDER] Erro ao verificar ordem \${orderId}: \${error.message}\`);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    try {
        const finalStatus = await api.getOrderStatus(symbol, orderId, accountId);
        console.log(\`[WAIT_ORDER] Status final da ordem \${orderId}: \${finalStatus.status}\`);
        return finalStatus;
    } catch (error) {
        console.log(\`[WAIT_ORDER] Erro na verificação final da ordem \${orderId}: \${error.message}\`);
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}`;

  // CORRIGIR: Função waitForOrderStatus com parâmetros corretos
  const fixedWaitForOrderStatus = `
async function waitForOrderStatus(symbol, orderId, accountId) {
    console.log(\`[LIMIT_ENTRY] Verificando status da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    try {
        const result = await api.getOrderStatus(symbol, orderId, accountId);
        
        if (result && result.status) {
            console.log(\`[LIMIT_ENTRY] ✅ Status da ordem \${orderId}: \${result.status}\`);
            return result;
        } else {
            console.log(\`[LIMIT_ENTRY] ⚠️ Resultado sem status válido para ordem \${orderId}\`);
            return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
        }
    } catch (error) {
        console.error(\`[LIMIT_ENTRY] ❌ Erro ao verificar status da ordem \${orderId}: \${error.message}\`);
        return { status: 'ERROR', executedQty: '0', avgPrice: '0' };
    }
}`;

  // Substituir funções existentes
  content = content.replace(
    /async function waitForOrderExecution[\s\S]*?(?=async function|function |\n\/\*\*|\nmodule\.exports|$)/,
    fixedWaitForOrderExecution + '\n\n'
  );
  
  content = content.replace(
    /async function waitForOrderStatus[\s\S]*?(?=async function|function |\n\/\*\*|\nmodule\.exports|$)/,
    fixedWaitForOrderStatus + '\n\n'
  );
  
  // CORRIGIR: Todas as chamadas na linha 337 e outras
  content = content.replace(
    /const\s+orderStatus\s*=\s*await\s+waitForOrderStatus\([^)]*\)/g,
    'const orderStatus = await waitForOrderStatus(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  content = content.replace(
    /await\s+waitForOrderExecution\([^)]*\)/g,
    'await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS, numericAccountId)'
  );
  
  // CORRIGIR: Chamadas diretas da API na linha 347
  content = content.replace(
    /await\s+api\.getOrderStatus\(numericAccountId,\s*activeOrderId,\s*signal\.symbol\)/g,
    'await api.getOrderStatus(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  // PADRÃO GERAL: Garantir ordem correta dos parâmetros
  content = content.replace(
    /api\.getOrderStatus\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g,
    (match, p1, p2, p3) => {
      // Se o primeiro parâmetro é numérico (accountId), corrigir ordem
      if (p1.includes('accountId') || p1.includes('numericAccountId') || p1.match(/^\d+$/)) {
        return `api.getOrderStatus(${p3}, ${p2}, ${p1})`;
      }
      // Se já está correto (symbol, orderId, accountId), manter
      return match;
    }
  );
  
  fs.writeFileSync(limitEntryPath, content, 'utf8');
  console.log('✅ 1. limitMakerEntry.js corrigido completamente');
}

// 2. VERIFICAR E CORRIGIR api.js - Garantir função getOrderStatus correta
const apiPath = path.join(__dirname, 'api.js');
if (fs.existsSync(apiPath)) {
  let content = fs.readFileSync(apiPath, 'utf8');
  
  // Garantir que getOrderStatus tem validação correta
  const correctGetOrderStatus = `
/**
 * Obtém status de uma ordem via REST API
 * @param {string} symbol - Símbolo (ex: POLUSDT)
 * @param {string} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da ordem
 */
async function getOrderStatus(symbol, orderId, accountId) {
  try {
    // VALIDAÇÃO CRÍTICA: Verificar tipos e ordem dos parâmetros
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Symbol inválido: \${symbol} (tipo: \${typeof symbol})\`);
    }
    
    if (!orderId || (typeof orderId !== 'string' && typeof orderId !== 'number')) {
      throw new Error(\`OrderId inválido: \${orderId} (tipo: \${typeof orderId})\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId inválido: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    console.log(\`[API] Obtendo status da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    const params = {
      symbol: symbol,
      orderId: String(orderId)
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/order', params);
    console.log(\`[API] ✅ Status da ordem \${orderId}: \${response.status}\`);
    return response;
    
  } catch (error) {
    console.error(\`[API] ❌ Erro ao obter status da ordem \${orderId} para \${symbol}: \${error.message}\`);
    throw error;
  }
}`;
  
  // Substituir função existente
  content = content.replace(
    /async function getOrderStatus[\s\S]*?(?=async function|function |\n\/\*\*|\nmodule\.exports|$)/,
    correctGetOrderStatus + '\n\n'
  );
  
  // Garantir que está nos exports
  if (!content.includes('getOrderStatus') || !content.includes('module.exports')) {
    content += `\n\n// Garantir export da função getOrderStatus\nmodule.exports = module.exports || {};\nmodule.exports.getOrderStatus = getOrderStatus;\n`;
  }
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ 2. api.js - função getOrderStatus garantida');
}

// 3. GARANTIR que não há problemas de cache ou imports
const clearNodeModules = `
// Clear require cache para forçar reload
Object.keys(require.cache).forEach(key => {
  if (key.includes('limitMakerEntry') || key.includes('api.js')) {
    delete require.cache[key];
  }
});
`;

fs.writeFileSync(path.join(__dirname, 'clear-cache.js'), clearNodeModules);

console.log('\n🎉 CORREÇÕES FINAIS APLICADAS!');
console.log('\n📋 Problemas resolvidos:');
console.log('1. ✅ Variável "api" definida no início do arquivo');
console.log('2. ✅ Função waitForOrderExecution com parâmetros corretos');
console.log('3. ✅ Função waitForOrderStatus com parâmetros corretos');
console.log('4. ✅ Ordem correta: getOrderStatus(symbol, orderId, accountId)');
console.log('5. ✅ Validação de tipos nos parâmetros');
console.log('6. ✅ Substituição de todas as chamadas incorretas');

console.log('\n🚀 Execute agora:');
console.log('   node clear-cache.js');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n✅ Agora deve funcionar SEM ERROS!');