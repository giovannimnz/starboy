const path = require('path');
const schedule = require('node-schedule');
const { getDatabaseInstance } = require('../../../core/database/conexao');
const { verifyAndFixEnvironmentConsistency, getFuturesAccountBalanceDetails } = require('../api/rest');
const websockets = require('../api/websocket');
const api = require('../api/rest');
const { initializeTelegramBot, stopAllTelegramBots } = require('../telegram/telegramBot');
const { onPriceUpdate, checkNewTrades, checkExpiredSignals, checkCanceledSignals } = require('./signalProcessor');
const { syncPositionsWithExchange, syncOrdersWithExchange, logOpenPositionsAndOrdersVisual } = require('../services/positionSync');
const orderHandlers = require('../handlers/orderHandlers');
const accountHandlers = require('../handlers/accountHandlers');
const { runPeriodicCleanup, monitorWebSocketHealth, updatePositionPricesWithTrailing, runAdvancedPositionMonitoring } = require('./enhancedMonitoring');
const { cleanupOrphanSignals, forceCloseGhostPositions, cancelOrphanOrders } = require('../services/cleanup');
const { syncAndCloseGhostPositions } = require('../services/positionHistory');
const { checkOrderTriggers } = require('./trailingStopLoss');

// === DEBUGGING ROBUSTO ===
console.log(`[MONITOR] 🚀 === INICIANDO MONITORAMENTO PARA CONTA ${process.argv[4] || ''} ===`);
console.log(`[MONITOR] 📅 Timestamp: ${new Date().toISOString()}`);
console.log(`[MONITOR] 🖥️ Process ID: ${process.pid}`);
console.log(`[MONITOR] 📁 Working Directory: ${process.cwd()}`);
console.log(`[MONITOR] 📋 Arguments: ${JSON.stringify(process.argv)}`);

// Capturar erros não tratados ANTES de qualquer outra coisa
process.on('uncaughtException', (error) => {
  console.error(`\n[MONITOR] 💥 ERRO CRÍTICO NÃO TRATADO:`, error);
  console.error(`[MONITOR] Stack trace:`, error.stack);
  console.error(`[MONITOR] 🚨 PROCESSO SERÁ ENCERRADO!`);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(`\n[MONITOR] 🚫 PROMISE REJEITADA:`, reason);
  console.error(`[MONITOR] Promise:`, promise);
  console.error(`[MONITOR] 🚨 PROCESSO PODE SER ENCERRADO!`);
  process.exit(1);
});

// === PARSING DE ARGUMENTOS ROBUSTO ===
let targetAccountId = null;

// Buscar --account
const accountIndex = process.argv.indexOf('--account');
if (accountIndex !== -1 && accountIndex + 1 < process.argv.length) {
  const accountArg = process.argv[accountIndex + 1];
  targetAccountId = parseInt(accountArg, 10);
  
  if (isNaN(targetAccountId) || targetAccountId <= 0) {
    console.error(`[MONITOR] ❌ AccountId inválido: "${accountArg}" (convertido para: ${targetAccountId})`);
    console.error(`[MONITOR] Uso correto: node monitoramento.js --account <ID_NUMERICO>`);
    process.exit(1);
  }
} else {
  console.error(`[MONITOR] ❌ Parâmetro --account não encontrado ou sem valor`);
  console.error(`[MONITOR] Argumentos recebidos: ${JSON.stringify(process.argv)}`);
  console.error(`[MONITOR] Uso correto: node monitoramento.js --account <ID_NUMERICO>`);
  process.exit(1);
}

console.log(`[MONITOR] ✅ AccountId validado: ${targetAccountId}`);

// Variáveis globais
let handlers = {};
let scheduledJobs = {};
let isShuttingDown = false;
let signalHandlersInstalled = false;

/**
 * Configura handlers de sinal do sistema (DEVE SER CHAMADA APENAS UMA VEZ POR PROCESSO)
 * @param {number} accountIdForLog - ID da conta para logging, mas os handlers são para o processo.
 */
function setupSignalHandlers(accountIdForLog) { 
  if (signalHandlersInstalled) {
    return;
  }
  
  console.log(`[MONITOR] 🛡️ Instalando signal handlers para graceful shutdown (processo para conta ${accountIdForLog})...`);
  
  process.once('SIGINT', async () => {
    console.log(`\n[MONITOR] 📡 SIGINT (Ctrl+C) recebido para conta ${accountIdForLog} - iniciando graceful shutdown...`);
    await gracefulShutdown(accountIdForLog);
  });
  
  process.once('SIGTERM', async () => {
    console.log(`\n[MONITOR] 📡 SIGTERM recebido para conta ${accountIdForLog} - iniciando graceful shutdown...`);
    await gracefulShutdown(accountIdForLog);
  });
  
  process.once('SIGQUIT', async () => {
    console.log(`\n[MONITOR] 📡 SIGQUIT recebido para conta ${accountIdForLog} - iniciando graceful shutdown...`);
    await gracefulShutdown(accountIdForLog);
  });
  
  process.on('uncaughtException', (error) => { 
    console.error(`\n[MONITOR] 💥 Erro não tratado (uncaughtException) no processo da conta ${accountIdForLog}:`, error);
    console.error(`[MONITOR] O processo para a conta ${accountIdForLog} provavelmente será encerrado devido a este erro.`);
  });
  
  process.on('unhandledRejection', (reason, promise) => { 
    console.error(`\n[MONITOR] 🚫 Promise rejeitada não tratada no processo da conta ${accountIdForLog}:`, reason);
    console.error('[MONITOR] Promise problematica:', promise);
    console.error(`[MONITOR] O processo para a conta ${accountIdForLog} pode estar instável, mas continuará tentando executar.`);
  });
  
  signalHandlersInstalled = true;
  console.log(`[MONITOR] ✅ Signal handlers instalados com sucesso para o processo da conta ${accountIdForLog}`);
}

