const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { getCurrentMarginType, cancelOrder, newStopOrder, cancelAllOpenOrders, getFuturesAccountBalanceDetails, changeInitialLeverage, changeMarginType, getPositionDetails, getOpenOrders, getAllOpenPositions, updateLeverageBracketsInDatabase } = require('../api');
const {getDatabaseInstance, updatePositionStatus, insertNewOrder, updateOrderStatus, moveClosedPositionsAndOrders, formatDateForMySQL, getBaseCalculoBalance, updateAccountBalance} = require('../db/conexao');
const { executeLimitMakerEntry } = require('./limitMakerEntry');
const websockets = require('../websockets');
const websocketApi = require('../websocketApi');

const latestPrices = new Map();

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();

// Conjunto para controlar sinais em processamento
const processingSignals = new Set();

// Mapa para armazenar últimas atualizações de log de preço
const lastPriceLogTime = {};

// Intervalo para log de preços (ms)
const PRICE_LOG_INTERVAL = 60000; // 1 minuto

// Contador para verificar quando fechar websockets sem atividade
const websocketEmptyCheckCounter = {};
const lastTrailingCheck = {}; // Para controlar quando foi a última verificação por posição
const positionsWithoutSL = new Set(); // Conjunto para armazenar IDs de posições sem SL
const MIN_CHECK_INTERVAL = 10000; // 10 segundos entre verificações para a mesma posição
const TWO_MINUTES_RECHECK_NO_SL = 2 * 60 * 1000; // 2 minutos para rechecar posições marcadas como sem SL

// Adicionar mapa para armazenar instâncias de bots por conta
const telegramBots = new Map();

// Função para inicializar o bot do Telegram para uma conta específica
async function initializeTelegramBot(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[TELEGRAM] Falha ao obter instância do banco de dados para conta ${accountId}`);
      return null;
    }

    // Buscar token do bot no banco de dados
    const [rows] = await db.query(
      'SELECT telegram_bot_token FROM contas WHERE id = ?',
      [accountId]
    );

    if (rows.length === 0 || !rows[0].telegram_bot_token) {
      console.error(`[TELEGRAM] Token do bot não encontrado para conta ${accountId}`);
      return null;
    }

    const botToken = rows[0].telegram_bot_token;
    
    // Verificar se já temos um bot para este token
    const existingBot = Array.from(telegramBots.values())
      .find(b => b.token === botToken);
    
    if (existingBot) {
      console.log(`[TELEGRAM] Reutilizando instância existente do bot para conta ${accountId}`);
      telegramBots.set(accountId, existingBot);
      return existingBot.bot;
    }
    
    // Criar nova instância do bot
    console.log(`[TELEGRAM] Inicializando bot do Telegram para conta ${accountId} com token: ${botToken.substring(0, 8)}...`);
    const bot = new Telegraf(botToken);
    
    // Configurar handlers básicos
    bot.catch((err) => {
      console.error(`[TELEGRAM] Erro no bot da conta ${accountId}:`, err);
    });
    
    // Iniciar o bot
    await bot.launch();
    console.log(`[TELEGRAM] Bot do Telegram inicializado com sucesso para conta ${accountId}`);
    
    // Armazenar no mapa
    telegramBots.set(accountId, { bot, token: botToken });
    
    return bot;
  } catch (error) {
    console.error(`[TELEGRAM] Erro ao inicializar bot do Telegram para conta ${accountId}:`, error);
    return null;
  }
}

// Função para obter o bot do Telegram para uma conta específica
function getTelegramBot(accountId = 1) {
  const botInfo = telegramBots.get(accountId);
  return botInfo ? botInfo.bot : null;
}

// Inicializar handlers
let handlers = {};
let scheduledJobs = {};

function determineOrderType(orderMsg) {
  // Se for ordem de tipo STOP ou TAKE_PROFIT com lado oposto à posição, é um SL ou TP
  if (orderMsg.o && orderMsg.o.toLowerCase().includes('stop') && orderMsg.R) {
    return 'STOP_LOSS';
  } else if (orderMsg.o && orderMsg.o.toLowerCase().includes('take_profit') && orderMsg.R) {
    return 'TAKE_PROFIT';
  } else {
    // Para outros casos, assumir ENTRADA por padrão
    return 'ENTRADA';
  }
}

// Atualizar dados de alavancagem ao iniciar o sistema
(async () => {
  try {
    await updateLeverageBracketsInDatabase();
    //console.log('Dados de alavancagem atualizados com sucesso.');
  } catch (error) {
    console.error('Erro ao atualizar dados de alavancagem:', error);
  }
})();

const accountId = process.argv.includes('--account') 
  ? parseInt(process.argv[process.argv.indexOf('--account') + 1]) || 1 
  : 1;

console.log(`[MONITOR] Iniciando sistema de monitoramento para conta ID: ${accountId}`);

// Função para inicializar o monitoramento
async function initializeMonitoring(accountId = 1) {
  console.log(`[MONITOR] Inicializando sistema de monitoramento para conta ID: ${accountId}...`);

  try {
    // Obter conexão com o banco de dados
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Falha ao obter conexão com o banco de dados para conta ${accountId}`);
    }

    // Inicializar o bot do Telegram para esta conta
    const bot = await initializeTelegramBot(accountId);
    
    if (!bot) {
      console.log(`[MONITOR] Bot do Telegram não inicializado para conta ${accountId}`);
    } else {
      console.log(`[MONITOR] Bot do Telegram inicializado com sucesso para conta ${accountId}`);
    }
    
    // Inicializar os handlers no websocketApi
    try {
      await websocketApi.initializeHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers inicializados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[MONITOR] Erro ao inicializar WebSocket API handlers:`, wsError);
      // Continuar mesmo com erro, já que podemos usar API REST como fallback
    }
    
    // Primeiro configurar handlers com os callbacks adaptados para accountId
    handlers = {
      handleOrderUpdate: async (msg, db) => await handleOrderUpdate(msg, db, accountId),
      handleAccountUpdate: async (msg, db) => await handleAccountUpdate(msg, db, accountId),
      onPriceUpdate: async (symbol, price, db) => await onPriceUpdate(symbol, price, db, accountId),
      getDbConnection: async () => await getDatabaseInstance(accountId)
    };
    
    // Usar os handlers configurados nos websockets
    websockets.setMonitoringCallbacks(handlers);
    
    // Iniciar userDataStream para esta conta
    try {
      await websockets.startUserDataStream(db, accountId);
      console.log(`[MONITOR] UserDataStream iniciado para conta ${accountId}`);
    } catch (userDataError) {
      console.error(`[MONITOR] Erro ao iniciar UserDataStream:`, userDataError);
      // Continuar mesmo com erro
    }

    // Verificar sinais pendentes ao iniciar
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, status 
      FROM webhook_signals 
      WHERE status IN ('PENDING', 'PROCESSANDO', 'AGUARDANDO_ACIONAMENTO')
      AND (conta_id = ? OR conta_id IS NULL)
    `, [accountId]);

    console.log(`[MONITOR] Ao iniciar, encontrados ${pendingSignals.length} sinais pendentes para conta ${accountId}:`);
    pendingSignals.forEach(signal => {
      console.log(`  - ID: ${signal.id}, Symbol: ${signal.symbol}, Side: ${signal.side}, Entry: ${signal.entry_price}`);
    });

    // Executar verificação inicial de novas operações imediatamente
    console.log(`[MONITOR] Executando verificação imediata de sinais pendentes...`);
    setTimeout(() => {
      checkNewTrades(accountId).catch(error => {
        console.error(`[MONITOR] Erro na verificação imediata de sinais:`, error);
      });
    }, 5000);

    // Agendar jobs específicos para esta conta
    const accountJobs = {};
    
    // Agendar verificação periódica de novas operações a cada 15 segundos
    console.log(`[MONITOR] Agendando verificação periódica de sinais a cada 15 segundos`);
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      try {
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro no job de verificação de sinais:`, error);
      }
    });
    
    // Iniciar monitoramento de preços para posições abertas
    await startPriceMonitoring(accountId);

    // Sincronizar posições com a corretora
    try {
      await syncPositionsWithExchange(accountId);
    } catch (syncError) {
      console.error(`[MONITOR] Erro ao sincronizar posições:`, syncError);
    }

    await logOpenPositionsAndOrders(accountId);

    console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
    
    return accountJobs;
  } catch (error) {
    console.error(`[MONITOR] Erro na configuração inicial para conta ${accountId}: ${error.message}`);
    throw error;
  }
}

const originalGetDatabaseInstance = getDatabaseInstance;
async function getDatabaseInstanceWithAccountId() {
  const db = await originalGetDatabaseInstance();
  // Armazenar o accountId no objeto de conexão para uso posterior
  db.accountId = accountId;
  return db;
}

async function logOpenPositionsAndOrders() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Obter posições abertas do banco
    const [dbPositions] = await db.query(`SELECT id, simbolo, quantidade, preco_entrada, preco_corrente, side FROM posicoes WHERE status = 'OPEN'`);
    
    // Obter ordens pendentes
    const [pendingOrders] = await db.query(`
      SELECT simbolo, tipo_ordem_bot, tipo_ordem, preco, quantidade, status, side 
      FROM ordens 
      WHERE status IN ('NEW', 'PARTIALLY_FILLED')
      ORDER BY simbolo, tipo_ordem_bot
    `);

    // Obter posições abertas da corretora para comparação
    const exchangePositions = await getAllOpenPositions();
    
    console.log('\n=== POSIÇÕES ABERTAS E ORDENS PENDENTES ===');
    console.log(`[MONITOR] Posições no banco: ${dbPositions.length} | Posições na corretora: ${exchangePositions.length}`);
    
    // Mostrar posições do banco
    if (dbPositions.length > 0) {
      console.log('\n[MONITOR] POSIÇÕES ABERTAS NO BANCO:');
      dbPositions.forEach(pos => {
        console.log(`  ${pos.simbolo}: ${pos.side} ${pos.quantidade} @ ${pos.preco_entrada} (Atual: ${pos.preco_corrente})`);
      });
    }
    
    // Mostrar posições da corretora
    if (exchangePositions.length > 0) {
      console.log('\n[MONITOR] POSIÇÕES ABERTAS NA CORRETORA:');
      exchangePositions.forEach(pos => {
        console.log(`  ${pos.simbolo}: ${pos.side} ${pos.quantidade} @ ${pos.preco_entrada}`);
      });
    }
    
    // Mostrar ordens pendentes
    if (pendingOrders.length > 0) {
      console.log('\n[MONITOR] ORDENS PENDENTES:');
      pendingOrders.forEach(order => {
        console.log(`  ${order.simbolo}: ${order.tipo_ordem_bot} (${order.tipo_ordem}) - ${order.side} ${order.quantidade} @ ${order.preco}`);
      });
    }
    
    console.log('===========================================\n');
  } catch (error) {
    console.error('[MONITOR] Erro ao obter posições e ordens:', error);
  }
}

async function syncPositionsWithExchange() {
  try {
    const db = await getDatabaseInstance(); // Presume que getDatabaseInstance() está definida
    if (!db) {
        console.error('[SYNC] Não foi possível obter instância do banco de dados.');
        return;
    }

    // 1. Obter posições abertas do banco
    // Adicionado um log para a query, caso seja útil para debug
    // console.log('[SYNC] Buscando posições abertas no banco de dados...');
    const [dbPositions] = await db.query(`SELECT id, simbolo, quantidade FROM posicoes WHERE status = 'OPEN'`);

    // 2. Obter posições da corretora
    // console.log('[SYNC] Buscando posições abertas na corretora...');
    const exchangePositions = await getAllOpenPositions(); // Presume que getAllOpenPositions() está definida

    //console.log(`[SYNC] Verificando ${dbPositions.length} posições abertas no banco vs ${exchangePositions.length} na corretora...`);

    // 3. Mapear posições da corretora por símbolo
    const exchangePositionsMap = {};
    exchangePositions.forEach(pos => {
      exchangePositionsMap[pos.simbolo] = pos;
    });

    // 4. Verificar posições que existem no banco mas não na corretora (fechadas)
    for (const dbPos of dbPositions) {
      if (!exchangePositionsMap[dbPos.simbolo]) {
        console.log(`[SYNC] Posição ${dbPos.simbolo} [DB ID: ${dbPos.id}] não encontrada na corretora. Fazendo verificação adicional...`);
        
        // ADICIONAR AQUI: Verificação adicional para confirmar que a posição realmente não existe
        try {
          // Fazer uma chamada direta à API para verificar esta posição específica
          const positionDetails = await getPositionDetails(dbPos.simbolo);
          const hasOpenPosition = positionDetails && positionDetails.some(pos => 
              parseFloat(pos.quantidade) > 0);
              
          if (hasOpenPosition) {
            console.log(`[SYNC] Segunda verificação confirmou que ${dbPos.simbolo} ainda está aberta. Mantendo registro.`);
            continue; // Pular para o próximo item do loop
          }
          
          // Se chegou aqui, a posição realmente não existe
          console.log(`[SYNC] Segunda verificação confirmou que ${dbPos.simbolo} está fechada. Movendo para histórico.`);
        } catch (detailsError) {
          console.error(`[SYNC] Erro ao verificar detalhes da posição ${dbPos.simbolo}:`, detailsError);
          // Se ocorreu erro na verificação adicional, não fechar a posição para ser seguro
          console.log(`[SYNC] Devido ao erro na verificação, mantendo posição ${dbPos.simbolo} no banco.`);
          continue;
        }
        
        await movePositionToHistory(db, dbPos.id, 'CLOSED', 'Fechada na corretora (detectado por sincronização)');
        console.log(`[SYNC] Posição ${dbPos.simbolo} [DB ID: ${dbPos.id}] movida para o histórico.`);
        
        // Verificar e fechar websocket
        setTimeout(async () => {
          try {
            await checkAndCloseWebsocket(db, dbPos.simbolo);
          } catch (wsError) {
            console.error(`[SYNC] Erro ao tentar fechar websocket para ${dbPos.simbolo}:`, wsError);
          }
        }, 5000);
      }
    }

    for (const pos of exchangePositions) {
      if (Math.abs(pos.quantidade) > 0) {
      //console.log(`[SYNC] Garantindo websocket ativo para ${pos.simbolo} com posição aberta`);
      websockets.ensurePriceWebsocketExists(pos.simbolo);
    }
  }

  } catch (error) {
    console.error(`[SYNC] Erro crítico ao sincronizar posições com a corretora: ${error.message}`, error.stack || error);
  }
}

// Função para iniciar monitoramento de preços para posições abertas
async function startPriceMonitoring(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Falha ao obter instância do banco de dados para conta ${accountId}`);
    }

    // Obter posições abertas ou com ordens de entrada pendentes
    const [pendingEntries] = await db.query(`
      SELECT o.simbolo
      FROM ordens o
      WHERE o.tipo_ordem_bot = 'ENTRADA' AND o.status = 'OPEN' AND o.conta_id = ?
      GROUP BY o.simbolo
    `, [accountId]);

    const [openPositions] = await db.query(`
      SELECT simbolo
      FROM posicoes
      WHERE status = 'OPEN' AND conta_id = ?
    `, [accountId]);

    // Obter sinais em AGUARDANDO_ACIONAMENTO ou PENDING
    const [pendingSignals] = await db.query(`
      SELECT symbol, timeframe, created_at, timeout_at, max_lifetime_minutes
      FROM webhook_signals
      WHERE (status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING') AND conta_id = ?
    `, [accountId]);

    console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para monitoramento (conta ${accountId})`);

    const symbols = new Set();

    // Adicionar símbolos com ordens pendentes
    pendingEntries.forEach(entry => symbols.add(entry.simbolo));

    // Adicionar símbolos com posições abertas
    openPositions.forEach(position => symbols.add(position.simbolo));

    // Adicionar símbolos com sinais pendentes
    pendingSignals.forEach(signal => symbols.add(signal.symbol));

  // Iniciar websockets para cada símbolo
  for (const symbol of symbols) {
    console.log(`[MONITOR] Iniciando monitoramento de preço para ${symbol}`);
    await websockets.ensurePriceWebsocketExists(symbol, accountId);
    
    // Garantir que temos o símbolo no cache de preços
    if (!latestPrices.has(symbol)) {
      try {
        // Inicializar com o preço atual via REST API
        const price = await getCurrentPrice(symbol);
        latestPrices.set(symbol, {
          price,
          timestamp: Date.now(),
          bid: price * 0.9999,
          ask: price * 1.0001
        });
      } catch (error) {
        console.warn(`[MONITOR] Não foi possível inicializar o preço para ${symbol}:`, error);
      }
    }
  }

    return symbols.size;
  } catch (error) {
    console.error(`[MONITOR] Erro ao iniciar monitoramento de preços para conta ${accountId}:`, error);
    throw error;
  }
}

// Função auxiliar para obter preço atual via API
/**
 * Função para obter preço atual via REST API com credenciais da conta específica
 * @param {string} symbol - Símbolo do par
 * @param {number} accountId - ID da conta
 * @returns {Promise<number|null>} - Preço atual ou null se falhar
 */
async function getCurrentPrice(symbol, accountId = 1) {
  try {
    // Obter credenciais da conta específica para usar a URL correta
    const api = require('../api');
    const credentials = await api.loadCredentialsFromDatabase(accountId);
    
    if (!credentials || !credentials.apiUrl) {
      throw new Error(`Credenciais não disponíveis para conta ${accountId}`);
    }
    
    // Construir URL completa com a URL da API correta
    const url = `${credentials.apiUrl}/v1/ticker/price?symbol=${symbol}`;
    console.log(`[MONITOR] Obtendo preço atual via REST API: ${url}`);
    
    const response = await axios.get(url);
    if (response.data && response.data.price) {
      const price = parseFloat(response.data.price);
      console.log(`[MONITOR] Preço atual de ${symbol} obtido via REST API: ${price}`);
      return price;
    }
    
    console.error(`[MONITOR] Resposta da API sem preço:`, response.data);
    return null;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter preço atual para ${symbol}:`, error);
    return null;
  }
}

