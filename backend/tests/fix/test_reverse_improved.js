const { getDatabaseInstance, insertPosition, insertNewOrder, formatDateForPostgreSQL } = require('../../core/database/conexao');
const websockets = require('../../exchanges/binance/api/websocket');
const rest = require('../../exchanges/binance/api/rest');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../config/.env') });
const { getOrderStatus, newMarketOrder, newStopOrder, newLimitMakerOrder, getPrecision, roundPriceToTickSize, validateQuantity, adjustQuantityToRequirements, getAllOpenPositions, getFuturesAccountBalanceDetails } = require('../../exchanges/binance/api/rest');
const { sendTelegramMessage, formatEntryMessage, formatErrorMessage } = require('../../exchanges/binance/services/telegramHelper');

/**
 * ✅ NOVA FUNÇÃO: Executa o reverse com todas as melhorias solicitadas
 * - Criação obrigatória da posição no banco antes de qualquer ordem
 * - Atualização do sinal (webhook_signals) com o id da posição
 * - Sistema Pub/Sub dedicado para esta execução
 * - Insert de cada ordem (entrada, SL, TP) no banco imediatamente após envio para a corretora
 * - Delay de 3 segundos entre cada insert para evitar deadlock
 * - Timeout de 45 segundos para confirmação via webhook
 * - Após timeout, polling REST para status da ordem até preenchimento
 * - Atualização da posição e ordens no banco com dados reais após preenchimento
 * - Não depende exclusivamente do webhook para confirmação de ordens
 */