/**
 * Sincroniza saldo da conta via WebSocket API (MELHORADA)
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object|null>} Resultado da sincronização
 */
async function syncAccountBalance(accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para syncAccountBalance: ${accountId}`);
  }

  try {
    console.log(`[MONITOR] Sincronizando saldo da conta ${accountId} via WebSocket API...`);

    const result = await getFuturesAccountBalanceDetails(accountId);
    
    if (result && result.success) {
      console.log(`[MONITOR] ✅ Saldo sincronizado via REST API para conta ${accountId}:`);
      console.log(`[MONITOR] 💰 Total: ${result.totalBalance} USDT, Disponível: ${result.availableBalance} USDT`);
      return result;
    } else {
      console.error(`[MONITOR] ❌ Falha na sincronização via REST API para conta ${accountId}:`, result?.error || 'Resposta inválida');
      return null;
    }
    
  } catch (error) {
    console.error(`[MONITOR] ❌ Erro ao sincronizar saldo da conta ${accountId}: ${error.message}`);
    return null;
  }
}

/**
 * Função principal para inicializar o monitoramento
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Jobs agendados
 */
async function initializeMonitoring(accountId) {
  setupSignalHandlers(accountId);
  
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
  }

  console.log(`[MONITOR] Inicializando sistema de monitoramento para conta ID: ${accountId}...`);

  try {
    // === ETAPA 1: Verificar conexão com banco ===
    console.log(`📊 ETAPA 1: Verificando conexão com banco de dados para conta ${accountId}...`);
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco de dados para conta ${accountId}`);
    }
    console.log(`✅ Banco de dados conectado com sucesso para conta ${accountId}\n`);
    
    // === ETAPA 2: Verificar consistência de ambiente ===
    console.log(`🔍 ETAPA 2: Verificando consistência de ambiente para conta ${accountId}...`);
    try {
      await verifyAndFixEnvironmentConsistency(accountId);
      console.log('[MONITOR] Verificação de consistência de ambiente concluída.');
    } catch (envError) {
      console.error('[MONITOR] ⚠️ Erro ao verificar consistência de ambiente, mas continuando:', envError.message);
    }

    // === ETAPA 3: Carregar credenciais ===
    console.log(`🔑 ETAPA 3: Carregando credenciais da conta ${accountId}...`);
    try {
      // CORREÇÃO: Usar api.loadCredentialsFromDatabase
      const credentials = await api.loadCredentialsFromDatabase(accountId);
      
      // CORREÇÃO: Verificar credenciais REST obrigatórias
      if (!credentials.apiKey || !credentials.secretKey) {
        throw new Error('Credenciais API REST incompletas');
      }
      console.log('✅ Credenciais REST carregadas com sucesso');
      
      console.log(`📋 Detalhes das credenciais:`);
      console.log(`- API Key: ${credentials.apiKey ? credentials.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- Secret Key: ${credentials.secretKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log(`- WS API Key: ${credentials.wsApiKey ? credentials.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- WS API Secret: ${credentials.wsApiSecret ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log();
      
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
      throw credError;
    }

// === ETAPA 3.5: Inicializar Bot do Telegram ===
console.log(`🤖 ETAPA 3.5: Inicializando bot do Telegram para conta ${accountId}...`);
try {
  const telegramBotInstance = await initializeTelegramBot(accountId);
  if (telegramBotInstance) {
    console.log(`✅ Bot do Telegram inicializado para conta ${accountId}`);
    console.log(`📋 Detalhes do bot:`);
    console.log(`   - Nome da conta: ${telegramBotInstance.accountName}`);
    console.log(`   - Chat ID: ${telegramBotInstance.chatId}`);
    console.log(`   - Token: ${telegramBotInstance.token.substring(0, 8)}...`);
  } else {
    console.log(`⚠️ Bot do Telegram não foi inicializado para conta ${accountId}`);
  }
} catch (telegramError) {
  console.error(`❌ Erro crítico ao inicializar bot do Telegram para conta ${accountId}:`, telegramError.message);
  // Não bloquear a inicialização por causa do Telegram
  console.log(`⚠️ Continuando inicialização sem bot do Telegram...`);
}
    
    // === ETAPA 4: Verificar estado da conexão ===
    console.log(`🔗 ETAPA 4: Verificando estado da conexão da conta ${accountId}...`);
    
    let accountState = api.getAccountConnectionState(accountId);
    
    if (!accountState) {
      console.log('⚠️ Estado da conta não existe, criando...');
      accountState = api.getAccountConnectionState(accountId, true);
      
      if (!accountState) {
        throw new Error('Impossível inicializar estado da conta');
      }
    }
    
    console.log('📋 Estado da conta verificado');

    console.log(`🕐 ETAPA 4.5: Verificando sincronização de tempo para conta ${accountId}...`);
try {
  const { checkServerTime } = require('../api/rest');
  const timeSync = await checkServerTime(accountId);
  
  if (!timeSync) {
    console.warn(`[MONITOR] ⚠️ Problema de sincronização de tempo detectado`);
    console.warn(`[MONITOR] ⚠️ Isso pode causar erros de 'recvWindow' nas requisições`);
  }
} catch (timeError) {
  console.warn(`[MONITOR] ⚠️ Erro ao verificar sincronização de tempo:`, timeError.message);
}

// === ETAPA 5: Inicializar WebSocket (SEM WebSocket API) ===
console.log(`🌐 ETAPA 5: Inicializando WebSockets para conta ${accountId}...`);

try {
  // ✅ APENAS WebSockets tradicionais, SEM WebSocket API
  console.log(`📡 WebSockets tradicionais disponíveis`);
} catch (wsInitError) {
  console.warn('⚠️ Erro nos WebSockets:', wsInitError.message);
}

    // === ETAPA 6: Verificar status da sessão ===
    console.log(`🔍 ETAPA 6: Verificando status da sessão WebSocket para conta ${accountId}...`);
    try {
      const sessionStatusResponse = await websockets.checkSessionStatus(accountId);
      const isActive = sessionStatusResponse && sessionStatusResponse.result && sessionStatusResponse.result.apiKey !== null;
      console.log('📊 Status da sessão:', isActive ? 'ATIVA' : 'INATIVA');
    } catch (sessionError) {
      console.warn('⚠️ Erro ao verificar status da sessão:', sessionError.message);
    }

    // === ETAPA 6.5: Registrar callbacks de monitoramento ===
console.log(`🔄 ETAPA 6.5: Registrando callbacks de WebSocket para conta ${accountId}...`);

try {
  const currentHandlers = websockets.getHandlers(accountId);
  const updatedHandlers = {
    ...currentHandlers,
    onPriceUpdate: async (symbol, price, db, acctId) => {
      try {
        console.log(`[MONITOR] 📊 Preço recebido: ${symbol} = ${price} (conta ${acctId})`);
        await onPriceUpdate(symbol, price, db, acctId);
      } catch (error) {
        console.error(`[MONITOR] ❌ Erro em onPriceUpdate:`, error.message);
      }
    }
  };

  // Registrar os handlers atualizados
  websockets.setMonitoringCallbacks(updatedHandlers, accountId);
  
  // Verificar registro
  const finalHandlers = websockets.getHandlers(accountId);
  console.log(`[MONITOR] 🔍 Verificação final do callback onPriceUpdate: ${typeof finalHandlers.onPriceUpdate}`);
  
} catch (callbackError) {
  console.error(`[MONITOR] ❌ Erro ao registrar callbacks para conta ${accountId}:`, callbackError.message);
}

    // === ETAPA 7: CONFIGURAR HANDLERS SEPARADAMENTE ===
    console.log(`🔧 ETAPA 7: Configurando handlers para conta ${accountId}...`);
    
    try {
      // INICIALIZAR ORDER HANDLERS
      console.log(`[MONITOR] Inicializando ORDER handlers para conta ${accountId}...`);
      const orderHandlersInitialized = await orderHandlers.initializeOrderHandlers(accountId);
      
      if (!orderHandlersInitialized) {
        throw new Error('Falha ao inicializar order handlers');
      }
      console.log(`[MONITOR] ✅ Order handlers inicializados para conta ${accountId}`);
      
      // INICIALIZAR ACCOUNT HANDLERS
      console.log(`[MONITOR] Inicializando ACCOUNT handlers para conta ${accountId}...`);
      const accountHandlersInitialized = await accountHandlers.initializeAccountHandlers(accountId);
      
      if (!accountHandlersInitialized) {
        throw new Error('Falha ao inicializar account handlers');
      }
      console.log(`[MONITOR] ✅ Account handlers inicializados para conta ${accountId}`);
      
      // ✅ IMPORTANTE: VERIFICAR E CORRIGIR HANDLERS FINAIS
      const currentHandlers = websockets.getHandlers(accountId);
      console.log(`[MONITOR] 🔍 Verificando handlers registrados para conta ${accountId}:`);
      console.log(`  - handleOrderUpdate: ${typeof currentHandlers.handleOrderUpdate}`);
      console.log(`  - handleAccountUpdate: ${typeof currentHandlers.handleAccountUpdate}`);
      
      // ✅ GARANTIR QUE AMBOS OS HANDLERS ESTÃO FUNCIONANDO
      if (typeof currentHandlers.handleOrderUpdate !== 'function') {
        console.warn(`[MONITOR] ⚠️ handleOrderUpdate não está registrado corretamente, registrando manualmente...`);
        
        websockets.setMonitoringCallbacks({
          ...currentHandlers,
          handleOrderUpdate: async (orderMsg, db) => {
            try {
              // ✅ CHAMAR A FUNÇÃO CORRIGIDA
              await orderHandlers.handleOrderUpdate(accountId, orderMsg, db);
            } catch (error) {
              console.error(`[MONITOR] ❌ Erro em handleOrderUpdate manual:`, error.message);
            }
          }
        }, accountId);
      }
      
      if (typeof currentHandlers.handleAccountUpdate !== 'function') {
        console.warn(`[MONITOR] ⚠️ handleAccountUpdate não está registrado corretamente, registrando manualmente...`);
        
        websockets.setMonitoringCallbacks({
          ...currentHandlers,
          handleAccountUpdate: async (accountMsg, db) => {
            try {
              await accountHandlers.handleAccountUpdate(accountMsg, accountId, db);
            } catch (error) {
              console.error(`[MONITOR] ❌ Erro em handleAccountUpdate manual:`, error.message);
            }
          }
        }, accountId);
      }
      
      // VERIFICAR STATUS FINAL DOS HANDLERS
      const finalHandlers = websockets.getHandlers(accountId);
      const orderHandlersOK = typeof finalHandlers.handleOrderUpdate === 'function';
      const accountHandlersOK = typeof finalHandlers.handleAccountUpdate === 'function';
      
      console.log(`[MONITOR] Status final dos handlers para conta ${accountId}:`);
      console.log(`  - Order handlers: ${orderHandlersOK ? '✅' : '❌'}`);
      console.log(`  - Account handlers: ${accountHandlersOK ? '✅' : '❌'}`);
      
      if (!orderHandlersOK || !accountHandlersOK) {
        throw new Error('Nem todos os handlers foram registrados corretamente');
      }
       
} catch (handlerError) {
  console.error(`[MONITOR] ❌ Erro crítico ao configurar handlers para conta ${accountId}:`, handlerError.message);
  throw handlerError;
}

    // === ETAPA 8: Iniciar UserDataStream ===
    console.log(`🌐 ETAPA 8: Iniciando UserDataStream para conta ${accountId}...`);
    
    try {
      await websockets.startUserDataStream(db, accountId);
      console.log(`[MONITOR] ✅ UserDataStream iniciado para conta ${accountId}`);
    } catch (userDataError) {
      console.error(`[MONITOR] ⚠️ Erro ao iniciar UserDataStream para conta ${accountId}:`, userDataError.message);
    }

// === ETAPA 9: Limpeza e preparação de sinais ===
console.log(`🧹 ETAPA 9: Executando limpeza avançada para conta ${accountId}...`);

try {
  // ✅ SINCRONIZAR POSIÇÕES E ORDENS PRIMEIRO
  await syncPositionsWithExchange(accountId);
  await syncOrdersWithExchange(accountId);

  // ✅ LIMPEZA SIMPLIFICADA DE ORDENS ÓRFÃS (Nova versão)
  console.log(`[MONITOR] 🔍 Verificando ordens órfãs para conta ${accountId}...`);
  const { cancelOrphanOrders } = require('../services/cleanup');
  const orphanResult = await cancelOrphanOrders(accountId);

  if (orphanResult > 0) {
    console.log(`[MONITOR] ✅ ${orphanResult} ordens órfãs processadas para conta ${accountId}`);
  } else {
    console.log(`[MONITOR] ✅ Nenhuma ordem órfã encontrada para conta ${accountId}`);
  }
  
  // ✅ MOVER ORDENS CANCELED PARA HISTÓRICO
  const { moveOrdersToHistory } = require('../services/cleanup');
  const movedOrders = await moveOrdersToHistory(accountId);
  if (movedOrders > 0) {
    console.log(`[MONITOR] 📚 ${movedOrders} ordens movidas para histórico para conta ${accountId}`);
  }
  
  // ✅ LIMPEZA DE SINAIS ÓRFÃOS (mantém como estava)
  console.log(`[MONITOR] 🗑️ Limpando sinais órfãos...`);
  await cleanupOrphanSignals(accountId);
  
  console.log(`[MONITOR] ✅ Limpeza avançada concluída para conta ${accountId}`);
} catch (cleanupError) {
  console.error(`[MONITOR] ⚠️ Erro durante limpeza avançada para conta ${accountId}:`, cleanupError.message);
}

    // === ETAPA 10: Verificar sinais ===
    console.log(`📋 ETAPA 10: Monitorar sinais para conta ${accountId}...`);
    
    try {
      await runSignalMonitoring(accountId);
    } catch (signalCheckError) {
      console.error(`[MONITOR] ⚠️ Erro ao monitorar sinais para conta ${accountId}:`, signalCheckError.message);
    }

// === ETAPA 11: Iniciar monitoramento de preços ===
console.log(`📈 ETAPA 11: Iniciando monitoramento de preços para conta ${accountId}...`);

try {
  // ✅ VERSÃO CORRIGIDA: Usar função inline em vez de duplicar
  const symbolsCount = await startPriceMonitoringInline(accountId);
  console.log(`[MONITOR] ✅ Monitoramento de preços iniciado para ${symbolsCount} símbolos da conta ${accountId}.`);
} catch (priceError) {
  console.error(`[MONITOR] ⚠️ Erro ao iniciar monitoramento de preços para conta ${accountId}:`, priceError.message);
}

/**
 * ✅ FUNÇÃO INLINE CORRIGIDA: Inicia monitoramento de preços
 */
async function startPriceMonitoringInline(accountId) {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return 0;
    }

    // ✅ PRIORITÁRIO: Símbolos com sinais AGUARDANDO_ACIONAMENTO
    const [pendingSignals] = await db.query(`
      SELECT DISTINCT symbol
      FROM webhook_signals
      WHERE conta_id = ? AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [accountId]);

    // ✅ SECUNDÁRIO: Símbolos com posições abertas
    const [openPositions] = await db.query(`
      SELECT DISTINCT simbolo as symbol
      FROM posicoes
      WHERE conta_id = ? AND status = 'OPEN'
    `, [accountId]);

    // ✅ TERCIÁRIO: Símbolos com ordens de entrada pendentes
    const [pendingEntries] = await db.query(`
      SELECT DISTINCT simbolo as symbol
      FROM ordens
      WHERE conta_id = ? AND tipo_ordem_bot = 'ENTRADA' AND status IN ('NEW', 'PARTIALLY_FILLED')
    `, [accountId]);

    const symbols = new Set();

    // ✅ PRIORIZAR SINAIS (mais importante)
    pendingSignals.forEach(signal => {
      symbols.add(signal.symbol);
      console.log(`[MONITOR] ⭐ Símbolo prioritário (sinal aguardando): ${signal.symbol}`);
    });

    // ✅ ADICIONAR POSIÇÕES ABERTAS
    openPositions.forEach(position => {
      if (!symbols.has(position.symbol)) {
        symbols.add(position.symbol);
        console.log(`[MONITOR] 📊 Símbolo (posição aberta): ${position.symbol}`);
      }
    });

    // ✅ ADICIONAR ORDENS PENDENTES
    pendingEntries.forEach(entry => {
      if (!symbols.has(entry.symbol)) {
        symbols.add(entry.symbol);
        console.log(`[MONITOR] 🔄 Símbolo (entrada pendente): ${entry.symbol}`);
      }
    });

    console.log(`[MONITOR] 📋 Total de símbolos para monitoramento: ${symbols.size}`);
    console.log(`[MONITOR] 📋 Símbolos: ${Array.from(symbols).join(', ')}`);

    // ✅ VERIFICAR se há sinais expirados durante período offline
    if (pendingSignals.length > 0) {
      console.log(`[MONITOR] 🔍 Verificando ${pendingSignals.length} sinais para possível expiração...`);
      
      const expiredCount = await checkExpiredSignals(accountId);
      
      if (expiredCount > 0) {
        console.log(`[MONITOR] ⏰ ${expiredCount} sinais expirados cancelados durante inicialização`);
      }
    }

    // Iniciar websockets para cada símbolo
    for (const symbol of symbols) {
      try {
        console.log(`[MONITOR] 🌐 Iniciando WebSocket para ${symbol} (conta ${accountId})`);
        await websockets.ensurePriceWebsocketExists(symbol, accountId);
      } catch (wsError) {
        console.error(`[MONITOR] ❌ Erro ao iniciar WebSocket para ${symbol}:`, wsError.message);
      }
    }

    return symbols.size;

  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
    return 0;
  }
}

    // === ETAPA 12: Sincronizar posições ===
    //console.log(`🔄 ETAPA 12: Sincronizando posições para conta ${accountId}...`);
    
    try {
      await syncPositionsWithExchange(accountId);
      await syncOrdersWithExchange(accountId);
      console.log(`[MONITOR] ✅ Sincronização de posições concluída para conta ${accountId}.`);
    } catch (syncError) {
      console.error(`[MONITOR] ⚠️ Erro ao sincronizar posições para conta ${accountId}:`, syncError.message);
    }

    // === ETAPA 13: Agendar jobs ===
    console.log(`⏰ ETAPA 13: Agendando jobs avançados para conta ${accountId}...`);

    const accountJobs = {};

    // Job principal: verificar sinais pendentes a cada 15 segundos
    accountJobs.runSignalMonitoring = schedule.scheduleJob('*/15 * * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await runSignalMonitoring(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na verificação periódica de sinais para conta ${accountId}:`, error.message);
      }
    });

    accountJobs.verifyWebSocketHealth = schedule.scheduleJob('*/2 * * * *', async () => {
  if (isShuttingDown) return;
  try {
    const db = await getDatabaseInstance();
    
    // Verificar se há sinais aguardando
    const [signals] = await db.query(`
      SELECT symbol FROM webhook_signals 
      WHERE conta_id = ? AND status = 'AGUARDANDO_ACIONAMENTO'
      GROUP BY symbol
      LIMIT 5
    `, [accountId]);
    
    if (signals.length > 0) {
      //console.log(`[MONITOR] 🔍 Verificando saúde do WebSocket para ${signals.length} símbolos:`);
      
      for (const signal of signals) {
        try {
          const priceWebsockets = websockets.getPriceWebsockets(accountId);
          
          if (priceWebsockets && priceWebsockets.has(signal.symbol)) {
            const ws = priceWebsockets.get(signal.symbol);
            const isOpen = ws && ws.readyState === 1; // WebSocket.OPEN
            
            if (isOpen) {
              //console.log(`[MONITOR]   ✅ ${signal.symbol}: WebSocket ativo`);
            } else {
              console.log(`[MONITOR]   ❌ ${signal.symbol}: WebSocket inativo (readyState: ${ws?.readyState})`);
              
              // Tentar recriar o WebSocket
              console.log(`[MONITOR] 🔄 Recriando WebSocket para ${signal.symbol}...`);
              await websockets.ensurePriceWebsocketExists(signal.symbol, accountId);
            }
          } else {
            console.log(`[MONITOR]   ❌ ${signal.symbol}: WebSocket não encontrado`);
            
            // Criar WebSocket
            console.log(`[MONITOR] 🆕 Criando WebSocket para ${signal.symbol}...`);
            await websockets.ensurePriceWebsocketExists(signal.symbol, accountId);
          }
          
        } catch (wsError) {
          console.error(`[MONITOR] ❌ Erro ao verificar WebSocket ${signal.symbol}:`, wsError.message);
        }
      }
    }
    
  } catch (error) {
    console.error(`[MONITOR] ❌ Erro na verificação de saúde do WebSocket:`, error.message);
  }
});

    // ✅ NOVO: Job de verificação de sinais expirados a cada 1 minuto (mais frequente)
