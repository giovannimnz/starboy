const { getDatabaseInstance, moveClosedPositionsAndOrders } = require('../../../core/database/conexao');
const { getAllOpenPositions, getOpenOrders } = require('../api/rest');

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

    // CORREÇÃO CRÍTICA: Log de debug antes da chamada
    console.log(`[SYNC] Chamando getAllOpenPositions com accountId: ${accountId} (tipo: ${typeof accountId})`);
    
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
async function logOpenPositionsAndOrdersVisual(accountId) {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Obter posições abertas do banco
    const [dbPositions] = await db.query(`SELECT id, simbolo, quantidade, preco_entrada, preco_corrente, side FROM posicoes WHERE status = 'OPEN'${accountId ? ' AND conta_id = ?' : ''}`, accountId ? [accountId] : []);
    
    // Obter ordens pendentes
    const [pendingOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, tipo_ordem, preco, quantidade, status, side 
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED')${accountId ? ' AND conta_id = ?' : ''}
      ORDER BY simbolo, tipo_ordem_bot
    `, accountId ? [accountId] : []);

    // Obter posições abertas da corretora para comparação
    const exchangePositions = await getAllOpenPositions(accountId);

    // Barra visual
    const bar = (count, emoji) => count > 0 ? emoji.repeat(Math.min(count, 20)) : '';
    const pad = (str, len) => (str + ' '.repeat(len)).slice(0, len);

    console.log('\n=== 📊 VISUALIZAÇÃO DE POSIÇÕES E ORDENS ===');
    console.log(
      `Banco:   |${bar(dbPositions.length, '🟩')}${pad('', 20 - dbPositions.length)}| ${dbPositions.length} posições`
    );
    console.log(
      `Corretora:|${bar(exchangePositions.length, '🟦')}${pad('', 20 - exchangePositions.length)}| ${exchangePositions.length} posições`
    );
    console.log(
      `Ordens:  |${bar(pendingOrders.length, '🟨')}${pad('', 20 - pendingOrders.length)}| ${pendingOrders.length} pendentes`
    );
    console.log('-------------------------------------------');

    // Mostrar detalhes (opcional)
    if (dbPositions.length > 0) {
      console.log('\n📊 Posições no Banco:');
      dbPositions.forEach(pos => {
        console.log(`  ${pad(pos.simbolo, 8)} | ${pad(pos.side, 4)} | ${pad(pos.quantidade, 8)} @ ${pad(pos.preco_entrada, 10)} | Atual: ${pos.preco_corrente}`);
      });
    }
    if (exchangePositions.length > 0) {
      console.log('\n🏦 Posições na Corretora:');
      exchangePositions.forEach(pos => {
        console.log(`  ${pad(pos.simbolo, 8)} | ${pad(pos.side, 4)} | ${pad(pos.quantidade, 8)} @ ${pad(pos.preco_entrada, 10)}`);
      });
    }
    if (pendingOrders.length > 0) {
      console.log('\n📋 Ordens Pendentes:');
      pendingOrders.forEach(order => {
        console.log(`  ${pad(order.simbolo, 8)} | ${pad(order.tipo_ordem_bot, 10)} | ${pad(order.side, 4)} | ${pad(order.quantidade, 8)} @ ${pad(order.preco, 10)} (${order.status})`);
      });
    }
    console.log('===========================================\n');
  } catch (error) {
    console.error('[MONITOR] Erro ao obter posições e ordens:', error);
  }
}

/**
 * ✅ SINCRONIZAÇÃO AVANÇADA COM MOVIMENTAÇÃO AUTOMÁTICA
 * Baseada na versão do _dev
 */
async function syncPositionsWithAutoClose(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em syncPositionsWithAutoClose: ${accountId}`);
    }

    console.log(`[SYNC_AUTO] 🔄 Iniciando sincronização avançada para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    const { movePositionToHistory } = require('./positionHistory');
    
    // Obter posições do banco e corretora
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, side, status, preco_entrada, preco_corrente
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
      ORDER BY simbolo
    `, [accountId]);

    const exchangePositions = await getAllOpenPositions(accountId);
    
    console.log(`[SYNC_AUTO] 📊 Banco: ${dbPositions.length} posições | Corretora: ${exchangePositions.length} posições`);

    let syncResults = {
      checked: dbPositions.length,
      movedToHistory: 0,
      updatedPrices: 0,
      errors: []
    };

    // Criar mapa de posições da corretora para busca rápida
    const exchangeMap = new Map();
    exchangePositions.forEach(pos => {
      exchangeMap.set(pos.simbolo, pos);
    });

    // Verificar cada posição do banco
    for (const dbPos of dbPositions) {
      const exchangePos = exchangeMap.get(dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        // POSIÇÃO NÃO EXISTE MAIS NA CORRETORA - MOVER PARA HISTÓRICO
        console.log(`[SYNC_AUTO] 🔄 Posição ${dbPos.simbolo} fechada na corretora, movendo para histórico...`);
        
        try {
          const moved = await movePositionToHistory(
            db, 
            dbPos.id, 
            'CLOSED', 
            'Sincronização automática - posição não encontrada na corretora',
            accountId
          );
          
          if (moved) {
            syncResults.movedToHistory++;
            console.log(`[SYNC_AUTO] ✅ Posição ${dbPos.simbolo} movida para histórico`);
          } else {
            syncResults.errors.push(`Falha ao mover ${dbPos.simbolo} para histórico`);
          }
          
        } catch (moveError) {
          console.error(`[SYNC_AUTO] ❌ Erro ao mover ${dbPos.simbolo}:`, moveError.message);
          syncResults.errors.push(`Erro ao mover ${dbPos.simbolo}: ${moveError.message}`);
        }
        
      } else {
        // POSIÇÃO EXISTE - ATUALIZAR PREÇO CORRENTE SE NECESSÁRIO
        const currentExchangePrice = parseFloat(exchangePos.precoAtual);
        const dbCurrentPrice = parseFloat(dbPos.preco_corrente || 0);
        
        if (Math.abs(currentExchangePrice - dbCurrentPrice) > 0.001) {
          try {
            await db.query(`
              UPDATE posicoes 
              SET preco_corrente = ?, data_hora_ultima_atualizacao = NOW()
              WHERE id = ?
            `, [currentExchangePrice, dbPos.id]);
            
            syncResults.updatedPrices++;
            console.log(`[SYNC_AUTO] 📊 Preço atualizado para ${dbPos.simbolo}: ${dbCurrentPrice} → ${currentExchangePrice}`);
            
          } catch (updateError) {
            console.error(`[SYNC_AUTO] ❌ Erro ao atualizar preço ${dbPos.simbolo}:`, updateError.message);
            syncResults.errors.push(`Erro ao atualizar preço ${dbPos.simbolo}: ${updateError.message}`);
          }
        }
      }
    }

    console.log(`[SYNC_AUTO] ✅ Sincronização avançada concluída para conta ${accountId}:`);
    console.log(`[SYNC_AUTO]   - Posições verificadas: ${syncResults.checked}`);
    console.log(`[SYNC_AUTO]   - Movidas para histórico: ${syncResults.movedToHistory}`);
    console.log(`[SYNC_AUTO]   - Preços atualizados: ${syncResults.updatedPrices}`);
    console.log(`[SYNC_AUTO]   - Erros: ${syncResults.errors.length}`);

    return syncResults;

  } catch (error) {
    console.error(`[SYNC_AUTO] ❌ Erro crítico na sincronização avançada para conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Sincroniza ordens abertas com a corretora
 * @param {number} accountId - ID da conta
 */
async function syncOrdersWithExchange(accountId) {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error(`Falha ao conectar ao banco para conta ${accountId}`);
    }

    console.log(`[SYNC_ORDERS] 🔄 Iniciando sincronização de ordens para conta ${accountId}...`);

    // ✅ DEFINIR STATUS FINALIZADOS QUE DEVEM SER MOVIDOS
    const finalizedStatuses = ['FILLED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED'];

    // Obter todos os símbolos com posição aberta OU já conhecidos no banco
    const [symbolsRows] = await db.query(
      `SELECT DISTINCT simbolo FROM posicoes WHERE conta_id = ?`, [accountId]
    );
    const symbols = symbolsRows.map(r => r.simbolo);

    let syncStats = {
      ordersChecked: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      ordersMoved: 0,
      positionsLinked: 0
    };

    for (const symbol of symbols) {
      // Buscar ordens abertas na corretora para o símbolo
      const openOrders = await getOpenOrders(accountId, symbol);
      console.log(`[SYNC_ORDERS] 📋 ${symbol}: ${openOrders.length} ordens na corretora`);

      for (const order of openOrders) {
        syncStats.ordersChecked++;

        // Verificar se já existe no banco
        const [existing] = await db.query(
          `SELECT id_externo, status FROM ordens WHERE id_externo = ? AND conta_id = ?`,
          [order.orderId, accountId]
        );

        if (existing.length === 0) {
          // ✅ INSERIR ORDEM NOVA
          await db.query(
            `INSERT INTO ordens 
              (id_externo, simbolo, tipo_ordem, preco, quantidade, status, side, conta_id, data_hora_criacao, tipo_ordem_bot, last_update)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, NOW())`,
            [
              order.orderId,
              order.symbol,
              order.type,
              order.price,
              order.origQty,
              order.status,
              order.side,
              accountId,
              order.type, // ou mapeie para tipo_ordem_bot se necessário
            ]
          );
          console.log(`[SYNC_ORDERS] ➕ Nova ordem ${order.orderId} (${order.symbol}) inserida: ${order.status}`);
          syncStats.ordersInserted++;
        } else {
          // ✅ ATUALIZAR STATUS SE NECESSÁRIO
          const currentStatus = existing[0].status;
          if (currentStatus !== order.status) {
            await db.query(
              `UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?`,
              [order.status, order.orderId, accountId]
            );
            console.log(`[SYNC_ORDERS] 🔄 Status atualizado ${order.orderId}: ${currentStatus} → ${order.status}`);
            syncStats.ordersUpdated++;
          }
        }

        // ✅ VERIFICAR SE DEVE MOVER PARA HISTÓRICO (STATUS FINALIZADO)
        if (finalizedStatuses.includes(order.status)) {
          console.log(`[SYNC_ORDERS] 🎯 Status finalizado detectado: ${order.orderId} (${order.status}) - movendo para histórico...`);
          
          try {
            // ✅ IMPORTAR E USAR A FUNÇÃO DE MOVIMENTO AUTOMÁTICO
            const { autoMoveOrderOnCompletion } = require('./orderHandlers');
            const moved = await autoMoveOrderOnCompletion(order.orderId, order.status, accountId);
            
            if (moved) {
              syncStats.ordersMoved++;
              console.log(`[SYNC_ORDERS] ✅ Ordem ${order.orderId} (${order.status}) movida para ordens_fechadas`);
            } else {
              console.warn(`[SYNC_ORDERS] ⚠️ Falha ao mover ordem ${order.orderId} para histórico`);
            }
          } catch (moveError) {
            console.error(`[SYNC_ORDERS] ❌ Erro ao mover ordem ${order.orderId}:`, moveError.message);
          }
        } else {
          // ✅ PARA ORDENS ATIVAS, ASSOCIAR id_posicao CORRETO
          const [posRows] = await db.query(
            `SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ? LIMIT 1`,
            [order.symbol, accountId]
          );
          
          if (posRows.length > 0) {
            const posId = posRows[0].id;
            const [updateResult] = await db.query(
              `UPDATE ordens SET id_posicao = ? WHERE id_externo = ? AND conta_id = ? AND (id_posicao IS NULL OR id_posicao != ?)`,
              [posId, order.orderId, accountId, posId]
            );
            
            if (updateResult.affectedRows > 0) {
              syncStats.positionsLinked++;
              console.log(`[SYNC_ORDERS] 🔗 Ordem ${order.orderId} vinculada à posição ${posId} (${order.symbol})`);
            }
          }
        }
      }
    }

    // ✅ VERIFICAR ORDENS NO BANCO QUE NÃO EXISTEM MAIS NA CORRETORA
    console.log(`[SYNC_ORDERS] 🔍 Verificando ordens órfãs no banco...`);
    
    const [dbOrders] = await db.query(`
      SELECT id_externo, simbolo, status, tipo_ordem_bot
      FROM ordens 
      WHERE conta_id = ? AND status NOT IN (${finalizedStatuses.map(() => '?').join(',')})
    `, [accountId, ...finalizedStatuses]);

    let orphanCount = 0;
    for (const dbOrder of dbOrders) {
      // Verificar se ordem ainda existe na corretora
      const { getOrderStatus } = require('../api/rest');
      try {
        const orderStatus = await getOrderStatus(dbOrder.simbolo, dbOrder.id_externo, accountId);
        
        if (!orderStatus || !orderStatus.orderId) {
          // ✅ ORDEM NÃO EXISTE MAIS NA CORRETORA - MARCAR COMO CANCELED E MOVER
          console.log(`[SYNC_ORDERS] 🗑️ Ordem órfã detectada: ${dbOrder.id_externo} - marcando como CANCELED`);
          
          await db.query(`
            UPDATE ordens 
            SET status = 'CANCELED', 
                last_update = NOW(),
                observacao = CONCAT(
                  IFNULL(observacao, ''), 
                  ' | Órfã - não existe na corretora (sync)'
                )
            WHERE id_externo = ? AND conta_id = ?
          `, [dbOrder.id_externo, accountId]);
          
          // Mover para histórico
          const { autoMoveOrderOnCompletion } = require('./orderHandlers');
          const moved = await autoMoveOrderOnCompletion(dbOrder.id_externo, 'CANCELED', accountId);
          
          if (moved) {
            orphanCount++;
            console.log(`[SYNC_ORDERS] ✅ Ordem órfã ${dbOrder.id_externo} movida para histórico`);
          }
        } else if (finalizedStatuses.includes(orderStatus.status)) {
          // ✅ ORDEM FINALIZADA NA CORRETORA MAS AINDA ATIVA NO BANCO
          console.log(`[SYNC_ORDERS] 🎯 Ordem ${dbOrder.id_externo} finalizada na corretora (${orderStatus.status}) - atualizando e movendo...`);
          
          await db.query(`
            UPDATE ordens 
            SET status = ?, last_update = NOW()
            WHERE id_externo = ? AND conta_id = ?
          `, [orderStatus.status, dbOrder.id_externo, accountId]);
          
          const { autoMoveOrderOnCompletion } = require('./orderHandlers');
          const moved = await autoMoveOrderOnCompletion(dbOrder.id_externo, orderStatus.status, accountId);
          
          if (moved) {
            syncStats.ordersMoved++;
            console.log(`[SYNC_ORDERS] ✅ Ordem atrasada ${dbOrder.id_externo} (${orderStatus.status}) movida para histórico`);
          }
        }
      } catch (checkError) {
        console.warn(`[SYNC_ORDERS] ⚠️ Erro ao verificar ordem ${dbOrder.id_externo}:`, checkError.message);
      }
    }

    // ✅ RELATÓRIO FINAL
    console.log(`[SYNC_ORDERS] ✅ Sincronização concluída para conta ${accountId}:`);
    console.log(`[SYNC_ORDERS]   📊 Ordens verificadas: ${syncStats.ordersChecked}`);
    console.log(`[SYNC_ORDERS]   ➕ Ordens inseridas: ${syncStats.ordersInserted}`);
    console.log(`[SYNC_ORDERS]   🔄 Ordens atualizadas: ${syncStats.ordersUpdated}`);
    console.log(`[SYNC_ORDERS]   📚 Ordens movidas para histórico: ${syncStats.ordersMoved}`);
    console.log(`[SYNC_ORDERS]   🔗 Posições vinculadas: ${syncStats.positionsLinked}`);
    console.log(`[SYNC_ORDERS]   🗑️ Órfãs processadas: ${orphanCount}`);

    return {
      success: true,
      stats: syncStats,
      orphansProcessed: orphanCount
    };

  } catch (error) {
    console.error(`[SYNC_ORDERS] ❌ Erro ao sincronizar ordens para conta ${accountId}:`, error.message);
    throw error;
  }
}

// LINHA 164 - Função pad com validação
function pad(str, width, char = ' ') {
  // ✅ VALIDAÇÃO: Garantir que width seja positivo
  const validWidth = Math.max(0, width || 0);
  const strLength = String(str).length;
  
  if (strLength >= validWidth) {
    return String(str);
  }
  
  const paddingNeeded = validWidth - strLength;
  return String(str) + char.repeat(paddingNeeded);
}

// LINHA 174 - Usar a função pad corrigida
function logOpenPositionsAndOrdersVisual(exchangePositions, dbPositions, exchangeOrders, dbOrders) {
  try {
    console.log(`[CONTA-1] ===  VISUALIZAÇÃO DE POSIÇÕES E ORDENS ===`);
    
    // ✅ VALIDAÇÃO: Garantir que arrays existam
    const safeExchangePos = Array.isArray(exchangePositions) ? exchangePositions : [];
    const safeDbPos = Array.isArray(dbPositions) ? dbPositions : [];
    const safeExchangeOrders = Array.isArray(exchangeOrders) ? exchangeOrders : [];
    const safeDbOrders = Array.isArray(dbOrders) ? dbOrders : [];
    
    // ✅ CALCULAÇÃO SEGURA DE LARGURA
    const maxWidth = 15; // Largura fixa máxima
    const minWidth = 10;  // Largura mínima
    
    console.log(`[CONTA-1] Banco:   |${pad('', maxWidth)}| ${safeDbPos.length} posições`);
    console.log(`Corretora:|${pad('', maxWidth)}| ${safeExchangePos.length} posições`);
    
    // ✅ LOGS ADICIONAIS DE DEBUG (opcional)
    console.log(`[CONTA-1] [SYNC] DEBUG - exchangePositions: ${safeExchangePos.length}, dbPositions: ${safeDbPos.length}`);
    console.log(`[CONTA-1] [SYNC] DEBUG - exchangeOrders: ${safeExchangeOrders.length}, dbOrders: ${safeDbOrders.length}`);
    
  } catch (error) {
    console.error(`[CONTA-1] ❌ Erro na visualização de posições:`, error.message);
    console.log(`[CONTA-1] Fallback: ${exchangePositions?.length || 0} posições na corretora, ${dbPositions?.length || 0} no banco`);
  }
}

module.exports = {
  syncPositionsWithExchange,
  logOpenPositionsAndOrdersVisual,
  syncPositionsWithAutoClose,
  syncOrdersWithExchange
};