const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const websockets = require('../websockets');

/**
 * Processa atualizações de ordens via WebSocket USER_DATA_STREAM
 * @param {Object} orderMsg - Mensagem de ordem do WebSocket
 * @param {number} accountId - ID da conta
 * @param {Object} db - Conexão com banco (opcional)
 */
async function handleOrderUpdate(orderMsg, accountId, db = null) {
  try {
    // VALIDAÇÃO: Parâmetros obrigatórios
    if (!orderMsg || !orderMsg.o || !orderMsg.o.i || !orderMsg.o.s || !accountId) {
      console.error(`[ORDER] Parâmetros inválidos: orderMsg.o.i=${orderMsg?.o?.i}, orderMsg.o.s=${orderMsg?.o?.s}, accountId=${accountId}`);
      return;
    }

    const order = orderMsg.o;
    const orderId = String(order.i); // ID da ordem
    const symbol = order.s;
    const executionType = order.x; // NEW, CANCELED, TRADE, etc.
    const orderStatus = order.X; // NEW, FILLED, PARTIALLY_FILLED, etc.
    const commission = parseFloat(order.n || '0');
    const commissionAsset = order.N || null;
    const tradeId = order.t || null;

    console.log(`[ORDER] Atualização recebida: ${orderId} (${symbol}) - ${executionType}/${orderStatus} - Executado: ${parseFloat(order.z || '0')}/${parseFloat(order.q || '0')}`);

    // OBTER CONEXÃO COM BANCO
    let connection = db;
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
      if (!connection) {
        console.error(`[ORDER] Não foi possível obter conexão com banco para conta ${accountId}`);
        return;
      }
    }

    // BUSCAR ORDEM NO BANCO
    const [existingOrders] = await connection.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderId, symbol, accountId]
    );

    let orderExists = existingOrders.length > 0;
    let existingOrder = orderExists ? existingOrders[0] : null;

    // PROCESSAR DIFERENTES TIPOS DE EXECUÇÃO
    switch (executionType) {
      case 'NEW':
        await handleNewOrder(connection, order, accountId, existingOrder);
        break;
        
      case 'TRADE':
        await handleTradeExecution(connection, order, accountId, existingOrder);
        break;
        
      case 'CANCELED':
        await handleOrderCancellation(connection, order, accountId, existingOrder);
        break;
        
      case 'EXPIRED':
        await handleOrderExpiry(connection, order, accountId, existingOrder);
        break;
        
      case 'AMENDMENT':
        await handleOrderAmendment(connection, order, accountId, existingOrder);
        break;
        
      default:
        console.log(`[ORDER] Tipo de execução não tratado: ${executionType} para ordem ${orderId}`);
        // Ainda assim, atualizar status se ordem existe
        if (orderExists) {
          await connection.query(
            'UPDATE ordens SET status = ?, last_update = NOW() WHERE id_externo = ? AND conta_id = ?',
            [orderStatus, orderId, accountId]
          );
        }
    }

  } catch (error) {
    console.error(`[ORDER] Erro ao processar atualização de ordem (OrderID: ${orderMsg?.o?.i}, Conta: ${accountId}): ${error.message}`);
  }
}

/**
 * Trata criação de nova ordem
 */
