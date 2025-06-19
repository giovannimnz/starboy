const fs = require('fs');
const path = require('path');

function fixLimitMakerEntry() {
  const filePath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');
  
  try {
    console.log('🔧 Corrigindo erro de sintaxe no limitMakerEntry.js...');
    
    let content = fs.readFileSync(filePath, 'utf8');
    
    // Verificar se há catch sem try correspondente
    const lines = content.split('\n');
    let fixedLines = [];
    let inTryBlock = false;
    let tryDepth = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;
      
      // Detectar início de try
      if (line.includes('try {')) {
        inTryBlock = true;
        tryDepth++;
        fixedLines.push(line);
        continue;
      }
      
      // Detectar catch
      if (line.includes('} catch (')) {
        if (!inTryBlock || tryDepth === 0) {
          console.log(`⚠️ Catch sem try correspondente na linha ${lineNumber}`);
          console.log(`   Linha: ${line.trim()}`);
          
          // Adicionar try antes do catch
          const indentation = line.match(/^(\s*)/)[1];
          fixedLines.push(`${indentation}try {`);
          tryDepth++;
        }
        tryDepth--;
        if (tryDepth === 0) {
          inTryBlock = false;
        }
        fixedLines.push(line);
        continue;
      }
      
      // Detectar finally
      if (line.includes('} finally {')) {
        tryDepth--;
        if (tryDepth === 0) {
          inTryBlock = false;
        }
        fixedLines.push(line);
        continue;
      }
      
      fixedLines.push(line);
    }
    
    const fixedContent = fixedLines.join('\n');
    
    // Criar backup
    const backupPath = filePath + '.backup.' + Date.now();
    fs.writeFileSync(backupPath, content);
    console.log(`📄 Backup criado: ${backupPath}`);
    
    // Salvar versão corrigida
    fs.writeFileSync(filePath, fixedContent);
    console.log('✅ Arquivo corrigido com sucesso!');
    
    return true;
    
  } catch (error) {
    console.error('❌ Erro ao corrigir arquivo:', error.message);
    return false;
  }
}

if (require.main === module) {
  fixLimitMakerEntry();
}

module.exports = { fixLimitMakerEntry };