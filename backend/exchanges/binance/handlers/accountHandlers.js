const { getDatabaseInstance, insertPosition, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatBalanceMessage, formatAlertMessage } = require('../telegram/telegramBot');
const { movePositionToHistory } = require('../services/cleanup');

/**
 * Processa atualizações de conta via WebSocket (ACCOUNT_UPDATE)
 * @param {Object} message - Mensagem completa do WebSocket
 * @param {number} accountId - ID da conta
 * @param {Object} db - Conexão com banco (opcional)
 */
async function handleAccountUpdate(message, accountId, db = null) {
  try {
    // VALIDAÇÃO CRÍTICA: Parâmetros obrigatórios
    if (!message || !message.a) {
      console.warn(`[ACCOUNT] Mensagem ACCOUNT_UPDATE inválida para conta ${accountId}:`, {
        hasMessage: !!message,
        hasData: !!(message && message.a),
        eventType: message?.e
      });
      return;
    }

    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ACCOUNT] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    const updateData = message.a;
    const reason = updateData.m || 'UNKNOWN';
    const eventTime = message.E || Date.now();
    const transactionTime = message.T || Date.now();
    
    console.log(`[ACCOUNT] ✅ Atualização de conta recebida para conta ${accountId}`);
    console.log(`[ACCOUNT] 📋 Detalhes: Motivo=${reason}, EventTime=${eventTime}, TransactionTime=${transactionTime}`);

    // OBTER CONEXÃO COM BANCO
    let connection = db;
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
      if (!connection) {
        console.error(`[ACCOUNT] ❌ Não foi possível obter conexão com banco para conta ${accountId}`);
        return;
      }
    }

    // PROCESSAR ATUALIZAÇÕES DE SALDO (se existir)
    if (updateData.B && Array.isArray(updateData.B) && updateData.B.length > 0) {
      console.log(`[ACCOUNT] 💰 Processando ${updateData.B.length} atualizações de saldo...`);
      await handleBalanceUpdates(connection, updateData.B, accountId, reason);
    }

    // PROCESSAR ATUALIZAÇÕES DE POSIÇÃO (PRINCIPAL)
    if (updateData.P && Array.isArray(updateData.P) && updateData.P.length > 0) {
      console.log(`[ACCOUNT] 📊 Processando ${updateData.P.length} atualizações de posição...`);
      await handlePositionUpdates(connection, updateData.P, accountId, reason, eventTime);
    }

    // LOG DE FINALIZAÇÃO
    if (!updateData.B && !updateData.P) {
      console.log(`[ACCOUNT] ℹ️ ACCOUNT_UPDATE sem dados de saldo ou posição para conta ${accountId} (motivo: ${reason})`);
    }

  } catch (error) {
    console.error(`[ACCOUNT] ❌ ERRO CRÍTICO ao processar atualização da conta ${accountId}:`, {
      error: error.message,
      stack: error.stack?.split('\n')?.[0],
      messageType: message?.e,
      reason: message?.a?.m
    });
  }
}

/**
 * ✅ VERSÃO COMPLETA: Processa atualizações de saldo com TODOS os campos
 */
// starboy/backend/exchanges/binance/services/accountHandlers.js - CORREÇÃO LINHA 100

/**
 * ✅ VERSÃO CORRIGIDA: Processa atualizações de saldo com lógica correta do saldo_base_calculo
 */
