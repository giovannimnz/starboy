const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../../../core/database/conexao');
const websockets = require('../api/websocket');
const rest = require('../api/rest');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const {  getRecentOrders, editOrder, roundPriceToTickSize, newMarketOrder, newLimitMakerOrder, newReduceOnlyOrder, cancelOrder, newStopOrder, getOpenOrders, getOrderStatus, getAllOpenPositions, getFuturesAccountBalanceDetails, getPrecision, getTickSize, getPrecisionCached, validateQuantity, adjustQuantityToRequirements,} = require('../api/rest');
const { sendTelegramMessage, formatEntryMessage, formatErrorMessage, formatAlertMessage, formatEntryMessageWithPrecision } = require('../services/telegramHelper');

// ✅ CORREÇÃO: Declarar sentOrders no escopo correto e com Map melhorado
// ✅ OTIMIZAÇÃO: Edição de ordens implementada para maior agilidade
//    - Edita ordem quando possível em vez de cancelar+recriar
//    - Economia de ~200-500ms por atualização de preço
//    - Fallback automático para cancelar+recriar se edição falhar
//    - Critério inteligente evita micro-edições desnecessárias
async function executeReverse(signal, currentPrice, accountId) {
  console.log(`[LIMIT_ENTRY] 🚀 Executando entrada para sinal ${signal.id}: ${signal.symbol} ${signal.side} a ${signal.entry_price} (conta ${accountId})`);

  // ✅ VARIÁVEIS DE CONTROLE PARA EVITAR DUPLICAÇÃO
  let slTpRpsAlreadyCreated = false;
  let entryProcessingComplete = false;
  
  // ✅ SISTEMA DE RASTREAMENTO MELHORADO - DECLARADO CORRETAMENTE
  const sentOrders = new Map(); // DEVE estar aqui, não no escopo global
  const orderLocks = new Map(); // ✅ NOVO: Para evitar race conditions
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
    
    // ✅ NOVO: Validação de timestamp para evitar execuções antigas
    const executionTime = order.T || Date.now();
    if (executionTime < executionStartTime) {
      console.warn(`[ORDER_WS] Ignorando execução antiga: ${new Date(executionTime)} < ${new Date(executionStartTime)}`);
      return;
    }
    
    // ✅ NOVO: Validação de timestamp futuro (erro de clock)
    if (executionTime > Date.now() + 60000) {
      console.warn(`[ORDER_WS] Ignorando execução no futuro: ${new Date(executionTime)}`);
      return;
    }
    
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
        executionTime: executionTime, // ✅ MELHORADO: usar timestamp da execução
        fills: [],
        commission: parseFloat(order.n || '0'),
        commissionAsset: order.N || null,
        realizedPnl: parseFloat(order.rp || '0'),
        clientOrderId: order.c || null
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
      orderInfo.executionTime = executionTime; // ✅ MELHORADO: atualizar timestamp
      orderInfo.commission = parseFloat(order.n || '0');
      orderInfo.commissionAsset = order.N || null;
      orderInfo.realizedPnl = parseFloat(order.rp || '0');
      
      // SE FOI UMA EXECUÇÃO (TRADE), ADICIONAR AO HISTÓRICO DE FILLS
      if (executionType === 'TRADE') {
        const fillQty = parseFloat(order.l || '0');
        const fillPrice = parseFloat(order.L || '0');
        const fillCommission = parseFloat(order.n || '0');
        const fillTime = executionTime;
        const tradeId = order.t || null;
        
        if (fillQty > 0) {
          // ✅ NOVO: Verificar se este fill já existe (evitar duplicação)
          const fillExists = orderInfo.fills.some(fill => 
            fill.tradeId === tradeId || 
            (Math.abs(fill.qty - fillQty) < 0.00000001 && Math.abs(fill.price - fillPrice) < 0.00000001 && Math.abs(fill.time - fillTime) < 1000)
          );
          
          if (!fillExists) {
            orderInfo.fills.push({
              qty: fillQty,
              price: fillPrice,
              commission: fillCommission,
              time: fillTime,
              tradeId: tradeId,
              realizedPnl: parseFloat(order.rp || '0')
            });
            
            console.log(`[ORDER_WS] Fill recebido para ${orderId}: ${fillQty} @ ${fillPrice} (Trade ID: ${tradeId})`);
            
            // ✅ NOVO: Validar continuidade dos fills
            const totalFilled = orderInfo.fills.reduce((sum, fill) => sum + fill.qty, 0);
            if (Math.abs(totalFilled - orderInfo.executedQty) > 0.00000001) {
              console.warn(`[ORDER_WS] ⚠️ Inconsistência nos fills para ${orderId}: ${totalFilled} vs ${orderInfo.executedQty}`);
            }
          } else {
            console.log(`[ORDER_WS] Fill duplicado ignorado para ${orderId}: ${fillQty} @ ${fillPrice}`);
          }
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

  // ✅ NOVO: ID único para o listener temporário desta execução
  const temporaryListenerId = `reverse-entry-${signal.id}`;

  try {
    // ✅ REGISTRAR HANDLER TEMPORÁRIO NO NOVO SISTEMA PUB/SUB
    websockets.on('orderUpdate', orderUpdateHandler, accountId, temporaryListenerId);
    console.log(`[LIMIT_ENTRY] ✅ Handler de WebSocket temporário registrado com ID: ${temporaryListenerId}`);

    // ✅ CONSTANTES CORRIGIDAS PARA MAIS EFICIÊNCIA
    const MAX_CHASE_ATTEMPTS = 500000; // Reduzido de 100
    const CHASE_TIMEOUT_MS = 300000; // 5 minutos para WebSocket-only
    const WAIT_FOR_ORDER_CONFIRMATION_MS = 10000; // Reduzido de 15s
    const EDIT_WAIT_TIMEOUT_MS = 20000; // Reduzido de 3s
    const MAX_DEPTH_STALENESS_MS = 15000; // ✅ AUMENTADO: 15 segundos para maior tolerância
    const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.95; // 95% em vez de 98%
    const MIN_PRICE_DIFF_FOR_EDIT = 0.00001; // ✅ NOVO: diferença mínima para justificar edição (evita micro-edições)

    let chaseAttempts = 0;
    let rejectionAttempts = 0; // ✅ NOVO: contador de rejeições
    let totalEntrySize = 0;
    let executionStartTime = Date.now();
    let partialFills = [];
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];
    const MAX_REJECTION_ATTEMPTS = 5; // ✅ NOVO: limite de rejeições

    // VALIDAÇÃO INICIAL (mantida)
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em executeReverse: ${accountId} (tipo: ${typeof accountId})`);
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
      currentPriceTrigger = await rest.getPrice(signal.symbol, numericAccountId);
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

    // ✅ CONFIGURAR WEBSOCKET DE PROFUNDIDADE - VERSÃO APENAS WEBSOCKET
    console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
    let wsReconnectionCount = 0;
    let lastSuccessfulDepthUpdate = Date.now();
    
    depthWs = websockets.bookTicker(signal.symbol, (depthData, receivedAccountId) => {
      // CORREÇÃO: Validar accountId se fornecido
      if (receivedAccountId && receivedAccountId !== accountId) {
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados recebidos para conta diferente: esperado ${accountId}, recebido ${receivedAccountId}`);
        return;
      }

      if (depthData && depthData.bestBid && depthData.bestAsk) {
        const bid = parseFloat(depthData.bestBid);
        const ask = parseFloat(depthData.bestAsk);

        // ✅ VALIDAÇÕES MELHORADAS 
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
        lastSuccessfulDepthUpdate = Date.now(); // ✅ NOVO: Rastrear última atualização bem-sucedida
        wsUpdateErrorCount = 0;
        
        // DEBUG: Log apenas a cada 20 atualizações para não poluir
        if (Math.random() < 0.05) { // 5% de chance = ~1 a cada 20 mensagens
          //console.log(`[LIMIT_ENTRY_DEPTH_WS] ${signal.symbol}: Bid=${bid.toFixed(pricePrecision)}, Ask=${ask.toFixed(pricePrecision)}, Spread=${spread.toFixed(pricePrecision)}`);
        }
      } else {
        wsUpdateErrorCount++;
        console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos para ${signal.symbol}:`, depthData);
      }
    }, accountId);

    // ✅ AGUARDAR DADOS DO WEBSOCKET - VERSÃO APENAS WEBSOCKET
    const MAX_RETRY_ATTEMPTS = 50; // Aumentado para dar mais tempo ao WebSocket
    const RETRY_INTERVAL_MS = 200; // Reduzido para verificações mais frequentes
    let wsRetryCount = 0;
    let hasValidBookData = false;

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
      //console.log(`[LIMIT_ENTRY] Aguardando WebSocket... tentativa ${wsRetryCount}/${MAX_RETRY_ATTEMPTS}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
    }

    // ✅ FALHA SE WEBSOCKET NÃO FUNCIONAR - SEM FALLBACK
    if (!hasValidBookData) {
      throw new Error(`WebSocket BookTicker falhou após ${MAX_RETRY_ATTEMPTS} tentativas. Dados inválidos para ${signal.symbol}. Última atualização: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
    }

    // OBTER TICK SIZE
    const tickSizeData = await getTickSize(signal.symbol, numericAccountId);
    const tickSize = parseFloat(tickSizeData.tickSize) || 0.01;

    console.log(`[LIMIT_ENTRY] ✅ Dados WebSocket prontos. Iniciando loop de chasing...`);
    console.log(`[LIMIT_ENTRY] Configuração: tickSize=${tickSize}, totalEntrySize=${totalEntrySize.toFixed(quantityPrecision)}`);

    // ===== LOOP PRINCIPAL DE PERSEGUIÇÃO DE PREÇO =====
    while (totalFilledSize < totalEntrySize && 
          chaseAttempts < MAX_CHASE_ATTEMPTS && 
          (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
      
      chaseAttempts++;

      // ✅ SINCRONIZAR PREENCHIMENTOS VIA WEBSOCKET E API - VERSÃO MELHORADA
      try {
        // ✅ NOVO: Detecção de ordens fantasma (não rastreadas)
        await detectGhostOrders(signal.symbol, executionStartTime, numericAccountId, sentOrders);
        
        // PRIMEIRO: Verificar ordens via WebSocket local
        let localFilledCount = 0;
        for (const [orderId, orderInfo] of sentOrders.entries()) {
          if ((orderInfo.status === 'FILLED') &&
              orderInfo.side === binanceSide &&
              orderInfo.executedQty > 0 &&
              !partialFills.some(fill => fill.orderId === orderId)) {
            
            // ✅ NOVO: Validar timestamp da execução
            if (orderInfo.executionTime >= executionStartTime) {
              partialFills.push({
                qty: orderInfo.executedQty,
                price: orderInfo.avgPrice,
                orderId: orderId,
                timestamp: orderInfo.executionTime,
                validationSource: 'websocket'
              });
              localFilledCount++;
            } else {
              console.warn(`[LIMIT_ENTRY] Ignorando fill antigo: ${orderId} (${new Date(orderInfo.executionTime)})`);
            }
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
          partialFills.push({ 
            qty, 
            price, 
            orderId: String(exOrder.orderId),
            timestamp: exOrder.updateTime,
            validationSource: 'rest_api'
          });
          apiFilledCount++;
        }
        
        if (apiFilledCount > 0) {
          totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
          console.log(`[LIMIT_ENTRY] ${apiFilledCount} ordens sincronizadas via rest. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
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

      // ✅ VERIFICAÇÃO DE DADOS DO BOOK - VERSÃO MELHORADA COM DETECÇÃO DE DESCONEXÃO
      const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
      const isWebSocketStale = (Date.now() - lastSuccessfulDepthUpdate > 30000); // 30 segundos sem dados válidos
      
      if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
        const staleReason = !currentBestBid || !currentBestAsk ? "ausentes" : (isDepthDataStale ? "velhos" : `erros WS (${wsUpdateErrorCount})`);
        console.log(`[LIMIT_ENTRY] Dados do BookTicker (WebSocket) para ${signal.symbol} ${staleReason}. Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Última atualização WS: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
        
        // ✅ NOVO: Se WebSocket estiver desconectado há muito tempo, tentar ressincronizar
        if (isWebSocketStale && chaseAttempts % 10 === 0) { // A cada 10 tentativas
          console.warn(`[LIMIT_ENTRY] ⚠️ WebSocket possivelmente desconectado. Tentando ressincronização...`);
          await resyncAfterReconnection(signal.symbol, executionStartTime, numericAccountId, sentOrders);
          wsReconnectionCount++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const bestBid = currentBestBid;
      const bestAsk = currentBestAsk;
      const spread = bestAsk - bestBid;

      // ✅ LÓGICA DE CÁLCULO DE PREÇO MELHORADA - MANTIDA
      let currentLocalMakerPrice;
      if (binanceSide === 'BUY') {
        // Sempre tenta entrar 1 tick acima do bestBid, mas nunca >= bestAsk
        let candidatePrice = bestBid + tickSize;
        if (candidatePrice < bestAsk) {
          currentLocalMakerPrice = candidatePrice;
          console.log(`[LIMIT_ENTRY] BUY agressivo: dentro do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do bid)`);
        } else {
          // Se não couber no spread, coloca no melhor bid possível (garante maker)
          currentLocalMakerPrice = bestAsk - tickSize;
          if (currentLocalMakerPrice <= bestBid) {
            currentLocalMakerPrice = bestBid;
            console.log(`[LIMIT_ENTRY] BUY: spread apertado, colocando no bestBid: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          } else {
            console.log(`[LIMIT_ENTRY] BUY: spread apertado, ajustando para 1 tick abaixo do ask: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          }
        }
      } else { // SELL
        // Sempre tenta entrar 1 tick abaixo do bestAsk, mas nunca <= bestBid
        let candidatePrice = bestAsk - tickSize;
        if (candidatePrice > bestBid) {
          currentLocalMakerPrice = candidatePrice;
          console.log(`[LIMIT_ENTRY] SELL agressivo: dentro do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do ask)`);
        } else {
          // Se não couber no spread, coloca no melhor ask possível (garante maker)
          currentLocalMakerPrice = bestBid + tickSize;
          if (currentLocalMakerPrice >= bestAsk) {
            currentLocalMakerPrice = bestAsk;
            console.log(`[LIMIT_ENTRY] SELL: spread apertado, colocando no bestAsk: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          } else {
            console.log(`[LIMIT_ENTRY] SELL: spread apertado, ajustando para 1 tick acima do bid: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
          }
        }
      }

      // Garantir que o preço esteja no tick correto
      currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice, numericAccountId);

      console.log(`[LIMIT_ENTRY] Preço MAKER ${binanceSide}: ${currentLocalMakerPrice.toFixed(pricePrecision)} | Book: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}, Spread=${(bestAsk-bestBid).toFixed(pricePrecision)}`);

      let orderPlacedOrEditedThisIteration = false;

      // ✅ GERENCIAMENTO DE ORDENS ATIVAS - VERSÃO ROBUSTA COM VERIFICAÇÃO DE STATUS
      if (activeOrderId) {
        // ✅ PRIMEIRO: VERIFICAR SE A ORDEM AINDA EXISTE NA CORRETORA
        let currentOrderStatus = null;
        try {
          const orderStatusResponse = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
          currentOrderStatus = orderStatusResponse?.status;
          console.log(`[LIMIT_ENTRY] 🔍 Status atual da ordem ${activeOrderId}: ${currentOrderStatus}`);
        } catch (statusError) {
          if (statusError.message && (statusError.message.includes('Order does not exist') || statusError.message.includes('Unknown order'))) {
            console.log(`[LIMIT_ENTRY] ❌ Ordem ${activeOrderId} não existe mais na corretora. Resetando activeOrderId.`);
            sentOrders.delete(activeOrderId);
            activeOrderId = null;
            currentOrderStatus = 'NOT_FOUND';
          } else {
            console.error(`[LIMIT_ENTRY] Erro ao verificar status da ordem ${activeOrderId}:`, statusError.message);
            // Continuar com dados do WebSocket como fallback
          }
        }

        // ✅ SE A ORDEM FOI CANCELADA OU NÃO EXISTE, RESETAR E CONTINUAR
        if (currentOrderStatus === 'CANCELED' || currentOrderStatus === 'NOT_FOUND' || currentOrderStatus === 'EXPIRED') {
          console.log(`[LIMIT_ENTRY] 🗑️ Ordem ${activeOrderId} com status ${currentOrderStatus}. Removendo do controle e criando nova ordem.`);
          sentOrders.delete(activeOrderId);
          activeOrderId = null;
        } else if (activeOrderId) {
          // ✅ USAR DADOS DO WEBSOCKET LOCAL COMBINADO COM STATUS DA API
          const wsOrderData = sentOrders.get(activeOrderId);
          
          if (!wsOrderData) {
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} não encontrada no mapa WebSocket. Resetando activeOrderId.`);
            activeOrderId = null;
          } else {
            const { status: wsStatus, executedQty, avgPrice, price: orderPriceFromWs, quantity } = wsOrderData;
            const wsFilledQty = parseFloat(executedQty || '0');
            const orderPriceOnExchange = parseFloat(orderPriceFromWs || '0');
            
            // ✅ USAR STATUS MAIS CONFIÁVEL (API TEM PRIORIDADE SOBRE WEBSOCKET)
            const effectiveStatus = currentOrderStatus || wsStatus;
          
          // VERIFICAR FILLS AINDA NÃO CONTABILIZADOS
          let alreadyAccountedForThisOrder = 0;
          partialFills.forEach(pf => {
            if (pf.orderId === activeOrderId) alreadyAccountedForThisOrder += pf.qty;
          });
          
          const netFilledSinceLastCheck = wsFilledQty - alreadyAccountedForThisOrder;

          if (netFilledSinceLastCheck > 0) {
            const fillPrice = parseFloat(avgPrice || orderPriceOnExchange);
            partialFills.push({ 
              qty: netFilledSinceLastCheck, 
              price: fillPrice, 
              orderId: activeOrderId,
              timestamp: Date.now() // ADICIONADO DA DEV
            });
            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
            console.log(`[LIMIT_ENTRY] 💰 Preenchimento detectado ${activeOrderId}: ${netFilledSinceLastCheck.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
          }            if (effectiveStatus === 'FILLED') {
              console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} totalmente preenchida.`);
              sentOrders.delete(activeOrderId);
              activeOrderId = null;
              if (totalFilledSize >= totalEntrySize) {
                console.log(`[LIMIT_ENTRY] 🎯 Quantidade total atingida após FILLED.`);
                break;
              }
            } else if (effectiveStatus === 'PARTIALLY_FILLED') {              const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
              const shouldEditOrder = priceDifference >= tickSize || orderPriceOnExchange !== currentLocalMakerPrice;
              
              if (shouldEditOrder) {
                console.log(`[LIMIT_ENTRY] ⚡ Ordem ${activeOrderId} parcialmente preenchida, mas preço mudou significativamente (${priceDifference.toFixed(pricePrecision)} > ${tickSize}). Cancelando e recriando...`);
                
                try {
                  await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                  console.log(`[LIMIT_ENTRY] ✅ Ordem parcial ${activeOrderId} cancelada.`);
                  
                  // REMOVER DO MAPA WEBSOCKET
                  sentOrders.delete(activeOrderId);
                  
                  // AGUARDAR UM POUCO PARA EVITAR CONFLITOS
                  await new Promise(resolve => setTimeout(resolve, 500));
                  activeOrderId = null;
                } catch (cancelError) {
                  console.error(`[LIMIT_ENTRY] ❌ Erro ao cancelar ordem parcial ${activeOrderId}:`, cancelError.message);
                  // Se não conseguir cancelar, resetar mesmo assim para evitar loop
                  sentOrders.delete(activeOrderId);
                  activeOrderId = null;
                }
              } else {
                console.log(`[LIMIT_ENTRY] ⏸️ Ordem ${activeOrderId} parcialmente preenchida, mas preço ainda adequado (diferença: ${priceDifference.toFixed(pricePrecision)}). Mantendo ordem.`);
              }
            } else if (effectiveStatus === 'NEW') {
              const priceDifference = Math.abs(orderPriceOnExchange - currentLocalMakerPrice);
              const shouldEditOrder = priceDifference >= tickSize || orderPriceOnExchange !== currentLocalMakerPrice;
              
              if (shouldEditOrder) {
                console.log(`[LIMIT_ENTRY] ✏️ Editando ordem ${activeOrderId}: ${orderPriceOnExchange.toFixed(pricePrecision)} → ${currentLocalMakerPrice.toFixed(pricePrecision)} (diferença: ${priceDifference.toFixed(pricePrecision)})`);
                
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
                  
                  if (editResponse && (editResponse.orderId || editResponse.data?.orderId)) {
                    const newOrderId = editResponse.orderId || editResponse.data?.orderId;
                    if (String(newOrderId) !== String(activeOrderId)) {
                      console.log(`[LIMIT_ENTRY] 🔄 Ordem recriada: ${activeOrderId} → ${newOrderId}`);
                      
                      // ATUALIZAR sentOrders MAP
                      if (sentOrders.has(activeOrderId)) {
                        const oldOrderInfo = sentOrders.get(activeOrderId);
                        sentOrders.delete(activeOrderId);
                        oldOrderInfo.orderId = String(newOrderId);
                        oldOrderInfo.price = currentLocalMakerPrice;
                        oldOrderInfo.lastUpdateTime = Date.now();
                        sentOrders.set(String(newOrderId), oldOrderInfo);
                      }
                      
                      activeOrderId = String(newOrderId);
                    } else {
                      // ATUALIZAR PREÇO NA ORDEM EXISTENTE
                      if (sentOrders.has(activeOrderId)) {
                        const orderInfo = sentOrders.get(activeOrderId);
                        orderInfo.price = currentLocalMakerPrice;
                        orderInfo.lastUpdateTime = Date.now();
                        sentOrders.set(activeOrderId, orderInfo);
                      }
                    }
                    
                    orderPlacedOrEditedThisIteration = true;
                    console.log(`[LIMIT_ENTRY] ✅ Ordem editada com sucesso: ${activeOrderId}`);
                  } else {
                    console.warn(`[LIMIT_ENTRY] ⚠️ Resposta inválida ao editar ordem:`, editResponse);
                  }
                } catch (editError) {
                  console.error(`[LIMIT_ENTRY] ❌ Erro ao editar ordem ${activeOrderId}:`, editError.message);
                  
                  // SE FALHOU AO EDITAR, CANCELAR E RECRIAR NA PRÓXIMA ITERAÇÃO
                  try {
                    await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                    sentOrders.delete(activeOrderId);
                    activeOrderId = null;
                    console.log(`[LIMIT_ENTRY] 🗑️ Ordem cancelada após erro de edição.`);
                  } catch (cancelError) {
                    console.error(`[LIMIT_ENTRY] ❌ Erro ao cancelar ordem após falha de edição:`, cancelError.message);
                    // Resetar mesmo com erro para evitar loop infinito
                    sentOrders.delete(activeOrderId);
                    activeOrderId = null;
                  }
                }
              } else {
                console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} já no preço adequado (${orderPriceOnExchange.toFixed(pricePrecision)}). Diferença: ${priceDifference.toFixed(pricePrecision)}`);
              }
            } else {
              console.log(`[LIMIT_ENTRY] ℹ️ Ordem ${activeOrderId} em status: ${effectiveStatus}`);
            }
          }
        }
      }
      
      // ✅ CRIAR NOVA ORDEM - VERSÃO SIMPLIFICADA (sem validação dupla pois sempre será maker)
      if (!activeOrderId && totalFilledSize < totalEntrySize) { 
        const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
        if (newOrderQty <= 0) { 
          console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
          break; 
        }
        
        try {
          console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)} (MAKER GARANTIDO - ${binanceSide === 'BUY' ? 'bestBid-1tick' : 'bestAsk+1tick'})`);
          console.log(`[LIMIT_ENTRY] 📊 Book atual: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}, Spread=${spread.toFixed(pricePrecision)}`);
          
          const orderResponse = await newLimitMakerOrder(
            numericAccountId,
            signal.symbol, 
            newOrderQty, 
            binanceSide, 
            currentLocalMakerPrice
          );
          
          if (orderResponse.status === 'REJECTED_POST_ONLY' || 
              (orderResponse.info && orderResponse.info.msg === 'Filter failure: PRICE_FILTER') ||
              (orderResponse.msg && orderResponse.msg.includes('Post Only order will be rejected'))) {
            
            rejectionAttempts++;
            console.log(`[LIMIT_ENTRY] ⚠️ Ordem rejeitada como maker (${rejectionAttempts}/${MAX_REJECTION_ATTEMPTS}): ${orderResponse.status || orderResponse.info?.msg || orderResponse.msg}`);
            console.log(`[LIMIT_ENTRY] ❌ ERRO CRÍTICO: A lógica MAKER GARANTIDA deveria SEMPRE ser aceita como maker!`);
            console.log(`[LIMIT_ENTRY] 📊 Debug - BestBid: ${bestBid.toFixed(pricePrecision)}, BestAsk: ${bestAsk.toFixed(pricePrecision)}, Preço enviado: ${currentLocalMakerPrice.toFixed(pricePrecision)}, Side: ${binanceSide}`);
            
            if (rejectionAttempts >= MAX_REJECTION_ATTEMPTS) {
              console.log(`[LIMIT_ENTRY] ❌ Muitas rejeições (${rejectionAttempts}). Algo está errado com a lógica MAKER GARANTIDA para sinal ${signal.id}`);
              throw new Error(`Lógica MAKER GARANTIDA falhando: ${rejectionAttempts} rejeições consecutivas`);
            }
            
            // ✅ SEM FALLBACK - aguardar próxima iteração com dados atualizados
            console.log(`[LIMIT_ENTRY] 🔄 Aguardando próxima iteração com dados frescos do WebSocket...`);
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          
          // ✅ RESETAR contador de rejeições em caso de sucesso
          rejectionAttempts = 0;
          
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
      
      // ✅ DELAY ULTRA REDUZIDO PARA RESPOSTA INSTANTÂNEA  
      await new Promise(resolve => setTimeout(resolve, 50));
    } 

    // ✅ SEÇÃO DE MARKET ORDER FALLBACK - VERSÃO MELHORADA DA DEV
    if (totalFilledSize < totalEntrySize) {
      console.log(`[LIMIT_ENTRY] 📊 Chasing encerrado. Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} (${((totalFilledSize/totalEntrySize)*100).toFixed(1)}%)`);
      console.log(`[LIMIT_ENTRY] 📊 Motivos: Timeout: ${Date.now() - executionStartTime >= CHASE_TIMEOUT_MS}, Tentativas: ${chaseAttempts >= MAX_CHASE_ATTEMPTS}`);
      
      const remainingToFillMarket = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
      
      // SÓ USAR MARKET SE A QUANTIDADE RESTANTE FOR SIGNIFICATIVA
      const minMarketOrderThreshold = totalEntrySize * 0.05; // 5% do total
      
      if (remainingToFillMarket > minMarketOrderThreshold) {
        console.log(`[LIMIT_ENTRY] 🚀 Tentando preencher restante (${remainingToFillMarket.toFixed(quantityPrecision)}) com ordem MARKET...`);
        
        // CANCELAR ORDEM ATIVA ANTES DE MARKET
        if (activeOrderId) {
          try {
            console.log(`[LIMIT_ENTRY] 🗑️ Cancelando ordem ativa ${activeOrderId} antes da MARKET...`);
            await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
            await new Promise(resolve => setTimeout(resolve, 1000)); // Aguardar 1 segundo
            activeOrderId = null;
            console.log(`[LIMIT_ENTRY] ✅ Ordem ativa cancelada com sucesso.`);
          } catch (cancelError) {
            console.error(`[LIMIT_ENTRY] ❌ Erro ao cancelar ordem ativa antes da MARKET:`, cancelError.message);
          }
        }
        
        try {
          // VALIDAR QUANTIDADE PARA MARKET
          const marketValidation = await validateQuantity(signal.symbol, remainingToFillMarket, currentPriceTrigger, numericAccountId, 'MARKET');
          
          let finalMarketQty = remainingToFillMarket;
          if (!marketValidation.isValid) {
            console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade MARKET inválida: ${marketValidation.reason}`);
            
            const marketAdjustment = await adjustQuantityToRequirements(signal.symbol, remainingToFillMarket, currentPriceTrigger, numericAccountId, 'MARKET');
            
            if (marketAdjustment.success) {
              finalMarketQty = marketAdjustment.adjustedQuantity;
              console.log(`[LIMIT_ENTRY] ✅ Quantidade MARKET ajustada: ${remainingToFillMarket} → ${finalMarketQty}`);
            } else {
              console.error(`[LIMIT_ENTRY] ❌ Impossível ajustar quantidade MARKET: ${marketAdjustment.error}`);
              throw new Error(`Quantidade MARKET inválida: ${marketAdjustment.error}`);
            }
          }
          
          console.log(`[LIMIT_ENTRY] 🚀 Enviando ordem MARKET: ${binanceSide} ${finalMarketQty.toFixed(quantityPrecision)} ${signal.symbol}`);
          
          marketOrderResponseForDb = await newMarketOrder(numericAccountId, signal.symbol, finalMarketQty, binanceSide);
          
          if (marketOrderResponseForDb && marketOrderResponseForDb.orderId) {
            console.log(`[LIMIT_ENTRY] ✅ Ordem MARKET criada: ${marketOrderResponseForDb.orderId}`);
            
            // AGUARDAR EXECUÇÃO DA MARKET
            const marketWaitResult = await waitForOrderExecution(signal.symbol, String(marketOrderResponseForDb.orderId), 5000, numericAccountId, sentOrders);
            
            if (marketWaitResult && marketWaitResult.status === 'FILLED') {
              const marketFilledQty = parseFloat(marketWaitResult.executedQty || '0');
              const marketAvgPrice = parseFloat(marketWaitResult.avgPrice || currentPriceTrigger);
              
              if (marketFilledQty > 0) {
                partialFills.push({ 
                  qty: marketFilledQty, 
                  price: marketAvgPrice, 
                  orderId: String(marketOrderResponseForDb.orderId),
                  timestamp: Date.now(),
                  orderType: 'MARKET'
                });
                totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                
                console.log(`[LIMIT_ENTRY] 💰 MARKET executada: ${marketFilledQty.toFixed(quantityPrecision)} @ ${marketAvgPrice.toFixed(pricePrecision)}. Total final: ${totalFilledSize.toFixed(quantityPrecision)}`);
              }
            } else {
              console.warn(`[LIMIT_ENTRY] ⚠️ Ordem MARKET não foi totalmente executada: ${marketWaitResult?.status || 'UNKNOWN'}`);
            }
          } else {
            console.error(`[LIMIT_ENTRY] ❌ Falha ao criar ordem MARKET. Resposta: ${JSON.stringify(marketOrderResponseForDb)}`);
          }
        } catch (marketError) {
          console.error(`[LIMIT_ENTRY] ❌ Erro na ordem MARKET:`, marketError.response?.data || marketError.message);
        }
      } else {
        console.log(`[LIMIT_ENTRY] ⏭️ Quantidade restante (${remainingToFillMarket.toFixed(quantityPrecision)}) muito pequena para MARKET. Prosseguindo...`);
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

    // Só considerar completa se 95% preenchido
    const isEntryReallyComplete = fillRatio >= 0.95;

    if (isEntryReallyComplete) {
        isEntryComplete = true;
    }

    console.log(`[LIMIT_ENTRY] ✅ Entrada executada: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} (${(fillRatio * 100).toFixed(1)}%)`);
    console.log(`[LIMIT_ENTRY] 📡 Aguardando confirmação da posição via webhook para criar SL/TP/RPs...`);

    // ✅ SUBSTITUIR POR LOG APENAS:
    console.log(`[LIMIT_ENTRY] 📊 Ordens de entrada executadas: ${partialFills.length} fills`);
    partialFills.forEach((fill, index) => {
      console.log(`[LIMIT_ENTRY]   Fill ${index + 1}: ${fill.qty.toFixed(quantityPrecision)} @ ${fill.price.toFixed(pricePrecision)} (ID: ${fill.orderId})`);
    });
    console.log(`[LIMIT_ENTRY] 📡 Aguardando confirmação das ordens via webhook para inserir no banco...`);

    // ✅ ATUALIZAR APENAS O STATUS DO SINAL
    await connection.query(
      `UPDATE webhook_signals SET status = 'EXECUTADO' WHERE id = ?`,
      [averageEntryPrice, signal.id]
    );

    // ✅ AGUARDAR UM POUCO PARA O WEBHOOK PROCESSAR AS ORDENS DE ENTRADA
    console.log(`[LIMIT_ENTRY] ⏳ Aguardando ${WAIT_FOR_WEBHOOK_MS}ms para webhook processar ordens de entrada...`);
    await new Promise(resolve => setTimeout(resolve, WAIT_FOR_WEBHOOK_MS));

    // ✅ BUSCAR POSIÇÃO CRIADA PELO WEBHOOK
    let positionId = null;
    let maxRetries = 1000;
    let retries = 0;

    while (!positionId && retries < maxRetries) {
      const [webhookPosition] = await connection.query(
        `SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ? ORDER BY id DESC LIMIT 1`,
        [signal.symbol, accountId]
      );
      
      if (webhookPosition.length > 0) {
        positionId = webhookPosition[0].id;
        console.log(`[LIMIT_ENTRY] ✅ Posição encontrada no banco (criada via webhook): ID ${positionId}`);
        break;
      }
      
      retries++;
      console.log(`[LIMIT_ENTRY] ⏳ Aguardando posição ser criada via webhook... tentativa ${retries}/${maxRetries}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    if (!positionId) {
      console.warn(`⚠️ Posição não encontrada, mas criando ordens de proteção mesmo assim...`);
      // Continuar criando SL/TP/RPs sem aguardar position_id
    }

    // ✅ CRIAR SL/TP/RPS - VERSÃO TOTALMENTE CORRIGIDA DA DEV
    let slTpRpsCreated = false;
    if (isEntryReallyComplete) {
      console.log(`[LIMIT_ENTRY] 🎯 Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
      slTpRpsCreated = true;

      let slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null; // Changed to `let` for potential adjustment
      
      const targetPrices = {
        tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
        tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
        tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
        tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
        tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
      };

      console.log(`[LIMIT_ENTRY] 📋 Preços configurados:`);
      console.log(`  - SL: ${slPriceVal || 'N/A'}`);
      console.log(`  - TP1: ${targetPrices.tp1 || 'N/A'}`);
      console.log(`  - TP2: ${targetPrices.tp2 || 'N/A'}`);
      console.log(`  - TP3: ${targetPrices.tp3 || 'N/A'}`);
      console.log(`  - TP4: ${targetPrices.tp4 || 'N/A'}`);
      console.log(`  - TP5: ${targetPrices.tp5 || 'N/A'}`);

      // ✅ CRIAR STOP LOSS - VERSÃO SEM INSERÇÃO NO BANCO
      if (slPriceVal && slPriceVal > 0) {
        try {
          // ✅ VERIFICAR SE JÁ EXISTE SL ATIVO PARA ESTE SINAL (sem depender de positionId)
          const [existingSl] = await connection.query(`
            SELECT COUNT(*) as count 
            FROM ordens 
            WHERE orign_sig = ? 
              AND tipo_ordem_bot = 'STOP_LOSS' 
              AND conta_id = ?
              AND status IN ('NEW', 'PARTIALLY_FILLED')
          `, [`WEBHOOK_${signal.id}`, accountId]);

          if (existingSl[0]?.count > 0) {
            console.log(`[LIMIT_ENTRY] ⚠️ STOP_LOSS já existe para sinal ${signal.id}. Pulando criação.`);
          } else {
            console.log(`[LIMIT_ENTRY] 🛡️ Enviando SL para corretora: STOP_MARKET ${binanceOppositeSide} @ stopPrice=${slPriceVal} (closePosition=true)`);
            
            // ✅ APENAS ENVIAR PARA CORRETORA - NÃO INSERIR NO BANCO
            const slResponse = await newStopOrder(
              numericAccountId,
              signal.symbol,
              null,
              binanceOppositeSide,
              slPriceVal,
              null,
              false,
              true,
              'STOP_MARKET'
            );
            
            if (slResponse && (slResponse.data?.orderId || slResponse.orderId)) {
              const slOrderId = slResponse.data?.orderId || slResponse.orderId;
              console.log(`[LIMIT_ENTRY] ✅ SL enviado para corretora: ${slOrderId} @ stopPrice=${slPriceVal}`);
              console.log(`[LIMIT_ENTRY] 📡 Aguardando confirmação via webhook para inserir no banco...`);
              
              // ✅ APENAS ATUALIZAR O SIGNAL COM O ORDER_ID
              await connection.query(
                `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`,
                [String(slOrderId), signal.id]
              );
            }
          }
        } catch (slError) {
          console.error(`[LIMIT_ENTRY] ❌ Erro ao enviar SL para corretora:`, slError.response?.data || slError.message);
        }
      } else {
        console.warn(`[LIMIT_ENTRY] ⚠️ Preço de SL inválido ou não fornecido (${slPriceVal}). SL não será criado.`);
      }

      // CRIAR REDUÇÕES PARCIAIS - VERSÃO SEM INSERÇÃO NO BANCO
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10]; // 25%, 30%, 25%, 10%
      let cumulativeQtyForRps = 0;

      console.log(`[LIMIT_ENTRY] 📊 Criando RPs com percentuais: ${reductionPercentages.map(p => (p*100)+'%').join(', ')}`);

      for (let i = 0; i < rpTargetKeys.length; i++) {
        const rpKey = rpTargetKeys[i];
        const rpPrice = targetPrices[rpKey];
        
        if (rpPrice && rpPrice > 0 && i < reductionPercentages.length) {
          // ✅ VERIFICAR SE JÁ EXISTE RP PARA ESTE TARGET ESPECÍFICO
          const [existingRp] = await connection.query(`
            SELECT COUNT(*) as count 
            FROM ordens 
            WHERE orign_sig = ? 
              AND tipo_ordem_bot = 'REDUCAO_PARCIAL' 
              AND target = ?
              AND conta_id = ?
              AND status IN ('NEW', 'PARTIALLY_FILLED')
          `, [`WEBHOOK_${signal.id}`, i + 1, accountId]);

          if (existingRp[0]?.count > 0) {
            console.log(`[LIMIT_ENTRY] ⚠️ RP${i+1} já existe para sinal ${signal.id}. Pulando criação.`);
            continue;
          }

          const rpPercentage = reductionPercentages[i];
          const rawRpQty = totalFilledSize * rpPercentage;
          const rpQty = parseFloat(rawRpQty.toFixed(quantityPrecision));
          
          if (rpQty > 0) {
            try {
              console.log(`[LIMIT_ENTRY] 📊 Enviando RP${i+1} para corretora: ${(rpPercentage*100)}% de ${totalFilledSize.toFixed(quantityPrecision)} = ${rpQty.toFixed(quantityPrecision)}`);
              
              // ✅ APENAS ENVIAR PARA CORRETORA - NÃO INSERIR NO BANCO
              const rpResponse = await newReduceOnlyOrder(
                numericAccountId,
                signal.symbol,
                rpQty,
                binanceOppositeSide,
                rpPrice
              );
              
              if (rpResponse && (rpResponse.data?.orderId || rpResponse.orderId)) {
                const rpOrderId = rpResponse.data?.orderId || rpResponse.orderId;
                console.log(`[LIMIT_ENTRY] ✅ RP${i+1} enviado para corretora: ${rpOrderId} (${(rpPercentage*100)}%)`);
                console.log(`[LIMIT_ENTRY] 📡 Aguardando confirmação via webhook para inserir no banco...`);
              }
            } catch (rpError) {
              console.error(`[LIMIT_ENTRY] ❌ Erro ao enviar RP${i+1} para corretora:`, rpError.response?.data || rpError.message);
            }
          }
        }
      }
      
      // ✅ CRIAR TAKE_PROFIT_MARKET TP5 - VERSÃO SEM INSERÇÃO NO BANCO
      if (targetPrices.tp5 && targetPrices.tp5 > 0) {
        try {
          const [existingTp5] = await connection.query(`
            SELECT COUNT(*) as count 
            FROM ordens 
            WHERE orign_sig = ? 
              AND tipo_ordem_bot = 'TAKE_PROFIT' 
              AND conta_id = ?
              AND status IN ('NEW', 'PARTIALLY_FILLED')
          `, [`WEBHOOK_${signal.id}`, accountId]);

          if (existingTp5[0]?.count > 0) {
            console.log(`[LIMIT_ENTRY] ⚠️ TAKE_PROFIT (TP5) já existe para sinal ${signal.id}. Pulando criação.`);
          } else {
            console.log(`[LIMIT_ENTRY] 🏁 Enviando TAKE_PROFIT_MARKET TP5 para corretora (${targetPrices.tp5})`);

            // ✅ APENAS ENVIAR PARA CORRETORA - NÃO INSERIR NO BANCO
            const tp5Response = await rest.newStopOrder(
              numericAccountId,
              signal.symbol,
              null, // quantity = null para closePosition
              binanceOppositeSide,
              targetPrices.tp5,
              null,
              false, // reduceOnly
              true,  // closePosition
              'TAKE_PROFIT_MARKET'
            );

            if (tp5Response && (tp5Response.data?.orderId || tp5Response.orderId)) {
              const tp5OrderId = tp5Response.data?.orderId || tp5Response.orderId;
              console.log(`[LIMIT_ENTRY] ✅ TAKE_PROFIT_MARKET TP5 enviado para corretora: ${tp5OrderId} @ ${targetPrices.tp5}`);
              console.log(`[LIMIT_ENTRY] 📡 Aguardando confirmação via webhook para inserir no banco...`);
            }
          }
        } catch (tp5Error) {
          console.error(`[LIMIT_ENTRY] ❌ Erro ao enviar TAKE_PROFIT_MARKET TP5 para corretora:`, tp5Error.response?.data || tp5Error.message);
        }
      }
      
      console.log(`[LIMIT_ENTRY] ✅ Processo de criação SL/TP/RPs CONCLUÍDO para sinal ${signal.id}`);
    } else if (slTpRpsAlreadyCreated) {
      console.log(`[LIMIT_ENTRY] ℹ️ SL/TP/RPs já existem para sinal ${signal.id}. Processo ignorado.`);
    } else {
      console.log(`[LIMIT_ENTRY] ℹ️ Entrada não suficientemente completa (${(fillRatio * 100).toFixed(1)}%) para criar SL/TP/RPs para sinal ${signal.id}`);
    }

    // ✅ MARCAR COMO PROCESSAMENTO COMPLETO
    entryProcessingComplete = true;

    await connection.commit();
    console.log(`[LIMIT_ENTRY] ✅ Transação COMMITADA com sucesso para sinal ${signal.id}`);

    // ✅ NOTIFICAÇÃO TELEGRAM DE ENTRADA EXECUTADA
    try {
      const totalValue = totalFilledSize * averageEntryPrice;
      const timestamp = new Date().toLocaleString('pt-BR');
      
      console.log(`[TELEGRAM_DISPATCHER] � ${timestamp} | ARQUIVO: reverse.js | AÇÃO: Disparando mensagem de ENTRADA EXECUTADA`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Dados: Conta=${accountId}, Symbol=${signal.symbol}, Qtd=${totalFilledSize}, Preço=${averageEntryPrice}, Valor=${totalValue.toFixed(2)}`);
      console.log(`[TELEGRAM_DISPATCHER] 🎯 Signal ID: ${signal.id}, Position ID: ${positionId || 'ainda não definido'}`);
      
      const telegramResult = await formatEntryMessageWithPrecision(signal, totalFilledSize, averageEntryPrice, totalValue, accountId);
      
      console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado do envio:`, JSON.stringify(telegramResult, null, 2));
      
      if (telegramResult && telegramResult.success) {
        console.log(`[TELEGRAM_DISPATCHER] ✅ ${timestamp} | reverse.js | Mensagem de entrada enviada com SUCESSO para conta ${accountId}`);
        
        // Salvar messageId se disponível
        let messageId = null;
        if (telegramResult.messageId) {
          messageId = telegramResult.messageId;
          console.log(`[TELEGRAM_DISPATCHER] 📨 Message ID (direto): ${messageId}`);
        } else if (telegramResult.result && telegramResult.result.message_id) {
          messageId = telegramResult.result.message_id;
          console.log(`[TELEGRAM_DISPATCHER] 📨 Message ID (result.message_id): ${messageId}`);
        } else {
          console.warn(`[TELEGRAM_DISPATCHER] ⚠️ Nenhum messageId encontrado na resposta`);
        }
        
        if (messageId) {
          await connection.query(
            `UPDATE webhook_signals SET registry_message_id = ? WHERE id = ?`,
            [messageId, signal.id]
          );
          console.log(`[TELEGRAM_DISPATCHER] 📋 Message ID salvo no banco: ${messageId} para sinal ${signal.id}`);
        }
      } else {
        console.warn(`[TELEGRAM_DISPATCHER] ⚠️ ${timestamp} | reverse.js | FALHA ao enviar mensagem de entrada`);
        console.warn(`[TELEGRAM_DISPATCHER] 🔍 Erro:`, telegramResult?.error || 'Erro desconhecido');
        console.warn(`[TELEGRAM_DISPATCHER] 🔍 Resposta completa:`, telegramResult);
      }
    } catch (telegramError) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | reverse.js | ERRO CRÍTICO ao enviar notificação de entrada:`, telegramError.message);
      console.error(`[TELEGRAM_DISPATCHER] 📋 Stack trace:`, telegramError.stack);
    }

    // Aguarde 3 segundos para garantir que as ordens e posição foram inseridas via WebSocket
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Buscar a posição aberta no banco
    const [positions] = await connection.query(
      `SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ? ORDER BY id DESC LIMIT 1`,
      [signal.symbol, accountId]
    );

    if (positions.length > 0) {
      positionId = positions[0].id;
      // Atualizar o sinal com o id da posição
      await connection.query(
        `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
        [positionId, signal.id]
      );
      console.log(`[LIMIT_ENTRY] 🔗 Sinal ${signal.id} vinculado à posição ${positionId}`);

      // Atualizar ordens SL, RP1-4, TP5 com os campos corretos
      // SL
      await connection.query(
        `UPDATE ordens SET id_posicao = ?, target = NULL, reduce_only = 1, close_position = 1
         WHERE simbolo = ? AND tipo_ordem_bot = 'STOP_LOSS' AND conta_id = ? AND id_posicao IS NULL`,
        [positionId, signal.symbol, accountId]
      );
      // RPs
      for (let i = 1; i <= 4; i++) {
        await connection.query(
          `UPDATE ordens SET id_posicao = ?, target = ?, reduce_only = 1, close_position = 0
           WHERE simbolo = ? AND tipo_ordem_bot = 'REDUCAO_PARCIAL' AND target IS NULL AND conta_id = ?`,
          [positionId, i, signal.symbol, accountId]
        );
      }
      // TP5
      await connection.query(
        `UPDATE ordens SET id_posicao = ?, target = 5, reduce_only = 1, close_position = 1
         WHERE simbolo = ? AND tipo_ordem_bot = 'TAKE_PROFIT' AND conta_id = ? AND id_posicao IS NULL`,
        [positionId, signal.symbol, accountId]
      );
    }
  } catch (error) { // This is the catch block for the main try
    const originalErrorMessage = error.message || String(error);
    console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`, error.stack || error);

    // ✅ NOTIFICAÇÃO TELEGRAM DE ERRO
    try {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: reverse.js | AÇÃO: Disparando mensagem de ERRO`);
      console.log(`[TELEGRAM_DISPATCHER] 📋 Dados: Conta=${accountId}, Signal=${signal.id}, Erro=${originalErrorMessage}`);
      
      const errorMessage = await formatErrorMessage(signal, originalErrorMessage);
      const result = await sendTelegramMessage(accountId, errorMessage);
      
      console.log(`[TELEGRAM_DISPATCHER] � Resultado do envio de erro:`, JSON.stringify(result, null, 2));
      
      if (result && result.success) {
        console.log(`[TELEGRAM_DISPATCHER] ✅ ${timestamp} | reverse.js | Mensagem de erro enviada com SUCESSO via Telegram`);
      } else {
        console.warn(`[TELEGRAM_DISPATCHER] ⚠️ ${timestamp} | reverse.js | FALHA ao enviar mensagem de erro:`, result?.error || 'Erro desconhecido');
      }
    } catch (telegramError) {
      const timestamp = new Date().toLocaleString('pt-BR');
      console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | reverse.js | ERRO CRÍTICO ao enviar notificação de erro:`, telegramError.message);
    }

    // CANCELAR ORDEM ATIVA SE EXISTIR USANDO rest.JS
    if (activeOrderId) {
      try {
        console.log(`[LIMIT_ENTRY] (Catch Principal) Tentando cancelar ordem ativa ${activeOrderId} antes do rollback.`);
        
        // ✅ USAR cancelOrder DO rest.JS
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
      // CORREÇÃO: Usar `connection.query` em vez de `db.query` que poderia não estar definido aqui
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        [String(originalErrorMessage).substring(0, 250), signal.id]
      );
    } catch (updateError) { 
      console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao atualizar status do sinal para ERROR no DB:`, updateError); 
    }

    return { success: false, error: originalErrorMessage };

  } finally {
    // ✅ LIMPEZA FINAL - SEMPRE EXECUTADO
    console.log(`[LIMIT_ENTRY] 🧹 Finalizando execução para sinal ${signal.id}. Iniciando limpeza...`);

    // ✅ REMOVER HANDLER TEMPORÁRIO DO WEBSOCKET USANDO O NOVO SISTEMA
    websockets.off('orderUpdate', temporaryListenerId, accountId);
    console.log(`[LIMIT_ENTRY] ✅ Handler de WebSocket temporário removido.`);

    // Parar o websocket de profundidade
    if (depthWs && typeof depthWs.close === 'function') {
      try {
        depthWs.close(1000, 'Execution completed');
        console.log(`[LIMIT_ENTRY] ✅ WebSocket de profundidade parado com sucesso.`);
      } catch (wsCloseError) {
        console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket de profundidade:`, wsCloseError.message);
      }
    }
    
    // Liberar conexão com o banco de dados
    if (connection) {
      try {
        connection.release();
        console.log(`[LIMIT_ENTRY] Conexão de banco liberada para sinal ${signal?.id || 'unknown'}`);
      } catch (releaseError) {
        console.error(`[LIMIT_ENTRY] Erro ao liberar conexão:`, releaseError.message);
      }
    }
  }

    return { success: true };
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
        } catch (restError) {
          console.log(`[WAIT_ORDER] ⚠️ Erro REST durante espera: ${restError.message}`);
        }
      }
    }
    
    console.warn(`[WAIT_ORDER] ⏰ Tempo limite atingido (${maxWaitMs}ms) para a ordem ${orderId}. Status atual pode ser: FILLED, PARTIALLY_FILLED ou ainda NEW.`);
    return { status: 'PENDING' };
  } catch (error) {
    console.error(`[WAIT_ORDER] ERRO:`, error.message);
    return { status: 'ERROR' };
  }
}

