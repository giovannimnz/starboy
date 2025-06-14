const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getDatabaseInstance } = require('./db/conexao');
const websocketApi = require('./websocketApi');
const { executeLimitMakerEntry } = require('./posicoes/limitMakerEntry');
const axios = require('axios');

// Função de diagnóstico e correção
async function diagnosticarECorrigirSinaisPendentes() {
  console.log('=== DIAGNÓSTICO DE SINAIS PENDENTES ===');
  
  try {
    // Obter conexão com o banco
    const db = await getDatabaseInstance();
    console.log('✅ Conexão com o banco de dados estabelecida');
    
    // Verificar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
    `);
    
    console.log(`[DIAGNÓSTICO] Encontrados ${pendingSignals.length} sinais pendentes.`);
    
    if (pendingSignals.length === 0) {
      console.log('Não há sinais pendentes para processar.');
      return;
    }
    
    // Mostrar detalhes dos sinais
    pendingSignals.forEach(signal => {
      console.log(`[DIAGNÓSTICO] Sinal ID: ${signal.id}, Symbol: ${signal.symbol}, Status: ${signal.status}`);
      console.log(`  - Side: ${signal.side}, Entry price: ${signal.entry_price}`);
      console.log(`  - Created at: ${signal.created_at}, Account ID: ${signal.conta_id}`);
    });
    
    // Perguntar se deseja processar os sinais
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    readline.question('\nDeseja processar estes sinais pendentes? (s/n): ', async (answer) => {
      if (answer.toLowerCase() === 's') {
        console.log('\n[CORREÇÃO] Processando sinais pendentes...');
        
        for (const signal of pendingSignals) {
          console.log(`\n[CORREÇÃO] Processando sinal ID ${signal.id} (${signal.symbol})...`);
          
          try {
            // Marcar como em processamento
            await db.query(
              'UPDATE webhook_signals SET status = "PROCESSANDO" WHERE id = ?',
              [signal.id]
            );
            
            // Obter preço atual
            console.log(`[CORREÇÃO] Obtendo preço atual para ${signal.symbol}...`);
            const currentPrice = await getCurrentPrice(signal.symbol);
            
            if (!currentPrice) {
              throw new Error(`Não foi possível obter preço atual para ${signal.symbol}`);
            }
            
            console.log(`[CORREÇÃO] Preço atual de ${signal.symbol}: ${currentPrice}`);
            
            // Executar a entrada
            console.log(`[CORREÇÃO] Executando entrada para ${signal.symbol}...`);
            
            const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, signal.conta_id || 1);
            
            if (entryResult && entryResult.success) {
              console.log(`[CORREÇÃO] ✅ Entrada executada com sucesso para sinal ID ${signal.id}`);
              console.log(`  - Position ID: ${entryResult.positionId}`);
              console.log(`  - Quantidade: ${entryResult.filledQuantity}`);
              console.log(`  - Preço médio: ${entryResult.averagePrice}`);
            } else {
              console.log(`[CORREÇÃO] ❌ Falha ao executar entrada: ${entryResult?.error || 'Erro desconhecido'}`);
            }
          } catch (error) {
            console.error(`[CORREÇÃO] ❌ Erro ao processar sinal ID ${signal.id}:`, error);
            
            // Atualizar status para ERROR
            try {
              await db.query(
                'UPDATE webhook_signals SET status = "ERROR", error_message = ? WHERE id = ?',
                [error.message.substring(0, 250), signal.id]
              );
              console.log(`[CORREÇÃO] Status do sinal atualizado para ERROR`);
            } catch (updateError) {
              console.error(`[CORREÇÃO] Erro adicional ao atualizar status:`, updateError);
            }
          }
        }
        
        console.log('\n[CORREÇÃO] Processamento de sinais concluído.');
      } else {
        console.log('Operação cancelada pelo usuário.');
      }
      
      readline.close();
      
      // Verificar status após processamento
      const [updatedSignals] = await db.query(`
        SELECT id, symbol, status, error_message FROM webhook_signals
        WHERE id IN (${pendingSignals.map(s => s.id).join(',')})
      `);
      
      console.log('\n=== RESULTADO FINAL ===');
      updatedSignals.forEach(signal => {
        console.log(`Sinal ID ${signal.id} (${signal.symbol}): Status = ${signal.status}`);
        if (signal.error_message) {
          console.log(`  - Erro: ${signal.error_message}`);
        }
      });
      
      process.exit(0);
    });
    
  } catch (error) {
    console.error('Erro no diagnóstico:', error);
    process.exit(1);
  }
}

// Substituir getCurrentPrice por uma função que tenta usar WebSocket primeiro
async function getCurrentPrice(symbol) {
  try {
    console.log(`[DIAGNÓSTICO] Tentando obter preço de ${symbol} via WebSocket API...`);
    
    // Garantir que a WebSocket API está inicializada
    await websocketApi.initializeHandlers(1); // accountId = 1
    
    // Iniciar o WebSocket de preço se necessário
    await websockets.ensurePriceWebsocketExists(symbol, 1);
    
    // Aguardar um momento para o WebSocket receber dados
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Tentar obter o preço do cache de WebSocket
    // (assumindo que você implementou a função getWebSocketPrice)
    const price = await getWebSocketPrice(symbol);
    
    if (price && !isNaN(price) && price > 0) {
      console.log(`[DIAGNÓSTICO] Preço obtido via WebSocket: ${price}`);
      return price;
    }
    
    // Fallback para API REST
    throw new Error('Preço não disponível via WebSocket, usando fallback REST API');
  } catch (error) {
    console.log(`[DIAGNÓSTICO] Usando fallback REST API para obter preço: ${error.message}`);
    
    // Fallback para REST API
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    if (response.data && response.data.price) {
      const price = parseFloat(response.data.price);
      console.log(`[DIAGNÓSTICO] Preço obtido via REST API: ${price}`);
      return price;
    }
    throw new Error('Preço não disponível na resposta da REST API');
  }
}

// Função para obter preço do websocket (se implementada)
async function getWebSocketPrice(symbol, maxAgeMs = 5000) {
  try {
    // Verificar se o módulo monitoramento está disponível
    const monitoramento = require('./posicoes/monitoramento');
    if (monitoramento && typeof monitoramento.getWebSocketPrice === 'function') {
      return await monitoramento.getWebSocketPrice(symbol, maxAgeMs);
    }
    
    throw new Error('Função getWebSocketPrice não disponível');
  } catch (error) {
    console.error(`[DIAGNÓSTICO] Erro ao usar getWebSocketPrice: ${error.message}`);
    throw error;
  }
}

// Executar diagnóstico
diagnosticarECorrigirSinaisPendentes();