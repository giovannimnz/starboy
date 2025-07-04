#!/usr/bin/env node

// ============================================================================
// SCRIPT DE REORGANIZAÇÃO DA ESTRUTURA DE ARQUIVOS DE FIX
// ============================================================================
// Este script reorganiza todos os arquivos relacionados a correções (fix)
// seguindo o padrão organizacional definido:
// - Scripts de fix: scripts/fix/
// - Testes de fix: backend/tests/fix/
// - Documentação: docs/backend/exchanges/binance-docs/[categoria]/
// ============================================================================

const fs = require('fs');
const path = require('path');

console.log('🔧 REORGANIZANDO ESTRUTURA DE ARQUIVOS DE FIX');
console.log('='.repeat(60));

// ============================================================================
// FUNÇÕES UTILITÁRIAS
// ============================================================================

function createDirectoryIfNotExists(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
    console.log(`📁 Criado: ${dirPath}`);
  }
}

function moveFile(oldPath, newPath, description = '') {
  try {
    if (fs.existsSync(oldPath)) {
      createDirectoryIfNotExists(path.dirname(newPath));
      
      // Se arquivo já existe no destino, fazer backup
      if (fs.existsSync(newPath)) {
        const backupPath = `${newPath}.backup.${Date.now()}`;
        fs.renameSync(newPath, backupPath);
        console.log(`📋 Backup criado: ${backupPath}`);
      }
      
      fs.renameSync(oldPath, newPath);
      console.log(`✅ Movido: ${path.basename(oldPath)} → ${newPath}`);
      if (description) console.log(`   📝 ${description}`);
      return true;
    } else {
      console.log(`⚠️  Não encontrado: ${oldPath}`);
    }
  } catch (error) {
    console.error(`❌ Erro ao mover ${oldPath}:`, error.message);
    return false;
  }
  return false;
}

function copyFile(oldPath, newPath, description = '') {
  try {
    if (fs.existsSync(oldPath)) {
      createDirectoryIfNotExists(path.dirname(newPath));
      fs.copyFileSync(oldPath, newPath);
      console.log(`📋 Copiado: ${path.basename(oldPath)} → ${newPath}`);
      if (description) console.log(`   📝 ${description}`);
      return true;
    }
  } catch (error) {
    console.error(`❌ Erro ao copiar ${oldPath}:`, error.message);
    return false;
  }
  return false;
}

// ============================================================================
// ESTRUTURA DE DIRETÓRIOS
// ============================================================================

function createDirectoryStructure() {
  console.log('\n📁 CRIANDO ESTRUTURA DE DIRETÓRIOS...');
  
  const directories = [
    // Scripts executáveis
    'scripts/fix',
    
    // Testes de correções
    'backend/tests/fix',
    
    // Documentação organizada por categoria
    'docs/backend/exchanges/binance-docs/general',
    'docs/backend/exchanges/binance-docs/futures', 
    'docs/backend/exchanges/binance-docs/spot',
    'docs/backend/exchanges/binance-docs/websocket',
    'docs/backend/exchanges/binance-docs/database',
    'docs/backend/exchanges/binance-docs/monitoring',
    'docs/backend/exchanges/binance-docs/api-fixes'
  ];

  directories.forEach(createDirectoryIfNotExists);
}

// ============================================================================
// MAPEAMENTO DE ARQUIVOS
// ============================================================================

