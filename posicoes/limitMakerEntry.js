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

    // ===== FLUXO PRINCIPAL DE ENTRADA - VERSÃO CORRIGIDA =====
    console.log(`[LIMIT_ENTRY] 🔄 Iniciando fluxo de entrada principal - Quantidade alvo: ${totalEntrySize.toFixed(quantityPrecision)}`);
    
    let entryCompleted = false;
    activeOrderId = null;
    chaseAttempts = 0;
    executionStartTime = Date.now();
    
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
      
      // CRIAR STOP LOSS
      if (slPriceVal && slPriceVal > 0) {
        try {
          console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize} ${signal.symbol} @ ${slPriceVal}`);
          
          // TENTAR USAR newStopOrder, SE FALHAR USAR ALTERNATIVA
          let stopOrderResult;
          try {
            stopOrderResult = await newStopOrder(
              numericAccountId,
              signal.symbol,
              totalFilledSize,
              binanceOppositeSide,
              slPriceVal,
              null, // stopPrice = triggerPrice
              true  // reduceOnly
            );
          } catch (stopOrderError) {
            console.warn(`[LIMIT_ENTRY] newStopOrder falhou, tentando método alternativo:`, stopOrderError.message);
            
            // MÉTODO ALTERNATIVO: Usar API direta
            const api = require('../api');
            stopOrderResult = await api.makeAuthenticatedRequest(numericAccountId, 'POST', '/v1/order', {
              symbol: signal.symbol,
              side: binanceOppositeSide,
              type: 'STOP_MARKET',
              quantity: totalFilledSize.toFixed(quantityPrecision),
              stopPrice: slPriceVal.toFixed(pricePrecision),
              reduceOnly: 'true',
              timeInForce: 'GTC'
            });
          }
          
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

      // CRIAR TAKE PROFITS
      const targetPrices = {
        tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
        tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
        tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
        tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
        tp5: (() => {
          const tp5Val = signal.tp5_price ? parseFloat(signal.tp5_price) : null;
          const tpVal = signal.tp_price ? parseFloat(signal.tp_price) : null;
          
          if (tp5Val && tp5Val > 0) return tp5Val;
          if (tpVal && tpVal > 0) return tpVal;
          
          return null;
        })()
      };

      // DEBUG: Log dos target prices
      console.log(`[LIMIT_ENTRY] Target Prices detectados:`, {
        tp1: targetPrices.tp1,
        tp2: targetPrices.tp2, 
        tp3: targetPrices.tp3,
        tp4: targetPrices.tp4,
        tp5: targetPrices.tp5,
        originalTpPrice: signal.tp_price,
        originalTp5Price: signal.tp5_price
      });

      // CRIAR REDUÇÕES PARCIAIS
      const reductionPercentages = [0.25, 0.30, 0.25, 0.10];
      let cumulativeQtyForRps = 0;
      
      // ✅ OBTER QUANTIDADE MÍNIMA DO EXCHANGE INFO
      const precisionForRps = await getPrecisionCached(signal.symbol, numericAccountId);
      const exchangeMinQty = precisionForRps.minQty || 0.001;
      
      console.log(`[LIMIT_ENTRY] Quantidade mínima do exchange para ${signal.symbol}: ${exchangeMinQty}`);
      
      // AJUSTAR QUANTIDADE MÍNIMA BASEADA NO TOTAL PREENCHIDO E NO EXCHANGE
      let minQtyForRp;
      if (totalFilledSize >= (exchangeMinQty * 4)) {
        minQtyForRp = exchangeMinQty;
      } else {
        minQtyForRp = Math.max(exchangeMinQty, totalFilledSize * 0.20);
      }
      
      console.log(`[LIMIT_ENTRY] Total preenchido para RPs: ${totalFilledSize}, Quantidade mínima ajustada por RP: ${minQtyForRp.toFixed(quantityPrecision)}, Exchange minQty: ${exchangeMinQty}`);
      
      // ✅ USAR exchangeMinQty EM VEZ DE 0.004
      if (totalFilledSize < (exchangeMinQty * 4)) {
        console.log(`[LIMIT_ENTRY] ⚠️ Posição muito pequena (${totalFilledSize}) comparada ao mínimo do exchange (${exchangeMinQty}), criando apenas 2 RPs maiores em vez de 4 pequenas`);
        
        // ESTRATÉGIA ALTERNATIVA: 2 RPs de 40% cada, deixando 20% para TP final
        let rp1Qty = parseFloat((totalFilledSize * 0.4).toFixed(quantityPrecision));
        let rp2Qty = parseFloat((totalFilledSize * 0.4).toFixed(quantityPrecision));
        
        console.log(`[LIMIT_ENTRY] Quantidades calculadas - RP1: ${rp1Qty}, RP2: ${rp2Qty}, Mínimo: ${minQtyForRp}`);
        
        // ✅ VALIDAR E AJUSTAR RP1
        if (targetPrices.tp1 && targetPrices.tp1 > averageEntryPrice) {
          const rp1Validation = await validateQuantity(signal.symbol, rp1Qty, targetPrices.tp1, numericAccountId, 'LIMIT');
          
          if (!rp1Validation.isValid) {
            console.warn(`[LIMIT_ENTRY] RP1 quantidade inválida: ${rp1Validation.reason}`);
            
            const rp1Adjustment = await adjustQuantityToRequirements(signal.symbol, rp1Qty, targetPrices.tp1, numericAccountId, 'LIMIT');
            
            if (rp1Adjustment.success) {
              rp1Qty = rp1Adjustment.adjustedQuantity;
              console.log(`[LIMIT_ENTRY] RP1 quantidade ajustada: ${rp1Adjustment.originalQuantity} → ${rp1Qty}`);
            } else {
              console.warn(`[LIMIT_ENTRY] RP1 não pode ser ajustada: ${rp1Adjustment.error}. Pulando RP1.`);
              rp1Qty = 0;
            }
          }
          
          if (rp1Qty > 0) {
            try {
              console.log(`[LIMIT_ENTRY] Criando RP1 alternativa (40%): ${rp1Qty} ${signal.symbol} @ ${targetPrices.tp1}`);
              
              const rp1Response = await newReduceOnlyOrder(
                numericAccountId, 
                signal.symbol, 
                rp1Qty, 
                binanceOppositeSide, 
                targetPrices.tp1
              );
              
              if (rp1Response && rp1Response.data && rp1Response.data.orderId) {
                cumulativeQtyForRps += rp1Qty;
                console.log(`[LIMIT_ENTRY] RP1 alternativa criada: ${rp1Response.data.orderId}`);
                
                // SALVAR NO BANCO
                const rp1OrderData = { 
                  tipo_ordem: 'LIMIT', 
                  preco: targetPrices.tp1, 
                  quantidade: rp1Qty, 
                  id_posicao: positionId, 
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()), 
                  id_externo: String(rp1Response.data.orderId).substring(0,90), 
                  side: binanceOppositeSide,
                  simbolo: signal.symbol, 
                  tipo_ordem_bot: 'REDUCAO_PARCIAL', 
                  target: 1, 
                  reduce_only: true, 
                  close_position: false, 
                  orign_sig: `WEBHOOK_${signal.id}`,
                  last_update: formatDateForMySQL(new Date())
                };
                await insertNewOrder(connection, rp1OrderData);
                
              } else {
                console.warn(`[LIMIT_ENTRY] RP1 alternativa falhou - resposta inválida:`, rp1Response);
              }
            } catch (rp1Error) {
              console.error(`[LIMIT_ENTRY] Erro ao criar RP1 alternativa:`, rp1Error.message);
            }
          }
        } else {
          console.log(`[LIMIT_ENTRY] RP1 alternativa pulada - TP1: ${targetPrices.tp1}, EntryPrice: ${averageEntryPrice}`);
        }
        
        // ✅ VALIDAR E AJUSTAR RP2  
        if (targetPrices.tp2 && targetPrices.tp2 > averageEntryPrice) {
          const rp2Validation = await validateQuantity(signal.symbol, rp2Qty, targetPrices.tp2, numericAccountId, 'LIMIT');
          
          if (!rp2Validation.isValid) {
            console.warn(`[LIMIT_ENTRY] RP2 quantidade inválida: ${rp2Validation.reason}`);
            
            const rp2Adjustment = await adjustQuantityToRequirements(signal.symbol, rp2Qty, targetPrices.tp2, numericAccountId, 'LIMIT');
            
            if (rp2Adjustment.success) {
              rp2Qty = rp2Adjustment.adjustedQuantity;
              console.log(`[LIMIT_ENTRY] RP2 quantidade ajustada: ${rp2Adjustment.originalQuantity} → ${rp2Qty}`);
            } else {
              console.warn(`[LIMIT_ENTRY] RP2 não pode ser ajustada: ${rp2Adjustment.error}. Pulando RP2.`);
              rp2Qty = 0;
            }
          }
          
          if (rp2Qty > 0) {
            try {
              console.log(`[LIMIT_ENTRY] Criando RP2 alternativa (40%): ${rp2Qty} ${signal.symbol} @ ${targetPrices.tp2}`);
              
              const rp2Response = await newReduceOnlyOrder(
                numericAccountId, 
                signal.symbol, 
                rp2Qty, 
                binanceOppositeSide, 
                targetPrices.tp2
              );
              
              if (rp2Response && rp2Response.data && rp2Response.data.orderId) {
                cumulativeQtyForRps += rp2Qty;
                console.log(`[LIMIT_ENTRY] RP2 alternativa criada: ${rp2Response.data.orderId}`);
                
                // SALVAR NO BANCO
                const rp2OrderData = { 
                  tipo_ordem: 'LIMIT', 
                  preco: targetPrices.tp2, 
                  quantidade: rp2Qty, 
                  id_posicao: positionId, 
                  status: 'NEW',
                  data_hora_criacao: formatDateForMySQL(new Date()), 
                  id_externo: String(rp2Response.data.orderId).substring(0,90), 
                  side: binanceOppositeSide,
                  simbolo: signal.symbol, 
                  tipo_ordem_bot: 'REDUCAO_PARCIAL', 
                  target: 2, 
                  reduce_only: true, 
                  close_position: false, 
                  orign_sig: `WEBHOOK_${signal.id}`,
                  last_update: formatDateForMySQL(new Date())
                };
                await insertNewOrder(connection, rp2OrderData);
                
              } else {
                console.warn(`[LIMIT_ENTRY] RP2 alternativa falhou - resposta inválida:`, rp2Response);
              }
            } catch (rp2Error) {
              console.error(`[LIMIT_ENTRY] Erro ao criar RP2 alternativa:`, rp2Error.message);
            }
          }
        } else {
          console.log(`[LIMIT_ENTRY] RP2 alternativa pulada - TP2: ${targetPrices.tp2}, EntryPrice: ${averageEntryPrice}`);
        }
        
        console.log(`[LIMIT_ENTRY] RPs alternativas finalizadas. Total para RPs: ${cumulativeQtyForRps.toFixed(quantityPrecision)}`);
        
      } else {
        // ✅ ESTRATÉGIA PADRÃO COM VALIDAÇÃO (PARA POSIÇÕES GRANDES)
        console.log(`[LIMIT_ENTRY] Posição grande (${totalFilledSize} ≥ ${(exchangeMinQty * 4).toFixed(quantityPrecision)}), criando 4 RPs padrão`);
        
        for (let i = 0; i < rpTargetKeys.length; i++) {
          const rpKey = rpTargetKeys[i];
          const rpPrice = targetPrices[rpKey];
          
          // ✅ CORREÇÃO: Adicionar validação de preço
          if (rpPrice && rpPrice > averageEntryPrice && i < reductionPercentages.length) {
            const reductionPercent = reductionPercentages[i];
            let reductionQtyRaw = totalFilledSize * reductionPercent;
            let reductionQty = parseFloat(reductionQtyRaw.toFixed(quantityPrecision));
            
            console.log(`[LIMIT_ENTRY] Calculando RP${i+1}: ${reductionPercent*100}% de ${totalFilledSize} = ${reductionQtyRaw} → ${reductionQty}`);
            
            // ✅ VALIDAR QUANTIDADE DA RP
            const rpValidation = await validateQuantity(signal.symbol, reductionQty, rpPrice, numericAccountId, 'LIMIT');
            
            if (!rpValidation.isValid) {
              console.warn(`[LIMIT_ENTRY] RP${i+1} quantidade inválida: ${rpValidation.reason}`);
              
              const rpAdjustment = await adjustQuantityToRequirements(signal.symbol, reductionQty, rpPrice, numericAccountId, 'LIMIT');
              
              if (rpAdjustment.success) {
                reductionQty = rpAdjustment.adjustedQuantity;
                console.log(`[LIMIT_ENTRY] RP${i+1} quantidade ajustada: ${rpAdjustment.originalQuantity} → ${reductionQty}`);
              } else {
                console.warn(`[LIMIT_ENTRY] RP${i+1} não pode ser ajustada: ${rpAdjustment.error}. Pulando.`);
                continue;
              }
            }
            
            if (reductionQty <= 0) {
              console.log(`[LIMIT_ENTRY] RP${i+1} quantidade zero após validação. Pulando.`);
              continue;
            }
            
            cumulativeQtyForRps += reductionQty;
            
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
                console.log(`[LIMIT_ENTRY] RP${i+1} criada: ${rpResponse.data.orderId}`);
                
                // SALVAR NO BANCO
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
                
              }
            } catch (rpError) { 
              console.warn(`[LIMIT_ENTRY] Pulando RP${i+1} devido a preço inválido ou menor que a entrada. Preço: ${rpPrice}, Entrada: ${averageEntryPrice}`);
            }
          }
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
    
    // ✅ GARANTIR VARIÁVEIS NO RECOVERY
    const recoveryAccountId = numericAccountId || accountId || parseInt(accountId) || 1;
    const recoveryQuantityPrecision = quantityPrecision || 3;
    const recoveryPricePrecision = pricePrecision || 2;
    const recoveryBinanceSide = binanceSide || (signal.side === 'COMPRA' ? 'BUY' : 'SELL');
    
    console.log(`[LIMIT_ENTRY_RECOVERY] Usando recoveryAccountId: ${recoveryAccountId}`);
    
    if (positionId && totalFilledSize > 0 && averageEntryPrice > 0) {
      console.warn(`[LIMIT_ENTRY_RECOVERY] Tentando SALVAR POSIÇÃO ${positionId} (${totalFilledSize.toFixed(recoveryQuantityPrecision)} ${signal.symbol} @ ${averageEntryPrice.toFixed(recoveryPricePrecision)}) apesar do erro: ${originalErrorMessage}`);
      
      try {
        const binanceOppositeSide = recoveryBinanceSide === 'BUY' ? 'SELL' : 'BUY';
        const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
        
        if (slPriceVal && slPriceVal > 0) {
          console.log(`[LIMIT_ENTRY_RECOVERY] Criando SL de emergência: ${totalFilledSize.toFixed(recoveryQuantityPrecision)} @ ${slPriceVal.toFixed(recoveryPricePrecision)}`);
          
          // ✅ USAR recoveryAccountId que está garantidamente definido
          const slResponse = await newStopOrder(
            recoveryAccountId,
            signal.symbol,
            totalFilledSize,
            binanceOppositeSide,
            slPriceVal,
            null,
            true
          );
          
          if (slResponse && slResponse.data && slResponse.data.orderId) {
            console.log(`[LIMIT_ENTRY_RECOVERY] ✅ SL de emergência criado: ${slResponse.data.orderId}`);
            
            const slOrderData = {
              tipo_ordem: 'STOP_MARKET',
              preco: slPriceVal,
              quantidade: totalFilledSize,
              id_posicao: positionId,
              status: 'NEW',
              data_hora_criacao: formatDateForMySQL(new Date()),
              id_externo: String(slResponse.data.orderId),
              side: binanceOppositeSide,
              simbolo: signal.symbol,
              tipo_ordem_bot: 'STOP_LOSS',
              target: null,
              reduce_only: true,
              close_position: false,
              last_update: formatDateForMySQL(new Date()),
              orign_sig: `WEBHOOK_${signal.id}_RECOVERY`
            };
            
            // ✅ VERIFICAR SE CONNECTION EXISTE ANTES DE USAR
            if (connection) {
              await insertNewOrder(connection, slOrderData);
            }
          }
        }
        
        // CRIAR TP DE EMERGÊNCIA SE DISPONÍVEL
        const finalTpPriceVal = signal.tp_price ? parseFloat(signal.tp_price) : (signal.tp5_price ? parseFloat(signal.tp5_price) : null);
        if (finalTpPriceVal && finalTpPriceVal > 0) {
          console.log(`[LIMIT_ENTRY_RECOVERY] Criando TP de emergência: ${totalFilledSize.toFixed(recoveryQuantityPrecision)} @ ${finalTpPriceVal.toFixed(recoveryPricePrecision)}`);
          
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
        await cancelOrder(recoveryAccountId, signal.symbol, activeOrderId); // ✅ USAR recoveryAccountId
        console.log(`[LIMIT_ENTRY] ✅ Ordem ${activeOrderId} cancelada`);
      } catch (cancelError) {
        console.error(`[LIMIT_ENTRY] Erro ao cancelar ordem ${activeOrderId}:`, cancelError.message);
      }
    }
    
    // ROLLBACK E ATUALIZAÇÃO DO STATUS
    if (connection) {
      try {
        await connection.rollback();
        console.log(`[LIMIT_ENTRY] ROLLBACK executado para sinal ${signal.id}`);
      } catch (rollbackError) {
        console.error(`[LIMIT_ENTRY] Erro no rollback:`, rollbackError.message);
      }
      
      try {
        await connection.query(
          'UPDATE webhook_signals SET status = ?, error_message = ? WHERE id = ?',
          ['ERROR', originalErrorMessage.substring(0, 250), signal.id]
        );
      } catch (updateError) {
        console.error(`[LIMIT_ENTRY] Erro ao atualizar status:`, updateError.message);
      }
    }
    
    return { success: false, error: originalErrorMessage };

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