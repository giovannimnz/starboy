const { getDatabaseInstance } = require('./backend/core/database/conexao');
const { checkSignalTriggers } = require('./backend/exchanges/binance/monitoring/signalProcessor');

async function testSignalTriggers() {
  console.log('🧪 Testando gatilhos de sinais...');
  
  try {
    // Conectar ao banco
    const db = await getDatabaseInstance();
    console.log('✅ Conectado ao banco de dados');
    
    // Verificar se há sinais pendentes
    const result = await db.query(`
      SELECT id, symbol, side, entry_price, status, created_at
      FROM webhook_signals 
      WHERE status = 'AGUARDANDO_ACIONAMENTO' 
      LIMIT 5
    `);
    
    console.log(`📊 Sinais encontrados: ${result.rows.length}`);
    
    if (result.rows.length > 0) {
      console.log('📋 Sinais pendentes:');
      result.rows.forEach(signal => {
        console.log(`  - ID: ${signal.id}, Symbol: ${signal.symbol}, Side: ${signal.side}, Entry: ${signal.entry_price}, Status: ${signal.status}`);
      });
      
      // Testar gatilho para o primeiro sinal
      const firstSignal = result.rows[0];
      const testPrice = parseFloat(firstSignal.entry_price) + (firstSignal.side === 'BUY' ? 1 : -1); // Simular preço que ativa o gatilho
      
      console.log(`\n🎯 Testando gatilho para sinal ${firstSignal.id}:`);
      console.log(`   Symbol: ${firstSignal.symbol}`);
      console.log(`   Entry Price: ${firstSignal.entry_price}`);
      console.log(`   Test Price: ${testPrice}`);
      console.log(`   Side: ${firstSignal.side}`);
      
      await checkSignalTriggers(firstSignal.symbol, testPrice, db, 1);
      
      console.log('✅ Teste de gatilho executado!');
    } else {
      console.log('📭 Nenhum sinal pendente encontrado');
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.error('Stack:', error.stack);
  }
  
  process.exit(0);
}

testSignalTriggers();
