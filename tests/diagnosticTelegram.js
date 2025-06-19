const { Telegraf } = require("telegraf");
const { getDatabaseInstance } = require('../db/conexao');

async function diagnosticTest() {
  console.log('🔍 ========== DIAGNÓSTICO TELEGRAM BOT ==========');
  
  try {
    // 1. Obter token
    console.log('📊 Obtendo token...');
    const db = await getDatabaseInstance();
    const [rows] = await db.query(
      'SELECT telegram_bot_token FROM contas WHERE id = 1 AND ativa = 1'
    );
    
    const token = rows[0].telegram_bot_token;
    console.log('✅ Token obtido');
    
    // 2. Teste de conectividade da API
    console.log('🌐 Testando conectividade com API do Telegram...');
    
    const testUrls = [
      `https://api.telegram.org/bot${token}/getMe`,
      `https://api.telegram.org/bot${token}/getWebhookInfo`,
      `https://api.telegram.org/bot${token}/getUpdates?limit=1`
    ];
    
    for (const url of testUrls) {
      try {
        const response = await fetch(url, { timeout: 5000 });
        const result = await response.json();
        console.log(`✅ ${url.split('/').pop()}: ${result.ok ? 'OK' : 'ERRO'}`);
        if (url.includes('getWebhookInfo')) {
          console.log(`   Webhook URL: ${result.result.url || 'Nenhum'}`);
          console.log(`   Pending updates: ${result.result.pending_update_count || 0}`);
        }
      } catch (apiError) {
        console.error(`❌ ${url.split('/').pop()}: ${apiError.message}`);
      }
    }
    
    // 3. Teste direto com diferentes configurações de polling
    const pollingConfigs = [
      { name: 'Básico', config: { polling: true } },
      { name: 'Timeout curto', config: { polling: { timeout: 1 } } },
      { name: 'Sem allowed_updates', config: { polling: { timeout: 5, limit: 1 } } },
      { name: 'Mínimo', config: { polling: { timeout: 3, limit: 1, allowed_updates: [] } } }
    ];
    
    for (const { name, config } of pollingConfigs) {
      console.log(`\n🧪 Testando configuração: ${name}`);
      
      try {
        const bot = new Telegraf(token);
        
        // Handler mínimo
        bot.on('message', () => {});
        
        console.log(`   Iniciando com config:`, JSON.stringify(config));
        
        // Teste com timeout de 3 segundos
        await Promise.race([
          bot.launch(config),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout 3s')), 3000)
          )
        ]);
        
        console.log(`   ✅ ${name}: Iniciado com sucesso!`);
        
        // Testar getMe
        const botInfo = await bot.telegram.getMe();
        console.log(`   ✅ getMe: @${botInfo.username}`);
        
        // Parar bot
        await bot.stop();
        console.log(`   ✅ ${name}: Parado com sucesso`);
        
        // Se chegou aqui, essa configuração funciona!
        console.log(`\n🎉 CONFIGURAÇÃO FUNCIONAL ENCONTRADA: ${name}`);
        return config;
        
      } catch (testError) {
        console.log(`   ❌ ${name}: ${testError.message}`);
      }
    }
    
    // 4. Teste sem polling (apenas criação)
    console.log('\n🧪 Testando apenas criação do bot (sem launch)...');
    try {
      const bot = new Telegraf(token);
      const botInfo = await bot.telegram.getMe();
      console.log(`✅ Bot criado e getMe funcional: @${botInfo.username}`);
      console.log('🔍 Problema está no launch/polling, não na criação do bot');
    } catch (createError) {
      console.error(`❌ Erro na criação: ${createError.message}`);
    }
    
    // 5. Verificar processos conflitantes
    console.log('\n🔍 Verificando possíveis conflitos...');
    
    // Verificar se há outros bots rodando (simulação)
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      const { stdout } = await execPromise('ps aux | grep -i telegraf || true');
      if (stdout.trim()) {
        console.log('⚠️ Possíveis processos Telegraf encontrados:');
        console.log(stdout);
      } else {
        console.log('✅ Nenhum processo Telegraf conflitante encontrado');
      }
    } catch (psError) {
      console.log('ℹ️ Não foi possível verificar processos');
    }
    
  } catch (error) {
    console.error('💥 Erro no diagnóstico:', error.message);
  }
}

if (require.main === module) {
  diagnosticTest()
    .then(() => {
      console.log('\n🏁 Diagnóstico concluído');
      process.exit(0);
    })
    .catch(error => {
      console.error('💥 Erro fatal:', error);
      process.exit(1);
    });
}

module.exports = { diagnosticTest };