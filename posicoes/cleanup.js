const { getDatabaseInstance } = require('../db/conexao');
const { getAllOpenPositions, cancelOrder } = require('../api');

/**
 * Limpa sinais órfãos e inconsistências
 */
async function cleanupOrphanSignals(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Resetar sinais em PROCESSANDO há mais de 5 minutos
    const [resetResult] = await db.query(`
      UPDATE webhook_signals 
      SET status = 'PENDING', 
          error_message = NULL,
          updated_at = NOW()
      WHERE status = 'PROCESSANDO' 
        AND conta_id = ?
        AND updated_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [accountId]);
    
    if (resetResult.affectedRows > 0) {
      console.log(`[CLEANUP] ${resetResult.affectedRows} sinais resetados para conta ${accountId}`);
    }

    // Limpar sinais com erro de "not defined"
    await db.query(`
      UPDATE webhook_signals 
      SET status = 'ERROR', 
          error_message = CONCAT(IFNULL(error_message, ''), ' | Limpo durante cleanup') 
      WHERE status = 'PENDING' 
        AND error_message LIKE '%not defined%'
        AND conta_id = ?
    `, [accountId]);

    return true;
  } catch (error) {
    console.error(`[CLEANUP] Erro ao limpar sinais órfãos:`, error.message);
    return false;
  }
}

/**
 * Força fechamento de posições detectadas como fechadas na corretora
 */
async function forceCloseGhostPositions(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Obter posições do banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);

    // Obter posições da corretora
    const exchangePositions = await getAllOpenPositions(accountId);
    const exchangePositionsMap = {};
    exchangePositions.forEach(pos => {
      exchangePositionsMap[pos.simbolo] = pos;
    });

    let closedCount = 0;
    for (const dbPos of dbPositions) {
      if (!exchangePositionsMap[dbPos.simbolo]) {
        console.log(`[CLEANUP] Posição fantasma detectada: ${dbPos.simbolo} (ID: ${dbPos.id})`);
        
        // Verificação adicional via API
        try {
          const positionDetails = await getPositionDetails(accountId, dbPos.simbolo);
          const hasOpenPosition = positionDetails && 
                                 positionDetails.some(pos => parseFloat(pos.quantidade) > 0);
          
          if (!hasOpenPosition) {
            await movePositionToHistory(db, dbPos.id, 'CLOSED', 'Fechada na corretora (detectado por cleanup)');
            console.log(`[CLEANUP] Posição ${dbPos.simbolo} movida para histórico`);
            closedCount++;
          }
        } catch (detailsError) {
          console.error(`[CLEANUP] Erro ao verificar detalhes de ${dbPos.simbolo}:`, detailsError.message);
        }
      }
    }

    if (closedCount > 0) {
      console.log(`[CLEANUP] ${closedCount} posições fantasma fechadas para conta ${accountId}`);
    }

    return closedCount;
  } catch (error) {
    console.error(`[CLEANUP] Erro ao forçar fechamento de posições fantasma:`, error.message);
    return 0;
  }
}

/**
 * Cancela ordens órfãs na corretora
 */
async function cancelOrphanOrders(accountId) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    // Buscar símbolos com posições fechadas mas ordens ainda ativas
    const [orphanOrders] = await db.query(`
      SELECT DISTINCT o.simbolo, o.id_externo
      FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.status = 'NEW' 
        AND (p.status != 'OPEN' OR p.id IS NULL)
        AND o.conta_id = ?
    `, [accountId]);

    let canceledCount = 0;
    for (const order of orphanOrders) {
      try {
        await cancelOrder(accountId, order.simbolo, order.id_externo);
        
        await db.query(`
          UPDATE ordens SET status = 'CANCELED_CLEANUP', last_update = NOW() 
          WHERE id_externo = ?
        `, [order.id_externo]);
        
        console.log(`[CLEANUP] Ordem órfã cancelada: ${order.id_externo}`);
        canceledCount++;
      } catch (cancelError) {
        console.error(`[CLEANUP] Erro ao cancelar ordem órfã ${order.id_externo}:`, cancelError.message);
      }
    }

    if (canceledCount > 0) {
      console.log(`[CLEANUP] ${canceledCount} ordens órfãs canceladas para conta ${accountId}`);
    }

    return canceledCount;
  } catch (error) {
    console.error(`[CLEANUP] Erro ao cancelar ordens órfãs:`, error.message);
    return 0;
  }
}

module.exports = {
  cleanupOrphanSignals,
  forceCloseGhostPositions,
  cancelOrphanOrders
};