const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets'); // Adicione esta linha
const websocketApi = require('../websocketApi');
const { executeLimitMakerEntry } = require('../posicoes/limitMakerEntry');
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

// Função para obter preço via WebSocket
async function getCurrentPrice(symbol) {
  try {
    console.log(`[DIAGNÓSTICO] Tentando obter preço de ${symbol} via WebSocket API...`);
    
    // Garantir que a WebSocket API está inicializada
    await websocketApi.initializeHandlers(1); // accountId = 1
    
    // Iniciar o WebSocket de preço se necessário
    try {
      await websockets.ensurePriceWebsocketExists(symbol, 1);
      
      // Aguardar um momento para o WebSocket receber dados
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Tentar obter o preço do cache de WebSocket
      const price = await getWebSocketPrice(symbol);
      
      if (price && !isNaN(price) && price > 0) {
        console.log(`[DIAGNÓSTICO] Preço obtido via WebSocket: ${price}`);
        return price;
      }
    } catch (wsError) {
      console.log(`[DIAGNÓSTICO] Erro ao usar WebSocket: ${wsError.message}`);
    }
    
    // Fallback para API REST
    console.log('[DIAGNÓSTICO] Usando fallback REST API para obter preço');
    
    // Obter URL da API da corretora
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase(1);
    
    // Construir URL completa garantindo que é válida
    const completeUrl = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    console.log(`[DIAGNÓSTICO] URL de consulta de preço: ${completeUrl}`);
    
    // Fazer requisição HTTP
    const response = await axios.get(completeUrl);
    
    if (response.data && response.data.price) {
      const price = parseFloat(response.data.price);
      console.log(`[DIAGNÓSTICO] Preço obtido via REST API: ${price}`);
      return price;
    }
    throw new Error('Preço não disponível na resposta da REST API');
  } catch (error) {
    console.log(`[DIAGNÓSTICO] Erro ao obter preço: ${error.message}`);
    throw error;
  }
}

/**
 * Função melhorada para obter o preço atual usando o cache de websocket
 * @param {string} symbol - Símbolo do par
 * @param {number} maxAgeMs - Idade máxima do preço em cache (ms)
 * @returns {Promise<number>} O preço atual
 */
async function getWebSocketPrice(symbol, maxAgeMs = 5000) {
  // Se não temos o símbolo no cache ou não tem websocket iniciado, iniciamos um
  if (!latestPrices.has(symbol)) {
    console.log(`[MONITOR] Iniciando monitoramento de preço via WebSocket para ${symbol}`);
    await websockets.ensurePriceWebsocketExists(symbol);
    
    // Aguardar um tempo para o websocket receber a primeira atualização
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Verificar se temos uma atualização recente no cache
  const priceEntry = latestPrices.get(symbol);
  const now = Date.now();
  
  if (priceEntry && (now - priceEntry.timestamp) < maxAgeMs) {
    return priceEntry.price;
  }

  // Se o preço for muito antigo ou não existir, fazer fallback para REST API
  console.log(`[MONITOR] Preço de ${symbol} não disponível via WebSocket (ou antigo), usando REST API como fallback`);
  try {
    // Obter URL da API da corretora
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase(1);
    
    // Construir URL completa garantindo que é válida
    const completeUrl = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    const response = await axios.get(completeUrl);
    
    if (!response.data || !response.data.price) {
      throw new Error(`Resposta inválida da API para ${symbol}`);
    }
    
    const restPrice = parseFloat(response.data.price);
    
    // Atualizar o cache com o preço da REST API
    if (restPrice) {
      latestPrices.set(symbol, {
        price: restPrice,
        timestamp: Date.now(),
        bid: restPrice * 0.9999,
        ask: restPrice * 1.0001
      });
    }
    
    return restPrice;
  } catch (error) {
    console.error(`[MONITOR] Erro no fallback REST para ${symbol}:`, error);
    
    // Se temos algum preço em cache, mesmo antigo, retorná-lo como último recurso
    if (priceEntry) {
      console.log(`[MONITOR] Usando preço em cache antigo para ${symbol}: ${priceEntry.price}`);
      return priceEntry.price;
    }
    
    throw error;
  }
}

// Executar diagnóstico
diagnosticarECorrigirSinaisPendentes();