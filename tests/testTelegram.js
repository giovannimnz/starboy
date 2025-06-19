const { 
  testTelegramBot, 
  listActiveBots, 
  validateTelegramToken,
  clearBotWebhook 
} = require('./posicoes/telegramBot');

async function runTelegramTests() {
  console.log('🧪 ========== TESTE COMPLETO DO TELEGRAM BOT ==========');
  
  const accountId = 1; // ✅ ALTERE PARA SUA CONTA DE TESTE
  
  try {
    // 1. Listar bots ativos
    console.log('\n📋 1. Listando bots ativos...');
    listActiveBots();
    
    // 2. Testar bot completo
    console.log('\n🤖 2. Testando inicialização e envio...');
    const testResult = await testTelegramBot(accountId);
    
    if (testResult.success) {
      console.log('✅ TESTE PASSOU! Bot funcionando.');
    } else {
      console.error('❌ TESTE FALHOU:', testResult.error);
    }
    
    // 3. Listar novamente
    console.log('\n📋 3. Listando bots após teste...');
    listActiveBots();
    
  } catch (error) {
    console.error('💥 Erro no teste:', error.message);
  }
  
  console.log('\n🏁 Teste concluído!');
}

// Executar se chamado diretamente
if (require.main === module) {
  runTelegramTests()
    .then(() => process.exit(0))
    .catch(error => {
      console.error('Erro fatal:', error);
      process.exit(1);
    });
}

module.exports = { runTelegramTests };