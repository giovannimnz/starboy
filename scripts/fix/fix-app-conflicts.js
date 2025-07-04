// fix-app-conflicts.js
const fs = require('fs');

function fixAppConflicts() {
  console.log('🔧 Removendo funções duplicadas do app.js...\n');
  
  const filePath = '../../backend/server/app.js'; // Ajustado caminho relativo
  
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    
    // 1. REMOVER TODAS AS FUNÇÕES DUPLICADAS
    const functionsToRemove = [
      'startInstance',
      'stopInstance', 
      'restartInstance',
      'listActiveInstances',
      'startAllInstances',
      'analyzeRestartNeed'
    ];
    
    console.log('🗑️ Removendo funções duplicadas...');
    
    functionsToRemove.forEach(funcName => {
      // Regex para remover função completa (async ou não)
      const functionRegex = new RegExp(
        `(async )?function ${funcName}\\([^)]*\\)\\s*{[\\s\\S]*?^}`,
        'gm'
      );
      
      if (content.match(functionRegex)) {
        content = content.replace(functionRegex, '');
        console.log(`   ✅ Removida: ${funcName}`);
      }
    });
    
    // 2. REMOVER VARIÁVEIS DUPLICADAS
    console.log('\n🗑️ Removendo variáveis duplicadas...');
    
    const duplicatedVars = [
      'const activeInstances = new Map();',
      'const { spawn } = require(\'child_process\');'
    ];
    
    duplicatedVars.forEach(varDecl => {
      if (content.includes(varDecl)) {
        content = content.replace(varDecl, `// ${varDecl} // REMOVIDO - usando instanceManager`);
        console.log(`   ✅ Removida: ${varDecl}`);
      }
    });
    
    // 3. CORRIGIR FUNÇÕES QUE USAM AS FUNÇÕES REMOVIDAS
    console.log('\n🔧 Corrigindo chamadas de função...');
    
    // Substituir chamadas locais por chamadas do instanceManager
    const replacements = [
      {
        from: 'await startInstance(accountId)',
        to: 'await require("../processes/instanceManager").startInstance(accountId)'
      },
      {
        from: 'await stopInstance(accountId)',
        to: 'await require("../processes/instanceManager").stopInstance(accountId)'
      },
      {
        from: 'await restartInstance(accountId)',
        to: 'await require("../processes/instanceManager").restartInstance(accountId)'
      },
      {
        from: 'listActiveInstances()',
        to: 'require("../processes/instanceManager").listActiveInstances()'
      },
      {
        from: 'await startAllInstances()',
        to: 'await require("../processes/instanceManager").startAllInstances()'
      }
    ];
    
    replacements.forEach(({from, to}) => {
      if (content.includes(from)) {
        content = content.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to);
        console.log(`   ✅ ${from} → ${to}`);
      }
    });
    
    // 4. ADICIONAR COMENTÁRIO EXPLICATIVO
    const header = `// ===============================================
// ESTE ARQUIVO É APENAS UMA INTERFACE PARA O INSTANCE MANAGER
// Todas as operações são delegadas para ../processes/instanceManager.js
// ===============================================

`;
    
    if (!content.includes('INTERFACE PARA O INSTANCE MANAGER')) {
      content = header + content;
    }
    
    // 5. SALVAR ARQUIVO
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('\n✅ Conflitos resolvidos com sucesso!');
    
    return true;
    
  } catch (error) {
    console.error('❌ Erro ao corrigir conflitos:', error.message);
    return false;
  }
}

// EXECUTAR
fixAppConflicts();