// Função para verificar novas operações e criar ordens
async function checkNewTrades(accountId = 1) {
  try {
    const startTime = Date.now();
    console.log(`[MONITOR] Verificando sinais pendentes para conta ${accountId} às ${new Date().toLocaleString()}`);
    
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      console.error(`[MONITOR] Falha ao obter instância do banco de dados para conta ${accountId}`);
      return;
    }

    // Verificar sinais PENDING na tabela webhook_signals
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING' AND (conta_id = ? OR conta_id IS NULL)
      ORDER BY created_at ASC
    `, [accountId]);

    if (pendingSignals.length === 0) {
      console.log(`[MONITOR] Nenhum sinal pendente encontrado para conta ${accountId}`);
      return;
    }

    console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para processar (Conta ${accountId})`);

    // Processar cada sinal pendente
    for (const signal of pendingSignals) {
      try {
        console.log(`[MONITOR] Iniciando processamento do sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} @ ${signal.entry_price}`);
        
        // Verificar se já está em processamento (prevenir duplicação)
        if (processingSignals.has(signal.id)) {
          console.log(`[MONITOR] Sinal ID ${signal.id} já está sendo processado, ignorando.`);
          continue;
        }
        
        // Marcar como em processamento
        processingSignals.add(signal.id);
        
        // Atualizar status para PROCESSANDO no banco
        await db.query(
          `UPDATE webhook_signals SET status = 'PROCESSANDO', updated_at = NOW() WHERE id = ?`,
          [signal.id]
        );
        
        // Obter preço atual para o símbolo
        const currentPrice = await getWebSocketPrice(signal.symbol, accountId);
        console.log(`[MONITOR] Preço atual de ${signal.symbol}: ${currentPrice}`);
        
        if (!currentPrice) {
          console.error(`[MONITOR] Não foi possível obter preço atual para ${signal.symbol}`);
          await db.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Não foi possível obter preço atual' WHERE id = ?`,
            [signal.id]
          );
          processingSignals.delete(signal.id);
          continue;
        }
        
        // Processar o sinal
        await processSignal(db, signal, currentPrice, accountId);
        
        // Remover do conjunto de processamento
        processingSignals.delete(signal.id);
      } catch (signalError) {
        console.error(`[MONITOR] Erro ao processar sinal ID ${signal.id}:`, signalError);
        
        // Atualizar status para ERROR
        try {
          await db.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
            [signalError.message.substring(0, 250), signal.id]
          );
        } catch (updateError) {
          console.error(`[MONITOR] Erro adicional ao atualizar status:`, updateError);
        }
        
        // Remover do conjunto de processamento
        processingSignals.delete(signal.id);
      }
    }
    
    const endTime = Date.now();
    console.log(`[MONITOR] Verificação de sinais pendentes concluída em ${(endTime - startTime)/1000} segundos`);
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar sinais pendentes:`, error);
  }
}

// Função para processar um sinal
// Atualizar a função processSignal para ter melhor tratamento de erros
async function processSignal(db, signal, currentPrice, accountId = 1) {
  console.log(`[MONITOR] Processando sinal ID ${signal.id} para ${signal.symbol}: ${signal.side} a ${signal.entry_price}`);
  
  const connection = await db.getConnection();

  try {
    await connection.beginTransaction();

    const {
      id, symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, timeframe
    } = signal;

    // Verificar se já existe uma posição aberta para este símbolo
    const [existingPositions] = await connection.query(
      `SELECT id FROM posicoes 
       WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?`,
      [symbol, accountId]
    );

    if (existingPositions.length > 0) {
      console.log(`[MONITOR] Já existe uma posição aberta para ${symbol}`);
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Já existe uma posição aberta para este símbolo' WHERE id = ?`,
        [id]
      );
      await connection.commit();
      return;
    }

    // Verificar se o símbolo é válido e se o preço de entrada é válido
    if (!symbol || !entry_price || parseFloat(entry_price) <= 0) {
      console.error(`[MONITOR] Símbolo ou preço de entrada inválido: ${symbol}, ${entry_price}`);
      await connection.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Símbolo ou preço de entrada inválido' WHERE id = ?`,
        [id]
      );
      await connection.commit();
      return;
    }

    // Configurar alavancagem e tipo de margem
    try {
      const leverageLevel = parseInt(leverage) || 75;
      
      console.log(`[API] Alterando alavancagem para ${symbol}: ${leverageLevel} (Conta ${accountId})`);
      await api.changeInitialLeverage(accountId, symbol, leverageLevel);
      console.log(`[MONITOR] Alavancagem configurada: ${leverageLevel}x para ${symbol}`);
      
      console.log(`[API] Alterando tipo de margem para ${symbol}: CROSSED (Conta ${accountId})`);
      await api.changeMarginType(accountId, symbol, 'CROSSED');
      console.log(`[MONITOR] Tipo de margem configurado para CROSSED em ${symbol}`);
    } catch (error) {
      console.warn(`[MONITOR] Aviso ao configurar alavancagem/margem: ${error.message}`);
      // Continuar mesmo com erro, pois pode ser apenas que já estava configurado
    }

    // Iniciar monitoramento de preço via WebSocket
    websockets.ensurePriceWebsocketExists(symbol, accountId);

    // Atualizar o registro no banco antes de executar
    await connection.query(
      `UPDATE webhook_signals SET status = 'EXECUTANDO' WHERE id = ?`,
      [id]
    );
    
    await connection.commit();
    
    // Verificar se temos a função executeLimitMakerEntry
    if (typeof executeLimitMakerEntry !== 'function') {
      throw new Error('Função executeLimitMakerEntry não está disponível');
    }
    
    // Usar o executeLimitMakerEntry para criar a ordem
    console.log(`[MONITOR] Chamando executeLimitMakerEntry para sinal ID ${id}`);
    const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, accountId);
    
    if (entryResult && entryResult.success) {
      console.log(`[MONITOR] Entrada executada com sucesso para sinal ID ${id}`);
      console.log(`[MONITOR] Detalhes: Position ID: ${entryResult.positionId}, Preço médio: ${entryResult.averagePrice}, Quantidade: ${entryResult.filledQuantity}`);
      
      // Enviar notificação via Telegram
      const bot = getTelegramBot(accountId);
      if (bot && chat_id) {
        try {
          await bot.telegram.sendMessage(chat_id, 
            `✅ Entrada executada: ${symbol} ${side}\n` +
            `💰 Preço médio: ${entryResult.averagePrice}\n` +
            `📊 Quantidade: ${entryResult.filledQuantity}\n` +
            `🆔 Position ID: ${entryResult.positionId}`
          );
        } catch (telegramError) {
          console.error(`[TELEGRAM] Erro ao enviar notificação:`, telegramError);
        }
      }
      
      return entryResult;
    } else {
      const errorMsg = entryResult?.error || 'Erro desconhecido na execução da entrada';
      console.error(`[MONITOR] Falha na execução da entrada: ${errorMsg}`);
      
      // Atualizar status para ERROR
      await db.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        [errorMsg.substring(0, 250), id]
      );
      
      throw new Error(`Falha ao executar entrada: ${errorMsg}`);
    }
  } catch (error) {
    console.error(`[MONITOR] Erro ao processar sinal ID ${signal.id} para ${signal.symbol}:`, error);
    
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error(`[MONITOR] Erro adicional ao fazer rollback:`, rollbackError);
      }
    }
    
    // Atualizar status para ERROR
    try {
      await db.query(
        `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
        [error.message.substring(0, 250), signal.id]
      );
    } catch (updateError) {
      console.error(`[MONITOR] Erro adicional ao atualizar status:`, updateError);
    }
    
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Atualizar a função forceProcessPendingSignals para ser mais robusta
async function forceProcessPendingSignals(accountId = 1) {
  console.log(`[MONITOR] Forçando processamento de sinais pendentes para conta ${accountId}...`);
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Falha ao obter instância do banco de dados para conta ${accountId}`);
    }

    // Selecionar sinais pendentes
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING' AND (conta_id = ? OR conta_id IS NULL)
      ORDER BY created_at ASC
    `, [accountId]);

    console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para processamento forçado`);

    if (pendingSignals.length === 0) {
      console.log(`[MONITOR] Não há sinais pendentes para processar para conta ${accountId}`);
      return;
    }

    // Processar cada sinal pendente
    for (const signal of pendingSignals) {
      try {
        console.log(`[MONITOR] Processando forçadamente sinal ID ${signal.id}: ${signal.symbol} ${signal.side} @ ${signal.entry_price}`);
        
        // Obter preço atual
        const currentPrice = await getWebSocketPrice(signal.symbol, accountId);
        console.log(`[MONITOR] Preço atual de ${signal.symbol}: ${currentPrice || 'null'}`);
        
        if (!currentPrice) {
          console.error(`[MONITOR] Preço atual de ${signal.symbol}: null`);
          // Tentar obter via API REST como último recurso
          try {
            const api = require('../api');
            const restPrice = await api.getPrice(accountId, signal.symbol);
            console.log(`[MONITOR] Preço obtido via REST API: ${restPrice}`);
            
            if (restPrice) {
              await processSignal(db, signal, restPrice, accountId);
              continue;
            }
          } catch (restError) {
            console.error(`[MONITOR] Também falhou ao obter preço via REST:`, restError);
          }
          
          // Se tudo falhar, registrar erro
          await db.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Não foi possível obter preço atual' WHERE id = ?`,
            [signal.id]
          );
          continue;
        }
        
        // Processar o sinal
        await processSignal(db, signal, currentPrice, accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro ao processar sinal ID ${signal.id}:`, error);
        
        // Atualizar status para ERROR
        try {
          await db.query(
            `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
            [error.message.substring(0, 250), signal.id]
          );
        } catch (updateError) {
          console.error(`[MONITOR] Erro ao atualizar status do sinal:`, updateError);
        }
      }
    }
  } catch (error) {
    console.error(`[MONITOR] Erro ao forçar processamento de sinais pendentes:`, error);
    throw error;
  }
}

