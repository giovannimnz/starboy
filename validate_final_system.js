const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

/**
 * Script de validação final do sistema Starboy PostgreSQL
 * Verifica se todas as correções foram aplicadas corretamente
 */

console.log('🔍 VALIDAÇÃO FINAL DO SISTEMA STARBOY - POSTGRESQL');
console.log('=================================================\n');

// Configuração dos arquivos críticos
const criticalFiles = [
  'backend/core/database/conexao.js',
  'backend/core/database/backup.js',
  'backend/core/database/restore.js',
  'backend/exchanges/binance/monitoring/orchMonitor.js',
  'backend/exchanges/binance/monitoring/signalProcessor.js',
  'backend/exchanges/binance/api/rest.js',
  'backend/exchanges/binance/api/websocket.js',
  'backend/exchanges/binance/services/telegramHelper.js',
  'backend/exchanges/binance/services/positionSync.js',
  'backend/server/api.js'
];

// Padrões que NÃO devem estar presentes
const forbiddenPatterns = [
  { pattern: /mysql(?!2)/i, description: 'Referências ao MySQL (exceto mysql2)' },
  { pattern: /telegramBot/g, description: 'Uso de telegramBot (deve ser telegramHelper)' },
  { pattern: /mysqldump/g, description: 'Comandos mysqldump' },
  { pattern: /mysql\s+/g, description: 'Comandos mysql' },
  { pattern: /require\(['"]mysql['"\)]/g, description: 'Import do módulo mysql' },
  { pattern: /connection\.query/g, description: 'Uso direto de connection.query' }
];

// Padrões específicos para diferentes tipos de arquivo
const contextualPatterns = [
  {
    pattern: /\$\d+(?!\s*[,\)])/g,
    description: 'Variáveis com sintaxe $1, $2 em contexto não-SQL',
    excludeFiles: ['conexao.js', 'backup.js', 'restore.js'], // Excluir arquivos que usam SQL
    validateContext: (match, content, index) => {
      // Verificar se está em contexto SQL válido
      const beforeMatch = content.substring(Math.max(0, index - 100), index);
      const afterMatch = content.substring(index, Math.min(content.length, index + 100));
      
      // Se está em query SQL, é válido
      if (beforeMatch.includes('query(') || beforeMatch.includes('SELECT') || 
          beforeMatch.includes('INSERT') || beforeMatch.includes('UPDATE') ||
          beforeMatch.includes('DELETE') || afterMatch.includes('FROM') ||
          afterMatch.includes('WHERE') || afterMatch.includes('VALUES')) {
        return false; // Não é erro
      }
      
      return true; // É erro
    }
  }
];

// Padrões que DEVEM estar presentes
const requiredPatterns = [
  { 
    files: ['backend/core/database/conexao.js'],
    pattern: /postgresql/i,
    description: 'Referência ao PostgreSQL na conexão'
  },
  {
    files: ['backend/core/database/backup.js'],
    pattern: /pg_dump/g,
    description: 'Uso de pg_dump no backup'
  },
  {
    files: ['backend/core/database/restore.js'],
    pattern: /psql/g,
    description: 'Uso de psql no restore'
  },
  {
    files: ['backend/exchanges/binance/services/telegramHelper.js'],
    pattern: /sendTelegramMessage/g,
    description: 'Função sendTelegramMessage'
  }
];

let validationErrors = [];
let validationWarnings = [];

/**
 * Verifica se um arquivo existe
 */
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Lê o conteúdo de um arquivo
 */
function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Erro ao ler arquivo ${filePath}: ${error.message}`);
  }
}

/**
 * Valida um arquivo contra padrões proibidos
 */
function validateForbiddenPatterns(filePath, content) {
  const errors = [];
  
  forbiddenPatterns.forEach(({ pattern, description }) => {
    const matches = content.match(pattern);
    if (matches) {
      errors.push({
        file: filePath,
        pattern: pattern.toString(),
        description,
        matches: matches.length,
        sample: matches[0]
      });
    }
  });
  
  return errors;
}

/**
 * Valida padrões obrigatórios
 */
function validateRequiredPatterns(filePath, content) {
  const errors = [];
  
  requiredPatterns.forEach(({ files, pattern, description }) => {
    if (files.includes(filePath)) {
      const matches = content.match(pattern);
      if (!matches) {
        errors.push({
          file: filePath,
          pattern: pattern.toString(),
          description,
          required: true
        });
      }
    }
  });
  
  return errors;
}

/**
 * Valida estrutura de imports
 */
function validateImports(filePath, content) {
  const errors = [];
  
  // Verificar se usa getDatabaseInstance corretamente
  if (content.includes('require(') && content.includes('database')) {
    if (!content.includes('getDatabaseInstance') && !filePath.includes('conexao.js')) {
      if (content.includes('db.query') || content.includes('database')) {
        errors.push({
          file: filePath,
          description: 'Arquivo usa banco mas não importa getDatabaseInstance',
          type: 'import'
        });
      }
    }
  }
  
  return errors;
}

/**
 * Executa validação completa
 */
async function runValidation() {
  console.log('📋 Verificando arquivos críticos...\n');
  
  // 1. Verificar existência dos arquivos
  for (const file of criticalFiles) {
    const fullPath = path.resolve(__dirname, file);
    if (!fileExists(fullPath)) {
      validationErrors.push({
        type: 'missing_file',
        file: file,
        description: 'Arquivo crítico não encontrado'
      });
    } else {
      console.log(`✅ ${file}`);
    }
  }
  
  if (validationErrors.length > 0) {
    console.log('\n❌ ARQUIVOS CRÍTICOS AUSENTES:');
    validationErrors.forEach(error => {
      console.log(`   - ${error.file}: ${error.description}`);
    });
    return false;
  }
  
  console.log('\n🔍 Validando conteúdo dos arquivos...\n');
  
  // 2. Validar conteúdo dos arquivos
  for (const file of criticalFiles) {
    const fullPath = path.resolve(__dirname, file);
    const content = readFile(fullPath);
    
    console.log(`🔍 Validando ${file}...`);
    
    // Verificar padrões proibidos
    const forbiddenErrors = validateForbiddenPatterns(file, content);
    validationErrors.push(...forbiddenErrors);
    
    // Verificar padrões obrigatórios
    const requiredErrors = validateRequiredPatterns(file, content);
    validationErrors.push(...requiredErrors);
    
    // Verificar imports
    const importErrors = validateImports(file, content);
    validationWarnings.push(...importErrors);
  }
  
  return true;
}

/**
 * Valida configuração do banco
 */
async function validateDatabase() {
  console.log('\n🗄️ Validando configuração do banco...\n');
  
  try {
    const { getDatabaseInstance } = require('./backend/core/database/conexao');
    const db = await getDatabaseInstance();
    
    console.log('✅ Conexão com PostgreSQL estabelecida');
    
    // Verificar se as tabelas principais existem
    const tables = ['contas', 'posicoes', 'ordens', 'sinais'];
    
    for (const table of tables) {
      const result = await db.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = $1
      `, [table]);
      
      if (result.rows.length > 0) {
        console.log(`✅ Tabela ${table} encontrada`);
      } else {
        validationErrors.push({
          type: 'missing_table',
          table: table,
          description: `Tabela ${table} não encontrada no banco`
        });
      }
    }
    
    return true;
  } catch (error) {
    validationErrors.push({
      type: 'database_error',
      description: `Erro ao conectar com o banco: ${error.message}`
    });
    return false;
  }
}

