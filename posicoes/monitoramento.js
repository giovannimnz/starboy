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
 * Função principal para inicializar o monitoramento
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Jobs agendados
 */
async function initializeMonitoring(accountId = 1) {
  console.log(`[MONITOR] Inicializando sistema de monitoramento para conta ID: ${accountId}...`);

  try {
    // Obter conexão com o banco de dados
    const db = await getDatabaseInstance(accountId);
    if (!db) {
      throw new Error(`Não foi possível conectar ao banco de dados para conta ${accountId}`);
    }
    
    // Atualizar dados de alavancagem
    try {
      await updateLeverageBracketsInDatabase('binance', accountId);
      console.log('[MONITOR] Atualização de brackets de alavancagem concluída com sucesso.');
    } catch (bracketError) {
      console.error('[MONITOR] Erro ao atualizar brackets de alavancagem:', bracketError);
    }
    
    // Verificar e corrigir inconsistências de ambiente
    try {
      await verifyAndFixEnvironmentConsistency(accountId);
    } catch (envError) {
      console.error('[MONITOR] Erro ao verificar consistência de ambiente:', envError);
    }

    // Inicializar o bot do Telegram para esta conta
    const bot = await initializeTelegramBot(accountId);
    
    if (!bot) {
      console.log(`[MONITOR] Bot do Telegram não inicializado para conta ${accountId}`);
    } else {
      console.log(`[MONITOR] Bot do Telegram inicializado para conta ${accountId}`);
    }
    
    // Inicializar os handlers no websocketApi
    try {
      console.log('[WS-API] Inicializando handlers para WebSocket API...');
      await websocketApi.initializeHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers inicializados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[WS-API] Erro ao inicializar WebSocket API handlers:`, wsError);
    }
    
    // Configurar handlers com os callbacks adaptados para accountId
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

    // Executar verificação imediata de sinais pendentes
    console.log('[MONITOR] Agendando verificação imediata de sinais pendentes...');
    setTimeout(() => {
      forceProcessPendingSignals(accountId);
    }, 5000);

    // Agendar jobs específicos para esta conta
    console.log('[MONITOR] Iniciando agendamento de jobs...');
    const accountJobs = {};
    
    // Agendar verificação periódica de sinais a cada 15 segundos
    console.log(`[MONITOR] Agendando verificação periódica de sinais a cada 15 segundos`);
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      try {
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro na verificação periódica de sinais:`, error);
      }
    });
    
    // Iniciar monitoramento de preços para posições abertas
    console.log('[MONITOR] Iniciando monitoramento de preços...');
    await startPriceMonitoring(accountId);
    console.log('[MONITOR] Monitoramento de preços iniciado com sucesso.');

    // Sincronizar posições com a corretora
    try {
      console.log('[MONITOR] Iniciando sincronização de posições...');
      await syncPositionsWithExchange(accountId);
      console.log('[MONITOR] Sincronização de posições concluída com sucesso.');
    } catch (syncError) {
      console.error('[MONITOR] Erro na sincronização de posições:', syncError);
    }

    // Log inicial de posições e ordens
    await logOpenPositionsAndOrders(accountId);

    console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
    
    return accountJobs;
  } catch (error) {
    console.error(`[MONITOR] Erro na configuração inicial para conta ${accountId}: ${error.message}`);
    throw error;
  }
}

// Verifica se está sendo executado como script principal
const accountId = process.argv.includes('--account') 
  ? parseInt(process.argv[process.argv.indexOf('--account') + 1]) || 1 
  : 1;

console.log(`[MONITOR] Iniciando sistema de monitoramento para conta ID: ${accountId}`);

// Auto-inicialização quando executado diretamente
if (require.main === module) {
  (async () => {
    try {
      console.log('[MONITOR] Iniciando sistema de monitoramento...');
      await initializeMonitoring(accountId);
    } catch (error) {
      console.error('[MONITOR] Erro crítico na inicialização:', error);
      process.exit(1);
    }
  })();
}

module.exports = {
  initializeMonitoring,
  checkNewTrades: (accountId) => checkNewTrades(accountId),
  forceProcessPendingSignals: (accountId) => forceProcessPendingSignals(accountId)
};