// Função para calcular tamanho da ordem baseado no capital disponível
function calculateOrderSize(availableBalance, capitalPercentage, entryPrice, leverage, precision) {
  const capital = availableBalance * capitalPercentage;
  const size = (capital * leverage) / entryPrice;

  // Converter para string com a precisão correta
  const sizeString = size.toFixed(precision);

  // Remover zeros à direita desnecessários e converter de volta para número
  // Isso evita problemas com a precisão exata
  const formattedSize = parseFloat(sizeString);

  // Log adicional para depuração
  console.log(`[MONITOR] Tamanho calculado: ${size}, Precisão: ${precision}, Formatado: ${formattedSize}`);

  return formattedSize;
}

/**
 * Obtém o saldo disponível para cálculo de novas operações
 * Usa o saldo_base_calculo em vez do saldo real da corretora
 * @returns {Promise<number>} Saldo base para cálculos
 */
async function getAvailableBalance() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return 0;
    }

    // Obter saldo_base_calculo do banco de dados
    const baseCalculo = await getBaseCalculoBalance(db);

    if (baseCalculo <= 0) {
      console.log('[MONITOR] Saldo base de cálculo não encontrado, buscando saldo real...');
      await syncAccountBalance(); // Atualizar o saldo se o base de cálculo não existe
      return await getBaseCalculoBalance(db); // Tentar novamente após atualização
    }

    console.log(`[MONITOR] Usando saldo base de cálculo: ${baseCalculo.toFixed(2)} USDT`);
    return baseCalculo;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter saldo base de cálculo: ${error.message}`);
    return 0;
  }
}

// Verificar se existe uma posição aberta para um símbolo
async function checkPositionExists(db, symbol, accountId = 1) {
  try {
    const [rows] = await db.query(
      "SELECT id FROM posicoes WHERE simbolo = ? AND (status = 'OPEN' OR status = 'PENDING') AND conta_id = ?",
      [symbol, accountId]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

// Substitua a função handleOrderUpdate existente
async function handleOrderUpdate(orderMsg, db, accountId = 1) {
  try {
    if (!db) {
      db = await getDatabaseInstance(accountId);
    }
    
    // Buscar a ordem no banco de dados, incluindo accountId
    const [orders] = await db.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?',
      [orderMsg.i, orderMsg.s, accountId]
    );


    // Se a ordem não for encontrada no banco mas está na corretora como FILLED ou PARTIALLY_FILLED,
    if (orders.length === 0 && (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      //console.log(`[MONITOR] Detectada ordem executada (Status: ${orderMsg.X}) na corretora que não existe no banco. OrderID: ${orderMsg.i}, Symbol: ${orderMsg.s}`);
      
      // Verificar se temos uma posição aberta para este símbolo
      const [positions] = await db.query(
        'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN" LIMIT 1', // Busca uma posição aberta para o símbolo
        [orderMsg.s]
      );
      
      if (positions.length > 0) {
        const position = positions[0];
        //console.log(`[MONITOR] Encontrada posição aberta (ID: ${position.id}) para ${orderMsg.s}. Registrando ordem executada ${orderMsg.i}.`);
        
        // Determinar o tipo de ordem do bot
        const tipoOrdemBot = determineOrderType(orderMsg);

        // Registrar a ordem com base nos dados recebidos via WebSocket
        const orderData = {
          tipo_ordem: orderMsg.o,        // Tipo de ordem da Binance (ex: MARKET, LIMIT, STOP_MARKET)
          preco: parseFloat(orderMsg.ap || orderMsg.p || 0), // Preço médio de execução ou preço da ordem
          quantidade: parseFloat(orderMsg.q), // Quantidade original da ordem
          id_posicao: position.id,      // ID da posição aberta encontrada
          status: orderMsg.X,           // Status da ordem (FILLED, PARTIALLY_FILLED)
          // Usar o tempo da transação (T) se disponível, senão o tempo da ordem (O), senão agora.
          data_hora_criacao: orderMsg.T ? formatDateForMySQL(new Date(orderMsg.T)) : (orderMsg.O ? formatDateForMySQL(new Date(orderMsg.O)) : formatDateForMySQL(new Date())),
          id_externo: String(orderMsg.i), // ID externo (orderId da Binance)
          side: orderMsg.S,             // Side (BUY/SELL)
          simbolo: orderMsg.s,          // Símbolo
          tipo_ordem_bot: tipoOrdemBot, // Tipo de ordem do bot (ENTRADA, STOP_LOSS, TAKE_PROFIT)
          target: null,                 // Target (se aplicável, geralmente para TPs múltiplos)
          // Tentar inferir reduce_only e close_position se possível a partir de orderMsg.R e orderMsg.pP
          reduce_only: orderMsg.R === true, // orderMsg.R é a flag reduceOnly
          close_position: orderMsg.pP === true, // orderMsg.pP é a flag closePosition (geralmente para ordens de TP/SL da UI da Binance)
          last_update: orderMsg.T ? formatDateForMySQL(new Date(orderMsg.T)) : formatDateForMySQL(new Date()), // Tempo da última atualização (tempo da transação)
          orign_sig: position.orign_sig || null, // Tentar herdar o orign_sig da posição, se existir
          // Campos adicionais da mensagem que podem ser úteis para auditoria:
          dados_originais_ws: JSON.stringify(orderMsg) // Salvar a mensagem original do WS
        };
        
        await insertNewOrder(db, orderData); // Sua função de inserir nova ordem
        //console.log(`[MONITOR] Ordem ${orderMsg.i} (Tipo Bot: ${tipoOrdemBot}) registrada no banco de dados para posição ${position.id}.`);
        
        // Se for uma ordem TP/SL FILLED, processar fechamento da posição
        if ((tipoOrdemBot === 'TAKE_PROFIT' || tipoOrdemBot === 'STOP_LOSS') && orderMsg.X === 'FILLED') {
          console.log(`[MONITOR] Ordem "fantasma" ${tipoOrdemBot} (ID: ${orderMsg.i}) executada, fechando posição ${position.id}`);
          // Antes de mover para o histórico, cancelar outras ordens abertas para esta posição
          const [otherLinkedOrders] = await db.query(
            'SELECT * FROM ordens WHERE id_posicao = ? AND status = "NEW" AND id_externo != ?',
            [position.id, orderMsg.i]
          );
          for (const otherOrder of otherLinkedOrders) {
            try {
              console.log(`[MONITOR] Cancelando ordem linkada ${otherOrder.id_externo} para posição ${position.id}`);
              await cancelOrder(otherOrder.id_externo, otherOrder.simbolo); // Sua função de cancelar ordem
              await updateOrderStatus(db, otherOrder.id, "CANCELED"); // Atualiza status no seu DB
            } catch (cancelError) {
              console.error(`[MONITOR] Erro ao cancelar ordem linkada ${otherOrder.id_externo}: ${cancelError.message}`);
            }
          }
          // Mover posição para o histórico
          await movePositionToHistory(db, position.id, 'CLOSED', `Posição fechada via ${tipoOrdemBot} "fantasma" ID ${orderMsg.i}`);
          
          // Sincronizar saldo após fechamento
           try {
             await syncAccountBalance();
           } catch (syncError) {
             console.error('[MONITOR] Erro ao sincronizar saldo após fechamento de posição "fantasma":', syncError);
           }
        }
      } else {
        //console.log(`[MONITOR] Nenhuma posição aberta encontrada para ${orderMsg.s}. Ordem "fantasma" ${orderMsg.i} não pôde ser associada e registrada.`);
      }
      
      return; // Finaliza o processamento aqui para ordens "fantasmas"
    }
    // --- FIM DA MELHORIA/CORREÇÃO ---

    // Código existente para ordens encontradas no banco
    if (orders.length === 0) {
      // Esta condição agora só será verdadeira se a ordem não foi encontrada E NÃO era FILLED/PARTIALLY_FILLED
      // ou se era FILLED/PARTIALLY_FILLED mas não tinha posição aberta correspondente.
      //console.log(`[MONITOR] Ordem ${orderMsg.i} (Status: ${orderMsg.X}) não encontrada no banco de dados e não tratada como "fantasma" preenchida.`);
      return;
    }

    const order = orders[0];

    // Se for ordem de entrada e tiver status NEW (recém criada) ou FILLED/PARTIALLY_FILLED
    if (order.tipo_ordem_bot === 'ENTRADA' &&
        (orderMsg.X === 'NEW' || orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {

      // Verificar se já existem ordens TP/SL para esta posição
      const [existingOrders] = await db.query(
          'SELECT * FROM ordens WHERE id_posicao = ? AND tipo_ordem_bot IN ("STOP_LOSS", "TAKE_PROFIT") AND status = "NEW"',
          [order.id_posicao]
      );

      if (existingOrders.length > 0) {
        console.log(`[MONITOR] Já existem ordens SL/TP para a posição ${order.id_posicao}, não criando novas`);

        if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
            // Apenas garantir que a ordem de entrada seja atualizada no DB se necessário
            if(order.status !== orderMsg.X) { // Se o status mudou
                await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                               [orderMsg.X, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
                console.log(`[MONITOR] Status da ordem de ENTRADA ${order.id_externo} atualizado para ${orderMsg.X}`);
            }
            // Garantir que o status da posição seja OPEN
            await updatePositionStatus(db, order.simbolo, { status: 'OPEN', id: order.id_posicao }); // Passar ID da posição
            console.log(`[MONITOR] Posição ${order.id_posicao} atualizada para OPEN após preenchimento da ordem de entrada ${order.id_externo}`);
            
            // NOVO: Atualizar o position_id na tabela webhook_signals
            try {
              // Buscar sinal pelo símbolo
              const [signalRows] = await db.query(
                `SELECT id FROM webhook_signals 
                 WHERE symbol = ? AND status = 'EXECUTADO' AND position_id IS NULL 
                 ORDER BY created_at DESC LIMIT 1`,
                [orderMsg.s] // símbolo da ordem
              );
              
              if (signalRows.length > 0) {
                const signalId = signalRows[0].id;
                console.log(`[ORDER UPDATE] Atualizando webhook_signal id=${signalId} com position_id=${order.id_posicao}`);
                await db.query(
                  `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
                  [order.id_posicao, signalId]
                );
              }
            } catch (updateError) {
              console.error(`[ORDER UPDATE] Erro ao atualizar position_id no webhook_signals: ${updateError.message}`);
              // Não interromper o fluxo principal
            }
        }
        return;
      }

      console.log(`[MONITOR] Criando ordens SL/TP para posição ${order.id_posicao} após ordem de entrada ${orderMsg.X}`);

      const [positionsDb] = await db.query('SELECT * FROM posicoes WHERE id = ?', [order.id_posicao]);
      if (positionsDb.length === 0) {
        console.log(`[MONITOR] Posição ${order.id_posicao} não encontrada para criar SL/TP`);
        return;
      }
      const currentPosition = positionsDb[0];

      if (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED') {
        // Atualizar a ordem de entrada no DB com preço de execução e novo status
        await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                       [orderMsg.X, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
        console.log(`[MONITOR] Status da ordem de ENTRADA ${order.id_externo} atualizado para ${orderMsg.X} com preço ${orderMsg.ap || order.preco}`);
        // Atualizar status da posição para OPEN
        await updatePositionStatus(db, currentPosition.simbolo, { status: 'OPEN', id: currentPosition.id });
        
        // NOVO: Atualizar o position_id na tabela webhook_signals
        try {
          // Buscar sinal pelo símbolo
          const [signalRows] = await db.query(
            `SELECT id FROM webhook_signals 
             WHERE symbol = ? AND status = 'EXECUTADO' AND position_id IS NULL 
             ORDER BY created_at DESC LIMIT 1`,
            [currentPosition.simbolo] // símbolo da posição
          );
          
          if (signalRows.length > 0) {
            const signalId = signalRows[0].id;
            console.log(`[ORDER UPDATE] Atualizando webhook_signal id=${signalId} com position_id=${currentPosition.id}`);
            await db.query(
              `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
              [currentPosition.id, signalId]
            );
          }
        } catch (updateError) {
          console.error(`[ORDER UPDATE] Erro ao atualizar position_id no webhook_signals: ${updateError.message}`);
          // Não interromper o fluxo principal
        }
      }

      let tpPrice, slPrice;
      const [signals] = await db.query(
          'SELECT * FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1',
          [order.id_posicao]
      );

      // Usar o preço de entrada da posição, que deve ter sido atualizado se a ordem de entrada foi FILLED.
      // Se a ordem de entrada ainda não foi FILLED (ex: status NEW), usamos o preço da ordem.
      const entryPrice = parseFloat(currentPosition.preco_entrada || order.preco);
      if (!entryPrice) {
          console.error(`[MONITOR] Preço de entrada inválido para posição ${currentPosition.id}. Não é possível criar TP/SL.`);
          return;
      }

      if (signals.length > 0 && signals[0].tp_price && signals[0].sl_price) {
        tpPrice = parseFloat(signals[0].tp_price);
        slPrice = parseFloat(signals[0].sl_price);
        console.log(`[MONITOR] Usando preços TP/SL do sinal para pos ${currentPosition.id}: TP=${tpPrice}, SL=${slPrice}`);
      } else {
        const factor = 0.01; // 1%
        if (currentPosition.side === 'BUY') {
          tpPrice = entryPrice * (1 + factor);
          slPrice = entryPrice * (1 - factor);
        } else { // SELL
          tpPrice = entryPrice * (1 - factor);
          slPrice = entryPrice * (1 + factor);
        }
        console.log(`[MONITOR] Calculando preços TP/SL padrão para pos ${currentPosition.id}: TP=${tpPrice}, SL=${slPrice} (Entrada: ${entryPrice})`);
      }
      
      // Arredondar preços para a precisão correta do símbolo (implementar getSymbolPrecision se necessário)
      // tpPrice = parseFloat(tpPrice.toFixed(getSymbolPrecision(currentPosition.simbolo, 'price')));
      // slPrice = parseFloat(slPrice.toFixed(getSymbolPrecision(currentPosition.simbolo, 'price')));

      const oppositeSide = currentPosition.side === 'BUY' ? 'SELL' : 'BUY';
      const quantityToClose = parseFloat(currentPosition.quantidade_aberta || currentPosition.quantidade || order.quantidade);

      if (!quantityToClose || quantityToClose <= 0) {
          console.error(`[MONITOR] Quantidade inválida para fechar posição ${currentPosition.id}. Não é possível criar TP/SL.`);
          return;
      }

      // Criar e enviar ordem de SL
      try {
        const slOrderParams = {
            symbol: currentPosition.simbolo,
            side: oppositeSide,
            type: 'STOP_MARKET', // Tipo de ordem para a corretora
            quantity: quantityToClose,
            stopPrice: slPrice, // Preço de disparo
            reduceOnly: true
        };
        // ou manter a assinatura original: (symbol, quantity, side, stopPrice, price, reduceOnly, closePosition)
        const slResponse = await newStopOrder(
            slOrderParams.symbol,
            slOrderParams.quantity,
            slOrderParams.side,
            slOrderParams.stopPrice,
            null,  // price (para STOP_MARKET, não LIMIT)
            true,  // reduceOnly
            false  // closePosition (reduceOnly=true já garante que só reduzirá)
        );
        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada na corretora para pos ${currentPosition.id}: ${slResponse.data.orderId}`);
        await insertNewOrder(db, {
          tipo_ordem: 'STOP_MARKET', preco: slPrice, quantidade: quantityToClose,
          id_posicao: currentPosition.id, status: 'NEW', // Status inicial é NEW até ser aceita pela corretora
          data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(slResponse.data.orderId),
          side: oppositeSide, simbolo: currentPosition.simbolo, tipo_ordem_bot: 'STOP_LOSS',
          reduce_only: true, last_update: formatDateForMySQL(new Date()), orign_sig: currentPosition.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem SL para pos ${currentPosition.id}: ${error.message || error}`);
      }

      // Criar e enviar ordem de TP
      try {
        const tpOrderParams = {
            symbol: currentPosition.simbolo,
            side: oppositeSide,
            type: 'TAKE_PROFIT_MARKET', // Tipo de ordem para a corretora
            quantity: quantityToClose,
            stopPrice: tpPrice, // Preço de disparo
            reduceOnly: true
        };
        // Para TAKE_PROFIT_MARKET, price é geralmente null (ou igual a stopPrice, dependendo da API da corretora)
        const tpResponse = await newStopOrder(
            tpOrderParams.symbol,
            tpOrderParams.quantity,
            tpOrderParams.side,
            tpOrderParams.stopPrice, // stopPrice para TAKE_PROFIT_MARKET
            tpPrice, // price (algumas corretoras usam stopPrice como trigger e executam a mercado, outras podem precisar de price para TAKE_PROFIT_LIMIT)
                      // Para TAKE_PROFIT_MARKET, o 'price' pode não ser usado ou ser igual ao stopPrice. Verifique a API.
            true,  // reduceOnly
            false  // closePosition
        );
        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada na corretora para pos ${currentPosition.id}: ${tpResponse.data.orderId}`);
        await insertNewOrder(db, {
          tipo_ordem: 'TAKE_PROFIT_MARKET', preco: tpPrice, quantidade: quantityToClose,
          id_posicao: currentPosition.id, status: 'NEW',
          data_hora_criacao: formatDateForMySQL(new Date()), id_externo: String(tpResponse.data.orderId),
          side: oppositeSide, simbolo: currentPosition.simbolo, tipo_ordem_bot: 'TAKE_PROFIT',
          reduce_only: true, last_update: formatDateForMySQL(new Date()), orign_sig: currentPosition.orign_sig
        });
      } catch (error) {
        console.error(`[MONITOR] Erro ao criar ordem TP para pos ${currentPosition.id}: ${error.message || error}`);
      }

    } else if ((order.tipo_ordem_bot === 'TAKE_PROFIT' || order.tipo_ordem_bot === 'STOP_LOSS') && 
               (orderMsg.X === 'FILLED' || (orderMsg.X === 'EXPIRED' && orderMsg.x === 'TRADE'))) { // Adicionado EXPIRED com execução TRADE
        
        const executionType = orderMsg.x; // NEW, CANCELED, REPLACED, REJECTED, TRADE, EXPIRED
        const orderStatus = orderMsg.X;   // NEW, PARTIALLY_FILLED, FILLED, CANCELED, PENDING_CANCEL, REJECTED, EXPIRED

        console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) para posição ${order.id_posicao} teve atualização: Status=${orderStatus}, ExecType=${executionType}`);

        // Se a ordem foi preenchida (FILLED ou EXPIRED mas com TRADE)
        if (orderStatus === 'FILLED' || (orderStatus === 'EXPIRED' && executionType === 'TRADE')) {
            console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) executada (Status: ${orderStatus}). Fechando posição ${order.id_posicao}.`);

            // Atualizar o status da ordem que foi FILLED/EXECUTED
            await db.query('UPDATE ordens SET status = ?, preco_executado = ?, last_update = ? WHERE id = ?', 
                           [orderStatus, parseFloat(orderMsg.ap || order.preco), formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);

            // Cancelar outras ordens abertas (TP ou SL oposto) para esta posição
            const [otherOrders] = await db.query(
                'SELECT * FROM ordens WHERE id_posicao = ? AND id_externo != ? AND status = "NEW" OR status = "OPEN" OR status = "PARTIALLY_FILLED"', // Status mais abrangentes para cancelamento
                [order.id_posicao, order.id_externo] // Usar id_externo aqui para evitar cancelar a própria ordem se o ID interno for igual
            );

            for (const otherOrder of otherOrders) {
                try {
                    console.log(`[MONITOR] Cancelando ordem oposta ${otherOrder.id_externo} (Status: ${otherOrder.status}) para posição ${order.id_posicao}`);
                    await cancelOrder(otherOrder.id_externo, otherOrder.simbolo); // Função da API da corretora
                    // O status da ordem cancelada será atualizado via WebSocket pela própria corretora.
                    // Podemos forçar uma atualização local se necessário, mas o ideal é aguardar o evento.
                    // await updateOrderStatus(db, otherOrder.id, "CANCELED"); 
                } catch (error) {
                    console.error(`[MONITOR] Erro ao cancelar ordem oposta ${otherOrder.id_externo}: ${error.message}`);
                    // Mesmo com erro no cancelamento, continuar para fechar a posição
                }
            }

            // Mover posição e suas ordens para tabelas de histórico
            try {
                await moveClosedPositionsAndOrders(db, order.id_posicao); // Sua função original
                console.log(`[MONITOR] Posição ${order.id_posicao} e suas ordens foram movidas para o histórico.`);

                // Sincronizar saldo após fechamento de posição
                try {
                    await syncAccountBalance();
                } catch (syncError) {
                    console.error('[MONITOR] Erro ao sincronizar saldo após fechamento de posição:', syncError);
                }
            } catch (error) {
                console.error(`[MONITOR] Erro ao mover registros para histórico para pos ${order.id_posicao}: ${error.message}`);
            }
        } else if (orderStatus === 'CANCELED' || orderStatus === 'REJECTED' || (orderStatus === 'EXPIRED' && executionType !== 'TRADE')) {
            // Se a ordem TP/SL foi cancelada, rejeitada ou expirou sem trade, apenas atualiza o status no DB
            console.log(`[MONITOR] Ordem ${order.tipo_ordem_bot} (ID_EXT: ${order.id_externo}) para posição ${order.id_posicao} teve status ${orderStatus}. Atualizando no DB.`);
            await db.query('UPDATE ordens SET status = ?, last_update = ? WHERE id = ?', 
                           [orderStatus, formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
        }
    } else if (orderMsg.X === 'CANCELED' || orderMsg.X === 'REJECTED' || (orderMsg.X === 'EXPIRED' && orderMsg.x !== 'TRADE')) {
        // Lógica para ordens de ENTRADA que foram canceladas/rejeitadas/expiradas sem fill
        if (order.tipo_ordem_bot === 'ENTRADA' && order.status !== 'FILLED' && order.status !== 'PARTIALLY_FILLED') {
            console.log(`[MONITOR] Ordem de ENTRADA (ID_EXT: ${order.id_externo}) para símbolo ${order.simbolo} teve status ${orderMsg.X}. Atualizando no DB.`);
            await db.query('UPDATE ordens SET status = ?, last_update = ? WHERE id = ?', 
                           [orderMsg.X, formatDateForMySQL(new Date(orderMsg.T || Date.now())), order.id]);
            // Se a ordem de entrada falhou, a posição associada (se existir e estiver PENDING) pode precisar ser atualizada ou removida.
            // Isso depende da sua lógica de criação de posições.
             const [posicoesPendentes] = await db.query('SELECT * FROM posicoes WHERE id = ? AND status = "PENDING"', [order.id_posicao]);
             if (posicoesPendentes.length > 0) {
                 await db.query('UPDATE posicoes SET status = "FAILED_ENTRY", observacao = ? WHERE id = ?',
                                [`Entrada falhou: Ordem ${order.id_externo} com status ${orderMsg.X}`, order.id_posicao]);
                 console.log(`[MONITOR] Posição ${order.id_posicao} marcada como FAILED_ENTRY.`);
             }
        }
    }

  } catch (error) {
    console.error(`[MONITOR] Erro ao processar atualização de ordem (OrderID: ${orderMsg.i}): ${error.message}`, error.stack);
  }
}

// Função corrigida para processar atualizações de conta via WebSocket
async function handleAccountUpdate(message, db) {
  try {
    //console.log('[ACCOUNT UPDATE] Recebido atualização de conta');

    // Se não houver conexão com o banco, tentar estabelecer
    if (!db) {
      db = await getDatabaseInstance();
      if (!db) {
        console.error('[ACCOUNT UPDATE] Falha ao obter instância do banco de dados');
        return;
      }
    }

    // Verificar se há atualizações de posição no evento
    if (message.a && message.a.P) {
      const positions = message.a.P;
      console.log(`[ACCOUNT UPDATE] Recebido atualização para ${positions.length} posições`);

      for (const position of positions) {
        const symbol = position.s;
        const positionAmt = parseFloat(position.pa);
        const entryPrice = parseFloat(position.ep);
        const updateTime = new Date(); // Timestamp atual do servidor
        
        if (Math.abs(parseFloat(position.pa)) > 0) {
          console.log(`[ACCOUNT UPDATE] Garantindo websocket ativo para ${symbol} com posição aberta`);
          websockets.ensurePriceWebsocketExists(symbol);
        }
        
        console.log(`[ACCOUNT UPDATE] Posição atualizada: ${symbol}, Quantidade: ${positionAmt}, Preço Entrada: ${entryPrice}`);

        // Buscar posição no banco de dados
        const [posRows] = await db.query(
          'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"',
          [symbol]
        );

        if (posRows.length > 0) {
          const posicaoDb = posRows[0];
          const positionId = posicaoDb.id;
          
          // CASO 1: Posição fechada (quantidade zerada)
          if (Math.abs(positionAmt) < 0.000001) { // Considera zero com margem para erro de precisão
            console.log(`[ACCOUNT UPDATE] Posição ${symbol} [ID: ${positionId}] detectada como FECHADA`);
            
            // Mover para histórico
            await movePositionToHistory(db, positionId, 'CLOSED', 'Fechada através da corretora');
            
            // Enviar notificação ao Telegram se necessário
            try {
              const [webhookInfo] = await db.query(`
                SELECT chat_id FROM webhook_signals 
                WHERE position_id = ? ORDER BY id DESC LIMIT 1
              `, [positionId]);
              
              if (webhookInfo.length > 0 && webhookInfo[0].chat_id && bot) {
                await bot.telegram.sendMessage(
                  webhookInfo[0].chat_id,
                  `⚠️ Posição ${symbol} fechada manualmente na corretora`
                );
              }
            } catch (notifyError) {
              console.error(`[ACCOUNT UPDATE] Erro ao notificar fechamento: ${notifyError.message}`);
            }
            
            // Verificar e fechar websocket se não houver mais atividade para este símbolo
            setTimeout(async () => {
              try {
                await checkAndCloseWebsocket(db, symbol);
              } catch (wsError) {
                console.error(`[ACCOUNT UPDATE] Erro ao fechar websocket: ${wsError.message}`);
              }
            }, 5000);
            
          } 
          // CASO 2: Posição ainda aberta (atualizar quantidade e preço)
          else if (Math.abs(positionAmt) !== Math.abs(parseFloat(posicaoDb.quantidade)) || 
                  Math.abs(entryPrice - parseFloat(posicaoDb.preco_entrada)) > 0.000001) {
            
            console.log(`[ACCOUNT UPDATE] Atualizando posição ${symbol} [ID: ${positionId}] - Nova quantidade: ${positionAmt}, Novo preço: ${entryPrice}`);
            
            await db.query(`
              UPDATE posicoes
              SET quantidade = ?,
                  preco_entrada = ?,
                  preco_corrente = ?,
                  data_hora_ultima_atualizacao = ?
              WHERE id = ? AND status = 'OPEN'
            `, [
              Math.abs(positionAmt),
              entryPrice,
              entryPrice,
              formatDateForMySQL(updateTime),
              positionId
            ]);
          }
        } else {
          // Posição não encontrada no banco - pode ser uma nova posição aberta manualmente
          console.log(`[ACCOUNT UPDATE] Posição ${symbol} com quantidade ${positionAmt} não encontrada no banco de dados`);
        }
      }
    } else {
      console.log('[ACCOUNT UPDATE] Sem atualizações de posição nesta mensagem');
    }

    if (message.a && message.a.P) {
      const positions = message.a.P;
      for (const position of positions) {
      const symbol = position.s;
    if (Math.abs(parseFloat(position.pa)) > 0) {
      // Se a posição tem quantidade não-zero, garantir que o websocket esteja ativo
      console.log(`[ACCOUNT UPDATE] Garantindo websocket ativo para ${symbol} com posição aberta`);
      websockets.ensurePriceWebsocketExists(symbol);
    }
  }
}
  } catch (error) {
    console.error('[ACCOUNT UPDATE] Erro ao processar atualização da conta:', error);
  }
}

// Inicializar handler para atualização de preços via websocket
function initializePriceMonitoring() {
  // Garantir que websockets.js está atribuindo nosso callback para atualizações de preço
  const priceUpdateHandler = async (symbol, tickerData) => {
    try {
      // Extrair o preço médio entre bid e ask
      const bestBid = parseFloat(tickerData.b);
      const bestAsk = parseFloat(tickerData.a);
      const currentPrice = (bestBid + bestAsk) / 2;

      // Atualizar o cache de preços
      latestPrices.set(symbol, {
        price: currentPrice,
        timestamp: Date.now(),
        bid: bestBid,
        ask: bestAsk
      });

      // Log menos frequente para evitar spam
      const now = Date.now();
      if (!lastPriceLogTime[symbol] || (now - lastPriceLogTime[symbol] > PRICE_LOG_INTERVAL)) {
        console.log(`[PRICE_WS] ${symbol}: ${currentPrice} (bid: ${bestBid}, ask: ${bestAsk})`);
        lastPriceLogTime[symbol] = now;
      }
    } catch (error) {
      console.error(`[PRICE_WS] Erro ao processar atualização de preço para ${symbol}:`, error);
    }
  };

  // Atualizar os handlers nos websockets
  const updatedHandlers = {
    ...handlers,
    onPriceUpdate: priceUpdateHandler
  };
  
  websockets.setMonitoringCallbacks(updatedHandlers);
  console.log('[MONITOR] Handler de atualização de preços via WebSocket configurado');
}

/**
 * Função melhorada para obter o preço atual usando o cache de websocket
 * @param {string} symbol - Símbolo do par
 * @param {number} maxAgeMs - Idade máxima do preço em cache (ms)
 * @returns {Promise<number>} O preço atual
 */
// Atualizar a função getWebSocketPrice para ser mais confiável
async function getWebSocketPrice(symbol, accountId = 1, maxAgeMs = 5000) {
  try {
    // Se não temos o símbolo no cache ou não tem websocket iniciado, iniciamos um
    if (!latestPrices.has(symbol)) {
      console.log(`[MONITOR] Iniciando monitoramento de preço via WebSocket para ${symbol}`);
      try {
        await websockets.ensurePriceWebsocketExists(symbol, accountId);
        
        // Aguardar um tempo para o websocket receber a primeira atualização
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (wsError) {
        console.error(`[MONITOR] Erro ao iniciar WebSocket para ${symbol}:`, wsError.message);
        // Continuar para verificar se já temos dados ou usar fallback
      }
    }

    // Verificar se temos uma atualização recente no cache
    const priceEntry = latestPrices.get(symbol);
    const now = Date.now();
    
    if (priceEntry && (now - priceEntry.timestamp) < maxAgeMs) {
      return priceEntry.price;
    }

    // Se o preço for muito antigo ou não existir, tentar obter diretamente
    console.log(`[MONITOR] Preço de ${symbol} não disponível via WebSocket (ou antigo)`);
    
    // Tentar obter o preço atual via API REST
    const restPrice = await getCurrentPrice(symbol, accountId);
    
    // Atualizar o cache com o preço da REST API
    if (restPrice) {
      latestPrices.set(symbol, {
        price: restPrice,
        timestamp: Date.now(),
        bid: restPrice * 0.9999,
        ask: restPrice * 1.0001
      });
      
      return restPrice;
    }
    
    // Se ainda temos algum preço em cache, mesmo antigo, retorná-lo como último recurso
    if (priceEntry) {
      console.log(`[MONITOR] Usando preço em cache antigo para ${symbol}: ${priceEntry.price}`);
      return priceEntry.price;
    }
    
    return null;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter preço para ${symbol}:`, error);
    return null;
  }
}

// Função para mover posição para tabelas de fechadas
// Modificação da função movePositionToHistory para cancelar ordens abertas na corretora
async function movePositionToHistory(db, positionId, status, reason) {
  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    attempts++;
    const connection = await db.getConnection();

    try {
      await connection.beginTransaction();

      // 1. Verificar se a posição existe
      const [positionResult] = await connection.query("SELECT * FROM posicoes WHERE id = ?", [positionId]);
      if (positionResult.length === 0) {
        console.log(`Posição com ID ${positionId} não encontrada.`);
        await connection.commit();
        connection.release();
        return true;
      }
      
      // Obter o símbolo da posição
      const symbol = positionResult[0].simbolo;
      console.log(`[MOVE_POSITION] Verificando ordens abertas na corretora para ${symbol} antes de mover posição ${positionId} para histórico`);
      
      // 2. NOVO: Verificar se existem ordens abertas na corretora para este símbolo
    try {
      console.log(`[MOVE_POSITION] Tentando cancelar todas as ordens abertas para ${symbol} de uma vez`);
  
      const cancelResult = await cancelAllOpenOrders(symbol);
  
      if (cancelResult && Array.isArray(cancelResult) && cancelResult.length > 0) {
        console.log(`[MOVE_POSITION] ${cancelResult.length} ordens canceladas com sucesso para ${symbol}`);
    
        // Log detalhado das ordens canceladas (opcional)
        cancelResult.forEach(order => {
          console.log(`[MOVE_POSITION] Ordem ${order.orderId} (tipo: ${order.type}, lado: ${order.side}) cancelada`);
        });
      } else {
        console.log(`[MOVE_POSITION] Nenhuma ordem encontrada/cancelada para ${symbol} ou resultado vazio`);
      }
  
  // Pequena pausa para a corretora processar os cancelamentos
  console.log(`[MOVE_POSITION] Aguardando 1 segundo para a corretora processar os cancelamentos...`);
  await new Promise(resolve => setTimeout(resolve, 1000));
  
} catch (exchangeError) {
  console.error(`[MOVE_POSITION] Erro ao cancelar ordens para ${symbol}: ${exchangeError.message}`);
  
  // Continuar mesmo com erro na verificação/cancelamento de ordens
  // Pode adicionar tentativa de fallback para cancelamento individual aqui se necessário
  console.log(`[MOVE_POSITION] Continuando apesar do erro no cancelamento em lote`);
}

      // 3. Atualizar status e tempo de fechamento
      const formattedDate = formatDateForMySQL(new Date());
      await connection.query(
          `UPDATE posicoes
           SET status = ?,
               data_hora_fechamento = ?,
               data_hora_ultima_atualizacao = ?
           WHERE id = ?`,
          [status, formattedDate, formattedDate, positionId]
      );

      // 4. Verificar todas as ordens que referenciam esta posição
      const [orderResult] = await connection.query("SELECT * FROM ordens WHERE id_posicao = ?", [positionId]);
      console.log(`Encontradas ${orderResult.length} ordens para posição ${positionId}.`);

      // 5. Se houver ordens, movê-las para fechadas
      if (orderResult.length > 0) {
        // Construir esquemas dinâmicos para mover ordens
        const [renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_firs'`);
        const [renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_seco'`);
        const [orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);

        const [dest_renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_firs'`);
        const [dest_renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_seco'`);
        const [dest_orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'orign_sig'`);

        let sourceCols = "tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, " +
            "id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, " +
            "last_update";

        let destCols = sourceCols;

        if (renew_sl_firs.length > 0 && dest_renew_sl_firs.length > 0) {
          sourceCols += ", renew_sl_firs";
          destCols += ", renew_sl_firs";
        }

        if (renew_sl_seco.length > 0 && dest_renew_sl_seco.length > 0) {
          sourceCols += ", renew_sl_seco";
          destCols += ", renew_sl_seco";
        }

        if (orign_sig.length > 0 && dest_orign_sig.length > 0) {
          sourceCols += ", orign_sig";
          destCols += ", orign_sig";
        }

        // Inserir ordens na tabela de histórico
        await connection.query(
            `INSERT INTO ordens_fechadas (${destCols})
             SELECT ${sourceCols} FROM ordens WHERE id_posicao = ?`,
            [positionId]
        );
        console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);

        // Excluir ordens originais
        await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
        console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);
      }

      // 6. Verificar se posição tem coluna orign_sig
      const [posColumns] = await connection.query(`SHOW COLUMNS FROM posicoes LIKE 'orign_sig'`);
      const hasOrignSig = posColumns.length > 0;

      // 7. Copiar posição para tabela histórica
      if (hasOrignSig) {
        await connection.query(
            `INSERT INTO posicoes_fechadas
             (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
              side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig)
             SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?,
                    side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
             FROM posicoes WHERE id = ?`,
            [formattedDate, positionId]
        );
      } else {
        await connection.query(
            `INSERT INTO posicoes_fechadas
             (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento,
              side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente)
             SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?,
                    side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente
             FROM posicoes WHERE id = ?`,
            [formattedDate, positionId]
        );
      }
      console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);

      // 8. Excluir posição original
      await connection.query("DELETE FROM posicoes WHERE id = ?", [positionId]);
      console.log(`Posição com id ${positionId} excluída de posicoes.`);

      // 9. Finalizar transação
      await connection.commit();
      console.log(`[SYNC] Posição ${positionId} movida para fechadas com status: ${status}, motivo: ${reason}`);

      // 10. Verificar se precisamos fechar o WebSocket de monitoramento de preço
      // Obter o símbolo da posição que foi movida
      await checkAndCloseWebsocket(db, symbol);

      connection.release();
      return true;

    } catch (error) {
      await connection.rollback();

      // Se for erro de bloqueio, tentar novamente com backoff exponencial
      if (error.code === 'ER_LOCK_WAIT_TIMEOUT' ||
          error.message.includes('Lock wait timeout') ||
          error.message.includes('Deadlock')) {

        const waitTime = Math.pow(2, attempts) * 1000; // 2s, 4s, 8s
        console.log(`[MONITOR] Bloqueio ao mover posição ${positionId}. Tentativa ${attempts}/${maxAttempts} - Aguardando ${waitTime/1000}s`);

        connection.release();
        await new Promise(resolve => setTimeout(resolve, waitTime));
      } else {
        console.error(`[MONITOR] Erro ao mover posição ${positionId} para fechadas:`, error);
        connection.release();
        throw error;
      }
    }
  }

  throw new Error(`Falha ao mover posição ${positionId} após ${maxAttempts} tentativas`);
}

async function onPriceUpdate(symbol, currentPrice, db, accountId = 1) {
  try {
    // Atualizar o cache de preços
    if (!latestPrices.has(symbol) || latestPrices.get(symbol).price !== currentPrice) {
      latestPrices.set(symbol, {
        price: currentPrice,
        timestamp: Date.now(),
        bid: null,  // Estes valores serão atualizados por updatePriceCache
        ask: null   // quando houver uma atualização completa do book
      });
    }

    await updatePositionPrices(db, symbol, currentPrice);

    // Logar preços de vez em quando (não em cada atualização para evitar spam)
    const now = Date.now();
    if (!lastPriceLogTime[symbol] || (now - lastPriceLogTime[symbol] > PRICE_LOG_INTERVAL)) {
      console.log(`[PRICE] ${symbol}: ${currentPrice}`);
      lastPriceLogTime[symbol] = now;
    }

    // 2. Buscar sinais pendentes para este símbolo (TANTO PENDING QUANTO AGUARDANDO_ACIONAMENTO)
    const [pendingSignalsResult] = await db.query(`
      SELECT 
      id, symbol, timeframe, side, leverage, capital_pct, 
      entry_price, 
      tp_price, sl_price, 
      tp1_price, tp2_price, tp3_price, tp4_price, tp5_price,
      status, error_message, position_id, entry_order_id, 
      tp_order_id, sl_order_id, chat_id, message_id, created_at, 
      updated_at, timeout_at, max_lifetime_minutes, 
      registry_message_id, message_id_orig, message_source, conta_id
      FROM webhook_signals
      WHERE symbol = ? AND conta_id = ? AND 
      (status = 'AGUARDANDO_ACIONAMENTO' OR status = 'PENDING')
    `, [symbol, accountId]);
    
    const pendingSignals = pendingSignalsResult || [];

    // 3. Verificar se há posições abertas ou ordens pendentes
    const [openPositionsResult] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
    `, [symbol, accountId]);
    
    const [pendingOrdersResult] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'NEW' AND conta_id = ?
    `, [symbol, accountId]);

    const openPositionsCount = (openPositionsResult && openPositionsResult[0] && openPositionsResult[0].count) || 0;
    const pendingOrdersCount = (pendingOrdersResult && pendingOrdersResult[0] && pendingOrdersResult[0].count) || 0;

    // 4. Verificar se precisamos manter o WebSocket ativo
    if (pendingSignals.length === 0 && 
        openPositionsCount === 0 && 
        pendingOrdersCount === 0) {
      // Incrementar contador vazio para este símbolo
      websocketEmptyCheckCounter[symbol] = (websocketEmptyCheckCounter[symbol] || 0) + 1;
      
      // Se já verificamos várias vezes e continua vazio, fechar o websocket
      if (websocketEmptyCheckCounter[symbol] > 10) {
        websockets.stopPriceMonitoring(symbol, accountId);
        delete websocketEmptyCheckCounter[symbol];
        console.log(`[MONITOR] WebSocket fechado para ${symbol} após 10 verificações sem atividade`);
      }
    } else {
      // Resetar contador se houver atividade
      websocketEmptyCheckCounter[symbol] = 0;
    }

    // 5. Processar sinais pendentes
    for (const signal of pendingSignals) {
      // Verificar se o sinal já está sendo processado
      if (processingSignals.has(signal.id)) {
        continue;
      }
      
      // Verificar se é um sinal desta conta
      if (signal.conta_id && signal.conta_id !== accountId) {
        continue;
      }

      // Se o sinal estiver com status PENDING, atualizá-lo para AGUARDANDO_ACIONAMENTO
      if (signal.status === 'PENDING') {
        await db.query(
          'UPDATE webhook_signals SET status = "AGUARDANDO_ACIONAMENTO" WHERE id = ?',
          [signal.id]
        );
        continue; // Pular este ciclo, será processado na próxima atualização de preço
      }

      // Para sinais AGUARDANDO_ACIONAMENTO, verificar se o preço gatilho foi atingido
      if (signal.status === 'AGUARDANDO_ACIONAMENTO') {
        const entryPrice = parseFloat(signal.entry_price);
        const side = signal.side.toUpperCase();
        
        let acionar = false;
        
        // Verificar se o preço atual atingiu o preço gatilho
        if (side === 'COMPRA' || side === 'BUY') {
          // Para compra, acionar quando o preço atual estiver próximo ou abaixo do preço de entrada
          // Considerando uma margem de 0.2% para tolerância
          const entryThreshold = entryPrice * 1.002; 
          acionar = currentPrice <= entryThreshold;
        } else if (side === 'VENDA' || side === 'SELL') {
          // Para venda, acionar quando o preço atual estiver próximo ou acima do preço de entrada
          // Considerando uma margem de 0.2% para tolerância
          const entryThreshold = entryPrice * 0.998;
          acionar = currentPrice >= entryThreshold;
        }
        
        if (acionar) {
          console.log(`[MONITOR] Preço gatilho atingido para sinal ID ${signal.id}: ${signal.symbol} ${side} @ ${entryPrice} (Preço atual: ${currentPrice})`);
          
          // Marcar como em processamento
          processingSignals.add(signal.id);
          
          try {
            // Atualizar status
            await db.query(
              'UPDATE webhook_signals SET status = "EXECUTANDO" WHERE id = ?',
              [signal.id]
            );
            
            // Executar a entrada LIMIT MAKER
            const entryResult = await executeLimitMakerEntry(db, signal, currentPrice, accountId);
            
            if (entryResult && entryResult.success) {
              console.log(`[MONITOR] Entrada executada com sucesso para sinal ID ${signal.id}. Posição ID: ${entryResult.positionId}`);
            } else {
              console.error(`[MONITOR] Falha ao executar entrada para sinal ID ${signal.id}: ${entryResult?.error || 'Erro desconheido'}`);
              
              await db.query(
                'UPDATE webhook_signals SET status = "ERROR", error_message = ? WHERE id = ?',
                [(entryResult?.error || 'Erro na execução da entrada').substring(0, 250), signal.id]
              );
            }
          } catch (execError) {
            console.error(`[MONITOR] Erro ao processar sinal ID ${signal.id} após atingir preço gatilho:`, execError);
            
            await db.query(
              'UPDATE webhook_signals SET status = "ERROR", error_message = ? WHERE id = ?',
              [execError.message.substring(0, 250), signal.id]
            );
          } finally {
            // Remover da lista de processamento
            processingSignals.delete(signal.id);
          }
        } else {
          // Logar o status do preço gatilho periodicamente (não em cada atualização)
          if (!lastPriceLogTime[`${symbol}_${signal.id}`] || 
              (now - lastPriceLogTime[`${symbol}_${signal.id}`] > PRICE_LOG_INTERVAL)) {
            console.log(`[PRICE_CHECK] Sinal ID ${signal.id}: ${symbol} ${side} @ ${entryPrice} - Atual: ${currentPrice} - Acionar: ${acionar ? 'SIM' : 'NÃO'}`);
            lastPriceLogTime[`${symbol}_${signal.id}`] = now;
          }
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro no processamento para ${symbol}:`, error);
  }
}

function updatePriceCache(symbol, bookTicker) {
  try {
    const bid = parseFloat(bookTicker.bidPrice || bookTicker.b);
    const ask = parseFloat(bookTicker.askPrice || bookTicker.a);
    
    if (!isNaN(bid) && !isNaN(ask) && bid > 0 && ask > 0) {
      const currentPrice = (bid + ask) / 2;
      
      latestPrices.set(symbol, {
        price: currentPrice,
        timestamp: Date.now(),
        bid: bid,
        ask: ask
      });
    }
  } catch (error) {
    console.error(`[PRICE_CACHE] Erro ao atualizar cache para ${symbol}:`, error);
  }
}

// Nova função para atualizar preços das posições
async function updatePositionPrices(db, symbol, currentPrice) {
  try {
    // 1. Buscar posições abertas para o símbolo
    const [positions] = await db.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"',
      [symbol]
    );

    if (positions.length === 0) {
      // Log menos frequente para não poluir console
      return;
    }

    // Log mais detalhado para ajudar no diagnóstico
    //console.log(`[PRICE UPDATE] Atualizando ${positions.length} posições para ${symbol}. Preço atual: ${currentPrice}`);

    // 2. Para cada posição, atualizar o preço corrente
    for (const position of positions) {
      const positionId = position.id;
      
      await db.query(
        `UPDATE posicoes SET 
         preco_corrente = ?, 
         data_hora_ultima_atualizacao = ? 
         WHERE id = ?`,
        [currentPrice, formatDateForMySQL(new Date()), positionId]
      );
      
      // 3. Verificar se há ordens SL/TP ativas que precisam ser monitoradas
      await checkOrderTriggers(db, position, currentPrice);
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao atualizar preços das posições para ${symbol}: ${error.message}`, error);
  }
}

// Nova função para verificar gatilhos de ordens
async function checkOrderTriggers(db, position, currentPrice) {
  try {
    const positionId = position.id;
    const functionPrefix = "[TRAILING]";

    // 1. VERIFICAR SE PRECISAMOS REALMENTE FAZER A VERIFICAÇÃO AGORA
    const now = Date.now();
    if (lastTrailingCheck[positionId] && (now - lastTrailingCheck[positionId] < MIN_CHECK_INTERVAL)) {
      return; // Última verificação muito recente
    }
    
    lastTrailingCheck[positionId] = now; // Atualiza o timestamp da última verificação

    // 2. OBTER O NÍVEL ATUAL DE TRAILING STOP DO BANCO DE DADOS
    const [trailingStateResult] = await db.query(
      `SELECT trailing_stop_level FROM posicoes WHERE id = ?`,
      [positionId]
    );
    
    // Se a coluna não existir, tentar criar
    if (trailingStateResult.length > 0 && !trailingStateResult[0].hasOwnProperty('trailing_stop_level')) {
      console.log(`[DB_FIX] Coluna 'trailing_stop_level' não encontrada para id ${positionId}. Adicionando...`);
      try {
        await db.query(`ALTER TABLE posicoes ADD COLUMN IF NOT EXISTS trailing_stop_level VARCHAR(20) DEFAULT 'ORIGINAL'`);
        const [recheckState] = await db.query(`SELECT trailing_stop_level FROM posicoes WHERE id = ?`, [positionId]);
        if (recheckState.length > 0) trailingStateResult[0] = recheckState[0];
      } catch (alterError) {
        console.error(`[DB_FIX] Erro ao adicionar coluna 'trailing_stop_level': ${alterError.message}`);
      }
    }
    
    const currentTrailingLevel = trailingStateResult.length > 0 && trailingStateResult[0].trailing_stop_level ? 
                                trailingStateResult[0].trailing_stop_level : 'ORIGINAL';

    // 3. BUSCAR DADOS DO SINAL
    const [signalInfo] = await db.query(
      `SELECT tp1_price, tp3_price, entry_price 
       FROM webhook_signals 
       WHERE position_id = ? 
       ORDER BY created_at DESC LIMIT 1`,
      [positionId]
    );

    if (signalInfo.length === 0) {
      console.log(`${functionPrefix} Sinal não encontrado para posição ${positionId} para lógica de trailing.`);
      return;
    }

    const signal = signalInfo[0];
    const tp1Price = parseFloat(signal.tp1_price);
    const tp3Price = parseFloat(signal.tp3_price);
    const entryPrice = parseFloat(position.preco_entrada);
    const side = position.side.toUpperCase();

    // Verificar validade dos preços
    if (isNaN(tp1Price) || tp1Price <= 0) {
      console.log(`${functionPrefix} TP1 (tp1_price: ${signal.tp1_price}) inválido no sinal para posição ${positionId}.`);
      return;
    }

    // 4. DETERMINAR SE UM ALVO FOI ATINGIDO
    let priceHitTP1 = false;
    let priceHitTP3 = false;
    
    if (side === 'BUY' || side === 'COMPRA') {
      priceHitTP1 = currentPrice >= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice >= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    } else if (side === 'SELL' || side === 'VENDA') {
      priceHitTP1 = currentPrice <= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice <= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    }

    // 5. REPOSITIONAMENTO PARA BREAKEVEN (APÓS TP1)
    if (priceHitTP1) {
      console.log(`${functionPrefix} Preço (${currentPrice}) atingiu TP1 (${tp1Price}) para Posição ID ${positionId} (${side}). Nível Trailing: ${currentTrailingLevel}. Iniciando SL para Breakeven.`);

      // NOVO: Verificar novamente para evitar reposicionamento duplicado
      const [checkAgain] = await db.query(
        `SELECT trailing_stop_level FROM posicoes WHERE id = ? AND trailing_stop_level = 'ORIGINAL'`,
        [positionId]
      );
      
      if (checkAgain.length === 0) {
        console.log(`${functionPrefix} Nível de trailing já foi atualizado para esta posição. Ignorando reposicionamento.`);
        return;
      }
      
      // Atualizar para BREAKEVEN primeiro, antes mesmo de cancelar ordens
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );
      
      console.log(`${functionPrefix} Cancelando ordens SL existentes ANTES de mover para breakeven...`);
      await cancelAllActiveStopLosses(db, position);
      
      await new Promise(resolve => setTimeout(resolve, 2500)); // Pausa para processamento da corretora

      try {
        // MODIFICADO: Buscar o entry_price do sinal original em webhook_signals
        const [signalEntryPriceResult] = await db.query(
          `SELECT entry_price FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`,
          [positionId]
        );
        
        // Usar o entry_price do sinal se disponível, caso contrário usar o entryPrice da posição
        const newSLBreakevenPrice = signalEntryPriceResult.length > 0 && signalEntryPriceResult[0].entry_price ? 
                                   parseFloat(signalEntryPriceResult[0].entry_price) : 
                                   entryPrice;
        
        console.log(`${functionPrefix} Usando preço de entrada do sinal original: ${newSLBreakevenPrice} (preço da posição: ${entryPrice})`);
        
        const quantity = parseFloat(position.quantidade);
        const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
        
        console.log(`${functionPrefix} Criando nova ordem SL (breakeven) para ${position.simbolo} @ ${newSLBreakevenPrice}`);
        const slResponse = await newStopOrder(
          position.simbolo, quantity, oppositeSide, newSLBreakevenPrice, null, true, true
        );
        
        if (slResponse && slResponse.data && slResponse.data.orderId) {
          const newOrderId = String(slResponse.data.orderId);
          console.log(`${functionPrefix} Nova SL (breakeven) criada: ID ${newOrderId} @ ${newSLBreakevenPrice}`);
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET', 
            preco: newSLBreakevenPrice, // Usando o preço do sinal original
            quantidade: quantity,
            id_posicao: positionId, 
            status: 'NEW', 
            data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: newOrderId, 
            side: oppositeSide, 
            simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS', 
            target: null, 
            reduce_only: true, 
            close_position: true,
            last_update: formatDateForMySQL(new Date()), 
            orign_sig: position.orign_sig,
            observacao: 'Trailing Stop - Breakeven (preço do sinal original)'
          });
          
          console.log(`${functionPrefix} SL Breakeven (${newOrderId}) criado e posição atualizada para BREAKEVEN.`);
          
          // Notificação Telegram (se necessário)
          try {
            const [webhookInfo] = await db.query(`SELECT chat_id FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`, [positionId]);
            if (webhookInfo.length > 0 && webhookInfo[0].chat_id && typeof bot !== 'undefined' && bot && bot.telegram) {
              await bot.telegram.sendMessage(webhookInfo[0].chat_id, `✅ Trailing Stop Ativado para ${position.simbolo}\n\nAlvo 1 atingido\nSL movido para breakeven: (${newSLBreakevenPrice})`);
            }
          } catch (notifyError) { 
            console.error(`${functionPrefix} Erro ao notificar SL breakeven: ${notifyError.message}`); 
          }
        } else {
          console.error(`${functionPrefix} Falha ao criar nova SL (breakeven) para ${position.simbolo}. Resposta:`, slResponse);
        }
      } catch (error) {
        const errorMsg = error.response?.data?.msg || error.message || String(error);
        console.error(`${functionPrefix} Erro crítico ao criar nova SL (breakeven) para ${position.simbolo}: ${errorMsg}`, error.stack);
      }
    // 6. REPOSICIONAMENTO PARA TP1 (APÓS TP3)
    } else if (priceHitTP3) {
      console.log(`${functionPrefix} Preço (${currentPrice}) atingiu TP3 (${tp3Price}) para Posição ID ${positionId} (${side}). Nível Trailing: ${currentTrailingLevel}. Iniciando SL para TP1 (${tp1Price}).`);
      
      // NOVO: Verificar novamente para evitar reposicionamento duplicado
      const [checkAgain] = await db.query(
        `SELECT trailing_stop_level FROM posicoes WHERE id = ? AND trailing_stop_level = 'BREAKEVEN'`,
        [positionId]
      );
      
      if (checkAgain.length === 0) {
        console.log(`${functionPrefix} Nível de trailing já foi atualizado para esta posição. Ignorando reposicionamento.`);
        return;
      }
      
      // Atualizar para TP1 primeiro, antes mesmo de cancelar ordens
      await db.query(
        `UPDATE posicoes SET trailing_stop_level = 'TP1', data_hora_ultima_atualizacao = ? WHERE id = ?`,
        [formatDateForMySQL(new Date()), positionId]
      );

      console.log(`${functionPrefix} Cancelando ordens SL existentes ANTES de mover para TP1...`);
      await cancelAllActiveStopLosses(db, position);
      
      await new Promise(resolve => setTimeout(resolve, 2500)); // Pausa

      try {
        const newSLatTP1Price = tp1Price;
        const quantity = parseFloat(position.quantidade);
        const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';

        console.log(`${functionPrefix} Criando nova ordem SL (nível TP1) para ${position.simbolo} @ ${newSLatTP1Price}`);
        const slResponse = await newStopOrder(
          position.simbolo, quantity, oppositeSide, newSLatTP1Price, null, true, true
        );

        if (slResponse && slResponse.data && slResponse.data.orderId) {
          const newOrderId = String(slResponse.data.orderId);
          console.log(`${functionPrefix} Nova SL (nível TP1) criada: ID ${newOrderId} @ ${newSLatTP1Price}`);
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET', 
            preco: newSLatTP1Price, 
            quantidade: quantity,
            id_posicao: positionId, 
            status: 'NEW', 
            data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: newOrderId, 
            side: oppositeSide, 
            simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS', 
            target: null, 
            reduce_only: true, 
            close_position: true,
            last_update: formatDateForMySQL(new Date()), 
            orign_sig: position.orign_sig,
            observacao: 'Trailing Stop - TP1'
          });
          
          console.log(`${functionPrefix} SL TP1 (${newOrderId}) criado e posição atualizada para TP1.`);

          // Notificação Telegram
          try {
            const [webhookInfo] = await db.query(`SELECT chat_id FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`, [positionId]);
            if (webhookInfo.length > 0 && webhookInfo[0].chat_id && typeof bot !== 'undefined' && bot && bot.telegram) {
              await bot.telegram.sendMessage(webhookInfo[0].chat_id, `🚀 Trailing Stop Atualizado para ${position.simbolo}\n\nAlvo 3 Atingido\nSL movido para TP1: ${newSLatTP1Price}`);
            }
          } catch (notifyError) { 
            console.error(`${functionPrefix} Erro ao notificar SL em TP1: ${notifyError.message}`); 
          }
        } else {
           console.error(`${functionPrefix} Falha ao criar nova SL (nível TP1) para ${position.simbolo}. Resposta:`, slResponse);
        }
      } catch (error) {
        const errorMsg = error.response?.data?.msg || error.message || String(error);
        console.error(`${functionPrefix} Erro crítico ao criar nova SL (nível TP1) para ${position.simbolo}: ${errorMsg}`, error.stack);
      }
    }
    
  } catch (error) {
    const positionIdError = position && position.id ? position.id : 'desconhecida';
    console.error(`[TRAILING_GLOBAL] Erro crítico em checkOrderTriggers para posição ${positionIdError}: ${error.message}`, error.stack);
  }
}

async function cancelAllActiveStopLosses(db, position) {
  let canceledProcessedCount = 0;
  const functionPrefix = "[CANCEL_ALL_SL]";
  const { simbolo, id: positionId, side: positionSide } = position;

  console.log(`${functionPrefix} Iniciando cancelamento de ordens SL para ${simbolo} (Posição ID: ${positionId})`);

  try {
    // 1. Buscar ordens abertas na corretora para o símbolo
    const openOrdersOnExchange = await getOpenOrders(simbolo); // Assumindo que getOpenOrders(simbolo) existe

    if (!openOrdersOnExchange || openOrdersOnExchange.length === 0) {
      console.log(`${functionPrefix} Nenhuma ordem aberta encontrada na corretora para ${simbolo}.`);
      // Opcional: Sincronizar/limpar ordens 'NEW' no DB que não existem na corretora
      try {
        const [dbSyncResult] = await db.query(
          `UPDATE ordens SET status = 'CANCELED_SYNC', observacao = 'Sincronizado: Não encontrada na corretora ao cancelar SLs', last_update = ? 
           WHERE id_posicao = ? AND tipo_ordem_bot = 'STOP_LOSS' AND status = 'NEW'`,
          [formatDateForMySQL(new Date()), positionId]
        );
        if (dbSyncResult.affectedRows > 0) {
          console.log(`${functionPrefix} ${dbSyncResult.affectedRows} ordens SL 'NEW' no DB para posição ${positionId} atualizadas para CANCELED_SYNC.`);
        }
      } catch (dbError) {
        console.error(`${functionPrefix} Erro ao sincronizar ordens SL 'NEW' no DB para ${positionId}: ${dbError.message}`);
      }
      return 0;
    }

    // 2. Filtrar ordens de Stop Loss relevantes
    const oppositeSide = positionSide.toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
    const stopLossOrdersToCancel = openOrdersOnExchange.filter(order => {
      const orderTypeUpper = order.type ? order.type.toUpperCase() : '';
      const orderSideUpper = order.side ? order.side.toUpperCase() : '';
      
      // Critérios para identificar uma ordem SL:
      // - Tipo inclui 'STOP' (ex: STOP_MARKET, STOP)
      // - Lado da ordem é oposto ao da posição (ordem de venda para posição de compra, e vice-versa)
      // - Idealmente, é 'reduceOnly'. Se a informação não estiver disponível, este critério pode ser flexibilizado
      //   ou assumir que todas as SLs gerenciadas são reduceOnly.
      const isStopType = orderTypeUpper.includes('STOP');
      const isCorrectSide = orderSideUpper === oppositeSide;
      const isReduceOnlyOrNotSpecified = order.reduceOnly === true || typeof order.reduceOnly === 'undefined';
      // Adicione mais lógicas de filtro se necessário, ex: verificar se a ordem não é um TP_MARKET que também pode usar 'STOP' no nome.
      // No seu caso, 'STOP_LOSS' em `tipo_ordem_bot` já ajuda a distinguir no DB. Aqui focamos na corretora.

      return isStopType && isCorrectSide && isReduceOnlyOrNotSpecified;
    });

    if (stopLossOrdersToCancel.length === 0) {
      console.log(`${functionPrefix} Nenhuma ordem SL (tipo STOP, lado oposto, reduceOnly) para cancelar encontrada na corretora para ${simbolo}.`);
      return 0;
    }
    console.log(`${functionPrefix} Encontradas ${stopLossOrdersToCancel.length} ordens SL na corretora para ${simbolo} para cancelamento.`);

    // 3. Cancelar cada ordem SL encontrada
    for (const order of stopLossOrdersToCancel) {
      const orderIdToCancel = order.orderId || order.clientOrderId; // Use o ID correto que sua função cancelOrder espera
      if (!orderIdToCancel) {
        console.warn(`${functionPrefix} Ordem SL sem ID válido para cancelar:`, order);
        continue;
      }

      try {
        console.log(`${functionPrefix} Cancelando ordem SL na corretora - ID: ${orderIdToCancel}, Tipo: ${order.type}, Preço Gatilho: ${order.stopPrice || order.price}`);
        await cancelOrder(orderIdToCancel, simbolo); // Assumindo que cancelOrder(orderId, symbol) existe
        
        console.log(`${functionPrefix} Ordem SL ${orderIdToCancel} cancelada com sucesso na corretora.`);
        
        // Atualizar status no banco de dados para esta ordem específica
        const [updateResult] = await db.query(
          'UPDATE ordens SET status = "CANCELED", observacao = ?, last_update = ? WHERE id_externo = ? AND id_posicao = ?', 
          [`Cancelada automaticamente antes de reposicionar SL`, formatDateForMySQL(new Date()), orderIdToCancel, positionId]
        );

        if (updateResult.affectedRows > 0) {
            console.log(`${functionPrefix} Status da ordem ${orderIdToCancel} (id_externo) atualizado para CANCELED no DB.`);
        } else {
            console.warn(`${functionPrefix} Ordem ${orderIdToCancel} cancelada na corretora, mas não encontrada/atualizada no DB por id_externo=${orderIdToCancel} e id_posicao=${positionId}. Verifique a consistência dos IDs.`);
        }
        canceledProcessedCount++;
      } catch (cancelError) {
        const errorMsg = cancelError.response?.data?.msg || cancelError.message || String(cancelError);
        const errorCode = cancelError.response?.data?.code;

        // Código -2011: Unknown order sent (ordem não existe ou já foi fechada/cancelada)
        if (errorCode === -2011 || (typeof errorMsg === 'string' && errorMsg.toLowerCase().includes('order does not exist'))) {
          console.log(`${functionPrefix} Ordem SL ${orderIdToCancel} não encontrada na corretora (provavelmente já cancelada/executada). Code: ${errorCode}. Msg: ${errorMsg}. Marcando como CANCELED_EXT no DB.`);
          await db.query(
            'UPDATE ordens SET status = "CANCELED_EXT", observacao = ?, last_update = ? WHERE id_externo = ? AND id_posicao = ?', 
            [`Não encontrada na corretora durante cancelamento`, formatDateForMySQL(new Date()), orderIdToCancel, positionId]
          );
          canceledProcessedCount++; // Conta como processada
        } else {
          console.error(`${functionPrefix} Erro ao cancelar ordem SL ${orderIdToCancel} para ${simbolo}: ${errorMsg} (Code: ${errorCode})`);
          // Continuar tentando cancelar as outras ordens
        }
      }
    }
    
    console.log(`${functionPrefix} ${canceledProcessedCount} de ${stopLossOrdersToCancel.length} ordens SL relevantes foram processadas para cancelamento para ${simbolo}.`);
    return canceledProcessedCount;

  } catch (error) {
    const errorMsg = error.response?.data?.msg || error.message || String(error);
    console.error(`${functionPrefix} Erro geral ao buscar ou cancelar ordens SL para ${simbolo}: ${errorMsg}`, error.stack);
    return 0; // Indica que houve falha na operação principal
  }
}

// Função para verificar ordens expiradas com base no timeframe
async function checkExpiredOrders(accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Falha ao obter instância do banco de dados para conta ${accountId}`);
    }

    // Buscar sinais pendentes com timeframe
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, timeframe, created_at, chat_id
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO' 
        AND timeframe IS NOT NULL AND timeframe != ''
        AND conta_id = ?
    `, [accountId]);

    console.log(`[MONITOR] Verificando ${pendingSignals.length} sinais pendentes com timeframe para conta ${accountId}`);
    const now = new Date();
    let cancelCount = 0;

    for (const signal of pendingSignals) {
      try {
        // Converter timeframe para milissegundos
        const timeframeMs = timeframeToMs(signal.timeframe);
        
        if (timeframeMs > 0) {
          const createdAt = new Date(signal.created_at);
          const elapsedMs = now - createdAt;
          
          // Se passou mais de 2x o timeframe, cancelar o sinal
          if (elapsedMs > timeframeMs * 2) {
            console.log(`[MONITOR] Sinal ID ${signal.id} (${signal.symbol}) expirou após ${Math.round(elapsedMs/60000)}min (timeframe: ${signal.timeframe})`);
            
            await cancelSignal(
              db, 
              signal.id, 
              'EXPIRED',
              `Sinal expirou após ${Math.round(elapsedMs/60000)} minutos (timeframe: ${signal.timeframe})`,
              accountId
            );
            
            cancelCount++;
          }
        }
      } catch (error) {
        console.error(`[MONITOR] Erro ao processar expiração para sinal ID ${signal.id}:`, error);
      }
    }

    if (cancelCount > 0) {
      console.log(`[MONITOR] ${cancelCount} sinais cancelados por expiração de timeframe`);
    }
    
    return cancelCount;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar sinais expirados para conta ${accountId}:`, error);
    throw error;
  }
}

