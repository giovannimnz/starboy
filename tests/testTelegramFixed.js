const { testTelegramBotFixed } = require('../posicoes/telegramBotFixed');

async function runFixedTest() {
  console.log('🧪 ========== TESTE BOT TELEGRAM CORRIGIDO ==========');
  
  try {
    const result = await testTelegramBotFixed(1);
    
    if (result.success) {
      console.log('\n✅ TESTE PASSOU! Bot corrigido funcionando.');
      if (result.messageSent) {
        console.log('✅ Mensagem enviada com sucesso!');
      } else {
        console.log('⚠️ Bot funcionando, mas chat ID pode não estar configurado');
      }
    } else {
      console.error('\n❌ TESTE FALHOU:', result.error);
    }
    
  } catch (error) {
    console.error('💥 Erro no teste:', error.message);
  }
  
  console.log('\n🏁 Teste da versão corrigida concluído!');
}

if (require.main === module) {
  runFixedTest()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Erro fatal:', error);
      process.exit(1);
    });
}

module.exports = { runFixedTest };