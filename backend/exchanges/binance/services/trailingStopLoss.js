const { getDatabaseInstance, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const { newStopOrder, cancelOrder, getOpenOrders } = require('../api/rest');
const { sendTelegramMessage, formatAlertMessage } = require('./telegramBot');

// Controle de verificações para evitar spam
const lastTrailingCheck = {};
const MIN_CHECK_INTERVAL = 10000; // 10 segundos
const TWO_MINUTES_RECHECK_NO_SL = 2 * 60 * 1000; // 2 minutos

/**
 * ✅ SISTEMA COMPLETO DE TRAILING STOP BASEADO NO _DEV
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

    // ✅ CONTROLE DE INTERVALO MÍNIMO
    const now = Date.now();
    if (lastTrailingCheck[positionId] && (now - lastTrailingCheck[positionId] < MIN_CHECK_INTERVAL)) {
      return;
    }
    lastTrailingCheck[positionId] = now;

    // ✅ OBTER NÍVEL ATUAL DE TRAILING DO BANCO
    const [trailingStateResult] = await db.query(
      `SELECT trailing_stop_level FROM posicoes WHERE id = ?`,
      [positionId]
    );
    
    // Se a coluna não existir, tentar criar
    if (trailingStateResult.length > 0 && !trailingStateResult[0].hasOwnProperty('trailing_stop_level')) {
      console.log(`${functionPrefix} Coluna trailing_stop_level não existe, tentando criar...`);
      try {
        await db.query(`
          ALTER TABLE posicoes 
          ADD COLUMN trailing_stop_level VARCHAR(20) DEFAULT 'ORIGINAL'
        `);
        console.log(`${functionPrefix} ✅ Coluna trailing_stop_level criada`);
      } catch (alterError) {
        console.warn(`${functionPrefix} ⚠️ Erro ao criar coluna trailing_stop_level:`, alterError.message);
      }
    }
    
    const currentTrailingLevel = trailingStateResult.length > 0 && trailingStateResult[0].trailing_stop_level ? 
                                trailingStateResult[0].trailing_stop_level : 'ORIGINAL';

    // ✅ BUSCAR DADOS DO SINAL RELACIONADO
    const [signalInfo] = await db.query(
      `SELECT tp1_price, tp3_price, entry_price, sl_price
       FROM webhook_signals 
       WHERE position_id = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [positionId]
    );

    if (signalInfo.length === 0) {
      console.log(`${functionPrefix} ⚠️ Nenhum sinal encontrado para posição ${positionId}`);
      return;
    }

    const signal = signalInfo[0];
    const tp1Price = parseFloat(signal.tp1_price || 0);
    const tp3Price = parseFloat(signal.tp3_price || 0);
    const entryPrice = parseFloat(signal.entry_price || position.preco_entrada || 0);
    const originalSlPrice = parseFloat(signal.sl_price || 0);
    const side = position.side.toUpperCase();

    // Verificar validade dos preços
    if (isNaN(tp1Price) || tp1Price <= 0) {
      console.log(`${functionPrefix} ⚠️ TP1 não configurado ou inválido para posição ${positionId}`);
      return;
    }

    console.log(`${functionPrefix} 📊 Posição ${position.simbolo} (${side}):`);
    console.log(`${functionPrefix}   - Preço atual: ${currentPrice}`);
    console.log(`${functionPrefix}   - Preço entrada: ${entryPrice}`);
    console.log(`${functionPrefix}   - TP1: ${tp1Price}`);
    console.log(`${functionPrefix}   - TP3: ${tp3Price || 'N/A'}`);
    console.log(`${functionPrefix}   - SL original: ${originalSlPrice || 'N/A'}`);
    console.log(`${functionPrefix}   - Nível trailing atual: ${currentTrailingLevel}`);

    // ✅ DETERMINAR SE ALVOS FORAM ATINGIDOS
    let priceHitTP1 = false;
    let priceHitTP3 = false;
    
    if (side === 'BUY' || side === 'COMPRA') {
      priceHitTP1 = currentPrice >= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice >= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    } else if (side === 'SELL' || side === 'VENDA') {
      priceHitTP1 = currentPrice <= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice <= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    }

    // ✅ REPOSICIONAMENTO PARA BREAKEVEN (APÓS TP1)
    if (priceHitTP1) {
      console.log(`${functionPrefix} 🎯 TP1 atingido para ${position.simbolo}. Movendo SL para breakeven.`);
      
      // Atualizar nível de trailing
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );
      
      // Cancelar todas as ordens de SL ativas
      const canceledCount = await cancelAllActiveStopLosses(db, position, accountId);
      console.log(`${functionPrefix} 🗑️ ${canceledCount} ordens SL canceladas`);
      
      // Aguardar cancelamentos
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      // Criar novo SL no breakeven
      const newSLBreakevenPrice = entryPrice;
      const quantity = parseFloat(position.quantidade);
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        console.log(`${functionPrefix} 📝 Criando SL breakeven: ${newSLBreakevenPrice}`);
        
        const slResponse = await newStopOrder(
          accountId, 
          position.simbolo, 
          quantity, 
          oppositeSide, 
          newSLBreakevenPrice, 
          null, 
          true // reduceOnly
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
            orign_sig: position.orign_sig,
            conta_id: accountId
          });
          
          console.log(`${functionPrefix} ✅ SL movido para breakeven: ${newSLBreakevenPrice}`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM
          try {
            const message = formatAlertMessage(
              'STOP LOSS MOVIDO',
              `🎯 <b>${position.simbolo}</b>\n\n` +
              `📈 TP1 atingido!\n` +
              `🛡️ Stop Loss movido para <b>BREAKEVEN</b>\n` +
              `💰 Novo SL: <b>$${newSLBreakevenPrice.toFixed(4)}</b>\n\n` +
              `🔒 Posição protegida contra perdas!`,
              'SUCCESS'
            );
            
            await sendTelegramMessage(accountId, message);
            console.log(`${functionPrefix} 📱 Notificação de SL breakeven enviada`);
          } catch (telegramError) {
            console.warn(`${functionPrefix} ⚠️ Erro ao enviar notificação:`, telegramError.message);
          }
          
        } else {
          throw new Error('Resposta inválida da API ao criar SL breakeven');
        }
      } catch (error) {
        console.error(`${functionPrefix} ❌ Erro ao criar SL breakeven:`, error.message);
      }
    }
    // ✅ REPOSICIONAMENTO PARA TP1 (APÓS TP3)
    else if (priceHitTP3) {
      console.log(`${functionPrefix} 🚀 TP3 atingido para ${position.simbolo}. Movendo SL para TP1.`);
      
      // Atualizar nível de trailing
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'TP1', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );
      
      // Cancelar todas as ordens de SL ativas
      const canceledCount = await cancelAllActiveStopLosses(db, position, accountId);
      console.log(`${functionPrefix} 🗑️ ${canceledCount} ordens SL canceladas`);
      
      // Aguardar cancelamentos
      await new Promise(resolve => setTimeout(resolve, 2500));
      
      // Criar novo SL no TP1
      const quantity = parseFloat(position.quantidade);
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        console.log(`${functionPrefix} 📝 Criando SL em TP1: ${tp1Price}`);
        
        const slResponse = await newStopOrder(
          accountId, 
          position.simbolo, 
          quantity, 
          oppositeSide, 
          tp1Price, 
          null, 
          true // reduceOnly
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
            orign_sig: position.orign_sig,
            conta_id: accountId
          });
          
          console.log(`${functionPrefix} ✅ SL movido para TP1: ${tp1Price}`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM
          try {
            const message = formatAlertMessage(
              'STOP LOSS AVANÇADO',
              `🚀 <b>${position.simbolo}</b>\n\n` +
              `🎯 TP3 atingido!\n` +
              `📈 Stop Loss movido para <b>TP1</b>\n` +
              `💰 Novo SL: <b>$${tp1Price.toFixed(4)}</b>\n\n` +
              `💎 Posição em lucro garantido!`,
              'SUCCESS'
            );
            
            await sendTelegramMessage(accountId, message);
            console.log(`${functionPrefix} 📱 Notificação de SL TP1 enviada`);
          } catch (telegramError) {
            console.warn(`${functionPrefix} ⚠️ Erro ao enviar notificação:`, telegramError.message);
          }
          
        } else {
          throw new Error('Resposta inválida da API ao criar SL em TP1');
        }
      } catch (error) {
        console.error(`${functionPrefix} ❌ Erro ao criar SL em TP1:`, error.message);
      }
    }
    
  } catch (error) {
    const positionIdError = position && position.id ? position.id : 'desconhecida';
    console.error(`[TRAILING] ❌ Erro em checkOrderTriggers para posição ${positionIdError}:`, error.message);
  }
}

/**
 * ✅ FUNÇÃO MELHORADA PARA CANCELAR STOP LOSSES
 */
async function cancelAllActiveStopLosses(db, position, accountId) {
  let canceledCount = 0;
  const functionPrefix = "[CANCEL_SL]";
  const { simbolo, id: positionId, side: positionSide } = position;

  console.log(`${functionPrefix} Cancelando ordens SL para ${simbolo} (Posição ID: ${positionId})`);

  try {
    // Buscar ordens abertas na corretora
    const openOrdersOnExchange = await getOpenOrders(accountId, simbolo);
    
    if (!openOrdersOnExchange || openOrdersOnExchange.length === 0) {
      console.log(`${functionPrefix} ℹ️ Nenhuma ordem aberta encontrada na corretora para ${simbolo}`);
      return 0;
    }

    // Filtrar ordens de Stop Loss relevantes
    const oppositeSide = positionSide.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const stopLossOrdersToCancel = openOrdersOnExchange.filter(order => {
      const orderTypeUpper = order.type ? order.type.toUpperCase() : '';
      const orderSideUpper = order.side ? order.side.toUpperCase() : '';
      
      return orderTypeUpper.includes('STOP') && 
             orderSideUpper === oppositeSide && 
             (order.reduceOnly === true || typeof order.reduceOnly === 'undefined');
    });

    if (stopLossOrdersToCancel.length === 0) {
      console.log(`${functionPrefix} ℹ️ Nenhuma ordem SL relevante encontrada para cancelar para ${simbolo}`);
      return 0;
    }

    console.log(`${functionPrefix} 🎯 Encontradas ${stopLossOrdersToCancel.length} ordens SL para cancelar`);

    // Cancelar cada ordem
    for (const order of stopLossOrdersToCancel) {
      try {
        await cancelOrder(accountId, simbolo, order.orderId);
        console.log(`${functionPrefix} ✅ SL ${order.orderId} cancelado`);
        
        // Atualizar status no banco
        await db.query(
          'UPDATE ordens SET status = "CANCELED", last_update = ? WHERE id_externo = ? AND conta_id = ?', 
          [formatDateForMySQL(new Date()), order.orderId, accountId]
        );
        
        canceledCount++;
      } catch (cancelError) {
        console.error(`${functionPrefix} ❌ Erro ao cancelar SL ${order.orderId}:`, cancelError.message);
      }
    }
    
    console.log(`${functionPrefix} 📊 Total cancelado: ${canceledCount} de ${stopLossOrdersToCancel.length} ordens SL`);
    return canceledCount;
    
  } catch (error) {
    console.error(`${functionPrefix} ❌ Erro geral ao cancelar SLs para ${simbolo}:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO PARA CANCELAR ORDENS DE STOP LOSS ESPECÍFICAS
 */
async function cancelStopLossOrders(db, positionId, accountId) {
  try {
    // ✅ BUSCAR ORDENS SL COM CONTA_ID CORRETO
    const [stopLossOrders] = await db.query(`
      SELECT id_externo, simbolo FROM ordens 
      WHERE id_posicao = ? AND conta_id = ? AND tipo_ordem_bot = 'STOP_LOSS' 
      AND status IN ('NEW', 'PARTIALLY_FILLED')
    `, [positionId, accountId]); // ✅ USAR accountId, NÃO orderId

    console.log(`[CANCEL_SL] 🔍 Encontradas ${stopLossOrders.length} ordens SL para cancelar`);

    let canceledCount = 0;
    for (const order of stopLossOrders) {
      try {
        // ✅ USAR accountId CORRETO, NÃO orderId
        await api.cancelOrder(order.simbolo, order.id_externo, accountId);
        
        // ✅ ATUALIZAR STATUS NO BANCO
        await db.query(`
          UPDATE ordens 
          SET status = 'CANCELED', last_update = NOW(),
              observacao = 'Cancelada para trailing stop'
          WHERE id_externo = ? AND conta_id = ?
        `, [order.id_externo, accountId]);
        
        canceledCount++;
        console.log(`[CANCEL_SL] ✅ SL ${order.id_externo} cancelado com sucesso`);
        
      } catch (cancelError) {
        console.error(`[CANCEL_SL] ❌ Erro ao cancelar SL ${order.id_externo}:`, cancelError.message);
      }
    }

    console.log(`[CANCEL_SL] 📊 Total cancelado: ${canceledCount} de ${stopLossOrders.length} ordens SL`);
    return canceledCount;

  } catch (error) {
    console.error(`[CANCEL_SL] ❌ Erro ao cancelar ordens SL:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO PARA CRIAR STOP LOSS NO BREAKEVEN
 */
async function createBreakevenStopLoss(db, position, breakevenPrice, accountId) {
  try {
    const symbol = position.simbolo;
    const quantity = Math.abs(parseFloat(position.quantidade));
    const side = position.side === 'BUY' ? 'SELL' : 'BUY';

    console.log(`[TRAILING] 🎯 Criando SL breakeven: ${breakevenPrice}`);

    // ✅ USAR newStopOrder COM PARÂMETROS CORRETOS
    const response = await api.newStopOrder(
      accountId,           // ✅ accountId correto
      symbol,             
      null,               // quantity será null para usar closePosition
      side,               
      breakevenPrice,     
      null,               // limitPrice
      false,              // postOnly
      true,               // closePosition = true
      'STOP_MARKET'       
    );

    // ✅ VALIDAÇÃO CORRIGIDA DA RESPOSTA
    const orderId = response?.orderId || response?.data?.orderId;
    
    if (orderId) {
      console.log(`[TRAILING] ✅ SL breakeven criado: ${orderId} @ ${breakevenPrice}`);
      
      // ✅ INSERIR NO BANCO VIA WEBHOOK (aguardar confirmação)
      console.log(`[TRAILING] 📡 Aguardando confirmação via webhook para inserir SL no banco...`);
      
      return {
        success: true,
        orderId: orderId,
        price: breakevenPrice
      };
    } else {
      console.error(`[TRAILING] ❌ Resposta da API sem orderId:`, response);
      return { success: false, error: 'OrderId não encontrado na resposta' };
    }

  } catch (error) {
    console.error(`[TRAILING] ❌ Erro ao criar SL breakeven:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * ✅ FUNÇÃO PARA MOVIMENTAR STOP LOSS PARA BREAKEVEN
 */
async function moveStopLossToBreakeven(db, position, accountId) {
  try {
    const positionId = position.id;
    const breakevenPrice = parseFloat(position.preco_entrada);

    console.log(`[TRAILING] 🎯 Movendo SL para breakeven para ${position.simbolo} (Posição ID: ${positionId})`);

    // ✅ 1. CANCELAR SLS EXISTENTES COM accountId CORRETO
    const canceledCount = await cancelStopLossOrders(db, positionId, accountId);
    
    if (canceledCount === 0) {
      console.warn(`[TRAILING] ⚠️ Nenhuma ordem SL foi cancelada`);
    }

    // ✅ 2. AGUARDAR UM POUCO PARA CANCELAMENTO PROCESSAR
    await new Promise(resolve => setTimeout(resolve, 1000));

    // ✅ 3. CRIAR NOVO SL BREAKEVEN
    const result = await createBreakevenStopLoss(db, position, breakevenPrice, accountId);

    if (result.success) {
      // ✅ 4. ATUALIZAR NÍVEL DE TRAILING NO BANCO
      await db.query(`
        UPDATE posicoes 
        SET trailing_stop_level = 'TP1_BREAKEVEN',
            data_hora_ultima_atualizacao = NOW()
        WHERE id = ?
      `, [positionId]);

      console.log(`[TRAILING] ✅ SL movido para breakeven com sucesso para posição ${positionId}`);
      return true;
    } else {
      console.error(`[TRAILING] ❌ Falha ao criar SL breakeven:`, result.error);
      return false;
    }

  } catch (error) {
    console.error(`[TRAILING] ❌ Erro ao mover SL para breakeven:`, error.message);
    return false;
  }
}

module.exports = {
  checkOrderTriggers,
  cancelAllActiveStopLosses
};