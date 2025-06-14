const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { getDatabaseInstance } = require('./db/conexao');
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

// Função para obter preço atual
async function getCurrentPrice(symbol) {
  try {
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${symbol}`);
    if (response.data && response.data.price) {
      return parseFloat(response.data.price);
    }
    throw new Error('Preço não disponível na resposta');
  } catch (error) {
    console.error(`[API] Erro ao obter preço atual para ${symbol}:`, error.message);
    throw error;
  }
}

// Executar diagnóstico
diagnosticarECorrigirSinaisPendentes();