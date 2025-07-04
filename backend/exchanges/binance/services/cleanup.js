const { getDatabaseInstance, formatDateForPostgreSQL } = require('../../../core/database/conexao');
const api = require('../api/rest');
//const { sendTelegramMessage, formatPositionClosedMessage, formatAlertMessage } = require('../telegram/telegramBot');

/**
 * Limpa sinais órfãos e inconsistências
 */
async function cleanupOrphanSignals(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return;
    }
    
    const db = await getDatabaseInstance();
    
    // Resetar sinais em PROCESSANDO há mais de 5 minutos
    const resetResult = await db.query(`
      UPDATE webhook_signals 
      SET status = 'PENDING', 
          error_message = NULL,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'PROCESSANDO' 
        AND conta_id = $1
        AND updated_at < (CURRENT_TIMESTAMP - INTERVAL '5 minutes')
    `, [accountId]);
    
    if (resetResult.rowCount > 0) {
      console.log(`[CLEANUP] ${resetResult.rowCount} sinais resetados para conta ${accountId}`);
    }

    // Limpar sinais com erro de "not defined"
    await db.query(`
      UPDATE webhook_signals 
      SET status = 'ERROR', 
          error_message = COALESCE(error_message, '') || ' | Limpo durante cleanup'
      WHERE error_message LIKE '%not defined%' 
        AND conta_id = $1
        AND status NOT IN ('ERROR', 'CANCELED')
    `, [accountId]);

  } catch (error) {
    console.error(`[CLEANUP] Erro na limpeza de sinais órfãos para conta ${accountId}:`, error.message);
  }
}

/**
 * Força fechamento de posições detectadas como fechadas na corretora
 */
