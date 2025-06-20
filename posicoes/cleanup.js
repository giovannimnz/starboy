const { getDatabaseInstance } = require('../db/conexao');
const { getAllOpenPositions, cancelOrder } = require('../api');

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
      WHERE error_message LIKE '%not defined%' 
        AND conta_id = ?
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
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    if (dbPositions.length === 0) {
      return 0;
    }
    
    // Obter posições abertas na corretora
    const exchangePositions = await getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // Posição não existe na corretora ou tem quantidade zero
        await db.query(`
          UPDATE posicoes 
          SET status = 'CLOSED', 
              data_hora_fechamento = NOW(),
              observacao = 'Fechada via cleanup - não encontrada na corretora'
          WHERE id = ?
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
 * Cancela ordens órfãs na corretora e atualiza status no banco
 */
async function cancelOrphanOrders(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return 0;
    }
    
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR ORDENS QUE PODEM ESTAR ÓRFÃS
    const [potentialOrphanOrders] = await db.query(`
      SELECT id_externo, simbolo, tipo_ordem_bot, quantidade, preco, status, id_posicao
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED', 'PENDING_CANCEL')
        AND conta_id = ?
        AND last_update < DATE_SUB(NOW(), INTERVAL 5 MINUTE)
    `, [accountId]);
    
    if (potentialOrphanOrders.length === 0) {
      console.log(`[CLEANUP] Nenhuma ordem órfã encontrada para conta ${accountId}`);
      return 0;
    }
    
    console.log(`[CLEANUP] 🔍 Verificando ${potentialOrphanOrders.length} ordens potencialmente órfãs para conta ${accountId}...`);
    
    let canceledCount = 0;
    let updatedCount = 0;
    
    for (const order of potentialOrphanOrders) {
      try {
        // ✅ TENTAR CANCELAR NA CORRETORA
        await cancelOrder(order.simbolo, order.id_externo, accountId);
        
        // ✅ SE CHEGOU AQUI, ORDEM AINDA EXISTIA E FOI CANCELADA
        console.log(`[CLEANUP] ✅ Ordem ${order.id_externo} cancelada na corretora`);
        
        await db.query(`
          UPDATE ordens 
          SET status = 'CANCELED', 
              last_update = NOW()
          WHERE id_externo = ? AND conta_id = ?
        `, [order.id_externo, accountId]);
        
        canceledCount++;
        
      } catch (cancelError) {
        // ✅ VERIFICAR SE É ERRO "ORDEM NÃO EXISTE"
        if (cancelError.message.includes('Unknown order sent') || 
            cancelError.message.includes('Order does not exist')) {
          
          console.log(`[CLEANUP] ✅ Ordem ${order.id_externo} confirmada como já cancelada/executada na corretora`);
          
          // ✅ MARCAR COMO CANCELED NO BANCO (porque não existe mais na corretora)
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', 
                last_update = NOW(),
                observacao = 'Órfã - não existe na corretora'
            WHERE id_externo = ? AND conta_id = ?
          `, [order.id_externo, accountId]);
          
          updatedCount++;
          
        } else {
          // ✅ ERRO REAL DE CANCELAMENTO
          console.error(`[CLEANUP] ❌ Erro real ao cancelar ordem ${order.id_externo}:`, cancelError.message);
        }
      }
    }
    
    console.log(`[CLEANUP] 📊 Resumo para conta ${accountId}:`);
    console.log(`  - Ordens canceladas na corretora: ${canceledCount}`);
    console.log(`  - Ordens órfãs marcadas como CANCELED: ${updatedCount}`);
    
    // ✅ MOVER ORDENS CANCELED PARA HISTÓRICO
    if (canceledCount > 0 || updatedCount > 0) {
      const movedToHistory = await moveOrdersToHistory(accountId);
      console.log(`[CLEANUP] 📚 ${movedToHistory} ordens movidas para ordens_fechadas`);
    }
    
    return canceledCount + updatedCount;
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro ao cancelar ordens órfãs para conta ${accountId}:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO MELHORADA: Mover ordens para histórico (CANCELED + FILLED órfãs)
 */
