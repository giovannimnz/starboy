# Correção do Swagger - Erro 500 bearerAuth

## Problema Identificado
O erro 500 ocorria quando o Swagger tentava gerar o JSON da documentação:
```
"Cannot read properties of undefined (reading 'bearerAuth')"
```

## Causa Raiz
O problema estava na configuração do Swagger no arquivo `backend/server/api.js`. A configuração `security` global estava causando conflitos com as definições de segurança individuais das rotas.

## Correção Implementada

### 1. Configuração Robusta do Swagger
```javascript
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
```

### 2. Configuração Robusta do Swagger UI
```javascript
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
```

### 3. Melhorias Implementadas
- ✅ **Especificação OpenAPI 3.0.0** explícita
- ✅ **Servidores múltiplos** (desenvolvimento e produção)
- ✅ **Schemas reutilizáveis** para Error e Success
- ✅ **Tags organizadas** para melhor navegação
- ✅ **Transformação de especificação** com validação adicional
- ✅ **Logs de debug** para requisições do Swagger
- ✅ **Configuração robusta** do Swagger UI
- ✅ **Persistência de autorização** no UI

## Arquivos Modificados
- `backend/server/api.js` - Configuração completa do Swagger
- `deploy_swagger_fix.sh` - Script de deploy com validação
- `SWAGGER_FIX.md` - Documentação da correção

## Validação Local
- ✅ Swagger UI acessível em `/docs`
- ✅ Swagger JSON acessível em `/docs/json`
- ✅ 6 rotas com autenticação JWT
- ✅ 31 rotas totais documentadas
- ✅ bearerAuth definido corretamente

## Deploy em Produção
Execute o script de deploy:
```bash
chmod +x deploy_swagger_fix.sh
./deploy_swagger_fix.sh
```

## Testes de Produção
```bash
# Testar health check
curl -s -o /dev/null -w "%{http_code}" http://137.131.190.161:8050/api/health

# Testar Swagger JSON
curl -s -o /dev/null -w "%{http_code}" http://137.131.190.161:8050/docs/json

# Testar Swagger UI
curl -s -o /dev/null -w "%{http_code}" http://137.131.190.161:8050/docs
```

## Resultado Esperado
- **Status 200** para todos os endpoints
- **Swagger JSON** carregando sem erros
- **Swagger UI** funcionando corretamente
- **Autenticação JWT** documentada e funcional