async function handleNewOrder(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  const symbol = order.s;
  
  try {
    if (existingOrder) {
      // Ordem já existe, apenas atualizar status e dados do WebSocket
      await connection.query(
        `UPDATE ordens SET 
         status = ?, 
         last_update = NOW(),
         dados_originais_ws = ?
         WHERE id_externo = ? AND conta_id = ?`,
        [order.X, JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem existente ${orderId} atualizada para ${order.X}`);
    } else {
      // ✅ BUSCAR POSIÇÃO RELACIONADA ANTES DE CRIAR A ORDEM
      let positionId = null;
      
      if (order.R === true) {
        // Se é reduce-only, deve ter uma posição existente
        const [existingPositions] = await connection.query(
          'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
          [symbol, 'OPEN', accountId]
        );
        
        if (existingPositions.length > 0) {
          positionId = existingPositions[0].id;
          console.log(`[ORDER] Ordem reduce-only ${orderId} vinculada à posição ${positionId}`);
        }
      }
      
      // ✅ USAR ESTRUTURA CORRETA DA TABELA
      const orderData = {
        tipo_ordem: mapOrderType(order.o),
        preco: parseFloat(order.p || '0'),
        quantidade: parseFloat(order.q || '0'),
        id_posicao: positionId, // NULL para ordens de entrada
        status: order.X,
        data_hora_criacao: formatDateForMySQL(new Date(order.T || Date.now())),
        id_externo: orderId,
        side: order.S,
        simbolo: symbol,
        tipo_ordem_bot: determineOrderBotType(order),
        target: null,
        reduce_only: order.R === true ? 1 : 0,
        close_position: order.cp === true ? 1 : 0,
        last_update: formatDateForMySQL(new Date()),
        orign_sig: extractOriginSignal(order.c),
        observacao: null,
        preco_executado: parseFloat(order.ap || '0'),
        quantidade_executada: parseFloat(order.z || '0'),
        dados_originais_ws: JSON.stringify(order),
        conta_id: accountId,
        renew_sl_firs: null,
        renew_sl_seco: null,
        commission: parseFloat(order.n || '0'),
        commission_asset: order.N || null,
        trade_id: order.t || null
      };

      // ✅ INSERIR COM QUERY MANUAL PARA CONTROLE COMPLETO
      const insertQuery = `
        INSERT INTO ordens (
          tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao,
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only,
          close_position, last_update, orign_sig, observacao, preco_executado,
          quantidade_executada, dados_originais_ws, conta_id, renew_sl_firs,
          renew_sl_seco, commission, commission_asset, trade_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;
      
      const insertValues = [
        orderData.tipo_ordem, orderData.preco, orderData.quantidade, orderData.id_posicao,
        orderData.status, orderData.data_hora_criacao, orderData.id_externo, orderData.side,
        orderData.simbolo, orderData.tipo_ordem_bot, orderData.target, orderData.reduce_only,
        orderData.close_position, orderData.last_update, orderData.orign_sig, orderData.observacao,
        orderData.preco_executado, orderData.quantidade_executada, orderData.dados_originais_ws,
        orderData.conta_id, orderData.renew_sl_firs, orderData.renew_sl_seco, orderData.commission,
        orderData.commission_asset, orderData.trade_id
      ];

      const [result] = await connection.query(insertQuery, insertValues);
      const orderInsertId = result.insertId;
      
      console.log(`[ORDER] Nova ordem ${orderId} inserida no banco com ID ${orderInsertId}${positionId ? ` (vinculada à posição ${positionId})` : ' (sem posição vinculada)'}`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar nova ordem ${orderId}:`, error.message);
  }
}

/**
 * Trata execução de trade
 */
async function handleTradeExecution(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  const symbol = order.s;
  const executedQty = parseFloat(order.z || '0');
  const avgPrice = parseFloat(order.ap || '0');
  const lastFilledQty = parseFloat(order.l || '0');
  const lastFilledPrice = parseFloat(order.L || '0');
  const commission = parseFloat(order.n || '0');
  const commissionAsset = order.N || null;
  const tradeId = order.t || null;
  
  try {
    // ATUALIZAR ORDEM NO BANCO
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = ?, 
         quantidade_executada = ?,
         preco_executado = ?,
         commission = ?,
         commission_asset = ?,
         trade_id = ?,
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [order.X, executedQty, avgPrice, commission, commissionAsset, tradeId, JSON.stringify(order), orderId, accountId]
      );
    } else {
      // Criar ordem se não existe (pode acontecer com ordens externas)
      console.log(`[ORDER] Ordem ${orderId} executada mas não encontrada no banco, criando...`);
      await handleNewOrder(connection, order, accountId, null);
    }

    // SE ORDEM FOI TOTALMENTE PREENCHIDA, VERIFICAR SE PRECISA CRIAR/ATUALIZAR POSIÇÃO
    if (order.X === 'FILLED' && !order.R) { // Se não é reduce only
      await handlePositionFromOrder(connection, order, accountId);
    }

    console.log(`[ORDER] Trade executado: ${orderId} - ${lastFilledQty} @ ${lastFilledPrice} (Total: ${executedQty}) - Comissão: ${commission} ${commissionAsset}`);
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar execução de trade ${orderId}:`, error.message);
  }
}

/**
 * Trata cancelamento de ordem
 */
async function handleOrderCancellation(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = 'CANCELED',
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} cancelada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar cancelamento ${orderId}:`, error.message);
  }
}

/**
 * Trata expiração de ordem
 */
async function handleOrderExpiry(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         status = 'EXPIRED',
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} expirada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar expiração ${orderId}:`, error.message);
  }
}

/**
 * Trata modificação de ordem
 */
async function handleOrderAmendment(connection, order, accountId, existingOrder) {
  const orderId = String(order.i);
  
  try {
    if (existingOrder) {
      await connection.query(
        `UPDATE ordens SET 
         preco = ?,
         quantidade = ?,
         status = ?,
         dados_originais_ws = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ?`,
        [parseFloat(order.p || '0'), parseFloat(order.q || '0'), order.X, JSON.stringify(order), orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} modificada`);
    }
  } catch (error) {
    console.error(`[ORDER] Erro ao tratar modificação ${orderId}:`, error.message);
  }
}

/**
 * Cria ou atualiza posição baseada na ordem executada
 */
async function handlePositionFromOrder(connection, order, accountId) {
  const symbol = order.s;
  const side = order.S;
  const executedQty = parseFloat(order.z || '0');
  const avgPrice = parseFloat(order.ap || '0');
  const orderId = String(order.i);
  
  try {
    // BUSCAR POSIÇÃO EXISTENTE
    const [existingPositions] = await connection.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
      [symbol, 'OPEN', accountId]
    );

    let positionId = null;

    if (existingPositions.length > 0) {
      // ATUALIZAR POSIÇÃO EXISTENTE
      const existingPos = existingPositions[0];
      positionId = existingPos.id;
      
      const currentQty = parseFloat(existingPos.quantidade || '0');
      const currentPrice = parseFloat(existingPos.preco_medio || '0');
      
      let newQty, newAvgPrice;
      
      if (existingPos.side === side) {
        // MESMA DIREÇÃO - SOMAR QUANTIDADE E RECALCULAR PREÇO MÉDIO
        newQty = currentQty + executedQty;
        newAvgPrice = ((currentQty * currentPrice) + (executedQty * avgPrice)) / newQty;
      } else {
        // DIREÇÃO OPOSTA - REDUZIR QUANTIDADE
        newQty = Math.abs(currentQty - executedQty);
        newAvgPrice = newQty > 0 ? currentPrice : avgPrice;
      }
      
      if (newQty <= 0.000001) {
        // POSIÇÃO FECHADA
        await connection.query(
          `UPDATE posicoes SET 
           status = 'CLOSED',
           quantidade = 0,
           data_hora_fechamento = NOW(),
           data_hora_ultima_atualizacao = NOW()
           WHERE id = ?`,
          [existingPos.id]
        );
        
        console.log(`[ORDER] Posição ${symbol} fechada via ordem ${orderId}`);
        positionId = null;
      } else {
        // POSIÇÃO ATUALIZADA
        await connection.query(
          `UPDATE posicoes SET 
           quantidade = ?,
           preco_medio = ?,
           preco_entrada = ?,
           preco_corrente = ?,
           side = ?,
           data_hora_ultima_atualizacao = NOW()
           WHERE id = ?`,
          [newQty, newAvgPrice, newAvgPrice, avgPrice, side, existingPos.id]
        );
        
        console.log(`[ORDER] Posição ${symbol} atualizada: ${newQty} @ ${newAvgPrice.toFixed(6)}`);
      }
    } else {
      // CRIAR NOVA POSIÇÃO
      const positionData = {
        simbolo: symbol,
        quantidade: executedQty,
        preco_medio: avgPrice,
        status: 'OPEN',
        data_hora_abertura: formatDateForMySQL(new Date()),
        side: side,
        leverage: 1,
        data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
        preco_entrada: avgPrice,
        preco_corrente: avgPrice,
        orign_sig: extractOriginSignal(order.c),
        quantidade_aberta: executedQty,
        conta_id: accountId
      };
      
      positionId = await insertPosition(connection, positionData);
      console.log(`[ORDER] Nova posição ${symbol} criada: ID ${positionId}`);
    }

    // ✅ VINCULAR A ORDEM À POSIÇÃO APÓS CRIAÇÃO/ATUALIZAÇÃO
    if (positionId) {
      await connection.query(
        `UPDATE ordens SET 
         id_posicao = ?,
         last_update = NOW()
         WHERE id_externo = ? AND conta_id = ? AND id_posicao IS NULL`,
        [positionId, orderId, accountId]
      );
      
      console.log(`[ORDER] Ordem ${orderId} vinculada à posição ${positionId}`);
    }

  } catch (error) {
    console.error(`[ORDER] Erro ao tratar posição para ordem ${orderId}:`, error.message);
  }
}

/**
 * Processa atualizações de conta via WebSocket (ACCOUNT_UPDATE)
 */
async function handleAccountUpdate(message, accountId, db = null) {
  try {
    // Validar parâmetros
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[ACCOUNT] AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      return;
    }

    if (!message.a) {
      console.warn(`[ACCOUNT] Mensagem ACCOUNT_UPDATE sem dados 'a' para conta ${accountId}`);
      return;
    }

    // OBTER CONEXÃO COM BANCO
    let connection = db;
    if (!connection) {
      connection = await getDatabaseInstance(accountId);
      if (!connection) {
        console.error(`[ACCOUNT] Não foi possível obter conexão com banco para conta ${accountId}`);
        return;
      }
    }

    const updateData = message.a;
    const reason = updateData.m || 'UNKNOWN';
    
    console.log(`[ACCOUNT] Atualização de conta recebida para conta ${accountId} - Motivo: ${reason}`);

    // PROCESSAR ATUALIZAÇÕES DE SALDO
    if (updateData.B && Array.isArray(updateData.B)) {
      await handleBalanceUpdates(connection, updateData.B, accountId, reason);
    }

    // PROCESSAR ATUALIZAÇÕES DE POSIÇÃO
    if (updateData.P && Array.isArray(updateData.P)) {
      await handlePositionUpdates(connection, updateData.P, accountId, reason);
    }

  } catch (error) {
    console.error(`[ACCOUNT] Erro ao processar atualização da conta ${accountId}:`, error.message);
  }
}

/**
 * Processa atualizações de saldo
 */
async function handleBalanceUpdates(connection, balances, accountId, reason) {
  try {
    for (const balance of balances) {
      const asset = balance.a;
      const walletBalance = parseFloat(balance.wb || '0');
      const crossWalletBalance = parseFloat(balance.cw || '0');
      const balanceChange = parseFloat(balance.bc || '0');
      
      console.log(`[ACCOUNT] Saldo atualizado para ${asset}: Wallet=${walletBalance}, Cross=${crossWalletBalance}, Change=${balanceChange}`);
      
      // ATUALIZAR SALDO NA TABELA CONTAS SE FOR USDT
      if (asset === 'USDT') {
        try {
          await connection.query(
            `UPDATE contas SET 
             saldo = ?,
             ultima_atualizacao = NOW()
             WHERE id = ?`,
            [crossWalletBalance, accountId]
          );
          
          console.log(`[ACCOUNT] Saldo USDT atualizado para conta ${accountId}: ${crossWalletBalance}`);
        } catch (updateError) {
          console.error(`[ACCOUNT] Erro ao atualizar saldo USDT:`, updateError.message);
        }
      }
    }
  } catch (error) {
    console.error(`[ACCOUNT] Erro ao processar atualizações de saldo:`, error.message);
  }
}

/**
 * Processa atualizações de posições
 */
async function handlePositionUpdates(connection, positions, accountId, reason) {
  try {
    for (const position of positions) {
      const symbol = position.s;
      const positionAmt = parseFloat(position.pa || '0');
      const entryPrice = parseFloat(position.ep || '0');
      const unrealizedPnl = parseFloat(position.up || '0');
      const marginType = position.mt || 'cross';
      const positionSide = position.ps || 'BOTH';
      const isolatedWallet = parseFloat(position.iw || '0');
      const breakEvenPrice = parseFloat(position.bep || '0');
      const accumulatedRealized = parseFloat(position.cr || '0');
      
      console.log(`[ACCOUNT] Posição ${symbol} atualizada: ${positionAmt} @ ${entryPrice} (PnL: ${unrealizedPnl})`);
      
      // BUSCAR POSIÇÃO EXISTENTE NO BANCO
      const [existingPositions] = await connection.query(
        'SELECT * FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
        [symbol, 'OPEN', accountId]
      );

      if (Math.abs(positionAmt) <= 0.000001) {
        // POSIÇÃO FECHADA
        if (existingPositions.length > 0) {
          for (const existingPos of existingPositions) {
            await connection.query(
              `UPDATE posicoes SET 
               status = 'CLOSED',
               quantidade = 0,
               data_hora_fechamento = NOW(),
               data_hora_ultima_atualizacao = NOW()
               WHERE id = ?`,
              [existingPos.id]
            );
            
            console.log(`[ACCOUNT] Posição ${symbol} fechada via account update (ID: ${existingPos.id})`);
          }
        }
      } else {
        // POSIÇÃO ABERTA OU ATUALIZADA
        const side = positionAmt > 0 ? 'BUY' : 'SELL';
        const absPositionAmt = Math.abs(positionAmt);
        
        if (existingPositions.length > 0) {
          // ATUALIZAR POSIÇÃO EXISTENTE
          const existingPos = existingPositions[0];
          
          await connection.query(
            `UPDATE posicoes SET 
             quantidade = ?,
             preco_entrada = ?,
             preco_corrente = ?,
             side = ?,
             data_hora_ultima_atualizacao = NOW()
             WHERE id = ?`,
            [absPositionAmt, entryPrice, entryPrice, side, existingPos.id]
          );
          
          console.log(`[ACCOUNT] Posição ${symbol} atualizada no banco: ${absPositionAmt} @ ${entryPrice}`);
        } else {
          // CRIAR NOVA POSIÇÃO (posição externa)
          const positionData = {
            simbolo: symbol,
            quantidade: absPositionAmt,
            preco_medio: entryPrice,
            status: 'OPEN',
            data_hora_abertura: formatDateForMySQL(new Date()),
            side: side,
            leverage: 1,
            data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
            preco_entrada: entryPrice,
            preco_corrente: entryPrice,
            orign_sig: 'EXTERNAL_POSITION',
            quantidade_aberta: absPositionAmt,
            conta_id: accountId
          };
          
          const positionId = await insertPosition(connection, positionData);
          console.log(`[ACCOUNT] Nova posição externa ${symbol} criada: ID ${positionId}`);
        }
      }
    }
  } catch (error) {
    console.error(`[ACCOUNT] Erro ao processar atualizações de posições:`, error.message);
  }
}

// FUNÇÕES AUXILIARES

/**
 * Mapeia tipo de ordem da Binance para formato do banco
 */
function mapOrderType(binanceOrderType) {
  const mapping = {
    'LIMIT': 'LIMIT',
    'MARKET': 'MARKET',
    'STOP': 'STOP',
    'STOP_MARKET': 'STOP_MARKET',
    'TAKE_PROFIT': 'TAKE_PROFIT',
    'TAKE_PROFIT_MARKET': 'TAKE_PROFIT_MARKET',
    'TRAILING_STOP_MARKET': 'TRAILING_STOP_MARKET',
    'LIQUIDATION': 'LIQUIDATION'
  };
  
  return mapping[binanceOrderType] || binanceOrderType;
}

/**
 * Determina o tipo de ordem do bot baseado nas características da ordem
 */
function determineOrderBotType(order) {
  if (order.R === true) {
    // Reduce only
    if (order.o.includes('TAKE_PROFIT')) {
      return 'REDUCAO_PARCIAL';
    } else if (order.o.includes('STOP')) {
      return 'STOP_LOSS';
    } else {
      return 'REDUCAO_PARCIAL';
    }
  } else {
    // Não é reduce only
    return 'ENTRADA';
  }
}

/**
 * Extrai signal de origem do clientOrderId
 */
function extractOriginSignal(clientOrderId) {
  if (!clientOrderId) return null;
  
  // Procurar padrões como "WEBHOOK_123" ou outros identificadores
  const webhookMatch = clientOrderId.match(/WEBHOOK_(\d+)/);
  if (webhookMatch) {
    return `WEBHOOK_${webhookMatch[1]}`;
  }
  
  // Se começar com autoclose, é liquidação
  if (clientOrderId.startsWith('autoclose-')) {
    return 'LIQUIDATION';
  }
  
  // Se for adl_autoclose, é ADL
  if (clientOrderId === 'adl_autoclose') {
    return 'ADL';
  }
  
  // Se começar com settlement_autoclose, é settlement
  if (clientOrderId.startsWith('settlement_autoclose-')) {
    return 'SETTLEMENT';
  }
  
  return null;
}

// REMOVER as funções handleAccountUpdate, handleBalanceUpdates, handlePositionUpdates
// e manter apenas as funções relacionadas a ordens

async function initializeOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Inicializando sistema para conta ${accountId}...`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco para conta ${accountId}`);
    }
    
    const registered = registerOrderHandlers(accountId);
    if (!registered) {
      throw new Error(`Falha ao registrar handlers para conta ${accountId}`);
    }
    
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

function registerOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Registrando handlers de ordem para conta ${accountId}...`);
    
    // MANTER callbacks existentes, adicionar apenas handleOrderUpdate
    const existingCallbacks = websockets.getHandlers(accountId) || {};
    
    const orderCallbacks = {
      ...existingCallbacks,
      handleOrderUpdate: (orderMsg, db) => handleOrderUpdate(orderMsg, accountId, db)
    };
    
    websockets.setMonitoringCallbacks(orderCallbacks, accountId);
    
    console.log(`[ORDER-HANDLERS] ✅ Handlers de ordem registrados para conta ${accountId}`);
    return true;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao registrar handlers de ordem para conta ${accountId}:`, error.message);
    return false;
  }
}

function areHandlersRegistered(accountId) {
  try {
    const handlers = websockets.getHandlers(accountId);
    const hasOrderHandler = handlers && typeof handlers.handleOrderUpdate === 'function';
    
    console.log(`[ORDER-HANDLERS] Status do handler de ordem para conta ${accountId}: ${hasOrderHandler ? '✅' : '❌'}`);
    return hasOrderHandler;
    
  } catch (error) {
    console.error(`[ORDER-HANDLERS] Erro ao verificar handlers de ordem para conta ${accountId}:`, error.message);
    return false;
  }
}

function unregisterOrderHandlers(accountId) {
  try {
    console.log(`[ORDER-HANDLERS] Removendo handlers para conta ${accountId}...`);
    
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

module.exports = {
  handleOrderUpdate,
  registerOrderHandlers,
  areHandlersRegistered,
  unregisterOrderHandlers,
  initializeOrderHandlers
};