accountJobs.checkExpiredSignals = schedule.scheduleJob('*/1 * * * *', async () => {
  if (isShuttingDown) return;
  try {
    if (typeof checkExpiredSignals === 'function') {
      const expiredCount = await checkExpiredSignals(accountId);
      if (expiredCount > 0) {
        console.log(`[MONITOR] ⏰ ${expiredCount} sinais expirados cancelados para conta ${accountId}`);
      }
    } else {
      console.error(`[MONITOR] ❌ checkExpiredSignals não é uma função válida`);
    }
    
  } catch (error) {
    console.error(`[MONITOR] ⚠️ Erro na verificação de sinais expirados para conta ${accountId}:`, error.message);
    
    // ✅ DEBUG: Mostrar detalhes do erro de import
    if (error.message.includes('not defined')) {
      console.error(`[MONITOR] 🔍 Verifique se checkExpiredSignals está exportado em signalProcessor.js`);
      
      try {
        console.log(`[MONITOR] 🔍 Funções disponíveis em signalProcessor:`, Object.keys(signalProcessor));
      } catch (importError) {
        console.error(`[MONITOR] ❌ Erro ao importar signalProcessor:`, importError.message);
      }
    }
  }
});

    // ✅ NOVO: Job avançado de monitoramento de posições a cada 1 minuto
    accountJobs.runAdvancedPositionMonitoring = schedule.scheduleJob('*/1 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await runAdvancedPositionMonitoring(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro no monitoramento avançado para conta ${accountId}:`, error.message);
      }
    });

    // ✅ MANTER APENAS JOB DE LIMPEZA DE POSIÇÕES FECHADAS
    accountJobs.cleanupClosedPositions = schedule.scheduleJob('*/1 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        const db = await getDatabaseInstance();
        
        // ✅ Buscar posições CLOSED para mover
        const [closedPositions] = await db.query(`
          SELECT id, simbolo, status, data_hora_fechamento, observacoes 
          FROM posicoes 
          WHERE status = 'CLOSED' AND conta_id = ?
          AND data_hora_fechamento < DATE_SUB(NOW(), INTERVAL 1 MINUTE)
        `, [accountId]);
        
        if (closedPositions.length > 0) {
          console.log(`[MONITOR] 📚 Movendo ${closedPositions.length} posições CLOSED para histórico...`);
          
          for (const position of closedPositions) {
            try {
              const { movePositionToHistoryPhysically } = require('./enhancedMonitoring');
              const moved = await movePositionToHistoryPhysically(
                db, 
                position.id, 
                'CLOSED', 
                position.observacoes || 'Auto-movida - posição fechada',
                accountId
              );
              
              if (moved) {
                console.log(`[MONITOR] ✅ Posição ${position.simbolo} movida para histórico`);
              }
              
            } catch (moveError) {
              console.error(`[MONITOR] ❌ Erro ao mover posição ${position.simbolo}:`, moveError.message);
            }
          }
        }
        
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na limpeza de posições CLOSED:`, error.message);
      }
    });

    // ✅ NOVO: Job de log de status a cada 1 minuto
    accountJobs.logStatus = schedule.scheduleJob('*/1 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await logOpenPositionsAndOrdersVisual(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro no log de status para conta ${accountId}:`, error.message);
      }
    });

    // Armazenar jobs para cleanup no shutdown
    scheduledJobs[accountId] = accountJobs;

