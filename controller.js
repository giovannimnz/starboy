require('dotenv').config();
const { Telegraf, Scenes, session } = require('telegraf');
const {
  getFuturesAccountBalanceDetails,
  getAllOpenPositions,
  encerrarPosicao,
  cancelOrder,
  cancelAllOpenOrders,
  getOpenOrders,
  transferBetweenAccounts
} = require('./api');

const bot = new Telegraf(process.env.BOT_TOKEN_CONTROLLER); // Use o token do novo bot

const cancelOrderScene = new Scenes.WizardScene(
  'cancel-order',
  (ctx) => {
    ctx.reply('Por favor, forneça o ID da ordem que deseja cancelar.');
    return ctx.wizard.next();
  },
  (ctx) => {
    ctx.wizard.state.orderId = ctx.message.text;
    ctx.reply('Por favor, forneça o símbolo da ordem que deseja cancelar.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const orderId = ctx.wizard.state.orderId;
    const symbol = ctx.message.text;
    try {
      const result = await cancelOrderById(orderId, symbol);
      console.log(result);
      ctx.reply(result);
    } catch (error) {
      const errorMessage = `Erro ao cancelar a ordem ${orderId}. Detalhes: ${error.message}`;
      console.log(errorMessage);
      ctx.reply(errorMessage);
    }
    return ctx.scene.leave();
  }
);

const cancelOrdersBySymbolScene = new Scenes.WizardScene(
  'cancel-orders-by-symbol',
  async (ctx) => {
    try {
      const openOrders = await getOpenOrders();
      if (openOrders.length === 0) {
        ctx.reply('Não há ordens abertas.');
        return ctx.scene.leave();
      }

      // Pegar todos os símbolos das ordens abertas
      const symbols = [...new Set(openOrders.map(order => order.symbol))];
      // Consultar posições abertas
      const openPositions = await getAllOpenPositions();
      // Pegar os símbolos das posições que estão realmente abertas
      const openPositionSymbols = openPositions
        .filter(pos => pos.quantidade !== 0)
        .map(pos => pos.simbolo);

      let openPositionsMessage = 'Posições Abertas\n';
      let noOpenPositionsMessage = 'Posições Fechadas\n';
      let count = 1;

      // Agrupar as ordens por símbolo
      const ordersGroupedBySymbol = openOrders.reduce((acc, order) => {
        acc[order.symbol] = acc[order.symbol] || [];
        acc[order.symbol].push(order);
        return acc;
      }, {});

      // Separar as posições abertas das não abertas
      for (const [symbol, orders] of Object.entries(ordersGroupedBySymbol)) {
        const positionsMessage = `${count} - ${symbol} - ${orders.length} Ordens\n`;
        if (openPositionSymbols.includes(symbol)) {
          openPositionsMessage += positionsMessage;
        } else {
          noOpenPositionsMessage += positionsMessage;
        }
        count++;
      }

      const message = 'Informe os números dos símbolos que deseja cancelar as ordens, separados por vírgula\n(Ex: 1, 2):\n\n' + openPositionsMessage + '\n' + noOpenPositionsMessage;
      ctx.reply(message);

      return ctx.wizard.next();
    } catch (error) {
      ctx.reply('Erro ao listar ordens abertas: ' + error.message);
      return ctx.scene.leave();
    }
  },
  async (ctx) => {
    const numbers = ctx.message.text.split(',').map(num => num.trim());
    const openOrders = await getOpenOrders();
    const selectedSymbols = [];
    
    let count = 1;
    const ordersGroupedBySymbol = openOrders.reduce((acc, order) => {
      acc[order.symbol] = acc[order.symbol] || [];
      acc[order.symbol].push(order);
      return acc;
    }, {});

    for (const symbol in ordersGroupedBySymbol) {
      if (numbers.includes(String(count))) {
        selectedSymbols.push(symbol);
      }
      count++;
    }

    try {
      for (const symbol of selectedSymbols) {
        await cancelAllOpenOrders(symbol);
      }
      ctx.reply('Ordens canceladas com sucesso.');
    } catch (error) {
      ctx.reply('Erro ao cancelar ordens: ' + error.message);
    }

    return ctx.scene.leave();
  }
);



const closePositionScene = new Scenes.WizardScene(
  'close-position',
  (ctx) => {
    ctx.reply('Por favor, forneça o símbolo da posição que deseja encerrar.');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const symbol = ctx.message.text;
    try {
      const result = await encerrarPosicao(symbol);
      console.log(result);
      ctx.reply('Posição ', symbol, ' encerrada.');
    } catch (error) {
      const errorMessage = `Erro ao encerrar posição ${symbol}. Detalhes: ${error.message}`;
      console.log(errorMessage);
      ctx.reply(errorMessage);
    }
    return ctx.scene.leave();
  }
);

const transferScene = new Scenes.WizardScene(
  'transfer',
  (ctx) => {
    ctx.reply('Por favor, forneça a quantidade de USDT que deseja transferir.');
    return ctx.wizard.next();
  },
  (ctx) => {
    ctx.wizard.state.amount = ctx.message.text;
    ctx.reply('Por favor, forneça o tipo de transferência:\n\n1: Depósito em Futuros\n2: Saque de Futuros');
    return ctx.wizard.next();
  },
  async (ctx) => {
    const asset = 'USDT';
    const amount = ctx.wizard.state.amount;
    const type = ctx.message.text;
    try {
      const result = await transferBetweenAccounts(asset, amount, type);
      const successMessage = `Transferência concluída com sucesso. ID da transação: ${result.tranId}`;
      console.log(successMessage);
      ctx.reply(successMessage);
    } catch (error) {
      const errorMessage = `Erro ao transferir entre contas. Detalhes: ${error.message}`;
      console.log(errorMessage);
      ctx.reply(errorMessage);
    }
    return ctx.scene.leave();
  }
);

const stage = new Scenes.Stage([cancelOrderScene, cancelOrdersBySymbolScene, closePositionScene, transferScene]);

bot.use(session());
bot.use(stage.middleware());

// Função para obter informações da conta
async function getAccountInfo() {
  try {
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');

    const balance = parseFloat(usdtBalance.balance).toFixed(2);
    const unrealizedPnl = parseFloat(usdtBalance.crossUnPnl).toFixed(2);
    const accountCapital = (parseFloat(usdtBalance.balance) + parseFloat(usdtBalance.crossUnPnl)).toFixed(2);
    const availableBalance = parseFloat(usdtBalance.availableBalance).toFixed(2);

    const accountInfo = `Usuário: giovanni_mnz\n\nSaldo da Conta: ${balance} USDT\nSaldo não realizado: ${unrealizedPnl} USDT\n\nCapital da Conta: ${accountCapital} USDT\n\nSaldo Disponível: ${availableBalance} USDT`;
    console.log("Informações da conta:", accountInfo);
    return accountInfo;
  } catch (error) {
    console.error('Erro ao obter informações da conta:', error.message);
    throw error;
  }
}

// Função para obter posições abertas
async function getOpenPositions() {
  try {
    const openPositions = await getAllOpenPositions();
    if (openPositions.length === 0) {
      const noPositionsMessage = 'Nenhuma posição aberta';
      console.log(noPositionsMessage);
      return noPositionsMessage;
    }

    const positionSymbols = openPositions.map(position => position.simbolo);
    const positionsInfo = `${openPositions.length}\n\n${positionSymbols.join('\n')}`;
    console.log("Posições abertas:", positionsInfo);
    return positionsInfo;
  } catch (error) {
    console.error('Erro ao obter posições abertas:', error.message);
    throw error;
  }
}

// Função para listar ordens abertas
async function getOpenOrdersGroupedBySymbol() {
  try {
    const openPositions = await getAllOpenPositions();
    if (openPositions.length === 0) {
      const noOrdersMessage = 'Nenhuma posição aberta';
      console.log(noOrdersMessage);
      return noOrdersMessage;
    }

    let response = '';
    for (let position of openPositions) {
      response += `\n${position.simbolo}\n`;
      const orders = await getOpenOrders(position.simbolo);
      for (let order of orders) {
        response += `Ordem ID: ${order.orderId}\n`;
      }
    }
    console.log("Ordens abertas agrupadas por símbolo:", response);
    return response;
  } catch (error) {
    console.error('Erro ao obter ordens abertas:', error.message);
    throw error;
  }
}

// Função para cancelar uma ordem específica pelo ID
async function cancelOrderById(orderId, symbol) {
  try {
    const result = await cancelOrder(orderId, symbol);
    const cancelOrderMessage = `Ordem com ID ${orderId} foi cancelada.`;
    console.log(cancelOrderMessage);
    return cancelOrderMessage;
  } catch (error) {
    const errorMessage = `Erro ao cancelar ordem com ID ${orderId}. Detalhes: ${error.message}`;
    console.error(errorMessage);
    return errorMessage;
  }
}

// Função para cancelar todas as ordens abertas de um símbolo específico
async function cancelAllOrdersBySymbol(symbol) {
    try {
      const result = await cancelAllOpenOrders(symbol);
      const cancelAllOrdersMessage = `Todas as ordens abertas para o símbolo ${symbol} foram canceladas.`;
      console.log(cancelAllOrdersMessage);
      return cancelAllOrdersMessage;
    } catch (error) {
      const errorMessage = `Erro ao cancelar todas as ordens para o símbolo ${symbol}. Detalhes: ${error.message}`;
      console.error(errorMessage);
      return errorMessage;
    }
  }

// Função para encerrar todas as posições abertas
async function closeAllPositions() {
  try {
    const openPositions = await getAllOpenPositions();
    if (openPositions.length === 0) {
      const noPositionsMessage = 'Nenhuma posição aberta';
      console.log(noPositionsMessage);
      return noPositionsMessage;
    }

    for (let position of openPositions) {
      await encerrarPosicao(position.simbolo);
      console.log(`Posição para o símbolo ${position.simbolo} foi encerrada.`);
    }

    const closeAllPositionsMessage = 'Todas as posições abertas foram encerradas.';
    console.log(closeAllPositionsMessage);
    return closeAllPositionsMessage;
  } catch (error) {
    const errorMessage = 'Erro ao encerrar todas as posições. Detalhes: ' + error.message;
    console.error(errorMessage);
    return errorMessage;
  }
}

// Função para listar todos os comandos disponíveis
function listCommands() {
  const commands = `
Comandos disponíveis:

/info_conta - Retorna informações da conta
/lista_posicoes - Retorna posições abertas
/lista_ordens - Lista as posições abertas e suas ordens agrupadas pelo símbolo, com o ID de cada ordem
/cancela_ordem - Cancela uma ordem específica pelo ID da ordem
/cancela_ordens_symbol - Cancela todas as ordens abertas para um símbolo específico
/encerra_posicao - Encerra uma posição específica pelo símbolo
/encerra_posicoes_all - Encerra todas as posições abertas
/transferencia_interna - Realiza transferência entre contas spot e futures
/comandos - Lista todos os comandos disponíveis
`;
  console.log("Lista de comandos disponíveis:", commands);
  return commands;
}

// Configurar o bot para responder às mensagens
bot.start((ctx) => {
  const startMessage = 'Olá! Eu sou o bot controlador. Peça por informações da conta ou posições abertas.';
  console.log("Comando /start recebido");
  console.log(startMessage);
  ctx.reply(startMessage);
});

bot.command('info_conta', async (ctx) => {
  console.log("Comando /info_conta recebido");
  try {
    const accountInfo = await getAccountInfo();
    console.log(accountInfo);
    ctx.reply(accountInfo);
  } catch (error) {
    const errorMessage = 'Erro ao obter informações da conta. Detalhes: ' + error.message;
    console.log(errorMessage);
    ctx.reply(errorMessage);
  }
});

bot.command('lista_posicoes', async (ctx) => {
  console.log("Comando /lista_posicoes recebido");
  try {
    const openPositions = await getOpenPositions();
    console.log(openPositions);
    ctx.reply(openPositions);
  } catch (error) {
    const errorMessage = 'Erro ao obter posições abertas. Detalhes: ' + error.message;
    console.log(errorMessage);
    ctx.reply(errorMessage);
  }
});

bot.command('lista_ordens', async (ctx) => {
  console.log("Comando /lista_ordens recebido");
  try {
    const openOrders = await getOpenOrdersGroupedBySymbol();
    console.log(openOrders);
    ctx.reply(openOrders);
  } catch (error) {
    const errorMessage = 'Erro ao obter ordens abertas. Detalhes: ' + error.message;
    console.log(errorMessage);
    ctx.reply(errorMessage);
  }
});

bot.command('cancela_ordem', (ctx) => {
  console.log("Comando /cancela_ordem recebido");
  ctx.scene.enter('cancel-order');
});


bot.command('cancela_ordens_symbol', (ctx) => {
  console.log("Comando /cancela_ordens_symbol recebido");
  ctx.scene.enter('cancel-orders-by-symbol');
});

bot.command('encerra_posicao', (ctx) => {
  console.log("Comando /encerra_posicao recebido");
  ctx.scene.enter('close-position');
});

bot.command('encerra_posicoes_all', async (ctx) => {
  console.log("Comando /encerra_posicoes_all recebido");
  try {
    const result = await closeAllPositions();
    console.log(result);
    ctx.reply(result);
  } catch (error) {
    const errorMessage = 'Erro ao encerrar todas as posições. Detalhes: ' + error.message;
    console.log(errorMessage);
    ctx.reply(errorMessage);
  }
});

bot.command('transferencia_interna', (ctx) => {
  console.log("Comando /transferencia_interna recebido");
  ctx.scene.enter('transfer');
});

bot.command('comandos', (ctx) => {
  console.log("Comando /comandos recebido");
  const commands = listCommands();
  console.log(commands);
  ctx.reply(commands);
});

// Iniciar o bot
bot.launch();

console.log("Controller bot is running...");

process.on('SIGINT', () => {
  bot.stop('SIGINT');
  process.exit();
});

process.on('SIGTERM', () => {
  bot.stop('SIGTERM');
  process.exit();
});
