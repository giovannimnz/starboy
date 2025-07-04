const { telegramApiService, formatEntryMessage, formatPositionClosedMessage, formatErrorMessage, formatAlertMessage } = require('../../../services/telegramApi');

async function telegramRoutes(fastify, options) {
  try {
    console.log('🔍 [DEBUG] Iniciando registro das rotas do Telegram...');
    
    // Verificar se os imports estão funcionando
    try {
      console.log('🔍 [DEBUG] Testando import do telegramApiService...');
      const { telegramApiService, formatEntryMessage, formatPositionClosedMessage, formatErrorMessage, formatAlertMessage } = require('../../../services/telegramApi');
      console.log('✅ [DEBUG] Import do telegramApiService OK');
    } catch (importError) {
      console.error('❌ [DEBUG] Erro no import:', importError.message);
      throw importError;
    }

    // Enviar mensagem simples
    fastify.post('/send-message', {
      schema: {
        description: 'Enviar mensagem via Telegram para uma conta',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'message'],
          properties: {
            accountId: { type: 'number', description: 'ID da conta' },
            message: { type: 'string', description: 'Mensagem a ser enviada' },
            chatId: { type: 'string', description: 'Chat ID específico (opcional)' }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegram.js | ENDPOINT: /send-message`);
        console.log(`[TELEGRAM_DISPATCHER] 📋 Request body:`, JSON.stringify(request.body, null, 2));
        
        const { telegramApiService } = require('../../../services/telegramApi');
        const { accountId, message, chatId } = request.body;
        
        const result = await telegramApiService.sendMessage(accountId, message, chatId);
        
        console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado final do endpoint:`, JSON.stringify(result, null, 2));
        
        if (result.success) {
          reply.send({
            success: true,
            messageId: result.messageId,
            message: 'Mensagem enviada com sucesso'
          });
        } else {
          reply.status(400).send({
            success: false,
            error: result.error
          });
        }
      } catch (error) {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.error(`[TELEGRAM_DISPATCHER] ❌ ${timestamp} | telegram.js | ERRO CRÍTICO no endpoint /send-message:`, error.message);
        reply.status(500).send({
          success: false,
          error: error.message
        });
      }
    });

    // Enviar mensagem de entrada executada
    fastify.post('/send-entry-message', {
      schema: {
        description: 'Enviar mensagem formatada de entrada executada',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'signal', 'filledQuantity', 'averagePrice', 'totalValue'],
          properties: {
            accountId: { type: 'number' },
            signal: { type: 'object' },
            filledQuantity: { type: 'number' },
            averagePrice: { type: 'number' },
            totalValue: { type: 'number' }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegram.js | ENDPOINT: /send-entry-message`);
        console.log(`[TELEGRAM_DISPATCHER] 📋 Request body:`, JSON.stringify(request.body, null, 2));
        
        const { formatEntryMessage, telegramApiService } = require('../../../services/telegramApi');
        const { accountId, signal, filledQuantity, averagePrice, totalValue } = request.body;
        
        const message = await formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId);
        console.log(`[TELEGRAM_DISPATCHER] 📝 Mensagem formatada (${message?.length || 0} chars):`, message?.substring(0, 100) + '...');
        
        const result = await telegramApiService.sendMessage(accountId, message);
        
        console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado final do endpoint entry:`, JSON.stringify(result, null, 2));
        
        // ✅ SE A MENSAGEM FOI ENVIADA COM SUCESSO, REGISTRAR O ID NA TABELA webhook_signals
        if (result.success && result.messageId && signal.id) {
          console.log(`[TELEGRAM_API] 📝 Registrando messageId ${result.messageId} para sinal ${signal.id}`);
          
          try {
            await telegramApiService.updateSignalRegistryMessageId(signal.id, result.messageId);
          } catch (updateError) {
            console.warn(`[TELEGRAM_API] ⚠️ Erro ao registrar messageId:`, updateError.message);
          }
        }
        
        reply.send({ success: result.success, error: result.error, messageId: result.messageId });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    // Enviar mensagem de posição fechada
    fastify.post('/send-position-closed', {
      schema: {
        description: 'Enviar mensagem formatada de posição fechada',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'position'],
          properties: {
            accountId: { type: 'number' },
            position: { type: 'object' },
            replyToMessageId: { type: 'string' } // ✅ NOVO: opcional
          }
        }
      }
    }, async (request, reply) => {
      try {
        const timestamp = new Date().toLocaleString('pt-BR');
        console.log(`[TELEGRAM_DISPATCHER] 🕐 ${timestamp} | ARQUIVO: telegram.js | ENDPOINT: /send-position-closed`);
        console.log(`[TELEGRAM_DISPATCHER] 📋 Request body:`, JSON.stringify(request.body, null, 2));
        
        const { formatPositionClosedMessage, telegramApiService } = require('../../../services/telegramApi');
        const { getDatabaseInstance } = require('../../../core/database/conexao');
        const { accountId, position, replyToMessageId: providedReplyId } = request.body;
        
        // ✅ USAR replyToMessageId FORNECIDO OU BUSCAR NO BANCO
        let replyToMessageId = providedReplyId || null;
        
        console.log(`[TELEGRAM_DISPATCHER] 🔍 ReplyToMessageId: ${replyToMessageId ? 'fornecido: ' + replyToMessageId : 'não fornecido, buscando no banco'}`);
        
        if (!replyToMessageId) {
          try {
            const db = await getDatabaseInstance();
            const result = await db.query(`SELECT registry_message_id FROM webhook_signals 
               WHERE position_id = $1 AND conta_id = $2 AND registry_message_id IS NOT NULL 
               ORDER BY id DESC LIMIT 1`, [position.id, accountId]
            );
            
            if (signalRows.rows.length > 0 && signalRows.rows[0].registry_message_id) {
              replyToMessageId = signalRows.rows[0].registry_message_id;
              console.log(`[TELEGRAM_DISPATCHER] 📱 Registry message ID encontrado no banco: ${replyToMessageId}`);
            } else {
              console.log(`[TELEGRAM_DISPATCHER] 📱 Nenhum registry_message_id encontrado para posição ${position.id}, enviando mensagem normal`);
            }
          } catch (dbError) {
            console.warn(`[TELEGRAM_DISPATCHER] ⚠️ Erro ao buscar registry_message_id no banco:`, dbError.message);
          }
        } else {
          console.log(`[TELEGRAM_DISPATCHER] 📱 Usando replyToMessageId fornecido: ${replyToMessageId}`);
        }
        
        const message = await formatPositionClosedMessage(position, null, null, null, null, null, accountId);
        console.log(`[TELEGRAM_DISPATCHER] 📝 Mensagem de posição fechada formatada (${message?.length || 0} chars):`, message?.substring(0, 100) + '...');
        
        const result = await telegramApiService.sendMessage(accountId, message, null, replyToMessageId);
        
        console.log(`[TELEGRAM_DISPATCHER] 📤 Resultado final do endpoint position-closed:`, JSON.stringify(result, null, 2));
        
        reply.send({ success: result.success, error: result.error });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    // Listar bots ativos
    fastify.get('/active-bots', {
      schema: {
        description: 'Listar contas com bots ativos',
        tags: ['Telegram']
      }
    }, async (request, reply) => {
      try {
        const { telegramApiService } = require('../../../services/telegramApi');
        const activeBots = telegramApiService.listActiveBots();
        reply.send({
          success: true,
          activeBots: activeBots,
          count: activeBots.length
        });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ✅ NOVO: Enviar mensagem de ordem executada
    fastify.post('/send-order-message', {
      schema: {
        description: 'Enviar mensagem formatada de ordem executada',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'symbol', 'side', 'orderType', 'quantity', 'price', 'status'],
          properties: {
            accountId: { type: 'number' },
            symbol: { type: 'string' },
            side: { type: 'string' },
            orderType: { type: 'string' },
            quantity: { type: 'string' },
            price: { type: 'string' },
            status: { type: 'string' }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { formatOrderMessage, telegramApiService } = require('../../../services/telegramApi');
        const { accountId, symbol, side, orderType, quantity, price, status } = request.body;
        
        const message = formatOrderMessage(symbol, side, orderType, quantity, price, status);
        const result = await telegramApiService.sendMessage(accountId, message);
        
        reply.send({ success: result.success, error: result.error });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ✅ NOVO: Enviar mensagem de mudança de saldo
    fastify.post('/send-balance-message', {
      schema: {
        description: 'Enviar mensagem formatada de mudança de saldo',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'previousBalance', 'newBalance', 'reason'],
          properties: {
            accountId: { type: 'number' },
            previousBalance: { type: 'number' },
            newBalance: { type: 'number' },
            reason: { type: 'string' },
            balanceChange: { type: 'number' }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { formatBalanceMessage, telegramApiService } = require('../../../services/telegramApi');
        const { accountId, previousBalance, newBalance, reason, balanceChange } = request.body;
        
        const message = formatBalanceMessage(accountId, previousBalance, newBalance, reason, balanceChange);
        
        if (!message) {
          // Mudança insignificante
          reply.send({ success: true, skipped: true, reason: 'Mudança insignificante' });
          return;
        }
        
        const result = await telegramApiService.sendMessage(accountId, message);
        reply.send({ success: result.success, error: result.error });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    // ✅ NOVO: Enviar mensagem de sinal registrado
    fastify.post('/send-signal-registered', {
      schema: {
        description: 'Enviar mensagem formatada de sinal registrado',
        tags: ['Telegram'],
        body: {
          type: 'object',
          required: ['accountId', 'signal'],
          properties: {
            accountId: { type: 'number' },
            signal: { type: 'object' },
            grupoOrigemNome: { type: 'string' }
          }
        }
      }
    }, async (request, reply) => {
      try {
        const { formatSignalRegisteredMessage, telegramApiService } = require('../../../services/telegramApi');
        const { accountId, signal, grupoOrigemNome } = request.body;
        
        const message = formatSignalRegisteredMessage(signal, grupoOrigemNome);
        const result = await telegramApiService.sendMessage(accountId, message);
        
        reply.send({ success: result.success, error: result.error });
      } catch (error) {
        reply.status(500).send({ success: false, error: error.message });
      }
    });

    console.log('✅ [DEBUG] Rotas do Telegram registradas com sucesso');
    
  } catch (error) {
    console.error('❌ [DEBUG] Erro ao registrar rotas do Telegram:', error.message);
    console.error('❌ [DEBUG] Stack trace:', error.stack);
    throw error;
  }
}

module.exports = telegramRoutes;