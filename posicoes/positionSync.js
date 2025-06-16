const { getDatabaseInstance, moveClosedPositionsAndOrders } = require('../db/conexao');
const { getAllOpenPositions } = require('../api');

/**
 * Sincroniza posições do banco com a corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da sincronização
 */
async function syncPositionsWithExchange(accountId) {
  try {
    // CORREÇÃO CRÍTICA: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em syncPositionsWithExchange: ${accountId} (tipo: ${typeof accountId})`);
    }

    console.log(`[SYNC] Iniciando sincronização de posições para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error(`Falha ao conectar ao banco para conta ${accountId}`);
    }

    // CORREÇÃO CRÍTICA: Chamar getAllOpenPositions apenas com accountId (número)
    const exchangePositions = await getAllOpenPositions(accountId);
    
    console.log(`[SYNC] Obtidas ${exchangePositions.length} posições da corretora para conta ${accountId}`);

    // Obter posições do banco de dados
    const [dbPositions] = await db.query(`
      SELECT 
        id, simbolo, quantidade, preco_medio, side, status,
        preco_entrada, preco_corrente, leverage
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
      ORDER BY simbolo
    `, [accountId]);

    console.log(`[SYNC] Encontradas ${dbPositions.length} posições no banco para conta ${accountId}`);

    let syncResults = {
      exchangePositions: exchangePositions.length,
      dbPositions: dbPositions.length,
      missingInDb: 0,
      missingInExchange: 0,
      updated: 0,
      errors: []
    };

    // Verificar posições que existem na corretora mas não no banco
    for (const exchangePos of exchangePositions) {
      const dbPos = dbPositions.find(p => p.simbolo === exchangePos.simbolo);
      
      if (!dbPos) {
        console.warn(`[SYNC] Posição ${exchangePos.simbolo} existe na corretora mas não no banco (conta ${accountId})`);
        syncResults.missingInDb++;
        
        // Opcional: Criar posição no banco automaticamente
        try {
          await db.query(`
            INSERT INTO posicoes (
              simbolo, quantidade, preco_medio, side, status, 
              preco_entrada, preco_corrente, leverage, conta_id,
              data_hora_abertura, data_hora_ultima_atualizacao
            ) VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, NOW(), NOW())
          `, [
            exchangePos.simbolo,
            parseFloat(exchangePos.quantidade),
            parseFloat(exchangePos.precoEntrada),
            exchangePos.lado,
            parseFloat(exchangePos.precoEntrada),
            parseFloat(exchangePos.precoAtual),
            parseInt(exchangePos.alavancagem || 1),
            accountId
          ]);
          
          console.log(`[SYNC] ✅ Posição ${exchangePos.simbolo} criada no banco para conta ${accountId}`);
          syncResults.updated++;
        } catch (createError) {
          console.error(`[SYNC] Erro ao criar posição ${exchangePos.simbolo} no banco:`, createError.message);
          syncResults.errors.push(`Erro ao criar ${exchangePos.simbolo}: ${createError.message}`);
        }
      } else {
        // Atualizar preço corrente se a posição já existe
        try {
          await db.query(`
            UPDATE posicoes 
            SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
            WHERE id = ?
          `, [parseFloat(exchangePos.precoAtual), dbPos.id]);
          
          syncResults.updated++;
        } catch (updateError) {
          console.error(`[SYNC] Erro ao atualizar posição ${dbPos.simbolo}:`, updateError.message);
          syncResults.errors.push(`Erro ao atualizar ${dbPos.simbolo}: ${updateError.message}`);
        }
      }
    }

    // Verificar posições que existem no banco mas não na corretora
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos) {
        console.warn(`[SYNC] Posição ${dbPos.simbolo} existe no banco mas não na corretora (conta ${accountId})`);
        syncResults.missingInExchange++;
        
        // Opcional: Marcar como fechada no banco
        try {
          await db.query(`
            UPDATE posicoes 
            SET status = 'CLOSED', data_hora_fechamento = NOW()
            WHERE id = ?
          `, [dbPos.id]);
          
          console.log(`[SYNC] ✅ Posição ${dbPos.simbolo} marcada como fechada no banco (conta ${accountId})`);
          syncResults.updated++;
        } catch (closeError) {
          console.error(`[SYNC] Erro ao fechar posição ${dbPos.simbolo} no banco:`, closeError.message);
          syncResults.errors.push(`Erro ao fechar ${dbPos.simbolo}: ${closeError.message}`);
        }
      }
    }

    console.log(`[SYNC] ✅ Sincronização concluída para conta ${accountId}:`, syncResults);
    return syncResults;

  } catch (error) {
    console.error(`[SYNC] Erro crítico ao sincronizar posições para conta ${accountId}:`, error);
    throw error;
  }
}

/**
 * Exibe log de posições abertas e ordens pendentes
 * @param {number} accountId - ID da conta
 */
async function logOpenPositionsAndOrders(accountId) {
  try {
    // CORREÇÃO: Validar accountId
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[LOG] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    const db = await getDatabaseInstance();
    if (!db) {
      console.error(`[LOG] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Obter posições do banco
    const [dbPositions] = await db.query(`
      SELECT simbolo, quantidade, side, preco_entrada, preco_corrente, status
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
      ORDER BY simbolo
    `, [accountId]);

    // Obter ordens pendentes
    const [pendingOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, side, quantidade, preco, status
      FROM ordens 
      WHERE status IN ('NEW', 'OPEN') AND conta_id = ?
      ORDER BY simbolo, tipo_ordem_bot
    `, [accountId]);

    // CORREÇÃO: Chamar getAllOpenPositions apenas com accountId
    const exchangePositions = await getAllOpenPositions(accountId);

    console.log('\n=== POSIÇÕES ABERTAS E ORDENS PENDENTES ===');
    console.log(`[MONITOR] Posições no banco: ${dbPositions.length} | Posições na corretora: ${exchangePositions.length}`);
    
    // Mostrar posições do banco
    if (dbPositions.length > 0) {
      console.log('\n📊 Posições no Banco:');
      dbPositions.forEach(pos => {
        console.log(`  ${pos.simbolo}: ${pos.quantidade} (${pos.side}) @ ${pos.preco_entrada} | Atual: ${pos.preco_corrente}`);
      });
    }
    
    // Mostrar posições da corretora
    if (exchangePositions.length > 0) {
      console.log('\n🏦 Posições na Corretora:');
      exchangePositions.forEach(pos => {
        console.log(`  ${pos.simbolo}: ${pos.quantidade} (${pos.lado}) @ ${pos.precoEntrada} | Mark: ${pos.precoAtual}`);
      });
    }
    
    // Mostrar ordens pendentes
    if (pendingOrders.length > 0) {
      console.log('\n📋 Ordens Pendentes:');
      pendingOrders.forEach(order => {
        console.log(`  ${order.simbolo}: ${order.tipo_ordem_bot} ${order.side} ${order.quantidade} @ ${order.preco} (${order.status})`);
      });
    }
    
    console.log('===========================================\n');
  } catch (error) {
    console.error(`[LOG] Erro ao obter posições e ordens para conta ${accountId}:`, error);
  }
}

module.exports = {
  syncPositionsWithExchange,
  logOpenPositionsAndOrders
};