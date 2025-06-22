const { getDatabaseInstance, insertPosition, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatBalanceMessage, formatAlertMessage } = require('../services/telegramBot');

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
            'SELECT saldo, saldo_base_calculo FROM contas WHERE id = ?',
            [accountId]
          );
          
          const previousBalance = currentData.length > 0 ? parseFloat(currentData[0].saldo || '0') : 0;
          const previousBaseCalculo = currentData.length > 0 ? parseFloat(currentData[0].saldo_base_calculo || '0') : 0;
          
          // ✅ CORREÇÃO: Lógica correta do saldo_base_calculo
          // saldo_base_calculo SÓ AUMENTA, NUNCA DIMINUI
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
                           saldo = ?,
                           saldo_base_calculo = ?,
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
          
          // ✅ NOTIFICAÇÃO TELEGRAM PARA MUDANÇAS SIGNIFICATIVAS
          if (Math.abs(balanceChange) > 5 || reason === 'FUNDING_FEE' || reason === 'REALIZED_PNL' || reason === 'ORDER') {
            try {
              const message = formatBalanceMessage(accountId, previousBalance, walletBalance, reason, balanceChange);
              await sendTelegramMessage(accountId, message);
              console.log(`[ACCOUNT] 📱 Notificação de saldo enviada para mudança de ${balanceChange.toFixed(4)} USDT`);
            } catch (telegramError) {
              console.warn(`[ACCOUNT] ⚠️ Erro ao enviar notificação de saldo:`, telegramError.message);
            }
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
 */
async function handlePositionUpdates(connection, positions, accountId, reason, eventTime, transactionTime) {
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
      
      if (Math.abs(positionAmt) > 0.000001) {
        // ✅ POSIÇÃO ABERTA OU AUMENTADA
        
        // Verificar se é nova posição
        const [existingPositions] = await connection.query(
          'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
          [symbol, 'OPEN', accountId]
        );
        
        if (existingPositions.length === 0) {
          // ✅ NOVA POSIÇÃO - BUSCAR SINAL ORIGINAL
          const [recentSignal] = await connection.query(`
            SELECT id, side, leverage 
            FROM webhook_signals 
            WHERE symbol = ? AND status IN ('ENTRADA_EM_PROGRESSO', 'EXECUTADO') 
            AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
            ORDER BY id DESC LIMIT 1
          `, [symbol]);
          
          // ✅ VERIFICAR COLUNAS DA TABELA POSICOES
          const [columns] = await connection.query(`SHOW COLUMNS FROM posicoes`);
          const existingColumns = columns.map(col => col.Field);
          
          // ✅ PREPARAR DADOS COMPLETOS DA POSIÇÃO
          const completePositionData = {
            simbolo: symbol,
            quantidade: Math.abs(positionAmt),
            preco_medio: entryPrice,
            status: 'OPEN',
            data_hora_abertura: formatDateForMySQL(new Date()),
            side: positionAmt > 0 ? 'BUY' : 'SELL',
            leverage: recentSignal[0]?.leverage || 1,
            data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
            preco_entrada: entryPrice,
            preco_corrente: entryPrice,
            orign_sig: recentSignal[0] ? `WEBHOOK_${recentSignal[0].id}` : null,
            quantidade_aberta: Math.abs(positionAmt),
            conta_id: accountId
          };
          
          // ✅ ADICIONAR CAMPOS NOVOS SE EXISTIREM
          if (existingColumns.includes('breakeven_price')) {
            completePositionData.breakeven_price = breakevenPrice;
          }
          if (existingColumns.includes('accumulated_realized')) {
            completePositionData.accumulated_realized = accumulatedRealized;
          }
          if (existingColumns.includes('unrealized_pnl')) {
            completePositionData.unrealized_pnl = unrealizedPnl;
          }
          if (existingColumns.includes('margin_type')) {
            completePositionData.margin_type = marginType;
          }
          if (existingColumns.includes('isolated_wallet')) {
            completePositionData.isolated_wallet = isolatedWallet;
          }
          if (existingColumns.includes('position_side')) {
            completePositionData.position_side = positionSide;
          }
          if (existingColumns.includes('event_reason')) {
            completePositionData.event_reason = reason;
          }
          if (existingColumns.includes('webhook_data_raw')) {
            completePositionData.webhook_data_raw = JSON.stringify({
              ...positionData,
              eventTime: eventTime,
              transactionTime: transactionTime,
              reason: reason
            });
          }
          
          const newPositionId = await insertPosition(connection, completePositionData, recentSignal[0]?.id);
          console.log(`[ACCOUNT_UPDATE] ✅ Nova posição COMPLETA criada: ${symbol} (ID: ${newPositionId}) com todos os campos do webhook`);
          
          // Atualizar sinal com position_id
          if (recentSignal[0]) {
            await connection.query(
              `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
              [newPositionId, recentSignal[0].id]
            );
          }
          
        } else {
          // ✅ ATUALIZAR POSIÇÃO EXISTENTE COM TODOS OS CAMPOS
          const positionId = existingPositions[0].id;
          
          // Verificar colunas novamente
          const [columns] = await connection.query(`SHOW COLUMNS FROM posicoes`);
          const existingColumns = columns.map(col => col.Field);
          
          let updateQuery = `UPDATE posicoes SET 
                           quantidade = ?,
                           preco_medio = ?,
                           preco_entrada = ?,
                           preco_corrente = ?,
                           data_hora_ultima_atualizacao = NOW()`;
          let updateValues = [Math.abs(positionAmt), entryPrice, entryPrice, entryPrice];
          
          // ✅ ADICIONAR CAMPOS NOVOS SE EXISTIREM
          if (existingColumns.includes('breakeven_price')) {
            updateQuery += `, breakeven_price = ?`;
            updateValues.push(breakevenPrice);
          }
          if (existingColumns.includes('accumulated_realized')) {
            updateQuery += `, accumulated_realized = ?`;
            updateValues.push(accumulatedRealized);
          }
          if (existingColumns.includes('unrealized_pnl')) {
            updateQuery += `, unrealized_pnl = ?`;
            updateValues.push(unrealizedPnl);
          }
          if (existingColumns.includes('margin_type')) {
            updateQuery += `, margin_type = ?`;
            updateValues.push(marginType);
          }
          if (existingColumns.includes('isolated_wallet')) {
            updateQuery += `, isolated_wallet = ?`;
            updateValues.push(isolatedWallet);
          }
          if (existingColumns.includes('position_side')) {
            updateQuery += `, position_side = ?`;
            updateValues.push(positionSide);
          }
          if (existingColumns.includes('event_reason')) {
            updateQuery += `, event_reason = ?`;
            updateValues.push(reason);
          }
          if (existingColumns.includes('webhook_data_raw')) {
            updateQuery += `, webhook_data_raw = ?`;
            updateValues.push(JSON.stringify({
              ...positionData,
              eventTime: eventTime,
              transactionTime: transactionTime,
              reason: reason
            }));
          }
          
          updateQuery += ` WHERE id = ?`;
          updateValues.push(positionId);
          
          await connection.query(updateQuery, updateValues);
          
          console.log(`[ACCOUNT_UPDATE] ✅ Posição ${symbol} atualizada COMPLETAMENTE com todos os campos do webhook`);
        }
        
      } else {
        // ✅ POSIÇÃO FECHADA (Position Amount = 0)
        console.log(`[ACCOUNT_UPDATE] 🏁 Posição ${symbol} fechada (Amount=0) - atualizando status...`);
        
        const [positionToClose] = await connection.query(
          'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
          [symbol, 'OPEN', accountId]
        );
        
        if (positionToClose.length > 0) {
          // Verificar colunas para atualização final
          const [columns] = await connection.query(`SHOW COLUMNS FROM posicoes`);
          const existingColumns = columns.map(col => col.Field);
          
          let closeQuery = `UPDATE posicoes SET 
                          status = 'CLOSED',
                          quantidade = 0,
                          data_hora_fechamento = NOW(),
                          data_hora_ultima_atualizacao = NOW()`;
          let closeValues = [];
          
          // ✅ ADICIONAR CAMPOS FINAIS
          if (existingColumns.includes('accumulated_realized')) {
            closeQuery += `, accumulated_realized = ?`;
            closeValues.push(accumulatedRealized);
          }
          if (existingColumns.includes('unrealized_pnl')) {
            closeQuery += `, unrealized_pnl = 0`; // Zero ao fechar
          }
          if (existingColumns.includes('event_reason')) {
            closeQuery += `, event_reason = ?`;
            closeValues.push(reason);
          }
          if (existingColumns.includes('webhook_data_raw')) {
            closeQuery += `, webhook_data_raw = ?`;
            closeValues.push(JSON.stringify({
              ...positionData,
              eventTime: eventTime,
              transactionTime: transactionTime,
              reason: reason,
              action: 'POSITION_CLOSED'
            }));
          }
          
          closeQuery += ` WHERE id = ?`;
          closeValues.push(positionToClose[0].id);
          
          await connection.query(closeQuery, closeValues);
          
          console.log(`[ACCOUNT_UPDATE] ✅ Posição ${symbol} marcada como FECHADA com dados completos do webhook`);
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