async function handleBalanceUpdates(connection, balances, accountId, reason, eventTime, transactionTime) {
  try {
    console.log(`[ACCOUNT] 💰 Processando ${balances.length} atualizações de saldo para conta ${accountId} (motivo: ${reason})`);
    
    for (const balance of balances) {
      const asset = balance.a;
      const walletBalance = parseFloat(balance.wb || '0');
      const crossWalletBalance = parseFloat(balance.cw || '0');
      const balanceChange = parseFloat(balance.bc || '0');
      
      // ✅ ATUALIZAR SALDO USDT SEMPRE
      if (asset === 'USDT') {
        try {
          console.log(`[ACCOUNT] 💰 ${asset}: Wallet=${walletBalance.toFixed(4)}, Cross=${crossWalletBalance.toFixed(4)}, Change=${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(4)}, Reason=${reason}`);
          
          const [currentData] = await connection.query(
            'SELECT saldo_futuros, saldo_base_calculo_futuros FROM contas WHERE id = ?',
            [accountId]
          );
          
          const previousBalance = currentData.length > 0 ? parseFloat(currentData[0].saldo_futuros || '0') : 0;
          const previousBaseCalculo = currentData.length > 0 ? parseFloat(currentData[0].saldo_base_calculo_futuros || '0') : 0;
          
          // ✅ CORREÇÃO: Lógica correta do saldo_base_calculo
          // saldo_base_calculo_futuros SÓ AUMENTA, NUNCA DIMINUI
          let novaBaseCalculo = previousBaseCalculo;
          if (walletBalance > previousBaseCalculo) {
            novaBaseCalculo = walletBalance;
            console.log(`[ACCOUNT] 📈 Saldo base de cálculo atualizado: ${previousBaseCalculo.toFixed(2)} → ${novaBaseCalculo.toFixed(2)} (saldo atual: ${walletBalance.toFixed(2)})`);
          } else {
            console.log(`[ACCOUNT] 📊 Saldo base de cálculo mantido: ${previousBaseCalculo.toFixed(2)} (saldo atual: ${walletBalance.toFixed(2)})`);
          }
          
          // ✅ VERIFICAR QUAIS COLUNAS EXISTEM
          const [columns] = await connection.query(`SHOW COLUMNS FROM contas`);
          const existingColumns = columns.map(col => col.Field);
          
          // ✅ CONSTRUIR UPDATE DINÂMICO - SEMPRE ATUALIZAR O SALDO
          let updateQuery = `UPDATE contas SET 
                           saldo_futuros = ?,
                           saldo_base_calculo_futuros = ?,
                           ultima_atualizacao = NOW()`;
          let updateValues = [walletBalance, novaBaseCalculo];
          
          // ✅ ADICIONAR CAMPOS NOVOS SE EXISTIREM
          if (existingColumns.includes('saldo_cross_wallet')) {
            updateQuery += `, saldo_cross_wallet = ?`;
            updateValues.push(crossWalletBalance);
          }
          
          if (existingColumns.includes('balance_change')) {
            updateQuery += `, balance_change = ?`;
            updateValues.push(balanceChange);
          }
          
          if (existingColumns.includes('last_event_reason')) {
            updateQuery += `, last_event_reason = ?`;
            updateValues.push(reason);
          }
          
          if (existingColumns.includes('event_time')) {
            updateQuery += `, event_time = ?`;
            updateValues.push(eventTime);
          }
          
          if (existingColumns.includes('transaction_time')) {
            updateQuery += `, transaction_time = ?`;
            updateValues.push(transactionTime);
          }
          
          updateQuery += ` WHERE id = ?`;
          updateValues.push(accountId);
          
          await connection.query(updateQuery, updateValues);
          
          console.log(`[ACCOUNT] ✅ Saldo USDT atualizado: ${walletBalance.toFixed(2)} USDT (base_calc: ${novaBaseCalculo.toFixed(2)}, change: ${balanceChange.toFixed(4)}, reason: ${reason})`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM - A FUNÇÃO formatBalanceMessage VAI DECIDIR SE ENVIA BASEADO NO LIMITE DE 0.01
          try {
            const message = formatBalanceMessage(accountId, previousBalance, walletBalance, reason, balanceChange);
            
            // ✅ SÓ ENVIA SE A MENSAGEM NÃO FOR NULL (mudança >= 0.01)
            if (message) {
              await sendTelegramMessage(accountId, message, chatId);
              console.log(`[ACCOUNT] 📱 Notificação de saldo enviada para mudança de ${balanceChange.toFixed(4)} USDT`);
            }
          } catch (telegramError) {
            console.warn(`[ACCOUNT] ⚠️ Erro ao enviar notificação de saldo:`, telegramError.message);
          }
          
        } catch (updateError) {
          console.error(`[ACCOUNT] ❌ Erro ao atualizar saldo USDT para conta ${accountId}:`, updateError.message);
        }
      } else {
        // ✅ LOG PARA OUTROS ASSETS (se necessário)
        if (Math.abs(balanceChange) > 0.001) {
          console.log(`[ACCOUNT] 💰 ${asset}: Wallet=${walletBalance.toFixed(8)}, Change=${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(8)}`);
        }
      }
    }
    
  } catch (error) {
    console.error(`[ACCOUNT] ❌ Erro ao processar atualizações de saldo:`, error.message);
  }
}

/**
 * ✅ VERSÃO COMPLETA: Processa atualizações de posições com TODOS os campos
 * Adicionado retry automático em caso de deadlock nas queries de update/insert
 */
async function handlePositionUpdates(connection, positions, accountId, reason, eventTime, transactionTime, retryCount = 0) {
  try {
    console.log(`[ACCOUNT] 📊 Processando ${positions.length} atualizações de posição para conta ${accountId} (motivo: ${reason})`);
    for (const positionData of positions) {
      const symbol = positionData.s;
      const positionAmt = parseFloat(positionData.pa || '0');
      const entryPrice = parseFloat(positionData.ep || '0');
      const breakevenPrice = parseFloat(positionData.bep || '0');
      const accumulatedRealized = parseFloat(positionData.cr || '0');
      const unrealizedPnl = parseFloat(positionData.up || '0');
      const marginType = positionData.mt || 'cross';
      const isolatedWallet = parseFloat(positionData.iw || '0');
      const positionSide = positionData.ps || 'BOTH';
      
      console.log(`[ACCOUNT] 📊 ${symbol}: Amount=${positionAmt}, Entry=${entryPrice}, UnrealizedPnL=${unrealizedPnl.toFixed(2)}, MarginType=${marginType}`);
      
      // Buscar posição aberta existente
      const [existingPositions] = await connection.query(
        'SELECT * FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
        [symbol, 'OPEN', accountId]
      );
      
      if (Math.abs(positionAmt) > 0.000001) {
        if (existingPositions.length > 0) {
          // Atualizar posição existente
          const positionId = existingPositions[0].id;
          let updateTries = 0;
          while (updateTries < 3) {
            try {
              // Montar update completo com todos os campos relevantes
              let updateQuery = `UPDATE posicoes SET quantidade = ?, preco_medio = ?, preco_entrada = ?, preco_corrente = ?, breakeven_price = ?, accumulated_realized = ?, unrealized_pnl = ?, margin_type = ?, isolated_wallet = ?, position_side = ?, event_reason = ?, webhook_data_raw = ?, data_hora_ultima_atualizacao = NOW() WHERE id = ?`;
              let updateValues = [positionAmt, entryPrice, entryPrice, entryPrice, breakevenPrice, accumulatedRealized, unrealizedPnl, marginType, isolatedWallet, positionSide, reason, JSON.stringify({ ...positionData, eventTime, transactionTime, reason, action: 'POSITION_UPDATE' }), positionId];
              await connection.query(updateQuery, updateValues);
              break;
            } catch (error) {
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && updateTries < 2) {
                updateTries++;
                await new Promise(res => setTimeout(res, 100 * (updateTries + 1)));
                continue;
              }
              throw error;
            }
          }
          console.log(`[ACCOUNT_UPDATE] ✅ Posição ${symbol} atualizada COMPLETAMENTE com todos os campos do webhook`);
        } else {
          // Só faz insert se pa != 0
          let newPositionId;
          let insertTries = 0;
          while (insertTries < 3) {
            try {
              const { insertPosition } = require('../../../core/database/conexao');
              newPositionId = await insertPosition(connection, {
                simbolo: symbol,
                quantidade: positionAmt,
                preco_medio: entryPrice,
                status: 'OPEN',
                data_hora_abertura: new Date(),
                side: positionSide,
                leverage: 1,
                data_hora_ultima_atualizacao: new Date(),
                preco_entrada: entryPrice,
                preco_corrente: entryPrice,
                breakeven_price: breakevenPrice,
                accumulated_realized: accumulatedRealized,
                unrealized_pnl: unrealizedPnl,
                margin_type: marginType,
                isolated_wallet: isolatedWallet,
                position_side: positionSide,
                event_reason: reason,
                webhook_data_raw: JSON.stringify({ ...positionData, eventTime, transactionTime, reason, action: 'POSITION_INSERT' }),
                conta_id: accountId
              }, accountId);
              break;
            } catch (error) {
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && insertTries < 2) {
                insertTries++;
                await new Promise(res => setTimeout(res, 100 * (insertTries + 1)));
                continue;
              }
              throw error;
            }
          }
          console.log(`[ACCOUNT_UPDATE] ✅ Nova posição COMPLETA criada: ${symbol} (ID: ${newPositionId}) com todos os campos do webhook`);
          
          // Após inserir a posição, vincular o id aos sinais e ordens
          if (newPositionId) {
            // Atualizar o webhook_signals mais recente com o mesmo symbol, status 'EXECUTADO' e conta
            await connection.query(
              `UPDATE webhook_signals SET position_id = ? WHERE symbol = ? AND status = 'EXECUTADO' AND conta_id = ? ORDER BY id DESC LIMIT 1`,
              [newPositionId, symbol, accountId]
            );
            // Atualizar ordens
            await connection.query(
              `UPDATE ordens SET id_posicao = ? WHERE simbolo = ? AND conta_id = ? AND (id_posicao IS NULL OR id_posicao = 0)`,
              [newPositionId, symbol, accountId]
            );
            // Atualizar ordens_fechadas
            await connection.query(
              `UPDATE ordens_fechadas SET id_posicao = ? WHERE simbolo = ? AND conta_id = ? AND (id_posicao IS NULL OR id_posicao = 0)`,
              [newPositionId, symbol, accountId]
            );
            console.log(`[ACCOUNT_UPDATE] 🔗 Posição ${symbol} (ID: ${newPositionId}) vinculada ao sinal e ordens/ordens_fechadas`);
          }
        }
      } else {
        // pa == 0: fechar posição existente, nunca fazer insert
        if (existingPositions.length > 0) {
          const positionId = existingPositions[0].id; // ✅ DEFINIR AQUI
           // === BUSCAR E SOMAR TRADES DA POSIÇÃO FECHADA ===
          try {
            const [posRows] = await connection.query('SELECT * FROM posicoes WHERE id = ?', [positionId]);
            if (posRows.length > 0) {
              const pos = posRows[0];
              const dataAbertura = new Date(pos.data_hora_abertura);
              const dataFechamento = new Date(pos.data_hora_fechamento);
              
              if (!isNaN(dataAbertura) && !isNaN(dataFechamento)) {
                // Aguarda 15 segundos para garantir que todos os trades estejam disponíveis na corretora
                //console.log(`[ACCOUNT_UPDATE] ⏳ Aguardando 15 segundos antes de buscar trades para cálculo do PnL...`);
                //await new Promise(res => setTimeout(res, 15000));
                
                // NOVA LÓGICA: Buscar orderIds das tabelas ordens e ordens_fechadas para a posição
                let orderIds = [];
                try {
                  // Buscar em ordens
                  const [ordensRows] = await connection.query('SELECT id_externo FROM ordens WHERE id_posicao = ?', [positionId]);
                  // Buscar em ordens_fechadas
                  const [ordensFechadasRows] = await connection.query('SELECT id_externo FROM ordens_fechadas WHERE id_posicao = ?', [positionId]);
                  orderIds = [
                    ...ordensRows.map(r => r.id_externo),
                    ...ordensFechadasRows.map(r => r.id_externo)
                  ].filter(Boolean);
                } catch (orderIdErr) {
                  console.error(`[ACCOUNT_UPDATE] ❌ Erro ao buscar orderIds para posição ${positionId}:`, orderIdErr.message);
                }
                if (orderIds.length === 0) {
                  console.warn(`[ACCOUNT_UPDATE] ⚠️ Nenhum orderId encontrado para a posição ${positionId}. Não será possível calcular o PnL por orderId.`);
                }
                let totalCommission = 0;
                let totalRealized = 0;
                const { getUserTrades } = require('../api/rest');
                for (const orderId of orderIds) {
                  try {
                    // Consultar trades por orderId
                    const trades = await getUserTrades(accountId, symbol, { orderId, recvWindow: 10000 });
                    if (Array.isArray(trades)) {
                      trades.forEach((t, idx) => {
                        const commission = parseFloat(t.commission || '0');
                        const realized = parseFloat(t.realizedPnl || '0');
                        if (!isNaN(commission)) totalCommission += commission;
                        if (!isNaN(realized)) totalRealized += realized;
                        // Log detalhado
                        console.log(`[ACCOUNT_UPDATE] [${accountId}] Trade #${idx + 1} para orderId ${orderId}:`, JSON.stringify(t));
                      });
                    } else {
                      console.log(`[ACCOUNT_UPDATE] [${accountId}] Nenhum trade retornado para orderId ${orderId}.`);
                    }
                  } catch (tradeErr) {
                    console.error(`[ACCOUNT_UPDATE] ❌ Erro ao buscar trades para orderId ${orderId}:`, tradeErr.message);
                  }
                }
                // LOGS DETALHADOS DO CÁLCULO
                console.log(`[ACCOUNT_UPDATE] 🧮 Trades da posição fechada ${symbol} (por orderId):`);
                console.log(`  - totalRealized (soma realizedPnl):`, totalRealized);
                console.log(`  - totalCommission (soma commission):`, totalCommission);
                const liquidPnl = totalRealized - totalCommission;
                console.log(`  - liquid_pnl (totalRealized - totalCommission):`, liquidPnl);
                await connection.query(
                  'UPDATE posicoes SET total_realized = ?, total_commission = ?, liquid_pnl = ? WHERE id = ?',
                  [totalRealized, totalCommission, liquidPnl, positionId]
                );
                console.log(`[ACCOUNT_UPDATE] 📝 UPDATE posicoes SET total_realized = ${totalRealized}, total_commission = ${totalCommission}, liquid_pnl = ${liquidPnl} WHERE id = ${positionId}`);

                // === ENVIAR MENSAGEM TELEGRAM APÓS ATUALIZAÇÃO DO PnL ===
                try {
                  // Buscar posição atualizada
                  const [updatedRows] = await connection.query('SELECT * FROM posicoes WHERE id = ?', [positionId]);
                  if (updatedRows.length > 0) {
                    const updatedPos = updatedRows[0];
                    // Buscar chatId da conta
                    const [contaRows] = await connection.query('SELECT telegram_chat_id FROM contas WHERE id = ?', [accountId]);
                    const chatId = contaRows.length > 0 ? contaRows[0].telegram_chat_id : null;
                    if (chatId) {
                      const { sendTelegramMessage, formatPositionClosedMessage } = require('../telegram/telegramBot');
                      const msg = await formatPositionClosedMessage(updatedPos, null, null, null, null, null, accountId);
                      await sendTelegramMessage(accountId, msg, chatId);
                      console.log(`[ACCOUNT_UPDATE] 📤 Mensagem de posição fechada enviada para Telegram (conta ${accountId}, chatId ${chatId})`);
                    } else {
                      console.warn(`[ACCOUNT_UPDATE] ⚠️ ChatId do Telegram não encontrado para conta ${accountId}`);
                    }
                  }
                } catch (telegramError) {
                  console.error(`[ACCOUNT_UPDATE] ❌ Erro ao enviar mensagem de posição fechada para o Telegram:`, telegramError.message);
                }
              }
            }
          } catch (tradeSumError) {
            console.error(`[ACCOUNT_UPDATE] ❌ Erro ao calcular comissão/realizado dos trades da posição fechada:`, tradeSumError.message);
          }

          // Verificar colunas para atualização final
          const [columns] = await connection.query(`SHOW COLUMNS FROM posicoes`);
          const existingColumns = columns.map(col => col.Field);
          let closeQuery = `UPDATE posicoes SET status = 'CLOSED', quantidade = 0, data_hora_fechamento = NOW(), data_hora_ultima_atualizacao = NOW()`;
          let closeValues = [];
          if (existingColumns.includes('accumulated_realized')) {
            closeQuery += `, accumulated_realized = ?`;
            closeValues.push(accumulatedRealized);
          }
          if (existingColumns.includes('unrealized_pnl')) {
            closeQuery += `, unrealized_pnl = 0`;
          }
          if (existingColumns.includes('event_reason')) {
            closeQuery += `, event_reason = ?`;
            closeValues.push(reason);
          }
          if (existingColumns.includes('webhook_data_raw')) {
            closeQuery += `, webhook_data_raw = ?`;
            closeValues.push(JSON.stringify({ ...positionData, eventTime, transactionTime, reason, action: 'POSITION_CLOSED' }));
          }
          closeQuery += ` WHERE id = ?`;
          closeValues.push(positionId);
          await connection.query(closeQuery, closeValues);
          console.log(`[ACCOUNT_UPDATE] ✅ Posição ${symbol} marcada como FECHADA com dados completos do webhook`);

          // ✅ MOVER PARA HISTÓRICO COM positionId DEFINIDO
          try {
            await movePositionToHistory(connection, positionId, 'CLOSED', reason, accountId);
          } catch (moveError) {
            console.error(`[ACCOUNT_UPDATE] ❌ Erro ao mover posição para histórico:`, moveError.message);
          }
        } else {
          console.log(`[ACCOUNT_UPDATE] Nenhuma posição aberta encontrada para ${symbol} ao tentar fechar.`);
        }
      }
    }
  } catch (error) {
    console.error(`[ACCOUNT] ❌ Erro ao processar atualizações de posição:`, error.message);
    throw error;
  }
}

