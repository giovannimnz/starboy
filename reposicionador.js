const { Telegraf } = require('telegraf');
const { getOpenOrders, cancelOrder, newStopOrder, getPositionDetails } = require('./api');
const { getDataHoraFormatada } = require('./conexao');

const bot = new Telegraf(process.env.BOT_TOKEN_REPOSICIONADOR);

bot.on('text', async (ctx) => {
  try {
    const messageText = ctx.message.text;
    const dataHora = getDataHoraFormatada();
    console.log('_______________________________\n     Mensagem recebida\n Novo Reposicionamento de SL\n', ' ' ,dataHora, '\n_______________________________\n\n', messageText, '\n_______________________________');
    const lines = messageText.split('\n');

    // Verifica se a mensagem é para reposicionar o Stop Loss
    if (lines.length === 4 && lines[2].includes('Alvo de marcação atingido')) {
      const symbol = lines[0].replace('#', '').trim();

      try {
        const newStopLossValue = parseFloat(lines[3].split(':')[1].trim());
        const positionDetails = await getPositionDetails(symbol);
        if (positionDetails.length === 0) {
          const noPositionMessage = `Não há posição aberta para ${symbol}.`;
          ctx.reply(noPositionMessage);
          return;
        }

        const side = positionDetails[0].quantidade > 0 ? 'SELL' : 'BUY';

        // Cancelar todas as ordens de tipo STOP_MARKET abertas para o símbolo
        const stopLossOrders = await getOpenOrders(symbol);
        let cancelCount = 0;
        let lastStopLossPrice = null;
        let lastStopLossOrderId = null;

        for (const order of stopLossOrders) {
          if (order.type === 'STOP_MARKET') {
            lastStopLossPrice = order.stopPrice;
            lastStopLossOrderId = order.orderId;
            await cancelOrder(order.orderId, symbol);
            console.log(`Ordem de Stop Loss cancelada: Order ID ${order.orderId}`);
            cancelCount++;
          }
        }

        // Verificar se havia ordens de Stop Loss para cancelar
        if (cancelCount === 0) {
          // Se nenhuma ordem de Stop Loss foi encontrada, insira uma nova ordem de Stop Loss
          const newStopLossResult = await newStopOrder(symbol, positionDetails[0].quantidade, side, newStopLossValue);
          let responseMessage = `Stop Loss Posicionado: ${newStopLossValue}\nOrder ID: ${newStopLossResult.orderId}\n\nNenhuma ordem de Stop Loss encontrada para o símbolo ${symbol}.\n `;
          console.log(responseMessage.trim());
          ctx.reply(responseMessage.trim());
          return;
        }

        // Enviar a nova ordem de Stop Loss com o novo valor informado na mensagem, se ordens anteriores foram canceladas
        const newStopLossResult = await newStopOrder(symbol, positionDetails[0].quantidade, side, newStopLossValue);
        let newStopLossExecPrice = newStopLossValue; // Inicialmente, o valor enviado
        if (newStopLossResult && newStopLossResult.orderId) {
          // Buscar o preço de execução real da ordem
          newStopLossExecPrice = newStopLossResult.stopPrice;
        }

        // Construir a mensagem de resposta
        let responseMessage = `Stop Loss Reposicionado: ${newStopLossExecPrice}\nOrder ID: ${newStopLossResult.orderId}\n\n`;
        if (lastStopLossPrice && lastStopLossOrderId) {
          responseMessage += `Ordem de Stop Loss existente cancelada: ${lastStopLossPrice}\nOrder ID: ${lastStopLossOrderId}`;
        }

        console.log(responseMessage.trim());
        ctx.reply(responseMessage.trim());
      } catch (error) {
        if (error.message.includes('Símbolo inválido')) {
          const invalidSymbolMessage = `Símbolo inválido: ${symbol}`;
          ctx.reply(invalidSymbolMessage);
        } else {
          console.error('Erro ao processar a mensagem:', error);
          ctx.reply('Ocorreu um erro ao processar sua solicitação.');
        }
      }
    } else {
      ctx.reply('Mensagem inválida ou formato de mensagem incorreto.');
    }
  } catch (error) {
    console.error('Erro ao processar a mensagem:', error);
    ctx.reply('Ocorreu um erro ao processar sua solicitação.');
  }
});

bot.launch();

console.log('Bot reposicionador de Stop Loss está em execução...');