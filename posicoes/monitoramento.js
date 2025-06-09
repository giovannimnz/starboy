const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const schedule = require('node-schedule');
const fs = require('fs').promises;
const { Telegraf } = require("telegraf");
const { newEntryOrder, getRecentOrders, editOrder, roundPriceToTickSize, newLimitMakerOrder, newReduceOnlyOrder, cancelOrder, newStopOrder, cancelAllOpenOrders, getAllLeverageBrackets, getFuturesAccountBalanceDetails, getPrecision, changeInitialLeverage, changeMarginType, getPositionDetails, setPositionMode, getOpenOrders, getOrderStatus, getAllOpenPositions, updateLeverageBracketsInDatabase, cancelPendingEntry, getTickSize } = require('../api');
const {getDatabaseInstance, getPositionIdBySymbol, updatePositionInDb, updatePositionStatus, insertNewOrder, disconnectDatabase, getAllPositionsFromDb, getOpenOrdersFromDb, getOrdersFromDb, updateOrderStatus, getPositionsFromDb, insertPosition, moveClosedPositionsAndOrders, formatDateForMySQL, getBaseCalculoBalance, updateAccountBalance} = require('../db/conexao');
const websockets = require('../websockets');

// Adicione este conjunto no topo do arquivo para rastrear ordens já canceladas
const cancelledOrders = new Set();
const processingSignals = new Set();
const websocketEmptyCheckCounter = {};
const lastLoggedWebsocketStates = {};
const lastTrailingCheck = {}; // Para controlar quando foi a última verificação por posição
const positionsWithoutSL = new Set(); // Conjunto para armazenar IDs de posições sem SL
const MIN_CHECK_INTERVAL = 10000; // 10 segundos entre verificações para a mesma posição
const TWO_MINUTES_RECHECK_NO_SL = 2 * 60 * 1000; // 2 minutos para rechecar posições marcadas como sem SL

// Inicializar o bot do Telegram
const bot = new Telegraf(process.env.BOT_TOKEN);

// Adicionar variável para armazenar os jobs
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

// Função para inicializar o monitoramento
async function initializeMonitoring() {
  //console.log('[MONITOR] Inicializando sistema de monitoramento...');

  // Sincronizar saldo da conta - ADICIONADO
  try {
    //console.log('[MONITOR] Sincronizando saldo da conta com a corretora...');
    const result = await syncAccountBalance();
    if (result) {
      console.log(`\n[MONITOR] Saldo: ${result.saldo.toFixed(2)} USDT | Saldo Base Calculo: ${result.saldo_base_calculo.toFixed(2)} USDT\n`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao sincronizar saldo da conta:', error);
  }

  // Configurar callbacks para WebSockets
  websockets.setMonitoringCallbacks({
    handleOrderUpdate,
    handleAccountUpdate,
    onPriceUpdate,
    getDbConnection: getDatabaseInstance
  });

  // Iniciar WebSocket para dados do usuário
  await websockets.startUserDataStream(getDatabaseInstance);

  // Sincronizar saldo da conta logo após conexão
  try {
    //console.log('[MONITOR] Sincronizando saldo inicial...');
    const result = await syncAccountBalance();
    if (result) {
      //console.log(`\n[MONITOR] Saldo inicial: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT\n`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao sincronizar saldo inicial:', error);
  }

  // Agendar verificação periódica de novas operações
  scheduledJobs.checkNewTrades = schedule.scheduleJob('*/3 * * * * *', async () => {
    try {
      await checkNewTrades();
    } catch (error) {
      console.error('[MONITOR] Erro ao verificar novas operações:', error);
    }
  });

  // Adicionar job de sincronização a cada 1 minuto
  // scheduledJobs.syncWithExchange = schedule.scheduleJob('*/1 * * * *', async () => {
  //   try {
  //     await syncWithExchange();
  //   } catch (error) {
  //     console.error('[MONITOR] Erro na sincronização periódica:', error);
  //   }
  // });

  // NOVO JOB: Atualização diária dos dados de alavancagem às 2:00 da manhã
  scheduledJobs.updateLeverageBrackets = schedule.scheduleJob('0 2 * * *', async () => {
    try {
      console.log('[MONITOR] Iniciando atualização diária dos dados de alavancagem...');
      const recordsUpdated = await updateLeverageBracketsInDatabase(true); // true = forçar atualização
      console.log(`[MONITOR] Atualização diária concluída. ${recordsUpdated} registros de alavancagem atualizados.`);
    } catch (error) {
      console.error('[MONITOR] Erro na atualização diária de dados de alavancagem:', error);
    }
  });

  // Adicionar job para verificar ordens expiradas a cada 5 minutos
  scheduledJobs.checkExpiredOrders = schedule.scheduleJob('*/5 * * * *', async () => {
    try {
      await checkExpiredOrders();
    } catch (error) {
      console.error('[MONITOR] Erro ao verificar ordens expiradas:', error);
    }
  });

  // Sincronizar saldo a cada hora
  scheduledJobs.syncAccountBalance = schedule.scheduleJob('0 * * * *', async () => {
    try {
      //console.log('[MONITOR] Sincronizando saldo (job periódico)...');
      await syncAccountBalance();
    } catch (error) {
      console.error('[MONITOR] Erro na sincronização periódica de saldo:', error);
    }
  });

  scheduledJobs.syncPositionsWithExchange = schedule.scheduleJob('*/30 * * * * *', async () => {
    try {
      //console.log('[MONITOR] Sincronizando posições com a corretora (job periódico)...'); // Adicionado log para identificar a chamada do job
      await syncPositionsWithExchange();
    } catch (error) {
      // O erro já é logado dentro de syncPositionsWithExchange ou no catch mais específico dele
      // Mas podemos adicionar um log genérico aqui se desejado, ou apenas deixar que a função interna lide com o log.
      console.error('[MONITOR] Erro geral no job de sincronizar posições:', error);
    }
  });

  // Iniciar monitoramento de preços para posições abertas
  try {
    await startPriceMonitoring();
  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
  }

  scheduledJobs.checkWebsocketsForOpenPositions = schedule.scheduleJob('*/1 * * * *', async () => {
  try {
    //console.log('[MONITOR] Verificando websockets para posições abertas...');
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Obter todos os símbolos com posições abertas ou ordens pendentes
    const [symbols] = await db.query(`
      SELECT simbolo FROM posicoes WHERE status = 'OPEN'
      UNION
      SELECT simbolo FROM ordens WHERE status IN ('NEW', 'PARTIALLY_FILLED')
      UNION
      SELECT symbol FROM webhook_signals WHERE status = 'AGUARDANDO_ACIONAMENTO'
    `);

    if (symbols.length > 0) {
      console.log(`[MONITOR] Encontrados ${symbols.length} símbolos com atividade que requerem websocket`);
      
      for (const row of symbols) {
        const symbol = row.simbolo || row.symbol;
        if (!symbol) continue;
        
        // Verificar se o websocket está ativo e reabrir se necessário
        if (!websockets.priceWebsockets[symbol] || 
            (websockets.priceWebsockets[symbol] && websockets.priceWebsockets[symbol].readyState !== 1)) {
          //console.log(`[MONITOR] Reabrindo websocket para ${symbol} (posição/ordem ativa)`);
          websockets.ensurePriceWebsocketExists(symbol);
        }
      }
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar websockets para posições abertas:', error);
  }
});

  //console.log('[MONITOR] Sistema de monitoramento inicializado com sucesso!');
}

// ***** INÍCIO DA IMPLEMENTAÇÃO SOLICITADA *****
// Nova função para sincronizar posições:
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
  } catch (error) {
    console.error(`[SYNC] Erro crítico ao sincronizar posições com a corretora: ${error.message}`, error.stack || error);
  }
}

// Função para iniciar monitoramento de preços para posições abertas
async function startPriceMonitoring() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Obter posições abertas ou com ordens de entrada pendentes
    const [pendingEntries] = await db.query(`
      SELECT o.simbolo
      FROM ordens o
      WHERE o.tipo_ordem_bot = 'ENTRADA' AND o.status = 'OPEN'
      GROUP BY o.simbolo
    `);

    const [openPositions] = await db.query(`
      SELECT simbolo
      FROM posicoes
      WHERE status = 'OPEN'
    `);

    // NOVO: Obter sinais em AGUARDANDO_ACIONAMENTO
    const [pendingSignals] = await db.query(`
      SELECT symbol, timeframe, created_at, timeout_at, max_lifetime_minutes
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO'
    `);

    //console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para monitoramento`);

    const symbols = new Set();

    // Adicionar símbolos com ordens pendentes
    pendingEntries.forEach(entry => symbols.add(entry.simbolo));

    // Adicionar símbolos com posições abertas
    openPositions.forEach(position => symbols.add(position.simbolo));

    // NOVO: Adicionar símbolos com sinais pendentes
    pendingSignals.forEach(signal => symbols.add(signal.symbol));

    // Iniciar websockets para cada símbolo
    for (const symbol of symbols) {
      //console.log(`[MONITOR] Iniciando monitoramento de preço para ${symbol}`);
      websockets.ensurePriceWebsocketExists(symbol);
    }

    // NOVO: Verificar sinais expirados durante o período offline
    if (pendingSignals.length > 0) {
      console.log(`[MONITOR] Verificando se há sinais expirados durante período offline...`);
      const now = new Date();
      
      for (const signal of pendingSignals) {
        // Verificar timeout usando campo timeout_at direto
        if (signal.timeout_at && new Date(signal.timeout_at) < now) {
          console.log(`[MONITOR] Sinal expirado para ${signal.symbol} (timeframe: ${signal.timeframe})`);
          await db.query(`
            UPDATE webhook_signals 
            SET status = 'CANCELED', 
                error_message = ? 
            WHERE symbol = ? AND status = 'AGUARDANDO_ACIONAMENTO'`,
            [`Sinal expirado durante período offline (timeout: ${signal.max_lifetime_minutes} min)`, signal.symbol]
          );
        } else {
          // Obter preço atual para verificar se o SL foi atingido durante o período offline
          try {
            const price = await getCurrentPrice(signal.symbol);
            if (price) {
              // Acionar callback onPriceUpdate para verificar condições
              await onPriceUpdate(signal.symbol, price, db);
            }
          } catch (priceError) {
            console.error(`[MONITOR] Erro ao obter preço atual para ${signal.symbol}:`, priceError);
          }
        }
      }
    }

  } catch (error) {
    console.error('[MONITOR] Erro ao iniciar monitoramento de preços:', error);
  }
}

// Função auxiliar para obter preço atual via API
async function getCurrentPrice(symbol) {
  try {
    const response = await axios.get(`${process.env.API_URL}/v1/ticker/price?symbol=${symbol}`);
    if (response.data && response.data.price) {
      return parseFloat(response.data.price);
    }
    return null;
  } catch (error) {
    console.error(`[MONITOR] Erro ao obter preço atual para ${symbol}:`, error);
    return null;
  }
}

// Função para verificar novas operações e criar ordens
async function checkNewTrades() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // Verificar apenas sinais PENDING na tabela webhook_signals
    const [pendingSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'PENDING'
      ORDER BY created_at ASC
    `);

    //console.log(`[MONITOR] Encontrados ${pendingSignals.length} sinais pendentes para processar`);

    for (const signal of pendingSignals) {
      // Atualizar status para PROCESSANDO antes de processar para evitar duplicação
      await db.query(
          'UPDATE webhook_signals SET status = "PROCESSANDO" WHERE id = ?',
          [signal.id]
      );

      // Processar o sinal
      await processSignal(db, signal);
    }

    // NOVO: Verificar sinais CANCELED que ainda não tiveram mensagem enviada
    const [canceledSignals] = await db.query(`
      SELECT * FROM webhook_signals
      WHERE status = 'CANCELED' 
      AND (sent_msg = 0 OR sent_msg IS NULL)
      ORDER BY created_at ASC
    `);

    //console.log(`[MONITOR] Encontrados ${canceledSignals.length} sinais cancelados pendentes de notificação`);

for (const signal of canceledSignals) {
  try {
    // Verificar se temos chat_id e message_id para enviar a notificação
    if (signal.chat_id && bot) {
      const errorMessage = signal.error_message || 'Motivo não especificado';
      
      // Extrair o message_id da mesma forma que em processSignal
      const originalMessageId = signal.message_id; // Extrair message_id como é feito em processSignal
      
      let telegramOptions = {};
      
      // Verificar se temos um ID de mensagem original para responder
      if (originalMessageId) {
        telegramOptions = { reply_to_message_id: originalMessageId };
      } else if (signal.message_id_orig) {
        telegramOptions = { reply_to_message_id: signal.message_id_orig };
      } else if (signal.registry_message_id) {
        telegramOptions = { reply_to_message_id: signal.registry_message_id };
      }
      
      // Extrair preço do motivo se existir para formatar corretamente
      let formattedReason = errorMessage;
      if (errorMessage && errorMessage.includes('\nPreço:')) {
        // Extrair valores numéricos para formatação
        formattedReason = errorMessage.replace(/(\d+\.\d+)/g, match => {
          return formatDecimal(parseFloat(match), 4);
        });
      }
      
      try {
        // Tenta enviar a mensagem como resposta primeiro
        await bot.telegram.sendMessage(
          signal.chat_id,
          `⚠️ Sinal para ${signal.symbol} Cancelado ⚠️\n(ID: ${signal.id})\n\nMotivo: ${formattedReason}`,
          telegramOptions
        );
        console.log(`[MONITOR] Notificação de cancelamento enviada para Sinal ID ${signal.id}`);
      } catch (replyError) {
        // Se falhar com erro de mensagem não encontrada, envia sem resposta
        if (replyError.message.includes('message to be replied not found')) {
          //console.log(`[MONITOR] Mensagem original não encontrada para sinal ${signal.id}. Enviando sem resposta.`);
          await bot.telegram.sendMessage(
            signal.chat_id,
            `⚠️ Sinal para ${signal.symbol} Cancelado ⚠️\n(ID: ${signal.id})\n\nMotivo: ${formattedReason}`
          );
        } else {
          // Se for outro tipo de erro, relança
          throw replyError;
        }
      }
    } else {
      console.log(`[MONITOR] Não foi possível enviar notificação para sinal ${signal.id}: ${!signal.chat_id ? 'chat_id não disponível' : 'bot não inicializado'}`);
    }
    
    // Marcar como notificado
    await db.query(
      'UPDATE webhook_signals SET sent_msg = 1 WHERE id = ?',
      [signal.id]
    );
  } catch (notifyError) {
    console.error(`[MONITOR] Erro ao notificar cancelamento do sinal ${signal.id}:`, notifyError.message);
  }
}

  } catch (error) {
    console.error('[MONITOR] Erro ao verificar novas operações:', error);
  }
}

// Função para processar um sinal recebido via webhook
async function processSignal(db, signal) {
  const connection = await db.getConnection(); // Get a connection from the pool

  try {
    await connection.beginTransaction(); // Start a transaction

    const {
      id, symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, timeframe,
      message_id: originalMessageId // <<< Extract originalMessageId from signal
    } = signal;

    console.log(`[MONITOR] Processando sinal ID ${id} para ${symbol}: ${side} a ${entry_price}`);

    const positionExists = await checkPositionExists(connection, symbol);
    if (positionExists) {
      console.log(`[MONITOR] Já existe uma posição aberta para ${symbol}. Ignorando sinal ID ${id}.`);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = 'Posição já existe para o símbolo' WHERE id = ?`,
          [id]
      );
      await connection.commit();
      return;
    }

    // 2. Configurar alavancagem e tipo de margem
    try {
      await changeInitialLeverage(symbol, parseInt(leverage));
      try {
        await changeMarginType(symbol, 'CROSSED'); // Or 'ISOLATED' as per your strategy
      } catch (marginError) {
        if (marginError.response && marginError.response.data && marginError.response.data.code === -4046) { // -4046: "No need to change margin type"
          console.log(`[MONITOR] Margem para ${symbol} já está como CROSSED (ou o tipo desejado), continuando...`);
        } else {
          throw marginError; // Re-throw other margin errors
        }
      }
    } catch (configError) {
      console.error(`[MONITOR] Erro ao configurar alavancagem/margem para ${symbol} (Sinal ID ${id}):`, configError.message);
      let errorMessage = `Erro config.: ${configError.message}`;
      if (configError.response && configError.response.data && configError.response.data.msg) {
        errorMessage = `Erro config. API: ${configError.response.data.msg}`;
      }
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [errorMessage, id]
      );
      await connection.commit();
      return;
    }

    // 3. Atualizar webhook_signals para 'AGUARDANDO_ACIONAMENTO' (inicialmente)
    await connection.query(
        `UPDATE webhook_signals SET
            status = 'AGUARDANDO_ACIONAMENTO'
         WHERE id = ?`,
        [id]
    );

    // 4. Iniciar monitoramento de preço para este símbolo (se não estiver ativo)
    websockets.ensurePriceWebsocketExists(symbol);

