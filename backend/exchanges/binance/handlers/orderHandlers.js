const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatOrderMessage, formatPositionClosedMessage } = require('../telegram/telegramBot');

const targetCache = new Map();

/**
 * ✅ FUNÇÃO UNIFICADA: Processa atualizações de ordens via WebSocket
 * Suporta MÚLTIPLOS formatos de entrada
 */
async function handleOrderUpdate(messageOrAccountId, orderDataOrDb = null, db = null) {
  try {
    let accountId, orderUpdateData, connection;
    
    // ✅ DETECTAR FORMATO DA CHAMADA
    if (typeof messageOrAccountId === 'number') {
      // FORMATO NOVO: handleOrderUpdate(accountId, orderUpdateData)
      accountId = messageOrAccountId;
      orderUpdateData = orderDataOrDb;
      connection = db;
    } else {
      // FORMATO ANTIGO: handleOrderUpdate(orderMsg, accountId, db)
      const orderMsg = messageOrAccountId;
      accountId = orderDataOrDb;
      connection = db;
      
      // ✅ VALIDAÇÃO DO FORMATO ANTIGO - CORREÇÃO AQUI
      if (!orderMsg) {
        console.error(`[ORDER] Mensagem de ordem inválida para conta ${accountId}`);
        return;
      }
      
      // ✅ EXTRAIR DADOS CORRETAMENTE BASEADO NO FORMATO BINANCE
      if (orderMsg.e === 'ORDER_TRADE_UPDATE' && orderMsg.o) {
        // Formato padrão da Binance: { e: 'ORDER_TRADE_UPDATE', o: { ... } }
        orderUpdateData = orderMsg.o;
      } else if (orderMsg.i && orderMsg.s) {
        // Formato direto: { i: orderId, s: symbol, ... }
        orderUpdateData = orderMsg;
      } else {
        console.error(`[ORDER] Formato de mensagem não reconhecido para conta ${accountId}:`, {
          hasE: orderMsg.e,
          hasO: !!orderMsg.o,
          hasI: !!orderMsg.i,
          hasS: !!orderMsg.s
        });
        return;
      }
    }

    // ✅ VALIDAÇÃO UNIFICADA
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ORDER] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    // ✅ PROCESSAR DADOS DA ORDEM - AGORA orderUpdateData JÁ ESTÁ CORRETO
    const orderData = orderUpdateData;
    
    const orderId = orderData.i?.toString();
    const symbol = orderData.s;
    const orderStatus = orderData.X;
    const executionType = orderData.x;
    
    if (!orderId || !symbol || !orderStatus) {
      console.warn(`[ORDER] ⚠️ Dados incompletos: orderId=${orderId}, symbol=${symbol}, status=${orderStatus}`);
      console.warn(`[ORDER] ⚠️ Dados recebidos:`, JSON.stringify(orderData, null, 2));
      return;
    }

    console.log(`[ORDER] 📨 Processando atualização: ${orderId} (${symbol}) - ${executionType}/${orderStatus}`);

    // ✅ OBTER CONEXÃO COM BANCO
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
      if (!connection) {
        console.error(`[ORDER] Não foi possível obter conexão com banco para conta ${accountId}`);
        return;
      }
    }

    // ✅ 1. VERIFICAR SE ORDEM EXISTE NO BANCO
    const [existingOrders] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderId, symbol, accountId]
    );

    const orderExists = existingOrders.length > 0;
    let shouldInsert = false;

    if (!orderExists) {
      console.log(`[ORDER] 🆕 Ordem externa detectada: ${orderId} - inserindo no banco...`);
      shouldInsert = true;
    }

    // ✅ 2. INSERIR ORDEM SE NÃO EXISTE (ORDEM EXTERNA)
    if (shouldInsert) {
      await insertExternalOrder(connection, orderData, accountId);
    }

    // ✅ 3. ATUALIZAR ORDEM EXISTENTE
    if (orderExists) {
      await updateExistingOrder(connection, orderData, accountId, existingOrders[0]);
    }

    // ✅ 4. VERIFICAR SE DEVE MOVER PARA HISTÓRICO
    const finalStatuses = ['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'];
    
    if (finalStatuses.includes(orderStatus)) {
      console.log(`[ORDER] 🎯 Status final detectado (${orderStatus}) - iniciando movimento automático...`);
      
      // Aguardar um pouco para garantir que a atualização foi processada
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const moved = await autoMoveOrderOnCompletion(orderId, orderStatus, accountId);
      
      if (moved) {
        console.log(`[ORDER] ✅ Ordem ${orderId} (${orderStatus}) movida automaticamente para histórico`);
        
        // Verificar fechamento de posição para ordens FILLED
        if (orderStatus === 'FILLED') {
          try {
            const closureResult = await checkPositionClosureAfterOrderExecution(orderId, accountId);
            if (closureResult) {
              console.log(`[ORDER] 🏁 Posição fechada automaticamente após execução da ordem ${orderId}`);
            }
          } catch (closureError) {
            console.error(`[ORDER] ⚠️ Erro ao verificar fechamento de posição:`, closureError.message);
          }
        }
      } else {
        console.warn(`[ORDER] ⚠️ Falha ao mover ordem ${orderId} automaticamente`);
      }
    }

    // ✅ 5. LOGS DETALHADOS
    if (orderStatus === 'FILLED') {
      const executedQty = parseFloat(orderData.z || 0);
      const avgPrice = parseFloat(orderData.ap || 0);
      const totalValue = executedQty * avgPrice;
      
      console.log(`[ORDER] 💰 Ordem FILLED processada:`);
      console.log(`[ORDER]   - ID: ${orderId}`);
      console.log(`[ORDER]   - Símbolo: ${symbol}`);
      console.log(`[ORDER]   - Quantidade: ${executedQty}`);
      console.log(`[ORDER]   - Preço médio: ${avgPrice}`);
      console.log(`[ORDER]   - Valor total: ${totalValue.toFixed(2)} USDT`);
    } else if (orderStatus === 'NEW') {
      console.log(`[ORDER] ✅ Nova ordem registrada:`);
      console.log(`[ORDER]   - ID: ${orderId}`);
      console.log(`[ORDER]   - Símbolo: ${symbol}`);
      console.log(`[ORDER]   - Tipo: ${orderData.o} (${orderData.R ? 'REDUCE_ONLY' : 'NORMAL'})`);
      console.log(`[ORDER]   - Side: ${orderData.S}`);
      console.log(`[ORDER]   - Quantidade: ${orderData.q}`);
      console.log(`[ORDER]   - Preço: ${orderData.p}`);
    }

  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao processar atualização da ordem:`, error.message);
    console.error(`[ORDER] Stack trace:`, error.stack);
  }
}

/**
 * Trata criação de nova ordem
 */
async function handleNewOrder(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  const symbol = order.s;
  
  try {
    if (existingOrder) {
      // Ordem já existe, apenas atualizar status e dados do WebSocket
      await connection.query(
        `UPDATE ordens SET 
         status = ?, 
         last_update = NOW(),
         dados_originais_ws = ?
         WHERE id_externo = ? AND conta_id = ?`,
        [order.X, JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem existente ${orderId} atualizada para ${order.X}`);
    } else {
      // ✅ BUSCAR POSIÇÃO RELACIONADA ANTES DE CRIAR A ORDEM
      let positionId = null;
      
      if (order.R === true) {
        // Se é reduce-only, deve ter uma posição existente
        const [existingPositions] = await connection.query(
          'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
          [symbol, 'OPEN', accountId]
        );
        
        if (existingPositions.length > 0) {
          positionId = existingPositions[0].id;
          console.log(`[ORDER] Ordem reduce-only ${orderId} vinculada à posição ${positionId}`);
        }
      }
      
      // ✅ USAR ESTRUTURA CORRETA DA TABELA
      const orderData = {
        tipo_ordem: mapOrderType(order.o),
        preco: parseFloat(order.p || '0'),
        quantidade: parseFloat(order.q || '0'),
        id_posicao: positionId, // NULL para ordens de entrada
        status: order.X,
        data_hora_criacao: formatDateForMySQL(new Date(order.T || Date.now())),
        id_externo: orderId,
        side: order.S,
        simbolo: symbol,
        tipo_ordem_bot: determineOrderBotType(order),
        target: null,
        reduce_only: order.R === true ? 1 : 0,
        close_position: order.cp === true ? 1 : 0,
        last_update: formatDateForMySQL(new Date()),
        orign_sig: extractOriginSignal(order.c),
        observacao: null,
        preco_executado: parseFloat(order.ap || '0'),
        quantidade_executada: parseFloat(order.z || '0'),
        dados_originais_ws: JSON.stringify(order),
        conta_id: accountId,
        renew_sl_firs: null,
        renew_sl_seco: null,
        commission: parseFloat(order.n || '0'),
        commission_asset: order.N || null,
        trade_id: order.t || null
      };

      // ✅ INSERIR COM QUERY MANUAL PARA CONTROLE COMPLETO
      const insertQuery = `
        INSERT INTO ordens (
          tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao,
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only,
          close_position, last_update, orign_sig, observacao, preco_executado,
          quantidade_executada, dados_originais_ws, conta_id, renew_sl_firs,
          renew_sl_seco, commission, commission_asset, trade_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const insertValues = [
        orderData.tipo_ordem, orderData.preco, orderData.quantidade, orderData.id_posicao,
        orderData.status, orderData.data_hora_criacao, orderData.id_externo, orderData.side,
        orderData.simbolo, orderData.tipo_ordem_bot, orderData.target, orderData.reduce_only,
        orderData.close_position, orderData.last_update, orderData.orign_sig, orderData.observacao,
        orderData.preco_executado, orderData.quantidade_executada, orderData.dados_originais_ws,
        orderData.conta_id, orderData.renew_sl_firs, orderData.renew_sl_seco, orderData.commission,
        orderData.commission_asset, orderData.trade_id
      ];

      const [result] = await connection.query(insertQuery, insertValues);
      const orderInsertId = result.insertId;
      
      console.log(`[ORDER] Nova ordem ${orderId} inserida no banco com ID ${orderInsertId}${positionId ? ` (vinculada à posição ${positionId})` : ' (sem posição vinculada)'}`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar nova ordem ${orderId}:`, error.message);
  }
}

