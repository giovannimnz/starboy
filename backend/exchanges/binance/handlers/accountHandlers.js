const { getDatabaseInstance, insertPosition, formatDateForPostgreSQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const { sendTelegramMessage, formatBalanceMessage } = require('../services/telegramHelper');
const { movePositionToHistory } = require('../services/cleanup');

// ✅ CACHE GLOBAL PARA EVITAR DUPLICIDADE DE MENSAGENS DE FECHAMENTO (COMPARTILHADO)
// Usando uma instância global para garantir que seja único em toda a aplicação
if (!global.telegramPositionCache) {
  global.telegramPositionCache = {
    recentlyClosedPositions: new Map(), // positionId -> timestamp
    recentTelegramSents: new Map(),     // `accountId-positionId` -> timestamp
    recentEventMessages: new Map()      // messageId -> timestamp (NOVO: evita processamento duplo de eventos)
  };
}

const recentlyClosedPositions = global.telegramPositionCache.recentlyClosedPositions;
const recentTelegramSents = global.telegramPositionCache.recentTelegramSents;
const recentEventMessages = global.telegramPositionCache.recentEventMessages;

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
    
    // ✅ LOG DETALHADO PARA RASTREAR MÚLTIPLAS INVOCAÇÕES
    const messageId = `${eventTime}-${accountId}-${reason}`;
    console.log(`[ACCOUNT_UPDATE_ENTRY] 🔍 ENTRADA - messageId: ${messageId}, conta: ${accountId}, evento: ${reason}, timestamp: ${new Date(eventTime).toISOString()}`);
    
    // ✅ CACHE DE DEDUPLICAÇÃO DE EVENTOS: Verificar se este evento já foi processado
    const now = Date.now();
    if (recentEventMessages.has(messageId)) {
      const lastProcessed = recentEventMessages.get(messageId);
      const timeDiff = now - lastProcessed;
      console.log(`[ACCOUNT_UPDATE] 🚨 EVENTO DUPLICADO DETECTADO! messageId: ${messageId} já foi processado há ${Math.round(timeDiff/1000)}s, ignorando`);
      console.log(`[ACCOUNT_UPDATE] 🔍 Esta é uma execução duplicada do handler que foi PREVENIDA pelo cache de eventos!`);
      return; // ✅ SAIR IMEDIATAMENTE PARA EVITAR PROCESSAMENTO DUPLICADO
    }
    
    // ✅ MARCAR EVENTO COMO PROCESSADO IMEDIATAMENTE (ATÔMICO)
    recentEventMessages.set(messageId, now);
    console.log(`[ACCOUNT_UPDATE] 🔒 Evento ${messageId} marcado como processado no cache`);
    
    // Limpar cache de eventos após 30 segundos (para evitar acúmulo excessivo)
    setTimeout(() => {
      recentEventMessages.delete(messageId);
      console.log(`[ACCOUNT_UPDATE] 🧹 Cache de evento limpo para ${messageId}`);
    }, 30 * 1000);
    
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
    console.error(`[ACCOUNT] ❌ Erro fatal no handleAccountUpdate para conta ${accountId}:`, error);
    // Não relançar o erro para não derrubar o listener do WebSocket
  }
}

/**
 * ✅ NOVO: Handler principal para o evento 'accountUpdate' do Pub/Sub.
 * Este handler é o ponto de entrada para todas as atualizações de conta vindas do WebSocket.
 * @param {Object} jsonData - A mensagem completa do WebSocket.
 */
async function onAccountUpdate(jsonData) {
    // O accountId é obtido através do contexto do listener quando registrado no pub/sub
    // Vamos extrair do próprio evento se disponível
    let accountId = null;
    
    // Tentar obter accountId de diferentes formas
    if (jsonData && jsonData.accountId) {
        accountId = jsonData.accountId;
    } else if (global.currentProcessAccountId) {
        accountId = global.currentProcessAccountId;
    } else {
        console.error('[ACCOUNT_UPDATE] AccountId não encontrado. JsonData:', jsonData);
        return;
    }
    
    // Chama a função de lógica de negócios existente.
    await handleAccountUpdate(jsonData, accountId);
}

/**
 * ✅ NOVO: Registra os handlers de conta no sistema Pub/Sub do WebSocket.
 * Deve ser chamado uma vez na inicialização do monitor.
 */
