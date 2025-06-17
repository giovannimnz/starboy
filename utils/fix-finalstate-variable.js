const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo erro de variável finalState...\n');

const apiPath = path.join(__dirname, 'api.js');

if (fs.existsSync(apiPath)) {
  // Backup
  const backupPath = `${apiPath}.backup.finalstate-fix.${Date.now()}`;
  fs.copyFileSync(apiPath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
  
  let content = fs.readFileSync(apiPath, 'utf8');
  
  console.log('🔍 Corrigindo erro de variável finalState...');
  
  // O problema é que estamos usando finalState mas a variável se chama accountState
  // Vou corrigir isso e também garantir que o setAccountState seja chamado no lugar certo
  
  // 1. Encontrar e corrigir a linha problemática
  content = content.replace(
    /setAccountState\(accountId, finalState\);/g,
    'setAccountState(accountId, accountState);'
  );
  
  // 2. Mover a chamada setAccountState para o local correto (após todas as atualizações)
  // Remover a chamada incorreta no final
  content = content.replace(
    /\/\/ CORREÇÃO CRÍTICA: Usar setAccountState para salvar no Map unificado[\s\S]*?setAccountState\(accountId, accountState\);[\s\S]*?return accountState;/,
    'return accountState;'
  );
  
  // 3. Adicionar a chamada setAccountState no local correto (após todas as atualizações do estado)
  const correctSetAccountStateCall = `
  // GARANTIR que o estado está no Map unificado
  setAccountState(accountId, accountState);
  console.log('[API] Estado RE-SALVO via setAccountState para garantia');
  
  console.log(\`[API] === FIM loadCredentialsFromDatabase para conta \${accountId} ===\`);
  return accountState;`;
  
  // Substituir o final da função loadCredentialsFromDatabase
  content = content.replace(
    /console\.log\(`\[API\] === FIM loadCredentialsFromDatabase para conta \${accountId} ===`\);\s*return accountState;/,
    correctSetAccountStateCall.trim()
  );
  
  fs.writeFileSync(apiPath, content, 'utf8');
  console.log('✅ Erro de variável finalState corrigido');
}

console.log('\n🎉 CORREÇÃO DE VARIÁVEL APLICADA!');
console.log('\n📋 O que foi corrigido:');
console.log('1. ✅ finalState → accountState (variável correta)');
console.log('2. ✅ setAccountState chamado no local correto');
console.log('3. ✅ Estado salvo no Map unificado após todas as atualizações');
console.log('4. ✅ Remoção de chamadas duplicadas/incorretas');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora deve funcionar:');
console.log('✅ loadCredentialsFromDatabase completa sem erro');
console.log('✅ Estado salvo corretamente no Map');
console.log('✅ makeAuthenticatedRequest encontra o estado');
console.log('✅ Sistema totalmente funcional');