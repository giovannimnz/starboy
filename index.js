require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const { Telegraf } = require("telegraf");

const sqlite3 = require('sqlite3').verbose();
const { getDatabaseInstance, insertPosition, insertNewOrder, getDataHoraFormatada, getCurrentDateTimeAsString } = require("./conexao");

const { newOrder, newEntryOrder, newReduceOnlyOrder, newStopOrder, newTakeProfitOrder, getMaxLeverage, getTickSize, getPrecision, getFuturesAccountBalanceDetails, changeInitialLeverage, changeMarginType, getCurrentLeverage, getCurrentMarginType, getPositionDetails, encerrarPosicao } = require("./api");

const bot = new Telegraf(process.env.BOT_TOKEN);

const confirmationQueue = [];
let isProcessingQueue = false;
let lastProcessedMessage = '';

function processQueue() {
    if (confirmationQueue.length > 0 && !isProcessingQueue) {
        const { ctx, message, originalMessageText } = confirmationQueue.shift();
        
        if (originalMessageText === lastProcessedMessage) {
            console.log("Mensagem duplicada detectada, ignorando...");
            processQueue(); 
        } else {
            isProcessingQueue = true;
            ctx.reply(message).then(() => {
                lastProcessedMessage = originalMessageText;
                isProcessingQueue = false;
                processQueue(); 
            }).catch(error => {
                console.error("Erro ao enviar mensagem:", error);
                isProcessingQueue = false;
                processQueue(); 
            });
        }
    }
}

