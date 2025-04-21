// sniper.js

const schedule = require('node-schedule');
const { getDatabaseInstance, disconnectDatabase, getAllPositionsFromDb, getDataHoraFormatada } = require('../db/conexao');
const { getFuturesAccountBalanceDetails, encerrarPosicao, getAllOpenPositions, getOpenOrders, cancelOrder, getPositionDetails, newStopOrder, getTickSize } = require('../api');

// Conectar ao banco de dados
const db = getDatabaseInstance();

let dinamicCapital = 500;

async function calculateDinamicCapital() {
    try {
        const balanceDetails = await getFuturesAccountBalanceDetails();
        const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
        const balance = parseFloat(usdtBalance.balance);
        const unrealizedPnl = parseFloat(usdtBalance.crossUnPnl);
        const accountCapital = balance + (unrealizedPnl >= 0 ? unrealizedPnl : -unrealizedPnl);
  
        /*
        let margin;
        let step;
        
        if (balance <= 500) {
            margin = 5;
            step = 25;
        } else if (balance <= 1000) {
            margin = 25;
            step = 50;
        } else {
            margin = 50;
            step = 100;
        }
        
        const lowerBound = dinamicCapital - margin;
        const upperBound = dinamicCapital + margin;
        
        if (balance > upperBound || balance < lowerBound) {
            dinamicCapital = Math.floor(balance / step) * step;
        }
    
        // Garantir que o dinamicCapital nunca seja zero ou muito pequeno
        if (dinamicCapital < 1) {
            dinamicCapital = balance; // Usar o saldo como capital dinâmico mínimo
        }
        */
  
        return dinamicCapital;
    } catch (error) {
        console.error('Erro ao calcular o capital dinâmico:', error.message);
        throw error;
    }
}
  
async function monitorarPNL() {
    try {
        const balanceDetails = await getFuturesAccountBalanceDetails();
        const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
        const balance = parseFloat(usdtBalance.balance);
        const unrealizedPnl = parseFloat(usdtBalance.crossUnPnl);
        const balancecapital = parseFloat(balance + unrealizedPnl)
  
        const dinamicCapital = await calculateDinamicCapital(); // Calcula o capital dinâmico
  
        let pnlPercentual = 0;
        if (dinamicCapital !== 0) {
            pnlPercentual = (unrealizedPnl / balance) * 100;
        }

        console.log('________________________________\n');         
        console.log(`Saldo da Conta: ${balance.toFixed(2)} USDT`);
        console.log(`Saldo não realizado: ${unrealizedPnl.toFixed(2)} USDT`);
        console.log(`Capital da conta: ${balancecapital.toFixed(2)} USDT`);
        console.log('');            
        console.log(`Percentual do PNL: ${pnlPercentual.toFixed(2)}%`);
        console.log('');      
        console.log(`Capital Dinâmico: ${dinamicCapital.toFixed(2)} USDT`);
        console.log('________________________________\n');   
  
        if (pnlPercentual > 45.5) {
            console.log('PNL excedeu 27.5% do capital dinâmico. Encerrando posições e ordens...');

            const openPositions = await getAllOpenPositions();
            for (let position of openPositions) {
                await encerrarPosicao(position.simbolo);
                console.log(`Posição para o símbolo ${position.simbolo} foi encerrada.`);
            }
        }
    } catch (error) {
        console.error('Erro ao monitorar PNL:', error.message);
    }
}

