const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../db/conexao');

async function simpleTest() {
  console.log('🧪 TESTE SIMPLES DO TELEGRAM BOT');
  
  try {
    // 1. Obter token do banco
    console.log('📊 Obtendo token do banco...');
    const db = await getDatabaseInstance();
    const [rows] = await db.query(
      'SELECT telegram_bot_token, nome FROM contas WHERE id = 1 AND ativa = 1'
    );
    
    if (rows.length === 0 || !rows[0].telegram_bot_token) {
      throw new Error('Token não encontrado');
    }
    
    const token = rows[0].telegram_bot_token;
    const accountName = rows[0].nome;
    
    console.log(`✅ Token obtido para conta: ${accountName}`);
    
    // 2. Testar API diretamente
    console.log('🔍 Testando API do Telegram...');
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const result = await response.json();
    
    if (!result.ok) {
      throw new Error(`API falhou: ${result.description}`);
    }
    
    console.log(`✅ API OK - Bot: @${result.result.username}`);
    
    // 3. Criar bot com configuração mínima
    console.log('🤖 Criando bot simples...');
    const bot = new Telegraf(token);
    
    // Handler mínimo
    bot.command('ping', (ctx) => ctx.reply('🏓 Pong!'));
    
    // 4. Tentar inicializar com timeout menor
    console.log('🚀 Iniciando polling...');
    
    const startTime = Date.now();
    await Promise.race([
      bot.launch({
        polling: {
          timeout: 5,
          limit: 10
        }
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 8000)
      )
    ]);
    
    const elapsed = Date.now() - startTime;
    console.log(`✅ Bot iniciado em ${elapsed}ms`);
    
    // 5. Testar getMe
    const botInfo = await bot.telegram.getMe();
    console.log(`✅ Bot ativo: @${botInfo.username}`);
    
    // 6. Parar bot
    setTimeout(async () => {
      await bot.stop();
      console.log('✅ Bot parado com sucesso');
      process.exit(0);
    }, 3000);
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  simpleTest();
}