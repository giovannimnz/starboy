const path = require('path');
const fs = require('fs');

async function validateBackendFiles() {
  console.log('🔍 Validando correções aplicadas no backend...\n');
  
  const results = {
    total: 0,
    corrected: 0,
    errors: []
  };
  
  // Lista de arquivos a verificar
  const filesToCheck = [
    'backend/exchanges/binance/utils/closeAllPositions.js',
    'backend/exchanges/binance/services/cleanup.js',
    'backend/exchanges/binance/services/telegramHelper.js',
    'backend/exchanges/binance/monitoring/signalProcessor.js',
    'backend/exchanges/binance/monitoring/orchMonitor.js',
    'backend/exchanges/binance/api/rest.js',
    'backend/exchanges/binance/api/websocket.js',
    'backend/services/telegramClient.js',
    'backend/server/routes/users/index.js',
    'backend/core/database/conexao.js'
  ];
  
  for (const filePath of filesToCheck) {
    const fullPath = path.join(process.cwd(), filePath);
    results.total++;
    
    try {
      if (!fs.existsSync(fullPath)) {
        results.errors.push(`❌ Arquivo não encontrado: ${filePath}`);
        continue;
      }
      
      const content = fs.readFileSync(fullPath, 'utf8');
      
      // Verificações específicas
      const checks = [
        {
          name: 'Sintaxe $1, $2, etc.',
          regex: /\w+\$\d+/g,
          shouldNotMatch: true
        },
        {
          name: 'Import telegramBot incorreto',
          regex: /require.*telegram\/telegramBot/,
          shouldNotMatch: true
        },
        {
          name: 'Import MySQL',
          regex: /require.*mysql2/,
          shouldNotMatch: true
        },
        {
          name: 'formatDateForMySQL',
          regex: /formatDateForMySQL/,
          shouldNotMatch: true,
          exception: 'conexao.js' // Permitido no conexao.js por compatibilidade
        }
      ];
      
      let fileHasErrors = false;
      
      for (const check of checks) {
        const matches = content.match(check.regex);
        
        if (check.shouldNotMatch && matches) {
          // Verificar exceções
          if (check.exception && filePath.includes(check.exception)) {
            continue;
          }
          
          results.errors.push(`❌ ${filePath}: ${check.name} encontrado - ${matches[0]}`);
          fileHasErrors = true;
        }
      }
      
      if (!fileHasErrors) {
        console.log(`✅ ${filePath}`);
        results.corrected++;
      }
      
    } catch (error) {
      results.errors.push(`❌ Erro ao ler ${filePath}: ${error.message}`);
    }
  }
  
  // Verificar se telegramHelper existe e está correto
  const telegramHelperPath = path.join(process.cwd(), 'backend/exchanges/binance/services/telegramHelper.js');
  if (fs.existsSync(telegramHelperPath)) {
    const content = fs.readFileSync(telegramHelperPath, 'utf8');
    if (content.includes('sendTelegramMessage')) {
      console.log('✅ telegramHelper.js está funcionando');
    } else {
      results.errors.push('❌ telegramHelper.js não contém sendTelegramMessage');
    }
  }
  
  // Verificar se conexao.js usa PostgreSQL
  const conexaoPath = path.join(process.cwd(), 'backend/core/database/conexao.js');
  if (fs.existsSync(conexaoPath)) {
    const content = fs.readFileSync(conexaoPath, 'utf8');
    if (content.includes('Pool') && content.includes('pg')) {
      console.log('✅ conexao.js usa PostgreSQL corretamente');
    } else {
      results.errors.push('❌ conexao.js não está configurado para PostgreSQL');
    }
  }
  
  console.log('\n📊 Resultados da validação:');
  console.log(`Total de arquivos verificados: ${results.total}`);
  console.log(`Arquivos corretos: ${results.corrected}`);
  console.log(`Arquivos com problemas: ${results.total - results.corrected}`);
  
  if (results.errors.length > 0) {
    console.log('\n🚨 Problemas encontrados:');
    results.errors.forEach(error => console.log(error));
  } else {
    console.log('\n🎉 Todos os arquivos estão corretos!');
  }
  
  // Verificar estrutura de imports
  console.log('\n🔍 Verificando estrutura de imports...');
  
  const importChecks = [
    {
      file: 'backend/exchanges/binance/utils/closeAllPositions.js',
      shouldHave: ['../../../core/database/conexao', '../services/telegramHelper']
    },
    {
      file: 'backend/exchanges/binance/services/cleanup.js', 
      shouldHave: ['../../../core/database/conexao', './telegramHelper']
    }
  ];
  
  for (const check of importChecks) {
    const fullPath = path.join(process.cwd(), check.file);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      
      let allImportsCorrect = true;
      for (const expectedImport of check.shouldHave) {
        if (!content.includes(expectedImport)) {
          console.log(`❌ ${check.file}: faltando import ${expectedImport}`);
          allImportsCorrect = false;
        }
      }
      
      if (allImportsCorrect) {
        console.log(`✅ ${check.file}: imports corretos`);
      }
    }
  }
  
  console.log('\n✅ Validação concluída!');
}

// Executar validação
validateBackendFiles().catch(console.error);
