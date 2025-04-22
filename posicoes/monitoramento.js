const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getTickSize, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, checkOrderExists, getAllOrdersBySymbol, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, initializeDatabase} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Definir funções de callback
async function handleOrderUpdate(message, db) {
    // Extrair os dados corretos dependendo do formato da mensagem
    const orderId = message.i || message.orderId;
    const status = message.X || message.status;
    const symbol = message.s || message.symbol;
  
    console.log(`[ORDER UPDATE] Symbol: ${symbol}, OrderID: ${orderId}, Status: ${status}, Mensagem completa:`, message);
  
    try {
        // Verificar se esta é uma ordem de ENTRADA que foi PREENCHIDA
        if (status === 'FILLED') {
            console.log(`[ORDER UPDATE] Ordem com status FILLED detectada para ${symbol}, ID: ${orderId}`);
            
            // Primeiro verificar se é uma ordem de entrada
            const orders = await getOrdersFromDb(db, { id_externo: orderId });
            console.log(`[ORDER UPDATE] Ordens encontradas no banco:`, orders);
            
            if (orders && orders.length > 0 && orders[0].tipo_ordem_bot === 'ENTRADA') {
                console.log(`[ORDER UPDATE] Ordem de entrada ${orderId} para ${symbol} preenchida. Criando SL e TP...`);

                // Buscar a posição no arquivo posicoes.json com mais tolerância
                const positionsFile = path.join(__dirname, 'posicoes.json');
                console.log(`[ORDER UPDATE] Buscando posições no arquivo: ${positionsFile}`);
                const content = await fs.readFile(positionsFile, 'utf8');
                const positions = JSON.parse(content);
                console.log(`[ORDER UPDATE] Posições encontradas no arquivo:`, positions);
                
                // Encontrar esta posição pelo símbolo e ID da ordem de entrada (com maior tolerância na comparação)
                const position = positions.find(p => 
                    p.symbol === symbol && (
                        String(p.entry_order_id) === String(orderId)
                    )
                );
                
                console.log(`[ORDER UPDATE] Posição encontrada para ordem ${orderId}:`, position);
                
                if (position) {
                    // Atualizar a posição
                    position.status = 'ENTRY_FILLED';
                    position.updated_at = new Date().toISOString();

                    // Garantir que o arquivo seja atualizado
                    console.log(`[ORDER UPDATE] Salvando posições atualizadas no arquivo...`);
                    await fs.writeFile(positionsFile, JSON.stringify(positions, null, 2), 'utf8');
                    console.log(`[ORDER UPDATE] Arquivo de posições atualizado com sucesso!`);
                } else {
                    console.error(`[ORDER UPDATE] Não foi possível encontrar a posição para ordem ${orderId} em ${symbol}. Entradas no JSON:`, 
                        positions.map(p => `${p.symbol}: entry_order_id=${p.entry_order_id} (${typeof p.entry_order_id})`));
                }
            } else {
                console.log(`[ORDER UPDATE] Ordem ${orderId} não é uma ordem de entrada ou não foi encontrada no banco`);
            }
        } else {
            console.log(`[ORDER UPDATE] Status da ordem ${orderId} para ${symbol}: ${status} - não é FILLED`);
        }
    } catch (error) {
        console.error('[ORDER UPDATE] Erro ao processar atualização de ordem:', error);
        console.error(error.stack);
    }
}

async function handleAccountUpdate(message, db) {
    try {
        // Código existente...
    } catch (error) {
        console.error('[ACCOUNT UPDATE] Erro ao processar atualização de conta:', error);
    }
}

// Na inicialização do script
console.log('[INIT] Verificando e configurando modo de posição...');
setPositionMode(false) // Configurar como One-way mode
  .then(() => console.log('[INIT] Modo de posição configurado como One-way'))
  .catch(error => console.error('[INIT] Erro ao configurar modo de posição:', error));
  

