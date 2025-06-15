const { getDatabaseInstance } = require('../db/conexao');

async function cleanup() {
  try {
    console.log('Limpando configurações inconsistentes...');
    
    const db = await getDatabaseInstance();
    
    // Verificar e corrigir URLs da corretora
    const [corretora] = await db.query('SELECT * FROM corretoras WHERE id = 1');
    
    if (corretora.length > 0) {
      const { ambiente, futures_ws_api_url } = corretora[0];
      
      if (ambiente === 'prd' && futures_ws_api_url.includes('testnet')) {
        console.log('Corrigindo URLs para produção...');
        await db.query(`
          UPDATE corretoras SET 
            futures_rest_api_url = 'https://fapi.binance.com/fapi',
            futures_ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi/v1',
            futures_ws_market_url = 'wss://fstream.binance.com'
          WHERE id = 1
        `);
        console.log('URLs corrigidas!');
      }
    }
    
    console.log('Limpeza concluída!');
    process.exit(0);
  } catch (error) {
    console.error('Erro durante limpeza:', error);
    process.exit(1);
  }
}

cleanup();