bot.on("text", async (ctx) => {
  try {
    const messageText = ctx.message.text;
    const dataHora = getDataHoraFormatada();

    console.log("_______________________________\n\n     Mensagem recebida\n       Nova Entrada\n", " " ,dataHora, "\n_______________________________\n\n", messageText, "\n_______________________________\n");

    const lines = messageText.split('\n');
      
    const symbolLine = lines[0];
    const symbol = symbolLine.split(' ')[0].replace('#', '').trim();
    const orderType = symbolLine.includes("COMPRA") ? "COMPRA" : "VENDA";
      
    const signalSource = lines[1];
      
    const leverageLine = lines.find(line => line.includes("ALAVANCAGEM:"));
    const marginLine = lines.find(line => line.includes("MARGEM:"));
    const marginType = marginLine.split(':')[1].trim().toUpperCase();
    const binanceMarginType = marginType === 'ISOLADA' ? 'ISOLATED' : 'CROSSED';
    const capitalLine = lines.find(line => line.includes("CAPITAL:"));
    const leverage = parseInt(leverageLine.split(':')[1].replace('x', ''));
    const capitalPercentage = parseInt(capitalLine.split(':')[1].replace('%', '').trim());
        
    const targets = lines.filter(line => line.includes("ALVO"))
      .map(target => parseFloat(target.split(':')[1].trim()));
    const numberOfTargets = targets.length;

    let pricePrecision, quantityPrecision;
    try {
      ({ pricePrecision, quantityPrecision } = await getPrecision(symbol));
    } catch (error) {
      if (error.message.includes("Símbolo inválido")) {
        ctx.reply(`Símbolo inválido: ${symbol}`);
      } else {
        ctx.reply(`Erro ao obter precisão do símbolo ${symbol}.`);
      }
      console.error('Operação não será realizada\n_______________________________\n');
      return;
    }

    const stopLossLine = lines.find(line => line.includes("STOP LOSS: "));
    const stopLossFloat = parseFloat(stopLossLine.split(': ')[1].trim());
    const stopLossPrice = stopLossFloat.toFixed(pricePrecision);
    
    const entryPriceLine = lines.find(line => line.includes("ENTRADA:"));
    const entryPrice = parseFloat(entryPriceLine.split(':')[1].trim()).toFixed(pricePrecision);

    const side = orderType === "COMPRA" ? "BUY" : "SELL";

    let id_externo = crypto.randomBytes(16).toString("hex");
    id_externo = id_externo.replace(/\./g, '');
    const data_hora_criacao = getCurrentDateTimeAsString();

    let balanceDetails;
    let usdtBalance;
    try {
      balanceDetails = await getFuturesAccountBalanceDetails();
      usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
      const balance = parseFloat(usdtBalance.balance);
      const availableBalance = parseFloat(usdtBalance.availableBalance);
      const unrealizedPnl = parseFloat(usdtBalance.crossUnPnl);

    } catch (error) {
      console.error("Erro ao obter detalhes do saldo da conta de futuros:", error);
      ctx.reply("Erro ao obter detalhes do saldo da conta de futuros. Verifique o console para mais detalhes.");
      return;
    }

    const capital = parseFloat(usdtBalance.balance) * (capitalPercentage / 100);
    const totalUSDT = capital * leverage;
    const tickSizeData = await getTickSize(symbol);
    if (!tickSizeData) {
      console.error(`Símbolo ${symbol} não está disponível na corretora.`);
      ctx.reply(`Símbolo ${symbol} não está disponível na corretora.`);
      return;
    }
    const { minQty, notional } = tickSizeData;

    let totalEntryQuantity = (totalUSDT / entryPrice).toFixed(quantityPrecision);

    const minEntryQty = entryPrice * 0.5;
    const minEntryNotional = minEntryQty * entryPrice;

    if (minEntryQty < minQty || minEntryNotional < notional) {
      ctx.reply(`50% da quantidade de entrada calculada (${minEntryQty.toFixed(8)}) ou do valor notional (${minEntryNotional.toFixed(2)}) para ${symbol} é menor que o mínimo exigido pela API (minQty: ${minQty}, notional: ${notional}), a ordem não será executada.`);
      console.log(`50% da quantidade de entrada calculada (${minEntryQty.toFixed(8)}) ou do valor notional (${minEntryNotional.toFixed(2)}) para ${symbol} é menor que o mínimo exigido pela API (minQty: ${minQty}, notional: ${notional}), a ordem não será executada.`);
      return;
    }

    const db = await getDatabaseInstance();

    const confirmationMessages = [];

    let existingPositions;
try {
  existingPositions = await getPositionDetails(symbol);
} catch (error) {
  console.error("Erro ao obter detalhes da posição:", error);
  ctx.reply("Erro ao verificar posição existente. Verifique o console para mais detalhes.");
  return;
}

if (existingPositions.length > 0) {
  const existingPosition = existingPositions[0];
  if (existingPosition.side === side) {
    ctx.reply(`Já existe uma posição aberta para ${symbol} no mesmo lado (${side}). Operação não será realizada.`);
    return;
  } else {
    try {
      await encerrarPosicao(symbol);
      confirmationMessages.push(`Posição existente para ${symbol} encerrada. Enviando nova ordem na direção oposta.`);
    } catch (error) {
      console.error("Erro ao encerrar a posição existente:", error);
      ctx.reply("Erro ao encerrar a posição existente. Verifique o console para mais detalhes.");
      return;
    }
  }
}

    let maxLeverage;
    try {
      maxLeverage = await getMaxLeverage(symbol);
    } catch (error) {
      ctx.reply(`Símbolo inválido:${symbol}.`);
      return;
    }    

    const adjustedLeverage = Math.min(leverage, maxLeverage);
    //console.log(`Alavancagem ajustada para ${symbol}: ${adjustedLeverage}x (Máxima permitida: ${maxLeverage}x)`);

    try {
      const currentLeverage = await getCurrentLeverage(symbol);
      const currentMarginType = await getCurrentMarginType(symbol);
    
      console.log(`Alavancagem atual para ${symbol}: ${currentLeverage}x`);
      console.log(`Tipo de margem atual para ${symbol}: ${currentMarginType}`);
    
      if (currentLeverage !== adjustedLeverage) {
        console.log(`Alterando alavancagem de ${currentLeverage}x para ${adjustedLeverage}x`);
        const leverageResponse = await changeInitialLeverage(symbol, adjustedLeverage);
        if (!leverageResponse || leverageResponse.leverage !== adjustedLeverage) {
          throw new Error(`Erro ao definir alavancagem: ${leverageResponse ? leverageResponse.msg : 'Resposta indefinida'}`);
        }
        console.log(`Alavancagem definida com sucesso para ${adjustedLeverage}x`);
      } else {
        console.log(`Alavancagem já está definida para ${adjustedLeverage}x`);
      }
    
      const expectedMarginType = binanceMarginType.toLowerCase();
      console.log(`Verificando se o tipo de margem ${currentMarginType} é igual a ${expectedMarginType}`);
      
      if (currentMarginType !== expectedMarginType && !(currentMarginType === 'cross' && expectedMarginType === 'crossed')) {
        console.log(`Alterando tipo de margem de ${currentMarginType} para ${expectedMarginType}`);
        const marginTypeResponse = await changeMarginType(symbol, expectedMarginType.toUpperCase());
        if (!marginTypeResponse || marginTypeResponse.code !== 200) {
          throw new Error(`Erro ao definir tipo de margem: ${marginTypeResponse ? marginTypeResponse.msg : 'Resposta indefinida'}`);
        }
        console.log(`Tipo de margem definido com sucesso para ${expectedMarginType}`);
      } else {
        console.log(`Tipo de margem já está definido como ${expectedMarginType}`);
      }
    } catch (error) {
      console.error("Erro ao definir alavancagem ou tipo de margem:", error);
      ctx.reply(`Erro ao definir alavancagem ou tipo de margem: ${error.message}`);
      return;
    }
    
  
  // Adicionando informações da conta
  confirmationMessages.push(`Usuário: giovanni_mnz`);
  confirmationMessages.push(`Saldo da Conta: ${parseFloat(usdtBalance.balance).toFixed(2)} USDT`);
  confirmationMessages.push(`Saldo não realizado: ${parseFloat(usdtBalance.crossUnPnl).toFixed(2)} USDT`);
  confirmationMessages.push(`Capital da Conta: ${(parseFloat(usdtBalance.balance) + parseFloat(usdtBalance.crossUnPnl)).toFixed(2)} USDT`);
  confirmationMessages.push(`Saldo Disponível: ${parseFloat(usdtBalance.availableBalance).toFixed(2)} USDT`);
  confirmationMessages.push('');
  confirmationMessages.push(`SIMBOLO: ${symbol}`);
  confirmationMessages.push('');
  confirmationMessages.push(`Enviando ordem de ${orderType}: ${entryPrice}`);

    let id_posicao;

// Mensagem para confirmar a entrada
const entryMessage = `Enviando ordem de ${orderType}: ${entryPrice}\n\nATIVOS: ${symbol}\n\nENTRADA: ${entryPrice}\n\n`;

// Função auxiliar para formatar o preço removendo zeros desnecessários
function formatPrice(price) {
  return parseFloat(price).toString();
}

// Enviando a ordem de entrada a mercado
const entryResult = await newEntryOrder(symbol, totalEntryQuantity, side);

if (entryResult && entryResult.orderId) { // Verifica se o ID da ordem foi retornado com sucesso
  const idOrdemEntrada = entryResult.orderId;
  const executionPrice = formatPrice(entryResult.price); // Captura e formata o preço de execução

  if (db) { // Verifica se a conexão com o banco de dados foi estabelecida
      try {
          const id_posicao = await insertPosition(db, { simbolo: symbol, quantidade: totalEntryQuantity, preco_medio: executionPrice, status: 'OPEN', data_hora_abertura: data_hora_criacao, side: side, leverage: adjustedLeverage, data_hora_ultima_atualizacao: data_hora_criacao, preco_entrada: executionPrice, preco_corrente: executionPrice });

          await insertNewOrder(db, { tipo_ordem: 'MARKET', preco: executionPrice, quantidade: totalEntryQuantity, id_posicao: id_posicao, status: 'OPEN', data_hora_criacao: data_hora_criacao, id_externo: idOrdemEntrada, side: side, simbolo: symbol, tipo_ordem_bot: 'ENTRADA', target: null, reduce_only: 'f', close_position: 'f', last_update: data_hora_criacao });

          // Atualizando a mensagem de confirmação para o formato correto
          confirmationMessages.push(`Preço de execução: ${executionPrice}`);
          confirmationMessages.push(`Order ID: ${idOrdemEntrada}\n`);
      } catch (error) {
          console.error("Erro ao inserir posição ou ordem de entrada inicial:", error);
          confirmationMessages.push(`Erro ao enviar ordem de entrada inicial\n\nErro ao inserir posição ou ordem de entrada inicial.`);
      }
  } else {
      confirmationMessages.push("Erro ao obter a conexão com o banco de dados.");
  }
} else {
  confirmationMessages.push(`Erro ao enviar ordem de entrada. Nenhum ID de ordem foi retornado.`);
}

    function getTargetPercentages(numTargets) {
        const percentages = {
          1: [100],
          2: [50,50],
          3: [30, 50, 20],
          4: [25, 25, 25, 25],
          5: [25, 20, 15, 20, 20],
          6: [25, 15, 15, 15, 20, 10],
          7: [25, 20, 15, 12, 10, 9, 9],
          8: [18, 22, 14, 12, 10, 8, 8, 8],
          9: [16, 20, 13, 11, 9, 8, 8, 7, 8],
          10: [15, 18, 12, 10, 9, 8, 8, 7, 7, 6],
          11: [14, 16, 12, 10, 9, 8, 7, 7, 6, 6, 5],
          12: [15, 15, 10, 9, 9, 8, 7, 6, 6, 5, 5, 5]
        };
        return percentages[numTargets] || [];
    }

    const targetPercentages = getTargetPercentages(numberOfTargets);
    const quantities = targetPercentages.map(percent => (totalEntryQuantity * (percent / 100)).toFixed(quantityPrecision));

    for (let i = 0; i < targets.length - 1; i++) {
        const targetPrice = targets[i];
        const quantity = quantities[i];
        try {
            const targetResult = await newReduceOnlyOrder(symbol, quantity, side === 'BUY' ? 'SELL' : 'BUY', targetPrice.toFixed(pricePrecision));
            if (targetResult.data && targetResult.data.orderId) {
              const idOrdemAlvo = targetResult.data.orderId;
                await insertNewOrder(db, { tipo_ordem: 'LIMIT', preco: targetPrice, quantidade: quantity, id_posicao: id_posicao, status: 'OPEN', data_hora_criacao: data_hora_criacao, id_externo: idOrdemAlvo, side: side, simbolo: symbol, tipo_ordem_bot: 'REDUCAO PARCIAL', target: i + 1, reduce_only: 't', close_position: 'f', last_update: data_hora_criacao });
                confirmationMessages.push(`Enviando ordem de saída para ALVO ${i + 1}: ${targetPrice}\nOrder ID: ${targetResult.data.orderId}\n`);
            }
        } catch (error) {
            console.error(`Erro ao enviar ordem para Alvo ${i + 1}`, error);
            confirmationMessages.push(`Erro ao enviar ordem para Alvo ${i + 1}`);
        }
    }

    const lastTargetIndex = targets.length - 1;
    const lastTargetPrice = targets[lastTargetIndex].toFixed(pricePrecision);
    const lastTargetQuantity = quantities[lastTargetIndex];
    try {
        const takeProfitResult = await newTakeProfitOrder(symbol, lastTargetQuantity, side === 'BUY' ? 'SELL' : 'BUY', lastTargetPrice);
        if (takeProfitResult.data && takeProfitResult.data.orderId) {
          const idOrdemTakeProfit = takeProfitResult.data.orderId;
            await insertNewOrder(db, { tipo_ordem: 'LIMIT', preco: lastTargetPrice, quantidade: lastTargetQuantity, id_posicao: id_posicao, status: 'OPEN', data_hora_criacao: data_hora_criacao, id_externo: idOrdemTakeProfit, side: side, simbolo: symbol, tipo_ordem_bot: 'TAKE PROFIT', target: null, reduce_only: 't', close_position: 't', last_update: data_hora_criacao });
            confirmationMessages.push(`Enviando ordem de Take Profit: ${lastTargetPrice}\nOrder ID: ${idOrdemTakeProfit}\n`);
        }
    } catch (error) {
        confirmationMessages.push("Erro ao enviar ordem de Take Profit.");
    }

    try {
        let stopLossQuantity = totalEntryQuantity;
        const stopLossResult = await newStopOrder(symbol, stopLossQuantity, side === 'BUY' ? 'SELL' : 'BUY', stopLossPrice);
        if (stopLossResult && stopLossResult.orderId) {
            const idOrdemStopLoss = stopLossResult.orderId;
            await insertNewOrder(db, { tipo_ordem: 'STOP LOSS', preco: stopLossPrice, quantidade: stopLossQuantity, id_posicao: id_posicao, status: 'OPEN', data_hora_criacao: data_hora_criacao, id_externo: idOrdemStopLoss, side: side, simbolo: symbol, tipo_ordem_bot: 'STOP LOSS', target: null, reduce_only: 't', close_position: 't', last_update: data_hora_criacao });
            confirmationMessages.push(`Enviando ordem de Stop Loss: ${stopLossPrice}\nOrder ID: ${idOrdemStopLoss}`);
        } else {
            confirmationMessages.push("Erro ao enviar a ordem de Stop Loss.");
        }
    } catch (error) {
        console.error("Erro ao enviar a ordem de Stop Loss:", error);
        confirmationMessages.push("Erro ao processar a ordem de Stop Loss. Por favor, verifique o console para mais detalhes.");
    }

    const consolidatedMessage = confirmationMessages.join('\n');
    confirmationQueue.push({ ctx, message: consolidatedMessage, originalMessageText: messageText });
    processQueue();

  } catch (error) {
    console.error("Ocorreu um erro:", error);
    ctx.reply("Ocorreu um erro ao processar a ordem. Por favor, verifique o console para mais detalhes.");
  }
});

bot.launch();

console.log("Bot is running...");