// Nova função para processar atualizações de preço (chamada pelo websocket.js)
async function onPriceUpdate(symbol, currentPrice, relevantTrades, positions) {
    try {
        const positionsFile = path.join(__dirname, 'posicoes.json');
        let needsUpdate = false;
        let tradesRemoved = false;
        
        // Criar uma cópia das posições para modificar
        let updatedPositions = [...positions];
        
        // Verificar cada trade relevante
        for (let i = 0; i < relevantTrades.length; i++) {
            const trade = relevantTrades[i];
            
            // Para trades com entrada criada, verificar se o preço atingiu o TP antes da entrada
            if (trade.status === 'ENTRY_CREATED') {
                const entryPrice = parseFloat(trade.entry);
                const tpPrice = parseFloat(trade.tp);
                const side = trade.side === 'COMPRA' ? 'BUY' : 'SELL';
                
                // Se o preço atingiu o TP antes da entrada ser preenchida
                if ((side === 'BUY' && currentPrice >= tpPrice) || 
                    (side === 'SELL' && currentPrice <= tpPrice)) {
                    console.log(`[MONITOR] TP atingido antes da entrada para ${symbol}`);
                    console.log(`[MONITOR] Detalhes: Preço atual=${currentPrice}, TP=${tpPrice}, Entrada=${entryPrice}`);
                    
                    try {
                        // Verificar se já processamos esta ordem
                        if (trade.entry_order_id && cancelledOrders.has(trade.entry_order_id)) {
                            console.log(`[MONITOR] Ordem ${trade.entry_order_id} para ${symbol} já foi cancelada anteriormente. Ignorando.`);
                            continue; // Pular para o próximo trade
                        }

                        // Cancelar a ordem de entrada na Binance
                        await cancelOrder(trade.entry_order_id, symbol);
                        
                        // Adicionar à lista de ordens já canceladas
                        cancelledOrders.add(trade.entry_order_id);
                        
                        // Remover a posição do banco de dados
                        const db = getDatabaseInstance();
                        if (db) {
                            try {
                                // Obter o ID da posição pelo símbolo
                                const positionId = await getPositionIdBySymbol(db, symbol);
                                if (positionId) {
                                    // Excluir posição e ordens associadas do banco de dados
                                    console.log(`[MONITOR] Excluindo posição ${positionId} do banco de dados para ${symbol}`);
                                    await moveClosedPositionsAndOrders(db, positionId);
                                }
                            } catch (dbError) {
                                console.error(`[MONITOR] Erro ao excluir posição do banco: ${dbError.message}`);
                            }
                        }
                        
                        // Verificar o chat_id antes de tentar enviar mensagem
                        if (trade.chat_id && typeof trade.chat_id === 'number') {
                            try {
                                // Verificar se o bot tem acesso ao chat antes de enviar
                                await bot.telegram.getChat(trade.chat_id)
                                    .then(async () => {
                                        await bot.telegram.sendMessage(trade.chat_id, 
                                            `⚠️ Ordem para ${symbol} CANCELADA ⚠️\n\n` +
                                            `O preço-alvo (${tpPrice}) foi atingido antes do ponto de entrada (${entryPrice}).\n\n` +
                                            `Preço atual: ${currentPrice}`
                                        );
                                        console.log(`[MONITOR] Mensagem Telegram enviada com sucesso para ${trade.chat_id}`);
                                    })
                                    .catch(chatError => {
                                        console.log(`[MONITOR] Chat ${trade.chat_id} não existe ou o bot não tem acesso: ${chatError.message}`);
                                    });
                            } catch (telegramError) {
                                console.log(`[MONITOR] Erro no Telegram: ${telegramError.message}`);
                            }
                        } else {
                            console.log(`[MONITOR] Chat ID inválido ou não fornecido: ${trade.chat_id}`);
                        }
                        
                        // Remover este trade do array de positions
                        updatedPositions = updatedPositions.filter(pos => 
                            !(pos.symbol === symbol && pos.entry_order_id === trade.entry_order_id)
                        );
                        
                        tradesRemoved = true;
                        
                        // Atualizar o status para uma identificação clara
                        trade.status = 'CANCELLED_TP_REACHED'; // Status explícito
                        trade.updated_at = new Date().toISOString();
                        
                        // Parar o websocket para este símbolo (opcional, dependendo da lógica)
                        console.log(`[MONITOR] Encerrando monitoramento de preço para ${symbol}`);
                        websockets.stopPriceMonitoring(symbol);
                        
                        // Remove dos trades relevantes para evitar processamento repetido
                        relevantTrades.splice(i, 1);
                        i--; // Ajustar o índice após remoção
                        
                    } catch (cancelError) {
                        console.error(`[MONITOR] Erro ao cancelar ordem: ${cancelError.message}`);
                    }
                }
            }
        }
        
        // Salvar atualizações no arquivo se necessário
        if (tradesRemoved) {
            await fs.writeFile(positionsFile, JSON.stringify(updatedPositions, null, 2));
            console.log(`[MONITOR] Arquivo posicoes.json atualizado - trades cancelados removidos`);
        } else if (needsUpdate) {
            await fs.writeFile(positionsFile, JSON.stringify(positions, null, 2));
        }
    } catch (error) {
        console.error(`[MONITOR] Erro ao processar atualização de preço para ${symbol}:`, error);
    }
}

