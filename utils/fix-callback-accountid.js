const fs = require('fs');
const path = require('path');

console.log('🔧 CORREÇÃO EXATA: setupBookDepthWebsocket com callback...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.callback.${Date.now()}`;
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
  
  console.log('1️⃣ Lendo arquivo limitMakerEntry.js...');
  let content = fs.readFileSync(limitMakerPath, 'utf8');
  
  console.log('2️⃣ Analisando linha 134...');
  const lines = content.split('\n');
  
  if (lines.length >= 134) {
    const line134 = lines[133];
    console.log(`LINHA 134 ATUAL: ${line134}`);
    
    if (line134.includes('setupBookDepthWebsocket') && line134.includes('(depthData, accountId) =>')) {
      console.log('✅ Encontrada chamada com callback function');
      console.log('❌ PROBLEMA: Falta accountId como terceiro parâmetro');
      
      // Mostrar contexto para entender melhor
      console.log('\nContexto (linhas 130-140):');
      for (let i = 129; i <= 139 && i < lines.length; i++) {
        const marker = i === 133 ? ' --> ' : '     ';
        console.log(`${marker}${i + 1}: ${lines[i]}`);
      }
      
      // A correção específica para este caso
      console.log('\n3️⃣ Aplicando correção específica...');
      
      // Padrão: setupBookDepthWebsocket(symbol, callback) 
      // Precisa ser: setupBookDepthWebsocket(symbol, callback, accountId)
      
      const originalLine = lines[133];
      
      // Procurar o final da função callback para adicionar accountId
      let correctedLine = originalLine;
      
      // Verificar se é uma arrow function que continua nas próximas linhas
      if (originalLine.includes('=>') && originalLine.trim().endsWith('{')) {
        // Arrow function que abre chaves - precisa encontrar onde fecha
        console.log('Arrow function detectada que continua nas próximas linhas');
        
        let braceCount = 1; // Começamos com 1 porque a linha atual abre uma chave
        let endLine = 133;
        
        // Procurar onde a função fecha
        for (let i = 134; i < lines.length && braceCount > 0; i++) {
          const line = lines[i];
          braceCount += (line.match(/\{/g) || []).length;
          braceCount -= (line.match(/\}/g) || []).length;
          
          if (braceCount === 0) {
            endLine = i;
            break;
          }
        }
        
        console.log(`Função callback termina na linha ${endLine + 1}`);
        
        // Modificar a linha onde a função fecha para adicionar accountId
        if (endLine < lines.length) {
          const closeLine = lines[endLine];
          console.log(`Linha de fechamento: ${closeLine}`);
          
          // Adicionar accountId após o fechamento da função
          if (closeLine.includes('});') || closeLine.includes('}),')) {
            lines[endLine] = closeLine.replace(/\}\);?/, '}, accountId);');
            console.log(`✅ Linha ${endLine + 1} corrigida: ${lines[endLine]}`);
          } else if (closeLine.trim() === '}') {
            lines[endLine] = closeLine.replace(/\}/, '}, accountId);');
            console.log(`✅ Linha ${endLine + 1} corrigida: ${lines[endLine]}`);
          }
        }
      } else {
        // Caso mais simples - função inline
        console.log('Função inline detectada');
        
        // Adicionar accountId antes do último parêntese
        correctedLine = originalLine.replace(/\)\s*;?\s*$/, ', accountId);');
        lines[133] = correctedLine;
        console.log(`✅ Linha 134 corrigida: ${correctedLine}`);
      }
    }
  }
  
  console.log('\n4️⃣ Aplicando correção abrangente...');
  
  // Reconstituir conteúdo
  content = lines.join('\n');
  
  // Correção abrangente para padrões similares
  // setupBookDepthWebsocket(symbol, (callback) => { ... })
  // deve ser: setupBookDepthWebsocket(symbol, (callback) => { ... }, accountId)
  
  const callbackPattern = /websockets\.setupBookDepthWebsocket\(\s*([^,]+),\s*\([^)]*\)\s*=>\s*\{[^}]*\}\s*\)/g;
  
  content = content.replace(callbackPattern, (match) => {
    if (!match.includes(', accountId')) {
      return match.replace(/\}\s*\)$/, '}, accountId)');
    }
    return match;
  });
  
  console.log('\n5️⃣ Salvando arquivo corrigido...');
  fs.writeFileSync(limitMakerPath, content, 'utf8');
  console.log('✅ Arquivo salvo');
  
} else {
  console.error('❌ limitMakerEntry.js não encontrado');
}

// Criar teste específico para este caso
console.log('\n6️⃣ Criando teste específico...');

const testScript = `// Teste específico para callback com accountId
const fs = require('fs');

function testCallbackCorrection() {
  console.log('🧪 Testando correção do callback...');
  
  try {
    const content = fs.readFileSync('./posicoes/limitMakerEntry.js', 'utf8');
    const lines = content.split('\\n');
    
    if (lines.length >= 134) {
      console.log('Linha 134:');
      console.log(lines[133]);
      
      // Procurar por padrões problemáticos
      const problematicPatterns = [
        /setupBookDepthWebsocket\\([^,]+,\\s*\\([^)]*\\)\\s*=>.*\\}\\s*\\)(?!.*accountId)/g,
        /setupBookDepthWebsocket\\([^,]+,\\s*function.*\\}\\s*\\)(?!.*accountId)/g
      ];
      
      let hasProblems = false;
      
      problematicPatterns.forEach((pattern, index) => {
        const matches = [...content.matchAll(pattern)];
        if (matches.length > 0) {
          console.log(\`❌ Padrão problemático \${index + 1}: \${matches.length} ocorrências\`);
          matches.forEach(match => {
            console.log(\`  \${match[0].substring(0, 80)}...\`);
          });
          hasProblems = true;
        }
      });
      
      if (!hasProblems) {
        console.log('✅ Nenhum padrão problemático encontrado');
      }
      
      // Testar import
      const limitMaker = require('./posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry importado sem erro');
      
      return !hasProblems;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return false;
  }
}

if (require.main === module) {
  if (testCallbackCorrection()) {
    console.log('\\n🎉 Correção do callback aplicada!');
    console.log('\\n🚀 Execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    console.log('\\n📊 setupBookDepthWebsocket deve receber accountId como 3º parâmetro!');
  } else {
    console.log('\\n❌ Ainda há problemas com callbacks');
  }
}`;

fs.writeFileSync(path.join(__dirname, 'test-callback.js'), testScript);

console.log('\n🎉 CORREÇÃO DO CALLBACK APLICADA!');
console.log('\n📋 O problema era:');
console.log('❌ setupBookDepthWebsocket(symbol, callback)');
console.log('✅ setupBookDepthWebsocket(symbol, callback, accountId)');

console.log('\n🧪 Teste a correção:');
console.log('   node test-callback.js');

console.log('\n🚀 Execute o monitoramento:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n🎯 Agora setupBookDepthWebsocket deve receber accountId corretamente!');
console.log('\n💾 Backup criado para segurança.');