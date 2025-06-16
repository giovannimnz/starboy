const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const schedule = require('node-schedule');
const { getDatabaseInstance } = require('../db/conexao');
const { verifyAndFixEnvironmentConsistency } = require('../api');
const websockets = require('../websockets');
const websocketApi = require('../websocketApi');

// Módulos separados
const { initializeTelegramBot } = require('./telegramBot');
const { startPriceMonitoring, onPriceUpdate } = require('./priceMonitoring');
const { checkNewTrades, forceProcessPendingSignals } = require('./signalProcessor');
const { syncPositionsWithExchange, logOpenPositionsAndOrders } = require('./positionSync');
const { handleOrderUpdate, handleAccountUpdate } = require('./orderHandlers');

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
    const websocketApi = require('../websocketApi');
    const result = await websocketApi.syncAccountBalanceViaWebSocket(accountId);
    
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
      const credentials = await websockets.loadCredentialsFromDatabase(accountId);
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
    
    let accountState = websockets.getAccountConnectionState(accountId);
    
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
        accountState = websockets.getAccountConnectionState(accountId, true);
        
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
      const sessionStatus = await websocketApi.getSessionStatus(accountId);
      console.log('📊 Status da sessão:', sessionStatus ? 'ATIVA' : 'INATIVA');
    } catch (sessionError) {
      console.warn('⚠️ Erro ao verificar status da sessão:', sessionError.message);
    }

    // === ETAPA 7: Configurar handlers WebSocket API ===
    console.log(`🔧 ETAPA 7: Configurando handlers WebSocket API para conta ${accountId}...`);
    
    try {
      await websocketApi.initializeWebSocketApiHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers configurados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[MONITOR] ⚠️ Erro ao inicializar WebSocket API handlers para conta ${accountId}, continuando com REST API fallback: ${wsError.message}`);
      
      // Se o erro for de chave Ed25519, oferecer solução
      if (wsError.message.includes('Ed25519') || wsError.message.includes('private key')) {
        console.log('\n🔧 SOLUÇÃO: Execute o comando abaixo para configurar a chave Ed25519:');
        console.log('node utils/configurarChavePEMAutomatico.js');
        console.log('');
      }
    }
    
    // === ETAPA 8: Configurar handlers com accountId ===
    console.log(`🔄 ETAPA 8: Configurando handlers para conta ${accountId}...`);
    
    const handlers = {
      handleOrderUpdate: async (msg, db) => {
        try {
          await handleOrderUpdate(msg, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] ⚠️ Erro em handleOrderUpdate para conta ${accountId}:`, error);
        }
      },
      handleAccountUpdate: async (msg, db) => {
        try {
          await handleAccountUpdate(msg, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] ⚠️ Erro em handleAccountUpdate para conta ${accountId}:`, error);
        }
      },
      onPriceUpdate: async (symbol, price, db) => {
        try {
          await onPriceUpdate(symbol, price, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] ⚠️ Erro em onPriceUpdate para ${symbol} conta ${accountId}:`, error);
        }
      },
      getDbConnection: async () => await getDatabaseInstance()
    };
    
    // CORREÇÃO: Configurar callbacks com accountId
    try {
      websockets.setMonitoringCallbacks(handlers, accountId);
      console.log(`[MONITOR] ✅ Callbacks do WebSocket configurados para conta ${accountId}`);
    } catch (callbackError) {
      console.error(`[MONITOR] ⚠️ Erro ao configurar callbacks do WebSocket para conta ${accountId}:`, callbackError.message);
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
    const allConnections = websockets.getAllAccountConnections();
    
    if (allConnections.has(accountId)) {
      const conn = allConnections.get(accountId);
      console.log(`  - accountId: ${accountId}`);
      console.log(`  - apiKey: ${conn.apiKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - secretKey: ${conn.secretKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - wsApiKey: ${conn.wsApiKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - privateKey: ${conn.privateKey ? 'Configurada' : 'Não configurada'}`);
      console.log(`  - isAuthenticated: ${conn.isAuthenticated}`);
      console.log(`  - wsApiAuthenticated: ${conn.wsApiAuthenticated}`);
      console.log(`  - requestCallbacks: ${conn.requestCallbacks ? conn.requestCallbacks.size : 'N/A'}`);
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
      'Credenciais API REST incompletas', // Adicionar erros que impedem a operação básica
      'Credenciais não encontradas para conta'
    ];
    
    const isCriticalError = criticalErrors.some(criticalError => 
      error.message.includes(criticalError)
    );
    
    if (isCriticalError) {
      console.log(`[MONITOR] ⚠️ Erro crítico detectado durante a inicialização da conta ${accountId}: ${error.message}`);
      // Não chamar gracefulShutdown aqui. Relançar o erro fará com que o processo filho
      // (monitoramento.js) termine com um código de erro. O app.js (processo pai)
      // detectará essa saída e decidirá se deve reiniciar a instância.
      throw error; 
    } else {
      console.log(`[MONITOR] ⚠️ Erro não-crítico durante inicialização - tentando operar com funcionalidades limitadas para conta ${accountId}`);
      
      const limitedJobs = {};
      try {
        limitedJobs.checkNewTrades = schedule.scheduleJob('*/30 * * * * *', async () => {
          if (isShuttingDown) return;
          try {
            await checkNewTrades(accountId);
          } catch (jobError) { // Renomear para evitar conflito com 'error' do catch externo
            console.error(`[MONITOR] ⚠️ Erro na verificação básica (modo limitado) para conta ${accountId}:`, jobError);
          }
        });
        
        console.log(`[MONITOR] ⚠️ Sistema operando em MODO LIMITADO para conta ${accountId}`);
        scheduledJobs[accountId] = limitedJobs;
        return limitedJobs;
        
      } catch (jobSetupError) { // Renomear para evitar conflito
        console.error(`[MONITOR] ❌ Impossível criar jobs mesmo em modo limitado para conta ${accountId}:`, jobSetupError.message);
        // Mesmo aqui, relançar o erro para que o app.js possa lidar.
        throw jobSetupError;
      }
    }
  }
}

