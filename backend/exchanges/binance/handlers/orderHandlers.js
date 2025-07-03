const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatOrderMessage } = require('../services/telegramHelper');

const targetCache = new Map();

/**
 * ✅ FUNÇÃO DE REGISTRO: Inscreve o handler de ordens no sistema de eventos WebSocket.
 * @param {number|string} accountId - O ID da conta para a qual o handler será registrado.
 */
function registerOrderUpdateHandler(accountId) {
    if (!accountId) {
        console.error('[ORDER-HANDLER] Tentativa de registrar handler sem accountId.');
        return;
    }

    // O listener recebe o payload da ordem diretamente do evento emitido
    const listener = (orderUpdatePayload) => {
        // O accountId é capturado do escopo externo (closure)
        // O terceiro argumento (db) é nulo, pois a função obterá a conexão, se necessário
        handleOrderUpdate(accountId, orderUpdatePayload, null);
    };

    // Registra o listener com um ID único para evitar duplicatas e permitir remoção
    websockets.on('orderUpdate', listener, accountId, 'mainOrderHandler');

    console.log(`[ORDER-HANDLER] Handler principal de atualização de ordens registrado para a conta ${accountId}.`);
}

/**
 * ✅ FUNÇÃO UNIFICADA: Processa atualizações de ordens via WebSocket
 * Suporta MÚLTIPLOS formatos de entrada
 */
