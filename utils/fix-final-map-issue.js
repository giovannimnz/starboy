const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo problema final do Map - garantindo uso das funções unificadas...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.final-map-fix.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Encontrando onde loadCredentialsFromDatabase NÃO usa setAccountState...');
  
  // O problema é que loadCredentialsFromDatabase pode estar usando um Map diferente
  // Vou garantir que TODAS as operações de Map usem as funções helper
  
  // 1. Procurar por todas as ocorrências de accountStates.set e substituir por setAccountState
  console.log('🔄 Substituindo todas as chamadas diretas ao Map...');
  
  content = content.replace(
    /accountStates\.set\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
    'setAccountState($1, $2)'
  );
  
  // 2. Procurar por todas as ocorrências de accountStates.get e substituir por getAccountState
  content = content.replace(
    /accountStates\.get\s*\(\s*([^)]+)\s*\)/g,
    'getAccountState($1)'
  );
  
  // 3. Garantir que o Map não seja manipulado diretamente em lugar nenhum
  // Substituir referencias diretas ao accountStates que não sejam através das funções
  
  // 4. Adicionar log na função setAccountState para debug
  const improvedSetAccountState = `
/**
 * Define um estado de conta no Map ÚNICO
 * @param {number} accountId - ID da conta
 * @param {Object} state - Estado da conta
 */
function setAccountState(accountId, state) {
  console.log(\`[API] setAccountState(\${accountId}) - ANTES: Map tem \${accountStates.size} contas\`);
  
  // Log das chaves existentes antes
  const keysBefore = Array.from(accountStates.keys());
  console.log(\`[API] setAccountState(\${accountId}) - Chaves antes: [\${keysBefore.join(', ')}]\`);
  
  accountStates.set(accountId, state);
  
  // Log das chaves existentes depois
  const keysAfter = Array.from(accountStates.keys());
  console.log(\`[API] setAccountState(\${accountId}) - DEPOIS: Map tem \${accountStates.size} contas\`);
  console.log(\`[API] setAccountState(\${accountId}) - Chaves depois: [\${keysAfter.join(', ')}]\`);
  
  // Garantir sincronização global
  if (typeof global !== 'undefined') {
    if (!global.accountStates) {
      global.accountStates = accountStates;
      console.log(\`[API] setAccountState(\${accountId}) - Global accountStates criado\`);
    }
    global.accountStates.set(accountId, state);
    console.log(\`[API] setAccountState(\${accountId}) - Estado sincronizado globalmente\`);
  }
  
  // Verificar imediatamente se foi salvo
  const verificacao = accountStates.get(accountId);
  console.log(\`[API] setAccountState(\${accountId}) - Verificação imediata: \${verificacao ? 'SUCESSO' : 'FALHOU'}\`);
  
  if (verificacao) {
    console.log(\`[API] setAccountState(\${accountId}) - ✅ Estado salvo com sucesso: apiKey=\${verificacao.apiKey ? 'SIM' : 'NÃO'}\`);
  } else {
    console.error(\`[API] setAccountState(\${accountId}) - ❌ FALHA CRÍTICA: Estado não foi salvo!\`);
  }
}`;

  // Substituir a função setAccountState existente
  content = content.replace(
    /function setAccountState\([\s\S]*?\n}/,
    improvedSetAccountState.trim()
  );
  
  // 5. Melhorar getAccountState também
  const improvedGetAccountState = `
/**
 * Obtém um estado de conta do Map ÚNICO
 * @param {number} accountId - ID da conta
 * @returns {Object|null} - Estado da conta ou null
 */
function getAccountState(accountId) {
  console.log(\`[API] getAccountState(\${accountId}) - BUSCANDO no Map (size: \${accountStates.size})\`);
  
  // Listar todas as chaves no Map para debug
  const keys = Array.from(accountStates.keys());
  console.log(\`[API] getAccountState(\${accountId}) - Chaves disponíveis: [\${keys.join(', ')}]\`);
  
  let state = accountStates.get(accountId);
  console.log(\`[API] getAccountState(\${accountId}) - Resultado direto do Map: \${state ? 'ENCONTRADO' : 'NÃO ENCONTRADO'}\`);
  
  // Se não encontrou, tentar do global como fallback
  if (!state && typeof global !== 'undefined' && global.accountStates) {
    console.log(\`[API] getAccountState(\${accountId}) - Tentando global como fallback...\`);
    state = global.accountStates.get(accountId);
    if (state) {
      console.log(\`[API] getAccountState(\${accountId}) - ✅ Encontrado no global, sincronizando com Map local\`);
      accountStates.set(accountId, state);
    } else {
      console.log(\`[API] getAccountState(\${accountId}) - ❌ Não encontrado nem no global\`);
    }
  }
  
  if (state) {
    console.log(\`[API] getAccountState(\${accountId}) - ✅ SUCESSO: Estado encontrado com apiKey=\${state.apiKey ? 'SIM' : 'NÃO'}\`);
  } else {
    console.log(\`[API] getAccountState(\${accountId}) - ❌ FALHA: Estado não encontrado em lugar nenhum\`);
  }
  
  return state;
}`;

  // Substituir a função getAccountState existente
  content = content.replace(
    /function getAccountState\([\s\S]*?\n}/,
    improvedGetAccountState.trim()
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Funções Map unificadas e com debug detalhado');
}

console.log('\n🎉 CORREÇÃO FINAL DO MAP APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ TODAS as chamadas accountStates.set() → setAccountState()');
console.log('2. ✅ TODAS as chamadas accountStates.get() → getAccountState()');
console.log('3. ✅ Debug detalhado em setAccountState()');
console.log('4. ✅ Debug detalhado em getAccountState()');
console.log('5. ✅ Verificação imediata após salvar');
console.log('6. ✅ Log de chaves antes e depois');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 O que deve acontecer agora:');
console.log('✅ loadCredentialsFromDatabase usa setAccountState()');
console.log('✅ makeAuthenticatedRequest usa getAccountState()');
console.log('✅ MESMO Map em todas as operações');
console.log('✅ Debug mostra exatamente onde está o problema');
console.log('✅ Estado persistente entre chamadas');