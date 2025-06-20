const fs = require('fs');
const path = require('path');

function findBrokenImports(dirPath) {
  const brokenImports = [];
  
  function processFile(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Buscar requires e imports
        const requireMatch = line.match(/require\(['"]([^'"]+)['"]\)/);
        const importMatch = line.match(/from ['"]([^'"]+)['"]/);
        
        const importPath = requireMatch?.[1] || importMatch?.[1];
        
        if (importPath && importPath.startsWith('.')) {
          // Resolver path relativo
          const resolvedPath = path.resolve(path.dirname(filePath), importPath);
          const possiblePaths = [
            resolvedPath,
            resolvedPath + '.js',
            path.join(resolvedPath, 'index.js')
          ];
          
          const exists = possiblePaths.some(p => fs.existsSync(p));
          
          if (!exists) {
            brokenImports.push({
              file: path.relative(process.cwd(), filePath),
              line: index + 1,
              import: importPath,
              fullLine: line.trim()
            });
          }
        }
      });
    } catch (error) {
      console.error(`Erro ao processar ${filePath}:`, error.message);
    }
  }
  
  function processDirectory(dir) {
    try {
      const items = fs.readdirSync(dir);
      
      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stats = fs.statSync(fullPath);
        
        if (stats.isDirectory() && !['node_modules', '.git'].includes(item)) {
          processDirectory(fullPath);
        } else if (stats.isFile() && fullPath.endsWith('.js')) {
          processFile(fullPath);
        }
      }
    } catch (error) {
      console.error(`Erro ao processar diretório ${dir}:`, error.message);
    }
  }
  
  processDirectory(dirPath);
  return brokenImports;
}

console.log('🔍 Verificando imports quebrados...\n');

const brokenImports = findBrokenImports('backend');

if (brokenImports.length === 0) {
  console.log('✅ Nenhum import quebrado encontrado!');
} else {
  console.log(`❌ Encontrados ${brokenImports.length} imports quebrados:\n`);
  
  brokenImports.forEach(({ file, line, import: imp, fullLine }) => {
    console.log(`📁 ${file}:${line}`);
    console.log(`   ${fullLine}`);
    console.log(`   ❌ Import não encontrado: ${imp}\n`);
  });
}