/**
 * Trata execução de trade
 */
async function handleTradeExecution(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  const symbol = order.s;
  const executedQty = parseFloat(order.z || '0');
  const avgPrice = parseFloat(order.ap || '0');
  const lastFilledQty = parseFloat(order.l || '0');
  const lastFilledPrice = parseFloat(order.L || '0');
  const commission = parseFloat(order.n || '0');
  const commissionAsset = order.N || null;
  const tradeId = order.t || null;
  
  try {
    // ATUALIZAR ORDEM NO BANCO
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = ?, 
         quantidade_executada = ?,
         preco_executado = ?,
         commission = ?,
         commission_asset = ?,
         trade_id = ?,
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [
          order.X, // status
          executedQty,
          avgPrice,
          commission,
          commissionAsset,
          tradeId,
          JSON.stringify(order),
          orderId,
          accountId
        ]
      );
      
      console.log(`[ORDER] ✅ Ordem ${orderId} atualizada: ${order.X}, Executado: ${executedQty} @ ${avgPrice}`);
      
      // ✅ NOVA VERIFICAÇÃO: Se ordem foi totalmente executada, verificar fechamento
      if (order.X === 'FILLED') {
        console.log(`[ORDER] 🎯 Ordem ${orderId} totalmente executada, verificando fechamento de posição...`);
        
        // Executar verificação em background para não bloquear
        setTimeout(async () => {
          try {
            await checkPositionClosureAfterOrderExecution(orderId, accountId);
          } catch (checkError) {
            console.error(`[ORDER] ⚠️ Erro na verificação de fechamento:`, checkError.message);
          }
        }, 2000); // Aguardar 2 segundos para garantir que tudo foi processado
      }
      
      // ✅ NOTIFICAÇÃO TELEGRAM PARA ORDENS IMPORTANTES
      if (order.X === 'FILLED' && existingOrder) {
        try {
          // Verificar se é ordem importante (SL, TP, ou entrada grande)
          const orderType = existingOrder.tipo_ordem_bot;
          const shouldNotify = orderType === 'STOP_LOSS' || 
                             orderType === 'TAKE_PROFIT' || 
                             orderType === 'REDUCAO_PARCIAL' ||
                             (orderType === 'ENTRADA' && executedQty * avgPrice > 100); // Entradas > $100
          
          if (shouldNotify) {
            const message = formatOrderMessage(
              symbol, 
              order.S, 
              orderType, 
              executedQty.toFixed(6), 
              avgPrice.toFixed(4), 
              'FILLED'
            );
            
            await sendTelegramMessage(accountId, message);
            console.log(`[ORDER] 📱 Notificação de ordem ${orderType} enviada`);
          }
        } catch (telegramError) {
          console.warn(`[ORDER] ⚠️ Erro ao enviar notificação de ordem:`, telegramError.message);
        }
      }

    } else {
      console.warn(`[ORDER] ⚠️ Ordem ${orderId} não encontrada no banco para atualização`);
    }
    
  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao processar execução da ordem ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Trata cancelamento de ordem
 */
async function handleOrderCancellation(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = 'CANCELED',
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} cancelada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar cancelamento ${orderId}:`, error.message);
  }
}

/**
 * Trata expiração de ordem
 */
async function handleOrderExpiry(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = 'EXPIRED',
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} expirada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar expiração ${orderId}:`, error.message);
  }
}

/**
 * Trata modificação de ordem
 */
