const { getDatabaseInstance, formatDateForMySQL } = require('../../../core/database/conexao');
const { cancelOrder, getOpenOrders } = require('../api/rest');
const { sendTelegramMessage, formatPositionClosedMessage, formatAlertMessage } = require('./telegramBot');

/**
 * ✅ FUNÇÃO MELHORADA: Mover posição fisicamente para histórico
 */
async function movePositionToHistory(db, positionId, status, reason, accountId) {
  let connection;
  
  try {
    console.log(`[MOVE_POSITION] 📚 Iniciando processo de mover posição ${positionId} para histórico...`);
    
    connection = await db.getConnection();
    await connection.beginTransaction();
    
    // ✅ 1. BUSCAR POSIÇÃO COMPLETA
    const [positionResult] = await connection.query(
      'SELECT * FROM posicoes WHERE id = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    if (positionResult.length === 0) {
      console.log(`[MOVE_POSITION] ⚠️ Posição ${positionId} não encontrada para conta ${accountId}`);
      await connection.rollback();
      return false;
    }
    
    const position = positionResult[0];
    const symbol = position.simbolo;
    
    console.log(`[MOVE_POSITION] 📋 Processando posição: ${symbol} (ID: ${positionId})`);
    
    // ✅ 2. CANCELAR ORDENS ABERTAS NA CORRETORA PARA ESTE SÍMBOLO
    try {
      console.log(`[MOVE_POSITION] 🗑️ Verificando ordens abertas na corretora para ${symbol}...`);
      
      const openOrdersOnExchange = await api.getOpenOrders(accountId, symbol);
      
      if (openOrdersOnExchange && openOrdersOnExchange.length > 0) {
        console.log(`[MOVE_POSITION] 📋 Encontradas ${openOrdersOnExchange.length} ordens abertas para ${symbol}`);
        
        for (const order of openOrdersOnExchange) {
          try {
            await api.cancelOrder(symbol, order.orderId, accountId);
            console.log(`[MOVE_POSITION] ✅ Ordem ${order.orderId} cancelada na corretora`);
          } catch (cancelError) {
            console.warn(`[MOVE_POSITION] ⚠️ Erro ao cancelar ordem ${order.orderId}:`, cancelError.message);
          }
        }
      }
    } catch (exchangeError) {
      console.warn(`[MOVE_POSITION] ⚠️ Erro ao verificar/cancelar ordens na corretora:`, exchangeError.message);
    }
    
    // ✅ 3. PROCESSAR ORDENS RELACIONADAS NO BANCO
    const [relatedOrders] = await connection.query(
      'SELECT * FROM ordens WHERE id_posicao = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    console.log(`[MOVE_POSITION] 📊 Encontradas ${relatedOrders.length} ordens relacionadas no banco`);
    
    // ✅ 4. MOVER ORDENS PARA HISTÓRICO
    if (relatedOrders.length > 0) {
      // Verificar colunas da tabela ordens_fechadas
      const [destColumns] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas`);
      const destColumnNames = destColumns.map(col => col.Field);
      
      for (const order of relatedOrders) {
        // Preparar dados da ordem
        const orderData = {
          tipo_ordem: order.tipo_ordem,
          preco: order.preco,
          quantidade: order.quantidade,
          id_posicao: order.id_posicao,
          status: (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED' || order.status === 'EXPIRED') ? 'CANCELED' : order.status,
          data_hora_criacao: order.data_hora_criacao,
          id_externo: order.id_externo,
          side: order.side,
          simbolo: order.simbolo,
          tipo_ordem_bot: order.tipo_ordem_bot,
          target: order.target,
          reduce_only: order.reduce_only,
          close_position: order.close_position,
          last_update: new Date(),
          conta_id: order.conta_id,
          preco_executado: order.preco_executado || 0,
          quantidade_executada: order.quantidade_executada || 0,
          observacao: order.observacao || 'Movida automaticamente - posição fechada'
        };
        
        // Adicionar campos opcionais
        if (destColumnNames.includes('orign_sig') && order.orign_sig) {
          orderData.orign_sig = order.orign_sig;
        }
        if (destColumnNames.includes('dados_originais_ws') && order.dados_originais_ws) {
          orderData.dados_originais_ws = order.dados_originais_ws;
        }
        
        // Construir query dinâmica
        const columns = Object.keys(orderData).filter(key => 
          destColumnNames.includes(key) && orderData[key] !== undefined
        );
        const values = columns.map(col => orderData[col]);
        const placeholders = columns.map(() => '?').join(', ');
        
        // Inserir na tabela fechadas
        await connection.query(
          `INSERT INTO ordens_fechadas (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
        
        console.log(`[MOVE_POSITION] ✅ Ordem ${order.id_externo} (${order.tipo_ordem_bot}) movida para ordens_fechadas`);
      }
      
      // Remover ordens da tabela ativa
      await connection.query(
        'DELETE FROM ordens WHERE id_posicao = ? AND conta_id = ?',
        [positionId, accountId]
      );
      
      console.log(`[MOVE_POSITION] 🗑️ ${relatedOrders.length} ordens removidas da tabela ativa`);
    }
    
    // ✅ 5. MOVER POSIÇÃO PARA HISTÓRICO
    console.log(`[MOVE_POSITION] 📚 Movendo posição para posicoes_fechadas...`);
    
    // Verificar colunas da tabela posicoes_fechadas
    const [posDestColumns] = await connection.query(`SHOW COLUMNS FROM posicoes_fechadas`);
    const posDestColumnNames = posDestColumns.map(col => col.Field);
    
    // Preparar dados da posição
    const now = new Date();
    const positionData = {
      simbolo: position.simbolo,
      quantidade: position.quantidade,
      preco_medio: position.preco_medio,
      status: status || 'CLOSED',
      data_hora_abertura: position.data_hora_abertura,
      data_hora_fechamento: now,
      side: position.side,
      leverage: position.leverage,
      data_hora_ultima_atualizacao: now,
      preco_entrada: position.preco_entrada,
      preco_corrente: position.preco_corrente,
      conta_id: position.conta_id,
      observacoes: reason || 'Movida automaticamente'
    };
    
    // Adicionar campos opcionais
    if (posDestColumnNames.includes('orign_sig') && position.orign_sig) {
      positionData.orign_sig = position.orign_sig;
    }
    if (posDestColumnNames.includes('quantidade_aberta') && position.quantidade_aberta) {
      positionData.quantidade_aberta = position.quantidade_aberta;
    }
    if (posDestColumnNames.includes('trailing_stop_level') && position.trailing_stop_level) {
      positionData.trailing_stop_level = position.trailing_stop_level;
    }
    if (posDestColumnNames.includes('pnl_corrente') && position.pnl_corrente) {
      positionData.pnl_corrente = position.pnl_corrente;
    }
    
    // Construir query dinâmica para posição
    const posColumns = Object.keys(positionData).filter(key => 
      posDestColumnNames.includes(key) && positionData[key] !== undefined
    );
    const posValues = posColumns.map(col => positionData[col]);
    const posPlaceholders = posColumns.map(() => '?').join(', ');
    
    // Inserir posição na tabela fechadas
    await connection.query(
      `INSERT INTO posicoes_fechadas (${posColumns.join(', ')}) VALUES (${posPlaceholders})`,
      posValues
    );
    
    // Remover posição da tabela ativa
    await connection.query(
      'DELETE FROM posicoes WHERE id = ? AND conta_id = ?',
      [positionId, accountId]
    );
    
    await connection.commit();
    
    console.log(`[MOVE_POSITION] ✅ Posição ${symbol} (ID: ${positionId}) movida fisicamente para posicoes_fechadas`);
    
    // ✅ 6. NOTIFICAÇÃO TELEGRAM
    try {
      const { sendTelegramMessage, formatPositionClosedMessage } = require('./telegramBot');
      const currentPrice = await api.getPrice(symbol, accountId);
      const entryPrice = parseFloat(position.preco_entrada);
      const quantity = parseFloat(position.quantidade);
      
      if (currentPrice && entryPrice) {
        const pnl = (currentPrice - entryPrice) * quantity * (position.side === 'BUY' ? 1 : -1);
        
        const message = formatPositionClosedMessage(
          symbol, 
          position.side, 
          quantity, 
          entryPrice, 
          currentPrice, 
          pnl
        );
        
        await sendTelegramMessage(accountId, message);
        console.log(`[MOVE_POSITION] 📱 Notificação de fechamento enviada`);
      }
    } catch (telegramError) {
      console.warn(`[MOVE_POSITION] ⚠️ Erro ao enviar notificação Telegram:`, telegramError.message);
    }
    
    return true;
    
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }
    console.error(`[MOVE_POSITION] ❌ Erro ao mover posição ${positionId} para histórico:`, error.message);
    return false;
    
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

/**
 * ✅ VERIFICAR E FECHAR WEBSOCKET SE NÃO HÁ MAIS ATIVIDADE
 */
async function checkAndCloseWebsocket(db, symbol, accountId) {
  try {
    const [counts] = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM webhook_signals WHERE symbol = ? AND conta_id = ? AND status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')) as signals,
        (SELECT COUNT(*) FROM posicoes WHERE simbolo = ? AND conta_id = ? AND status = 'OPEN') as positions,
        (SELECT COUNT(*) FROM ordens WHERE simbolo = ? AND conta_id = ? AND status = 'NEW') as orders
    `, [symbol, accountId, symbol, accountId, symbol, accountId]);

    const totalActivity = (counts[0]?.signals || 0) + (counts[0]?.positions || 0) + (counts[0]?.orders || 0);

    if (totalActivity === 0) {
      const websockets = require('../api/websocket');
      websockets.stopPriceMonitoring(symbol, accountId);
      console.log(`[MOVE_POSITION] 🔌 WebSocket fechado para ${symbol} (conta ${accountId}) - sem atividade`);
    }
    
  } catch (error) {
    console.error(`[MOVE_POSITION] ❌ Erro ao verificar fechamento de WebSocket:`, error.message);
  }
}

/**
 * ✅ SINCRONIZAÇÃO AVANÇADA COM FECHAMENTO AUTOMÁTICO
 */
async function syncAndCloseGhostPositions(accountId) {
  try {
    console.log(`[SYNC_CLOSE] 🔄 Verificando posições fantasma para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    const { getAllOpenPositions } = require('../api/rest');
    
    // Obter posições do banco e da corretora
    const [dbPositions] = await db.query(`
      SELECT id, simbolo, quantidade, side FROM posicoes 
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);
    
    const exchangePositions = await getAllOpenPositions(accountId);
    
    let closedCount = 0;
    
    for (const dbPos of dbPositions) {
      const exchangePos = exchangePositions.find(p => p.simbolo === dbPos.simbolo);
      
      if (!exchangePos || Math.abs(parseFloat(exchangePos.quantidade)) <= 0.000001) {
        console.log(`[SYNC_CLOSE] 🔄 Posição ${dbPos.simbolo} não existe mais na corretora, movendo para histórico...`);
        
        const success = await movePositionToHistory(
          db, 
          dbPos.id, 
          'CLOSED', 
          'Sincronização automática - posição não encontrada na corretora',
          accountId
        );
        
        if (success) {
          closedCount++;
          console.log(`[SYNC_CLOSE] ✅ Posição ${dbPos.simbolo} movida para histórico`);
        } else {
          console.error(`[SYNC_CLOSE] ❌ Falha ao mover posição ${dbPos.simbolo}`);
        }
      }
    }
    
    console.log(`[SYNC_CLOSE] 📊 Total de posições movidas para histórico: ${closedCount}`);
    return closedCount;
    
  } catch (error) {
    console.error(`[SYNC_CLOSE] ❌ Erro na sincronização com fechamento:`, error.message);
    return 0;
  }
}

module.exports = {
  movePositionToHistory,
  checkAndCloseWebsocket,
  syncAndCloseGhostPositions
};