// Função auxiliar para verificar se um símbolo precisa de monitoramento
async function needsMonitoring(symbol) {
    try {
        const positionsFile = path.join(__dirname, 'posicoes.json');
        const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
        
        if (!fileExists) {
            return false;
        }
        
        const content = await fs.readFile(positionsFile, 'utf8');
        if (!content.trim()) {
            return false;
        }
        
        const positions = JSON.parse(content);
        const needsMonitoring = positions.some(pos => 
            pos.symbol === symbol && 
            ['PENDING_ENTRY', 'ENTRY_CREATED', 'ENTRY_FILLED'].includes(pos.status)
        );
        
        return needsMonitoring;
    } catch (error) {
        console.error(`[MONITOR] Erro ao verificar necessidade de monitoramento para ${symbol}:`, error);
        return false;
    }
}

// Função que realiza as verificações e atualizações necessárias
async function checkAndUpdateOrders() {
    try {
        const db = getDatabaseInstance();
        if (!db) {
            console.log("Banco de dados não disponível. Tentando novamente mais tarde.");
            return;
        }
        
        // Verificar se a tabela ordens existe antes de consultar
        await ensureTablesExist(db);
        
        const partialOrders = await getOrdersFromDb(db, { 
            tipo_ordem_bot: "REDUCAO PARCIAL", 
            target: "1", 
            status: "FILLED"
        }).catch(error => {
            console.error("Erro ao consultar ordens:", error);
            return [];
        });

        const filteredOrders = partialOrders.filter(order => 
            order.renew_sl_firs === null || order.renew_sl_firs === undefined
        );

        if (!filteredOrders || filteredOrders.length === 0) {
            return; // Nenhuma ordem para processar
        }

        for (let order of filteredOrders) {
            try {
                // Cancelar a ordem de stop loss existente
                await cancelOrder(order.id_externo, order.simbolo);

                // Obter preço médio da posição
                const position = await getPositionById(db, order.id_posicao);
                if (!position) {
                    console.error(`Posição com ID ${order.id_posicao} não encontrada`);
                    continue;
                }
                
                const averagePrice = position.preco_medio;

                // Determinar o lado oposto para a nova ordem de stop loss
                const side = order.side === 'BUY' ? 'SELL' : 'BUY';

                // Enviar nova ordem de stop loss com o preço médio
                const newStopLossResult = await newStopOrder(order.simbolo, order.quantidade, side, averagePrice);
                if (newStopLossResult.data && newStopLossResult.data.orderId) {
                    // Inserir a nova ordem no banco de dados
                    const id_posicao = await getPositionIdBySymbol(db, order.simbolo);
                    await insertNewOrder(db, {
                        tipo_ordem: 'STOP LOSS',
                        preco: averagePrice,
                        quantidade: order.quantidade,
                        id_posicao: id_posicao,
                        status: 'OPEN',
                        data_hora_criacao: new Date().toISOString(),
                        id_externo: newStopLossResult.data.orderId,
                        side: side,
                        simbolo: order.simbolo,
                        tipo_ordem_bot: 'STOP LOSS',
                        target: null,
                        reduce_only: true,
                        close_position: true,
                        last_update: new Date().toISOString()
                    });
                    console.log(`New stop loss order created with ID: ${newStopLossResult.data.orderId}`);
                } else {
                    console.error("Error creating new stop loss order on Binance.");
                }

                // Atualizar o banco de dados para refletir que o stop loss foi renovado
                await updateOrderRenewFlag(db, order.id);
            } catch (error) {
                console.error(`Erro ao processar ordem ${order.id_externo}:`, error);
            }
        }
    } catch (error) {
        console.error("Erro geral em checkAndUpdateOrders:", error);
        // Não há tentativa de recuperação
    }
}

