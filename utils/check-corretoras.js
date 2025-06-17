// Script para verificar e corrigir tabela corretoras
const { getDatabaseInstance } = require('../db/conexao');

async function checkCorretoras() {
  console.log('🔍 Verificando tabela corretoras...');
  
  try {
    const db = await getDatabaseInstance();
    
    console.log('\n=== VERIFICANDO CORRETORA ID 1 ===');
    const [corretoras] = await db.query('SELECT * FROM corretoras WHERE id = 1');
    
    if (corretoras.length === 0) {
      console.log('❌ Corretora ID 1 não encontrada!');
      
      console.log('\n🔧 Criando corretora padrão...');
      await db.query(`
        INSERT INTO corretoras (id, corretora, ambiente, futures_rest_api_url, futures_ws_market_url, futures_ws_api_url)
        VALUES (1, 'binance', 'prd', 'https://fapi.binance.com/fapi', 'wss://fstream.binance.com', 'wss://ws-fapi.binance.com/ws-fapi/v1')
        ON DUPLICATE KEY UPDATE
        corretora = VALUES(corretora),
        ambiente = VALUES(ambiente),
        futures_rest_api_url = VALUES(futures_rest_api_url),
        futures_ws_market_url = VALUES(futures_ws_market_url),
        futures_ws_api_url = VALUES(futures_ws_api_url)
      `);
      
      console.log('✅ Corretora criada/atualizada com sucesso!');
    } else {
      const corretora = corretoras[0];
      console.log('✅ Corretora ID 1 encontrada:');
      console.log('  - Nome:', corretora.corretora);
      console.log('  - Ambiente:', corretora.ambiente);
      console.log('  - REST API URL:', corretora.futures_rest_api_url);
      console.log('  - WS Market URL:', corretora.futures_ws_market_url);
      console.log('  - WS API URL:', corretora.futures_ws_api_url);
      
      // Verificar se URLs estão corretas para o ambiente
      const isProduction = corretora.ambiente === 'prd';
      const hasTestnetUrls = corretora.futures_rest_api_url?.includes('testnet') || 
                            corretora.futures_ws_api_url?.includes('testnet') ||
                            corretora.futures_ws_market_url?.includes('testnet');
      
      if (isProduction && hasTestnetUrls) {
        console.log('⚠️ PROBLEMA: Ambiente de produção usando URLs de testnet!');
        console.log('🔧 Corrigindo URLs...');
        
        await db.query(`
          UPDATE corretoras 
          SET futures_rest_api_url = 'https://fapi.binance.com/fapi',
              futures_ws_market_url = 'wss://fstream.binance.com',
              futures_ws_api_url = 'wss://ws-fapi.binance.com/ws-fapi/v1'
          WHERE id = 1
        `);
        
        console.log('✅ URLs corrigidas para produção!');
      } else if (!isProduction && !hasTestnetUrls) {
        console.log('⚠️ PROBLEMA: Ambiente de testnet usando URLs de produção!');
        console.log('🔧 Corrigindo URLs...');
        
        await db.query(`
          UPDATE corretoras 
          SET futures_rest_api_url = 'https://testnet.binancefuture.com/fapi',
              futures_ws_market_url = 'wss://stream.binancefuture.com',
              futures_ws_api_url = 'wss://testnet.binancefuture.com/ws-fapi/v1'
          WHERE id = 1
        `);
        
        console.log('✅ URLs corrigidas para testnet!');
      } else {
        console.log('✅ URLs estão corretas para o ambiente');
      }
    }
    
    console.log('\n=== VERIFICANDO CONTA ID 1 ===');
    const [contas] = await db.query(`
      SELECT c.id, c.nome, c.id_corretora, c.ativa,
             c.api_key IS NOT NULL as has_api_key,
             c.api_secret IS NOT NULL as has_api_secret,
             c.ws_api_key IS NOT NULL as has_ws_api_key,
             c.ws_api_secret IS NOT NULL as has_ws_api_secret
      FROM contas c 
      WHERE c.id = 1
    `);
    
    if (contas.length === 0) {
      console.log('❌ Conta ID 1 não encontrada!');
    } else {
      const conta = contas[0];
      console.log('✅ Conta ID 1 encontrada:');
      console.log('  - Nome:', conta.nome);
      console.log('  - ID Corretora:', conta.id_corretora);
      console.log('  - Ativa:', conta.ativa);
      console.log('  - API Key:', conta.has_api_key ? 'PRESENTE' : 'AUSENTE');
      console.log('  - API Secret:', conta.has_api_secret ? 'PRESENTE' : 'AUSENTE');
      console.log('  - WS API Key:', conta.has_ws_api_key ? 'PRESENTE' : 'AUSENTE');
      console.log('  - WS API Secret:', conta.has_ws_api_secret ? 'PRESENTE' : 'AUSENTE');
    }
    
    console.log('\n🎉 Verificação concluída!');
    
  } catch (error) {
    console.error('❌ Erro na verificação:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  checkCorretoras();
}

module.exports = { checkCorretoras };