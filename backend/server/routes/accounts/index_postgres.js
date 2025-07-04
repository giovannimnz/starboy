const { getDatabaseInstance } = require('../../../core/database/conexao');

async function accountsRoutes(fastify, options) {

  // GET /accounts/user/:userId - Lista todas as contas do usuário
  fastify.get('/accounts/user/:userId', {
    schema: {
      description: 'Lista todas as contas de corretora de um usuário.',
      tags: ['Contas'],
      summary: 'Listar contas do usuário',
      params: {
        type: 'object',
        properties: {
          userId: { type: 'integer' }
        },
        required: ['userId']
      }
    }
  }, async (request, reply) => {
    const { userId } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      const result = await db.query(`
        SELECT 
          c.id,
          c.nome,
          c.descricao,
          c.id_corretora,
          c.ativa,
          c.saldo_futuros,
          c.saldo_spot,
          c.saldo_base_calculo_futuros,
          c.saldo_base_calculo_spot,
          c.data_criacao,
          c.ultima_atualizacao,
          cor.corretora as nome_corretora,
          cor.ambiente
        FROM contas c
        JOIN corretoras cor ON c.id_corretora = cor.id
        WHERE c.user_id = $1 AND c.ativa = true
        ORDER BY c.data_criacao DESC
      `, [userId]);
      
      reply.send({ 
        success: true, 
        data: result.rows, 
        total: result.rows.length 
      });
    } catch (error) {
      console.error('Erro ao buscar contas do usuário:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // GET /accounts/brokers - Lista todas as corretoras disponíveis
  fastify.get('/accounts/brokers', {
    schema: {
      description: 'Lista todas as corretoras disponíveis.',
      tags: ['Corretoras'],
      summary: 'Listar corretoras',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array' },
            total: { type: 'number' }
          }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    
    try {
      const result = await db.query(`
        SELECT id, corretora, ambiente, ativa
        FROM corretoras
        WHERE ativa = true
        ORDER BY corretora, ambiente
      `);
      
      reply.send({ 
        success: true, 
        data: result.rows, 
        total: result.rows.length 
      });
    } catch (error) {
      console.error('Erro ao buscar corretoras:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // POST /accounts - Criar nova conta
  fastify.post('/accounts', {
    schema: {
      description: 'Cria uma nova conta de corretora.',
      tags: ['Contas'],
      summary: 'Criar nova conta',
      body: {
        type: 'object',
        required: ['nome', 'id_corretora', 'api_key', 'api_secret', 'user_id'],
        properties: {
          nome: { type: 'string' },
          descricao: { type: 'string' },
          id_corretora: { type: 'integer' },
          api_key: { type: 'string' },
          api_secret: { type: 'string' },
          ws_api_key: { type: 'string' },
          ws_api_secret: { type: 'string' },
          testnet_spot_api_key: { type: 'string' },
          testnet_spot_api_secret: { type: 'string' },
          telegram_chat_id: { type: 'string' },
          telegram_bot_token: { type: 'string' },
          telegram_bot_token_controller: { type: 'string' },
          celular: { type: 'string' },
          max_posicoes: { type: 'integer' },
          user_id: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    
    try {
      const {
        nome, descricao, id_corretora, api_key, api_secret, ws_api_key, ws_api_secret,
        testnet_spot_api_key, testnet_spot_api_secret, telegram_chat_id, telegram_bot_token,
        telegram_bot_token_controller, celular, max_posicoes, user_id
      } = request.body;

      // Validar se o usuário existe
      const userCheck = await db.query('SELECT id FROM users WHERE id = $1 AND ativa = true', [user_id]);
      if (userCheck.rows.length === 0) {
        return reply.code(400).send({ success: false, error: 'Usuário não encontrado ou inativo' });
      }

      // Validar se a corretora existe
      const brokerCheck = await db.query('SELECT id FROM corretoras WHERE id = $1 AND ativa = true', [id_corretora]);
      if (brokerCheck.rows.length === 0) {
        return reply.code(400).send({ success: false, error: 'Corretora não encontrada ou inativa' });
      }

      // Verificar se já existe uma conta com o mesmo nome para o usuário
      const nameCheck = await db.query('SELECT id FROM contas WHERE user_id = $1 AND nome = $2 AND ativa = true', [user_id, nome]);
      if (nameCheck.rows.length > 0) {
        return reply.code(400).send({ success: false, error: 'Já existe uma conta com este nome para este usuário' });
      }

      const result = await db.query(`
        INSERT INTO contas (
          nome, descricao, id_corretora, api_key, api_secret, ws_api_key, ws_api_secret,
          testnet_spot_api_key, testnet_spot_api_secret, telegram_chat_id, telegram_bot_token,
          telegram_bot_token_controller, celular, max_posicoes, user_id, ativa,
          data_criacao, ultima_atualizacao
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, true,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        ) RETURNING id
      `, [
        nome, descricao, id_corretora, api_key, api_secret, ws_api_key, ws_api_secret,
        testnet_spot_api_key, testnet_spot_api_secret, telegram_chat_id, telegram_bot_token,
        telegram_bot_token_controller, celular, max_posicoes || 5, user_id
      ]);

      const novaContaId = result.rows[0].id;

      reply.send({ 
        success: true, 
        data: { id: novaContaId, message: 'Conta criada com sucesso' }
      });
    } catch (error) {
      console.error('Erro ao criar conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // PUT /accounts/:id - Atualizar conta existente
  fastify.put('/accounts/:id', {
    schema: {
      description: 'Atualiza uma conta existente.',
      tags: ['Contas'],
      summary: 'Atualizar conta',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          descricao: { type: 'string' },
          api_key: { type: 'string' },
          api_secret: { type: 'string' },
          ws_api_key: { type: 'string' },
          ws_api_secret: { type: 'string' },
          testnet_spot_api_key: { type: 'string' },
          testnet_spot_api_secret: { type: 'string' },
          telegram_chat_id: { type: 'string' },
          telegram_bot_token: { type: 'string' },
          telegram_bot_token_controller: { type: 'string' },
          celular: { type: 'string' },
          max_posicoes: { type: 'integer' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      // Verificar se a conta existe
      const accountCheck = await db.query('SELECT id, user_id FROM contas WHERE id = $1 AND ativa = true', [id]);
      if (accountCheck.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conta não encontrada' });
      }

      // Construir query de atualização dinamicamente
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      const allowedFields = [
        'nome', 'descricao', 'api_key', 'api_secret', 'ws_api_key', 'ws_api_secret',
        'testnet_spot_api_key', 'testnet_spot_api_secret', 'telegram_chat_id', 
        'telegram_bot_token', 'telegram_bot_token_controller', 'celular', 'max_posicoes'
      ];

      for (const field of allowedFields) {
        if (request.body[field] !== undefined) {
          updateFields.push(`${field} = $${paramIndex}`);
          updateValues.push(request.body[field]);
          paramIndex++;
        }
      }

      if (updateFields.length === 0) {
        return reply.code(400).send({ success: false, error: 'Nenhum campo para atualizar' });
      }

      updateFields.push(`ultima_atualizacao = CURRENT_TIMESTAMP`);
      updateValues.push(id);

      const query = `UPDATE contas SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
      await db.query(query, updateValues);

      reply.send({ 
        success: true, 
        data: { message: 'Conta atualizada com sucesso' }
      });
    } catch (error) {
      console.error('Erro ao atualizar conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // DELETE /accounts/:id - Desativar conta (soft delete)
  fastify.delete('/accounts/:id', {
    schema: {
      description: 'Desativa uma conta (soft delete).',
      tags: ['Contas'],
      summary: 'Desativar conta',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      // Verificar se a conta existe
      const accountCheck = await db.query('SELECT id FROM contas WHERE id = $1 AND ativa = true', [id]);
      if (accountCheck.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conta não encontrada' });
      }

      // Desativar a conta
      await db.query('UPDATE contas SET ativa = false, ultima_atualizacao = CURRENT_TIMESTAMP WHERE id = $1', [id]);

      reply.send({ 
        success: true, 
        data: { message: 'Conta desativada com sucesso' }
      });
    } catch (error) {
      console.error('Erro ao desativar conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // GET /accounts/:id - Buscar conta específica
  fastify.get('/accounts/:id', {
    schema: {
      description: 'Busca uma conta específica.',
      tags: ['Contas'],
      summary: 'Buscar conta por ID',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      const result = await db.query(`
        SELECT 
          c.id,
          c.nome,
          c.descricao,
          c.id_corretora,
          c.ativa,
          c.saldo_futuros,
          c.saldo_spot,
          c.saldo_base_calculo_futuros,
          c.saldo_base_calculo_spot,
          c.data_criacao,
          c.ultima_atualizacao,
          cor.corretora as nome_corretora,
          cor.ambiente
        FROM contas c
        JOIN corretoras cor ON c.id_corretora = cor.id
        WHERE c.id = $1 AND c.ativa = true
      `, [id]);
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conta não encontrada' });
      }

      reply.send({ 
        success: true, 
        data: result.rows[0] 
      });
    } catch (error) {
      console.error('Erro ao buscar conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // GET /accounts/:id/balance - Buscar saldo da conta
  fastify.get('/accounts/:id/balance', {
    schema: {
      description: 'Busca o saldo de uma conta específica.',
      tags: ['Contas'],
      summary: 'Buscar saldo da conta',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      const result = await db.query(
        'SELECT saldo_futuros, saldo_spot, saldo_base_calculo_futuros, saldo_base_calculo_spot FROM contas WHERE id = $1 AND ativa = true',
        [id]
      );
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conta não encontrada' });
      }

      reply.send({ 
        success: true, 
        data: result.rows[0] 
      });
    } catch (error) {
      console.error('Erro ao buscar saldo da conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

  // PUT /accounts/:id/balance - Atualizar saldo da conta
  fastify.put('/accounts/:id/balance', {
    schema: {
      description: 'Atualiza o saldo de uma conta específica.',
      tags: ['Contas'],
      summary: 'Atualizar saldo da conta',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        properties: {
          saldo_futuros: { type: 'number' },
          saldo_spot: { type: 'number' },
          saldo_base_calculo_futuros: { type: 'number' },
          saldo_base_calculo_spot: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const db = await getDatabaseInstance();
    
    try {
      const result = await db.query(
        'SELECT id FROM contas WHERE id = $1 AND ativa = true',
        [id]
      );
      
      if (result.rows.length === 0) {
        return reply.code(404).send({ success: false, error: 'Conta não encontrada' });
      }

      // Construir query de atualização dinamicamente
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      const allowedFields = ['saldo_futuros', 'saldo_spot', 'saldo_base_calculo_futuros', 'saldo_base_calculo_spot'];

      for (const field of allowedFields) {
        if (request.body[field] !== undefined) {
          updateFields.push(`${field} = $${paramIndex}`);
          updateValues.push(request.body[field]);
          paramIndex++;
        }
      }

      if (updateFields.length === 0) {
        return reply.code(400).send({ success: false, error: 'Nenhum campo de saldo para atualizar' });
      }

      updateFields.push(`ultima_atualizacao = CURRENT_TIMESTAMP`);
      updateValues.push(id);

      const query = `UPDATE contas SET ${updateFields.join(', ')} WHERE id = $${paramIndex}`;
      await db.query(query, updateValues);

      reply.send({ 
        success: true, 
        data: { message: 'Saldo atualizado com sucesso' }
      });
    } catch (error) {
      console.error('Erro ao atualizar saldo da conta:', error);
      reply.code(500).send({ success: false, error: 'Erro interno do servidor' });
    }
  });

}

module.exports = accountsRoutes;