async function handleOrderAmendment(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         preco = ?,
         quantidade = ?,
         status = ?,
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [parseFloat(order.p || '0'), parseFloat(order.q || '0'), order.X, JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} modificada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar modificação ${orderId}:`, error.message);
  }
}

/**
 * Cria ou atualiza posição baseada na ordem executada
 */
async function handlePositionFromOrder(connection, order, accountId) {
  const symbol = order.s;
  const side = order.S;
  const executedQty = parseFloat(order.z || '0');
  const avgPrice = parseFloat(order.ap || '0');
  const orderId = String(order.i);
  
  try {
    // BUSCAR POSIÇÃO EXISTENTE
    const [existingPositions] = await connection.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
      [symbol, 'OPEN', accountId]
    );

    let positionId = null;

    if (existingPositions.length > 0) {
      // ATUALIZAR POSIÇÃO EXISTENTE
      const existingPos = existingPositions[0];
      positionId = existingPos.id;
      
      const currentQty = parseFloat(existingPos.quantidade || '0');
      const currentPrice = parseFloat(existingPos.preco_medio || '0');
      
      let newQty, newAvgPrice;
      
      if (existingPos.side === side) {
        // MESMA DIREÇÃO - SOMAR QUANTIDADE E RECALCULAR PREÇO MÉDIO
        newQty = currentQty + executedQty;
        newAvgPrice = ((currentQty * currentPrice) + (executedQty * avgPrice)) / newQty;
      } else {
        // DIREÇÃO OPOSTA - REDUZIR QUANTIDADE
        newQty = Math.abs(currentQty - executedQty);
        newAvgPrice = newQty > 0 ? currentPrice : avgPrice;
      }
      
      if (newQty <= 0.000001) {
        // POSIÇÃO FECHADA
        await connection.query(
          `UPDATE posicoes SET 
           status = 'CLOSED',
           quantidade = 0,
           data_hora_fechamento = NOW(),
           data_hora_ultima_atualizacao = NOW()
           WHERE id = ?`,
          [existingPos.id]
        );
        
        console.log(`[ORDER] Posição ${symbol} fechada via ordem ${orderId}`);
        positionId = null;
      } else {
        // POSIÇÃO ATUALIZADA
        await connection.query(
          `UPDATE posicoes SET 
           quantidade = ?,
           preco_medio = ?,
           preco_entrada = ?,
           preco_corrente = ?,
           side = ?,
           data_hora_ultima_atualizacao = NOW()
           WHERE id = ?`,
          [newQty, newAvgPrice, newAvgPrice, avgPrice, side, existingPos.id]
        );
        
        console.log(`[ORDER] Posição ${symbol} atualizada: ${newQty} @ ${newAvgPrice.toFixed(6)}`);
      }
    } else {
      // CRIAR NOVA POSIÇÃO
      const positionData = {
        simbolo: symbol,
        quantidade: executedQty,
        preco_medio: avgPrice,
        status: 'OPEN',
        data_hora_abertura: formatDateForMySQL(new Date()),
        side: side,
        leverage: 1,
        data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
        preco_entrada: avgPrice,
        preco_corrente: avgPrice,
        orign_sig: extractOriginSignal(order.c),
        quantidade_aberta: executedQty,
        conta_id: accountId
      };
      
      positionId = await insertPosition(connection, positionData);
      console.log(`[ORDER] Nova posição ${symbol} criada: ID ${positionId}`);
    }

    // ✅ VINCULAR A ORDEM À POSIÇÃO APÓS CRIAÇÃO/ATUALIZAÇÃO
    if (positionId) {
      await connection.query(
        `UPDATE ordens SET 
         id_posicao = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ? AND id_posicao IS NULL`,
        [positionId, orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} vinculada à posição ${positionId}`);
    }

  } catch (error) {
    console.error(`[ORDER] Erro ao tratar posição para ordem ${orderId}:`, error.message);
  }
}

/**
 * ✅ NOVA FUNÇÃO: Mover ordem automaticamente quando FILLED ou CANCELLED
 */
