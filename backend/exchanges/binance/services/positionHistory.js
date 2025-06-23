const { getDatabaseInstance, formatDateForMySQL } = require('../../../core/database/conexao');
const { cancelOrder, getOpenOrders } = require('../api/rest');
const { sendTelegramMessage, formatPositionClosedMessage, formatAlertMessage } = require('../telegram/telegramBot');

/**
 * ✅ FUNÇÃO MELHORADA: Mover posição fisicamente para histórico
 */
async function movePositionToHistory(db, positionId, status, reason, accountId) {
  let connection;
  
  try {
    console.log(`[MOVE_POSITION] 📚 Iniciando processo de mover posição ${positionId} para histórico...`);
    
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Buscar a posição completa da tabela ativa com SELECT *
    const [positionResult] = await connection.query(
      'SELECT * FROM posicoes WHERE id = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    if (positionResult.length === 0) {
      console.log(`[MOVE_POSITION] ⚠️ Posição ${positionId} não encontrada para conta ${accountId}`);
      await connection.rollback();
      return false;
    }
    
    const positionToMove = positionResult[0];
    const symbol = positionToMove.simbolo;
    
    console.log(`[MOVE_POSITION] 📋 Processando posição: ${symbol} (ID: ${positionId})`);
    
    // 2. Cancelar ordens abertas na corretora (mantido como está)
    try {
      const openOrdersOnExchange = await api.getOpenOrders(accountId, symbol);
      if (openOrdersOnExchange && openOrdersOnExchange.length > 0) {
        console.log(`[MOVE_POSITION] 🗑️ Cancelando ${openOrdersOnExchange.length} ordens abertas para ${symbol} na corretora...`);
        for (const order of openOrdersOnExchange) {
          await api.cancelOrder(symbol, order.orderId, accountId);
        }
      }
    } catch (exchangeError) {
      console.warn(`[MOVE_POSITION] ⚠️ Erro ao cancelar ordens na corretora:`, exchangeError.message);
    }
    
    // 3. Buscar todas as ordens relacionadas no banco
    const [relatedOrders] = await connection.query(
      'SELECT * FROM ordens WHERE id_posicao = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    // 4. Mover ordens para o histórico (lógica dinâmica)
    if (relatedOrders.length > 0) {
      const [destOrderColumnsResult] = await connection.query('SHOW COLUMNS FROM ordens_fechadas');
      const destOrderColumns = destOrderColumnsResult.map(col => col.Field);
      
      for (const order of relatedOrders) {
        const closedOrderData = {
          ...order,
          id_original: order.id,
          id_original_ordens: order.id,
          status: ['NEW', 'PARTIALLY_FILLED', 'PENDING'].includes(order.status) ? 'CANCELED' : order.status,
          last_update: new Date(),
          observacao: `${order.observacao || ''} | Movida para histórico em ${new Date().toISOString()}`.trim()
        };
        delete closedOrderData.id;

        const finalOrderData = {};
        for (const key in closedOrderData) {
          if (destOrderColumns.includes(key)) {
            finalOrderData[key] = closedOrderData[key];
          }
        }

        const columns = Object.keys(finalOrderData);
        const placeholders = columns.map(() => '?').join(', ');
        
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          Object.values(finalOrderData)
        );
      }
      
      await connection.query('DELETE FROM ordens WHERE id_posicao = ? AND conta_id = ?', [positionId, accountId]);
      console.log(`[MOVE_POSITION] ✅ ${relatedOrders.length} ordens relacionadas movidas para o histórico.`);
    }
    
    // 5. Mover a posição para o histórico (lógica dinâmica)
    const [destPosColumnsResult] = await connection.query('SHOW COLUMNS FROM posicoes_fechadas');
    const destPosColumns = destPosColumnsResult.map(col => col.Field);

    const closedPositionData = {
      ...positionToMove,
      id_original: positionToMove.id,
      status: status || 'CLOSED',
      motivo_fechamento: reason || positionToMove.observacoes || 'Fechada pelo sistema',
      data_hora_fechamento: new Date(),
      data_hora_ultima_atualizacao: new Date(),
    };
    delete closedPositionData.id;

    const finalPositionData = {};
    for (const key in closedPositionData) {
      if (destPosColumns.includes(key)) {
        finalPositionData[key] = closedPositionData[key];
      }
    }

    const posColumns = Object.keys(finalPositionData);
    const posPlaceholders = posColumns.map(() => '?').join(', ');

    await connection.query(
      `INSERT INTO posicoes_fechadas (${posColumns.join(', ')}) VALUES (${posPlaceholders})`,
      Object.values(finalPositionData)
    );
    
    await connection.query('DELETE FROM posicoes WHERE id = ? AND conta_id = ?', [positionId, accountId]);
    
    await connection.commit();
    console.log(`[MOVE_POSITION] ✅ Posição ${symbol} (ID: ${positionId}) e suas ordens foram movidas para o histórico.`);
    
    // 6. Enviar notificação Telegram (mantido como está)
    try {
      const currentPrice = await api.getPrice(symbol, accountId);
      const entryPrice = parseFloat(positionToMove.preco_entrada);
      const quantity = parseFloat(positionToMove.quantidade);
      
      if (currentPrice && entryPrice) {
        const pnl = (currentPrice - entryPrice) * quantity * (positionToMove.side === 'BUY' ? 1 : -1);
        const message = formatPositionClosedMessage(symbol, positionToMove.side, quantity, entryPrice, currentPrice, pnl);
        await sendTelegramMessage(accountId, message);
        console.log(`[MOVE_POSITION] 📱 Notificação de fechamento enviada.`);
      }
    } catch (telegramError) {
      console.warn(`[MOVE_POSITION] ⚠️ Erro ao enviar notificação:`, telegramError.message);
    }
    
    return true;
    
  } catch (error) {
    if (connection) await connection.rollback();
    console.error(`[MOVE_POSITION] ❌ Erro ao mover posição ${positionId}:`, error.message);
    return false;
  } finally {
    if (connection) connection.release();
  }
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
      const websockets = require('../api/websocket');
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
    const { getAllOpenPositions } = require('../api/rest');
    
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