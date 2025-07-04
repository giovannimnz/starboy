/**
 * Script para corrigir URLs das corretoras no banco de dados
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function fixCorretorUrls() {
  try {
    console.log('🔧 === CORRIGINDO URLS DAS CORRETORAS ===');
    
    const db = await getDatabaseInstance();
    
    // Verificar corretoras atuais
    console.log('\n📊 Verificando corretoras atuais...');
    const corretorasResult = await db.query('SELECT * FROM corretoras ORDER BY id');
    const corretoras = corretorasResult.rows;
    
    console.log(`📊 Corretoras encontradas: ${corretoras.length}`);
    
    corretoras.forEach(corretora => {
      console.log(`📊   - ID: ${corretora.id}, Nome: ${corretora.corretora}, Ambiente: ${corretora.ambiente}`);
      console.log(`📊     - spot_rest_api_url: ${corretora.spot_rest_api_url || 'undefined'}`);
      console.log(`📊     - futures_rest_api_url: ${corretora.futures_rest_api_url || 'undefined'}`);
      console.log(`📊     - futures_ws_market_url: ${corretora.futures_ws_market_url || 'undefined'}`);
      console.log(`📊     - futures_ws_api_url: ${corretora.futures_ws_api_url || 'undefined'}`);
    });
    
    // Corrigir corretora testnet (ID 999)
    console.log('\n🔧 Corrigindo corretora testnet (ID 999)...');
    
    const updateTestnetResult = await db.query(`
      UPDATE corretoras SET 
        spot_rest_api_url = $1,
        futures_rest_api_url = $2,
        futures_ws_market_url = $3,
        futures_ws_api_url = $4,
        ultima_atualizacao = NOW()
      WHERE id = 999
    `, [
      'https://testnet.binance.vision',
      'https://testnet.binancefuture.com/fapi',
      'wss://stream.binancefuture.com/ws',
      'wss://testnet.binancefuture.com/ws-fapi/v1'
    ]);
    
    console.log(`✅ Corretora testnet atualizada (${updateTestnetResult.rowCount} linha(s) afetada(s))`);
    
    // Corrigir corretora produção (ID 1)
    console.log('\n🔧 Corrigindo corretora produção (ID 1)...');
    
    const updateProdResult = await db.query(`
      UPDATE corretoras SET 
        spot_rest_api_url = $1,
        futures_rest_api_url = $2,
        futures_ws_market_url = $3,
        futures_ws_api_url = $4,
        ultima_atualizacao = NOW()
      WHERE id = 1
    `, [
      'https://api.binance.com',
      'https://fapi.binance.com/fapi',
      'wss://fstream.binance.com/ws',
      'wss://ws-fapi.binance.com/ws-fapi/v1'
    ]);
    
    console.log(`✅ Corretora produção atualizada (${updateProdResult.rowCount} linha(s) afetada(s))`);
    
    // Verificar correção
    console.log('\n✅ Verificando correção...');
    const corretorasFixedResult = await db.query('SELECT * FROM corretoras ORDER BY id');
    const corretorasFixed = corretorasFixedResult.rows;
    
    corretorasFixed.forEach(corretora => {
      console.log(`✅   - ID: ${corretora.id}, Nome: ${corretora.corretora}, Ambiente: ${corretora.ambiente}`);
      console.log(`✅     - spot_rest_api_url: ${corretora.spot_rest_api_url}`);
      console.log(`✅     - futures_rest_api_url: ${corretora.futures_rest_api_url}`);
      console.log(`✅     - futures_ws_market_url: ${corretora.futures_ws_market_url}`);
      console.log(`✅     - futures_ws_api_url: ${corretora.futures_ws_api_url}`);
    });
    
    console.log('\n🎉 === CORREÇÃO CONCLUÍDA COM SUCESSO ===');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir URLs das corretoras:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Executar se for chamado diretamente
if (require.main === module) {
  fixCorretorUrls();
}

module.exports = { fixCorretorUrls };
