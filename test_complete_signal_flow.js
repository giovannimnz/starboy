const { getDatabaseInstance } = require('./backend/core/database/conexao');
const { checkSignalTriggers } = require('./backend/exchanges/binance/monitoring/signalProcessor');

async function testCompleteSignalFlow() {
  console.log('🧪 Testando fluxo completo de sinais...');
  
  try {
    // Conectar ao banco
    const db = await getDatabaseInstance();
    console.log('✅ Conectado ao banco de dados');
    
    // Inserir um sinal de teste
    const testSignal = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      entry_price: 50000,
      sl_price: 49000,
      tp1_price: 51000,
      leverage: 5,
      capital_pct: 10,
      status: 'AGUARDANDO_ACIONAMENTO',
      conta_id: 1,
      timeframe: '1h',
      chat_id: '-1001234567890'
    };
    
    console.log('📝 Inserindo sinal de teste...');
    const insertResult = await db.query(`
      INSERT INTO webhook_signals (
        symbol, side, entry_price, sl_price, tp1_price, leverage, 
        capital_pct, status, conta_id, timeframe, chat_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP)
      RETURNING id
    `, [
      testSignal.symbol, testSignal.side, testSignal.entry_price, 
      testSignal.sl_price, testSignal.tp1_price, testSignal.leverage,
      testSignal.capital_pct, testSignal.status, testSignal.conta_id,
      testSignal.timeframe, testSignal.chat_id
    ]);
    
    const signalId = insertResult.rows[0].id;
    console.log(`✅ Sinal inserido com ID: ${signalId}`);
    
    // Testar diferentes cenários de preço
    console.log('\n📊 Testando diferentes cenários de preço:');
    
    // 1. Preço abaixo da entrada (não deve ativar)
    console.log('1. Preço abaixo da entrada (48000)...');
    await checkSignalTriggers(testSignal.symbol, 48000, db, testSignal.conta_id);
    
    // 2. Preço igual à entrada (não deve ativar para BUY)
    console.log('2. Preço igual à entrada (50000)...');
    await checkSignalTriggers(testSignal.symbol, 50000, db, testSignal.conta_id);
    
    // 3. Preço acima da entrada (deve ativar para BUY)
    console.log('3. Preço acima da entrada (50100) - DEVE ATIVAR!');
    await checkSignalTriggers(testSignal.symbol, 50100, db, testSignal.conta_id);
    
    // Verificar status do sinal
    console.log('\n🔍 Verificando status final do sinal...');
    const statusResult = await db.query(`
      SELECT id, status, error_message, position_id
      FROM webhook_signals 
      WHERE id = $1
    `, [signalId]);
    
    if (statusResult.rows.length > 0) {
      const signal = statusResult.rows[0];
      console.log(`📋 Status final: ${signal.status}`);
      if (signal.error_message) {
        console.log(`⚠️ Erro: ${signal.error_message}`);
      }
      if (signal.position_id) {
        console.log(`🎯 Position ID: ${signal.position_id}`);
      }
    }
    
    // Limpar sinal de teste
    await db.query('DELETE FROM webhook_signals WHERE id = $1', [signalId]);
    console.log('🧹 Sinal de teste removido');
    
    console.log('\n✅ Teste completo finalizado!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.error('Stack:', error.stack);
  }
  
  process.exit(0);
}

testCompleteSignalFlow();
