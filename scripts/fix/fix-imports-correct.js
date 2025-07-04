// scripts/migration/fix-imports-correct.js
const fs = require('fs');
const path = require('path');

// Mapeamentos corretos baseados na estrutura real
const importMappings = {
  // Database paths (os mais comuns)
  '../core/database/conexao': '../../../core/database/conexao',
  '../../core/database/conexao': '../../../core/database/conexao',
  '../../../core/database/conexao': '../../../core/database/conexao',
  
  // API paths para services (contexto: backend/exchanges/binance/services/)
  '../exchanges/binance/api/rest': '../api/rest',
  '../exchanges/binance/api/websocket': '../api/websocket',
  
  // API paths para api (contexto: backend/exchanges/binance/api/)
  '../core/database/conexao': '../../../core/database/conexao',
  '../exchanges/binance/api/rest': './rest',
  
  // Imports dentro de services (mesmo diretório)
  './orderHandlers': './orderHandlers',
  './accountHandlers': './accountHandlers',
  './enhancedMonitoring': './enhancedMonitoring',
  './positionSync': './positionSync',
  './positionHistory': './positionHistory',
  './cleanup': './cleanup',
  './monitoramento': './monitoramento',
  './telegramBot': './telegramBot',
  './priceMonitoring': './priceMonitoring',
  './signalProcessor': './signalProcessor',
  './signalTimeout': './signalTimeout',
  './trailingStopLoss': './trailingStopLoss',
  './limitMakerEntry': './limitMakerEntry'
};

function getCorrectPath(currentFilePath, importPath) {
  const relativePath = path.relative(process.cwd(), currentFilePath);
  
  // Para arquivos em backend/exchanges/binance/services/
  if (relativePath.includes('backend/exchanges/binance/services/')) {
    switch (importPath) {
      case '../../core/database/conexao':
        return '../../../core/database/conexao';
      case '../exchanges/binance/api/rest':
        return '../api/rest';
      case '../exchanges/binance/api/websocket':
        return '../api/websocket';
      default:
        return importPath;
    }
  }
  
  // Para arquivos em backend/exchanges/binance/api/
  if (relativePath.includes('backend/exchanges/binance/api/')) {
    switch (importPath) {
      case '../core/database/conexao':
        return '../../../core/database/conexao';
      case '../exchanges/binance/api/rest':
        return './rest';
      default:
        return importPath;
    }
  }
  
  return importPath;
}

function updateFileImports(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`⏭️ Arquivo não encontrado: ${filePath}`);
      return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    const relativePath = path.relative(process.cwd(), filePath);

    console.log(`🔍 Processando: ${relativePath}`);

    // Padrões para encontrar requires e imports
    const requirePattern = /require\(['"]([^'"]+)['"]\)/g;
    const importPattern = /from ['"]([^'"]+)['"]/g;

    // Processar requires
    content = content.replace(requirePattern, (match, importPath) => {
      if (importPath.startsWith('.')) {
        const correctPath = getCorrectPath(filePath, importPath);
        if (correctPath !== importPath) {
          console.log(`  ✅ Require: ${importPath} → ${correctPath}`);
          modified = true;
          return `require('${correctPath}')`;
        }
      }
      return match;
    });

    // Processar imports ES6
    content = content.replace(importPattern, (match, importPath) => {
      if (importPath.startsWith('.')) {
        const correctPath = getCorrectPath(filePath, importPath);
        if (correctPath !== importPath) {
          console.log(`  ✅ Import: ${importPath} → ${correctPath}`);
          modified = true;
          return `from '${correctPath}'`;
        }
      }
      return match;
    });

    // Salvar se modificado
    if (modified) {
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`💾 Arquivo atualizado: ${relativePath}`);
    } else {
      console.log(`➖ Nenhuma alteração necessária: ${relativePath}`);
    }

  } catch (error) {
    console.error(`❌ Erro ao processar ${filePath}:`, error.message);
  }
}

function processDirectory(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      console.log(`⏭️ Diretório não encontrado: ${dirPath}`);
      return;
    }

    const items = fs.readdirSync(dirPath);
    
    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const stats = fs.statSync(fullPath);
      
      if (stats.isDirectory()) {
        if (!['node_modules', '.git'].includes(item)) {
          processDirectory(fullPath);
        }
      } else if (stats.isFile() && fullPath.endsWith('.js')) {
        updateFileImports(fullPath);
      }
    }
  } catch (error) {
    console.error(`❌ Erro ao processar diretório ${dirPath}:`, error.message);
  }
}

function main() {
  console.log('🚀 Corrigindo imports quebrados...\n');
  
  // Processar apenas o diretório backend que tem os problemas
  processDirectory('backend');
  
  console.log('\n✅ Correção de imports concluída!');
}

// Executar
main();