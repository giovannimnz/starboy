const { getDatabaseInstance, formatDateForMySQL } = require('../db/conexao');
const { cancelOrder, getOpenOrders } = require('../api');
const { sendTelegramMessage, formatPositionClosedMessage, formatAlertMessage } = require('./telegramBot');

/**
 * ✅ FUNÇÃO PRINCIPAL PARA MOVER POSIÇÕES E ORDENS PARA HISTÓRICO
 * Baseada na versão do _dev com melhorias
 */
async function movePositionToHistory(db, positionId, status, reason, accountId) {
  console.log(`[MOVE_POSITION] 🔄 Iniciando movimentação da posição ${positionId} para histórico...`);
  console.log(`[MOVE_POSITION] 📋 Status: ${status}, Motivo: ${reason}, Conta: ${accountId}`);
  
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    console.log(`[MOVE_POSITION] 🔄 Tentativa ${attempts}/${maxAttempts} para posição ${positionId}`);
    
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // ✅ 1. VERIFICAR SE A POSIÇÃO EXISTE
      const [positionResult] = await connection.query(
        "SELECT * FROM posicoes WHERE id = ?", 
        [positionId]
      );
      
      if (positionResult.length === 0) {
        console.warn(`[MOVE_POSITION] ⚠️ Posição ${positionId} não encontrada no banco`);
        await connection.rollback();
        connection.release();
        return false;
      }
      
      const position = positionResult[0];
      const symbol = position.simbolo;
      const quantity = parseFloat(position.quantidade || 0);
      const entryPrice = parseFloat(position.preco_entrada || 0);
      const currentPrice = parseFloat(position.preco_corrente || entryPrice);
      
      console.log(`[MOVE_POSITION] 📊 Posição encontrada: ${symbol} - ${quantity} @ ${entryPrice}`);
      
      // ✅ 2. CANCELAR ORDENS ABERTAS NA CORRETORA PARA ESTE SÍMBOLO
      try {
        console.log(`[MOVE_POSITION] 🗑️ Verificando ordens abertas na corretora para ${symbol}...`);
        
        const openOrdersOnExchange = await getOpenOrders(accountId, symbol);
        
        if (openOrdersOnExchange && openOrdersOnExchange.length > 0) {
          console.log(`[MOVE_POSITION] 📋 Encontradas ${openOrdersOnExchange.length} ordens abertas para ${symbol}`);
          
          for (const order of openOrdersOnExchange) {
            try {
              await cancelOrder(accountId, symbol, order.orderId);
              console.log(`[MOVE_POSITION] ✅ Ordem ${order.orderId} cancelada`);
              
              // Aguardar um pouco entre cancelamentos
              await new Promise(resolve => setTimeout(resolve, 200));
              
            } catch (cancelError) {
              console.warn(`[MOVE_POSITION] ⚠️ Erro ao cancelar ordem ${order.orderId}:`, cancelError.message);
            }
          }
          
          // Aguardar cancelamentos serem processados
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.log(`[MOVE_POSITION] ℹ️ Nenhuma ordem aberta encontrada para ${symbol}`);
        }
        
      } catch (exchangeError) {
        console.warn(`[MOVE_POSITION] ⚠️ Erro ao verificar/cancelar ordens na corretora:`, exchangeError.message);
      }

      // ✅ 3. ATUALIZAR STATUS E TEMPO DE FECHAMENTO DA POSIÇÃO
      const formattedDate = formatDateForMySQL(new Date());
      await connection.query(
        `UPDATE posicoes
         SET status = ?,
             data_hora_fechamento = ?,
             data_hora_ultima_atualizacao = ?
         WHERE id = ?`,
        [status, formattedDate, formattedDate, positionId]
      );
      
      console.log(`[MOVE_POSITION] ✅ Status da posição ${positionId} atualizado para ${status}`);

      // ✅ 4. BUSCAR TODAS AS ORDENS RELACIONADAS À POSIÇÃO
      const [orderResult] = await connection.query(
        "SELECT * FROM ordens WHERE id_posicao = ?", 
        [positionId]
      );
      
      console.log(`[MOVE_POSITION] 📋 Encontradas ${orderResult.length} ordens para posição ${positionId}`);

      // ✅ 5. MOVER ORDENS PARA TABELA DE FECHADAS (SE HOUVER)
      if (orderResult.length > 0) {
        console.log(`[MOVE_POSITION] 🔄 Movendo ${orderResult.length} ordens para ordens_fechadas...`);
        
        for (const order of orderResult) {
          try {
            // Verificar se a coluna orign_sig existe na tabela ordens
            const [orderColumns] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);
            const hasOrignSigOrdens = orderColumns.length > 0;
            
            // Inserir na tabela fechadas
            if (hasOrignSigOrdens) {
              await connection.query(`
                INSERT INTO ordens_fechadas (
                  tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao,
                  id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only,
                  close_position, last_update, orign_sig, observacao, preco_executado,
                  quantidade_executada, dados_originais_ws, conta_id, renew_sl_firs,
                  renew_sl_seco, commission, commission_asset, trade_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                order.tipo_ordem, order.preco, order.quantidade, order.id_posicao,
                order.status, order.data_hora_criacao, order.id_externo, order.side,
                order.simbolo, order.tipo_ordem_bot, order.target, order.reduce_only,
                order.close_position, order.last_update, order.orign_sig, order.observacao,
                order.preco_executado, order.quantidade_executada, order.dados_originais_ws,
                order.conta_id, order.renew_sl_firs, order.renew_sl_seco, order.commission,
                order.commission_asset, order.trade_id
              ]);
            } else {
              // Versão sem orign_sig para compatibilidade
              await connection.query(`
                INSERT INTO ordens_fechadas (
                  tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao,
                  id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only,
                  close_position, last_update, observacao, preco_executado,
                  quantidade_executada, dados_originais_ws, conta_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                order.tipo_ordem, order.preco, order.quantidade, order.id_posicao,
                order.status, order.data_hora_criacao, order.id_externo, order.side,
                order.simbolo, order.tipo_ordem_bot, order.target, order.reduce_only,
                order.close_position, order.last_update, order.observacao,
                order.preco_executado, order.quantidade_executada, order.dados_originais_ws,
                order.conta_id
              ]);
            }
            
            console.log(`[MOVE_POSITION] ✅ Ordem ${order.id_externo} movida para histórico`);
            
          } catch (moveOrderError) {
            console.error(`[MOVE_POSITION] ❌ Erro ao mover ordem ${order.id_externo}:`, moveOrderError.message);
            throw moveOrderError;
          }
        }
        
        // Excluir ordens originais
        await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
        console.log(`[MOVE_POSITION] ✅ ${orderResult.length} ordens excluídas da tabela original`);
      }

      // ✅ 6. VERIFICAR SE POSIÇÃO TEM COLUNA orign_sig
      const [posColumns] = await connection.query(`SHOW COLUMNS FROM posicoes LIKE 'orign_sig'`);
      const hasOrignSigPos = posColumns.length > 0;

      // ✅ 7. COPIAR POSIÇÃO PARA TABELA HISTÓRICA
      console.log(`[MOVE_POSITION] 🔄 Movendo posição ${positionId} para posicoes_fechadas...`);
      
      try {
        if (hasOrignSigPos) {
          await connection.query(`
            INSERT INTO posicoes_fechadas (
              simbolo, quantidade, preco_medio, status, data_hora_abertura,
              data_hora_fechamento, side, leverage, data_hora_ultima_atualizacao,
              preco_entrada, preco_corrente, orign_sig, quantidade_aberta, conta_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            position.simbolo, position.quantidade, position.preco_medio, status,
            position.data_hora_abertura, formattedDate, position.side, position.leverage,
            formattedDate, position.preco_entrada, position.preco_corrente,
            position.orign_sig, position.quantidade_aberta, position.conta_id
          ]);
        } else {
          await connection.query(`
            INSERT INTO posicoes_fechadas (
              simbolo, quantidade, preco_medio, status, data_hora_abertura,
              data_hora_fechamento, side, leverage, data_hora_ultima_atualizacao,
              preco_entrada, preco_corrente, quantidade_aberta, conta_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            position.simbolo, position.quantidade, position.preco_medio, status,
            position.data_hora_abertura, formattedDate, position.side, position.leverage,
            formattedDate, position.preco_entrada, position.preco_corrente,
            position.quantidade_aberta, position.conta_id
          ]);
        }
        
        console.log(`[MOVE_POSITION] ✅ Posição ${positionId} copiada para posicoes_fechadas`);
        
      } catch (copyError) {
        console.error(`[MOVE_POSITION] ❌ Erro ao copiar posição para histórico:`, copyError.message);
        throw copyError;
      }

      // ✅ 8. EXCLUIR POSIÇÃO ORIGINAL
      await connection.query("DELETE FROM posicoes WHERE id = ?", [positionId]);
      console.log(`[MOVE_POSITION] ✅ Posição ${positionId} excluída da tabela original`);

      // ✅ 9. FINALIZAR TRANSAÇÃO
      await connection.commit();
      console.log(`[MOVE_POSITION] ✅ Transação commitada para posição ${positionId}`);

      // ✅ 10. CALCULAR PNL E ENVIAR NOTIFICAÇÃO TELEGRAM
      try {
        const pnl = (currentPrice - entryPrice) * quantity * (position.side === 'BUY' ? 1 : -1);
        
        const message = formatPositionClosedMessage(
          symbol, 
          position.side, 
          quantity, 
          entryPrice, 
          currentPrice, 
          pnl
        );
        
        await sendTelegramMessage(accountId, message);
        console.log(`[MOVE_POSITION] 📱 Notificação de fechamento enviada`);
        
      } catch (telegramError) {
        console.warn(`[MOVE_POSITION] ⚠️ Erro ao enviar notificação Telegram:`, telegramError.message);
      }

      // ✅ 11. VERIFICAR SE DEVE FECHAR WEBSOCKET
      await checkAndCloseWebsocket(db, symbol, accountId);

      connection.release();
      console.log(`[MOVE_POSITION] 🎉 Posição ${positionId} movida com sucesso para histórico`);
      return true;

    } catch (error) {
      await connection.rollback();
      console.error(`[MOVE_POSITION] ❌ Erro na tentativa ${attempts}:`, error.message);

      // Se for erro de bloqueio, tentar novamente
      if (error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
          error.message.includes('Lock wait timeout') ||
          error.message.includes('Deadlock')) {
        
        const backoffTime = Math.pow(2, attempts) * 1000; // Backoff exponencial
        console.log(`[MOVE_POSITION] ⏳ Aguardando ${backoffTime}ms antes da próxima tentativa...`);
        await new Promise(resolve => setTimeout(resolve, backoffTime));
        
      } else {
        console.error(`[MOVE_POSITION] ❌ Erro não recuperável:`, error.message);
        break;
      }
    } finally {
      if (connection) {
        connection.release();
      }
    }
  }

  console.error(`[MOVE_POSITION] ❌ Falha definitiva ao mover posição ${positionId} após ${maxAttempts} tentativas`);
  return false;
}

