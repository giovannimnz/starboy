const { getDatabaseInstance } = require('../db/conexao');
const { checkOrderTriggers } = require('./trailingStopLoss');
const { checkExpiredSignals } = require('./signalTimeout');
const { cleanupOrphanSignals, forceCloseGhostPositions } = require('./cleanup');
const websockets = require('../websockets');

/**
 * Atualiza preços das posições com trailing stop
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ENHANCED] AccountId inválido: ${accountId}`);
      return;
    }
    
    // Buscar posições abertas para o símbolo
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      // Atualizar preço corrente
      await db.query(`
        UPDATE posicoes 
        SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
        WHERE id = ?
      `, [currentPrice, position.id]);
      
      // Verificar trailing stops
      try {
        await checkOrderTriggers(db, position, currentPrice, accountId);
      } catch (trailingError) {
        console.error(`[ENHANCED] Erro no trailing stop para posição ${position.id}:`, trailingError.message);
      }
    }
    
  } catch (error) {
    console.error(`[ENHANCED] Erro ao atualizar preços para ${symbol} conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ ATUALIZAÇÃO COMPLETA DE PREÇOS COM TRAILING E GATILHOS
 * Combina todas as verificações de preço em uma só função
 */
async function updatePositionPricesWithTrailing(db, symbol, currentPrice, accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ENHANCED] AccountId inválido: ${accountId}`);
      return;
    }
    
    // ✅ 1. VERIFICAR GATILHOS DE ENTRADA PRIMEIRO
    const { checkSignalTriggers } = require('./priceMonitoring');
    await checkSignalTriggers(symbol, currentPrice, db, accountId);
    
    // ✅ 2. ATUALIZAR PREÇOS DAS POSIÇÕES
    const [positions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    for (const position of positions) {
      // Atualizar preço corrente
      await db.query(`
        UPDATE posicoes 
        SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
        WHERE id = ?
      `, [currentPrice, position.id]);
      
      // ✅ 3. VERIFICAR TRAILING STOPS
      try {
        const { checkOrderTriggers } = require('./trailingStopLoss');
        await checkOrderTriggers(db, position, currentPrice, accountId);
      } catch (trailingError) {
        console.error(`[ENHANCED] Erro no trailing stop para posição ${position.id}:`, trailingError.message);
      }
    }
    
    // ✅ 4. LOG PERIÓDICO (APENAS A CADA MINUTO)
    const now = Date.now();
    const lastLogKey = `${symbol}_${accountId}`;
    if (!global.lastPriceLog) global.lastPriceLog = {};
    
    if (!global.lastPriceLog[lastLogKey] || (now - global.lastPriceLog[lastLogKey]) > 60000) {
      if (positions.length > 0) {
        console.log(`[ENHANCED] 📊 ${symbol} @ ${currentPrice} - ${positions.length} posições ativas (conta ${accountId})`);
      }
      global.lastPriceLog[lastLogKey] = now;
    }
    
  } catch (error) {
    console.error(`[ENHANCED] ❌ Erro ao atualizar preços para ${symbol} conta ${accountId}:`, error.message);
  }
}

/**
 * Job de limpeza periódica
 */
async function runPeriodicCleanup(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[CLEANUP] AccountId inválido: ${accountId}`);
      return;
    }
    
    //console.log(`[CLEANUP] Executando limpeza periódica para conta ${accountId}...`);
    
    // Verificar sinais expirados
    await checkExpiredSignals(accountId);
    
    // Limpar sinais órfãos
    await cleanupOrphanSignals(accountId);
    
    // A cada 10 minutos, verificar posições fantasma
    const now = new Date();
    if (now.getMinutes() % 10 === 0) {
      await forceCloseGhostPositions(accountId);
    }
    
    //console.log(`[CLEANUP] ✅ Limpeza periódica concluída para conta ${accountId}`);
  } catch (error) {
    console.error(`[CLEANUP] Erro na limpeza periódica para conta ${accountId}:`, error.message);
  }
}

/**
 * Monitora saúde dos WebSockets
 */
