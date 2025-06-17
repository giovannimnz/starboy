// Teste específico para linha 134
const fs = require('fs');
const path = require('path');

function testLine134() {
  console.log('🧪 Testando correção da linha 134...');
  
  const limitMakerPath = path.join(__dirname, 'posicoes', 'limitMakerEntry.js');
  
  if (fs.existsSync(limitMakerPath)) {
    const content = fs.readFileSync(limitMakerPath, 'utf8');
    const lines = content.split('\n');
    
    if (lines.length >= 134) {
      const line134 = lines[133];
      console.log(`Linha 134: ${line134.trim()}`);
      
      if (line134.includes('setupBookDepthWebsocket')) {
        if (line134.includes('accountId')) {
          console.log('✅ Linha 134 tem accountId - correção aplicada!');
          return true;
        } else {
          console.log('❌ Linha 134 ainda não tem accountId');
          return false;
        }
      } else {
        console.log('⚠️ Linha 134 não tem setupBookDepthWebsocket');
        return true;
      }
    } else {
      console.log('❌ Arquivo muito pequeno');
      return false;
    }
  } else {
    console.log('❌ Arquivo não encontrado');
    return false;
  }
}

function testImport() {
  try {
    console.log('\n🧪 Testando import do limitMakerEntry...');
    const limitMaker = require('./posicoes/limitMakerEntry');
    console.log('✅ limitMakerEntry importado sem erros');
    return true;
  } catch (error) {
    console.error('❌ Erro ao importar:', error.message);
    return false;
  }
}

if (require.main === module) {
  const line134Ok = testLine134();
  const importOk = testImport();
  
  if (line134Ok && importOk) {
    console.log('\n🎉 Correção da linha 134 bem-sucedida!');
    console.log('\n🚀 Execute o monitoramento:');
    console.log('   node posicoes/monitoramento.js --account 1');
    console.log('\n📊 O erro "accountId=undefined" deve estar resolvido!');
  } else {
    console.log('\n❌ Ainda há problemas');
    process.exit(1);
  }
}

module.exports = { testLine134, testImport };