let accountId = null;

if (require.main === module) {
  // Só executar validação se for o script principal
  accountId = process.argv.includes('--account') 
    ? parseInt(process.argv[process.argv.indexOf('--account') + 1])
    : null;

  // CORREÇÃO: Validar accountId obrigatório APENAS quando executado diretamente
  if (!accountId || isNaN(accountId) || accountId <= 0) {
    console.error('[MONITOR] ❌ AccountId é obrigatório e deve ser um número válido');
    console.error('[MONITOR] 📝 Uso: node posicoes/monitoramento.js --account <ID>');
    console.error('[MONITOR] 📝 Exemplo: node posicoes/monitoramento.js --account 2');
    process.exit(1);
  }

  console.log(`[MONITOR] Iniciando sistema de monitoramento para conta ID: ${accountId}`);

  // Auto-inicialização quando executado diretamente
  (async () => {
    try {
      await initializeMonitoring(accountId);
    } catch (error) {
      console.error(`[MONITOR] Erro crítico na inicialização para conta ${accountId}:`, error);
      process.exit(1);
    }
  })();
}

/**
 * Configura handlers de sinal do sistema (DEVE SER CHAMADA APENAS UMA VEZ POR PROCESSO)
 * @param {number} accountId - ID da conta para logging, mas os handlers são para o processo.
 */
