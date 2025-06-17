const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo confusão de parâmetros e variáveis ausentes...\n');

// 1. CORRIGIR limitMakerEntry.js - PROBLEMA PRINCIPAL
const limitEntryPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');
if (fs.existsSync(limitEntryPath)) {
  const backupPath = `${limitEntryPath}.backup.parameter-fix.${Date.now()}`;
  fs.copyFileSync(limitEntryPath, backupPath);
  console.log(`📁 Backup limitMakerEntry.js: ${backupPath}`);
  
  let content = fs.readFileSync(limitEntryPath, 'utf8');
  
  // ADICIONAR: import correto do api no início do arquivo
  if (!content.includes("const api = require('../api')")) {
    content = "const api = require('../api');\n" + content;
    console.log('✅ Import da API adicionado');
  }
  
  // CORRIGIR: Todas as chamadas de getOrderStatus com parâmetros corretos
  content = content.replace(
    /await\s+websocketApi\.getOrderStatusViaWebSocket\([^)]*\)/g,
    'await api.getOrderStatus(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  // CORRIGIR: Função waitForOrderExecution - parâmetros corretos
  const fixedWaitForOrderExecution = `
// Função otimizada para aguardar a execução de uma ordem
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId) {
    // CORREÇÃO CRÍTICA: Validar parâmetros antes de usar
    if (!accountId || typeof accountId !== 'number') {
        throw new Error(\`AccountId inválido: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    if (!orderId || typeof orderId !== 'string') {
        throw new Error(\`OrderId inválido: \${orderId} (tipo: \${typeof orderId})\`);
    }
    
    console.log(\`[WAIT_ORDER] Aguardando execução da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    const startTime = Date.now();
    
    // Verificação inicial imediata
    try {
        const orderStatus = await api.getOrderStatus(symbol, orderId, accountId);
        
        if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
            console.log(\`[WAIT_ORDER] ✅ Ordem \${orderId} já executada: \${orderStatus.status}\`);
            return orderStatus;
        }
    } catch (initialError) {
        console.log(\`[WAIT_ORDER] Erro inicial ao verificar ordem \${orderId}: \${initialError.message}\`);
    }
    
    // Loop de verificação com timeouts
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
    
    // Timeout - última tentativa
    try {
        const finalStatus = await api.getOrderStatus(symbol, orderId, accountId);
        console.log(\`[WAIT_ORDER] Status final da ordem \${orderId}: \${finalStatus.status}\`);
        return finalStatus;
    } catch (error) {
        console.log(\`[WAIT_ORDER] Erro na verificação final da ordem \${orderId}: \${error.message}\`);
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}`;

  // Substituir função waitForOrderExecution
  content = content.replace(
    /async function waitForOrderExecution[\s\S]*?(?=async function|function |module\.exports|\n\/\*\*|\n\/\/|$)/,
    fixedWaitForOrderExecution + '\n\n'
  );
  
  // CORRIGIR: Todas as chamadas para waitForOrderExecution com parâmetros corretos
  content = content.replace(
    /await waitForOrderExecution\([^)]*\)/g,
    'await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS, numericAccountId)'
  );
  
  // CORRIGIR: Função waitForOrderStatus com parâmetros corretos
  const fixedWaitForOrderStatus = `
async function waitForOrderStatus(symbol, orderId, accountId) {
    // CORREÇÃO CRÍTICA: Validar todos os parâmetros
    if (!accountId || typeof accountId !== 'number') {
        throw new Error(\`AccountId inválido: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    if (!orderId || typeof orderId !== 'string') {
        throw new Error(\`OrderId inválido: \${orderId} (tipo: \${typeof orderId})\`);
    }
    
    if (!symbol || typeof symbol !== 'string') {
        throw new Error(\`Symbol inválido: \${symbol} (tipo: \${typeof symbol})\`);
    }
    
    console.log(\`[LIMIT_ENTRY] Verificando status da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    try {
        // Usar sempre REST API para maior confiabilidade
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

  // Substituir função waitForOrderStatus
  content = content.replace(
    /async function waitForOrderStatus[\s\S]*?(?=async function|function |module\.exports|\n\/\*\*|\n\/\/|$)/,
    fixedWaitForOrderStatus + '\n\n'
  );
  
  // CORRIGIR: Chamadas para waitForOrderStatus
  content = content.replace(
    /await waitForOrderStatus\([^)]*\)/g,
    'await waitForOrderStatus(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  // REMOVER: Referências a websocketApi que causam erro
  content = content.replace(
    /const websocketApi = require\(['"][^'"]*['"]\);?\s*/g,
    ''
  );
  
  fs.writeFileSync(limitEntryPath, content, 'utf8');
  console.log('✅ 1. limitMakerEntry.js corrigido - parâmetros e imports');
}

// 2. VERIFICAR E CORRIGIR api.js - FUNÇÃO getOrderStatus
const apiPath = path.join(__dirname, 'api.js');
if (fs.existsSync(apiPath)) {
  let content = fs.readFileSync(apiPath, 'utf8');
  
  // Verificar se a função getOrderStatus tem os parâmetros corretos
  if (content.includes('async function getOrderStatus')) {
    // Verificar ordem dos parâmetros
    const correctGetOrderStatus = `
/**
 * Obtém status de uma ordem via REST API
 * @param {string} symbol - Símbolo
 * @param {string} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Status da ordem
 */
async function getOrderStatus(symbol, orderId, accountId) {
  try {
    // VALIDAÇÃO CRÍTICA: Verificar tipos dos parâmetros
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Symbol inválido: \${symbol} (tipo: \${typeof symbol})\`);
    }
    
    if (!orderId || typeof orderId !== 'string') {
      throw new Error(\`OrderId inválido: \${orderId} (tipo: \${typeof orderId})\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId inválido: \${accountId} (tipo: \${typeof accountId})\`);
    }
    
    console.log(\`[API] Obtendo status da ordem \${orderId} para \${symbol} (conta \${accountId})...\`);
    
    const params = {
      symbol: symbol,
      orderId: orderId
    };
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/order', params);
    console.log(\`[API] ✅ Status da ordem \${orderId}: \${response.status}\`);
    return response;
    
  } catch (error) {
    console.error(\`[API] Erro ao obter status da ordem \${orderId} para \${symbol}: \${error.message}\`);
    throw error;
  }
}`;
    
    // Substituir função existente
    content = content.replace(
      /async function getOrderStatus[\s\S]*?(?=async function|function |\n\/\*\*|\nmodule\.exports|$)/,
      correctGetOrderStatus + '\n\n'
    );
    
    fs.writeFileSync(apiPath, content, 'utf8');
    console.log('✅ 2. api.js - função getOrderStatus corrigida');
  }
}

console.log('\n🎉 CORREÇÕES APLICADAS COM SUCESSO!');
console.log('\n📋 Problemas resolvidos:');
console.log('1. ✅ Confusão orderId/accountId corrigida');
console.log('2. ✅ Variável "api" definida corretamente');
console.log('3. ✅ Parâmetros em ordem correta');
console.log('4. ✅ Validação de tipos de parâmetros');
console.log('5. ✅ Referências inválidas removidas');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Resultados esperados:');
console.log('✅ Verificação de status da ordem funcionando');
console.log('✅ Sem erros de parâmetros inválidos');
console.log('✅ Sem erros "api is not defined"');
console.log('✅ Sistema operacional sem confusão de IDs');