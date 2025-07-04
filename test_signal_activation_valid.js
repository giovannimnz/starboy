const { getDatabaseInstance } = require('./backend/core/database/conexao');
const { checkSignalTriggers } = require('./backend/exchanges/binance/monitoring/signalProcessor');

async function testSignalActivationWithValidAccount() {
  console.log('🧪 Testando ativação de sinal com conta válida...');
  
  try {
    // Conectar ao banco
    const db = await getDatabaseInstance();
    console.log('✅ Conectado ao banco de dados');
    
    // Listar contas disponíveis
    const accountsResult = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = true');
    console.log('📋 Contas disponíveis:');
    accountsResult.rows.forEach(account => {
      console.log(`  - ID: ${account.id}, Nome: ${account.nome}, Ativa: ${account.ativa}`);
    });
    
    const accountId = accountsResult.rows[0].id; // Usar primeira conta disponível
    console.log(`\n🎯 Usando conta ID: ${accountId}`);
    
    // Inserir um sinal de teste com preços seguros (SL muito baixo)
    const testSignal = {
      symbol: 'BTCUSDT',
      side: 'BUY',
      entry_price: 50000,
      sl_price: 40000, // SL muito baixo para não interferir
      tp1_price: 55000,
      leverage: 2,
      capital_pct: 5,
      status: 'AGUARDANDO_ACIONAMENTO',
      conta_id: accountId,
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
    
    // Verificar status inicial
    console.log('\n🔍 Status inicial do sinal:');
    let statusResult = await db.query(`
      SELECT id, status, error_message, position_id
      FROM webhook_signals 
      WHERE id = $1
    `, [signalId]);
    
    console.log(`📋 Status: ${statusResult.rows[0].status}`);
    
    // Testar preço que deve ativar o sinal (BUY: preço atual > entry_price)
    console.log('\n🎯 Testando preço que deve ativar sinal BUY...');
    console.log(`Entry Price: ${testSignal.entry_price}`);
    console.log(`Test Price: 50100 (acima da entrada)`);
    
    await checkSignalTriggers(testSignal.symbol, 50100, db, testSignal.conta_id);
    
    // Verificar status final
    console.log('\n🔍 Status final do sinal:');
    statusResult = await db.query(`
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
    
    console.log('\n✅ Teste de ativação finalizado!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.error('Stack:', error.stack);
  }
  
  process.exit(0);
}

testSignalActivationWithValidAccount();