async function executeReverse(signal, currentPrice, accountId) {
  console.log(`[REVERSE_IMPROVED] 🚀 Executando entrada para sinal ${signal.id}: ${signal.symbol} ${signal.side} a ${signal.entry_price} (conta ${accountId})`);

  // ✅ CONSTANTES
  const WEBHOOK_TIMEOUT_MS = 45000; // 45 segundos para confirmação webhook
  const DELAY_BETWEEN_INSERTS_MS = 3000; // 3 segundos entre inserts
  const REST_POLLING_INTERVAL_MS = 2000; // 2 segundos entre consultas REST
  const MAX_REST_POLLING_ATTEMPTS = 30; // Máximo 1 minuto de polling
  
  // ✅ VARIÁVEIS DE CONTROLE
  let connection = null;
  let positionId = null;
  let entryOrderId = null;
  let isWebhookConfirmed = false;
  let totalFilledSize = 0;
  let averageEntryPrice = 0;
  let entryOrderStatus = null;
  
  // ✅ NOVO: ID único para o listener temporário desta execução
  const temporaryListenerId = `reverse-entry-${signal.id}-${Date.now()}`;
  
  // ✅ HANDLER PARA WEBHOOK DEDICADO
  const orderUpdateHandler = (orderMsg) => {
      if (!orderMsg || !orderMsg.o) return;
      
      const order = orderMsg.o;
      const orderId = String(order.i);
      const orderStatus = order.X;
      const executedQty = parseFloat(order.z || '0');
      const avgPrice = parseFloat(order.ap || '0');
      
      // Verificar se é nossa ordem de entrada
      if (orderId === entryOrderId) {
          console.log(`[REVERSE_IMPROVED] 📨 Webhook recebido para ordem de entrada ${orderId}: status=${orderStatus}, filled=${executedQty}`);
          
          entryOrderStatus = orderStatus;
          totalFilledSize = executedQty;
          averageEntryPrice = avgPrice;
          
          if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
              isWebhookConfirmed = true;
          }
      }
  };

  try {
      // ✅ VALIDAÇÕES INICIAIS
      if (!accountId || typeof accountId !== 'number') {
          throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
      }

      if (!signal || !signal.id || !signal.symbol) {
          throw new Error(`Signal inválido: ${JSON.stringify(signal)}`);
      }

      const numericAccountId = parseInt(accountId) || accountId;

      // ✅ OBTER CONEXÃO DO BANCO
      const db = await getDatabaseInstance(accountId);
      if (!db) {
          throw new Error(`Não foi possível obter conexão com banco para conta ${accountId}`);
      }
      connection = await db.getConnection();
      await connection.beginTransaction();

      // ✅ VERIFICAR SE JÁ EXISTE POSIÇÃO ABERTA
      const existingPositionsOnExchange = await getAllOpenPositions(numericAccountId);
      const positionAlreadyExists = existingPositionsOnExchange.some(p =>
          p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
      );

      if (positionAlreadyExists) {
          throw new Error(`Posição já existe para ${signal.symbol}`);
      }

      // ✅ OBTER PRECISÃO E CALCULAR TAMANHOS
      const precisionInfo = await getPrecision(signal.symbol, numericAccountId);
      const quantityPrecision = precisionInfo.quantityPrecision;
      const pricePrecision = precisionInfo.pricePrecision;
      const stepSize = precisionInfo.stepSize;

      const availableBalance = await getAvailableBalance(numericAccountId);
      const capitalPercentage = parseFloat(signal.capital_pct) / 100;
      const leverage = parseInt(signal.leverage);

      const entryPrice = parseFloat(signal.entry_price);
      let totalEntrySize = calculateOrderSize(
          availableBalance, capitalPercentage, entryPrice, leverage, stepSize, quantityPrecision
      );

      if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
          throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
      }

      console.log(`[REVERSE_IMPROVED] Tamanho calculado: ${totalEntrySize.toFixed(quantityPrecision)} ${signal.symbol}`);

      // ✅ VALIDAR QUANTIDADE
      const entryValidation = await validateQuantity(signal.symbol, totalEntrySize, entryPrice, numericAccountId, 'MARKET');
      if (!entryValidation.isValid) {
          const adjustment = await adjustQuantityToRequirements(signal.symbol, totalEntrySize, entryPrice, numericAccountId, 'MARKET');
          if (adjustment.success) {
              totalEntrySize = adjustment.adjustedQuantity;
              console.log(`[REVERSE_IMPROVED] Quantidade ajustada: ${totalEntrySize}`);
          } else {
              throw new Error(`Quantidade inválida: ${entryValidation.reason}`);
          }
      }

      const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? "BUY" : "SELL";

      // ✅ PASSO 1: CRIAR POSIÇÃO NO BANCO OBRIGATORIAMENTE ANTES DE QUALQUER ORDEM
      console.log(`[REVERSE_IMPROVED] 🏗️ Criando posição no banco de dados...`);
      
      const positionData = {
          simbolo: signal.symbol,
          quantidade: 0, // Será atualizada após preenchimento
          quantidade_aberta: totalEntrySize,
          preco_medio: 0, // Será atualizada após preenchimento
          status: 'OPEN',
          side: binanceSide,
          leverage: leverage,
          preco_entrada: entryPrice,
          preco_corrente: entryPrice,
          observacoes: `Criada automaticamente para sinal ${signal.id}`
      };

      positionId = await insertPosition(connection, positionData, accountId);
      console.log(`[REVERSE_IMPROVED] ✅ Posição criada no banco com ID: ${positionId}`);

      // ✅ PASSO 2: ATUALIZAR O SINAL COM O ID DA POSIÇÃO
      await connection.query(
          `UPDATE webhook_signals SET position_id = $1, status = 'ENTRADA_EM_PROGRESSO', updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
          [positionId, signal.id]
      );
      console.log(`[REVERSE_IMPROVED] ✅ Sinal ${signal.id} atualizado com position_id: ${positionId}`);

      // ✅ PASSO 3: REGISTRAR LISTENER DEDICADO DO PUB/SUB
      websockets.registerEntryExecutionListener(orderUpdateHandler, accountId, temporaryListenerId);
      console.log(`[REVERSE_IMPROVED] 🎧 Listener dedicado registrado: ${temporaryListenerId}`);

      // ✅ PASSO 4: ENVIAR ORDEM DE ENTRADA PARA A CORRETORA
      console.log(`[REVERSE_IMPROVED] 📤 Enviando ordem de entrada para a corretora...`);
      
      const entryOrderResponse = await newMarketOrder(
          signal.symbol,
          binanceSide,
          totalEntrySize,
          numericAccountId
      );

      if (!entryOrderResponse || !entryOrderResponse.orderId) {
          throw new Error(`Falha ao enviar ordem de entrada: ${JSON.stringify(entryOrderResponse)}`);
      }

      entryOrderId = String(entryOrderResponse.orderId);
      console.log(`[REVERSE_IMPROVED] ✅ Ordem de entrada enviada: ${entryOrderId}`);

      // ✅ PASSO 5: INSERIR ORDEM DE ENTRADA NO BANCO IMEDIATAMENTE
      const entryOrderData = {
          tipo_ordem: 'MARKET',
          preco: entryPrice,
          quantidade: totalEntrySize,
          id_posicao: positionId,
          status: 'NEW',
          data_hora_criacao: formatDateForPostgreSQL(new Date()),
          id_externo: entryOrderId,
          side: binanceSide,
          simbolo: signal.symbol,
          tipo_ordem_bot: 'ENTRADA',
          target: null,
          reduce_only: false,
          close_position: false,
          last_update: formatDateForPostgreSQL(new Date()),
          orign_sig: `WEBHOOK_${signal.id}`,
          observacao: `Ordem de entrada para sinal ${signal.id}`
      };

      await insertNewOrder(connection, entryOrderData);
      console.log(`[REVERSE_IMPROVED] ✅ Ordem de entrada inserida no banco`);

      // ✅ PASSO 6: AGUARDAR CONFIRMAÇÃO VIA WEBHOOK (45 segundos)
      console.log(`[REVERSE_IMPROVED] ⏳ Aguardando confirmação via webhook por ${WEBHOOK_TIMEOUT_MS/1000}s...`);
      
      const webhookStartTime = Date.now();
      while ((Date.now() - webhookStartTime) < WEBHOOK_TIMEOUT_MS && !isWebhookConfirmed) {
          await new Promise(resolve => setTimeout(resolve, 500)); // Check a cada 500ms
      }

      // ✅ PASSO 7: SE WEBHOOK NÃO CONFIRMOU, FAZER POLLING REST
      if (!isWebhookConfirmed) {
          console.log(`[REVERSE_IMPROVED] ⚠️ Webhook timeout - iniciando polling REST...`);
          
          let pollingAttempts = 0;
          let orderFound = false;
          
          while (pollingAttempts < MAX_REST_POLLING_ATTEMPTS && !orderFound) {
              try {
                  const orderStatus = await getOrderStatus(signal.symbol, entryOrderId, numericAccountId);
                  
                  if (orderStatus) {
                      console.log(`[REVERSE_IMPROVED] 📊 Status REST da ordem: ${orderStatus.status}, filled: ${orderStatus.executedQty}`);
                      
                      entryOrderStatus = orderStatus.status;
                      totalFilledSize = parseFloat(orderStatus.executedQty || '0');
                      averageEntryPrice = parseFloat(orderStatus.avgPrice || entryPrice);
                      
                      if (orderStatus.status === 'FILLED') {
                          orderFound = true;
                          break;
                      }
                  }
              } catch (error) {
                  console.warn(`[REVERSE_IMPROVED] ⚠️ Erro ao consultar status da ordem via REST:`, error.message);
              }
              
              pollingAttempts++;
              if (pollingAttempts < MAX_REST_POLLING_ATTEMPTS) {
                  await new Promise(resolve => setTimeout(resolve, REST_POLLING_INTERVAL_MS));
              }
          }
          
          if (!orderFound) {
              throw new Error(`Ordem de entrada não foi preenchida após ${MAX_REST_POLLING_ATTEMPTS} tentativas de polling`);
          }
      }

      // ✅ PASSO 8: ATUALIZAR POSIÇÃO E ORDEM NO BANCO COM DADOS REAIS
      if (totalFilledSize > 0 && averageEntryPrice > 0) {
          console.log(`[REVERSE_IMPROVED] 📊 Atualizando posição: filled=${totalFilledSize}, avgPrice=${averageEntryPrice}`);
          
          // Atualizar posição
          await connection.query(`
              UPDATE posicoes 
              SET quantidade = $1, preco_medio = $2, preco_entrada = $3, preco_corrente = $4, last_update = CURRENT_TIMESTAMP
              WHERE id = $5
          `, [totalFilledSize, averageEntryPrice, averageEntryPrice, averageEntryPrice, positionId]);
          
          // Atualizar ordem
          await connection.query(`
              UPDATE ordens 
              SET status = $1, preco_executado = $2, quantidade_executada = $3, last_update = CURRENT_TIMESTAMP
              WHERE id_externo = $4 AND conta_id = $5
          `, ['FILLED', averageEntryPrice, totalFilledSize, entryOrderId, accountId]);
      }

      // ✅ DELAY ANTES DE CRIAR AS PRÓXIMAS ORDENS
      console.log(`[REVERSE_IMPROVED] ⏳ Aguardando ${DELAY_BETWEEN_INSERTS_MS/1000}s antes de criar Stop Loss...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_INSERTS_MS));

      // ✅ PASSO 9: CRIAR ORDEM DE STOP LOSS
      if (signal.sl_price && signal.sl_price > 0) {
          await createStopLossOrder(signal, averageEntryPrice, totalFilledSize, accountId, positionId, connection);
      }

      // ✅ DELAY ANTES DE CRIAR TPS
      console.log(`[REVERSE_IMPROVED] ⏳ Aguardando ${DELAY_BETWEEN_INSERTS_MS/1000}s antes de criar Take Profits...`);
      await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_INSERTS_MS));

      // ✅ PASSO 10: CRIAR ORDENS DE TAKE PROFIT
      const tpTargets = ['tp1_price', 'tp2_price', 'tp3_price', 'tp4_price', 'tp5_price'];
      for (let i = 0; i < tpTargets.length; i++) {
          const tpField = tpTargets[i];
          if (signal[tpField] && signal[tpField] > 0) {
              await createTakeProfitOrder(signal, signal[tpField], totalFilledSize / tpTargets.length, accountId, positionId, connection, i + 1);
              
              // Delay entre cada TP
              if (i < tpTargets.length - 1) {
                  await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_INSERTS_MS));
              }
          }
      }

      // ✅ COMMIT DA TRANSAÇÃO
      await connection.commit();
      
      // ✅ ATUALIZAR STATUS DO SINAL
      await connection.query(
          `UPDATE webhook_signals SET status = 'EXECUTADO', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [signal.id]
      );

      console.log(`[REVERSE_IMPROVED] ✅ Entrada executada com sucesso! Position ID: ${positionId}, Filled: ${totalFilledSize}`);

      // ✅ NOTIFICAÇÃO TELEGRAM
      try {
          const telegramMessage = `✅ Entrada Executada!\n\n📊 ${signal.symbol} ${binanceSide}\n💰 Quantidade: ${totalFilledSize}\n💲 Preço médio: ${averageEntryPrice}\n🎯 Position ID: ${positionId}`;
          await sendTelegramMessage(telegramMessage, accountId);
      } catch (telegramError) {
          console.warn(`[REVERSE_IMPROVED] ⚠️ Erro ao enviar Telegram:`, telegramError.message);
      }

      return { 
          success: true, 
          positionId: positionId,
          entryOrderId: entryOrderId,
          filledQuantity: totalFilledSize,
          averagePrice: averageEntryPrice
      };

  } catch (error) {
      console.error(`[REVERSE_IMPROVED] ❌ Erro durante execução:`, error.message);
      
      // Rollback da transação
      if (connection) {
          try {
              await connection.rollback();
              console.log(`[REVERSE_IMPROVED] 🔄 Rollback executado`);
          } catch (rollbackError) {
              console.error(`[REVERSE_IMPROVED] ❌ Erro no rollback:`, rollbackError.message);
          }
      }

      // Atualizar sinal com erro
      if (signal.id && connection) {
          try {
              await connection.query(
                  `UPDATE webhook_signals SET status = 'ERROR', error_message = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
                  [error.message.substring(0, 250), signal.id]
              );
          } catch (updateError) {
              console.error(`[REVERSE_IMPROVED] ❌ Erro ao atualizar sinal:`, updateError.message);
          }
      }

      return { 
          success: false, 
          error: error.message 
      };

  } finally {
      // ✅ LIMPAR LISTENER DEDICADO
      if (temporaryListenerId) {
          websockets.unregisterEntryExecutionListener(temporaryListenerId);
          console.log(`[REVERSE_IMPROVED] 🗑️ Listener dedicado removido: ${temporaryListenerId}`);
      }

      // ✅ LIBERAR CONEXÃO
      if (connection) {
          try {
              connection.release();
          } catch (releaseError) {
              console.error(`[REVERSE_IMPROVED] ❌ Erro ao liberar conexão:`, releaseError.message);
          }
      }
  }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Criar ordem de Stop Loss
 */
