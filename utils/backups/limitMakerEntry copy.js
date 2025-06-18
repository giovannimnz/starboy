const axios = require('axios');
const fs = require('fs').promises;
const { newEntryOrder, getRecentOrders, editOrder, roundPriceToTickSize, newLimitMakerOrder, newReduceOnlyOrder, cancelOrder, newStopOrder, getOpenOrders, getOrderStatus, getAllOpenPositions, getPrecision, getTickSize } = require('../api');
const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const websockets = require('../websockets');
const api = require('../api');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

/**
 * Executa entrada usando Limit Maker
 * @param {Object} db - Conexão com o banco de dados
 * @param {Object} signal - Sinal a ser processado
 * @param {number} currentPrice - Preço atual do mercado
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} Resultado da operação
 */
async function executeLimitMakerEntry(signal, accountId) {
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
    const CHASE_TIMEOUT_MS = 60000; // 1 minuto
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
        
        console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol}) na conta ${accountId}`);
        
        // OBTER CONEXÃO DO BANCO PARA A CONTA ESPECÍFICA
        const db = await getDatabaseInstance(accountId);
        if (!db) {
            throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
        }
        
        connection = await db.getConnection();
        const numericAccountId = parseInt(accountId) || accountId;
        
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
        
        binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
        
        await connection.query(
            `UPDATE webhook_signals SET status = 'ENTRADA_EM_PROGRESSO' WHERE id = ?`,
            [signal.id]
        );

        // CONFIGURAR WEBSOCKET DE PROFUNDIDADE
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
                
                console.log(`[LIMIT_ENTRY_DEPTH_WS] ✅ Dados válidos ${signal.symbol}: Bid=${bid.toFixed(pricePrecision)}, Ask=${ask.toFixed(pricePrecision)}, Spread=${spreadPercent.toFixed(4)}%`);
            } else {
                wsUpdateErrorCount++;
                console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos para ${signal.symbol}:`, depthData);
            }
        }, accountId);

        // AGUARDAR DADOS DO WEBSOCKET COM FALLBACK MELHORADO
        const MAX_RETRY_ATTEMPTS = 10;
        const RETRY_INTERVAL_MS = 200;
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
            await new Promise(resolve => setTimeout(resolve, RETRY_INTERVAL_MS));
        }
        
        // USAR FALLBACK SE WEBSOCKET FALHAR
        if (!hasValidBookData) {
            console.warn(`[LIMIT_ENTRY] ⚠️ BookTicker WebSocket falhou após ${MAX_RETRY_ATTEMPTS} tentativas. Usando fallback REST.`);
            
            if (fallbackBid && fallbackAsk) {
                currentBestBid = fallbackBid;
                currentBestAsk = fallbackAsk;
                hasValidBookData = true;
                console.log(`[LIMIT_ENTRY] ✅ Usando dados de fallback REST: Bid=${currentBestBid.toFixed(pricePrecision)}, Ask=${currentBestAsk.toFixed(pricePrecision)}`);
            } else {
                throw new Error(`Não foi possível obter dados de preço válidos nem via WebSocket nem via REST API para ${signal.symbol}`);
            }
        }

        // LOOP PRINCIPAL DE CHASING
        while (totalFilledSize < totalEntrySize && 
               chaseAttempts < MAX_CHASE_ATTEMPTS && 
               (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
            
            chaseAttempts++;

            // SINCRONIZAR PREENCHIMENTOS
            try {
                const recentOrders = await getRecentOrders(numericAccountId, signal.symbol, 15);
                
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
                        console.log(`[LIMIT_ENTRY] (Sync Recent) Contabilizado: ${qty.toFixed(quantityPrecision)} @ ${price.toFixed(pricePrecision)} (ID: ${exOrder.orderId}). Total agora: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    }
                }
                if (totalFilledSize >= totalEntrySize) {
                    console.log(`[LIMIT_ENTRY] (Sync Recent) Quantidade total atingida após sincronização.`);
                    break;
                }
            } catch (checkError) {
                console.error(`[LIMIT_ENTRY] Erro ao buscar/sincronizar ordens recentes:`, checkError.message);
            }

            const remainingSizeCurrentLoop = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
            if (remainingSizeCurrentLoop <= 0) {
                console.log(`[LIMIT_ENTRY] Quantidade restante zerada. Saindo do loop.`);
                break;
            }

            // VERIFICAR DADOS DO BOOK
            const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
            if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
                console.log(`[LIMIT_ENTRY] Dados do BookTicker obsoletos ou inválidos.`);
            }

            const bestBid = currentBestBid;
            const bestAsk = currentBestAsk;

            const tickSizeData = await getTickSize(signal.symbol, numericAccountId);
            const tickSize = parseFloat(tickSizeData.tickSize);
            
            // CALCULAR PREÇO MAKER MELHORADO
            let currentLocalMakerPrice;
            if (binanceSide === 'BUY') {
                // Para compras: posicionar dentro do spread quando possível
                const spreadSize = bestAsk - bestBid;
                const moreBidPrice = bestBid + tickSize;
                
                if (spreadSize > tickSize && moreBidPrice < bestAsk) {
                    currentLocalMakerPrice = moreBidPrice;
                    console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem BUY posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                } else {
                    currentLocalMakerPrice = bestBid;
                    console.log(`[LIMIT_ENTRY] Spread estreito. Posicionando ordem BUY no melhor bid: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                }
                
                // Verificação final para garantir ordem MAKER
                if (currentLocalMakerPrice >= bestAsk - tickSize) {
                    currentLocalMakerPrice = bestAsk - tickSize;
                    console.log(`[LIMIT_ENTRY] Ajuste: preço BUY ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                }
            } else { // SELL
                // Para vendas: posicionar dentro do spread quando possível
                const spreadSize = bestAsk - bestBid;
                const lessAskPrice = bestAsk - tickSize;
                
                if (spreadSize > tickSize && lessAskPrice > bestBid) {
                    currentLocalMakerPrice = lessAskPrice;
                    console.log(`[LIMIT_ENTRY] Estratégia agressiva: Ordem SELL posicionada DENTRO do spread a ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                } else {
                    currentLocalMakerPrice = bestAsk;
                    console.log(`[LIMIT_ENTRY] Spread estreito. Posicionando ordem SELL no melhor ask: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                }
                
                // Verificação final para garantir ordem MAKER
                if (currentLocalMakerPrice <= bestBid + tickSize) {
                    currentLocalMakerPrice = bestBid + tickSize;
                    console.log(`[LIMIT_ENTRY] Ajuste: preço SELL ajustado para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                }
            }

            currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice, numericAccountId);

            console.log(`[LIMIT_ENTRY] Preço MAKER ${binanceSide}: ${currentLocalMakerPrice.toFixed(pricePrecision)} | Book: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}`);

            let orderPlacedOrEditedThisIteration = false;

            // GERENCIAMENTO DE ORDENS ATIVAS
            if (activeOrderId) {
                let currentOrderDataFromExchange;
                try {
                    currentOrderDataFromExchange = await api.getOrderStatus(signal.symbol, activeOrderId, numericAccountId);
                } catch (e) {
                    if (e.status === 400 && e.error?.code === -2013) {
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} não encontrada. Possivelmente cancelada.`);
                        activeOrderId = null;
                        continue;
                    } else {
                        console.error(`[LIMIT_ENTRY] Erro ao verificar status da ordem ${activeOrderId}:`, e);
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        continue;
                    }
                }

                if (currentOrderDataFromExchange) {
                    const { status, executedQty, avgPrice, price: orderPriceOnExchangeStr } = currentOrderDataFromExchange;
                    const apiFilledQty = parseFloat(executedQty || 0);
                    const orderPriceOnExchange = parseFloat(orderPriceOnExchangeStr);
                    
                    let alreadyAccountedForThisOrder = 0;
                    partialFills.forEach(pf => { 
                        if (pf.orderId === activeOrderId) alreadyAccountedForThisOrder += pf.qty; 
                    });
                    const netFilledSinceLastCheck = apiFilledQty - alreadyAccountedForThisOrder;

                    if (netFilledSinceLastCheck > 0) {
                        const fillPrice = parseFloat(avgPrice || orderPriceOnExchangeStr);
                        partialFills.push({ qty: netFilledSinceLastCheck, price: fillPrice, orderId: activeOrderId });
                        totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                        console.log(`[LIMIT_ENTRY] Preenchimento detectado ${activeOrderId}: ${netFilledSinceLastCheck.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    }

                    if (status === 'FILLED') {
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} FILLED.`);
                        activeOrderId = null; 
                        if (totalFilledSize >= totalEntrySize) break; 
                        continue; 
                    } 
                    else if (status === 'PARTIALLY_FILLED' || status === 'NEW') {
                        const needsReposition = Math.abs(orderPriceOnExchange - currentLocalMakerPrice) >= tickSize;

                        if (needsReposition) {
                            console.log(`[LIMIT_ENTRY] Reposicionando ordem ${activeOrderId}.`);
                            if (status === 'PARTIALLY_FILLED') {
                                try { 
                                    await cancelOrder(numericAccountId, signal.symbol, activeOrderId); 
                                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} cancelada.`);
                                } catch (cancelError) { 
                                    console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId}:`, cancelError.message);
                                }
                                activeOrderId = null; 
                            } else { // status === 'NEW'
                                try {
                                    const qtyToEdit = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                                    if (qtyToEdit > 0) {
                                        const editResp = await editOrder(numericAccountId, signal.symbol, 
                                            activeOrderId, 
                                            currentLocalMakerPrice.toFixed(pricePrecision), 
                                            binanceSide
                                        );
                                        
                                        if (editResp.wasPartiallyFilled) {
                                            console.log(`[LIMIT_ENTRY] Ordem recriada devido a preenchimento parcial.`);
                                            
                                            if (parseFloat(editResp.executedQty) > 0) {
                                                const fillPrice = parseFloat(editResp.originalPrice || 0);
                                                partialFills.push({ qty: parseFloat(editResp.executedQty), price: fillPrice, orderId: editResp.oldOrderId });
                                                totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                                            }
                                            
                                            activeOrderId = String(editResp.orderId);
                                            orderPlacedOrEditedThisIteration = true;
                                        } else {
                                            if (String(editResp.orderId) !== activeOrderId) { 
                                                activeOrderId = String(editResp.orderId);
                                            }
                                            orderPlacedOrEditedThisIteration = true;
                                        }
                                    } else {
                                        console.log(`[LIMIT_ENTRY] Quantidade para editar é zero. Cancelando ordem.`);
                                        try { 
                                            await cancelOrder(numericAccountId, signal.symbol, activeOrderId); 
                                        } catch(e){ 
                                            console.warn(`[LIMIT_ENTRY] Falha ao cancelar:`, e.message); 
                                        } 
                                        activeOrderId = null;
                                    }
                                } catch (editErr) {
                                    console.error(`[LIMIT_ENTRY] Falha ao editar ${activeOrderId}:`, editErr.message);
                                    activeOrderId = null;
                                }
                            }
                        } else { 
                            orderPlacedOrEditedThisIteration = true; 
                        }
                    } else { 
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} com status inesperado: ${status}. Resetando.`);
                        activeOrderId = null;
                    }
                }
            }
            
            // CRIAR NOVA ORDEM SE NECESSÁRIO
            if (!activeOrderId && totalFilledSize < totalEntrySize) { 
                const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                if (newOrderQty <= 0) { 
                    console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero. Saindo do loop."); 
                    break; 
                }
                try {
                    console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                    
                    const restOrderResponse = await newLimitMakerOrder(numericAccountId, signal.symbol, newOrderQty, binanceSide, currentLocalMakerPrice);
                    
                    if (restOrderResponse && restOrderResponse.data && restOrderResponse.data.orderId) {
                        activeOrderId = String(restOrderResponse.data.orderId);
                        orderPlacedOrEditedThisIteration = true;
                        console.log(`[LIMIT_ENTRY] Nova LIMIT criada: ID ${activeOrderId}`);
                    } else if (restOrderResponse && restOrderResponse.orderId) {
                        activeOrderId = String(restOrderResponse.orderId);
                        orderPlacedOrEditedThisIteration = true;
                        console.log(`[LIMIT_ENTRY] Nova LIMIT criada (formato alternativo): ID ${activeOrderId}`);
                    } else {
                        throw new Error('Resposta da API não contém orderId válido');
                    }
                } catch (error) {
                    console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, error.message);
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    continue;
                }
            }
            
            // AGUARDAR EXECUÇÃO SE ORDEM FOI CRIADA/EDITADA
            if (orderPlacedOrEditedThisIteration && activeOrderId) {
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
                    if (totalFilledSize >= totalEntrySize) break;
                } else if (orderWaitResult.status === 'PARTIALLY_FILLED') {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} PARTIALLY_FILLED (após wait).`);
                } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderWaitResult.status)) {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ${orderWaitResult.status} (após wait). Resetando.`);
                    activeOrderId = null;
                }
            }
            
            if (totalFilledSize >= totalEntrySize) {
                console.log(`[LIMIT_ENTRY] Quantidade total (${totalEntrySize.toFixed(quantityPrecision)}) alcançada.`);
                break; 
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        } 

        // CALCULAR PREÇO MÉDIO DE ENTRADA
        if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
        } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
            averageEntryPrice = currentPriceTrigger; 
            console.warn(`[LIMIT_ENTRY] Usando currentPriceTrigger como averageEntryPrice (fallback).`);
        }

        // TENTAR PREENCHER RESTANTE COM ORDEM MARKET
        if (totalFilledSize < totalEntrySize) {
            console.log(`[LIMIT_ENTRY] Chasing encerrado. Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)}`);
            const remainingToFillMarket = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
            
            if (remainingToFillMarket > 0) {
                console.log(`[LIMIT_ENTRY] Tentando preencher restante (${remainingToFillMarket.toFixed(quantityPrecision)}) com ordem MARKET.`);
                if (activeOrderId) { 
                    try {
                        const lastOrderStatus = await getOrderStatus(numericAccountId, signal.symbol, activeOrderId);
                        if (lastOrderStatus && (lastOrderStatus.status === 'NEW' || lastOrderStatus.status === 'PARTIALLY_FILLED')) {
                            await cancelOrder(numericAccountId, signal.symbol, activeOrderId); 
                            console.log(`[LIMIT_ENTRY] Última ordem LIMIT ${activeOrderId} cancelada.`);
                        }
                    } catch (cancelErr) { 
                        console.warn(`[LIMIT_ENTRY] Falha ao cancelar antes da MARKET:`, cancelErr.message); 
                    }
                    activeOrderId = null; 
                }
                try {
                    marketOrderResponseForDb = await newEntryOrder(numericAccountId, signal.symbol, remainingToFillMarket, binanceSide);
                    
                    if (marketOrderResponseForDb && marketOrderResponseForDb.orderId && marketOrderResponseForDb.status === 'FILLED') {
                        const marketFilledQty = parseFloat(marketOrderResponseForDb.executedQty);
                        const marketFilledPrice = parseFloat(marketOrderResponseForDb.avgPrice || marketOrderResponseForDb.price); 
                        if (marketFilledQty > 0) {
                            partialFills.push({ qty: marketFilledQty, price: marketFilledPrice, orderId: String(marketOrderResponseForDb.orderId) });
                            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0); 
                            averageEntryPrice = calculateAveragePrice(partialFills); 
                        }
                        console.log(`[LIMIT_ENTRY] Ordem MARKET final preenchida: ${marketFilledQty.toFixed(quantityPrecision)} @ ${marketFilledPrice.toFixed(pricePrecision)}`);
                    } else {
                        console.error(`[LIMIT_ENTRY] Falha na ordem MARKET final:`, marketOrderResponseForDb);
                    }
                } catch (marketError) {
                   console.error(`[LIMIT_ENTRY] Erro ao executar ordem MARKET final:`, marketError.response?.data || marketError.message);
                }
            }
        }
        
        const MIN_FILL_THRESHOLD_ABSOLUTE = 0.000001; 
        if (totalFilledSize <= MIN_FILL_THRESHOLD_ABSOLUTE) { 
             throw new Error(`Entrada falhou. Quantidade preenchida (${totalFilledSize.toFixed(quantityPrecision)}) é insignificante.`);
        }
        
        const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;

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
        
        // INSERIR POSIÇÃO NO BANCO
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
        };
        
        positionId = await insertPosition(connection, positionData, signal.id);
        if (!positionId) throw new Error(`Falha ao inserir posição no banco de dados para Sinal ID ${signal.id}`);
        console.log(`[LIMIT_ENTRY] Posição ID ${positionId} criada no banco de dados para Sinal ID ${signal.id}`);

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
                    
                    if (stopOrderResult && stopOrderResult.data && stopOrderResult.data.orderId) {
                        console.log(`[LIMIT_ENTRY] SL criado com ID: ${stopOrderResult.data.orderId}`);
                        
                        const slOrderData = {
                            tipo_ordem: 'STOP_MARKET',
                            preco: slPriceVal,
                            quantidade: totalFilledSize,
                            id_posicao: positionId,
                            status: 'OPEN',
                            data_hora_criacao: formatDateForMySQL(new Date()),
                            id_externo: String(stopOrderResult.data.orderId),
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
                tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
            };

            const reductionPercentages = [0.25, 0.30, 0.25, 0.10];
            let cumulativeQtyForRps = 0;
            
            for (let i = 0; i < rpTargetKeys.length; i++) {
                const rpKey = rpTargetKeys[i];
                const rpPrice = targetPrices[rpKey];
                if (rpPrice && rpPrice > 0 && i < reductionPercentages.length) {
                    const reductionPercent = reductionPercentages[i];
                    const reductionQty = parseFloat((totalFilledSize * reductionPercent).toFixed(quantityPrecision));
                    if (reductionQty <= 0) {
                        console.log(`[LIMIT_ENTRY] Quantidade para RP${i+1} é zero. Pulando.`);
                        continue;
                    }
                    cumulativeQtyForRps += reductionQty;
                    try {
                        console.log(`[LIMIT_ENTRY] Criando RP${i+1}: ${reductionQty.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(pricePrecision)}`);
                        const rpResponse = await newReduceOnlyOrder(numericAccountId, signal.symbol, reductionQty, binanceOppositeSide, rpPrice.toFixed(pricePrecision));
                        if (rpResponse && rpResponse.data && rpResponse.data.orderId) {
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
                            console.log(`[LIMIT_ENTRY] RP${i+1} criada: ${rpResponse.data.orderId}`);
                        }
                    } catch (rpError) { 
                        console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1}:`, rpError.response?.data || rpError.message); 
                    }
                }
            }

            // CRIAR TP FINAL
            const finalTpPrice = targetPrices.tp5;
            const qtyForFinalTpRaw = totalFilledSize - cumulativeQtyForRps;
            const qtyForFinalTp = parseFloat(qtyForFinalTpRaw.toFixed(quantityPrecision));

            if (finalTpPrice && finalTpPrice > 0 && qtyForFinalTp > 0) {
                try {
                    console.log(`[LIMIT_ENTRY] Criando TP Final: ${qtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${finalTpPrice.toFixed(pricePrecision)}`);
                    const tpResponse = await newStopOrder(numericAccountId, signal.symbol, qtyForFinalTp.toFixed(quantityPrecision), 
                        binanceOppositeSide, finalTpPrice.toFixed(pricePrecision), 
                        finalTpPrice.toFixed(pricePrecision), true, true 
                    );
                    if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
                        const tpOrderData = { 
                            tipo_ordem: 'TAKE_PROFIT_MARKET', 
                            preco: finalTpPrice, 
                            quantidade: qtyForFinalTp, 
                            id_posicao: positionId, 
                            status: 'NEW',
                            data_hora_criacao: formatDateForMySQL(new Date()), 
                            id_externo: String(tpResponse.data.orderId).substring(0,90), 
                            side: binanceOppositeSide,
                            simbolo: signal.symbol, 
                            tipo_ordem_bot: 'TAKE_PROFIT', 
                            target: 5, 
                            reduce_only: true, 
                            close_position: true, 
                            orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: formatDateForMySQL(new Date())
                        };
                        await insertNewOrder(connection, tpOrderData); 
                        console.log(`[LIMIT_ENTRY] TP Final criado: ${tpResponse.data.orderId}`);
                        await connection.query(`UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`, [String(tpResponse.data.orderId), signal.id]);
                    }
                } catch (tpError) { 
                    console.error(`[LIMIT_ENTRY] Erro ao criar TP Final:`, tpError.response?.data || tpError.message); 
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
        console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`);
        
        if (connection) {
            try {
                await connection.rollback();
                console.log(`[LIMIT_ENTRY] (Catch Principal) ROLLBACK da transação principal efetuado para Sinal ${signal.id}.`);
            } catch (rollbackError) {
                console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao fazer rollback:`, rollbackError.message);
            }
            
            try {
                await connection.query(
                    'UPDATE webhook_signals SET status = ?, error_message = ? WHERE id = ?',
                    ['ERROR', originalErrorMessage, signal.id]
                );
            } catch (updateError) {
                console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao atualizar status do sinal para ERROR no DB:`, updateError.message); 
            }
        }
        
        return { success: false, error: originalErrorMessage };

    } finally {
        if (depthWs) {
            console.log(`[LIMIT_ENTRY] Fechando WebSocket de profundidade para ${signal?.symbol || 'unknown'} no bloco finally.`);
            try {
                depthWs.close();
            } catch (wsCloseError) {
                console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket de profundidade no finally: ${wsCloseError.message}`);
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
function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, precision) {
    const capital = availableBalance * capitalPercentage;
    const rawSize = (capital * leverage) / entryPrice;
    
    const validPrecision = Math.max(0, Math.min(8, Math.floor(precision)));
    const formattedSize = parseFloat(rawSize.toFixed(validPrecision));
    
    console.log(`[MONITOR] Cálculo: capital=${capital.toFixed(2)}, rawSize=${rawSize}, precisão=${validPrecision}, formatado=${formattedSize}`);
    
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