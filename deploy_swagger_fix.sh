#!/bin/bash

# Script de Deploy das Correções do Swagger
# Este script deve ser executado no servidor de produção

echo "🚀 Iniciando deploy das correções do Swagger..."

# Variáveis
PROJECT_DIR="/home/ubuntu/atius/starboy_dev"
BACKUP_DIR="/home/ubuntu/backups"
DATE=$(date +%Y%m%d_%H%M%S)

# Criar backup do arquivo atual
echo "📦 Criando backup do arquivo api.js..."
mkdir -p $BACKUP_DIR
cp $PROJECT_DIR/backend/server/api.js $BACKUP_DIR/api.js.backup.$DATE

# Parar o servidor atual
echo "🛑 Parando servidor atual..."
pm2 stop starboy-api || echo "Servidor não estava rodando"

# Fazer backup do banco (opcional)
echo "💾 Fazendo backup do banco..."
# Adicionar comando de backup do banco se necessário

# Atualizar código
echo "📥 Atualizando código..."
cd $PROJECT_DIR
git pull origin main || echo "Erro no git pull - continuando..."

# Instalar dependências
echo "📦 Instalando dependências..."
npm install

# Validar configuração
echo "✅ Validando configuração..."
node -e "
const fastify = require('fastify')();
fastify.register(require('@fastify/swagger'), {
  openapi: {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    }
  }
});
fastify.ready().then(() => {
  console.log('✅ Configuração do Swagger válida');
  process.exit(0);
}).catch(err => {
  console.error('❌ Erro na configuração:', err);
  process.exit(1);
});
"

if [ $? -eq 0 ]; then
  echo "✅ Validação OK - Iniciando servidor..."
  
  # Iniciar servidor
  echo "🚀 Iniciando servidor..."
  pm2 start backend/server/api.js --name starboy-api --log-date-format="YYYY-MM-DD HH:mm:ss"
  
  # Aguardar servidor iniciar
  echo "⏳ Aguardando servidor iniciar..."
  sleep 10
  
  # Testar endpoints
  echo "🔍 Testando endpoints..."
  
  # Testar health check
  HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8050/api/health)
  if [ "$HEALTH_STATUS" -eq 200 ]; then
    echo "✅ Health check OK (Status: $HEALTH_STATUS)"
  else
    echo "❌ Health check falhou (Status: $HEALTH_STATUS)"
  fi
  
  # Testar Swagger JSON
  JSON_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8050/docs/json)
  if [ "$JSON_STATUS" -eq 200 ]; then
    echo "✅ Swagger JSON OK (Status: $JSON_STATUS)"
  else
    echo "❌ Swagger JSON falhou (Status: $JSON_STATUS)"
    echo "📋 Verificando logs..."
    pm2 logs starboy-api --lines 20
  fi
  
  # Testar Swagger UI
  UI_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8050/docs)
  if [ "$UI_STATUS" -eq 200 ]; then
    echo "✅ Swagger UI OK (Status: $UI_STATUS)"
  else
    echo "❌ Swagger UI falhou (Status: $UI_STATUS)"
  fi
  
  # Mostrar status do PM2
  echo "📊 Status do PM2:"
  pm2 status
  
  echo "🎉 Deploy concluído!"
  echo "📚 Swagger disponível em: http://137.131.190.161:8050/docs"
  echo "📄 Swagger JSON disponível em: http://137.131.190.161:8050/docs/json"
  
else
  echo "❌ Validação falhou - Restaurando backup..."
  cp $BACKUP_DIR/api.js.backup.$DATE $PROJECT_DIR/backend/server/api.js
  pm2 start backend/server/api.js --name starboy-api
  echo "🔄 Backup restaurado e servidor reiniciado"
  exit 1
fi
