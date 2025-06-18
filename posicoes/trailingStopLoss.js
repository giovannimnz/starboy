const { getDatabaseInstance, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const { newStopOrder, cancelOrder, getOpenOrders } = require('../api');

// Controle de verificações para evitar spam
const lastTrailingCheck = {};
const MIN_CHECK_INTERVAL = 10000; // 10 segundos

/**
 * Verifica e atualiza trailing stops para posições abertas
 * @param {Object} db - Instância do banco
 * @param {Object} position - Dados da posição
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function checkOrderTriggers(db, position, currentPrice, accountId) {
  try {
    const positionId = position.id;
    const functionPrefix = "[TRAILING]";

    // Controle de intervalo mínimo
    const now = Date.now();
    if (lastTrailingCheck[positionId] && (now - lastTrailingCheck[positionId] < MIN_CHECK_INTERVAL)) {
      return;
    }
    lastTrailingCheck[positionId] = now;

    // Obter nível atual de trailing
    const [trailingStateResult] = await db.query(
      `SELECT trailing_stop_level FROM posicoes WHERE id = ?`,
      [positionId]
    );
    
    const currentTrailingLevel = trailingStateResult.length > 0 && trailingStateResult[0].trailing_stop_level ? 
                                trailingStateResult[0].trailing_stop_level : 'ORIGINAL';

    // Buscar dados do sinal
    const [signalInfo] = await db.query(
      `SELECT tp1_price, tp3_price, entry_price 
       FROM webhook_signals 
       WHERE position_id = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [positionId]
    );

    if (signalInfo.length === 0) {
      return;
    }

    const signal = signalInfo[0];
    const tp1Price = parseFloat(signal.tp1_price);
    const tp3Price = parseFloat(signal.tp3_price);
    const entryPrice = parseFloat(position.preco_entrada);
    const side = position.side.toUpperCase();

    if (isNaN(tp1Price) || tp1Price <= 0) {
      return;
    }

    // Determinar se alvos foram atingidos
    let priceHitTP1 = false;
    let priceHitTP3 = false;
    
    if (side === 'BUY' || side === 'COMPRA') {
      priceHitTP1 = currentPrice >= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice >= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    } else if (side === 'SELL' || side === 'VENDA') {
      priceHitTP1 = currentPrice <= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice <= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    }

    // Mover SL para breakeven após TP1
    if (priceHitTP1) {
      console.log(`${functionPrefix} TP1 atingido para ${position.simbolo}. Movendo SL para breakeven.`);
      
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );
      
      await cancelAllActiveStopLosses(db, position, accountId);
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const newSLBreakevenPrice = parseFloat(signal.entry_price) || entryPrice;
      const quantity = parseFloat(position.quantidade);
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        const slResponse = await newStopOrder(
          accountId, position.simbolo, quantity, oppositeSide, newSLBreakevenPrice, null, true
        );
        
        if (slResponse && slResponse.data && slResponse.data.orderId) {
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET',
            preco: newSLBreakevenPrice,
            quantidade: quantity,
            id_posicao: positionId,
            status: 'NEW',
            data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: String(slResponse.data.orderId),
            side: oppositeSide,
            simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS',
            reduce_only: true,
            close_position: true,
            last_update: formatDateForMySQL(new Date()),
            orign_sig: position.orign_sig
          });
          
          console.log(`${functionPrefix} SL movido para breakeven: ${newSLBreakevenPrice}`);
        }
      } catch (error) {
        console.error(`${functionPrefix} Erro ao criar SL breakeven:`, error.message);
      }
    }
    // Mover SL para TP1 após TP3
    else if (priceHitTP3) {
      console.log(`${functionPrefix} TP3 atingido para ${position.simbolo}. Movendo SL para TP1.`);
      
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'TP1', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );
      
      await cancelAllActiveStopLosses(db, position, accountId);
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      const quantity = parseFloat(position.quantidade);
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        const slResponse = await newStopOrder(
          accountId, position.simbolo, quantity, oppositeSide, tp1Price, null, true
        );
        
        if (slResponse && slResponse.data && slResponse.data.orderId) {
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET',
            preco: tp1Price,
            quantidade: quantity,
            id_posicao: positionId,
            status: 'NEW',
            data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: String(slResponse.data.orderId),
            side: oppositeSide,
            simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS',
            reduce_only: true,
            close_position: true,
            last_update: formatDateForMySQL(new Date()),
            orign_sig: position.orign_sig
          });
          
          console.log(`${functionPrefix} SL movido para TP1: ${tp1Price}`);
        }
      } catch (error) {
        console.error(`${functionPrefix} Erro ao criar SL em TP1:`, error.message);
      }
    }
    
  } catch (error) {
    console.error(`[TRAILING] Erro em checkOrderTriggers:`, error.message);
  }
}

/**
 * Cancela todas as ordens de Stop Loss ativas
 */
async function cancelAllActiveStopLosses(db, position, accountId) {
  try {
    const openOrdersOnExchange = await getOpenOrders(accountId, position.simbolo);
    
    if (!openOrdersOnExchange || openOrdersOnExchange.length === 0) {
      return 0;
    }

    const oppositeSide = position.side.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const stopLossOrdersToCancel = openOrdersOnExchange.filter(order => {
      const orderTypeUpper = order.type ? order.type.toUpperCase() : '';
      const orderSideUpper = order.side ? order.side.toUpperCase() : '';
      
      return orderTypeUpper.includes('STOP') && 
             orderSideUpper === oppositeSide && 
             (order.reduceOnly === true || typeof order.reduceOnly === 'undefined');
    });

    let canceledCount = 0;
    for (const order of stopLossOrdersToCancel) {
      try {
        await cancelOrder(accountId, position.simbolo, order.orderId);
        console.log(`[TRAILING] SL ${order.orderId} cancelado com sucesso`);
        
        await db.query(
          'UPDATE ordens SET status = "CANCELED", last_update = ? WHERE id_externo = ?', 
          [formatDateForMySQL(new Date()), order.orderId]
        );
        canceledCount++;
      } catch (cancelError) {
        console.error(`[TRAILING] Erro ao cancelar SL ${order.orderId}:`, cancelError.message);
      }
    }
    
    return canceledCount;
  } catch (error) {
    console.error(`[TRAILING] Erro ao cancelar SLs:`, error.message);
    return 0;
  }
}

module.exports = {
  checkOrderTriggers,
  cancelAllActiveStopLosses
};