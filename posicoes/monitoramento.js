const path = require('path');
const schedule = require('node-schedule');
const { getDatabaseInstance } = require('../db/conexao');
const { verifyAndFixEnvironmentConsistency, getFuturesAccountBalanceDetails } = require('../api');
const websockets = require('../websockets');
const api = require('../api');

// NOVOS IMPORTS
const { initializeTelegramBot } = require('./telegramBot');
const { startPriceMonitoring, onPriceUpdate } = require('./priceMonitoring');
const { checkNewTrades } = require('./signalProcessor');
const { syncPositionsWithExchange, logOpenPositionsAndOrders } = require('./positionSync');
const orderHandlers = require('./orderHandlers');
const { checkExpiredSignals } = require('./signalTimeout');
const { runPeriodicCleanup, monitorWebSocketHealth, updatePositionPricesWithTrailing } = require('./enhancedMonitoring');
const { cleanupOrphanSignals, forceCloseGhostPositions, cancelOrphanOrders } = require('./cleanup');

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
 * Sincroniza saldo da conta via REST API
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object|null>} Resultado da sincronização
 */
async function syncAccountBalance(accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para syncAccountBalance: ${accountId}`);
  }

  try {
    console.log(`[MONITOR] Sincronizando saldo da conta ${accountId} via REST API...`);
    
    // CHAMADA CORRIGIDA - getFuturesAccountBalanceDetails já usa REST API
    const result = await getFuturesAccountBalanceDetails(accountId);
    
    if (result && result.success) {
      // CORREÇÃO: Verificar se a base de cálculo aumentou
      if (result.saldo_base_calculo > result.previousBaseCalculo) {
        console.log(`[MONITOR] 📈 Base de cálculo aumentada para conta ${accountId}: ${result.previousBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
      }
      
      // CORREÇÃO: Verificar se o saldo total mudou
      if (Math.abs(result.saldo - result.previousSaldo) > 0.01) {
        const mudanca = result.saldo - result.previousSaldo;
        const sinal = mudanca > 0 ? '+' : '';
        console.log(`[MONITOR] 💰 Saldo alterado para conta ${accountId}: ${result.previousSaldo.toFixed(2)} → ${result.saldo.toFixed(2)} USDT (${sinal}${mudanca.toFixed(2)})`);
      }
      
      console.log(`[MONITOR] ✅ Sincronização de saldo concluída para conta ${accountId}`);
      
      return {
        accountId: accountId,
        saldo: result.saldo,
        saldo_disponivel: result.saldo_disponivel,
        saldo_base_calculo: result.saldo_base_calculo,
        success: true
      };
      
    } else {
      console.error(`[MONITOR] ❌ Falha ao sincronizar saldo para conta ${accountId}:`, result?.error || 'Resposta inválida');
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
      const telegramBot = await initializeTelegramBot(accountId);
      if (telegramBot) {
        console.log(`✅ Bot do Telegram inicializado para conta ${accountId}`);
      } else {
        console.log(`⚠️ Bot do Telegram não configurado para conta ${accountId}`);
      }
    } catch (telegramError) {
      console.error(`⚠️ Erro ao inicializar bot do Telegram para conta ${accountId}:`, telegramError.message);
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

    // === ETAPA 5: Inicializar WebSocket API ===
    console.log(`🌐 ETAPA 5: Inicializando WebSocket API para conta ${accountId}...`);
    
    try {
      const wsConnected = await websockets.startWebSocketApi(accountId);
      console.log(`WebSocket API: ${wsConnected ? 'CONECTADO' : 'FALHOU'}`);
    } catch (wsInitError) {
      console.warn('⚠️ WebSocket API não inicializado:', wsInitError.message);
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

    // === ETAPA 7: CORREÇÃO - Configurar handlers APENAS via orderHandlers.js ===
    console.log(`🔧 ETAPA 7: Configurando handlers para conta ${accountId}...`);
    
    try {
      // USAR APENAS orderHandlers - SEM configuração manual
      const handlersInitialized = await orderHandlers.initializeOrderHandlers(accountId);
      
      if (!handlersInitialized) {
        throw new Error('Falha ao inicializar order handlers');
      }
      
      console.log(`[MONITOR] ✅ Order handlers inicializados com sucesso para conta ${accountId}`);
      
      // Verificar se estão registrados
      const handlersRegistered = orderHandlers.areHandlersRegistered(accountId);
      console.log(`[MONITOR] Status dos handlers: ${handlersRegistered ? 'REGISTRADOS' : 'NÃO REGISTRADOS'}`);
      
      // ADICIONAR callback de preço APENAS se não foi registrado via orderHandlers
      const currentHandlers = websockets.getHandlers(accountId);
      if (!currentHandlers.onPriceUpdate) {
        console.log(`[MONITOR] Adicionando callback de preço para conta ${accountId}...`);
        websockets.setMonitoringCallbacks({
          ...currentHandlers,
          onPriceUpdate: async (symbol, price, db) => {
            try {
              // USAR função melhorada do enhancedMonitoring
              await updatePositionPricesWithTrailing(db, symbol, price, accountId);
              
              // Chamar também a função original para manter compatibilidade
              await onPriceUpdate(symbol, price, db, accountId);
            } catch (error) {
              console.error(`[MONITOR] ⚠️ Erro em onPriceUpdate para ${symbol} conta ${accountId}:`, error.message);
            }
          }
        }, accountId);
      }
      
    } catch (orderHandlerError) {
      console.error(`[MONITOR] ❌ Erro crítico ao configurar handlers para conta ${accountId}:`, orderHandlerError.message);
      throw orderHandlerError; // Não usar fallback manual que causa conflitos
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
      // Limpeza de sinais órfãos
      await cleanupOrphanSignals(accountId);
      
      // Verificar sinais expirados
      const expiredCount = await checkExpiredSignals(accountId);
      if (expiredCount > 0) {
        console.log(`[MONITOR] ${expiredCount} sinais expirados cancelados para conta ${accountId}`);
      }
      
      // Cancelar ordens órfãs (uma vez na inicialização)
      const canceledOrders = await cancelOrphanOrders(accountId);
      if (canceledOrders > 0) {
        console.log(`[MONITOR] ${canceledOrders} ordens órfãs canceladas para conta ${accountId}`);
      }
      
      // Forçar fechamento de posições fantasma
      const closedGhosts = await forceCloseGhostPositions(accountId);
      if (closedGhosts > 0) {
        console.log(`[MONITOR] ${closedGhosts} posições fantasma fechadas para conta ${accountId}`);
      }
      
      console.log(`[MONITOR] ✅ Limpeza avançada concluída para conta ${accountId}`);
    } catch (cleanupError) {
      console.error(`[MONITOR] ⚠️ Erro durante limpeza avançada para conta ${accountId}:`, cleanupError.message);
    }

    // === ETAPA 10: Verificar sinais pendentes ===
    console.log(`📋 ETAPA 10: Verificando sinais pendentes para conta ${accountId}...`);
    
    try {
      await checkNewTrades(accountId);
    } catch (signalCheckError) {
      console.error(`[MONITOR] ⚠️ Erro ao verificar sinais pendentes para conta ${accountId}:`, signalCheckError.message);
    }

    // === ETAPA 11: Iniciar monitoramento de preços ===
    console.log(`📈 ETAPA 11: Iniciando monitoramento de preços para conta ${accountId}...`);
    
    try {
      const symbolsCount = await startPriceMonitoring(accountId);
      console.log(`[MONITOR] ✅ Monitoramento de preços iniciado para ${symbolsCount} símbolos da conta ${accountId}.`);
    } catch (priceError) {
      console.error(`[MONITOR] ⚠️ Erro ao iniciar monitoramento de preços para conta ${accountId}:`, priceError.message);
    }

    // === ETAPA 12: Sincronizar posições ===
    console.log(`🔄 ETAPA 12: Sincronizando posições para conta ${accountId}...`);
    
    try {
      await syncPositionsWithExchange(accountId);
      console.log(`[MONITOR] ✅ Sincronização de posições concluída para conta ${accountId}.`);
    } catch (syncError) {
      console.error(`[MONITOR] ⚠️ Erro ao sincronizar posições para conta ${accountId}:`, syncError.message);
    }

    // === ETAPA 13: Agendar jobs ===
    console.log(`⏰ ETAPA 13: Agendando jobs avançados para conta ${accountId}...`);

    const accountJobs = {};

    // Job principal: verificar sinais pendentes a cada 15 segundos
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na verificação periódica de sinais para conta ${accountId}:`, error.message);
      }
    });

    // Job de sincronização de saldo a cada 5 minutos
    accountJobs.syncBalance = schedule.scheduleJob('*/5 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await syncAccountBalance(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na sincronização periódica de saldo para conta ${accountId}:`, error.message);
      }
    });

    // NOVO: Job de verificação de sinais expirados a cada 2 minutos
    accountJobs.checkExpiredSignals = schedule.scheduleJob('*/2 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        const expiredCount = await checkExpiredSignals(accountId);
        if (expiredCount > 0) {
          console.log(`[MONITOR] ${expiredCount} sinais expirados cancelados para conta ${accountId}`);
        }
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na verificação de sinais expirados para conta ${accountId}:`, error.message);
      }
    });

    // NOVO: Job de limpeza periódica a cada 10 minutos
    accountJobs.periodicCleanup = schedule.scheduleJob('*/10 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await runPeriodicCleanup(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na limpeza periódica para conta ${accountId}:`, error.message);
      }
    });

    // NOVO: Job de monitoramento de saúde dos WebSockets a cada 5 minutos
    accountJobs.monitorWebSocketHealth = schedule.scheduleJob('*/5 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        monitorWebSocketHealth(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro no monitoramento de WebSockets para conta ${accountId}:`, error.message);
      }
    });

    // NOVO: Job de cancelamento de ordens órfãs a cada hora
    accountJobs.cancelOrphanOrders = schedule.scheduleJob('0 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        const canceledCount = await cancelOrphanOrders(accountId);
        if (canceledCount > 0) {
          console.log(`[MONITOR] ${canceledCount} ordens órfãs canceladas para conta ${accountId}`);
        }
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro ao cancelar ordens órfãs para conta ${accountId}:`, error.message);
      }
    });

    // Armazenar jobs para cleanup no shutdown
    scheduledJobs[accountId] = accountJobs;

    console.log(`[MONITOR] ✅ Sistema de monitoramento avançado inicializado com sucesso para conta ${accountId}!`);
    console.log(`[MONITOR] 📊 Jobs agendados: ${Object.keys(accountJobs).length}`);
    console.log(`[MONITOR] 📋 Jobs ativos: ${Object.keys(accountJobs).join(', ')}`);

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
  console.log(`\n[MONITOR] 🛑 === INICIANDO GRACEFUL SHUTDOWN PARA CONTA ${accountIdToShutdown} ===`);
  
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
      // CORREÇÃO: Usar orderHandlers para limpeza
      const handlersRemoved = orderHandlers.unregisterOrderHandlers(accountIdToShutdown);
      if (handlersRemoved) {
        console.log(`[MONITOR]   ✅ Order handlers removidos para conta ${accountIdToShutdown}`);
      } else {
        console.log(`[MONITOR]   ⚠️ Falha ao remover order handlers para conta ${accountIdToShutdown}`);
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
    
    console.log(`[MONITOR] 🗃️ 7/7 - Fechando pool do banco de dados (se aplicável ao processo da conta ${accountIdToShutdown})...`);
    try {
      const { closePool, getPool } = require('../db/conexao');
      if (getPool()) { 
          await closePool();
          console.log(`[MONITOR]   ✅ Pool do banco fechado (solicitado por conta ${accountIdToShutdown})`);
      } else {
          console.log(`[MONITOR]   ℹ️ Pool do banco já estava fechado ou não foi inicializado por este processo.`);
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

module.exports = {
  initializeMonitoring,
  syncAccountBalance,
  gracefulShutdown,
  checkNewTrades: (accountId) => checkNewTrades(accountId)
};