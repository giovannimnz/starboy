const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const dbModule = require('../core/database/conexao');

// Carregar .env com verificação de erro
try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../config/.env') });
  console.log('✅ Arquivo .env carregado com sucesso');
} catch (envError) {
  console.error('❌ Erro ao carregar .env:', envError.message);
  // Tentar carregar do diretório raiz como fallback
  try {
    require('dotenv').config({ path: path.resolve(__dirname, '../../.env.test') });
    console.log('✅ Arquivo .env.test carregado como fallback');
  } catch (fallbackError) {
    console.error('❌ Erro ao carregar .env.test:', fallbackError.message);
    console.log('⚠️ Continuando sem arquivo .env');
  }
}

const fastify = require('fastify')({ 
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty'
    }
  }
});

// Verificar se módulos necessários existem
let getDatabaseInstance, instanceManager;

try {
  getDatabaseInstance = dbModule.getDatabaseInstance;
  console.log('✅ Módulo de database carregado');
} catch (dbError) {
  console.error('❌ Erro ao carregar módulo de database:', dbError.message);
  
  // Criar função mock se não existir
  getDatabaseInstance = async () => {
    throw new Error('Módulo de database não disponível');
  };
}

try {
  instanceManager = require('../processes/instanceManager');
  console.log('✅ Módulo instanceManager carregado');
} catch (imError) {
  console.error('❌ Erro ao carregar instanceManager:', imError.message);
  
  // Criar funções mock se não existir
  instanceManager = {
    startInstance: async () => false,
    stopInstance: async () => false,
    restartInstance: async () => false,
    listActiveInstances: () => [],
    startAllInstances: async () => 0,
    stopAllInstances: async () => 0,
    isInstanceRunning: () => false,
    getInstanceStats: () => ({ total: 0, running: 0, stopped: 0 })
  };
}

const {
  startInstance,
  stopInstance,
  restartInstance,
  listActiveInstances,
  startAllInstances,
  stopAllInstances,
  isInstanceRunning,
  getInstanceStats
} = instanceManager;

// ✅ PLUGINS
async function registerPlugins() {
  try {
    console.log('🔧 Registrando plugins...');
    
    // CORS para permitir requests do frontend
    await fastify.register(require('@fastify/cors'), {
      origin: [
        'http://localhost:3000',  // Next.js dev
        'http://localhost:3001',  // Alternativo
        'https://your-frontend-domain.vercel.app' // Seu domínio Vercel
      ],
      credentials: true
    });
    console.log('✅ CORS registrado');

    // Helmet para segurança
    await fastify.register(require('@fastify/helmet'), {
      contentSecurityPolicy: false
    });
    console.log('✅ Helmet registrado');

    // Rate limiting
    await fastify.register(require('@fastify/rate-limit'), {
      max: 100,
      timeWindow: '1 minute'
    });
    console.log('✅ Rate limiting registrado');

      await fastify.register(require('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'Starboy API',
        description: 'Documentação da API para o sistema de trading Starboy.',
        version: '1.0.0'
      },
      servers: [{
        url: 'http://localhost:8001',
        description: 'Servidor de Desenvolvimento'
      }],
    },
  });

  await fastify.register(require('@fastify/swagger-ui'), {
    routePrefix: '/docs', // Este é o caminho onde a documentação ficará disponível
    uiConfig: {
      docExpansion: 'list', // 'list' ou 'full'
      deepLinking: true
    },
  });
    
    console.log('✅ Todos os plugins registrados com sucesso');
  } catch (error) {
    console.error('❌ Erro ao registrar plugins:', error);
    throw error;
  }
}

// ✅ SCHEMAS PARA VALIDAÇÃO
const schemas = {
  accountId: {
    type: 'object',
    required: ['accountId'],
    properties: {
      accountId: { type: 'integer', minimum: 1 }
    }
  },
  
  accountResponse: {
    type: 'object',
    properties: {
      id: { type: 'integer' },
      nome: { type: 'string' },
      ativa: { type: 'boolean' },
      status: { type: 'string' },
      isRunning: { type: 'boolean' },
      pid: { type: ['integer', 'null'] },
      startTime: { type: ['string', 'null'] },
      uptimeFormatted: { type: ['string', 'null'] }
    }
  }
};

