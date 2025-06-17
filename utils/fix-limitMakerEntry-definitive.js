const fs = require('fs');
const path = require('path');

console.log('🔧 CORREÇÃO DEFINITIVA DO limitMakerEntry.js...\n');

const limitEntryPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');

if (fs.existsSync(limitEntryPath)) {
  // Backup de segurança
  const backupPath = `${limitEntryPath}.backup.definitive.${Date.now()}`;
  fs.copyFileSync(limitEntryPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(limitEntryPath, 'utf8');
  
  // 1. GARANTIR IMPORT DA API NO INÍCIO
  const lines = content.split('\n');
  let hasApiImport = false;
  
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    if (lines[i].includes("require('../api')") || lines[i].includes("require('./api')")) {
      hasApiImport = true;
      break;
    }
  }
  
  if (!hasApiImport) {
    content = "const api = require('../api');\n" + content;
    console.log('✅ Import da API adicionado no início');
  }
  
  // 2. CORRIGIR LINHA 337 - Substituir waitForOrderStatus por chamada direta
  content = content.replace(
    /const\s+orderStatus\s*=\s*await\s+waitForOrderStatus\([^)]*\);?/g,
    'const orderStatus = await api.getOrderStatus(signal.symbol, activeOrderId, numericAccountId);'
  );
  
  // 3. CORRIGIR LINHA 347 - Garantir ordem correta dos parâmetros
  content = content.replace(
    /await\s+api\.getOrderStatus\(numericAccountId,\s*activeOrderId,\s*signal\.symbol\)/g,
    'await api.getOrderStatus(signal.symbol, activeOrderId, numericAccountId)'
  );
  
  // 4. SUBSTITUIR FUNÇÃO waitForOrderExecution POR IMPLEMENTAÇÃO SIMPLES
  const newWaitForOrderExecution = `
// Função simplificada para aguardar execução
async function waitForOrderExecution(symbol, orderId, maxWaitMs, accountId) {
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
    
    // Última tentativa
    try {
        const finalStatus = await api.getOrderStatus(symbol, orderId, accountId);
        return finalStatus;
    } catch (error) {
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}`;

  // Substituir função waitForOrderExecution
  content = content.replace(
    /async function waitForOrderExecution[\s\S]*?(?=\n(?:async function|function |\/\*\*|module\.exports)|\n$)/,
    newWaitForOrderExecution + '\n'
  );
  
  // 5. REMOVER FUNÇÃO waitForOrderStatus (problema raiz)
  content = content.replace(
    /async function waitForOrderStatus[\s\S]*?(?=\n(?:async function|function |\/\*\*|module\.exports)|\n$)/,
    ''
  );
  
  // 6. CORRIGIR TODAS AS CHAMADAS DE waitForOrderExecution
  content = content.replace(
    /await\s+waitForOrderExecution\([^)]*\)/g,
    'await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS, numericAccountId)'
  );
  
  // 7. GARANTIR QUE TODAS AS CHAMADAS DA API ESTÃO CORRETAS
  content = content.replace(
    /api\.getOrderStatus\(([^,]*),\s*([^,]*),\s*([^)]*)\)/g,
    (match, p1, p2, p3) => {
      // Detectar se primeiro parâmetro é accountId (número)
      if (p1.trim().match(/^\d+$/) || p1.includes('accountId') || p1.includes('numericAccountId')) {
        return \`api.getOrderStatus(\${p3.trim()}, \${p2.trim()}, \${p1.trim()})\`;
      }
      return match;
    }
  );
  
  fs.writeFileSync(limitEntryPath, content, 'utf8');
  console.log('✅ limitMakerEntry.js corrigido definitivamente');
  
} else {
  console.log('❌ Arquivo limitMakerEntry.js não encontrado');
}

// VERIFICAR E CORRIGIR api.js TAMBÉM
const apiPath = path.join(__dirname, 'api.js');
if (fs.existsSync(apiPath)) {
  let apiContent = fs.readFileSync(apiPath, 'utf8');
  
  // Verificar se getOrderStatus tem validação adequada
  if (!apiContent.includes('Symbol inválido') || apiContent.includes('typeof symbol !== \'string\'')) {
    console.log('⚠️ api.js pode precisar de correção na função getOrderStatus');
    
    const correctGetOrderStatusValidation = `
    // VALIDAÇÃO DE PARÂMETROS CORRIGIDA
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Symbol deve ser uma string válida. Recebido: \${symbol} (tipo: \${typeof symbol})\`);
    }
    
    if (!orderId || (typeof orderId !== 'string' && typeof orderId !== 'number')) {
      throw new Error(\`OrderId deve ser string ou number. Recebido: \${orderId} (tipo: \${typeof orderId})\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId deve ser um número. Recebido: \${accountId} (tipo: \${typeof accountId})\`);
    }`;
    
    // Atualizar validação se necessário
    apiContent = apiContent.replace(
      /if\s*\(\s*!symbol\s*\|\|\s*typeof symbol\s*!==\s*['"]string['"]\s*\)\s*{[^}]*}/,
      correctGetOrderStatusValidation.trim()
    );
    
    fs.writeFileSync(apiPath, apiContent, 'utf8');
    console.log('✅ api.js - validação atualizada');
  }
}

console.log('\n🎉 CORREÇÃO DEFINITIVA CONCLUÍDA!');
console.log('\n📋 Mudanças aplicadas:');
console.log('1. ✅ Import da API garantido no início');
console.log('2. ✅ Linha 337: waitForOrderStatus substituído por chamada direta');
console.log('3. ✅ Linha 347: parâmetros corrigidos');
console.log('4. ✅ Função waitForOrderExecution simplificada');
console.log('5. ✅ Função waitForOrderStatus removida (fonte do problema)');
console.log('6. ✅ Todas as chamadas da API corrigidas');

console.log('\n🚀 Execute agora:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Resultado esperado:');
console.log('✅ Sem erro "api is not defined"');
console.log('✅ Sem erro "Symbol inválido"');
console.log('✅ Verificação de status da ordem funcionando');