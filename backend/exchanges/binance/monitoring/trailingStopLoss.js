const { getDatabaseInstance, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const { newStopOrder, cancelOrder, getOpenOrders } = require('../api/rest');
const { sendTelegramMessage, formatAlertMessage } = require('../telegram/telegramBot');

// Controle de verificações para evitar spam
const lastTrailingCheck = {};
const MIN_CHECK_INTERVAL = 10000; // 10 segundos
const TWO_MINUTES_RECHECK_NO_SL = 2 * 60 * 1000; // 2 minutos

/**
 * ✅ FUNÇÃO PRINCIPAL: Substitui o enhancedMonitoring
 * Atualiza posições com trailing stop loss
 * @param {Object} db - Instância do banco
 * @param {string} symbol - Símbolo da moeda
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    // Buscar posições abertas para o símbolo
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN'
    `, [symbol, accountId]);

    if (positions.length === 0) {
      return;
    }

    // Processar trailing stop para cada posição
    for (const position of positions) {
      try {
        await checkOrderTriggers(db, position, currentPrice, accountId);
      } catch (positionError) {
        console.error(`[TRAILING] Erro ao processar posição ${position.simbolo}:`, positionError.message);
      }
    }

  } catch (error) {
    console.error('[TRAILING] Erro no enhanced monitoring:', error.message);
  }
}

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

    // Buscar o sinal vinculado via position_id
    let signalInfo = [];
    const [signalRows] = await db.query(`
      SELECT tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, entry_price, sl_price, symbol, side
      FROM webhook_signals
      WHERE position_id = ? AND conta_id = ?
      ORDER BY created_at DESC LIMIT 1
    `, [positionId, accountId]);
    signalInfo = signalRows;

    if (signalInfo.length === 0) {
      console.log(`${functionPrefix} ⚠️ Nenhum sinal encontrado para posição ${positionId} (${position.simbolo})`);
      return;
    }

    const signal = signalInfo[0];
    const tp1Price = parseFloat(signal.tp1_price || 0);
    const tp3Price = parseFloat(signal.tp3_price || 0);
    const entryPrice = parseFloat(signal.entry_price || position.preco_entrada || 0);
    const originalSlPrice = parseFloat(signal.sl_price || 0);
    const side = position.side ? position.side.toUpperCase() : (signal.side ? signal.side.toUpperCase() : '');

    // Verificar validade dos preços
    if (isNaN(tp1Price) || tp1Price <= 0) {
      console.log(`${functionPrefix} ⚠️ TP1 não configurado ou inválido para posição ${positionId}`);
      return;
    }

    // ✅ LOG MAIS DETALHADO
    console.log(`${functionPrefix} 📊 Posição ${position.simbolo} (${side}) - ID: ${positionId}:`);
    console.log(`${functionPrefix}   - Preço atual: ${currentPrice}`);
    console.log(`${functionPrefix}   - Preço entrada: ${entryPrice}`);
    console.log(`${functionPrefix}   - TP1: ${tp1Price}`);
    console.log(`${functionPrefix}   - TP3: ${tp3Price || 'N/A'}`);
    console.log(`${functionPrefix}   - SL original: ${originalSlPrice || 'N/A'}`);
    console.log(`${functionPrefix}   - Nível trailing atual: ${currentTrailingLevel}`);
    console.log(`${functionPrefix}   - Origin signal: ${position.orign_sig || 'N/A'}`);

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

    console.log(`${functionPrefix} 🎯 Verificação de gatilhos:`);
    console.log(`${functionPrefix}   - TP1 atingido: ${priceHitTP1}`);
    console.log(`${functionPrefix}   - TP3 atingido: ${priceHitTP3}`);

    // ✅ REPOSICIONAMENTO PARA BREAKEVEN (APÓS TP1)
    if (priceHitTP1) {
      console.log(`${functionPrefix} 🎯 TP1 atingido para ${position.simbolo}. Movendo SL para breakeven.`);
      
      // ✅ 1. ATUALIZAR NÍVEL DE TRAILING
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = NOW() WHERE id = ?`,
        [positionId]
      );
      
      // ✅ 2. CANCELAR TODAS AS ORDENS DE SL ATIVAS
      const canceledCount = await cancelStopLossOrders(db, positionId, accountId);
      console.log(`${functionPrefix} 🗑️ ${canceledCount} ordens SL canceladas`);
      
      // ✅ 3. AGUARDAR CANCELAMENTOS
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // ✅ 4. CRIAR NOVO SL NO BREAKEVEN COM closePosition=true
      const newSLBreakevenPrice = entryPrice;
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        console.log(`${functionPrefix} 📝 Criando SL breakeven: ${newSLBreakevenPrice} (closePosition=true)`);
        
        const slResponse = await newStopOrder(
          accountId,                 // accountId
          position.simbolo,          // symbol
          null,                      // ✅ quantity = null
          oppositeSide,              // side
          newSLBreakevenPrice,       // stopPrice
          null,                      // price
          false,                     // ✅ reduceOnly = false
          true,                      // ✅ closePosition = true
          'STOP_MARKET'              // orderType
        );
        
        if (slResponse && slResponse.orderId) {
          console.log(`${functionPrefix} ✅ SL breakeven criado: ${slResponse.orderId} (closePosition=true)`);
          
          // ✅ NÃO INSERIR NO BANCO - será feito via webhook
          console.log(`${functionPrefix} 📡 Ordem será registrada via webhook automaticamente`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM
          try {
            const message = formatAlertMessage(
              'STOP LOSS MOVIDO',
              `🎯 <b>${position.simbolo}</b>\n\n` +
              `📈 TP1 atingido!\n` +
              `🛡️ Stop Loss movido para <b>BREAKEVEN</b>\n` +
              `💰 Novo SL: <b>$${newSLBreakevenPrice.toFixed(4)}</b>\n\n` +
              `🔒 Posição protegida contra perdas!\n` +
              `⚡ Modo: Close Position`,
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
      
      // ✅ 1. ATUALIZAR NÍVEL DE TRAILING
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'TP1', data_hora_ultima_atualizacao = NOW() WHERE id = ?`,
        [positionId]
      );
      
      // Cancelar SLs existentes
      const canceledCount = await cancelStopLossOrders(db, positionId, accountId);
      console.log(`${functionPrefix} 🗑️ ${canceledCount} ordens SL canceladas`);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // ✅ CRIAR SL EM TP1 COM closePosition=true
      const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
      
      try {
        console.log(`${functionPrefix} 📝 Criando SL em TP1: ${tp1Price} (closePosition=true)`);
        
        const slResponse = await newStopOrder(
          accountId,
          position.simbolo,
          null,                // ✅ quantity = null
          oppositeSide,
          tp1Price,
          null,
          false,               // ✅ reduceOnly = false
          true,                // ✅ closePosition = true
          'STOP_MARKET'
        );
        
        if (slResponse && slResponse.orderId) {
          console.log(`${functionPrefix} ✅ SL TP1 criado: ${slResponse.orderId} (closePosition=true)`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM
          try {
            const message = formatAlertMessage(
              'STOP LOSS MOVIDO PARA TP1',
              `🚀 <b>${position.simbolo}</b>\n\n` +
              `📈 TP3 atingido!\n` +
              `🛡️ Stop Loss movido para <b>TP1</b>\n` +
              `💰 Novo SL: <b>$${tp1Price.toFixed(4)}</b>\n\n` +
              `🎯 Lucro garantido!\n` +
              `⚡ Modo: Close Position`,
              'SUCCESS'
            );
            
            await sendTelegramMessage(accountId, message);
            console.log(`${functionPrefix} 📱 Notificação de SL TP1 enviada`);
          } catch (telegramError) {
            console.warn(`${functionPrefix} ⚠️ Erro ao enviar notificação:`, telegramError.message);
          }
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
 * ✅ FUNÇÃO CORRIGIDA PARA CANCELAR ORDENS DE STOP LOSS ESPECÍFICAS
 */
async function cancelStopLossOrders(db, positionId, accountId) {
  try {
    console.log(`[CANCEL_SL] 🔍 Cancelando SLs para posição ${positionId} (conta ${accountId})`);

    // ✅ 1. BUSCAR ORDENS SL NO BANCO
    const [stopLossOrders] = await db.query(`
      SELECT id_externo, simbolo FROM ordens 
      WHERE id_posicao = ? AND conta_id = ? AND tipo_ordem_bot = 'STOP_LOSS' 
      AND status IN ('NEW', 'PARTIALLY_FILLED')
    `, [positionId, accountId]);

    console.log(`[CANCEL_SL] 📋 Encontradas ${stopLossOrders.length} ordens SL no banco`);

    if (stopLossOrders.length === 0) {
      return 0;
    }

    let canceledCount = 0;
    for (const order of stopLossOrders) {
      try {
        // ✅ 2. CANCELAR NA CORRETORA USANDO IMPORT CORRETO
        await cancelOrder(order.simbolo, order.id_externo, accountId);
        
        // ✅ 3. ATUALIZAR STATUS NO BANCO
        await db.query(`
          UPDATE ordens 
          SET status = 'CANCELED', last_update = NOW(),
              observacao = CONCAT(
                IFNULL(observacao, ''), 
                ' | Cancelada para trailing stop'
              )
          WHERE id_externo = ? AND conta_id = ?
        `, [order.id_externo, accountId]);
        
        canceledCount++;
        console.log(`[CANCEL_SL] ✅ SL ${order.id_externo} cancelado com sucesso`);
        
      } catch (cancelError) {
        // ✅ 4. TRATAR ERRO DE "ORDEM NÃO EXISTE"
        if (cancelError.message && 
            (cancelError.message.includes('Unknown order') || 
             cancelError.message.includes('does not exist'))) {
          console.log(`[CANCEL_SL] ℹ️ SL ${order.id_externo} já foi executado/cancelado`);
          
          // Marcar como cancelado no banco mesmo assim
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', last_update = NOW(),
                observacao = CONCAT(
                  IFNULL(observacao, ''), 
                  ' | Não existe na corretora'
                )
            WHERE id_externo = ? AND conta_id = ?
          `, [order.id_externo, accountId]);
          
          canceledCount++;
        } else {
          console.error(`[CANCEL_SL] ❌ Erro ao cancelar SL ${order.id_externo}:`, cancelError.message);
        }
      }
    }

    console.log(`[CANCEL_SL] 📊 Total processado: ${canceledCount} de ${stopLossOrders.length} ordens SL`);
    return canceledCount;

  } catch (error) {
    console.error(`[CANCEL_SL] ❌ Erro geral ao cancelar ordens SL:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO CORRIGIDA PARA CRIAR STOP LOSS NO BREAKEVEN
 */
async function createBreakevenStopLoss(db, position, breakevenPrice, accountId) {
  try {
    const symbol = position.simbolo;
    const side = position.side === 'BUY' ? 'SELL' : 'BUY';

    console.log(`[TRAILING] 🎯 Criando SL breakeven: ${breakevenPrice} para ${symbol}`);

    // ✅ USAR closePosition=true (RECOMENDADO)
    const response = await newStopOrder(
      accountId,           // accountId
      symbol,              // symbol
      null,                // ✅ quantity = null quando closePosition=true
      side,                // side
      breakevenPrice,      // stopPrice
      null,                // price (não usado para STOP_MARKET)
      false,               // ✅ reduceOnly = false (não usado com closePosition)
      true,                // ✅ closePosition = true (FECHA TODA A POSIÇÃO)
      'STOP_MARKET'        // orderType
    );

    // ✅ VALIDAÇÃO CORRIGIDA DA RESPOSTA
    const orderId = response?.orderId;
    
    if (orderId) {
      console.log(`[TRAILING] ✅ SL breakeven criado: ${orderId} @ ${breakevenPrice} (closePosition=true)`);
      
      // ✅ A ORDEM SERÁ INSERIDA NO BANCO VIA WEBHOOK automaticamente
      console.log(`[TRAILING] 📡 Aguardando confirmação via webhook...`);
      
      return {
        success: true,
        orderId: orderId,
        price: breakevenPrice,
        closePosition: true
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
  cancelAllActiveStopLosses,
  lastTrailingCheck,
  updatePositionPricesWithTrailing
};