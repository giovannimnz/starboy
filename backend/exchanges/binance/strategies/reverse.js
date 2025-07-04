const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const rest = require('../api/rest');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { getRecentOrders, editOrder, roundPriceToTickSize, newMarketOrder, newLimitMakerOrder, newReduceOnlyOrder, cancelOrder, newStopOrder, getOpenOrders, getOrderStatus, getAllOpenPositions, getFuturesAccountBalanceDetails, getPrecision, getTickSize, getPrecisionCached, validateQuantity, adjustQuantityToRequirements } = require('../api/rest');
const { sendTelegramMessage, formatEntryMessage, formatErrorMessage, formatAlertMessage, formatEntryMessageWithPrecision } = require('../services/telegramHelper');

/**
 * ✅ NOVA FUNÇÃO: Executa o reverse com todas as melhorias solicitadas
 * - Criação obrigatória da posição no banco antes de qualquer ordem
 * - Atualização do sinal (webhook_signals) com o id da posição
 * - Sistema Pub/Sub dedicado para esta execução
 * - Insert de cada ordem (entrada, SL, TP) no banco imediatamente após envio para a corretora
 * - Delay de 3 segundos entre cada insert para evitar deadlock
 * - Timeout de 45 segundos para confirmação via webhook
 * - Após timeout, polling REST para status da ordem até preenchimento
 * - Atualização da posição e ordens no banco com dados reais após preenchimento
 * - Não depende exclusivamente do webhook para confirmação de ordens
 */
