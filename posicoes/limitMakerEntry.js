const axios = require('axios');
const fs = require('fs').promises;
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
  // Assuming these new WebSocket API functions are implemented elsewhere and exposed
  getMultipleOrderStatusViaWebSocket,
  getOrderStatusViaWebSocket,
  cancelOrderByIdViaWebSocket,
  editOrderViaWebSocket,
  placeLimitMakerOrderViaWebSocket,
} = require('../api');
const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const websockets = require('../websockets');
const api = require('../api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Executa entrada usando Limit Maker
 * @param {Object} signal - Sinal a ser processado
 * @param {number} currentPrice - Preço atual do mercado
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} Resultado da operação
 */
// CORREÇÃO: Removido o parâmetro 'db' que causava erro de sintaxe.
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
    // ✅ ADICIONAR NO INÍCIO DA FUNÇÃO, APÓS A DEFINIÇÃO DO orderUpdateHandler
    // Registrar o handler para WebSocket
    const websockets = require('../websockets');
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

    // ... resto do código ...

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
    let precision = null; // Inicializar precision para evitar erro de referência

    // Constantes de configuração
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 180000; // 3 minutos
    const WAIT_FOR_ORDER_CONFIRMATION_MS = 15000; // ✅ 15 segundos para aguardar confirmação WebSocket
    const EDIT_WAIT_TIMEOUT_MS = 3000;
    const MAX_DEPTH_STALENESS_MS = 3000;
    const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.98;

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let executionStartTime = Date.now();
    let partialFills = [];
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    // VALIDAÇÃO INICIAL CRÍTICA
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em executeLimitMakerEntry: ${accountId} (tipo: ${typeof accountId})`);
    }

    if (!signal || !signal.id || !signal.symbol) {
      throw new Error(`Signal inválido: ${JSON.stringify(signal)}`);
    }

    // ✅ DEFINIR numericAccountId LOGO NO INÍCIO
    numericAccountId = parseInt(accountId) || accountId; // ✅ CORREÇÃO: Apenas atribuir o valor.

    console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol}) na conta ${accountId}`);

    // OBTER CONEXÃO DO BANCO PARA A CONTA ESPECÍFICA
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
    }

    connection = await db.getConnection();

    // VERIFICAR SE JÁ EXISTE POSIÇÃO ABERTA
    const existingPositionsOnExchange = await getAllOpenPositions(numericAccountId, signal.symbol);
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

    // VERIFICAR E CANCELAR ORDENS EXISTENTES
    const [existingOrders] = await connection.query(
      `SELECT id_externo FROM ordens WHERE orign_sig = ? AND status IN ('NEW', 'PARTIALLY_FILLED')`,
      [`WEBHOOK_${signal.id}`]
    );

    if (existingOrders.length > 0) {
      console.log(`[LIMIT_ENTRY] ⚠️ Já existem ${existingOrders.length} ordens ativas para este sinal. Cancelando...`);

      for (const order of existingOrders) {
        try {
          await cancelOrder(numericAccountId, signal.symbol, order.id_externo);
          console.log(`[LIMIT_ENTRY] Ordem ${order.id_externo} cancelada com sucesso.`);

          await connection.query(
            `UPDATE ordens SET status = 'CANCELED', last_update = NOW() WHERE id_externo = ?`,
            [order.id_externo]
          );
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
    const stepSize = precisionInfo.stepSize; // ✅ OBTÉM O STEP SIZE

    const availableBalance = await getAvailableBalance(numericAccountId);
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage);

    // OBTER PREÇO ATUAL
    const currentPriceTrigger = signal.price || signal.entry_price || await api.getPrice(signal.symbol, numericAccountId);

    if (!currentPriceTrigger || currentPriceTrigger <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPriceTrigger}`);
    }

    totalEntrySize = calculateOrderSize(
      availableBalance, capitalPercentage, currentPriceTrigger, leverage, stepSize, quantityPrecision // ✅ PASSA O STEP SIZE PARA A FUNÇÃO
    );

    if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
      throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
    }

    // ✅ VALIDAR QUANTIDADE TOTAL CONTRA REQUISITOS DA BINANCE
    console.log(`[LIMIT_ENTRY] Validando quantidade total de entrada: ${totalEntrySize}`);
    const entryValidation = await validateQuantity(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');

    if (!entryValidation.isValid) {
      console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade de entrada inválida: ${entryValidation.reason}`);

      // TENTAR AJUSTAR AUTOMATICAMENTE
      const adjustment = await adjustQuantityToRequirements(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');

      if (adjustment.success) {
        console.log(`[LIMIT_ENTRY] ✅ Quantidade ajustada: ${totalEntrySize} → ${adjustment.adjustedQuantity}`);

        // ✅ VERIFICAÇÃO CRÍTICA: Se ajuste mudou drasticamente a quantidade, avisar
        const adjustmentRatio = adjustment.adjustedQuantity / totalEntrySize;
        if (adjustmentRatio > 10) { // Se teve que aumentar mais de 10x
          console.warn(`[LIMIT_ENTRY] ⚠️ AVISO: Quantidade foi aumentada drasticamente (${adjustmentRatio.toFixed(1)}x) para atender requisitos mínimos`);
          console.warn(`[LIMIT_ENTRY] Original: ${totalEntrySize.toFixed(quantityPrecision)}, Ajustada: ${adjustment.adjustedQuantity.toFixed(quantityPrecision)}`);
        }

        totalEntrySize = adjustment.adjustedQuantity;
      } else {
        // ✅ FALHA CRÍTICA: Se não conseguiu ajustar, abortar o sinal
        const errorMsg = `Quantidade de entrada inválida para ${signal.symbol}: ${entryValidation.reason}. Ajuste impossível: ${adjustment.error}`;
        console.error(`[LIMIT_ENTRY] ❌ ${errorMsg}`);

        // Atualizar status do sinal para ERROR
        if (connection) {
          await connection.query(
            'UPDATE webhook_signals SET status = ?, error_message = ? WHERE id = ?',
            ['ERROR', errorMsg.substring(0, 250), signal.id]
          );
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

    // ✅ MELHORAR O SETUP DO WEBSOCKET DE PROFUNDIDADE
    // CONFIGURAR WEBSOCKET DE PROFUNDIDADE - VERSÃO MELHORADA
    console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
    depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData, receivedAccountId) => {
      // VALIDAÇÃO: Verificar se é para a conta correta
      if (receivedAccountId && receivedAccountId !== accountId) {
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados recebidos para conta diferente: esperado ${accountId}, recebido ${receivedAccountId}`);
        return;
      }

      if (depthData && depthData.bestBid && depthData.bestAsk) {
        const bid = parseFloat(depthData.bestBid);
        const ask = parseFloat(depthData.bestAsk);

        // VALIDAÇÃO: Verificar spread razoável
        const spread = ask - bid;
        const spreadPercent = (spread / bid) * 100;

        if (spreadPercent > 5) {
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Spread muito grande para ${signal.symbol}: ${spreadPercent.toFixed(2)}% - possível erro nos dados`);
          wsUpdateErrorCount++;
          return;
        }

        // VALIDAÇÃO: Verificar se bid < ask
        if (bid >= ask) {
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados inválidos para ${signal.symbol}: bid (${bid}) >= ask (${ask})`);
          wsUpdateErrorCount++;
          return;
        }

        currentBestBid = bid;
        currentBestAsk = ask;
        lastDepthUpdateTimestamp = Date.now();
        wsUpdateErrorCount = 0;

        // Log apenas para debug quando necessário
        //console.log(`[LIMIT_ENTRY_DEPTH_WS] ✅ Dados válidos ${signal.symbol}: Bid=${bid.toFixed(pricePrecision)}, Ask=${ask.toFixed(pricePrecision)}, Spread=${spreadPercent.toFixed(4)}%`);
      } else {
        wsUpdateErrorCount++;
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos para ${signal.symbol}:`, depthData);
      }
    }, accountId);

    // AGUARDAR DADOS DO WEBSOCKET COM RETRY MELHORADO
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

    // OBTER TICK SIZE UMA ÚNICA VEZ FORA DO LOOP
    const tickSizeData = await getTickSize(signal.symbol, numericAccountId);
    const tickSize = parseFloat(tickSizeData.tickSize) || 0.01;

    console.log(`[LIMIT_ENTRY] ✅ Dados iniciais prontos. Iniciando loop de chasing...`);
    console.log(`[LIMIT_ENTRY] Configuração: tickSize=${tickSize}, totalEntrySize=${totalEntrySize.toFixed(quantityPrecision)}`);

    // Removed the old while loop and its contents here.

    // ✅ SUBSTITUIR O LOOP PRINCIPAL DE CHASING POR ESTA VERSÃO BASEADA NA DEV
    // ===== LOOP PRINCIPAL DE PERSEGUIÇÃO DE PREÇO (BASEADO NA VERSÃO DEV) =====
    while (totalFilledSize < totalEntrySize && 
          chaseAttempts < MAX_CHASE_ATTEMPTS && 
          (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
      
      chaseAttempts++;

      // ✅ SINCRONIZAR PREENCHIMENTOS ANTES DE OBTER O BOOK (como na versão dev)
      try {
        // ALTERADO: Usar WebSocket API para obter ordens recentes
        // NOTE: getMultipleOrderStatusViaWebSocket is a placeholder and needs to be implemented
        const recentOrdersResponse = await getMultipleOrderStatusViaWebSocket(signal.symbol, 
          Array(15).fill().map((_, i) => i + 1) // Solicitar status das últimas 15 ordens
        );
        
        // Pegar apenas as ordens que foram preenchidas
        const recentOrders = recentOrdersResponse.filter(order =>
          order.data && order.data.status === 'FILLED'
        ).map(order => order.data);
        
        // CORREÇÃO: Verificar apenas ordens recentes que pertencem a ESTE SINAL
        // Usar o tempo de início da execução atual como filtro
        const filledExchangeOrders = recentOrders.filter(order =>
          order.status === 'FILLED' &&
          order.side === binanceSide &&
          parseFloat(order.executedQty) > 0 &&
          // ADICIONANDO este filtro crucial:
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

      // ✅ VERIFICAÇÃO DE DADOS DO BOOK MELHORADA (como na versão dev)
      const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
      if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
        const staleReason = !currentBestBid || !currentBestAsk ? "ausentes" : (isDepthDataStale ? "velhos" : `erros WS (${wsUpdateErrorCount})`);
        console.log(`[LIMIT_ENTRY] Dados do BookTicker (WebSocket) para ${signal.symbol} ${staleReason}. Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Última atualização WS: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
        
        // Aguardar um pouco antes de continuar
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const bestBid = currentBestBid;
      const bestAsk = currentBestAsk;
      const spread = bestAsk - bestBid;

      // ✅ LÓGICA DE CÁLCULO DE PREÇO MELHORADA (baseada na versão dev)
      let currentLocalMakerPrice;
      if (binanceSide === 'BUY') {
        // Para compras (BUY), verificar se podemos posicionar ordem dentro do spread
        // Queremos posicionar 1 tick acima do melhor bid (mais agressivo, mas ainda MAKER)
        const spreadSize = bestAsk - bestBid;
        const moreBidPrice = bestBid + tickSize;
        
        // Verificar se há espaço suficiente no spread para posicionar a ordem
        if (spreadSize > tickSize && moreBidPrice < bestAsk) {
          // Posicionar ordem 1 tick acima do melhor bid
          currentLocalMakerPrice = moreBidPrice;
          console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem BUY posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do melhor bid)`);
        } else {
          // Spread muito estreito, usar o bid atual como base
          currentLocalMakerPrice = bestBid;
          console.log(`[LIMIT_ENTRY] Spread muito estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem BUY no melhor bid: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
        }
        
        // Verificação final para garantir que a ordem será MAKER
        if (currentLocalMakerPrice >= bestAsk - tickSize) {
          currentLocalMakerPrice = bestAsk - tickSize;
          console.log(`[LIMIT_ENTRY] Ajuste: preço BUY ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do ask)`);
        }
      } else { // SELL
        // Para vendas (SELL), verificar se podemos posicionar ordem dentro do spread
        // Queremos posicionar 1 tick abaixo do melhor ask (mais agressivo, mas ainda MAKER)
        const spreadSize = bestAsk - bestBid;
        const lessAskPrice = bestAsk - tickSize;
        
        // Verificar se há espaço suficiente no spread para posicionar a ordem
        if (spreadSize > tickSize && lessAskPrice > bestBid) {
          // Posicionar ordem 1 tick abaixo do melhor ask
          currentLocalMakerPrice = lessAskPrice;
          console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem SELL posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do melhor ask)`);
        } else {
          // Spread muito estreito, usar o ask atual como base
          currentLocalMakerPrice = bestAsk;
          console.log(`[LIMIT_ENTRY] Spread muito estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem SELL no melhor ask: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
        }
        
        // Verificação final para garantir que a ordem será MAKER
        if (currentLocalMakerPrice <= bestBid + tickSize) {
          currentLocalMakerPrice = bestBid + tickSize;
          console.log(`[LIMIT_ENTRY] Ajuste: preço SELL ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do bid)`);
        }
      }

      // Garantir que o preço esteja no tick correto
      currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice, numericAccountId);

      // Adicionar log para depuração
      console.log(`[LIMIT_ENTRY] Preço MAKER ${binanceSide}: ${currentLocalMakerPrice.toFixed(pricePrecision)} | Book: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}, Spread=${(bestAsk-bestBid).toFixed(pricePrecision)}`);

      let orderPlacedOrEditedThisIteration = false;

      // ✅ GERENCIAMENTO DE ORDENS ATIVAS MELHORADO (baseado na versão dev)
      if (activeOrderId) {
        let currentOrderDataFromExchange;
        try {
          // ALTERADO: Usar WebSocket API para verificar status da ordem
          // NOTE: getOrderStatusViaWebSocket is a placeholder and needs to be implemented
          currentOrderDataFromExchange = await getOrderStatusViaWebSocket(signal.symbol, activeOrderId);
        } catch (e) {
          if (e.errorCode === -2013 || e.errorCode === -2011) {
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} não encontrada/cancelada na corretora (${e.errorCode}). Resetando activeOrderId.`);
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
            // ✅ LÓGICA PARA LIDAR COM ORDENS PARCIALMENTE PREENCHIDAS (como na versão dev)
            const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
            const shouldEditOrder = priceDifference > tickSize;
            
            if (shouldEditOrder) {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida, mas preço mudou significativamente. Cancelando e recriando...`);
              
              try {
                // Cancelar ordem parcial
                // NOTE: cancelOrderByIdViaWebSocket is a placeholder and needs to be implemented
                await cancelOrderByIdViaWebSocket(signal.symbol, activeOrderId);
                console.log(`[LIMIT_ENTRY] Ordem parcial ${activeOrderId} cancelada.`);
                
                // Aguardar um pouco antes de criar nova ordem
                await new Promise(resolve => setTimeout(resolve, 500));
                
                // Resetar para criar nova ordem
                activeOrderId = null;
              } catch (cancelError) {
                console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem parcial ${activeOrderId}:`, cancelError.message);
                // Continuar sem resetar activeOrderId para tentar novamente
              }
            } else {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida, mas preço ainda adequado. Mantendo ordem.`);
            }
          } else if (status === 'NEW') {
            // ✅ VERIFICAR SE PRECISAMOS EDITAR A ORDEM (como na versão dev)
            const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
            const shouldEditOrder = priceDifference > tickSize;
            
            if (shouldEditOrder) {
              console.log(`[LIMIT_ENTRY] Editando ordem ${activeOrderId}: ${orderPriceOnExchange.toFixed(pricePrecision)} → ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
              
              try {
                const remainingQtyToOrder = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                
                // ALTERADO: Usar WebSocket API para editar ordem
                // NOTE: editOrderViaWebSocket is a placeholder and needs to be implemented
                const editResponse = await editOrderViaWebSocket(
                  signal.symbol,
                  activeOrderId, 
                  currentLocalMakerPrice,
                  binanceSide,
                  remainingQtyToOrder
                );
                
                if (editResponse && editResponse.orderId) {
                  // Atualizar ID se a ordem foi recriada
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
                
                // Em caso de erro, cancelar e resetar para criar nova ordem
                try {
                  // NOTE: cancelOrderByIdViaWebSocket is a placeholder and needs to be implemented
                  await cancelOrderByIdViaWebSocket(signal.symbol, activeOrderId);
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
      
      // ✅ CRIAR NOVA ORDEM SE NECESSÁRIO (como na versão dev)
      if (!activeOrderId && totalFilledSize < totalEntrySize) { 
        const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
        if (newOrderQty <= 0) { 
          console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
          break; 
        }
        try {
          console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          
          // ALTERADO: Usar WebSocket API para enviar ordem LIMIT MAKER
          // NOTE: placeLimitMakerOrderViaWebSocket is a placeholder and needs to be implemented
          const orderResponse = await placeLimitMakerOrderViaWebSocket(
            signal.symbol, newOrderQty, binanceSide, currentLocalMakerPrice
          );
          
          if (orderResponse.status === 'REJECTED_POST_ONLY' || 
              (orderResponse.info && orderResponse.info.msg === 'Filter failure: PRICE_FILTER')) {
            console.log(`[LIMIT_ENTRY] Ordem rejeitada (${orderResponse.status || orderResponse.info?.msg}). Ajustando preço...`);
            
            // Ajustar preço e tentar novamente
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
          console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, newOrderError.response?.data || newOrderError.message);
          await new Promise(resolve => setTimeout(resolve, 1000)); 
          continue;
        }
      }
      
      // ✅ AGUARDAR EXECUÇÃO SE ORDEM FOI CRIADA/EDITADA (como na versão dev)
      if (orderPlacedOrEditedThisIteration && activeOrderId) {
        console.log(`[LIMIT_ENTRY] Aguardando execução/status da ordem ${activeOrderId} por ${EDIT_WAIT_TIMEOUT_MS}ms...`);
        
        // ALTERADO: Usar função waitForOrderExecution adaptada para WebSocket API
        const orderWaitResult = await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS);
        
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
      
      await new Promise(resolve => setTimeout(resolve, 200)); // Loop principal de espera
    } 

    // Calcular preço médio final
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
      averageEntryPrice = currentPriceTrigger; 
      console.warn(`[LIMIT_ENTRY] averageEntryPrice não pôde ser calculado a partir de partialFills (total preenchido: ${totalFilledSize}), usando currentPriceTrigger como fallback: ${averageEntryPrice}`);
    }

    // If you need the `entryCompleted` flag for subsequent logic, set it here
    if (totalFilledSize >= totalEntrySize) {
        isEntryComplete = true; // Set the flag after the loop
    }
    // ... (rest of the function remains the same)
    // Removed old `if (orderFilled && Math.abs(totalFilledSize - totalEntrySize) <= 0.000001)` check as the new loop handles `entryCompleted`.

    // INSERIR POSIÇÃO NO BANCO - CORREÇÃO PARA EVITAR DUPLICATAS
    console.log(`[LIMIT_ENTRY] Verificando se posição já existe antes de inserir...`);

    // ✅ VERIFICAR SE JÁ EXISTE POSIÇÃO PARA ESTE SÍMBOLO
    const [existingDbPositions] = await connection.query(
      'SELECT id FROM posicoes WHERE simbolo = ? AND status = ? AND conta_id = ?',
      [signal.symbol, 'OPEN', accountId]
    );

    if (existingDbPositions.length > 0) {
      console.log(`[LIMIT_ENTRY] ✅ Posição já existe no banco para ${signal.symbol} (ID: ${existingDbPositions[0].id}), atualizando dados...`);

      positionId = existingDbPositions[0].id;

      // ATUALIZAR POSIÇÃO EXISTENTE EM VEZ DE CRIAR NOVA
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
      // CRIAR NOVA POSIÇÃO APENAS SE NÃO EXISTIR
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

    // REGISTRAR TODAS AS ORDENS NO BANCO
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
    // Changed condition to use `isEntryComplete` if you decide to use it, or continue with fillRatio.
    if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO) { // Using fillRatio as it's already calculated and seems appropriate
      console.log(`[LIMIT_ENTRY] Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
      slTpRpsCreated = true;

      // EXTRAIR PREÇOS DE TP DO SINAL
      const targetPrices = {
          tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
          tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
          tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
          tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
          tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null)
      };

      // LOG DOS PREÇOS EXTRAÍDOS PARA DIAGNÓSTICO
      console.log(`[LIMIT_ENTRY] Preços de TP extraídos:`, targetPrices);

      // VALIDAR PREÇOS DE TP
      let validTpCount = 0;
      Object.entries(targetPrices).forEach(([key, value]) => {
          if (value && value > 0) {
              validTpCount++;
              console.log(`[LIMIT_ENTRY] ${key.toUpperCase()}: ${value} - VÁLIDO`);
          } else {
              console.log(`[LIMIT_ENTRY] ${key.toUpperCase()}: ${value} - INVÁLIDO OU NÃO DEFINIDO`);
          }
      });

      console.log(`[LIMIT_ENTRY] Total de preços de TP válidos: ${validTpCount}`);

      // Se não houver nenhum preço válido, definir um fallback
      if (validTpCount === 0) {
          console.log(`[LIMIT_ENTRY] Nenhum preço de TP válido encontrado. Usando preços de fallback.`);
          // Para compra: TP 10% acima do preço de entrada
          // Para venda: TP 10% abaixo do preço de entrada
          const direction = binanceSide === 'BUY' ? 1 : -1;
          const percentageIncrease = 0.02; // 2% para cada TP de fallback
          
          targetPrices.tp1 = averageEntryPrice * (1 + (direction * percentageIncrease));
          targetPrices.tp2 = averageEntryPrice * (1 + (direction * percentageIncrease * 2));
          targetPrices.tp3 = averageEntryPrice * (1 + (direction * percentageIncrease * 3));
          targetPrices.tp4 = averageEntryPrice * (1 + (direction * percentageIncrease * 4));
          targetPrices.tp5 = averageEntryPrice * (1 + (direction * percentageIncrease * 5)); // Final TP at 10%

          console.log(`[LIMIT_ENTRY] Preços de TP de fallback criados:`, targetPrices);
      }

      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;

      // MODIFICAÇÃO NO CÓDIGO DE CRIAÇÃO DO STOP LOSS
      // VERIFICAR SE JÁ EXISTE ORDEM SL PARA ESTA POSIÇÃO
      const [existingStopOrders] = await connection.query(
        `SELECT id, id_externo FROM ordens 
         WHERE id_posicao = ? 
         AND tipo_ordem_bot = 'STOP_LOSS' 
         AND status IN ('NEW', 'PARTIALLY_FILLED')
         AND conta_id = ?`,  // Adicionar filtro por conta_id
        [positionId, accountId]
      );

      // CRIAR STOP LOSS APENAS SE NÃO EXISTIR
      if (existingStopOrders.length === 0) {
        if (slPriceVal && slPriceVal > 0) {
          try {
            console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${slPriceVal.toFixed(pricePrecision)}`);

            const stopOrderResult = await newStopOrder(
              numericAccountId,
              signal.symbol,
              totalFilledSize, // A quantidade deve ser explícita para STOP_MARKET se não usar closePosition, mas aqui passamos para o log. Para closePosition=true, a quantidade é nula.
              binanceOppositeSide,
              slPriceVal,
              null,
              true,         // reduceOnly
              true          // MODIFICADO: closePosition = true
            );

            if (stopOrderResult && (stopOrderResult.data?.orderId || stopOrderResult.orderId)) {
              const slOrderId = stopOrderResult.data?.orderId || stopOrderResult.orderId;
              console.log(`[LIMIT_ENTRY] SL criado com ID: ${slOrderId}`);

              // Inserir no banco de dados
              const slOrderData = {
                tipo_ordem: 'STOP_MARKET',
                preco: slPriceVal,
                quantidade: totalFilledSize, // A quantidade aqui deve refletir o total da posição para registro
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(slOrderId).substring(0,90),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'STOP_LOSS',
                target: null,
                reduce_only: true,
                close_position: true, // MODIFICADO: close_position = true
                orign_sig: `WEBHOOK_${signal.id}`,
                last_update: formatDateForMySQL(new Date()),
                conta_id: accountId
              };

              await insertNewOrder(connection, slOrderData);
              console.log(`[LIMIT_ENTRY] Ordem de STOP_LOSS inserida com sucesso`);
            }
          } catch (slError) {
            console.error(`[LIMIT_ENTRY] Erro ao criar SL:`, slError.message);
          }
        } else {
          console.log(`[LIMIT_ENTRY] ⚠️ SL não configurado para esta posição (preço SL não definido)`);
        }
      } else {
        console.log(`[LIMIT_ENTRY] ℹ️ SL já existe para esta posição (ID: ${existingStopOrders[0].id_externo}), não criando novamente`);
      }

      // CÁLCULO CORRETO DAS REDUÇÕES PARCIAIS
      // IMPORTANTE: A quantidade do SL não deve reduzir o disponível para RPs
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10]; // 25%, 30%, 25%, 10%
      const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];
      let cumulativeQtyForRps = 0;
      let availablePositionSize = totalFilledSize; // Rastrear quanto ainda resta da posição

      // NOVA LÓGICA: Verificar ordens RP existentes para não ultrapassar 100%
      const [existingRpOrders] = await connection.query(
        `SELECT SUM(quantidade) as totalRpQty FROM ordens 
         WHERE id_posicao = ? 
         AND tipo_ordem_bot IN ('REDUCAO_PARCIAL', 'TAKE_PROFIT') 
         AND status IN ('NEW', 'PARTIALLY_FILLED')
         AND conta_id = ?`,
        [positionId, accountId]
      );

      const existingRpQuantity = parseFloat(existingRpOrders[0].totalRpQty || 0);
      if (existingRpQuantity > 0) {
        console.log(`[LIMIT_ENTRY] Encontradas ordens RP existentes totalizando ${existingRpQuantity}`);
        availablePositionSize = Math.max(0, availablePositionSize - existingRpQuantity);
        console.log(`[LIMIT_ENTRY] Quantidade disponível ajustada: ${availablePositionSize.toFixed(quantityPrecision)}`);
      }

      // Obter precisão para formatação
      const precision = await getPrecisionCached(signal.symbol, numericAccountId);
      if (!precision) {
        console.error(`[LIMIT_ENTRY] ❌ Erro ao obter precisão para ${signal.symbol}`);
        throw new Error(`Precisão não disponível para ${signal.symbol}`);
      }

      console.log(`[LIMIT_ENTRY] Criando reduções parciais com porcentagens: ${reductionPercentages.map(p => (p*100)+'%').join(', ')}`);
      console.log(`[LIMIT_ENTRY] Tamanho total da posição: ${totalFilledSize.toFixed(quantityPrecision)}, disponível para RPs: ${availablePositionSize.toFixed(quantityPrecision)}, precisão: ${precision.quantityPrecision}`);

      // Criar RPs com porcentagens definidas
      for (let i = 0; i < rpTargetKeys.length && i < reductionPercentages.length; i++) {
        try {
          const rpKey = rpTargetKeys[i];
          const rpPrice = targetPrices[rpKey];
          const reductionPercent = reductionPercentages[i];
          
          // VALIDAR SE PREÇO É VÁLIDO PARA A DIREÇÃO DO TRADE
          if (!rpPrice || rpPrice <= 0) {
            console.log(`[LIMIT_ENTRY] RP${i+1} pulada - preço inválido: ${rpPrice}`);
            continue;
          }
          
          // VALIDAR DIREÇÃO DO PREÇO (BUY deve ter TP > entry, SELL deve ter TP < entry)
          const isPriceValidForDirection = binanceSide === 'BUY' ? 
            rpPrice > averageEntryPrice : 
            rpPrice < averageEntryPrice;
            
          if (!isPriceValidForDirection) {
            console.log(`[LIMIT_ENTRY] RP${i+1} pulada - preço ${rpPrice.toFixed(pricePrecision)} inválido para ${binanceSide} (entry: ${averageEntryPrice.toFixed(pricePrecision)})`);
            continue;
          }
          
          // CALCULAR QUANTIDADE - VERIFICAR SE NÃO EXCEDE O DISPONÍVEL
          let idealReductionQty = totalFilledSize * reductionPercent;
          let reductionQty = Math.min(idealReductionQty, availablePositionSize);
          
          // Arredondar para a precisão correta
          reductionQty = parseFloat(reductionQty.toFixed(precision.quantityPrecision));
          
          console.log(`[LIMIT_ENTRY] Calculando RP${i+1}: ${reductionPercent*100}% de ${totalFilledSize.toFixed(quantityPrecision)} = ${reductionQty.toFixed(quantityPrecision)} (disponível: ${availablePositionSize.toFixed(quantityPrecision)})`);
          
          if (reductionQty <= 0 || reductionQty < precision.minQty) {
            console.log(`[LIMIT_ENTRY] RP${i+1} pulada - quantidade insuficiente: ${reductionQty.toFixed(quantityPrecision)}`);
            continue;
          }
          
          console.log(`[LIMIT_ENTRY] Criando RP${i+1}: ${reductionQty.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(pricePrecision)}`);
          
          const rpResponse = await newReduceOnlyOrder(
            numericAccountId, 
            signal.symbol, 
            reductionQty, 
            binanceOppositeSide, 
            rpPrice
          );
          
          if (rpResponse && (rpResponse.orderId || (rpResponse.data && rpResponse.data.orderId))) {
            const rpOrderId = rpResponse.orderId || rpResponse.data.orderId;
            console.log(`[LIMIT_ENTRY] RP${i+1} criada com sucesso: ${rpOrderId}`);
            
            // Inserir no banco
            const rpOrderData = { 
              tipo_ordem: 'LIMIT', 
              preco: rpPrice, 
              quantidade: reductionQty, 
              id_posicao: positionId, 
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()), 
              id_externo: String(rpOrderId).substring(0,90), 
              side: binanceOppositeSide,
              simbolo: signal.symbol, 
              tipo_ordem_bot: 'REDUCAO_PARCIAL', 
              target: i+1, 
              reduce_only: true, 
              close_position: false, 
              orign_sig: `WEBHOOK_${signal.id}`,
              last_update: formatDateForMySQL(new Date()),
              conta_id: accountId
            };
            
            await insertNewOrder(connection, rpOrderData);
            console.log(`Ordem de REDUCAO_PARCIAL inserida com sucesso: ${rpOrderId}`);
            
            // Atualizar contabilidade
            cumulativeQtyForRps += reductionQty;
            availablePositionSize -= reductionQty; // Reduzir o disponível
          } else {
            console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar RP${i+1}:`, rpResponse);
          }
        } catch (rpError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.message);
          // Continuar para a próxima RP mesmo se esta falhar
        }
      }

      // CRIAR TAKE PROFIT FINAL (TP5) COM QUANTIDADE RESTANTE
      const remainingQtyForFinalTp = availablePositionSize; // Usar o que ainda está disponível
      const finalTpPrice = targetPrices.tp5;

      // Lógica atualizada para o TP final
      if (remainingQtyForFinalTp > precision.minQty && finalTpPrice && finalTpPrice > 0) {
        // VALIDAR DIREÇÃO DO TP FINAL
        const isFinalTpValidForDirection = binanceSide === 'BUY' ?
          finalTpPrice > averageEntryPrice :
          finalTpPrice < averageEntryPrice;
          
        if (!isFinalTpValidForDirection) {
          console.log(`[LIMIT_ENTRY] TP FINAL pulado - preço ${finalTpPrice.toFixed(pricePrecision)} inválido para ${binanceSide} (entry: ${averageEntryPrice.toFixed(pricePrecision)})`);
        } else {
          try {
            // Decidir se usamos closePosition baseado no quanto resta da posição
            // Se a quantidade restante for muito próxima da total (ex: > 95% do totalFillSize)
            // ou se a quantidade restante for superior a 75% da posição total original
            const useClosePosition = (remainingQtyForFinalTp / totalFilledSize) > 0.95 || (remainingQtyForFinalTp / totalEntrySize) > 0.75; 
            
            // Logar a decisão
            console.log(`[LIMIT_ENTRY] Criando TP FINAL: ${remainingQtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${finalTpPrice.toFixed(pricePrecision)} (closePosition: ${useClosePosition})`);
            
            // Se for para usar closePosition, a quantidade deve ser nula no newReduceOnlyOrder
            const quantityToSend = useClosePosition ? null : remainingQtyForFinalTp;

            const tpFinalResponse = await newReduceOnlyOrder(
              numericAccountId,
              signal.symbol,
              quantityToSend, // Quantidade nula se closePosition for true
              binanceOppositeSide,
              finalTpPrice,
              useClosePosition // Novo parâmetro: closePosition
            );
            
            if (tpFinalResponse && (tpFinalResponse.orderId || (tpFinalResponse.data && tpFinalResponse.data.orderId))) {
              const finalTpOrderId = tpFinalResponse.orderId || tpFinalResponse.data.orderId;
              console.log(`[LIMIT_ENTRY] TP FINAL (LIMIT) criado com sucesso: ${finalTpOrderId}`);
              
              const tpOrderData = {
                tipo_ordem: 'LIMIT',
                preco: finalTpPrice,
                quantidade: useClosePosition ? totalFilledSize : remainingQtyForFinalTp, // Para registro no DB, usar o totalFilledSize se for closePosition total
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(finalTpOrderId).substring(0,90),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'TAKE_PROFIT',
                target: 5,
                reduce_only: true,
                close_position: useClosePosition,
                orign_sig: `WEBHOOK_${signal.id}`,
                last_update: formatDateForMySQL(new Date()),
                conta_id: accountId
              };
              
              await insertNewOrder(connection, tpOrderData);
              console.log(`Ordem de TAKE_PROFIT (LIMIT) inserida com sucesso: ${finalTpOrderId}`);
            } else {
              console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar TP FINAL (LIMIT):`, tpFinalResponse);
              throw new Error("Resposta de ordem LIMIT TP inválida."); // Lançar erro para tentar STOP_MARKET
            }
          } catch (tpError) {
            console.error(`[LIMIT_ENTRY] Erro ao criar TP FINAL como LIMIT:`, tpError.message);
            
            // Tentar criar como TAKE_PROFIT_MARKET alternativo
            try {
              console.log(`[LIMIT_ENTRY] Tentando criar TP FINAL alternativo como TAKE_PROFIT_MARKET...`);
              
              // Para TakeProfit Market precisamos ajustar um pouco o preço
              const adjustedTpPrice = binanceSide === 'BUY' ? finalTpPrice * 1.001 : finalTpPrice * 0.999;
              
              // Para STOP_MARKET com closePosition=true, quantity é null
              const altTpResponse = await newStopOrder(
                numericAccountId,
                signal.symbol,
                null, // quantity é null quando closePosition é true
                binanceOppositeSide,
                adjustedTpPrice, // stopPrice (preço de gatilho)
                null, // price (null para MARKET)
                true, // reduceOnly
                true  // closePosition
              );
              
              if (altTpResponse && (altTpResponse.orderId || (altTpResponse.data && altTpResponse.data.orderId))) {
                const altTpOrderId = altTpResponse.orderId || altTpResponse.data.orderId;
                console.log(`[LIMIT_ENTRY] TP FINAL alternativo (STOP_MARKET) criado com sucesso: ${altTpOrderId}`);
                
                const altTpOrderData = {
                  tipo_ordem: 'TAKE_PROFIT_MARKET',
                  preco: adjustedTpPrice,
                  quantidade: remainingQtyForFinalTp, // Para registro no DB, usar a quantidade restante
                  id_posicao: positionId,
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()),
                  id_externo: String(altTpOrderId).substring(0,90),
                  side: binanceOppositeSide,
                  simbolo: signal.symbol,
                  tipo_ordem_bot: 'TAKE_PROFIT',
                  target: 5,
                  reduce_only: true,
                  close_position: true,
                  orign_sig: `WEBHOOK_${signal.id}`,
                  last_update: formatDateForMySQL(new Date()),
                  conta_id: accountId
                };
                
                await insertNewOrder(connection, altTpOrderData);
                console.log(`Ordem de TAKE_PROFIT alternativa inserida com sucesso: ${altTpOrderId}`);
              } else {
                console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar TP FINAL alternativo (STOP_MARKET):`, altTpResponse);
              }
            } catch (altError) {
              console.error(`[LIMIT_ENTRY] Também falhou criar TP FINAL alternativo:`, altError.message);
            }
          }
        }
      } else {
        console.log(`[LIMIT_ENTRY] TP FINAL pulado - quantidade restante: ${remainingQtyForFinalTp.toFixed(quantityPrecision)}, TP5: ${finalTpPrice}, minQty: ${precision.minQty}`);
      }
    } // Fechamento do if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO)

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

    // ✅ GARANTIR VARIÁVEIS NO RECOVERY
    const recoveryAccountId = numericAccountId || accountId || parseInt(accountId) || 1;
    const recoveryQuantityPrecision = quantityPrecision || 3;
    const recoveryPricePrecision = pricePrecision || 2;
    const recoveryBinanceSide = binanceSide || (signal.side === 'COMPRA' ? 'BUY' : 'SELL');

    console.log(`[LIMIT_ENTRY_RECOVERY] Usando recoveryAccountId: ${recoveryAccountId}`);

    if (positionId && totalFilledSize > 0 && averageEntryPrice > 0) {
      console.warn(`[LIMIT_ENTRY_RECOVERY] Tentando SALVAR POSIÇÃO ${positionId}...`);

      try {
        // VERIFICAR SE JÁ EXISTE SL PARA ESTA POSIÇÃO
        const [existingStopOrders] = await connection.query(
          `SELECT id, id_externo FROM ordens
           WHERE id_posicao = ?
           AND tipo_ordem_bot = 'STOP_LOSS'
           AND status IN ('NEW', 'PARTIALLY_FILLED')
           AND conta_id = ?`,
          [positionId, accountId]
        );

        const binanceOppositeSide = recoveryBinanceSide === 'BUY' ? 'SELL' : 'BUY';
        const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;

        // CRIAR SL DE EMERGÊNCIA APENAS SE NÃO EXISTIR
        if (existingStopOrders.length === 0 && slPriceVal && slPriceVal > 0) {
          console.log(`[LIMIT_ENTRY_RECOVERY] Criando SL de emergência: ${totalFilledSize.toFixed(recoveryQuantityPrecision)} @ ${slPriceVal.toFixed(recoveryPricePrecision)}`);

          try {
            const stopOrderResult = await newStopOrder(
              recoveryAccountId,
              signal.symbol,
              null, // quantity é null para closePosition=true
              binanceOppositeSide,
              slPriceVal,
              null,
              true,
              true // closePosition
            );

            if (stopOrderResult && (stopOrderResult.data?.orderId || stopOrderResult.orderId)) {
              const slOrderId = stopOrderResult.data?.orderId || stopOrderResult.orderId;

              // Inserir no banco de dados
              const slOrderData = {
                tipo_ordem: 'STOP_MARKET',
                preco: slPriceVal,
                quantidade: totalFilledSize, // A quantidade aqui deve refletir o total da posição para registro
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(slOrderId).substring(0,90),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'STOP_LOSS',
                target: null,
                reduce_only: true,
                close_position: true, // close_position = true
                orign_sig: `WEBHOOK_${signal.id}_RECOVERY`,
                last_update: formatDateForMySQL(new Date())
              };

              await insertNewOrder(connection, slOrderData);
              console.log(`[LIMIT_ENTRY_RECOVERY] SL de emergência criado com ID: ${slOrderId}`);
            }
          } catch (slError) {
            console.error(`[LIMIT_ENTRY_RECOVERY] Erro ao criar SL de emergência:`, slError.message);
          }
        } else if (existingStopOrders.length > 0) {
          console.log(`[LIMIT_ENTRY_RECOVERY] SL já existe (ID: ${existingStopOrders[0].id_externo}), não criando novamente`);
        }

        // CRIAR TP DE EMERGÊNCIA SE DISPONÍVEL
        const finalTpPriceVal = signal.tp_price ? parseFloat(signal.tp_price) : (signal.tp5_price ? parseFloat(signal.tp5_price) : null);
        if (finalTpPriceVal && finalTpPriceVal > 0) {
          console.log(`[LIMIT_ENTRY_RECOVERY] Criando TP de emergência: ${totalFilledSize.toFixed(recoveryQuantityPrecision)} @ ${finalTpPriceVal.toFixed(recoveryPricePrecision)}`);

          try {
            const tpResponse = await newStopOrder(
              recoveryAccountId,
              signal.symbol,
              null, // quantity é null para closePosition=true
              binanceOppositeSide,
              finalTpPriceVal,
              null, // price param null for STOP_MARKET
              true,
              true // closePosition
            );

            if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
              console.log(`[LIMIT_ENTRY_RECOVERY] ✅ TP de emergência criado: ${tpResponse.data.orderId}`);

              const tpOrderData = {
                tipo_ordem: 'TAKE_PROFIT_MARKET',
                preco: finalTpPriceVal,
                quantidade: totalFilledSize, // A quantidade aqui deve refletir o total da posição para registro
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(tpResponse.data.orderId),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'TAKE_PROFIT',
                target: null,
                reduce_only: true,
                close_position: true, // close_position = true
                last_update: formatDateForMySQL(new Date()),
                orign_sig: `WEBHOOK_${signal.id}_RECOVERY`
              };

              // ✅ VERIFICAR SE CONNECTION EXISTE ANTES DE USAR
              if (connection) {
                await insertNewOrder(connection, tpOrderData);
              }
            }
          } catch (tpError) {
            console.error(`[LIMIT_ENTRY_RECOVERY] Erro ao criar TP de emergência:`, tpError.message);
          }
        }

        // ✅ VERIFICAR SE CONNECTION EXISTE ANTES DE COMMIT
        if (connection) {
          await connection.commit();
        }
        console.warn(`[LIMIT_ENTRY_RECOVERY] ✅ Posição ${positionId} SALVA com SL/TP de emergência. Erro original: ${originalErrorMessage}`);

        return {
          success: true,
          positionId,
          averagePrice: averageEntryPrice,
          filledQuantity: totalFilledSize,
          warning: `Erro durante entrada: ${originalErrorMessage}. Posição salva com SL/TP de emergência.`
        };

      } catch (recoveryError) {
        console.error(`[LIMIT_ENTRY_RECOVERY] ❌ ERRO na recuperação:`, recoveryError.message);
      }
    }

    // CANCELAR ORDEM ATIVA SE EXISTIR
    if (activeOrderId) {
      try {
        console.log(`[LIMIT_ENTRY] Cancelando ordem ativa ${activeOrderId}...`);
        await cancelOrder(recoveryAccountId, signal.symbol, activeOrderId);
        console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} cancelada`);
      } catch (cancelError) {
        console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem ${activeOrderId}:`, cancelError.message);
      }
    }
    // Adicione esta linha:
  } finally {
    // BLOCO FINALLY (sem mudanças)
    if (depthWs) {
      console.log(`[LIMIT_ENTRY] Fechando WebSocket de profundidade para ${signal?.symbol || 'unknown'} no bloco finally.`);
      try {
        depthWs.close();
      } catch (wsCloseError) {
        console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket:`, wsCloseError.message);
      }
    }
    if (connection) {
      connection.release();
    }
  }
}