function registerAccountHandlers(accountId) {
    if (!accountId) {
        console.error('[ACCOUNT_HANDLERS] AccountId é obrigatório para registrar handlers');
        return;
    }
    
    // Criar um wrapper que captura o accountId
    const accountUpdateWrapper = (jsonData) => {
        handleAccountUpdate(jsonData, accountId);
    };
    
    const listenerId = 'mainAccountHandler'; // ID único para este listener
    websockets.on('accountUpdate', accountUpdateWrapper, accountId, listenerId);
    console.log(`[ACCOUNT_HANDLERS] 🎧 Handler principal de conta registrado para a conta ${accountId} com o ID: ${listenerId}`);
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
            'SELECT saldo_futuros, saldo_base_calculo_futuros FROM contas WHERE id = $1',
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
          const columns = await connection.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'contas' AND table_schema = CURRENT_SCHEMA()`);
          const existingColumns = columns.rows.map(row => row.column_name);
          
          // ✅ CONSTRUIR UPDATE DINÂMICO - SEMPRE ATUALIZAR O SALDO
          let updateQuery = `UPDATE contas SET 
                           saldo_futuros = $1,
                           saldo_base_calculo_futuros = $2,
                           ultima_atualizacao = CURRENT_TIMESTAMP`;
          let updateValues = [walletBalance, novaBaseCalculo];
          
          // ✅ ADICIONAR CAMPOS NOVOS SE EXISTIREM
          if (existingColumns.includes('saldo_cross_wallet')) {
            updateQuery += `, saldo_cross_wallet = $1`;
            updateValues.push(crossWalletBalance);
          }
          
          if (existingColumns.includes('balance_change')) {
            updateQuery += `, balance_change = $1`;
            updateValues.push(balanceChange);
          }
          
          if (existingColumns.includes('last_event_reason')) {
            updateQuery += `, last_event_reason = $1`;
            updateValues.push(reason);
          }
          
          if (existingColumns.includes('event_time')) {
            updateQuery += `, event_time = $1`;
            updateValues.push(eventTime);
          }
          
          if (existingColumns.includes('transaction_time')) {
            updateQuery += `, transaction_time = $1`;
            updateValues.push(transactionTime);
          }
          
          updateQuery += ` WHERE id = $1`;
          updateValues.push(accountId);
          
          // ✅ RETRY EM CASO DE DEADLOCK - ATUALIZAÇÃO DE SALDO
          let balanceUpdateTries = 0;
          while (balanceUpdateTries < 1000) {
            try {
              await connection.query(updateQuery, updateValues);
              break;
            } catch (error) {
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && balanceUpdateTries < 999) {
                balanceUpdateTries++;
                console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar saldo, tentativa ${balanceUpdateTries}/1000...`);
                await new Promise(res => setTimeout(res, 10 + Math.random() * 50)); // 10-60ms random delay
                continue;
              }
              throw error;
            }
          }
          
          console.log(`[ACCOUNT] ✅ Saldo USDT atualizado: ${walletBalance.toFixed(2)} USDT (base_calc: ${novaBaseCalculo.toFixed(2)}, change: ${balanceChange.toFixed(4)}, reason: ${reason})`);
          
          // ✅ NOTIFICAÇÃO TELEGRAM - A FUNÇÃO formatBalanceMessage VAI DECIDIR SE ENVIA BASEADO NO LIMITE DE 0.01
          try {
            const message = formatBalanceMessage(accountId, previousBalance, walletBalance, reason, balanceChange);
            
            // ✅ SÓ ENVIA SE A MENSAGEM NÃO FOR NULL (mudança >= 0.01)
            if (message) {
            //  await sendTelegramMessage(accountId, message, chatId);
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
    const functionEntry = `${eventTime}-${accountId}-${reason}-${Date.now()}`;
    console.log(`[POSITION_UPDATE_ENTRY] 🔍 ENTRADA - functionEntry: ${functionEntry}, positions: ${positions.length}, conta: ${accountId}, motivo: ${reason}`);
    
    // ✅ VERIFICAÇÃO ADICIONAL: Se já temos um cache de evento marcado, este processamento de posição deveria ser único
    const eventKey = `${eventTime}-${accountId}-${reason}`;
    if (!recentEventMessages.has(eventKey)) {
      console.warn(`[POSITION_UPDATE_ENTRY] ⚠️ ATENÇÃO: Processando posições para evento ${eventKey} que não está no cache de eventos!`);
    }
    
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
        'SELECT * FROM posicoes WHERE simbolo = $1 AND status = $2 AND conta_id = $3',
        [symbol, 'OPEN', accountId]
      );
      
      if (Math.abs(positionAmt) > 0.000001) {
        if (existingPositions.length > 0) {
          // Atualizar posição existente
          const positionId = existingPositions[0].id;
          let updateTries = 0;
          while (updateTries < 1000) {
            try {
              // Montar update completo com todos os campos relevantes
              let updateQuery = `UPDATE posicoes SET quantidade = $1, preco_medio = $2, preco_entrada = $3, preco_corrente = $4, breakeven_price = $5, accumulated_realized = $6, unrealized_pnl = $7, margin_type = $8, isolated_wallet = $9, position_side = $10, event_reason = $11, webhook_data_raw = $12, data_hora_ultima_atualizacao = CURRENT_TIMESTAMP WHERE id = $13`;
              let updateValues = [positionAmt, entryPrice, entryPrice, entryPrice, breakevenPrice, accumulatedRealized, unrealizedPnl, marginType, isolatedWallet, positionSide, reason, JSON.stringify({ ...positionData, eventTime, transactionTime, reason, action: 'POSITION_UPDATE' }), positionId];
              await connection.query(updateQuery, updateValues);
              break;
            } catch (error) {
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && updateTries < 999) {
                updateTries++;
                console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar posição, tentativa ${updateTries}/1000...`);
                await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
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
          while (insertTries < 1000) {
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
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && insertTries < 999) {
                insertTries++;
                console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao inserir posição, tentativa ${insertTries}/1000...`);
                await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                continue;
              }
              throw error;
            }
          }
          console.log(`[ACCOUNT_UPDATE] ✅ Nova posição COMPLETA criada: ${symbol} (ID: ${newPositionId}) com todos os campos do webhook`);
          
          // Após inserir a posição, vincular o id aos sinais e ordens
          if (newPositionId) {
            console.log(`[ACCOUNT_UPDATE] 🔗 Iniciando vinculação da posição ${newPositionId} (${symbol}) aos sinais e ordens...`);
            
            // ✅ PRIMEIRO: Buscar sinais candidatos para debug
            try {
              const [candidateSignals] = await connection.query(
                `SELECT id, symbol, status, position_id, created_at FROM webhook_signals 
                 WHERE symbol = $1 AND conta_id = $2 AND (position_id IS NULL OR position_id = 0) 
                 ORDER BY created_at DESC LIMIT 5`,
                [symbol, accountId]
              );
              
              console.log(`[ACCOUNT_UPDATE] 🔍 Sinais candidatos encontrados para ${symbol} (conta ${accountId}):`, 
                candidateSignals.map(s => `ID:${s.id}, Status:${s.status}, PositionId:${s.position_id}, Created:${s.created_at}`));
            } catch (debugError) {
              console.warn(`[ACCOUNT_UPDATE] ⚠️ Erro ao buscar sinais candidatos para debug:`, debugError.message);
            }
            
            // ✅ BUSCAR E ATUALIZAR O SINAL MAIS RECENTE (prioridade EXECUTADO, fallback qualquer status)
            let webhookUpdateTries = 0;
            let signalUpdated = false;
            while (webhookUpdateTries < 1000 && !signalUpdated) {
              try {
                let signalToUpdate = null;
                
                // 1️⃣ PRIMEIRO: Buscar sinal mais recente com status 'EXECUTADO' sem position_id
                console.log(`[ACCOUNT_UPDATE] 🔍 Buscando sinal EXECUTADO para ${symbol} (conta ${accountId})...`);
                const [executedSignals] = await connection.query(
                  `SELECT id, status, created_at FROM webhook_signals 
                   WHERE symbol = $1 AND conta_id = $2 AND status = 'EXECUTADO' AND (position_id IS NULL OR position_id = 0)
                   ORDER BY created_at DESC LIMIT 1`,
                  [symbol, accountId]
                );
                
                if (executedSignals.length > 0) {
                  signalToUpdate = executedSignals[0];
                  console.log(`[ACCOUNT_UPDATE] ✅ Encontrado sinal EXECUTADO: ID ${signalToUpdate.id} (${signalToUpdate.created_at})`);
                } else {
                  console.log(`[ACCOUNT_UPDATE] ⚠️ Nenhum sinal EXECUTADO encontrado, buscando fallback...`);
                  
                  // 2️⃣ FALLBACK: Buscar sinal mais recente de qualquer status sem position_id
                  const [anyStatusSignals] = await connection.query(
                    `SELECT id, status, created_at FROM webhook_signals 
                     WHERE symbol = $1 AND conta_id = $2 AND (position_id IS NULL OR position_id = 0)
                     ORDER BY created_at DESC LIMIT 1`,
                    [symbol, accountId]
                  );
                  
                  if (anyStatusSignals.length > 0) {
                    signalToUpdate = anyStatusSignals[0];
                    console.log(`[ACCOUNT_UPDATE] 📋 Usando sinal fallback: ID ${signalToUpdate.id} (status: ${signalToUpdate.status}, ${signalToUpdate.created_at})`);
                  }
                }
                
                if (signalToUpdate) {
                  const signalId = signalToUpdate.id;
                  const signalStatus = signalToUpdate.status;
                  
                  console.log(`[ACCOUNT_UPDATE] 🎯 Vinculando posição ${newPositionId} ao sinal ${signalId} (status: ${signalStatus})`);
                  
                  // Atualizar o sinal específico
                  const [updateResult] = await connection.query(
                    `UPDATE webhook_signals SET position_id = $1 WHERE id = $2`,
                    [newPositionId, signalId]
                  );
                  
                  if (updateResult.rowCount > 0) {
                    console.log(`[ACCOUNT_UPDATE] ✅ Sinal ${signalId} vinculado à posição ${newPositionId} com sucesso (tipo: ${signalStatus === 'EXECUTADO' ? 'prioritário' : 'fallback'})`);
                    signalUpdated = true;
                  } else {
                    console.warn(`[ACCOUNT_UPDATE] ⚠️ Nenhuma linha afetada ao atualizar sinal ${signalId}`);
                  }
                } else {
                  console.warn(`[ACCOUNT_UPDATE] ⚠️ Nenhum sinal encontrado para vincular à posição ${newPositionId} (${symbol}, conta ${accountId})`);
                  signalUpdated = true; // Para parar o loop
                }
                
                break;
              } catch (error) {
                if (error.message && error.message.includes('Deadlock found when trying to get lock') && webhookUpdateTries < 999) {
                  webhookUpdateTries++;
                  console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar webhook_signals, tentativa ${webhookUpdateTries}/1000...`);
                  await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                  continue;
                }
                throw error;
              }
            }
            
            // ✅ ATUALIZAR ORDENS COM LOGS DETALHADOS
            console.log(`[ACCOUNT_UPDATE] 🔗 Vinculando ordens à posição ${newPositionId}...`);
            
            let ordensUpdateTries = 0;
            while (ordensUpdateTries < 1000) {
              try {
                const [ordensResult] = await connection.query(
                  `UPDATE ordens SET id_posicao = $1 WHERE simbolo = $2 AND conta_id = $3 AND (id_posicao IS NULL OR id_posicao = 0)`,
                  [newPositionId, symbol, accountId]
                );
                console.log(`[ACCOUNT_UPDATE] ✅ ${ordensResult.rowCount} ordens vinculadas à posição ${newPositionId}`);
                break;
              } catch (error) {
                if (error.message && error.message.includes('Deadlock found when trying to get lock') && ordensUpdateTries < 999) {
                  ordensUpdateTries++;
                  console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar ordens, tentativa ${ordensUpdateTries}/1000...`);
                  await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                  continue;
                }
                throw error;
              }
            }
            
            // ✅ ATUALIZAR ORDENS_FECHADAS COM LOGS DETALHADOS
            let ordensFechadasUpdateTries = 0;
            while (ordensFechadasUpdateTries < 1000) {
              try {
                const [ordensFechadasResult] = await connection.query(
                  `UPDATE ordens_fechadas SET id_posicao = $1 WHERE simbolo = $2 AND conta_id = $3 AND (id_posicao IS NULL OR id_posicao = 0)`,
                  [newPositionId, symbol, accountId]
                );
                console.log(`[ACCOUNT_UPDATE] ✅ ${ordensFechadasResult.rowCount} ordens_fechadas vinculadas à posição ${newPositionId}`);
                break;
              } catch (error) {
                if (error.message && error.message.includes('Deadlock found when trying to get lock') && ordensFechadasUpdateTries < 999) {
                  ordensFechadasUpdateTries++;
                  console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar ordens_fechadas, tentativa ${ordensFechadasUpdateTries}/1000...`);
                  await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                  continue;
                }
                throw error;
              }
            }
            
            // ✅ LOG FINAL DE CONFIRMAÇÃO
            try {
              const [finalCheck] = await connection.query(
                `SELECT id, status, position_id FROM webhook_signals 
                 WHERE symbol = $1 AND conta_id = $2 AND position_id = $3`,
                [symbol, accountId, newPositionId]
              );
              
              if (finalCheck.length > 0) {
                console.log(`[ACCOUNT_UPDATE] ✅ CONFIRMADO: Sinal ${finalCheck[0].id} vinculado à posição ${newPositionId} (status: ${finalCheck[0].status})`);
              } else {
                console.warn(`[ACCOUNT_UPDATE] ⚠️ ATENÇÃO: Nenhum sinal encontrado vinculado à posição ${newPositionId} após tentativa de vinculação`);
              }
            } catch (checkError) {
              console.warn(`[ACCOUNT_UPDATE] ⚠️ Erro ao verificar vinculação final:`, checkError.message);
            }
            
            console.log(`[ACCOUNT_UPDATE] 🔗 Posição ${symbol} (ID: ${newPositionId}) processada completamente`);
          }
        }
      } else {
        // pa == 0: fechar posição existente, nunca fazer insert
        if (existingPositions.length > 0) {
          const positionId = existingPositions[0].id; // ✅ DEFINIR AQUI
          const wasOpen = existingPositions[0].status === 'OPEN'; // ✅ VERIFICAR SE ESTAVA ABERTA ANTES
          
          // ✅ SÓ PROCESSAR SE A POSIÇÃO ESTAVA REALMENTE ABERTA
          if (!wasOpen) {
            console.log(`[ACCOUNT_UPDATE] ⚠️ Posição ${symbol} (ID: ${positionId}) já estava fechada (status: ${existingPositions[0].status}), ignorando evento de fechamento`);
            continue;
          }
          
          // ✅ CACHE PARA EVITAR DUPLICIDADE - Verificar se já foi processada recentemente
          const now = Date.now();
          const positionKey = `${accountId}-${positionId}`;
          console.log(`[DEDUP_CACHE_CHECK] 🔍 Verificando cache para ${positionKey}, cache atual:`, Array.from(recentlyClosedPositions.entries()));
          
          const recentlyClosed = recentlyClosedPositions.has(positionKey);
          if (recentlyClosed) {
            const lastProcessed = recentlyClosedPositions.get(positionKey);
            const timeDiff = now - lastProcessed;
            console.log(`[ACCOUNT_UPDATE] � DUPLICAÇÃO DETECTADA! Posição ${symbol} (ID: ${positionId}) já foi processada há ${Math.round(timeDiff/1000)}s, ignorando evento duplicado`);
            console.log(`[ACCOUNT_UPDATE] 🔍 Esta é uma duplicação de evento ACCOUNT_UPDATE que foi PREVENIDA pelo cache!`);
            continue;
          }
          
          // ✅ MARCAR POSIÇÃO COMO PROCESSADA NO CACHE IMEDIATAMENTE (antes do processamento)
          console.log(`[DEDUP_CACHE_SET] ✅ Marcando ${positionKey} como processada no cache`);
          recentlyClosedPositions.set(positionKey, now);
          // Remover do cache após 2 minutos (reduzido de 5 para evitar atraso em reprocessamento legítimo)
          setTimeout(() => {
            recentlyClosedPositions.delete(positionKey);
            console.log(`[ACCOUNT_UPDATE] 🧹 Cache limpo para posição ${positionKey}`);
          }, 2 * 60 * 1000);
          
          console.log(`[ACCOUNT_UPDATE] 🔄 Fechando posição ${symbol} (ID: ${positionId}) que estava OPEN - PROCESSAMENTO ÚNICO`);
          console.log(`[POSITION_CLOSE_TRACKING] 🎯 Início do fechamento: positionId=${positionId}, symbol=${symbol}, conta=${accountId}, eventTime=${eventTime}`);
          
           // === BUSCAR E SOMAR TRADES DA POSIÇÃO FECHADA ===
          try {
            const [posRows] = await connection.query('SELECT * FROM posicoes WHERE id = $1', [positionId]);
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
                  const [ordensRows] = await connection.query('SELECT id_externo FROM ordens WHERE id_posicao = $1', [positionId]);
                  // Buscar em ordens_fechadas
                  const [ordensFechadasRows] = await connection.query('SELECT id_externo FROM ordens_fechadas WHERE id_posicao = $2', [positionId]);
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
                
                // ✅ RETRY EM CASO DE DEADLOCK - ATUALIZAÇÃO DO PnL
                let pnlUpdateTries = 0;
                while (pnlUpdateTries < 1000) {
                  try {
                    await connection.query(
                      'UPDATE posicoes SET total_realized = $1, total_commission = $2, liquid_pnl = $3 WHERE id = $4',
                      [totalRealized, totalCommission, liquidPnl, positionId]
                    );
                    break;
                  } catch (error) {
                    if (error.message && error.message.includes('Deadlock found when trying to get lock') && pnlUpdateTries < 999) {
                      pnlUpdateTries++;
                      console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao atualizar PnL, tentativa ${pnlUpdateTries}/1000...`);
                      await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                      continue;
                    }
                    throw error;
                  }
                }
                
                console.log(`[ACCOUNT_UPDATE] 📝 UPDATE posicoes SET total_realized = ${totalRealized}, total_commission = ${totalCommission}, liquid_pnl = ${liquidPnl} WHERE id = ${positionId}`);

                // === ENVIAR MENSAGEM TELEGRAM APÓS ATUALIZAÇÃO DO PnL ===
                try {
                  // Buscar posição atualizada
                  const [updatedRows] = await connection.query('SELECT * FROM posicoes WHERE id = $1', [positionId]);
                  if (updatedRows.length > 0) {
                    const updatedPos = updatedRows[0];
                    
                    // ✅ BUSCAR registry_message_id DO SINAL CORRESPONDENTE À CONTA ESPECÍFICA
                    let replyToMessageId = null;
                    try {
                      const [signalRows] = await connection.query(
                        `SELECT registry_message_id FROM webhook_signals 
                         WHERE position_id = $1 AND conta_id = $2 AND registry_message_id IS NOT NULL 
                         ORDER BY id DESC LIMIT 1`,
                        [positionId, accountId]
                      );
                      
                      if (signalRows.length > 0 && signalRows[0].registry_message_id) {
                        replyToMessageId = signalRows[0].registry_message_id;
                        console.log(`[ACCOUNT_UPDATE] 📱 Enviando mensagem como resposta à mensagem ${replyToMessageId} (conta ${accountId})`);
                      } else {
                        console.log(`[ACCOUNT_UPDATE] 📱 Nenhum registry_message_id encontrado para posição ${positionId} da conta ${accountId}`);
                      }
                    } catch (signalError) {
                      console.warn(`[ACCOUNT_UPDATE] ⚠️ Erro ao buscar registry_message_id:`, signalError.message);
                    }
                    
                    // Buscar chatId da conta
                    const [contaRows] = await connection.query('SELECT telegram_chat_id FROM contas WHERE id = $1', [accountId]);
                    const chatId = contaRows.length > 0 ? contaRows[0].telegram_chat_id : null;
                    if (chatId) {
                      // ✅ SISTEMA DE DEDUPLICAÇÃO ULTRA-ROBUSTO
                      // Combinar múltiplos identificadores para criar chave única
                      const positionHash = `${accountId}-${positionId}-${updatedPos.simbolo}-${Math.round(updatedPos.liquid_pnl * 10000)}`;
                      const telegramKey = `${accountId}-${positionId}`;
                      const globalKey = `pos_closed_${positionHash}`;
                      const now = Date.now();
                      
                      console.log(`[TELEGRAM_DUPLICATE_CHECK] 🔍 Verificação de duplicação para posição ${positionId}:`);
                      console.log(`[TELEGRAM_DUPLICATE_CHECK] 📋 Hash da posição: ${positionHash}`);
                      console.log(`[TELEGRAM_DUPLICATE_CHECK] 📋 Cache telegram atual:`, Array.from(recentTelegramSents.keys()));
                      console.log(`[TELEGRAM_DUPLICATE_CHECK] 📋 Cache posições atual:`, Array.from(recentlyClosedPositions.keys()));
                      
                      // ✅ VERIFICAÇÃO 1: Cache específico do Telegram
                      if (recentTelegramSents.has(telegramKey)) {
                        const lastSent = recentTelegramSents.get(telegramKey);
                        const timeDiff = now - lastSent;
                        console.log(`[TELEGRAM_DISPATCHER] 🚨 DUPLICAÇÃO TELEGRAM DETECTADA! Posição ${positionId} já teve mensagem enviada há ${Math.round(timeDiff/1000)}s`);
                      } else if (recentlyClosedPositions.has(globalKey)) {
                        // ✅ VERIFICAÇÃO 2: Cache global de posições fechadas com hash
                        const lastClosed = recentlyClosedPositions.get(globalKey);
                        const timeDiff = now - lastClosed;
                        console.log(`[TELEGRAM_DISPATCHER] 🚨 DUPLICAÇÃO GLOBAL DETECTADA! Hash ${positionHash} já processado há ${Math.round(timeDiff/1000)}s`);
                      } else {
                        // ✅ MARCAR TODAS AS PROTEÇÕES ANTES DE ENVIAR (ATÔMICO)
                        recentTelegramSents.set(telegramKey, now);
                        recentlyClosedPositions.set(globalKey, now);
                        console.log(`[TELEGRAM_DISPATCHER] 🔒 Posição ${positionId} marcada em TODOS os caches antes do envio`);
                        
                        // ✅ LIMPEZA AUTOMÁTICA DOS CACHES (3 minutos)
                        setTimeout(() => {
                          recentTelegramSents.delete(telegramKey);
                          recentlyClosedPositions.delete(globalKey);
                          console.log(`[TELEGRAM_DISPATCHER] 🧹 Caches limpos para posição ${positionId}`);
                        }, 3 * 60 * 1000);
                        
                        // ✅ PROCEDER COM O ENVIO (todas as verificações passaram)
                        const timestamp = new Date().toLocaleString('pt-BR');
                        console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: accountHandlers.js | AÇÃO: Disparando mensagem de POSIÇÃO FECHADA`);
                        console.log(`[TELEGRAM_DISPATCHER] 📋 Dados: Conta=${accountId}, Symbol=${updatedPos.simbolo}, PnL=${updatedPos.liquid_pnl}, PositionID=${positionId}`);
                        console.log(`[TELEGRAM_DISPATCHER] 🔗 ReplyTo: ${replyToMessageId || 'nenhum'}, ChatID=${chatId}`);
                        
                        const { formatAndSendPositionClosed } = require('../services/telegramHelper');
                        const result = await formatAndSendPositionClosed(accountId, updatedPos, replyToMessageId);
                        
                        console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado do envio de posição fechada:`, JSON.stringify(result, null, 2));
                        
                        if (result && result.success) {
                          console.log(`[TELEGRAM_DISPATCHER] ✅ ${timestamp} | accountHandlers.js | Mensagem de posição fechada enviada com SUCESSO (conta ${accountId})`);
                        } else {
                          console.warn(`[TELEGRAM_DISPATCHER] ⚠️ ${timestamp} | accountHandlers.js | FALHA ao enviar mensagem de posição fechada`);
                          console.warn(`[TELEGRAM_DISPATCHER] 🔍 Erro:`, result$1.error || 'Erro desconhecido');
                          console.warn(`[TELEGRAM_DISPATCHER] 🔍 Resposta completa:`, result);
                        }
                      }
                    } else {
                      const timestamp = new Date().toLocaleString('pt-BR');
                      console.warn(`[TELEGRAM_DISPATCHER] ⚠️ ${timestamp} | accountHandlers.js | ChatId do Telegram não encontrado para conta ${accountId}`);
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
          const columns = await connection.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'posicoes' AND table_schema = CURRENT_SCHEMA()`);
          const existingColumns = columns.rows.map(row => row.column_name);
          let closeQuery = `UPDATE posicoes SET status = 'CLOSED', quantidade = 0, data_hora_fechamento = CURRENT_TIMESTAMP, data_hora_ultima_atualizacao = CURRENT_TIMESTAMP`;
          let closeValues = [];
          if (existingColumns.includes('accumulated_realized')) {
            closeQuery += `, accumulated_realized = $1`;
            closeValues.push(accumulatedRealized);
          }
          if (existingColumns.includes('unrealized_pnl')) {
            closeQuery += `, unrealized_pnl = 0`;
          }
          if (existingColumns.includes('event_reason')) {
            closeQuery += `, event_reason = $1`;
            closeValues.push(reason);
          }
          if (existingColumns.includes('webhook_data_raw')) {
            closeQuery += `, webhook_data_raw = $1`;
            closeValues.push(JSON.stringify({ ...positionData, eventTime, transactionTime, reason, action: 'POSITION_CLOSED' }));
          }
          closeQuery += ` WHERE id = $1`;
          closeValues.push(positionId);
          
          // ✅ RETRY EM CASO DE DEADLOCK - FECHAMENTO DE POSIÇÃO
          let closeUpdateTries = 0;
          while (closeUpdateTries < 1000) {
            try {
              await connection.query(closeQuery, closeValues);
              break;
            } catch (error) {
              if (error.message && error.message.includes('Deadlock found when trying to get lock') && closeUpdateTries < 999) {
                closeUpdateTries++;
                console.warn(`[ACCOUNT] ⚠️ Deadlock detectado ao fechar posição, tentativa ${closeUpdateTries}/1000...`);
                await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                continue;
              }
              throw error;
            }
          }
          
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

/**
 * ✅ FUNÇÃO DEBUG: Mostra status dos caches de deduplicação
 */
function debugCacheStatus() {
  console.log(`[CACHE_DEBUG] 📊 Status dos caches de deduplicação:`);
  console.log(`[CACHE_DEBUG] 🔒 Posições recentemente fechadas: ${recentlyClosedPositions.size} entradas`);
  console.log(`[CACHE_DEBUG] 📱 Telegramas recentemente enviados: ${recentTelegramSents.size} entradas`);
  console.log(`[CACHE_DEBUG] 🎯 Eventos recentemente processados: ${recentEventMessages.size} entradas`);
  console.log(`[CACHE_DEBUG] 📋 Detalhes das posições:`, Array.from(recentlyClosedPositions.entries()));
  console.log(`[CACHE_DEBUG] 📋 Detalhes dos telegramas:`, Array.from(recentTelegramSents.entries()));
  console.log(`[CACHE_DEBUG] 📋 Detalhes dos eventos:`, Array.from(recentEventMessages.entries()));
}

/**
 * ✅ FUNÇÃO TESTE: Simula teste de deduplicação
 */
function testDeduplication(accountId, positionId) {
  const positionKey = `${accountId}-${positionId}`;
  const telegramKey = `${accountId}-${positionId}`;
  
  console.log(`[DEDUP_TEST] 🧪 Testando deduplicação para posição ${positionKey}`);
  
  // Teste 1: Verificar se posição está no cache
  const isInPositionCache = recentlyClosedPositions.has(positionKey);
  console.log(`[DEDUP_TEST] 📋 Posição no cache de fechamento: ${isInPositionCache}`);
  
  // Teste 2: Verificar se telegram está no cache
  const isInTelegramCache = recentTelegramSents.has(telegramKey);
  console.log(`[DEDUP_TEST] 📱 Telegram no cache de envio: ${isInTelegramCache}`);
  
  return {
    positionCached: isInPositionCache,
    telegramCached: isInTelegramCache
  };
}

/**
 * ✅ FUNÇÃO UTILITÁRIA: Limpa todos os caches de deduplicação
 */
function clearAllCaches() {
  const positionCount = recentlyClosedPositions.size;
  const telegramCount = recentTelegramSents.size;
  const eventCount = recentEventMessages.size;
  
  recentlyClosedPositions.clear();
  recentTelegramSents.clear();
  recentEventMessages.clear();
  
  console.log(`[CACHE_CLEAR] 🧹 Todos os caches limpos:`);
  console.log(`[CACHE_CLEAR] 📋 Posições removidas: ${positionCount}`);
  console.log(`[CACHE_CLEAR] 📱 Telegramas removidos: ${telegramCount}`);
  console.log(`[CACHE_CLEAR] 🎯 Eventos removidos: ${eventCount}`);
  
  return {
    positionsCleared: positionCount,
    telegramsCleared: telegramCount,
    eventsCleared: eventCount
  };
}

/**
 * ✅ FUNÇÃO UTILITÁRIA: Verifica e corrige sinais órfãos (sem position_id)
 * Pode ser chamada periodicamente para garantir que não haja sinais perdidos
 */
async function fixOrphanSignals(accountId = null) {
  try {
    console.log(`[ACCOUNT_ORPHAN] 🔍 Iniciando verificação de sinais órfãos${accountId ? ` para conta ${accountId}` : ' para todas as contas'}...`);
    
    const connection = await getDatabaseInstance(accountId || 1);
    if (!connection) {
      console.error(`[ACCOUNT_ORPHAN] ❌ Não foi possível obter conexão com banco`);
      return 0;
    }

    // Buscar sinais órfãos dos últimos 30 minutos
    let orphanQuery = `
      SELECT ws.id, ws.symbol, ws.conta_id, ws.status, ws.created_at
      FROM webhook_signals ws
      WHERE (ws.position_id IS NULL OR ws.position_id = 0)
        AND ws.created_at >= (CURRENT_TIMESTAMP - INTERVAL '30 MINUTE')
    `;
    let queryParams = [];
    
    if (accountId) {
      orphanQuery += ` AND ws.conta_id = $1`;
      queryParams.push(accountId);
    }
    
    orphanQuery += ` ORDER BY ws.created_at DESC`;
    
    const [orphanSignals] = await connection.query(orphanQuery, queryParams);

    if (orphanSignals.length === 0) {
      console.log(`[ACCOUNT_ORPHAN] ✅ Nenhum sinal órfão encontrado`);
      return 0;
    }

    console.log(`[ACCOUNT_ORPHAN] 🔍 Encontrados ${orphanSignals.length} sinais órfãos para verificação`);

    let linkedCount = 0;

    for (const signal of orphanSignals) {
      try {
        // Buscar posição OPEN mais recente para o mesmo símbolo e conta
        const [positions] = await connection.query(`
          SELECT id, quantidade, preco_medio, data_hora_abertura
          FROM posicoes 
          WHERE simbolo = $1 AND conta_id = $2 AND status = 'OPEN' AND ABS(quantidade) > 0
          ORDER BY data_hora_abertura DESC, id DESC
          LIMIT 1
        `, [signal.symbol, signal.conta_id]);

        if (positions.length > 0) {
          const position = positions[0];
          
          // Verificar se a posição foi criada próximo ao horário do sinal (margem de 10 minutos)
          const signalTime = new Date(signal.created_at);
          const positionTime = new Date(position.data_hora_abertura);
          const timeDiff = Math.abs(positionTime.getTime() - signalTime.getTime());
          const tenMinutes = 10 * 60 * 1000;

          if (timeDiff <= tenMinutes) {
            // Atualizar sinal com retry robusto
            let updateTries = 0;
            while (updateTries < 100) {
              try {
                const [updateResult] = await connection.query(
                  `UPDATE webhook_signals SET position_id = $1 WHERE id = $2`,
                  [position.id, signal.id]
                );
                
                if (updateResult.rowCount > 0) {
                  console.log(`[ACCOUNT_ORPHAN] ✅ Sinal órfão ${signal.id} (${signal.symbol}) vinculado à posição ${position.id}`);
                  console.log(`[ACCOUNT_ORPHAN]   - Quantidade posição: ${position.quantidade}`);
                  console.log(`[ACCOUNT_ORPHAN]   - Preço médio: ${position.preco_medio}`);
                  console.log(`[ACCOUNT_ORPHAN]   - Diferença temporal: ${(timeDiff / 1000).toFixed(1)}s`);
                  
                  linkedCount++;
                } else {
                  console.warn(`[ACCOUNT_ORPHAN] ⚠️ Nenhuma linha afetada ao vincular sinal órfão ${signal.id}`);
                }
                break;
                
              } catch (updateError) {
                if (updateError.message && updateError.message.includes('Deadlock found when trying to get lock') && updateTries < 99) {
                  updateTries++;
                  console.warn(`[ACCOUNT_ORPHAN] ⚠️ Deadlock ao vincular sinal órfão, tentativa ${updateTries}/100...`);
                  await new Promise(res => setTimeout(res, 10 + Math.random() * 50));
                  continue;
                }
                throw updateError;
              }
            }
          } else {
            console.log(`[ACCOUNT_ORPHAN] ⏭️ Sinal ${signal.id} (${signal.symbol}): diferença temporal muito grande (${(timeDiff / 1000).toFixed(1)}s)`);
          }
        } else {
          console.log(`[ACCOUNT_ORPHAN] 🔍 Sinal ${signal.id} (${signal.symbol}): nenhuma posição OPEN encontrada`);
        }
        
      } catch (signalError) {
        console.error(`[ACCOUNT_ORPHAN] ❌ Erro ao processar sinal órfão ${signal.id}:`, signalError.message);
      }
    }

    if (linkedCount > 0) {
      console.log(`[ACCOUNT_ORPHAN] ✅ Total de sinais órfãos corrigidos: ${linkedCount}/${orphanSignals.length}`);
    } else {
      console.log(`[ACCOUNT_ORPHAN] ℹ️ Nenhum sinal órfão pôde ser corrigido`);
    }

    return linkedCount;
    
  } catch (error) {
    console.error(`[ACCOUNT_ORPHAN] ❌ Erro ao verificar sinais órfãos:`, error.message);
    return 0;
  }
}

/**
 * ✅ FUNÇÃO DIAGNÓSTICO: Monitora e reporta atividade de deduplicação em tempo real
 */
function monitorDeduplication() {
  const stats = {
    totalEventMessages: recentEventMessages.size,
    totalClosedPositions: recentlyClosedPositions.size,
    totalTelegramSents: recentTelegramSents.size,
    recentEvents: Array.from(recentEventMessages.entries()).slice(-5), // Últimos 5
    recentPositions: Array.from(recentlyClosedPositions.entries()).slice(-5),
    recentTelegrams: Array.from(recentTelegramSents.entries()).slice(-5),
    timestamp: new Date().toISOString()
  };
  
  console.log(`[DEDUP_MONITOR] 📊 Status da deduplicação em ${stats.timestamp}:`);
  console.log(`[DEDUP_MONITOR] 🎯 Eventos recentes: ${stats.totalEventMessages}`);
  console.log(`[DEDUP_MONITOR] 🔒 Posições fechadas: ${stats.totalClosedPositions}`);
  console.log(`[DEDUP_MONITOR] 📱 Telegramas enviados: ${stats.totalTelegramSents}`);
  
  return stats;
}

/**
 * ✅ FUNÇÃO ALERTA: Detecta padrões suspeitos que podem indicar duplicações
 */
function detectSuspiciousPatterns() {
  const now = Date.now();
  const suspiciousEvents = [];
  
  // Verificar eventos muito próximos no tempo
  const eventTimes = Array.from(recentEventMessages.values());
  for (let i = 1; i < eventTimes.length; i++) {
    const timeDiff = eventTimes[i] - eventTimes[i-1];
    if (timeDiff < 1000) { // Menos de 1 segundo
      suspiciousEvents.push({
        type: 'RAPID_EVENTS',
        timeDiff,
        message: `Eventos muito próximos detectados (${timeDiff}ms)`
      });
    }
  }
  
  // Verificar se há muitas entradas no cache (possível memory leak)
  if (recentEventMessages.size > 100) {
    suspiciousEvents.push({
      type: 'CACHE_OVERFLOW',
      cacheSize: recentEventMessages.size,
      message: `Cache de eventos muito grande: ${recentEventMessages.size} entradas`
    });
  }
  
  if (suspiciousEvents.length > 0) {
    console.warn(`[DEDUP_ALERT] 🚨 Padrões suspeitos detectados:`, suspiciousEvents);
  }
  
  return suspiciousEvents;
}

module.exports = {
  handleAccountUpdate,
  handleBalanceUpdates,
  handlePositionUpdates,
  registerAccountHandlers
};