function reorganizeFiles() {
  console.log('\n🔄 REORGANIZANDO ARQUIVOS...');

  // ============================================================================
  // 1. SCRIPTS DE FIX (já estão no local correto em scripts/fix/)
  // ============================================================================
  console.log('\n🔧 Scripts de Fix (scripts/fix/):');
  console.log('✅ Arquivos já estão no local correto');

  // ============================================================================
  // 2. TESTES DE FIX (já estão no local correto em backend/tests/fix/)
  // ============================================================================ 
  console.log('\n🧪 Testes de Fix (backend/tests/fix/):');
  console.log('✅ Arquivos já estão no local correto');

  // ============================================================================
  // 3. DOCUMENTAÇÃO - REORGANIZAR POR CATEGORIA
  // ============================================================================
  console.log('\n📚 Reorganizando documentação por categoria...');

  const docMappings = [
    // Database & Performance
    {
      files: [
        'docs/backend/exchanges/fix/OTIMIZACAO_BANCO_DADOS_*.md',
        'docs/backend/exchanges/binance-docs/futures/OTIMIZACAO_BANCO_DADOS_*.md',
        'docs/backend/exchanges/fix/LOGS_CONTA_ID_*.md',
        'docs/backend/exchanges/binance-docs/futures/NOVO_INDICE_*.md'
      ],
      target: 'docs/backend/exchanges/binance-docs/database/',
      category: 'Otimizações de Banco de Dados'
    },

    // WebSocket & API
    {
      files: [
        'docs/backend/exchanges/fix/CORRECOES_WEBSOCKET_*.md',
        'docs/backend/exchanges/fix/CORRECAO_RECV_WINDOW_*.md',
        'docs/backend/exchanges/binance-docs/futures/TIME_SYNC_*.md'
      ],
      target: 'docs/backend/exchanges/binance-docs/api-fixes/',
      category: 'Correções de API e WebSocket'
    },

    // System & Monitoring  
    {
      files: [
        'docs/backend/exchanges/fix/CORRECOES_SISTEMA_*.md',
        'docs/backend/exchanges/fix/SISTEMA_CORRIGIDO_*.md',
        'docs/backend/exchanges/binance-docs/futures/SISTEMA_CORRIGIDO_*.md'
      ],
      target: 'docs/backend/exchanges/binance-docs/monitoring/',
      category: 'Sistema e Monitoramento'
    },

    // Futures Trading
    {
      files: [
        'docs/backend/exchanges/fix/IMPLEMENTACAO_BUFFER_*.md',
        'docs/backend/exchanges/fix/CORRECAO_VINCULACAO_*.md'
      ],
      target: 'docs/backend/exchanges/binance-docs/futures/',
      category: 'Trading de Futuros'
    }
  ];

  docMappings.forEach(mapping => {
    console.log(`\n📂 ${mapping.category}:`);
    
    // Buscar arquivos por padrão glob simples
    mapping.files.forEach(pattern => {
      const basePath = pattern.replace('*', '');
      const dir = path.dirname(pattern);
      
      try {
        if (fs.existsSync(dir)) {
          const files = fs.readdirSync(dir);
          files.forEach(file => {
            const fullPath = path.join(dir, file);
            if (file.endsWith('.md') && pattern.includes(file.split('_')[0] + '_')) {
              const targetPath = path.join(mapping.target, file);
              moveFile(fullPath, targetPath, mapping.category);
            }
          });
        }
      } catch (error) {
        console.log(`⚠️  Pasta não encontrada: ${dir}`);
      }
    });
  });
}

// ============================================================================
// LIMPEZA DE DUPLICATAS
// ============================================================================

function cleanupDuplicates() {
  console.log('\n🧹 LIMPANDO DUPLICATAS...');

  const duplicatePatterns = [
    'docs/backend/exchanges/fix/',
    'docs/backend/exchanges/binance-docs/futures/' // Alguns podem ter ficado duplicados
  ];

  duplicatePatterns.forEach(pattern => {
    try {
      if (fs.existsSync(pattern)) {
        const files = fs.readdirSync(pattern);
        console.log(`📁 Verificando: ${pattern} (${files.length} arquivos)`);
        
        // Não remover automaticamente, apenas listar
        if (files.length > 0) {
          console.log(`   📋 Arquivos encontrados: ${files.join(', ')}`);
          console.log(`   ⚠️  Verificar manualmente se devem ser removidos`);
        }
      }
    } catch (error) {
      console.log(`⚠️  Erro ao verificar ${pattern}: ${error.message}`);
    }
  });
}

// ============================================================================
// CRIAR ÍNDICES E DOCUMENTAÇÃO
// ============================================================================

