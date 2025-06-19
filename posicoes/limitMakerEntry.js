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
/**
 * Executa entrada usando Limit Maker - VERSÃO CORRIGIDA PARA AGUARDAR WEBSOCKET
 * @param {Object} signal - Sinal a ser processado
 * @param {number} currentPrice - Preço atual do mercado
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} Resultado da operação
 */
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
  let precision = null; // ✅ Inicializar precision para evitar erro de referência
  
  // ✅ CONTROLE DE ORDENS ENVIADAS
  const sentOrders = new Map(); // Mapa para controlar ordens já enviadas
  let totalNotionalSent = 0; // Controlar notional total enviado
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
    numericAccountId = parseInt(accountId) || accountId;
    
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
    precision = await getPrecision(signal.symbol, numericAccountId);
    quantityPrecision = precision.quantityPrecision;
    pricePrecision = precision.pricePrecision;
    const stepSize = precision.stepSize;

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
    
    // VALIDAR QUANTIDADE TOTAL
    console.log(`[LIMIT_ENTRY] Validando quantidade total de entrada: ${totalEntrySize}`);
    const entryValidation = await validateQuantity(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');
    
    if (!entryValidation.isValid) {
      console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade de entrada inválida: ${entryValidation.reason}`);
      
      // TENTAR AJUSTAR AUTOMATICAMENTE
      const adjustment = await adjustQuantityToRequirements(signal.symbol, totalEntrySize, currentPriceTrigger, numericAccountId, 'LIMIT');
      
      if (adjustment.success) {
        console.log(`[LIMIT_ENTRY] ✅ Quantidade ajustada: ${totalEntrySize} → ${adjustment.adjustedQuantity}`);
        totalEntrySize = adjustment.adjustedQuantity;
      } else {
        const errorMsg = `Quantidade de entrada inválida para ${signal.symbol}: ${entryValidation.reason}. Ajuste impossível: ${adjustment.error}`;
        console.error(`[LIMIT_ENTRY] ❌ ${errorMsg}`);
        
        await connection.query(
          'UPDATE webhook_signals SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', errorMsg.substring(0, 250), signal.id]
        );
        
        return { 
          success: false, 
          error: errorMsg,
          suggestion: adjustment.suggestedAction || "Aumente o capital disponível ou escolha outro símbolo"
        };
      }
    }
    
    binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
    
    await connection.query(
      `UPDATE webhook_signals SET status = 'ENTRADA_EM_PROGRESSO' WHERE id = ?`,
      [signal.id]
    );

    // CONFIGURAR WEBSOCKET DE PROFUNDIDADE
    console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
    depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData, receivedAccountId) => {
      if (receivedAccountId && receivedAccountId !== accountId) {
        return;
      }
      
      if (depthData && depthData.bestBid && depthData.bestAsk) {
        const bid = parseFloat(depthData.bestBid);
        const ask = parseFloat(depthData.bestAsk);
        
        const spread = ask - bid;
        const spreadPercent = (spread / bid) * 100;
        
        if (spreadPercent > 5) {
          console.warn(`[LIMIT_ENTRY_DEPTH_WS] Spread muito alto para ${signal.symbol}: ${spreadPercent.toFixed(4)}%`);
          wsUpdateErrorCount++;
          return;
        }
        
        currentBestBid = bid;
        currentBestAsk = ask;
        lastDepthUpdateTimestamp = Date.now();
        wsUpdateErrorCount = 0;
      } else {
        wsUpdateErrorCount++;
      }
    }, accountId);

    // AGUARDAR DADOS DO WEBSOCKET COM RETRY
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

    // ===== FLUXO PRINCIPAL DE ENTRADA - VERSÃO CORRIGIDA =====
    console.log(`[LIMIT_ENTRY] 🔄 Iniciando fluxo de entrada principal - Quantidade alvo: ${totalEntrySize.toFixed(quantityPrecision)}`);
    
    let entryCompleted = false;
    activeOrderId = null;
    chaseAttempts = 0;
    executionStartTime = Date.now();
    
    // ✅ LOOP PRINCIPAL CORRIGIDO PARA AGUARDAR CONFIRMAÇÃO WEBSOCKET
    while (!entryCompleted && 
           chaseAttempts < MAX_CHASE_ATTEMPTS && 
           (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
      
      chaseAttempts++;
      console.log(`[LIMIT_ENTRY] 🔄 Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS} - Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} (${((totalFilledSize/totalEntrySize)*100).toFixed(1)}%)`);
      
      // ✅ ATUALIZAÇÃO: VERIFICAR SE JÁ ATINGIMOS O LIMITE DA ENTRADA
      if (totalFilledSize >= totalEntrySize * 0.98) {
        console.log(`[LIMIT_ENTRY] ✅ Quantidade alvo atingida (${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)}), finalizando entrada`);
        entryCompleted = true;
        break;
      }
      
      // ✅ SINCRONIZAR VIA WEBSOCKET APENAS (NÃO CONSULTAR API)
      // Em vez de chamar getRecentOrders, vamos confiar no handler WebSocket que já está recebendo atualizações
      
      // Calcular quantidade restante (garantindo não exceder o planejado)
      const remainingQuantity = Math.max(0, totalEntrySize - totalFilledSize);
      
      if (remainingQuantity <= 0.000001) {
        console.log(`[LIMIT_ENTRY] ✅ ENTRADA COMPLETADA! Total preenchido: ${totalFilledSize.toFixed(quantityPrecision)}`);
        entryCompleted = true;
        break;
      }
      
      console.log(`[LIMIT_ENTRY] Quantidade restante: ${remainingQuantity.toFixed(quantityPrecision)}`);
      
      // VALIDAR DADOS DO BOOK
      const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
      if (isDepthDataStale || !currentBestBid || !currentBestAsk) {
        console.log(`[LIMIT_ENTRY] ⏳ Aguardando dados atualizados do book...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      // CALCULAR PREÇO IDEAL PARA ORDEM
      let targetPrice;
      const spread = currentBestAsk - currentBestBid;
      const spreadPercent = (spread / currentBestBid) * 100;
      
      if (binanceSide === 'BUY') {
        // Para BUY: tentar ficar à frente do melhor bid
        if (spread > tickSize * 2) {
          // Se spread é grande, posicionar dentro do spread
          targetPrice = currentBestBid + tickSize;
          if (targetPrice >= currentBestAsk) {
            targetPrice = currentBestAsk - tickSize;
          }
        } else {
          // Se spread é pequeno, ficar no bid
          targetPrice = currentBestBid;
        }
      } else { // SELL
        // Para SELL: tentar ficar à frente do melhor ask
        if (spread > tickSize * 2) {
          // Se spread é grande, posicionar dentro do spread
          targetPrice = currentBestAsk - tickSize;
          if (targetPrice <= currentBestBid) {
            targetPrice = currentBestBid + tickSize;
          }
        } else {
          // Se spread é pequeno, ficar no ask
          targetPrice = currentBestAsk;
        }
      }
      
      // Arredondar para tick size
      targetPrice = await roundPriceToTickSize(signal.symbol, targetPrice, numericAccountId);
      
      console.log(`[LIMIT_ENTRY] 📊 Book: Bid=${currentBestBid.toFixed(pricePrecision)}, Ask=${currentBestAsk.toFixed(pricePrecision)}, Spread=${spreadPercent.toFixed(4)}%`);
      console.log(`[LIMIT_ENTRY] 🎯 Preço alvo calculado: ${targetPrice.toFixed(pricePrecision)}`);
      
      // ✅ VERIFICA SE TEMOS ORDEM ATIVA E AGUARDA ANTES DE CRIAR NOVA
      if (activeOrderId) {
        // Verificar se ainda está pendente no nosso mapa local
        const orderInfo = sentOrders.get(activeOrderId);
        if (orderInfo) {
          // Se recebemos atualização recente (menos de 30 segundos), continue aguardando
          const orderAge = Date.now() - orderInfo.lastUpdateTime;
          if (orderAge < 30000) {
            if (orderInfo.status === 'NEW') {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ainda ativa, aguardando execução...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            } else if (orderInfo.status === 'PARTIALLY_FILLED') {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} parcialmente preenchida, aguardando mais execuções...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
              continue;
            }
          }
          
          // Se ordem está ativa há muito tempo sem atualização, tentar cancelar
          console.log(`[LIMIT_ENTRY] Cancelando ordem ${activeOrderId} que está sem atualizações recentes...`);
          try {
            await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
            activeOrderId = null;
          } catch (cancelError) {
            console.warn(`[LIMIT_ENTRY] Erro ao cancelar ordem ${activeOrderId}:`, cancelError.message);
            // Assumir que a ordem não existe mais
            activeOrderId = null;
          }
        } else {
          // Ordem não está no mapa, pode ter sido completada
          activeOrderId = null;
        }
      }
      
      // ✅ SE NÃO TEMOS ORDEM ATIVA, CRIAR UMA NOVA
      if (!activeOrderId) {
        // Garantir que não enviamos mais que a quantidade planejada
        const quantityToOrder = Math.min(
          remainingQuantity,
          totalEntrySize
        );
        
        if (quantityToOrder <= 0.000001) {
          console.log(`[LIMIT_ENTRY] ✅ Quantidade alvo atingida, não é necessário criar nova ordem`);
          entryCompleted = true;
          break;
        }
        
        // Validar quantidade antes de criar ordem
        const orderValidation = await validateQuantity(signal.symbol, quantityToOrder, targetPrice, numericAccountId, 'LIMIT');
        
        if (!orderValidation.isValid) {
          console.warn(`[LIMIT_ENTRY] ⚠️ Quantidade da ordem inválida: ${orderValidation.reason}`);
          
          const adjustment = await adjustQuantityToRequirements(signal.symbol, quantityToOrder, targetPrice, numericAccountId, 'LIMIT');
          
          if (adjustment.success) {
            console.log(`[LIMIT_ENTRY] Quantidade ajustada: ${quantityToOrder} → ${adjustment.adjustedQuantity}`);
            const adjustedQuantity = adjustment.adjustedQuantity;
            
            // Criar ordem com quantidade ajustada
            try {
              console.log(`[LIMIT_ENTRY] 📤 Criando nova ordem: ${binanceSide} ${adjustedQuantity} @ ${targetPrice}`);
              
              const orderResponse = await newLimitMakerOrder(numericAccountId, signal.symbol, adjustedQuantity, binanceSide, targetPrice);
              
              if (orderResponse && orderResponse.orderId) {
                activeOrderId = String(orderResponse.orderId);
                console.log(`[LIMIT_ENTRY] ✅ Nova ordem criada: ${activeOrderId}`);
                
                // ✅ REGISTRAR ORDEM NO MAPA
                sentOrders.set(activeOrderId, {
                  orderId: activeOrderId,
                  symbol: signal.symbol,
                  side: binanceSide,
                  quantity: adjustedQuantity,
                  price: targetPrice,
                  status: 'NEW',
                  executedQty: 0,
                  creationTime: Date.now(),
                  lastUpdateTime: Date.now()
                });
                
                // ✅ AGUARDAR CONFIRMAÇÃO DA ORDEM VIA WEBSOCKET
                console.log(`[LIMIT_ENTRY] Aguardando confirmação da ordem ${activeOrderId} via WebSocket (15 segundos)...`);
                await new Promise(resolve => setTimeout(resolve, WAIT_FOR_ORDER_CONFIRMATION_MS));
                
                // Verificar se a ordem foi preenchida enquanto aguardávamos
                const orderInfo = sentOrders.get(activeOrderId);
                if (orderInfo && orderInfo.status === 'FILLED') {
                  console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} foi preenchida completamente durante a espera`);
                  activeOrderId = null;
                }
              } else {
                console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar ordem:`, orderResponse);
              }
            } catch (orderError) {
              console.error(`[LIMIT_ENTRY] ❌ Erro ao criar ordem:`, orderError.message);
              // Aguardar um pouco antes de tentar novamente
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          } else {
            console.error(`[LIMIT_ENTRY] Não foi possível ajustar quantidade: ${adjustment.error}`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          // Quantidade válida, criar ordem
          try {
            console.log(`[LIMIT_ENTRY] 📤 Criando nova ordem: ${binanceSide} ${quantityToOrder} @ ${targetPrice}`);
            
            const orderResponse = await newLimitMakerOrder(numericAccountId, signal.symbol, quantityToOrder, binanceSide, targetPrice);
            
            if (orderResponse && orderResponse.orderId) {
              activeOrderId = String(orderResponse.orderId);
              console.log(`[LIMIT_ENTRY] ✅ Nova ordem criada: ${activeOrderId}`);
              
              // ✅ REGISTRAR ORDEM NO MAPA
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
              
              // ✅ AGUARDAR CONFIRMAÇÃO DA ORDEM VIA WEBSOCKET
              console.log(`[LIMIT_ENTRY] Aguardando confirmação da ordem ${activeOrderId} via WebSocket (15 segundos)...`);
              await new Promise(resolve => setTimeout(resolve, WAIT_FOR_ORDER_CONFIRMATION_MS));
              
              // Verificar se a ordem foi preenchida enquanto aguardávamos
              const orderInfo = sentOrders.get(activeOrderId);
              if (orderInfo && orderInfo.status === 'FILLED') {
                console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} foi preenchida completamente durante a espera`);
                activeOrderId = null;
              }
            } else {
              console.warn(`[LIMIT_ENTRY] Resposta inválida ao criar ordem:`, orderResponse);
            }
          } catch (orderError) {
            console.error(`[LIMIT_ENTRY] ❌ Erro ao criar ordem:`, orderError.message);
            // Aguardar um pouco antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
      
      // AGUARDAR UM POUCO ANTES DA PRÓXIMA ITERAÇÃO
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    
    // ===== VERIFICAR RESULTADO FINAL DA ENTRADA =====
    const finalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
    const fillRatio = totalEntrySize > 0 ? finalFilledSize / totalEntrySize : 0;
    
    console.log(`[LIMIT_ENTRY] 📊 RESULTADO FINAL DA ENTRADA:`);
    console.log(`  - Tentativas: ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}`);
    console.log(`  - Preenchido: ${finalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} (${(fillRatio * 100).toFixed(1)}%)`);
    console.log(`  - Preço médio: ${averageEntryPrice ? averageEntryPrice.toFixed(pricePrecision) : 'N/A'}`);
    console.log(`  - Tempo gasto: ${((Date.now() - executionStartTime) / 1000).toFixed(1)}s`);
    
    // Cancelar ordem ativa se ainda existir
    if (activeOrderId) {
      try {
        console.log(`[LIMIT_ENTRY] Cancelando ordem ativa restante: ${activeOrderId}`);
        await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
      } catch (cancelError) {
        console.warn(`[LIMIT_ENTRY] Erro ao cancelar ordem ativa final:`, cancelError.message);
      }
    }
    
    // Atualizar variáveis finais
    totalFilledSize = finalFilledSize;
    
    // VALIDAÇÃO FINAL: Verificar se entrada foi suficiente
    const MIN_FILL_THRESHOLD = 0.90; // 90% mínimo
    
    if (fillRatio < MIN_FILL_THRESHOLD) {
      throw new Error(`Entrada insuficiente: apenas ${(fillRatio * 100).toFixed(1)}% preenchida (mínimo: ${(MIN_FILL_THRESHOLD * 100)}%)`);
    }
    
    if (totalFilledSize <= 0.000001) {
      throw new Error(`Entrada falhou: nenhuma quantidade foi preenchida`);
    }
    
    // Recalcular preço médio final
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    }
    
    if (!averageEntryPrice || averageEntryPrice <= 0) {
      throw new Error(`Preço médio de entrada inválido: ${averageEntryPrice}`);
    }
    
    console.log(`[LIMIT_ENTRY] ✅ ENTRADA CONCLUÍDA COM SUCESSO!`);
    console.log(`[LIMIT_ENTRY] Total: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${averageEntryPrice.toFixed(pricePrecision)}`);

    // CALCULAR PREÇO MÉDIO DE ENTRADA
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
      averageEntryPrice = currentPriceTrigger; 
      console.warn(`[LIMIT_ENTRY] Usando currentPriceTrigger como averageEntryPrice (fallback).`);
    }

    const MIN_FILL_THRESHOLD_ABSOLUTE = 0.000001; 
    if (totalFilledSize <= MIN_FILL_THRESHOLD_ABSOLUTE) { 
         throw new Error(`Entrada falhou. Quantidade preenchida (${totalFilledSize.toFixed(quantityPrecision)}) é insignificante.`);
    }
    
    // RECALCULAR PREÇO MÉDIO FINAL
    if (partialFills.length > 0) {
      averageEntryPrice = calculateAveragePrice(partialFills);
    } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) {
       averageEntryPrice = currentPriceTrigger;
       console.warn(`[LIMIT_ENTRY] Usando currentPriceTrigger como averageEntryPrice (fallback extremo).`);
    }
    if (!averageEntryPrice || averageEntryPrice === 0) {
      throw new Error(`Preço médio de entrada não pôde ser determinado apesar de ${totalFilledSize} preenchido.`);
    }

    console.log(`[LIMIT_ENTRY] Processo de entrada finalizado para Sinal ID ${signal.id}: Total Preenchido ${totalFilledSize.toFixed(quantityPrecision)} de ${totalEntrySize.toFixed(quantityPrecision)} (${(fillRatio * 100).toFixed(1)}%) @ Preço Médio ${averageEntryPrice.toFixed(pricePrecision)}`);
    
    // INSERIR POSIÇÃO NO BANCO - CORREÇÃO PARA EVITAR DUPLICATAS
    console.log(`[LIMIT_ENTRY] Verificando se posição já existe antes de inserir...`);
    
    // VERIFICAR SE JÁ EXISTE POSIÇÃO PARA ESTE SÍMBOLO
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
      
      // CRIAR STOP LOSS
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
            const orderId = stopOrderResult.data?.orderId || stopOrderResult.orderId;
            console.log(`[LIMIT_ENTRY] SL criado com ID: ${orderId}`);
            
            const slOrderData = {
              tipo_ordem: 'STOP_MARKET',
              preco: slPriceVal,
              quantidade: totalFilledSize,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(orderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'STOP_LOSS',
              target: null,
              reduce_only: true,
              close_position: false,
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}`
            };
            
            await insertNewOrder(connection, slOrderData);
            await connection.query(`UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`, [String(orderId), signal.id]);
          }
        } catch (slError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar SL:`, slError.message);
        }
      }

      // ✅ CORREÇÃO: OBTER PREÇOS CORRETOS DOS TPs
      // Verificar se os valores são preços (maiores que 100) ou percentuais (menores que 100)
      const targetPrices = {};
      
      // Função auxiliar para calcular preço TP com base na entrada
      const calculateTpPrice = (priceOrPercent) => {
        if (!priceOrPercent) return null;
        
        const value = parseFloat(priceOrPercent);
        if (isNaN(value) || value <= 0) return null;
        
        // Se valor < 100, assumir que é percentual
        if (value < 100) {
          return binanceSide === 'BUY' 
            ? averageEntryPrice * (1 + value/100)  // Para BUY: preço + X%
            : averageEntryPrice * (1 - value/100); // Para SELL: preço - X%
        }
        
        // Caso contrário, é um preço absoluto
        return value;
      };
      
      // Calcular todos os preços dos TPs
      targetPrices.tp1 = calculateTpPrice(signal.tp1_price);
      targetPrices.tp2 = calculateTpPrice(signal.tp2_price);
      targetPrices.tp3 = calculateTpPrice(signal.tp3_price);
      targetPrices.tp4 = calculateTpPrice(signal.tp4_price);
      targetPrices.tp5 = calculateTpPrice(signal.tp5_price || signal.tp_price);

      console.log(`[LIMIT_ENTRY] Target Prices calculados:`, {
        tp1: targetPrices.tp1,
        tp2: targetPrices.tp2, 
        tp3: targetPrices.tp3,
        tp4: targetPrices.tp4,
        tp5: targetPrices.tp5,
        side: binanceSide,
        entryPrice: averageEntryPrice
      });

      // ✅ CRIAR REDUÇÕES PARCIAIS COM PORCENTAGENS CORRETAS E SEM VALIDAÇÃO
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10]; // 25%, 30%, 25%, 10%
      const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];
      let cumulativeQtyForRps = 0;
      
      console.log(`[LIMIT_ENTRY] Criando reduções parciais com porcentagens: ${reductionPercentages.map(p => (p*100)+'%').join(', ')}`);
      
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
        
        // CALCULAR QUANTIDADE SEM VALIDAÇÃO DE MÍNIMO
        let reductionQty = totalFilledSize * reductionPercent;
        reductionQty = parseFloat(reductionQty.toFixed(quantityPrecision));
        
        console.log(`[LIMIT_ENTRY] Calculando RP${i+1}: ${reductionPercent*100}% de ${totalFilledSize} = ${reductionQty}`);
        
        if (reductionQty <= 0) {
          console.log(`[LIMIT_ENTRY] RP${i+1} pulada - quantidade zero: ${reductionQty}`);
          continue;
        }
        
        try {
          console.log(`[LIMIT_ENTRY] Criando RP${i+1}: ${reductionQty.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(pricePrecision)}`);
          
          const rpResponse = await newReduceOnlyOrder(
            numericAccountId, 
            signal.symbol, 
            reductionQty, 
            binanceOppositeSide, 
            rpPrice
          );
          
          if (rpResponse && rpResponse.data && rpResponse.data.orderId) {
            cumulativeQtyForRps += reductionQty;
            console.log(`[LIMIT_ENTRY] RP${i+1} criada com sucesso: ${rpResponse.data.orderId}`);
            
            const rpOrderData = { 
              tipo_ordem: 'LIMIT', 
              preco: rpPrice, 
              quantidade: reductionQty, 
              id_posicao: positionId, 
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()), 
              id_externo: String(rpResponse.data.orderId).substring(0,90), 
              side: binanceOppositeSide,
              simbolo: signal.symbol, 
              tipo_ordem_bot: 'REDUCAO_PARCIAL', 
              target: i + 1, 
              reduce_only: true, 
              close_position: false, 
              orign_sig: `WEBHOOK_${signal.id}`,
              last_update: formatDateForMySQL(new Date())
            };
            await insertNewOrder(connection, rpOrderData);
            
          } else {
            console.warn(`[LIMIT_ENTRY] RP${i+1} falhou - resposta inválida:`, rpResponse);
          }
        } catch (rpError) {
          console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.message);
        }
      }
      
      // ✅ CRIAR TAKE PROFIT FINAL (TP5) COM QUANTIDADE RESTANTE USANDO TAKE_PROFIT_MARKET
      const remainingQtyForFinalTp = totalFilledSize - cumulativeQtyForRps;
      
      if (remainingQtyForFinalTp > 0.000001 && targetPrices.tp5) {
        // VALIDAR DIREÇÃO DO TP FINAL
        const isFinalTpValidForDirection = binanceSide === 'BUY' ? 
          targetPrices.tp5 > averageEntryPrice : 
          targetPrices.tp5 < averageEntryPrice;
          
        if (isFinalTpValidForDirection) {
          try {
            console.log(`[LIMIT_ENTRY] Criando TP FINAL: ${remainingQtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${targetPrices.tp5.toFixed(pricePrecision)}`);
            
            // ✅ USAR TAKE_PROFIT_MARKET EM VEZ DE LIMIT
            const finalTpResponse = await newStopOrder(
              numericAccountId, 
              signal.symbol, 
              remainingQtyForFinalTp, 
              binanceOppositeSide, 
              targetPrices.tp5,
              null, // price
              true, // reduceOnly
              false // closePosition
            );
            
            if (finalTpResponse && finalTpResponse.data && finalTpResponse.data.orderId) {
              console.log(`[LIMIT_ENTRY] TP FINAL criado com sucesso: ${finalTpResponse.data.orderId}`);
              
              const finalTpOrderData = { 
                tipo_ordem: 'TAKE_PROFIT_MARKET', 
                preco: targetPrices.tp5, 
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
          }
        } else {
          console.log(`[LIMIT_ENTRY] TP FINAL pulado - preço ${targetPrices.tp5} inválido para ${binanceSide} (entry: ${averageEntryPrice})`);
        }
      } else {
        console.log(`[LIMIT_ENTRY] TP FINAL pulado - quantidade restante: ${remainingQtyForFinalTp}, TP5: ${targetPrices.tp5}`);
      }
      
      console.log(`[LIMIT_ENTRY] Resumo das ordens criadas:`);
      console.log(`  - SL: ${slPriceVal ? 'Criado' : 'Não configurado'}`);
      console.log(`  - RPs criadas: quantidade total = ${cumulativeQtyForRps.toFixed(quantityPrecision)}`);
      console.log(`  - TP Final: ${remainingQtyForFinalTp > 0.000001 && targetPrices.tp5 ? 'Criado' : 'Não criado'}`);
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
    // ...restante do bloco catch e recovery
    
    // ✅ GARANTIR PRECISÃO PARA RECOVERY
    if (!precision) precision = await getPrecision(signal.symbol, numericAccountId);
    
    const originalErrorMessage = error.message || String(error);
    console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`, error.stack || error);
    
    // ✅ GARANTIR VARIÁVEIS NO RECOVERY
    const recoveryAccountId = numericAccountId || accountId || parseInt(accountId) || 1;
    const recoveryQuantityPrecision = quantityPrecision || precision?.quantityPrecision || 3;
    const recoveryPricePrecision = pricePrecision || precision?.pricePrecision || 2;
    const recoveryBinanceSide = binanceSide || (signal.side === 'COMPRA' ? 'BUY' : 'SELL');
    
    // ... restante do código de recovery
    
  } finally {
    // REMOVER O HANDLER WEBSOCKET PERSONALIZADO
    try {
      const existingHandlers = websockets.getHandlers(accountId) || {};
      if (existingHandlers.originalOrderUpdateHandler) {
        const cleanedHandlers = {
          ...existingHandlers,
          handleOrderUpdate: existingHandlers.originalOrderUpdateHandler
        };
        delete cleanedHandlers.originalOrderUpdateHandler;
        websockets.setMonitoringCallbacks(cleanedHandlers, accountId);
      }
    } catch (handlerError) {
      console.error(`[LIMIT_ENTRY] Erro ao restaurar handlers WebSocket:`, handlerError.message);
    }
    
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