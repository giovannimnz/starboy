const { getDatabaseInstance } = require('../../../core/database/conexao');
const { getAllOpenPositions, newMarketOrder, cancelOrder, getOpenOrders, loadCredentialsFromDatabase } = require('../api/rest');
const { sendTelegramMessage, formatAlertMessage } = require('../telegram/telegramBot');

/**
 * Fecha TODAS as posições abertas de uma conta a mercado
 * @param {number} accountId - ID da conta
 * @param {boolean} cancelOrders - Se deve cancelar ordens abertas antes (padrão: true)
 * @param {boolean} notifyTelegram - Se deve notificar via Telegram (padrão: true)
 * @returns {Promise<Object>} - Resultado da operação
 */
async function closeAllPositions(accountId, cancelOrders = true, notifyTelegram = true) {
  console.log(`[CLOSE_ALL] 🚨 INICIANDO FECHAMENTO DE TODAS AS POSIÇÕES - CONTA ${accountId}`);
  
  // Carregar credenciais da conta antes de qualquer operação
  console.log(`[CLOSE_ALL] 🔑 Carregando credenciais da conta ${accountId}...`);
  try {
    await loadCredentialsFromDatabase(accountId);
    console.log(`[CLOSE_ALL] ✅ Credenciais carregadas com sucesso`);
  } catch (credError) {
    throw new Error(`Erro ao carregar credenciais da conta ${accountId}: ${credError.message}`);
  }
  
  const db = await getDatabaseInstance();
  if (!db) {
    throw new Error('Falha ao conectar ao banco de dados');
  }

  const results = {
    totalPositions: 0,
    closedPositions: 0,
    ordersCanceled: 0,
    errors: [],
    closedSymbols: [],
    startTime: new Date(),
    endTime: null
  };

  try {
    // 1. Buscar todas as posições abertas na corretora
    console.log(`[CLOSE_ALL] 📊 Buscando posições abertas na corretora...`);
    const exchangePositions = await getAllOpenPositions(accountId);
    results.totalPositions = exchangePositions.length;
    
    if (exchangePositions.length === 0) {
      console.log(`[CLOSE_ALL] ✅ Nenhuma posição aberta encontrada na conta ${accountId}`);
      results.endTime = new Date();
      return results;
    }

    console.log(`[CLOSE_ALL] 📋 Encontradas ${exchangePositions.length} posições abertas:`);
    exchangePositions.forEach(pos => {
      console.log(`[CLOSE_ALL]   - ${pos.simbolo}: ${pos.quantidade} (${pos.lado || pos.side})`);
    });

    // 2. Cancelar todas as ordens abertas (se solicitado)
    if (cancelOrders) {
      console.log(`[CLOSE_ALL] 🚫 Cancelando todas as ordens abertas...`);
      
      try {
        const openOrders = await getOpenOrders(accountId);
        console.log(`[CLOSE_ALL] 📋 Encontradas ${openOrders.length} ordens abertas para cancelar`);
        
        for (const order of openOrders) {
          try {
            await cancelOrder(order.symbol, order.orderId, accountId);
            results.ordersCanceled++;
            console.log(`[CLOSE_ALL] ✅ Ordem cancelada: ${order.symbol} ${order.orderId}`);
          } catch (cancelError) {
            console.error(`[CLOSE_ALL] ❌ Erro ao cancelar ordem ${order.orderId}:`, cancelError.message);
            results.errors.push(`Cancelar ordem ${order.orderId}: ${cancelError.message}`);
          }
        }
      } catch (ordersError) {
        console.error(`[CLOSE_ALL] ⚠️ Erro ao buscar ordens abertas:`, ordersError.message);
        results.errors.push(`Buscar ordens: ${ordersError.message}`);
      }
    }

    // 3. Fechar todas as posições a mercado
    console.log(`[CLOSE_ALL] 💥 Fechando todas as posições a mercado...`);
    
    for (const pos of exchangePositions) {
      const symbol = pos.simbolo;
      const quantity = Math.abs(parseFloat(pos.quantidade));
      
      // Determinar lado oposto para fechar
      const positionSide = pos.lado || pos.side;
      const closeSide = (positionSide === 'BUY' || positionSide === 'LONG') ? 'SELL' : 'BUY';
      
      if (quantity <= 0) {
        console.warn(`[CLOSE_ALL] ⚠️ Quantidade inválida para ${symbol}: ${quantity}`);
        continue;
      }

      try {
        console.log(`[CLOSE_ALL] 🎯 Fechando ${symbol}: ${quantity} (${closeSide})`);
        
        const result = await newMarketOrder(accountId, symbol, quantity, closeSide);
        
        if (result && result.orderId) {
          results.closedPositions++;
          results.closedSymbols.push({
            symbol: symbol,
            quantity: quantity,
            side: closeSide,
            orderId: result.orderId,
            price: result.avgPrice || result.price || 'Market'
          });
          console.log(`[CLOSE_ALL] ✅ ${symbol} fechado com sucesso - Ordem: ${result.orderId}`);
        } else {
          throw new Error('Resposta inválida da API');
        }
        
        // Pequena pausa entre ordens para evitar rate limit
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (closeError) {
        console.error(`[CLOSE_ALL] ❌ Erro ao fechar ${symbol}:`, closeError.message);
        results.errors.push(`Fechar ${symbol}: ${closeError.message}`);
      }
    }

    // 4. Marcar posições como fechadas no banco (se necessário)
    console.log(`[CLOSE_ALL] 📚 Atualizando status no banco de dados...`);
    try {
      for (const closedSymbol of results.closedSymbols) {
        await db.query(
          `UPDATE posicoes SET status = 'CLOSED', data_hora_fechamento = NOW() 
           WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
          [closedSymbol.symbol, accountId]
        );
      }
    } catch (dbError) {
      console.error(`[CLOSE_ALL] ⚠️ Erro ao atualizar banco:`, dbError.message);
      results.errors.push(`Atualizar banco: ${dbError.message}`);
    }

    results.endTime = new Date();
    const duration = results.endTime - results.startTime;

    // 5. Relatório final
    console.log(`[CLOSE_ALL] 📊 === RELATÓRIO FINAL ===`);
    console.log(`[CLOSE_ALL] ⏱️  Duração: ${duration}ms`);
    console.log(`[CLOSE_ALL] 📋 Posições encontradas: ${results.totalPositions}`);
    console.log(`[CLOSE_ALL] ✅ Posições fechadas: ${results.closedPositions}`);
    console.log(`[CLOSE_ALL] 🚫 Ordens canceladas: ${results.ordersCanceled}`);
    console.log(`[CLOSE_ALL] ❌ Erros: ${results.errors.length}`);
    
    if (results.closedSymbols.length > 0) {
      console.log(`[CLOSE_ALL] 📜 Símbolos fechados:`);
      results.closedSymbols.forEach(item => {
        console.log(`[CLOSE_ALL]   ✅ ${item.symbol}: ${item.quantity} @ ${item.price} (Ordem: ${item.orderId})`);
      });
    }

    if (results.errors.length > 0) {
      console.log(`[CLOSE_ALL] ⚠️ Erros encontrados:`);
      results.errors.forEach(error => {
        console.log(`[CLOSE_ALL]   ❌ ${error}`);
      });
    }

    // 6. Notificação Telegram
    if (notifyTelegram) {
      try {
        const successRate = results.totalPositions > 0 ? (results.closedPositions / results.totalPositions * 100).toFixed(1) : '0';
        
        let message = `🚨 <b>FECHAMENTO EM MASSA - CONTA ${accountId}</b>\n\n`;
        message += `📊 <b>Resumo:</b>\n`;
        message += `• Posições encontradas: ${results.totalPositions}\n`;
        message += `• Posições fechadas: ${results.closedPositions}\n`;
        message += `• Taxa de sucesso: ${successRate}%\n`;
        message += `• Ordens canceladas: ${results.ordersCanceled}\n`;
        message += `• Erros: ${results.errors.length}\n`;
        message += `• Duração: ${duration}ms\n\n`;
        
        if (results.closedSymbols.length > 0) {
          message += `✅ <b>Posições fechadas:</b>\n`;
          results.closedSymbols.forEach(item => {
            message += `• ${item.symbol}: ${item.quantity} ${item.side}\n`;
          });
        }
        
        if (results.errors.length > 0) {
          message += `\n❌ <b>Erros:</b>\n`;
          results.errors.slice(0, 5).forEach(error => { // Limitar a 5 erros
            message += `• ${error}\n`;
          });
          if (results.errors.length > 5) {
            message += `• ... e mais ${results.errors.length - 5} erros\n`;
          }
        }

        await sendTelegramMessage(accountId, message);
        console.log(`[CLOSE_ALL] 📱 Relatório enviado via Telegram`);
      } catch (telegramError) {
        console.error(`[CLOSE_ALL] ⚠️ Erro ao enviar notificação Telegram:`, telegramError.message);
      }
    }

    return results;

  } catch (error) {
    results.endTime = new Date();
    results.errors.push(`Erro geral: ${error.message}`);
    console.error(`[CLOSE_ALL] 💥 ERRO CRÍTICO:`, error.message);
    throw error;
  }
}

/**
 * Função para uso via linha de comando
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
FECHAMENTO EM MASSA DE POSIÇÕES
================================

Uso: node closeAllPositions.js <accountId> [opções]

Argumentos:
  <accountId>           ID da conta (obrigatório)

Opções:
  --no-cancel-orders    Não cancelar ordens abertas antes
  --no-telegram         Não enviar notificação via Telegram
  --confirm             Confirmar ação (obrigatório para segurança)

Exemplo:
  node closeAllPositions.js 1 --confirm
  node closeAllPositions.js 1 --no-cancel-orders --confirm
    `);
    process.exit(1);
  }

  const accountId = parseInt(args[0]);
  const cancelOrders = !args.includes('--no-cancel-orders');
  const notifyTelegram = !args.includes('--no-telegram');
  const confirmed = args.includes('--confirm');

  if (!accountId || isNaN(accountId)) {
    console.error('❌ ID da conta inválido');
    process.exit(1);
  }

  if (!confirmed) {
    console.error('❌ Esta ação é IRREVERSÍVEL! Use --confirm para confirmar');
    process.exit(1);
  }

  console.log(`⚠️  ATENÇÃO: Esta ação irá fechar TODAS as posições da conta ${accountId}!`);
  console.log(`⚠️  Cancelar ordens: ${cancelOrders ? 'SIM' : 'NÃO'}`);
  console.log(`⚠️  Notificar Telegram: ${notifyTelegram ? 'SIM' : 'NÃO'}`);
  
  // Aguardar 3 segundos para o usuário ter chance de cancelar
  console.log(`⏳ Iniciando em 3 segundos... (Ctrl+C para cancelar)`);
  await new Promise(resolve => setTimeout(resolve, 3010));

  try {
    const result = await closeAllPositions(accountId, cancelOrders, notifyTelegram);
    
    console.log(`\n🎉 OPERAÇÃO CONCLUÍDA!`);
    console.log(`✅ ${result.closedPositions}/${result.totalPositions} posições fechadas`);
    
    if (result.errors.length > 0) {
      console.log(`❌ ${result.errors.length} erros encontrados`);
      process.exit(1);
    } else {
      process.exit(0);
    }
  } catch (error) {
    console.error(`💥 ERRO FATAL:`, error.message);
    process.exit(1);
  }
}

// Se executado diretamente
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  closeAllPositions
};