async function autoMoveOrderOnCompletion(orderId, newStatus, accountId, retryCount = 0) {
  if (!['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(newStatus)) {
    return false;
  }

  let connection;
  try {
    const db = await getDatabaseInstance();
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Buscar a ordem completa da tabela ativa
    const [orderResult] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );

    if (orderResult.length === 0) {
      console.warn(`[ORDER_AUTO_MOVE] ⚠️ Ordem ${orderId} não encontrada no banco para mover.`);
      await connection.rollback();
      return false;
    }
    
    const orderToMove = orderResult[0];

    // 2. Preparar dados para inserção na tabela de histórico
    const closedOrderData = {
      ...orderToMove, // Copia todos os campos da ordem original
      id_original: orderToMove.id,
      id_original_ordens: orderToMove.id,
      status: newStatus,
      last_update: new Date(),
      observacao: `${orderToMove.observacao || ''} | Movida para histórico: ${newStatus}`.trim(),
    };
    delete closedOrderData.id;

    // 3. Obter colunas da tabela de destino
    const [destColumnsResult] = await connection.query('SHOW COLUMNS FROM ordens_fechadas');
    const destColumns = destColumnsResult.map(col => col.Field);

    // 4. Filtrar dados para inserir apenas colunas existentes
    const finalDataToInsert = {};
    for (const key in closedOrderData) {
      if (destColumns.includes(key)) {
        finalDataToInsert[key] = closedOrderData[key];
      }
    }

    // 5. Inserir na tabela de histórico
    const columns = Object.keys(finalDataToInsert);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(finalDataToInsert);

    // Atualizar posição relacionada, se houver
    if (orderToMove.id_posicao) {
      const [positions] = await connection.query(
        'SELECT total_commission, total_realized FROM posicoes WHERE id = ? AND conta_id = ?',
        [orderToMove.id_posicao, accountId]
      );
      if (positions.length > 0) {
        const pos = positions[0];
        const newTotalCommission = (parseFloat(pos.total_commission) || 0) + (parseFloat(orderToMove.commission) || 0);
        const newTotalRealized = (parseFloat(pos.total_realized) || 0) + (parseFloat(orderToMove.realized_profit) || 0);
        let newLiquidPnl;
        if (newTotalCommission < 0) {
          newLiquidPnl = newTotalRealized + newTotalCommission;
        } else {
          newLiquidPnl = newTotalRealized - newTotalCommission;
        }
        await connection.query(
          'UPDATE posicoes SET total_commission = ?, total_realized = ?, liquid_pnl = ? WHERE id = ? AND conta_id = ?',
          [newTotalCommission, newTotalRealized, newLiquidPnl, orderToMove.id_posicao, accountId]
        );
        console.log(`[ORDER_AUTO_MOVE] Posição ${orderToMove.id_posicao} atualizada: total_commission=${newTotalCommission}, total_realized=${newTotalRealized}, liquid_pnl=${newLiquidPnl}`);
      }
    }    

    await connection.query(
      `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
      values
    );

    // 6. Remover da tabela ativa
    await connection.query('DELETE FROM ordens WHERE id = ?', [orderToMove.id]);

    await connection.commit();
    console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} movida para ordens_fechadas.`);
    return true;

  } catch (error) {
    if (connection) await connection.rollback();

    // Retry em caso de deadlock
    if (
      error.message &&
      error.message.includes('Deadlock found when trying to get lock') &&
      retryCount < 3
    ) {
      console.warn(`[ORDER_AUTO_MOVE] ⚠️ Deadlock ao mover ordem ${orderId}. Tentando novamente (${retryCount + 1}/3)...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
      return autoMoveOrderOnCompletion(orderId, newStatus, accountId, retryCount + 1);
    }

    console.error(`[ORDER_AUTO_MOVE] ❌ Erro ao mover ordem ${orderId}:`, error.message);
    return false;
  } finally {
    if (connection) connection.release();
  }
}


/**
 * ✅ FUNÇÃO CORRIGIDA: Processa atualizações de ordens via WebSocket
 * Suporta MÚLTIPLOS formatos de entrada
 */
async function handleOrderUpdate(messageOrAccountId, orderDataOrDb = null, db = null) {
  try {
    let accountId, orderUpdateData, connection;
    
    // ✅ DETECTAR FORMATO DA CHAMADA
    if (typeof messageOrAccountId === 'number') {
      // FORMATO NOVO: handleOrderUpdate(accountId, orderUpdateData)
      accountId = messageOrAccountId;
      orderUpdateData = orderDataOrDb;
      connection = db;
    } else {
      // FORMATO ANTIGO: handleOrderUpdate(orderMsg, accountId, db)
      const orderMsg = messageOrAccountId;
      accountId = orderDataOrDb;
      connection = db;
      
      // ✅ VALIDAÇÃO DO FORMATO ANTIGO - CORREÇÃO AQUI
      if (!orderMsg) {
        console.error(`[ORDER] Mensagem de ordem inválida para conta ${accountId}`);
        return;
      }
      
      // ✅ EXTRAIR DADOS CORRETAMENTE BASEADO NO FORMATO BINANCE
      if (orderMsg.e === 'ORDER_TRADE_UPDATE' && orderMsg.o) {
        // Formato padrão da Binance: { e: 'ORDER_TRADE_UPDATE', o: { ... } }
        orderUpdateData = orderMsg.o;
      } else if (orderMsg.i && orderMsg.s) {
        // Formato direto: { i: orderId, s: symbol, ... }
        orderUpdateData = orderMsg;
      } else {
        console.error(`[ORDER] Formato de mensagem não reconhecido para conta ${accountId}:`, {
          hasE: orderMsg.e,
          hasO: !!orderMsg.o,
          hasI: !!orderMsg.i,
          hasS: !!orderMsg.s
        });
        return;
      }
    }

    // ✅ VALIDAÇÃO UNIFICADA
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ORDER] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    // ✅ PROCESSAR DADOS DA ORDEM - AGORA orderUpdateData JÁ ESTÁ CORRETO
    const orderData = orderUpdateData;
    
    const orderId = orderData.i?.toString();
    const symbol = orderData.s;
    const orderStatus = orderData.X;
    const executionType = orderData.x;
    
    if (!orderId || !symbol || !orderStatus) {
      console.warn(`[ORDER] ⚠️ Dados incompletos: orderId=${orderId}, symbol=${symbol}, status=${orderStatus}`);
      console.warn(`[ORDER] ⚠️ Dados recebidos:`, JSON.stringify(orderData, null, 2));
      return;
    }

    console.log(`[ORDER] 📨 Processando atualização: ${orderId} (${symbol}) - ${executionType}/${orderStatus}`);

    // ✅ OBTER CONEXÃO COM BANCO
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
      if (!connection) {
        console.error(`[ORDER] Não foi possível obter conexão com banco para conta ${accountId}`);
        return;
      }
    }

    // ✅ 1. VERIFICAR SE ORDEM EXISTE NO BANCO
    const [existingOrders] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderId, symbol, accountId]
    );

    const orderExists = existingOrders.length > 0;
    let shouldInsert = false;

    if (!orderExists) {
      console.log(`[ORDER] 🆕 Ordem externa detectada: ${orderId} - inserindo no banco...`);
      shouldInsert = true;
    }

    // ✅ 2. INSERIR ORDEM SE NÃO EXISTE (ORDEM EXTERNA)
    if (shouldInsert) {
      await insertExternalOrder(connection, orderData, accountId);
    }

    // ✅ 3. ATUALIZAR ORDEM EXISTENTE
    if (orderExists) {
      await updateExistingOrder(connection, orderData, accountId, existingOrders[0]);
    }

    // ✅ 4. VERIFICAR SE DEVE MOVER PARA HISTÓRICO
    const finalStatuses = ['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'];
    
    if (finalStatuses.includes(orderStatus)) {
      console.log(`[ORDER] 🎯 Status final detectado (${orderStatus}) - iniciando movimento automático...`);
      
      // Aguardar um pouco para garantir que a atualização foi processada
      await new Promise(resolve => setTimeout(resolve, 500));
      
      const moved = await autoMoveOrderOnCompletion(orderId, orderStatus, accountId);
      
      if (moved) {
        console.log(`[ORDER] ✅ Ordem ${orderId} (${orderStatus}) movida automaticamente para histórico`);
        
        // Verificar fechamento de posição para ordens FILLED
        if (orderStatus === 'FILLED') {
          try {
            const closureResult = await checkPositionClosureAfterOrderExecution(orderId, accountId);
            if (closureResult) {
              console.log(`[ORDER] 🏁 Posição fechada automaticamente após execução da ordem ${orderId}`);
            }
          } catch (closureError) {
            console.error(`[ORDER] ⚠️ Erro ao verificar fechamento de posição:`, closureError.message);
          }
        }
      } else {
        console.warn(`[ORDER] ⚠️ Falha ao mover ordem ${orderId} automaticamente`);
      }
    }

    // ✅ 5. LOGS DETALHADOS
    if (orderStatus === 'FILLED') {
      const executedQty = parseFloat(orderData.z || 0);
      const avgPrice = parseFloat(orderData.ap || 0);
      const totalValue = executedQty * avgPrice;
      
      console.log(`[ORDER] 💰 Ordem FILLED processada:`);
      console.log(`[ORDER]   - ID: ${orderId}`);
      console.log(`[ORDER]   - Símbolo: ${symbol}`);
      console.log(`[ORDER]   - Quantidade: ${executedQty}`);
      console.log(`[ORDER]   - Preço médio: ${avgPrice}`);
      console.log(`[ORDER]   - Valor total: ${totalValue.toFixed(2)} USDT`);
    } else if (orderStatus === 'NEW') {
      console.log(`[ORDER] ✅ Nova ordem registrada:`);
      console.log(`[ORDER]   - ID: ${orderId}`);
      console.log(`[ORDER]   - Símbolo: ${symbol}`);
      console.log(`[ORDER]   - Tipo: ${orderData.o} (${orderData.R ? 'REDUCE_ONLY' : 'NORMAL'})`);
      console.log(`[ORDER]   - Side: ${orderData.S}`);
      console.log(`[ORDER]   - Quantidade: ${orderData.q}`);
      console.log(`[ORDER]   - Preço: ${orderData.p}`);
    }

  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao processar atualização da ordem:`, error.message);
    console.error(`[ORDER] Stack trace:`, error.stack);
  }
}

/**
 * ✅ FUNÇÃO MELHORADA: Inserir ordem externa com TODOS os campos do webhook
 */
async function insertExternalOrder(dbConnection, orderData, accountId) {
  try {
    console.log(`[ORDER] 📝 Inserindo ordem externa COMPLETA: ${orderData.i} (${orderData.s})`);
    
    let connection = dbConnection;
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
    }
    
    // ✅ BUSCAR POSIÇÃO RELACIONADA
    let positionId = null;
    if (orderData.R === true || orderData.cp === true) {
      const [existingPositions] = await connection.query(
        'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
        [orderData.s, 'OPEN', accountId]
      );
      
      if (existingPositions.length > 0) {
        positionId = existingPositions[0].id;
        console.log(`[ORDER] 🔗 Ordem externa vinculada à posição ${positionId}`);
      }
    }
    
    // Determinar tipo de ordem bot
    const orderBotType = determineOrderBotTypeFromExternal(orderData);

    // === NOVO BLOCO: Definir target apenas para RPs e TP final ===
    let target = null;
    let orignSig = 'EXTERNAL_ORDER';
    if (orderData.c && orderData.c.startsWith('WEBHOOK_')) {
      orignSig = orderData.c;
    } else if (orderData.orign_sig) {
      orignSig = orderData.orign_sig;
    }

    // Inicializar cache se necessário
    if (!targetCache.has(orignSig)) {
      targetCache.set(orignSig, { rp: 1, tp: 5 });
    }
    const cache = targetCache.get(orignSig);

    if (orderBotType === 'REDUCAO_PARCIAL') {
      target = cache.rp;
      cache.rp += 1;
    } else if (orderBotType === 'TAKE_PROFIT') {
      target = cache.tp;
    }
    // Limpar cache se for TP final (última ordem do ciclo)
    if (orderBotType === 'TAKE_PROFIT') {
      targetCache.delete(orignSig);
    }

    // ✅ MAPEAMENTO COMPLETO DOS CAMPOS
    const orderInsertData = {
      // Campos básicos existentes
      tipo_ordem: mapOrderType(orderData.o),
      preco: parseFloat(orderData.p || '0'),
      quantidade: parseFloat(orderData.q || '0'),
      id_posicao: positionId,
      status: orderData.X,
      data_hora_criacao: formatDateForMySQL(new Date(orderData.T || Date.now())),
      id_externo: orderData.i.toString(),
      side: orderData.S,
      simbolo: orderData.s,
      tipo_ordem_bot: orderBotType,
      target: target, // <-- Aqui entra o target correto
      reduce_only: orderData.R === true ? 1 : 0,
      close_position: orderData.cp === true ? 1 : 0,
      last_update: formatDateForMySQL(new Date()),
      orign_sig: 'EXTERNAL_ORDER',
      observacao: `Ordem externa: ${orderData.c || 'N/A'}`,
      preco_executado: parseFloat(orderData.ap || '0'),
      quantidade_executada: parseFloat(orderData.z || '0'),
      dados_originais_ws: JSON.stringify(orderData),
      conta_id: accountId,
      commission: parseFloat(orderData.n || '0'),
      commission_asset: orderData.N || 'USDT',
      trade_id: orderData.t || null,
      
      // ✅ NOVOS CAMPOS DO WEBHOOK (se as colunas existirem)
      client_order_id: orderData.c || null,
      time_in_force: orderData.f || null,
      stop_price: parseFloat(orderData.sp || '0') || null,
      execution_type: orderData.x || null,
      last_filled_quantity: parseFloat(orderData.l || '0') || null,
      last_filled_price: parseFloat(orderData.L || '0') || null,
      order_trade_time: orderData.T || null,
      bids_notional: parseFloat(orderData.b || '0') || null,
      ask_notional: parseFloat(orderData.a || '0') || null,
      is_maker_side: orderData.m === true ? 1 : 0,
      stop_price_working_type: orderData.wt || null,
      original_order_type: orderData.ot || null,
      position_side: orderData.ps || null,
      activation_price: parseFloat(orderData.AP || '0') || null,
      callback_rate: parseFloat(orderData.cr || '0') || null,
      price_protection: orderData.pP === true ? 1 : 0,
      realized_profit: parseFloat(orderData.rp || '0') || null,
      stp_mode: orderData.V || null,
      price_match_mode: orderData.pm || null,
      gtd_auto_cancel_time: orderData.gtd || null
    };

    // ✅ VERIFICAR QUAIS COLUNAS EXISTEM NA TABELA
    const [columns] = await connection.query(`SHOW COLUMNS FROM ordens`);
    const existingColumns = columns.map(col => col.Field);
    
    // ✅ FILTRAR APENAS CAMPOS QUE EXISTEM NA TABELA
    const validData = {};
    Object.keys(orderInsertData).forEach(key => {
      if (existingColumns.includes(key) && orderInsertData[key] !== undefined) {
        validData[key] = orderInsertData[key];
      }
    });

    // ✅ CONSTRUIR QUERY DINÂMICA
    const columnNames = Object.keys(validData);
    const values = Object.values(validData);
    const placeholders = columnNames.map(() => '?').join(', ');
    
    const insertQuery = `
      INSERT INTO ordens (${columnNames.join(', ')}) 
      VALUES (${placeholders})
    `;

    const [result] = await connection.query(insertQuery, values);
    const orderDbId = result.insertId;
    
    console.log(`[ORDER] ✅ Ordem externa COMPLETA ${orderData.i} inserida:`);
    console.log(`[ORDER]   - ID Banco: ${orderDbId}`);
    console.log(`[ORDER]   - Client Order ID: ${orderData.c || 'N/A'}`);
    console.log(`[ORDER]   - Execution Type: ${orderData.x}`);
    console.log(`[ORDER]   - Time in Force: ${orderData.f}`);
    console.log(`[ORDER]   - Stop Price: ${orderData.sp || 'N/A'}`);
    console.log(`[ORDER]   - Position Side: ${orderData.ps || 'N/A'}`);
    console.log(`[ORDER]   - Campos salvos: ${columnNames.length}/${Object.keys(orderInsertData).length}`);
    
    return orderDbId;
    
  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao inserir ordem externa COMPLETA:`, error.message);
    throw error;
  }
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Atualizar ordem existente com retry em caso de deadlock
 */
async function updateExistingOrder(dbConnection, orderData, accountId, existingOrder, retryCount = 0) {
  try {
    const orderId = orderData.i.toString();
    let connection = dbConnection;
    if (!connection) {
      const db = await getDatabaseInstance();
      connection = await db.getConnection();
    }
    // Buscar valores atuais do banco
    const [currentRows] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );
    const current = currentRows[0] || {};
    // Para cada campo, só sobrescrever se o novo valor não for null/undefined
    const realized_profit = orderData.rp !== null && orderData.rp !== undefined ? parseFloat(orderData.rp) : current.realized_profit;
    const commission = orderData.n !== null && orderData.n !== undefined ? parseFloat(orderData.n) : current.commission;
    const commission_asset = orderData.N !== null && orderData.N !== undefined ? orderData.N : current.commission_asset;
    const trade_id = orderData.t !== null && orderData.t !== undefined ? orderData.t : current.trade_id;
    const quantidade_executada = orderData.z !== null && orderData.z !== undefined ? parseFloat(orderData.z) : current.quantidade_executada;
    const preco_executado = orderData.ap !== null && orderData.ap !== undefined ? parseFloat(orderData.ap) : current.preco_executado;
    // Outros campos podem ser tratados da mesma forma se necessário
    await connection.query(`
      UPDATE ordens 
      SET status = ?, 
          quantidade_executada = ?,
          preco_executado = ?,
          commission = ?,
          commission_asset = ?,
          trade_id = ?,
          realized_profit = ?,
          dados_originais_ws = ?,
          last_update = NOW()
      WHERE id_externo = ? AND conta_id = ?
    `, [
      orderData.X,      quantidade_executada,      preco_executado,      commission,      commission_asset,      trade_id,      realized_profit,      JSON.stringify(orderData),      orderId,
      accountId
    ]);
    console.log(`[ORDER] ✅ Ordem ${orderId} atualizada: ${orderData.X}`);

    // === NOVO BLOCO: Verificação e cálculo de comissão/profit ===
    // Buscar ordem atualizada do banco
    const [updatedRows] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );
    const updatedOrder = updatedRows[0];
    if (!updatedOrder) return;

    // Identificar tipo de ordem bot
    const tipoOrdemBot = updatedOrder.tipo_ordem_bot;
    const isAbertura = tipoOrdemBot === 'ENTRADA' || tipoOrdemBot === 'ENTRADA_MARKET';
    const isFechamento = [
      'REDUCAO_PARCIAL',
      'STOP_LOSS',
      'FECHAMENTO_MANUAL',
      'TAKE_PROFIT',
      'TAKE_PROFIT_MARKET'
    ].includes(tipoOrdemBot);

    // Identificar maker/taker
    let isMaker = false;
    if (updatedOrder.hasOwnProperty('is_maker_side')) {
      isMaker = !!updatedOrder.is_maker_side;
    } else if (updatedOrder.dados_originais_ws) {
      try {
        const ws = JSON.parse(updatedOrder.dados_originais_ws);
        if (ws.hasOwnProperty('m')) isMaker = !!ws.m;
      } catch {}
    }
    const taxa = isMaker ? 0.0002 : 0.0005;

    // Cálculo de comissão
    let precisaUpdate = false;
    let novaComissao = updatedOrder.commission;
    let novoProfit = updatedOrder.realized_profit;
    const quantidadeExecutada = parseFloat(updatedOrder.quantidade_executada || 0);
    const precoExecutado = parseFloat(updatedOrder.preco_executado || 0);

    // Ordem de abertura: só comissão
    if (isAbertura && (!novaComissao || novaComissao === 0)) {
      novaComissao = quantidadeExecutada * precoExecutado * taxa;
      precisaUpdate = true;
      console.log(`[ORDER] 🧮 Comissão estimada (abertura): ${novaComissao}`);
    }
    // Ordem de fechamento: comissão e profit
    if (isFechamento && ((!novaComissao || novaComissao === 0) || (!novoProfit && novoProfit !== 0))) {
      if (!novaComissao || novaComissao === 0) {
        novaComissao = quantidadeExecutada * precoExecutado * taxa;
        precisaUpdate = true;
        console.log(`[ORDER] 🧮 Comissão estimada (fechamento): ${novaComissao}`);
      }
      if (novoProfit === null || novoProfit === undefined) {
        // Estimar profit realizado: diferença entre preço de entrada e saída * quantidade
        // Busca preço de entrada da posição
        let precoEntrada = null;
        if (updatedOrder.id_posicao) {
          const [posRows] = await connection.query('SELECT preco FROM posicoes WHERE id = ?', [updatedOrder.id_posicao]);
          if (posRows.length > 0) precoEntrada = parseFloat(posRows[0].preco || 0);
        }
        if (precoEntrada !== null) {
          if (updatedOrder.side === 'SELL') {
            novoProfit = (precoExecutado - precoEntrada) * quantidadeExecutada;
          } else {
            novoProfit = (precoEntrada - precoExecutado) * quantidadeExecutada;
          }
          precisaUpdate = true;
          console.log(`[ORDER] 🧮 Profit estimado: ${novoProfit}`);
        }
      }
    }
    // Atualizar ordem se necessário
    if (precisaUpdate) {
      await connection.query(
        `UPDATE ordens SET commission = ?, realized_profit = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?`,
        [novaComissao, novoProfit, orderId, accountId]
      );
      console.log(`[ORDER] ✅ Ordem ${orderId} atualizada com comissão/profit estimados.`);
    }
    // Atualizar posição relacionada
    if (updatedOrder.id_posicao && (precisaUpdate || isFechamento)) {
      // Buscar totais atuais
      const [posRows] = await connection.query('SELECT total_commission, total_realized FROM posicoes WHERE id = ?', [updatedOrder.id_posicao]);
      if (posRows.length > 0) {
        const totalCommission = parseFloat(posRows[0].total_commission || 0) + (novaComissao || 0);
        const totalRealized = parseFloat(posRows[0].total_realized || 0) + (novoProfit || 0);
        await connection.query(
          `UPDATE posicoes SET total_commission = ?, total_realized = ?, last_update = NOW() WHERE id = ?`,
          [totalCommission, totalRealized, updatedOrder.id_posicao]
        );
        console.log(`[ORDER] ✅ Posição ${updatedOrder.id_posicao} atualizada com totais de comissão/profit.`);
      }
    }
  } catch (error) {
    // Retry em caso de deadlock
    if (
      error.message &&
      error.message.includes('Deadlock found when trying to get lock') &&
      retryCount < 3
    ) {
      console.warn(`[ORDER] ⚠️ Deadlock ao atualizar ordem ${orderData.i}. Tentando novamente (${retryCount + 1}/3)...`);
      await new Promise(resolve => setTimeout(resolve, 500 * (retryCount + 1)));
      return updateExistingOrder(dbConnection, orderData, accountId, existingOrder, retryCount + 1);
    }
    console.error(`[ORDER] ❌ Erro ao atualizar ordem ${orderData.i}:`, error.message);
    throw error;
  }
}

/**
 * ✅ FUNÇÃO MELHORADA: Determinar tipo de ordem bot para ordens externas
 */
function determineOrderBotTypeFromExternal(orderData) {
  const orderType = orderData.o; // LIMIT, MARKET, STOP_MARKET, etc.
  const reduceOnly = orderData.R === true;
  const closePosition = orderData.cp === true;
  const clientOrderId = orderData.c || '';
  
  // ✅ DETECTAR TIPOS ESPECIAIS PELO CLIENT ORDER ID
  if (clientOrderId.startsWith('autoclose-')) {
    return 'LIQUIDATION';
  }
  
  if (clientOrderId === 'adl_autoclose') {
    return 'ADL';
  }
  
  if (clientOrderId.startsWith('settlement_autoclose-')) {
    return 'SETTLEMENT';
  }
  
  // ✅ DETECTAR BASEADO NO TIPO DE ORDEM E CARACTERÍSTICAS
  if (orderType === 'STOP_MARKET' && (closePosition || reduceOnly)) {
    return 'STOP_LOSS';
  }
  
  if (orderType === 'TAKE_PROFIT_MARKET' && (closePosition || reduceOnly)) {
    return 'TAKE_PROFIT';
  }
  
  if (orderType === 'TRAILING_STOP_MARKET') {
    return 'TRAILING_STOP';
  }
  
  if (orderType === 'LIMIT' && reduceOnly) {
    return 'REDUCAO_PARCIAL';
  }
  
  if (orderType === 'LIMIT' && !reduceOnly && !closePosition) {
    return 'ENTRADA';
  }
  
  if (orderType === 'MARKET' && !reduceOnly && !closePosition) {
    return 'ENTRADA_MARKET';
  }
  
  if (orderType === 'MARKET' && (reduceOnly || closePosition)) {
    return 'FECHAMENTO_MANUAL';
  }
  
  // ✅ DETECTAR PELO CLIENT ORDER ID SE FOR DO PRÓPRIO BOT
  if (clientOrderId.includes('web_') || clientOrderId.includes('gui_')) {
    return 'MANUAL_WEB';
  }
  
  return 'EXTERNA';
}

/**
 * ✅ NOVA FUNÇÃO: Verificar se deve notificar ordem externa
 */
function shouldNotifyExternalOrder(orderBotType, orderData) {
  const importantTypes = ['STOP_LOSS', 'TAKE_PROFIT', 'ENTRADA'];
  const largeValue = parseFloat(orderData.q || 0) * parseFloat(orderData.p || 0) > 50; // > $50
  
  return importantTypes.includes(orderBotType) || largeValue;
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Registrar handlers de ordem
 */
function registerOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Registrando handlers de ordem para conta ${accountId}...`);
    
    // OBTER callbacks existentes
    const existingCallbacks = websockets.getHandlers(accountId) || {};
    
    // ✅ CRIAR HANDLER ROBUSTO QUE ACEITA MÚLTIPLOS FORMATOS
    const robustOrderHandler = async (messageOrOrder, db) => {
      try {
        console.log(`[ORDER-HANDLERS] 📨 Mensagem recebida para conta ${accountId}:`, {
          type: typeof messageOrOrder,
          hasE: messageOrOrder?.e,
          hasO: messageOrOrder?.o,
          hasI: messageOrOrder?.i,
          hasS: messageOrOrder?.s
        });
        
        // ✅ CHAMAR FUNÇÃO UNIFICADA
        await handleOrderUpdate(messageOrOrder, accountId, db);
        
      } catch (handlerError) {
        console.error(`[ORDER-HANDLERS] ❌ Erro no handler robusto para conta ${accountId}:`, handlerError.message);
      }
    };
    
    // ✅ REGISTRAR HANDLER ROBUSTO
    const orderCallbacks = {
      ...existingCallbacks,
      handleOrderUpdate: robustOrderHandler
    };
    
    websockets.setMonitoringCallbacks(orderCallbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handler robusto registrado para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] ❌ Erro ao registrar handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * ✅ FUNÇÃO NOVA: Verificar se posição deve ser fechada após execução de ordem
 */
async function checkPositionClosureAfterOrderExecution(orderId, accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar ordem executada
    const [executedOrder] = await db.query(`
      SELECT o.*, p.simbolo as position_symbol, p.id as position_id, p.quantidade as position_qty
      FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.id_externo = ? AND o.conta_id = ? AND o.status = 'FILLED'
    `, [orderId, accountId]);
    
    if (executedOrder.length === 0) {
      return false;
    }
    
    const order = executedOrder[0];
    
    // Verificar se é ordem que fecha posição (TP ou SL)
    if (order.tipo_ordem_bot === 'TAKE_PROFIT' || 
        order.tipo_ordem_bot === 'STOP_LOSS' ||
        order.close_position === 1) {
      
      console.log(`[ORDER_CLOSURE] 🎯 Ordem de fechamento executada: ${order.tipo_ordem_bot} para ${order.position_symbol}`);
      
      // Verificar se posição ainda existe na corretora
      const exchangePositions = await api.getAllOpenPositions(accountId);
      const exchangePos = exchangePositions.find(p => p.simbolo === order.position_symbol);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        console.log(`[ORDER_CLOSURE] ✅ Posição ${order.position_symbol} confirmada como fechada na corretora`);
        
        // Mover posição para histórico (com cancelamento automático de ordens)
        const { movePositionToHistoryPhysically } = require('../monitoring/enhancedMonitoring');
        const moved = await movePositionToHistoryPhysically(
          db,
          order.position_id,
          'CLOSED',
          `Fechada por ${order.tipo_ordem_bot} - Ordem ${orderId}`,
          accountId
        );
        
        if (moved) {
          console.log(`[ORDER_CLOSURE] ✅ Posição ${order.position_symbol} movida para histórico com sucesso`);
          return true;
        }
      }
    }
    
    return false;
    
  } catch (error) {
    console.error(`[ORDER_CLOSURE] ❌ Erro ao verificar fechamento de posição:`, error.message);
    return false;
  }
}