if (chat_id) {
    try {
        let telegramOptions = {};
        
        // Verificar se temos um ID de mensagem original para responder
        if (originalMessageId) {
            try {
                // Verificar se a mensagem original existe antes de tentar responder
                // Usar uma abordagem mais segura sem tentar verificar a mensagem diretamente
                telegramOptions = { reply_to_message_id: originalMessageId };
            } catch (telegramCheckError) {
                console.log(`[MONITOR] Aviso: Erro ao verificar mensagem original ID ${originalMessageId}. Enviando sem resposta.`);
                // Continue sem reply_to_message_id
            }
        }
        
        const triggerCondition = side.toUpperCase() === 'COMPRA' || side.toUpperCase() === 'BUY'
            ? `Acima de ${formatDecimal(entry_price)}`
            : `Abaixo de ${formatDecimal(entry_price)}`;
        
        // Enviar a mensagem sem try-catch específico para este envio
        // Se houver erro, ele será capturado pelo try-catch externo
        const sentMessage = await bot.telegram.sendMessage(chat_id,
            `🔄 Sinal Registrado para ${symbol}\n\n` +
            `🆔 Sinal Ref: WEBHOOK_${id}\n` +
            `Direção: ${side.charAt(0).toUpperCase() + side.slice(1).toLowerCase()}\n` +
            `Alavancagem: ${leverage}x\n\n` +
            `Entrada: ${triggerCondition}\n` +
            `TP: ${formatDecimal(tp_price)}\n` +
            `SL: ${formatDecimal(sl_price)}\n\n` +
            `Aguardando gatilho de preço...`,
            telegramOptions
        );
        
        // Salvar o ID da mensagem de confirmação
        if (sentMessage && sentMessage.message_id) {
            await connection.query(
                `UPDATE webhook_signals SET registry_message_id = ? WHERE id = ?`,
                [sentMessage.message_id, id]
            );
            console.log(`[MONITOR] Mensagem de confirmação (${sentMessage.message_id}) enviada e ID salvo para sinal ${id}.`);
        }
    } catch (telegramError) {
        // Simplificar mensagem de erro e continuar o processamento
        console.error(`[MONITOR] Erro ao enviar mensagem Telegram para sinal ID ${id}: ${telegramError.message}`);
        // Não reexibir o objeto de erro completo para evitar poluição do log
    }
}

    // 6. Calcular e registrar o tempo de timeout e atualizar o sinal novamente
    let timeoutAt = null;
    let maxLifetimeMinutes = null;

    if (timeframe) {
        const timeframeMs = timeframeToMs(timeframe); // Garanta que timeframeToMs está definida
        if (timeframeMs > 0) {
            const maxLifetimeMs = timeframeMs * 3; // Exemplo: timeout é 3x o timeframe do sinal
            const now = new Date();
            timeoutAt = new Date(now.getTime() + maxLifetimeMs);
            maxLifetimeMinutes = Math.floor(maxLifetimeMs / (60 * 1000));
            
            console.log(`[MONITOR] Timeout para sinal ID ${id} (${symbol}) definido para: ${timeoutAt.toISOString()} (${maxLifetimeMinutes} min)`);
        } else {
            console.log(`[MONITOR] Timeframe inválido ou zero para sinal ID ${id} (${symbol}). Timeout não será definido.`);
        }
    } else {
        console.log(`[MONITOR] Timeframe não fornecido para sinal ID ${id} (${symbol}). Timeout não será definido.`);
    }

    await connection.query(
        `UPDATE webhook_signals SET
            status = 'AGUARDANDO_ACIONAMENTO', 
            timeout_at = ?,
            max_lifetime_minutes = ?
         WHERE id = ?`,
        [timeoutAt, maxLifetimeMinutes, id]
    );

    await connection.commit(); // Comita a transação
    console.log(`[MONITOR] Sinal ID ${id} para ${symbol} registrado com sucesso. Status: AGUARDANDO_ACIONAMENTO.`);

  } catch (error) {
    console.error(`[MONITOR] Erro crítico ao processar sinal ID ${signal.id || 'N/A'} para ${signal.symbol || 'N/A'}:`, error);
    if (connection) { // Garante que connection existe antes de tentar rollback
        try {
            await connection.rollback(); // Reverte a transação em caso de erro
            console.log(`[MONITOR] Rollback efetuado para sinal ID ${signal.id || 'N/A'}.`);
        } catch (rollbackError) {
            console.error(`[MONITOR] Erro crítico ao tentar fazer rollback para sinal ID ${signal.id || 'N/A'}:`, rollbackError);
        }
    }

  } finally {
    if (connection) { // Garante que connection existe antes de tentar release
        connection.release(); // Libera a conexão de volta para o pool
    }
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
async function checkPositionExists(db, symbol) {
  try {
    const [rows] = await db.query(
        "SELECT id FROM posicoes WHERE simbolo = ? AND (status = 'OPEN' OR status = 'PENDING')",
        [symbol]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

// Substitua a função handleOrderUpdate existente
async function handleOrderUpdate(orderMsg, db) {
  try {
    //console.log(`[ORDER UPDATE] Symbol: ${orderMsg.s}, OrderID: ${orderMsg.i}, Status: ${orderMsg.X}, ExecutionType: ${orderMsg.x}, Price: ${orderMsg.p}, AvgPrice: ${orderMsg.ap}, Qty: ${orderMsg.q}, OrderType: ${orderMsg.o}`);

    // Buscar a ordem no banco de dados
    const [orders] = await db.query(
      'SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ?',
      [orderMsg.i, orderMsg.s]
    );

    // --- INÍCIO DA MELHORIA/CORREÇÃO ---
    // Se a ordem não for encontrada no banco mas está na corretora como FILLED ou PARTIALLY_FILLED,
    // verificar se temos a posição relacionada e registrar esta ordem.
    if (orders.length === 0 && (orderMsg.X === 'FILLED' || orderMsg.X === 'PARTIALLY_FILLED')) {
      //console.log(`[MONITOR] Detectada ordem executada (Status: ${orderMsg.X}) na corretora que não existe no banco. OrderID: ${orderMsg.i}, Symbol: ${orderMsg.s}`);
      
      // Verificar se temos uma posição aberta para este símbolo
      // Idealmente, se for uma ordem de fechamento (TP/SL), ela deveria ter uma posição.
      // Se for uma ordem de entrada "fantasma", não haveria posição aberta antes dela.
      // A query busca uma posição que JÁ ESTARIA ABERTA se esta ordem fosse um TP/SL dela.
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
        console.log(`[MONITOR] Nenhuma posição aberta encontrada para ${orderMsg.s}. Ordem "fantasma" ${orderMsg.i} não pôde ser associada e registrada.`);
      }
      
      return; // Finaliza o processamento aqui para ordens "fantasmas"
    }
    // --- FIM DA MELHORIA/CORREÇÃO ---

    // Código existente para ordens encontradas no banco
    if (orders.length === 0) {
      // Esta condição agora só será verdadeira se a ordem não foi encontrada E NÃO era FILLED/PARTIALLY_FILLED
      // ou se era FILLED/PARTIALLY_FILLED mas não tinha posição aberta correspondente.
      console.log(`[MONITOR] Ordem ${orderMsg.i} (Status: ${orderMsg.X}) não encontrada no banco de dados e não tratada como "fantasma" preenchida.`);
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
    console.log('[ACCOUNT UPDATE] Recebido atualização de conta');

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
  } catch (error) {
    console.error('[ACCOUNT UPDATE] Erro ao processar atualização da conta:', error);
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

async function onPriceUpdate(symbol, currentPrice, db) {
  try {
    // 1. Atualizar preços das posições abertas para este símbolo
    await updatePositionPrices(db, symbol, currentPrice);

    // 2. Buscar sinais pendentes para este símbolo
    const [pendingSignalsResult] = await db.query(`
      SELECT 
      id, symbol, timeframe, side, leverage, capital_pct, 
      entry_price, 
      tp_price, sl_price, 
      tp1_price, tp2_price, tp3_price, tp4_price, tp5_price,
      status, error_message, position_id, entry_order_id, 
      tp_order_id, sl_order_id, chat_id, message_id, created_at, 
      updated_at, timeout_at, max_lifetime_minutes, 
      registry_message_id, message_id_orig, message_source
      FROM webhook_signals
      WHERE symbol = ?
        AND status = 'AGUARDANDO_ACIONAMENTO'
    `, [symbol]);
    
    const pendingSignals = pendingSignalsResult || [];
    // Log da nova estrutura:
    //console.log(`[PRICE UPDATE] Encontrados ${pendingSignals.length} sinais pendentes para ${symbol}`);

    // 3. Verificar se há posições abertas ou ordens pendentes
    const [openPositionsResult] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes 
      WHERE simbolo = ? AND status = 'OPEN'
    `, [symbol]);
    
    const [pendingOrdersResult] = await db.query(`
      SELECT COUNT(*) as count FROM ordens
      WHERE simbolo = ? AND status = 'NEW' 
    `, [symbol]); // Presume-se que ordens 'OPEN' são as que justificam manter o WS

    const openPositionsCount = (openPositionsResult && openPositionsResult[0] && openPositionsResult[0].count) || 0;
    const pendingOrdersCount = (pendingOrdersResult && pendingOrdersResult[0] && pendingOrdersResult[0].count) || 0;

    // 4. Verificar se precisamos manter o WebSocket ativo
    if (pendingSignals.length === 0 && openPositionsCount === 0 && pendingOrdersCount === 0) {
      console.log(`[MONITOR] Símbolo ${symbol} sem atividade (sinais=${pendingSignals.length}, posições=${openPositionsCount}, ordens=${pendingOrdersCount}). Tentando fechar WebSocket.`);
      
      // Fechar WebSocket diretamente, sem usar contador
      await checkAndCloseWebsocket(db, symbol);
      
      // Limpar o contador antigo, caso exista, por segurança/higiene.
      if (websocketEmptyCheckCounter && websocketEmptyCheckCounter[symbol]) {
        delete websocketEmptyCheckCounter[symbol];
      }
      // Não é necessário retornar aqui, pois o loop de pendingSignals não executará se pendingSignals.length === 0.
    } else {
      let reasons = [];
      if (pendingSignals.length > 0) {
        reasons.push(`${pendingSignals.length} ${pendingSignals.length === 1 ? 'Sinal pendente' : 'Sinais pendentes'}`);
      }
      if (openPositionsCount > 0) {
        reasons.push(`${openPositionsCount} ${openPositionsCount === 1 ? 'Posição aberta' : 'Posições abertas'}`);
      }
      if (pendingOrdersCount > 0) {
        reasons.push(`${pendingOrdersCount} ${pendingOrdersCount === 1 ? 'Ordem pendente' : 'Ordens pendentes'}`);
      }

      // Criar uma string representando o estado atual
      const currentState = reasons.join('|');
  
      // Verificar se o estado mudou ou se é a primeira vez para este símbolo
      if (!lastLoggedWebsocketStates[symbol] || lastLoggedWebsocketStates[symbol] !== currentState) {
        console.log(`[MONITOR] WebSocket aberto para ${symbol}${reasons.length > 0 ? ' - ' + reasons.join(' - ') : ''}`);
        // Atualizar o estado atual no log
        lastLoggedWebsocketStates[symbol] = currentState;
      }
  
      // Se houver websocketEmptyCheckCounter para este símbolo, remover
      if (websocketEmptyCheckCounter && websocketEmptyCheckCounter[symbol]) {
        console.log(`[MONITOR] Removendo contador antigo websocketEmptyCheckCounter para ${symbol}.`);
        delete websocketEmptyCheckCounter[symbol];
      }
    }

    // 5. Processar sinais pendentes (modificação aqui)
    for (const signal of pendingSignals) {
      const entryPrice = parseFloat(signal.entry_price);
      const slPrice = parseFloat(signal.sl_price);
      const side = signal.side;

      const normalizedSide = side.toUpperCase();
      const isBuy = normalizedSide === 'BUY' || normalizedSide === 'COMPRA';
      const isSell = normalizedSide === 'SELL' || normalizedSide === 'VENDA';

      const shouldTrigger = (isBuy && currentPrice >= entryPrice) ||
                            (isSell && currentPrice <= entryPrice);

      const slHit = (isBuy && currentPrice <= slPrice) ||
                    (isSell && currentPrice >= slPrice);

      const createdAt = new Date(signal.created_at);
      const now = new Date();
      const signalAgeMs = now.getTime() - createdAt.getTime();
      const timeframeMs = timeframeToMs(signal.timeframe); // Precisa estar definida
      const maxLifetimeMs = timeframeMs > 0 ? timeframeMs * 3 : 0;
      const timeoutHit = maxLifetimeMs > 0 && signalAgeMs > maxLifetimeMs;

      const elapsedMin = Math.floor(signalAgeMs / (60 * 1000));
      const maxLifetimeMin = maxLifetimeMs > 0 ? Math.floor(maxLifetimeMs / (60 * 1000)) : 0;
      const timeRemainingMin = timeoutHit || maxLifetimeMs === 0 ? 0 : Math.floor((maxLifetimeMs - signalAgeMs) / (60 * 1000));

      console.log(`[PRICE UPDATE] Sinal ${signal.id} (${symbol}): Preço Atual=${currentPrice}, Entrada=${entryPrice}, SL=${slPrice}. Gatilhos: Trigger=${shouldTrigger}, SLHit=${slHit}, Timeout=${timeoutHit} | Tempo: ${elapsedMin}/${maxLifetimeMin} min`);

      if (shouldTrigger) {
        const signalKey = `${signal.id}_${signal.symbol}`;
        if (processingSignals.has(signalKey)) {
          console.log(`[PRICE UPDATE] Sinal ${signalKey} já está sendo processado, aguardando...`);
          continue;
        }
        processingSignals.add(signalKey);

        try {
          console.log(`[PRICE UPDATE] ACIONANDO entrada LIMIT MAKER para sinal ${signalKey} a ${currentPrice}`);
          
          // MODIFICAÇÃO: Usar executeLimitMakerEntry em vez de executeEntryOrder
          await executeLimitMakerEntry(db, signal, currentPrice);
        } catch (error) {
          console.error(`[PRICE UPDATE] Erro ao executar entrada para ${signalKey}: ${error.message}`);
        } finally {
          setTimeout(() => {
            processingSignals.delete(signalKey);
            console.log(`[PRICE UPDATE] Sinal ${signalKey} removido da lista de processamento`);
          }, 5000);
        }
      } else if (slHit) {
        console.log(`[PRICE UPDATE] ❌ SL ${formatDecimal(slPrice, 4)} atingido antes da entrada para ${signal.id} (${symbol}).`);
        await cancelSignal(db, signal.id, 'SL_BEFORE_ENTRY',
          `Stop loss (${formatDecimal(slPrice, 4)}) atingido antes da entrada(${formatDecimal(currentPrice, 4)})`); // Precisa estar definida
      } else if (timeoutHit) {
        console.log(`[PRICE UPDATE] ⏱️ TIMEOUT para sinal ${signal.id} (${symbol}). Ativo por ${elapsedMin} min (máx: ${maxLifetimeMin} min). Cancelando.`);
        await cancelSignal(db, signal.id, 'TIMEOUT_ENTRY',
          `Entrada não acionada dentro do limite de tempo (${signal.timeframe} * 3 = ${maxLifetimeMin} min)`); // Precisa estar definida
      } else {
        if (maxLifetimeMs > 0) {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando. Tempo restante: ${timeRemainingMin} min (${elapsedMin}/${maxLifetimeMin} min)`);
        } else {
          console.log(`[PRICE UPDATE] ⏳ Sinal ${signal.id} (${symbol}) aguardando (sem timeout definido).`);
        }
      }
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro no processamento para ${symbol}:`, error);
  }
}

// ***** INÍCIO DAS NOVAS FUNÇÕES *****

// Nova função para atualizar preços das posições
async function updatePositionPrices(db, symbol, currentPrice) {
  try {
    // 1. Buscar posições abertas para o símbolo
    const [positions] = await db.query(
      'SELECT * FROM posicoes WHERE simbolo = ? AND status = "OPEN"', // Aspas duplas em "OPEN" para consistência com SQL
      [symbol]
    );

    if (positions.length === 0) {
        // console.log(`[PRICE UPDATE] Nenhuma posição aberta encontrada para ${symbol} para atualizar preços.`);
        return; // Não há posições para atualizar
    }

    // console.log(`[PRICE UPDATE] Encontradas ${positions.length} posições abertas para ${symbol}. Atualizando preços...`);

    // 2. Para cada posição, atualizar o preço corrente
    for (const position of positions) {
      const positionId = position.id;
      
      // Evitar log excessivo se a função for chamada muito frequentemente. Pode ser útil para debug inicial.
      // console.log(`[PRICE UPDATE] Atualizando preço da posição ${positionId} (${symbol}) para ${currentPrice}`);
      
      await db.query(
        `UPDATE posicoes SET 
         preco_corrente = ?, 
         data_hora_ultima_atualizacao = ? 
         WHERE id = ?`, // Removido espaço extra antes de preco_corrente e data_hora_ultima_atualizacao
        [currentPrice, formatDateForMySQL(new Date()), positionId] // Usa o placeholder formatDateForMySQL
      );
      
      // 3. Verificar se há ordens SL/TP ativas que precisam ser monitoradas
      await checkOrderTriggers(db, position, currentPrice);
    }
  } catch (error) {
    console.error(`[PRICE UPDATE] Erro ao atualizar preços das posições para ${symbol}: ${error.message}`, error);
    // Considerar se este erro deve ser propagado para onPriceUpdate ou tratado aqui.
    // Se propagar, onPriceUpdate pode parar o processamento de sinais pendentes.
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

    // 2. VERIFICAR SE JÁ SABEMOS QUE ESTA POSIÇÃO NÃO TEM SL
    if (positionsWithoutSL.has(positionId)) {
      if (lastTrailingCheck[positionId] && (now - lastTrailingCheck[positionId] < TWO_MINUTES_RECHECK_NO_SL)) {
        return; // Ainda não passou tempo suficiente para rechecar posição sem SL
      }
    }
    
    lastTrailingCheck[positionId] = now; // Atualiza o timestamp da última verificação

    // 3. BUSCAR ORDENS ATIVAS PARA ESTA POSIÇÃO (DO NOSSO BANCO DE DADOS)
    const [ordersInDb] = await db.query(
      `SELECT * FROM ordens 
       WHERE id_posicao = ? 
       AND status = "NEW" 
       AND tipo_ordem_bot IN ("STOP_LOSS", "TAKE_PROFIT", "REDUCAO_PARCIAL")`, // Inclui outros tipos se relevante para a lógica geral
      [positionId]
    );

    const slOrdersInDb = ordersInDb.filter(order => order.tipo_ordem_bot === 'STOP_LOSS' && order.status === 'NEW');

    // 4. PROCESSAR CASO DE POSIÇÃO SEM SL ATIVO NO NOSSO DB
    if (slOrdersInDb.length === 0) {
      positionsWithoutSL.add(positionId);
      console.log(`${functionPrefix} Nenhuma ordem SL ativa encontrada no DB para posição ${positionId}. Tentando criar SL automático.`);
      try {
        const [signalInfo] = await db.query(
          `SELECT tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, entry_price, sl_price 
           FROM webhook_signals 
           WHERE position_id = ? 
           ORDER BY created_at DESC LIMIT 1`,
          [positionId]
        );

        if (signalInfo.length === 0) {
          console.log(`${functionPrefix} Sinal não encontrado para posição ${positionId} - impossível criar SL automático.`);
          return;
        }

        const signal = signalInfo[0];
        const slPrice = parseFloat(signal.sl_price);
        const side = position.side.toUpperCase();

        if (isNaN(slPrice) || slPrice <= 0) {
          console.log(`${functionPrefix} Preço de SL (sl_price: ${signal.sl_price}) inválido no sinal para posição ${positionId}.`);
          return;
        }

        const quantity = parseFloat(position.quantidade);
        if (isNaN(quantity) || quantity <= 0) {
          console.log(`${functionPrefix} Quantidade inválida (quantidade: ${position.quantidade}) para posição ${positionId}.`);
          return;
        }

        const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';

        console.log(`${functionPrefix} Preparando para criar nova ordem SL automática para posição ${positionId} no preço ${slPrice}`);
        
        // ANTES de criar o SL automático, cancelar quaisquer SLs que possam existir na corretora e não no nosso DB (sincronização)
        console.log(`${functionPrefix} Verificando e cancelando SLs existentes na corretora ANTES de criar SL automático...`);
        await cancelAllActiveStopLosses(db, position);
        await new Promise(resolve => setTimeout(resolve, 1500)); // Pausa para processamento da corretora

        const slResponse = await newStopOrder(
          position.simbolo, quantity, oppositeSide, slPrice, null, true, true
        );

        if (slResponse && slResponse.data && slResponse.data.orderId) {
          const newOrderId = String(slResponse.data.orderId);
          console.log(`${functionPrefix} Nova ordem SL automática criada: ${newOrderId} a ${slPrice} para posição ${positionId}`);
          const newSLBreakevenPrice = entryPrice;
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET',
            preco: newSLBreakevenPrice,
            quantidade: quantity, // Certifique-se que 'quantity' está definida corretamente
            id_posicao: positionId,
            status: 'NEW', // Ou o status retornado pela API se disponível
            data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: newOrderId,
            side: oppositeSide, // Certifique-se que 'oppositeSide' está definida
            simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS',
            target: null, // SL geralmente não tem target
            reduce_only: true,
            close_position: true, // Geralmente SLs são closePosition
            last_update: formatDateForMySQL(new Date()),
            orign_sig: position.orign_sig, // Certifique-se que 'position.orign_sig' existe
            observacao: 'Trailing Stop - Breakeven' // Adicione se a coluna existir
        });
          await db.query(
            `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = ? WHERE id = ?`,
            [formatDateForMySQL(new Date()), positionId]
          );
          console.log(`${functionPrefix} SL Breakeven (${newOrderId}) criado e posição atualizada para BREAKEVEN.`);
          positionsWithoutSL.delete(positionId);
        } else {
          console.error(`${functionPrefix} Falha ao criar SL de breakeven na corretora. Resposta:`, slResponse);
        }
        return; 
      } catch (error) {
        console.error(`${functionPrefix} Erro crítico ao mover SL para breakeven: ${error.message}`, error.stack);
      }
      return; 
    } else {
      positionsWithoutSL.delete(positionId);
    }

    // 5. CONTINUAR COM A LÓGICA DE TRAILING STOP (SE HOUVER SLs ATIVOS NO NOSSO DB)
    // const currentSLInDb = slOrdersInDb[0]; // Referência ao SL do nosso DB

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

    if (isNaN(tp1Price) || tp1Price <= 0) {
      console.log(`${functionPrefix} TP1 (tp1_price: ${signal.tp1_price}) inválido no sinal para posição ${positionId}.`);
      return;
    }

    const [trailingStateResult] = await db.query(
      `SELECT trailing_stop_level FROM posicoes WHERE id = ?`,
      [positionId]
    );
    
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
    const currentTrailingLevel = trailingStateResult.length > 0 && trailingStateResult[0].trailing_stop_level ? trailingStateResult[0].trailing_stop_level : 'ORIGINAL';

    let priceHitTP1 = false;
    let priceHitTP3 = false;
    if (side === 'BUY' || side === 'COMPRA') {
      priceHitTP1 = currentPrice >= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice >= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    } else if (side === 'SELL' || side === 'VENDA') {
      priceHitTP1 = currentPrice <= tp1Price && currentTrailingLevel === 'ORIGINAL';
      priceHitTP3 = !isNaN(tp3Price) && tp3Price > 0 && currentPrice <= tp3Price && currentTrailingLevel === 'BREAKEVEN';
    }

    // --- INÍCIO DAS MODIFICAÇÕES PARA USAR cancelAllActiveStopLosses ---
    if (priceHitTP1) {
      console.log(`${functionPrefix} Preço (${currentPrice}) atingiu TP1 (${tp1Price}) para Posição ID ${positionId} (${side}). Nível Trailing: ${currentTrailingLevel}. Iniciando SL para Breakeven (${entryPrice}).`);
      
      console.log(`${functionPrefix} Cancelando ordens SL existentes ANTES de mover para breakeven...`);
      await cancelAllActiveStopLosses(db, position); // <--- CHAMADA DA NOVA FUNÇÃO
      
      await new Promise(resolve => setTimeout(resolve, 2500)); // Pausa para processamento da corretora

      try {
        const newSLBreakevenPrice = entryPrice;
        const quantity = parseFloat(position.quantidade);
        const oppositeSide = side === 'BUY' || side === 'COMPRA' ? 'SELL' : 'BUY';
        
        console.log(`${functionPrefix} Criando nova ordem SL (breakeven) para ${position.simbolo} @ ${newSLBreakevenPrice}`);
        const slResponse = await newStopOrder(
          position.simbolo, quantity, oppositeSide, newSLBreakevenPrice, null, true, true
        );
        
        if (slResponse && slResponse.data && slResponse.data.orderId) {
          const newOrderId = String(slResponse.data.orderId);
          console.log(`${functionPrefix} Nova SL (breakeven) criada: ID ${newOrderId} @ ${newSLBreakevenPrice}`);
          const newSLBreakevenPrice = entryPrice;
          await insertNewOrder(db, {
            tipo_ordem: 'STOP_MARKET', preco: newSLBreakevenPrice, quantidade: quantity,
            id_posicao: positionId, status: 'NEW', data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: newOrderId, side: oppositeSide, simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS', target: null, reduce_only: true, close_position: true,
            last_update: formatDateForMySQL(new Date()), orign_sig: position.orign_sig,
            observacao: 'Trailing Stop - Breakeven (CancelAll)'
          });
          await db.query(
            `UPDATE posicoes SET trailing_stop_level = 'BREAKEVEN', data_hora_ultima_atualizacao = ? WHERE id = ?`,
            [formatDateForMySQL(new Date()), positionId]
          );
          
          // Notificação Telegram (adapte se necessário)
          try {
            const [webhookInfo] = await db.query(`SELECT chat_id FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`, [positionId]);
            if (webhookInfo.length > 0 && webhookInfo[0].chat_id && typeof bot !== 'undefined' && bot && bot.telegram) {
              await bot.telegram.sendMessage(webhookInfo[0].chat_id, `✅ Trailing Stop Ativado para ${position.simbolo}\n\nAlvo 1 atingido\nSL movido para breakeven: (${newSLBreakevenPrice})`);
            }
          } catch (notifyError) { console.error(`${functionPrefix} Erro ao notificar SL breakeven: ${notifyError.message}`); }

        } else {
          console.error(`${functionPrefix} Falha ao criar nova SL (breakeven) para ${position.simbolo}. Resposta:`, slResponse);
        }
      } catch (error) {
        const errorMsg = error.response?.data?.msg || error.message || String(error);
        console.error(`${functionPrefix} Erro crítico ao criar nova SL (breakeven) para ${position.simbolo}: ${errorMsg}`, error.stack);
      }
    } else if (priceHitTP3) {
      console.log(`${functionPrefix} Preço (${currentPrice}) atingiu TP3 (${tp3Price}) para Posição ID ${positionId} (${side}). Nível Trailing: ${currentTrailingLevel}. Iniciando SL para TP1 (${tp1Price}).`);

      console.log(`${functionPrefix} Cancelando ordens SL existentes ANTES de mover para TP1...`);
      await cancelAllActiveStopLosses(db, position); // <--- CHAMADA DA NOVA FUNÇÃO
      
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
            tipo_ordem: 'STOP_MARKET', preco: newSLatTP1Price, quantidade: quantity,
            id_posicao: positionId, status: 'NEW', data_hora_criacao: formatDateForMySQL(new Date()),
            id_externo: newOrderId, side: oppositeSide, simbolo: position.simbolo,
            tipo_ordem_bot: 'STOP_LOSS', target: null, reduce_only: true, close_position: true,
            last_update: formatDateForMySQL(new Date()), orign_sig: position.orign_sig,
            observacao: 'Trailing Stop - TP1 (CancelAll)'
          });
          await db.query(
            `UPDATE posicoes SET trailing_stop_level = 'TP1', data_hora_ultima_atualizacao = ? WHERE id = ?`,
            [formatDateForMySQL(new Date()), positionId]
          );

          // Notificação Telegram (adapte se necessário)
          try {
            const [webhookInfo] = await db.query(`SELECT chat_id FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1`, [positionId]);
            if (webhookInfo.length > 0 && webhookInfo[0].chat_id && typeof bot !== 'undefined' && bot && bot.telegram) {
              await bot.telegram.sendMessage(webhookInfo[0].chat_id, `🚀 Trailing Stop Atualizado para ${position.simbolo}\n\nAlvo 3 Atingido\nSL movido para TP1: ${newSLatTP1Price}`);
            }
          } catch (notifyError) { console.error(`${functionPrefix} Erro ao notificar SL em TP1: ${notifyError.message}`); }

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
            [`Não encontrada na corretora durante cancelamento em massa`, formatDateForMySQL(new Date()), orderIdToCancel, positionId]
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

// Função para acionar entrada a mercado
async function triggerMarketEntry(db, entry, currentPrice) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();

    console.log(`[MONITOR] Acionando entrada a mercado para ${entry.simbolo} a ${currentPrice}`);

    // 1. Obter detalhes da posição e do sinal
    const [positionDetails] = await connection.query(
        `SELECT * FROM posicoes WHERE id = ?`,
        [entry.position_id]
    );

    if (positionDetails.length === 0) {
      throw new Error(`Posição ID ${entry.position_id} não encontrada`);
    }

    const position = positionDetails[0];

    // 2. Obter precisão da quantidade
    const { quantityPrecision } = await getPrecision(entry.simbolo);

    // 3. Calcular tamanho da ordem
    const availableBalance = await getAvailableBalance();

    const orderSize = calculateOrderSize(
        availableBalance,
        parseFloat(entry.capital_pct) / 100,
        parseFloat(entry.preco_entrada), // Usamos o preço de entrada original para cálculo
        parseInt(entry.leverage),
        quantityPrecision
    );

    // 4. Enviar ordem de mercado para a corretora
    try {
      const binanceSide = entry.side;
      const orderResponse = await newEntryOrder(
          entry.simbolo,
          orderSize,
          binanceSide
      );

      if (!orderResponse || !orderResponse.orderId) {
        throw new Error('Resposta inválida da corretora ao criar ordem de mercado');
      }

      const orderId = orderResponse.orderId;
      const executedQty = parseFloat(orderResponse.executedQty);
      const executedPrice = parseFloat(orderResponse.price);

      console.log(`[MONITOR] Ordem de mercado executada: ${entry.simbolo}, ID: ${orderId}, Preço: ${executedPrice}, Qtd: ${executedQty}`);

      // 5. ALTERAÇÃO: AGORA criamos a posição no banco
      const positionData = {
        simbolo: entry.simbolo,
        quantidade: executedQty,
        preco_medio: executedPrice,
        status: 'OPEN', // Diretamente como OPEN, não PENDING_ENTRY
        data_hora_abertura: new Date().toISOString(),
        side: binanceSide,
        leverage: parseInt(entry.leverage),
        data_hora_ultima_atualizacao: new Date().toISOString(),
        preco_entrada: executedPrice,
        preco_corrente: executedPrice,
        orign_sig: `WEBHOOK_${entry.webhook_id}`
      };

      const positionId = await insertPosition(connection, positionData);

      if (!positionId) {
        throw new Error('Falha ao inserir posição após execução da ordem');
      }

      // 6. Registrar ordem de entrada no banco
      const orderData = {
        tipo_ordem: 'MARKET',
        preco: executedPrice,
        quantidade: executedQty,
        id_posicao: positionId,
        status: 'FILLED',
        data_hora_criacao: new Date().toISOString(),
        id_externo: orderId,
        side: binanceSide,
        simbolo: entry.simbolo,
        tipo_ordem_bot: 'ENTRADA',
        target: null,
        reduce_only: false,
        close_position: false,
        last_update: new Date().toISOString(),
        orign_sig: `WEBHOOK_${entry.webhook_id}`
      };

      await insertNewOrder(connection, orderData);

      // 7. Atualizar webhook_signals
      await connection.query(
          `UPDATE webhook_signals SET
                                    status = 'EXECUTADO',
                                    position_id = ?,
                                    entry_order_id = ?
           WHERE id = ?`,
          [positionId, orderId, entry.webhook_id]
      );

      // 8. Criar e enviar ordens SL/TP
      const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
      const tpPriceVal = parseFloat(entry.tp_price);
      const slPriceVal = parseFloat(entry.sl_price);

      // Criar ordem SL
      try {
        const slResponse = await newStopOrder(
            entry.simbolo,
            executedQty,
            binanceOppositeSide,
            slPriceVal,
            null,           // price = null para STOP_MARKET
            false,           // reduceOnly = true
            true           // closePosition = false
        );

        console.log(`[MONITOR] Ordem SL (STOP_MARKET) criada: ${slResponse.data.orderId}`);

        // Registrar ordem SL no banco
        const slOrderData = {
          tipo_ordem: 'STOP_MARKET',
          preco: slPriceVal,
          quantidade: executedQty,
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: slResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: entry.simbolo,
          tipo_ordem_bot: 'STOP_LOSS',
          target: null,
          reduce_only: false,
          close_position: true,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${entry.webhook_id}`
        };

        await insertNewOrder(connection, slOrderData);

        // Atualizar SL ID no webhook
        await connection.query(
            `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`,
            [slResponse.data.orderId, entry.webhook_id]
        );
      } catch (slError) {
        console.error(`[MONITOR] Erro ao criar ordem SL: ${slError.message}`);
      }

      // Criar ordem TP
      try {
        const tpResponse = await newStopOrder(
            entry.simbolo,
            executedQty,
            binanceOppositeSide,
            tpPriceVal,
            tpPriceVal,      // price igual a stopPrice para TAKE_PROFIT_MARKET
            false,            // reduceOnly = true
            true            // closePosition = false
        );

        console.log(`[MONITOR] Ordem TP (TAKE_PROFIT_MARKET) criada: ${tpResponse.data.orderId}`);

        // Registrar ordem TP no banco
        const tpOrderData = {
          tipo_ordem: 'TAKE_PROFIT_MARKET',
          preco: tpPriceVal,
          quantidade: executedQty,
          id_posicao: positionId,
          status: 'OPEN',
          data_hora_criacao: new Date().toISOString(),
          id_externo: tpResponse.data.orderId,
          side: binanceOppositeSide,
          simbolo: entry.simbolo,
          tipo_ordem_bot: 'TAKE_PROFIT',
          target: 5,
          reduce_only: true,
          close_position: false,
          last_update: new Date().toISOString(),
          orign_sig: `WEBHOOK_${entry.webhook_id}`
        };

        await insertNewOrder(connection, tpOrderData);

        // Atualizar TP ID no webhook
        await connection.query(
            `UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`,
            [tpResponse.data.orderId, entry.webhook_id]
        );
      } catch (tpError) {
        console.error(`[MONITOR] Erro ao criar ordem TP: ${tpError.message}`);
      }

      // 9. Enviar notificação ao Telegram
      if (entry.chat_id) {
        try {
          await bot.telegram.sendMessage(entry.chat_id,
              `✅ Entrada realizada em ${entry.simbolo}\n\n` +
              `Direção: ${position.side.charAt(0).toUpperCase() + position.side.slice(1).toLowerCase()}\n` +
              `Alavancagem: ${entry.leverage}x\n` +
              `Quantidade: ${executedQty}\n\n` +
              `Entrada: ${executedPrice}\n` +
              `TP: ${tpPriceVal}\n` +
              `SL: ${slPriceVal}\n`,
              
          );
        } catch (telegramError) {
          console.error(`[MONITOR] Erro ao enviar mensagem Telegram:`, telegramError);
        }
      }

      await connection.commit();
      console.log(`[MONITOR] Entrada a mercado executada e registrada com sucesso para ${entry.simbolo}`);

      // Sincronizar saldo após criar ordem
      try {
        await syncAccountBalance();
      } catch (syncError) {
        console.error('[MONITOR] Erro ao sincronizar saldo após criar ordem:', syncError);
      }

    } catch (orderError) {
      console.error(`[MONITOR] Erro ao criar ordem de mercado para ${entry.simbolo}:`, orderError);
      await connection.query(
          `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
          [`Erro ao criar ordem de mercado: ${orderError.message}`, entry.webhook_id]
      );
      await connection.rollback();
    }

  } catch (error) {
    console.error(`[MONITOR] Erro ao acionar entrada a mercado:`, error);
    await connection.rollback();
  } finally {
    connection.release();
  }
}

// Função para verificar ordens expiradas com base no timeframe
async function checkExpiredOrders() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return;
    }

    // CORREÇÃO: Remover parâmetro [symbol] que causava erro
    const [pendingSignals] = await db.query(`
      SELECT id, symbol, side, entry_price, timeframe, created_at, chat_id
      FROM webhook_signals
      WHERE status = 'AGUARDANDO_ACIONAMENTO'
        AND timeframe IS NOT NULL AND timeframe != ''
    `);

    //console.log(`[MONITOR] Verificando ${pendingSignals.length} sinais pendentes com timeframe`);
    const now = new Date();
    let cancelCount = 0;

    for (const signal of pendingSignals) {
      // Pular se não tiver timeframe
      if (!signal.timeframe) continue;

      // Calcular o tempo máximo de vida do sinal (3x o timeframe)
      const timeframeMs = timeframeToMs(signal.timeframe);
      const maxLifetimeMs = timeframeMs * 3;

      // Se o timeframe não for válido ou for zero, pular
      if (maxLifetimeMs <= 0) {
        console.log(`[MONITOR] Timeframe inválido para sinal ${signal.id}: ${signal.timeframe}`);
        continue;
      }

      // Calcular há quanto tempo o sinal foi criado
      const createdAt = new Date(signal.created_at);
      const signalAgeMs = now.getTime() - createdAt.getTime();

      // Se o sinal estiver expirado (idade > 3x timeframe)
      if (signalAgeMs > maxLifetimeMs) {
        console.log(`[MONITOR] Sinal pendente para ${signal.symbol} expirado por timeout`);
        console.log(`[MONITOR] Idade: ${(signalAgeMs / (60 * 1000)).toFixed(2)} min, Máximo: ${(maxLifetimeMs / (60 * 1000)).toFixed(2)} min (${signal.timeframe} * 3)`);

        // Cancelar o sinal
        await cancelSignal(db, signal.id, 'TIMEOUT',
          `Entrada não acionada dentro do limite de tempo (${signal.timeframe} * 3)`);
        
        cancelCount++;
      }
    }

    if (cancelCount > 0) {
      console.log(`[MONITOR] ${cancelCount} sinais pendentes cancelados por timeout de timeframe`);
    }
  } catch (error) {
    console.error('[MONITOR] Erro ao verificar sinais expirados:', error);
  }
}

/**
 * Sincroniza o saldo da conta com a corretora e atualiza o banco de dados
 * Segue a regra: saldo_base_calculo só é atualizado quando o saldo aumenta
 * @returns {Promise<Object>} Objeto contendo saldo e saldo_base_calculo atualizados
 */
async function syncAccountBalance() {
  try {
    const db = await getDatabaseInstance();
    if (!db) {
      console.error('[MONITOR] Falha ao obter instância do banco de dados');
      return null;
    }

    // Obter saldo real da corretora
    //console.log('[MONITOR] Obtendo saldo atualizado da corretora...');
    const balanceDetails = await getFuturesAccountBalanceDetails();
    const usdtBalance = balanceDetails.find(item => item.asset === 'USDT');

    if (!usdtBalance) {
      throw new Error('Saldo USDT não encontrado na corretora');
    }

    // CORREÇÃO: Usar o campo balance (saldo total) em vez de availableBalance
    const realSaldo = parseFloat(usdtBalance.balance);

    //console.log(`[MONITOR] Saldo total na corretora: ${realSaldo.toFixed(2)} USDT`);
    //console.log(`[MONITOR] Saldo disponível: ${parseFloat(usdtBalance.availableBalance).toFixed(2)} USDT`);

    // Obter saldo atual e base de cálculo do banco
    const [currentBalance] = await db.query('SELECT saldo, saldo_base_calculo FROM conta WHERE id = 1');

    const currentSaldo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo || 0) : 0;
    const currentBaseCalculo = currentBalance.length > 0 ? parseFloat(currentBalance[0].saldo_base_calculo || 0) : 0;

    //console.log(`[MONITOR] Saldo atual: ${currentSaldo.toFixed(2)} USDT | Base Cálculo: ${currentBaseCalculo.toFixed(2)} USDT`);

    // Atualizar saldo no banco de dados com o saldo total
    const result = await updateAccountBalance(db, realSaldo);

    if (result) {
      //console.log(`[MONITOR] Saldo atualizado para: ${result.saldo.toFixed(2)} USDT | Base Cálculo: ${result.saldo_base_calculo.toFixed(2)} USDT`);

      // Se o saldo base de cálculo foi alterado, exibir mensagem adicional
      if (result.saldo_base_calculo > currentBaseCalculo) {
        console.log(`[MONITOR] Base de cálculo aumentada: ${currentBaseCalculo.toFixed(2)} → ${result.saldo_base_calculo.toFixed(2)} USDT`);
      }
    }

    return result;
  } catch (error) {
    console.error(`[MONITOR] Erro ao sincronizar saldo da conta: ${error.message}`);
    return null;
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
        console.log(`[MONITOR] WebSocket para ${symbol} fechado com sucesso.`);
        
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

async function executeLimitMakerEntry(db, signal, currentPriceTrigger) {
    const connection = await db.getConnection();
    const MAX_CHASE_ATTEMPTS = 100;
    const CHASE_TIMEOUT_MS = 450000; // 7.5 minutos
    const WAIT_FOR_EXECUTION_TIMEOUT_MS = 5000;
    const EDIT_WAIT_TIMEOUT_MS = 3000;

    let chaseAttempts = 0;
    let totalEntrySize = 0;
    let totalFilledSize = 0;
    let averageEntryPrice = 0;
    let positionId = null;
    let executionStartTime = Date.now();
    let partialFills = [];
    let activeOrderId = null;
    let marketOrderResponseForDb = null;
    const rpTargetKeys = ['tp1', 'tp2', 'tp3', 'tp4'];

    let binanceSide;
    let leverage;
    let quantityPrecision;
    let pricePrecision;
    let precisionInfo;

    // Variáveis para o WebSocket de profundidade
    let depthWs = null;
    let currentBestBid = null;
    let currentBestAsk = null;
    let lastDepthUpdateTimestamp = 0;
    const MAX_DEPTH_STALENESS_MS = 3000; // Considerar dados do book "velhos" após 3 segundos sem atualização do WS
    let wsUpdateErrorCount = 0;

    try {
        const existingPositionsOnExchange = await getAllOpenPositions(signal.symbol);
        const positionAlreadyExists = existingPositionsOnExchange.some(p =>
            p.simbolo === signal.symbol && Math.abs(p.quantidade) > 0
        );

        if (positionAlreadyExists) {
            console.log(`[LIMIT_ENTRY] ALERTA: Posição já existe para ${signal.symbol}. Cancelando.`);
            await db.query(
                `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
                ['Posição já existe na corretora (verificação inicial)', signal.id]
            );
            return { success: false, error: 'Posição já existe na corretora (verificação inicial)' };
        }

        await connection.beginTransaction();
        
        console.log(`[LIMIT_ENTRY] Iniciando LIMIT MAKER para Sinal ID ${signal.id} (${signal.symbol})`);
        
        precisionInfo = await getPrecision(signal.symbol);
        quantityPrecision = precisionInfo.quantityPrecision;
        pricePrecision = precisionInfo.pricePrecision;
        
        const availableBalance = await getAvailableBalance();
        const capitalPercentage = parseFloat(signal.capital_pct) / 100;
        leverage = parseInt(signal.leverage); 
        
        totalEntrySize = calculateOrderSize(
            availableBalance, capitalPercentage, currentPriceTrigger, leverage, quantityPrecision
        );
        
        if (totalEntrySize <= 0 || isNaN(totalEntrySize)) {
            throw new Error(`Tamanho da ordem inválido: ${totalEntrySize}`);
        }
        
        binanceSide = signal.side.toUpperCase() === 'COMPRA' || signal.side.toUpperCase() === 'BUY' ? 'BUY' : 'SELL';
        
        await connection.query(
            `UPDATE webhook_signals SET status = 'ENTRADA_EM_PROGRESSO' WHERE id = ?`,
            [signal.id]
        );

        // --- INÍCIO: Integração WebSocket de Profundidade ---
        console.log(`[LIMIT_ENTRY] Iniciando WebSocket de profundidade para ${signal.symbol}`);
        depthWs = websockets.setupBookDepthWebsocket(signal.symbol, (depthData) => {
            if (depthData.bestBid && depthData.bestAsk) {
                currentBestBid = parseFloat(depthData.bestBid);
                currentBestAsk = parseFloat(depthData.bestAsk);
                lastDepthUpdateTimestamp = Date.now();
                wsUpdateErrorCount = 0; // Resetar contador de erro se recebermos dados
                // console.log(`[LIMIT_ENTRY_DEPTH_WS] ${signal.symbol} - Bid: ${currentBestBid}, Ask: ${currentBestAsk}`);
            } else {
                wsUpdateErrorCount++;
                console.warn(`[LIMIT_ENTRY_DEPTH_WS] Dados de profundidade inválidos recebidos para ${signal.symbol}:`, depthData);
            }
        });
        // Lidar com erros de conexão do WS de profundidade principal aqui, se necessário, ou confiar na lógica interna de setupBookDepthWebsocket.
        // Adicionar uma pequena pausa para permitir que o WebSocket conecte e receba os primeiros dados.
        await new Promise(resolve => setTimeout(resolve, 1500)); // 1.5 segundos de cortesia para conexão WS

        // Obter dados iniciais do book via REST como fallback ou para início rápido
        if (!currentBestBid || !currentBestAsk) {
            try {
                console.log(`[LIMIT_ENTRY] WebSocket de profundidade ainda não forneceu dados. Buscando book inicial via REST para ${signal.symbol}...`);
                const initialBookData = await getBookTicker(signal.symbol); // Sua função existente
                if (initialBookData && initialBookData.bidPrice && initialBookData.askPrice) {
                    currentBestBid = parseFloat(initialBookData.bidPrice);
                    currentBestAsk = parseFloat(initialBookData.askPrice);
                    lastDepthUpdateTimestamp = Date.now(); // Atualiza o timestamp
                    console.log(`[LIMIT_ENTRY] Book inicial obtido via REST: Bid ${currentBestBid}, Ask ${currentBestAsk}`);
                } else {
                     console.warn(`[LIMIT_ENTRY] Book ticker inicial via REST não retornou dados válidos para ${signal.symbol}.`);
                }
            } catch (e) {
                console.warn(`[LIMIT_ENTRY] Falha ao obter book ticker inicial via REST para ${signal.symbol}: ${e.message}. Tentará prosseguir com dados do WS se disponíveis.`);
            }
        }
        // --- FIM: Integração WebSocket de Profundidade ---
        
        while (totalFilledSize < totalEntrySize && 
               chaseAttempts < MAX_CHASE_ATTEMPTS && 
               (Date.now() - executionStartTime) < CHASE_TIMEOUT_MS) {
            
            chaseAttempts++;
            // Removido o log de tentativa daqui para reduzir verbosidade, pode ser adicionado se necessário.

            // Sincronizar preenchimentos antes de obter o book para ter o `totalFilledSize` mais atual
            try {
                // ... (lógica de getRecentOrders e processamento de filledExchangeOrders - MANTIDA) ...
                 const recentOrders = await getRecentOrders(signal.symbol, 15); // Sua função existente
                 const filledExchangeOrders = recentOrders.filter(order =>
                    order.status === 'FILLED' &&
                    order.side === binanceSide &&
                    parseFloat(order.executedQty) > 0 &&
                    (Date.now() - order.updateTime) < CHASE_TIMEOUT_MS * 2 &&
                    !partialFills.some(fill => fill.orderId === String(order.orderId))
                );

                for (const exOrder of filledExchangeOrders) {
                    const qty = parseFloat(exOrder.executedQty);
                    const price = parseFloat(exOrder.avgPrice || exOrder.price);
                    if (!partialFills.some(fill => fill.orderId === String(exOrder.orderId))) {
                        partialFills.push({ qty, price, orderId: String(exOrder.orderId) });
                        totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                        console.log(`[LIMIT_ENTRY] (Sync Recent) Contabilizado: ${qty.toFixed(quantityPrecision)} @ ${price.toFixed(pricePrecision)} (ID: ${exOrder.orderId}). Total agora: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    }
                }
                if (totalFilledSize >= totalEntrySize) {
                    console.log(`[LIMIT_ENTRY] (Sync Recent) Quantidade total atingida após sincronização de ordens recentes.`);
                    break;
                }
            } catch (checkError) {
                console.error(`[LIMIT_ENTRY] Erro ao buscar/sincronizar ordens recentes:`, checkError.message);
            }


            const remainingSizeCurrentLoop = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
            if (remainingSizeCurrentLoop <= 0) {
                console.log(`[LIMIT_ENTRY] Quantidade restante (${remainingSizeCurrentLoop.toFixed(quantityPrecision)}) zerada ou negativa. Saindo do loop de chasing.`);
                break;
            }

            // --- USO DOS DADOS DO WEBSOCKET ---
            const isDepthDataStale = (Date.now() - lastDepthUpdateTimestamp > MAX_DEPTH_STALENESS_MS);
            if (!currentBestBid || !currentBestAsk || isDepthDataStale || wsUpdateErrorCount > 3) {
                const staleReason = !currentBestBid || !currentBestAsk ? "ausentes" : (isDepthDataStale ? "velhos" : `erros WS (${wsUpdateErrorCount})`);
                console.log(`[LIMIT_ENTRY] Dados do book (WebSocket) para ${signal.symbol} ${staleReason}. Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Bid: ${currentBestBid}, Ask: ${currentBestAsk}, Última atualização WS: ${lastDepthUpdateTimestamp ? new Date(lastDepthUpdateTimestamp).toISOString() : 'N/A'}`);
                
                // Fallback para REST se o WS estiver com problemas persistentes
                if (isDepthDataStale || wsUpdateErrorCount > 3) {
                    console.warn(`[LIMIT_ENTRY] Tentando fallback para API REST para obter book de ${signal.symbol}`);
                    try {
                        const fallbackBookData = await getBookTicker(signal.symbol); // Sua função existente
                        if (fallbackBookData && fallbackBookData.bidPrice && fallbackBookData.askPrice) {
                            currentBestBid = parseFloat(fallbackBookData.bidPrice);
                            currentBestAsk = parseFloat(fallbackBookData.askPrice);
                            // Não atualize lastDepthUpdateTimestamp aqui, para não mascarar o problema do WS
                            console.log(`[LIMIT_ENTRY] Book obtido via REST (fallback): Bid ${currentBestBid}, Ask ${currentBestAsk}`);
                            wsUpdateErrorCount = 0; // Resetar contador se o fallback funcionar
                        } else {
                             console.error(`[LIMIT_ENTRY] Fallback REST para ${signal.symbol} não retornou dados válidos.`);
                             await new Promise(resolve => setTimeout(resolve, 1000)); // Pausa maior se REST também falha
                             continue;
                        }
                    } catch (e) {
                        console.error(`[LIMIT_ENTRY] Falha ao obter book ticker via REST (fallback) para ${signal.symbol}: ${e.message}`);
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Pausa maior
                        continue;
                    }
                } else {
                    await new Promise(resolve => setTimeout(resolve, 300)); // Pausa curta se os dados do WS ainda não chegaram
                    continue;
                }
            }
            // --- FIM USO DOS DADOS DO WEBSOCKET ---

            const bestBid = currentBestBid; // Usar os valores atualizados pelo WS (ou fallback REST)
            const bestAsk = currentBestAsk;
            const spread = bestAsk - bestBid;

            const tickSizeData = await getTickSize(signal.symbol);
            const tickSize = parseFloat(tickSizeData.tickSize);
            
            // A lógica para definir currentLocalMakerPrice (renomeado para evitar confusão) e gerenciar ordens é mantida.
            // 'currentMakerPrice' dentro do loop while agora é 'currentLocalMakerPrice'
            let currentLocalMakerPrice;
            if (binanceSide === 'BUY') {
                currentLocalMakerPrice = bestAsk - tickSize;
                const spreadTicks = Math.floor(spread / tickSize);
                if (spreadTicks > 2) {
                    currentLocalMakerPrice = bestBid + tickSize;
                }
            } else { // SELL
                currentLocalMakerPrice = bestBid + tickSize;
                const spreadTicks = Math.floor(spread / tickSize);
                if (spreadTicks > 2) {
                    currentLocalMakerPrice = bestAsk - tickSize;
                }
            }
            currentLocalMakerPrice = await roundPriceToTickSize(signal.symbol, currentLocalMakerPrice);
            
            if (chaseAttempts % 5 === 0) { // Logar preço calculado a cada 5 tentativas para não poluir muito
                 console.log(`[LIMIT_ENTRY] Tentativa ${chaseAttempts}/${MAX_CHASE_ATTEMPTS}. Preço MAKER calculado: ${currentLocalMakerPrice.toFixed(pricePrecision)} (Bid: ${bestBid.toFixed(pricePrecision)}, Ask: ${bestAsk.toFixed(pricePrecision)})`);
            }

            let orderPlacedOrEditedThisIteration = false;

            // ... (Toda a lógica de gerenciamento de activeOrderId, getOrderStatus, edição, cancelamento, nova ordem é MANTIDA) ...
            // A diferença é que 'currentLocalMakerPrice' é usado para novas ordens ou edições.
            // Exemplo de onde currentLocalMakerPrice seria usado:
            // na hora de editar: await editOrder(..., currentLocalMakerPrice.toFixed(pricePrecision));
            // na hora de criar nova: await newLimitMakerOrder(..., currentLocalMakerPrice);

             if (activeOrderId) {
                let currentOrderDataFromExchange;
                try {
                    currentOrderDataFromExchange = await getOrderStatus(activeOrderId, signal.symbol);
                } catch (e) {
                    if (e.response && e.response.data && (e.response.data.code === -2013 || e.response.data.code === -2011) ) { 
                        console.log(`[LIMIT_ENTRY] Ordem ativa ${activeOrderId} não existe mais na corretora. Resetando.`);
                        activeOrderId = null;
                    } else {
                        console.error(`[LIMIT_ENTRY] Erro ao buscar status da ordem ${activeOrderId}: ${e.message}`);
                        await new Promise(resolve => setTimeout(resolve, 200)); continue;
                    }
                }

                if (currentOrderDataFromExchange) {
                    const { status, executedQty, avgPrice, price: orderPriceOnExchangeStr, origQty } = currentOrderDataFromExchange;
                    const apiFilledQty = parseFloat(executedQty || 0);
                    const orderPriceOnExchange = parseFloat(orderPriceOnExchangeStr);
                    
                    let alreadyAccountedForThisOrder = 0;
                    partialFills.forEach(pf => { if (pf.orderId === activeOrderId) alreadyAccountedForThisOrder += pf.qty; });
                    const netFilledSinceLastCheck = apiFilledQty - alreadyAccountedForThisOrder;

                    if (netFilledSinceLastCheck > 0) {
                        const fillPrice = parseFloat(avgPrice || orderPriceOnExchangeStr); // Usar avgPrice se disponível
                        partialFills.push({ qty: netFilledSinceLastCheck, price: fillPrice, orderId: activeOrderId });
                        totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                        console.log(`[LIMIT_ENTRY] Preenchimento (status check) ${activeOrderId}: ${netFilledSinceLastCheck.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    }

                    if (status === 'FILLED') {
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} FILLED (status check).`);
                        activeOrderId = null; 
                        if (totalFilledSize >= totalEntrySize) break; 
                        continue; 
                    } 
                    else if (status === 'PARTIALLY_FILLED' || status === 'NEW') {
                        // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ${status} (status check). Verificando necessidade de reposicionamento.`);
                        const needsReposition = Math.abs(orderPriceOnExchange - currentLocalMakerPrice) >= tickSize;

                        if (needsReposition) {
                            console.log(`[LIMIT_ENTRY] Reposicionando ordem ${activeOrderId}. Preço atual da ordem: ${orderPriceOnExchange.toFixed(pricePrecision)}, Preço MAKER ideal: ${currentLocalMakerPrice.toFixed(pricePrecision)}.`);
                            if (status === 'PARTIALLY_FILLED') {
                                console.log(`[LIMIT_ENTRY] Cancelando ${activeOrderId} (parcialmente preenchida) para reposicionar restante.`);
                                try { 
                                    await cancelOrder(activeOrderId, signal.symbol); 
                                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} cancelada com sucesso.`);
                                } catch (cancelError) { 
                                    console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} (parcial): ${cancelError.message}. Verificando se já foi preenchida/cancelada.`);
                                    try {
                                        const postCancelAttemptStatus = await getOrderStatus(activeOrderId, signal.symbol);
                                        if (postCancelAttemptStatus.status === 'FILLED' || postCancelAttemptStatus.status === 'CANCELED') {
                                            console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} já está ${postCancelAttemptStatus.status}. Resetando activeOrderId.`);
                                            activeOrderId = null; 
                                            const finalApiFilledQty = parseFloat(postCancelAttemptStatus.executedQty || 0);
                                            const finalNetFilled = finalApiFilledQty - alreadyAccountedForThisOrder;
                                            if (finalNetFilled > 0) {
                                                const finalFillPrice = parseFloat(postCancelAttemptStatus.avgPrice || postCancelAttemptStatus.price);
                                                partialFills.push({ qty: finalNetFilled, price: finalFillPrice, orderId: activeOrderId }); // activeOrderId pode já ser null aqui, mas o ID é importante
                                                totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                                                console.log(`[LIMIT_ENTRY] Preenchimento adicional (pós falha cancel) ${activeOrderId || 'ID_ORDEM_ANTERIOR'}: ${finalNetFilled.toFixed(quantityPrecision)} @ ${finalFillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                                            }
                                        }
                                    } catch (statusError) {
                                        console.error(`[LIMIT_ENTRY] Erro ao verificar status de ${activeOrderId} após falha no cancelamento: ${statusError.message}`);
                                    }
                                }
                                activeOrderId = null; 
                            } else { // status === 'NEW'
                                console.log(`[LIMIT_ENTRY] Tentando editar ordem NEW ${activeOrderId} para novo preço ${currentLocalMakerPrice.toFixed(pricePrecision)}.`);
                                try {
                                    const qtyToEdit = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                                    if (qtyToEdit > 0) { 
                                        const editResp = await editOrder(signal.symbol, activeOrderId, binanceSide, qtyToEdit, currentLocalMakerPrice.toFixed(pricePrecision));
                                        if (editResp && editResp.orderId) {
                                            if (String(editResp.orderId) !== activeOrderId) { 
                                                console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} editada (cancel/replace). Nova ID: ${editResp.orderId}`);
                                                activeOrderId = String(editResp.orderId);
                                            } else { console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} editada com sucesso.`); }
                                            orderPlacedOrEditedThisIteration = true;
                                        } else {
                                            console.warn(`[LIMIT_ENTRY] Edição da ordem ${activeOrderId} não retornou ID válido ou falhou. Cancelando para segurança.`);
                                            try { await cancelOrder(activeOrderId, signal.symbol); } catch(e){ console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} após edição sem ID: ${e.message}`); } 
                                            activeOrderId = null;
                                        }
                                    } else {
                                        console.log(`[LIMIT_ENTRY] Quantidade a editar para ${activeOrderId} é zero ou negativa. Cancelando ordem.`);
                                        try { await cancelOrder(activeOrderId, signal.symbol); } catch(e){ console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} (qtd zero para editar): ${e.message}`); } 
                                        activeOrderId = null;
                                    }
                                } catch (editErr) {
                                    console.warn(`[LIMIT_ENTRY] Falha ao editar ${activeOrderId}: ${editErr.message}.`, editErr.response?.data);
                                    try { 
                                        const postEditFailStatus = await getOrderStatus(activeOrderId, signal.symbol); 
                                        if(postEditFailStatus && postEditFailStatus.status !== 'NEW' && postEditFailStatus.status !== 'PARTIALLY_FILLED') {
                                            activeOrderId = null; 
                                        } else if (postEditFailStatus && (postEditFailStatus.status === 'NEW' || postEditFailStatus.status === 'PARTIALLY_FILLED')) {
                                            console.log(`[LIMIT_ENTRY] Tentando cancelar ${activeOrderId} após falha na edição.`);
                                            await cancelOrder(activeOrderId, signal.symbol);
                                            activeOrderId = null;
                                        }
                                    } catch(e){ 
                                        console.warn(`[LIMIT_ENTRY] Erro ao obter status de ${activeOrderId} após falha na edição: ${e.message}. Resetando activeOrderId.`);
                                        activeOrderId = null; 
                                    } 
                                }
                            }
                        } else { 
                            // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} (${status}) já está no preço MAKER ideal ou dentro da tolerância. Mantendo.`);
                            orderPlacedOrEditedThisIteration = true; 
                        }
                    } else { 
                        console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} com status inesperado: ${status}. Resetando.`);
                        activeOrderId = null;
                    }
                }
            }
            
            if (!activeOrderId && totalFilledSize < totalEntrySize) { 
                const newOrderQty = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
                if (newOrderQty <= 0) { 
                    console.log("[LIMIT_ENTRY] Quantidade para nova ordem é zero ou negativa. Saindo do loop de chasing."); 
                    break; 
                }
                try {
                    console.log(`[LIMIT_ENTRY] Enviando NOVA LIMIT ${signal.symbol}: ${binanceSide} ${newOrderQty.toFixed(quantityPrecision)} @ ${currentLocalMakerPrice.toFixed(pricePrecision)}`);
                    const orderResponse = await newLimitMakerOrder(
                        signal.symbol, newOrderQty, binanceSide, currentLocalMakerPrice
                    );
                    if (orderResponse.status === 'REJECTED_POST_ONLY' || (orderResponse.info && orderResponse.info.msg === 'Filter failure: PRICE_FILTER')) {
                        console.log(`[LIMIT_ENTRY] Nova LIMIT MAKER rejeitada (Post-Only ou Price Filter). Aguardando próxima iteração.`);
                        await new Promise(resolve => setTimeout(resolve, 300)); 
                        continue; 
                    }
                    if (!orderResponse.orderId) throw new Error(`Resposta da nova ordem LIMIT inválida: ${JSON.stringify(orderResponse)}`);
                    activeOrderId = String(orderResponse.orderId);
                    orderPlacedOrEditedThisIteration = true;
                    console.log(`[LIMIT_ENTRY] Nova LIMIT criada: ID ${activeOrderId}`);
                } catch (newOrderError) {
                    console.error(`[LIMIT_ENTRY] Erro ao criar NOVA LIMIT:`, newOrderError.response?.data || newOrderError.message);
                    await new Promise(resolve => setTimeout(resolve, 1000)); 
                    continue;
                }
            }
            
            if (orderPlacedOrEditedThisIteration && activeOrderId) {
                // console.log(`[LIMIT_ENTRY] Aguardando execução/status da ordem ${activeOrderId} por ${EDIT_WAIT_TIMEOUT_MS}ms...`);
                const orderWaitResult = await waitForOrderExecution(signal.symbol, activeOrderId, EDIT_WAIT_TIMEOUT_MS);
                
                const apiWaitFilledQty = parseFloat(orderWaitResult.executedQty || 0);
                let alreadyAccountedForWait = 0;
                partialFills.forEach(pf => { if (pf.orderId === activeOrderId) alreadyAccountedForWait += pf.qty; });
                const netFilledInWait = apiWaitFilledQty - alreadyAccountedForWait;

                if (netFilledInWait > 0) {
                    const fillPrice = parseFloat(orderWaitResult.avgPrice || orderWaitResult.price);
                    partialFills.push({ qty: netFilledInWait, price: fillPrice, orderId: activeOrderId });
                    totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0);
                    console.log(`[LIMIT_ENTRY] Preenchimento (após wait) ${activeOrderId}: ${netFilledInWait.toFixed(quantityPrecision)} @ ${fillPrice.toFixed(pricePrecision)}. Total: ${totalFilledSize.toFixed(quantityPrecision)}`);
                }

                if (orderWaitResult.status === 'FILLED') {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} FILLED (após wait).`);
                    activeOrderId = null; 
                    if (totalFilledSize >= totalEntrySize) break;
                } else if (orderWaitResult.status === 'PARTIALLY_FILLED') {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} PARTIALLY_FILLED (após wait). Continuará no loop.`);
                } else if (['CANCELED', 'REJECTED', 'EXPIRED'].includes(orderWaitResult.status)) {
                    console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ${orderWaitResult.status} (após wait). Resetando.`);
                    activeOrderId = null;
                } else if (orderWaitResult.status === 'NEW') {
                    //  console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} ainda NEW (após wait). Continuará no loop para reavaliação.`);
                } else if (orderWaitResult.status && orderWaitResult.status.startsWith('TIMED_OUT')) {
                    console.log(`[LIMIT_ENTRY] Timeout ao aguardar ${activeOrderId}. Será reavaliada na próxima iteração.`);
                } else {
                    // console.log(`[LIMIT_ENTRY] Ordem ${activeOrderId} com status ${orderWaitResult.status || 'DESCONHECIDO'} (após wait). Será reavaliada.`);
                }
            }
            
            if (totalFilledSize >= totalEntrySize) {
                console.log(`[LIMIT_ENTRY] Quantidade total (${totalEntrySize.toFixed(quantityPrecision)}) alcançada.`);
                break; 
            }
            await new Promise(resolve => setTimeout(resolve, 200)); // Loop principal de espera
        } 
        
        // ... (Restante da função: cálculo de averageEntryPrice, lógica de preenchimento com MARKET se necessário, MIN_FILL_THRESHOLD, registro da posição, SL/TP, notificações - MANTIDO) ...
        // O restante da função permanece como na versão anterior.
        if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
        } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0)) { 
            averageEntryPrice = currentPriceTrigger; 
            console.warn(`[LIMIT_ENTRY] averageEntryPrice não pôde ser calculado a partir de partialFills (total preenchido: ${totalFilledSize}), usando currentPriceTrigger como fallback: ${averageEntryPrice}`);
        }


        if (totalFilledSize < totalEntrySize) {
            console.log(`[LIMIT_ENTRY] Chasing encerrado. Preenchido: ${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)}. Timeout: ${Date.now() - executionStartTime >= CHASE_TIMEOUT_MS}, Tentativas: ${chaseAttempts >= MAX_CHASE_ATTEMPTS}`);
            const remainingToFillMarket = parseFloat((totalEntrySize - totalFilledSize).toFixed(quantityPrecision));
            
            if (remainingToFillMarket > 0) {
                console.log(`[LIMIT_ENTRY] Tentando preencher restante (${remainingToFillMarket.toFixed(quantityPrecision)}) com ordem MARKET.`);
                if (activeOrderId) { 
                    try {
                        const lastOrderStatus = await getOrderStatus(activeOrderId, signal.symbol);
                        if (lastOrderStatus && (lastOrderStatus.status === 'NEW' || lastOrderStatus.status === 'PARTIALLY_FILLED')) {
                            await cancelOrder(activeOrderId, signal.symbol); 
                            console.log(`[LIMIT_ENTRY] Última ordem LIMIT ${activeOrderId} cancelada antes da ordem MARKET final.`);
                        }
                    } catch (cancelErr) { console.warn(`[LIMIT_ENTRY] Falha ao cancelar ${activeOrderId} antes da MARKET final: ${cancelErr.message}`); }
                    activeOrderId = null; 
                }
                try {
                    marketOrderResponseForDb = await newEntryOrder(
                        signal.symbol, remainingToFillMarket, binanceSide
                    );
                    if (marketOrderResponseForDb && marketOrderResponseForDb.orderId && marketOrderResponseForDb.status === 'FILLED') {
                        const marketFilledQty = parseFloat(marketOrderResponseForDb.executedQty);
                        // Para MARKET, avgPrice é o preço de execução
                        const marketFilledPrice = parseFloat(marketOrderResponseForDb.avgPrice || marketOrderResponseForDb.price); 
                        if (marketFilledQty > 0) {
                            partialFills.push({ qty: marketFilledQty, price: marketFilledPrice, orderId: String(marketOrderResponseForDb.orderId) });
                            totalFilledSize = partialFills.reduce((sum, pf) => sum + pf.qty, 0); 
                            averageEntryPrice = calculateAveragePrice(partialFills); 
                        }
                        console.log(`[LIMIT_ENTRY] Ordem MARKET final preenchida: ${marketFilledQty.toFixed(quantityPrecision)} @ ${marketFilledPrice.toFixed(pricePrecision)}. Total acumulado: ${totalFilledSize.toFixed(quantityPrecision)}`);
                    } else {
                        console.error(`[LIMIT_ENTRY] Falha na ordem MARKET final ou resposta inválida/não FILLED:`, marketOrderResponseForDb);
                    }
                } catch (marketError) {
                   console.error(`[LIMIT_ENTRY] Erro crítico ao executar ordem MARKET final:`, marketError.response?.data || marketError.message);
                }
            }
        }
        
        const MIN_FILL_THRESHOLD_ABSOLUTE = 0.000001; 
        if (totalFilledSize <= MIN_FILL_THRESHOLD_ABSOLUTE) { 
             throw new Error(`Entrada falhou. Quantidade preenchida (${totalFilledSize.toFixed(quantityPrecision)}) é insignificante ou nula para Sinal ID ${signal.id}.`);
        }
        
        const fillRatio = totalEntrySize > 0 ? totalFilledSize / totalEntrySize : 0;
        const ENTRY_COMPLETE_THRESHOLD_RATIO = 0.999; 

        // Recalcular averageEntryPrice final com todos os preenchimentos
        if (partialFills.length > 0) {
            averageEntryPrice = calculateAveragePrice(partialFills);
        } else if (totalFilledSize > 0 && (!averageEntryPrice || averageEntryPrice === 0) ){ // Se não houve preenchimentos parciais mas algo foi preenchido (raro)
             averageEntryPrice = currentPriceTrigger; // Fallback extremo
             console.warn(`[LIMIT_ENTRY] Usando currentPriceTrigger como averageEntryPrice (fallback extremo).`);
        }
        if (!averageEntryPrice || averageEntryPrice === 0 ) { // Se ainda assim for zero e houve preenchimento
            throw new Error(`Preço médio de entrada não pôde ser determinado apesar de ${totalFilledSize} preenchido.`);
        }


        console.log(`[LIMIT_ENTRY] Processo de entrada finalizado para Sinal ID ${signal.id}: Total Preenchido ${totalFilledSize.toFixed(quantityPrecision)} de ${totalEntrySize.toFixed(quantityPrecision)} (${(fillRatio * 100).toFixed(1)}%) @ Preço Médio ${averageEntryPrice.toFixed(pricePrecision)}`);
        
        const positionData = {
            simbolo: signal.symbol, quantidade: totalFilledSize, preco_medio: averageEntryPrice, status: 'OPEN',
            data_hora_abertura: new Date(executionStartTime).toISOString(), side: binanceSide, leverage: leverage,
            data_hora_ultima_atualizacao: new Date().toISOString(), preco_entrada: averageEntryPrice,
            preco_corrente: averageEntryPrice, 
            orign_sig: `WEBHOOK_${signal.id}`,
            quantidade_aberta: totalFilledSize,
        };
        
        positionId = await insertPosition(connection, positionData);
        if (!positionId) throw new Error(`Falha ao inserir posição no banco de dados para Sinal ID ${signal.id}`);
        console.log(`[LIMIT_ENTRY] Posição ID ${positionId} criada no banco de dados para Sinal ID ${signal.id}`);
        
        for (const fill of partialFills) {
            const orderData = {
                tipo_ordem: (marketOrderResponseForDb && fill.orderId === String(marketOrderResponseForDb.orderId)) ? 'MARKET' : 'LIMIT',
                preco: fill.price, quantidade: fill.qty, id_posicao: positionId, status: 'FILLED', 
                data_hora_criacao: new Date().toISOString(), 
                id_externo: String(fill.orderId || `fill_${Date.now()}_${Math.random().toString(36).substring(7)}`).substring(0, 90), 
                side: binanceSide, simbolo: signal.symbol, tipo_ordem_bot: 'ENTRADA', target: null,
                reduce_only: false, close_position: false, last_update: new Date().toISOString(),
                orign_sig: `WEBHOOK_${signal.id}`, preco_executado: fill.price, quantidade_executada: fill.qty,
            };
            await insertNewOrder(connection, orderData);
        }
        
        await connection.query(
            `UPDATE webhook_signals SET status = 'EXECUTADO', position_id = ?, entry_order_id = ?, entry_price = ? WHERE id = ?`,
            [positionId, (partialFills.length > 0 ? partialFills[0].orderId : null), averageEntryPrice, signal.id]
        );
        
        let slTpRpsCreated = false;
        if (fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO) {
            console.log(`[LIMIT_ENTRY] Entrada considerada COMPLETA (${(fillRatio * 100).toFixed(1)}%). Criando SL/TP/RPs.`);
            slTpRpsCreated = true;

            const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
            const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
            
            const targetPrices = {
                tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
                tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
                tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
                tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
                tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
            };

            if (slPriceVal && slPriceVal > 0) {
                try {
                    console.log(`[LIMIT_ENTRY] Criando SL: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${slPriceVal.toFixed(pricePrecision)}`);
                    const slResponse = await newStopOrder( 
                        signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                        binanceOppositeSide, slPriceVal.toFixed(pricePrecision), null, true, true 
                    );
                    if (slResponse && slResponse.data && slResponse.data.orderId) {
                        const slOrderData = { 
                            tipo_ordem: 'STOP_MARKET', preco: slPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW', 
                            data_hora_criacao: new Date().toISOString(), id_externo: String(slResponse.data.orderId).substring(0,90), side: binanceOppositeSide, 
                            simbolo: signal.symbol, tipo_ordem_bot: 'STOP_LOSS', reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: new Date().toISOString(), target: null
                        };
                        await insertNewOrder(connection, slOrderData); 
                        console.log(`[LIMIT_ENTRY] SL criado: ${slResponse.data.orderId}`);
                        await connection.query( `UPDATE webhook_signals SET sl_order_id = ? WHERE id = ?`, [String(slResponse.data.orderId), signal.id] );
                    } else { console.warn(`[LIMIT_ENTRY] Falha criar SL, resposta inválida:`, slResponse); }
                } catch (slError) { console.error(`[LIMIT_ENTRY] Erro ao criar SL:`, slError.response?.data || slError.message); }
            } else { console.warn(`[LIMIT_ENTRY] Preço de SL inválido ou não fornecido (${slPriceVal}). SL não será criado.`); }
            
            const reductionPercentages = [0.10, 0.40, 0.30, 0.10];
            let cumulativeQtyForRps = 0;
            for (let i = 0; i < rpTargetKeys.length; i++) {
                const rpKey = rpTargetKeys[i];
                const rpPrice = targetPrices[rpKey];
                if (rpPrice && rpPrice > 0 && i < reductionPercentages.length) {
                    const reductionPercent = reductionPercentages[i];
                    const reductionQty = parseFloat((totalFilledSize * reductionPercent).toFixed(quantityPrecision));
                    if (reductionQty <= 0) {
                        console.log(`[LIMIT_ENTRY] Quantidade para RP${i+1} (${rpKey}) é zero. Pulando.`);
                        continue;
                    }
                    cumulativeQtyForRps += reductionQty;
                    try {
                        console.log(`[LIMIT_ENTRY] Criando RP${i+1} (${rpKey}): ${reductionQty.toFixed(quantityPrecision)} ${signal.symbol} @ ${rpPrice.toFixed(pricePrecision)}`);
                        const rpResponse = await newReduceOnlyOrder(
                            signal.symbol, reductionQty, binanceOppositeSide, rpPrice.toFixed(pricePrecision)
                        );
                        if (rpResponse && rpResponse.data && rpResponse.data.orderId) {
                            const rpOrderData = { 
                                tipo_ordem: 'LIMIT', preco: rpPrice, quantidade: reductionQty, id_posicao: positionId, status: 'NEW',
                                data_hora_criacao: new Date().toISOString(), id_externo: String(rpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                                simbolo: signal.symbol, tipo_ordem_bot: 'REDUCAO_PARCIAL', target: i + 1, reduce_only: true, close_position: false, orign_sig: `WEBHOOK_${signal.id}`,
                                last_update: new Date().toISOString()
                            };
                            await insertNewOrder(connection, rpOrderData); 
                            console.log(`[LIMIT_ENTRY] RP${i+1} (${rpKey}) criada: ${rpResponse.data.orderId}`);
                        } else { console.warn(`[LIMIT_ENTRY] Falha ao criar RP${i+1}, resposta inválida:`, rpResponse); }
                    } catch (rpError) { console.error(`[LIMIT_ENTRY] Erro ao criar RP${i+1} (${rpKey}):`, rpError.response?.data || rpError.message); }
                }
            }

            const finalTpPrice = targetPrices.tp5;
            const qtyForFinalTpRaw = totalFilledSize - cumulativeQtyForRps;
            const qtyForFinalTp = parseFloat(qtyForFinalTpRaw.toFixed(quantityPrecision));

            if (finalTpPrice && finalTpPrice > 0 && qtyForFinalTp > 0) {
                 try {
                    console.log(`[LIMIT_ENTRY] Criando TP Final (tp5) para quantidade restante: ${qtyForFinalTp.toFixed(quantityPrecision)} ${signal.symbol} @ ${finalTpPrice.toFixed(pricePrecision)}`);
                    const tpResponse = await newStopOrder( 
                        signal.symbol, qtyForFinalTp.toFixed(quantityPrecision), 
                        binanceOppositeSide, finalTpPrice.toFixed(pricePrecision), 
                        finalTpPrice.toFixed(pricePrecision), true, true 
                    );
                    if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
                        const tpOrderData = { 
                            tipo_ordem: 'TAKE_PROFIT_MARKET', preco: finalTpPrice, 
                            quantidade: qtyForFinalTp, 
                            id_posicao: positionId, status: 'NEW',
                            data_hora_criacao: new Date().toISOString(), id_externo: String(tpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                            simbolo: signal.symbol, tipo_ordem_bot: 'TAKE_PROFIT', target: 5, reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: new Date().toISOString()
                        };
                        await insertNewOrder(connection, tpOrderData); 
                        console.log(`[LIMIT_ENTRY] TP Final (tp5) criado: ${tpResponse.data.orderId}`);
                         await connection.query( `UPDATE webhook_signals SET tp_order_id = ? WHERE id = ?`, [String(tpResponse.data.orderId), signal.id] );
                    } else { console.warn(`[LIMIT_ENTRY] Falha ao criar TP Final, resposta inválida:`, tpResponse); }
                } catch (tpError) { console.error(`[LIMIT_ENTRY] Erro ao criar TP Final (tp5):`, tpError.response?.data || tpError.message); }
            } else if (qtyForFinalTp <= 0 && finalTpPrice && finalTpPrice > 0) {
                console.warn(`[LIMIT_ENTRY] TP Final (tp5) não criado pois a quantidade restante após RPs é zero ou negativa (${qtyForFinalTp.toFixed(quantityPrecision)}).`);
            } else if (!finalTpPrice || finalTpPrice <= 0) {
                console.warn(`[LIMIT_ENTRY] Preço do TP Final (tp5/tp_price) inválido (${finalTpPrice}). TP Final não será criado.`);
            }
        } else if (totalFilledSize > 0) { 
            console.warn(`[LIMIT_ENTRY] Entrada NÃO COMPLETAMENTE PREENCHIDA (${(fillRatio * 100).toFixed(1)}% < ${(ENTRY_COMPLETE_THRESHOLD_RATIO*100).toFixed(1)}%). SL/TP/RPs AUTOMÁTICOS NÃO SERÃO CRIADOS para Posição ID: ${positionId}. Requer manejo manual ou configuração de SL/TP fallback!`);
            if (typeof bot !== 'undefined' && signal.chat_id && bot) {
                try {
                    const warningMsg = `⚠️ ATENÇÃO: ${signal.symbol} (Sinal ID: ${signal.id}) aberta PARCIALMENTE (${totalFilledSize.toFixed(quantityPrecision)}/${totalEntrySize.toFixed(quantityPrecision)} - ${(fillRatio * 100).toFixed(1)}%).\n` +
                                       `SL/TP automáticos NÃO foram criados devido ao preenchimento parcial abaixo do limiar. GERENCIE MANUALMENTE!`;
                    const tgOpts = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
                    await bot.telegram.sendMessage(signal.chat_id, warningMsg, tgOpts);
                } catch (tgError) { console.error(`[LIMIT_ENTRY] Erro ao enviar notificação Telegram (parcial sem SL/TP):`, tgError); }
            }
        }
        
        if (typeof bot !== 'undefined' && signal.chat_id && bot) { 
            try {
                // ... (Lógica de notificação do Telegram mantida) ...
                const displaySide = binanceSide === 'BUY' ? 'Compra' : 'Venda';
                const amountInUsdt = totalFilledSize * averageEntryPrice; 
                let tgTargetsMessage = "";
                let tgHasAnyRpListed = false;
                const targetPrices = { 
                    tp1: signal.tp1_price ? parseFloat(signal.tp1_price) : null,
                    tp2: signal.tp2_price ? parseFloat(signal.tp2_price) : null,
                    tp3: signal.tp3_price ? parseFloat(signal.tp3_price) : null,
                    tp4: signal.tp4_price ? parseFloat(signal.tp4_price) : null,
                    tp5: signal.tp5_price ? parseFloat(signal.tp5_price) : (signal.tp_price ? parseFloat(signal.tp_price) : null) 
                };
                const reductionPercentages = [0.10, 0.40, 0.30, 0.10]; 

                rpTargetKeys.forEach((key, index) => {
                    const price = targetPrices[key];
                    if (price && price > 0 && index < reductionPercentages.length && slTpRpsCreated) { 
                        const percent = reductionPercentages[index] * 100;
                        tgTargetsMessage += `RP${index+1} (${percent}%): ${price.toFixed(pricePrecision)}\n`;
                        tgHasAnyRpListed = true;
                    }
                });
                const tgFinalTpDisplay = targetPrices.tp5;
                if (tgFinalTpDisplay && tgFinalTpDisplay > 0 && slTpRpsCreated) { 
                    tgTargetsMessage += `Take Profit Final: ${tgFinalTpDisplay.toFixed(pricePrecision)}\n`;
                } else if (!tgHasAnyRpListed && slTpRpsCreated) {
                    tgTargetsMessage = "Alvos de TP não definidos no sinal (ou não criados).\n";
                }
                 if (!slTpRpsCreated) {
                     tgTargetsMessage = "Nenhum Take Profit/Redução Parcial programado automaticamente.\n";
                 }

                let slTpMessage = "";
                if (slTpRpsCreated) {
                    const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
                    slTpMessage = `Alvos Programados:\n${tgTargetsMessage}\nStop Loss: ${slPriceVal ? slPriceVal.toFixed(pricePrecision) : 'N/A (não definido ou não criado)'}\n`;
                } else {
                    slTpMessage = "SL/TP/RPs automáticos NÃO configurados (entrada parcial ou falha na criação).\n";
                }

                const telegramOptions = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
                
                await bot.telegram.sendMessage(signal.chat_id,
                    `✅ Entrada ${slTpRpsCreated && fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO ? 'LIMIT MAKER' : `LIMIT MAKER (${fillRatio >= ENTRY_COMPLETE_THRESHOLD_RATIO ? 'COMPLETA' : 'PARCIAL'})`} realizada em ${signal.symbol} \n(Sinal ID: ${signal.id}, Posição DB ID: ${positionId})\n\n` +
                    `Direção: ${displaySide}\nAlavancagem: ${leverage}x\n` +
                    `Valor Aprox. (USDT): ${amountInUsdt.toFixed(2)}\n`+
                    `Qtd. Executada: ${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol.replace('USDT', '')} (${(fillRatio*100).toFixed(1)}% da meta)\n` +
                    `Preço Médio Entrada: ${averageEntryPrice.toFixed(pricePrecision)}\n\n` +
                    slTpMessage,
                    telegramOptions
                );
                console.log(`[LIMIT_ENTRY] Notificação Telegram final enviada para Sinal ID ${signal.id}`);

            } catch (telegramError) { console.error(`[LIMIT_ENTRY] Erro ao enviar notificação Telegram final:`, telegramError); }
        }
        
        await connection.commit();
        console.log(`[LIMIT_ENTRY] Transação COMMITADA. Sucesso para Sinal ID ${signal.id}`);
        
        if (typeof syncAccountBalance !== 'undefined') { 
            try { await syncAccountBalance(); } catch (e) { console.error(`[LIMIT_ENTRY] Erro ao executar syncAccountBalance: ${e.message}`); }
        }
        
        return {
            success: true, positionId, averagePrice: averageEntryPrice, filledQuantity: totalFilledSize, 
            partialWarning: !slTpRpsCreated && totalFilledSize > 0 && fillRatio < ENTRY_COMPLETE_THRESHOLD_RATIO
        };
        
    } catch (error) { 
        // ... (Bloco catch principal e lógica de recuperação MANTIDOS) ...
         const originalErrorMessage = error.message || String(error);
        console.error(`[LIMIT_ENTRY] ERRO FATAL DURANTE ENTRADA (Sinal ID ${signal.id}): ${originalErrorMessage}`, error.stack || error);
        
        if (positionId && totalFilledSize > 0 && averageEntryPrice > 0) { 
            console.warn(`[LIMIT_ENTRY_RECOVERY] Tentando SALVAR POSIÇÃO ${positionId} (${totalFilledSize.toFixed(quantityPrecision)} ${signal.symbol} @ ${averageEntryPrice.toFixed(pricePrecision)}) e enviar SL/TP de emergência devido ao erro: ${originalErrorMessage}`);
            try {
                const binanceOppositeSide = binanceSide === 'BUY' ? 'SELL' : 'BUY';
                const slPriceVal = signal.sl_price ? parseFloat(signal.sl_price) : null;
                
                if (slPriceVal && slPriceVal > 0) {
                    console.log(`[LIMIT_ENTRY_RECOVERY] Enviando SL de emergência: ${totalFilledSize.toFixed(quantityPrecision)} @ ${slPriceVal.toFixed(pricePrecision)}`);
                    const slResponse = await newStopOrder( 
                        signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                        binanceOppositeSide, slPriceVal.toFixed(pricePrecision), null, true, true 
                    );
                    if (slResponse && slResponse.data && slResponse.data.orderId) {
                        const slOrderData = { 
                            tipo_ordem: 'STOP_MARKET', preco: slPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW', 
                            data_hora_criacao: new Date().toISOString(), id_externo: String(slResponse.data.orderId).substring(0,90), side: binanceOppositeSide, 
                            simbolo: signal.symbol, tipo_ordem_bot: 'STOP_LOSS', reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: new Date().toISOString(), target: null, observacao: 'SL Enviado em Recuperação de Erro'
                        };
                        await insertNewOrder(connection, slOrderData); 
                        console.log(`[LIMIT_ENTRY_RECOVERY] SL de emergência (recuperação) criado: ${slResponse.data.orderId}`);
                        await connection.query( `UPDATE webhook_signals SET sl_order_id = ?, status = 'EXECUTADO_COM_AVISO_RECUPERACAO', error_message = LEFT(CONCAT('Recuperação: ', ?, error_message), 250) WHERE id = ? AND position_id = ?`, 
                                                [String(slResponse.data.orderId), `Erro: ${originalErrorMessage}. Posição salva, SL emergência tentado.`, signal.id, positionId] );
                    } else { console.error(`[LIMIT_ENTRY_RECOVERY] Falha ao criar SL de emergência (recuperação). Resposta inválida:`, slResponse); }
                } else { console.warn(`[LIMIT_ENTRY_RECOVERY] SL de emergência inválido (${slPriceVal}). Não enviado.`); }

                const finalTpPriceVal = signal.tp_price ? parseFloat(signal.tp_price) : (signal.tp5_price ? parseFloat(signal.tp5_price) : null);
                if (finalTpPriceVal && finalTpPriceVal > 0) {
                    console.log(`[LIMIT_ENTRY_RECOVERY] Enviando TP Final de emergência: ${totalFilledSize.toFixed(quantityPrecision)} @ ${finalTpPriceVal.toFixed(pricePrecision)}`);
                     const tpResponse = await newStopOrder( 
                        signal.symbol, totalFilledSize.toFixed(quantityPrecision), 
                        binanceOppositeSide, finalTpPriceVal.toFixed(pricePrecision),
                        finalTpPriceVal.toFixed(pricePrecision), true, true 
                    );
                    if (tpResponse && tpResponse.data && tpResponse.data.orderId) {
                        const tpOrderData = {
                            tipo_ordem: 'TAKE_PROFIT_MARKET', preco: finalTpPriceVal, quantidade: totalFilledSize, id_posicao: positionId, status: 'NEW',
                            data_hora_criacao: new Date().toISOString(), id_externo: String(tpResponse.data.orderId).substring(0,90), side: binanceOppositeSide,
                            simbolo: signal.symbol, tipo_ordem_bot: 'TAKE_PROFIT', target: 5, reduce_only: true, close_position: true, orign_sig: `WEBHOOK_${signal.id}`,
                            last_update: new Date().toISOString(), observacao: 'TP Enviado em Recuperação de Erro'
                        };
                        await insertNewOrder(connection, tpOrderData); 
                        console.log(`[LIMIT_ENTRY_RECOVERY] TP de emergência (recuperação) criado: ${tpResponse.data.orderId}`);
                        await connection.query( `UPDATE webhook_signals SET tp_order_id = ?, status = 'EXECUTADO_COM_AVISO_RECUPERACAO', error_message = LEFT(CONCAT('Recuperação: ', ?, error_message), 250) WHERE id = ? AND position_id = ?`, 
                                                [String(tpResponse.data.orderId), `Erro: ${originalErrorMessage}. Posição salva, SL/TP emergência tentados.`, signal.id, positionId] );
                    } else { console.error(`[LIMIT_ENTRY_RECOVERY] Falha criar TP de emergência (recuperação). Resposta inválida:`, tpResponse); }
                } else { console.warn(`[LIMIT_ENTRY_RECOVERY] TP Final de emergência inválido. Não enviado.`); }
                
                await connection.commit(); 
                console.warn(`[LIMIT_ENTRY_RECOVERY] Posição ${positionId} SALVA e SL/TP de emergência tentados. Erro original: ${originalErrorMessage}`);
                
                if (typeof bot !== 'undefined' && signal.chat_id && bot) {
                    await bot.telegram.sendMessage(signal.chat_id, `⚠️ Posição ${signal.symbol} (Sinal ${signal.id}, Posição DB ID: ${positionId}) aberta, mas com erro (${originalErrorMessage}).\nSL/TP de EMERGÊNCIA foram tentados. VERIFIQUE IMEDIATAMENTE!`);
                }
                return {
                    success: true, positionId, averagePrice: averageEntryPrice, filledQuantity: totalFilledSize,
                    warning: `Erro durante entrada: ${originalErrorMessage}. Posição salva e SL/TP de emergência foram tentados.`
                };
            } catch (recoveryError) {
                console.error(`[LIMIT_ENTRY_RECOVERY] ERRO CRÍTICO NA LÓGICA DE RECUPERAÇÃO (SL/TP):`, recoveryError.message, recoveryError.stack);
                if (connection) { 
                    try { await connection.rollback(); console.log('[LIMIT_ENTRY_RECOVERY] Rollback da recuperação tentado.'); }
                    catch (rbRecoveryErr) { console.error('[LIMIT_ENTRY_RECOVERY] Erro no rollback da recuperação:', rbRecoveryErr); }
                }
            }
        }
        
        if (activeOrderId) { 
            try { 
                console.log(`[LIMIT_ENTRY] (Catch Principal) Tentando cancelar ordem ativa ${activeOrderId} antes do rollback.`);
                await cancelOrder(activeOrderId, signal.symbol); 
                console.log(`[LIMIT_ENTRY] (Catch Principal) Ordem ${activeOrderId} cancelada com sucesso.`);
            } catch (cancelErrOnCatch) { 
                console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao cancelar ordem ${activeOrderId}:`, cancelErrOnCatch.message); 
            }
        }
        
        if (connection) { 
            try { 
                await connection.rollback(); 
                console.log(`[LIMIT_ENTRY] (Catch Principal) ROLLBACK da transação principal efetuado para Sinal ${signal.id}.`); 
            } catch (rbErr) { 
                console.error(`[LIMIT_ENTRY] (Catch Principal) Erro CRÍTICO ao efetuar ROLLBACK para Sinal ${signal.id}:`, rbErr); 
            }
        }
        
        try {
            await db.query( 
                `UPDATE webhook_signals SET status = 'ERROR', error_message = ? WHERE id = ?`,
                [String(originalErrorMessage).substring(0, 250), signal.id]
            );
        } catch (updateError) { 
            console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao atualizar status do sinal para ERROR no DB:`, updateError); 
        }
        
        if (typeof bot !== 'undefined' && signal.chat_id && bot) { 
            try {
                const tgOptsOnError = signal.message_id ? { reply_to_message_id: signal.message_id } : {};
                await bot.telegram.sendMessage(signal.chat_id,
                    `❌ Erro CRÍTICO ao tentar abrir posição LIMIT MAKER para ${signal.symbol} (Sinal ID: ${signal.id})\nMotivo: ${originalErrorMessage}`, tgOptsOnError );
            } catch (tgError) { console.error(`[LIMIT_ENTRY] (Catch Principal) Erro ao notificar Telegram sobre falha:`, tgError); }
        }
        return { success: false, error: originalErrorMessage };

    } finally {
        // --- INÍCIO: Fechamento do WebSocket de Profundidade ---
        if (depthWs) {
            console.log(`[LIMIT_ENTRY] Fechando WebSocket de profundidade para ${signal.symbol} no bloco finally.`);
            try {
                depthWs.close();
            } catch (wsCloseError) {
                console.error(`[LIMIT_ENTRY] Erro ao fechar WebSocket de profundidade para ${signal.symbol} no finally: ${wsCloseError.message}`);
            }
        }
        // --- FIM: Fechamento do WebSocket de Profundidade ---
        if (connection) {
            connection.release();
        }
    }
}