// ✅ NOVA FUNÇÃO: Detectar ordens fantasma (não rastreadas)
async function detectGhostOrders(symbol, executionStartTime, accountId, sentOrdersMap) {
  try {
    const recentOrders = await getRecentOrders(accountId, symbol, 20);
    const activeOrders = recentOrders.filter(order => 
      (order.status === 'NEW' || order.status === 'PARTIALLY_FILLED') &&
      order.updateTime >= executionStartTime
    );
    
    for (const order of activeOrders) {
      const orderId = String(order.orderId);
      if (!sentOrdersMap.has(orderId)) {
        console.warn(`[GHOST_ORDER] ⚠️ Ordem não rastreada encontrada: ${orderId} (${order.status})`);
        
        // Adicionar ao mapa para rastreamento
        sentOrdersMap.set(orderId, {
          orderId: orderId,
          symbol: order.symbol,
          side: order.side,
          price: parseFloat(order.price || '0'),
          quantity: parseFloat(order.origQty || '0'),
          executedQty: parseFloat(order.executedQty || '0'),
          avgPrice: parseFloat(order.avgPrice || order.price || '0'),
          status: order.status,
          type: order.type,
          lastUpdateTime: order.updateTime,
          executionTime: order.updateTime,
          fills: [],
          commission: 0,
          commissionAsset: null,
          realizedPnl: 0,
          clientOrderId: order.clientOrderId || null,
          isGhostOrder: true // Marcar como ordem fantasma
        });
        
        console.log(`[GHOST_ORDER] ✅ Ordem fantasma ${orderId} adicionada ao rastreamento`);
      }
    }
  } catch (error) {
    console.error(`[GHOST_ORDER] Erro na detecção: ${error.message}`);
  }
}

