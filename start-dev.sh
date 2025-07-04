#!/bin/bash

# Script de desenvolvimento para o projeto Starboy Trading
# Suporta execução em modo backend, frontend ou completo

set -e

# Cores para output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Função para log colorido
log() {
    echo -e "${GREEN}[DEV]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se as dependências estão instaladas
check_dependencies() {
    log "Verificando dependências..."
    
    if [ ! -d "node_modules" ]; then
        warn "node_modules não encontrado. Instalando dependências..."
        npm install
    fi
    
    if [ ! -f "config/.env" ]; then
        warn "Arquivo config/.env não encontrado!"
        echo "Crie o arquivo config/.env com as variáveis necessárias:"
        echo "DB_HOST=localhost"
        echo "DB_PORT=5432"
        echo "DB_USER=postgres"
        echo "DB_PASSWORD=sua_senha"
        echo "DB_NAME=starboy_dev"
        exit 1
    fi
    
    log "Dependências verificadas ✓"
}

# Função para iniciar apenas o backend
start_backend() {
    log "Iniciando servidor backend (API)..."
    exec nodemon backend/server/api.js --watch backend --watch config
}

# Função para iniciar apenas o frontend
start_frontend() {
    log "Iniciando servidor frontend..."
    cd frontend
    exec npm run dev
}

# Função para iniciar backend e frontend simultaneamente
start_full() {
    log "Iniciando desenvolvimento completo (Backend + Frontend)..."
    
    # Verificar se concurrently está instalado
    if ! command -v npx &> /dev/null; then
        error "npx não encontrado. Instale o Node.js"
        exit 1
    fi
    
    # Usar concurrently para rodar ambos
    exec npx concurrently \
        --names "API,WEB" \
        --prefix-colors "blue,green" \
        "nodemon backend/server/api.js --watch backend --watch config" \
        "cd frontend && npm run dev"
}

# Verificar argumentos
case "${1:-full}" in
    "backend"|"api")
        check_dependencies
        start_backend
        ;;
    "frontend"|"web")
        check_dependencies
        start_frontend
        ;;
    "full"|"dev"|"")
        check_dependencies
        start_full
        ;;
    "help"|"-h"|"--help")
        echo "Uso: $0 [opção]"
        echo "Opções:"
        echo "  backend    - Inicia apenas o servidor backend/API"
        echo "  frontend   - Inicia apenas o servidor frontend"
        echo "  full       - Inicia backend e frontend (padrão)"
        echo "  help       - Mostra esta ajuda"
        exit 0
        ;;
    *)
        error "Opção inválida: $1"
        echo "Use '$0 help' para ver as opções disponíveis"
        exit 1
        ;;
esac