/**
 * Sincroniza o saldo da conta com a corretora e atualiza o banco de dados
 * Agora usa a WebSocket API para melhor desempenho
 * Segue a regra: saldo_base_calculo só é atualizado quando o saldo aumenta
 * @returns {Promise<Object>} Objeto contendo saldo e saldo_base_calculo atualizados
 */
async function syncAccountBalance() {
  try {
    // Importar o módulo websocketApi se ainda não estiver disponível
    const websocketApi = require('../websocketApi');
    
    // Usar o novo método WebSocket API para obter informações de saldo
    const result = await websocketApi.syncAccountBalanceViaWebSocket();
    
    // Se houver resultados, registrar mudanças significativas
    if (result && result.success) {
      // Se o saldo base de cálculo foi alterado, exibir mensagem adicional
      if (result.saldo_base_calculo > result.previousBaseCalculo) {
        console.log(`[MONITOR] Base de cálculo aumentada: ${result.previousBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
      }
      
      return {
        saldo: result.saldo,
        saldo_base_calculo: result.saldo_base_calculo
      };
    } else {
      console.error('[MONITOR] Falha ao sincronizar saldo via WebSocket API:', result?.error || 'Resposta inválida');
      return null;
    }
  } catch (error) {
    console.error(`[MONITOR] Erro ao sincronizar saldo da conta: ${error.message}`);
    
    // Se houver erro na WebSocket API, tentar fallback para método antigo
    console.log('[MONITOR] Tentando fallback para API REST...');
    try {
      const db = await getDatabaseInstance();
      if (!db) {
        console.error('[MONITOR] Falha ao obter instância do banco de dados');
        return null;
      }

      // Obter saldo real da corretora
      const balanceDetails = await getFuturesAccountBalanceDetails();
      const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');

      if (!usdtBalance) {
        throw new Error('Saldo USDT não encontrado na corretora');
      }

      // Usar o campo balance (saldo total) em vez de availableBalance
      const realSaldo = parseFloat(usdtBalance.balance);

      // Obter saldo atual e base de cálculo do banco
      const [currentBalance] = await db.query('SELECT saldo, saldo_base_calculo FROM conta WHERE id = 1');

      const currentSaldo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo || 0) : 0;
      const currentBaseCalculo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo_base_calculo || 0) : 0;

      // Atualizar saldo no banco de dados com o saldo total
      const result = await updateAccountBalance(db, realSaldo);

      if (result) {
        // Se o saldo base de cálculo foi alterado, exibir mensagem adicional
        if (result.saldo_base_calculo > currentBaseCalculo) {
          console.log(`[MONITOR] Base de cálculo aumentada: ${currentBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
        }
      }

      return result;
    } catch (fallbackError) {
      console.error(`[MONITOR] Erro no método fallback: ${fallbackError.message}`);
      return null;
    }
  }
}

// Função para converter timeframe para milissegundos
function timeframeToMs(timeframe) {
  if (!timeframe) return 0;

  // Extrair número e unidade
  const match = timeframe.match(/^(\d+)([mhdwM])$/);
  if (!match) {
    console.log(`[MONITOR] Formato de timeframe inválido: ${timeframe}`);
    return 0;
  }

  const [_, value, unit] = match;
  const numValue = parseInt(value, 10);

  // Converter para milissegundos com base na unidade
  switch(unit) {
    case 'm': return numValue * 60 * 1000; // minutos para ms
    case 'h': return numValue * 60 * 60 * 1000; // horas para ms
    case 'd': return numValue * 24 * 60 * 60 * 1000; // dias para ms
    case 'w': return numValue * 7 * 24 * 60 * 60 * 1000; // semanas para ms
    case 'M': return numValue * 30 * 24 * 60 * 60 * 1000; // meses para ms (aproximado)
    default: return 0;
  }
}

// Iniciar o monitoramento automaticamente quando o script for executado
(async () => {
  try {
    console.log('[MONITOR] Iniciando sistema de monitoramento...');
    await initializeMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao inicializar monitoramento:', error);
  }
})();

async function checkAndCloseWebsocket(db, symbol) {
  try {
    console.log(`[MONITOR] Verificando se o WebSocket para ${symbol} pode ser fechado...`);

    // 1. Verificar se ainda existem sinais pendentes para o símbolo
    const [pendingSignalsRows] = await db.query(`
      SELECT COUNT(*) as count FROM webhook_signals 
      WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    const pendingSignalsCount = pendingSignalsRows[0].count;

    // 2. Verificar se ainda existem posições abertas para o símbolo
    const [activePositionsRows] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN'
    `, [symbol]);
    const activePositionsCount = activePositionsRows[0].count;
    
    // 3. Verificar se ainda existem ordens pendentes
    const [pendingOrdersRows] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status IN ('NEW', 'PARTIALLY_FILLED')
    `, [symbol]);
    const pendingOrdersCount = pendingOrdersRows[0].count;
    
    console.log(`[MONITOR] Estado para ${symbol}: Sinais=${pendingSignalsCount}, Posições=${activePositionsCount}, Ordens=${pendingOrdersCount}`);

    // 4. VERIFICA MAIS RIGOROSAMENTE - Apenas fecha se TODAS as condições forem satisfeitas
    if (pendingSignalsCount === 0 && 
        activePositionsCount === 0 && 
        pendingOrdersCount === 0) {
      
      console.log(`[MONITOR] Não há atividade para ${symbol}. Fechando WebSocket.`);
      
      if (websockets.stopPriceMonitoring(symbol)) {
        //console.log(`[MONITOR] WebSocket para ${symbol} fechado com sucesso.`);
        
        // Limpar estado registrado no lastLoggedWebsocketStates
        if (lastLoggedWebsocketStates[symbol]) {
          delete lastLoggedWebsocketStates[symbol];
        }
        
        return true;
      } else {
        console.log(`[MONITOR] WebSocket para ${symbol} não encontrado ou já fechado.`);
      }
    } else {
      console.log(`[MONITOR] WebSocket para ${symbol} NÃO será fechado pois ainda há atividade.`);
      
      // IMPORTANTE: Garantir que o websocket esteja aberto quando há atividade
      if (!websockets.priceWebsockets[symbol] || 
          (websockets.priceWebsockets[symbol] && websockets.priceWebsockets[symbol].readyState !== 1)) {
        console.log(`[MONITOR] WebSocket para ${symbol} não existe ou não está aberto. Reabrindo...`);
        websockets.ensurePriceWebsocketExists(symbol);
      }
    }
    
    return false;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar WebSocket para ${symbol}: ${error.message}`);
    return false;
  }
}