// ... (funções auxiliares como calculateAveragePrice, waitForOrderExecution mock)
// Assegure-se que as funções auxiliares estão corretas e completas.

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price) && qty > 0) { // Adicionada verificação qty > 0
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

async function waitForOrderExecution(symbol, orderId, maxWaitMs = 6000) {
  if (!orderId) {
    console.log(`[WAIT_ORDER] OrderId inválido: ${orderId}`);
    return { status: 'UNKNOWN', executedQty: 0 };
  }

  const startTime = Date.now();
  let lastStatus = null;
  
  try {
    // Tentar obter status imediatamente
    try {
      const initialStatus = await getOrderStatus(symbol, orderId);
      if (initialStatus.status === 'FILLED' || initialStatus.status === 'PARTIALLY_FILLED') {
        console.log(`[WAIT_ORDER] Ordem ${orderId} já está ${initialStatus.status}`);
        return initialStatus;
      }
      lastStatus = initialStatus;
    } catch (initialError) {
      console.log(`[WAIT_ORDER] Erro inicial ao verificar ordem ${orderId}: ${initialError.message}`);
    }
    
    // Usar algoritmo de espera adaptativa
    let waitTime = 300; // Começa com 300ms
    
    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
      
      try {
        const orderStatus = await getOrderStatus(symbol, orderId);
        lastStatus = orderStatus;
        
        // Se a ordem foi preenchida ou cancelada, retornar imediatamente
        if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(orderStatus.status)) {
          console.log(`[WAIT_ORDER] Ordem ${orderId} com status ${orderStatus.status}`);
          return orderStatus;
        }
        
        // Aumentar ligeiramente o tempo de espera, max 800ms
        waitTime = Math.min(waitTime * 1.5, 800);
      } catch (error) {
        console.log(`[WAIT_ORDER] Erro ao verificar ordem ${orderId}: ${error.message}`);
        // Diminuir tempo de espera para tentar mais vezes
        waitTime = Math.max(waitTime / 2, 200);
      }
    }
    
    // Timeout atingido
    console.log(`[WAIT_ORDER] Timeout para ordem ${orderId} (${maxWaitMs}ms)`);
    return lastStatus || { status: 'TIMEOUT', executedQty: 0 };
  } catch (error) {
    console.error(`[WAIT_ORDER] Erro crítico ao aguardar ordem ${orderId}: ${error.message}`);
    return lastStatus || { status: 'ERROR', executedQty: 0, error: error.message };
  }
}

