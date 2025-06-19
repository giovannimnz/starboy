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



async function executeLimitMakerEntry(signal, currentPrice, accountId) {
  console.log(`[LIMIT_ENTRY] 🚀 Executando entrada para sinal ${signal.id}: ${signal.symbol} ${signal.side} a ${signal.entry_price}`);

  // ✅ SISTEMA DE RASTREAMENTO MELHORADO (baseado na versão dev)
  const sentOrders = new Map(); // Mapa para rastrear ordens enviadas
  let isEntryComplete = false;
  let currentBestBid = null;
  let currentBestAsk = null;
  let lastDepthUpdateTimestamp = 0;
  let wsUpdateErrorCount = 0;
  
  // ✅ HANDLER MELHORADO PARA WEBSOCKET (baseado na versão dev)
  const orderUpdateHandler = (orderMsg) => {
    if (!orderMsg || !orderMsg.o || !orderMsg.o.i) return;

    const order = orderMsg.o;
    const orderId = String(order.i);
    const executionType = order.x; // NEW, CANCELED, TRADE, etc.
    const orderStatus = order.X; // NEW, FILLED, PARTIALLY_FILLED, etc.
    
    // Atualizar a ordem no mapa de ordens enviadas
    if (!sentOrders.has(orderId)) {
      // Se a ordem não estava no mapa, adicionar
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
        fills: []
      });
    } else {
      // Atualizar ordem existente
      const orderInfo = sentOrders.get(orderId);
      orderInfo.status = orderStatus;
      orderInfo.executedQty = parseFloat(order.z || '0');
      orderInfo.avgPrice = parseFloat(order.ap || '0');
      orderInfo.lastUpdateTime = Date.now();
      
      // Se foi uma execução (TRADE), adicionar ao histórico de fills
      if (executionType === 'TRADE') {
        const fillQty = parseFloat(order.l || '0'); // quantidade desta execução
        const fillPrice = parseFloat(order.L || '0'); // preço desta execução
        
        if (fillQty > 0) {
          orderInfo.fills.push({
            qty: fillQty,
            price: fillPrice,
            time: Date.now()
          });
          
          console.log(`[ORDER_WS] Fill recebido para ${orderId}: ${fillQty} @ ${fillPrice}`);
        }
      }
      
      sentOrders.set(orderId, orderInfo);
    }
  };

  try {
    // ✅ REGISTRAR HANDLER PARA WEBSOCKET
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

    // Constantes de configuração
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 180000; // 3 minutos
    const WAIT_FOR_ORDER_CONFIRMATION_MS = 15000;
    const EDIT_WAIT_TIMEOUT_MS = 3000;
    const MAX_DEPTH_STALENESS_MS = 3000;
    const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.98;

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let executionStartTime = Date.now();
    let partialFills = [];
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    // VALIDAÇÃO INICIAL
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em executeLimitMakerEntry: ${accountId} (tipo: ${typeof accountId})`);
    }

    if (!signal || !signal.id || !signal.symbol) {
      throw new Error(`Signal inválido: ${JSON.stringify(signal)}`);
    }

    numericAccountId = parseInt(accountId) || accountId;

    console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol}) na conta ${accountId}`);

    // OBTER CONEXÃO DO BANCO
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
    }

    connection = await db.getConnection();

    // VERIFICAR SE JÁ EXISTE POSIÇÃO ABERTA
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

    // CANCELAR ORDENS EXISTENTES
    const [existingOrders] = await connection.query(
      `SELECT id_externo FROM ordens WHERE orign_sig = ? AND status IN ('NEW', 'PARTIALLY_FILLED')`,
      [`WEBHOOK_${signal.id}`]
    );

    if (existingOrders.length > 0) {
      console.log(`[LIMIT_ENTRY] ⚠️ Já existem ${existingOrders.length} ordens ativas para este sinal. Cancelando...`);

      for (const order of existingOrders) {
        try {
          // ✅ USAR FUNÇÃO DO API.JS
          await cancelOrder(signal.symbol, order.id_externo, numericAccountId);
          console.log(`[LIMIT_ENTRY] Ordem ${order.id_externo} cancelada.`);
        } catch (cancelError) {
          console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem ${order.id_externo}:`, cancelError.message);
        }
      }
    }

    await connection.beginTransaction();

    // OBTER PRECISÃO E CALCULAR TAMANHOS
    const precisionInfo = await getPrecision(signal.symbol, numericAccountId);
    quantityPrecision = precisionInfo.quantityPrecision;
    pricePrecision = precisionInfo.pricePrecision;
    const stepSize = precisionInfo.stepSize;

    const availableBalance = await getAvailableBalance(numericAccountId);
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage);

    // OBTER PREÇO ATUAL
    const currentPriceTrigger = signal.price || signal.entry_price || await api.getPrice(signal.symbol, numericAccountId);

    if (!currentPriceTrigger || currentPriceTrigger <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPriceTrigger}`);
    }

    totalEntrySize = calculateOrderSize(
      availableBalance, capitalPercentage, currentPriceTrigger, leverage, stepSize, quantityPrecision
    );

    if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
      throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
    }

    // ✅ VALIDAR QUANTIDADE TOTAL
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

    await connection.query(
      `UPDATE webhook_signals SET status = 'ENTRADA_EM_PROGRESSO' WHERE id = ?`,
      [signal.id]
    );

    // ✅ CONFIGURAR WEBSOCKET DE PROFUNDIDADE
    console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
    depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData, receivedAccountId) => {
      if (receivedAccountId && receivedAccountId !== accountId) {
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados recebidos para conta diferente: esperado ${accountId}, recebido ${receivedAccountId}`);
        return;
      }

      if (depthData && depthData.bestBid && depthData.bestAsk) {
        const bid = parseFloat(depthData.bestBid);
        const ask = parseFloat(depthData.bestAsk);

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
      } else {
        wsUpdateErrorCount++;
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos para ${signal.symbol}:`, depthData);
      }
    }, accountId);

    // AGUARDAR DADOS DO WEBSOCKET COM FALLBACK
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
        const spread = currentMarketPrice * 0.0001;
        fallbackBid = currentMarketPrice - spread;
        fallbackAsk = currentMarketPrice + spread;
        console.log(`[LIMIT_ENTRY] Dados de fallback: Bid=${fallbackBid.toFixed(pricePrecision)}, Ask=${fallbackAsk.toFixed(pricePrecision)}`);
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

      // ✅ SINCRONIZAR PREENCHIMENTOS USANDO API.JS
      try {
        // ✅ USAR getRecentOrders DO API.JS
        const recentOrders = await getRecentOrders(numericAccountId, signal.symbol, 15);
        
        // Filtrar apenas ordens preenchidas
        const filledExchangeOrders = recentOrders.filter(order =>
          order.status === 'FILLED' &&
          order.side === binanceSide &&
          parseFloat(order.executedQty) > 0 &&
          order.updateTime >= executionStartTime && 
          (Date.now() - order.updateTime) < CHASE_TIMEOUT_MS * 2 &&
          !partialFills.some(fill => fill.orderId === String(order.orderId))
        );

        for (const exOrder of filledExchangeOrders) {
          const qty = parseFloat(exOrder.executedQty);
          const price = parseFloat(exOrder.avgPrice || exOrder.price);
          if (!partialFills.some(fill => fill.orderId === String(exOrder.orderId))) {
            partialFills.push({ qty, price, orderId: String(exOrder.orderId) });
            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
          }
        }
        if (totalFilledSize >= totalEntrySize) {
          console.log(`[LIMIT_ENTRY] (Sync Recent) Quantidade total atingida após sincronização de ordens recentes.`);
          break;
        }
      } catch (checkError) {
        console.error(`[LIMIT_ENTRY] Erro ao buscar/sincronizar ordens recentes:`, checkError.message);
      }

      const remainingSizeCurrentLoop = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
      if (remainingSizeCurrentLoop <= 0) {
        console.log(`[LIMIT_ENTRY] Quantidade restante (${remainingSizeCurrentLoop.toFixed(quantityPrecision)}) zerada ou negativa. Saindo do loop de chasing.`);
        break;
      }

      // ✅ VERIFICAÇÃO DE DADOS DO BOOK
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

      // ✅ LÓGICA DE CÁLCULO DE PREÇO MELHORADA
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

      // ✅ GERENCIAMENTO DE ORDENS ATIVAS USANDO API.JS
      if (activeOrderId) {
        let currentOrderDataFromExchange;
        try {
          // ✅ USAR getOrderStatus DO API.JS
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
                // ✅ USAR cancelOrder DO API.JS
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
                
                // ✅ USAR editOrder DO API.JS
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
                  // ✅ USAR cancelOrder DO API.JS
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
      
      // ✅ CRIAR NOVA ORDEM USANDO API.JS
      if (!activeOrderId && totalFilledSize < totalEntrySize) { 
        const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
        if (newOrderQty <= 0) { 
          console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
          break; 
        }
        try {
          console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          
          // ✅ USAR newLimitMakerOrder DO API.JS
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
        } catch (newOrderError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, newOrderError.message);
          await new Promise(resolve => setTimeout(resolve, 1000)); 
          continue;
        }
      }
      
      // ✅ AGUARDAR EXECUÇÃO
      if (orderPlacedOrEditedThisIteration && activeOrderId) {
        console.log(`[LIMIT_ENTRY] Aguardando execução/status da ordem ${activeOrderId} por ${EDIT_WAIT_TIMEOUT_MS}ms...`);
        
        const orderWaitResult = await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS, numericAccountId);
        
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

    // Calcular preço médio final
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
      averageEntryPrice = currentPriceTrigger; 
      console.warn(`[LIMIT_ENTRY] averageEntryPrice não pôde ser calculado a partir de partialFills (total preenchido: ${totalFilledSize}), usando currentPriceTrigger como fallback: ${averageEntryPrice}`);
    }

    // Verificar se entrada foi completada
    const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;

    // ... resto da lógica de criação de posição, SL/TP/RPs permanece igual ...

    if (totalFilledSize >= totalEntrySize) {
        isEntryComplete = true;
    }

    // INSERIR POSIÇÃO NO BANCO
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

    // REGISTRAR ORDENS NO BANCO
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
      };
      await insertNewOrder(connection, orderData);
    }

    await connection.query(
      `UPDATE webhook_signals SET status = 'EXECUTADO', position_id = ?, entry_order_id = ?, entry_price = ? WHERE id = ?`,
      [positionId, (partialFills.length > 0 ? partialFills[0].orderId : null), averageEntryPrice, signal.id]
    );

    // CRIAR SL/TP/RPS SE ENTRADA FOI COMPLETA
    let slTpRpsCreated = false;
    if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO) {
      console.log(`[LIMIT_ENTRY] Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
      slTpRpsCreated = true;

      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
      
      const targetPrices = {
        tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
        tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
        tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
        tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
        tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
      };

      // CRIAR STOP LOSS USANDO API.JS
      if (slPriceVal && slPriceVal > 0) {
        try {
          // ✅ USAR newStopOrder DO API.JS
          const slResponse = await newStopOrder(
            numericAccountId,
            signal.symbol,
            null, // quantity null para closePosition
            binanceOppositeSide,
            slPriceVal,
            null, // price null para MARKET
            true, // reduceOnly
            true  // closePosition
          );
          
          if (slResponse && slResponse.orderId) {
            const slOrderData = {
              tipo_ordem: 'STOP_MARKET',
              preco: 0,
              quantidade: 0,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(slResponse.orderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'STOP_LOSS',
              target: slPriceVal,
              reduce_only: true,
              close_position: true,
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}`,
              preco_executado: 0,
              quantidade_executada: 0,
            };
            await insertNewOrder(connection, slOrderData);
            console.log(`[LIMIT_ENTRY] ✅ Stop Loss criado: ${slPriceVal} (ID: ${slResponse.orderId})`);
          }
        } catch (slError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar Stop Loss:`, slError.message);
        }
      }

      // CRIAR REDUÇÕES PARCIAIS USANDO API.JS
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
              // ✅ USAR newReduceOnlyOrder DO API.JS
              const rpResponse = await newReduceOnlyOrder(
                numericAccountId,
                signal.symbol,
                rpQuantity,
                binanceOppositeSide,
                rpPrice
              );
              
              if (rpResponse && rpResponse.orderId) {
                const rpOrderData = {
                  tipo_ordem: 'LIMIT',
                  preco: rpPrice,
                  quantidade: rpQuantity,
                  id_posicao: positionId,
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()),
                  id_externo: String(rpResponse.orderId),
                  side: binanceOppositeSide,
                  simbolo: signal.symbol,
                  tipo_ordem_bot: 'REDUCAO_PARCIAL',
                  target: rpPrice,
                  reduce_only: true,
                  close_position: false,
                  last_update: formatDateForMySQL(new Date()),
                  orign_sig: `WEBHOOK_${signal.id}`,
                  preco_executado: 0,
                  quantidade_executada: 0,
                };
                await insertNewOrder(connection, rpOrderData);
                
                cumulativeQtyForRps += rpQuantity;
                console.log(`[LIMIT_ENTRY] ✅ RP${i+1} criada: ${rpQuantity.toFixed(quantityPrecision)} @ ${rpPrice} (${(rpPercentage*100).toFixed(0)}%) - ID: ${rpResponse.orderId}`);
              }
            } catch (rpError) {
              console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.message);
            }
          }
        }
      }

      // CRIAR TP FINAL USANDO API.JS
      const finalTpPrice = targetPrices.tp5;
      const qtyForFinalTpRaw = totalFilledSize - cumulativeQtyForRps;
      const qtyForFinalTp = parseFloat(qtyForFinalTpRaw.toFixed(quantityPrecision));

      if (finalTpPrice && finalTpPrice > 0 && qtyForFinalTp > 0) {
        try {
          // ✅ USAR newReduceOnlyOrder DO API.JS
          const tpResponse = await newReduceOnlyOrder(
            numericAccountId,
            signal.symbol,
            qtyForFinalTp,
            binanceOppositeSide,
            finalTpPrice
          );
          
          if (tpResponse && tpResponse.orderId) {
            const tpOrderData = {
              tipo_ordem: 'LIMIT',
              preco: finalTpPrice,
              quantidade: qtyForFinalTp,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(tpResponse.orderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'TAKE_PROFIT',
              target: finalTpPrice,
              reduce_only: true,
              close_position: false,
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}`,
              preco_executado: 0,
              quantidade_executada: 0,
            };
            await insertNewOrder(connection, tpOrderData);
            console.log(`[LIMIT_ENTRY] ✅ Take Profit final criado: ${qtyForFinalTp.toFixed(quantityPrecision)} @ ${finalTpPrice} - ID: ${tpResponse.orderId}`);
          }
        } catch (tpError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar TP final:`, tpError.message);
        }
      }
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

// ✅ FUNÇÃO waitForOrderExecution ADAPTADA PARA USAR API.JS
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId) {
  const startTime = Date.now();
  
  try {
    // Primeira verificação imediata via sentOrders (WebSocket local)
    if (sentOrders.has(orderId)) {
      const orderInfo = sentOrders.get(orderId);
      if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
        console.log(`[WAIT_ORDER] Ordem ${orderId} já confirmada via WebSocket local: ${orderInfo.status}`);
        return {
          status: orderInfo.status,
          executedQty: orderInfo.executedQty,
          avgPrice: orderInfo.avgPrice || orderInfo.price
        };
      }
    }
    
    // Se não foi confirmada, usar REST API
    try {
      // ✅ USAR getOrderStatus DO API.JS
      const orderStatus = await getOrderStatus(symbol, orderId, accountId);
      if (orderStatus && (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED')) {
        console.log(`[WAIT_ORDER] Ordem ${orderId} confirmada via REST: ${orderStatus.status}`);
        
        // Atualizar o mapa de ordens enviadas
        if (sentOrders.has(orderId)) {
          const orderInfo = sentOrders.get(orderId);
          orderInfo.status = orderStatus.status;
          orderInfo.executedQty = parseFloat(orderStatus.executedQty);
          orderInfo.avgPrice = parseFloat(orderStatus.avgPrice);
          orderInfo.lastUpdateTime = Date.now();
          sentOrders.set(orderId, orderInfo);
        }
        
        return orderStatus;
      }
    } catch (error) {
      console.log(`[WAIT_ORDER] Erro REST (pode ser apenas atraso): ${error.message}`);
    }
    
    // Aguardar até o timeout, verificando se o WebSocket local atualiza
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (sentOrders.has(orderId)) {
        const orderInfo = sentOrders.get(orderId);
        if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
          console.log(`[WAIT_ORDER] Ordem ${orderId} confirmada via WebSocket local durante espera: ${orderInfo.status}`);
          return {
            status: orderInfo.status,
            executedQty: orderInfo.executedQty,
            avgPrice: orderInfo.avgPrice || orderInfo.price
          };
        }
      }
    }
    
    // Final: uma última tentativa via REST
    try {
      // ✅ USAR getOrderStatus DO API.JS
      return await getOrderStatus(symbol, orderId, accountId);
    } catch (error) {
      console.log(`[WAIT_ORDER] Erro final ao verificar ordem ${orderId}: ${error.message}`);
      return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
  } catch (error) {
    console.error(`[WAIT_ORDER] Erro crítico em waitForOrderExecution:`, error);
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