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
          sobrenome: { type: 'string' }, // Adicionado campo sobrenome
          email: { type: 'string', format: 'email' },
          senha: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const { nome, sobrenome, email, senha } = request.body;
    const db = await getDatabaseInstance();
    try {
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        return reply.status(409).send({ error: 'E-mail já cadastrado.' });
      }
      const saltRounds = 10;
      const hashDaSenha = await bcrypt.hash(senha, saltRounds);
      
      // Atualizada query para incluir sobrenome
      const query = sobrenome 
        ? 'INSERT INTO users (nome, sobrenome, email, senha) VALUES ($1, $2, $3, $4)'
        : 'INSERT INTO users (nome, email, senha) VALUES ($1, $2, $3)';
      const params = sobrenome 
        ? [nome, sobrenome, email, hashDaSenha]
        : [nome, email, hashDaSenha];
      
      await db.query(query, params);
      reply.status(201).send({ message: 'Usuário registrado com sucesso!' });
    } catch (error) {
      fastify.log.error('Erro no registro:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA DE LOGIN
  fastify.post('/users/login', {
    schema: {
      description: 'Faz login de um usuário no sistema.',
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
      const result = await db.query(
        'SELECT id, nome, sobrenome, email, senha, ativa FROM users WHERE email = $1', 
        [email]
      );
      
      if (result.rows.length === 0) {
        return reply.status(401).send({ error: 'E-mail ou senha inválidos.' });
      }
      
      const user = result.rows[0];
      
      // Verificar se o usuário está ativo
      if (!user.ativa) {
        return reply.status(401).send({ error: 'Usuário inativo.' });
      }
      
      const senhaCorreta = await bcrypt.compare(senha, user.senha);
      if (!senhaCorreta) {
        return reply.status(401).send({ error: 'E-mail ou senha inválidos.' });
      }
      
      const token = jwt.sign(
        { 
          id: user.id, 
          email: user.email, 
          nome: user.nome,
          sobrenome: user.sobrenome 
        },
        process.env.JWT_SECRET,
        { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
      );
      
      reply.send({ 
        message: 'Login realizado com sucesso!', 
        token,
        user: { 
          id: user.id, 
          nome: user.nome, 
          sobrenome: user.sobrenome,
          email: user.email 
        }
      });
    } catch (error) {
      fastify.log.error('Erro no login:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // MIDDLEWARE DE AUTENTICAÇÃO
  async function authenticate(request, reply) {
    try {
      const token = request.headers.authorization?.split(' ')[1];
      if (!token) {
        return reply.status(401).send({ error: 'Token de acesso requerido.' });
      }
      
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      request.user = decoded;
    } catch (error) {
      return reply.status(401).send({ error: 'Token inválido.' });
    }
  }

  // ROTA PROTEGIDA DE PERFIL
  fastify.get('/users/profile', {
    preHandler: authenticate,
    schema: {
      description: 'Busca o perfil do usuário logado.',
      tags: ['Usuários'],
      summary: 'Perfil do usuário',
      security: [{ bearerAuth: [] }]
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    try {
      const result = await db.query(
        'SELECT id, nome, sobrenome, email, criado_em, atualizado_em FROM users WHERE id = $1 AND ativa = true', 
        [request.user.id]
      );
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado.' });
      }
      
      reply.send({ user: result.rows[0] });
    } catch (error) {
      fastify.log.error('Erro ao buscar perfil:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA PARA ATUALIZAR PERFIL
  fastify.put('/users/profile', {
    preHandler: authenticate,
    schema: {
      description: 'Atualiza o perfil do usuário logado.',
      tags: ['Usuários'],
      summary: 'Atualizar perfil',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          sobrenome: { type: 'string' },
          email: { type: 'string', format: 'email' }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    try {
      const { nome, sobrenome, email } = request.body;
      const updateFields = [];
      const updateValues = [];
      let paramIndex = 1;

      if (nome !== undefined) {
        updateFields.push(`nome = $${paramIndex}`);
        updateValues.push(nome);
        paramIndex++;
      }

      if (sobrenome !== undefined) {
        updateFields.push(`sobrenome = $${paramIndex}`);
        updateValues.push(sobrenome);
        paramIndex++;
      }

      if (email !== undefined) {
        // Verificar se o novo email já existe
        const emailCheck = await db.query(
          'SELECT id FROM users WHERE email = $1 AND id != $2', 
          [email, request.user.id]
        );
        
        if (emailCheck.rows.length > 0) {
          return reply.status(409).send({ error: 'E-mail já está em uso por outro usuário.' });
        }

        updateFields.push(`email = $${paramIndex}`);
        updateValues.push(email);
        paramIndex++;
      }

      if (updateFields.length === 0) {
        return reply.status(400).send({ error: 'Nenhum campo para atualizar.' });
      }

      updateValues.push(request.user.id);
      const query = `UPDATE users SET ${updateFields.join(', ')}, atualizado_em = CURRENT_TIMESTAMP WHERE id = $${paramIndex}`;
      
      await db.query(query, updateValues);
      
      reply.send({ message: 'Perfil atualizado com sucesso!' });
    } catch (error) {
      fastify.log.error('Erro ao atualizar perfil:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA PARA ALTERAR SENHA
  fastify.put('/users/change-password', {
    preHandler: authenticate,
    schema: {
      description: 'Altera a senha do usuário logado.',
      tags: ['Usuários'],
      summary: 'Alterar senha',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['senhaAtual', 'novaSenha'],
        properties: {
          senhaAtual: { type: 'string' },
          novaSenha: { type: 'string', minLength: 6 }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    try {
      const { senhaAtual, novaSenha } = request.body;
      
      // Buscar senha atual do usuário
      const result = await db.query('SELECT senha FROM users WHERE id = $1 AND ativa = true', [request.user.id]);
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado.' });
      }
      
      const user = result.rows[0];
      
      // Verificar senha atual
      const senhaCorreta = await bcrypt.compare(senhaAtual, user.senha);
      if (!senhaCorreta) {
        return reply.status(401).send({ error: 'Senha atual incorreta.' });
      }
      
      // Gerar hash da nova senha
      const saltRounds = 10;
      const hashNovaSenha = await bcrypt.hash(novaSenha, saltRounds);
      
      // Atualizar senha
      await db.query(
        'UPDATE users SET senha = $1, atualizado_em = CURRENT_TIMESTAMP WHERE id = $2', 
        [hashNovaSenha, request.user.id]
      );
      
      reply.send({ message: 'Senha alterada com sucesso!' });
    } catch (error) {
      fastify.log.error('Erro ao alterar senha:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA PARA DESATIVAR CONTA
  fastify.delete('/users/deactivate', {
    preHandler: authenticate,
    schema: {
      description: 'Desativa a conta do usuário logado.',
      tags: ['Usuários'],
      summary: 'Desativar conta',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['senha'],
        properties: {
          senha: { type: 'string' }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    try {
      const { senha } = request.body;
      
      // Verificar se o usuário existe e está ativo
      const result = await db.query('SELECT senha FROM users WHERE id = $1 AND ativa = true', [request.user.id]);
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado.' });
      }
      
      const user = result.rows[0];
      
      // Verificar senha
      const senhaCorreta = await bcrypt.compare(senha, user.senha);
      if (!senhaCorreta) {
        return reply.status(401).send({ error: 'Senha incorreta.' });
      }
      
      // Desativar usuário
      await db.query(
        'UPDATE users SET ativa = false, atualizado_em = CURRENT_TIMESTAMP WHERE id = $1', 
        [request.user.id]
      );
      
      reply.send({ message: 'Conta desativada com sucesso!' });
    } catch (error) {
      fastify.log.error('Erro ao desativar conta:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA PARA BUSCAR USUÁRIO POR ID (admin)
  fastify.get('/users/:id', {
    preHandler: authenticate,
    schema: {
      description: 'Busca um usuário específico por ID.',
      tags: ['Usuários'],
      summary: 'Buscar usuário por ID',
      security: [{ bearerAuth: [] }],
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
        'SELECT id, nome, sobrenome, email, ativa, criado_em, atualizado_em FROM users WHERE id = $1', 
        [id]
      );
      
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: 'Usuário não encontrado.' });
      }
      
      reply.send({ user: result.rows[0] });
    } catch (error) {
      fastify.log.error('Erro ao buscar usuário:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

  // ROTA PARA LISTAR TODOS OS USUÁRIOS (admin)
  fastify.get('/users', {
    preHandler: authenticate,
    schema: {
      description: 'Lista todos os usuários do sistema.',
      tags: ['Usuários'],
      summary: 'Listar todos os usuários',
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          ativa: { type: 'boolean' },
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
        }
      }
    }
  }, async (request, reply) => {
    const db = await getDatabaseInstance();
    
    try {
      const { ativa, page = 1, limit = 10 } = request.query;
      const offset = (page - 1) * limit;
      
      let query = 'SELECT id, nome, sobrenome, email, ativa, criado_em, atualizado_em FROM users';
      const params = [];
      let paramIndex = 1;
      
      if (ativa !== undefined) {
        query += ` WHERE ativa = $${paramIndex}`;
        params.push(ativa);
        paramIndex++;
      }
      
      query += ` ORDER BY criado_em DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(limit, offset);
      
      const result = await db.query(query, params);
      
      // Contar total de usuários
      let countQuery = 'SELECT COUNT(*) as total FROM users';
      const countParams = [];
      
      if (ativa !== undefined) {
        countQuery += ' WHERE ativa = $1';
        countParams.push(ativa);
      }
      
      const countResult = await db.query(countQuery, countParams);
      const total = parseInt(countResult.rows[0].total);
      
      reply.send({ 
        users: result.rows,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      fastify.log.error('Erro ao listar usuários:', error);
      reply.status(500).send({ error: 'Erro interno do servidor' });
    }
  });

}

module.exports = authRoutes;