function createIndexFiles() {
  console.log('\n📋 CRIANDO ARQUIVOS DE ÍNDICE...');

  // Índice principal
  const mainIndex = `# ÍNDICE DE ARQUIVOS DE CORREÇÃO (FIX)

## 📁 Estrutura Organizacional

### 🔧 Scripts de Correção
**Localização:** \`scripts/fix/\`
- Scripts executáveis para aplicar correções
- Executar com: \`node scripts/fix/[script-name].js\`

### 🧪 Testes de Correção  
**Localização:** \`backend/tests/fix/\`
- Scripts de teste para validar correções
- Executar com: \`./backend/tests/fix/[test-name].sh\`

### 📚 Documentação por Categoria

#### 🗄️ Database & Performance
**Localização:** \`docs/backend/exchanges/binance-docs/database/\`
- Otimizações de banco de dados
- Índices e performance
- Logs e auditoria

#### 🌐 API & WebSocket
**Localização:** \`docs/backend/exchanges/binance-docs/api-fixes/\`
- Correções de API REST
- Melhorias em WebSocket
- Sincronização de tempo
- RecvWindow e timeouts

#### 📊 Sistema & Monitoramento
**Localização:** \`docs/backend/exchanges/binance-docs/monitoring/\`
- Correções do sistema de monitoramento
- Logs e debugging
- Relatórios de sistema

#### 📈 Trading de Futuros
**Localização:** \`docs/backend/exchanges/binance-docs/futures/\`
- Estratégias e algoritmos
- Buffer de ordens
- Vinculação de sinais

---

## 🚀 Como Usar

1. **Aplicar Correção:**
   \`\`\`bash
   cd scripts/fix
   node [script-name].js
   \`\`\`

2. **Testar Correção:**
   \`\`\`bash
   cd backend/tests/fix
   ./test_[test-name].sh
   \`\`\`

3. **Consultar Documentação:**
   Navegar até a categoria apropriada em \`docs/backend/exchanges/binance-docs/\`

---
*Atualizado em: ${new Date().toISOString()}*
*Gerado por: reorganize-fix-structure.js*
`;

  fs.writeFileSync('docs/backend/exchanges/binance-docs/INDEX_FIXES.md', mainIndex);
  console.log('✅ Criado: INDEX_FIXES.md');

  // README específico para scripts
  const scriptsReadme = `# Scripts de Correção

Todos os scripts executáveis para aplicar correções no sistema.

## 📋 Scripts Disponíveis:

${fs.existsSync('scripts/fix') ? 
  fs.readdirSync('scripts/fix')
    .filter(f => f.endsWith('.js'))
    .map(f => `- \`${f}\` - ${getScriptDescription(f)}`)
    .join('\n') 
  : '(Nenhum script encontrado)'}

## 🚀 Como Executar:

\`\`\`bash
cd scripts/fix
node [nome-do-script].js
\`\`\`

---
*Atualizado automaticamente*
`;

  fs.writeFileSync('scripts/fix/README.md', scriptsReadme);
  console.log('✅ Criado: scripts/fix/README.md');
}

function getScriptDescription(filename) {
  const descriptions = {
    'fix-app-conflicts.js': 'Remove conflitos no app.js',
    'reorganize-fix-structure.js': 'Reorganiza estrutura de arquivos fix',
    'apply_indexes.js': 'Aplica otimizações de índices no banco',
    'fix-all-env-paths.js': 'Corrige caminhos de ambiente',
    'fix-imports-after-migration.js': 'Corrige imports após migração'
  };
  return descriptions[filename] || 'Script de correção';
}

// ============================================================================
// EXECUÇÃO PRINCIPAL
// ============================================================================

function main() {
  try {
    createDirectoryStructure();
    reorganizeFiles(); 
    cleanupDuplicates();
    createIndexFiles();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ REORGANIZAÇÃO CONCLUÍDA COM SUCESSO!');
    console.log('\n📁 Estrutura Final:');
    console.log('├── scripts/fix/          # 🔧 Scripts executáveis');
    console.log('├── backend/tests/fix/    # 🧪 Testes de correção'); 
    console.log('└── docs/backend/exchanges/binance-docs/');
    console.log('    ├── database/         # 🗄️ DB & Performance');
    console.log('    ├── api-fixes/        # 🌐 API & WebSocket');
    console.log('    ├── monitoring/       # 📊 Sistema & Monitoramento');
    console.log('    └── futures/          # 📈 Trading de Futuros');
    console.log('\n📋 Consulte INDEX_FIXES.md para documentação completa');
    
  } catch (error) {
    console.error('\n❌ Erro durante reorganização:', error.message);
    process.exit(1);
  }
}

// EXECUTAR APENAS SE CHAMADO DIRETAMENTE
if (require.main === module) {
  main();
}

module.exports = { main, createDirectoryStructure, reorganizeFiles };