// Adicionar esta nova função para garantir que as tabelas existam
async function ensureTablesExist(db) {
    return new Promise((resolve, reject) => {
        // Verificar se a tabela 'ordens' existe
        db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ordens'", (err, row) => {
            if (err) {
                reject(err);
                return;
            }
            
            if (!row) {
                console.log("Tabela 'ordens' não encontrada. Inicializando o banco de dados...");
                initializeDatabase();
                setTimeout(() => {
                    resolve();
                }, 1000); // Hardcoded timeout
            } else {
                resolve();
            }
        });
    });
}

// Adicionar esta função ao arquivo monitoramento.js
async function getPositionById(db, id_posicao) {
  return new Promise((resolve, reject) => {
    db.get("SELECT * FROM posicoes WHERE id = ?", [id_posicao], (err, row) => {
      if (err) {
        console.error("Erro ao buscar posição por ID:", err);
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

// Adicionar também esta função que é chamada mas não definida
async function updateOrderRenewFlag(db, orderId) {
  return new Promise((resolve, reject) => {
    const sql = "UPDATE ordens SET renew_sl_firs = 'TRUE' WHERE id = ?";
    db.run(sql, [orderId], function(err) {
      if (err) {
        console.error(`Erro ao atualizar flag de renovação para ordem ${orderId}:`, err.message);
        reject(err);
      } else {
        console.log(`Flag de renovação atualizado para ordem ${orderId}`);
        resolve();
      }
    });
  });
}

// Agendar a função checkAndUpdateOrders para rodar a cada 2 minutos
schedule.scheduleJob('*/2 * * * *', function() {
    //console.log('Running checkAndUpdateOrders...');
    checkAndUpdateOrders();
});

// Função para atualizar o arquivo leverage.json
async function updateLeverageBrackets() {
  try {
    //console.log('[SCHEDULER] Iniciando atualização dos brackets de alavancagem...');
    
    // Obter os brackets de alavancagem atualizados da API
    const brackets = await getAllLeverageBrackets();
    
    // Definir o caminho para o arquivo leverage.json
    const leverageFilePath = path.join(__dirname, '..', 'indicadores', 'leverage.json');
    
    // Salvar os brackets no arquivo leverage.json com formatação para legibilidade
    await fs.writeFile(leverageFilePath, JSON.stringify(brackets, null, 2));
    
    //console.log('[SCHEDULER] Arquivo leverage.json atualizado com sucesso!');
    console.log(`[SCHEDULER] Total de símbolos atualizados: ${brackets.length}`);
    
    // Verificar se algum símbolo específico está presente para validação
    const btcBracket = brackets.find(b => b.symbol === 'BTCUSDT');
    if (btcBracket) {
      //console.log('[SCHEDULER] Exemplo de bracket para BTCUSDT:', 
        //btcBracket.brackets.map(b => b.cum).slice(0, 3), '...');
    }
    
    return brackets;
  } catch (error) {
    console.error('[SCHEDULER] Erro ao atualizar brackets de alavancagem:', error);
    throw error;
  }
}

// Agendar a execução diária às 03:00
schedule.scheduleJob('0 3 * * *', function() {
  console.log('[SCHEDULER] Executando atualização programada dos brackets de alavancagem...');
  updateLeverageBrackets()
    .then(() => console.log('[SCHEDULER] Atualização programada concluída com sucesso'))
    .catch(error => console.error('[SCHEDULER] Falha na atualização programada:', error));
});

// Adicionar essa linha antes de iniciar o startUserDataStream
//console.log('[INIT] Realizando primeira atualização de brackets de alavancagem ao iniciar...');
updateLeverageBrackets()
  //.then(() => console.log('[INIT] Primeira atualização de brackets concluída'))
  //.catch(error => console.error('[INIT] Falha na primeira atualização de brackets:', error));

// Função para monitorar o arquivo posicoes.json
async function monitorPositionsFile() {
  //console.log('[MONITOR] Iniciando monitoramento do arquivo posicoes.json');
  
  try {
    // Verificar arquivo imediatamente na inicialização
    await checkNewTrades();
    
    // Agendar verificações a cada 5 segundos
    setInterval(async () => {
        await checkNewTrades();
    }, 5000);
    // Nunca é limpo com clearInterval
  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento:', error);
  }
}

// Função para verificar novos trades no arquivo posicoes.json
async function checkNewTrades() {
  try {
    const positionsFile = path.join(__dirname, 'posicoes.json');
    
    const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
    if (!fileExists) {
      return; // Arquivo não existe ainda
    }
    
    const content = await fs.readFile(positionsFile, 'utf8');
    if (!content.trim()) {
      return; // Arquivo vazio
    }
    
    const positions = JSON.parse(content);
    
    // Filtrar trades pendentes (ainda não processados)
    const pendingTrades = positions.filter(trade => trade.status === 'PENDING_ENTRY');
    
    for (const trade of pendingTrades) {
      console.log(`[MONITOR] Processando novo trade pendente: ${trade.symbol}`);
      await processNewTrade(trade, positions);
      
      // Atualizar o arquivo após processar cada trade
      await fs.writeFile(positionsFile, JSON.stringify(positions, null, 2));
    }
    
    // Monitorar também posições abertas
    const openTrades = positions.filter(trade => 
      ['ENTRY_CREATED', 'ENTRY_FILLED'].includes(trade.status)
    );
    
    for (const trade of openTrades) {
      websockets.ensurePriceWebsocketExists(trade.symbol);
    }
    
    // Verificar se há trades que foram cancelados mas ainda estão no arquivo
    const canceledTrades = positions.filter(trade => 
      trade.status === 'CANCELLED_TP_REACHED'
    );
    
    if (canceledTrades.length > 0) {
      console.log(`[MONITOR] Removendo ${canceledTrades.length} trades cancelados do arquivo`);
      const updatedPositions = positions.filter(trade => 
        trade.status !== 'CANCELLED_TP_REACHED'
      );
      await fs.writeFile(positionsFile, JSON.stringify(updatedPositions, null, 2));
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar novos trades:', error);
  }
}

// Função para processar um novo trade
async function processNewTrade(trade, allPositions) {
  const db = getDatabaseInstance();
  
  try {
    // Preparar parâmetros para a ordem de entrada
    const symbol = trade.symbol;
    const side = trade.side === 'COMPRA' ? 'BUY' : 'SELL';
    const price = parseFloat(trade.entry);
    const leverage = parseInt(trade.leverage, 10);
    const capitalPct = parseFloat(trade.capital_pct);
    
    // Obter detalhes da conta
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');
    const capital = parseFloat(usdtBalance.balance) * (capitalPct / 100);
    
    // Calcular quantidade
    const tickSizeData = await getTickSize(symbol);
    const { quantityPrecision } = await getPrecision(symbol);
    const totalUSDT = capital * leverage;
    const quantity = (totalUSDT / price).toFixed(quantityPrecision);
    
    // Configurar alavancagem e tipo de margem
    await changeInitialLeverage(symbol, leverage);
    await changeMarginType(symbol, 'ISOLATED');
    
    // Criar ordem LIMIT de entrada
    const entryOrderResult = await newOrder(symbol, quantity, side, price);
    console.log(`[MONITOR] Ordem de entrada criada para ${symbol} com ID: ${entryOrderResult.data.orderId}`);
    
    // Atualizar o status no array de posições
    trade.status = 'ENTRY_CREATED';
    trade.entry_order_id = entryOrderResult.data.orderId;
    trade.updated_at = new Date().toISOString();
    
    // Inserir no banco de dados
    const id_posicao = await insertPosition(db, {
      simbolo: symbol,
      quantidade: quantity,
      preco_entrada: price,
      preco_medio: price,
      status: 'PENDING',
      data_hora_abertura: new Date().toISOString(),
      side: side,
      leverage: leverage,
      data_hora_ultima_atualizacao: new Date().toISOString(),
      preco_corrente: price
    });
    
    // Inserir a ordem de entrada no banco
    await insertNewOrder(db, {
      tipo_ordem: 'LIMIT',
      preco: price,
      quantidade: quantity,
      id_posicao: id_posicao,
      status: 'OPEN',
      data_hora_criacao: new Date().toISOString(),
      id_externo: entryOrderResult.data.orderId,
      side: side,
      simbolo: symbol,
      tipo_ordem_bot: 'ENTRADA',
      target: null,
      reduce_only: false,
      close_position: false,
      last_update: new Date().toISOString()
    });
    
    // Iniciar monitoramento de preço para este símbolo
    websockets.ensurePriceWebsocketExists(symbol);
    
  } catch (error) {
    console.error(`[MONITOR] Erro ao processar novo trade para ${trade.symbol}:`, error);
    trade.status = 'ERROR';
    trade.error = error.message;
    trade.updated_at = new Date().toISOString();
  }
}

// Adicione esta função para limpar posições com status ERROR
async function cleanErrorPositions() {
    try {
        const positionsFile = path.join(__dirname, 'posicoes.json');
        const fileExists = await fs.access(positionsFile).then(() => true).catch(() => false);
        
        if (!fileExists) {
            return;
        }
        
        const content = await fs.readFile(positionsFile, 'utf8');
        if (!content.trim()) {
            return;
        }
        
        const positions = JSON.parse(content);
        const originalCount = positions.length;
        
        // Filtrar todas as posições com status ERROR
        const updatedPositions = positions.filter(pos => pos.status !== 'ERROR');
        
        const removedCount = originalCount - updatedPositions.length;
        if (removedCount > 0) {
            console.log(`[MONITOR] Removendo ${removedCount} posições com status ERROR`);
            await fs.writeFile(positionsFile, JSON.stringify(updatedPositions, null, 2));
        }
    } catch (error) {
        console.error('[MONITOR] Erro ao limpar posições com erro:', error);
    }
}

// Iniciar o monitoramento do arquivo posicoes.json
monitorPositionsFile();

// Adicionar essa linha antes de iniciar o startUserDataStream
//console.log('[INIT] Iniciando monitoramento de trades e posições...');

// Registrar os callbacks no módulo websockets
websockets.setMonitoringCallbacks({
  handleOrderUpdate,
  handleAccountUpdate,
  onPriceUpdate
});

// Iniciar o monitoramento
websockets.startUserDataStream(getDatabaseInstance).catch(console.error);

// Chamar esta função periodicamente ou na inicialização
cleanErrorPositions().catch(console.error);

// Não precisamos mais exportar estas funções
module.exports = {};

// Comentários explicativos sobre a dependência circular entre os módulos
// monitoramento.js requer websockets.js 
// websockets.js acessa funções de monitoramento.js