// ✅ MELHORAR handleTradeExecution para chamar a verificação
async function handleTradeExecution(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  const symbol = order.s;
  const executedQty = parseFloat(order.z || '0');
  const avgPrice = parseFloat(order.ap || '0');
  const lastFilledQty = parseFloat(order.l || '0');
  const lastFilledPrice = parseFloat(order.L || '0');
  const commission = parseFloat(order.n || '0');
  const commissionAsset = order.N || null;
  const tradeId = order.t || null;
  
  try {
    // ATUALIZAR ORDEM NO BANCO (código existente)
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = ?, 
         quantidade_executada = ?,
         preco_executado = ?,
         commission = ?,
         commission_asset = ?,
         trade_id = ?,
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [
          order.X, // status
          executedQty,
          avgPrice,
          commission,
          commissionAsset,
          tradeId,
          JSON.stringify(order),
          orderId,
          accountId
        ]
      );
      
      console.log(`[ORDER] ✅ Ordem ${orderId} atualizada: ${order.X}, Executado: ${executedQty} @ ${avgPrice}`);
      
      // ✅ NOVA VERIFICAÇÃO: Se ordem foi totalmente executada, verificar fechamento
      if (order.X === 'FILLED') {
        console.log(`[ORDER] 🎯 Ordem ${orderId} totalmente executada, verificando fechamento de posição...`);
        
        // Executar verificação em background para não bloquear
        setTimeout(async () => {
          try {
            await checkPositionClosureAfterOrderExecution(orderId, accountId);
          } catch (checkError) {
            console.error(`[ORDER] ⚠️ Erro na verificação de fechamento:`, checkError.message);
          }
        }, 2000); // Aguardar 2 segundos para garantir que tudo foi processado
      }
      
      // ✅ NOTIFICAÇÃO TELEGRAM PARA ORDENS IMPORTANTES
      if (order.X === 'FILLED' && existingOrder) {
        try {
          // Verificar se é ordem importante (SL, TP, ou entrada grande)
          const orderType = existingOrder.tipo_ordem_bot;
          const shouldNotify = orderType === 'STOP_LOSS' || 
                             orderType === 'TAKE_PROFIT' || 
                             orderType === 'REDUCAO_PARCIAL' ||
                             (orderType === 'ENTRADA' && executedQty * avgPrice > 100); // Entradas > $100
          
          if (shouldNotify) {
            const message = formatOrderMessage(
              symbol, 
              order.S, 
              orderType, 
              executedQty.toFixed(6), 
              avgPrice.toFixed(4), 
              'FILLED'
            );
            
            await sendTelegramMessage(accountId, message);
            console.log(`[ORDER] 📱 Notificação de ordem ${orderType} enviada`);
          }
        } catch (telegramError) {
          console.warn(`[ORDER] ⚠️ Erro ao enviar notificação de ordem:`, telegramError.message);
        }
      }

    } else {
      console.warn(`[ORDER] ⚠️ Ordem ${orderId} não encontrada no banco para atualização`);
    }
    
  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao processar execução da ordem ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Mapeia tipo de ordem da Binance para formato do banco
 */
