// fix-all-env-paths.js
const fs = require('fs');

const filesToFix = [
  {
    file: 'backend/indicators/divap.py',
    from: "env_path = pathlib.Path(__file__).parents[1] / '.env'",
    to: "env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'"
  },
  {
    file: 'backend/indicators/webhook.py',
    from: "env_path = pathlib.Path(__file__).parents[1] / '.env'",
    to: "env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'"
  },
  {
    file: 'backend/indicators/backtest/divap_check.py',
    from: "env_path = pathlib.Path(__file__).parents[2] / '.env'",
    to: "env_path = pathlib.Path(__file__).parents[3] / 'config' / '.env'"
  }
];

console.log('🔧 Corrigindo paths do .env em arquivos Python...\n');

let fixedCount = 0;
let totalFiles = filesToFix.length;

filesToFix.forEach(({ file, from, to }) => {
  try {
    if (!fs.existsSync(file)) {
      console.log(`⏭️ Arquivo não encontrado: ${file}`);
      return;
    }

    let content = fs.readFileSync(file, 'utf8');
    
    if (content.includes(from)) {
      content = content.replace(from, to);
      fs.writeFileSync(file, content, 'utf8');
      console.log(`✅ Corrigido: ${file}`);
      console.log(`   ${from}`);
      console.log(`   ↓`);
      console.log(`   ${to}\n`);
      fixedCount++;
    } else {
      console.log(`➖ Linha não encontrada em: ${file}`);
      console.log(`   Procurando: ${from}\n`);
    }
  } catch (error) {
    console.error(`❌ Erro ao processar ${file}:`, error.message);
  }
});

console.log(`📊 Resumo:`);
console.log(`  - Arquivos processados: ${totalFiles}`);
console.log(`  - Arquivos corrigidos: ${fixedCount}`);
console.log(`  - Arquivos sem alterações: ${totalFiles - fixedCount}`);

if (fixedCount > 0) {
  console.log('\n✅ Correções aplicadas com sucesso!');
  console.log('\n🔍 Agora teste se os arquivos funcionam:');
  console.log('cd backend/indicators');
  console.log('python3 divap.py');
  console.log('python3 webhook.py');
} else {
  console.log('\n⚠️ Nenhuma correção foi aplicada. Verifique se os arquivos existem e contêm as linhas esperadas.');
}