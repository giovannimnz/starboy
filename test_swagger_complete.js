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

async function testSwaggerFix() {
  console.log('🔍 Testando correção do Swagger...');
  
  try {
    // Registra plugins básicos
    await fastify.register(require('@fastify/cors'), {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: true
    });

    // Configuração do Swagger (igual ao api.js corrigido)
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
        }
      }
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

    // Registra as rotas
    console.log('📋 Registrando rotas...');
    await fastify.register(require('./backend/server/routes/users'), { prefix: '/api' });
    await fastify.register(require('./backend/server/routes/dashboard'), { prefix: '/api' });
    await fastify.register(require('./backend/server/routes/accounts'), { prefix: '/api' });
    await fastify.register(require('./backend/server/routes/telegram/telegram'), { prefix: '/api/telegram' });

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

    console.log('✅ Todas as rotas registradas');
    
    await fastify.ready();
    console.log('✅ Fastify ready');
    
    // Testa o swagger object
    try {
      const swaggerObject = fastify.swagger();
      console.log('✅ Swagger JSON gerado com sucesso');
      
      // Verifica se bearerAuth está definido
      if (swaggerObject.components && swaggerObject.components.securitySchemes && swaggerObject.components.securitySchemes.bearerAuth) {
        console.log('✅ bearerAuth definido corretamente');
      } else {
        console.log('❌ bearerAuth não definido');
      }
      
      // Conta rotas com security
      const paths = swaggerObject.paths || {};
      let routesWithSecurity = 0;
      
      for (const [path, methods] of Object.entries(paths)) {
        for (const [method, config] of Object.entries(methods)) {
          if (config.security) {
            routesWithSecurity++;
          }
        }
      }
      
      console.log(`📊 Rotas com security: ${routesWithSecurity}`);
      console.log(`📊 Total de rotas: ${Object.keys(paths).length}`);
      
    } catch (swaggerError) {
      console.error('❌ Erro ao gerar swagger object:', swaggerError);
      return;
    }
    
    // Inicia o servidor
    const port = process.env.API_PORT || 8050;
    const host = '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`🚀 Servidor rodando em http://${host}:${port}`);
    console.log(`📚 Swagger disponível em http://${host}:${port}/docs`);
    
    // Testa endpoints com fetch
    setTimeout(async () => {
      console.log('🔄 Testando endpoints...');
      
      const fetch = require('isomorphic-fetch');
      
      try {
        console.log('🔄 Testando /docs/json...');
        const jsonResponse = await fetch(`http://${host}:${port}/docs/json`);
        console.log(`📄 /docs/json - Status: ${jsonResponse.status}`);
        
        if (jsonResponse.ok) {
          console.log('✅ Swagger JSON endpoint funcionando!');
        } else {
          const errorText = await jsonResponse.text();
          console.error('❌ Erro no JSON endpoint:', errorText);
        }
        
        console.log('🔄 Testando /docs...');
        const docsResponse = await fetch(`http://${host}:${port}/docs`);
        console.log(`🎨 /docs - Status: ${docsResponse.status}`);
        
        if (docsResponse.ok) {
          console.log('✅ Swagger UI endpoint funcionando!');
        } else {
          const errorText = await docsResponse.text();
          console.error('❌ Erro no UI endpoint:', errorText);
        }
        
        console.log('🔄 Testando /api/health...');
        const healthResponse = await fetch(`http://${host}:${port}/api/health`);
        console.log(`💚 /api/health - Status: ${healthResponse.status}`);
        
        if (healthResponse.ok) {
          const healthData = await healthResponse.json();
          console.log('✅ Health endpoint funcionando:', healthData);
        } else {
          const errorText = await healthResponse.text();
          console.error('❌ Erro no health endpoint:', errorText);
        }
        
      } catch (fetchError) {
        console.error('❌ Erro ao testar endpoints:', fetchError);
      }
      
      // Finaliza o servidor
      await fastify.close();
      console.log('🛑 Servidor finalizado');
      console.log('🎉 Teste concluído!');
    }, 3000);
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
    console.error('Stack:', error.stack);
  }
}

testSwaggerFix().catch(console.error);
