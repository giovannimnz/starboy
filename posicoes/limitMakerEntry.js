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

  // ✅ CONTROLE DE ORDENS ENVIADAS
  const sentOrders = new Map(); // Mapa para controlar ordens já enviadas
  let isEntryComplete = false; // Flag para saber se a entrada foi completada

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

  // Variáveis para o WebSocket de profundidade
  let currentBestBid = null;
  let currentBestAsk = null;
  let lastDepthUpdateTimestamp = 0;
  let wsUpdateErrorCount = 0;

  // ✅ HANDLER PARA RECEBER UPDATES DE ORDENS VIA WEBSOCKET
  const orderUpdateHandler = (orderMsg) => {
    if (!orderMsg || !orderMsg.o || !orderMsg.o.i) return;

    const order = orderMsg.o;
    const orderId = String(order.i);
    const executionType = order.x; // NEW, CANCELED, TRADE, etc.
    const orderStatus = order.X; // NEW, FILLED, PARTIALLY_FILLED, etc.

    // Atualizar ordem no mapa se já estiver sendo rastreada
    if (sentOrders.has(orderId)) {
      const orderInfo = sentOrders.get(orderId);
      orderInfo.status = orderStatus;
      orderInfo.executedQty = parseFloat(order.z || '0');
      orderInfo.lastUpdateTime = Date.now();

      if (executionType === 'TRADE' && (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED')) {
        const executedQty = parseFloat(order.l || '0'); // quantidade executada nesta atualização
        const price = parseFloat(order.L || '0'); // preço desta execução

        if (executedQty > 0 && price > 0) {
          // Adicionar ao array de preenchimentos
          partialFills.push({
            qty: executedQty,
            price: price,
            orderId: orderId
          });

          // Recalcular total preenchido
          totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);

          // Recalcular preço médio
          if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
          }

          console.log(`[LIMIT_ENTRY] ✅ WebSocket: Ordem ${orderId} executada: ${executedQty} @ ${price} (Total: ${totalFilledSize}/${totalEntrySize})`);
        }
      }
    }
  };

  try {
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

        if (spreadPercent > 5) { // Spread maior que 5% é suspeito
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Spread muito alto para ${signal.symbol}: ${spreadPercent.toFixed(4)}%`);
          wsUpdateErrorCount++;
          return;
        }

        currentBestBid = bid;
        currentBestAsk = ask;
        lastDepthUpdateTimestamp = Date.now();
        wsUpdateErrorCount = 0;

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

    // ===== FLUXO OTIMIZADO DE ENTRADA - APENAS UMA ORDEM POR VEZ =====
    console.log(`[LIMIT_ENTRY] 🔄 Iniciando fluxo de entrada com UMA ÚNICA ORDEM - Quantidade: ${totalEntrySize.toFixed(quantityPrecision)}`);

    let entryCompleted = false;
    activeOrderId = null;
    let entryAttemptCount = 0;
    const MAX_ENTRY_ATTEMPTS = 5; // Máximo de tentativas sequenciais, não simultâneas
    executionStartTime = Date.now();

    // Aguardar conexão do WebSocket para order updates
    console.log(`[LIMIT_ENTRY] Aguardando WebSocket de ordens estar pronto...`);
    await new Promise(resolve => setTimeout(resolve, 2000));

    while (!entryCompleted && entryAttemptCount < MAX_ENTRY_ATTEMPTS) {
      entryAttemptCount++;
      console.log(`[LIMIT_ENTRY] 🔄 Tentativa ${entryAttemptCount}/${MAX_ENTRY_ATTEMPTS} - Quantidade restante: ${(totalEntrySize - totalFilledSize).toFixed(quantityPrecision)}`);
      
      // Calcular preço ideal para esta tentativa
      let targetPrice;
      
      // Aguardar dados válidos do book
      const waitStartTime = Date.now();
      while ((!currentBestBid || !currentBestAsk) && Date.now() - waitStartTime < 5000) {
        console.log(`[LIMIT_ENTRY] Aguardando dados válidos do book...`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // ===== NOVA LÓGICA DE CÁLCULO DE PREÇO MELHORADA =====
      // Inspirada no código do starboy_dev para posicionar ordens de forma mais eficiente
      if (currentBestBid && currentBestAsk) {
        const spread = currentBestAsk - currentBestBid;
        
        if (binanceSide === 'BUY') {
          // Para compras (BUY), verificar se podemos posicionar ordem dentro do spread
          const spreadSize = currentBestAsk - currentBestBid;
          const moreBidPrice = currentBestBid + tickSize;
          
          // Verificar se há espaço suficiente no spread para posicionar a ordem
          if (spreadSize > tickSize && moreBidPrice < currentBestAsk) {
            // Posicionar ordem 1 tick acima do melhor bid (mais agressivo, mas ainda MAKER)
            targetPrice = moreBidPrice;
            console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem BUY posicionada DENTRO do spread a ${targetPrice.toFixed(pricePrecision)} (1 tick acima do bid ${currentBestBid.toFixed(pricePrecision)})`);
          } else {
            // Spread muito estreito, usar o bid atual como base
            targetPrice = currentBestBid;
            console.log(`[LIMIT_ENTRY] Spread estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem BUY no bid: ${targetPrice.toFixed(pricePrecision)}`);
          }
          
          // Verificação final para garantir que a ordem será MAKER
          if (targetPrice >= currentBestAsk - tickSize) {
            targetPrice = currentBestAsk - tickSize;
            console.log(`[LIMIT_ENTRY] Ajuste: preço BUY ajustado para garantir ordem maker: ${targetPrice.toFixed(pricePrecision)} (1 tick abaixo do ask)`);
          }
        } else { // SELL
          // Para vendas, verificar se podemos posicionar dentro do spread
          const spreadSize = currentBestAsk - currentBestBid;
          const lessAskPrice = currentBestAsk - tickSize;
          
          if (spreadSize > tickSize && lessAskPrice > currentBestBid) {
            // Posicionar ordem 1 tick abaixo do melhor ask
            targetPrice = lessAskPrice;
            console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem SELL posicionada DENTRO do spread a ${targetPrice.toFixed(pricePrecision)} (1 tick abaixo do ask ${currentBestAsk.toFixed(pricePrecision)})`);
          } else {
            // Spread estreito, usar o ask atual
            targetPrice = currentBestAsk;
            console.log(`[LIMIT_ENTRY] Spread estreito (${spreadSize.toFixed(pricePrecision)}). Posicionando ordem SELL no ask: ${targetPrice.toFixed(pricePrecision)}`);
          }
          
          // Verificação final para garantir ordem MAKER
          if (targetPrice <= currentBestBid + tickSize) {
            targetPrice = currentBestBid + tickSize;
            console.log(`[LIMIT_ENTRY] Ajuste: preço SELL ajustado para garantir ordem maker: ${targetPrice.toFixed(pricePrecision)} (1 tick acima do bid)`);
          }
        }
      } else {
        // Fallback caso não tenhamos dados do book
        targetPrice = parseFloat(signal.entry_price || signal.price);
        console.log(`[LIMIT_ENTRY] Usando preço do sinal como fallback: ${targetPrice}`);
      }

      // Arredondar preço para tick size
      targetPrice = await roundPriceToTickSize(signal.symbol, targetPrice, numericAccountId);
      console.log(`[LIMIT_ENTRY] 🎯 Preço alvo calculado: ${targetPrice.toFixed(pricePrecision)}`);
      
      // Calcular quantidade restante
      const remainingQty = totalEntrySize - totalFilledSize;
      if (remainingQty <= 0.000001) {
        console.log(`[LIMIT_ENTRY] ✅ Quantidade já preenchida completamente!`);
        entryCompleted = true;
        break;
      }
      
      // VALIDAR QUANTIDADE
      const formattedQty = parseFloat(remainingQty.toFixed(quantityPrecision));
      const orderValidation = await validateQuantity(signal.symbol, formattedQty, targetPrice, numericAccountId, 'LIMIT');
      let quantityToOrder = formattedQty;
      
      if (!orderValidation.isValid) {
        console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade inválida (${formattedQty}): ${orderValidation.reason}`);
        
        const adjustment = await adjustQuantityToRequirements(signal.symbol, formattedQty, targetPrice, numericAccountId, 'LIMIT');
        if (adjustment.success) {
          quantityToOrder = adjustment.adjustedQuantity;
          console.log(`[LIMIT_ENTRY] Quantidade ajustada: ${formattedQty} → ${quantityToOrder}`);
        } else {
          console.error(`[LIMIT_ENTRY] Não foi possível ajustar quantidade: ${adjustment.error}`);
          break;
        }
      }
      
      // ===== VERIFICAÇÃO CRÍTICA: SE JÁ EXISTE ORDEM ATIVA =====
      if (activeOrderId) {
        console.log(`[LIMIT_ENTRY] ⚠️ Já existe ordem ativa ${activeOrderId}. Verificando status...`);
        
        // Verificar status na corretora via REST API
        try {
          const existingOrderStatus = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
          
          // Se ordem está preenchida
          if (existingOrderStatus.status === 'FILLED') {
            console.log(`[LIMIT_ENTRY] ✅ Ordem existente ${activeOrderId} está FILLED`);
            
            // Contabilizar preenchimento
            const filledQty = parseFloat(existingOrderStatus.executedQty);
            const avgPrice = parseFloat(existingOrderStatus.avgPrice || existingOrderStatus.price);
            
            // Adicionar aos preenchimentos se ainda não estiver
            if (!partialFills.some(f => f.orderId === activeOrderId)) {
              partialFills.push({
                qty: filledQty,
                price: avgPrice,
                orderId: activeOrderId
              });
              
              // Recalcular totais
              totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
              averageEntryPrice = calculateAveragePrice(partialFills);
            }
            
            // Resetar ordem ativa
            activeOrderId = null;
            continue;
          }
          // Se ordem está parcialmente preenchida
          else if (existingOrderStatus.status === 'PARTIALLY_FILLED') {
            console.log(`[LIMIT_ENTRY] Ordem existente ${activeOrderId} está PARTIALLY_FILLED (${existingOrderStatus.executedQty}/${existingOrderStatus.origQty})`);
            
            // Se o preço alvo mudou significativamente, cancelar e recriar
            const currentOrderPrice = parseFloat(existingOrderStatus.price);
            const priceDifference = Math.abs(currentOrderPrice - targetPrice) / currentOrderPrice;
            
            if (priceDifference > 0.0005) { // Diferença de 0.05%
              console.log(`[LIMIT_ENTRY] Preço mudou significativamente (${(priceDifference*100).toFixed(4)}%). Cancelando ordem atual.`);
              
              try {
                await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} cancelada com sucesso`);
                
                // Contabilizar preenchimento parcial
                const partiallyFilledQty = parseFloat(existingOrderStatus.executedQty);
                if (partiallyFilledQty > 0) {
                  partialFills.push({
                    qty: partiallyFilledQty,
                    price: parseFloat(existingOrderStatus.avgPrice || existingOrderStatus.price),
                    orderId: activeOrderId
                  });
                  
                  // Recalcular totais
                  totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                  averageEntryPrice = calculateAveragePrice(partialFills);
                }
                
                // Resetar ordem ativa
                activeOrderId = null;
              } catch (cancelError) {
                console.warn(`[LIMIT_ENTRY] Erro ao cancelar ordem: ${cancelError.message}`);
                
                // Verificar novamente o status após erro
                try {
                  const statusAfterError = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
                  
                  if (statusAfterError.status === 'FILLED') {
                    console.log(`[LIMIT_ENTRY] ✅ Ordem foi preenchida durante tentativa de cancelamento`);
                    
                    // Contabilizar preenchimento
                    partialFills.push({
                      qty: parseFloat(statusAfterError.executedQty),
                      price: parseFloat(statusAfterError.avgPrice || statusAfterError.price),
                      orderId: activeOrderId
                    });
                    
                    totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                    averageEntryPrice = calculateAveragePrice(partialFills);
                    
                    // Resetar ordem ativa
                    activeOrderId = null;
                  }
                } catch (recheckError) {
                  console.error(`[LIMIT_ENTRY] Erro ao verificar status após falha de cancelamento: ${recheckError.message}`);
                }
              }
            } else {
              console.log(`[LIMIT_ENTRY] Preço não mudou significativamente. Mantendo ordem atual.`);
              
              // Aguardar mais tempo para preenchimento
              await new Promise(resolve => setTimeout(resolve, 5000));
              continue;
            }
          }
          // Se ordem ainda está aberta (NEW)
          else if (existingOrderStatus.status === 'NEW') {
            // Se preço ideal mudou significativamente, cancelar e recriar
            const currentOrderPrice = parseFloat(existingOrderStatus.price);
            const priceDifference = Math.abs(currentOrderPrice - targetPrice) / currentOrderPrice;
            
            if (priceDifference > 0.0005) { // Diferença de 0.05%
              console.log(`[LIMIT_ENTRY] Preço ideal mudou ${(priceDifference*100).toFixed(4)}%. Cancelando ordem atual.`);
              
              try {
                await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} cancelada com sucesso`);
                activeOrderId = null;
              } catch (cancelError) {
                console.warn(`[LIMIT_ENTRY] Erro ao cancelar ordem: ${cancelError.message}`);
                
                // Verificar se o erro é porque a ordem já foi preenchida
                if (cancelError.message && cancelError.message.includes("Unknown order")) {
                  console.log(`[LIMIT_ENTRY] Ordem possivelmente já executada. Verificando...`);
                  
                  try {
                    const statusAfterError = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
                    
                    if (statusAfterError.status === 'FILLED') {
                      console.log(`[LIMIT_ENTRY] ✅ Ordem foi preenchida`);
                      
                      // Contabilizar preenchimento
                      partialFills.push({
                        qty: parseFloat(statusAfterError.executedQty),
                        price: parseFloat(statusAfterError.avgPrice || statusAfterError.price),
                        orderId: activeOrderId
                      });
                      
                      totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                      averageEntryPrice = calculateAveragePrice(partialFills);
                    }
                  } catch (recheckError) {
                    console.error(`[LIMIT_ENTRY] Erro ao verificar status: ${recheckError.message}`);
                  }
                }
                
                activeOrderId = null;
              }
            } else {
              console.log(`[LIMIT_ENTRY] Preço não mudou significativamente. Mantendo ordem atual.`);
              
              // Aguardar mais tempo para preenchimento
              await new Promise(resolve => setTimeout(resolve, 5000));
              continue;
            }
          }
          // Outros status (CANCELED, REJECTED, etc.)
          else {
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} está em estado ${existingOrderStatus.status}. Resetando.`);
            activeOrderId = null;
          }
        } catch (statusError) {
          console.warn(`[LIMIT_ENTRY] Erro ao verificar status da ordem ${activeOrderId}: ${statusError.message}`);
          
          // Por segurança, resetar ordem ativa
          activeOrderId = null;
        }
      }
      
      // ===== CRIAR NOVA ORDEM APENAS SE NÃO EXISTE ORDEM ATIVA =====
      if (!activeOrderId) {
        console.log(`[LIMIT_ENTRY] ⭐ Enviando UMA ÚNICA ordem: ${binanceSide} ${quantityToOrder} ${signal.symbol} @ ${targetPrice}`);
        
        try {
          // Enviar uma única ordem
          const orderResponse = await newLimitMakerOrder(
            numericAccountId,
            signal.symbol,
            quantityToOrder,
            binanceSide,
            targetPrice
          );
          
          if (!orderResponse || !orderResponse.orderId) {
            console.error(`[LIMIT_ENTRY] ❌ Resposta inválida ao criar ordem:`, orderResponse);
            await new Promise(resolve => setTimeout(resolve, 2000));
            continue;
          }
          
          // Registrar a ordem criada
          activeOrderId = String(orderResponse.orderId);
          console.log(`[LIMIT_ENTRY] ✅ Ordem criada com ID: ${activeOrderId}`);
          
          // Registrar para rastreamento
          sentOrders.set(activeOrderId, {
            orderId: activeOrderId,
            symbol: signal.symbol,
            side: binanceSide,
            quantity: quantityToOrder,
            price: targetPrice,
            status: 'NEW',
            executedQty: 0,
            creationTime: Date.now(),
            lastUpdateTime: Date.now()
          });
          
          // AGUARDAR CONFIRMAÇÃO VIA WEBSOCKET OU REST API (30 segundos no máximo)
          console.log(`[LIMIT_ENTRY] ⏱️ Aguardando confirmação para ordem ${activeOrderId}...`);
          
          const waitOrderStartTime = Date.now();
          const maxWaitTime = 30000; // 30 segundos
          let orderFilled = false;
          let lastCheckTime = Date.now();
          
          while (Date.now() - waitOrderStartTime < maxWaitTime) {
            // Verificar mapa de ordens atualizado pelo WebSocket
            const orderInfo = sentOrders.get(activeOrderId);
            
            if (orderInfo && orderInfo.status === 'FILLED') {
              console.log(`[LIMIT_ENTRY] ✅ WebSocket confirmou ordem ${activeOrderId} como FILLED`);
              orderFilled = true;
              
              // Recalcular quantidade preenchida
              totalFilledSize += parseFloat(orderInfo.executedQty || 0);
              
              // Recalcular preço médio
              if (partialFills.length > 0) {
                averageEntryPrice = calculateAveragePrice(partialFills);
              }
              
              console.log(`[LIMIT_ENTRY] Total preenchido: ${totalFilledSize.toFixed(quantityPrecision)} @ ${averageEntryPrice.toFixed(pricePrecision)}`);
              break;
            }
            
            // Verificar via REST API a cada 5 segundos (caso WebSocket falhe)
            if (Date.now() - lastCheckTime > 5000) {
              lastCheckTime = Date.now();
              console.log(`[LIMIT_ENTRY] Verificando status via REST API (WebSocket pode estar lento)...`);
              
              try {
                const restStatus = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
                
                if (restStatus.status === 'FILLED') {
                  console.log(`[LIMIT_ENTRY] ✅ REST API confirmou ordem ${activeOrderId} como FILLED`);
                  orderFilled = true;
                  
                  // Contabilizar preenchimento
                  partialFills.push({
                    qty: parseFloat(restStatus.executedQty),
                    price: parseFloat(restStatus.avgPrice || restStatus.price),
                    orderId: activeOrderId
                  });
                  
                  totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                  averageEntryPrice = calculateAveragePrice(partialFills);
                  
                  break;
                }
                else if (restStatus.status === 'PARTIALLY_FILLED') {
                  console.log(`[LIMIT_ENTRY] REST API: Ordem ${activeOrderId} parcialmente preenchida: ${restStatus.executedQty}/${restStatus.origQty}`);
                  
                  // Atualizar informação no mapa
                  if (sentOrders.has(activeOrderId)) {
                    const orderInfo = sentOrders.get(activeOrderId);
                    orderInfo.status = 'PARTIALLY_FILLED';
                    orderInfo.executedQty = parseFloat(restStatus.executedQty);
                    orderInfo.lastUpdateTime = Date.now();
                  }
                }
              } catch (restError) {
                console.warn(`[LIMIT_ENTRY] Erro ao verificar status via REST: ${restError.message}`);
              }
            }
            
            // Verificar a cada 200ms
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          
          // Se a ordem foi totalmente preenchida, a entrada está completa
          if (orderFilled && Math.abs(totalFilledSize - totalEntrySize) <= 0.000001) {
            console.log(`[LIMIT_ENTRY] ✅ Entrada completa após ${entryAttemptCount} tentativa(s)`);
            entryCompleted = true;
            break;
          }
          
          // Se timeout, cancelar ordem ativa se ainda estiver aberta
          if (Date.now() - waitOrderStartTime >= maxWaitTime && activeOrderId) {
            console.log(`[LIMIT_ENTRY] Timeout aguardando preenchimento. Verificando status final...`);
            
            try {
              const finalStatus = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
              
              if (finalStatus.status === 'NEW' || finalStatus.status === 'PARTIALLY_FILLED') {
                console.log(`[LIMIT_ENTRY] Cancelando ordem após timeout (status: ${finalStatus.status})...`);
                
                try {
                  await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
                  console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} cancelada após timeout`);
                  
                  // Se estava parcialmente preenchida, contabilizar
                  if (finalStatus.status === 'PARTIALLY_FILLED') {
                    const executedQty = parseFloat(finalStatus.executedQty);
                    if (executedQty > 0) {
                      partialFills.push({
                        qty: executedQty,
                        price: parseFloat(finalStatus.avgPrice || finalStatus.price),
                        orderId: activeOrderId
                      });
                      
                      totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                      averageEntryPrice = calculateAveragePrice(partialFills);
                    }
                  }
                } catch (cancelError) {
                  console.warn(`[LIMIT_ENTRY] Erro ao cancelar após timeout: ${cancelError.message}`);
                  
                  // Verificar se erro é porque a ordem já foi preenchida
                  if (cancelError.message && cancelError.message.includes("Unknown order")) {
                    console.log(`[LIMIT_ENTRY] Ordem possivelmente já executada. Verificando status final...`);
                    try {
                      const statusAfterError = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
                      
                      if (statusAfterError.status === 'FILLED') {
                        console.log(`[LIMIT_ENTRY] ✅ Ordem foi preenchida durante cancelamento`);
                        
                        partialFills.push({
                          qty: parseFloat(statusAfterError.executedQty),
                          price: parseFloat(statusAfterError.avgPrice || statusAfterError.price),
                          orderId: activeOrderId
                        });
                        
                        totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                        averageEntryPrice = calculateAveragePrice(partialFills);
                      }
                    } catch (recheckError) {
                      console.error(`[LIMIT_ENTRY] Erro ao verificar status: ${recheckError.message}`);
                    }
                  }
                }
              }
              else if (finalStatus.status === 'FILLED') {
                console.log(`[LIMIT_ENTRY] ✅ Ordem já estava preenchida na verificação final`);
                
                partialFills.push({
                  qty: parseFloat(finalStatus.executedQty),
                  price: parseFloat(finalStatus.avgPrice || finalStatus.price),
                  orderId: activeOrderId
                });
                
                totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
                averageEntryPrice = calculateAveragePrice(partialFills);
              }
            } catch (finalCheckError) {
              console.warn(`[LIMIT_ENTRY] Erro na verificação final: ${finalCheckError.message}`);
            }
            
            // Resetar ordem ativa
            activeOrderId = null;
          }
        } catch (orderError) {
          console.error(`[LIMIT_ENTRY] ❌ Erro ao criar ordem:`, orderError.message);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      
      // Aguardar antes da próxima tentativa
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // VERIFICAR RESULTADO FINAL
    console.log(`[LIMIT_ENTRY] 📊 RESULTADO FINAL APÓS ${entryAttemptCount} TENTATIVAS:`);
    console.log(`  - Quantidade preenchida: ${totalFilledSize.toFixed(quantityPrecision)} de ${totalEntrySize.toFixed(quantityPrecision)} (${((totalFilledSize/totalEntrySize)*100).toFixed(1)}%)`);
    console.log(`  - Preço médio: ${averageEntryPrice ? averageEntryPrice.toFixed(pricePrecision) : 'N/A'}`);

    // Se não conseguiu preencher pelo menos 95% da quantidade desejada, falhar
    const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;
    if (fillRatio < 0.95) {
      throw new Error(`Não foi possível completar entrada: apenas ${(fillRatio * 100).toFixed(1)}% preenchido`);
    }

    // Se chegou aqui, a entrada foi bem-sucedida

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
    if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO) {
      console.log(`[LIMIT_ENTRY] Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
      slTpRpsCreated = true;

      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;

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
            console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize} ${signal.symbol} @ ${slPriceVal}`);

            const stopOrderResult = await newStopOrder(
              numericAccountId,
              signal.symbol,
              totalFilledSize,
              binanceOppositeSide,
              slPriceVal,
              null,
              true
            );

            if (stopOrderResult && (stopOrderResult.data?.orderId || stopOrderResult.orderId)) {
              const slOrderId = stopOrderResult.data?.orderId || stopOrderResult.orderId;
              console.log(`[LIMIT_ENTRY] SL criado com ID: ${slOrderId}`);

              // Inserir no banco de dados
              const slOrderData = {
                tipo_ordem: 'STOP_MARKET',
                preco: slPriceVal,
                quantidade: totalFilledSize,
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(slOrderId).substring(0,90),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'STOP_LOSS',
                target: null,
                reduce_only: true,
                close_position: false,
                orign_sig: `WEBHOOK_${signal.id}`,
                last_update: formatDateForMySQL(new Date())
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
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10]; // 25%, 30%, 25%, 10%
      const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];
      let cumulativeQtyForRps = 0;
      let availablePositionSize = totalFilledSize; // Rastrear quanto ainda resta da posição

      // Obter precisão para formatação
      const precision = await getPrecisionCached(signal.symbol, numericAccountId);
      if (!precision) {
        console.error(`[LIMIT_ENTRY] ❌ Erro ao obter precisão para ${signal.symbol}`);
        throw new Error(`Precisão não disponível para ${signal.symbol}`);
      }

      console.log(`[LIMIT_ENTRY] Criando reduções parciais com porcentagens: ${reductionPercentages.map(p => (p*100)+'%').join(', ')}`);
      console.log(`[LIMIT_ENTRY] Tamanho total da posição: ${totalFilledSize}, precisão: ${precision.quantityPrecision}`);

      // Criar RPs com porcentagens definidas
      for (let i = 0; i < rpTargetKeys.length && i < reductionPercentages.length; i++) {
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
          console.log(`[LIMIT_ENTRY] RP${i+1} pulada - preço ${rpPrice} inválido para ${binanceSide} (entry: ${averageEntryPrice})`);
          continue;
        }
        
        // CALCULAR QUANTIDADE - VERIFICAR SE NÃO EXCEDE O DISPONÍVEL
        let idealReductionQty = totalFilledSize * reductionPercent;
        let reductionQty = Math.min(idealReductionQty, availablePositionSize);
        
        // Arredondar para a precisão correta
        reductionQty = parseFloat(reductionQty.toFixed(precision.quantityPrecision));
        
        console.log(`[LIMIT_ENTRY] Calculando RP${i+1}: ${reductionPercent*100}% de ${totalFilledSize} = ${reductionQty} (disponível: ${availablePositionSize.toFixed(precision.quantityPrecision)})`);
        
        if (reductionQty <= 0 || reductionQty < precision.minQty) {
          console.log(`[LIMIT_ENTRY] RP${i+1} pulada - quantidade insuficiente: ${reductionQty}`);
          continue;
        }
        
        try {
          console.log(`[LIMIT_ENTRY] Criando RP${i+1}: ${reductionQty.toFixed(precision.quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(precision.pricePrecision)}`);
          
          const rpResponse = await newReduceOnlyOrder(
            numericAccountId, 
            signal.symbol, 
            reductionQty, 
            binanceOppositeSide, 
            rpPrice
          );
          
          if (rpResponse && rpResponse.data && rpResponse.data.orderId) {
            const rpOrderId = rpResponse.data.orderId;
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
              last_update: formatDateForMySQL(new Date())
            };
            
            await insertNewOrder(connection, rpOrderData);
            
            // Atualizar contabilidade
            cumulativeQtyForRps += reductionQty;
            availablePositionSize -= reductionQty; // Reduzir o disponível
          } else {
            console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar RP${i+1}:`, rpResponse);
          }
        } catch (rpError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.message);
        }
      }

      // CRIAR TAKE PROFIT FINAL (TP5) COM QUANTIDADE RESTANTE
      const remainingQtyForFinalTp = availablePositionSize; // Usar o que ainda está disponível

      if (remainingQtyForFinalTp > precision.minQty && targetPrices.tp5) {
        // VALIDAR DIREÇÃO DO TP FINAL
        const isFinalTpValidForDirection = binanceSide === 'BUY' ? 
          targetPrices.tp5 > averageEntryPrice : 
          targetPrices.tp5 < averageEntryPrice;
          
        if (isFinalTpValidForDirection) {
          try {
            console.log(`[LIMIT_ENTRY] Criando TP FINAL: ${remainingQtyForFinalTp.toFixed(precision.quantityPrecision)} ${signal.symbol} @ ${targetPrices.tp5.toFixed(precision.pricePrecision)}`);
            
            // USAR TAKE_PROFIT_MARKET COM PREÇO AJUSTADO (MENOS AGRESSIVO)
            // Para compra: preço ligeiramente maior, para venda: preço ligeiramente menor
            const adjustedTpPrice = binanceSide === 'BUY' ? 
              targetPrices.tp5 * 1.005 : // +0.5% para BUY (TP mais conservador)
              targetPrices.tp5 * 0.995;  // -0.5% para SELL (TP mais conservador)
            
            const finalTpResponse = await newStopOrder(
              numericAccountId, 
              signal.symbol, 
              remainingQtyForFinalTp, 
              binanceOppositeSide, 
              adjustedTpPrice, // Usar preço ajustado
              null, // price param null para STOP_MARKET
              true, // reduceOnly
              false // closePosition
            );
            
            if (finalTpResponse && finalTpResponse.data && finalTpResponse.data.orderId) {
              console.log(`[LIMIT_ENTRY] TP FINAL criado com sucesso: ${finalTpResponse.data.orderId}`);
              
              const finalTpOrderData = { 
                tipo_ordem: 'TAKE_PROFIT_MARKET', 
                preco: adjustedTpPrice, 
                quantidade: remainingQtyForFinalTp, 
                id_posicao: positionId, 
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()), 
                id_externo: String(finalTpResponse.data.orderId).substring(0,90), 
                side: binanceOppositeSide,
                simbolo: signal.symbol, 
                tipo_ordem_bot: 'TAKE_PROFIT', 
                target: 5, 
                reduce_only: true, 
                close_position: false, 
                orign_sig: `WEBHOOK_${signal.id}`,
                last_update: formatDateForMySQL(new Date())
              };
              await insertNewOrder(connection, finalTpOrderData);
            } else {
              console.warn(`[LIMIT_ENTRY] TP FINAL falhou - resposta inválida:`, finalTpResponse);
            }
          } catch (finalTpError) {
            console.error(`[LIMIT_ENTRY] Erro ao criar TP FINAL:`, finalTpError.message);
            
            // TENTAR NOVAMENTE COM ORDEM LIMIT EM VEZ DE STOP
            try {
              console.log(`[LIMIT_ENTRY] Tentando criar TP FINAL como LIMIT...`);
              
              const altTpResponse = await newReduceOnlyOrder(
                numericAccountId,
                signal.symbol,
                remainingQtyForFinalTp,
                binanceOppositeSide,
                targetPrices.tp5
              );
              
              if (altTpResponse && altTpResponse.data && altTpResponse.data.orderId) {
                console.log(`[LIMIT_ENTRY] TP FINAL (LIMIT) criado com sucesso: ${altTpResponse.data.orderId}`);
                
                const altTpOrderData = {
                  tipo_ordem: 'LIMIT',
                  preco: targetPrices.tp5,
                  quantidade: remainingQtyForFinalTp,
                  id_posicao: positionId,
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()),
                  id_externo: String(altTpResponse.data.orderId).substring(0,90),
                  side: binanceOppositeSide,
                  simbolo: signal.symbol,
                  tipo_ordem_bot: 'TAKE_PROFIT',
                  target: 5,
                  reduce_only: true,
                  close_position: false,
                  orign_sig: `WEBHOOK_${signal.id}`,
                  last_update: formatDateForMySQL(new Date())
                };
                await insertNewOrder(connection, altTpOrderData);
              }
            } catch (altError) {
              console.error(`[LIMIT_ENTRY] Também falhou criar TP FINAL alternativo:`, altError.message);
            }
          }
        } else {
          console.log(`[LIMIT_ENTRY] TP FINAL pulado - preço ${targetPrices.tp5} inválido para ${binanceSide} (entry: ${averageEntryPrice})`);
        }
      } else {
        console.log(`[LIMIT_ENTRY] TP FINAL pulado - quantidade restante: ${remainingQtyForFinalTp}, TP5: ${targetPrices.tp5}, minQty: ${precision.minQty}`);
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
          console.log(`[LIMIT_ENTRY_RECOVERY] Criando SL de emergência: ${totalFilledSize.toFixed(recoveryQuantityPrecision)} @ ${slPriceVal}`);

          try {
            const stopOrderResult = await newStopOrder(
              recoveryAccountId,
              signal.symbol,
              totalFilledSize,
              binanceOppositeSide,
              slPriceVal,
              null,
              true
            );

            if (stopOrderResult && (stopOrderResult.data?.orderId || stopOrderResult.orderId)) {
              const slOrderId = stopOrderResult.data?.orderId || stopOrderResult.orderId;

              // Inserir no banco de dados
              const slOrderData = {
                tipo_ordem: 'STOP_MARKET',
                preco: slPriceVal,
                quantidade: totalFilledSize,
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(slOrderId).substring(0,90),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'STOP_LOSS',
                target: null,
                reduce_only: true,
                close_position: false,
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
              totalFilledSize,
              binanceOppositeSide,
              finalTpPriceVal,
              finalTpPriceVal,
              true,
              true
            );

            if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
              console.log(`[LIMIT_ENTRY_RECOVERY] ✅ TP de emergência criado: ${tpResponse.data.orderId}`);

              const tpOrderData = {
                tipo_ordem: 'TAKE_PROFIT_MARKET',
                preco: finalTpPriceVal,
                quantidade: totalFilledSize,
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForMySQL(new Date()),
                id_externo: String(tpResponse.data.orderId),
                side: binanceOppositeSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'TAKE_PROFIT',
                target: null,
                reduce_only: true,
                close_position: false,
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

// FUNÇÃO PARA AGUARDAR EXECUÇÃO DE ORDEM
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000, accountId) {
    console.log(`[WAIT_ORDER] Aguardando execução da ordem ${orderId} para ${symbol} (conta ${accountId})...`);

    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
        try {
            const orderStatus = await api.getOrderStatus(symbol, orderId, accountId);

            if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
                console.log(`[WAIT_ORDER] ✅ Ordem ${orderId} executada: ${orderStatus.status}`);
                return orderStatus;
            }

            await new Promise(resolve => setTimeout(resolve, 200));
        } catch (error) {
            console.log(`[WAIT_ORDER] Erro ao verificar ordem ${orderId}: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }

    // Última tentativa
    try {
        const finalStatus = await api.getOrderStatus(symbol, orderId, accountId);
        console.log(`[WAIT_ORDER] Status final da ordem ${orderId}: ${finalStatus.status}`);
        return finalStatus;
    } catch (error) {
        console.log(`[WAIT_ORDER] Erro na verificação final da ordem ${orderId}: ${error.message}`);
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}

module.exports = {
    executeLimitMakerEntry
};