const { getDatabaseInstance, insertNewOrder, formatDateForPostgreSQL } = require('../../../core/database/conexao');
const { newStopOrder, cancelOrder, getOpenOrders } = require('../api/rest');
const { sendTelegramMessage, formatAlertMessage } = require('../services/telegramHelper');

// Controle de verificações para evitar spam
const lastTrailingCheck = {};
const MIN_CHECK_INTERVAL = 10000; // 10 segundos
const TWO_MINUTES_RECHECK_NO_SL = 2 * 60 * 1000; // 2 minutos

/**
 * FUNÇÃO PRINCIPAL: Substitui o enhancedMonitoring
 * Atualiza posições com trailing stop loss
 * @param {Object} db - Instância do banco
 * @param {string} symbol - Símbolo da moeda
 * @param {number} currentPrice - Preço atual
 * @param {number} accountId - ID da conta
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    // Buscar posições abertas para o símbolo
    const result = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = $1 AND conta_id = $2 AND status = 'OPEN'
    `, [symbol, accountId]);
    const positions = result.rows;

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
 * SISTEMA COMPLETO DE TRAILING STOP BASEADO NO _DEV
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

    // CONTROLE DE INTERVALO MÍNIMO
    const now = Date.now();
    if (lastTrailingCheck[positionId] && (now - lastTrailingCheck[positionId] < MIN_CHECK_INTERVAL)) {
      return;
    }
    lastTrailingCheck[positionId] = now;

    // OBTER NÍVEL ATUAL DE TRAILING DO BANCO
    const [trailingStateResult] = await db.query(
      `SELECT trailing_stop_level FROM posicoes WHERE id = $1`,
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
        console.log(`${functionPrefix} [OK] Coluna trailing_stop_level criada`);
      } catch (alterError) {
        console.warn(`${functionPrefix} [WARN] Erro ao criar coluna trailing_stop_level:`, alterError.message);
      }
    }
    
    const currentTrailingLevel = (trailingStateResult.length > 0 && trailingStateResult[0].trailing_stop_level)
      ? trailingStateResult[0].trailing_stop_level.toUpperCase()
      : 'ORIGINAL';

    // Buscar dados do sinal relacionado usando position_id
    let signalInfo = [];
    const [result] = await db.query(
      `SELECT tp1_price, tp3_price, entry_price, sl_price, symbol, side
       FROM webhook_signals
       WHERE position_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [position.id]
    );
    signalInfo = result;
    if (signalInfo.length === 0) {
      // Fallback: buscar por símbolo
      const [fallbackResult] = await db.query(
        `SELECT tp1_price, tp3_price, entry_price, sl_price, symbol, side
         FROM webhook_signals
         WHERE symbol = $1 AND conta_id = $2 AND status IN ('EXECUTADO', 'PROCESSANDO')
         ORDER BY created_at DESC LIMIT 1`,
        [position.simbolo, accountId]
      );
      signalInfo = fallbackResult;
    }
    if (signalInfo.length === 0) {
      console.warn('[TRAILING] Nenhum sinal encontrado para a posição. Não é possível aplicar trailing.');
      return;
    }
    const signal = signalInfo[0];
    const tp1Price = parseFloat(signal.tp1_price || 0);
    const tp3Price = parseFloat(signal.tp3_price || 0);
    const entryPrice = parseFloat(signal.entry_price || position.preco_entrada || 0);
    const originalSlPrice = parseFloat(signal.sl_price || 0);
    
    // Determinar side corretamente - se a posição tem side 'BOTH', usar o side do sinal
    let side = (position.side || '').toUpperCase();
    if (side === 'BOTH' || !side || !['BUY', 'SELL', 'LONG', 'SHORT'].includes(side)) {
      side = (signal.side || '').toUpperCase();
      //console.log(`[TRAILING] [WARN] Side da posição era '${position.side}', usando side do sinal: '${side}'`);
    }
    
    // Se ainda não temos um side válido, determinar pela quantidade da posição
    if (!side || side === 'BOTH' || !['BUY', 'SELL', 'LONG', 'SHORT'].includes(side)) {
      const positionQty = parseFloat(position.quantidade || 0);
      side = positionQty > 0 ? "BUY" : "SELL";
      //console.log(`[TRAILING] [WARN] Determinando side pela quantidade da posição: ${positionQty} -> ${side}`);
    }

    // Verificar validade dos preços
    if (isNaN(tp1Price) || tp1Price <= 0) {
      console.warn('[TRAILING] TP1 inválido, não é possível aplicar trailing.');
      return;
    }

    // LOG DETALHADO
    //console.log(`[TRAILING] [INFO] Posição ${position.simbolo} (${side}) - ID: ${position.id}:`);
    //console.log(`[TRAILING]   - Preço atual: ${currentPrice}`);
    //console.log(`[TRAILING]   - Preço entrada: ${entryPrice}`);
    //console.log(`[TRAILING]   - TP1: ${tp1Price}`);
    //console.log(`[TRAILING]   - TP3: ${tp3Price || 'N/A'}`);
    //console.log(`[TRAILING]   - SL original: ${originalSlPrice || 'N/A'}`);
    //console.log(`[TRAILING]   - Nível trailing atual: ${position.trailing_stop_level || 'ORIGINAL'}`);
    //console.log(`[TRAILING]   - Origin signal: ${position.orign_sig || 'N/A'}`);
    //console.log(`[TRAILING]   - Side final determinado: ${side}`);
    //console.log(`[TRAILING]   - Quantidade posição: ${position.quantidade}`);

    // DETERMINAR SE ALVOS FORAM ATINGIDOS
    let priceHitTP1 = false;
    let priceHitTP3 = false;
    
    // Garantir que todos os valores são números para comparação correta
    const currentPriceNum = parseFloat(currentPrice);
    const tp1PriceNum = parseFloat(tp1Price);
    const tp3PriceNum = parseFloat(tp3Price || 0);
    
    //console.log(`[TRAILING] 🔢 Debug comparação:`);
    //console.log(`[TRAILING]   - currentPrice: ${currentPrice} (${typeof currentPrice}) -> ${currentPriceNum}`);
    //console.log(`[TRAILING]   - tp1Price: ${tp1Price} (${typeof tp1Price}) -> ${tp1PriceNum}`);
    //console.log(`[TRAILING]   - side: ${side}`);
    
    if (side === 'BUY' || side === 'COMPRA' || side === 'LONG') {
      priceHitTP1 = currentPriceNum >= tp1PriceNum;
      priceHitTP3 = tp3PriceNum > 0 ? currentPriceNum >= tp3PriceNum : false;
      //console.log(`[TRAILING] [CHECK] LONG: ${currentPriceNum} >= ${tp1PriceNum} = ${priceHitTP1}`);
    } else if (side === 'SELL' || side === 'VENDA' || side === 'SHORT') {
      priceHitTP1 = currentPriceNum <= tp1PriceNum;
      priceHitTP3 = tp3PriceNum > 0 ? currentPriceNum <= tp3PriceNum : false;
      //console.log(`[TRAILING] [CHECK] SHORT: ${currentPriceNum} <= ${tp1PriceNum} = ${priceHitTP1}`);
    }

    //console.log(`[TRAILING] [CHECK] Verificação de gatilhos:`);
    //console.log(`[TRAILING]   - TP1 atingido: ${priceHitTP1}`);
    //console.log(`[TRAILING]   - TP3 atingido: ${priceHitTP3}`);

    // REPOSICIONAMENTO PARA BREAKEVEN (APÓS TP1)
    if (priceHitTP1 && !['TP1_BREAKEVEN', 'BREAKEVEN'].includes(currentTrailingLevel)) {
      //console.log(`[TRAILING] [TP1] TP1 atingido! Condições para reposicionamento:`);
      //console.log(`[TRAILING]   - priceHitTP1: ${priceHitTP1}`);
      //console.log(`[TRAILING]   - currentTrailingLevel: '${currentTrailingLevel}'`);
      //console.log(`[TRAILING]   - Não está em ['TP1_BREAKEVEN', 'BREAKEVEN']: ${!['TP1_BREAKEVEN', 'BREAKEVEN'].includes(currentTrailingLevel)}`);
      //console.log(`[TRAILING] [ACTION] Movendo SL para breakeven...`);
      
      const result = await moveStopLossToBreakeven(db, position, accountId);
      if (result) {
        console.log(`[TRAILING] [OK] SL movido para breakeven com sucesso`);
      } else {
        console.log(`[TRAILING] [ERROR] Falha ao mover SL para breakeven`);
      }
      return;
    } else if (priceHitTP1) {
      //console.log(`[TRAILING] ⏭️ TP1 atingido, mas trailing level já é: '${currentTrailingLevel}'`);
    }
    // REPOSICIONAMENTO PARA TP1 (APÓS TP3)
    if (
      tp3Price > 0 &&
      priceHitTP3 &&
      !['TP3_TP1'].includes(currentTrailingLevel) // só move se ainda não está nesse nível
    ) {
      const result = await moveStopLossToTP1(db, position, tp1Price, accountId);
      if (result) {
        console.log(`[TRAILING] [OK] SL movido para TP1 com sucesso após TP3`);
      } else {
        console.log(`[TRAILING] [ERROR] Falha ao mover SL para TP1 após TP3`);
      }
      return;
    } else if (tp3Price > 0 && priceHitTP3) {
      // TP3 atingido, mas já está no nível TP3_TP1
      //console.log(`[TRAILING] ⏭️ TP3 atingido, mas trailing level já é: '${currentTrailingLevel}'`);
    }
  } catch (error) {
    const positionIdError = position && position.id ? position.id : 'desconhecida';
    console.error(`[TRAILING] [ERROR] Erro em checkOrderTriggers para posição ${positionIdError}:`, error.message);
  }
}

/**
 * FUNÇÃO MELHORADA PARA CANCELAR STOP LOSSES
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
      console.log(`${functionPrefix} [INFO] Nenhuma ordem aberta encontrada na corretora para ${simbolo}`);
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
      console.log(`${functionPrefix} [INFO] Nenhuma ordem SL relevante encontrada para cancelar para ${simbolo}`);
      return 0;
    }

    console.log(`${functionPrefix} [TARGET] Encontradas ${stopLossOrdersToCancel.length} ordens SL para cancelar`);

    // Cancelar cada ordem
    for (const order of stopLossOrdersToCancel) {
      try {
        await cancelOrder(accountId, simbolo, order.orderId);
        console.log(`${functionPrefix} [OK] SL ${order.orderId} cancelado`);
        
        // Atualizar status no banco
        await db.query(
          'UPDATE ordens SET status = $1, last_update = $2 WHERE id_externo = $3 AND conta_id = $4', 
          ['CANCELED', formatDateForPostgreSQL(new Date()), order.orderId, accountId]
        );
        
        canceledCount++;
      } catch (cancelError) {
        console.error(`${functionPrefix} [ERROR] Erro ao cancelar SL ${order.orderId}:`, cancelError.message);
      }
    }
    
    console.log(`${functionPrefix} [INFO] Total cancelado: ${canceledCount} de ${stopLossOrdersToCancel.length} ordens SL`);
    return canceledCount;
    
  } catch (error) {
    console.error(`${functionPrefix} [ERROR] Erro geral ao cancelar SLs para ${simbolo}:`, error.message);
    return 0;
  }
}

/**
 * FUNÇÃO CORRIGIDA PARA CANCELAR ORDENS DE STOP LOSS ESPECÍFICAS
 */
