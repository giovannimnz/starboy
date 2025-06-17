const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets');

/**
 * Processa atualizações de ordens via WebSocket
 * @param {Object} orderMsg - Mensagem de ordem do WebSocket
 * @param {number} accountId - ID da conta
 */
async function handleOrderUpdate(orderMsg, accountId) {
  try {
    // VALIDAÇÃO: Parâmetros obrigatórios
    if (!orderMsg || !orderMsg.i || !orderMsg.s || !accountId) {
      console.error(`[ORDER] Parâmetros inválidos: orderMsg.i=${orderMsg?.i}, orderMsg.s=${orderMsg?.s}, accountId=${accountId}`);
      return;
    }

    // CORREÇÃO: Obter conexão usando getDatabaseInstance
    const db = await getDatabaseInstance(accountId);
    
    if (!db) {
      console.error(`[ORDER] Não foi possível obter conexão com banco para conta ${accountId}`);
      return;
    }
    
    // Buscar a ordem no banco com conta_id
    const [orders] = await db.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderMsg.i, orderMsg.s, accountId]
    );

    // Se ordem não encontrada mas está executada na corretora
    if (orders.length === 0 && (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      console.log(`[ORDER] Ordem ${orderMsg.i} executada na corretora mas não encontrada no banco para conta ${accountId} - possivelmente externa`);
      return;
    }

    if (orders.length === 0) {
      console.log(`[ORDER] Ordem ${orderMsg.i} não encontrada no banco de dados para conta ${accountId}`);
      return;
    }

    const order = orders[0];

    // Processar diferentes tipos de atualização
    if (order.tipo_ordem_bot === 'ENTRADA' &&
        (orderMsg.X === 'NEW' || orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      
      console.log(`[ORDER] Ordem de entrada ${orderMsg.i} (conta ${accountId}) atualizada: ${orderMsg.X}`);
      
      // Atualizar status no banco incluindo conta_id
      await db.query(
        'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?',
        [orderMsg.X, orderMsg.i, accountId]
      );
      
    } else if (orderMsg.X === 'CANCELED') {
      console.log(`[ORDER] Ordem ${orderMsg.i} (conta ${accountId}) cancelada`);
      
      await db.query(
        'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?',
        ['CANCELED', orderMsg.i, accountId]
      );
      
    } else if (orderMsg.X === 'EXPIRED') {
      console.log(`[ORDER] Ordem ${orderMsg.i} (conta ${accountId}) expirada`);
      
      await db.query(
        'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?',
        ['EXPIRED', orderMsg.i, accountId]
      );
    }

  } catch (error) {
    console.error(`[ORDER] Erro ao processar atualização de ordem (OrderID: ${orderMsg?.i}, Conta: ${accountId}): ${error.message}`);
  }
}

/**
 * Processa atualizações de conta via WebSocket
 * @param {Object} message - Mensagem de conta do WebSocket
 * @param {number} accountId - ID da conta
 */
async function handleAccountUpdate(message, accountId) {
  try {
    // Validar parâmetros
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ACCOUNT] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    // CORREÇÃO: Obter conexão usando getDatabaseInstance
    const db = await getDatabaseInstance(accountId);
    
    if (!db) {
      console.warn(`[ACCOUNT] Não foi possível obter conexão com banco para conta ${accountId}`);
      return;
    }

    // Verificar se há atualizações de posição no evento
    if (message.a && message.a.P) {
      console.log(`[ACCOUNT] Atualização de posições recebida para conta ${accountId}: ${message.a.P.length} posições`);
      
      // Processar cada posição atualizada
      for (const position of message.a.P) {
        const symbol = position.s;
        const positionAmt = parseFloat(position.pa);
        const entryPrice = parseFloat(position.ep);
        const unrealizedPnl = parseFloat(position.up);
        
        // Validar dados da posição
        if (!symbol) {
          console.warn(`[ACCOUNT] Símbolo inválido na posição para conta ${accountId}`);
          continue;
        }
        
        // Se a posição foi fechada (quantidade = 0)
        if (positionAmt === 0) {
          console.log(`[ACCOUNT] Posição ${symbol} foi fechada para conta ${accountId}`);
          
          try {
            const [result] = await db.query(
              `UPDATE posicoes SET status = 'CLOSED', 
               data_hora_fechamento = NOW(), 
               data_hora_ultima_atualizacao = NOW() 
               WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
              [symbol, accountId]
            );
            
            if (result.affectedRows > 0) {
              console.log(`[ACCOUNT] ✅ Posição ${symbol} marcada como fechada para conta ${accountId}`);
            } else {
              console.log(`[ACCOUNT] ⚠️ Nenhuma posição aberta encontrada para ${symbol} na conta ${accountId}`);
            }
            
          } catch (updateError) {
            console.error(`[ACCOUNT] ❌ Erro ao atualizar posição fechada ${symbol} (conta ${accountId}):`, updateError.message);
          }
        } else {
          // Atualizar posições abertas com novos dados
          console.log(`[ACCOUNT] Posição ${symbol} atualizada para conta ${accountId}: ${positionAmt} @ ${entryPrice} (PnL: ${unrealizedPnl})`);
          
          try {
            await db.query(
              `UPDATE posicoes SET 
               quantidade = ?, 
               preco_entrada = ?, 
               preco_corrente = ?,
               data_hora_ultima_atualizacao = NOW() 
               WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
              [Math.abs(positionAmt), entryPrice, entryPrice, symbol, accountId]
            );
          } catch (updateError) {
            console.error(`[ACCOUNT] ❌ Erro ao atualizar dados da posição ${symbol} (conta ${accountId}):`, updateError.message);
          }
        }
      }
    } else {
      // Log mais simples para outras atualizações de conta
      console.log(`[ACCOUNT] Atualização de conta recebida para conta ${accountId} (sem posições)`);
    }

  } catch (error) {
    console.error(`[ACCOUNT] Erro ao processar atualização da conta ${accountId}:`, error.message);
  }
}

