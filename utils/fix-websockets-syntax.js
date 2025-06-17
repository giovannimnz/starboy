const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo erro específico na linha 1099 do websockets.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.line1099.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
}

// Corrigir websockets.js
console.log('1️⃣ Corrigindo websockets.js linha 1099...');
const websocketsPath = path.join(__dirname, 'websockets.js');
createBackup(websocketsPath);

let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');
const lines = websocketsContent.split('\n');

console.log(`📊 Total de linhas no arquivo: ${lines.length}`);

// Encontrar e corrigir o erro na linha 1099
if (lines.length >= 1099) {
  const problematicLine = lines[1098]; // Array é 0-indexed
  console.log(`🚨 Linha 1099 problemática: "${problematicLine}"`);
  
  // Verificar se é realmente o erro esperado
  if (problematicLine.includes("const accountState = 'Graceful shutdown');")) {
    console.log('✅ Erro identificado: linha mal formada');
    
    // Corrigir a linha
    lines[1098] = "    const accountState = getAccountConnectionState(accountId);";
    console.log(`🔧 Linha corrigida para: "${lines[1098]}"`);
  } else {
    // Procurar por outras variações do erro
    console.log('🔍 Procurando por outras variações do erro...');
    
    for (let i = Math.max(0, 1095); i < Math.min(lines.length, 1105); i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      
      // Procurar por padrões problemáticos
      if (line.includes("= 'Graceful shutdown');") || 
          line.includes("const accountState = '") ||
          line.match(/const\s+\w+\s+=\s*'[^']*'\s*\);/)) {
        
        console.log(`🚨 Erro encontrado na linha ${lineNumber}: "${line}"`);
        
        // Tentar corrigir baseado no contexto
        if (line.includes('accountState')) {
          lines[i] = "    const accountState = getAccountConnectionState(accountId);";
          console.log(`✅ Linha ${lineNumber} corrigida para: "${lines[i]}"`);
        } else {
          // Comentar a linha problemática
          lines[i] = `    // LINHA PROBLEMÁTICA COMENTADA: ${line}`;
          console.log(`⚠️ Linha ${lineNumber} comentada: "${lines[i]}"`);
        }
      }
    }
  }
  
  // Mostrar contexto ao redor da linha 1099
  console.log('\n📝 Contexto ao redor da linha 1099:');
  for (let i = Math.max(0, 1095); i <= Math.min(lines.length - 1, 1103); i++) {
    const lineNum = i + 1;
    const marker = lineNum === 1099 ? '>>> ' : '    ';
    console.log(`${marker}${lineNum}: ${lines[i]}`);
  }
  
} else {
  console.log(`⚠️ Arquivo tem apenas ${lines.length} linhas, menor que 1099`);
  
  // Procurar por padrões problemáticos em todo o arquivo
  console.log('🔍 Procurando por padrões problemáticos em todo o arquivo...');
  let foundErrors = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // Procurar por padrões específicos problemáticos
    if (line.includes("= 'Graceful shutdown');") || 
        line.match(/const\s+\w+\s+=\s*'[^']*'\s*\);/) ||
        line.includes("const accountState = '")) {
      
      console.log(`🚨 Erro encontrado na linha ${lineNumber}: "${line.trim()}"`);
      
      // Corrigir baseado no padrão
      if (line.includes('accountState')) {
        lines[i] = line.replace(/const accountState = '[^']*'\);?/, 'const accountState = getAccountConnectionState(accountId);');
      } else {
        lines[i] = `    // LINHA PROBLEMÁTICA COMENTADA: ${line.trim()}`;
      }
      
      console.log(`✅ Corrigida para: "${lines[i].trim()}"`);
      foundErrors++;
    }
  }
  
  console.log(`📊 Total de erros encontrados e corrigidos: ${foundErrors}`);
}

// Verificar se há outros problemas de sintaxe óbvios
console.log('\n🔍 Verificando outros problemas de sintaxe...');

const criticalPatterns = [
  /const\s+\w+\s+=\s*'[^']*'\s*\);/,
  /=\s*'[^']*'\s*\);/,
  /getAccountConnectionState\(\s*'[^']*'\s*\)/,
  /'[^']*'\s*\);?\s*$/
];

let totalIssues = 0;
criticalPatterns.forEach((pattern, index) => {
  const matches = websocketsContent.match(pattern);
  if (matches) {
    console.log(`⚠️ Padrão ${index + 1} encontrado: ${pattern}`);
    totalIssues++;
  }
});

// Salvar o arquivo corrigido
const correctedContent = lines.join('\n');
fs.writeFileSync(websocketsPath, correctedContent, 'utf8');

console.log('\n🎉 Correção concluída!');
console.log(`📝 Problemas encontrados e corrigidos: ${totalIssues > 0 ? 'SIM' : 'Verificação manual necessária'}`);

console.log('\n🚀 Teste novamente:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backup salvo em caso de problemas.');

// Tentar validar a sintaxe básica do arquivo corrigido
console.log('\n🔍 Validando sintaxe básica...');
try {
  // Verificar se há parênteses desbalanceados óbvios
  const openParens = (correctedContent.match(/\(/g) || []).length;
  const closeParens = (correctedContent.match(/\)/g) || []).length;
  const openBraces = (correctedContent.match(/\{/g) || []).length;
  const closeBraces = (correctedContent.match(/\}/g) || []).length;
  
  console.log(`📊 Parênteses: ${openParens} abertos, ${closeParens} fechados`);
  console.log(`📊 Chaves: ${openBraces} abertas, ${closeBraces} fechadas`);
  
  if (openParens === closeParens && openBraces === closeBraces) {
    console.log('✅ Sintaxe básica parece estar correta');
  } else {
    console.log('⚠️ Possível problema de sintaxe detectado');
  }
} catch (syntaxError) {
  console.log('⚠️ Erro ao validar sintaxe:', syntaxError.message);
}