function setupSignalHandlers(accountIdForLog) { // Renomeado para clareza
  if (signalHandlersInstalled) {
    // console.log(`[MONITOR] Signal handlers já estão instalados (conta ${accountIdForLog})`); // Log opcional
    return;
  }
  
  console.log(`[MONITOR] 🛡️ Instalando signal handlers para graceful shutdown (processo para conta ${accountIdForLog})...`);
  
  // Handlers que DEVEM chamar gracefulShutdown
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
  
  // Handlers que NÃO DEVEM chamar gracefulShutdown, apenas logar.
  // O Node.js geralmente encerra o processo em 'uncaughtException'.
  // O app.js (gerenciador de processos) deve lidar com a reinicialização.
  process.on('uncaughtException', (error) => { // Usar .on para pegar todos, se ocorrerem múltiplos antes do exit
    console.error(`\n[MONITOR] 💥 Erro não tratado (uncaughtException) no processo da conta ${accountIdForLog}:`, error);
    console.error(`[MONITOR] O processo para a conta ${accountIdForLog} provavelmente será encerrado devido a este erro.`);
    // Não chamar gracefulShutdown. Deixar o processo morrer.
    // Se o app.js estiver gerenciando, ele tentará reiniciar.
    // process.exit(1); // O Node.js geralmente faz isso por padrão para uncaughtException.
                      // Adicionar explicitamente se quiser garantir.
  });
  
  process.on('unhandledRejection', (reason, promise) => { // Usar .on
    console.error(`\n[MONITOR] 🚫 Promise rejeitada não tratada no processo da conta ${accountIdForLog}:`, reason);
    console.error('[MONITOR] Promise problematica:', promise);
    console.error(`[MONITOR] O processo para a conta ${accountIdForLog} pode estar instável, mas continuará tentando executar.`);
    // Não chamar gracefulShutdown.
  });
  
  signalHandlersInstalled = true;
  console.log(`[MONITOR] ✅ Signal handlers instalados com sucesso para o processo da conta ${accountIdForLog}`);
}

/**
 * Implementa graceful shutdown para uma conta específica
 * @param {number} accountId - ID da conta
 */
