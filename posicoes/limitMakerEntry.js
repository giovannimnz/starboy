const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const fs = require('fs').promises;
const { newEntryOrder, getRecentOrders, editOrder, roundPriceToTickSize, newLimitMakerOrder, newReduceOnlyOrder, cancelOrder, newStopOrder, getOpenOrders, getOrderStatus, getAllOpenPositions, getPrecision, getTickSize } = require('../api');
const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForMySQL } = require('../db/conexao');
const websockets = require('../websockets');

async function executeLimitMakerEntry(db, signal, currentPriceTrigger) {
    const connection = await db.getConnection();
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 450000; // 7.5 minutos
    const WAIT_FOR_EXECUTION_TIMEOUT_MS = 5000;
    const EDIT_WAIT_TIMEOUT_MS = 3000;

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let totalFilledSize = 0;
    let averageEntryPrice = 0;
    let positionId = null;
    let executionStartTime = Date.now();
    let partialFills = [];
    let activeOrderId = null;
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    let binanceSide;
    let leverage;
    let quantityPrecision;
    let pricePrecision;
    let precisionInfo;

    // Variáveis para o WebSocket de profundidade
    let depthWs = null;
    let currentBestBid = null;
    let currentBestAsk = null;
    let lastDepthUpdateTimestamp = 0;
    const MAX_DEPTH_STALENESS_MS = 3000; // Considerar dados do book "velhos" após 3 segundos sem atualização do WS
    let wsUpdateErrorCount = 0;

    try {
        const existingPositionsOnExchange = await getAllOpenPositions(signal.symbol);
        const positionAlreadyExists = existingPositionsOnExchange.some(p =>
            p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
        );

        if (positionAlreadyExists) {
            console.log(`[LIMIT_ENTRY] ALERTA: Posição já existe para ${signal.symbol}. Cancelando.`);
            await db.query(
                `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
                ['Posição já existe na corretora (verificação inicial)', signal.id]
            );
            return { success: false, error: 'Posição já existe na corretora (verificação inicial)' };
        }

        await connection.beginTransaction();
        
        console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol})`);
        
        precisionInfo = await getPrecision(signal.symbol);
        quantityPrecision = precisionInfo.quantityPrecision;
        pricePrecision = precisionInfo.pricePrecision;
        
        const availableBalance = await getAvailableBalance();
        const capitalPercentage = parseFloat(signal.capital_pct) / 100;
        leverage = parseInt(signal.leverage); 
        
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

        // --- INÍCIO: Integração WebSocket de Profundidade ---
        console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
        depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData) => {
            if (depthData.bestBid && depthData.bestAsk) {
                currentBestBid = parseFloat(depthData.bestBid);
                currentBestAsk = parseFloat(depthData.bestAsk);
                lastDepthUpdateTimestamp = Date.now();
                wsUpdateErrorCount = 0; // Resetar contador de erro se recebermos dados
            } else {
                wsUpdateErrorCount++;
                console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos recebidos para ${signal.symbol}:`, depthData);
            }
        });
        
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 segundos para conexão WS

        // Obter dados iniciais do book via REST como fallback
        if (!currentBestBid || !currentBestAsk) {
            try {
                console.log(`[LIMIT_ENTRY] WebSocket de profundidade ainda não forneceu dados. Buscando book inicial via REST para ${signal.symbol}...`);
                const initialBookData = await getBookTicker(signal.symbol);
                if (initialBookData && initialBookData.bidPrice && initialBookData.askPrice) {
                    currentBestBid = parseFloat(initialBookData.bidPrice);
                    currentBestAsk = parseFloat(initialBookData.askPrice);
                    lastDepthUpdateTimestamp = Date.now();
                    console.log(`[LIMIT_ENTRY] Book inicial obtido via REST: Bid ${currentBestBid}, Ask ${currentBestAsk}`);
                } else {
                     console.warn(`[LIMIT_ENTRY] Book ticker inicial via REST não retornou dados válidos para ${signal.symbol}.`);
                }
            } catch (e) {
                console.warn(`[LIMIT_ENTRY] Falha ao obter book ticker inicial via REST para ${signal.symbol}: ${e.message}. Tentará prosseguir com dados do WS se disponíveis.`);
            }
        }
        // --- FIM: Integração WebSocket de Profundidade ---
        
        while (totalFilledSize < totalEntrySize && 
               chaseAttempts < MAX_CHASE_ATTEMPTS && 
               (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
            
            chaseAttempts++;

            // Sincronizar preenchimentos antes de obter o book
            try {
                const recentOrders = await getRecentOrders(signal.symbol, 15);
                const filledExchangeOrders = recentOrders.filter(order =>
                    order.status === 'FILLED' &&
                    order.side === binanceSide &&
                    parseFloat(order.executedQty) > 0 &&
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

            // --- USO DOS DADOS DO WEBSOCKET ---
const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
    const staleReason = !currentBestBid || !currentBestAsk ? "ausentes" : (isDepthDataStale ? "velhos" : `erros WS (${wsUpdateErrorCount})`);
    console.log(`[LIMIT_ENTRY] Dados do BookTicker (WebSocket) para ${signal.symbol} ${staleReason}. Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Última atualização WS: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
    
    // Fallback para REST se o WS estiver com problemas persistentes
    if (isDepthDataStale || wsUpdateErrorCount > 3) {
        console.warn(`[LIMIT_ENTRY] Tentando fallback para API REST para obter BookTicker de ${signal.symbol}`);
        try {
            // Usar endpoint REST específico para bookTicker para maior rapidez
            const response = await axios.get(`${process.env.API_URL}/v1/ticker/bookTicker?symbol=${signal.symbol}`, {
                timeout: 1000 // timeout mais curto para evitar bloqueios
            });
            
            if (response.data && response.data.bidPrice && response.data.askPrice) {
                currentBestBid = parseFloat(response.data.bidPrice);
                currentBestAsk = parseFloat(response.data.askPrice);
                lastDepthUpdateTimestamp = Date.now();
                console.log(`[LIMIT_ENTRY] BookTicker obtido via REST (fallback): Bid=${currentBestBid.toFixed(pricePrecision)}, Ask=${currentBestAsk.toFixed(pricePrecision)}`);
                wsUpdateErrorCount = 0;
            } else {
                console.error(`[LIMIT_ENTRY] Fallback REST para BookTicker de ${signal.symbol} não retornou dados válidos.`);
                await new Promise(resolve => setTimeout(resolve, 500));
                continue;
            }
        } catch (e) {
            console.error(`[LIMIT_ENTRY] Falha ao obter BookTicker via REST para ${signal.symbol}: ${e.message}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            continue;
        }
    } else {
        await new Promise(resolve => setTimeout(resolve, 200));
        continue;
    }
}
            // --- FIM USO DOS DADOS DO WEBSOCKET ---

            const bestBid = currentBestBid;
            const bestAsk = currentBestAsk;
            const spread = bestAsk - bestBid;

            const tickSizeData = await getTickSize(signal.symbol);
            const tickSize = parseFloat(tickSizeData.tickSize);
            
let currentLocalMakerPrice;
if (binanceSide === 'BUY') {
    // Para compras (BUY), usamos o bid como base
    // Para ser o mais competitivo possível, colocamos exatamente no bestBid
    currentLocalMakerPrice = bestBid;
    
    // Para garantir que seja maker, verificar se o preço não está muito perto do ask
    if (bestBid >= bestAsk - tickSize) {
        // Se o spread é menor que 1 tick, precisamos garantir ordem maker
        currentLocalMakerPrice = bestAsk - tickSize;
        console.log(`[LIMIT_ENTRY] Ajustando preço BUY para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick abaixo do ask)`);
    }
} else { // SELL
    // Para vendas (SELL), usamos o ask como base
    // Para ser o mais competitivo possível, colocamos exatamente no bestAsk
    currentLocalMakerPrice = bestAsk;
    
    // Para garantir que seja maker, verificar se o preço não está muito perto do bid
    if (bestAsk <= bestBid + tickSize) {
        // Se o spread é menor que 1 tick, precisamos garantir ordem maker
        currentLocalMakerPrice = bestBid + tickSize;
        console.log(`[LIMIT_ENTRY] Ajustando preço SELL para garantir ordem maker: ${currentLocalMakerPrice.toFixed(pricePrecision)} (1 tick acima do bid)`);
    }
}

// Garantir que o preço esteja no tick correto
currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice);

// Adicionar log para depuração (sempre, não apenas a cada 5 tentativas)
console.log(`[LIMIT_ENTRY] Preço MAKER para ${binanceSide}: ${currentLocalMakerPrice.toFixed(pricePrecision)} | Book: Bid=${bestBid.toFixed(pricePrecision)}, Ask=${bestAsk.toFixed(pricePrecision)}, Spread=${(bestAsk-bestBid).toFixed(pricePrecision)}`);

            let orderPlacedOrEditedThisIteration = false;

            // ... (Toda a lógica de gerenciamento de activeOrderId, getOrderStatus, edição, cancelamento, nova ordem é MANTIDA) ...
            // A diferença é que 'currentLocalMakerPrice' é usado para novas ordens ou edições.
            // Exemplo de onde currentLocalMakerPrice seria usado:
            // na hora de editar: await editOrder(..., currentLocalMakerPrice.toFixed(pricePrecision));
            // na hora de criar nova: await newLimitMakerOrder(..., currentLocalMakerPrice);

             if (activeOrderId) {
                let currentOrderDataFromExchange;
                try {
                    currentOrderDataFromExchange = await getOrderStatus(activeOrderId, signal.symbol);
                } catch (e) {
                    if (e.response && e.response.data && (e.response.data.code === -2013 || e.response.data.code === -2011) ) { 
                        console.log(`[LIMIT_ENTRY] Ordem ativa ${activeOrderId} não existe mais na corretora. Resetando.`);
                        activeOrderId = null;
                    } else {
                        console.error(`[LIMIT_ENTRY] Erro ao buscar status da ordem ${activeOrderId}: ${e.message}`);
                        await new Promise(resolve => setTimeout(resolve, 200)); continue;
                    }
                }

                if (currentOrderDataFromExchange) {
                    const { status, executedQty, avgPrice, price: orderPriceOnExchangeStr, origQty } = currentOrderDataFromExchange;
                    const apiFilledQty = parseFloat(executedQty || 0);
                    const orderPriceOnExchange = parseFloat(orderPriceOnExchangeStr);
                    
                    let alreadyAccountedForThisOrder = 0;
                    partialFills.forEach(pf => { if (pf.orderId === activeOrderId) alreadyAccountedForThisOrder += pf.qty; });
                    const netFilledSinceLastCheck = apiFilledQty - alreadyAccountedForThisOrder;

                    if (netFilledSinceLastCheck > 0) {
                        const fillPrice = parseFloat(avgPrice || orderPriceOnExchangeStr); // Usar avgPrice se disponível
                        partialFills.push({ qty: netFilledSinceLastCheck, price: fillPrice, orderId: activeOrderId });
                        totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                        console.log(`[LIMIT_ENTRY] Preenchimento (status check) ${activeOrderId}: ${netFilledSinceLastCheck.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    }

                    if (status === 'FILLED') {
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} FILLED (status check).`);
                        activeOrderId = null; 
                        if (totalFilledSize >= totalEntrySize) break; 
                        continue; 
                    } 
                    else if (status === 'PARTIALLY_FILLED' || status === 'NEW') {
                        // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ${status} (status check). Verificando necessidade de reposicionamento.`);
                        const needsReposition = Math.abs(orderPriceOnExchange - currentLocalMakerPrice) >= tickSize;

                        if (needsReposition) {
                            console.log(`[LIMIT_ENTRY] Reposicionando ordem ${activeOrderId}. Preço atual da ordem: ${orderPriceOnExchange.toFixed(pricePrecision)}, Preço MAKER ideal: ${currentLocalMakerPrice.toFixed(pricePrecision)}.`);
                            if (status === 'PARTIALLY_FILLED') {
                                console.log(`[LIMIT_ENTRY] Cancelando ${activeOrderId} (parcialmente preenchida) para reposicionar restante.`);
                                try { 
                                    await cancelOrder(activeOrderId, signal.symbol); 
                                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} cancelada com sucesso.`);
                                } catch (cancelError) { 
                                    console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} (parcial): ${cancelError.message}. Verificando se já foi preenchida/cancelada.`);
                                    try {
                                        const postCancelAttemptStatus = await getOrderStatus(activeOrderId, signal.symbol);
                                        if (postCancelAttemptStatus.status === 'FILLED' || postCancelAttemptStatus.status === 'CANCELED') {
                                            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} já está ${postCancelAttemptStatus.status}. Resetando activeOrderId.`);
                                            activeOrderId = null; 
                                            const finalApiFilledQty = parseFloat(postCancelAttemptStatus.executedQty || 0);
                                            const finalNetFilled = finalApiFilledQty - alreadyAccountedForThisOrder;
                                            if (finalNetFilled > 0) {
                                                const finalFillPrice = parseFloat(postCancelAttemptStatus.avgPrice || postCancelAttemptStatus.price);
                                                partialFills.push({ qty: finalNetFilled, price: finalFillPrice, orderId: activeOrderId }); // activeOrderId pode já ser null aqui, mas o ID é importante
                                                totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                                                console.log(`[LIMIT_ENTRY] Preenchimento adicional (pós falha cancel) ${activeOrderId || 'ID_ORDEM_ANTERIOR'}: ${finalNetFilled.toFixed(quantityPrecision)} @ ${finalFillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                                            }
                                        }
                                    } catch (statusError) {
                                        console.error(`[LIMIT_ENTRY] Erro ao verificar status de ${activeOrderId} após falha no cancelamento: ${statusError.message}`);
                                    }
                                }
                                activeOrderId = null; 
                            } else { // status === 'NEW'
                                console.log(`[LIMIT_ENTRY] Tentando editar ordem NEW ${activeOrderId} para novo preço ${currentLocalMakerPrice.toFixed(pricePrecision)}.`);
                                try {
                                    const qtyToEdit = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                                    if (qtyToEdit > 0) { 
                                        const editResp = await editOrder(signal.symbol, activeOrderId, currentLocalMakerPrice.toFixed(pricePrecision), binanceSide);
                                        if (editResp && editResp.orderId) {
                                            if (String(editResp.orderId) !== activeOrderId) { 
                                                console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} editada com sucesso para ${currentLocalMakerPrice.toFixed(pricePrecision)}.`);
                                                activeOrderId = String(editResp.orderId);
                                            } else { console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} editada com sucesso.`); }
                                            orderPlacedOrEditedThisIteration = true;
                                        } else {
                                            console.warn(`[LIMIT_ENTRY] Edição da ordem ${activeOrderId} não retornou ID válido ou falhou. Cancelando para segurança.`);
                                            try { await cancelOrder(activeOrderId, signal.symbol); } catch(e){ console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} após edição sem ID: ${e.message}`); } 
                                            activeOrderId = null;
                                        }
                                    } else {
                                        console.log(`[LIMIT_ENTRY] Quantidade a editar para ${activeOrderId} é zero ou negativa. Cancelando ordem.`);
                                        try { await cancelOrder(activeOrderId, signal.symbol); } catch(e){ console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} (qtd zero para editar): ${e.message}`); } 
                                        activeOrderId = null;
                                    }
                                } catch (editErr) {
                                    console.error(`[LIMIT_ENTRY] Falha ao editar ${activeOrderId}: ${editErr.message}`);
                                    try { 
                                        const postEditFailStatus = await getOrderStatus(activeOrderId, signal.symbol); 
                                        if(postEditFailStatus && postEditFailStatus.status !== 'NEW' && postEditFailStatus.status !== 'PARTIALLY_FILLED') {
                                            activeOrderId = null; 
                                        } else if (postEditFailStatus && (postEditFailStatus.status === 'NEW' || postEditFailStatus.status === 'PARTIALLY_FILLED')) {
                                            console.log(`[LIMIT_ENTRY] Tentando cancelar ${activeOrderId} após falha na edição.`);
                                            await cancelOrder(activeOrderId, signal.symbol);
                                            activeOrderId = null;
                                        }
                                    } catch(e){ 
                                        console.warn(`[LIMIT_ENTRY] Erro ao obter status de ${activeOrderId} após falha na edição: ${e.message}. Resetando activeOrderId.`);
                                        activeOrderId = null; 
                                    } 
                                }
                            }
                        } else { 
                            // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} (${status}) já está no preço MAKER ideal ou dentro da tolerância. Mantendo.`);
                            orderPlacedOrEditedThisIteration = true; 
                        }
                    } else { 
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} com status inesperado: ${status}. Resetando.`);
                        activeOrderId = null;
                    }
                }
            }
            
            if (!activeOrderId && totalFilledSize < totalEntrySize) { 
                const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                if (newOrderQty <= 0) { 
                    console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
                    break; 
                }
                try {
                    console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                    const orderResponse = await newLimitMakerOrder(
                        signal.symbol, newOrderQty, binanceSide, currentLocalMakerPrice
                    );
                    if (orderResponse.status === 'REJECTED_POST_ONLY' || (orderResponse.info && orderResponse.info.msg === 'Filter failure: PRICE_FILTER')) {
                        console.log(`[LIMIT_ENTRY] Nova LIMIT MAKER rejeitada (Post-Only ou Price Filter). Aguardando próxima iteração.`);
                        await new Promise(resolve => setTimeout(resolve, 300)); 
                        continue; 
                    }
                    if (!orderResponse.orderId) throw new Error(`Resposta da nova ordem LIMIT inválida: ${JSON.stringify(orderResponse)}`);
                    activeOrderId = String(orderResponse.orderId);
                    orderPlacedOrEditedThisIteration = true;
                    console.log(`[LIMIT_ENTRY] Nova LIMIT criada: ID ${activeOrderId}`);
                } catch (newOrderError) {
                    console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, newOrderError.response?.data || newOrderError.message);
                    await new Promise(resolve => setTimeout(resolve, 1000)); 
                    continue;
                }
            }
            
            if (orderPlacedOrEditedThisIteration && activeOrderId) {
                // console.log(`[LIMIT_ENTRY] Aguardando execução/status da ordem ${activeOrderId} por ${EDIT_WAIT_TIMEOUT_MS}ms...`);
                const orderWaitResult = await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS);
                
                const apiWaitFilledQty = parseFloat(orderWaitResult.executedQty || 0);
                let alreadyAccountedForWait = 0;
                partialFills.forEach(pf => { if (pf.orderId === activeOrderId) alreadyAccountedForWait += pf.qty; });
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
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} PARTIALLY_FILLED (após wait). Continuará no loop.`);
                } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderWaitResult.status)) {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ${orderWaitResult.status} (após wait). Resetando.`);
                    activeOrderId = null;
                } else if (orderWaitResult.status === 'NEW') {
                    //  console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ainda NEW (após wait). Continuará no loop para reavaliação.`);
                } else if (orderWaitResult.status && orderWaitResult.status.startsWith('TIMED_OUT')) {
                    console.log(`[LIMIT_ENTRY] Timeout ao aguardar ${activeOrderId}. Será reavaliada na próxima iteração.`);
                } else {
                    // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} com status ${orderWaitResult.status || 'DESCONHECIDO'} (após wait). Será reavaliada.`);
                }
            }
            
            if (totalFilledSize >= totalEntrySize) {
                console.log(`[LIMIT_ENTRY] Quantidade total (${totalEntrySize.toFixed(quantityPrecision)}) alcançada.`);
                break; 
            }
            await new Promise(resolve => setTimeout(resolve, 200)); // Loop principal de espera
        } 
        
        // ... (Restante da função: cálculo de averageEntryPrice, lógica de preenchimento com MARKET se necessário, MIN_FILL_THRESHOLD, registro da posição, SL/TP, notificações - MANTIDO) ...
        // O restante da função permanece como na versão anterior.
        if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
        } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
            averageEntryPrice = currentPriceTrigger; 
            console.warn(`[LIMIT_ENTRY] averageEntryPrice não pôde ser calculado a partir de partialFills (total preenchido: ${totalFilledSize}), usando currentPriceTrigger como fallback: ${averageEntryPrice}`);
        }


        if (totalFilledSize < totalEntrySize) {
            console.log(`[LIMIT_ENTRY] Chasing encerrado. Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)}. Timeout: ${Date.now() - executionStartTime >= CHASE_TIMEOUT_MS}, Tentativas: ${chaseAttempts >= MAX_CHASE_ATTEMPTS}`);
            const remainingToFillMarket = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
            
            if (remainingToFillMarket > 0) {
                console.log(`[LIMIT_ENTRY] Tentando preencher restante (${remainingToFillMarket.toFixed(quantityPrecision)}) com ordem MARKET.`);
                if (activeOrderId) { 
                    try {
                        const lastOrderStatus = await getOrderStatus(activeOrderId, signal.symbol);
                        if (lastOrderStatus && (lastOrderStatus.status === 'NEW' || lastOrderStatus.status === 'PARTIALLY_FILLED')) {
                            await cancelOrder(activeOrderId, signal.symbol); 
                            console.log(`[LIMIT_ENTRY] Última ordem LIMIT ${activeOrderId} cancelada antes da ordem MARKET final.`);
                        }
                    } catch (cancelErr) { console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} antes da MARKET final: ${cancelErr.message}`); }
                    activeOrderId = null; 
                }
                try {
                    marketOrderResponseForDb = await newEntryOrder(
                        signal.symbol, remainingToFillMarket, binanceSide
                    );
                    if (marketOrderResponseForDb && marketOrderResponseForDb.orderId && marketOrderResponseForDb.status === 'FILLED') {
                        const marketFilledQty = parseFloat(marketOrderResponseForDb.executedQty);
                        // Para MARKET, avgPrice é o preço de execução
                        const marketFilledPrice = parseFloat(marketOrderResponseForDb.avgPrice || marketOrderResponseForDb.price); 
                        if (marketFilledQty > 0) {
                            partialFills.push({ qty: marketFilledQty, price: marketFilledPrice, orderId: String(marketOrderResponseForDb.orderId) });
                            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0); 
                            averageEntryPrice = calculateAveragePrice(partialFills); 
                        }
                        console.log(`[LIMIT_ENTRY] Ordem MARKET final preenchida: ${marketFilledQty.toFixed(quantityPrecision)} @ ${marketFilledPrice.toFixed(pricePrecision)}. Total acumulado: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    } else {
                        console.error(`[LIMIT_ENTRY] Falha na ordem MARKET final ou resposta inválida/não FILLED:`, marketOrderResponseForDb);
                    }
                } catch (marketError) {
                   console.error(`[LIMIT_ENTRY] Erro crítico ao executar ordem MARKET final:`, marketError.response?.data || marketError.message);
                }
            }
        }
        
        const MIN_FILL_THRESHOLD_ABSOLUTE = 0.000001; 
        if (totalFilledSize <= MIN_FILL_THRESHOLD_ABSOLUTE) { 
             throw new Error(`Entrada falhou. Quantidade preenchida (${totalFilledSize.toFixed(quantityPrecision)}) é insignificante ou nula para Sinal ID ${signal.id}.`);
        }
        
        const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;
        const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.999; 

        // Recalcular averageEntryPrice final com todos os preenchimentos
        if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
        } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0) ){ // Se não houve preenchimentos parciais mas algo foi preenchido (raro)
             averageEntryPrice = currentPriceTrigger; // Fallback extremo
             console.warn(`[LIMIT_ENTRY] Usando currentPriceTrigger como averageEntryPrice (fallback extremo).`);
        }
        if (!averageEntryPrice || averageEntryPrice === 0 ) { // Se ainda assim for zero e houve preenchimento
            throw new Error(`Preço médio de entrada não pôde ser determinado apesar de ${totalFilledSize} preenchido.`);
        }

        console.log(`[LIMIT_ENTRY] Processo de entrada finalizado para Sinal ID ${signal.id}: Total Preenchido ${totalFilledSize.toFixed(quantityPrecision)} de ${totalEntrySize.toFixed(quantityPrecision)} (${(fillRatio * 100).toFixed(1)}%) @ Preço Médio ${averageEntryPrice.toFixed(pricePrecision)}`);
        
        const positionData = {
            simbolo: signal.symbol, quantidade: totalFilledSize, preco_medio: averageEntryPrice, status: 'OPEN',
            data_hora_abertura: formatDateForMySQL(new Date(executionStartTime)), side: binanceSide, leverage: leverage,
            data_hora_ultima_atualizacao: formatDateForMySQL(new Date()), preco_entrada: averageEntryPrice,
            preco_corrente: averageEntryPrice, 
            orign_sig: `WEBHOOK_${signal.id}`,
            quantidade_aberta: totalFilledSize,
        };
        
        positionId = await insertPosition(connection, positionData, signal.id);
        if (!positionId) throw new Error(`Falha ao inserir posição no banco de dados para Sinal ID ${signal.id}`);
        console.log(`[LIMIT_ENTRY] Posição ID ${positionId} criada no banco de dados para Sinal ID ${signal.id}`);
        
        for (const fill of partialFills) {
            const orderData = {
                tipo_ordem: (marketOrderResponseForDb && fill.orderId === String(marketOrderResponseForDb.orderId)) ? 'MARKET' : 'LIMIT',
                preco: fill.price, quantidade: fill.qty, id_posicao: positionId, status: 'FILLED', 
                data_hora_criacao: formatDateForMySQL(new Date()), 
                id_externo: String(fill.orderId || `fill_${Date.now()}_${Math.random().toString(36).substring(7)}`).substring(0, 90), 
                side: binanceSide, simbolo: signal.symbol, tipo_ordem_bot: 'ENTRADA', target: null,
                reduce_only: false, close_position: false, last_update: formatDateForMySQL(new Date()),
                orign_sig: `WEBHOOK_${signal.id}`, preco_executado: fill.price, quantidade_executada: fill.qty,
            };
            await insertNewOrder(connection, orderData);
        }
        
        await connection.query(
            `UPDATE webhook_signals SET status = 'EXECUTADO', position_id = ?, entry_order_id = ?, entry_price = ? WHERE id = ?`,
            [positionId, (partialFills.length > 0 ? partialFills[0].orderId : null), averageEntryPrice, signal.id]
        );
        
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

    // Primeiro criar apenas o Stop Loss
    if (slPriceVal && slPriceVal > 0) {
        try {
            console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${slPriceVal.toFixed(pricePrecision)}`);
            const slResponse = await newStopOrder( 
                signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                binanceOppositeSide, slPriceVal.toFixed(pricePrecision), null, true, true 
            );
            if (slResponse && slResponse.data && slResponse.data.orderId) {
                const slOrderData = { 
                    tipo_ordem: 'STOP_MARKET', preco: slPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW', 
                    data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(slResponse.data.orderId).substring(0,90), side: binanceOppositeSide, 
                    simbolo: signal.symbol, tipo_ordem_bot: 'STOP_LOSS', reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                    last_update: formatDateForMySQL(new Date()), target: null
                };
                await insertNewOrder(connection, slOrderData); 
                console.log(`[LIMIT_ENTRY] SL criado: ${slResponse.data.orderId}`);
                await connection.query( `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`, [String(slResponse.data.orderId), signal.id] );
            } else { console.warn(`[LIMIT_ENTRY] Falha criar SL, resposta inválida:`, slResponse); }
        } catch (slError) { console.error(`[LIMIT_ENTRY] Erro ao criar SL:`, slError.response?.data || slError.message); }
    } else { console.warn(`[LIMIT_ENTRY] Preço de SL inválido ou não fornecido (${slPriceVal}). SL não será criado.`); }
    
    // NOVA IMPLEMENTAÇÃO: Esperar confirmação da posição antes de criar RPs e TP
    console.log(`[LIMIT_ENTRY] Aguardando confirmação da posição na corretora antes de criar RPs e TP...`);
    
    // Esperar um pouco para dar tempo à corretora processar a posição
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verificar se a posição está aberta na corretora
    let positionConfirmed = false;
    let retryCount = 0;
    const MAX_RETRIES = 5;
    
    while (!positionConfirmed && retryCount < MAX_RETRIES) {
        try {
            // Verificar se a posição existe na corretora
            const positions = await getAllOpenPositions(signal.symbol);
            const position = positions.find(p => 
                p.symbol === signal.symbol && 
                Math.abs(parseFloat(p.positionAmt)) > 0
            );
            
            if (position) {
                positionConfirmed = true;
                console.log(`[LIMIT_ENTRY] Posição confirmada na corretora após ${retryCount + 1} tentativa(s). Quantidade: ${position.positionAmt}`);
            } else {
                retryCount++;
                console.log(`[LIMIT_ENTRY] Posição ainda não confirmada. Tentativa ${retryCount}/${MAX_RETRIES}`);
                if (retryCount < MAX_RETRIES) {
                    // Esperar 2 segundos entre tentativas
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (error) {
            console.error(`[LIMIT_ENTRY] Erro ao verificar posição na corretora:`, error.message);
            retryCount++;
            if (retryCount < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    }
    
    if (!positionConfirmed) {
        console.warn(`[LIMIT_ENTRY] Não foi possível confirmar a posição na corretora após ${MAX_RETRIES} tentativas. Tentando criar RP/TP mesmo assim.`);
    }
    
    // Continuar apenas se a posição foi confirmada ou se esgotamos as tentativas
    if (positionConfirmed || retryCount >= MAX_RETRIES) {
        // Se não confirmou, espera um pouco mais como última tentativa
        if (!positionConfirmed) {
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
        
        // Agora criar as ordens RP
        const reductionPercentages = [0.15, 0.35, 0.25, 0.10];
        let cumulativeQtyForRps = 0;
        for (let i = 0; i < rpTargetKeys.length; i++) {
            const rpKey = rpTargetKeys[i];
            const rpPrice = targetPrices[rpKey];
            if (rpPrice && rpPrice > 0 && i < reductionPercentages.length) {
                const reductionPercent = reductionPercentages[i];
                const reductionQty = parseFloat((totalFilledSize * reductionPercent).toFixed(quantityPrecision));
                if (reductionQty <= 0) {
                    console.log(`[LIMIT_ENTRY] Quantidade para RP${i+1} (${rpKey}) é zero. Pulando.`);
                    continue;
                }
                cumulativeQtyForRps += reductionQty;
                try {
                    console.log(`[LIMIT_ENTRY] Criando RP${i+1} (${rpKey}): ${reductionQty.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(pricePrecision)}`);
                    const rpResponse = await newReduceOnlyOrder(
                        signal.symbol, reductionQty, binanceOppositeSide, rpPrice.toFixed(pricePrecision)
                    );
                    if (rpResponse && rpResponse.data && rpResponse.data.orderId) {
                        const rpOrderData = { 
                            tipo_ordem: 'LIMIT', preco: rpPrice, quantidade: reductionQty, id_posicao: positionId, status: 'NEW',
                            data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(rpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                            simbolo: signal.symbol, tipo_ordem_bot: 'REDUCAO_PARCIAL', target: i + 1, reduce_only: true, close_position: false, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: formatDateForMySQL(new Date())
                        };
                        await insertNewOrder(connection, rpOrderData); 
                        console.log(`[LIMIT_ENTRY] RP${i+1} (${rpKey}) criada: ${rpResponse.data.orderId}`);
                    } else { console.warn(`[LIMIT_ENTRY] Falha ao criar RP${i+1}, resposta inválida:`, rpResponse); }
                } catch (rpError) { 
                    console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1} (${rpKey}):`, rpError.response?.data || rpError.message); 
                }
            }
        }

        // Criar o TP final
        const finalTpPrice = targetPrices.tp5;
        const qtyForFinalTpRaw = totalFilledSize - cumulativeQtyForRps;
        const qtyForFinalTp = parseFloat(qtyForFinalTpRaw.toFixed(quantityPrecision));

        if (finalTpPrice && finalTpPrice > 0 && qtyForFinalTp > 0) {
            try {
                console.log(`[LIMIT_ENTRY] Criando TP Final (tp5) para quantidade restante: ${qtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${finalTpPrice.toFixed(pricePrecision)}`);
                const tpResponse = await newStopOrder( 
                    signal.symbol, qtyForFinalTp.toFixed(quantityPrecision), 
                    binanceOppositeSide, finalTpPrice.toFixed(pricePrecision), 
                    finalTpPrice.toFixed(pricePrecision), true, true 
                );
                if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
                    const tpOrderData = { 
                        tipo_ordem: 'TAKE_PROFIT_MARKET', preco: finalTpPrice, 
                        quantidade: qtyForFinalTp, 
                        id_posicao: positionId, status: 'NEW',
                        data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(tpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                        simbolo: signal.symbol, tipo_ordem_bot: 'TAKE_PROFIT', target: 5, reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                        last_update: formatDateForMySQL(new Date())
                    };
                    await insertNewOrder(connection, tpOrderData); 
                    console.log(`[LIMIT_ENTRY] TP Final (tp5) criado: ${tpResponse.data.orderId}`);
                    await connection.query( `UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`, [String(tpResponse.data.orderId), signal.id] );
                } else { console.warn(`[LIMIT_ENTRY] Falha ao criar TP Final, resposta inválida:`, tpResponse); }
            } catch (tpError) { console.error(`[LIMIT_ENTRY] Erro ao criar TP Final (tp5):`, tpError.response?.data || tpError.message); }
        } else if (qtyForFinalTp <= 0 && finalTpPrice && finalTpPrice > 0) {
            console.warn(`[LIMIT_ENTRY] TP Final (tp5) não criado pois a quantidade restante após RPs é zero ou negativa (${qtyForFinalTp.toFixed(quantityPrecision)}).`);
        } else if (!finalTpPrice || finalTpPrice <= 0) {
            console.warn(`[LIMIT_ENTRY] Preço do TP Final (tp5/tp_price) inválido (${finalTpPrice}). TP Final não será criado.`);
        }
    }
} else if (totalFilledSize > 0) { 
    console.warn(`[LIMIT_ENTRY] Entrada NÃO COMPLETAMENTE PREENCHIDA (${(fillRatio * 100).toFixed(1)}% < ${(ENTRY_COMPLETE_THRESHOLD_RATIO*100).toFixed(1)}%). SL/TP/RPs AUTOMÁTICOS NÃO SERÃO CRIADOS para Posição ID: ${positionId}. Requer manejo manual ou configuração de SL/TP fallback!`);
    if (typeof bot !== 'undefined' && signal.chat_id && bot) {
        try {
            const warningMsg = `⚠️ ATENÇÃO: ${signal.symbol} (Sinal ID: ${signal.id}) aberta PARCIALMENTE (${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} - ${(fillRatio * 100).toFixed(1)}%).\n` +
                               `SL/TP automáticos NÃO foram criados devido ao preenchimento parcial abaixo do limiar. GERENCIE MANUALMENTE!`;
            const tgOpts = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
            await bot.telegram.sendMessage(signal.chat_id, warningMsg, tgOpts);
        } catch (tgError) { console.error(`[LIMIT_ENTRY] Erro ao enviar notificação Telegram (parcial sem SL/TP):`, tgError); }
    }
}
        
        if (typeof bot !== 'undefined' && signal.chat_id && bot) { 
            try {
                // ... (Lógica de notificação do Telegram mantida) ...
                const displaySide = binanceSide === 'BUY' ? 'Compra' : 'Venda';
                const amountInUsdt = totalFilledSize * averageEntryPrice; 
                let tgTargetsMessage = "";
                let tgHasAnyRpListed = false;
                const targetPrices = { 
                    tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
                    tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
                    tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
                    tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
                    tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
                };
                const reductionPercentages = [0.15, 0.35, 0.25, 0.10]; 

                rpTargetKeys.forEach((key, index) => {
                    const price = targetPrices[key];
                    if (price && price > 0 && index < reductionPercentages.length && slTpRpsCreated) { 
                        const percent = reductionPercentages[index] * 100;
                        tgTargetsMessage += `RP${index+1} (${percent}%): ${price.toFixed(pricePrecision)}\n`;
                        tgHasAnyRpListed = true;
                    }
                });
                const tgFinalTpDisplay = targetPrices.tp5;
                if (tgFinalTpDisplay && tgFinalTpDisplay > 0 && slTpRpsCreated) { 
                    tgTargetsMessage += `Take Profit Final: ${tgFinalTpDisplay.toFixed(pricePrecision)}\n`;
                } else if (!tgHasAnyRpListed && slTpRpsCreated) {
                    tgTargetsMessage = "Alvos de TP não definidos no sinal (ou não criados).\n";
                }
                 if (!slTpRpsCreated) {
                     tgTargetsMessage = "Nenhum Take Profit/Redução Parcial programado automaticamente.\n";
                 }

                let slTpMessage = "";
                if (slTpRpsCreated) {
                    const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
                    slTpMessage = `Alvos Programados:\n${tgTargetsMessage}\nStop Loss: ${slPriceVal ? slPriceVal.toFixed(pricePrecision) : 'N/A (não definido ou não criado)'}\n`;
                } else {
                    slTpMessage = "SL/TP/RPs automáticos NÃO configurados (entrada parcial ou falha na criação).\n";
                }

                const telegramOptions = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
                
                await bot.telegram.sendMessage(signal.chat_id,
                    `✅ Entrada ${slTpRpsCreated && fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO ? 'LIMIT MAKER' : `LIMIT MAKER (${fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO ? 'COMPLETA' : 'PARCIAL'})`} realizada em ${signal.symbol} \n(Sinal ID: ${signal.id}, Posição DB ID: ${positionId})\n\n` +
                    `Direção: ${displaySide}\nAlavancagem: ${leverage}x\n` +
                    `Valor Aprox. (USDT): ${amountInUsdt.toFixed(2)}\n`+
                    `Qtd. Executada: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol.replace('USDT', '')} (${(fillRatio*100).toFixed(1)}% da meta)\n` +
                    `Preço Médio Entrada: ${averageEntryPrice.toFixed(pricePrecision)}\n\n` +
                    slTpMessage,
                    telegramOptions
                );
                console.log(`[LIMIT_ENTRY] Notificação Telegram final enviada para Sinal ID ${signal.id}`);

            } catch (telegramError) { console.error(`[LIMIT_ENTRY] Erro ao enviar notificação Telegram final:`, telegramError); }
        }
        
        await connection.commit();
        console.log(`[LIMIT_ENTRY] Transação COMMITADA. Sucesso para Sinal ID ${signal.id}`);
        
        if (typeof syncAccountBalance !== 'undefined') { 
            try { await syncAccountBalance(); } catch (e) { console.error(`[LIMIT_ENTRY] Erro ao executar syncAccountBalance: ${e.message}`); }
        }
        
        return {
            success: true, positionId, averagePrice: averageEntryPrice, filledQuantity: totalFilledSize, 
            partialWarning: !slTpRpsCreated && totalFilledSize > 0 && fillRatio < ENTRY_COMPLETE_THRESHOLD_RATIO
        };
        
    } catch (error) { 
        // ... (Bloco catch principal e lógica de recuperação MANTIDOS) ...
         const originalErrorMessage = error.message || String(error);
        console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`, error.stack || error);
        
        if (positionId && totalFilledSize > 0 && averageEntryPrice > 0) { 
            console.warn(`[LIMIT_ENTRY_RECOVERY] Tentando SALVAR POSIÇÃO ${positionId} (${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${averageEntryPrice.toFixed(pricePrecision)}) e enviar SL/TP de emergência devido ao erro: ${originalErrorMessage}`);
            try {
                const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
                const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
                
                if (slPriceVal && slPriceVal > 0) {
                    console.log(`[LIMIT_ENTRY_RECOVERY] Enviando SL de emergência: ${totalFilledSize.toFixed(quantityPrecision)} @ ${slPriceVal.toFixed(pricePrecision)}`);
                    const slResponse = await newStopOrder( 
                        signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                        binanceOppositeSide, slPriceVal.toFixed(pricePrecision), null, true, true 
                    );
                    if (slResponse && slResponse.data && slResponse.data.orderId) {
                        const slOrderData = { 
                            tipo_ordem: 'STOP_MARKET', preco: slPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW', 
                            data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(slResponse.data.orderId).substring(0,90), side: binanceOppositeSide, 
                            simbolo: signal.symbol, tipo_ordem_bot: 'STOP_LOSS', reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: formatDateForMySQL(new Date()), target: null, observacao: 'SL Enviado em Recuperação de Erro'
                        };
                        await insertNewOrder(connection, slOrderData); 
                        console.log(`[LIMIT_ENTRY_RECOVERY] SL de emergência (recuperação) criado: ${slResponse.data.orderId}`);
                        await connection.query( `UPDATE webhook_signals SET sl_order_id = ?, status = 'EXECUTADO_COM_AVISO_RECUPERACAO', error_message = LEFT(CONCAT('Recuperação: ', ?, error_message), 250) WHERE id = ? AND position_id = ?`, 
                                                [String(slResponse.data.orderId), `Erro: ${originalErrorMessage}. Posição salva, SL emergência tentado.`, signal.id, positionId] );
                    } else { console.error(`[LIMIT_ENTRY_RECOVERY] Falha ao criar SL de emergência (recuperação). Resposta inválida:`, slResponse); }
                } else { console.warn(`[LIMIT_ENTRY_RECOVERY] SL de emergência inválido (${slPriceVal}). Não enviado.`); }

                const finalTpPriceVal = signal.tp_price ? parseFloat(signal.tp_price) : (signal.tp5_price ? parseFloat(signal.tp5_price) : null);
                if (finalTpPriceVal && finalTpPriceVal > 0) {
                    console.log(`[LIMIT_ENTRY_RECOVERY] Enviando TP Final de emergência: ${totalFilledSize.toFixed(quantityPrecision)} @ ${finalTpPriceVal.toFixed(pricePrecision)}`);
                     const tpResponse = await newStopOrder( 
                        signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                        binanceOppositeSide, finalTpPriceVal.toFixed(pricePrecision),
                        finalTpPriceVal.toFixed(pricePrecision), true, true 
                    );
                    if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
                        const tpOrderData = {
                            tipo_ordem: 'TAKE_PROFIT_MARKET', preco: finalTpPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW',
                            data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(tpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                            simbolo: signal.symbol, tipo_ordem_bot: 'TAKE_PROFIT', target: 5, reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: formatDateForMySQL(new Date()), observacao: 'TP Enviado em Recuperação de Erro'
                        };
                        await insertNewOrder(connection, tpOrderData); 
                        console.log(`[LIMIT_ENTRY_RECOVERY] TP de emergência (recuperação) criado: ${tpResponse.data.orderId}`);
                        await connection.query( `UPDATE webhook_signals SET tp_order_id = ?, status = 'EXECUTADO_COM_AVISO_RECUPERACAO', error_message = LEFT(CONCAT('Recuperação: ', ?, error_message), 250) WHERE id = ? AND position_id = ?`, 
                                                [String(tpResponse.data.orderId), `Erro: ${originalErrorMessage}. Posição salva, SL/TP emergência tentados.`, signal.id, positionId] );
                    } else { console.error(`[LIMIT_ENTRY_RECOVERY] Falha criar TP de emergência (recuperação). Resposta inválida:`, tpResponse); }
                } else { console.warn(`[LIMIT_ENTRY_RECOVERY] TP Final de emergência inválido. Não enviado.`); }
                
                await connection.commit(); 
                console.warn(`[LIMIT_ENTRY_RECOVERY] Posição ${positionId} SALVA e SL/TP de emergência tentados. Erro original: ${originalErrorMessage}`);
                
                if (typeof bot !== 'undefined' && signal.chat_id && bot) {
                    await bot.telegram.sendMessage(signal.chat_id, `⚠️ Posição ${signal.symbol} (Sinal ${signal.id}, Posição DB ID: ${positionId}) aberta, mas com erro (${originalErrorMessage}).\nSL/TP de EMERGÊNCIA foram tentados. VERIFIQUE IMEDIATAMENTE!`);
                }
                return {
                    success: true, positionId, averagePrice: averageEntryPrice, filledQuantity: totalFilledSize,
                    warning: `Erro durante entrada: ${originalErrorMessage}. Posição salva e SL/TP de emergência foram tentados.`
                };
            } catch (recoveryError) {
                console.error(`[LIMIT_ENTRY_RECOVERY] ERRO CRÍTICO NA LÓGICA DE RECUPERAÇÃO (SL/TP):`, recoveryError.message, recoveryError.stack);
                if (connection) { 
                    try { await connection.rollback(); console.log('[LIMIT_ENTRY_RECOVERY] Rollback da recuperação tentado.'); }
                    catch (rbRecoveryErr) { console.error('[LIMIT_ENTRY_RECOVERY] Erro no rollback da recuperação:', rbRecoveryErr); }
                }
            }
        }
        
        if (activeOrderId) { 
            try { 
                console.log(`[LIMIT_ENTRY] (Catch Principal) Tentando cancelar ordem ativa ${activeOrderId} antes do rollback.`);
                await cancelOrder(activeOrderId, signal.symbol); 
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
        
        if (typeof bot !== 'undefined' && signal.chat_id && bot) { 
            try {
                const tgOptsOnError = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
                await bot.telegram.sendMessage(signal.chat_id,
                    `❌ Erro CRÍTICO ao tentar abrir posição LIMIT MAKER para ${signal.symbol} (Sinal ID: ${signal.id})\nMotivo: ${originalErrorMessage}`, tgOptsOnError );
            } catch (tgError) { console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao notificar Telegram sobre falha:`, tgError); }
        }
        return { success: false, error: originalErrorMessage };

    } finally {
        // --- INÍCIO: Fechamento do WebSocket de Profundidade ---
        if (depthWs) {
            console.log(`[LIMIT_ENTRY] Fechando WebSocket de profundidade para ${signal.symbol} no bloco finally.`);
            try {
                depthWs.close();
            } catch (wsCloseError) {
                console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket de profundidade para ${signal.symbol} no finally: ${wsCloseError.message}`);
            }
        }
        // --- FIM: Fechamento do WebSocket de Profundidade ---
        if (connection) {
            connection.release();
        }
    }
}

// Função auxiliar para obter saldo disponível
async function getAvailableBalance() {
    try {
        const db = await getDatabaseInstance();
        if (!db) {
            throw new Error('[MONITOR] Falha ao obter instância do banco de dados');
        }

        // Obter saldo_base_calculo do banco de dados
        const [rows] = await db.query('SELECT saldo_base_calculo FROM conta WHERE id = 1');
        const baseCalculo = rows.length > 0 ? parseFloat(rows[0].saldo_base_calculo || 0) : 0;

        if (baseCalculo <= 0) {
            throw new Error('Saldo base de cálculo inválido ou zero');
        }

        console.log(`[MONITOR] Usando saldo base de cálculo: ${baseCalculo.toFixed(2)} USDT`);
        return baseCalculo;
    } catch (error) {
        console.error(`[MONITOR] Erro ao obter saldo base de cálculo: ${error.message}`);
        return 0;
    }
}

// Função auxiliar para calcular tamanho da ordem
function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, precision) {
    const capital = availableBalance * capitalPercentage;
    const size = (capital * leverage) / entryPrice;
    const sizeString = size.toFixed(precision);
    const formattedSize = parseFloat(sizeString);
    
    console.log(`[MONITOR] Tamanho calculado: ${size}, Precisão: ${precision}, Formatado: ${formattedSize}`);
    return formattedSize;
}

// Função auxiliar para calcular preço médio
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

// Função para obter dados do livro de ordens (BookTicker)
async function getBookTicker(symbol) {
    try {
        const response = await axios.get(`${process.env.API_URL}/v1/ticker/price?symbol=${symbol}`);
        if (response.data && response.data.price) {
            const price = parseFloat(response.data.price);
            // Simulando um book com spread mínimo
            return {
                bidPrice: (price * 0.9999).toString(),
                askPrice: (price * 1.0001).toString(),
                bidQty: "1",
                askQty: "1"
            };
        }
        return null;
    } catch (error) {
        console.error(`[MONITOR] Erro ao obter preço atual para ${symbol}:`, error);
        return null;
    }
}

// Função otimizada para aguardar a execução de uma ordem
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000) {
    const startTime = Date.now();
    
    try {
        // Verificar imediatamente o status da ordem (sem espera inicial)
        const orderStatus = await getOrderStatus(orderId, symbol);
        
        // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
        if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
            return orderStatus;
        }
    } catch (initialError) {
        console.log(`[WAIT_ORDER] Erro inicial ao verificar ordem ${orderId}: ${initialError.message}`);
    }
    
    // Loop de espera com intervalos mais curtos
    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Verificar status da ordem
            const orderStatus = await getOrderStatus(orderId, symbol);
            
            // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
            if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
                return orderStatus;
            }
            
            // Aguardar um período muito curto antes de verificar novamente
            await new Promise(resolve => setTimeout(resolve, 100));            
        } catch (error) {
            console.log(`[WAIT_ORDER] Erro ao verificar ordem ${orderId}: ${error.message}`);
            // Aguardar antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    // Timeout atingido, tentar obter o status atual
    try {
        return await getOrderStatus(orderId, symbol);
    } catch (error) {
        return { status: 'UNKNOWN', executedQty: '0', avgPrice: '0' };
    }
}

module.exports = {
    executeLimitMakerEntry
};