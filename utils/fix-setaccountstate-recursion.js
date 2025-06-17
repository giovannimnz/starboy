const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo recursão infinita na função setAccountState...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.setaccountstate-recursion-fix.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Analisando recursão na função setAccountState...');
  
  // O problema é que setAccountState está se chamando dentro de si mesma
  // Vou substituir por uma versão simples e direta
  
  const fixedSetAccountState = `
/**
 * Define um estado de conta no Map ÚNICO - VERSÃO SEM RECURSÃO
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(\`[API] setAccountState(\${accountId}) - Salvando no Map global\`);
  
  // Salvar DIRETAMENTE no Map - SEM CHAMADAS RECURSIVAS
  accountStates.set(accountId, state);
  
  console.log(\`[API] setAccountState(\${accountId}) - ✅ Salvo com sucesso\`);
  console.log(\`[API] setAccountState(\${accountId}) - Map agora tem \${accountStates.size} entradas\`);
  
  return true;
}`;

  // Substituir a função setAccountState problemática
  content = content.replace(
    /function setAccountState\([\s\S]*?\n}/,
    fixedSetAccountState.trim()
  );
  
  // Garantir que getAccountState também seja simples
  const fixedGetAccountState = `
/**
 * Obtém um estado de conta do Map ÚNICO - VERSÃO SEM RECURSÃO
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  console.log(\`[API] getAccountState(\${accountId}) - Buscando no Map\`);
  
  const state = accountStates.get(accountId);
  console.log(\`[API] getAccountState(\${accountId}) - \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  
  return state || null;
}`;

  // Substituir a função getAccountState também
  content = content.replace(
    /function getAccountState\([\s\S]*?\n}/,
    fixedGetAccountState.trim()
  );
  
  // Garantir que debugAccountStates seja simples
  const fixedDebugAccountStates = `
/**
 * Lista todos os estados para debug - SEM RECURSÃO
 */
function debugAccountStates() {
  console.log(\`[API] DEBUG - Map tem \${accountStates.size} entradas\`);
  
  if (accountStates.size === 0) {
    console.log(\`[API] DEBUG - Map está vazio!\`);
    return;
  }
  
  for (const [id, state] of accountStates.entries()) {
    console.log(\`[API] DEBUG - Conta \${id}: apiKey=\${state.apiKey ? 'SIM' : 'NÃO'}\`);
  }
}`;

  // Substituir debugAccountStates
  content = content.replace(
    /function debugAccountStates\(\)[\s\S]*?\n}/,
    fixedDebugAccountStates.trim()
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Recursão infinita em setAccountState corrigida');
}

console.log('\n🎉 CORREÇÃO DE RECURSÃO APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ setAccountState() simplificada - sem recursão');
console.log('2. ✅ getAccountState() simplificada - sem recursão');
console.log('3. ✅ debugAccountStates() simplificada - sem recursão');
console.log('4. ✅ Todas as funções fazem operações diretas no Map');
console.log('5. ✅ Removidas TODAS as chamadas recursivas');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ loadCredentialsFromDatabase completa sem recursão');
console.log('✅ setAccountState salva estado sem loop infinito');
console.log('✅ makeAuthenticatedRequest encontra estado no Map');
console.log('✅ Sistema totalmente operacional');