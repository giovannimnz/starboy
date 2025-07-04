const fs = require('fs');
const path = require('path');

// Mapeamento completo de todas as mudanças de paths
const importMappings = {
  // APIs principais
  './api': '../exchanges/binance/api/rest',
  '../api': '../exchanges/binance/api/rest',
  '../../api': '../exchanges/binance/api/rest',
  '../../../api': '../exchanges/binance/api/rest',
  './websockets': '../exchanges/binance/api/websocket',
  '../websockets': '../exchanges/binance/api/websocket',
  '../../websockets': '../exchanges/binance/api/websocket',

  // Database
  './db/conexao': '../core/database/conexao',
  '../db/conexao': '../core/database/conexao',
  '../../db/conexao': '../core/database/conexao',
  './db/createDb': '../core/database/createDb',
  '../db/createDb': '../core/database/createDb',

  // Posicoes para Services (Binance)
  './posicoes/': '../exchanges/binance/services/',
  '../posicoes/': '../exchanges/binance/services/',
  '../../posicoes/': '../exchanges/binance/services/',
  './posicoes': '../exchanges/binance/services',
  '../posicoes': '../exchanges/binance/services',

  // Arquivos específicos de posicoes
  './posicoes/orderHandlers': '../exchanges/binance/services/orderHandlers',
  './posicoes/accountHandlers': '../exchanges/binance/services/accountHandlers',
  './posicoes/enhancedMonitoring': '../exchanges/binance/services/enhancedMonitoring',
  './posicoes/positionSync': '../exchanges/binance/services/positionSync',
  './posicoes/positionHistory': '../exchanges/binance/services/positionHistory',
  './posicoes/cleanup': '../exchanges/binance/services/cleanup',
  './posicoes/monitoramento': '../exchanges/binance/services/monitoramento',
  './posicoes/telegramBot': '../exchanges/binance/services/telegramBot',
  './posicoes/priceMonitoring': '../exchanges/binance/services/priceMonitoring',
  './posicoes/signalProcessor': '../exchanges/binance/services/signalProcessor',
  './posicoes/signalTimeout': '../exchanges/binance/services/signalTimeout',

  // Indicadores
  './indicadores/': '../indicators/',
  '../indicadores/': '../indicators/',
  '../../indicadores/': '../indicators/',
  
  // Utils
  './utils/': '../../shared/utils/',
  '../utils/': '../../shared/utils/',
  '../../utils/': '../../shared/utils/',

  // App e processos
  './app': '../server/app',
  './instanceManager': '../processes/instanceManager',
  './rateLimitMonitor': '../processes/rateLimitMonitor'
};

// Mapeamentos para paths internos dentro de services
const internalServiceMappings = {
  '../orderHandlers': './orderHandlers',
  '../accountHandlers': './accountHandlers', 
  '../enhancedMonitoring': './enhancedMonitoring',
  '../positionSync': './positionSync',
  '../positionHistory': './positionHistory',
  '../cleanup': './cleanup',
  '../monitoramento': './monitoramento',
  '../telegramBot': './telegramBot',
  '../priceMonitoring': './priceMonitoring',
  '../signalProcessor': './signalProcessor',
  '../signalTimeout': './signalTimeout'
};