async function handleOrderUpdate(accountId, orderUpdateData, db = null) {
  try {
    let connection;

    // ✅ VALIDAÇÃO UNIFICADA
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ORDER] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    if (!orderUpdateData || !orderUpdateData.i) {
        console.error(`[ORDER] Dados de atualização de ordem inválidos para conta ${accountId}:`, orderUpdateData);
        return;
    }

    // ✅ PROCESSAR DADOS DA ORDEM
    const orderData = orderUpdateData.o || orderUpdateData; // O payload pode vir aninhado em 'o'
    
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
    // ATUALIZAR ORDEM NO BANCO - com retry
    if (existingOrder) {
      let tradeUpdateTries = 0;
      while (tradeUpdateTries < 1000) {
        try {
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
          break;
        } catch (error) {
          if (error.message && error.message.includes('Deadlock found when trying to get lock') && tradeUpdateTries < 99) {
            tradeUpdateTries++;
            console.warn(`[ORDER] ⚠️ Deadlock detectado ao atualizar trade, tentativa ${tradeUpdateTries}/1000...`);
            await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
            continue;
          }
          throw error;
        }
      }
      
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
            
            //await sendTelegramMessage(accountId, message);
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
 * ✅ NOVA FUNÇÃO: Mover ordem automaticamente quando FILLED ou CANCELLED
 */
async function autoMoveOrderOnCompletion(orderId, newStatus, accountId, retryCount = 0) {
  if (!['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(newStatus)) {
    return false;
  }

  let connection;
  try {
    console.log(`[ORDER_AUTO_MOVE] 🔄 Iniciando migração da ordem ${orderId} com status ${newStatus}...`);
    
    const db = await getDatabaseInstance();
    connection = await db.getConnection();
    await connection.beginTransaction();

    // ✅ 1. VERIFICAÇÃO PRELIMINAR: Ordem já foi movida para histórico?
    const [historyCheck] = await connection.query(
      'SELECT id FROM ordens_fechadas WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );
    
    if (historyCheck.length > 0) {
      console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} já existe no histórico - verificando duplicatas na tabela ativa...`);
      
      // Verificar se ainda está na tabela ativa (situação de duplicata)
      const [activeCheck] = await connection.query(
        'SELECT id FROM ordens WHERE id_externo = ? AND conta_id = ?',
        [orderId, accountId]
      );
      
      if (activeCheck.length > 0) {
        console.log(`[ORDER_AUTO_MOVE] 🔧 CORREÇÃO: Ordem ${orderId} duplicada - removendo da tabela ativa...`);
        
        const [deleteResult] = await connection.query(
          'DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?',
          [orderId, accountId]
        );
        
        await connection.commit();
        console.log(`[ORDER_AUTO_MOVE] ✅ Ordem duplicada ${orderId} removida (${deleteResult.affectedRows} linha(s))`);
        return true;
      } else {
        console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} já está corretamente no histórico`);
        await connection.rollback();
        return true;
      }
    }

    // ✅ 2. BUSCAR ORDEM COMPLETA DA TABELA ATIVA
    const [orderResult] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );

    if (orderResult.length === 0) {
      console.warn(`[ORDER_AUTO_MOVE] ⚠️ Ordem ${orderId} não encontrada na tabela ativa para mover.`);
      await connection.rollback();
      return false;
    }
    
    const orderToMove = orderResult[0];

    // ✅ 3. VERIFICAÇÃO CRÍTICA: TODAS AS ORDENS PRECISAM TER id_posicao (incluindo CANCELED)
    // Não importa o status ou tipo - TODA ordem precisa de id_posicao para ir ao histórico
    if (!orderToMove.id_posicao || orderToMove.id_posicao === 0) {
      console.warn(`[ORDER_AUTO_MOVE] ⏳ Ordem ${newStatus} ${orderId} sem id_posicao. Iniciando retry a cada 2s por até 5 minutos...`);
      
      // Retry a cada 2 segundos por até 5 minutos (150 tentativas)
      const maxRetries = 150; // 5 minutos / 2 segundos = 150 tentativas
      const retryInterval = 2000; // 2 segundos
      let posId = null;
      let retryAttempt = 0;
      
      while (retryAttempt < maxRetries && !posId) {
        retryAttempt++;
        
        // ✅ VERIFICAÇÃO INTERMEDIÁRIA 1: Ordem já foi movida para histórico durante o retry?
        const [intermediateMoveCheck] = await connection.query(
          'SELECT id FROM ordens_fechadas WHERE id_externo = ? AND conta_id = ?',
          [orderId, accountId]
        );
        
        if (intermediateMoveCheck.length > 0) {
          console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} foi movida para histórico durante retry - interrompendo busca`);
          await connection.rollback();
          return true;
        }
        
        // ✅ VERIFICAÇÃO INTERMEDIÁRIA 2: Ordem já tem id_posicao?
        const [intermediatePositionCheck] = await connection.query(
          'SELECT id_posicao FROM ordens WHERE id_externo = ? AND conta_id = ?',
          [orderId, accountId]
        );
        
        if (intermediatePositionCheck.length === 0) {
          console.log(`[ORDER_AUTO_MOVE] ⚠️ Ordem ${orderId} não existe mais na tabela ativa - encerrando retry`);
          await connection.rollback();
          return false;
        }
        
        if (intermediatePositionCheck[0].id_posicao && intermediatePositionCheck[0].id_posicao !== 0) {
          posId = intermediatePositionCheck[0].id_posicao;
          console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} agora tem id_posicao=${posId} - continuando com migração`);
          break;
        }
        
        // ✅ BUSCAR POSIÇÃO CORRESPONDENTE PARA VINCULAR
        const symbol = orderToMove.simbolo;
        const [availablePositions] = await connection.query(
          `SELECT id, quantidade, preco_medio, data_hora_abertura 
           FROM posicoes 
           WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN' AND ABS(quantidade) > 0
           ORDER BY data_hora_abertura DESC, id DESC
           LIMIT 1`,
          [symbol, accountId]
        );
        
        if (availablePositions.length > 0) {
          const targetPosition = availablePositions[0];
          console.log(`[ORDER_AUTO_MOVE] 🔗 Tentativa ${retryAttempt}: Vinculando ordem ${orderId} à posição ${targetPosition.id}...`);
          
          // Tentar vincular posição com retry
          let positionUpdateTries = 0;
          while (positionUpdateTries < 100) {
            try {
              await connection.query(
                'UPDATE ordens SET id_posicao = ? WHERE id_externo = ? AND conta_id = ?',
                [targetPosition.id, orderId, accountId]
              );
              
              posId = targetPosition.id;
              console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} vinculada à posição ${posId} com sucesso`);
              break;
              
            } catch (positionUpdateError) {
              if (positionUpdateError.message && positionUpdateError.message.includes('Deadlock found when trying to get lock') && positionUpdateTries < 99) {
                positionUpdateTries++;
                console.warn(`[ORDER_AUTO_MOVE] ⚠️ Deadlock ao vincular posição, tentativa ${positionUpdateTries}/100...`);
                await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                continue;
              }
              throw positionUpdateError;
            }
          }
        } else {
          console.log(`[ORDER_AUTO_MOVE] 🔍 Tentativa ${retryAttempt}/${maxRetries}: Nenhuma posição OPEN encontrada para ${symbol}`);
        }
        
        // Aguardar antes da próxima tentativa (se não encontrou posição)
        if (!posId) {
          console.log(`[ORDER_AUTO_MOVE] ⏳ Aguardando ${retryInterval/1000}s antes da próxima tentativa...`);
          await new Promise(res => setTimeout(res, retryInterval));
        }
      }
      
      // Se não conseguiu vincular após todos os retries
      if (!posId) {
        console.warn(`[ORDER_AUTO_MOVE] ⚠️ TIMEOUT: Ordem ${orderId} não pôde ser vinculada a uma posição após ${maxRetries * retryInterval / 1000}s`);
        console.warn(`[ORDER_AUTO_MOVE] ❌ Ordem ${newStatus} ${orderId} será rejeitada - não pode ir ao histórico sem id_posicao`);
        await connection.rollback();
        return false;
      }
      
      // ✅ ATUALIZAR ORDEM COM A POSIÇÃO ENCONTRADA
      orderToMove.id_posicao = posId;
    }

    // ✅ 4. VERIFICAÇÃO FINAL: Ordem ainda não foi movida enquanto processávamos?
    const [finalMoveCheck] = await connection.query(
      'SELECT id FROM ordens_fechadas WHERE id_externo = ? AND conta_id = ?',
      [orderId, accountId]
    );
    
    if (finalMoveCheck.length > 0) {
      console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} foi movida por outro processo - cancelando operação`);
      await connection.rollback();
      return true;
    }

    // ✅ 5. PREPARAR DADOS PARA INSERÇÃO NA TABELA DE HISTÓRICO
    const closedOrderData = {
      ...orderToMove, // Copia todos os campos da ordem original
      id_original: orderToMove.id,
      id_original_ordens: orderToMove.id,
      status: newStatus,
      last_update: new Date(),
      observacao: `${orderToMove.observacao || ''} | Movida para histórico: ${newStatus}`.trim(),
    };
    delete closedOrderData.id;

    // ✅ 6. OBTER COLUNAS DA TABELA DE DESTINO
    const [destColumnsResult] = await connection.query('SHOW COLUMNS FROM ordens_fechadas');
    const destColumns = destColumnsResult.map(col => col.Field);

    // ✅ 7. FILTRAR DADOS PARA INSERIR APENAS COLUNAS EXISTENTES
    const finalDataToInsert = {};
    for (const key in closedOrderData) {
      if (destColumns.includes(key)) {
        finalDataToInsert[key] = closedOrderData[key];
      }
    }

    // ✅ 8. INSERIR NA TABELA DE HISTÓRICO
    const columns = Object.keys(finalDataToInsert);
    const placeholders = columns.map(() => '?').join(', ');
    const values = Object.values(finalDataToInsert);

    // ✅ RETRY EM CASO DE DEADLOCK - INSERÇÃO NO HISTÓRICO
    let insertHistoryTries = 0;
    while (insertHistoryTries < 1000) {
      try {
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        break;
      } catch (error) {
        if (error.message && error.message.includes('Deadlock found when trying to get lock') && insertHistoryTries < 999) {
          insertHistoryTries++;
          console.warn(`[ORDER_AUTO_MOVE] ⚠️ Deadlock detectado ao inserir no histórico, tentativa ${insertHistoryTries}/1000...`);
          await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
          continue;
        }
        throw error;
      }
    }
    
    console.log(`[ORDER_AUTO_MOVE] 📚 Ordem ${orderId} inserida no histórico com sucesso`);

    // ✅ 9. REMOVER TODAS AS CÓPIAS DA ORDEM DA TABELA ATIVA (CORRIGIR DUPLICATAS)
    console.log(`[ORDER_AUTO_MOVE] 🗑️ Deletando TODAS as cópias da ordem ${orderId} da tabela ativa...`);
    
    // ✅ RETRY EM CASO DE DEADLOCK - DELETE DA TABELA ATIVA
    let deleteTries = 0;
    let deleteResult;
    while (deleteTries < 1000) {
      try {
        [deleteResult] = await connection.query(
          'DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?', 
          [orderId, accountId]
        );
        break;
      } catch (error) {
        if (error.message && error.message.includes('Deadlock found when trying to get lock') && deleteTries < 999) {
          deleteTries++;
          console.warn(`[ORDER_AUTO_MOVE] ⚠️ Deadlock detectado ao deletar ordem, tentativa ${deleteTries}/1000...`);
          await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
          continue;
        }
        throw error;
      }
    }
    
    if (deleteResult.affectedRows === 0) {
      console.error(`[ORDER_AUTO_MOVE] ❌ FALHA: Nenhuma linha foi deletada para ordem ${orderId}`);
      await connection.rollback();
      return false;
    }
    
    console.log(`[ORDER_AUTO_MOVE] ✅ ${deleteResult.affectedRows} cópia(s) da ordem ${orderId} deletada(s) da tabela ativa`);

    await connection.commit();
    
    // ✅ 10. VERIFICAÇÃO FINAL: CONFIRMAR QUE A ORDEM FOI REALMENTE REMOVIDA
    const [verifyResult] = await connection.query(
      'SELECT COUNT(*) as count FROM ordens WHERE id_externo = ? AND conta_id = ?', 
      [orderId, accountId]
    );
    
    if (verifyResult[0].count > 0) {
      console.error(`[ORDER_AUTO_MOVE] ❌ ERRO CRÍTICO: Ainda existem ${verifyResult[0].count} cópia(s) da ordem ${orderId} na tabela ativa após deleção!`);
      return false;
    }
    
    console.log(`[ORDER_AUTO_MOVE] ✅ Ordem ${orderId} movida e deletada com sucesso - verificação final confirmada`);
    return true;

  } catch (error) {
    if (connection) await connection.rollback();

    // Retry em caso de deadlock
    if (
      error.message &&
      error.message.includes('Deadlock found when trying to get lock') &&
      retryCount < 1000
    ) {
      console.warn(`[ORDER_AUTO_MOVE] ⚠️ Deadlock ao mover ordem ${orderId}. Tentando novamente (${retryCount + 1}/1000)...`);
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
async function handleOrderUpdate(accountId, orderUpdateData, db = null) {
  try {
    let connection;

    // ✅ VALIDAÇÃO UNIFICADA
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ORDER] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    if (!orderUpdateData || !orderUpdateData.i) {
        console.error(`[ORDER] Dados de atualização de ordem inválidos para conta ${accountId}:`, orderUpdateData);
        return;
    }

    // ✅ PROCESSAR DADOS DA ORDEM
    const orderData = orderUpdateData.o || orderUpdateData; // O payload pode vir aninhado em 'o'
    
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
      //console.log(`[ORDER]   - ID: ${orderId}`);
      //console.log(`[ORDER]   - Símbolo: ${symbol}`);
      //console.log(`[ORDER]   - Quantidade: ${executedQty}`);
      //console.log(`[ORDER]   - Preço médio: ${avgPrice}`);
      //console.log(`[ORDER]   - Valor total: ${totalValue.toFixed(2)} USDT`);
    } else if (orderStatus === 'NEW') {
      console.log(`[ORDER] ✅ Nova ordem registrada:`);
      //console.log(`[ORDER]   - ID: ${orderId}`);
      //console.log(`[ORDER]   - Símbolo: ${symbol}`);
      //console.log(`[ORDER]   - Tipo: ${orderData.o} (${orderData.R ? 'REDUCE_ONLY' : 'NORMAL'})`);
      //console.log(`[ORDER]   - Side: ${orderData.S}`);
      //console.log(`[ORDER]   - Quantidade: ${orderData.q}`);
      //console.log(`[ORDER]   - Preço: ${orderData.p}`);
    }

  } catch (error) {
    console.error(`[ORDER] ❌ Erro ao processar atualização da ordem:`, error.message);
    console.error(`[ORDER] Stack trace:`, error.stack);
  }
}

/**
 * ✅ FUNÇÃO CORRIGIDA: Inserir ordem externa com TODOS os campos do webhook
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

    // ✅ RETRY EM CASO DE DEADLOCK - INSERÇÃO DE ORDEM EXTERNA
    let insertTries = 0;
    let result, orderDbId;
    while (insertTries < 1000) {
      try {
        [result] = await connection.query(insertQuery, values);
        orderDbId = result.insertId;
        break;
      } catch (error) {
        if (error.message && error.message.includes('Deadlock found when trying to get lock') && insertTries < 99) {
          insertTries++;
          console.warn(`[ORDER] ⚠️ Deadlock detectado ao inserir ordem externa, tentativa ${insertTries}/1000...`);
          await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
          continue;
        }
        throw error;
      }
    }
    
    console.log(`[ORDER] ✅ Ordem externa COMPLETA ${orderData.i} inserida:`);
    console.log(`[ORDER]   - ID Banco: ${orderDbId}`);
    console.log(`[ORDER]   - Client Order ID: ${orderData.c || 'N/A'}`);
    console.log(`[ORDER]   - Execution Type: ${orderData.x}`);
    console.log(`[ORDER]   - Time in Force: ${orderData.f}`);
    console.log(`[ORDER]   - Stop Price: ${orderData.sp || 'N/A'}`);
    console.log(`[ORDER]   - Position Side: ${orderData.ps || 'N/A'}`);
    console.log(`[ORDER]   - Campos salvos: ${columnNames.length}/${Object.keys(orderInsertData).length}`);

    // ✅ NOVA LÓGICA: PROCURAR E VINCULAR POSIÇÃO APÓS INSERÇÃO (SE NÃO ESTAVA VINCULADA)
    if (!positionId) {
      console.log(`[ORDER] 🔍 Iniciando busca por posição para vincular ordem ${orderData.i}...`);
      
      // Executar busca de posição em background para não bloquear
      setTimeout(async () => {
        await searchAndLinkPosition(orderDbId, orderData, accountId);
      }, 1000); // Aguardar 1 segundo antes de iniciar a busca
    }
    
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

    // === VALIDAÇÃO: Não atualizar se algum valor for NaN ===
    const camposParaValidar = {
      realized_profit, commission, quantidade_executada, preco_executado
    };
    for (const [campo, valor] of Object.entries(camposParaValidar)) {
      if (valor !== undefined && valor !== null && isNaN(valor)) {
        console.error(`[ORDER] ❌ Valor inválido (NaN) detectado em updateExistingOrder: ${campo}=${valor} | orderId=${orderId} | accountId=${accountId}`);
        return; // Não faz update se algum valor for NaN
      }
    }

    // ✅ RETRY EM CASO DE DEADLOCK - ATUALIZAÇÃO DE ORDEM EXISTENTE
    let updateTries = 0;
    while (updateTries < 1000) {
      try {
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
        break;
      } catch (error) {
        if (error.message && error.message.includes('Deadlock found when trying to get lock') && updateTries < 99) {
          updateTries++;
          console.warn(`[ORDER] ⚠️ Deadlock detectado ao atualizar ordem, tentativa ${updateTries}/1000...`);
          await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
          continue;
        }
        throw error;
      }
    }
    
    console.log(`[ORDER] ✅ Ordem ${orderId} atualizada: ${orderData.X}`);

  } catch (error) {
    // Retry em caso de deadlock
    if (
      error.message &&
      error.message.includes('Deadlock found when trying to get lock') &&
      retryCount < 1000
    ) {
      //console.warn(`[ORDER] ⚠️ Deadlock ao atualizar ordem ${orderData.i}. Tentando novamente (${retryCount + 1}/1000)...`);
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
      /*  console.log(`[ORDER-HANDLERS] 📨 Mensagem recebida para conta ${accountId}:`, {
          type: typeof messageOrOrder,
          hasE: messageOrOrder?.e,
          hasO: messageOrOrder?.o,
          hasI: messageOrOrder?.i,
          hasS: messageOrOrder?.s
        });*/
        
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

/**
 * ✅ FUNÇÃO PARA LIMPAR ORDENS ÓRFÃS QUE JÁ FORAM MOVIDAS PARA O HISTÓRICO
 * Remove ordens que existem na tabela ativa mas já estão no histórico (duplicatas)
 */
async function cleanupOrphanOrders(accountId) {
  let connection;
  try {
    console.log(`[CLEANUP_ORDERS] 🧹 Iniciando limpeza de ordens órfãs para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    connection = await db.getConnection();
    
    // Buscar ordens que estão tanto na tabela ativa quanto no histórico
    const [duplicateOrders] = await connection.query(`
      SELECT o.id, o.id_externo, o.simbolo, o.status
      FROM ordens o
      INNER JOIN ordens_fechadas oh ON o.id_externo = oh.id_externo AND o.conta_id = oh.conta_id
      WHERE o.conta_id = ?
    `, [accountId]);
    
    if (duplicateOrders.length === 0) {
      console.log(`[CLEANUP_ORDERS] ✅ Nenhuma ordem órfã encontrada para conta ${accountId}`);
      return 0;
    }
    
    console.log(`[CLEANUP_ORDERS] 🔍 Encontradas ${duplicateOrders.length} ordens órfãs para limpeza`);
    
    let cleanedCount = 0;
    
    for (const order of duplicateOrders) {
      // ✅ RETRY EM CASO DE DEADLOCK - DELETE DE ORDENS ÓRFÃS
      let cleanupTries = 0;
      while (cleanupTries < 1000) {
        try {
          const [deleteResult] = await connection.query(
            'DELETE FROM ordens WHERE id = ?', 
            [order.id]
          );
          
          if (deleteResult.affectedRows > 0) {
            console.log(`[CLEANUP_ORDERS] 🗑️ Ordem órfã removida: ${order.id_externo} (${order.simbolo})`);
            cleanedCount++;
          }
          break;
        } catch (deleteError) {
          if (deleteError.message && deleteError.message.includes('Deadlock found when trying to get lock') && cleanupTries < 99) {
            cleanupTries++;
            console.warn(`[CLEANUP_ORDERS] ⚠️ Deadlock detectado ao limpar ordem órfã, tentativa ${cleanupTries}/1000...`);
            await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
            continue;
          }
          console.error(`[CLEANUP_ORDERS] ❌ Erro ao remover ordem órfã ${order.id_externo}:`, deleteError.message);
          break;
        }
      }
    }
    
    console.log(`[CLEANUP_ORDERS] ✅ Limpeza concluída: ${cleanedCount} ordens órfãs removidas`);
    return cleanedCount;
    
  } catch (error) {
    console.error(`[CLEANUP_ORDERS] ❌ Erro na limpeza de ordens órfãs:`, error.message);
    return 0;
  } finally {
    if (connection) connection.release();
  }
}

/**
 * Cria ordens de SL/TP/reduções para uma posição existente baseado no sinal original
 * @param {Object} signal - Sinal do webhook_signals
 * @param {Object} position - Posição da corretora
 * @param {number} accountId - ID da conta
 * @param {number} positionId - ID da posição no banco
 */
async function createTpSlOrdersForSignal(signal, position, accountId, positionId) {
  const db = await getDatabaseInstance();
  if (!db) {
    throw new Error('Falha ao obter instância do banco de dados');
  }

  const { newStopOrder, getPrecision, roundPriceToTickSize } = require('../api/rest');
  
  try {
    console.log(`[CREATE_PROTECTION] Criando ordens de proteção para ${signal.symbol} (sinal ID: ${signal.id})...`);
    
    // Obter precisão do símbolo
    const precisionInfo = await getPrecision(signal.symbol, accountId);
    const pricePrecision = precisionInfo.pricePrecision;
    
    // Determinar lado oposto para ordens de fechamento
    const entryLadoBinance = (signal.side === 'COMPRA' || signal.side === 'BUY') ? 'BUY' : 'SELL';
    const exitLadoBinance = entryLadoBinance === 'BUY' ? 'SELL' : 'BUY';
    
    const positionQty = Math.abs(parseFloat(position.quantidade));
    
    // 1. Criar ordem de Stop Loss
    if (signal.sl_price && signal.sl_price > 0) {
      const slPrice = await roundPriceToTickSize(signal.symbol, parseFloat(signal.sl_price), accountId);
      
      try {
        const slResult = await newStopOrder(
          accountId,
          signal.symbol,
          null, // quantidade null para closePosition
          exitLadoBinance,
          slPrice,
          null, // price null para STOP_MARKET
          false, // reduceOnly false para closePosition
          true, // closePosition true
          'STOP_MARKET'
        );
        
        if (slResult && slResult.orderId) {
          // Inserir no banco
          await insertNewOrder({
            id_externo: slResult.orderId,
            simbolo: signal.symbol,
            lado: exitLadoBinance,
            tipo_ordem: 'STOP_MARKET',
            tipo_ordem_bot: 'SL',
            preco: slPrice,
            quantidade: 0, // closePosition
            status: 'NEW',
            posicao_id: positionId,
            orign_sig: `WEBHOOK_${signal.id}`,
            conta_id: accountId
          });
          console.log(`[CREATE_PROTECTION] ✅ SL criado: ${slResult.orderId} a ${slPrice}`);
        }
      } catch (slError) {
        console.error(`[CREATE_PROTECTION] Erro ao criar SL:`, slError.message);
      }
    }
    
    // 2. Criar ordens de Take Profit
    const tpPrices = [signal.tp1_price, signal.tp2_price, signal.tp3_price, signal.tp4_price, signal.tp5_price];
    const tpLabels = ['TP1', 'TP2', 'TP3', 'TP4', 'TP5'];
    
    for (let i = 0; i < tpPrices.length; i++) {
      const tpPrice = tpPrices[i];
      if (!tpPrice || tpPrice <= 0) continue;
      
      const tpPriceRounded = await roundPriceToTickSize(signal.symbol, parseFloat(tpPrice), accountId);
      
      // Calcular quantidade (25% da posição para cada TP)
      const tpQty = Math.floor((positionQty * 0.25) / precisionInfo.stepSize) * precisionInfo.stepSize;
      if (tpQty <= 0) continue;
      
      try {
        const tpResult = await newStopOrder(
          accountId,
          signal.symbol,
          tpQty,
          exitLadoBinance,
          tpPriceRounded,
          null,
          true, // reduceOnly
          false, // closePosition
          'TAKE_PROFIT_MARKET'
        );
        
        if (tpResult && tpResult.orderId) {
          // Inserir no banco
          await insertNewOrder({
            id_externo: tpResult.orderId,
            simbolo: signal.symbol,
            lado: exitLadoBinance,
            tipo_ordem: 'TAKE_PROFIT_MARKET',
            tipo_ordem_bot: tpLabels[i],
            preco: tpPriceRounded,
            quantidade: tpQty,
            status: 'NEW',
            posicao_id: positionId,
            orign_sig: `WEBHOOK_${signal.id}`,
            conta_id: accountId
          });
          console.log(`[CREATE_PROTECTION] ✅ ${tpLabels[i]} criado: ${tpResult.orderId} a ${tpPriceRounded}`);
        }
      } catch (tpError) {
        console.error(`[CREATE_PROTECTION] Erro ao criar ${tpLabels[i]}:`, tpError.message);
      }
    }
    
    console.log(`[CREATE_PROTECTION] ✅ Ordens de proteção processadas para ${signal.symbol}`);
    
  } catch (error) {
    console.error(`[CREATE_PROTECTION] Erro geral ao criar ordens de proteção:`, error.message);
    throw error;
  }
}

/**
 * 🔍 Busca e vincula uma posição à ordem após inserção
 * Tenta a cada 5 segundos por até 5 minutos com verificações intermediárias
 */
async function searchAndLinkPosition(orderDbId, orderData, accountId) {
  const { getDatabaseInstance } = require('../../../core/database/conexao');
  
  let db;
  try {
    db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[POSITION_LINK] ❌ Não foi possível obter conexão com banco para conta ${accountId}`);
      return;
    }
  } catch (error) {
    console.error(`[POSITION_LINK] ❌ Erro ao obter conexão com banco:`, error.message);
    return;
  }

  const startTime = Date.now();
  const timeout = 5 * 60 * 1000; // 5 minutos
  const interval = 5000; // 5 segundos
  const symbol = orderData.s;
  
  console.log(`[POSITION_LINK] 🔍 Iniciando busca por posição para ordem ${orderData.i} (${symbol})...`);
  console.log(`[POSITION_LINK]   - Timeout: 5 minutos`);
  console.log(`[POSITION_LINK]   - Intervalo: 5 segundos`);

  const searchInterval = setInterval(async () => {
    let connection;
    try {
      connection = await db.getConnection();
      
      // ✅ VERIFICAÇÃO INTERMEDIÁRIA 1: Ordem já foi movida para histórico?
      const [historyCheck] = await connection.query(
        'SELECT id FROM ordens_fechadas WHERE id_externo = ? AND conta_id = ?',
        [orderData.i, accountId]
      );
      
      if (historyCheck.length > 0) {
        console.log(`[POSITION_LINK] ✅ Ordem ${orderData.i} foi movida para histórico - interrompendo busca`);
        clearInterval(searchInterval);
        return;
      }
      
      // ✅ VERIFICAÇÃO INTERMEDIÁRIA 2: Ordem ainda existe na tabela ativa?
      const [orderCheck] = await connection.query(
        'SELECT id_posicao FROM ordens WHERE id = ? AND conta_id = ?',
        [orderDbId, accountId]
      );
      
      if (orderCheck.length === 0) {
        console.log(`[POSITION_LINK] ⚠️ Ordem ${orderDbId} não encontrada no banco - foi removida ou movida`);
        clearInterval(searchInterval);
        return;
      }
      
      // ✅ VERIFICAÇÃO INTERMEDIÁRIA 3: Ordem já tem id_posicao?
      if (orderCheck[0].id_posicao) {
        console.log(`[POSITION_LINK] ✅ Ordem ${orderDbId} já está vinculada à posição ${orderCheck[0].id_posicao}`);
        clearInterval(searchInterval);
        return;
      }
      
      // ✅ BUSCAR POSIÇÃO CORRESPONDENTE
      const [positions] = await connection.query(
        `SELECT id, quantidade, preco_medio 
         FROM posicoes 
         WHERE simbolo = ? AND conta_id = ? AND ABS(quantidade) > 0
         ORDER BY data_hora_abertura DESC, id DESC
         LIMIT 1`,
        [symbol, accountId]
      );
      
      if (positions.length > 0) {
        const position = positions[0];
        
        // ✅ ATUALIZAR ORDEM COM RETRY ROBUSTO
        let updateTries = 0;
        while (updateTries < 100) {
          try {
            // ✅ VERIFICAÇÃO FINAL ANTES DO UPDATE: Ordem ainda não foi movida?
            const [finalCheck] = await connection.query(
              'SELECT id_posicao FROM ordens WHERE id = ? AND conta_id = ?',
              [orderDbId, accountId]
            );
            
            if (finalCheck.length === 0) {
              console.log(`[POSITION_LINK] ⚠️ Ordem ${orderDbId} não existe mais - foi movida durante processo`);
              clearInterval(searchInterval);
              return;
            }
            
            if (finalCheck[0].id_posicao) {
              console.log(`[POSITION_LINK] ✅ Ordem ${orderDbId} já foi vinculada à posição ${finalCheck[0].id_posicao} por outro processo`);
              clearInterval(searchInterval);
              return;
            }
            
            // ✅ EXECUTAR UPDATE
            await connection.query(
              'UPDATE ordens SET id_posicao = ? WHERE id = ? AND conta_id = ?',
              [position.id, orderDbId, accountId]
            );
            
            console.log(`[POSITION_LINK] ✅ Ordem ${orderDbId} vinculada à posição ${position.id}`);
            console.log(`[POSITION_LINK]   - Símbolo: ${symbol}`);
            console.log(`[POSITION_LINK]   - Quantidade posição: ${position.quantidade}`);
            console.log(`[POSITION_LINK]   - Preço médio: ${position.preco_medio}`);
            console.log(`[POSITION_LINK]   - Tempo decorrido: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
            
            clearInterval(searchInterval);
            return;
            
          } catch (updateError) {
            if (updateError.message && updateError.message.includes('Deadlock found when trying to get lock') && updateTries < 99) {
              updateTries++;
              console.warn(`[POSITION_LINK] ⚠️ Deadlock ao vincular posição, tentativa ${updateTries}/100...`);
              await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
              continue;
            }
            throw updateError;
          }
        }
      } else {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[POSITION_LINK] 🔍 Posição para ${symbol} ainda não encontrada (${elapsed}s)...`);
      }
      
      // ✅ VERIFICAR TIMEOUT
      if (Date.now() - startTime >= timeout) {
        console.warn(`[POSITION_LINK] ⏰ Timeout atingido para ordem ${orderDbId} (${symbol})`);
        console.warn(`[POSITION_LINK]   - Posição não foi encontrada em 5 minutos`);
        clearInterval(searchInterval);
      }
      
    } catch (error) {
      console.error(`[POSITION_LINK] ❌ Erro na busca por posição:`, error.message);
      
      // Em caso de erro crítico, parar a busca
      if (!error.message.includes('Deadlock')) {
        clearInterval(searchInterval);
      }
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }, interval);
}

module.exports = {
  handleOrderUpdate,
  registerOrderUpdateHandler, // ✅ Garante que a função correta está exportada
  autoMoveOrderOnCompletion,
  checkPositionClosureAfterOrderExecution,
  insertExternalOrder,
  cleanupOrphanOrders,
  createTpSlOrdersForSignal,
  searchAndLinkPosition
};