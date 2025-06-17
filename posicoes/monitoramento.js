const path = require('path');
const schedule = require('node-schedule');
const { getDatabaseInstance } = require('../db/conexao');
const { verifyAndFixEnvironmentConsistency, getFuturesAccountBalanceDetails } = require('../api');
const websockets = require('../websockets');
const api = require('../api'); // Certifique-se de que api é importado
const { initializeTelegramBot } = require('./telegramBot');
const { startPriceMonitoring, onPriceUpdate } = require('./priceMonitoring');
const { checkNewTrades } = require('./signalProcessor');
const { syncPositionsWithExchange, logOpenPositionsAndOrders } = require('./positionSync');
const orderHandlers = require('./orderHandlers');

// Variáveis globais
let handlers = {};
let scheduledJobs = {};
let isShuttingDown = false;
let signalHandlersInstalled = false;

/**
 * Sincroniza saldo da conta via WebSocket API
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object|null>} Resultado da sincronização
 */
async function syncAccountBalance(accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório para syncAccountBalance: ${accountId}`);
  }

  try {
    // const websocketApi = require('../websocketApi'); // Já importado no topo
    const result = await getFuturesAccountBalanceDetails(accountId);
    
    if (result && result.success) {
      if (result.saldo_base_calculo > result.previousBaseCalculo) {
        console.log(`[MONITOR] Base de cálculo aumentada para conta ${accountId}: ${result.previousBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
      }
      
      return {
        accountId: accountId,
        saldo: result.saldo,
        saldo_base_calculo: result.saldo_base_calculo
      };
    } else {
      console.error(`[MONITOR] Falha ao sincronizar saldo via WebSocket API para conta ${accountId}:`, result?.error || 'Resposta inválida');
      return null;
    }
  } catch (error) {
    console.error(`[MONITOR] Erro ao sincronizar saldo da conta ${accountId}: ${error.message}`);
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

    // === ETAPA 3: Carregar credenciais WebSocket ===
    console.log(`🔑 ETAPA 3: Carregando credenciais da conta ${accountId}...`);
    try {
      // const credentials = await websockets.loadCredentialsFromDatabase(accountId); // Linha antiga
      const credentials = await api.loadCredentialsFromDatabase(accountId); // <<< ALTERAR PARA api.loadCredentialsFromDatabase
      if (!credentials.apiKey || !credentials.secretKey) { // Checar credenciais REST
        throw new Error('Credenciais API REST incompletas');
      }
      console.log('✅ Credenciais carregadas com sucesso');
      
      console.log(`📋 Detalhes das credenciais:`);
      console.log(`- API Key: ${credentials.apiKey ? credentials.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- Secret Key: ${credentials.secretKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log(`- WS API Key: ${credentials.wsApiKey ? credentials.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- Private Key: ${credentials.privateKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log();
      
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
      throw credError;
    }
    
    // === ETAPA 4: Verificar estado da conexão ===
    console.log(`🔗 ETAPA 4: Verificando estado da conexão da conta ${accountId}...`);
    
    let accountState = api.getAccountConnectionState(accountId);
    
    if (!accountState) {
      console.log('⚠️ Estado da conta não existe ainda, tentando inicializar...');
      
      const allConnections = websockets.getAllAccountConnections();
      console.log(`📊 Total de conexões no mapa: ${allConnections.size}`);
      
      if (allConnections.has(accountId)) {
        console.log(`✅ Conta ${accountId} existe no mapa de conexões`);
        accountState = allConnections.get(accountId);
      } else {
        console.log(`❌ Conta ${accountId} não existe no mapa de conexões`);
        
        console.log('🔄 Tentando forçar inicialização do estado...');
        accountState = api.getAccountConnectionState(accountId, true);
        
        if (!accountState) {
          throw new Error('Impossível inicializar estado da conta mesmo forçando');
        }
      }
    }
    
    console.log('📋 Informações do estado da conta:');
    console.log(`- API Key: ${accountState.apiKey ? accountState.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Secret Key: ${accountState.secretKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
    console.log(`- WS API Key: ${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Private Key: ${accountState.privateKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
    console.log();

    // === ETAPA 5: Inicializar WebSocket API ===
    console.log(`🌐 ETAPA 5: Inicializando WebSocket API para conta ${accountId}...`);
    
    try {
      console.log(`📞 Chamando websockets.startWebSocketApi(${accountId})...`);
      const wsConnected = await websockets.startWebSocketApi(accountId);
      
      if (wsConnected) {
        console.log('✅ WebSocket API inicializado com sucesso!');
      } else {
        console.log('⚠️ WebSocket API não foi inicializado, mas continuando...');
      }
    } catch (wsInitError) {
      console.warn('⚠️ Erro ao inicializar WebSocket API:', wsInitError.message);
    }
    console.log();

    // === ETAPA 6: Verificar status da sessão ===
    console.log(`🔍 ETAPA 6: Verificando status da sessão WebSocket para conta ${accountId}...`);
    try {
      // CORREÇÃO: Chamar a função correta de websockets.js
      const sessionStatusResponse = await websockets.checkSessionStatus(accountId);
      const isActive = sessionStatusResponse && sessionStatusResponse.result && sessionStatusResponse.result.apiKey !== null;
      console.log('📊 Status da sessão:', isActive ? 'ATIVA' : 'INATIVA');
    } catch (sessionError) {
      console.warn('⚠️ Erro ao verificar status da sessão:', sessionError.message);
    }

    // === ETAPA 7: Configurar handlers WebSocket API ===
    console.log(`🔧 ETAPA 7: Configurando handlers WebSocket API para conta ${accountId}...`);
    
    try {
      // CORREÇÃO: Chamar a função correta de websocketApi.js
      await websockets.getHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers configurados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[MONITOR] ⚠️ Erro ao inicializar WebSocket API handlers para conta ${accountId}, continuando com REST API fallback: ${wsError.message}`);
      
      // Se o erro for de chave Ed25519, oferecer solução
      if (wsError.message.includes('Ed25519') || wsError.message.includes('private key') || wsError.message.includes('ws_api_secret')) {
        console.log('\n🔧 SOLUÇÃO: Verifique se a chave Ed25519 (ws_api_secret) está configurada corretamente no banco para a conta.');
        console.log('Pode ser necessário gerar uma nova chave na Binance e atualizar o campo `ws_api_secret` na tabela `contas`.');
        console.log('Exemplo de comando para configurar (se tiver o utilitário): node utils/configurarChavePEMAutomatico.js');
        console.log('');
      }
    }
    
    // === ETAPA 8: CORRIGIR - Configurar handlers com orderHandlers.js ===
    console.log(`🔄 ETAPA 8: Configurando handlers para conta ${accountId}...`);
    
    // USAR o sistema orderHandlers ao invés de configurar manualmente
    try {
      const handlersInitialized = await orderHandlers.initializeOrderHandlers(accountId);
      
      if (handlersInitialized) {
        console.log(`[MONITOR] ✅ Order handlers inicializados com sucesso para conta ${accountId}`);
        
        // Verificar se estão registrados
        const handlersRegistered = orderHandlers.areHandlersRegistered(accountId);
        console.log(`[MONITOR] Status dos handlers: ${handlersRegistered ? 'REGISTRADOS' : 'NÃO REGISTRADOS'}`);
        
      } else {
        throw new Error('Falha ao inicializar order handlers');
      }
      
    } catch (orderHandlerError) {
      console.error(`[MONITOR] ❌ Erro ao configurar order handlers para conta ${accountId}:`, orderHandlerError.message);
      
      // FALLBACK: Configurar handlers manualmente
      console.log(`[MONITOR] 🔄 Tentando configuração manual de handlers para conta ${accountId}...`);
      
      const manualHandlers = {
        handleOrderUpdate: async (orderMsg) => {
          try {
            await orderHandlers.handleOrderUpdate(orderMsg, accountId);
          } catch (error) {
            console.error(`[MONITOR] ⚠️ Erro em handleOrderUpdate para conta ${accountId}:`, error.message);
          }
        },
        handleAccountUpdate: async (message) => {
          try {
            await orderHandlers.handleAccountUpdate(message, accountId);
          } catch (error) {
            console.error(`[MONITOR] ⚠️ Erro em handleAccountUpdate para conta ${accountId}:`, error.message);
          }
        },
        onPriceUpdate: async (symbol, price, db) => {
          try {
            await onPriceUpdate(symbol, price, db, accountId);
          } catch (error) {
            console.error(`[MONITOR] ⚠️ Erro em onPriceUpdate para ${symbol} conta ${accountId}:`, error.message);
          }
        }
      };
      
      // Configurar callbacks manualmente
      try {
        websockets.setMonitoringCallbacks(manualHandlers, accountId);
        console.log(`[MONITOR] ✅ Callbacks manuais configurados para conta ${accountId}`);
      } catch (manualCallbackError) {
        console.error(`[MONITOR] ❌ Erro ao configurar callbacks manuais para conta ${accountId}:`, manualCallbackError.message);
        throw manualCallbackError;
      }
    }

    // === ETAPA 9: Iniciar UserDataStream ===
    console.log(`🌐 ETAPA 9: Iniciando UserDataStream para conta ${accountId}...`);
    
    try {
      await websockets.startUserDataStream(db, accountId);
      console.log(`[MONITOR] ✅ UserDataStream iniciado para conta ${accountId}`);
    } catch (userDataError) {
      console.error(`[MONITOR] ⚠️ Erro ao iniciar UserDataStream para conta ${accountId}, mas continuando: ${userDataError.message}`);
    }

    // === ETAPA 10: Limpeza e preparação de sinais ===
    console.log(`🧹 ETAPA 10: Limpando sinais com erro para conta ${accountId}...`);
    
    try {
      await db.query(`
        UPDATE webhook_signals 
        SET status = 'ERROR', 
            error_message = CONCAT(IFNULL(error_message, ''), ' | Limpo durante inicialização') 
        WHERE status = 'PENDING' 
          AND error_message LIKE '%not defined%'
          AND conta_id = ?
      `, [accountId]);
    } catch (cleanError) {
      console.error(`[MONITOR] ⚠️ Erro ao limpar sinais com erro para conta ${accountId}:`, cleanError.message);
    }

    try {
      console.log(`[MONITOR] 🔄 Resetando sinais em processamento para conta ${accountId}...`);
      const [resetResult] = await db.query(`
        UPDATE webhook_signals 
        SET status = 'PENDING', 
            error_message = NULL,
            updated_at = NOW()
        WHERE status = 'PROCESSANDO' 
          AND conta_id = ?
      `, [accountId]);
      
      if (resetResult.affectedRows > 0) {
        console.log(`[MONITOR] ✅ ${resetResult.affectedRows} sinais resetados de PROCESSANDO para PENDING para conta ${accountId}`);
      }
    } catch (resetError) {
      console.error(`[MONITOR] ⚠️ Erro ao resetar sinais em processamento para conta ${accountId}:`, resetError.message);
    }

    // === ETAPA 11: Verificar sinais pendentes ===
    console.log(`📋 ETAPA 11: Verificando sinais pendentes para conta ${accountId}...`);
    
    try {
      await checkNewTrades(accountId);
    } catch (signalCheckError) {
      console.error(`[MONITOR] ⚠️ Erro ao verificar sinais pendentes para conta ${accountId}:`, signalCheckError.message);
    }

    // === ETAPA 12: Iniciar monitoramento de preços ===
    console.log(`📈 ETAPA 12: Iniciando monitoramento de preços para conta ${accountId}...`);
    
    try {
      const symbolsCount = await startPriceMonitoring(accountId);
      console.log(`[MONITOR] ✅ Monitoramento de preços iniciado para ${symbolsCount} símbolos da conta ${accountId}.`);
    } catch (priceError) {
      console.error(`[MONITOR] ⚠️ Erro ao iniciar monitoramento de preços para conta ${accountId}, mas continuando:`, priceError.message);
    }

    // === ETAPA 13: Sincronizar posições ===
    console.log(`🔄 ETAPA 13: Sincronizando posições para conta ${accountId}...`);
    
    try {
      await syncPositionsWithExchange(accountId);
      console.log(`[MONITOR] ✅ Sincronização de posições concluída para conta ${accountId}.`);
    } catch (syncError) {
      console.error(`[MONITOR] ⚠️ Erro ao sincronizar posições para conta ${accountId}, mas continuando:`, syncError.message);
    }

    // === ETAPA 14: Diagnóstico detalhado ===
    console.log(`🔧 ETAPA 14: Diagnóstico detalhado do WebSocket para conta ${accountId}...`);
    
    console.log('🔍 Estado atual das conexões:');
    const allConnectionsAfterInit = websockets.getAllAccountConnections(); // Renomeado para evitar conflito
    
    if (allConnectionsAfterInit.has(accountId)) {
      const conn = allConnectionsAfterInit.get(accountId);
      console.log(`  - accountId: ${accountId}`);
      console.log(`  - apiKey: ${conn.apiKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - secretKey: ${conn.secretKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - wsApiKey: ${conn.wsApiKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - privateKey (Ed25519): ${conn.privateKey ? 'Configurada' : 'Não configurada'}`); // privateKey é a Ed25519
      console.log(`  - isAuthenticated (REST API): ${conn.isAuthenticated}`); // Este isAuthenticated é mais genérico
      console.log(`  - wsApiAuthenticated (WS API): ${conn.wsApiAuthenticated}`);
      console.log(`  - requestCallbacks: ${conn.requestCallbacks ? conn.requestCallbacks.size : 'N/A'}`);
      console.log(`  - wsApiConnection state: ${conn.wsApiConnection ? conn.wsApiConnection.readyState : 'N/A'}`);
      console.log(`  - userDataStream state: ${conn.userDataStream ? conn.userDataStream.readyState : 'N/A'}`);
    }

    // === ETAPA 15: Agendar jobs específicos da conta ===
    console.log(`⏰ ETAPA FINAL: Agendando jobs para conta ${accountId}...`);
    
    const accountJobs = {};
    
    // Job principal: verificar sinais pendentes a cada 15 segundos
    console.log(`[MONITOR] Agendando verificação de sinais a cada 15 segundos para conta ${accountId}`);
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na verificação periódica de sinais para conta ${accountId}:`, error);
      }
    });
    
    // Job de sincronização de saldo a cada 5 minutos
    console.log(`[MONITOR] Agendando sincronização de saldo a cada 5 minutos para conta ${accountId}`);
    accountJobs.syncBalance = schedule.scheduleJob('*/5 * * * *', async () => {
      if (isShuttingDown) return;
      try {
        await syncAccountBalance(accountId);
      } catch (error) {
        console.error(`[MONITOR] ⚠️ Erro na sincronização periódica de saldo para conta ${accountId}:`, error);
      }
    });

    console.log(`[MONITOR] ✅ Sistema de monitoramento inicializado com sucesso para conta ${accountId}!`);
    console.log(`[MONITOR] 📊 Jobs agendados: ${Object.keys(accountJobs).length}`);
    console.log(`[MONITOR] 💡 Use Ctrl+C para encerrar graciosamente (se executando standalone)`);
    
    scheduledJobs[accountId] = accountJobs;
    
    return accountJobs;
    
  } catch (error) {
    console.error(`[MONITOR] ❌ Erro CRÍTICO na configuração inicial para conta ${accountId}: ${error.message}`);
    console.error('[MONITOR] Stack trace:', error.stack);
    
    const criticalErrors = [
      'AccountId inválido',
      'Não foi possível conectar ao banco de dados',
      'Impossível inicializar estado da conta',
      'Credenciais API REST incompletas', 
      'Credenciais não encontradas para conta',
      'Chave privada Ed25519 (ws_api_secret) não encontrada' // Adicionado erro crítico
    ];
    
    const isCriticalError = criticalErrors.some(criticalError => 
      error.message.includes(criticalError)
    );
    
    if (isCriticalError) {
      console.log(`[MONITOR] ⚠️ Erro crítico detectado durante a inicialização da conta ${accountId}: ${error.message}`);
      throw error; 
    } else {
      console.log(`[MONITOR] ⚠️ Erro não-crítico durante inicialização - tentando operar com funcionalidades limitadas para conta ${accountId}`);
      
      const limitedJobs = {};
      try {
        limitedJobs.checkNewTrades = schedule.scheduleJob('*/30 * * * * *', async () => {
          if (isShuttingDown) return;
          try {
            await checkNewTrades(accountId);
          } catch (jobError) { 
            console.error(`[MONITOR] ⚠️ Erro na verificação básica (modo limitado) para conta ${accountId}:`, jobError);
          }
        });
        
        console.log(`[MONITOR] ⚠️ Sistema operando em MODO LIMITADO para conta ${accountId}`);
        scheduledJobs[accountId] = limitedJobs;
        return limitedJobs;
        
      } catch (jobSetupError) { 
        console.error(`[MONITOR] ❌ Impossível criar jobs mesmo em modo limitado para conta ${accountId}:`, jobSetupError.message);
        throw jobSetupError;
      }
    }
  }
}

let currentAccountId = null; // Renomeado para evitar conflito com a variável global 'accountId'

if (require.main === module) {
  currentAccountId = process.argv.includes('--account') 
    ? parseInt(process.argv[process.argv.indexOf('--account') + 1])
    : null;

  if (!currentAccountId || isNaN(currentAccountId) || currentAccountId <= 0) {
    console.error('[MONITOR] ❌ AccountId é obrigatório e deve ser um número válido');
    console.error('[MONITOR] 📝 Uso: node posicoes/monitoramento.js --account <ID>');
    console.error('[MONITOR] 📝 Exemplo: node posicoes/monitoramento.js --account 2');
    process.exit(1);
  }

  console.log(`[MONITOR] Iniciando sistema de monitoramento para conta ID: ${currentAccountId}`);

  (async () => {
    try {
      await initializeMonitoring(currentAccountId);
    } catch (error) {
      console.error(`[MONITOR] Erro crítico na inicialização para conta ${currentAccountId}:`, error);
      process.exit(1);
    }
  })();
}

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
    console.log(`[MONITOR] 📅 1/6 - Cancelando jobs agendados para conta ${accountIdToShutdown}...`);
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
    
    console.log(`[MONITOR] 🔌 2/6 - Fechando WebSockets para conta ${accountIdToShutdown}...`);
    try {
      websockets.reset(accountIdToShutdown); 
      console.log(`[MONITOR]   ✅ WebSockets para conta ${accountIdToShutdown} fechados/resetados`);
    } catch (wsError) {
      console.error(`[MONITOR]   ⚠️ Erro ao fechar WebSockets para conta ${accountIdToShutdown}: ${wsError.message}`);
    }
    
    console.log(`[MONITOR] 🧹 3/6 - Limpando handlers para conta ${accountIdToShutdown}...`);
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

    console.log(`[MONITOR] 📈 4/6 - Parando monitoramento de preços para conta ${accountIdToShutdown}...`);
    // Esta lógica também é coberta por websockets.reset(accountIdToShutdown)
    console.log(`[MONITOR]   ✅ Monitoramento de preços para conta ${accountIdToShutdown} parado (via reset de websockets)`);
    
    console.log(`[MONITOR] ⏱️ 5/6 - Aguardando finalização de operações pendentes para conta ${accountIdToShutdown}...`);
    await new Promise(resolve => setTimeout(resolve, 2000)); 
    console.log(`[MONITOR]   ✅ Aguarde concluído para conta ${accountIdToShutdown}`);
    
    console.log(`[MONITOR] 🗃️ 6/6 - Fechando pool do banco de dados (se aplicável ao processo da conta ${accountIdToShutdown})...`);
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
  checkNewTrades: (accountId) => checkNewTrades(accountId),
  forceProcessPendingSignals: (accountId) => forceProcessPendingSignals(accountId)
};