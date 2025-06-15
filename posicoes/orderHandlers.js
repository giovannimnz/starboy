const { getDatabaseInstance } = require('../db/conexao');

/**
 * Processa atualizações de ordens via WebSocket
 * @param {Object} orderMsg - Mensagem de ordem do WebSocket
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function handleOrderUpdate(orderMsg, db, accountId) {
  try {
    if (!db) {
      console.error(`[ORDER] Banco de dados não disponível para conta ${accountId}`);
      return;
    }
    
    // Buscar a ordem no banco de dados
    const [orders] = await db.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderMsg.i, orderMsg.s, accountId]
    );

    // Se ordem não encontrada mas está executada na corretora
    if (orders.length === 0 && (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      console.log(`[ORDER] Ordem ${orderMsg.i} executada na corretora mas não encontrada no banco - possivelmente externa`);
      return;
    }

    if (orders.length === 0) {
      console.log(`[ORDER] Ordem ${orderMsg.i} não encontrada no banco de dados para conta ${accountId}`);
      return;
    }

    const order = orders[0];

    // Processar diferentes tipos de atualização
    if (order.tipo_ordem_bot === 'ENTRADA' &&
        (orderMsg.X === 'NEW' || orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      
      console.log(`[ORDER] Ordem de entrada ${orderMsg.i} atualizada: ${orderMsg.X}`);
      
      // Atualizar status no banco
      await db.query(
        'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ?',
        [orderMsg.X, orderMsg.i]
      );
    } else if (orderMsg.X === 'CANCELED') {
      console.log(`[ORDER] Ordem ${orderMsg.i} cancelada`);
      
      // Atualizar status no banco
      await db.query(
        'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ?',
        [orderMsg.X, orderMsg.i]
      );
    }

  } catch (error) {
    console.error(`[ORDER] Erro ao processar atualização de ordem (OrderID: ${orderMsg.i}): ${error.message}`);
  }
}

/**
 * Processa atualizações de conta via WebSocket
 * @param {Object} message - Mensagem de conta do WebSocket
 * @param {Object} db - Conexão com banco
 * @param {number} accountId - ID da conta
 */
async function handleAccountUpdate(message, db, accountId) {
  try {
    // Se não houver conexão com o banco, tentar estabelecer
    if (!db) {
      console.warn(`[ACCOUNT] Banco de dados não disponível para conta ${accountId}`);
      return;
    }

    // Verificar se há atualizações de posição no evento
    if (message.a && message.a.P) {
      console.log(`[ACCOUNT] Atualização de posições recebida para conta ${accountId}:`, message.a.P.length, 'posições');
      
      // Processar cada posição atualizada
      for (const position of message.a.P) {
        const symbol = position.s;
        const positionAmt = parseFloat(position.pa);
        const entryPrice = parseFloat(position.ep);
        const unrealizedPnl = parseFloat(position.up);
        
        // Se a posição foi fechada (quantidade = 0)
        if (positionAmt === 0) {
          console.log(`[ACCOUNT] Posição ${symbol} foi fechada`);
          
          // Atualizar no banco de dados se necessário
          try {
            await db.query(
              `UPDATE posicoes SET status = 'CLOSED', 
               data_hora_fechamento = NOW(), 
               data_hora_ultima_atualizacao = NOW() 
               WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
              [symbol, accountId]
            );
          } catch (updateError) {
            console.error(`[ACCOUNT] Erro ao atualizar posição fechada ${symbol}:`, updateError);
          }
        }
      }
    } else {
      // Log mais simples para outras atualizações de conta
      console.log(`[ACCOUNT] Atualização de conta recebida para conta ${accountId} (sem posições)`);
    }

  } catch (error) {
    console.error(`[ACCOUNT] Erro ao processar atualização da conta ${accountId}:`, error);
  }
}

module.exports = {
  handleOrderUpdate,
  handleAccountUpdate
};