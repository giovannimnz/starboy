const fs = require('fs').promises;
const path = require('path');

const migrations = [
  // Database
  { from: 'db/', to: 'backend/core/database/', type: 'directory' },
  
  // Binance específico
  { from: 'api.js', to: 'backend/exchanges/binance/api/rest.js', type: 'file' },
  { from: 'websockets.js', to: 'backend/exchanges/binance/api/websocket.js', type: 'file' },
  { from: 'posicoes/', to: 'backend/exchanges/binance/services/', type: 'directory' },
  
  // Indicadores (Python - universal)
  { from: 'indicadores/', to: 'backend/indicators/', type: 'directory' },
  
  // Processos
  { from: 'app.js', to: 'backend/server/app.js', type: 'file' },
  { from: 'instanceManager.js', to: 'backend/processes/instanceManager.js', type: 'file' },
  { from: 'rateLimitMonitor.js', to: 'backend/processes/rateLimitMonitor.js', type: 'file' },
  
  // Utils e backups
  { from: 'utils/', to: 'shared/utils/', type: 'directory' },
  { from: 'tests/', to: 'backend/tests/', type: 'directory' },
];

async function ensureDirectoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (error) {
    if (error.code !== 'EEXIST') {
      throw error;
    }
  }
}

async function copyDirectory(src, dest) {
  await ensureDirectoryExists(dest);
  
  const entries = await fs.readdir(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function removeDirectory(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        await removeDirectory(fullPath);
      } else {
        await fs.unlink(fullPath);
      }
    }
    
    await fs.rmdir(dirPath);
  } catch (error) {
    console.warn(`⚠️ Aviso: Não foi possível remover ${dirPath}:`, error.message);
  }
}

async function migrateItem(migration) {
  const { from, to, type } = migration;
  
  try {
    // Verificar se o arquivo/diretório origem existe
    try {
      await fs.access(from);
    } catch {
      console.log(`⏭️ Pulando ${from} (não existe)`);
      return;
    }
    
    // Criar diretório destino se necessário
    const destDir = path.dirname(to);
    await ensureDirectoryExists(destDir);
    
    if (type === 'directory') {
      // Para diretórios: copiar e depois remover
      console.log(`📁 Copiando diretório: ${from} → ${to}`);
      await copyDirectory(from, to);
      
      console.log(`🗑️ Removendo diretório original: ${from}`);
      await removeDirectory(from);
      
    } else {
      // Para arquivos: tentar rename primeiro, senão copiar e remover
      try {
        await fs.rename(from, to);
      } catch (renameError) {
        if (renameError.code === 'EPERM' || renameError.code === 'EXDEV') {
          // Se rename falhar, copiar e remover
          console.log(`📄 Copiando arquivo: ${from} → ${to}`);
          await fs.copyFile(from, to);
          await fs.unlink(from);
        } else {
          throw renameError;
        }
      }
    }
    
    console.log(`✅ Migrado: ${from} → ${to}`);
    
  } catch (error) {
    console.error(`❌ Erro ao migrar ${from}:`, error.message);
    
    // Se falhar, tentar pelo menos copiar
    try {
      console.log(`🔄 Tentando apenas copiar: ${from} → ${to}`);
      if (type === 'directory') {
        await copyDirectory(from, to);
      } else {
        await fs.copyFile(from, to);
      }
      console.log(`✅ Copiado (original mantido): ${from} → ${to}`);
    } catch (copyError) {
      console.error(`❌ Falha total para ${from}:`, copyError.message);
    }
  }
}

async function createNewDirectoryStructure() {
  console.log('🏗️ Criando nova estrutura de diretórios...');
  
  const directories = [
    'backend/core/database',
    'backend/core/websockets', 
    'backend/core/utils',
    'backend/core/config',
    'backend/exchanges/binance/api',
    'backend/exchanges/binance/services',
    'backend/exchanges/binance/handlers',
    'backend/exchanges/binance/strategies',
    'backend/exchanges/binance/monitoring',
    'backend/exchanges/binance/telegram',
    'backend/exchanges/bybit/api',
    'backend/exchanges/okx/api',
    'backend/indicators/analysis',
    'backend/indicators/shared',
    'backend/indicators/backtest',
    'backend/server/routes/api',
    'backend/server/routes/webhook',
    'backend/server/middleware',
    'backend/server/controllers',
    'backend/processes',
    'backend/tests/unit',
    'backend/tests/integration',
    'frontend/src/components/exchanges',
    'frontend/src/components/common',
    'frontend/src/views',
    'frontend/src/stores',
    'frontend/src/services',
    'shared/types',
    'shared/constants',
    'shared/utils/backups',
    'docs/exchanges',
    'config',
    'scripts/migration'
  ];
  
  for (const dir of directories) {
    try {
      await ensureDirectoryExists(dir);
      console.log(`✅ Criado: ${dir}`);
    } catch (error) {
      console.error(`❌ Erro ao criar ${dir}:`, error.message);
    }
  }
}

async function migrate() {
  console.log('🚀 Iniciando migração para nova estrutura...\n');
  
  // 1. Criar estrutura de diretórios
  await createNewDirectoryStructure();
  
  console.log('\n📦 Migrando arquivos e diretórios...\n');
  
  // 2. Migrar itens
  for (const migration of migrations) {
    await migrateItem(migration);
  }
  
  console.log('\n🎉 Migração concluída!');
  console.log('\n📋 Próximos passos:');
  console.log('1. ✅ Verificar se todos os arquivos foram movidos corretamente');
  console.log('2. ✅ Executar: node scripts/migration/update-imports.js');
  console.log('3. ✅ Atualizar package.json com novos scripts');
  console.log('4. ✅ Testar se tudo ainda funciona');
  console.log('5. ✅ Remover diretórios vazios manualmente se necessário');
  
  // 3. Listar diretórios que podem precisar ser removidos manualmente
  console.log('\n📁 Diretórios originais para verificar/remover:');
  const checkDirs = ['db', 'posicoes', 'indicadores', 'utils', 'tests'];
  
  for (const dir of checkDirs) {
    try {
      const stats = await fs.stat(dir);
      if (stats.isDirectory()) {
        const contents = await fs.readdir(dir);
        if (contents.length === 0) {
          console.log(`🗑️ ${dir}/ (vazio - pode ser removido)`);
          try {
            await fs.rmdir(dir);
            console.log(`✅ Removido: ${dir}/`);
          } catch {
            console.log(`⚠️ Remova manualmente: ${dir}/`);
          }
        } else {
          console.log(`📂 ${dir}/ (ainda contém: ${contents.join(', ')})`);
        }
      }
    } catch {
      console.log(`✅ ${dir}/ (já removido ou não existe)`);
    }
  }
}

// Executar migração
migrate().catch(console.error);