async function createStopLossOrder(signal, entryPrice, quantity, accountId, positionId, connection) {
    try {
        console.log(`[REVERSE_IMPROVED] 🛡️ Criando ordem de Stop Loss...`);
        
        const slPrice = parseFloat(signal.sl_price);
        const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? "BUY" : "SELL";
        const slSide = binanceSide === 'BUY' ? "SELL" : "BUY"; // Oposto da entrada
        
        // Enviar para corretora
        const slOrderResponse = await newStopOrder(
            signal.symbol,
            slSide,
            quantity,
            slPrice,
            accountId
        );

        if (slOrderResponse && slOrderResponse.orderId) {
            console.log(`[REVERSE_IMPROVED] ✅ Stop Loss enviado: ${slOrderResponse.orderId}`);
            
            // Inserir no banco
            const slOrderData = {
                tipo_ordem: 'STOP_MARKET',
                preco: slPrice,
                quantidade: quantity,
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForPostgreSQL(new Date()),
                id_externo: String(slOrderResponse.orderId),
                side: slSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'SL',
                target: null,
                reduce_only: true,
                close_position: false,
                last_update: formatDateForPostgreSQL(new Date()),
                orign_sig: `WEBHOOK_${signal.id}`,
                observacao: `Stop Loss para sinal ${signal.id}`,
                stop_price: slPrice
            };

            await insertNewOrder(connection, slOrderData);
            console.log(`[REVERSE_IMPROVED] ✅ Stop Loss inserido no banco`);
        }
    } catch (error) {
        console.error(`[REVERSE_IMPROVED] ❌ Erro ao criar Stop Loss:`, error.message);
        throw error;
    }
}