const cancelingSignals = new Set();

async function cancelSignal(db, signalId, statusParam, reason, accountId = 1) {
  // Verificar se este sinal já está sendo cancelado
  const lockKey = `cancel_${signalId}`;
  if (cancelingSignals.has(lockKey)) {
    console.log(`[MONITOR] Sinal ID ${signalId} já está sendo cancelado, ignorando chamada duplicada.`);
    return false; // Evitar processamento duplicado
  }

  try {
    // Adicionar à lista de sinais em processamento
    cancelingSignals.add(lockKey);

    console.log(`[MONITOR] Iniciando cancelamento do sinal ID ${signalId} (Status informado no parâmetro: ${statusParam}): ${reason}`);

    // Verificar se o sinal já não está cancelado no banco de dados
    const [currentStatusRows] = await db.query(`
      SELECT status FROM webhook_signals WHERE id = ?
    `, [signalId]);

    if (currentStatusRows.length === 0) {
      console.warn(`[MONITOR] Sinal ID ${signalId} não encontrado no banco de dados para cancelamento.`);
    } else if (currentStatusRows[0].status === 'CANCELED') {
      console.log(`[MONITOR] Sinal ID ${signalId} já está com status CANCELED no banco de dados.`);
    }

    const [updateResult] = await db.query(`
      UPDATE webhook_signals
      SET status = 'CANCELED',
          error_message = ?
      WHERE id = ?
    `, [reason, signalId]);

    if (updateResult.affectedRows === 0) {
      console.warn(`[MONITOR] Tentativa de atualizar sinal ID ${signalId} para CANCELED, mas nenhum registro foi afetado. O sinal pode não existir ou já estar cancelado.`);
    } else {
      console.log(`[MONITOR] Sinal ID ${signalId} atualizado para CANCELED no banco de dados.`);
    }

    let signalData = null;
    let symbolToVerify = null;

    const [signalInfoRows] = await db.query(`
      SELECT symbol, chat_id, registry_message_id
      FROM webhook_signals
      WHERE id = ? LIMIT 1
    `, [signalId]);

    if (signalInfoRows && signalInfoRows.length > 0) {
      signalData = signalInfoRows[0];
      symbolToVerify = signalData.symbol;
    }

    // Início da implementação da formatação de preço
    if (signalData && signalData.chat_id && bot) { // Assumindo que 'bot' é uma variável global/acessível
      try {
        const telegramOptions = signalData.registry_message_id
          ? { reply_to_message_id: signalData.registry_message_id }
          : {};

        // Extrair preço do motivo se existir para formatar corretamente
        let formattedReason = reason;
        if (reason && reason.includes('\nPreço:')) { // Adicionada verificação se 'reason' existe
          // Extrair valores numéricos para formatação
          formattedReason = reason.replace(/(\d+\.\d+)/g, match => {
            // Certifique-se que formatDecimal está definida e funciona como esperado
            return formatDecimal(parseFloat(match), 4); // Usando 4 casas decimais como no seu exemplo
          });
        }

        await bot.telegram.sendMessage(signalData.chat_id,
          `⚠️ Sinal para ${signalData.symbol || 'N/A'} Cancelado ⚠️ \n(ID: ${signalId})\n\n` +
          `Motivo: ${formattedReason}`, // Usando formattedReason aqui
          telegramOptions
        );
        console.log(`[MONITOR] Notificação de cancelamento enviada para Sinal ID ${signalId} (reply to: ${signalData.registry_message_id || 'N/A'}).`);
      } catch (telegramError) {
        console.error(`[MONITOR] Erro ao enviar notificação Telegram para cancelamento do sinal ID ${signalId}: ${telegramError.message}`, telegramError);
      }
    } else {
      let logMessage = `[MONITOR] Não foi possível enviar notificação de cancelamento para o sinal ID ${signalId}: `;
      if (!signalData) logMessage += "informações do sinal não encontradas (pode ter sido deletado). ";
      if (signalData && !signalData.chat_id) logMessage += "chat_id não encontrado. ";
      if (!bot) logMessage += "instância do bot não disponível. ";
      console.log(logMessage.trim());
    }
    // Fim da implementação da formatação de preço

    if (symbolToVerify) {
      try {
        const [remainingSignalsRows] = await db.query(`
          SELECT COUNT(*) as count
          FROM webhook_signals
          WHERE symbol = ?
            AND status = 'AGUARDANDO_ACIONAMENTO'
        `, [symbolToVerify]);

        const count = (remainingSignalsRows && remainingSignalsRows[0]) ? remainingSignalsRows[0].count : 0;

        if (count === 0) {
          console.log(`[MONITOR] Não há mais sinais 'AGUARDANDO_ACIONAMENTO' para ${symbolToVerify} após cancelamento do sinal ID ${signalId}. Agendando verificação de websocket.`);
          setTimeout(async () => {
            try {
                console.log(`[MONITOR] Executando checkAndCloseWebsocket para ${symbolToVerify} (agendado após cancelamento do sinal ID ${signalId}).`);
                if (typeof checkAndCloseWebsocket === 'function') {
                    await checkAndCloseWebsocket(db, symbolToVerify);
                } else {
                    console.error(`[MONITOR] Função checkAndCloseWebsocket não está definida ou não é uma função.`);
                }
            } catch (websocketCheckError) {
                console.error(`[MONITOR] Erro dentro do setTimeout ao executar checkAndCloseWebsocket para ${symbolToVerify} (Sinal ID ${signalId}):`, websocketCheckError);
            }
          }, 5000);
        } else {
          console.log(`[MONITOR] Ainda existem ${count} sinais 'AGUARDANDO_ACIONAMENTO' para ${symbolToVerify} após cancelamento do sinal ID ${signalId}. Websocket para ${symbolToVerify} permanecerá ativo.`);
        }
      } catch (checkError) {
        console.error(`[MONITOR] Erro ao verificar sinais restantes para ${symbolToVerify} (referente ao sinal cancelado ID ${signalId}):`, checkError);
      }
    } else {
      console.log(`[MONITOR] Símbolo não encontrado para o sinal ID ${signalId}. Não foi possível verificar o estado do websocket com base neste cancelamento.`);
    }

    cancelingSignals.delete(lockKey);
    return true;
  } catch (error) {
    console.error(`[MONITOR] Erro geral ao cancelar sinal ID ${signalId}: ${error.message}`, error);
    cancelingSignals.delete(lockKey);
    return false;
  }
}

/**
 * Formata um valor decimal removendo zeros desnecessários à direita
 * @param {number} value - O valor a ser formatado
 * @param {number} maxPrecision - Precisão máxima (opcional)
 * @return {string} Valor formatado sem zeros desnecessários
 */
function formatDecimal(value, maxPrecision = 8) {
  if (value === undefined || value === null) return '0';
  
  // Primeiro formata com a precisão máxima
  const formatted = parseFloat(value).toFixed(maxPrecision);
  
  // Depois remove zeros desnecessários e pontos decimais isolados
  return parseFloat(formatted).toString();
}

module.exports = {
  initializeMonitoring,
  checkNewTrades,
  forceProcessPendingSignals,
  processSignal,
  getWebSocketPrice,
  updatePriceCache
};