async function forceCloseGhostPositions(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const dbPositionsResult = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = $1
    `, [accountId]);
    
    if (dbPositionsResult.rows.length === 0) {
      return 0;
    }
    
    const dbPositions = dbPositionsResult.rows;
    
    // Obter posições abertas na corretora
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // Posição não existe na corretora ou tem quantidade zero
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = CURRENT_TIMESTAMP,
              observacoes = 'Fechada via cleanup - não encontrada na corretora'
          WHERE id = $1
        `, [dbPos.id]);
        
        console.log(`[CLEANUP] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[CLEANUP] Erro ao fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ VERSÃO SIMPLIFICADA: Verifica se ordem existe na corretora pelo id_externo
 * Se não existir na corretora = órfã (atualizar banco)
 */
async function cancelOrphanOrders(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    // ✅ VERIFICAR SE SISTEMA ESTÁ EM SHUTDOWN
    if (global.isShuttingDown || process.env.NODE_ENV === 'shutdown') {
      console.log(`[CLEANUP] 🛑 Sistema em shutdown - cancelando verificação de órfãs para conta ${accountId}`);
      return 0;
    }
   
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR APENAS ORDENS ATIVAS (excluir já finalizadas)
    const activeOrdersResult = await db.query(`
      SELECT id_externo, simbolo, tipo_ordem_bot, quantidade, preco, status, id_posicao, orign_sig
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
        AND conta_id = $1
    `, [accountId]);

    if (activeOrdersResult.rows.length === 0) {
      return 0;
    }

    const activeOrders = activeOrdersResult.rows;
    console.log(`[CLEANUP] 🔍 Verificando ${activeOrders.length} ordens ATIVAS para órfãs (conta ${accountId})...`);

    let orphanCount = 0;
    let preservedCount = 0;

    for (const order of activeOrders) {
      try {
        // ✅ VERIFICAR SE ORDEM EXISTE NA CORRETORA
        const orderStatus = await api.getOrderStatus(order.simbolo, order.id_externo, accountId);

        if (orderStatus && orderStatus.orderId) {
          const exchangeStatus = orderStatus.status;
          
          // ✅ SE STATUS MUDOU PARA FINALIZADO, MOVER IMEDIATAMENTE
          if (['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(exchangeStatus)) {
            console.log(`[CLEANUP] 🎯 Ordem ${order.id_externo} finalizada na corretora (${exchangeStatus}) - movendo...`);
            
            // Atualizar status no banco primeiro
            await db.query(`
              UPDATE ordens 
              SET status = $1, last_update = CURRENT_TIMESTAMP
              WHERE id_externo = $2 AND conta_id = $3
            `, [exchangeStatus, order.id_externo, accountId]);
            
            // Mover automaticamente
            const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
            const moved = await autoMoveOrderOnCompletion(order.id_externo, exchangeStatus, accountId);
            
            if (moved) {
              console.log(`[CLEANUP] ✅ Ordem finalizada ${order.id_externo} movida para histórico`);
              orphanCount++; // Contar como processada
            }
            
          } else if (exchangeStatus !== order.status) {
            // ✅ SINCRONIZAR STATUS SEM MOVER
            console.log(`[CLEANUP] 🔄 Sincronizando status: ${order.status} → ${exchangeStatus}`);
            await db.query(`
              UPDATE ordens 
              SET status = $1, last_update = CURRENT_TIMESTAMP
              WHERE id_externo = $2 AND conta_id = $3
            `, [exchangeStatus, order.id_externo, accountId]);
            preservedCount++;
          } else {
            // ✅ ORDEM OK - PRESERVAR
            preservedCount++;
          }
          
        } else {
          // ✅ ORDEM NÃO EXISTE = ÓRFÃ
          console.log(`[CLEANUP] 🗑️ Ordem órfã detectada: ${order.id_externo} - marcando como CANCELED`);
          
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', 
                last_update = CURRENT_TIMESTAMP,
                observacao = COALESCE(observacao, '') || ' | Órfã - não existe na corretora'
            WHERE id_externo = $1 AND conta_id = $2
          `, [order.id_externo, accountId]);
          
          // ✅ MOVER ÓRFÃ PARA HISTÓRICO IMEDIATAMENTE
          const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
          const moved = await autoMoveOrderOnCompletion(order.id_externo, 'CANCELED', accountId);
          
          if (moved) {
            orphanCount++;
            console.log(`[CLEANUP] ✅ Órfã ${order.id_externo} movida para histórico`);
          }
        }

      } catch (orderError) {
        console.error(`[CLEANUP] ⚠️ Erro ao verificar ordem ${order.id_externo}:`, orderError.message);
        preservedCount++;
      }
    }

    console.log(`[CLEANUP] 📊 Resumo para conta ${accountId}:`);
    console.log(`  - Ordens processadas/movidas: ${orphanCount}`);
    console.log(`  - Ordens preservadas (ativas): ${preservedCount}`);

    return orphanCount;

  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro ao processar ordens para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Mover ordens para histórico COM TODOS OS CAMPOS
 */
