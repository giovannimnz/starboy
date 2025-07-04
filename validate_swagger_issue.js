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

async function validateSwaggerIssue() {
  console.log('🔍 Investigando problema específico do Swagger...');
  
  try {
    // Configuração básica do Swagger
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
      routePrefix: '/docs'
    });

    // Rota de teste com security
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

    // Rota de teste sem security
    fastify.get('/test-no-auth', {
      schema: {
        description: 'Rota de teste sem auth',
        tags: ['Test'],
        summary: 'Teste sem auth'
      }
    }, async (request, reply) => {
      return { success: true };
    });

    await fastify.ready();
    console.log('✅ Fastify ready');

    // Testa geração do swagger
    try {
      const swaggerObject = fastify.swagger();
      console.log('✅ Swagger object gerado sem erro');
      
      // Verifica se há rotas com security
      const paths = swaggerObject.paths || {};
      console.log('📋 Verificando security nas rotas...');
      
      for (const [path, methods] of Object.entries(paths)) {
        for (const [method, config] of Object.entries(methods)) {
          if (config.security) {
            console.log(`🔒 Rota ${method.toUpperCase()} ${path} tem security:`, config.security);
            
            // Verifica se a security referencia bearerAuth
            config.security.forEach(securityItem => {
              if (securityItem.bearerAuth !== undefined) {
                console.log(`  📝 Referência bearerAuth encontrada`);
                
                // Verifica se bearerAuth está definido nos components
                if (swaggerObject.components && swaggerObject.components.securitySchemes && swaggerObject.components.securitySchemes.bearerAuth) {
                  console.log(`  ✅ bearerAuth definido nos components`);
                } else {
                  console.log(`  ❌ bearerAuth NÃO definido nos components`);
                }
              }
            });
          }
        }
      }
      
      console.log('🎉 Validação concluída com sucesso!');
      
    } catch (swaggerError) {
      console.error('❌ Erro ao gerar swagger object:', swaggerError);
      console.error('Stack:', swaggerError.stack);
    }
    
  } catch (error) {
    console.error('❌ Erro na validação:', error);
    console.error('Stack:', error.stack);
  }
}

validateSwaggerIssue().catch(console.error);
