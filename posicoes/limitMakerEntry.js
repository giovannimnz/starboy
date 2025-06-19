const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const websockets = require('../websockets');
const api = require('../api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const {
  getRecentOrders,
  editOrder,
  roundPriceToTickSize,
  newMarketOrder,
  newLimitMakerOrder,
  newReduceOnlyOrder,
  cancelOrder,
  newStopOrder,
  getOpenOrders,
  getOrderStatus,
  getAllOpenPositions,
  getFuturesAccountBalanceDetails,
  getPrecision,
  getTickSize,
  getPrecisionCached,
  validateQuantity,
  adjustQuantityToRequirements,
} = require('../api');



// ✅ CORREÇÃO: Declarar sentOrders no escopo correto e com Map melhorado
async function executeLimitMakerEntry(signal, currentPrice, accountId) {
  console.log(`[LIMIT_ENTRY] 🚀 Executando entrada para sinal ${signal.id}: ${signal.symbol} ${signal.side} a ${signal.entry_price} (conta ${accountId})`);

  // ✅ SISTEMA DE RASTREAMENTO MELHORADO - DECLARADO CORRETAMENTE
  const sentOrders = new Map(); // DEVE estar aqui, não no escopo global
  let isEntryComplete = false;
  let currentBestBid = null;
  let currentBestAsk = null;
  let lastDepthUpdateTimestamp = 0;
  let wsUpdateErrorCount = 0;
  
  // ✅ HANDLER MELHORADO PARA WEBSOCKET - VERSÃO CORRIGIDA DA DEV
  const orderUpdateHandler = (orderMsg) => {
    if (!orderMsg || !orderMsg.o || !orderMsg.o.i) return;

    const order = orderMsg.o;
    const orderId = String(order.i);
    const executionType = order.x; // NEW, CANCELED, TRADE, etc.
    const orderStatus = order.X; // NEW, FILLED, PARTIALLY_FILLED, etc.
    
    // ATUALIZAR A ORDEM NO MAPA COM TODOS OS DETALHES NECESSÁRIOS
    if (!sentOrders.has(orderId)) {
      sentOrders.set(orderId, {
        orderId: orderId,
        symbol: order.s,
        side: order.S,
        price: parseFloat(order.p || '0'),
        quantity: parseFloat(order.q || '0'),
        executedQty: parseFloat(order.z || '0'),
        avgPrice: parseFloat(order.ap || '0'),
        status: orderStatus,
        type: order.o,
        lastUpdateTime: Date.now(),
        fills: [],
        commission: parseFloat(order.n || '0'),
        commissionAsset: order.N || null,
        realizedPnl: parseFloat(order.rp || '0'), // ADICIONADO DA DEV
        executionTime: order.T || Date.now(), // ADICIONADO DA DEV
        clientOrderId: order.c || null // ADICIONADO DA DEV
      });
      
      console.log(`[ORDER_WS] Nova ordem rastreada via WS: ${orderId} (${orderStatus})`);
    } else {
      // ATUALIZAR ORDEM EXISTENTE COM MAIS DETALHES
      const orderInfo = sentOrders.get(orderId);
      const oldStatus = orderInfo.status;
      const oldExecutedQty = orderInfo.executedQty;
      
      orderInfo.status = orderStatus;
      orderInfo.executedQty = parseFloat(order.z || '0');
      orderInfo.avgPrice = parseFloat(order.ap || '0');
      orderInfo.lastUpdateTime = Date.now();
      orderInfo.commission = parseFloat(order.n || '0');
      orderInfo.commissionAsset = order.N || null;
      orderInfo.realizedPnl = parseFloat(order.rp || '0'); // ADICIONADO DA DEV
      orderInfo.executionTime = order.T || Date.now(); // ADICIONADO DA DEV
      
      // SE FOI UMA EXECUÇÃO (TRADE), ADICIONAR AO HISTÓRICO DE FILLS
      if (executionType === 'TRADE') {
        const fillQty = parseFloat(order.l || '0');
        const fillPrice = parseFloat(order.L || '0');
        const fillCommission = parseFloat(order.n || '0');
        const fillTime = order.T || Date.now(); // ADICIONADO DA DEV
        const tradeId = order.t || null; // ADICIONADO DA DEV
        
        if (fillQty > 0) {
          orderInfo.fills.push({
            qty: fillQty,
            price: fillPrice,
            commission: fillCommission,
            time: fillTime,
            tradeId: tradeId,
            realizedPnl: parseFloat(order.rp || '0') // ADICIONADO DA DEV
          });
          
          console.log(`[ORDER_WS] Fill recebido para ${orderId}: ${fillQty} @ ${fillPrice} (Trade ID: ${tradeId})`);
        }
      }
      
      // LOG DE MUDANÇAS IMPORTANTES
      if (oldStatus !== orderStatus) {
        console.log(`[ORDER_WS] Status mudou para ${orderId}: ${oldStatus} → ${orderStatus}`);
      }
      
      if (oldExecutedQty !== orderInfo.executedQty) {
        const diff = orderInfo.executedQty - oldExecutedQty;
        console.log(`[ORDER_WS] Execução atualizada para ${orderId}: +${diff.toFixed(8)} (Total: ${orderInfo.executedQty})`);
      }
      
      sentOrders.set(orderId, orderInfo);
    }
  };

  try {
    // ✅ REGISTRAR HANDLER PARA WEBSOCKET (MANTIDO)
    const existingHandlers = websockets.getHandlers(accountId) || {};
    const updatedHandlers = {
      ...existingHandlers,
      handleOrderUpdate: async (msg, db) => {
        if (existingHandlers.handleOrderUpdate) {
          await existingHandlers.handleOrderUpdate(msg, db);
        }
        orderUpdateHandler(msg);
      }
    };
    websockets.setMonitoringCallbacks(updatedHandlers, accountId);

    let connection = null;
    let activeOrderId = null;
    let depthWs = null;
    let positionId = null;
    let totalFilledSize = 0;
    let averageEntryPrice = 0;
    let binanceSide;
    let quantityPrecision;
    let pricePrecision;
    let numericAccountId;

    // ✅ CONSTANTES CORRIGIDAS DA VERSÃO DEV
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 180000; // 3 minutos (CORRIGIDO da versão dev)
    const WAIT_FOR_ORDER_CONFIRMATION_MS = 15000;
    const EDIT_WAIT_TIMEOUT_MS = 3000;
    const MAX_DEPTH_STALENESS_MS = 3000;
    const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.98; // CORRIGIDO: 98% em vez de 99.9%

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let executionStartTime = Date.now();
    let partialFills = [];
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    // VALIDAÇÃO INICIAL (mantida)
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em executeLimitMakerEntry: ${accountId} (tipo: ${typeof accountId})`);
    }

    if (!signal || !signal.id || !signal.symbol) {
      throw new Error(`Signal inválido: ${JSON.stringify(signal)}`);
    }

    numericAccountId = parseInt(accountId) || accountId;

    console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol}) na conta ${accountId}`);

    // OBTER CONEXÃO DO BANCO (mantido)
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
    }

    connection = await db.getConnection();

    // VERIFICAR SE JÁ EXISTE POSIÇÃO ABERTA (mantido)
    const existingPositionsOnExchange = await getAllOpenPositions(numericAccountId);
    const positionAlreadyExists = existingPositionsOnExchange.some(p =>
        p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
    );

    if (positionAlreadyExists) {
      console.log(`[LIMIT_ENTRY] ALERTA: Posição já existe para ${signal.symbol}. Cancelando.`);
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        ['Posição já existe na corretora (verificação inicial)', signal.id]
      );
      return { success: false, error: 'Posição já existe na corretora (verificação inicial)' };
    }

    // ✅ CANCELAR ORDENS EXISTENTES - VERSÃO MELHORADA DA DEV
    const [existingOrders] = await connection.query(
      `SELECT id_externo FROM ordens WHERE orign_sig = ? AND status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = ?`,
      [`WEBHOOK_${signal.id}`, accountId] // CORREÇÃO: incluir conta_id na query
    );

    if (existingOrders.length > 0) {
      console.log(`[LIMIT_ENTRY] ⚠️ Já existem ${existingOrders.length} ordens ativas para este sinal. Cancelando...`);

      for (const order of existingOrders) {
        try {
          await cancelOrder(signal.symbol, order.id_externo, numericAccountId);
          console.log(`[LIMIT_ENTRY] Ordem ${order.id_externo} cancelada.`);
          
          // ✅ CORREÇÃO: Atualizar status no banco após cancelamento
          await connection.query(
            `UPDATE ordens SET status = 'CANCELED', last_update = NOW() WHERE id_externo = ? AND conta_id = ?`,
            [order.id_externo, accountId]
          );
        } catch (cancelError) {
          console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem ${order.id_externo}:`, cancelError.message);
        }
      }
      
      // ✅ AGUARDAR UM POUCO APÓS CANCELAMENTOS
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await connection.beginTransaction();

    // ✅ OBTER PRECISÃO E CALCULAR TAMANHOS - VERSÃO MELHORADA
    const precisionInfo = await getPrecision(signal.symbol, numericAccountId);
    quantityPrecision = precisionInfo.quantityPrecision;
    pricePrecision = precisionInfo.pricePrecision;
    const stepSize = precisionInfo.stepSize;

    console.log(`[LIMIT_ENTRY] Precisão obtida para ${signal.symbol}: qty=${quantityPrecision}, price=${pricePrecision}, step=${stepSize}`);

    const availableBalance = await getAvailableBalance(numericAccountId);
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage);

    // ✅ OBTER PREÇO ATUAL - VERSÃO CORRIGIDA
    let currentPriceTrigger;
    if (signal.price && signal.price > 0) {
      currentPriceTrigger = parseFloat(signal.price);
      console.log(`[LIMIT_ENTRY] Usando preço do sinal: ${currentPriceTrigger}`);
    } else if (signal.entry_price && signal.entry_price > 0) {
      currentPriceTrigger = parseFloat(signal.entry_price);
      console.log(`[LIMIT_ENTRY] Usando entry_price do sinal: ${currentPriceTrigger}`);
    } else {
      currentPriceTrigger = await api.getPrice(signal.symbol, numericAccountId);
      console.log(`[LIMIT_ENTRY] Preço obtido via API: ${currentPriceTrigger}`);
    }

    if (!currentPriceTrigger || currentPriceTrigger <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPriceTrigger}`);
    }

    totalEntrySize = calculateOrderSize(
      availableBalance, capitalPercentage, currentPriceTrigger, leverage, stepSize, quantityPrecision
    );

    if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
      throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
    }

    console.log(`[LIMIT_ENTRY] Tamanho total calculado: ${totalEntrySize.toFixed(quantityPrecision)} ${signal.symbol}`);

    // ✅ VALIDAR QUANTIDADE TOTAL - MANTIDO
    console.log(`[LIMIT_ENTRY] Validando quantidade total de entrada: ${totalEntrySize}`);
    const entryValidation = await validateQuantity(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');

    if (!entryValidation.isValid) {
      console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade de entrada inválida: ${entryValidation.reason}`);

      const adjustment = await adjustQuantityToRequirements(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');

      if (adjustment.success) {
        console.log(`[LIMIT_ENTRY] ✅ Quantidade ajustada: ${totalEntrySize} → ${adjustment.adjustedQuantity}`);
        totalEntrySize = adjustment.adjustedQuantity;
      } else {
        const errorMsg = `Quantidade de entrada inválida para ${signal.symbol}: ${entryValidation.reason}. Ajuste impossível: ${adjustment.error}`;
        console.error(`[LIMIT_ENTRY] ❌ ${errorMsg}`);

        if (connection) {
          await connection.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
            [errorMsg.substring(0, 250), signal.id]
          );
          await connection.commit();
        }

        return {
          success: false,
          error: errorMsg,
          suggestion: adjustment.suggestedAction || "Aumente o capital disponível ou escolha outro símbolo"
        };
      }
    } else {
      console.log(`[LIMIT_ENTRY] ✅ Quantidade de entrada válida: ${totalEntrySize}`);
    }

    binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY'; // ADICIONADO AQUI

    await connection.query(
      `UPDATE webhook_signals SET status = 'ENTRADA_EM_PROGRESSO' WHERE id = ?`,
      [signal.id]
    );

    // ✅ CONFIGURAR WEBSOCKET DE PROFUNDIDADE - VERSÃO CORRIGIDA
    console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
    depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData, receivedAccountId) => {
      // CORREÇÃO: Validar accountId se fornecido
      if (receivedAccountId && receivedAccountId !== accountId) {
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados recebidos para conta diferente: esperado ${accountId}, recebido ${receivedAccountId}`);
        return;
      }

      if (depthData && depthData.bestBid && depthData.bestAsk) {
        const bid = parseFloat(depthData.bestBid);
        const ask = parseFloat(depthData.bestAsk);

        // ✅ VALIDAÇÕES MELHORADAS DA VERSÃO DEV
        const spread = ask - bid;
        const spreadPercent = (spread / bid) * 100;

        if (spreadPercent > 5) {
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Spread muito grande para ${signal.symbol}: ${spreadPercent.toFixed(2)}% - possível erro nos dados`);
          wsUpdateErrorCount++;
          return;
        }

        if (bid >= ask) {
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados inválidos para ${signal.symbol}: bid (${bid}) >= ask (${ask})`);
          wsUpdateErrorCount++;
          return;
        }

        currentBestBid = bid;
        currentBestAsk = ask;
        lastDepthUpdateTimestamp = Date.now();
        wsUpdateErrorCount = 0;
        
        // DEBUG: Log apenas a cada 10 atualizações para não poluir
        if (Math.random() < 0.1) {
          console.log(`[LIMIT_ENTRY_DEPTH_WS] ${signal.symbol}: Bid=${bid.toFixed(pricePrecision)}, Ask=${ask.toFixed(pricePrecision)}, Spread=${spread.toFixed(pricePrecision)}`);
        }
      } else {
        wsUpdateErrorCount++;
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos para ${signal.symbol}:`, depthData);
      }
    }, accountId);

    // ✅ AGUARDAR DADOS DO WEBSOCKET COM FALLBACK - VERSÃO MELHORADA
    const MAX_RETRY_ATTEMPTS = 30;
    const RETRY_INTERVAL_MS = 500;
    let wsRetryCount = 0;
    let hasValidBookData = false;

    // FALLBACK: Obter dados via REST API
    let fallbackBid = null;
    let fallbackAsk = null;

    try {
      console.log(`[LIMIT_ENTRY] Obtendo dados de preço via REST API como fallback...`);
      const currentMarketPrice = await api.getPrice(signal.symbol, numericAccountId);
      if (currentMarketPrice && currentMarketPrice > 0) {
        // ✅ CORREÇÃO: Spread mais realista baseado no tick size
        const tickSizeInfo = await getTickSize(signal.symbol, numericAccountId);
        const tickSize = parseFloat(tickSizeInfo.tickSize) || (currentMarketPrice * 0.0001);
        
        fallbackBid = currentMarketPrice - tickSize;
        fallbackAsk = currentMarketPrice + tickSize;
        console.log(`[LIMIT_ENTRY] Dados de fallback: Bid=${fallbackBid.toFixed(pricePrecision)}, Ask=${fallbackAsk.toFixed(pricePrecision)} (tick=${tickSize})`);
      }
    } catch (priceError) {
      console.warn(`[LIMIT_ENTRY] Erro ao obter preço de fallback:`, priceError.message);
    }

    // AGUARDAR DADOS VÁLIDOS DO WEBSOCKET
    console.log(`[LIMIT_ENTRY] Aguardando dados do BookTicker WebSocket...`);
    while (wsRetryCount < MAX_RETRY_ATTEMPTS && !hasValidBookData) {
      if (currentBestBid !== null && currentBestAsk !== null &&
          !isNaN(currentBestBid) && !isNaN(currentBestAsk) &&
          currentBestBid > 0 && currentBestAsk > 0 &&
          currentBestBid < currentBestAsk) {

        hasValidBookData = true;
        console.log(`[LIMIT_ENTRY] ✅ Dados do BookTicker (WebSocket) válidos para ${signal.symbol} após ${wsRetryCount} tentativas. Bid=${currentBestBid}, Ask=${currentBestAsk}`);
        break;
      }

      wsRetryCount++;
      console.log(`[LIMIT_ENTRY] Aguardando WebSocket... tentativa ${wsRetryCount}/${MAX_RETRY_ATTEMPTS}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
    }

    // USAR FALLBACK SE WEBSOCKET FALHAR
    if (!hasValidBookData) {
      console.warn(`[LIMIT_ENTRY] ⚠️ BookTicker WebSocket falhou após ${MAX_RETRY_ATTEMPTS} tentativas. Usando fallback REST.`);

      if (fallbackBid && fallbackAsk) {
        currentBestBid = fallbackBid;
        currentBestAsk = fallbackAsk;
        lastDepthUpdateTimestamp = Date.now();
        hasValidBookData = true;
        console.log(`[LIMIT_ENTRY] ✅ Usando dados de fallback REST: Bid=${currentBestBid.toFixed(pricePrecision)}, Ask=${currentBestAsk.toFixed(pricePrecision)}`);
      } else {
        throw new Error(`Não foi possível obter dados de preço válidos nem via WebSocket nem via REST API para ${signal.symbol}`);
      }
    }

    // OBTER TICK SIZE
    const tickSizeData = await getTickSize(signal.symbol, numericAccountId);
    const tickSize = parseFloat(tickSizeData.tickSize) || 0.01;

    console.log(`[LIMIT_ENTRY] ✅ Dados iniciais prontos. Iniciando loop de chasing...`);
    console.log(`[LIMIT_ENTRY] Configuração: tickSize=${tickSize}, totalEntrySize=${totalEntrySize.toFixed(quantityPrecision)}`);

    // ===== LOOP PRINCIPAL DE PERSEGUIÇÃO DE PREÇO =====
    while (totalFilledSize < totalEntrySize && 
          chaseAttempts < MAX_CHASE_ATTEMPTS && 
          (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
      
      chaseAttempts++;

      // ✅ SINCRONIZAR PREENCHIMENTOS VIA WEBSOCKET E API - VERSÃO MELHORADA
      try {
        // PRIMEIRO: Verificar ordens via WebSocket local
        let localFilledCount = 0;
        for (const [orderId, orderInfo] of sentOrders.entries()) {
          if ((orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') &&
              orderInfo.side === binanceSide &&
              orderInfo.executedQty > 0 &&
              !partialFills.some(fill => fill.orderId === orderId)) {
            
            partialFills.push({
              qty: orderInfo.executedQty,
              price: orderInfo.avgPrice,
              orderId: orderId
            });
            localFilledCount++;
          }
        }
        
        if (localFilledCount > 0) {
          totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
          console.log(`[LIMIT_ENTRY] ${localFilledCount} ordens sincronizadas via WebSocket local. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
        }

        // SEGUNDO: Buscar ordens recentes via API como backup
        const recentOrders = await getRecentOrders(numericAccountId, signal.symbol, 15);
        
        // Filtrar apenas ordens preenchidas relevantes
        const filledExchangeOrders = recentOrders.filter(order =>
          order.status === 'FILLED' &&
          order.side === binanceSide &&
          parseFloat(order.executedQty) > 0 &&
          order.updateTime >= executionStartTime && 
          (Date.now() - order.updateTime) < CHASE_TIMEOUT_MS * 2 &&
          !partialFills.some(fill => fill.orderId === String(order.orderId))
        );

        let apiFilledCount = 0;
        for (const exOrder of filledExchangeOrders) {
          const qty = parseFloat(exOrder.executedQty);
          const price = parseFloat(exOrder.avgPrice || exOrder.price);
          partialFills.push({ qty, price, orderId: String(exOrder.orderId) });
          apiFilledCount++;
        }
        
        if (apiFilledCount > 0) {
          totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
          console.log(`[LIMIT_ENTRY] ${apiFilledCount} ordens sincronizadas via API. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
        }
        
        if (totalFilledSize >= totalEntrySize) {
          console.log(`[LIMIT_ENTRY] (Sync) Quantidade total atingida após sincronização. Finalizando...`);
          break;
        }
      } catch (checkError) {
        console.error(`[LIMIT_ENTRY] Erro ao sincronizar ordens:`, checkError.message);
      }

      const remainingSizeCurrentLoop = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
      if (remainingSizeCurrentLoop <= 0) {
        console.log(`[LIMIT_ENTRY] Quantidade restante (${remainingSizeCurrentLoop.toFixed(quantityPrecision)}) zerada ou negativa. Saindo do loop de chasing.`);
        break;
      }

      // ✅ VERIFICAÇÃO DE DADOS DO BOOK - MANTIDO
      const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
      if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
        const staleReason = !currentBestBid || !currentBestAsk ? "ausentes" : (isDepthDataStale ? "velhos" : `erros WS (${wsUpdateErrorCount})`);
        console.log(`[LIMIT_ENTRY] Dados do BookTicker (WebSocket) para ${signal.symbol} ${staleReason}. Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Última atualização WS: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
        
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const bestBid = currentBestBid;
      const bestAsk = currentBestAsk;
      const spread = bestAsk - bestBid;

      // ✅ LÓGICA DE CÁLCULO DE PREÇO MELHORADA - MANTIDA
      let currentLocalMakerPrice;
      if (binanceSide === 'BUY') {
        const spreadSize = bestAsk - bestBid;
        const moreBidPrice = bestBid + tickSize;
        
        if (spreadSize > tickSize && moreBidPrice < bestAsk) {
          currentLocalMakerPrice = moreBidPrice;
          console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem BUY posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do melhor bid)`);
        } else {
          currentLocalMakerPrice = bestBid;
          console.log(`[LIMIT_ENTRY] Spread muito estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem BUY no melhor bid: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
        }
        
        if (currentLocalMakerPrice >= bestAsk - tickSize) {
          currentLocalMakerPrice = bestAsk - tickSize;
          console.log(`[LIMIT_ENTRY] Ajuste: preço BUY ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do ask)`);
        }
      } else { // SELL
        const spreadSize = bestAsk - bestBid;
        const lessAskPrice = bestAsk - tickSize;
        
        if (spreadSize > tickSize && lessAskPrice > bestBid) {
          currentLocalMakerPrice = lessAskPrice;
          console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem SELL posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do melhor ask)`);
        } else {
          currentLocalMakerPrice = bestAsk;
          console.log(`[LIMIT_ENTRY] Spread muito estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem SELL no melhor ask: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
        }
        
        if (currentLocalMakerPrice <= bestBid + tickSize) {
          currentLocalMakerPrice = bestBid + tickSize;
          console.log(`[LIMIT_ENTRY] Ajuste: preço SELL ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do bid)`);
        }
      }

      // Garantir que o preço esteja no tick correto
      currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice, numericAccountId);

      console.log(`[LIMIT_ENTRY] Preço MAKER ${binanceSide}: ${currentLocalMakerPrice.toFixed(pricePrecision)} | Book: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}, Spread=${(bestAsk-bestBid).toFixed(pricePrecision)}`);

      let orderPlacedOrEditedThisIteration = false;

      // ✅ GERENCIAMENTO DE ORDENS ATIVAS - VERSÃO MELHORADA
      if (activeOrderId) {
        let currentOrderDataFromExchange;
        try {
          currentOrderDataFromExchange = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
        } catch (e) {
          if (e.message && e.message.includes('Order does not exist')) {
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} não encontrada/cancelada na corretora. Resetando activeOrderId.`);
            activeOrderId = null;
            currentOrderDataFromExchange = null;
          } else {
            console.error(`[LIMIT_ENTRY] Erro ao verificar status da ordem ${activeOrderId}:`, e.message);
            currentOrderDataFromExchange = null;
          }
        }

        if (currentOrderDataFromExchange) {
          const { status, executedQty, avgPrice, price: orderPriceOnExchangeStr, origQty } = currentOrderDataFromExchange;
          const apiFilledQty = parseFloat(executedQty || 0);
          const orderPriceOnExchange = parseFloat(orderPriceOnExchangeStr);
          
          let alreadyAccountedForThisOrder = 0;
          partialFills.forEach(pf => {
            if (pf.orderId === activeOrderId) alreadyAccountedForThisOrder += pf.qty;
          });
          
          const netFilledSinceLastCheck = apiFilledQty - alreadyAccountedForThisOrder;

          if (netFilledSinceLastCheck > 0) {
            const fillPrice = parseFloat(avgPrice || orderPriceOnExchange);
            partialFills.push({ qty: netFilledSinceLastCheck, price: fillPrice, orderId: activeOrderId });
            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
            console.log(`[LIMIT_ENTRY] Preenchimento detectado ${activeOrderId}: ${netFilledSinceLastCheck.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
          }

          if (status === 'FILLED') {
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} totalmente preenchida.`);
            activeOrderId = null;
            if (totalFilledSize >= totalEntrySize) {
              console.log(`[LIMIT_ENTRY] Quantidade total atingida após FILLED.`);
              break;
            }
          } else if (status === 'PARTIALLY_FILLED') {
            const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
            const shouldEditOrder = priceDifference > tickSize;
            
            if (shouldEditOrder) {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida, mas preço mudou significativamente. Cancelando e recriando...`);
              
              try {
                await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                console.log(`[LIMIT_ENTRY] Ordem parcial ${activeOrderId} cancelada.`);
                
                await new Promise(resolve => setTimeout(resolve, 500));
                activeOrderId = null;
              } catch (cancelError) {
                console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem parcial ${activeOrderId}:`, cancelError.message);
              }
            } else {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida, mas preço ainda adequado. Mantendo ordem.`);
            }
          } else if (status === 'NEW') {
            const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
            const shouldEditOrder = priceDifference > tickSize;
            
            if (shouldEditOrder) {
              console.log(`[LIMIT_ENTRY] Editando ordem ${activeOrderId}: ${orderPriceOnExchange.toFixed(pricePrecision)} → ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
              
              try {
                const remainingQtyToOrder = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                
                const editResponse = await editOrder(
                  numericAccountId,
                  signal.symbol,
                  activeOrderId, 
                  currentLocalMakerPrice,
                  binanceSide,
                  remainingQtyToOrder
                );
                
                if (editResponse && editResponse.orderId) {
                  if (editResponse.orderId !== activeOrderId) {
                    console.log(`[LIMIT_ENTRY] Ordem recriada: ${activeOrderId} → ${editResponse.orderId}`);
                    activeOrderId = String(editResponse.orderId);
                  }
                  
                  orderPlacedOrEditedThisIteration = true;
                  console.log(`[LIMIT_ENTRY] Ordem editada com sucesso: ${activeOrderId}`);
                } else {
                  console.warn(`[LIMIT_ENTRY] Resposta inválida ao editar ordem:`, editResponse);
                }
              } catch (editError) {
                console.error(`[LIMIT_ENTRY] Erro ao editar ordem ${activeOrderId}:`, editError.message);
                
                try {
                  await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                  activeOrderId = null;
                  console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} cancelada após erro de edição.`);
                } catch (cancelError) {
                  console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem após falha de edição:`, cancelError.message);
                }
              }
            } else {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} já no preço adequado (${orderPriceOnExchange.toFixed(pricePrecision)}).`);
            }
          }
        }
      }
      
      // ✅ CRIAR NOVA ORDEM - MANTIDO
      if (!activeOrderId && totalFilledSize < totalEntrySize) { 
        const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
        if (newOrderQty <= 0) { 
          console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
          break; 
        }
        try {
          console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          
          const orderResponse = await newLimitMakerOrder(
            numericAccountId,
            signal.symbol, 
            newOrderQty, 
            binanceSide, 
            currentLocalMakerPrice
          );
          
          if (orderResponse.status === 'REJECTED_POST_ONLY' || 
              (orderResponse.info && orderResponse.info.msg === 'Filter failure: PRICE_FILTER')) {
            console.log(`[LIMIT_ENTRY] Ordem rejeitada (${orderResponse.status || orderResponse.info?.msg}). Ajustando preço...`);
            
            if (binanceSide === 'BUY') {
              currentLocalMakerPrice = bestBid - tickSize;
            } else {
              currentLocalMakerPrice = bestAsk + tickSize;
            }
            
            currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice, numericAccountId);
            console.log(`[LIMIT_ENTRY] Novo preço ajustado: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
            continue;
          }
          
          if (!orderResponse.orderId) {
            throw new Error(`Resposta inválida da ordem: ${JSON.stringify(orderResponse)}`);
          }
          
          activeOrderId = String(orderResponse.orderId);
          orderPlacedOrEditedThisIteration = true;
          console.log(`[LIMIT_ENTRY] Nova LIMIT criada: ID ${activeOrderId}`);
          
          // ✅ CORREÇÃO: Adicionar ordem ao sentOrders imediatamente
          sentOrders.set(activeOrderId, {
            orderId: activeOrderId,
            symbol: signal.symbol,
            side: binanceSide,
            price: currentLocalMakerPrice,
            quantity: newOrderQty,
            executedQty: 0,
            avgPrice: 0,
            status: 'NEW',
            type: 'LIMIT',
            lastUpdateTime: Date.now(),
            fills: []
          });
          
        } catch (newOrderError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, newOrderError.message);
          await new Promise(resolve => setTimeout(resolve, 1000)); 
          continue;
        }
      }
      
      // ✅ AGUARDAR EXECUÇÃO - VERSÃO MELHORADA
      if (orderPlacedOrEditedThisIteration && activeOrderId) {
        console.log(`[LIMIT_ENTRY] Aguardando execução/status da ordem ${activeOrderId} por ${EDIT_WAIT_TIMEOUT_MS}ms...`);
        
        const orderWaitResult = await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS, numericAccountId, sentOrders);
        
        const apiWaitFilledQty = parseFloat(orderWaitResult.executedQty || 0);
        let alreadyAccountedForWait = 0;
        partialFills.forEach(pf => { 
          if (pf.orderId === activeOrderId) alreadyAccountedForWait += pf.qty; 
        });
        
        const netFilledInWait = apiWaitFilledQty - alreadyAccountedForWait;

        if (netFilledInWait > 0) {
          const fillPrice = parseFloat(orderWaitResult.avgPrice || orderWaitResult.price);
          partialFills.push({ qty: netFilledInWait, price: fillPrice, orderId: activeOrderId });
          totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
          console.log(`[LIMIT_ENTRY] Preenchimento (após wait) ${activeOrderId}: ${netFilledInWait.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
        }

        if (orderWaitResult.status === 'FILLED') {
          console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} FILLED (após wait).`);
          activeOrderId = null; 
          if (totalFilledSize >= totalEntrySize) {
            console.log(`[LIMIT_ENTRY] Quantidade total atingida após wait.`);
            break;
          }
        } else if (orderWaitResult.status === 'PARTIALLY_FILLED') {
          console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida após wait.`);
        } else {
          console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ainda em ${orderWaitResult.status} após wait.`);
        }
      }
      
      if (totalFilledSize >= totalEntrySize) {
        console.log(`[LIMIT_ENTRY] Quantidade total (${totalEntrySize.toFixed(quantityPrecision)}) alcançada.`);
        break; 
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
    } 

    // ✅ SEÇÃO DE MARKET ORDER FALLBACK - VERSÃO MELHORADA DA DEV
    if (totalFilledSize < totalEntrySize) {
      console.log(`[LIMIT_ENTRY] Chasing encerrado. Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)}. Timeout: ${Date.now() - executionStartTime >= CHASE_TIMEOUT_MS}, Tentativas: ${chaseAttempts >= MAX_CHASE_ATTEMPTS}`);
      const remainingToFillMarket = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
      
      if (remainingToFillMarket > 0) {
        console.log(`[LIMIT_ENTRY] Tentando preencher restante (${remainingToFillMarket.toFixed(quantityPrecision)}) com ordem MARKET.`);
        
        // ✅ CORREÇÃO: Cancelar ordem ativa antes de MARKET
        if (activeOrderId) {
          try {
            console.log(`[LIMIT_ENTRY] Cancelando ordem ativa ${activeOrderId} antes da MARKET...`);
            await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} cancelada.`);
            
            // Aguardar cancelamento se propagar
            await new Promise(resolve => setTimeout(resolve, 1000));
            activeOrderId = null;
          } catch (cancelError) {
            console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem ${activeOrderId} antes da MARKET:`, cancelError.message);
          }
        }
        
        try {
          // ✅ VALIDAR QUANTIDADE MÍNIMA PARA MARKET
          const marketValidation = await validateQuantity(signal.symbol, remainingToFillMarket, currentPriceTrigger, numericAccountId, 'MARKET');
          
          let finalMarketQty = remainingToFillMarket;
          if (!marketValidation.isValid) {
            console.warn(`[LIMIT_ENTRY] Quantidade MARKET inválida: ${marketValidation.reason}`);
            
            const marketAdjustment = await adjustQuantityToRequirements(signal.symbol, remainingToFillMarket, currentPriceTrigger, numericAccountId, 'MARKET');
            
            if (marketAdjustment.success) {
              finalMarketQty = marketAdjustment.adjustedQuantity;
              console.log(`[LIMIT_ENTRY] Quantidade MARKET ajustada: ${remainingToFillMarket} → ${finalMarketQty}`);
            } else {
              console.error(`[LIMIT_ENTRY] Impossível ajustar quantidade MARKET. Pulando ordem MARKET.`);
              finalMarketQty = 0;
            }
          }
          
          if (finalMarketQty > 0) {
            console.log(`[LIMIT_ENTRY] Enviando ordem MARKET: ${binanceSide} ${finalMarketQty.toFixed(quantityPrecision)} ${signal.symbol}`);
            
            const marketResponse = await newMarketOrder(numericAccountId, signal.symbol, finalMarketQty, binanceSide);
            
            if (marketResponse && marketResponse.orderId) {
              console.log(`[LIMIT_ENTRY] ✅ Ordem MARKET criada: ${marketResponse.orderId}`);
              marketOrderResponseForDb = marketResponse;
              
              // ✅ ATUALIZAR TOTAIS APÓS MARKET ORDER
              const marketFilledQty = parseFloat(marketResponse.executedQty || finalMarketQty);
              const marketPrice = parseFloat(marketResponse.avgPrice || marketResponse.price || currentPriceTrigger);
              
              partialFills.push({
                qty: marketFilledQty,
                price: marketPrice,
                orderId: String(marketResponse.orderId)
              });
              
              totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
              console.log(`[LIMIT_ENTRY] MARKET preenchida: ${marketFilledQty.toFixed(quantityPrecision)} @ ${marketPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
            }
          }
        } catch (marketError) {
          console.error(`[LIMIT_ENTRY] Erro ao enviar ordem MARKET:`, marketError.response?.data || marketError.message);
        }
      }
    }

    // Calcular preço médio final
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
      averageEntryPrice = currentPriceTrigger; 
      console.warn(`[LIMIT_ENTRY] averageEntryPrice não pôde ser calculado a partir de partialFills (total preenchido: ${totalFilledSize}), usando currentPriceTrigger como fallback: ${averageEntryPrice}`);
    }

    // ✅ VERIFICAÇÃO FINAL ANTES DE CRIAR POSIÇÃO
    const MIN_FILL_THRESHOLD_ABSOLUTE = 0.000001; 
    if (totalFilledSize <= MIN_FILL_THRESHOLD_ABSOLUTE) { 
       throw new Error(`Entrada falhou. Quantidade preenchida (${totalFilledSize.toFixed(quantityPrecision)}) é insignificante ou nula para Sinal ID ${signal.id}.`);
    }

    // Verificar se entrada foi completada
    const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;

    if (totalFilledSize >= totalEntrySize) {
        isEntryComplete = true;
    }

    // ✅ INSERIR POSIÇÃO NO BANCO - VERSÃO MELHORADA
    console.log(`[LIMIT_ENTRY] Verificando se posição já existe antes de inserir...`);

    const [existingDbPositions] = await connection.query(
      'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
      [signal.symbol, 'OPEN', accountId]
    );

    if (existingDbPositions.length > 0) {
      console.log(`[LIMIT_ENTRY] ✅ Posição já existe no banco para ${signal.symbol} (ID: ${existingDbPositions[0].id}), atualizando dados...`);

      positionId = existingDbPositions[0].id;

      await connection.query(
        `UPDATE posicoes SET
         quantidade = ?,
         preco_medio = ?,
         preco_entrada = ?,
         preco_corrente = ?,
         data_hora_ultima_atualizacao = NOW()
         WHERE id = ?`,
        [totalFilledSize, averageEntryPrice, averageEntryPrice, averageEntryPrice, positionId]
      );

      console.log(`[LIMIT_ENTRY] ✅ Posição ${positionId} atualizada no banco para ${signal.symbol}`);

    } else {
      const positionData = {
        simbolo: signal.symbol,
        quantidade: totalFilledSize,
        preco_medio: averageEntryPrice,
        status: 'OPEN',
        data_hora_abertura: formatDateForMySQL(new Date(executionStartTime)),
        side: binanceSide,
        leverage: leverage,
        data_hora_ultima_atualizacao: formatDateForMySQL(new Date()),
        preco_entrada: averageEntryPrice,
        preco_corrente: averageEntryPrice,
        orign_sig: `WEBHOOK_${signal.id}`,
        quantidade_aberta: totalFilledSize,
        conta_id: accountId
      };

      positionId = await insertPosition(connection, positionData, signal.id);
      if (!positionId) throw new Error(`Falha ao inserir posição no banco de dados para Sinal ID ${signal.id}`);
      console.log(`[LIMIT_ENTRY] ✅ Nova posição ID ${positionId} criada no banco de dados para Sinal ID ${signal.id}`);
    }

    // ✅ REGISTRAR ORDENS NO BANCO - VERSÃO MELHORADA
    for (const fill of partialFills) {
      const orderData = {
        tipo_ordem: (marketOrderResponseForDb && fill.orderId === String(marketOrderResponseForDb.orderId)) ? 'MARKET' : 'LIMIT',
        preco: fill.price,
        quantidade: fill.qty,
        id_posicao: positionId,
        status: 'FILLED',
        data_hora_criacao: formatDateForMySQL(new Date()),
        id_externo: String(fill.orderId || `fill_${Date.now()}_${Math.random().toString(36).substring(7)}`).substring(0, 90),
        side: binanceSide,
        simbolo: signal.symbol,
        tipo_ordem_bot: 'ENTRADA',
        target: null,
        reduce_only: false,
        close_position: false,
        last_update: formatDateForMySQL(new Date()),
        orign_sig: `WEBHOOK_${signal.id}`,
        preco_executado: fill.price,
        quantidade_executada: fill.qty,
        conta_id: accountId // ✅ ADICIONADO
      };
      await insertNewOrder(connection, orderData);
    }

    await connection.query(
      `UPDATE webhook_signals SET status = 'EXECUTADO', position_id = ?, entry_order_id = ?, entry_price = ? WHERE id = ?`,
      [positionId, (partialFills.length > 0 ? partialFills[0].orderId : null), averageEntryPrice, signal.id]
    );

    // ✅ CRIAR SL/TP/RPS - VERSÃO TOTALMENTE CORRIGIDA DA DEV
    let slTpRpsCreated = false;
    if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO) {
      console.log(`[LIMIT_ENTRY] Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
      slTpRpsCreated = true;

      const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
      
      const targetPrices = {
        tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
        tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
        tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
        tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
        tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
      };

      // ✅ CRIAR STOP LOSS - CORRIGIDO
      if (slPriceVal && slPriceVal > 0) {
        try {
          console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${slPriceVal}`);
          
          const slResponse = await newStopOrder(
            numericAccountId,
            signal.symbol,
            totalFilledSize, // ✅ CORREÇÃO: usar quantidade específica em vez de null
            binanceOppositeSide,
            slPriceVal,
            null, // price null para MARKET
            true, // reduceOnly
            false // closePosition = false, usar quantidade específica
          );
          
          if (slResponse && (slResponse.data?.orderId || slResponse.orderId)) {
            const slOrderId = slResponse.data?.orderId || slResponse.orderId;
            const slOrderData = {
              tipo_ordem: 'STOP_MARKET',
              preco: slPriceVal,
              quantidade: totalFilledSize,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(slOrderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'STOP_LOSS',
              target: slPriceVal,
              reduce_only: true,
              close_position: false, // ✅ CORREÇÃO: false porque usamos quantidade específica
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}`,
              preco_executado: 0,
              quantidade_executada: 0,
              conta_id: accountId // ✅ ADICIONADO
            };
            await insertNewOrder(connection, slOrderData);
            console.log(`[LIMIT_ENTRY] ✅ Stop Loss criado: ${slPriceVal} (ID: ${slOrderId})`);
            
            // ✅ SALVAR ID DO SL NO SINAL
            await connection.query(
              `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`,
              [String(slOrderId), signal.id]
            );
          }
        } catch (slError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar Stop Loss:`, slError.response?.data || slError.message);
        }
      }

      // ✅ CRIAR REDUÇÕES PARCIAIS - CORRIGIDO
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10];
      let cumulativeQtyForRps = 0;
      
      for (let i = 0; i < rpTargetKeys.length; i++) {
        const rpKey = rpTargetKeys[i];
        const rpPrice = targetPrices[rpKey];
        if (rpPrice && rpPrice > 0 && i < reductionPercentages.length) {
          const rpPercentage = reductionPercentages[i];
          const rpQuantity = parseFloat((totalFilledSize * rpPercentage).toFixed(quantityPrecision));
          
          if (rpQuantity > 0) {
            try {
              console.log(`[LIMIT_ENTRY] Criando RP${i+1}: ${rpQuantity.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice}`);
              
              const rpResponse = await newReduceOnlyOrder(
                numericAccountId,
                signal.symbol,
                rpQuantity,
                binanceOppositeSide,
                rpPrice
              );
              
              if (rpResponse && (rpResponse.data?.orderId || rpResponse.orderId)) {
                const rpOrderId = rpResponse.data?.orderId || rpResponse.orderId;
                const rpOrderData = {
                  tipo_ordem: 'LIMIT',
                  preco: rpPrice,
                  quantidade: rpQuantity,
                  id_posicao: positionId,
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()),
                  id_externo: String(rpOrderId),
                  side: binanceOppositeSide,
                  simbolo: signal.symbol,
                  tipo_ordem_bot: 'REDUCAO_PARCIAL',
                  target: i + 1, // ✅ CORREÇÃO: usar número do target
                  reduce_only: true,
                  close_position: false,
                  last_update: formatDateForMySQL(new Date()),
                  orign_sig: `WEBHOOK_${signal.id}`,
                  preco_executado: 0,
                  quantidade_executada: 0,
                  conta_id: accountId // ✅ ADICIONADO
                };
                await insertNewOrder(connection, rpOrderData);
                
                cumulativeQtyForRps += rpQuantity;
                console.log(`[LIMIT_ENTRY] ✅ RP${i+1} criada: ${rpQuantity.toFixed(quantityPrecision)} @ ${rpPrice} (${(rpPercentage*100).toFixed(0)}%) - ID: ${rpOrderId}`);
              }
            } catch (rpError) {
              console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.response?.data || rpError.message);
            }
          }
        }
      }

      // ✅ CRIAR TP FINAL - CORRIGIDO
      const finalTpPrice = targetPrices.tp5;
      const qtyForFinalTpRaw = totalFilledSize - cumulativeQtyForRps;
      const qtyForFinalTp = parseFloat(qtyForFinalTpRaw.toFixed(quantityPrecision));

      if (finalTpPrice && finalTpPrice > 0 && qtyForFinalTp > 0) {
        try {
          console.log(`[LIMIT_ENTRY] Criando TP Final: ${qtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${finalTpPrice}`);
          
          const tpResponse = await newReduceOnlyOrder(
            numericAccountId,
            signal.symbol,
            qtyForFinalTp,
            binanceOppositeSide,
            finalTpPrice
          );
          
          if (tpResponse && (tpResponse.data?.orderId || tpResponse.orderId)) {
            const tpOrderId = tpResponse.data?.orderId || tpResponse.orderId;
            const tpOrderData = {
              tipo_ordem: 'LIMIT',
              preco: finalTpPrice,
              quantidade: qtyForFinalTp,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(tpOrderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'TAKE_PROFIT',
              target: 5, // ✅ CORREÇÃO: target numérico
              reduce_only: true,
              close_position: false,
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}`,
              preco_executado: 0,
              quantidade_executada: 0,
              conta_id: accountId // ✅ ADICIONADO
            };
            await insertNewOrder(connection, tpOrderData);
            console.log(`[LIMIT_ENTRY] ✅ Take Profit final criado: ${qtyForFinalTp.toFixed(quantityPrecision)} @ ${finalTpPrice} - ID: ${tpOrderId}`);
            
            // ✅ SALVAR ID DO TP NO SINAL
            await connection.query(
              `UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`,
              [String(tpOrderId), signal.id]
            );
          }
        } catch (tpError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar TP final:`, tpError.response?.data || tpError.message);
        }
      }
    }

    // ✅ NOTIFICAÇÃO TELEGRAM - VERSÃO MELHORADA DA DEV
    try {
      const displaySide = binanceSide === 'BUY' ? 'Compra' : 'Venda';
      const signalStatus = isEntryComplete ? '✅ Executado' : '⚠️ Parcial';
      const emoji = isEntryComplete ? '✅' : '⚠️';
      
      let message = `${emoji} *Sinal de ${displaySide}*\n`;
      message += `🔹 Símbolo: ${signal.symbol}\n`;
      message += `🔹 Quantidade: ${totalFilledSize.toFixed(quantityPrecision)}\n`;
      message += `🔹 Preço Médio: ${averageEntryPrice.toFixed(pricePrecision)}\n`;
      message += `🔹 Status: ${signalStatus}\n`;
      message += `🔹 ID da Posição: ${positionId}\n`;
      message += `🔹 ID da Ordem de Entrada: ${partialFills.length > 0 ? partialFills[0].orderId : 'N/A'}`;
      
      await sendTelegramMessage(message);
      console.log(`[LIMIT_ENTRY] Mensagem enviada para o Telegram: ${message}`);
    } catch (telegramError) {
      console.error(`[LIMIT_ENTRY] Erro ao enviar mensagem para o Telegram:`, telegramError.message);
    }

    await connection.commit();
    console.log(`[LIMIT_ENTRY] Transação COMMITADA. Sucesso para Sinal ID ${signal.id}`);

    return {
      success: true,
      positionId,
      averagePrice: averageEntryPrice,
      filledQuantity: totalFilledSize,
      partialWarning: !slTpRpsCreated && totalFilledSize > 0 && fillRatio < ENTRY_COMPLETE_THRESHOLD_RATIO
    };

  } catch (error) {
    const originalErrorMessage = error.message || String(error);
    console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`, error.stack || error);

    // CANCELAR ORDEM ATIVA SE EXISTIR USANDO API.JS
    if (activeOrderId) {
      try {
        console.log(`[LIMIT_ENTRY] (Catch Principal) Tentando cancelar ordem ativa ${activeOrderId} antes do rollback.`);
        
        // ✅ USAR cancelOrder DO API.JS
        await cancelOrder(signal.symbol, activeOrderId, numericAccountId); 
        
        console.log(`[LIMIT_ENTRY] (Catch Principal) Ordem ${activeOrderId} cancelada com sucesso.`);
      } catch (cancelErrOnCatch) { 
        console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao cancelar ordem ${activeOrderId}:`, cancelErrOnCatch.message); 
      }
    }

    if (connection) { 
      try { 
        await connection.rollback(); 
        console.log(`[LIMIT_ENTRY] (Catch Principal) ROLLBACK da transação principal efetuado para Sinal ${signal.id}.`); 
      } catch (rbErr) { 
        console.error(`[LIMIT_ENTRY] (Catch Principal) Erro CRÍTICO ao efetuar ROLLBACK para Sinal ${signal.id}:`, rbErr); 
      }
    }

    try {
      await db.query( 
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        [String(originalErrorMessage).substring(0, 250), signal.id]
      );
    } catch (updateError) { 
      console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao atualizar status do sinal para ERROR no DB:`, updateError); 
    }

    return { success: false, error: originalErrorMessage };

  } finally {
    if (depthWs) {
      console.log(`[LIMIT_ENTRY] Fechando WebSocket de profundidade para ${signal?.symbol || 'unknown'} no bloco finally.`);
      try {
        depthWs.close();
      } catch (wsCloseError) {
        console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket de profundidade para ${signal?.symbol || 'unknown'} no finally: ${wsCloseError.message}`);
      }
    }
    if (connection) {
      connection.release();
    }
  }
}

// ✅ FUNÇÃO waitForOrderExecution ADAPTADA DA DEV COM MELHORIAS
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId, sentOrdersMap) {
  const startTime = Date.now();
  
  try {
    console.log(`[WAIT_ORDER] Aguardando execução da ordem ${orderId} por ${maxWaitMs}ms...`);
    
    // PRIMEIRA VERIFICAÇÃO: WebSocket local (mais rápido)
    if (sentOrdersMap && sentOrdersMap.has(orderId)) {
      const orderInfo = sentOrdersMap.get(orderId);
      if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
        console.log(`[WAIT_ORDER] ✅ Ordem ${orderId} já confirmada via WebSocket local: ${orderInfo.status}`);
        return {
          status: orderInfo.status,
          executedQty: orderInfo.executedQty.toString(),
          avgPrice: (orderInfo.avgPrice || orderInfo.price).toString(),
          orderId: orderId,
          clientOrderId: orderInfo.clientOrderId,
          fills: orderInfo.fills || []
        };
      }
    }
    
    // SEGUNDA VERIFICAÇÃO: REST API imediata
    try {
      const orderStatus = await getOrderStatus(symbol, orderId, accountId);
      if (orderStatus && (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED')) {
        console.log(`[WAIT_ORDER] ✅ Ordem ${orderId} confirmada via REST: ${orderStatus.status}`);
        
        // ATUALIZAR O MAPA DE ORDENS ENVIADAS
        if (sentOrdersMap && sentOrdersMap.has(orderId)) {
          const orderInfo = sentOrdersMap.get(orderId);
          orderInfo.status = orderStatus.status;
          orderInfo.executedQty = parseFloat(orderStatus.executedQty || '0');
          orderInfo.avgPrice = parseFloat(orderStatus.avgPrice || orderStatus.price || '0');
          orderInfo.lastUpdateTime = Date.now();
          sentOrdersMap.set(orderId, orderInfo);
        }
        
        return orderStatus;
      }
    } catch (restError) {
      console.log(`[WAIT_ORDER] ⚠️ Erro REST (pode ser apenas atraso): ${restError.message}`);
    }
    
    // LOOP DE ESPERA COM VERIFICAÇÕES DUPLAS
    const checkInterval = 100; // 100ms entre verificações
    let checks = 0;
    const maxChecks = Math.floor(maxWaitMs / checkInterval);
    
    while (checks < maxChecks) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
      checks++;
      
      // VERIFICAR VIA WEBSOCKET LOCAL A CADA ITERAÇÃO
      if (sentOrdersMap && sentOrdersMap.has(orderId)) {
        const orderInfo = sentOrdersMap.get(orderId);
        if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
          console.log(`[WAIT_ORDER] ✅ Ordem ${orderId} confirmada via WebSocket durante espera: ${orderInfo.status}`);
          return {
            status: orderInfo.status,
            executedQty: orderInfo.executedQty.toString(),
            avgPrice: (orderInfo.avgPrice || orderInfo.price).toString(),
            orderId: orderId,
            clientOrderId: orderInfo.clientOrderId,
            fills: orderInfo.fills || []
          };
        }
      }
      
      // VERIFICAR VIA REST A CADA 10 ITERAÇÕES (1 segundo)
      if (checks % 10 === 0) {
        try {
          const orderStatus = await getOrderStatus(symbol, orderId, accountId);
          if (orderStatus && (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED')) {
            console.log(`[WAIT_ORDER] ✅ Ordem ${orderId} confirmada via REST durante espera: ${orderStatus.status}`);
            return orderStatus;
          }
        } catch (error) {
          // Ignorar erros durante o loop
        }
      }
    }
    
    // VERIFICAÇÃO FINAL VIA REST
    try {
      const finalStatus = await getOrderStatus(symbol, orderId, accountId);
      console.log(`[WAIT_ORDER] Status final da ordem ${orderId}: ${finalStatus?.status || 'UNKNOWN'}`);
      return finalStatus || { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    } catch (error) {
      console.log(`[WAIT_ORDER] ❌ Erro final ao verificar ordem ${orderId}: ${error.message}`);
      return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
    
  } catch (error) {
    console.error(`[WAIT_ORDER] ❌ Erro crítico em waitForOrderExecution:`, error);
    return { status: 'ERROR', executedQty: '0', avgPrice: '0' };
  }
}

// FUNÇÕES AUXILIARES (mantidas como estavam)
async function getAvailableBalance(accountId) {
    try {
        console.log(`[LIMIT_ENTRY] Obtendo saldo disponível para conta ${accountId}...`);

        if (!accountId || typeof accountId !== 'number') {
            throw new Error(`AccountId inválido: ${accountId}`);
        }

        // ✅ USAR getFuturesAccountBalanceDetails DO API.JS
        const balanceDetails = await api.getFuturesAccountBalanceDetails(accountId);

        if (!balanceDetails || !balanceDetails.success) {
            console.log(`[LIMIT_ENTRY] ⚠️ Resposta de saldo inválida, usando valor padrão`);
            return 1000;
        }

        const saldoDisponivel = parseFloat(balanceDetails.saldo_disponivel || balanceDetails.saldo || 0);
        console.log(`[LIMIT_ENTRY] ✅ Saldo disponível: ${saldoDisponivel} USDT`);

        return saldoDisponivel;
    } catch (error) {
        console.error(`[LIMIT_ENTRY] Erro ao obter saldo para conta ${accountId}:`, error.message);
        console.log(`[LIMIT_ENTRY] ⚠️ Usando valor padrão devido ao erro`);
        return 1000;
    }
}

function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, stepSize, quantityPrecision) {
    const capital = availableBalance * capitalPercentage;
    const rawSize = (capital * leverage) / entryPrice;

    if (stepSize <= 0) {
        console.warn(`[MONITOR] StepSize inválido (${stepSize}), usando precisão para cálculo.`);
        const multiplier = Math.pow(10, quantityPrecision);
        const truncatedSize = Math.floor(rawSize * multiplier) / multiplier;
        return parseFloat(truncatedSize.toFixed(quantityPrecision));
    }

    const stepMultiplier = 1 / stepSize;
    const stepsRaw = rawSize * stepMultiplier;
    const stepsFloor = Math.floor(stepsRaw);
    const truncatedSize = stepsFloor / stepMultiplier;

    const formattedSize = parseFloat(truncatedSize.toFixed(quantityPrecision));

    console.log(`[MONITOR] Cálculo: capital=${capital.toFixed(2)}, rawSize=${rawSize}, stepSize=${stepSize}, steps=${stepsFloor}, formatado=${formattedSize}`);

    return formattedSize;
}

function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;

    let totalQty = 0;
    let totalCost = 0;

    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);

        if (!isNaN(qty) && !isNaN(price) && qty > 0) {
            totalQty += qty;
            totalCost += qty * price;
        }
    });

    return totalQty > 0 ? totalCost / totalQty : 0;
}

module.exports = {
    executeLimitMakerEntry
};