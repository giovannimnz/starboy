const { getDatabaseInstance } = require('../db/conexao');
const {
  updateLeverageBracketsInDatabase,
  getLeverageBracketsFromDb,
  getMaxLeverageFromDb,
  getMarginInfoFromDb,
  calculateRequiredMargin
} = require('../api');

async function testarAlavancagem() {
  try {
    console.log('=== TESTANDO FUNÇÕES DE ALAVANCAGEM ===');
    
    const accountId = 1;
    const symbol = 'BTCUSDT';
    const exchange = 'binance';
    
    // 1. Atualizar brackets (se necessário)
    console.log('\n1. Atualizando brackets de alavancagem...');
    await updateLeverageBracketsInDatabase(exchange, accountId);
    
    // 2. Obter brackets do banco
    console.log('\n2. Obtendo brackets do banco...');
    const brackets = await getLeverageBracketsFromDb(symbol, exchange, accountId);
    console.log(`Encontrados ${brackets.length} brackets para ${symbol}:`);
    brackets.slice(0, 3).forEach(bracket => {
      console.log(`  Bracket ${bracket.bracket}: ${bracket.initial_leverage}x leverage, Notional: ${bracket.notional_floor} - ${bracket.notional_cap}`);
    });
    
    // 3. Obter alavancagem máxima
    console.log('\n3. Obtendo alavancagem máxima...');
    const maxLeverage = await getMaxLeverageFromDb(symbol, exchange, accountId);
    console.log(`Alavancagem máxima para ${symbol}: ${maxLeverage}x`);
    
    // 4. Testar cálculo de margem
    console.log('\n4. Testando cálculo de margem...');
    const notionalValue = 1000; // $1000 USD
    const leverage = 10;
    
    const marginInfo = await getMarginInfoFromDb(symbol, notionalValue, exchange, accountId);
    console.log(`Informações de margem para ${symbol} com notional $${notionalValue}:`);
    console.log(`  Bracket: ${marginInfo.bracket}`);
    console.log(`  Max Leverage: ${marginInfo.initial_leverage}x`);
    console.log(`  Maint Margin Ratio: ${(marginInfo.maint_margin_ratio * 100).toFixed(4)}%`);
    
    const marginCalc = await calculateRequiredMargin(symbol, notionalValue, leverage, exchange, accountId);
    console.log(`Cálculo de margem para ${leverage}x leverage:`);
    console.log(`  Margem Inicial: $${marginCalc.initialMargin}`);
    console.log(`  Margem de Manutenção: $${marginCalc.maintMargin}`);
    
    console.log('\n✅ Teste concluído com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  }
}

testarAlavancagem();