async function executeReverse(signal, currentPrice, accountId) {
  console.log(`[REVERSE_IMPROVED] 🚀 Executando entrada para sinal ${signal.id}: ${signal.symbol} ${signal.side} a ${signal.entry_price} (conta ${accountId})`);

  let connection = null;
  let positionId = null;
  let entryOrderId = null;
  let slOrderId = null;
  let tpOrderIds = [];
  let webhookTimeout = null;
  let positionCreated = false;
  const executionId = `reverse-entry-${signal.id}-${Date.now()}`;
  
  // ✅ CONSTANTES
  const WEBHOOK_TIMEOUT_MS = 45000; // 45 segundos
  const ORDER_INSERT_DELAY_MS = 3000; // 3 segundos entre inserts
  const MAX_REST_POLLING_ATTEMPTS = 20; // 2 minutos de polling
  const REST_POLLING_INTERVAL_MS = 6000; // 6 segundos entre consultas
  
  try {
    // 1. OBTER CONEXÃO DO BANCO
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
    }
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 2. VERIFICAR SE JÁ EXISTE POSIÇÃO ABERTA
    const existingPositionsOnExchange = await getAllOpenPositions(accountId);
    const positionAlreadyExists = existingPositionsOnExchange.some(p =>
      p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
    );

    if (positionAlreadyExists) {
      console.log(`[REVERSE_IMPROVED] ALERTA: Posição já existe para ${signal.symbol}. Cancelando.`);
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        ['Posição já existe na corretora', signal.id]
      );
      await connection.commit();
      return { success: false, error: 'Posição já existe na corretora' };
    }

    // 3. OBTER PRECISÃO E CALCULAR TAMANHOS
    const precisionInfo = await getPrecision(signal.symbol, accountId);
    const quantityPrecision = precisionInfo.quantityPrecision;
    const pricePrecision = precisionInfo.pricePrecision;
    const stepSize = precisionInfo.stepSize;

    console.log(`[REVERSE_IMPROVED] Precisão para ${signal.symbol}: qty=${quantityPrecision}, price=${pricePrecision}, step=${stepSize}`);

    const availableBalance = await getAvailableBalance(accountId);
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage);

    const currentPriceTrigger = signal.entry_price ? parseFloat(signal.entry_price) : 
                                (signal.price ? parseFloat(signal.price) : 
                                await rest.getPrice(signal.symbol, accountId));

    if (!currentPriceTrigger || currentPriceTrigger <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPriceTrigger}`);
    }

    const totalEntrySize = calculateOrderSize(
      availableBalance, capitalPercentage, currentPriceTrigger, leverage, stepSize, quantityPrecision
    );

    if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
      throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
    }

    const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';

    console.log(`[REVERSE_IMPROVED] Tamanho calculado: ${totalEntrySize.toFixed(quantityPrecision)} ${signal.symbol}`);

    // 4. ✅ CRIAÇÃO OBRIGATÓRIA DA POSIÇÃO NO BANCO ANTES DE QUALQUER ORDEM
    console.log(`[REVERSE_IMPROVED] 📊 Criando posição no banco antes das ordens...`);
    
    const positionData = {
      simbolo: signal.symbol,
      quantidade: totalEntrySize,
      quantidade_aberta: totalEntrySize,
      preco_medio: currentPriceTrigger,
      status: 'OPEN',
      data_hora_abertura: new Date(),
      side: binanceSide,
      leverage: leverage,
      data_hora_ultima_atualizacao: new Date(),
      preco_entrada: currentPriceTrigger,
      preco_corrente: currentPriceTrigger,
      trailing_stop_level: 'ORIGINAL',
      pnl_corrente: 0,
      observacoes: `Criada pelo reverse para sinal ${signal.id}`,
      margin_type: 'isolated',
      position_side: 'BOTH'
    };

    positionId = await insertPosition(connection, positionData, accountId);
    positionCreated = true;
    console.log(`[REVERSE_IMPROVED] ✅ Posição criada no banco com ID: ${positionId}`);

    // 5. ✅ ATUALIZAR O SINAL COM O ID DA POSIÇÃO
    await connection.query(
      `UPDATE webhook_signals SET position_id = ?, status = 'ENTRADA_EM_PROGRESSO', updated_at = NOW() WHERE id = ?`,
      [positionId, signal.id]
    );
    console.log(`[REVERSE_IMPROVED] ✅ Sinal ${signal.id} atualizado com position_id: ${positionId}`);

    // 6. ✅ CONFIGURAR SISTEMA PUB/SUB DEDICADO PARA ESTA EXECUÇÃO
    let orderFilled = false;
    let orderFilledData = null;

    const orderUpdateHandler = (orderMsg) => {
      if (!orderMsg || !orderMsg.o) return;
      
      const order = orderMsg.o;
      const orderId = String(order.i);
      const orderStatus = order.X;
      
      // Verificar se é nossa ordem de entrada
      if (orderId === entryOrderId) {
        console.log(`[REVERSE_IMPROVED] 🎯 Ordem de entrada ${orderId} atualizada: ${orderStatus}`);
        
        if (orderStatus === 'FILLED') {
          console.log(`[REVERSE_IMPROVED] ✅ Ordem de entrada PREENCHIDA via webhook!`);
          orderFilled = true;
          orderFilledData = {
            orderId: orderId,
            executedQty: parseFloat(order.z || '0'),
            avgPrice: parseFloat(order.ap || '0'),
            commission: parseFloat(order.n || '0'),
            commissionAsset: order.N || null,
            fills: order.fills || []
          };
          
          // Limpar timeout do webhook
          if (webhookTimeout) {
            clearTimeout(webhookTimeout);
            webhookTimeout = null;
          }
        }
      }
    };

    // Registrar listener dedicado
    websockets.registerEntryExecutionListener(orderUpdateHandler, accountId, executionId);
    console.log(`[REVERSE_IMPROVED] 🎧 Handler de webhook registrado com ID: ${executionId}`);

    // 7. ✅ ENVIAR ORDEM DE ENTRADA E INSERIR NO BANCO COM DELAY
    console.log(`[REVERSE_IMPROVED] 📤 Enviando ordem de entrada...`);
    
    const entryOrderResponse = await newMarketOrder(
      signal.symbol,
      binanceSide,
      totalEntrySize,
      accountId
    );

    if (!entryOrderResponse || !entryOrderResponse.orderId) {
      throw new Error(`Falha ao enviar ordem de entrada: ${JSON.stringify(entryOrderResponse)}`);
    }

    entryOrderId = String(entryOrderResponse.orderId);
    console.log(`[REVERSE_IMPROVED] ✅ Ordem de entrada enviada: ${entryOrderId}`);

    // Insert da ordem de entrada no banco
    await connection.query(
      `INSERT INTO ordens (
        tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
        id_externo, side, simbolo, tipo_ordem_bot, reduce_only, close_position, 
        last_update, orign_sig, observacao, conta_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'MARKET', currentPriceTrigger, totalEntrySize, positionId, 'NEW', 
        formatDateForMySQL(new Date()), entryOrderId, binanceSide, signal.symbol, 
        'ENTRADA', false, false, formatDateForMySQL(new Date()), 
        `WEBHOOK_${signal.id}`, 'Ordem de entrada do reverse', accountId
      ]
    );
    console.log(`[REVERSE_IMPROVED] 📋 Ordem de entrada inserida no banco`);

    // Delay obrigatório de 3 segundos
    console.log(`[REVERSE_IMPROVED] ⏱️ Aguardando ${ORDER_INSERT_DELAY_MS}ms antes da próxima ordem...`);
    await new Promise(resolve => setTimeout(resolve, ORDER_INSERT_DELAY_MS));

    // 8. ✅ CONFIGURAR TIMEOUT PARA WEBHOOK (45 segundos)
    let webhookTimedOut = false;
    
    webhookTimeout = setTimeout(async () => {
      console.log(`[REVERSE_IMPROVED] ⏰ Timeout do webhook atingido (${WEBHOOK_TIMEOUT_MS}ms). Iniciando polling REST...`);
      webhookTimedOut = true;
      
      // Iniciar polling via REST API
      let pollingAttempts = 0;
      
      while (pollingAttempts < MAX_REST_POLLING_ATTEMPTS && !orderFilled) {
        try {
          console.log(`[REVERSE_IMPROVED] 🔍 Consultando status da ordem ${entryOrderId} (tentativa ${pollingAttempts + 1}/${MAX_REST_POLLING_ATTEMPTS})`);
          
          const orderStatus = await getOrderStatus(signal.symbol, entryOrderId, accountId);
          
          if (orderStatus && orderStatus.status === 'FILLED') {
            console.log(`[REVERSE_IMPROVED] ✅ Ordem preenchida via REST API!`);
            orderFilled = true;
            orderFilledData = {
              orderId: entryOrderId,
              executedQty: parseFloat(orderStatus.executedQty || '0'),
              avgPrice: parseFloat(orderStatus.avgPrice || '0'),
              commission: parseFloat(orderStatus.commission || '0'),
              commissionAsset: orderStatus.commissionAsset || null,
              fills: orderStatus.fills || []
            };
            break;
          }
          
          pollingAttempts++;
          if (pollingAttempts < MAX_REST_POLLING_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, REST_POLLING_INTERVAL_MS));
          }
          
        } catch (pollingError) {
          console.error(`[REVERSE_IMPROVED] ❌ Erro no polling REST:`, pollingError.message);
          pollingAttempts++;
        }
      }
      
      if (!orderFilled) {
        console.error(`[REVERSE_IMPROVED] ❌ Ordem não foi preenchida após ${MAX_REST_POLLING_ATTEMPTS} tentativas de polling`);
      }
    }, WEBHOOK_TIMEOUT_MS);

    // 9. ✅ AGUARDAR PREENCHIMENTO DA ORDEM DE ENTRADA (webhook ou REST)
    console.log(`[REVERSE_IMPROVED] ⏳ Aguardando preenchimento da ordem de entrada...`);
    
    const maxWaitTime = WEBHOOK_TIMEOUT_MS + (MAX_REST_POLLING_ATTEMPTS * REST_POLLING_INTERVAL_MS) + 10000; // +10s buffer
    const startWaitTime = Date.now();
    
    while (!orderFilled && (Date.now() - startWaitTime) < maxWaitTime) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Check a cada segundo
    }

    if (!orderFilled) {
      throw new Error(`Ordem de entrada não foi preenchida dentro do tempo limite`);
    }

    // Limpar timeout se ainda estiver ativo
    if (webhookTimeout) {
      clearTimeout(webhookTimeout);
      webhookTimeout = null;
    }

    console.log(`[REVERSE_IMPROVED] 🎉 Ordem de entrada preenchida:`, orderFilledData);

    // 10. ✅ ATUALIZAR POSIÇÃO E ORDEM NO BANCO COM DADOS REAIS
    await connection.query(
      `UPDATE posicoes SET 
        quantidade_executada = ?, preco_medio = ?, preco_entrada = ?, 
        total_commission = ?, last_update = NOW()
       WHERE id = ?`,
      [
        orderFilledData.executedQty, orderFilledData.avgPrice, orderFilledData.avgPrice,
        orderFilledData.commission, positionId
      ]
    );

    await connection.query(
      `UPDATE ordens SET 
        status = 'FILLED', quantidade_executada = ?, preco_executado = ?, 
        commission = ?, commission_asset = ?, last_update = NOW()
       WHERE id_externo = ? AND conta_id = ?`,
      [
        orderFilledData.executedQty, orderFilledData.avgPrice,
        orderFilledData.commission, orderFilledData.commissionAsset,
        entryOrderId, accountId
      ]
    );

    console.log(`[REVERSE_IMPROVED] ✅ Posição e ordem atualizadas no banco com dados reais`);

    // 11. ✅ CRIAR ORDENS DE SL E TP
    if (signal.sl_price && signal.sl_price > 0) {
      console.log(`[REVERSE_IMPROVED] 📤 Criando ordem de Stop Loss...`);
      
      const slOrderResponse = await createStopLossOrder(
        signal, orderFilledData.avgPrice, orderFilledData.executedQty, 
        accountId, positionId, connection
      );
      
      if (slOrderResponse && slOrderResponse.orderId) {
        slOrderId = String(slOrderResponse.orderId);
        console.log(`[REVERSE_IMPROVED] ✅ Stop Loss criado: ${slOrderId}`);
        
        // Delay obrigatório
        await new Promise(resolve => setTimeout(resolve, ORDER_INSERT_DELAY_MS));
      }
    }

    // Criar ordens de Take Profit
    const tpPrices = [signal.tp1_price, signal.tp2_price, signal.tp3_price, signal.tp4_price, signal.tp5_price]
      .filter(price => price && price > 0);

    for (let i = 0; i < tpPrices.length; i++) {
      console.log(`[REVERSE_IMPROVED] 📤 Criando Take Profit ${i + 1}...`);
      
      const tpOrderResponse = await createTakeProfitOrder(
        signal, tpPrices[i], orderFilledData.executedQty / tpPrices.length, 
        accountId, positionId, connection, i + 1
      );
      
      if (tpOrderResponse && tpOrderResponse.orderId) {
        tpOrderIds.push(String(tpOrderResponse.orderId));
        console.log(`[REVERSE_IMPROVED] ✅ Take Profit ${i + 1} criado: ${tpOrderResponse.orderId}`);
        
        // Delay obrigatório (exceto na última)
        if (i < tpPrices.length - 1) {
          await new Promise(resolve => setTimeout(resolve, ORDER_INSERT_DELAY_MS));
        }
      }
    }

    // 12. ✅ ATUALIZAR STATUS DO SINAL PARA EXECUTADO
    await connection.query(
      `UPDATE webhook_signals SET status = 'EXECUTADO', updated_at = NOW() WHERE id = ?`,
      [signal.id]
    );

    await connection.commit();
    console.log(`[REVERSE_IMPROVED] ✅ Transação commitada com sucesso`);

    // 13. ✅ NOTIFICAÇÃO TELEGRAM
    const telegramMessage = `🎯 *Entrada Executada*\n\n` +
      `📊 *${signal.symbol}* - ${signal.side}\n` +
      `💰 Quantidade: ${orderFilledData.executedQty}\n` +
      `💵 Preço Médio: ${orderFilledData.avgPrice}\n` +
      `📈 Posição ID: ${positionId}\n` +
      `🔗 Ordem ID: ${entryOrderId}\n` +
      `${slOrderId ? `🛡️ Stop Loss: ${slOrderId}\n` : ''}` +
      `${tpOrderIds.length > 0 ? `🎯 Take Profits: ${tpOrderIds.join(', ')}\n` : ''}` +
      `⚡ Via: ${webhookTimedOut ? 'REST API' : 'WebSocket'}`;

    try {
      await sendTelegramMessage(telegramMessage, accountId);
      console.log(`[REVERSE_IMPROVED] 📱 Notificação Telegram enviada`);
    } catch (telegramError) {
      console.error(`[REVERSE_IMPROVED] ❌ Erro ao enviar Telegram:`, telegramError.message);
    }

    return {
      success: true,
      positionId: positionId,
      entryOrderId: entryOrderId,
      slOrderId: slOrderId,
      tpOrderIds: tpOrderIds,
      executedQty: orderFilledData.executedQty,
      avgPrice: orderFilledData.avgPrice,
      method: webhookTimedOut ? 'REST_POLLING' : 'WEBHOOK'
    };

  } catch (error) {
    console.error(`[REVERSE_IMPROVED] ❌ Erro na execução:`, error.message);
    
    try {
      if (connection) {
        await connection.rollback();
      }
      
      // Se posição foi criada, marcar como erro
      if (positionCreated && positionId) {
        await connection.query(
          `UPDATE posicoes SET status = 'ERROR', observacoes = ? WHERE id = ?`,
          [`Erro na execução: ${error.message}`, positionId]
        );
      }
      
      // Atualizar sinal com erro
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ?, updated_at = NOW() WHERE id = ?`,
        [error.message.substring(0, 250), signal.id]
      );
      
    } catch (cleanupError) {
      console.error(`[REVERSE_IMPROVED] ❌ Erro no cleanup:`, cleanupError.message);
    }
    
    return { success: false, error: error.message };

  } finally {
    // Cleanup
    try {
      if (webhookTimeout) {
        clearTimeout(webhookTimeout);
      }
      
      // Remover listener dedicado
      websockets.unregisterEntryExecutionListener(executionId);
      console.log(`[REVERSE_IMPROVED] 🔇 Handler de webhook removido: ${executionId}`);
      
      if (connection) {
        connection.release();
      }
    } catch (cleanupError) {
      console.error(`[REVERSE_IMPROVED] ❌ Erro no cleanup final:`, cleanupError.message);
    }
  }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Criar ordem de Stop Loss
 */
async function createStopLossOrder(signal, entryPrice, quantity, accountId, positionId, connection) {
  try {
    const slPrice = parseFloat(signal.sl_price);
    const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    
    const slOrderResponse = await newStopOrder(
      signal.symbol,
      binanceSide,
      quantity,
      slPrice,
      accountId,
      true // reduceOnly
    );
    
    if (slOrderResponse && slOrderResponse.orderId) {
      // Insert no banco
      await connection.query(
        `INSERT INTO ordens (
          tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, reduce_only, close_position, 
          last_update, orign_sig, observacao, conta_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'STOP_MARKET', slPrice, quantity, positionId, 'NEW', 
          formatDateForMySQL(new Date()), slOrderResponse.orderId, binanceSide, signal.symbol, 
          'SL', true, false, formatDateForMySQL(new Date()), 
          `WEBHOOK_${signal.id}`, 'Stop Loss do reverse', accountId
        ]
      );
    }
    
    return slOrderResponse;
  } catch (error) {
    console.error(`[REVERSE_IMPROVED] ❌ Erro ao criar Stop Loss:`, error.message);
    throw error;
  }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Criar ordem de Take Profit
 */