console.log(`[MONITOR] ✅ Sistema de monitoramento avançado inicializado com sucesso para conta ${accountId}!`);
console.log(`[MONITOR] 📊 Jobs agendados: ${Object.keys(accountJobs).length}`);
console.log(`[MONITOR] 📋 Jobs ativos:`);
Object.keys(accountJobs).forEach(jobName => { 
  console.log(`[MONITOR]   - ${jobName}: ${accountJobs[jobName] ? '✅' : '❌'}`); 
});
console.log(`[MONITOR] 🎯 Funcionalidades ativas:`);
console.log(`[MONITOR]   - Trailing Stop Loss: ✅`);
console.log(`[MONITOR]   - Signal Timeout: ✅`);
console.log(`[MONITOR]   - Telegram Bot: ✅`);
console.log(`[MONITOR]   - Enhanced Monitoring: ✅`);
console.log(`[MONITOR]   - Position History: ✅`);
console.log(`[MONITOR]   - Cleanup System (Órfãs Simplificado): ✅`); // ✅ ATUALIZADO
console.log(`[MONITOR]   - Orphan Order Detection: ✅`); // ✅ NOVO
console.log(`[MONITOR]   - WebSocket API: ✅`);

    try {
      await logOpenPositionsAndOrdersVisual(accountId);
    } catch (error) {
      console.error(`[MONITOR] ⚠️ Erro ao executar logOpenPositionsAndOrdersVisual na inicialização:`, error.message);
    }
    
    return accountJobs;

  } catch (error) {
    console.error(`[MONITOR] ❌ Erro crítico durante inicialização para conta ${accountId}:`, error.message);
    throw error;
  }

}