// FUNÇÃO AUXILIAR PARA OBTER SALDO DISPONÍVEL
async function getAvailableBalance(accountId) {
    try {
        console.log(`[LIMIT_ENTRY] Obtendo saldo disponível para conta ${accountId}...`);

        if (!accountId || typeof accountId !== 'number') {
            throw new Error(`AccountId inválido: ${accountId}`);
        }

        const api = require('../api');
        const balanceDetails = await api.getFuturesAccountBalanceDetails(accountId);

        if (!balanceDetails || !balanceDetails.assets) {
            console.log(`[LIMIT_ENTRY] ⚠️ Resposta de saldo inválida, usando valor padrão`);
            return 1000;
        }

        const usdtAsset = balanceDetails.assets.find(asset => asset.asset === 'USDT');

        if (!usdtAsset) {
            console.log(`[LIMIT_ENTRY] ⚠️ Asset USDT não encontrado, usando valor padrão`);
            return 1000;
        }

        const availableBalance = parseFloat(usdtAsset.availableBalance);
        console.log(`[LIMIT_ENTRY] ✅ Saldo disponível: ${availableBalance} USDT`);

        return availableBalance;
    } catch (error) {
        console.error(`[LIMIT_ENTRY] Erro ao obter saldo para conta ${accountId}:`, error.message);
        console.log(`[LIMIT_ENTRY] ⚠️ Usando valor padrão devido ao erro`);
        return 1000;
    }
}


