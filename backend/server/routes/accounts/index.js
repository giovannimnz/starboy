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
      const [rows] = await db.query(`
        SELECT 
          c.id,
          c.nome,
          c.descricao,
          c.id_corretora,
          c.ativa,
          c.saldo,
          c.saldo_base_calculo,
          c.data_criacao,
          c.ultima_atualizacao,
          cor.corretora as nome_corretora,
          cor.ambiente
        FROM contas c
        JOIN corretoras cor ON c.id_corretora = cor.id
        WHERE c.user_id = ? AND c.ativa = 1
        ORDER BY c.data_criacao DESC
      `, [userId]);
      
      reply.send({ 
        success: true, 
        data: rows, 
        total: rows.length 
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar contas do usuário:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // GET /accounts/brokers - Lista todas as corretoras disponíveis
  fastify.get('/accounts/brokers', {
    schema: {
      description: 'Lista todas as corretoras disponíveis.',
      tags: ['Contas'],
      summary: 'Listar corretoras'
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    
    try {
      const [rows] = await db.query(`
        SELECT id, corretora, ambiente, ativa
        FROM corretoras
        WHERE ativa = 1
        ORDER BY corretora ASC
      `);
      
      reply.send({ 
        success: true, 
        data: rows, 
        total: rows.length 
      });
    } catch (error) {
      fastify.log.error('Erro ao buscar corretoras:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // POST /accounts - Criar nova conta de corretora
  fastify.post('/accounts', {
    schema: {
      description: 'Cria uma nova conta de corretora para o usuário.',
      tags: ['Contas'],
      summary: 'Criar conta de corretora',
      body: {
        type: 'object',
        required: ['user_id', 'nome', 'id_corretora', 'api_key', 'api_secret'],
        properties: {
          user_id: { type: 'integer' },
          nome: { type: 'string', minLength: 1 },
          descricao: { type: 'string' },
          id_corretora: { type: 'integer' },
          api_key: { type: 'string', minLength: 1 },
          api_secret: { type: 'string', minLength: 1 },
          ws_api_key: { type: 'string' },
          ws_api_secret: { type: 'string' },
          telegram_chat_id: { type: 'string' },
          max_posicoes: { type: 'integer', default: 10 },
          saldo_base_calculo: { type: 'number', default: 0 }
        }
      }
    }
  }, async (request, reply) => {
    const {
      user_id,
      nome,
      descricao,
      id_corretora,
      api_key,
      api_secret,
      ws_api_key,
      ws_api_secret,
      telegram_chat_id,
      max_posicoes = 10,
      saldo_base_calculo = 0
    } = request.body;
    
    const db = await getDatabaseInstance();
    
    try {
      // Verificar se o usuário existe
      const [userCheck] = await db.query('SELECT id FROM users WHERE id = ? AND ativa = 1', [user_id]);
      if (userCheck.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }

      // Verificar se a corretora existe
      const [brokerCheck] = await db.query('SELECT id FROM corretoras WHERE id = ? AND ativa = 1', [id_corretora]);
      if (brokerCheck.length === 0) {
        return reply.status(404).send({ error: 'Corretora não encontrada' });
      }

      // Verificar se já existe uma conta com o mesmo nome para o usuário
      const [nameCheck] = await db.query('SELECT id FROM contas WHERE user_id = ? AND nome = ? AND ativa = 1', [user_id, nome]);
      if (nameCheck.length > 0) {
        return reply.status(409).send({ error: 'Já existe uma conta com este nome' });
      }

      // Inserir nova conta
      const [result] = await db.query(`
        INSERT INTO contas (
          user_id, nome, descricao, id_corretora, api_key, api_secret, 
          ws_api_key, ws_api_secret, telegram_chat_id, max_posicoes, 
          saldo_base_calculo, data_criacao
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
      `, [
        user_id, nome, descricao, id_corretora, api_key, api_secret,
        ws_api_key, ws_api_secret, telegram_chat_id, max_posicoes, saldo_base_calculo
      ]);

      reply.status(201).send({
        success: true,
        message: 'Conta criada com sucesso',
        account_id: result.insertId
      });
    } catch (error) {
      fastify.log.error('Erro ao criar conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // PUT /accounts/:id - Atualizar conta de corretora
  fastify.put('/accounts/:id', {
    schema: {
      description: 'Atualiza uma conta de corretora.',
      tags: ['Contas'],
      summary: 'Atualizar conta de corretora',
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
          telegram_chat_id: { type: 'string' },
          max_posicoes: { type: 'integer' },
          saldo_base_calculo: { type: 'number' }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const updateData = request.body;
    const db = await getDatabaseInstance();
    
    try {
      // Verificar se a conta existe e está ativa
      const [accountCheck] = await db.query('SELECT id, user_id FROM contas WHERE id = ? AND ativa = 1', [id]);
      if (accountCheck.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }

      // Construir query de atualização dinamicamente
      const updateFields = [];
      const updateValues = [];

      Object.keys(updateData).forEach(key => {
        if (updateData[key] !== undefined && updateData[key] !== null) {
          updateFields.push(`${key} = ?`);
          updateValues.push(updateData[key]);
        }
      });

      if (updateFields.length === 0) {
        return reply.status(400).send({ error: 'Nenhum campo para atualizar foi fornecido' });
      }

      updateFields.push('ultima_atualizacao = NOW()');
      updateValues.push(id);

      const query = `UPDATE contas SET ${updateFields.join(', ')} WHERE id = ?`;
      await db.query(query, updateValues);

      reply.send({
        success: true,
        message: 'Conta atualizada com sucesso'
      });
    } catch (error) {
      fastify.log.error('Erro ao atualizar conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // DELETE /accounts/:id - Remover conta de corretora (soft delete)
  fastify.delete('/accounts/:id', {
    schema: {
      description: 'Remove uma conta de corretora (soft delete).',
      tags: ['Contas'],
      summary: 'Remover conta de corretora',
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
      const [accountCheck] = await db.query('SELECT id FROM contas WHERE id = ? AND ativa = 1', [id]);
      if (accountCheck.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }

      // Soft delete
      await db.query('UPDATE contas SET ativa = 0, ultima_atualizacao = NOW() WHERE id = ?', [id]);

      reply.send({
        success: true,
        message: 'Conta removida com sucesso'
      });
    } catch (error) {
      fastify.log.error('Erro ao remover conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // POST /accounts/:id/test - Testar conexão com a corretora
  fastify.post('/accounts/:id/test', {
    schema: {
      description: 'Testa a conexão com a corretora usando as credenciais da conta.',
      tags: ['Contas'],
      summary: 'Testar conexão',
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
      // Buscar dados da conta
      const [rows] = await db.query(`
        SELECT c.api_key, c.api_secret, cor.corretora
        FROM contas c
        JOIN corretoras cor ON c.id_corretora = cor.id
        WHERE c.id = ? AND c.ativa = 1
      `, [id]);
      
      if (rows.length === 0) {
        return reply.status(404).send({ error: 'Conta não encontrada' });
      }

      const account = rows[0];
      
      // Aqui você implementaria o teste real da conexão com a corretora
      // Por exemplo, para Binance, fazer uma chamada para account info
      
      // Simulação do teste (substitua pela implementação real)
      const testResult = {
        success: true,
        broker: account.corretora,
        message: 'Conexão testada com sucesso',
        timestamp: new Date().toISOString()
      };

      reply.send(testResult);
    } catch (error) {
      fastify.log.error('Erro ao testar conexão:', error);
      reply.status(500).send({ 
        success: false,
        error: 'Erro ao testar conexão com a corretora' 
      });
    }
  });
}

module.exports = accountsRoutes;