// ✅ NOVA FUNÇÃO: Ressincronizar após reconexão do WebSocket
async function resyncAfterReconnection(symbol, executionStartTime, accountId, sentOrdersMap) {
  console.log(`[RESYNC] Ressincronizando após reconexão do WebSocket...`);
  
  try {
    const recentOrders = await getRecentOrders(accountId, symbol, 30);
    let resyncCount = 0;
    
    for (const order of recentOrders) {
      if (order.updateTime >= executionStartTime) {
        const orderId = String(order.orderId);
        
        if (sentOrdersMap.has(orderId)) {
          const localOrder = sentOrdersMap.get(orderId);
          if (localOrder.lastUpdateTime < order.updateTime) {
            localOrder.status = order.status;
            localOrder.executedQty = parseFloat(order.executedQty || '0');
            localOrder.avgPrice = parseFloat(order.avgPrice || order.price || '0');
            localOrder.lastUpdateTime = order.updateTime;
            localOrder.executionTime = order.updateTime;
            sentOrdersMap.set(orderId, localOrder);
            
            resyncCount++;
            console.log(`[RESYNC] Ordem ${orderId} atualizada: ${order.status} (exec: ${order.executedQty})`);
          }
        }
      }
    }
    
    if (resyncCount > 0) {
      console.log(`[RESYNC] ✅ ${resyncCount} ordens ressincronizadas com sucesso`);
    } else {
      console.log(`[RESYNC] ℹ️ Nenhuma atualização necessária durante ressincronização`);
    }
  } catch (error) {
    console.error(`[RESYNC] Erro na ressincronização: ${error.message}`);
  }
}

