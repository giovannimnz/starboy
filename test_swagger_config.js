const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, './config/.env') });

const fastify = require('fastify')({ 
  logger: {
    level: 'info',
    transport: {
      target: 'pino-pretty'
    }
  }
});

async function testSwaggerConfig() {
  console.log('🔍 Testando configuração do Swagger...');
  
  try {
    // Registra apenas o swagger sem as rotas
    await fastify.register(require('@fastify/swagger'), {
      openapi: {
        info: {
          title: 'Starboy API',
          description: 'Documentação da API para o sistema de trading Starboy.',
          version: '1.0.0'
        },
        servers: [{
          url: `http://0.0.0.0:${process.env.API_PORT || 8050}`,
          description: 'Servidor de Desenvolvimento'
        }],
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
              description: 'Token JWT para autenticação'
            }
          }
        },
        security: [
          {
            bearerAuth: []
          }
        ]
      },
    });

    await fastify.register(require('@fastify/swagger-ui'), {
      routePrefix: '/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 1,
        displayRequestDuration: true,
        tryItOutEnabled: true
      },
      uiHooks: {
        onRequest: function (request, reply, next) { next() },
        preHandler: function (request, reply, next) { next() }
      },
      staticCSP: true,
      transformStaticCSP: (header) => header,
      transformSpecification: (swaggerObject, request, reply) => { return swaggerObject },
      transformSpecificationClone: true
    });

    console.log('✅ Swagger configurado sem erros');
    
    // Testa uma rota simples para verificar se o schema funciona
    fastify.get('/test', {
      schema: {
        description: 'Rota de teste',
        tags: ['Test'],
        summary: 'Teste',
        security: [{ bearerAuth: [] }]
      }
    }, async (request, reply) => {
      return { success: true };
    });

    await fastify.ready();
    console.log('✅ Fastify ready - configuração válida');
    
    // Testa se o swagger JSON pode ser gerado
    const swaggerObject = fastify.swagger();
    console.log('✅ Swagger object gerado:', Object.keys(swaggerObject));
    
    if (swaggerObject.components && swaggerObject.components.securitySchemes && swaggerObject.components.securitySchemes.bearerAuth) {
      console.log('✅ bearerAuth encontrado na configuração');
    } else {
      console.log('❌ bearerAuth não encontrado');
    }
    
    console.log('🎉 Teste concluído com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro na configuração do Swagger:', error);
    console.error('Stack trace:', error.stack);
  }
}

testSwaggerConfig().catch(console.error);
