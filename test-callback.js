// Teste específico para callback com accountId
const fs = require('fs');

function testCallbackCorrection() {
  console.log('🧪 Testando correção do callback...');
  
  try {
    const content = fs.readFileSync('./posicoes/limitMakerEntry.js', 'utf8');
    const lines = content.split('\n');
    
    if (lines.length >= 134) {
      console.log('Linha 134:');
      console.log(lines[133]);
      
      // Procurar por padrões problemáticos
      const problematicPatterns = [
        /setupBookDepthWebsocket\([^,]+,\s*\([^)]*\)\s*=>.*\}\s*\)(?!.*accountId)/g,
        /setupBookDepthWebsocket\([^,]+,\s*function.*\}\s*\)(?!.*accountId)/g
      ];
      
      let hasProblems = false;
      
      problematicPatterns.forEach((pattern, index) => {
        const matches = [...content.matchAll(pattern)];
        if (matches.length > 0) {
          console.log(`❌ Padrão problemático ${index + 1}: ${matches.length} ocorrências`);
          matches.forEach(match => {
            console.log(`  ${match[0].substring(0, 80)}...`);
          });
          hasProblems = true;
        }
      });
      
      if (!hasProblems) {
        console.log('✅ Nenhum padrão problemático encontrado');
      }
      
      // Testar import
      const limitMaker = require('./posicoes/limitMakerEntry');
      console.log('✅ limitMakerEntry importado sem erro');
      
      return !hasProblems;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return false;
  }
}

if (require.main === module) {
  if (testCallbackCorrection()) {
    console.log('\n🎉 Correção do callback aplicada!');
    console.log('\n🚀 Execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    console.log('\n📊 setupBookDepthWebsocket deve receber accountId como 3º parâmetro!');
  } else {
    console.log('\n❌ Ainda há problemas com callbacks');
  }
}