const { telegramApiService, formatEntryMessage, formatPositionClosedMessage, formatErrorMessage, formatAlertMessage } = require('../../services/telegramApi');

async function telegramRoutes(fastify, options) {
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
      const { accountId, message, chatId } = request.body;
      
      const result = await telegramApiService.sendMessage(accountId, message, chatId);
      
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
      const { accountId, signal, filledQuantity, averagePrice, totalValue } = request.body;
      
      const message = await formatEntryMessage(signal, filledQuantity, averagePrice, totalValue, accountId);
      const result = await telegramApiService.sendMessage(accountId, message);
      
      reply.send({ success: result.success, error: result.error });
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
          position: { type: 'object' }
        }
      }
    }
  }, async (request, reply) => {
    try {
      const { accountId, position } = request.body;
      
      const message = await formatPositionClosedMessage(position, null, null, null, null, null, accountId);
      const result = await telegramApiService.sendMessage(accountId, message);
      
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
}

module.exports = telegramRoutes;