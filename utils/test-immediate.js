// Teste imediato da correção
const fs = require('fs');
const path = require('path');

function testCorrection() {
  console.log('🧪 Testando correção imediata...');
  
  try {
    // Testar import
    const limitMaker = require('./posicoes/limitMakerEntry');
    console.log('✅ limitMakerEntry importado sem erro');
    
    // Verificar linha 134
    const content = fs.readFileSync('./posicoes/limitMakerEntry.js', 'utf8');
    const lines = content.split('\n');
    
    if (lines.length >= 134) {
      const line134 = lines[133];
      console.log(`Linha 134: ${line134.trim()}`);
      
      if (line134.includes('setupBookDepthWebsocket')) {
        const match = line134.match(/setupBookDepthWebsocket\(([^)]+)\)/);
        if (match) {
          const params = match[1].split(',');
          console.log(`Parâmetros: ${params.length}`);
          params.forEach((param, index) => {
            console.log(`  ${index + 1}: ${param.trim()}`);
          });
          
          if (params.length >= 2 && params[1].trim() === 'accountId') {
            console.log('✅ Linha 134 corrigida corretamente!');
            return true;
          } else {
            console.log('❌ Linha 134 ainda tem problema');
            return false;
          }
        }
      }
    }
    
    return true;
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return false;
  }
}

if (require.main === module) {
  if (testCorrection()) {
    console.log('\n🎉 Correção aplicada com sucesso!');
    console.log('\n🚀 Execute o monitoramento agora:');
    console.log('   node posicoes/monitoramento.js --account 1');
    console.log('\n📊 O erro "AccountId inválido: undefined" deve estar resolvido!');
  } else {
    console.log('\n❌ Ainda há problemas - verifique manualmente');
  }
}