// ... (funções auxiliares como calculateAveragePrice, waitForOrderExecution mock)
// Assegure-se que as funções auxiliares estão corretas e completas.

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price) && qty > 0) { // Adicionada verificação qty > 0
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para aguardar execução da ordem (MOCK - SUBSTITUA PELA SUA IMPLEMENTAÇÃO REAL)
// ESSENCIAL: Sua função real getOrderStatus deve retornar o objeto completo da ordem, não apenas a string do status.
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    return new Promise(async (resolve) => {
        if (!orderId) {
            resolve({ status: 'NO_ORDER_ID', executedQty: 0, price: 0, orderId: null, avgPrice: 0, cummulativeQuoteQty: 0 });
            return;
        }

        const checkInterval = Math.min(Math.max(timeoutMs / 4, 500), 2000); // Intervalo entre 0.5s e 2s, no máximo 4 checagens
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            try {
                // ESTA FUNÇÃO PRECISA RETORNAR O OBJETO COMPLETO DA ORDEM DA BINANCE
                const orderStatusFull = await getOrderStatus(orderId, symbol); 

                if (orderStatusFull) { 
                    const status = orderStatusFull.status;
                    const executedQty = parseFloat(orderStatusFull.executedQty || 0);
                    const avgPrice = parseFloat(orderStatusFull.avgPrice || 0); // avgPrice é o preço médio de execução
                    const price = parseFloat(orderStatusFull.price || 0); // Preço da ordem original
                    const cummulativeQuoteQty = parseFloat(orderStatusFull.cummulativeQuoteQty || 0);
                    const orderIdFromStatus = orderStatusFull.orderId;

                    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status)) {
                        clearInterval(intervalId);
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'PARTIALLY_FILLED') {
                        // Para parcial, resolve para que o loop principal possa processar o preenchimento
                        clearInterval(intervalId); // Resolve imediatamente com o estado parcial
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'NEW' || status === 'PENDING_CANCEL') {
                        // Continua esperando se NEW
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Status nulo para ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro buscar status ${orderId}: ${error.message}`);
            }

            elapsedTime += checkInterval;
            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({ 
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS', 
                            executedQty: parseFloat(finalOrderStatus.executedQty || 0), 
                            price: parseFloat(finalOrderStatus.avgPrice || finalOrderStatus.price || 0), 
                            orderId: finalOrderStatus.orderId,
                            avgPrice: parseFloat(finalOrderStatus.avgPrice || 0),
                            cummulativeQuoteQty: parseFloat(finalOrderStatus.cummulativeQuoteQty || 0)
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        await checker(); 
    });
}

// ... (funções auxiliares como calculateAveragePrice, waitForOrderExecution mock)
// Assegure-se que as funções auxiliares estão corretas e completas.

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price) && qty > 0) { // Adicionada verificação qty > 0
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para aguardar execução da ordem (MOCK - SUBSTITUA PELA SUA IMPLEMENTAÇÃO REAL)
// ESSENCIAL: Sua função real getOrderStatus deve retornar o objeto completo da ordem, não apenas a string do status.
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    return new Promise(async (resolve) => {
        if (!orderId) {
            resolve({ status: 'NO_ORDER_ID', executedQty: 0, price: 0, orderId: null, avgPrice: 0, cummulativeQuoteQty: 0 });
            return;
        }

        const checkInterval = Math.min(Math.max(timeoutMs / 4, 500), 2000); // Intervalo entre 0.5s e 2s, no máximo 4 checagens
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            try {
                // ESTA FUNÇÃO PRECISA RETORNAR O OBJETO COMPLETO DA ORDEM DA BINANCE
                const orderStatusFull = await getOrderStatus(orderId, symbol); 

                if (orderStatusFull) { 
                    const status = orderStatusFull.status;
                    const executedQty = parseFloat(orderStatusFull.executedQty || 0);
                    const avgPrice = parseFloat(orderStatusFull.avgPrice || 0); // avgPrice é o preço médio de execução
                    const price = parseFloat(orderStatusFull.price || 0); // Preço da ordem original
                    const cummulativeQuoteQty = parseFloat(orderStatusFull.cummulativeQuoteQty || 0);
                    const orderIdFromStatus = orderStatusFull.orderId;

                    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status)) {
                        clearInterval(intervalId);
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'PARTIALLY_FILLED') {
                        // Para parcial, resolve para que o loop principal possa processar o preenchimento
                        clearInterval(intervalId); // Resolve imediatamente com o estado parcial
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'NEW' || status === 'PENDING_CANCEL') {
                        // Continua esperando se NEW
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Status nulo para ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro buscar status ${orderId}: ${error.message}`);
            }

            elapsedTime += checkInterval;
            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({ 
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS', 
                            executedQty: parseFloat(finalOrderStatus.executedQty || 0), 
                            price: parseFloat(finalOrderStatus.avgPrice || finalOrderStatus.price || 0), 
                            orderId: finalOrderStatus.orderId,
                            avgPrice: parseFloat(finalOrderStatus.avgPrice || 0),
                            cummulativeQuoteQty: parseFloat(finalOrderStatus.cummulativeQuoteQty || 0)
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        await checker(); 
    });
}

// ... (funções auxiliares como calculateAveragePrice, waitForOrderExecution mock)
// Assegure-se que as funções auxiliares estão corretas e completas.

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price) && qty > 0) { // Adicionada verificação qty > 0
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para aguardar execução da ordem (MOCK - SUBSTITUA PELA SUA IMPLEMENTAÇÃO REAL)
// ESSENCIAL: Sua função real getOrderStatus deve retornar o objeto completo da ordem, não apenas a string do status.
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    return new Promise(async (resolve) => {
        if (!orderId) {
            resolve({ status: 'NO_ORDER_ID', executedQty: 0, price: 0, orderId: null, avgPrice: 0, cummulativeQuoteQty: 0 });
            return;
        }

        const checkInterval = Math.min(Math.max(timeoutMs / 4, 500), 2000); // Intervalo entre 0.5s e 2s, no máximo 4 checagens
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            try {
                // ESTA FUNÇÃO PRECISA RETORNAR O OBJETO COMPLETO DA ORDEM DA BINANCE
                const orderStatusFull = await getOrderStatus(orderId, symbol); 

                if (orderStatusFull) { 
                    const status = orderStatusFull.status;
                    const executedQty = parseFloat(orderStatusFull.executedQty || 0);
                    const avgPrice = parseFloat(orderStatusFull.avgPrice || 0); // avgPrice é o preço médio de execução
                    const price = parseFloat(orderStatusFull.price || 0); // Preço da ordem original
                    const cummulativeQuoteQty = parseFloat(orderStatusFull.cummulativeQuoteQty || 0);
                    const orderIdFromStatus = orderStatusFull.orderId;

                    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status)) {
                        clearInterval(intervalId);
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'PARTIALLY_FILLED') {
                        // Para parcial, resolve para que o loop principal possa processar o preenchimento
                        clearInterval(intervalId); // Resolve imediatamente com o estado parcial
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'NEW' || status === 'PENDING_CANCEL') {
                        // Continua esperando se NEW
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Status nulo para ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro buscar status ${orderId}: ${error.message}`);
            }

            elapsedTime += checkInterval;
            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({ 
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS', 
                            executedQty: parseFloat(finalOrderStatus.executedQty || 0), 
                            price: parseFloat(finalOrderStatus.avgPrice || finalOrderStatus.price || 0), 
                            orderId: finalOrderStatus.orderId,
                            avgPrice: parseFloat(finalOrderStatus.avgPrice || 0),
                            cummulativeQuoteQty: parseFloat(finalOrderStatus.cummulativeQuoteQty || 0)
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        await checker(); 
    });
}

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price) && qty > 0) { // Adicionada verificação qty > 0
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para aguardar execução da ordem (MOCK - SUBSTITUA PELA SUA IMPLEMENTAÇÃO REAL)
// ESSENCIAL: Sua função real getOrderStatus deve retornar o objeto completo da ordem, não apenas a string do status.
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    return new Promise(async (resolve) => {
        if (!orderId) {
            resolve({ status: 'NO_ORDER_ID', executedQty: 0, price: 0, orderId: null, avgPrice: 0, cummulativeQuoteQty: 0 });
            return;
        }

        const checkInterval = Math.min(Math.max(timeoutMs / 4, 500), 2000); // Intervalo entre 0.5s e 2s, no máximo 4 checagens
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            try {
                // ESTA FUNÇÃO PRECISA RETORNAR O OBJETO COMPLETO DA ORDEM DA BINANCE
                const orderStatusFull = await getOrderStatus(orderId, symbol); 

                if (orderStatusFull) { 
                    const status = orderStatusFull.status;
                    const executedQty = parseFloat(orderStatusFull.executedQty || 0);
                    const avgPrice = parseFloat(orderStatusFull.avgPrice || 0); // avgPrice é o preço médio de execução
                    const price = parseFloat(orderStatusFull.price || 0); // Preço da ordem original
                    const cummulativeQuoteQty = parseFloat(orderStatusFull.cummulativeQuoteQty || 0);
                    const orderIdFromStatus = orderStatusFull.orderId;

                    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(status)) {
                        clearInterval(intervalId);
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'PARTIALLY_FILLED') {
                        // Para parcial, resolve para que o loop principal possa processar o preenchimento
                        clearInterval(intervalId); // Resolve imediatamente com o estado parcial
                        resolve({ status, executedQty, price: avgPrice || price, orderId: orderIdFromStatus, avgPrice, cummulativeQuoteQty });
                        return;
                    } else if (status === 'NEW' || status === 'PENDING_CANCEL') {
                        // Continua esperando se NEW
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Status nulo para ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro buscar status ${orderId}: ${error.message}`);
            }

            elapsedTime += checkInterval;
            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({ 
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS', 
                            executedQty: parseFloat(finalOrderStatus.executedQty || 0), 
                            price: parseFloat(finalOrderStatus.avgPrice || finalOrderStatus.price || 0), 
                            orderId: finalOrderStatus.orderId,
                            avgPrice: parseFloat(finalOrderStatus.avgPrice || 0),
                            cummulativeQuoteQty: parseFloat(finalOrderStatus.cummulativeQuoteQty || 0)
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        await checker(); 
    });
}

// Função auxiliar para calcular preço médio
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        const qty = parseFloat(fill.qty);
        const price = parseFloat(fill.price);
        if (!isNaN(qty) && !isNaN(price)) {
            totalQty += qty;
            totalCost += qty * price;
        }
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para aguardar execução da ordem (MOCK - SUBSTITUA PELA SUA IMPLEMENTAÇÃO REAL)
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    return new Promise(async (resolve) => {
        if (!orderId) {
            // console.warn("[MOCK_WAIT] OrderId nulo fornecido para waitForOrderExecution.");
            resolve({ status: 'NO_ORDER_ID', executedQty: 0, price: 0, orderId: null, avgPrice: 0, cummulativeQuoteQty: 0 });
            return;
        }

        const checkInterval = Math.min(timeoutMs / 3, 1500); 
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            try {
                const orderStatusFull = await getOrderStatus(orderId, symbol); // Deve retornar o objeto completo da ordem

                if (orderStatusFull) { 
                    if (['FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(orderStatusFull.status)) {
                        clearInterval(intervalId);
                        resolve({
                            status: orderStatusFull.status,
                            executedQty: parseFloat(orderStatusFull.executedQty || 0),
                            price: parseFloat(orderStatusFull.avgPrice || orderStatusFull.price || 0), 
                            orderId: orderStatusFull.orderId,
                            avgPrice: parseFloat(orderStatusFull.avgPrice || 0), 
                            cummulativeQuoteQty: parseFloat(orderStatusFull.cummulativeQuoteQty || 0)
                        });
                        return;
                    } else if (orderStatusFull.status === 'PARTIALLY_FILLED' || orderStatusFull.status === 'NEW' || orderStatusFull.status === 'PENDING_CANCEL') {
                        // Para PARTIALLY_FILLED, também resolvemos para que o loop principal possa processar.
                        // Para NEW, o loop principal continuará monitorando ou editando.
                         if (orderStatusFull.status === 'PARTIALLY_FILLED' && elapsedTime >= timeoutMs / 2) { // Resolve antes se parcial e já esperou um pouco
                            clearInterval(intervalId);
                            resolve({ /* ... dados da ordem ... */ ...orderStatusFull, executedQty: parseFloat(orderStatusFull.executedQty), price: parseFloat(orderStatusFull.avgPrice || orderStatusFull.price) });
                            return;
                         }
                        // console.log(`[MOCK_WAIT] Ordem ${orderId} status: ${orderStatusFull.status}`);
                    } else {
                         // console.log(`[MOCK_WAIT] Ordem ${orderId} status inesperado: ${orderStatusFull.status}`);
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Status nulo para ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro ao buscar status da ordem ${orderId}: ${error.message}`);
                // Não limpar intervalo aqui, pode ser erro de rede temporário
            }

            elapsedTime += checkInterval;
            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                // console.warn(`[MOCK_WAIT] Timeout para ordem ${orderId}. Obtendo status final...`);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({ /* ... dados da ordem ... */ ...finalOrderStatus, executedQty: parseFloat(finalOrderStatus.executedQty), price: parseFloat(finalOrderStatus.avgPrice || finalOrderStatus.price) });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        await checker(); // Executa imediatamente uma vez
    });
}

// Função auxiliar para calcular preço médio (você já deve ter algo similar)
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        totalQty += parseFloat(fill.qty);
        totalCost += parseFloat(fill.qty) * parseFloat(fill.price);
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para simular waitForOrderExecution (substitua pela sua implementação real com WebSockets ou polling mais robusto)
// ESTA É UMA SIMULAÇÃO E PRECISA SER SUBSTITUÍDA PELA SUA LÓGICA REAL DE WEBSOCKET/POLLING
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    // console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    
    return new Promise(async (resolve) => {
        const checkInterval = Math.min(timeoutMs / 2, 1000); 
        let elapsedTime = 0;
        let intervalId;

        const checker = async () => {
            elapsedTime += checkInterval;
            try {
                const orderStatus = await getOrderStatus(orderId, symbol); 

                if (orderStatus) { 
                    if (['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(orderStatus.status)) {
                        clearInterval(intervalId);
                        // console.log(`[MOCK_WAIT] Ordem ${orderId} com status final: ${orderStatus.status}`);
                        resolve({
                            status: orderStatus.status,
                            executedQty: orderStatus.executedQty || 0,
                            price: orderStatus.avgPrice || orderStatus.price || 0, 
                            orderId: orderStatus.orderId,
                            avgPrice: orderStatus.avgPrice || 0, // Adicionado para consistência
                            cummulativeQuoteQty: orderStatus.cummulativeQuoteQty || 0 // Adicionado
                        });
                        return;
                    } else if (orderStatus.status === 'NEW' || orderStatus.status === 'PENDING_CANCEL') {
                        // console.log(`[MOCK_WAIT] Ordem ${orderId} ainda com status: ${orderStatus.status}`);
                    } else {
                         // console.log(`[MOCK_WAIT] Ordem ${orderId} com status desconhecido/inesperado: ${orderStatus.status}`);
                    }
                } else {
                    // console.warn(`[MOCK_WAIT] Não foi possível obter status da ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro ao buscar status da ordem ${orderId}: ${error.message}`);
            }

            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                // console.warn(`[MOCK_WAIT] Timeout esperando pela ordem ${orderId}. Tentando obter status final...`);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); 
                    if (finalOrderStatus) {
                         resolve({
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS',
                            executedQty: finalOrderStatus.executedQty || 0,
                            price: finalOrderStatus.avgPrice || finalOrderStatus.price || 0,
                            orderId: finalOrderStatus.orderId,
                            avgPrice: finalOrderStatus.avgPrice || 0,
                            cummulativeQuoteQty: finalOrderStatus.cummulativeQuoteQty || 0
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId, avgPrice: 0, cummulativeQuoteQty: 0 });
                }
            }
        };
        intervalId = setInterval(checker, checkInterval);
        checker(); // Executa imediatamente uma vez
    });
}

// Função auxiliar para calcular preço médio (você já deve ter algo similar)
function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    let totalQty = 0;
    let totalCost = 0;
    fills.forEach(fill => {
        totalQty += parseFloat(fill.qty);
        totalCost += parseFloat(fill.qty) * parseFloat(fill.price);
    });
    return totalQty > 0 ? totalCost / totalQty : 0;
}

// Função auxiliar para simular waitForOrderExecution (substitua pela sua implementação real com WebSockets ou polling mais robusto)
// ESTA É UMA SIMULAÇÃO E PRECISA SER SUBSTITUÍDA PELA SUA LÓGICA REAL DE WEBSOCKET/POLLING
async function waitForOrderExecution(symbol, orderId, timeoutMs) {
    console.log(`[MOCK_WAIT] Aguardando execução da ordem ${orderId} para ${symbol} (Timeout: ${timeoutMs}ms)`);
    // Na sua implementação real, você ouviria os WebSockets ou faria polling na API da Binance.
    // Para este exemplo, vamos apenas simular buscando o status da ordem após um delay.
    
    return new Promise(async (resolve) => {
        const checkInterval = Math.min(timeoutMs / 2, 1000); // Verificar no máximo a cada 1s ou na metade do timeout
        let elapsedTime = 0;

        const intervalId = setInterval(async () => {
            elapsedTime += checkInterval;
            try {
                const orderStatus = await getOrderStatus(orderId, symbol); // Sua função de api.js //

                if (orderStatus) { // Se getOrderStatus retorna um objeto com a ordem
                    if (['FILLED', 'PARTIALLY_FILLED', 'CANCELED', 'REJECTED', 'EXPIRED'].includes(orderStatus.status)) {
                        clearInterval(intervalId);
                        console.log(`[MOCK_WAIT] Ordem ${orderId} com status final: ${orderStatus.status}`);
                        resolve({
                            status: orderStatus.status,
                            executedQty: orderStatus.executedQty || 0,
                            price: orderStatus.avgPrice || orderStatus.price || 0, // ou cummulativeQuoteQty / executedQty
                            orderId: orderStatus.orderId,
                            // Adicione mais campos relevantes da resposta da ordem
                        });
                        return;
                    } else if (orderStatus.status === 'NEW' || orderStatus.status === 'PENDING_CANCEL') {
                        console.log(`[MOCK_WAIT] Ordem ${orderId} ainda com status: ${orderStatus.status}`);
                    } else {
                         console.log(`[MOCK_WAIT] Ordem ${orderId} com status desconhecido/inesperado: ${orderStatus.status}`);
                    }
                } else {
                    console.warn(`[MOCK_WAIT] Não foi possível obter status da ordem ${orderId}.`);
                }
            } catch (error) {
                console.error(`[MOCK_WAIT] Erro ao buscar status da ordem ${orderId}: ${error.message}`);
                // Não limpar intervalo em caso de erro de busca, pode ser temporário
            }

            if (elapsedTime >= timeoutMs) {
                clearInterval(intervalId);
                console.warn(`[MOCK_WAIT] Timeout esperando pela ordem ${orderId}. Tentando obter status final...`);
                try {
                    const finalOrderStatus = await getOrderStatus(orderId, symbol); //
                    if (finalOrderStatus) {
                         resolve({
                            status: finalOrderStatus.status || 'TIMED_OUT_UNKNOWN_STATUS',
                            executedQty: finalOrderStatus.executedQty || 0,
                            price: finalOrderStatus.avgPrice || finalOrderStatus.price || 0,
                            orderId: finalOrderStatus.orderId,
                        });
                    } else {
                         resolve({ status: 'TIMED_OUT_NO_INFO', executedQty: 0, price: 0, orderId: orderId });
                    }
                } catch (e) {
                     resolve({ status: 'TIMED_OUT_API_ERROR', executedQty: 0, price: 0, orderId: orderId });
                }
            }
        }, checkInterval);
    });
}

function calculateAveragePrice(fills) {
    if (!fills || fills.length === 0) return 0;
    
    let totalQuantity = 0;
    let totalValue = 0;
    
    for (const fill of fills) {
        totalQuantity += fill.qty;
        totalValue += fill.qty * fill.price;
    }
    
    return totalQuantity > 0 ? totalValue / totalQuantity : 0;
}

// Função para obter dados do livro de ordens (BookTicker)
async function getBookTicker(symbol) {
  try {
    // Usar um timeout mais curto para evitar bloqueios longos
    const url = `${process.env.API_URL}/v1/ticker/bookTicker?symbol=${symbol}`;
    const response = await axios.get(url, { 
      timeout: 2000, // Timeout de 2 segundos
      headers: { 'Cache-Control': 'no-cache' } // Evitar cache
    });
    
    if (!response.data || !response.data.bidPrice || !response.data.askPrice) {
      throw new Error(`Dados do bookTicker inválidos para ${symbol}`);
    }
    
    return {
      bidPrice: response.data.bidPrice,
      askPrice: response.data.askPrice,
      bidQty: response.data.bidQty,
      askQty: response.data.askQty,
      timestamp: Date.now()
    };
  } catch (error) {
    console.error(`[BOOK] Erro ao obter book ticker para ${symbol}: ${error.message}`);
    
    // Implementar fallback para situações de erro
    // Tentar obter o preço de outra fonte se disponível
    try {
      console.log(`[BOOK] Tentando fallback para ${symbol}...`);
      const fallbackUrl = `${process.env.API_URL}/v1/ticker/price?symbol=${symbol}`;
      const fallbackResponse = await axios.get(fallbackUrl, { timeout: 2000 });
      
      if (fallbackResponse.data && fallbackResponse.data.price) {
        const price = parseFloat(fallbackResponse.data.price);
        // Criar um book ticker aproximado com o preço atual
        return {
          bidPrice: (price * 0.9999).toString(), // 0.01% abaixo do preço
          askPrice: (price * 1.0001).toString(), // 0.01% acima do preço
          bidQty: "0",
          askQty: "0",
          timestamp: Date.now(),
          isApproximation: true
        };
      }
    } catch (fallbackError) {
      console.error(`[BOOK] Fallback também falhou para ${symbol}: ${fallbackError.message}`);
    }
    
    throw error; // Re-lançar o erro original se o fallback também falhar
  }
}
// Função otimizada para aguardar a execução de uma ordem
async function waitForOrderExecution(symbol, orderId, maxWaitMs = 3000) {
    const startTime = Date.now();
    
    // Verificar imediatamente o status da ordem (sem espera inicial)
    try {
        const orderStatus = await getOrderStatus(symbol, orderId);
        
        // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
        if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
            return orderStatus;
        }
    } catch (initialError) {
        // Ignorar erro inicial, continuará o loop abaixo
    }
    
    // Loop de espera com intervalos mais curtos
    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Verificar status da ordem
            const orderStatus = await getOrderStatus(symbol, orderId);
            
            // Se a ordem foi executada (total ou parcialmente), retornar imediatamente
            if (orderStatus.status === 'FILLED' || orderStatus.status === 'PARTIALLY_FILLED') {
                return orderStatus;
            }
            
            // Aguardar um período muito curto antes de verificar novamente
            await new Promise(resolve => setTimeout(resolve, 100)); // Reduzido para 100ms
            
        } catch (error) {
            // Se a ordem não for encontrada, verificar se foi executada
            if (error.response && error.response.status === 404) {
                try {
                    const recentOrders = await getRecentOrders(symbol, 5); // Buscar apenas as 5 mais recentes
                    const matchingOrder = recentOrders.find(order => String(order.orderId) === String(orderId));
                    if (matchingOrder) {
                        return matchingOrder;
                    }
                } catch (detailsError) {
                    // Ignorar erro
                }
            }
            
            // Aguardar antes de tentar novamente
            await new Promise(resolve => setTimeout(resolve, 100)); // Reduzido para 100ms
        }
    }
    
    // Timeout atingido, retornar o status atual
    try {
        return await getOrderStatus(symbol, orderId);
    } catch (error) {
        return { status: 'UNKNOWN' };
    }
}

// Função para obter detalhes de uma ordem executada
async function getFilledOrderDetails(symbol, orderId) {
    try {
        const timestamp = Date.now();
        const queryString = `symbol=${symbol}&orderId=${orderId}&timestamp=${timestamp}`;
        const signature = crypto
            .createHmac('sha256', process.env.API_SECRET)
            .update(queryString)
            .digest('hex');
        
        const response = await axios.get(
            `${process.env.API_URL}/v1/order?${queryString}&signature=${signature}`,
            { headers: { 'X-MBX-APIKEY': process.env.API_KEY } }
        );
        
        return response.data;
    } catch (error) {
        console.error(`[LIMIT_ENTRY] Erro ao obter detalhes da ordem ${orderId}:`, error);
        return null;
    }
}

const cancelingSignals = new Set();

async function cancelSignal(db, signalId, statusParam, reason) {
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
        // Atualizado o log de erro para ser mais consistente com o seu exemplo
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

// Adicione temporariamente este código para limpar entradas pendentes antigas
async function cleanUpExistingEntries() {
  try {
    const db = await getDatabaseInstance(); // Supondo que getDatabaseInstance() retorna a conexão/pool
    if (!db) {
        console.error("[CLEANUP] Instância do banco de dados não obtida.");
        return;
    }
    
    // Cancelar todos os sinais em AGUARDANDO_ACIONAMENTO que têm position_id
    const [pendingSignalsRows] = await db.query(`
      SELECT id, symbol, position_id 
      FROM webhook_signals 
      WHERE status = 'AGUARDANDO_ACIONAMENTO' 
        AND position_id IS NOT NULL
    `);
    
    const pendingSignals = pendingSignalsRows; // O resultado já é um array de objetos

    console.log(`[CLEANUP] Encontrados ${pendingSignals.length} sinais pendentes com posições`);
    
    for (const signal of pendingSignals) {
      await cancelSignal(db, signal.id, 'CLEANUP', 
        `Limpeza de sistema: nova versão não usa posições pendentes`);
    }
    
    console.log(`[CLEANUP] Limpeza concluída`);
  } catch (error) {
    console.error(`[CLEANUP] Erro durante limpeza:`, error);
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

// Execute a limpeza (se necessário, chame esta função no início do seu script)
// cleanUpExistingEntries();