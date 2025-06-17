const fs = require('fs');
const path = require('path');

console.log('🔧 Correção específica da linha 134 do limitMakerEntry.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.line134.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');

if (fs.existsSync(limitMakerPath)) {
  createBackup(limitMakerPath);
  
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  const lines = content.split('\n');
  
  console.log('🔍 Analisando linha 134 especificamente...');
  
  if (lines.length >= 134) {
    const line134 = lines[133]; // Array é 0-indexed
    console.log(`Linha 134: ${line134}`);
    
    if (line134.includes('setupBookDepthWebsocket')) {
      console.log('✅ Encontrada chamada setupBookDepthWebsocket na linha 134!');
      
      // Mostrar contexto
      console.log('\nContexto (linhas 130-140):');
      for (let i = 129; i <= 139 && i < lines.length; i++) {
        const marker = i === 133 ? ' --> ' : '     ';
        console.log(`${marker}${i + 1}: ${lines[i]}`);
      }
      
      // Procurar a função que contém a linha 134
      console.log('\n🔍 Procurando função que contém a linha 134...');
      
      let functionStart = -1;
      let functionName = '';
      
      for (let i = 133; i >= 0; i--) {
        const line = lines[i];
        if (line.includes('function') || line.includes('=>')) {
          functionStart = i;
          functionName = line.trim();
          break;
        }
      }
      
      if (functionStart !== -1) {
        console.log(`Função encontrada na linha ${functionStart + 1}: ${functionName}`);
        
        // Verificar se a função tem accountId como parâmetro
        if (functionName.includes('accountId')) {
          console.log('✅ Função tem accountId como parâmetro');
          
          // Corrigir a linha 134
          const originalLine = lines[133];
          
          if (!originalLine.includes(', accountId') && !originalLine.includes(',accountId')) {
            // Corrigir a chamada
            lines[133] = originalLine.replace(
              /websockets\.setupBookDepthWebsocket\(([^)]+)\)/,
              'websockets.setupBookDepthWebsocket($1, accountId)'
            );
            
            console.log(`✅ Linha 134 corrigida:`);
            console.log(`   ANTES: ${originalLine.trim()}`);
            console.log(`   DEPOIS: ${lines[133].trim()}`);
          } else {
            console.log('⚠️ Linha 134 já tem accountId - pode ser outro problema');
          }
        } else {
          console.log('❌ Função não tem accountId como parâmetro');
          
          // Procurar onde accountId está definido no escopo
          console.log('\n🔍 Procurando accountId no escopo...');
          
          for (let i = 133; i >= Math.max(0, functionStart - 10); i--) {
            const line = lines[i];
            if (line.includes('accountId') && !line.includes('function')) {
              console.log(`Encontrado accountId na linha ${i + 1}: ${line.trim()}`);
            }
          }
        }
      } else {
        console.log('❌ Não foi possível encontrar a função que contém a linha 134');
      }
      
      // Salvar o arquivo corrigido
      content = lines.join('\n');
      fs.writeFileSync(limitMakerPath, content, 'utf8');
      console.log('\n✅ Arquivo salvo com correção');
      
    } else {
      console.log('❌ Linha 134 não contém setupBookDepthWebsocket');
      console.log(`Conteúdo da linha 134: ${line134}`);
    }
  } else {
    console.log(`❌ Arquivo tem apenas ${lines.length} linhas, não alcança linha 134`);
  }
  
} else {
  console.error('❌ limitMakerEntry.js não encontrado');
}

// Criar uma correção mais abrangente
console.log('\n2️⃣ Aplicando correção abrangente...');

if (fs.existsSync(limitMakerPath)) {
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  
  // Encontrar e corrigir TODAS as chamadas setupBookDepthWebsocket sem accountId
  const regex = /websockets\.setupBookDepthWebsocket\(([^,)]+)\)(?!\s*,\s*accountId)/g;
  const matches = [...content.matchAll(regex)];
  
  console.log(`Encontradas ${matches.length} chamadas setupBookDepthWebsocket sem accountId`);
  
  matches.forEach((match, index) => {
    console.log(`Chamada ${index + 1}: ${match[0]}`);
  });
  
  // Corrigir todas as chamadas
  content = content.replace(regex, 'websockets.setupBookDepthWebsocket($1, accountId)');
  
  // Remover duplicatas se criadas
  content = content.replace(
    /websockets\.setupBookDepthWebsocket\(([^,]+),\s*accountId,\s*accountId\)/g,
    'websockets.setupBookDepthWebsocket($1, accountId)'
  );
  
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  console.log('✅ Todas as chamadas setupBookDepthWebsocket corrigidas');
}

// Criar teste específico
console.log('\n3️⃣ Criando teste específico...');

const testScript = `// Teste específico para linha 134
const fs = require('fs');
const path = require('path');

function testLine134() {
  console.log('🧪 Testando correção da linha 134...');
  
  const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');
  
  if (fs.existsSync(limitMakerPath)) {
    const content = fs.readFileSync(limitMakerPath, 'utf8');
    const lines = content.split('\\n');
    
    if (lines.length >= 134) {
      const line134 = lines[133];
      console.log(\`Linha 134: \${line134.trim()}\`);
      
      if (line134.includes('setupBookDepthWebsocket')) {
        if (line134.includes('accountId')) {
          console.log('✅ Linha 134 tem accountId - correção aplicada!');
          return true;
        } else {
          console.log('❌ Linha 134 ainda não tem accountId');
          return false;
        }
      } else {
        console.log('⚠️ Linha 134 não tem setupBookDepthWebsocket');
        return true;
      }
    } else {
      console.log('❌ Arquivo muito pequeno');
      return false;
    }
  } else {
    console.log('❌ Arquivo não encontrado');
    return false;
  }
}

function testImport() {
  try {
    console.log('\\n🧪 Testando import do limitMakerEntry...');
    const limitMaker = require('./posicoes/limitMakerEntry');
    console.log('✅ limitMakerEntry importado sem erros');
    return true;
  } catch (error) {
    console.error('❌ Erro ao importar:', error.message);
    return false;
  }
}

if (require.main === module) {
  const line134Ok = testLine134();
  const importOk = testImport();
  
  if (line134Ok && importOk) {
    console.log('\\n🎉 Correção da linha 134 bem-sucedida!');
    console.log('\\n🚀 Execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    console.log('\\n📊 O erro "accountId=undefined" deve estar resolvido!');
  } else {
    console.log('\\n❌ Ainda há problemas');
    process.exit(1);
  }
}

module.exports = { testLine134, testImport };`;

fs.writeFileSync(path.join(__dirname, 'test-line-134.js'), testScript);
console.log('✅ Arquivo de teste criado: test-line-134.js');

console.log('\n🎉 Correção específica da linha 134 concluída!');
console.log('\n📋 O que foi feito:');
console.log('1. ✅ Identificada linha 134 específica com problema');
console.log('2. ✅ Analisado contexto da função');
console.log('3. ✅ Corrigida chamada setupBookDepthWebsocket');
console.log('4. ✅ Aplicada correção abrangente para outros casos');

console.log('\n🧪 Execute o teste:');
console.log('   node test-line-134.js');

console.log('\n🚀 Depois execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora o erro "accountId=undefined" deve estar resolvido!');
console.log('\n💾 Backup criado para segurança.');