async function cancelStopLossOrders(db, positionId, accountId) {
  try {
    console.log(`[CANCEL_SL] [SEARCH] Cancelando SLs para posição ${positionId} (conta ${accountId})`);

    // 1. BUSCAR ORDENS SL NO BANCO
    const result = await db.query(`
      SELECT id_externo, simbolo FROM ordens 
      WHERE id_posicao = $1 AND conta_id = $2 AND tipo_ordem_bot = 'STOP_LOSS' 
      AND status IN ('NEW', 'PARTIALLY_FILLED')
    `, [positionId, accountId]);
    const stopLossOrders = result.rows;

    console.log(`[CANCEL_SL] [LIST] Encontradas ${stopLossOrders.length} ordens SL no banco`);

    if (stopLossOrders.length === 0) {
      return 0;
    }

    let canceledCount = 0;
    for (const order of stopLossOrders) {
      try {
        // 2. CANCELAR NA CORRETORA USANDO IMPORT CORRETO
        await cancelOrder(order.simbolo, order.id_externo, accountId);
        
        // 3. ATUALIZAR STATUS NO BANCO
        await db.query(`
          UPDATE ordens 
          SET status = 'CANCELED', last_update = CURRENT_TIMESTAMP,
              observacao = COALESCE(observacao, '') || ' | Cancelada para trailing stop'
          WHERE id_externo = $1 AND conta_id = $2
        `, [order.id_externo, accountId]);
        
        canceledCount++;
        console.log(`[CANCEL_SL] [OK] SL ${order.id_externo} cancelado com sucesso`);
        
      } catch (cancelError) {
        // 4. TRATAR ERRO DE "ORDEM NÃO EXISTE"
        if (cancelError.message && 
            (cancelError.message.includes('Unknown order') || 
             cancelError.message.includes('does not exist'))) {
          console.log(`[CANCEL_SL] [INFO] SL ${order.id_externo} já foi executado/cancelado`);
          
          // Marcar como cancelado no banco mesmo assim
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', last_update = CURRENT_TIMESTAMP,
                observacao = COALESCE(observacao, '') || ' | Não existe na corretora'
            WHERE id_externo = $1 AND conta_id = $2
          `, [order.id_externo, accountId]);
          
          canceledCount++;
        } else {
          console.error(`[CANCEL_SL] [ERROR] Erro ao cancelar SL ${order.id_externo}:`, cancelError.message);
        }
      }
    }

    console.log(`[CANCEL_SL] [INFO] Total processado: ${canceledCount} de ${stopLossOrders.length} ordens SL`);
    return canceledCount;

  } catch (error) {
    console.error(`[CANCEL_SL] [ERROR] Erro geral ao cancelar ordens SL:`, error.message);
    return 0;
  }
}

/**
 * FUNÇÃO CORRIGIDA PARA CRIAR STOP LOSS NO BREAKEVEN
 */
async function createBreakevenStopLoss(db, position, breakevenPrice, accountId) {
  try {
    const symbol = position.simbolo;
    // Corrigir side para o oposto, aceitando todos os aliases
    const side = getOppositeSide(position.side);

    console.log(`[TRAILING] [TARGET] Criando SL breakeven: ${breakevenPrice} para ${symbol} (side SL: ${side}, side posição: ${position.side})`);

    // USAR closePosition=true (RECOMENDADO)
    const response = await newStopOrder(
      accountId,           // accountId
      symbol,              // symbol
      null,                // quantity = null quando closePosition=true
      side,                // side
      breakevenPrice,      // stopPrice
      null,                // price (não usado para STOP_MARKET)
      false,               // reduceOnly = false (não usado com closePosition)
      true,                // closePosition = true (FECHA TODA A POSIÇÃO)
      'STOP_MARKET'        // orderType
    );

    // VALIDAÇÃO CORRIGIDA DA RESPOSTA
    const orderId = response.orderId;
    
    if (orderId) {
      console.log(`[TRAILING] [OK] SL breakeven criado: ${orderId} @ ${breakevenPrice} (closePosition=true)`);
      
      // A ORDEM SERÁ INSERIDA NO BANCO VIA WEBHOOK automaticamente
      console.log(`[TRAILING] [WEBHOOK] Aguardando confirmação via webhook...`);
      
      return {
        success: true,
        orderId: orderId,
        price: breakevenPrice,
        closePosition: true
      };
    } else {
      console.error(`[TRAILING] [ERROR] Resposta da API sem orderId:`, response);
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

    // Buscar entry_price do último webhook_signals relacionado à posição
    const signalsResult = await db.query(
      `SELECT entry_price FROM webhook_signals WHERE position_id = $1 ORDER BY timestamp DESC LIMIT 1`, 
      [positionId]
    );
    
    const breakevenPrice = signalsResult.rows.length > 0 ? parseFloat(signalsResult.rows[0].entry_price) : parseFloat(position.preco_entrada);

    console.log(`[TRAILING] Movendo SL para breakeven para ${position.simbolo} (Posição ID: ${positionId}) usando entry_price do sinal: ${breakevenPrice}`);

    // 1. CANCELAR SLS EXISTENTES COM accountId CORRETO
    const canceledCount = await cancelStopLossOrders(db, positionId, accountId);
    if (canceledCount === 0) {
      console.warn(`[TRAILING] Nenhuma ordem SL foi cancelada`);
    }
    // 2. AGUARDAR UM POUCO PARA CANCELAMENTO PROCESSAR
    await new Promise(resolve => setTimeout(resolve, 1000));
    // 3. CRIAR NOVO SL BREAKEVEN
    const result = await createBreakevenStopLoss(db, position, breakevenPrice, accountId);
    if (result.success) {
      // 4. ATUALIZAR NÍVEL DE TRAILING NO BANCO (sempre como TP1_BREAKEVEN)
      await db.query(`
        UPDATE posicoes 
        SET trailing_stop_level = 'TP1_BREAKEVEN',
            data_hora_ultima_atualizacao = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [positionId]);
      console.log(`[TRAILING] SL movido para breakeven com sucesso para posição ${positionId}`);
      return true;
    } else {
      console.error(`[TRAILING] Falha ao criar SL breakeven:`, result.error);
      return false;
    }
  } catch (error) {
    console.error(`[TRAILING] Erro ao mover SL para breakeven:`, error.message);
    return false;
  }
}

/**
 * Move o Stop Loss para o TP1 após atingir o TP3
 */
async function moveStopLossToTP1(db, position, tp1Price, accountId) {
  try {
    const positionId = position.id;
    const symbol = position.simbolo;
    // Cancelar SLs existentes
    const canceledCount = await cancelStopLossOrders(db, positionId, accountId);
    if (canceledCount === 0) {
      console.warn(`[TRAILING] [WARN] Nenhuma ordem SL foi cancelada para TP1`);
    }
    // Aguarda um pouco
    await new Promise(resolve => setTimeout(resolve, 1000));
    // Cria novo SL no TP1
    const side = getOppositeSide(position.side);
    const response = await newStopOrder(
      accountId,
      symbol,
      null, // quantity = null para closePosition
      side,
      tp1Price,
      null,
      false,
      true,
      'STOP_MARKET'
    );
    const orderId = response.orderId;
    if (orderId) {
      console.log(`[TRAILING] [OK] SL reposicionado para TP1: ${orderId} @ ${tp1Price}`);
      // Atualiza nível de trailing
      await db.query(`
        UPDATE posicoes 
        SET trailing_stop_level = 'TP3_TP1',
            data_hora_ultima_atualizacao = CURRENT_TIMESTAMP
        WHERE id = $1
      `, [positionId]);
      return true;
    } else {
      console.error(`[TRAILING] [ERROR] Falha ao criar SL no TP1:`, response);
      return false;
    }
  } catch (error) {
    console.error(`[TRAILING] [ERROR] Erro ao mover SL para TP1:`, error.message);
    return false;
  }
}

/**
 * Utilitário para inverter o side da posição para o stop loss
 * Aceita aliases: BUY, LONG, COMPRA → SELL | SELL, SHORT, VENDA → BUY
 */
function getOppositeSide(side) {
  if (!side) return 'SELL'; // fallback seguro
  const s = side.toUpperCase();
  if (['BUY', 'LONG', 'COMPRA'].includes(s)) return 'SELL';
  if (['SELL', 'SHORT', 'VENDA'].includes(s)) return 'BUY';
  return 'SELL'; // fallback
}

module.exports = {
  checkOrderTriggers,
  cancelAllActiveStopLosses,
  updatePositionPricesWithTrailing
};