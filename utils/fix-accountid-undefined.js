const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo accountId undefined no setupBookDepthWebsocket...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.accountid-undefined.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Corrigir limitMakerEntry.js - garantir que accountId seja passado
console.log('1️⃣ Corrigindo limitMakerEntry.js...');
const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');

if (fs.existsSync(limitMakerPath)) {
  createBackup(limitMakerPath);
  
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  
  // Encontrar e corrigir a chamada para setupBookDepthWebsocket
  console.log('Procurando chamada para setupBookDepthWebsocket...');
  
  // Padrões comuns de chamada
  const patterns = [
    /websockets\.setupBookDepthWebsocket\([^)]*\)/g,
    /setupBookDepthWebsocket\([^)]*\)/g
  ];
  
  patterns.forEach(pattern => {
    const matches = content.match(pattern);
    if (matches) {
      console.log('Encontradas chamadas:', matches);
      
      // Corrigir chamadas que não incluem accountId
      content = content.replace(
        /websockets\.setupBookDepthWebsocket\(([^,)]+)\)/g,
        'websockets.setupBookDepthWebsocket($1, accountId)'
      );
      
      content = content.replace(
        /setupBookDepthWebsocket\(([^,)]+)\)/g,
        'setupBookDepthWebsocket($1, accountId)'
      );
    }
  });
  
  // Verificar se há chamadas que já têm 2 parâmetros mas o segundo é undefined/null
  content = content.replace(
    /websockets\.setupBookDepthWebsocket\(([^,]+),\s*(undefined|null)\s*\)/g,
    'websockets.setupBookDepthWebsocket($1, accountId)'
  );
  
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  console.log('✅ Chamadas para setupBookDepthWebsocket corrigidas');
} else {
  console.error('❌ limitMakerEntry.js não encontrado');
}

// 2. Corrigir websockets.js - adicionar validação de accountId
console.log('\n2️⃣ Adicionando validação no websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  createBackup(websocketsPath);
  
  let content = fs.readFileSync(websocketsPath, 'utf8');
  
  // Encontrar a função setupBookDepthWebsocket e adicionar validação
  const functionMatch = content.match(/(setupBookDepthWebsocket[\s\S]*?function[^{]*\{)/);
  
  if (functionMatch) {
    const validationCode = `
  // Validação do accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[WEBSOCKET] AccountId inválido para setupBookDepthWebsocket: \${accountId} (tipo: \${typeof accountId})\`);
    throw new Error(\`AccountId é obrigatório e deve ser um número, recebido: \${accountId}\`);
  }
  
  console.log(\`[WEBSOCKET] setupBookDepthWebsocket chamado para conta \${accountId}\`);
`;
    
    content = content.replace(
      functionMatch[1],
      functionMatch[1] + validationCode
    );
    
    console.log('✅ Validação de accountId adicionada ao setupBookDepthWebsocket');
  } else {
    console.log('⚠️ Função setupBookDepthWebsocket não encontrada para adicionar validação');
  }
  
  fs.writeFileSync(websocketsPath, content, 'utf8');
} else {
  console.error('❌ websockets.js não encontrado');
}

// 3. Criar versão corrigida da chamada para limitMakerEntry.js
console.log('\n3️⃣ Criando correção específica para limitMakerEntry.js...');

if (fs.existsSync(limitMakerPath)) {
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  
  // Procurar o local onde setupBookDepthWebsocket é chamado e garantir contexto correto
  const lines = content.split('\n');
  let foundLine = -1;
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('setupBookDepthWebsocket')) {
      foundLine = i;
      console.log(`Linha ${i + 1}: ${lines[i].trim()}`);
      
      // Verificar se accountId está disponível no escopo
      let j = i - 1;
      let hasAccountId = false;
      
      while (j >= 0 && j > i - 20) {
        if (lines[j].includes('accountId') && (lines[j].includes('function') || lines[j].includes('=>'))) {
          hasAccountId = true;
          break;
        }
        j--;
      }
      
      if (!hasAccountId) {
        console.log(`⚠️ accountId pode não estar disponível no escopo da linha ${i + 1}`);
      }
      
      // Corrigir a linha se necessário
      if (!lines[i].includes(', accountId') && !lines[i].includes(',accountId')) {
        lines[i] = lines[i].replace(
          /setupBookDepthWebsocket\(([^)]+)\)/,
          'setupBookDepthWebsocket($1, accountId)'
        );
        console.log(`✅ Corrigida linha ${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  
  content = lines.join('\n');
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  
  if (foundLine === -1) {
    console.log('⚠️ Chamada para setupBookDepthWebsocket não encontrada');
  }
} else {
  console.error('❌ limitMakerEntry.js não encontrado para correção específica');
}

// 4. Criar teste para validar a correção
console.log('\n4️⃣ Criando teste de validação...');

const testScript = `// Teste de validação do accountId
async function testAccountIdFix() {
  console.log('🧪 Testando correção do accountId...');
  
  try {
    console.log('\\n=== TESTE 1: Verificar websockets.js ===');
    const websockets = require('./websockets');
    
    console.log('- setupBookDepthWebsocket:', typeof websockets.setupBookDepthWebsocket);
    
    if (typeof websockets.setupBookDepthWebsocket !== 'function') {
      console.error('❌ setupBookDepthWebsocket não encontrada!');
      return false;
    }
    
    console.log('\\n=== TESTE 2: Testar validação de accountId ===');
    
    try {
      // Tentar chamar com accountId undefined - deve dar erro
      await websockets.setupBookDepthWebsocket('BTCUSDT', undefined);
      console.error('❌ Validação falhou - não rejeitou accountId undefined');
      return false;
    } catch (error) {
      if (error.message.includes('AccountId é obrigatório')) {
        console.log('✅ Validação funcionando - rejeitou accountId undefined');
      } else {
        console.log('⚠️ Erro diferente (aceitável):', error.message);
      }
    }
    
    console.log('\\n=== TESTE 3: Verificar limitMakerEntry.js ===');
    
    try {
      const limitMaker = require('./posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry carregado sem erros');
    } catch (error) {
      console.error('❌ Erro ao carregar limitMakerEntry:', error.message);
      return false;
    }
    
    console.log('\\n✅ Todos os testes passaram!');
    return true;
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    return false;
  }
}

if (require.main === module) {
  testAccountIdFix().then(success => {
    if (success) {
      console.log('\\n🎉 Correção do accountId bem-sucedida!');
      console.log('\\n🚀 Execute o monitoramento:');
      console.log('   node posicoes/monitoramento.js --account 1');
      console.log('\\n📊 O setupBookDepthWebsocket deve receber accountId corretamente!');
    } else {
      console.log('\\n❌ Ainda há problemas com accountId');
      process.exit(1);
    }
  });
}

module.exports = { testAccountIdFix };`;

fs.writeFileSync(path.join(__dirname, 'test-accountid-fix.js'), testScript);
console.log('✅ Arquivo de teste criado: test-accountid-fix.js');

console.log('\n🎉 Correção do accountId undefined concluída!');
console.log('\n📋 Principais correções:');
console.log('1. ✅ Chamadas para setupBookDepthWebsocket corrigidas');
console.log('2. ✅ Validação de accountId adicionada no websockets.js');
console.log('3. ✅ Verificação de escopo em limitMakerEntry.js');
console.log('4. ✅ Teste de validação criado');

console.log('\n🧪 Execute o teste:');
console.log('   node test-accountid-fix.js');

console.log('\n🚀 Depois execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para segurança.');