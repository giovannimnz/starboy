const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../config/.env') });

const fastify = require('fastify')({ 
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty'
    }
  }
});

const { getDatabaseInstance } = require('../core/database/conexao');
const {
  startInstance,
  stopInstance,
  restartInstance,
  listActiveInstances,
  startAllInstances,
  stopAllInstances,
  isInstanceRunning,
  getInstanceStats
} = require('../processes/instanceManager');

// ✅ PLUGINS
async function registerPlugins() {
  // CORS para permitir requests do frontend
  await fastify.register(require('@fastify/cors'), {
    origin: [
      'http://localhost:3000',  // Next.js dev
      'http://localhost:3001',  // Alternativo
      'https://your-frontend-domain.vercel.app' // Seu domínio Vercel
    ],
    credentials: true
  });

  // Helmet para segurança
  await fastify.register(require('@fastify/helmet'), {
    contentSecurityPolicy: false
  });

  // Rate limiting
  await fastify.register(require('@fastify/rate-limit'), {
    max: 100,
    timeWindow: '1 minute'
  });
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

// ✅ INICIALIZAÇÃO DO SERVIDOR
async function startServer() {
  try {
    await registerPlugins();
    
    const port = process.env.API_PORT || 8000;
    const host = process.env.API_HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    
    console.log(`🚀 API Server rodando em http://${host}:${port}`);
    console.log(`📊 Dashboard: http://${host}:${port}/api/dashboard/stats`);
    console.log(`👥 Contas: http://${host}:${port}/api/accounts`);
    
  } catch (error) {
    fastify.log.error('Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

// Iniciar servidor
if (require.main === module) {
  startServer();
}

module.exports = { fastify, startServer };