function mapOrderType(binanceOrderType) {
  const mapping = {
    'LIMIT': 'LIMIT',
    'MARKET': 'MARKET',
    'STOP': 'STOP',
    'STOP_MARKET': 'STOP_MARKET',
    'TAKE_PROFIT': 'TAKE_PROFIT',
    'TAKE_PROFIT_MARKET': 'TAKE_PROFIT_MARKET',
    'TRAILING_STOP_MARKET': 'TRAILING_STOP_MARKET',
    'LIQUIDATION': 'LIQUIDATION'
  };
  
  return mapping[binanceOrderType] || binanceOrderType;
}

/**
 * Determina o tipo de ordem do bot baseado nas características da ordem
 */
function determineOrderBotType(order) {
  const orderType = order.o; // LIMIT, MARKET, STOP_MARKET, etc.
  const reduceOnly = order.R === true;
  const closePosition = order.cp === true;
  const stopPrice = parseFloat(order.sp || '0');
  
  // ✅ DETECTAR TIPO DE ORDEM BASEADO NAS CARACTERÍSTICAS
  if (orderType === 'STOP_MARKET' && closePosition) {
    return 'STOP_LOSS';
  }
  
  if (orderType === 'TAKE_PROFIT_MARKET' && closePosition) {
    return 'TAKE_PROFIT';
  }
  
  if (orderType === 'LIMIT' && reduceOnly) {
    return 'REDUCAO_PARCIAL';
  }
  
  if (orderType === 'LIMIT' || orderType === 'MARKET') {
    return 'ENTRADA';
  }
  
  return 'UNKNOWN';
}

