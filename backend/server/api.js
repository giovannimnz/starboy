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
  await fastify.register(require('@fastify/cors'), {
    origin: [
      process.env.FRONTEND_URL || 'http://0.0.0.0:3050',
      `http://0.0.0.0:${process.env.FRONTEND_PORT || 3050}`,
      `http://localhost:${process.env.FRONTEND_PORT || 3050}`,
      `http://127.0.0.1:${process.env.FRONTEND_PORT || 3050}`,
      // Permitir qualquer origem para desenvolvimento (remover em produção)
      '*'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
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
  
  // Configuração do Swagger - Versão mais robusta
  await fastify.register(require('@fastify/swagger'), {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Starboy API',
        description: 'Documentação da API para o sistema de trading Starboy.',
        version: '1.0.0',
        contact: {
          name: 'Suporte API',
          email: 'suporte@starboy.com'
        }
      },
      servers: [
        {
          url: `http://0.0.0.0:${process.env.API_PORT || 8050}`,
          description: 'Servidor de Desenvolvimento'
        },
        {
          url: `http://137.131.190.161:${process.env.API_PORT || 8050}`,
          description: 'Servidor de Produção'
        }
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Token JWT para autenticação nas rotas protegidas'
          }
        },
        schemas: {
          Error: {
            type: 'object',
            properties: {
              error: {
                type: 'string',
                description: 'Mensagem de erro'
              }
            }
          },
          Success: {
            type: 'object',
            properties: {
              success: {
                type: 'boolean',
                description: 'Indica se a operação foi bem-sucedida'
              },
              message: {
                type: 'string',
                description: 'Mensagem de sucesso'
              }
            }
          }
        }
      },
      tags: [
        {
          name: 'Sistema',
          description: 'Endpoints do sistema'
        },
        {
          name: 'Usuários',
          description: 'Gestão de usuários'
        },
        {
          name: 'Contas',
          description: 'Gestão de contas de trading'
        },
        {
          name: 'Dashboard',
          description: 'Dados do dashboard'
        },
        {
          name: 'Telegram',
          description: 'Integração com Telegram'
        }
      ]
    },
    exposeRoute: true,
    hideUntagged: false,
    stripBasePath: false
  });

  // Configuração do Swagger UI - Versão mais robusta
  await fastify.register(require('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    exposeRoute: true,
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      defaultModelsExpandDepth: 1,
      defaultModelExpandDepth: 1,
      displayRequestDuration: true,
      tryItOutEnabled: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      persistAuthorization: true
    },
    uiHooks: {
      onRequest: function (request, reply, next) { 
        // Log das requisições do Swagger
        console.log(`[SWAGGER] ${request.method} ${request.url}`);
        next();
      },
      preHandler: function (request, reply, next) { 
        next();
      }
    },
    staticCSP: true,
    transformStaticCSP: (header) => header,
    transformSpecification: (swaggerObject, request, reply) => {
      // Validação adicional do objeto Swagger
      if (!swaggerObject.components) {
        swaggerObject.components = {};
      }
      if (!swaggerObject.components.securitySchemes) {
        swaggerObject.components.securitySchemes = {};
      }
      if (!swaggerObject.components.securitySchemes.bearerAuth) {
        swaggerObject.components.securitySchemes.bearerAuth = {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT para autenticação'
        };
      }
      return swaggerObject;
    },
    transformSpecificationClone: true
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

  // Registra o plugin de contas e adiciona um prefixo /api
  await fastify.register(require('./routes/accounts'), { prefix: '/api' });

  // ✅ CORREÇÃO: Caminho correto para telegram
  await fastify.register(require('./routes/telegram/telegram'), { prefix: '/api/telegram' });

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

    const port = process.env.API_PORT || 8050;
    const host = process.env.API_HOST || '0.0.0.0';
    
    await fastify.listen({ port, host });
    
    fastify.log.info(`🚀 API Server rodando em http://${host}:${port}`);
    fastify.log.info(`📚 Documentação da API disponível em http://${host}:${port}/docs`);
    
  } catch (error) {
    fastify.log.error('Erro ao iniciar servidor:', error);
    console.error('Stack trace completo:', error.stack);
    process.exit(1);
  }
}

startServer();

module.exports = { fastify };