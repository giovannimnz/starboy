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
  
  // Constantes de configuração
  const MAX_CHASE_ATTEMPTS = 100;
  const CHASE_TIMEOUT_MS = 180000; // 3 minutos
  const WAIT_FOR_EXECUTION_TIMEOUT_MS = 5000;
  const EDIT_WAIT_TIMEOUT_MS = 3000;
  const MAX_DEPTH_STALENESS_MS = 3000;
  const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.999;
  
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

  try {
    // VALIDAÇÃO INICIAL CRÍTICA
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido em executeLimitMakerEntry: ${accountId} (tipo: ${typeof accountId})`);
    }
    
    if (!signal || !signal.id || !signal.symbol) {
      throw new Error(`Signal inválido: ${JSON.stringify(signal)}`);
    }
    
    // ✅ DEFINIR numericAccountId LOGO NO INÍCIO
    const numericAccountId = parseInt(accountId) || accountId;
    
    console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol}) na conta ${accountId}`);
    
    // OBTER CONEXÃO DO BANCO PARA A CONTA ESPECÍFICA
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
    }
    
    connection = await db.getConnection();
    // ✅ REMOVER ESTA LINHA DUPLICADA: const numericAccountId = parseInt(accountId) || accountId;
    
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

    const availableBalance = await getAvailableBalance(numericAccountId);
    const capitalPercentage = parseFloat(signal.capital_pct) / 100;
    const leverage = parseInt(signal.leverage); 
    
    // OBTER PREÇO ATUAL
    const currentPriceTrigger = signal.price || signal.entry_price || await api.getPrice(signal.symbol, numericAccountId);
    
    if (!currentPriceTrigger || currentPriceTrigger <= 0) {
      throw new Error(`Preço inválido para ${signal.symbol}: ${currentPriceTrigger}`);
    }
    
    totalEntrySize = calculateOrderSize(
      availableBalance, capitalPercentage, currentPriceTrigger, leverage, quantityPrecision
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
        totalEntrySize = adjustment.adjustedQuantity;
      } else {
        throw new Error(`Quantidade de entrada inválida para ${signal.symbol}: ${entryValidation.reason}. Não foi possível ajustar automaticamente: ${adjustment.error}`);
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

    // AGUARDAR DADOS DO WEBSOCKET COM RETRY MELHORADO (COMO VERSÃO ANTIGA)
    const MAX_RETRY_ATTEMPTS = 30; // Aumentado de 10 para 30
    const RETRY_INTERVAL_MS = 500; // Aumentado de 200 para 500ms
    let wsRetryCount = 0;
    let hasValidBookData = false;
    
    // FALLBACK: Obter dados via REST API
    let fallbackBid = null;
    let fallbackAsk = null;
    
    try {
      console.log(`[LIMIT_ENTRY] Obtendo dados de preço via REST API como fallback...`);
      const currentMarketPrice = await api.getPrice(signal.symbol, numericAccountId);
      if (currentMarketPrice && currentMarketPrice > 0) {
        const spread = currentMarketPrice * 0.0001; // Spread menor para ser mais preciso
        fallbackBid = currentMarketPrice - spread;
        fallbackAsk = currentMarketPrice + spread;
        console.log(`[LIMIT_ENTRY] Dados de fallback: Bid=${fallbackBid.toFixed(pricePrecision)}, Ask=${fallbackAsk.toFixed(pricePrecision)}`);
      }
    } catch (priceError) {
      console.warn(`[LIMIT_ENTRY] Erro ao obter preço de fallback:`, priceError.message);
    }

    // AGUARDAR DADOS VÁLIDOS DO WEBSOCKET - VERSÃO MELHORADA
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
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 180000; // 3 minutos
    const executionStartTime = Date.now();
    
    // LOOP PRINCIPAL - PERSEGUIR PREÇO ATÉ COMPLETAR A ENTRADA
    while (!entryCompleted && 
           chaseAttempts < MAX_CHASE_ATTEMPTS && 
           (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
      
      chaseAttempts++;
      console.log(`[LIMIT_ENTRY] 🔄 Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS} - Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} (${((totalFilledSize/totalEntrySize)*100).toFixed(1)}%)`);
      
      // ===== ETAPA 1: SINCRONIZAR PREENCHIMENTOS EXISTENTES =====
      try {
        const recentOrders = await getRecentOrders(numericAccountId, signal.symbol, 20);
        
        // Filtrar ordens relevantes (FILLED e do lado correto)
        const relevantFills = recentOrders.filter(order =>
          order.status === 'FILLED' &&
          order.side === binanceSide &&
          parseFloat(order.executedQty) > 0 &&
          order.updateTime >= executionStartTime &&
          !partialFills.some(fill => fill.orderId === String(order.orderId))
        );
        
        // Contabilizar novos preenchimentos
        for (const order of relevantFills) {
          const qty = parseFloat(order.executedQty);
          const price = parseFloat(order.avgPrice || order.price);
          
          partialFills.push({
            qty: qty,
            price: price,
            orderId: String(order.orderId)
          });
          
          console.log(`[LIMIT_ENTRY] ✅ Novo preenchimento: ${qty.toFixed(quantityPrecision)} @ ${price.toFixed(pricePrecision)} (ID: ${order.orderId})`);
        }
        
        // Recalcular total preenchido
        totalFilledSize = partialFills.reduce((sum, fill) => sum + fill.qty, 0);
        
        if (partialFills.length > 0) {
          averageEntryPrice = calculateAveragePrice(partialFills);
        }
        
      } catch (syncError) {
        console.warn(`[LIMIT_ENTRY] Erro ao sincronizar preenchimentos:`, syncError.message);
      }
      
      // ===== ETAPA 2: VERIFICAR SE ENTRADA FOI COMPLETADA =====
      const remainingQuantity = totalEntrySize - totalFilledSize;
      
      if (remainingQuantity <= 0.000001) { // Tolerância para arredondamentos
        console.log(`[LIMIT_ENTRY] ✅ ENTRADA COMPLETADA! Total preenchido: ${totalFilledSize.toFixed(quantityPrecision)}`);
        entryCompleted = true;
        break;
      }
      
      console.log(`[LIMIT_ENTRY] Quantidade restante: ${remainingQuantity.toFixed(quantityPrecision)}`);
      
      // ===== ETAPA 3: VALIDAR DADOS DO BOOK =====
      const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
      if (isDepthDataStale || !currentBestBid || !currentBestAsk) {
        console.log(`[LIMIT_ENTRY] ⏳ Aguardando dados atualizados do book...`);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      
      // ===== ETAPA 4: CALCULAR PREÇO IDEAL PARA ORDEM =====
      let targetPrice;
      const spread = currentBestAsk - currentBestBid;
      const spreadPercent = (spread / currentBestBid) * 100;
      
      if (binanceSide === 'BUY') {
        // Para BUY: tentar ficar à frente do melhor bid
        if (spread > tickSize * 2) {
          // Se spread é grande, posicionar dentro do spread
          targetPrice = currentBestBid + tickSize;
          
          // Garantir que não ultrapasse o ask (seria taker)
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
          
          // Garantir que não ultrapasse o bid (seria taker)
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
      
      // ===== ETAPA 5: GERENCIAR ORDEM ATIVA =====
      if (activeOrderId) {
        console.log(`[LIMIT_ENTRY] Verificando ordem ativa: ${activeOrderId}`);
        
        try {
          const orderStatus = await getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
          
          if (orderStatus.status === 'FILLED') {
            console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} foi executada completamente`);
            
            // Contabilizar se ainda não foi contabilizada
            const alreadyAccountedQty = partialFills
              .filter(fill => fill.orderId === activeOrderId)
              .reduce((sum, fill) => sum + fill.qty, 0);
            
            const executedQty = parseFloat(orderStatus.executedQty || '0');
            const newQty = executedQty - alreadyAccountedQty;
            
            if (newQty > 0) {
              const execPrice = parseFloat(orderStatus.avgPrice || orderStatus.price);
              partialFills.push({
                qty: newQty,
                price: execPrice,
                orderId: activeOrderId
              });
              console.log(`[LIMIT_ENTRY] Contabilizado: ${newQty.toFixed(quantityPrecision)} @ ${execPrice.toFixed(pricePrecision)}`);
            }
            
            activeOrderId = null;
            continue; // Verificar se precisa de mais ordens
            
          } else if (orderStatus.status === 'PARTIALLY_FILLED') {
            console.log(`[LIMIT_ENTRY] ⚠️ Ordem ${activeOrderId} parcialmente preenchida`);
            
            // Contabilizar preenchimento parcial
            const alreadyAccountedQty = partialFills
              .filter(fill => fill.orderId === activeOrderId)
              .reduce((sum, fill) => sum + fill.qty, 0);
            
            const executedQty = parseFloat(orderStatus.executedQty || '0');
            const newQty = executedQty - alreadyAccountedQty;
            
            if (newQty > 0) {
              const execPrice = parseFloat(orderStatus.avgPrice || orderStatus.price);
              partialFills.push({
                qty: newQty,
                price: execPrice,
                orderId: activeOrderId
              });
              console.log(`[LIMIT_ENTRY] Contabilizado preenchimento parcial: ${newQty.toFixed(quantityPrecision)} @ ${execPrice.toFixed(pricePrecision)}`);
            }
            
            // ESTRATÉGIA: Cancelar ordem parcial e criar nova com quantidade restante
            console.log(`[LIMIT_ENTRY] Cancelando ordem parcial para recriar com novo preço...`);
            
            try {
              await cancelOrder(signal.symbol, activeOrderId, numericAccountId);
              console.log(`[LIMIT_ENTRY] ✅ Ordem parcial ${activeOrderId} cancelada`);
            } catch (cancelError) {
              console.warn(`[LIMIT_ENTRY] Erro ao cancelar ordem parcial:`, cancelError.message);
            }
            
            activeOrderId = null;
            continue; // Criar nova ordem no próximo loop
            
          } else if (orderStatus.status === 'NEW') {
            // Verificar se preço precisa ser reposicionado
            const currentOrderPrice = parseFloat(orderStatus.price);
            const priceNeedsUpdate = Math.abs(currentOrderPrice - targetPrice) >= tickSize;
            
            if (priceNeedsUpdate) {
              console.log(`[LIMIT_ENTRY] 🔄 Reposicionando ordem ${activeOrderId}: ${currentOrderPrice.toFixed(pricePrecision)} → ${targetPrice.toFixed(pricePrecision)}`);
              
              try {
                // Calcular quantidade restante baseada na ordem ativa
                const origQty = parseFloat(orderStatus.origQty);
                const remainingQtyForEdit = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                
                // Editar ordem (que cancelará e recriará se necessário)
                const editResult = await editOrder(
                  numericAccountId,
                  signal.symbol,
                  activeOrderId,
                  targetPrice,
                  binanceSide,
                  remainingQtyForEdit
                );
                
                if (editResult.wasPartiallyFilled) {
                  // Se ordem foi cancelada por ser parcial, usar nova ordem ID
                  activeOrderId = String(editResult.orderId);
                  console.log(`[LIMIT_ENTRY] Ordem recriada devido preenchimento parcial: ${activeOrderId}`);
                } else {
                  // Se foi apenas editada, manter o ID (ou usar novo se mudou)
                  activeOrderId = String(editResult.orderId || activeOrderId);
                  console.log(`[LIMIT_ENTRY] Ordem editada: ${activeOrderId}`);
                }
                
              } catch (editError) {
                console.error(`[LIMIT_ENTRY] Erro ao editar ordem ${activeOrderId}:`, editError.message);
                activeOrderId = null; // Forçar criação de nova ordem
              }
            } else {
              console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} já está no preço correto, aguardando...`);
            }
            
          } else {
            // Status inválido (CANCELED, REJECTED, etc.)
            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} tem status inválido: ${orderStatus.status}`);
            activeOrderId = null;
          }
          
        } catch (statusError) {
          console.error(`[LIMIT_ENTRY] Erro ao verificar status da ordem ${activeOrderId}:`, statusError.message);
          activeOrderId = null; // Assumir que ordem não existe mais
        }
      }
      
      // ===== ETAPA 6: CRIAR NOVA ORDEM SE NECESSÁRIO =====
      if (!activeOrderId) {
        const quantityToOrder = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
        
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
            const adjustedQty = adjustment.adjustedQuantity;
            console.log(`[LIMIT_ENTRY] Quantidade ajustada: ${quantityToOrder} → ${adjustedQty}`);
            
            try {
              console.log(`[LIMIT_ENTRY] 📤 Criando nova ordem: ${binanceSide} ${adjustedQty} @ ${targetPrice.toFixed(pricePrecision)}`);
              
              const orderResponse = await newLimitMakerOrder(
                numericAccountId,
                signal.symbol,
                adjustedQty,
                binanceSide,
                targetPrice
              );
              
              if (orderResponse && (orderResponse.orderId || orderResponse.data?.orderId)) {
                activeOrderId = String(orderResponse.orderId || orderResponse.data.orderId);
                console.log(`[LIMIT_ENTRY] ✅ Nova ordem criada: ${activeOrderId}`);
              } else {
                console.error(`[LIMIT_ENTRY] ❌ Resposta inválida ao criar ordem:`, orderResponse);
              }
              
            } catch (orderError) {
              console.error(`[LIMIT_ENTRY] ❌ Erro ao criar ordem:`, orderError.message);
              
              // Se for erro de Post-Only (seria taker), aguardar um pouco
              if (orderError.message && orderError.message.includes('immediately match')) {
                console.log(`[LIMIT_ENTRY] Preço seria taker, aguardando book mudar...`);
                await new Promise(resolve => setTimeout(resolve, 1000));
              }
            }
          } else {
            console.error(`[LIMIT_ENTRY] ❌ Não foi possível ajustar quantidade: ${adjustment.error}`);
            break; // Sair do loop se não conseguir ajustar
          }
        } else {
          // Quantidade válida, criar ordem
          try {
            console.log(`[LIMIT_ENTRY] 📤 Criando nova ordem: ${binanceSide} ${quantityToOrder} @ ${targetPrice.toFixed(pricePrecision)}`);
            
            const orderResponse = await newLimitMakerOrder(
              numericAccountId,
              signal.symbol,
              quantityToOrder,
              binanceSide,
              targetPrice
            );
            
            if (orderResponse && (orderResponse.orderId || orderResponse.data?.orderId)) {
              activeOrderId = String(orderResponse.orderId || orderResponse.data.orderId);
              console.log(`[LIMIT_ENTRY] ✅ Nova ordem criada: ${activeOrderId}`);
            } else {
              console.error(`[LIMIT_ENTRY] ❌ Resposta inválida ao criar ordem:`, orderResponse);
            }
            
          } catch (orderError) {
            console.error(`[LIMIT_ENTRY] ❌ Erro ao criar ordem:`, orderError.message);
            
            // Se for erro de Post-Only (seria taker), aguardar um pouco
            if (orderError.message && orderError.message.includes('immediately match')) {
              console.log(`[LIMIT_ENTRY] Preço seria taker, aguardando book mudar...`);
              await new Promise(resolve => setTimeout(resolve, 1000));
            }
          }
        }
      }
      
      // ===== ETAPA 7: AGUARDAR UM POUCO ANTES DA PRÓXIMA ITERAÇÃO =====
      await new Promise(resolve => setTimeout(resolve, 300)); // 300ms entre iterações
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
    
    // ===== REMOVER TODO O CÓDIGO DE "CHASING ATIVO FINAL" E "MARKET DE ÚLTIMO RECURSO" =====
    // A partir daqui, continuar com a criação da posição no banco e SL/TP/RPs...