async function gracefulShutdown(accountId) {
  if (isShuttingDown) {
    console.log(`[MONITOR] Shutdown para conta ${accountId} já em andamento...`);
    return;
  }
  
  isShuttingDown = true; // Marcar o shutdown para esta instância específica
  console.log(`\n[MONITOR] 🛑 === INICIANDO GRACEFUL SHUTDOWN PARA CONTA ${accountId} ===`);
  
  try {
    // ... (PASSO 1 a PASSO 5 - mesma lógica de antes) ...
    // PASSO 1: Cancelar jobs agendados
    console.log(`[MONITOR] 📅 1/6 - Cancelando jobs agendados para conta ${accountId}...`);
    if (scheduledJobs[accountId]) {
      let jobsCancelados = 0;
      for (const [jobName, job] of Object.entries(scheduledJobs[accountId])) {
        if (job && typeof job.cancel === 'function') {
          job.cancel();
          jobsCancelados++;
          console.log(`[MONITOR]   ✅ Job '${jobName}' (conta ${accountId}) cancelado`);
        }
      }
      delete scheduledJobs[accountId];
      console.log(`[MONITOR]   📊 Total de jobs cancelados para conta ${accountId}: ${jobsCancelados}`);
    } else {
      console.log(`[MONITOR]   ℹ️ Nenhum job agendado encontrado para conta ${accountId}`);
    }
    
    // PASSO 2: Fechar WebSockets
    console.log(`[MONITOR] 🔌 2/6 - Fechando WebSockets para conta ${accountId}...`);
    try {
      // A função reset em websockets.js deve ser específica para a conta
      websockets.reset(accountId); 
      console.log(`[MONITOR]   ✅ WebSockets para conta ${accountId} fechados/resetados`);
    } catch (wsError) {
      console.error(`[MONITOR]   ⚠️ Erro ao fechar WebSockets para conta ${accountId}: ${wsError.message}`);
    }
    
    // PASSO 3: Limpar handlers (se houver handlers específicos da conta armazenados aqui)
    console.log(`[MONITOR] 🧹 3/6 - Limpando handlers para conta ${accountId}...`);
    if (handlers[accountId]) { // Assumindo que 'handlers' é um objeto que pode ter uma chave por accountId
      delete handlers[accountId];
      console.log(`[MONITOR]   ✅ Handlers para conta ${accountId} removidos`);
    } else {
      // Se handlers é global para o módulo, não limpar aqui, ou apenas limpar os callbacks da conta.
      // A lógica atual em websockets.js já limpa os callbacks no accountState.
      console.log(`[MONITOR]   ℹ️ Nenhum handler específico para limpar no monitor para conta ${accountId}`);
    }
    
    // PASSO 4: Parar monitoramento de preços (se for por conta)
    console.log(`[MONITOR] 📈 4/6 - Parando monitoramento de preços para conta ${accountId}...`);
    try {
      // Se startPriceMonitoring retorna algo para parar, ou se há uma função stopPriceMonitoring global
      // que precisa ser chamada. A lógica atual em websockets.js já lida com o fechamento
      // dos websockets de preço individuais em websockets.reset(accountId).
      console.log(`[MONITOR]   ✅ Monitoramento de preços para conta ${accountId} parado (via reset de websockets)`);
    } catch (priceError) {
      console.error(`[MONITOR]   ⚠️ Erro ao parar monitoramento de preços para conta ${accountId}: ${priceError.message}`);
    }
    
    // PASSO 5: Aguardar finalização de operações pendentes
    console.log(`[MONITOR] ⏱️ 5/6 - Aguardando finalização de operações pendentes para conta ${accountId}...`);
    await new Promise(resolve => setTimeout(resolve, 2000)); // Pequena pausa genérica
    console.log(`[MONITOR]   ✅ Aguarde concluído para conta ${accountId}`);
    
    // PASSO 6: Fechar pool do banco (por último)
    // Esta parte é delicada se múltiplos processos de monitoramento compartilham o mesmo pool.
    // Idealmente, o pool é gerenciado pelo processo principal (app.js) ou cada processo filho
    // tem seu próprio pool ou apenas usa a instância do pool.
    // Se cada monitoramento.js tem seu "próprio" pool (mesmo que seja uma referência ao global),
    // o closePool pode ser chamado.
    console.log(`[MONITOR] 🗃️ 6/6 - Fechando pool do banco de dados (se aplicável ao processo da conta ${accountId})...`);
    try {
      const { closePool, getPool } = require('../db/conexao');
      // Só fechar se o pool existir e não houver outras contas ativas usando-o (lógica complexa)
      // Por simplicidade, vamos assumir que cada processo filho pode tentar fechar sua "visão" do pool.
      // Se o pool for compartilhado, o primeiro a fechar fecha para todos.
      // Uma melhor abordagem seria o app.js gerenciar o fechamento do pool.
      if (getPool()) { // Verifica se o pool foi inicializado
          await closePool();
          console.log(`[MONITOR]   ✅ Pool do banco fechado (solicitado por conta ${accountId})`);
      } else {
          console.log(`[MONITOR]   ℹ️ Pool do banco já estava fechado ou não foi inicializado por este processo.`);
      }
    } catch (dbError) {
      console.error(`[MONITOR]   ⚠️ Erro ao fechar pool do banco (solicitado por conta ${accountId}): ${dbError.message}`);
    }
    
    console.log(`[MONITOR] ✅ === GRACEFUL SHUTDOWN PARA CONTA ${accountId} CONCLUÍDO ===`);
    
  } catch (error) {
    console.error(`[MONITOR] ❌ Erro durante graceful shutdown para conta ${accountId}:`, error.message);
  } finally {
    console.log(`[MONITOR] 🚪 Processo para conta ${accountId} encerrando em 1 segundo...`);
    
    // Este process.exit(0) garante que o app.js veja uma saída limpa
    // quando o shutdown é iniciado por SIGINT/SIGTERM.
    setTimeout(() => {
      console.log(`[MONITOR] 🚨 PROCESSO PARA CONTA ${accountId} SAINDO AGORA!`);
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