// ✅ NOVA FUNÇÃO: Envolve a sincronização de uma ordem em um lock
async function syncOrderWithLock(orderId, symbol, accountId, sentOrdersMap, executionStartTime, partialFills, binanceSide) {
  if (orderLocks.has(orderId)) {
    console.log(`[LOCK] Aguardando lock para ordem ${orderId}...`);
    await orderLocks.get(orderId);
    return null; // Retorna nulo para indicar que já estava sendo processado
  }

  const lockPromise = (async () => {
    try {
      return await syncAndProcessSingleOrder(orderId, symbol, accountId, sentOrdersMap, executionStartTime, partialFills, binanceSide);
    } finally {
      orderLocks.delete(orderId);
      console.log(`[LOCK] Lock liberado para ordem ${orderId}`);
    }
  })();
  
  orderLocks.set(orderId, lockPromise);
  return await lockPromise;
}

// ✅ NOVA FUNÇÃO: Lógica de sincronização segura para uma única ordem
async function syncAndProcessSingleOrder(orderId, symbol, accountId, sentOrdersMap, executionStartTime, partialFills, binanceSide) {
    console.log(`[SYNC_ORDER] Sincronizando ordem ${orderId}...`);
    let filledQty = 0;

    try {
        const orderStatus = await getOrderStatus(symbol, orderId, accountId);

        if (orderStatus && orderStatus.updateTime >= executionStartTime) {
            const localOrder = sentOrdersMap.get(orderId) || {};
            
            // Atualizar mapa local com dados da API (fonte da verdade)
            localOrder.status = orderStatus.status;
            localOrder.executedQty = parseFloat(orderStatus.executedQty || '0');
            localOrder.avgPrice = parseFloat(orderStatus.avgPrice || orderStatus.price || '0');
            localOrder.lastUpdateTime = orderStatus.updateTime;
            sentOrdersMap.set(orderId, { ...localOrder, ...orderStatus });

            if (orderStatus.status === 'FILLED' && orderStatus.side === binanceSide) {
                const alreadyFilled = partialFills.some(f => f.orderId === orderId);
                if (!alreadyFilled) {
                    filledQty = parseFloat(orderStatus.executedQty);
                    if (filledQty > 0) {
                        partialFills.push({
                            qty: filledQty,
                            price: parseFloat(orderStatus.avgPrice),
                            orderId: orderId,
                            timestamp: orderStatus.updateTime,
                            validationSource: 'sync_lock'
                        });
                        console.log(`[SYNC_ORDER] ✅ Ordem ${orderId} confirmada como FILLED. Qtd: ${filledQty}`);
                        return { filled: true, qty: filledQty };
                    }
                }
            }
        }
    } catch (error) {
        console.error(`[SYNC_ORDER] Erro ao sincronizar ordem ${orderId}: ${error.message}`);
    }
    
    return { filled: false, qty: 0 };
}