function detectTargetLevel(symbol, price, orignSig, db) {
  // Buscar preços dos alvos no sinal original
  const signalId = orignSig.replace('WEBHOOK_', '');
  
  // Retornar target baseado na proximidade do preço
  // (implementação similar à sugerida anteriormente)
  
  return null; // ou número do target
}

/**
 * Extrai signal de origem do clientOrderId
 */
function extractOriginSignal(clientOrderId) {
  if (!clientOrderId) return null;
  
  // Procurar padrões como "WEBHOOK_123" ou outros identificadores
  const webhookMatch = clientOrderId.match(/WEBHOOK_(\d+)/);
  if (webhookMatch) {
    return `WEBHOOK_${webhookMatch[1]}`;
  }
  
  // Se começar com autoclose, é liquidação
  if (clientOrderId.startsWith('autoclose-')) {
    return 'LIQUIDATION';
  }
  
  // Se for adl_autoclose, é ADL
  if (clientOrderId === 'adl_autoclose') {
    return 'ADL';
  }
  
  // Se começar com settlement_autoclose, é settlement
  if (clientOrderId.startsWith('settlement_autoclose-')) {
    return 'SETTLEMENT';
  }
  
  return null;
}

// REMOVER as funções handleAccountUpdate, handleBalanceUpdates, handlePositionUpdates
// e manter apenas as funções relacionadas a ordens

