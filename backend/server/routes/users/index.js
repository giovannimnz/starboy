// backend/server/routes/auth/index.js

const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { getDatabaseInstance } = require('../../../core/database/conexao');

async function authRoutes(fastify, options) {

  // ROTA DE REGISTRO
  fastify.post('/users/register', {
    schema: {
      description: 'Registra um novo usuário no sistema.',
      tags: ['Usuários'],
      summary: 'Registro de novo usuário',
      body: {
        type: 'object',
        required: ['nome', 'email', 'senha'],
        properties: {
          nome: { type: 'string' },
          email: { type: 'string', format: 'email' },
          senha: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const { nome, email, senha } = request.body;
    const db = await getDatabaseInstance();
    try {
      const [existing] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length > 0) {
        return reply.status(409).send({ error: 'E-mail já cadastrado.' });
      }
      const saltRounds = 10;
      const hashDaSenha = await bcrypt.hash(senha, saltRounds);
      await db.query('INSERT INTO users (nome, email, senha) VALUES (?, ?, ?)', [nome, email, hashDaSenha]);
      reply.status(201).send({ message: 'Usuário registrado com sucesso!' });
    } catch (error) {
      fastify.log.error('Erro no registro:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA DE LOGIN
  fastify.post('/users/login', {
    schema: {
      description: 'Autentica um usuário e retorna um token JWT.',
      tags: ['Usuários'],
      summary: 'Login de usuário',
      body: {
        type: 'object',
        required: ['email', 'senha'],
        properties: {
          email: { type: 'string', format: 'email' },
          senha: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const { email, senha } = request.body;
    const db = await getDatabaseInstance();
    try {
      const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
      if (users.length === 0) {
        return reply.status(401).send({ error: 'Credenciais inválidas' });
      }
      const user = users[0];
      const senhaValida = await bcrypt.compare(senha, user.senha);
      if (!senhaValida) {
        return reply.status(401).send({ error: 'Credenciais inválidas' });
      }
      const tokenPayload = { id: user.id, email: user.email, nome: user.nome };
      const secretKey = process.env.JWT_SECRET || 'suaChaveSecretaPadraoSuperSegura';
      const token = jwt.sign(tokenPayload, secretKey, { expiresIn: '8h' });
      reply.send({ token, user: tokenPayload });
    } catch (error) {
      fastify.log.error('Erro no login:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // GET /users - Lista todos os usuários ou um específico, com filtro por ativa
  fastify.get('/users', {
    schema: {
      description: 'Lista todos os usuários ou um usuário específico, com opção de filtrar por id e ativa.',
      tags: ['Usuários'],
      summary: 'Listar usuários',
      querystring: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'ID do usuário (opcional)' },
          ativa: { type: 'boolean', description: 'Filtrar por usuários ativos/inativos (opcional)' }
        }
      }
    }
  }, async (request, reply) => {
    const { id, ativa } = request.query;
    const db = await getDatabaseInstance();
    try {
      let query = 'SELECT id, nome, email, ativo, criado_em, atualizado_em FROM users WHERE 1=1';
      const params = [];
      if (id) {
        query += ' AND id = ?';
        params.push(id);
      }
      if (typeof ativa !== 'undefined') {
        query += ' AND ativo = ?';
        params.push(ativa ? 1 : 0);
      }
      const [users] = await db.query(query, params);
      reply.send({ success: true, data: users, total: users.length });
    } catch (error) {
      fastify.log.error('Erro ao buscar usuários:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // DELETE /users/:id - Remove usuário por id
  fastify.delete('/users/:id', {
    schema: {
      description: 'Remove (soft delete) um usuário pelo id.',
      tags: ['Usuários'],
      summary: 'Deletar usuário',
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
      // Soft delete: marca como inativo
      const [result] = await db.query('UPDATE users SET ativo = 0 WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }
      reply.send({ success: true, message: 'Usuário removido com sucesso.' });
    } catch (error) {
      fastify.log.error('Erro ao deletar usuário:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // PUT /users/:id/password - Alterar senha do usuário
  fastify.put('/users/:id/password', {
    schema: {
      description: 'Altera a senha do usuário. É necessário informar a senha atual.',
      tags: ['Usuários'],
      summary: 'Alterar senha do usuário',
      params: {
        type: 'object',
        properties: {
          id: { type: 'integer' }
        },
        required: ['id']
      },
      body: {
        type: 'object',
        required: ['senhaAtual', 'novaSenha'],
        properties: {
          senhaAtual: { type: 'string', minLength: 6 },
          novaSenha: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const { id } = request.params;
    const { senhaAtual, novaSenha } = request.body;
    const db = await getDatabaseInstance();
    try {
      // Buscar usuário
      const [users] = await db.query('SELECT senha FROM users WHERE id = ? AND ativo = 1', [id]);
      if (users.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado' });
      }
      const senhaHash = users[0].senha;
      const senhaValida = await bcrypt.compare(senhaAtual, senhaHash);
      if (!senhaValida) {
        return reply.status(401).send({ error: 'Senha atual incorreta' });
      }
      // Atualizar senha
      const novaSenhaHash = await bcrypt.hash(novaSenha, 10);
      await db.query('UPDATE users SET senha = ? WHERE id = ?', [novaSenhaHash, id]);
      reply.send({ success: true, message: 'Senha alterada com sucesso.' });
    } catch (error) {
      fastify.log.error('Erro ao alterar senha:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });
}

module.exports = authRoutes;