// FUNÇÕES AUXILIARES (mantidas como estavam)
async function getAvailableBalance(accountId) {
    try {
        console.log(`[LIMIT_ENTRY] Obtendo saldo_base_calculo para conta ${accountId}...`);

        if (!accountId || typeof accountId !== 'number') {
            throw new Error(`AccountId inválido: ${accountId}`);
        }

        // ✅ USAR saldo_base_calculo_futuros DO BANCO
        const db = await getDatabaseInstance(accountId);
        
        const [rows] = await db.query(
            'SELECT saldo_base_calculo_futuros FROM contas WHERE id = ? AND ativa = 1',
            [accountId]
        );

        if (rows.length === 0) {
            throw new Error(`Conta ${accountId} não encontrada ou não está ativa`);
        }

        const saldoBaseCalculoFuturos = parseFloat(rows[0].saldo_base_calculo_futuros || 0);
        
        console.log(`[LIMIT_ENTRY] ✅ saldo obtido: ${saldoBaseCalculoFuturos} USDT`);
        return saldoBaseCalculoFuturos;

    } catch (error) {
        console.error(`[LIMIT_ENTRY] Erro ao obter saldo_base_calculo para conta ${accountId}:`, error.message);
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

    // ✅ ATUALIZAR LOG PARA MOSTRAR QUE ESTÁ USANDO saldo_base_calculo
    console.log(`[MONITOR] Cálculo baseado em saldo_base_calculo:`);
    console.log(`[MONITOR]   - saldo_base_calculo: ${availableBalance.toFixed(2)} USDT`);
    console.log(`[MONITOR]   - formatado: ${formattedSize}`);

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

// ✅ CONSTANTES PARA AGUARDAR WEBHOOK
const WAIT_FOR_WEBHOOK_MS = 3000; // 3 segundos para webhook processar

module.exports = {
    executeReverse
};