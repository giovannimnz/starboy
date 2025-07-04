# Configuração de Portas Centralizadas

Este documento descreve como todas as configurações de porta do projeto estão centralizadas no arquivo `.env`.

## ✅ Configurações Centralizadas

Todas as portas estão agora configuradas no arquivo `config/.env`:

```properties
# API Configuration
API_PORT=8050
API_HOST=0.0.0.0

# Frontend Configuration
FRONTEND_PORT=3050
FRONTEND_HOST=localhost
FRONTEND_URL=http://localhost:3050

# Database Configuration
DB_PORT=3306

# Webhook Configuration
WEBHOOK_URL=http://localhost:8050/webhook-sinal
```

## 📁 Arquivos Atualizados

### Backend (`backend/server/api.js`)
- ✅ Usa `process.env.API_PORT` com fallback para 8050
- ✅ Usa `process.env.FRONTEND_URL` e `process.env.FRONTEND_PORT` para CORS
- ✅ Swagger UI usa porta da variável de ambiente

### Frontend (`frontend/package.json`)
- ✅ Scripts `dev` e `start` usam `${FRONTEND_PORT:-3050}`
- ✅ Fallback para 3050 se a variável não estiver definida

### Python Scripts (`backend/indicators/divap.py`)
- ✅ Webhook URL usa `os.getenv("API_PORT", "8050")`
- ✅ URL construída dinamicamente: `http://localhost:{API_PORT}/webhook-sinal`

## 🔧 Como Usar

### 1. Para alterar as portas:
Edite apenas o arquivo `config/.env`:

```properties
# Exemplo: mudando as portas
API_PORT=8080
FRONTEND_PORT=3000
```

### 2. Para desenvolvimento:
```bash
# Backend irá rodar na porta definida em API_PORT
cd backend && npm start

# Frontend irá rodar na porta definida em FRONTEND_PORT  
cd frontend && npm run dev
```

### 3. Para produção:
```bash
# Configure as variáveis de ambiente do sistema ou use um arquivo .env.production
export API_PORT=8050
export FRONTEND_PORT=3050
```

## 📋 Benefícios

1. **Configuração Única**: Todas as portas em um só lugar
2. **Flexibilidade**: Fácil alteração para diferentes ambientes
3. **Consistência**: Evita conflitos entre hardcoded ports
4. **Docker Ready**: Pronto para containerização
5. **CI/CD Friendly**: Fácil configuração em pipelines

## 🚨 Importante

- Sempre use as variáveis de ambiente em vez de valores hardcoded
- Mantenha fallbacks para desenvolvimento local
- Documente qualquer nova porta adicionada ao sistema
- Teste localmente após mudanças de configuração

## 🔍 Verificação

Para verificar se todas as portas estão sendo usadas corretamente:

```bash
# Procurar por portas hardcoded (deve retornar poucos resultados)
grep -r ":[0-9][0-9][0-9][0-9]" --exclude-dir=node_modules --exclude="*.md" .

# Verificar se .env está sendo carregado
node -e "require('dotenv').config({path: './config/.env'}); console.log('API_PORT:', process.env.API_PORT)"
```
