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

// PLUGINS
async function registerPlugins() {
  // CORS para permitir requests do frontend
  await fastify.register(require('@fastify/cors'), {
    origin: true,
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
  
  // Configuração do Swagger
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
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
  });

  fastify.log.info('Plugins registrados com sucesso.');
}

// ROTAS
async function registerRoutes() {
  fastify.log.info('Registrando rotas...');
  
  // Registra o plugin de usuario e adiciona um prefixo /api
  await fastify.register(require('./routes/users'), { prefix: '/api' });
  
  // Registra o plugin de dashboard e adiciona um prefixo /api
  await fastify.register(require('./routes/dashboard'), { prefix: '/api' });

  // Rota de Health Check
  fastify.get('/api/health', {
    schema: {
      description: 'Verifica a saúde da API.',
      tags: ['Sistema'],
      summary: 'Health Check',
    }
  }, async (request, reply) => {
    reply.send({
      success: true,
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  });

  fastify.log.info('Rotas registradas com sucesso.');
}

// INICIALIZAÇÃO DO SERVIDOR
async function startServer() {
  try {
    fastify.log.info('Iniciando servidor API...');
    
    await registerPlugins();
    await registerRoutes();

    const port = process.env.API_PORT || 8001;
    const host = process.env.API_HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    
    fastify.log.info(`🚀 API Server rodando em http://${host}:${port}`);
    fastify.log.info(`📚 Documentação da API disponível em http://${host}:${port}/docs`);
    
  } catch (error) {
    fastify.log.error('Erro ao iniciar servidor:', error);
    process.exit(1);
  }
}

startServer();

module.exports = { fastify };