// ✅ ROTAS DA API

// 📊 Dashboard - Estatísticas gerais
fastify.get('/api/dashboard/stats', async (request, reply) => {
  try {
    const stats = getInstanceStats();
    const activeInstances = listActiveInstances();
    
    const db = await getDatabaseInstance();
    const [totalAccounts] = await db.query('SELECT COUNT(*) as total FROM contas WHERE ativa = 1');
    const totalAtivas = totalAccounts[0].total;
    
    const dashboardStats = {
      system: {
        totalInstances: stats.total,
        runningInstances: stats.running,
        stoppedInstances: stats.stopped,
        totalAccounts: totalAtivas,
        utilizationRate: totalAtivas > 0 ? ((stats.running / totalAtivas) * 100).toFixed(1) : 0
      },
      instances: activeInstances.map(inst => ({
        accountId: inst.accountId,
        name: inst.name,
        pid: inst.pid,
        startTime: inst.startTime.toISOString(),
        uptimeFormatted: inst.uptimeFormatted,
        isRunning: inst.isRunning
      }))
    };
    
    reply.send({
      success: true,
      data: dashboardStats,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar estatísticas:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// 👥 Contas - Listar todas
fastify.get('/api/accounts', async (request, reply) => {
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query(`
      SELECT 
        c.id, 
        c.nome, 
        c.ativa, 
        c.data_criacao,
        c.ultima_atualizacao,
        c.max_posicoes,
        cor.corretora,
        cor.ambiente
      FROM contas c 
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id 
      WHERE c.ativa = 1
      ORDER BY c.id
    `);
    
    const activeInstances = listActiveInstances();
    
    const accountsWithStatus = accounts.map(account => {
      const instance = activeInstances.find(inst => inst.accountId === account.id);
      
      return {
        ...account,
        isRunning: !!instance,
        status: instance ? 'running' : 'stopped',
        pid: instance?.pid || null,
        startTime: instance?.startTime?.toISOString() || null,
        uptimeFormatted: instance?.uptimeFormatted || null,
        corretora: account.corretora || 'N/A',
        ambiente: account.ambiente || 'N/A'
      };
    });
    
    reply.send({
      success: true,
      data: accountsWithStatus,
      total: accountsWithStatus.length
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar contas:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro ao buscar contas',
      message: error.message
    });
  }
});

// 🚀 Contas - Iniciar conta específica
fastify.post('/api/accounts/:id/start', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const accountId = parseInt(request.params.id);
    
    if (isInstanceRunning(accountId)) {
      return reply.status(400).send({
        success: false,
        error: 'Conta já está ativa',
        message: `Conta ID ${accountId} já está rodando`
      });
    }
    
    const success = await startInstance(accountId);
    
    if (success) {
      reply.send({
        success: true,
        message: `Conta ID ${accountId} iniciada com sucesso`,
        data: { accountId, status: 'started' }
      });
    } else {
      reply.status(500).send({
        success: false,
        error: 'Falha ao iniciar conta',
        message: `Não foi possível iniciar a conta ID ${accountId}`
      });
    }
    
  } catch (error) {
    fastify.log.error(`Erro ao iniciar conta ${request.params.id}:`, error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno',
      message: error.message
    });
  }
});

// 🛑 Contas - Parar conta específica
fastify.post('/api/accounts/:id/stop', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const accountId = parseInt(request.params.id);
    
    if (!isInstanceRunning(accountId)) {
      return reply.status(400).send({
        success: false,
        error: 'Conta não está ativa',
        message: `Conta ID ${accountId} não está rodando`
      });
    }
    
    const success = await stopInstance(accountId);
    
    if (success) {
      reply.send({
        success: true,
        message: `Conta ID ${accountId} parada com sucesso`,
        data: { accountId, status: 'stopped' }
      });
    } else {
      reply.status(500).send({
        success: false,
        error: 'Falha ao parar conta',
        message: `Não foi possível parar a conta ID ${accountId}`
      });
    }
    
  } catch (error) {
    fastify.log.error(`Erro ao parar conta ${request.params.id}:`, error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno',
      message: error.message
    });
  }
});