/**
 * ✅ VERIFICAR E FECHAR WEBSOCKET SE NÃO HÁ MAIS ATIVIDADE
 */
async function checkAndCloseWebsocket(db, symbol, accountId) {
  try {
    const [counts] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM webhook_signals WHERE symbol = ? AND conta_id = ? AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')) as signals,
        (SELECT COUNT(*) FROM posicoes WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN') as positions,
        (SELECT COUNT(*) FROM ordens WHERE simbolo = ? AND conta_id = ? AND status = 'NEW') as orders
    `, [symbol, accountId, symbol, accountId, symbol, accountId]);

    const totalActivity = (counts[0]?.signals || 0) + (counts[0]?.positions || 0) + (counts[0]?.orders || 0);

    if (totalActivity === 0) {
      const websockets = require('../websockets');
      websockets.stopPriceMonitoring(symbol, accountId);
      console.log(`[MOVE_POSITION] 🔌 WebSocket fechado para ${symbol} (conta ${accountId}) - sem atividade`);
    }
    
  } catch (error) {
    console.error(`[MOVE_POSITION] ❌ Erro ao verificar fechamento de WebSocket:`, error.message);
  }
}

/**
 * ✅ SINCRONIZAÇÃO AVANÇADA COM FECHAMENTO AUTOMÁTICO
 */
async function syncAndCloseGhostPositions(accountId) {
  try {
    console.log(`[SYNC_CLOSE] 🔄 Verificando posições fantasma para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    const { getAllOpenPositions } = require('../api');
    
    // Obter posições do banco e da corretora
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, side FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    const exchangePositions = await getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        console.log(`[SYNC_CLOSE] 🔄 Posição ${dbPos.simbolo} não existe mais na corretora, movendo para histórico...`);
        
        const success = await movePositionToHistory(
          db, 
          dbPos.id, 
          'CLOSED', 
          'Sincronização automática - posição não encontrada na corretora',
          accountId
        );
        
        if (success) {
          closedCount++;
          console.log(`[SYNC_CLOSE] ✅ Posição ${dbPos.simbolo} movida para histórico`);
        } else {
          console.error(`[SYNC_CLOSE] ❌ Falha ao mover posição ${dbPos.simbolo}`);
        }
      }
    }
    
    console.log(`[SYNC_CLOSE] 📊 Total de posições movidas para histórico: ${closedCount}`);
    return closedCount;
    
  } catch (error) {
    console.error(`[SYNC_CLOSE] ❌ Erro na sincronização com fechamento:`, error.message);
    return 0;
  }
}

module.exports = {
  movePositionToHistory,
  checkAndCloseWebsocket,
  syncAndCloseGhostPositions
};