function updateFileImports(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      console.log(`⏭️ Arquivo não encontrado: ${filePath}`);
      return;
    }

    let content = fs.readFileSync(filePath, 'utf8');
    let modified = false;

    // Determinar contexto do arquivo para escolher mapeamentos corretos
    const relativePath = path.relative(process.cwd(), filePath);
    const isInServices = relativePath.includes('backend/exchanges/binance/services/');
    
    console.log(`🔍 Processando: ${relativePath}`);

    // Aplicar mapeamentos apropriados
    const mappingsToUse = isInServices ? 
      { ...importMappings, ...internalServiceMappings } : 
      importMappings;

    // Atualizar requires
    for (const [oldPath, newPath] of Object.entries(mappingsToUse)) {
      const patterns = [
        new RegExp(`require\\(['"]${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]\\)`, 'g'),
        new RegExp(`require\\(['"]${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^'"]+)['"]\\)`, 'g'),
        new RegExp(`from ['"]${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`, 'g'),
        new RegExp(`from ['"]${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^'"]+)['"]`, 'g')
      ];

      patterns.forEach((pattern, index) => {
        const oldContent = content;
        
        if (index % 2 === 0) {
          // Padrões sem arquivo específico
          content = content.replace(pattern, (match) => {
            if (match.includes('require')) {
              return `require('${newPath}')`;
            } else {
              return `from '${newPath}'`;
            }
          });
        } else {
          // Padrões com arquivo específico
          content = content.replace(pattern, (match, filename) => {
            if (match.includes('require')) {
              return `require('${newPath}/${filename}')`;
            } else {
              return `from '${newPath}/${filename}'`;
            }
          });
        }

        if (oldContent !== content) {
          modified = true;
          console.log(`  ✅ Atualizado: ${oldPath} → ${newPath}`);
        }
      });
    }

    // Correções específicas adicionais
    const specificCorrections = [
      // Database paths
      [/require\(['"]\.\.\/backend\/core\/database\/conexao['"]\)/g, "require('../../core/database/conexao')"],
      [/require\(['"]\.\.\/\.\.\/backend\/core\/database\/conexao['"]\)/g, "require('../core/database/conexao')"],
      
      // API paths para diferentes contextos
      [/require\(['"]\.\.\/backend\/exchanges\/binance\/api\/rest['"]\)/g, "require('../../exchanges/binance/api/rest')"],
      [/require\(['"]\.\.\/\.\.\/backend\/exchanges\/binance\/api\/rest['"]\)/g, "require('../exchanges/binance/api/rest')"],
      
      // Websockets
      [/require\(['"]\.\.\/backend\/exchanges\/binance\/api\/websocket['"]\)/g, "require('../../exchanges/binance/api/websocket')"],
      
      // Services internos
      [/require\(['"]\.\/backend\/exchanges\/binance\/services\//g, "require('./"],
    ];

    specificCorrections.forEach(([pattern, replacement]) => {
      const oldContent = content;
      content = content.replace(pattern, replacement);
      if (oldContent !== content) {
        modified = true;
        console.log(`  ✅ Correção específica aplicada`);
      }
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

function processDirectory(dirPath, extensions = ['.js', '.json']) {
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
        // Pular node_modules e .git
        if (!['node_modules', '.git', '.env'].includes(item)) {
          processDirectory(fullPath, extensions);
        }
      } else if (stats.isFile()) {
        const ext = path.extname(item);
        if (extensions.includes(ext)) {
          updateFileImports(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`❌ Erro ao processar diretório ${dirPath}:`, error.message);
  }
}

function main() {
  console.log('🚀 Iniciando correção de imports após migração...\n');

  // Processar todos os diretórios relevantes
  const directoriesToProcess = [
    'backend',
    'scripts',
    'tests',
    // Processar arquivos raiz também
    '.'
  ];

  directoriesToProcess.forEach(dir => {
    console.log(`\n📁 Processando diretório: ${dir}`);
    if (dir === '.') {
      // Para raiz, processar apenas arquivos específicos
      const rootFiles = ['package.json', 'fixSyntaxError.js', 'websocketApi.js'];
      rootFiles.forEach(file => {
        if (fs.existsSync(file)) {
          updateFileImports(file);
        }
      });
    } else {
      processDirectory(dir);
    }
  });

  console.log('\n✅ Correção de imports concluída!');
  console.log('\n📋 Próximos passos:');
  console.log('1. ✅ Testar se todas as funcionalidades ainda funcionam');
  console.log('2. ✅ Verificar se há imports órfãos restantes');
  console.log('3. ✅ Executar testes: npm test');
  console.log('4. ✅ Verificar logs de erro em runtime');
}

// Executar
main();