// 🔄 Contas - Reiniciar conta específica
fastify.post('/api/accounts/:id/restart', {
  schema: {
    params: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const accountId = parseInt(request.params.id);
    
    const success = await restartInstance(accountId);
    
    if (success) {
      reply.send({
        success: true,
        message: `Conta ID ${accountId} reiniciada com sucesso`,
        data: { accountId, status: 'restarted' }
      });
    } else {
      reply.status(500).send({
        success: false,
        error: 'Falha ao reiniciar conta',
        message: `Não foi possível reiniciar a conta ID ${accountId}`
      });
    }
    
  } catch (error) {
    fastify.log.error(`Erro ao reiniciar conta ${request.params.id}:`, error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno',
      message: error.message
    });
  }
});

// 🚀 Sistema - Iniciar todas as contas
fastify.post('/api/system/start-all', async (request, reply) => {
  try {
    const successCount = await startAllInstances();
    
    const db = await getDatabaseInstance();
    const [totalAccounts] = await db.query('SELECT COUNT(*) as total FROM contas WHERE ativa = 1');
    const totalAtivas = totalAccounts[0].total;
    
    reply.send({
      success: true,
      message: `${successCount}/${totalAtivas} contas iniciadas com sucesso`,
      data: {
        started: successCount,
        total: totalAtivas,
        successRate: totalAtivas > 0 ? ((successCount / totalAtivas) * 100).toFixed(1) : 0
      }
    });
    
  } catch (error) {
    fastify.log.error('Erro ao iniciar todas as contas:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro ao iniciar contas',
      message: error.message
    });
  }
});

// 🛑 Sistema - Parar todas as contas
fastify.post('/api/system/stop-all', async (request, reply) => {
  try {
    const stoppedCount = await stopAllInstances();
    
    reply.send({
      success: true,
      message: `${stoppedCount} conta(s) parada(s) com sucesso`,
      data: {
        stopped: stoppedCount
      }
    });
    
  } catch (error) {
    fastify.log.error('Erro ao parar todas as contas:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro ao parar contas',
      message: error.message
    });
  }
});

// 📈 Logs - Buscar logs recentes (exemplo)
fastify.get('/api/logs', async (request, reply) => {
  try {
    // Implementar busca de logs se necessário
    reply.send({
      success: true,
      data: [],
      message: 'Endpoint de logs - implementar conforme necessário'
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar logs:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro ao buscar logs',
      message: error.message
    });
  }
});

// ✅ Health Check
fastify.get('/api/health', async (request, reply) => {
  reply.send({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0'
  });
});