async function moveOrdersToHistory(accountId) {
  try {
    const db = await getDatabaseInstance();
    
    // ✅ BUSCAR ORDENS PARA MOVER (CANCELED + FILLED órfãs)
    const [ordersToMove] = await db.query(`
      SELECT o.*, p.status as position_status FROM ordens o
      LEFT JOIN posicoes p ON o.id_posicao = p.id
      WHERE o.conta_id = ? 
        AND (
          (o.status = 'CANCELED' AND o.last_update > DATE_SUB(NOW(), INTERVAL 1 HOUR))
          OR 
          (o.status = 'FILLED' AND (p.id IS NULL OR p.status != 'OPEN') AND o.last_update < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
        )
    `, [accountId]);
    
    if (ordersToMove.length === 0) {
      return 0;
    }
    
    const canceledOrders = ordersToMove.filter(o => o.status === 'CANCELED');
    const orphanFilledOrders = ordersToMove.filter(o => o.status === 'FILLED');
    
    console.log(`[CLEANUP] 📚 Movendo para histórico:`);
    console.log(`  - ${canceledOrders.length} ordens CANCELED`);
    console.log(`  - ${orphanFilledOrders.length} ordens FILLED órfãs`);
    
    const connection = await db.getConnection();
    await connection.beginTransaction();
    
    try {
      // ✅ VERIFICAR SE TABELA DESTINO TEM COLUNAS NECESSÁRIAS
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
      let movedCount = 0;
      
      for (const order of ordersToMove) {
        // ✅ PREPARAR DADOS PARA INSERÇÃO
        const insertData = {
          tipo_ordem: order.tipo_ordem,
          preco: order.preco,
          quantidade: order.quantidade,
          id_posicao: order.id_posicao,
          status: order.status,
          data_hora_criacao: order.data_hora_criacao,
          id_externo: order.id_externo,
          side: order.side,
          simbolo: order.simbolo,
          tipo_ordem_bot: order.tipo_ordem_bot,
          target: order.target,
          reduce_only: order.reduce_only,
          close_position: order.close_position,
          last_update: order.last_update,
          conta_id: order.conta_id,
          preco_executado: order.preco_executado || 0,
          quantidade_executada: order.quantidade_executada || 0,
          observacao: order.observacao || 
            (order.status === 'CANCELED' ? 'Movida via cleanup - órfã' : 'Movida automaticamente - posição fechada')
        };
        
        // ✅ ADICIONAR CAMPOS OPCIONAIS SE EXISTIREM
        if (destColumnNames.includes('orign_sig') && order.orign_sig) {
          insertData.orign_sig = order.orign_sig;
        }
        if (destColumnNames.includes('dados_originais_ws') && order.dados_originais_ws) {
          insertData.dados_originais_ws = order.dados_originais_ws;
        }
        
        // ✅ CONSTRUIR QUERY DINÂMICA
        const columns = Object.keys(insertData).filter(key => 
          destColumnNames.includes(key) && insertData[key] !== undefined
        );
        const values = columns.map(col => insertData[col]);
        const placeholders = columns.map(() => '?').join(', ');
        
        // ✅ INSERIR NA TABELA FECHADAS
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        
        // ✅ REMOVER DA TABELA ATIVA
        await connection.query(
          'DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?',
          [order.id_externo, accountId]
        );
        
        movedCount++;
      }
      
      await connection.commit();
      console.log(`[CLEANUP] ✅ ${movedCount} ordens movidas para histórico com sucesso`);
      
      return movedCount;
      
    } catch (moveError) {
      await connection.rollback();
      console.error(`[CLEANUP] ❌ Erro ao mover ordens para histórico:`, moveError.message);
      throw moveError;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    console.error(`[CLEANUP] ❌ Erro na função moveOrdersToHistory:`, error.message);
    return 0;
  }
}

module.exports = {
  cleanupOrphanSignals,
  forceCloseGhostPositions,
  cancelOrphanOrders,      // ✅ ESTA LINHA DEVE EXISTIR
  moveOrdersToHistory      // ✅ ADICIONAR SE AINDA NÃO EXISTE
};