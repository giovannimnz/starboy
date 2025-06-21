const { getDatabaseInstance, insertPosition, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatBalanceMessage, formatAlertMessage } = require('./telegramBot');

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
 * Processa atualizações de saldo - VERSÃO MELHORADA
 */
async function handleBalanceUpdates(connection, balances, accountId, reason) {
  try {
    console.log(`[ACCOUNT] 💰 Processando ${balances.length} atualizações de saldo para conta ${accountId} (motivo: ${reason})`);
    
    for (const balance of balances) {
      const asset = balance.a;
      const walletBalance = parseFloat(balance.wb || '0');
      const crossWalletBalance = parseFloat(balance.cw || '0');
      const balanceChange = parseFloat(balance.bc || '0');
      
      // LOG DETALHADO APENAS PARA MUDANÇAS SIGNIFICATIVAS
      if (Math.abs(balanceChange) > 0.001 || reason === 'FUNDING_FEE') {
        console.log(`[ACCOUNT] 💰 ${asset}: Wallet=${walletBalance.toFixed(4)}, Cross=${crossWalletBalance.toFixed(4)}, Change=${balanceChange >= 0 ? '+' : ''}${balanceChange.toFixed(4)}`);
      }
      
      // ATUALIZAR SALDO USDT NA TABELA CONTAS
      if (asset === 'USDT' && Math.abs(balanceChange) > 0.001) {
        try {
          const [currentData] = await connection.query(
            'SELECT saldo, saldo_base_calculo FROM contas WHERE id = ?',
            [accountId]
          );
          
          const previousBalance = currentData.length > 0 ? parseFloat(currentData[0].saldo || '0') : 0;
          const previousBaseCalculo = currentData.length > 0 ? parseFloat(currentData[0].saldo_base_calculo || '0') : 0;
          const calculoBasadaEm5Porcento = crossWalletBalance * 0.05;
          const novaBaseCalculo = Math.max(calculoBasadaEm5Porcento, previousBaseCalculo);
          
          await connection.query(
            `UPDATE contas SET 
             saldo = ?,
             saldo_base_calculo = ?,
             ultima_atualizacao = NOW()
             WHERE id = ?`,
            [walletBalance, novaBaseCalculo, accountId]
          );
          
          console.log(`[ACCOUNT] ✅ Saldo USDT atualizado: ${walletBalance.toFixed(2)} (base: ${novaBaseCalculo.toFixed(2)})`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM PARA MUDANÇAS SIGNIFICATIVAS
          if (Math.abs(balanceChange) > 10 || reason === 'REALIZED_PNL') { // Mudanças > $10 ou PnL realizado
            try {
              const message = formatBalanceMessage(accountId, previousBalance, walletBalance, reason);
              await sendTelegramMessage(accountId, message);
              console.log(`[ACCOUNT] 📱 Notificação de saldo enviada`);
            } catch (telegramError) {
              console.warn(`[ACCOUNT] ⚠️ Erro ao enviar notificação de saldo:`, telegramError.message);
            }
          }
          
        } catch (updateError) {
          console.error(`[ACCOUNT] ❌ Erro ao atualizar saldo USDT para conta ${accountId}:`, updateError.message);
        }
      }
    }
    
  } catch (error) {
    console.error(`[ACCOUNT] ❌ Erro ao processar atualizações de saldo:`, error.message);
  }
}

/**
 * Processa atualizações de posições - VERSÃO CORRIGIDA SEM OBSERVACOES E SEM VALIDAÇÃO DE PREÇO MÍNIMO
 */
async function handlePositionUpdates(connection, positions, accountId, reason, eventTime) {
  for (const positionData of positions) {
    const symbol = positionData.s;
    const positionAmt = parseFloat(positionData.pa || '0');
    
    if (Math.abs(positionAmt) > 0.000001) {
      // POSIÇÃO ABERTA OU AUMENTADA
      
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
        
        const positionData = {
          simbolo: symbol,
          quantidade: Math.abs(positionAmt),
          preco_medio: parseFloat(positionData.ep || '0'),
          status: 'OPEN',
          data_hora_abertura: formatDateForMySQL(new Date()),
          side: positionAmt > 0 ? 'BUY' : 'SELL',
          leverage: recentSignal[0]?.leverage || 1,
          data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
          preco_entrada: parseFloat(positionData.ep || '0'),
          preco_corrente: parseFloat(positionData.ep || '0'),
          orign_sig: recentSignal[0] ? `WEBHOOK_${recentSignal[0].id}` : null,
          quantidade_aberta: Math.abs(positionAmt),
          conta_id: accountId
        };
        
        const newPositionId = await insertPosition(connection, positionData, recentSignal[0]?.id);
        console.log(`[ACCOUNT_UPDATE] ✅ Nova posição criada via webhook: ${symbol} (ID: ${newPositionId})`);
        
        // Atualizar sinal com position_id
        if (recentSignal[0]) {
          await connection.query(
            `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
            [newPositionId, recentSignal[0].id]
          );
        }
      }
    }
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