/**
 * Registra os handlers de conta para uma conta específica
 */
function registerAccountHandlers(accountId) {
  try {
    console.log(`[ACCOUNT-HANDLERS] Registrando handlers de conta para conta ${accountId}...`);
    
    // VERIFICAR SE JÁ EXISTE handleAccountUpdate nos callbacks
    const existingCallbacks = websockets.getHandlers(accountId) || {};
    
    const accountCallbacks = {
      ...existingCallbacks, // Manter callbacks existentes (como handleOrderUpdate)
      handleAccountUpdate: (message, db) => handleAccountUpdate(message, accountId, db)
    };
    
    websockets.setMonitoringCallbacks(accountCallbacks, accountId);
    
    console.log(`[ACCOUNT-HANDLERS] ✅ Handlers de conta registrados para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ACCOUNT-HANDLERS] ❌ Erro ao registrar handlers de conta para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Verifica se os handlers de conta estão registrados
 */
function areAccountHandlersRegistered(accountId) {
  try {
    const handlers = websockets.getHandlers(accountId);
    const hasAccountHandler = handlers && typeof handlers.handleAccountUpdate === 'function';
    
    console.log(`[ACCOUNT-HANDLERS] Status do handler de conta para conta ${accountId}: ${hasAccountHandler ? '✅' : '❌'}`);
    return hasAccountHandler;
    
  } catch (error) {
    console.error(`[ACCOUNT-HANDLERS] Erro ao verificar handlers de conta para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Remove os handlers de conta
 */
function unregisterAccountHandlers(accountId) {
  try {
    console.log(`[ACCOUNT-HANDLERS] Removendo handlers de conta para conta ${accountId}...`);
    
    // MANTER outros callbacks, remover apenas handleAccountUpdate
    const existingCallbacks = websockets.getHandlers(accountId) || {};
    const cleanedCallbacks = { ...existingCallbacks };
    delete cleanedCallbacks.handleAccountUpdate;
    
    websockets.setMonitoringCallbacks(cleanedCallbacks, accountId);
    
    console.log(`[ACCOUNT-HANDLERS] ✅ Handlers de conta removidos para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ACCOUNT-HANDLERS] Erro ao remover handlers de conta para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Inicializa completamente o sistema de handlers de conta
 */
async function initializeAccountHandlers(accountId) {
  try {
    console.log(`[ACCOUNT-HANDLERS] Inicializando sistema de handlers de conta para conta ${accountId}...`);
    
    // VERIFICAR CONEXÃO COM BANCO
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    // REGISTRAR HANDLERS
    const registered = registerAccountHandlers(accountId);
    if (!registered) {
      throw new Error(`Falha ao registrar handlers de conta para conta ${accountId}`);
    }
    
    // VERIFICAR SE FORAM REGISTRADOS CORRETAMENTE
    const verified = areAccountHandlersRegistered(accountId);
    if (!verified) {
      throw new Error(`Handlers de conta não foram registrados corretamente para conta ${accountId}`);
    }
    
    console.log(`[ACCOUNT-HANDLERS] ✅ Sistema de handlers de conta inicializado com sucesso para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ACCOUNT-HANDLERS] ❌ Erro ao inicializar sistema de handlers de conta para conta ${accountId}:`, error.message);
    return false;
  }
}

module.exports = {
  handleAccountUpdate,
  handleBalanceUpdates,
  handlePositionUpdates,
  registerAccountHandlers,
  areAccountHandlersRegistered,
  unregisterAccountHandlers,
  initializeAccountHandlers
};