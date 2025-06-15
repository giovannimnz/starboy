const { getDatabaseInstance, moveClosedPositionsAndOrders } = require('../db/conexao');
const { getAllOpenPositions } = require('../api');

/**
 * Sincroniza posições entre banco de dados e corretora
 * @param {number} accountId - ID da conta
 */
async function syncPositionsWithExchange(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[SYNC] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Obter posições abertas do banco
    const [dbPositions] = await db.query(
      `SELECT id, simbolo, quantidade FROM posicoes WHERE status = 'OPEN' AND conta_id = ?`,
      [accountId]
    );

    // Obter posições da corretora
    const exchangePositions = await getAllOpenPositions(accountId);

    console.log(`[SYNC] Verificando ${dbPositions.length} posições no banco vs ${exchangePositions.length} na corretora (conta ${accountId})...`);

    // Mapear posições da corretora por símbolo
    const exchangePositionsMap = {};
    exchangePositions.forEach(pos => {
      exchangePositionsMap[pos.simbolo] = pos;
    });

    // Verificar posições que existem no banco mas não na corretora (fechadas)
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositionsMap[dbPos.simbolo];
      
      if (!exchangePos || Math.abs(exchangePos.quantidade) < 0.000001) {
        console.log(`[SYNC] Posição ${dbPos.simbolo} (ID: ${dbPos.id}) fechada na corretora mas aberta no banco`);
        
        try {
          // Mover para histórico
          await moveClosedPositionsAndOrders(db, dbPos.id, 'CLOSED', 'Fechada na corretora (sincronização)');
        } catch (moveError) {
          console.error(`[SYNC] Erro ao mover posição ${dbPos.id} para histórico:`, moveError);
        }
      }
    }

    // Verificar posições que existem na corretora mas não no banco
    for (const pos of exchangePositions) {
      const dbPos = dbPositions.find(dp => dp.simbolo === pos.simbolo);
      
      if (!dbPos) {
        console.log(`[SYNC] Posição ${pos.simbolo} existe na corretora mas não no banco (posição externa)`);
        // Não criar automaticamente - pode ser posição manual
      }
    }

  } catch (error) {
    console.error(`[SYNC] Erro crítico ao sincronizar posições para conta ${accountId}:`, error);
  }
}

/**
 * Exibe log de posições abertas e ordens pendentes
 * @param {number} accountId - ID da conta
 */
async function logOpenPositionsAndOrders(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[LOG] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Obter posições abertas do banco
    const [dbPositions] = await db.query(
      `SELECT id, simbolo, quantidade, preco_entrada, preco_corrente, side 
       FROM posicoes WHERE status = 'OPEN' AND conta_id = ?`,
      [accountId]
    );
    
    // Obter ordens pendentes
    const [pendingOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, tipo_ordem, preco, quantidade, status, side 
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = ?
      ORDER BY simbolo, tipo_ordem_bot
    `, [accountId]);

    // Obter posições abertas da corretora
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