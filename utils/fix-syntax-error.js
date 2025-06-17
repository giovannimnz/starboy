const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo erro de sintaxe no websockets.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.syntax.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
}

// Corrigir websockets.js
console.log('1️⃣ Corrigindo erro de sintaxe no websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');
createBackup(websocketsPath);

let websocketsContent = fs.readFileSync(websocketsPath, 'utf8');

// Encontrar e corrigir o erro na linha 440
console.log('🔍 Procurando pelo erro de sintaxe...');

// Procurar por padrões problemáticos
const problematicPatterns = [
  /const accountState = true\);/g,
  /const accountState = getAccountConnectionState\(accountId, true\);/g,
  /getAccountConnectionState\(accountId, true\);/g
];

// Verificar e corrigir cada padrão
let fixed = false;

// Corrigir o padrão específico do erro
websocketsContent = websocketsContent.replace(
  /const accountState = true\);/g,
  'const accountState = getAccountConnectionState(accountId, true);'
);

// Corrigir outros possíveis problemas similares
websocketsContent = websocketsContent.replace(
  /getAccountConnectionState\(accountId, true\);(?!\s*;)/g,
  'getAccountConnectionState(accountId, true);'
);

// Verificar se há outros problemas de sintaxe comuns
const syntaxProblems = [
  { pattern: /\(\s*true\s*\)\s*;/, replacement: '(accountId, true);' },
  { pattern: /getAccountConnectionState\(\s*,\s*true\s*\)/, replacement: 'getAccountConnectionState(accountId, true)' },
  { pattern: /const\s+\w+\s+=\s+true\s*\);/, replacement: match => {
    const varName = match.match(/const\s+(\w+)\s+=/)[1];
    return `const ${varName} = getAccountConnectionState(accountId, true);`;
  }}
];

syntaxProblems.forEach(problem => {
  if (websocketsContent.match(problem.pattern)) {
    console.log(`🔧 Corrigindo padrão: ${problem.pattern}`);
    if (typeof problem.replacement === 'function') {
      websocketsContent = websocketsContent.replace(problem.pattern, problem.replacement);
    } else {
      websocketsContent = websocketsContent.replace(problem.pattern, problem.replacement);
    }
    fixed = true;
  }
});

// Verificar especificamente por problemas na área da linha 440
const lines = websocketsContent.split('\n');
let lineNumber = 0;
let foundSyntaxError = false;

for (let i = 0; i < lines.length; i++) {
  lineNumber = i + 1;
  const line = lines[i];
  
  // Procurar por sintaxe problemática
  if (line.includes('const accountState = true);') || 
      line.includes('= true);') || 
      line.match(/=\s*true\s*\);/)) {
    
    console.log(`🚨 Erro de sintaxe encontrado na linha ${lineNumber}: ${line.trim()}`);
    
    // Tentar corrigir automaticamente
    if (line.includes('const accountState = true);')) {
      lines[i] = line.replace('const accountState = true);', 'const accountState = getAccountConnectionState(accountId, true);');
      console.log(`✅ Linha ${lineNumber} corrigida para: ${lines[i].trim()}`);
      foundSyntaxError = true;
      fixed = true;
    } else if (line.match(/const\s+\w+\s+=\s*true\s*\);/)) {
      const varMatch = line.match(/const\s+(\w+)\s+=/);
      if (varMatch) {
        const varName = varMatch[1];
        lines[i] = line.replace(/const\s+\w+\s+=\s*true\s*\);/, `const ${varName} = getAccountConnectionState(accountId, true);`);
        console.log(`✅ Linha ${lineNumber} corrigida para: ${lines[i].trim()}`);
        foundSyntaxError = true;
        fixed = true;
      }
    }
  }
  
  // Procurar por outros problemas comuns
  if (line.includes('getAccountConnectionState(, true)') || 
      line.includes('getAccountConnectionState( , true)')) {
    lines[i] = line.replace(/getAccountConnectionState\(\s*,\s*true\s*\)/, 'getAccountConnectionState(accountId, true)');
    console.log(`✅ Linha ${lineNumber} corrigida para: ${lines[i].trim()}`);
    foundSyntaxError = true;
    fixed = true;
  }
}

if (foundSyntaxError) {
  websocketsContent = lines.join('\n');
}

// Verificar se ainda há problemas de sintaxe óbvios
const remainingIssues = [];
const criticalPatterns = [
  /const\s+\w+\s+=\s*true\s*\);/,
  /=\s*true\s*\);/,
  /getAccountConnectionState\(\s*,/,
  /\(\s*true\s*\)\s*;(?![^(]*\))/
];

criticalPatterns.forEach((pattern, index) => {
  const matches = websocketsContent.match(pattern);
  if (matches) {
    remainingIssues.push(`Padrão ${index + 1}: ${pattern} - ${matches.length} ocorrências`);
  }
});

if (remainingIssues.length > 0) {
  console.log('⚠️ Possíveis problemas restantes:');
  remainingIssues.forEach(issue => console.log(`  - ${issue}`));
}

// Salvar o arquivo corrigido
fs.writeFileSync(websocketsPath, websocketsContent, 'utf8');

if (fixed) {
  console.log('✅ websockets.js corrigido com sucesso!');
} else {
  console.log('🔍 Nenhum erro óbvio encontrado para correção automática');
  
  // Mostrar as linhas ao redor da linha 440 para diagnóstico manual
  const lines = websocketsContent.split('\n');
  if (lines.length >= 440) {
    console.log('\n📝 Contexto da linha 440:');
    for (let i = Math.max(0, 437); i <= Math.min(lines.length - 1, 443); i++) {
      const lineNum = i + 1;
      const marker = lineNum === 440 ? '>>> ' : '    ';
      console.log(`${marker}${lineNum}: ${lines[i]}`);
    }
  }
}

console.log('\n🎉 Correção de sintaxe concluída!');
console.log('\n🚀 Teste novamente:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backup criado em caso de problemas.');