// FUNÇÃO AUXILIAR PARA CALCULAR TAMANHO DA ORDEM
function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, stepSize, quantityPrecision) {
    const capital = availableBalance * capitalPercentage;
    const rawSize = (capital * leverage) / entryPrice;

    if (stepSize <= 0) {
        console.warn(`[MONITOR] StepSize inválido (${stepSize}), usando precisão para cálculo.`);
        const multiplier = Math.pow(10, quantityPrecision);
        const truncatedSize = Math.floor(rawSize * multiplier) / multiplier;
        return parseFloat(truncatedSize.toFixed(quantityPrecision));
    }

    // ✅ CORREÇÃO FINAL: Usar math mais preciso para evitar problemas de ponto flutuante
    const stepMultiplier = 1 / stepSize;
    const stepsRaw = rawSize * stepMultiplier;
    const stepsFloor = Math.floor(stepsRaw);
    const truncatedSize = stepsFloor / stepMultiplier;

    // ✅ GARANTIR que o resultado seja formatado com a precisão correta
    const formattedSize = parseFloat(truncatedSize.toFixed(quantityPrecision));

    console.log(`[MONITOR] Cálculo: capital=${capital.toFixed(2)}, rawSize=${rawSize}, stepSize=${stepSize}, steps=${stepsFloor}, formatado=${formattedSize}`);

    return formattedSize;
}