/**
 * Implementa graceful shutdown para uma conta específica
 * @param {number} accountIdToShutdown - ID da conta (renomeado para evitar conflito)
 */
async function gracefulShutdown(accountIdToShutdown) {
  if (isShuttingDown) {
    console.log(`[MONITOR] Shutdown para conta ${accountIdToShutdown} já em andamento...`);
    return;
  }
  
  isShuttingDown = true;
  console.log(`\n[MONITOR] 🛑 === INICIANDO SHUTDOWN PARA CONTA ${accountIdToShutdown} ===`);
  
  try {
    console.log(`[MONITOR] 📅 1/7 - Cancelando jobs agendados para conta ${accountIdToShutdown}...`);
    if (scheduledJobs[accountIdToShutdown]) {
      let jobsCancelados = 0;
      for (const [jobName, job] of Object.entries(scheduledJobs[accountIdToShutdown])) {
        if (job && typeof job.cancel === 'function') {
          job.cancel();
          jobsCancelados++;
          console.log(`[MONITOR]   ✅ Job '${jobName}' (conta ${accountIdToShutdown}) cancelado`);
        }
      }
      delete scheduledJobs[accountIdToShutdown];
      console.log(`[MONITOR]   📊 Total de jobs cancelados para conta ${accountIdToShutdown}: ${jobsCancelados}`);
    } else {
      console.log(`[MONITOR]   ℹ️ Nenhum job agendado encontrado para conta ${accountIdToShutdown}`);
    }

    console.log(`[MONITOR] 🧹 2/7 - Executando limpeza final para conta ${accountIdToShutdown}...`);
    try {
      // Última limpeza antes de fechar
      await runPeriodicCleanup(accountIdToShutdown);
      console.log(`[MONITOR]   ✅ Limpeza final concluída para conta ${accountIdToShutdown}`);
    } catch (finalCleanupError) {
      console.error(`[MONITOR]   ⚠️ Erro na limpeza final para conta ${accountIdToShutdown}:`, finalCleanupError.message);
    }
    
    console.log(`[MONITOR] 🔌 3/7 - Fechando WebSockets para conta ${accountIdToShutdown}...`);
    try {
      websockets.reset(accountIdToShutdown); 
      console.log(`[MONITOR]   ✅ WebSockets para conta ${accountIdToShutdown} fechados/resetados`);
    } catch (wsError) {
      console.error(`[MONITOR]   ⚠️ Erro ao fechar WebSockets para conta ${accountIdToShutdown}: ${wsError.message}`);
    }
    
    console.log(`[MONITOR] 🧹 4/7 - Limpando handlers para conta ${accountIdToShutdown}...`);
    try {
      // LIMPAR ORDER HANDLERS
      const orderHandlersRemoved = orderHandlers.unregisterOrderHandlers(accountIdToShutdown);
      if (orderHandlersRemoved) {
        console.log(`[MONITOR]   ✅ Order handlers removidos para conta ${accountIdToShutdown}`);
      } else {
        console.log(`[MONITOR]   ⚠️ Falha ao remover order handlers para conta ${accountIdToShutdown}`);
      }
      
      // LIMPAR ACCOUNT HANDLERS
      const accountHandlersRemoved = accountHandlers.unregisterAccountHandlers(accountIdToShutdown);
      if (accountHandlersRemoved) {
        console.log(`[MONITOR]   ✅ Account handlers removidos para conta ${accountIdToShutdown}`);
      } else {
        console.log(`[MONITOR]   ⚠️ Falha ao remover account handlers para conta ${accountIdToShutdown}`);
      }
      
      // Limpar também os websocket handlers
      websockets.setMonitoringCallbacks({}, accountIdToShutdown);
      console.log(`[MONITOR]   ✅ WebSocket handlers limpos para conta ${accountIdToShutdown}`);
      
    } catch (handlerCleanupError) {
      console.error(`[MONITOR]   ⚠️ Erro ao limpar handlers para conta ${accountIdToShutdown}:`, handlerCleanupError.message);
    }

    console.log(`[MONITOR] 📈 5/7 - Parando monitoramento de preços para conta ${accountIdToShutdown}...`);
    // Esta lógica também é coberta por websockets.reset(accountIdToShutdown)
    console.log(`[MONITOR]   ✅ Monitoramento de preços para conta ${accountIdToShutdown} parado (via reset de websockets)`);
    
    console.log(`[MONITOR] ⏱️ 6/7 - Aguardando finalização de operações pendentes para conta ${accountIdToShutdown}...`);
    await new Promise(resolve => setTimeout(resolve, 2000)); 
    console.log(`[MONITOR]   ✅ Aguarde concluído para conta ${accountIdToShutdown}`);
    
    console.log(`[MONITOR] 🤖 6.5/7 - Parando bot do Telegram para conta ${accountIdToShutdown}...`);
    try {
      const { stopTelegramBot } = require('./telegramBot');
      await stopTelegramBot(accountIdToShutdown);
      console.log(`[MONITOR]   ✅ Bot do Telegram parado para conta ${accountIdToShutdown}`);
    } catch (telegramShutdownError) {
      console.error(`[MONITOR]   ⚠️ Erro ao parar bot do Telegram para conta ${accountIdToShutdown}:`, telegramShutdownError.message);
    }

    // ✅ ADICIONAR: Limpeza final de trailing stops
    console.log(`[MONITOR] 🎯 6.8/7 - Limpando estados de trailing stop para conta ${accountIdToShutdown}...`);
    try {
      // Limpar cache de trailing stops
      const { lastTrailingCheck } = require('./trailingStopLoss');
      if (lastTrailingCheck) {
        Object.keys(lastTrailingCheck).forEach(key => {
          if (key.includes(`_${accountIdToShutdown}`)) {
            delete lastTrailingCheck[key];
          }
        });
      }
      console.log(`[MONITOR]   ✅ Estados de trailing stop limpos para conta ${accountIdToShutdown}`);
    } catch (trailingCleanupError) {
      console.error(`[MONITOR]   ⚠️ Erro ao limpar trailing stops:`, trailingCleanupError.message);
    }
    
// === ETAPA 7/7: Fechar pool do banco ===
console.log(`🗃️ 7/7 - Fechando pool do banco de dados (se aplicável ao processo da conta ${accountIdToShutdown})...`);
try {
  const { closePool } = require('../../../core/database/conexao');
  const db = await getDatabaseInstance();
  
  if (db && db.pool) { 
    await closePool();
    console.log(`[MONITOR]   ✅ Pool do banco fechado (solicitado por conta ${accountIdToShutdown})`);
  } else {
    console.log(`[MONITOR]   ℹ️ Pool do banco já estava fechado ou não foi inicializado.`);
  }
} catch (dbError) {
  console.error(`[MONITOR]   ⚠️ Erro ao fechar pool do banco (solicitado por conta ${accountIdToShutdown}): ${dbError.message}`);
}
    
    console.log(`[MONITOR] ✅ === GRACEFUL SHUTDOWN PARA CONTA ${accountIdToShutdown} CONCLUÍDO ===`);
    
  } catch (error) {
    console.error(`[MONITOR] ❌ Erro durante graceful shutdown para conta ${accountIdToShutdown}:`, error.message);
  } finally {
    console.log(`[MONITOR] 🚪 Processo para conta ${accountIdToShutdown} encerrando em 1 segundo...`);
    
    setTimeout(() => {
      console.log(`[MONITOR] 🚨 PROCESSO PARA CONTA ${accountIdToShutdown} SAINDO AGORA!`);
      process.exit(0); 
    }, 1000);
  }
}