// ROTAS DE AUTENTICAÇÃO
async function authenticationRoutes() {
    fastify.post('/api/register', {
    schema: {
        description: 'Registra um novo usuário no sistema.',
        tags: ['Autenticação'],
        summary: 'Registro de novo usuário',
        body: {
            type: 'object',
            required: ['nome', 'username', 'email', 'senha'],
            properties: {
                nome: { type: 'string' },
                username: { type: 'string', minLength: 3, maxLength: 20 },
                email: { type: 'string', format: 'email' },
                senha: { type: 'string', minLength: 6 }
            }
        }
    }
}, async (request, reply) => {
    const { nome, username, email, senha } = request.body;
    const db = await getDatabaseInstance();
    try {
        // Verifica se já existe username OU email
        const [existing] = await db.query('SELECT id FROM users WHERE email = ? OR username = ?', [email, username]);
        if (existing.length > 0) {
            return reply.status(409).send({ error: 'E-mail ou username já cadastrado.' });
        }
        const saltRounds = 10;
        const hashDaSenha = await bcrypt.hash(senha, saltRounds);
        await db.query(
            'INSERT INTO users (nome, username, email, senha, ativa) VALUES (?, ?, ?, ?, 1)',
            [nome, username, email, hashDaSenha]
        );
        reply.status(201).send({
            message: 'Usuário registrado com sucesso!',
            nome,
            username,
            email
        });
    } catch (error) {
        fastify.log.error('Erro no registro:', error);
        reply.status(500).send({ error: 'Erro interno do servidor' });
    }
});

    fastify.post('/api/login', {
        schema: {
            description: 'Autentica um usuário e retorna um token JWT.',
            tags: ['Autenticação'],
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
}

// 👤 ROTAS DE PERFIL DE USUÁRIO

// Obter dados do perfil do usuário
fastify.get('/api/profile/:userId', {
  schema: {
    params: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const db = await getDatabaseInstance();
    
    const [users] = await db.query(`
      SELECT id, nome, username, email, criado_em, atualizado_em, ativo, avatar, telefone
      FROM users 
      WHERE id = ? AND ativo = 1
    `, [userId]);
    
    if (users.length === 0) {
      return reply.status(404).send({
        success: false,
        error: 'Usuário não encontrado'
      });
    }
    
    const user = users[0];
    
    reply.send({
      success: true,
      data: {
        id: user.id,
        nome: user.nome,
        username: user.username,
        email: user.email,
        criado_em: user.criado_em,
        atualizado_em: user.atualizado_em,
        avatar: user.avatar,
        telefone: user.telefone
      }
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar perfil:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Atualizar dados do perfil do usuário
fastify.put('/api/profile/:userId', {
  schema: {
    params: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' }
      }
    },
    body: {
      type: 'object',
      properties: {
        nome: { type: 'string', maxLength: 100 },
        username: { type: 'string', maxLength: 50 },
        email: { type: 'string', maxLength: 100, format: 'email' },
        telefone: { type: 'string', maxLength: 20 },
        avatar: { type: 'string', maxLength: 255 }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const { nome, username, email, telefone, avatar } = request.body;
    const db = await getDatabaseInstance();
    
    // Verificar se usuário existe
    const [existingUser] = await db.query('SELECT id FROM users WHERE id = ? AND ativo = 1', [userId]);
    if (existingUser.length === 0) {
      return reply.status(404).send({
        success: false,
        error: 'Usuário não encontrado'
      });
    }
    
    // Verificar se email/username já existem para outro usuário
    if (email || username) {
      const [duplicates] = await db.query(`
        SELECT id, email, username FROM users 
        WHERE (email = ? OR username = ?) AND id != ? AND ativo = 1
      `, [email || '', username || '', userId]);
      
      if (duplicates.length > 0) {
        const duplicate = duplicates[0];
        const field = duplicate.email === email ? 'email' : 'username';
        return reply.status(400).send({
          success: false,
          error: `Este ${field} já está em uso por outro usuário`
        });
      }
    }
    
    // Preparar campos para atualização
    const updateFields = [];
    const updateValues = [];
    
    if (nome) {
      updateFields.push('nome = ?');
      updateValues.push(nome);
    }
    if (username) {
      updateFields.push('username = ?');
      updateValues.push(username);
    }
    if (email) {
      updateFields.push('email = ?');
      updateValues.push(email);
    }
    if (telefone !== undefined) {
      updateFields.push('telefone = ?');
      updateValues.push(telefone);
    }
    if (avatar !== undefined) {
      updateFields.push('avatar = ?');
      updateValues.push(avatar);
    }
    
    if (updateFields.length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'Nenhum campo válido para atualização'
      });
    }
    
    updateValues.push(userId);
    
    await db.query(`
      UPDATE users 
      SET ${updateFields.join(', ')}, atualizado_em = NOW()
      WHERE id = ?
    `, updateValues);
    
    // Buscar dados atualizados
    const [updatedUser] = await db.query(`
      SELECT id, nome, username, email, criado_em, atualizado_em, avatar, telefone
      FROM users 
      WHERE id = ?
    `, [userId]);
    
    reply.send({
      success: true,
      message: 'Perfil atualizado com sucesso',
      data: updatedUser[0]
    });
    
  } catch (error) {
    fastify.log.error('Erro ao atualizar perfil:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// 🏢 ROTAS DE CORRETORAS DO USUÁRIO

// Listar contas de corretora do usuário
fastify.get('/api/user/:userId/accounts', {
  schema: {
    params: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const db = await getDatabaseInstance();
    
    const [accounts] = await db.query(`
      SELECT 
        c.id,
        c.nome,
        c.descricao,
        c.id_corretora,
        c.ativa,
        c.max_posicoes,
        c.saldo,
        c.saldo_base_calculo,
        c.data_criacao,
        c.ultima_atualizacao,
        c.celular,
        cor.corretora as nome_corretora,
        cor.ambiente
      FROM contas c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.user_id = ? OR c.user_id IS NULL
      ORDER BY c.id DESC
    `, [userId]);
    
    // Formatar dados removendo informações sensíveis
    const accountsFormatted = accounts.map(account => ({
      id: account.id,
      nome: account.nome,
      descricao: account.descricao,
      id_corretora: account.id_corretora,
      nome_corretora: account.nome_corretora,
      ambiente: account.ambiente,
      ativa: account.ativa,
      max_posicoes: account.max_posicoes,
      saldo: parseFloat(account.saldo || 0),
      saldo_base_calculo: parseFloat(account.saldo_base_calculo || 0),
      data_criacao: account.data_criacao,
      ultima_atualizacao: account.ultima_atualizacao,
      celular: account.celular,
      has_api_key: !!(account.api_key),
      has_api_secret: !!(account.api_secret)
    }));
    
    reply.send({
      success: true,
      data: accountsFormatted,
      total: accountsFormatted.length
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar contas do usuário:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Criar nova conta de corretora
fastify.post('/api/user/:userId/accounts', {
  schema: {
    params: {
      type: 'object',
      required: ['userId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' }
      }
    },
    body: {
      type: 'object',
      required: ['nome', 'id_corretora', 'api_key', 'api_secret'],
      properties: {
        nome: { type: 'string', maxLength: 100 },
        descricao: { type: 'string', maxLength: 500 },
        id_corretora: { type: 'integer' },
        api_key: { type: 'string', maxLength: 255 },
        api_secret: { type: 'string', maxLength: 255 },
        ws_api_key: { type: 'string', maxLength: 255 },
        ws_api_secret: { type: 'string', maxLength: 255 },
        telegram_chat_id: { type: 'string', maxLength: 50 },
        celular: { type: 'string', maxLength: 20 },
        max_posicoes: { type: 'integer', minimum: 1, maximum: 100 }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const {
      nome,
      descricao,
      id_corretora,
      api_key,
      api_secret,
      ws_api_key,
      ws_api_secret,
      telegram_chat_id,
      celular,
      max_posicoes = 10
    } = request.body;
    
    const db = await getDatabaseInstance();
    
    // Verificar se corretora existe
    const [corretora] = await db.query('SELECT id, corretora, ambiente FROM corretoras WHERE id = ? AND ativa = 1', [id_corretora]);
    if (corretora.length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'Corretora não encontrada ou inativa'
      });
    }
    
    // Verificar se já existe conta com mesmo nome para este usuário
    const [existingAccount] = await db.query(
      'SELECT id FROM contas WHERE nome = ? AND (user_id = ? OR user_id IS NULL)',
      [nome, userId]
    );
    
    if (existingAccount.length > 0) {
      return reply.status(400).send({
        success: false,
        error: 'Já existe uma conta com este nome'
      });
    }
    
    // Inserir nova conta
    const [result] = await db.query(`
      INSERT INTO contas (
        nome, descricao, id_corretora, api_key, api_secret, 
        ws_api_key, ws_api_secret, telegram_chat_id, celular,
        max_posicoes, user_id, ativa, data_criacao
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())
    `, [
      nome, descricao, id_corretora, api_key, api_secret,
      ws_api_key, ws_api_secret, telegram_chat_id, celular,
      max_posicoes, userId
    ]);
    
    const accountId = result.insertId;
    
    // Buscar dados da conta criada
    const [newAccount] = await db.query(`
      SELECT 
        c.id, c.nome, c.descricao, c.id_corretora, c.ativa,
        c.max_posicoes, c.data_criacao,
        cor.corretora as nome_corretora, cor.ambiente
      FROM contas c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ?
    `, [accountId]);
    
    reply.send({
      success: true,
      message: 'Conta de corretora criada com sucesso',
      data: {
        id: newAccount[0].id,
        nome: newAccount[0].nome,
        descricao: newAccount[0].descricao,
        id_corretora: newAccount[0].id_corretora,
        nome_corretora: newAccount[0].nome_corretora,
        ambiente: newAccount[0].ambiente,
        ativa: newAccount[0].ativa,
        max_posicoes: newAccount[0].max_posicoes,
        data_criacao: newAccount[0].data_criacao
      }
    });
    
  } catch (error) {
    fastify.log.error('Erro ao criar conta de corretora:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Atualizar conta de corretora
fastify.put('/api/user/:userId/accounts/:accountId', {
  schema: {
    params: {
      type: 'object',
      required: ['userId', 'accountId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' },
        accountId: { type: 'string', pattern: '^[0-9]+$' }
      }
    },
    body: {
      type: 'object',
      properties: {
        nome: { type: 'string', maxLength: 100 },
        descricao: { type: 'string', maxLength: 500 },
        id_corretora: { type: 'integer' },
        api_key: { type: 'string', maxLength: 255 },
        api_secret: { type: 'string', maxLength: 255 },
        ws_api_key: { type: 'string', maxLength: 255 },
        ws_api_secret: { type: 'string', maxLength: 255 },
        telegram_chat_id: { type: 'string', maxLength: 50 },
        celular: { type: 'string', maxLength: 20 },
        max_posicoes: { type: 'integer', minimum: 1, maximum: 100 },
        ativa: { type: 'boolean' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const accountId = parseInt(request.params.accountId);
    const db = await getDatabaseInstance();
    
    // Verificar se conta existe e pertence ao usuário
    const [existingAccount] = await db.query(
      'SELECT id FROM contas WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
      [accountId, userId]
    );
    
    if (existingAccount.length === 0) {
      return reply.status(404).send({
        success: false,
        error: 'Conta não encontrada'
      });
    }
    
    // Preparar campos para atualização
    const updateFields = [];
    const updateValues = [];
    const allowedFields = [
      'nome', 'descricao', 'id_corretora', 'api_key', 'api_secret',
      'ws_api_key', 'ws_api_secret', 'telegram_chat_id', 'celular',
      'max_posicoes', 'ativa'
    ];
    
    allowedFields.forEach(field => {
      if (request.body[field] !== undefined) {
        updateFields.push(`${field} = ?`);
        updateValues.push(request.body[field]);
      }
    });
    
    if (updateFields.length === 0) {
      return reply.status(400).send({
        success: false,
        error: 'Nenhum campo válido para atualização'
      });
    }
    
    // Verificar se nova corretora existe (se foi alterada)
    if (request.body.id_corretora) {
      const [corretora] = await db.query(
        'SELECT id FROM corretoras WHERE id = ? AND ativa = 1',
        [request.body.id_corretora]
      );
      if (corretora.length === 0) {
        return reply.status(400).send({
          success: false,
          error: 'Corretora não encontrada ou inativa'
        });
      }
    }
    
    updateValues.push(accountId);
    
    await db.query(`
      UPDATE contas 
      SET ${updateFields.join(', ')}, ultima_atualizacao = NOW()
      WHERE id = ?
    `, updateValues);
    
    // Buscar dados atualizados
    const [updatedAccount] = await db.query(`
      SELECT 
        c.id, c.nome, c.descricao, c.id_corretora, c.ativa,
        c.max_posicoes, c.ultima_atualizacao,
        cor.corretora as nome_corretora, cor.ambiente
      FROM contas c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ?
    `, [accountId]);
    
    reply.send({
      success: true,
      message: 'Conta atualizada com sucesso',
      data: updatedAccount[0]
    });
    
  } catch (error) {
    fastify.log.error('Erro ao atualizar conta de corretora:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Deletar conta de corretora
fastify.delete('/api/user/:userId/accounts/:accountId', {
  schema: {
    params: {
      type: 'object',
      required: ['userId', 'accountId'],
      properties: {
        userId: { type: 'string', pattern: '^[0-9]+$' },
        accountId: { type: 'string', pattern: '^[0-9]+$' }
      }
    }
  }
}, async (request, reply) => {
  try {
    const userId = parseInt(request.params.userId);
    const accountId = parseInt(request.params.accountId);
    const db = await getDatabaseInstance();
    
    // Verificar se conta existe e pertence ao usuário
    const [existingAccount] = await db.query(
      'SELECT id, nome FROM contas WHERE id = ? AND (user_id = ? OR user_id IS NULL)',
      [accountId, userId]
    );
    
    if (existingAccount.length === 0) {
      return reply.status(404).send({
        success: false,
        error: 'Conta não encontrada'
      });
    }
    
    // Verificar se existem posições abertas
    const [openPositions] = await db.query(
      'SELECT COUNT(*) as count FROM posicoes WHERE conta_id = ? AND status = "OPEN"',
      [accountId]
    );
    
    if (openPositions[0].count > 0) {
      return reply.status(400).send({
        success: false,
        error: 'Não é possível deletar conta com posições abertas',
        details: `Existem ${openPositions[0].count} posições abertas`
      });
    }
    
    // Verificar se existem ordens ativas
    const [activeOrders] = await db.query(
      `SELECT COUNT(*) as count FROM ordens 
       WHERE conta_id = ? AND status IN ('NEW', 'PARTIALLY_FILLED')`,
      [accountId]
    );
    
    if (activeOrders[0].count > 0) {
      return reply.status(400).send({
        success: false,
        error: 'Não é possível deletar conta com ordens ativas',
        details: `Existem ${activeOrders[0].count} ordens ativas`
      });
    }
    
    // Marcar como inativa ao invés de deletar (soft delete)
    await db.query(
      'UPDATE contas SET ativa = 0, ultima_atualizacao = NOW() WHERE id = ?',
      [accountId]
    );
    
    reply.send({
      success: true,
      message: `Conta "${existingAccount[0].nome}" foi desativada com sucesso`
    });
    
  } catch (error) {
    fastify.log.error('Erro ao deletar conta de corretora:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// Listar corretoras disponíveis
fastify.get('/api/brokers', async (request, reply) => {
  try {
    const db = await getDatabaseInstance();
    
    const [brokers] = await db.query(`
      SELECT id, corretora, ambiente, data_criacao, ultima_atualizacao
      FROM corretoras 
      WHERE ativa = 1
      ORDER BY corretora, ambiente
    `);
    
    reply.send({
      success: true,
      data: brokers,
      total: brokers.length
    });
    
  } catch (error) {
    fastify.log.error('Erro ao buscar corretoras:', error);
    reply.status(500).send({
      success: false,
      error: 'Erro interno do servidor',
      message: error.message
    });
  }
});

// ✅ INICIALIZAÇÃO DO SERVIDOR COM MELHOR TRATAMENTO DE ERRO
async function startServer() {
  try {
    console.log('🚀 Iniciando servidor API...');
    
    // Verificar variáveis de ambiente essenciais
    const requiredVars = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const missingVars = requiredVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
      console.warn(`⚠️ Variáveis de ambiente ausentes: ${missingVars.join(', ')}`);
      console.warn('⚠️ Algumas funcionalidades podem não funcionar corretamente');
    }
    
    console.log('🔧 Registrando plugins...');
    await registerPlugins();
    await authenticationRoutes(); // Registra as rotas de autenticação
    
    const port = process.env.API_PORT || 8001;
    const host = process.env.API_HOST || '0.0.0.0';
    
    console.log(`🚀 Iniciando servidor na porta ${port}...`);
    await fastify.listen({ port, host });
    
    console.log('✅ ================================');
    console.log(`✅ API Server rodando em http://${host}:${port}`);
    console.log(`📊 Dashboard: http://${host}:${port}/api/dashboard/stats`);
    console.log(`👥 Contas: http://${host}:${port}/api/accounts`);
    console.log(`💚 Health Check: http://${host}:${port}/api/health`);
    console.log('✅ ================================');
    
  } catch (error) {
    console.error('❌ ERRO FATAL ao iniciar servidor:', error);
    console.error('Stack trace:', error.stack);
    
    // Log detalhado do erro
    if (error.code === 'EADDRINUSE') {
      console.error('❌ Porta já está em uso. Tente uma porta diferente ou pare o processo que está usando a porta.');
    } else if (error.code === 'ENOENT') {
      console.error('❌ Arquivo ou diretório não encontrado:', error.path);
    } else if (error.code === 'MODULE_NOT_FOUND') {
      console.error('❌ Módulo não encontrado:', error.message);
    }
    
    process.exit(1);
  }
}

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
  console.error('Stack trace:', error.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
  console.error('Promise:', promise);
  process.exit(1);
});

// Iniciar servidor
if (require.main === module) {
  startServer();
}

module.exports = { fastify, startServer };