/*
function calculatePnl(quantity, entryPrice, stopPrice, side) {
    if (side === 'BUY') {
        return (stopPrice - entryPrice) * quantity;
    } else {
        return (entryPrice - stopPrice) * quantity;
    }
}

async function verificarECancelarOrdens() {
    try {
        const openOrders = await getOpenOrders();
        const openPositions = await getAllOpenPositions();

        // Converte a lista de posições abertas para um Set para facilitar a verificação
        const openPositionSymbols = new Set(openPositions.map(position => position.simbolo));

        for (let order of openOrders) {
            const symbol = order.symbol;
            if (!openPositionSymbols.has(symbol)) {
                // Se não houver posições abertas para este símbolo, cancele a ordem
                try {
                    console.log(`Tentando cancelar ordem: ${order.orderId} para o símbolo: ${symbol}`);
                    await cancelOrder(order.orderId, symbol);
                    console.log(`Ordem ${order.orderId} para o símbolo ${symbol} foi cancelada.`);
                } catch (cancelError) {
                    console.error(`Erro ao cancelar a ordem ${order.orderId} para o símbolo ${symbol}:`, cancelError.response ? cancelError.response.data : cancelError.message);
                }
            }
        }

        for (let position of openPositions) {
            let marginValue;
            if (position.margin_type && position.margin_type.toLowerCase() === 'cross') {
                marginValue = Math.abs(position.maint_margin);
            } else {
                marginValue = Math.abs(position.isolated_margin);
            }

            console.log(`Verificando margem da posição ${position.simbolo}: marginValue = ${marginValue}, margin_type = ${position.margin_type}`);
            if (marginValue < 8) {
                const openOrdersForSymbol = openOrders.filter(order => order.symbol === position.simbolo);
                let stopLossOrder = null;
                for (let order of openOrdersForSymbol) {
                    if (order.type === 'STOP_MARKET' || order.type === 'STOP_LOSS') {
                        stopLossOrder = order;
                        break;
                    }
                }

                if (stopLossOrder) {
                    const stopPrice = parseFloat(stopLossOrder.stopPrice);
                    const pnl = calculatePnl(position.quantidade, position.preco_entrada, stopPrice, position.side);

                    console.log(`Projeção de PNL para o símbolo ${position.simbolo} com stopPrice ${stopPrice}: ${pnl} USDT`);

                    if (pnl <= -0.05 || pnl >= 0.05) {
                        try {
                            console.log(`Tentando cancelar ordem de stop loss: ${stopLossOrder.orderId} para o símbolo: ${position.simbolo}`);
                            await cancelOrder(stopLossOrder.orderId, position.simbolo);
                            console.log(`Ordem de stop loss ${stopLossOrder.orderId} para o símbolo ${position.simbolo} foi cancelada.`);
                            console.log(`Criando nova ordem de stop loss para o símbolo ${position.simbolo} com preço de entrada ${position.preco_entrada}.`);
                            await newStopOrder(position.simbolo, Math.abs(position.quantidade), position.quantidade < 0 ? 'BUY' : 'SELL', position.preco_entrada);
                            console.log(`Nova ordem de stop loss criada para o símbolo ${position.simbolo} com preço de entrada ${position.preco_entrada}.`);
                        } catch (cancelError) {
                            console.error(`Erro ao cancelar a ordem de stop loss ${stopLossOrder.orderId} para o símbolo ${position.simbolo}:`, cancelError.response ? cancelError.response.data : cancelError.message);
                        }
                    } else {
                        console.log(`A ordem de stop loss para o símbolo ${position.simbolo} não precisa ser alterada. PNL: ${pnl} USDT`);
                    }
                } else {
                    console.log(`Criando nova ordem de stop loss para o símbolo ${position.simbolo} com preço de entrada ${position.preco_entrada}.`);
                    await newStopOrder(position.simbolo, Math.abs(position.quantidade), position.quantidade < 0 ? 'BUY' : 'SELL', position.preco_entrada);
                    console.log(`Nova ordem de stop loss criada para o símbolo ${position.simbolo} com preço de entrada ${position.preco_entrada}.`);
                }
            }

            // Verificação se a posição tem stop loss e take profit
            const openOrdersForSymbol = openOrders.filter(order => order.symbol === position.simbolo);
            const hasStopLoss = openOrdersForSymbol.some(order => order.type === 'STOP_MARKET' || order.type === 'STOP_LOSS');
            const hasTakeProfit = openOrdersForSymbol.some(order => order.type === 'TAKE_PROFIT' || order.type === 'TAKE_PROFIT_MARKET');

            const positionAgeMinutes = (Date.now() - new Date(position.data_hora_abertura).getTime()) / 60000;
            if ((!hasStopLoss || !hasTakeProfit) && positionAgeMinutes > 1) {
                await encerrarPosicao(position.simbolo);
                console.log(`Posição ${position.simbolo} encerrada por não ter ordens de stop loss ou take profit após 1 minuto.`);
            }
        }

    } catch (error) {
        console.error('Erro ao verificar e cancelar ordens abertas:', error.message);
    }
}
*/

// Agendar a função para rodar a cada 15 segundos
schedule.scheduleJob('*/15 * * * * *', async function() {
    const dataHora = getDataHoraFormatada();
    console.log(' Monitorando PNL...\n', dataHora);
    await monitorarPNL();
    //await verificarECancelarOrdens();
});

// Desconectar do banco de dados ao encerrar o processo
process.on('SIGINT', () => {
    disconnectDatabase(db);
    process.exit();
});

console.log("Sniper bot is running...");