/**
 * ✅ FUNÇÃO AUXILIAR: Criar ordem de Take Profit
 */
async function createTakeProfitOrder(signal, tpPrice, quantity, accountId, positionId, connection, targetNumber) {
    try {
        console.log(`[REVERSE_IMPROVED] 🎯 Criando Take Profit ${targetNumber} (${tpPrice})...`);
        
        const binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? "BUY" : "SELL";
        const tpSide = binanceSide === 'BUY' ? "SELL" : "BUY"; // Oposto da entrada
        
        // Enviar para corretora
        const tpOrderResponse = await newLimitMakerOrder(
            signal.symbol,
            tpSide,
            quantity,
            tpPrice,
            accountId,
            true // reduce_only
        );

        if (tpOrderResponse && tpOrderResponse.orderId) {
            console.log(`[REVERSE_IMPROVED] ✅ Take Profit ${targetNumber} enviado: ${tpOrderResponse.orderId}`);
            
            // Inserir no banco
            const tpOrderData = {
                tipo_ordem: 'LIMIT',
                preco: tpPrice,
                quantidade: quantity,
                id_posicao: positionId,
                status: 'NEW',
                data_hora_criacao: formatDateForPostgreSQL(new Date()),
                id_externo: String(tpOrderResponse.orderId),
                side: tpSide,
                simbolo: signal.symbol,
                tipo_ordem_bot: 'TP',
                target: targetNumber,
                reduce_only: true,
                close_position: false,
                last_update: formatDateForPostgreSQL(new Date()),
                orign_sig: `WEBHOOK_${signal.id}`,
                observacao: `Take Profit ${targetNumber} para sinal ${signal.id}`
            };

            await insertNewOrder(connection, tpOrderData);
            console.log(`[REVERSE_IMPROVED] ✅ Take Profit ${targetNumber} inserido no banco`);
        }
    } catch (error) {
        console.error(`[REVERSE_IMPROVED] ❌ Erro ao criar Take Profit ${targetNumber}:`, error.message);
        throw error;
    }
}