// FUNÇÃO AUXILIAR PARA CALCULAR PREÇO MÉDIO
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

// ✅ SUBSTITUIR A FUNÇÃO waitForOrderExecution POR ESTA VERSÃO MELHORADA
/**
 * Aguarda execução de ordem usando WebSocket + REST API como fallback
 * Baseado na versão dev mais robusta
 */
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000) {
  const startTime = Date.now();
  
  try {
    // Primeira verificação imediata via WebSocket
    if (sentOrders.has(orderId)) {
      const orderInfo = sentOrders.get(orderId);
      if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
        console.log(`[WAIT_ORDER] Ordem ${orderId} já confirmada via WebSocket: ${orderInfo.status}`);
        return {
          status: orderInfo.status,
          executedQty: orderInfo.executedQty,
          avgPrice: orderInfo.avgPrice || orderInfo.price
        };
      }
    }
    
    // Se não foi confirmada, tentar via REST API, mas com tratamento de erro melhor
    try {
      // NOTE: `accountId` needs to be passed to this helper function if it's used within `executeLimitMakerEntry`
      // or if `api.getOrderStatus` requires it and it's not globally available.
      // For now, assuming it's accessible through closure or passed from parent.
      const orderStatus = await api.getOrderStatus(symbol, orderId, accountId); 
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
      // Se a ordem não existe via REST, mas foi criada, é possível que seja um atraso
      // Não tratar como erro fatal, continuar aguardando WebSocket
      console.log(`[WAIT_ORDER] Erro REST (pode ser apenas atraso): ${error.message}`);
    }
    
    // Aguardar até o timeout, verificando se o WebSocket atualiza
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, 100));
      
      if (sentOrders.has(orderId)) {
        const orderInfo = sentOrders.get(orderId);
        if (orderInfo.status === 'FILLED' || orderInfo.status === 'PARTIALLY_FILLED') {
          console.log(`[WAIT_ORDER] Ordem ${orderId} confirmada via WebSocket durante espera: ${orderInfo.status}`);
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
      return await api.getOrderStatus(symbol, orderId, accountId); // `accountId` again needs to be accessible
    } catch (error) {
      console.log(`[WAIT_ORDER] Erro final ao verificar ordem ${orderId}: ${error.message}`);
      return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
  } catch (error) {
    console.error(`[WAIT_ORDER] Erro crítico em waitForOrderExecution:`, error);
    return { status: 'ERROR', executedQty: '0', avgPrice: '0' };
  }
}

module.exports = {
    executeLimitMakerEntry
};