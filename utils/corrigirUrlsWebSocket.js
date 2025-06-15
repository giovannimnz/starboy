const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getDatabaseInstance } = require('../db/conexao');

async function corrigirUrlsWebSocket() {
  try {
    console.log('=== CORREÇÃO DAS URLs DE WEBSOCKET DA BINANCE ===');
    
    const db = await getDatabaseInstance();
    
    // URLs corretas de acordo com a documentação oficial da Binance
    const urlsCorretas = {
      produção: {
        futures_ws_market_url: 'wss://fstream.binance.com',
        futures_ws_api_url: 'wss://ws-fapi.binance.com/ws-fapi/v1'
      },
      testnet: {
        futures_ws_market_url: 'wss://fstream.binancefuture.com',
        futures_ws_api_url: 'wss://testnet.binancefuture.com/ws-fapi/v1'
      }
    };
    
    // Obter todas as corretoras
    const [corretoras] = await db.query('SELECT id, corretora, ambiente, futures_ws_market_url, futures_ws_api_url FROM corretoras');
    
    console.log(`Encontradas ${corretoras.length} corretoras no banco de dados.`);
    
    // Verificar e corrigir cada corretora
    for (const corretora of corretoras) {
      console.log(`\nVerificando corretora ID ${corretora.id} (${corretora.corretora}, ambiente: ${corretora.ambiente}):`);
      
      const isProd = corretora.ambiente === 'prd';
      const urlsAmbiente = isProd ? urlsCorretas.produção : urlsCorretas.testnet;
      
      // Verificar URL do WebSocket Market
      if (corretora.futures_ws_market_url !== urlsAmbiente.futures_ws_market_url) {
        console.log(`  ❌ URL WebSocket Market incorreta: ${corretora.futures_ws_market_url}`);
        console.log(`  ✅ Corrigindo para: ${urlsAmbiente.futures_ws_market_url}`);
        
        await db.query(
          'UPDATE corretoras SET futures_ws_market_url = ? WHERE id = ?',
          [urlsAmbiente.futures_ws_market_url, corretora.id]
        );
      } else {
        console.log(`  ✓ URL WebSocket Market correta: ${corretora.futures_ws_market_url}`);
      }
      
      // Verificar URL do WebSocket API
      if (corretora.futures_ws_api_url !== urlsAmbiente.futures_ws_api_url) {
        console.log(`  ❌ URL WebSocket API incorreta: ${corretora.futures_ws_api_url}`);
        console.log(`  ✅ Corrigindo para: ${urlsAmbiente.futures_ws_api_url}`);
        
        await db.query(
          'UPDATE corretoras SET futures_ws_api_url = ? WHERE id = ?',
          [urlsAmbiente.futures_ws_api_url, corretora.id]
        );
      } else {
        console.log(`  ✓ URL WebSocket API correta: ${corretora.futures_ws_api_url}`);
      }
    }
    
    console.log('\n✅ Correção das URLs de WebSocket concluída com sucesso!');
    console.log('Por favor, reinicie o sistema para aplicar as alterações.');
    
  } catch (error) {
    console.error('Erro durante a correção das URLs:', error);
  }
}

corrigirUrlsWebSocket();