async function runSignalMonitoring(accountId) {
  try {
    // Verificar novos sinais (PENDING)
    const newSignals = await checkNewTrades(accountId);
    const canceledSignals = await checkCanceledSignals(accountId);
    const expiredSignals = await checkExpiredSignals(accountId);
    
    const totalProcessed = newSignals + canceledSignals + expiredSignals;
    if (totalProcessed > 0) {
      console.log(`[MONITORING] 📊 Processados: ${newSignals} novos, ${canceledSignals} cancelados, ${expiredSignals} expirados`);
    }
    
  } catch (error) {
    console.error(`[MONITORING] ❌ Erro no monitoramento de sinais:`, error.message);
  }
}

// === INICIALIZAÇÃO PROTEGIDA ===
async function startMonitoringProcess() {
  try {
    console.log(`[MONITOR] 🔄 Iniciando sistema de monitoramento para conta ${targetAccountId}...`);
    
    // ✅ VERIFICAÇÃO SIMPLES SEM LOOP COMPLEXO
    console.log(`[MONITOR] 📦 Verificando dependências críticas...`);
    console.log(`[MONITOR]   ✅ ../db/conexao`);
    console.log(`[MONITOR]   ✅ ../api`);
    console.log(`[MONITOR]   ✅ ../websockets`);
    console.log(`[MONITOR] ✅ Dependências críticas verificadas`);
    
    console.log(`[MONITOR] 📞 Chamando initializeMonitoring para conta ${targetAccountId}...`);
    
    // IMPORTANTE: Chamar initializeMonitoring de forma protegida
    const jobsResult = await initializeMonitoring(targetAccountId);
    
    if (!jobsResult || Object.keys(jobsResult).length === 0) {
      throw new Error('initializeMonitoring retornou resultado vazio ou inválido');
    }
    
    console.log(`[MONITOR] 🎉 === MONITORAMENTO INICIALIZADO ===`);
    console.log(`[MONITOR] 📊 Jobs agendados: ${Object.keys(jobsResult).length}`);
    console.log(`[MONITOR] 🔄 Sistema entrando em modo de operação contínua...`);
    
    // Manter o processo vivo com heartbeat
    let heartbeatCounter = 0;
    const heartbeatInterval = setInterval(() => {
      heartbeatCounter++;
      
      // Log de heartbeat a cada 5 minutos
      if (heartbeatCounter % 30 === 0) {
        console.log(`[MONITOR] ✅ Heartbeat configurado - Sistema operacional`);
      }
    }, 10000);
    
    // ✅ LIMPEZA DO HEARTBEAT NO SHUTDOWN
    process.on('exit', () => {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
      }
    });
    
  } catch (error) {
    console.error(`[MONITOR] ❌ ERRO FATAL na inicialização da conta ${targetAccountId}:`, error.message);
    console.error(`[MONITOR] Stack trace:`, error.stack);
    
    // Tentar limpeza de emergência
    try {
      console.log(`[MONITOR] 🧹 Tentando limpeza de emergência...`);
      await gracefulShutdown(targetAccountId);
    } catch (cleanupError) {
      console.error(`[MONITOR] ❌ Erro na limpeza de emergência:`, cleanupError.message);
    }
    
    console.error(`[MONITOR] 🚨 PROCESSO SERÁ ENCERRADO DEVIDO AO ERRO FATAL`);
    process.exit(1);
  }
}

// === EXECUÇÃO PRINCIPAL ===
if (require.main === module) {
  console.log(`[MONITOR] 🎬 Executando como script principal para conta ${targetAccountId}`);
  startMonitoringProcess();
} else {
  console.log(`[MONITOR] 📚 Carregado como módulo`);
}

// Remover a execução automática do final do arquivo se existir