/**
 * NOVA FUNÇÃO: Registra os handlers no sistema de websockets
 * @param {number} accountId - ID da conta
 */
function registerOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Registrando handlers para conta ${accountId}...`);
    
    // USAR websockets.setMonitoringCallbacks para registrar nossos handlers
    const callbacks = {
      handleOrderUpdate: (orderMsg, db) => handleOrderUpdate(orderMsg, accountId),
      handleAccountUpdate: (message, db) => handleAccountUpdate(message, accountId)
    };
    
    websockets.setMonitoringCallbacks(callbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handlers registrados para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao registrar handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * NOVA FUNÇÃO: Verifica se os handlers estão registrados
 * @param {number} accountId - ID da conta
 */
function areHandlersRegistered(accountId) {
  try {
    // USAR websockets.getHandlers para verificar se existem handlers
    const handlers = websockets.getHandlers(accountId);
    
    const hasOrderHandler = handlers && typeof handlers.handleOrderUpdate === 'function';
    const hasAccountHandler = handlers && typeof handlers.handleAccountUpdate === 'function';
    
    console.log(`[ORDER-HANDLERS] Status dos handlers para conta ${accountId}:`);
    console.log(`  - handleOrderUpdate: ${hasOrderHandler ? '✅' : '❌'}`);
    console.log(`  - handleAccountUpdate: ${hasAccountHandler ? '✅' : '❌'}`);
    
    return hasOrderHandler && hasAccountHandler;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao verificar handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * NOVA FUNÇÃO: Remove os handlers do sistema
 * @param {number} accountId - ID da conta
 */
function unregisterOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Removendo handlers para conta ${accountId}...`);
    
    // Registrar callbacks vazios para "limpar"
    const emptyCallbacks = {
      handleOrderUpdate: null,
      handleAccountUpdate: null
    };
    
    websockets.setMonitoringCallbacks(emptyCallbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handlers removidos para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao remover handlers para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * NOVA FUNÇÃO: Inicializa o sistema completo de handlers para uma conta
 * @param {number} accountId - ID da conta
 */
async function initializeOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Inicializando sistema para conta ${accountId}...`);
    
    // 1. Verificar se a conexão com banco existe
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    // 2. Registrar os handlers
    const registered = registerOrderHandlers(accountId);
    if (!registered) {
      throw new Error(`Falha ao registrar handlers para conta ${accountId}`);
    }
    
    // 3. Verificar se foram registrados corretamente
    const verified = areHandlersRegistered(accountId);
    if (!verified) {
      throw new Error(`Handlers não foram registrados corretamente para conta ${accountId}`);
    }
    
    console.log(`[ORDER-HANDLERS] ✅ Sistema inicializado com sucesso para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] ❌ Erro ao inicializar sistema para conta ${accountId}:`, error.message);
    return false;
  }
}

module.exports = {
  handleOrderUpdate,
  handleAccountUpdate,
  registerOrderHandlers,
  areHandlersRegistered,
  unregisterOrderHandlers,
  initializeOrderHandlers
};