// FUNÇÕES AUXILIARES (mantidas como estavam)
async function getAvailableBalance(accountId) {
    try {
        const balanceData = await getFuturesAccountBalanceDetails(accountId);
        return balanceData.availableBalance || 0;
    } catch (error) {
        console.error(`[REVERSE_IMPROVED] Erro ao obter saldo disponível:`, error.message);
        return 0;
    }
}

function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, stepSize, quantityPrecision) {
    const capital = availableBalance * capitalPercentage;
    const rawSize = (capital * leverage) / entryPrice;

    if (stepSize <= 0) {
        return parseFloat(rawSize.toFixed(quantityPrecision));
    }

    const stepMultiplier = 1 / stepSize;
    const stepsRaw = rawSize * stepMultiplier;
    const stepsFloor = Math.floor(stepsRaw);
    const truncatedSize = stepsFloor / stepMultiplier;

    const formattedSize = parseFloat(truncatedSize.toFixed(quantityPrecision));

    console.log(`[REVERSE_IMPROVED] Cálculo do tamanho:`);
    console.log(`  - Saldo disponível: ${availableBalance.toFixed(2)} USDT`);
    console.log(`  - Capital %: ${(capitalPercentage * 100).toFixed(2)}%`);
    console.log(`  - Alavancagem: ${leverage}x`);
    console.log(`  - Preço entrada: ${entryPrice}`);
    console.log(`  - Tamanho formatado: ${formattedSize}`);

    return formattedSize;
}

module.exports = {
    executeReverse
};