/**
 * Valida package.json
 */
function validatePackageJson() {
  console.log('\n📦 Validando dependências...\n');
  
  try {
    const packagePath = path.resolve(__dirname, 'package.json');
    const packageContent = JSON.parse(readFile(packagePath));
    
    const requiredDeps = ['pg', 'ws', 'node-telegram-bot-api', 'express'];
    const forbiddenDeps = ['mysql', 'mysql2'];
    
    // Verificar dependências obrigatórias
    for (const dep of requiredDeps) {
      if (!packageContent.dependencies || !packageContent.dependencies[dep]) {
        validationErrors.push({
          type: 'missing_dependency',
          dependency: dep,
          description: `Dependência ${dep} não encontrada`
        });
      } else {
        console.log(`✅ Dependência ${dep} encontrada`);
      }
    }
    
    // Verificar dependências proibidas
    for (const dep of forbiddenDeps) {
      if (packageContent.dependencies && packageContent.dependencies[dep]) {
        validationWarnings.push({
          type: 'forbidden_dependency',
          dependency: dep,
          description: `Dependência ${dep} ainda presente (deveria ser removida)`
        });
      }
    }
    
    return true;
  } catch (error) {
    validationErrors.push({
      type: 'package_error',
      description: `Erro ao validar package.json: ${error.message}`
    });
    return false;
  }
}

/**
 * Executa todos os testes
 */
async function main() {
  console.log(`Iniciando validação em: ${new Date().toISOString()}\n`);
  
  const fileValidation = await runValidation();
  const dbValidation = await validateDatabase();
  const packageValidation = validatePackageJson();
  
  console.log('\n' + '='.repeat(80));
  console.log('📊 RESULTADO DA VALIDAÇÃO');
  console.log('='.repeat(80));
  
  if (validationErrors.length === 0 && validationWarnings.length === 0) {
    console.log('🎉 PARABÉNS! Sistema validado com sucesso!');
    console.log('✅ Todos os arquivos críticos estão presentes');
    console.log('✅ Todas as correções foram aplicadas');
    console.log('✅ Banco PostgreSQL configurado corretamente');
    console.log('✅ Dependências corretas instaladas');
    console.log('\n🚀 O sistema está pronto para uso!');
    return true;
  }
  
  // Mostrar erros críticos
  if (validationErrors.length > 0) {
    console.log('\n❌ ERROS CRÍTICOS ENCONTRADOS:');
    validationErrors.forEach((error, index) => {
      console.log(`\n${index + 1}. ${error.description}`);
      if (error.file) console.log(`   Arquivo: ${error.file}`);
      if (error.pattern) console.log(`   Padrão: ${error.pattern}`);
      if (error.matches) console.log(`   Ocorrências: ${error.matches}`);
      if (error.sample) console.log(`   Exemplo: ${error.sample}`);
    });
  }
  
  // Mostrar avisos
  if (validationWarnings.length > 0) {
    console.log('\n⚠️ AVISOS:');
    validationWarnings.forEach((warning, index) => {
      console.log(`\n${index + 1}. ${warning.description}`);
      if (warning.file) console.log(`   Arquivo: ${warning.file}`);
    });
  }
  
  console.log('\n🔧 RECOMENDAÇÕES:');
  
  if (validationErrors.length > 0) {
    console.log('1. Corrija os erros críticos listados acima');
    console.log('2. Execute novamente este script para re-validar');
    console.log('3. Se necessário, consulte a documentação de migração');
  }
  
  if (validationWarnings.length > 0) {
    console.log('4. Considere corrigir os avisos para melhor qualidade do código');
  }
  
  return false;
}

// Executar validação
main().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('\n💥 ERRO DURANTE A VALIDAÇÃO:', error);
  process.exit(1);
});