async function createTakeProfitOrder(signal, tpPrice, quantity, accountId, positionId, connection, targetNumber) {
  try {
    const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    
    const tpOrderResponse = await newLimitMakerOrder(
      signal.symbol,
      binanceSide,
      quantity,
      tpPrice,
      accountId,
      true // reduceOnly
    );
    
    if (tpOrderResponse && tpOrderResponse.orderId) {
      // Insert no banco
      await connection.query(
        `INSERT INTO ordens (
          tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
          last_update, orign_sig, observacao, conta_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'LIMIT', tpPrice, quantity, positionId, 'NEW', 
          formatDateForMySQL(new Date()), tpOrderResponse.orderId, binanceSide, signal.symbol, 
          'TP', targetNumber, true, false, formatDateForMySQL(new Date()), 
          `WEBHOOK_${signal.id}`, `Take Profit ${targetNumber} do reverse`, accountId
        ]
      );
    }
    
    return tpOrderResponse;
  } catch (error) {
    console.error(`[REVERSE_IMPROVED] ❌ Erro ao criar Take Profit ${targetNumber}:`, error.message);
    throw error;
  }
}

// Funções auxiliares
async function getAvailableBalance(accountId) {
  try {
    const balance = await getFuturesAccountBalanceDetails(accountId);
    return parseFloat(balance.availableBalance || balance.balance || 0);
  } catch (error) {
    console.error(`[REVERSE] Erro ao obter saldo:`, error.message);
    return 0;
  }
}

function calculateOrderSize(balance, capitalPct, price, leverage, stepSize, precision) {
  const capitalToUse = balance * capitalPct;
  const grossSize = (capitalToUse * leverage) / price;
  const adjustedSize = Math.floor(grossSize / stepSize) * stepSize;
  return parseFloat(adjustedSize.toFixed(precision));
}

function calculateAveragePrice(fills) {
  if (!fills || fills.length === 0) return 0;
  
  const totalQty = fills.reduce((sum, fill) => sum + fill.qty, 0);
  const totalValue = fills.reduce((sum, fill) => sum + (fill.qty * fill.price), 0);
  
  return totalQty > 0 ? totalValue / totalQty : 0;
}

module.exports = {
  executeReverse
};
