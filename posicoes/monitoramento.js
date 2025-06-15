const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { setupEd25519FromPEM } = require('../websockets');

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
      console.error('[MONITOR] Erro ao atualizar brackets de alavancagem, mas continuando inicialização:', bracketError.message);
    }
    
    // Verificar e corrigir inconsistências de ambiente
    try {
      await verifyAndFixEnvironmentConsistency(accountId);
      console.log('[MONITOR] Verificação de consistência de ambiente concluída.');
    } catch (envError) {
      console.error('[MONITOR] Erro ao verificar consistência de ambiente, mas continuando:', envError.message);
    }

    // Inicializar o bot do Telegram para esta conta
    /*
    let bot = null;
    try {
      bot = await initializeTelegramBot(accountId);
      if (!bot) {
        console.log(`[MONITOR] Bot do Telegram não inicializado para conta ${accountId}`);
      } else {
        console.log(`[MONITOR] Bot do Telegram inicializado para conta ${accountId}`);
      }
    } catch (telegramError) {
      console.error('[MONITOR] Erro ao inicializar bot do Telegram, mas continuando:', telegramError.message);
    }
      */
    
    await setupEd25519FromPEM(1);
    // CORREÇÃO: Comentar WebSocket API temporariamente devido ao erro Ed25519
    try {
      console.log('[WS-API] Inicializando handlers para WebSocket API...');
      await websocketApi.initializeHandlers(accountId);
      console.log(`[MONITOR] WebSocket API handlers inicializados para conta ${accountId}`);
    } catch (wsError) {
      console.error(`[MONITOR] Erro ao inicializar WebSocket API handlers, continuando com REST API fallback: ${wsError.message}`);
      
      // Se o erro for de chave Ed25519, oferecer solução
      if (wsError.message.includes('Ed25519') || wsError.message.includes('private key')) {
        console.log('\n🔧 SOLUÇÃO: Execute o comando abaixo para configurar a chave Ed25519:');
        console.log('node utils/configurarChavePEMAutomatico.js');
        console.log('');
      }
    }
    
    // Configurar handlers com os callbacks adaptados para accountId
    handlers = {
      handleOrderUpdate: async (msg, db) => {
        try {
          await handleOrderUpdate(msg, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] Erro em handleOrderUpdate:`, error);
        }
      },
      handleAccountUpdate: async (msg, db) => {
        try {
          await handleAccountUpdate(msg, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] Erro em handleAccountUpdate:`, error);
        }
      },
      onPriceUpdate: async (symbol, price, db) => {
        try {
          await onPriceUpdate(symbol, price, db, accountId);
        } catch (error) {
          console.error(`[MONITOR] Erro em onPriceUpdate para ${symbol}:`, error);
        }
      },
      getDbConnection: async () => await getDatabaseInstance(accountId)
    };
    
    // Usar os handlers configurados nos websockets
    try {
      websockets.setMonitoringCallbacks(handlers);
      console.log('[MONITOR] Callbacks do WebSocket configurados com sucesso.');
    } catch (callbackError) {
      console.error('[MONITOR] Erro ao configurar callbacks do WebSocket:', callbackError.message);
    }
    
    // Iniciar userDataStream para esta conta
    try {
      await websockets.startUserDataStream(db, accountId);
      console.log(`[MONITOR] UserDataStream iniciado para conta ${accountId}`);
    } catch (userDataError) {
      console.error(`[MONITOR] Erro ao iniciar UserDataStream, mas continuando: ${userDataError.message}`);
    }

    // IMPORTANTE: Limpar sinais com erro antes de verificar pendentes
    try {
      console.log('[MONITOR] Limpando sinais com erro...');
      await db.query(`
        UPDATE webhook_signals 
        SET status = 'ERROR', 
            error_message = CONCAT(IFNULL(error_message, ''), ' | Limpo durante inicialização') 
        WHERE status = 'PENDING' 
          AND error_message LIKE '%not defined%'
          AND conta_id = ?
      `, [accountId]);
      console.log('[MONITOR] Sinais com erro limpos.');
    } catch (cleanError) {
      console.error('[MONITOR] Erro ao limpar sinais com erro:', cleanError.message);
    }

    // CORREÇÃO: Resetar sinais em PROCESSANDO para PENDING
    try {
      console.log('[MONITOR] Resetando sinais em processamento...');
      const [resetResult] = await db.query(`
        UPDATE webhook_signals 
        SET status = 'PENDING', 
            error_message = NULL,
            updated_at = NOW()
        WHERE status = 'PROCESSANDO' 
          AND conta_id = ?
      `, [accountId]);
      
      if (resetResult.affectedRows > 0) {
        console.log(`[MONITOR] ${resetResult.affectedRows} sinais resetados de PROCESSANDO para PENDING`);
      }
    } catch (resetError) {
      console.error('[MONITOR] Erro ao resetar sinais em processamento:', resetError.message);
    }

    // Verificar sinais pendentes ao iniciar
    try {
      const [pendingSignals] = await db.query(`
        SELECT id, symbol, side, entry_price, status, error_message
        FROM webhook_signals 
        WHERE status IN ('PENDING', 'AGUARDANDO_ACIONAMENTO')
        AND (conta_id = ? OR conta_id IS NULL)
        AND (error_message IS NULL OR error_message NOT LIKE '%not defined%')
      `, [accountId]);

      console.log(`[MONITOR] Ao iniciar, encontrados ${pendingSignals.length} sinais pendentes válidos para conta ${accountId}:`);
      pendingSignals.forEach(signal => {
        console.log(`  - ID: ${signal.id}, Symbol: ${signal.symbol}, Side: ${signal.side}, Entry: ${signal.entry_price}, Status: ${signal.status}`);
      });
    } catch (signalCheckError) {
      console.error('[MONITOR] Erro ao verificar sinais pendentes:', signalCheckError.message);
    }

    // Iniciar monitoramento de preços para posições abertas
    try {
      console.log('[MONITOR] Iniciando monitoramento de preços...');
      const symbolsCount = await startPriceMonitoring(accountId);
      console.log(`[MONITOR] Monitoramento de preços iniciado para ${symbolsCount} símbolos.`);
    } catch (priceError) {
      console.error('[MONITOR] Erro ao iniciar monitoramento de preços, mas continuando:', priceError.message);
    }

    // Sincronizar posições com a corretora
    try {
      console.log('[MONITOR] Iniciando sincronização de posições...');
      await syncPositionsWithExchange(accountId);
      console.log('[MONITOR] Sincronização de posições concluída com sucesso.');
    } catch (syncError) {
      console.error('[MONITOR] Erro ao sincronizar posições, mas continuando:', syncError.message);
    }

    // Log inicial de posições e ordens
    try {
      await logOpenPositionsAndOrders(accountId);
    } catch (logError) {
      console.error('[MONITOR] Erro ao fazer log de posições:', logError.message);
    }

    // CORREÇÃO PRINCIPAL: Agendar jobs de verificação periódica
    console.log('[MONITOR] Iniciando agendamento de jobs...');
    const accountJobs = {};
    
    // Job principal: verificar sinais pendentes a cada 15 segundos
    console.log(`[MONITOR] Agendando verificação de sinais a cada 15 segundos para conta ${accountId}`);
    accountJobs.checkNewTrades = schedule.scheduleJob('*/15 * * * * *', async () => {
      try {
        console.log(`[MONITOR] Executando verificação periódica de sinais para conta ${accountId}...`);
        await checkNewTrades(accountId);
      } catch (error) {
        console.error(`[MONITOR] Erro na verificação periódica de sinais para conta ${accountId}:`, error);
      }
    });
    
    // Job secundário: forçar processamento de sinais pendentes a cada 60 segundos
     
    //console.log(`[MONITOR] Agendando verificação forçada de sinais a cada 60 segundos para conta ${accountId}`);
    //accountJobs.forceProcessPending = schedule.scheduleJob('0 */1 * * * *', async () => {
    //  try {
    //    console.log(`[MONITOR] Executando verificação forçada de sinais pendentes para conta ${accountId}...`);
    //    await forceProcessPendingSignals(accountId);
    //  } catch (error) {
    //    console.error(`[MONITOR] Erro na verificação forçada de sinais para conta ${accountId}:`, error);
    //  }
    //});


    // EXECUTAR VERIFICAÇÃO FORÇADA após 10 segundos se a primeira não processar
    setTimeout(async () => {
      try {
        console.log('[MONITOR] === EXECUTANDO VERIFICAÇÃO FORÇADA ===');
        await forceProcessPendingSignals(accountId);
        console.log('[MONITOR] === VERIFICAÇÃO FORÇADA CONCLUÍDA ===');
      } catch (error) {
        console.error('[MONITOR] Erro na verificação forçada:', error);
      }
    }, 10000);

    console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
    console.log(`[MONITOR] Jobs agendados: ${Object.keys(accountJobs).length}`);
    
    // Armazenar jobs para possível cancelamento futuro
    scheduledJobs[accountId] = accountJobs;
    
    return accountJobs;
  } catch (error) {
    console.error(`[MONITOR] Erro CRÍTICO na configuração inicial para conta ${accountId}: ${error.message}`);
    console.error('[MONITOR] Stack trace:', error.stack);
    
    // Mesmo com erro crítico, tentar continuar com funcionalidades básicas
    console.log('[MONITOR] Tentando continuar com funcionalidades básicas...');
    
    try {
      const db = await getDatabaseInstance(accountId);
      if (db) {
        // Pelo menos tentar agendar verificação de sinais
        const basicJobs = {};
        basicJobs.checkNewTrades = schedule.scheduleJob('*/30 * * * * *', async () => {
          try {
            console.log(`[MONITOR] Verificação básica de sinais para conta ${accountId}...`);
            await checkNewTrades(accountId);
          } catch (jobError) {
            console.error(`[MONITOR] Erro na verificação básica de sinais:`, jobError);
          }
        });
        
        console.log('[MONITOR] Modo de recuperação ativado - apenas verificação básica de sinais.');
        return basicJobs;
      }
    } catch (recoveryError) {
      console.error('[MONITOR] Falha total na inicialização:', recoveryError.message);
    }
    
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
      //console.log('[MONITOR] Iniciando sistema de monitoramento...');
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