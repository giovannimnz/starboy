const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const schedule = require('node-schedule');
const { getDatabaseInstance } = require('../db/conexao');
const { updateLeverageBracketsInDatabase, verifyAndFixEnvironmentConsistency } = require('../api');
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
  // CORREÇÃO: Validar accountId no início
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
    
    // === ETAPA 2: Atualizar dados de alavancagem ===
    console.log(`🔧 ETAPA 2: Atualizando brackets de alavancagem para conta ${accountId}...`);
    try {
      await updateLeverageBracketsInDatabase('binance', accountId);
      console.log('[MONITOR] Atualização de brackets de alavancagem concluída com sucesso.');
    } catch (bracketError) {
      console.error('[MONITOR] Erro ao atualizar brackets de alavancagem, mas continuando inicialização:', bracketError.message);
    }
    
    // === ETAPA 3: Verificar consistência de ambiente ===
    console.log(`🔍 ETAPA 3: Verificando consistência de ambiente para conta ${accountId}...`);
    try {
      await verifyAndFixEnvironmentConsistency(accountId);
      console.log('[MONITOR] Verificação de consistência de ambiente concluída.');
    } catch (envError) {
      console.error('[MONITOR] Erro ao verificar consistência de ambiente, mas continuando:', envError.message);
    }

    // === ETAPA 4: Carregar credenciais WebSocket ===
    console.log(`🔑 ETAPA 4: Carregando credenciais da conta ${accountId}...`);
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
    
    // === ETAPA 5: Verificar estado da conta ===
    console.log(`🔗 ETAPA 5: Verificando estado da conexão da conta ${accountId}...`);
    
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
    console.log(`- WS API Key: ${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Private Key: ${accountState.privateKey ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}`);
    console.log(`- WS API URL: ${accountState.wsApiUrl || 'PADRÃO'}`);
    console.log(`- Authenticated: ${accountState.isAuthenticated || accountState.wsApiAuthenticated || false}`);
    console.log();

    // === ETAPA 6: Inicializar WebSocket API ===
    console.log(`🔧 ETAPA 6: Inicializando WebSocket API para conta ${accountId}...`);
    
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

    // === ETAPA 7: Verificar status da sessão ===
    console.log(`🔍 ETAPA 7: Verificando status da sessão WebSocket para conta ${accountId}...`);
    try {
      const sessionStatus = await websockets.checkSessionStatus(accountId);
      console.log('📊 Status da sessão:', JSON.stringify(sessionStatus, null, 2));
    } catch (sessionError) {
      console.warn('⚠️ Erro ao verificar status da sessão:', sessionError.message);
    }
    console.log();

    // === ETAPA 8: Inicializar handlers WebSocket API ===
    console.log(`🎯 ETAPA 8: Inicializando handlers WebSocket API para conta ${accountId}...`);
    
    try {
      console.log(`📞 Chamando websocketApi.initializeHandlers(${accountId})...`);
      await websocketApi.initializeHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers inicializados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[MONITOR] Erro ao inicializar WebSocket API handlers para conta ${accountId}, continuando com REST API fallback: ${wsError.message}`);
      
      // Se o erro for de chave Ed25519, oferecer solução
      if (wsError.message.includes('Ed25519') || wsError.message.includes('private key')) {
        console.log('\n🔧 SOLUÇÃO: Execute o comando abaixo para configurar a chave Ed25519:');
        console.log('node utils/configurarChavePEMAutomatico.js');
        console.log('');
      }
    }
    
    // === ETAPA 9: Configurar handlers com accountId ===
    console.log(`🔄 ETAPA 9: Configurando handlers para conta ${accountId}...`);
    
    const handlers = {
      handleOrderUpdate: async (msg, db) => {
        try {
          await handleOrderUpdate(msg, db, accountId); // Passar accountId
        } catch (error) {
          console.error(`[MONITOR] Erro em handleOrderUpdate para conta ${accountId}:`, error);
        }
      },
      handleAccountUpdate: async (msg, db) => {
        try {
          await handleAccountUpdate(msg, db, accountId); // Passar accountId
        } catch (error) {
          console.error(`[MONITOR] Erro em handleAccountUpdate para conta ${accountId}:`, error);
        }
      },
      onPriceUpdate: async (symbol, price, db) => {
        try {
          await onPriceUpdate(symbol, price, db, accountId); // Passar accountId
        } catch (error) {
          console.error(`[MONITOR] Erro em onPriceUpdate para ${symbol} conta ${accountId}:`, error);
        }
      },
      getDbConnection: async () => await getDatabaseInstance()
    };
    
    // CORREÇÃO: Configurar callbacks com accountId
    try {
      websockets.setMonitoringCallbacks(handlers, accountId);
      console.log(`[MONITOR] Callbacks do WebSocket configurados para conta ${accountId}`);
    } catch (callbackError) {
      console.error(`[MONITOR] Erro ao configurar callbacks do WebSocket para conta ${accountId}:`, callbackError.message);
    }
    
    // === ETAPA 10: Iniciar UserDataStream ===
    console.log(`🌐 ETAPA 10: Iniciando UserDataStream para conta ${accountId}...`);
    
    try {
      await websockets.startUserDataStream(db, accountId);
      console.log(`[MONITOR] UserDataStream iniciado para conta ${accountId}`);
    } catch (userDataError) {
      console.error(`[MONITOR] Erro ao iniciar UserDataStream para conta ${accountId}, mas continuando: ${userDataError.message}`);
    }

    // === ETAPA 11: Limpeza e preparação de sinais ===
    console.log(`🧹 ETAPA 11: Limpando sinais com erro para conta ${accountId}...`);
    
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
      console.error(`[MONITOR] Erro ao limpar sinais com erro para conta ${accountId}:`, cleanError.message);
    }

    try {
      console.log(`[MONITOR] Resetando sinais em processamento para conta ${accountId}...`);
      const [resetResult] = await db.query(`
        UPDATE webhook_signals 
        SET status = 'PENDING', 
            error_message = NULL,
            updated_at = NOW()
        WHERE status = 'PROCESSANDO' 
          AND conta_id = ?
      `, [accountId]);
      
      if (resetResult.affectedRows > 0) {
        console.log(`[MONITOR] ${resetResult.affectedRows} sinais resetados de PROCESSANDO para PENDING para conta ${accountId}`);
      }
    } catch (resetError) {
      console.error(`[MONITOR] Erro ao resetar sinais em processamento para conta ${accountId}:`, resetError.message);
    }

    // === ETAPA 12: Verificar sinais pendentes ===
    console.log(`📋 ETAPA 12: Verificando sinais pendentes para conta ${accountId}...`);
    
    try {
      await checkNewTrades(accountId);
    } catch (signalCheckError) {
      console.error(`[MONITOR] Erro ao verificar sinais pendentes para conta ${accountId}:`, signalCheckError.message);
    }

    // === ETAPA 13: Iniciar monitoramento de preços ===
    console.log(`📈 ETAPA 13: Iniciando monitoramento de preços para conta ${accountId}...`);
    
    try {
      const symbolsCount = await startPriceMonitoring(accountId);
      console.log(`[MONITOR] Monitoramento de preços iniciado para ${symbolsCount} símbolos da conta ${accountId}.`);
    } catch (priceError) {
      console.error(`[MONITOR] Erro ao iniciar monitoramento de preços para conta ${accountId}, mas continuando:`, priceError.message);
    }

    // === ETAPA 14: Sincronizar posições ===
    console.log(`🔄 ETAPA 14: Sincronizando posições para conta ${accountId}...`);
    
    try {
      await syncPositionsWithExchange(accountId);
      console.log(`[MONITOR] Sincronização de posições concluída para conta ${accountId}.`);
    } catch (syncError) {
      console.error(`[MONITOR] Erro ao sincronizar posições para conta ${accountId}, mas continuando:`, syncError.message);
    }

    // === ETAPA 15: Diagnóstico detalhado ===
    console.log(`🔧 ETAPA 15: Diagnóstico detalhado do WebSocket para conta ${accountId}...`);
    
    console.log('🔍 Estado atual das conexões:');
    console.log(`- WebSocket API conectado: ${websockets.isWebSocketApiConnected(accountId)}`);
    console.log(`- WebSocket API autenticado: ${websockets.isWebSocketApiAuthenticated(accountId)}`);
    
    const allConnections = websockets.getAllAccountConnections();
    console.log(`- Total de conexões ativas: ${allConnections.size}`);
    
    if (allConnections.has(accountId)) {
      const conn = allConnections.get(accountId);
      console.log(`📋 Detalhes da conexão da conta ${accountId}:`);
      console.log(`  - wsApi existe: ${conn.wsApi ? 'SIM' : 'NÃO'}`);
      console.log(`  - wsApi estado: ${conn.wsApi ? conn.wsApi.readyState : 'N/A'}`);
      console.log(`  - isAuthenticated: ${conn.isAuthenticated}`);
      console.log(`  - wsApiAuthenticated: ${conn.wsApiAuthenticated}`);
      console.log(`  - requestCallbacks: ${conn.requestCallbacks ? conn.requestCallbacks.size : 'N/A'}`);
    }

    // === ETAPA 16: Agendar jobs específicos da conta ===
    console.log(`⏰ ETAPA 16: Agendando jobs para conta ${accountId}...`);
    
    const accountJobs = {};
    
    // Job principal: verificar sinais pendentes a cada 15 segundos
    console.log(`[MONITOR] Agendando verificação de sinais a cada 15 segundos para conta ${accountId}`);
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      try {
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro na verificação periódica de sinais para conta ${accountId}:`, error);
      }
    });
    
    // Job de sincronização de saldo a cada 5 minutos
    console.log(`[MONITOR] Agendando sincronização de saldo a cada 5 minutos para conta ${accountId}`);
    accountJobs.syncBalance = schedule.scheduleJob('*/5 * * * *', async () => {
      try {
        await syncAccountBalance(accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro na sincronização periódica de saldo para conta ${accountId}:`, error);
      }
    });

    console.log(`[MONITOR] Sistema de monitoramento inicializado com sucesso para conta ${accountId}!`);
    console.log(`[MONITOR] Jobs agendados: ${Object.keys(accountJobs).length}`);
    
    scheduledJobs[accountId] = accountJobs;
    
    return accountJobs;
    
  } catch (error) {
    console.error(`[MONITOR] Erro CRÍTICO na configuração inicial para conta ${accountId}: ${error.message}`);
    console.error('[MONITOR] Stack trace:', error.stack);
    
    console.log(`[MONITOR] Tentando continuar com funcionalidades básicas para conta ${accountId}...`);
    
    try {
      const db = await getDatabaseInstance();
      if (db) {
        const basicJobs = {};
        basicJobs.checkNewTrades = schedule.scheduleJob('*/30 * * * * *', async () => {
          try {
            console.log(`[MONITOR] Verificação básica de sinais para conta ${accountId}...`);
            await checkNewTrades(accountId);
          } catch (jobError) {
            console.error(`[MONITOR] Erro na verificação básica de sinais:`, jobError);
          }
        });
        
        console.log(`[MONITOR] Modo de recuperação ativado para conta ${accountId} - apenas verificação básica de sinais.`);
        return basicJobs;
      }
    } catch (recoveryError) {
      console.error(`[MONITOR] Falha total na inicialização para conta ${accountId}:`, recoveryError.message);
    }
    
    throw error;
  }
}

// Verifica se está sendo executado como script principal
const accountId = process.argv.includes('--account') 
  ? parseInt(process.argv[process.argv.indexOf('--account') + 1])
  : null;

// CORREÇÃO: Validar accountId obrigatório
if (!accountId || isNaN(accountId) || accountId <= 0) {
  console.error('[MONITOR] ❌ AccountId é obrigatório e deve ser um número válido');
  console.error('[MONITOR] 📝 Uso: node posicoes/monitoramento.js --account <ID>');
  console.error('[MONITOR] 📝 Exemplo: node posicoes/monitoramento.js --account 2');
  process.exit(1);
}

console.log(`[MONITOR] Iniciando sistema de monitoramento para conta ID: ${accountId}`);

// Auto-inicialização quando executado diretamente
if (require.main === module) {
  (async () => {
    try {
      await initializeMonitoring(accountId);
    } catch (error) {
      console.error(`[MONITOR] Erro crítico na inicialização para conta ${accountId}:`, error);
      process.exit(1);
    }
  })();
}

module.exports = {
  initializeMonitoring,
  syncAccountBalance,
  checkNewTrades: (accountId) => checkNewTrades(accountId),
  forceProcessPendingSignals: (accountId) => forceProcessPendingSignals(accountId)
};