function monitorWebSocketHealth(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[HEALTH] AccountId inválido: ${accountId}`);
      return;
    }
    
    console.log(`[HEALTH] Verificando saúde dos WebSockets para conta ${accountId}...`);
    
    const isApiConnected = websockets.isWebSocketApiConnected(accountId);
    const isApiAuthenticated = websockets.isWebSocketApiAuthenticated(accountId);
    
    console.log(`[HEALTH] Conta ${accountId}:`);
    console.log(`  - WebSocket API conectado: ${isApiConnected ? '✅' : '❌'}`);
    console.log(`  - WebSocket API autenticado: ${isApiAuthenticated ? '✅' : '❌'}`);
    
    // Reconectar se necessário
    if (!isApiConnected || !isApiAuthenticated) {
      console.log(`[HEALTH] ⚠️ Problemas detectados na conta ${accountId}, tentando reconectar...`);
      websockets.startWebSocketApi(accountId).catch(error => {
        console.error(`[HEALTH] Erro ao reconectar conta ${accountId}:`, error.message);
      });
    }
    
  } catch (error) {
    console.error(`[HEALTH] Erro ao monitorar WebSockets para conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ FUNÇÃO COMPLETA DE MONITORAMENTO COMO NO _DEV
 * Combina trailing stops, verificação de posições fechadas e limpeza
 */
async function runAdvancedPositionMonitoring(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ADVANCED_MONITOR] AccountId inválido: ${accountId}`);
      return;
    }
    
    console.log(`[ADVANCED_MONITOR] 🔄 Executando monitoramento avançado para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    const api = require('../api');
    const { movePositionToHistory } = require('./positionHistory');
    
    // ✅ 1. VERIFICAR POSIÇÕES ABERTAS NO BANCO
    const [openPositions] = await db.query(`
      SELECT * FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    if (openPositions.length === 0) {
      console.log(`[ADVANCED_MONITOR] ℹ️ Nenhuma posição aberta para conta ${accountId}`);
      return;
    }
    
    console.log(`[ADVANCED_MONITOR] 📊 Monitorando ${openPositions.length} posições para conta ${accountId}`);
    
    // ✅ 2. OBTER POSIÇÕES DA CORRETORA PARA COMPARAÇÃO
    const exchangePositions = await api.getAllOpenPositions(accountId);
    const exchangePositionsMap = new Map();
    exchangePositions.forEach(pos => {
      exchangePositionsMap.set(pos.simbolo, pos);
    });
    
    let checkedCount = 0;
    let closedCount = 0;
    
    // ✅ 3. VERIFICAR CADA POSIÇÃO
    for (const position of openPositions) {
      try {
        checkedCount++;
        
        // Verificar se posição ainda existe na corretora
        const exchangePos = exchangePositionsMap.get(position.simbolo);
        
        if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
          console.log(`[ADVANCED_MONITOR] 🔄 Posição ${position.simbolo} fechada na corretora, movendo para histórico...`);
          
          const moved = await movePositionToHistory(
            db, 
            position.id, 
            'CLOSED', 
            'Monitoramento automático - posição fechada na corretora',
            accountId
          );
          
          if (moved) {
            closedCount++;
          }
          
          continue; // Pular verificações de trailing para posição fechada
        }
        
        // ✅ 4. OBTER PREÇO ATUAL E VERIFICAR TRAILING STOPS
        const currentPrice = await api.getPrice(position.simbolo, accountId);
        
        if (currentPrice && currentPrice > 0) {
          // Atualizar preço corrente no banco
          await db.query(`
            UPDATE posicoes 
            SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
            WHERE id = ?
          `, [currentPrice, position.id]);
          
          // Verificar trailing stops
          const { checkOrderTriggers } = require('./trailingStopLoss');
          await checkOrderTriggers(db, position, currentPrice, accountId);
          
          console.log(`[ADVANCED_MONITOR] ✅ ${position.simbolo} @ ${currentPrice} - trailing verificado`);
        }
        
        // Pequena pausa entre verificações
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (posError) {
        console.error(`[ADVANCED_MONITOR] ❌ Erro ao verificar posição ${position.simbolo}:`, posError.message);
      }
    }
    
    console.log(`[ADVANCED_MONITOR] ✅ Monitoramento concluído para conta ${accountId}:`);
    console.log(`[ADVANCED_MONITOR]   - Posições verificadas: ${checkedCount}`);
    console.log(`[ADVANCED_MONITOR]   - Posições movidas para histórico: ${closedCount}`);
    
  } catch (error) {
    console.error(`[ADVANCED_MONITOR] ❌ Erro no monitoramento avançado para conta ${accountId}:`, error.message);
  }
}

/**
 * ✅ VERIFICAÇÃO ESPECÍFICA DE ORDERS E POSIÇÕES COMO NO _DEV
 */
async function logOpenPositionsAndOrders(accountId) {
  try {
    const db = await getDatabaseInstance();
    const api = require('../api');
    
    if (!db) {
      console.error(`[LOG_STATUS] Não foi possível conectar ao banco para conta ${accountId}`);
      return;
    }

    // Obter posições abertas do banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, preco_entrada, preco_corrente, side 
      FROM posicoes WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    // Obter ordens pendentes
    const [pendingOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, tipo_ordem, preco, quantidade, status, side 
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = ?
      ORDER BY simbolo, tipo_ordem_bot
    `, [accountId]);

    // Obter posições abertas da corretora para comparação
    const exchangePositions = await api.getAllOpenPositions(accountId);
    
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
    console.error(`[LOG_STATUS] Erro ao obter posições e ordens para conta ${accountId}:`, error);
  }
}

// ✅ ATUALIZAR module.exports:
module.exports = {
  updatePositionPricesWithTrailing,
  runPeriodicCleanup,
  monitorWebSocketHealth,
  runAdvancedPositionMonitoring, // ✅ NOVA
  logOpenPositionsAndOrders       // ✅ NOVA
};