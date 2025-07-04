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

async function testFullServer() {
  console.log('🔍 Testando servidor completo...');
  
  try {
    // Registra CORS
    await fastify.register(require('@fastify/cors'), {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      credentials: true
    });

    // Registra Swagger
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
      routePrefix: '/docs'
    });

    // Registra rotas uma por uma para identificar problemas
    console.log('📋 Registrando rotas...');
    
    try {
      await fastify.register(require('./backend/server/routes/users'), { prefix: '/api' });
      console.log('✅ Rotas de usuários registradas');
    } catch (error) {
      console.error('❌ Erro nas rotas de usuários:', error.message);
    }
    
    try {
      await fastify.register(require('./backend/server/routes/dashboard'), { prefix: '/api' });
      console.log('✅ Rotas de dashboard registradas');
    } catch (error) {
      console.error('❌ Erro nas rotas de dashboard:', error.message);
    }
    
    try {
      await fastify.register(require('./backend/server/routes/accounts'), { prefix: '/api' });
      console.log('✅ Rotas de accounts registradas');
    } catch (error) {
      console.error('❌ Erro nas rotas de accounts:', error.message);
    }
    
    try {
      await fastify.register(require('./backend/server/routes/telegram/telegram'), { prefix: '/api/telegram' });
      console.log('✅ Rotas de telegram registradas');
    } catch (error) {
      console.error('❌ Erro nas rotas de telegram:', error.message);
    }

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
    const swaggerObject = fastify.swagger();
    console.log('✅ Swagger JSON gerado com sucesso');
    console.log('📊 Rotas encontradas:', Object.keys(swaggerObject.paths || {}));
    
    // Inicia o servidor
    const port = process.env.API_PORT || 8050;
    const host = '0.0.0.0';
    
    await fastify.listen({ port, host });
    console.log(`🚀 Servidor rodando em http://${host}:${port}`);
    console.log(`📚 Swagger disponível em http://${host}:${port}/docs`);
    
    // Aguarda um pouco e faz requisições de teste
    setTimeout(async () => {
      console.log('🔄 Testando endpoints...');
      
      const fetch = require('isomorphic-fetch');
      
      try {
        const response = await fetch(`http://${host}:${port}/docs/json`);
        console.log(`📄 /docs/json - Status: ${response.status}`);
        
        if (response.ok) {
          console.log('✅ Swagger JSON endpoint funcionando');
        } else {
          const error = await response.text();
          console.error('❌ Erro no JSON endpoint:', error);
        }
      } catch (error) {
        console.error('❌ Erro ao testar JSON endpoint:', error.message);
      }
      
      // Finaliza o servidor
      await fastify.close();
      console.log('🛑 Servidor finalizado');
    }, 3000);
    
  } catch (error) {
    console.error('❌ Erro ao testar servidor completo:', error);
    console.error('Stack trace:', error.stack);
  }
}

testFullServer().catch(console.error);
