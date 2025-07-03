const { getDatabaseInstance, moveClosedPositionsAndOrders } = require('../../../core/database/conexao');
const { getAllOpenPositions, getOpenOrders } = require('../api/rest');
// ✅ CORREÇÃO: Importar do cleanup.js
const { movePositionToHistory } = require('../services/cleanup');
// ✅ IMPORTAR FUNÇÕES NECESSÁRIAS PARA CRIAR ORDENS
const { newStopOrder, newLimitMakerOrder, newReduceOnlyOrder, validateQuantity, adjustQuantityToRequirements, getPrecision, roundPriceToTickSize } = require('../api/rest');

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

    //console.log(`[SYNC] Iniciando sincronização de posições para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error(`Falha ao conectar ao banco para conta ${accountId}`);
    }

    // CORREÇÃO CRÍTICA: Log de debug antes da chamada
    //console.log(`[SYNC] Chamando getAllOpenPositions com accountId: ${accountId} (tipo: ${typeof accountId})`);
    
    // CORREÇÃO CRÍTICA: Chamar getAllOpenPositions apenas com accountId (número)
    const exchangePositions = await getAllOpenPositions(accountId);
    
    //console.log(`[SYNC] Obtidas ${exchangePositions.length} posições da corretora para conta ${accountId}`);

    // Obter posições do banco de dados
    const [dbPositions] = await db.query(`
      SELECT 
        id, simbolo, quantidade, preco_medio, side, status,
        preco_entrada, preco_corrente, leverage
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
      ORDER BY simbolo
    `, [accountId]);

    //console.log(`[SYNC] Encontradas ${dbPositions.length} posições no banco para conta ${accountId}`);

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
        //console.warn(`[SYNC] Posição ${exchangePos.simbolo} existe na corretora mas não no banco (conta ${accountId})`);
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
          
          //console.log(`[SYNC] ✅ Posição ${exchangePos.simbolo} criada no banco para conta ${accountId}`);
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
        
        // ✅ MARCAR COMO FECHADA E MOVER PARA HISTÓRICO
        try {
          await db.query(`
            UPDATE posicoes 
            SET status = 'CLOSED', data_hora_fechamento = NOW()
            WHERE id = ?
          `, [dbPos.id]);
          
          // ✅ MOVER IMEDIATAMENTE PARA HISTÓRICO
          const moved = await movePositionToHistory(
            db, 
            dbPos.id, 
            'CLOSED', 
            'Sincronização - posição não encontrada na corretora',
            accountId
          );
          
          if (moved) {
            console.log(`[SYNC] ✅ Posição ${dbPos.simbolo} fechada e movida para histórico (conta ${accountId})`);
          } else {
            console.log(`[SYNC] ✅ Posição ${dbPos.simbolo} marcada como fechada no banco (conta ${accountId})`);
          }
          
          syncResults.updated++;
        } catch (closeError) {
          console.error(`[SYNC] Erro ao fechar posição ${dbPos.simbolo} no banco:`, closeError.message);
          syncResults.errors.push(`Erro ao fechar ${dbPos.simbolo}: ${closeError.message}`);
        }
      }
    }

    //console.log(`[SYNC] ✅ Sincronização concluída para conta ${accountId}:`, syncResults);
    
    // ✅ APÓS SINCRONIZAÇÃO, VERIFICAR E MOVER POSIÇÕES CLOSED RESTANTES
    try {
      const moveResults = await moveClosedPositionsToHistory(accountId);
      if (moveResults.moved > 0) {
        console.log(`[SYNC] 📚 ${moveResults.moved} posições CLOSED adicionais movidas para histórico`);
      }
    } catch (moveError) {
      console.warn(`[SYNC] ⚠️ Erro ao mover posições CLOSED restantes:`, moveError.message);
    }
    
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
    //console.log('===========================================\n');
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

    //console.log(`[SYNC_AUTO] 🔄 Iniciando sincronização avançada para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    
    // Obter posições do banco e corretora
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, side, status, preco_entrada, preco_corrente
      FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
      ORDER BY simbolo
    `, [accountId]);

    const exchangePositions = await getAllOpenPositions(accountId);

    // Lógica para exibir logs apenas se houver diferença ou alteração
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
          } else {
            syncResults.errors.push(`Falha ao mover ${dbPos.simbolo} para histórico`);
          }
        } catch (moveError) {
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
          } catch (updateError) {
            syncResults.errors.push(`Erro ao atualizar preço ${dbPos.simbolo}: ${updateError.message}`);
          }
        }
      }
    }

    // ✅ NOVA FUNCIONALIDADE: DETECTAR E CORRIGIR POSIÇÕES ÓRFÃS
    try {
      console.log(`[SYNC_AUTO] 🔍 Verificando posições órfãs que precisam de ordens de proteção...`);
      const orphanResults = await detectAndFixOrphanPositions(accountId);
      
      if (orphanResults.fixed > 0) {
        console.log(`[SYNC_AUTO] 🔧 ${orphanResults.fixed} posições órfãs corrigidas com ordens de proteção!`);
        syncResults.orphansFixed = orphanResults.fixed;
      } else if (orphanResults.processed > 0) {
        console.log(`[SYNC_AUTO] ✅ ${orphanResults.processed} posições verificadas, nenhuma órfã encontrada`);
        syncResults.orphansChecked = orphanResults.processed;
      }
      
      if (orphanResults.errors.length > 0) {
        console.warn(`[SYNC_AUTO] ⚠️ ${orphanResults.errors.length} erros na detecção de órfãs:`, orphanResults.errors);
        syncResults.orphanErrors = orphanResults.errors;
      }
    } catch (orphanDetectionError) {
      console.error(`[SYNC_AUTO] ❌ Erro na detecção de posições órfãs:`, orphanDetectionError.message);
      syncResults.orphanDetectionError = orphanDetectionError.message;
    }

    // ✅ NOVA FUNCIONALIDADE: VINCULAR SINAIS 'EXECUTADO' A POSIÇÕES ABERTAS
    try {
      console.log(`[SYNC_AUTO] 🔗 Verificando sinais para vincular a posições abertas...`);
      const linkResults = await linkSignalsToOpenPositions(accountId);
      if (linkResults.linked > 0) {
        syncResults.signalsLinked = linkResults.linked;
      }
      if (linkResults.errors.length > 0) {
        syncResults.signalLinkErrors = linkResults.errors;
      }
    } catch (linkError) {
      console.error(`[SYNC_AUTO] ❌ Erro na vinculação de sinais:`, linkError.message);
      syncResults.signalLinkError = linkError.message;
    }

    return syncResults;

  } catch (error) {
    console.error(`[SYNC_AUTO] ❌ Erro crítico na sincronização avançada para conta ${accountId}:`, error.message);
    throw error;
  } finally {
    // ✅ SEMPRE VERIFICAR E MOVER POSIÇÕES CLOSED APÓS SINCRONIZAÇÃO
    try {
      const moveResults = await moveClosedPositionsToHistory(accountId);
      if (moveResults.moved > 0) {
        console.log(`[SYNC_AUTO] 📚 ${moveResults.moved} posições CLOSED movidas para histórico após sincronização`);
      }
    } catch (moveError) {
      console.warn(`[SYNC_AUTO] ⚠️ Erro ao mover posições CLOSED após sincronização:`, moveError.message);
    }
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

    // ✅ STATUS FINALIZADOS QUE DEVEM SER MOVIDOS AUTOMATICAMENTE
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
      positionsLinked: 0,
      orphansProcessed: 0
    };

    // ✅ PRIMEIRO: PROCESSAR ORDENS DA CORRETORA
    for (const symbol of symbols) {
      try {
        // Buscar ordens abertas na corretora para o símbolo
        const openOrders = await getOpenOrders(accountId, symbol);
        console.log(`[SYNC_ORDERS] 📋 ${symbol}: ${openOrders.length} ordens na corretora`);

        for (const order of openOrders) {
          syncStats.ordersChecked++;

          // Verificar se já existe no banco
          const [existing] = await db.query(
            `SELECT id_externo, status, data_hora_criacao FROM ordens WHERE id_externo = ? AND conta_id = ?`,
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

          // ✅ VERIFICAR SE DEVE MOVER PARA HISTÓRICO (STATUS FINALIZADO NA CORRETORA)
          if (finalizedStatuses.includes(order.status)) {
            console.log(`[SYNC_ORDERS] 🎯 Status finalizado na corretora: ${order.orderId} (${order.status}) - movendo para histórico...`);
            
            try {
              const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
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
      } catch (symbolError) {
        console.error(`[SYNC_ORDERS] ❌ Erro ao processar símbolo ${symbol}:`, symbolError.message);
      }
    }

    // ✅ SEGUNDO: VERIFICAR TODAS AS ORDENS NO BANCO (ATIVAS + FINALIZADAS ANTIGAS)
    console.log(`[SYNC_ORDERS] 🔍 Verificando ordens no banco de dados...`);
    
    const [allDbOrders] = await db.query(`
      SELECT id_externo, simbolo, status, tipo_ordem_bot, data_hora_criacao,
             TIMESTAMPDIFF(MINUTE, data_hora_criacao, NOW()) as minutes_old
      FROM ordens 
      WHERE conta_id = ?
      ORDER BY data_hora_criacao DESC
    `, [accountId]);

    console.log(`[SYNC_ORDERS] 📊 Encontradas ${allDbOrders.length} ordens no banco para verificação`);

    for (const dbOrder of allDbOrders) {
      try {
        // ✅ REGRA 1: VERIFICAR SE STATUS NO BANCO É FINALIZADO
        if (finalizedStatuses.includes(dbOrder.status)) {
          console.log(`[SYNC_ORDERS] 🎯 Ordem ${dbOrder.id_externo} com status finalizado no banco (${dbOrder.status}) - movendo...`);
          
          const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
          const moved = await autoMoveOrderOnCompletion(dbOrder.id_externo, dbOrder.status, accountId);
          
          if (moved) {
            syncStats.ordersMoved++;
            console.log(`[SYNC_ORDERS] ✅ Ordem finalizada ${dbOrder.id_externo} movida do banco para histórico`);
          }
          continue; // Próxima ordem
        }

        // ✅ REGRA 2: VERIFICAR SE ORDEM EXISTE NA CORRETORA
        const { getOrderStatus } = require('../api/rest');
        let orderStatus = null;
        let orderExistsOnExchange = false;

        try {
          orderStatus = await getOrderStatus(dbOrder.simbolo, dbOrder.id_externo, accountId);
          orderExistsOnExchange = orderStatus && orderStatus.orderId;
        } catch (checkError) {
          console.warn(`[SYNC_ORDERS] ⚠️ Erro ao verificar ordem ${dbOrder.id_externo} na corretora:`, checkError.message);
          orderExistsOnExchange = false;
        }

        if (!orderExistsOnExchange) {
          // ✅ REGRA 3: ORDEM NÃO EXISTE NA CORRETORA
          const minutesOld = dbOrder.minutes_old || 0;
          
          if (minutesOld > 1) {
            // ✅ ORDEM TEM MAIS DE 1 MINUTO E NÃO EXISTE NA CORRETORA - MOVER
            console.log(`[SYNC_ORDERS] 🗑️ Ordem órfã detectada: ${dbOrder.id_externo} (${minutesOld} min) - não existe na corretora`);
            
            // Marcar como CANCELED primeiro
            await db.query(`
              UPDATE ordens 
              SET status = 'CANCELED', 
                  last_update = NOW(),
                  observacao = CONCAT(
                    IFNULL(observacao, ''), 
                    ' | Órfã - não existe na corretora (${minutesOld} min old)'
                  )
              WHERE id_externo = ? AND conta_id = ?
            `, [dbOrder.id_externo, accountId]);
            
            // Mover para histórico
            const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
            const moved = await autoMoveOrderOnCompletion(dbOrder.id_externo, 'CANCELED', accountId);
            
            if (moved) {
              syncStats.orphansProcessed++;
              console.log(`[SYNC_ORDERS] ✅ Ordem órfã ${dbOrder.id_externo} movida para histórico`);
            }
          } else {
            console.log(`[SYNC_ORDERS] ⏳ Ordem ${dbOrder.id_externo} não encontrada na corretora, mas tem apenas ${minutesOld} min - aguardando...`);
          }
          
        } else {
          // ✅ REGRA 4: ORDEM EXISTE NA CORRETORA - VERIFICAR STATUS
          const exchangeStatus = orderStatus.status;
          
          if (finalizedStatuses.includes(exchangeStatus)) {
            console.log(`[SYNC_ORDERS] 🎯 Ordem ${dbOrder.id_externo} finalizada na corretora (${exchangeStatus}) - sincronizando e movendo...`);
            
            // Atualizar status no banco primeiro
            await db.query(`
              UPDATE ordens 
              SET status = ?, last_update = NOW()
              WHERE id_externo = ? AND conta_id = ?
            `, [exchangeStatus, dbOrder.id_externo, accountId]);
            
            // Mover para histórico
            const { autoMoveOrderOnCompletion } = require('../handlers/orderHandlers');
            const moved = await autoMoveOrderOnCompletion(dbOrder.id_externo, exchangeStatus, accountId);
            
            if (moved) {
              syncStats.ordersMoved++;
              console.log(`[SYNC_ORDERS] ✅ Ordem ${dbOrder.id_externo} (${exchangeStatus}) sincronizada e movida para histórico`);
            }
          } else if (exchangeStatus !== dbOrder.status) {
            // ✅ SINCRONIZAR STATUS SEM MOVER (ordem ainda ativa)
            console.log(`[SYNC_ORDERS] 🔄 Sincronizando status ativo: ${dbOrder.status} → ${exchangeStatus}`);
            await db.query(`
              UPDATE ordens 
              SET status = ?, last_update = NOW()
              WHERE id_externo = ? AND conta_id = ?
            `, [exchangeStatus, dbOrder.id_externo, accountId]);
            syncStats.ordersUpdated++;
          }
        }

      } catch (orderError) {
        console.error(`[SYNC_ORDERS] ❌ Erro ao processar ordem ${dbOrder.id_externo}:`, orderError.message);
      }
    }

    // ✅ RELATÓRIO FINAL DETALHADO
    console.log(`[SYNC_ORDERS] ✅ Sincronização concluída para conta ${accountId}:`);
    console.log(`[SYNC_ORDERS]   📊 Ordens verificadas: ${syncStats.ordersChecked}`);
    console.log(`[SYNC_ORDERS]   ➕ Ordens inseridas: ${syncStats.ordersInserted}`);
    console.log(`[SYNC_ORDERS]   🔄 Ordens atualizadas: ${syncStats.ordersUpdated}`);
    console.log(`[SYNC_ORDERS]   📚 Ordens movidas para histórico: ${syncStats.ordersMoved}`);
    console.log(`[SYNC_ORDERS]   🔗 Posições vinculadas: ${syncStats.positionsLinked}`);
    console.log(`[SYNC_ORDERS]   🗑️ Órfãs processadas: ${syncStats.orphansProcessed}`);
    console.log(`[SYNC_ORDERS]   🎯 Total de movimentos: ${syncStats.ordersMoved + syncStats.orphansProcessed}`);

    return {
      success: true,
      stats: syncStats,
      totalMoved: syncStats.ordersMoved + syncStats.orphansProcessed
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

async function logOpenPositionsAndOrdersVisual(accountId) {
  try {
    //console.log('\n=== 🔍 DIAGNÓSTICO DE SINCRONIZAÇÃO ===');
    
    const db = await getDatabaseInstance();
    
    // Posições do banco
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, preco_entrada, side, status 
      FROM posicoes WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    // Posições da corretora  
    const exchangePositions = await getAllOpenPositions(accountId);
    
    //console.log(`[SYNC_CHECK] 📊 Banco: ${dbPositions.length} posições | Corretora: ${exchangePositions.length} posições`);
    
    // ✅ DETECTAR DISCREPÂNCIAS
    const discrepancies = [];
    
    dbPositions.forEach(dbPos => {
      const exchangePos = exchangePositions.find(ex => ex.simbolo === dbPos.simbolo);
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        discrepancies.push({
          type: 'MISSING_ON_EXCHANGE',
          symbol: dbPos.simbolo,
          dbId: dbPos.id,
          dbQty: dbPos.quantidade
        });
      }
    });
    
    exchangePositions.forEach(exPos => {
      if (Math.abs(parseFloat(exPos.quantidade)) > 0.000001) {
        const dbPos = dbPositions.find(db => db.simbolo === exPos.simbolo);
        if (!dbPos) {
          discrepancies.push({
            type: 'MISSING_ON_DB',
            symbol: exPos.simbolo,
            exchangeQty: exPos.quantidade
          });
        }
      }
    });
    
    if (discrepancies.length > 0) {
      console.log(`[SYNC_CHECK] ⚠️ ENCONTRADAS ${discrepancies.length} DISCREPÂNCIAS:`);
      discrepancies.forEach(disc => {
        if (disc.type === 'MISSING_ON_EXCHANGE') {
          console.log(`  🚨 ${disc.symbol}: Existe no banco (ID: ${disc.dbId}, Qty: ${disc.dbQty}) mas NÃO na corretora`);
        } else {
          console.log(`  🚨 ${disc.symbol}: Existe na corretora (Qty: ${disc.exchangeQty}) mas NÃO no banco`);
        }
      });
    } else {
      //console.log(`[SYNC_CHECK] ✅ Banco e corretora estão sincronizados`);
    }
    
    //console.log('===========================================\n');
  } catch (error) {
    console.error(`[SYNC_CHECK] ❌ Erro na verificação de sincronização:`, error.message);
  }
}

/**
 * ✅ FUNÇÃO PARA DETECTAR E MOVER POSIÇÕES CLOSED PARA HISTÓRICO
 * Move automaticamente todas as posições com status CLOSED para posicoes_fechadas
 */
async function moveClosedPositionsToHistory(accountId) {
  try {
    //console.log(`[MOVE_CLOSED] 🔄 Verificando posições CLOSED para mover ao histórico (conta ${accountId})...`);
    
    const db = await getDatabaseInstance();
    
    // Buscar todas as posições com status CLOSED
    const [closedPositions] = await db.query(`
      SELECT id, simbolo, status, data_hora_fechamento, liquid_pnl
      FROM posicoes 
      WHERE status = 'CLOSED' AND conta_id = ?
      ORDER BY data_hora_fechamento DESC
    `, [accountId]);
    
    if (closedPositions.length === 0) {
      //console.log(`[MOVE_CLOSED] ℹ️ Nenhuma posição CLOSED encontrada para conta ${accountId}`);
      return { moved: 0, errors: [] };
    }
    
    console.log(`[MOVE_CLOSED] 📊 Encontradas ${closedPositions.length} posições CLOSED para mover...`);
    
    let moveResults = {
      moved: 0,
      errors: []
    };
    
    // Mover cada posição CLOSED para o histórico
    for (const position of closedPositions) {
      try {
        console.log(`[MOVE_CLOSED] 📚 Movendo posição ${position.simbolo} (ID: ${position.id}) para histórico...`);
        
        const moved = await movePositionToHistory(
          db, 
          position.id, 
          'CLOSED', 
          'Movida automaticamente - detectada como CLOSED',
          accountId
        );
        
        if (moved) {
          moveResults.moved++;
          console.log(`[MOVE_CLOSED] ✅ Posição ${position.simbolo} (ID: ${position.id}) movida com sucesso para histórico`);
        } else {
          moveResults.errors.push(`Falha ao mover ${position.simbolo} (ID: ${position.id})`);
          console.error(`[MOVE_CLOSED] ❌ Falha ao mover posição ${position.simbolo} para histórico`);
        }
        
      } catch (moveError) {
        moveResults.errors.push(`Erro ao mover ${position.simbolo}: ${moveError.message}`);
        console.error(`[MOVE_CLOSED] ❌ Erro ao mover posição ${position.simbolo}:`, moveError.message);
      }
    }
    
    console.log(`[MOVE_CLOSED] ✅ Processamento concluído: ${moveResults.moved} movidas, ${moveResults.errors.length} erros`);
    
    return moveResults;
    
  } catch (error) {
    console.error(`[MOVE_CLOSED] ❌ Erro crítico ao mover posições CLOSED:`, error.message);
    return { moved: 0, errors: [error.message] };
  }
}

/**
 * ✅ NOVA FUNÇÃO: Cria ordens SL, RPs e TP Market para posições órfãs (não criadas pelo webhook)
 * @param {number} accountId - ID da conta
 * @param {Object} position - Posição da corretora
 * @param {Object} latestSignal - Último sinal para o símbolo
 * @returns {Promise<Object>} - Resultado da criação das ordens
 */
async function createMissingOrdersForPosition(accountId, position, latestSignal) {
  console.log(`[MISSING_ORDERS] 🔧 Criando ordens SL/RPs/TP para posição órfã: ${position.simbolo} (${position.quantidade})`);
  
  try {
    const db = await getDatabaseInstance();
    const symbol = position.simbolo;
    const positionQty = Math.abs(parseFloat(position.quantidade));
    const positionSide = parseFloat(position.quantidade) > 0 ? 'BUY' : 'SELL';
    const oppositeSide = positionSide === 'BUY' ? 'SELL' : 'BUY';
    
    // ✅ OBTER PRECISÃO DO SÍMBOLO
    const precisionInfo = await getPrecision(symbol, accountId);
    const quantityPrecision = precisionInfo.quantityPrecision;
    const pricePrecision = precisionInfo.pricePrecision;
    
    console.log(`[MISSING_ORDERS] 📊 Posição ${symbol}: Side=${positionSide}, Qty=${positionQty.toFixed(quantityPrecision)}`);
    console.log(`[MISSING_ORDERS] 📋 Sinal usado: ID=${latestSignal.id}, SL=${latestSignal.sl_price}, TP1=${latestSignal.tp1_price}`);
    
    let createdOrders = {
      sl: null,
      rp1: null,
      rp2: null,
      rp3: null,
      rp4: null,
      tp: null,
      errors: []
    };
    
    // ✅ 1. CRIAR STOP LOSS (se definido no sinal)
    if (latestSignal.sl_price && parseFloat(latestSignal.sl_price) > 0) {
      try {
        const slPrice = parseFloat(latestSignal.sl_price);
        const roundedSlPrice = await roundPriceToTickSize(symbol, slPrice, accountId);
        
        console.log(`[MISSING_ORDERS] 🛑 Criando STOP LOSS: ${positionQty.toFixed(quantityPrecision)} @ ${roundedSlPrice.toFixed(pricePrecision)}`);
        
        const slOrder = await newStopOrder(
          accountId,
          symbol,
          positionQty,
          oppositeSide, // Oposto à posição
          roundedSlPrice,
          null, // price = null para STOP_MARKET
          true, // reduceOnly = true
          false, // closePosition = false (usamos quantity específica)
          'STOP_MARKET' // orderType
        );
        
        if (slOrder && slOrder.orderId) {
          createdOrders.sl = slOrder.orderId;
          console.log(`[MISSING_ORDERS] ✅ STOP LOSS criado: ${slOrder.orderId}`);
          
          // ✅ SALVAR NO BANCO
          await db.query(`
            INSERT INTO ordens (
              id_externo, simbolo, tipo_ordem, preco, quantidade, status, side, conta_id,
              data_hora_criacao, tipo_ordem_bot, orign_sig, reduce_only, last_update
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, NOW())
          `, [
            slOrder.orderId, symbol, 'STOP_MARKET', roundedSlPrice, positionQty,
            'NEW', oppositeSide, accountId, 'STOP_LOSS',
            `FALLBACK_${latestSignal.id}`, 1 // reduce_only = true
          ]);
        }
      } catch (slError) {
        console.error(`[MISSING_ORDERS] ❌ Erro ao criar STOP LOSS:`, slError.message);
        createdOrders.errors.push(`SL: ${slError.message}`);
      }
    }
    
    // ✅ 2. CRIAR TAKE PROFITS / REALIZE PROFITS
    const tpTargets = [
      { key: 'rp1', price: latestSignal.tp1_price, percentage: 0.25 }, // 25% da posição
      { key: 'rp2', price: latestSignal.tp2_price, percentage: 0.25 }, // 25% da posição
      { key: 'rp3', price: latestSignal.tp3_price, percentage: 0.25 }, // 25% da posição
      { key: 'rp4', price: latestSignal.tp4_price, percentage: 0.15 }, // 15% da posição
      { key: 'tp', price: latestSignal.tp5_price || latestSignal.tp_price, percentage: 0.10 } // 10% restante
    ];
    
    let remainingQty = positionQty;
    
    for (const target of tpTargets) {
      if (!target.price || parseFloat(target.price) <= 0) {
        console.log(`[MISSING_ORDERS] ⏭️ ${target.key.toUpperCase()}: preço não definido, pulando...`);
        continue;
      }
      
      try {
        const targetPrice = parseFloat(target.price);
        const roundedPrice = await roundPriceToTickSize(symbol, targetPrice, accountId);
        
        // ✅ CALCULAR QUANTIDADE (percentual da posição total)
        let targetQty = parseFloat((positionQty * target.percentage).toFixed(quantityPrecision));
        
        // ✅ AJUSTAR QUANTIDADE SE NECESSÁRIO
        if (targetQty > remainingQty) {
          targetQty = remainingQty;
        }
        
        if (targetQty <= 0.000001) {
          console.log(`[MISSING_ORDERS] ⏭️ ${target.key.toUpperCase()}: quantidade muito pequena (${targetQty}), pulando...`);
          continue;
        }
        
        console.log(`[MISSING_ORDERS] 🎯 Criando ${target.key.toUpperCase()}: ${targetQty.toFixed(quantityPrecision)} @ ${roundedPrice.toFixed(pricePrecision)} (${(target.percentage * 100).toFixed(0)}%)`);
        
        // ✅ VALIDAR QUANTIDADE
        const validation = await validateQuantity(symbol, targetQty, roundedPrice, accountId, 'LIMIT');
        let finalQty = targetQty;
        
        if (!validation.isValid) {
          console.warn(`[MISSING_ORDERS] ⚠️ ${target.key.toUpperCase()}: quantidade inválida (${validation.reason}), tentando ajustar...`);
          
          const adjustment = await adjustQuantityToRequirements(symbol, targetQty, roundedPrice, accountId, 'LIMIT');
          if (adjustment.success) {
            finalQty = adjustment.adjustedQuantity;
            console.log(`[MISSING_ORDERS] ✅ ${target.key.toUpperCase()}: quantidade ajustada para ${finalQty.toFixed(quantityPrecision)}`);
          } else {
            console.error(`[MISSING_ORDERS] ❌ ${target.key.toUpperCase()}: impossível ajustar quantidade - ${adjustment.error}`);
            createdOrders.errors.push(`${target.key}: ${adjustment.error}`);
            continue;
          }
        }
        
        // ✅ CRIAR ORDEM LIMIT MAKER REDUCE-ONLY
        const tpOrder = await newReduceOnlyOrder(
          accountId,
          symbol,
          finalQty,
          oppositeSide, // Oposto à posição
          roundedPrice,
          'LIMIT' // LIMIT para melhor preço
        );
        
        if (tpOrder && tpOrder.orderId) {
          createdOrders[target.key] = tpOrder.orderId;
          remainingQty -= finalQty;
          console.log(`[MISSING_ORDERS] ✅ ${target.key.toUpperCase()} criado: ${tpOrder.orderId} (restante: ${remainingQty.toFixed(quantityPrecision)})`);
          
          // ✅ SALVAR NO BANCO
          await db.query(`
            INSERT INTO ordens (
              id_externo, simbolo, tipo_ordem, preco, quantidade, status, side, conta_id,
              data_hora_criacao, tipo_ordem_bot, orign_sig, reduce_only, last_update
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, NOW())
          `, [
            tpOrder.orderId, symbol, 'LIMIT', roundedPrice, finalQty,
            'NEW', oppositeSide, accountId, target.key.toUpperCase(),
            `FALLBACK_${latestSignal.id}`, 1 // reduce_only = true
          ]);
        }
        
      } catch (tpError) {
        console.error(`[MISSING_ORDERS] ❌ Erro ao criar ${target.key.toUpperCase()}:`, tpError.message);
        createdOrders.errors.push(`${target.key}: ${tpError.message}`);
      }
    }
    
    // ✅ RELATÓRIO FINAL
    const successCount = Object.values(createdOrders).filter(v => v && typeof v === 'string').length;
    console.log(`[MISSING_ORDERS] 📊 Resultado para ${symbol}:`);
    console.log(`[MISSING_ORDERS]   ✅ Ordens criadas: ${successCount}`);
    console.log(`[MISSING_ORDERS]   ❌ Erros: ${createdOrders.errors.length}`);
    
    if (createdOrders.errors.length > 0) {
      console.log(`[MISSING_ORDERS]   📋 Detalhes dos erros:`, createdOrders.errors);
    }
    
    return {
      success: successCount > 0,
      created: successCount,
      errors: createdOrders.errors.length,
      details: createdOrders
    };
    
  } catch (error) {
    console.error(`[MISSING_ORDERS] ❌ Erro crítico ao criar ordens para ${position.simbolo}:`, error.message);
    return {
      success: false,
      created: 0,
      errors: 1,
      details: { errors: [error.message] }
    };
  }
}

/**
 * ✅ NOVA FUNÇÃO: Detecta posições órfãs e cria ordens SL/RPs/TP automaticamente
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da detecção e criação
 */
async function detectAndFixOrphanPositions(accountId) {
  console.log(`[ORPHAN_DETECTION] 🔍 Detectando posições órfãs para conta ${accountId}...`);
  
  try {
    const db = await getDatabaseInstance();
    
    // ✅ OBTER POSIÇÕES DA CORRETORA
    const exchangePositions = await getAllOpenPositions(accountId);
    
    if (exchangePositions.length === 0) {
      console.log(`[ORPHAN_DETECTION] ℹ️ Nenhuma posição encontrada na corretora para conta ${accountId}`);
      return { processed: 0, fixed: 0, errors: [] };
    }
    
    console.log(`[ORPHAN_DETECTION] 📊 Encontradas ${exchangePositions.length} posições na corretora`);
    
    let results = {
      processed: 0,
      fixed: 0,
      errors: []
    };
    
    for (const position of exchangePositions) {
      try {
        const symbol = position.simbolo;
        const positionAge = position.tempoAbertura ? Date.now() - position.tempoAbertura : 0;
        const ageMinutes = Math.floor(positionAge / (1000 * 60));
        
        console.log(`[ORPHAN_DETECTION] 🔍 Verificando ${symbol} (idade: ${ageMinutes} min)...`);
        
        results.processed++;
        
        // ✅ CRITÉRIO 1: Posição deve ter mais de 4 minutos
        if (ageMinutes < 4) {
          console.log(`[ORPHAN_DETECTION] ⏳ ${symbol}: muito nova (${ageMinutes} min), pulando...`);
          continue;
        }
        
        // ✅ CRITÉRIO 2: Verificar se tem ordens abertas (se tiver, não é órfã)
        const openOrders = await getOpenOrders(accountId, symbol);
        if (openOrders.length > 0) {
          console.log(`[ORPHAN_DETECTION] 📋 ${symbol}: tem ${openOrders.length} ordens abertas, não é órfã`);
          continue;
        }
        
        // ✅ CRITÉRIO 3: Verificar se existe posição correspondente no banco
        const [dbPositions] = await db.query(`
          SELECT id, simbolo FROM posicoes 
          WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN'
        `, [symbol, accountId]);
        
        if (dbPositions.length === 0) {
          console.log(`[ORPHAN_DETECTION] ⚠️ ${symbol}: não encontrada no banco, posição órfã detectada!`);
        } else {
          console.log(`[ORPHAN_DETECTION] ✅ ${symbol}: encontrada no banco (ID: ${dbPositions[0].id}), verificando ordens...`);
          
          // ✅ VERIFICAR SE TEM ORDENS DE PROTEÇÃO (SL/TP) NO BANCO
          const [protectionOrders] = await db.query(`
            SELECT COUNT(*) as count FROM ordens 
            WHERE simbolo = ? AND conta_id = ? AND status IN ('NEW', 'PARTIALLY_FILLED')
              AND tipo_ordem_bot IN ('STOP_LOSS', 'RP1', 'RP2', 'RP3', 'RP4', 'TP')
          `, [symbol, accountId]);
          
          if (protectionOrders[0].count > 0) {
            console.log(`[ORPHAN_DETECTION] ✅ ${symbol}: tem ${protectionOrders[0].count} ordens de proteção, tudo ok`);
            continue;
          } else {
            console.log(`[ORPHAN_DETECTION] ⚠️ ${symbol}: posição existe no banco mas SEM ordens de proteção, tratando como órfã!`);
          }
        }
        
        // ✅ BUSCAR ÚLTIMO SINAL PARA O SÍMBOLO
        const [latestSignals] = await db.query(`
          SELECT id, symbol, side, sl_price, tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, tp_price, created_at
          FROM webhook_signals 
          WHERE symbol = ? AND conta_id = ? 
          ORDER BY created_at DESC 
          LIMIT 1
        `, [symbol, accountId]);
        
        if (latestSignals.length === 0) {
          console.warn(`[ORPHAN_DETECTION] ⚠️ ${symbol}: nenhum sinal encontrado para criar ordens de proteção`);
          results.errors.push(`${symbol}: sem sinal de referência`);
          continue;
        }
        
        const latestSignal = latestSignals[0];
        const signalAge = Date.now() - new Date(latestSignal.created_at).getTime();
        const signalAgeMinutes = Math.floor(signalAge / (1000 * 60));
        
        console.log(`[ORPHAN_DETECTION] 📋 ${symbol}: usando sinal ID=${latestSignal.id} (idade: ${signalAgeMinutes} min)`);
        
        // ✅ VERIFICAR SE O SINAL TEM PREÇOS DE SL/TP DEFINIDOS
        const hasSlPrice = latestSignal.sl_price && parseFloat(latestSignal.sl_price) > 0;
        const hasTpPrices = [latestSignal.tp1_price, latestSignal.tp2_price, latestSignal.tp3_price, latestSignal.tp4_price, latestSignal.tp5_price, latestSignal.tp_price].some(price => price && parseFloat(price) > 0);
        
        if (!hasSlPrice && !hasTpPrices) {
          console.warn(`[ORPHAN_DETECTION] ⚠️ ${symbol}: sinal não tem preços de SL/TP definidos`);
          results.errors.push(`${symbol}: sinal sem preços de SL/TP`);
          continue;
        }
        
        // ✅ CRIAR ORDENS SL/RPs/TP PARA A POSIÇÃO ÓRFÃ
        console.log(`[ORPHAN_DETECTION] 🔧 ${symbol}: criando ordens de proteção para posição órfã...`);
        
        const orderCreationResult = await createMissingOrdersForPosition(accountId, position, latestSignal);
        
        if (orderCreationResult.success) {
          results.fixed++;
          console.log(`[ORPHAN_DETECTION] ✅ ${symbol}: ${orderCreationResult.created} ordens de proteção criadas com sucesso!`);
        } else {
          results.errors.push(`${symbol}: falha ao criar ordens - ${orderCreationResult.details.errors.join(', ')}`);
          console.error(`[ORPHAN_DETECTION] ❌ ${symbol}: falha ao criar ordens de proteção`);
        }
        
      } catch (positionError) {
        console.error(`[ORPHAN_DETECTION] ❌ Erro ao processar posição ${position.simbolo}:`, positionError.message);
        results.errors.push(`${position.simbolo}: ${positionError.message}`);
      }
    }
    
    // ✅ RELATÓRIO FINAL
    console.log(`[ORPHAN_DETECTION] 📊 Relatório final para conta ${accountId}:`);
    console.log(`[ORPHAN_DETECTION]   🔍 Posições processadas: ${results.processed}`);
    console.log(`[ORPHAN_DETECTION]   🔧 Posições órfãs corrigidas: ${results.fixed}`);
    console.log(`[ORPHAN_DETECTION]   ❌ Erros: ${results.errors.length}`);
    
    if (results.errors.length > 0) {
      console.log(`[ORPHAN_DETECTION]   📋 Detalhes dos erros:`, results.errors);
    }
    
    return results;
    
  } catch (error) {
    console.error(`[ORPHAN_DETECTION] ❌ Erro crítico na detecção de posições órfãs:`, error.message);
    return { processed: 0, fixed: 0, errors: [error.message] };
  }
}

/**
 * ✅ NOVA FUNÇÃO: Vincula sinais com status 'EXECUTADO' a posições abertas.
 * Esta função corrige casos em que o webhook processou o sinal, mas a vinculação com a posição falhou.
 * Atualiza apenas a coluna position_id na tabela webhook_signals.
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da operação de vinculação.
 */
async function linkSignalsToOpenPositions(accountId) {
  //console.log(`[LINK_SIGNALS] 🔍 Verificando sinais 'EXECUTADO' sem posição vinculada para conta ${accountId}...`);
  
  try {
    const db = await getDatabaseInstance();
    
    // 1. Encontrar sinais com status 'EXECUTADO' e sem position_id
    const [signalsToLink] = await db.query(`
      SELECT id, symbol
      FROM webhook_signals
      WHERE status = 'EXECUTADO' 
        AND position_id IS NULL 
        AND conta_id = ?
      ORDER BY created_at DESC
    `, [accountId]);

    if (signalsToLink.length === 0) {
      //console.log(`[LINK_SIGNALS] ℹ️ Nenhum sinal 'EXECUTADO' para vincular.`);
      return { linked: 0, errors: [] };
    }

    console.log(`[LINK_SIGNALS] 📊 Encontrados ${signalsToLink.length} sinais para potencial vinculação.`);

    let linkedCount = 0;
    const errors = [];

    // Usar um Set para não re-processar o mesmo símbolo, já que pegamos o mais recente pela query
    const processedSymbols = new Set();

    for (const signal of signalsToLink) {
      if (processedSymbols.has(signal.symbol)) {
        continue; // Já processamos o sinal mais recente para este símbolo
      }

      try {
        // 2. Encontrar a posição aberta correspondente para o símbolo
        const [openPositions] = await db.query(`
          SELECT id, simbolo
          FROM posicoes
          WHERE simbolo = ? 
            AND status = 'OPEN' 
            AND conta_id = ?
          LIMIT 1
        `, [signal.symbol, accountId]);

        if (openPositions.length > 0) {
          const position = openPositions[0];
          
          // 3. Verificar se este sinal já não está vinculado a alguma posição
          const [existingLink] = await db.query(`
            SELECT position_id FROM webhook_signals 
            WHERE id = ? AND position_id IS NOT NULL
          `, [signal.id]);
          
          if (existingLink.length > 0) {
            console.log(`[LINK_SIGNALS] ℹ️ Sinal ${signal.id} (${signal.symbol}) já está vinculado à posição ${existingLink[0].position_id}, pulando...`);
            continue;
          }
          
          console.log(`[LINK_SIGNALS] 🔗 Vinculando sinal ${signal.id} (${signal.symbol}) à posição ${position.id}...`);

          // 4. Atualizar apenas o sinal com o ID da posição (tabela posicoes não tem coluna signal_id)
          const [signalUpdateResult] = await db.query(`
            UPDATE webhook_signals
            SET position_id = ?
            WHERE id = ? AND position_id IS NULL
          `, [position.id, signal.id]);

          if (signalUpdateResult.affectedRows > 0) {
            linkedCount++;
            console.log(`[LINK_SIGNALS] ✅ Sinal ${signal.id} vinculado com sucesso à posição ${position.id}.`);
          } else {
            console.warn(`[LINK_SIGNALS] ⚠️ A vinculação do sinal ${signal.id} à posição ${position.id} pode ter falhado (affectedRows: 0).`);
          }
        }
      } catch (linkError) {
        console.error(`[LINK_SIGNALS] ❌ Erro ao vincular sinal para ${signal.symbol}:`, linkError.message);
        errors.push(`Símbolo ${signal.symbol}: ${linkError.message}`);
      }
      
      processedSymbols.add(signal.symbol);
    }

    if (linkedCount > 0) {
        console.log(`[LINK_SIGNALS] ✅ Processo de vinculação concluído: ${linkedCount} vinculados, ${errors.length} erros.`);
    }
    
    return { linked: linkedCount, errors };

  } catch (error) {
    console.error(`[LINK_SIGNALS] ❌ Erro crítico ao vincular sinais a posições:`, error.message);
    return { linked: 0, errors: [error.message] };
  }
}

module.exports = {
  syncPositionsWithExchange,
  logOpenPositionsAndOrdersVisual,
  syncPositionsWithAutoClose,
  syncOrdersWithExchange,
  moveClosedPositionsToHistory,
  createMissingOrdersForPosition,
  detectAndFixOrphanPositions,
  linkSignalsToOpenPositions
};