async function initializeOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Inicializando sistema para conta ${accountId}...`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    const registered = registerOrderHandlers(accountId);
    if (!registered) {
      throw new Error(`Falha ao registrar handlers para conta ${accountId}`);
    }
    
    const verified = areHandlersRegistered(accountId);
    if (!verified) {
      throw new Error(`Handlers não foram registrados corretamente para conta ${accountId}`);
    }
    
    console.log(`[ORDER-HANDLERS] ✅ Sistema inicializado com sucesso para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] ❌ Erro ao inicializar sistema para conta ${accountId}:`, error.message);
    return false;
  }
}

function registerOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Registrando handlers de ordem para conta ${accountId}...`);
    
    // OBTER callbacks existentes
    const existingCallbacks = websockets.getHandlers(accountId) || {};
    
    // ✅ CRIAR HANDLER ROBUSTO QUE ACEITA MÚLTIPLOS FORMATOS
    const robustOrderHandler = async (messageOrOrder, db) => {
      try {
        console.log(`[ORDER-HANDLERS] 📨 Mensagem recebida para conta ${accountId}:`, {
          type: typeof messageOrOrder,
          hasE: messageOrOrder?.e,
          hasO: messageOrOrder?.o,
          hasI: messageOrOrder?.i,
          hasS: messageOrOrder?.s
        });
        
        // ✅ CHAMAR FUNÇÃO UNIFICADA
        await handleOrderUpdate(messageOrOrder, accountId, db);
        
      } catch (handlerError) {
        console.error(`[ORDER-HANDLERS] ❌ Erro no handler robusto para conta ${accountId}:`, handlerError.message);
      }
    };
    
    // ✅ REGISTRAR HANDLER ROBUSTO
    const orderCallbacks = {
      ...existingCallbacks,
      handleOrderUpdate: robustOrderHandler
    };
    
    websockets.setMonitoringCallbacks(orderCallbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handler robusto registrado para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] ❌ Erro ao registrar handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

function areHandlersRegistered(accountId) {
  try {
    const handlers = websockets.getHandlers(accountId);
    const hasOrderHandler = handlers && typeof handlers.handleOrderUpdate === 'function';
    
    console.log(`[ORDER-HANDLERS] Status do handler de ordem para conta ${accountId}: ${hasOrderHandler ? '✅' : '❌'}`);
    return hasOrderHandler;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao verificar handlers de ordem para conta ${accountId}:`, error.message);
    return false;
  }
}

function unregisterOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Removendo handlers para conta ${accountId}...`);
    
    const emptyCallbacks = {
      handleOrderUpdate: null,
      handleAccountUpdate: null
    };
    
    websockets.setMonitoringCallbacks(emptyCallbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handlers removidos para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao remover handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

module.exports = {
  handleOrderUpdate,
  registerOrderHandlers,
  areHandlersRegistered,
  unregisterOrderHandlers,
  initializeOrderHandlers,
  handleTradeExecution,
  checkPositionClosureAfterOrderExecution,
  autoMoveOrderOnCompletion
};