async function moveOrdersToHistory(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR ORDENS PARA MOVER (CANCELED + FILLED órfãs)
    const ordersToMoveResult = await db.query(`
      SELECT o.*, p.status as position_status FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.conta_id = $1 
        AND (
          (o.status = 'CANCELED' AND o.last_update > (CURRENT_TIMESTAMP - INTERVAL '1 minute'))
          OR 
          (o.status = 'FILLED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < (CURRENT_TIMESTAMP - INTERVAL '1 minute'))
          OR 
          (o.status = 'EXPIRED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < (CURRENT_TIMESTAMP - INTERVAL '1 minute'))
        )
    `, [accountId]);
    
    if (ordersToMoveResult.rows.length === 0) {
      return 0;
    }
    
    const ordersToMove = ordersToMoveResult.rows;
    const canceledOrders = ordersToMove.filter(o => o.status === 'CANCELED');
    const orphanFilledOrders = ordersToMove.filter(o => o.status === 'FILLED');
    
    console.log(`[CLEANUP] 📚 Movendo para histórico:`);
    console.log(`  - ${canceledOrders.length} ordens CANCELED`);
    console.log(`  - ${orphanFilledOrders.length} ordens FILLED órfãs`);
    
    let movedCount = 0;
    
    for (const order of ordersToMove) {
      // Nova regra: Se for ENTRADA, FILLED ou CANCELED, sem id_posicao, aguarda e tenta vincular
      if (
        (order.status === 'FILLED' || order.status === 'CANCELED') &&
        order.tipo_ordem_bot === 'ENTRADA' &&
        (!order.id_posicao || order.id_posicao === 0)
      ) {
        console.warn(`[CLEANUP] ⏳ Ordem ENTRADA ${order.status} ${order.id_externo} sem id_posicao. Aguardando 30s para tentar vincular à posição aberta...`);
        await new Promise(resolve => setTimeout(resolve, 30000));
        // Buscar posição aberta para o symbol
        const openPositionsResult = await db.query(`SELECT id FROM posicoes WHERE simbolo = $1 AND status = 'OPEN' AND conta_id = $2 LIMIT 1`,
          [order.simbolo, accountId]
        );
        if (openPositionsResult.rows.length > 0) {
          const posId = openPositionsResult.rows[0].id;
          await db.query(`UPDATE ordens SET id_posicao = $1 WHERE id_externo = $2 AND conta_id = $3`, [posId, order.id_externo, accountId]);
          order.id_posicao = posId;
          console.log(`[CLEANUP] 🔗 Ordem ${order.id_externo} vinculada à posição ${posId}`);
        } else {
          console.warn(`[CLEANUP] ⚠️ Não foi encontrada posição aberta para o symbol ${order.simbolo} após aguardar. Ordem ${order.id_externo} permanecerá sem vínculo.`);
          // Não mover para o histórico se não conseguir vincular
          continue;
        }
      }
      // Só mover se já estiver vinculada a uma posição
      if (!order.id_posicao || order.id_posicao === 0) {
        console.warn(`[CLEANUP] ⚠️ Ordem ${order.id_externo} ainda não vinculada a uma posição (id_posicao NULL/0). Aguardando vínculo antes de mover para _fechadas.`);
        continue;
      }
      // Atualizar posição relacionada, se houver
      if (order.id_posicao) {
        // Buscar posição atual
        const positionsResult = await db.query(`SELECT total_commission, total_realized FROM posicoes WHERE id = $1 AND conta_id = $2`, [order.id_posicao, accountId]);
        if (positionsResult.rows.length > 0) {
          const pos = positionsResult.rows[0];
          const newTotalCommission = (parseFloat(pos.total_commission) || 0) + (parseFloat(order.commission) || 0);
          const newTotalRealized = (parseFloat(pos.total_realized) || 0) + (parseFloat(order.realized_profit) || 0);

          let newLiquidPnl;
          if (newTotalCommission < 0) {
            newLiquidPnl = newTotalRealized + newTotalCommission;
          } else {
            newLiquidPnl = newTotalRealized - newTotalCommission;
          }

          await db.query(`UPDATE posicoes SET total_commission = $1, total_realized = $2, liquid_pnl = $3 WHERE id = $4 AND conta_id = $5`, [newTotalCommission, newTotalRealized, newLiquidPnl, order.id_posicao, accountId]);
          console.log(`[CLEANUP] Posição ${order.id_posicao} atualizada: total_commission=${newTotalCommission}, total_realized=${newTotalRealized}, liquid_pnl=${newLiquidPnl}`);
        }
      }
      // ✅ INSERIR COM TODOS OS CAMPOS
      await db.query(`
        INSERT INTO ordens_fechadas (
          id_original, id_original_ordens, tipo_ordem, preco, quantidade, id_posicao, status,
          data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot,
          target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco,
          orign_sig, dados_originais_ws, quantidade_executada, preco_executado, observacao,
          conta_id, commission, commission_asset, trade_id, client_order_id, time_in_force,
          stop_price, execution_type, last_filled_quantity, last_filled_price, order_trade_time,
          realized_profit, position_side
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36)
      `, [
        order.id, // id_original
        order.id, // id_original_ordens
        order.tipo_ordem,
        order.preco,
        order.quantidade,
        order.id_posicao,
        order.status,
        formatDateForPostgreSQL(order.data_hora_criacao || new Date()),
        order.id_externo,
        order.side,
        order.simbolo,
        order.tipo_ordem_bot,
        order.target,
        order.reduce_only,
        order.close_position,
        formatDateForPostgreSQL(order.last_update || new Date()),
        order.renew_sl_firs,
        order.renew_sl_seco,
        order.orign_sig,
        order.dados_originais_ws,
        order.quantidade_executada || 0,
        order.preco_executado,
        order.observacao || (order.status === 'CANCELED' ? 'Movida via cleanup - órfã' : 'Movida automaticamente - posição fechada'),
        order.conta_id,
        order.commission || 0,
        order.commission_asset,
        order.trade_id,
        order.client_order_id,
        order.time_in_force,
        order.stop_price,
        order.execution_type,
        order.last_filled_quantity,
        order.last_filled_price,
        order.order_trade_time,
        order.realized_profit,
        order.position_side
      ]);
      // ✅ REMOVER DA TABELA ATIVA
      await db.query(`DELETE FROM ordens WHERE id_externo = $1 AND conta_id = $2`, [order.id_externo, accountId]);
      movedCount++;
    }
    
    console.log(`[CLEANUP] ✅ ${movedCount} ordens movidas para histórico com sucesso`);
    
    return movedCount;
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro na função moveOrdersToHistory:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Verificar se ordem específica existe na corretora
 * @param {string} symbol - Símbolo da ordem
 * @param {string} orderId - ID externo da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - { exists: boolean, status: string|null }
 */
async function checkOrderExistsOnExchange(symbol, orderId, accountId) {
  try {
    const orderStatus = await api.getOrderStatus(symbol, orderId, accountId);
    
    if (orderStatus && orderStatus.orderId && orderStatus.status) {
      return {
        exists: true,
        status: orderStatus.status,
        data: orderStatus
      };
    } else {
      return {
        exists: false,
        status: null,
        data: null
      };
    }
    
  } catch (error) {
    // Verificar se é erro de "ordem não existe"
    if (error.message.includes('Unknown order sent') || 
        error.message.includes('Order does not exist') ||
        error.message.includes('-2013')) {
      
      return {
        exists: false,
        status: null,
        error: 'ORDER_NOT_FOUND'
      };
    }
    
    // Outros erros (rede, etc.) - relançar
    throw error;
  }
}

/**
 * ✅ FUNÇÃO PARA VERIFICAR ORDEM INDIVIDUAL
 * Útil para verificações pontuais ou debugging
 */
async function checkSingleOrderStatus(orderId, accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar ordem no banco
    const orderInDbResult = await db.query(`
      SELECT id_externo, simbolo, tipo_ordem_bot, status, last_update
      FROM ordens 
      WHERE id_externo = $1 AND conta_id = $2
    `, [orderId, accountId]);
    
    if (orderInDbResult.rows.length === 0) {
      return { error: 'Ordem não encontrada no banco de dados' };
    }
    
    const order = orderInDbResult.rows[0];
    
    // Verificar na corretora
    const exchangeCheck = await checkOrderExistsOnExchange(order.simbolo, orderId, accountId);
    
    const result = {
      orderId: orderId,
      symbol: order.simbolo,
      type: order.tipo_ordem_bot,
      statusInDb: order.status,
      lastUpdate: order.last_update,
      existsOnExchange: exchangeCheck.exists,
      statusOnExchange: exchangeCheck.status,
      isOrphan: !exchangeCheck.exists && ['NEW', 'PARTIALLY_FILLED'].includes(order.status)
    };
    
    console.log(`[CLEANUP] 📋 Status da ordem ${orderId}:`);
    console.log(`  - No banco: ${result.statusInDb}`);
    console.log(`  - Na corretora: ${result.existsOnExchange ? result.statusOnExchange : 'NÃO EXISTE'}`);
    console.log(`  - É órfã: ${result.isOrphan ? 'SIM' : 'NÃO'}`);
    
    return result;
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro ao verificar ordem ${orderId}:`, error.message);
    return { error: error.message };
  }
}

/**
 * ✅ FUNÇÃO PARA HISTORICO DE POSIÇÕES
 * Move posições fechadas para o histórico
 */
async function movePositionToHistory(positionId, accountId, force = false) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posição
    const positionsResult = await db.query(`
      SELECT * FROM posicoes 
      WHERE id = $1 AND conta_id = $2
    `, [positionId, accountId]);
    
    if (positionsResult.rows.length === 0) {
      return 0;
    }
    
    const position = positionsResult.rows[0];
    
    // Verificar se já está fechada
    if (position.status !== 'CLOSED' && !force) {
      console.log(`[HISTORICO] Posição ${positionId} não está fechada (status: ${position.status})`);
      return 0;
    }
    
    // Inserir no histórico
    await db.query(`
      INSERT INTO posicoes_fechadas (
        id_original, simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, motivo_fechamento, side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig, conta_id, quantidade_aberta, trailing_stop_level, pnl_corrente, breakeven_price, accumulated_realized, unrealized_pnl, margin_type, isolated_wallet, position_side, event_reason, webhook_data_raw, observacoes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27)
    `, [
      position.id, // id_original
      position.simbolo,
      position.quantidade,
      position.preco_medio,
      status || position.status,
      formatDateForPostgreSQL(position.data_hora_abertura),
      formatDateForPostgreSQL(new Date()), // data_hora_fechamento = agora
      reason || null, // motivo_fechamento
      position.side,
      position.leverage,
      formatDateForPostgreSQL(position.data_hora_ultima_atualizacao),
      position.preco_entrada,
      position.preco_corrente,
      position.orign_sig,
      position.conta_id,
      position.quantidade_aberta,
      position.trailing_stop_level,
      position.pnl_corrente,
      position.breakeven_price,
      position.accumulated_realized,
      position.unrealized_pnl,
      position.margin_type,
      position.isolated_wallet,
      position.position_side,
      position.event_reason,
      position.webhook_data_raw,
      position.observacoes
    ]);
    
    // Remover da tabela de posições
    await db.query(`
      DELETE FROM posicoes WHERE id = $1
    `, [positionId]);
    
    console.log(`[HISTORICO] Posição ${positionId} movida para histórico com sucesso`);
    
    // Enviar mensagem para o Telegram
   // const message = formatPositionClosedMessage(position);
   // sendTelegramMessage(message);
    
    return 1;
    
  } catch (error) {
    console.error(`[HISTORICO] Erro ao mover posição ${positionId} para histórico:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO PARA FECHAR E SINCRONIZAR POSIÇÕES "FANTASMA"
 * Fecha posições que estão abertas no banco mas não na corretora
 */
async function checkAndCloseWebsocket(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const dbPositionsResult = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = $1
    `, [accountId]);
    
    if (dbPositionsResult.rows.length === 0) {
      return 0;
    }
    
    const dbPositions = dbPositionsResult.rows;
    
    // Obter posições abertas na corretora via WebSocket
    const exchangePositions = await api.api.getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // Posição não existe na corretora ou tem quantidade zero
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = CURRENT_TIMESTAMP,
              observacoes = 'Fechada via WebSocket - não encontrada na corretora'
          WHERE id = $1
        `, [dbPos.id]);
        
        console.log(`[WEBSOCKET] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[WEBSOCKET] Erro ao fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ⚡️ SOLUÇÃO CORRIGIDA: Mover posição para histórico COM TODOS OS CAMPOS
 * SEQUÊNCIA CORRETA: 1) Cancelar ordens na corretora → 2) Mover para histórico
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} positionId - ID da posição
 * @param {string} status - Status para o histórico
 * @param {string} reason - Motivo do fechamento 
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se movida com sucesso
 */
async function movePositionToHistory(db, positionId, status = 'CLOSED', reason = 'Movida automaticamente', accountId) {
  let connection;
  try {
    console.log(`[MOVE_POSITION] 📚 Iniciando movimento da posição ${positionId} para conta ${accountId}...`);
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Obter a posição
    const positionResult = await connection.query(`SELECT * FROM posicoes WHERE id = $1 AND conta_id = $2`, [positionId, accountId]
    );
    if (positionResult.rows.length === 0) {
      console.log(`[MOVE_POSITION] ⚠️ Posição ${positionId} não encontrada para conta ${accountId}`);
      await connection.rollback();
      return false;
    }
    const position = positionResult.rows[0];
    const symbol = position.simbolo;

    // 2. Buscar ordens relacionadas ANTES de mover
    const relatedOrdersResult = await connection.query(`SELECT id, id_externo, status FROM ordens WHERE id_posicao = $1 AND conta_id = $2`, [positionId, accountId]
    );
    const relatedOrders = relatedOrdersResult.rows;
    console.log(`[MOVE_POSITION] 📋 Encontradas ${relatedOrders.length} ordens relacionadas para ${symbol}...`);

    // 3. Cancelar ordens na corretora
    let ordersToCancel = relatedOrders.filter(order => 
      ['NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].includes(order.status)
    );
    if (ordersToCancel.length > 0) {
      console.log(`[MOVE_POSITION] 🗑️ Cancelando ${ordersToCancel.length} ordens ativas na corretora...`);
      
      for (const order of ordersToCancel) {
        try {
          const cancelResult = await api.cancelOrder(symbol, order.id_externo, accountId);
          
          if (cancelResult && cancelResult.status) {
            await connection.query(`UPDATE ordens SET status = $1, last_update = $2, observacao = $3 WHERE id = $4 AND conta_id = $5`, [cancelResult.status, formatDateForPostgreSQL(new Date()), `Cancelada durante fechamento da posição ${positionId}`, order.id, accountId]
            );
          }
        } catch (cancelError) {
          if (cancelError.message.includes('Unknown order') || 
              cancelError.message.includes('-2011') ||
              cancelError.message.includes('Order does not exist')) {
            await connection.query(
              'UPDATE ordens SET status = $1, last_update = $2, observacao = $3 WHERE id = $4 AND conta_id = $5',
              [formatDateForPostgreSQL(new Date()), 'Marcada como cancelada - não existe na corretora', order.id, accountId]
            );
          }
        }
      }
      
      console.log(`[MOVE_POSITION] ✅ Processo de cancelamento na corretora concluído`);
    } else {
      console.log(`[MOVE_POSITION] ℹ️ Nenhuma ordem ativa para cancelar na corretora`);
    }
    
    // 4. Aguardar 2 segundos
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // 5. Buscar ordens atualizadas
    const updatedOrdersResult = await connection.query(`SELECT id FROM ordens WHERE id_posicao = $1 AND conta_id = $2`, [positionId, accountId]
    );
    
    // 6. INSERIR POSIÇÃO NO HISTÓRICO COM TODOS OS CAMPOS CORRETOS
    await connection.query(`
      INSERT INTO posicoes_fechadas (
        id_original, simbolo, quantidade, quantidade_aberta, preco_medio, status, data_hora_abertura, data_hora_fechamento, motivo_fechamento, side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig, conta_id, trailing_stop_level, pnl_corrente, breakeven_price, accumulated_realized, unrealized_pnl, total_realized, total_commission, liquid_pnl, margin_type, isolated_wallet, position_side, event_reason, webhook_data_raw, observacoes, last_update
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31)
    `, [
      position.id, // id_original
      position.simbolo,
      position.quantidade,
      position.quantidade_aberta,
      position.preco_medio,
      status || position.status,
      formatDateForPostgreSQL(position.data_hora_abertura),
      formatDateForPostgreSQL(new Date()), // data_hora_fechamento = agora
      reason || null, // motivo_fechamento
      position.side,
      position.leverage,
      formatDateForPostgreSQL(position.data_hora_ultima_atualizacao),
      position.preco_entrada,
      position.preco_corrente,
      position.orign_sig,
      position.conta_id,
      position.trailing_stop_level,
      position.pnl_corrente,
      position.breakeven_price,
      position.accumulated_realized,
      position.unrealized_pnl,
      position.total_realized,
      position.total_commission,
      position.liquid_pnl,
      position.margin_type,
      position.isolated_wallet,
      position.position_side,
      position.event_reason,
      position.webhook_data_raw,
      position.observacoes,
      formatDateForPostgreSQL(new Date())
    ]);

    // 7. MOVER ORDENS PARA HISTÓRICO (mantém igual)
    const updatedOrders = updatedOrdersResult.rows;
    for (const order of updatedOrders) {
      // Atualizar posição relacionada, se houver
      if (order.id_posicao) {
        // Buscar posição atual
        const positionsResult = await connection.query(`SELECT total_commission, total_realized FROM posicoes WHERE id = $1 AND conta_id = $2`, [order.id_posicao, accountId]
        );
        if (positionsResult.rows.length > 0) {
          const pos = positionsResult.rows[0];
          const newTotalCommission = (parseFloat(pos.total_commission) || 0) + (parseFloat(order.commission) || 0);
          const newTotalRealized = (parseFloat(pos.total_realizado) || 0) + (parseFloat(order.realized_profit) || 0);

          // Regra para cálculo do liquid_pnl
          let newLiquidPnl;
          if (newTotalCommission < 0) {
            newLiquidPnl = newTotalRealized + newTotalCommission;
          } else {
            newLiquidPnl = newTotalRealized - newTotalCommission;
          }

          await connection.query(`UPDATE posicoes SET total_commission = $1, total_realized = $2, liquid_pnl = $3 WHERE id = $4 AND conta_id = $5`, [newTotalCommission, newTotalRealized, newLiquidPnl, order.id_posicao, accountId]
          );
          console.log(`[CLEANUP] Posição ${order.id_posicao} atualizada: total_commission=${newTotalCommission}, total_realized=${newTotalRealized}, liquid_pnl=${newLiquidPnl}`);
        }
      }
      await connection.query(`
        INSERT INTO ordens_fechadas (
          id_original, id_original_ordens, tipo_ordem, preco, quantidade, id_posicao, status,
          data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot,
          target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco,
          orign_sig, dados_originais_ws, quantidade_executada, preco_executado, observacao,
          conta_id, commission, commission_asset, trade_id, client_order_id, time_in_force,
          stop_price, execution_type, last_filled_quantity, last_filled_price, order_trade_time,
          realized_profit, position_side
        )
        SELECT
          id, -- id_original
          id, -- id_original_ordens
          tipo_ordem,
          preco,
          quantidade,
          id_posicao,
          status,
          data_hora_criacao,
          id_externo,
          side,
          simbolo,
          tipo_ordem_bot,
          target,
          reduce_only,
          close_position,
          $1, -- last_update (formatado)
          renew_sl_firs,
          renew_sl_seco,
          orign_sig,
          dados_originais_ws,
          quantidade_executada,
          preco_executado,
          COALESCE(observacao, '') || ' | Cancelada na corretora antes da movimentação para histórico',
          conta_id,
          commission,
          commission_asset,
          trade_id,
          client_order_id,
          time_in_force,
          stop_price,
          execution_type,
          last_filled_quantity,
          last_filled_price,
          order_trade_time,
          realized_profit,
          position_side
        FROM ordens
        WHERE id_posicao = $2 AND conta_id = $3`, [formatDateForPostgreSQL(new Date()), positionId, accountId]
      );
    }
    
    // 8. Deletar ordens da tabela principal
    await connection.query(`DELETE FROM ordens WHERE id_posicao = $1 AND conta_id = $2`, [positionId, accountId]);
    
    // 9. Deletar posição da tabela principal
    await connection.query(`DELETE FROM posicoes WHERE id = $1 AND conta_id = $2`, [positionId, accountId]);
    
    await connection.commit();
    console.log(`[MOVE_POSITION] ✅ Posição ${symbol} (ID: ${positionId}) movida com sucesso após cancelar ordens na corretora`);
    
    // 10. Enviar notificação ao Telegram APÓS commit e com dados atualizados
    try {
      // Recarregar a posição já atualizada (com PnL final)
      const updatedPositionResult = await connection.query(`SELECT * FROM posicoes_fechadas WHERE id_original = $1 AND conta_id = $2 ORDER BY id DESC LIMIT 1`, [positionId, accountId]
      );
      const updatedPosition = updatedPositionResult && updatedPositionResult.rows[0] ? updatedPositionResult.rows[0] : position;
      
      // ✅ REMOVIDO: Envio de mensagem duplicada (já enviada em accountHandlers.js)
      // const message = await formatPositionClosedMessage(updatedPosition);
      // await sendTelegramMessage(accountId, message);
      console.log(`[MOVE_POSITION] 📱 Notificação já enviada em accountHandlers.js - não enviando duplicada`);
    } catch (telegramError) {
      console.log(`[MOVE_POSITION] ⚠️ Erro ao enviar notificação: ${telegramError.message}`);
    }
    
    return true;
    
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`[MOVE_POSITION] ❌ Erro ao mover posição ${positionId}:`, error.message);
    console.error(`[MOVE_POSITION] Stack:`, error.stack);
    return false;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * ✅ FUNÇÃO PARA SINCRONIZAR E FECHAR POSIÇÕES "FANTASMA"
 * Sincroniza posições abertas na corretora e fecha as que estão abertas no banco mas não na corretora
 */
async function syncAndCloseGhostPositions(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Obter posições abertas no banco
    const dbPositionsResult = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = $1
    `, [accountId]);
    
    if (dbPositionsResult.rows.length === 0) {
      return 0;
    }
    
    const dbPositions = dbPositionsResult.rows;
    
    // Obter posições abertas na corretora
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos) {
        // Posição não existe na corretora
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = CURRENT_TIMESTAMP,
              observacoes = 'Fechada via sync - não encontrada na corretora'
          WHERE id = $1
        `, [dbPos.id]);
        
        console.log(`[SYNC] Posição fantasma ${dbPos.simbolo} fechada para conta ${accountId} (ID: ${dbPos.id})`);
        closedCount++;
      } else {
        // Sincronizar quantidade e status
        const quantidadeDiff = Math.abs(parseFloat(exchangePos.quantidade)) - Math.abs(parseFloat(dbPos.quantidade));
        
        if (quantidadeDiff > 0.000001) {
          await db.query(`
            UPDATE posicoes 
            SET quantidade = $1, 
                status = 'OPEN', 
                data_hora_fechamento = NULL,
                observacoes = 'Sincronizada com a corretora'
            WHERE id = $2
          `, [exchangePos.quantidade, dbPos.id]);
          
          console.log(`[SYNC] Posição ${dbPos.simbolo} sincronizada (nova quantidade: ${exchangePos.quantidade})`);
        }
      }
    }
    
    return closedCount;
    
  } catch (error) {
    console.error(`[SYNC] Erro ao sincronizar e fechar posições fantasma para conta ${accountId}:`, error.message);
    return 0;
  }
}

module.exports = {
  cleanupOrphanSignals,
  forceCloseGhostPositions,
  cancelOrphanOrders,
  moveOrdersToHistory,
  checkOrderExistsOnExchange,
  checkSingleOrderStatus,
  movePositionToHistory,
  checkAndCloseWebsocket,
  syncAndCloseGhostPositions
};