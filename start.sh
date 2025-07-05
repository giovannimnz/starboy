#!/bin/bash

# Script unificado para o projeto Starboy Trading
# Suporta desenvolvimento (dev) e produção (prod)

set -e

# Cores para output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Função para log colorido
log() {
    local mode="$1"
    local message="$2"
    case $mode in
        "dev") echo -e "${GREEN}[DEV]${NC} $message" ;;
        "prod") echo -e "${BLUE}[PROD]${NC} $message" ;;
        "info") echo -e "${CYAN}[INFO]${NC} $message" ;;
        *) echo -e "${GREEN}[STARBOY]${NC} $message" ;;
    esac
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Verificar se as dependências estão instaladas
check_dependencies() {
    local mode="$1"
    log "$mode" "Verificando dependências..."
    
    if [ ! -d "node_modules" ]; then
        warn "node_modules não encontrado. Instalando dependências..."
        if [ "$mode" = "prod" ]; then
            npm ci --only=production
        else
            npm install
        fi
    fi
    
    if [ ! -f "config/.env" ]; then
        warn "Arquivo config/.env não encontrado!"
        echo "Crie o arquivo config/.env com as variáveis necessárias:"
        echo "DB_HOST=localhost"
        echo "DB_PORT=8745"
        echo "DB_USER=postgres"
        echo "DB_PASSWORD=Bkfigt!546"
        echo "DB_NAME=starboy"
        echo "NODE_ENV=$mode"
        exit 1
    fi
    
    # Verificar se o build do frontend existe (apenas para produção)
    if [ "$mode" = "prod" ] && [ -d "frontend" ] && [ ! -d "frontend/.next" ] && [ "${2:-full}" != "backend" ]; then
        warn "Build do frontend não encontrado. Executando build..."
        cd frontend
        npm run build
        cd ..
    fi
    
    log "$mode" "Dependências verificadas ✓"
}

# Função para iniciar apenas o backend
start_backend() {
    local mode="$1"
    if [ "$mode" = "dev" ]; then
        log "dev" "Iniciando servidor backend (API) em desenvolvimento..."
        log "info" "Porta: 8050 (desenvolvimento)"
        exec nodemon backend/server/api.js --watch backend --watch config
    else
        log "prod" "Iniciando servidor backend (API) em produção..."
        log "info" "Porta: 8025 (produção)"
        export NODE_ENV=production
        exec node backend/server/api.js
    fi
}

# Função para iniciar apenas o frontend
start_frontend() {
    local mode="$1"
    if [ "$mode" = "dev" ]; then
        log "dev" "Iniciando servidor frontend em desenvolvimento..."
        log "info" "Porta: 3050 (desenvolvimento)"
        cd frontend
        exec npm run dev
    else
        log "prod" "Iniciando servidor frontend em produção..."
        log "info" "Porta: 3025 (produção)"
        cd frontend
        export NODE_ENV=production
        exec npm run start
    fi
}

# Função para iniciar backend e frontend simultaneamente
start_full() {
    local mode="$1"
    
    # Verificar se concurrently está instalado
    if ! command -v npx &> /dev/null; then
        error "npx não encontrado. Instale o Node.js"
        exit 1
    fi
    
    if [ "$mode" = "dev" ]; then
        log "dev" "Iniciando desenvolvimento completo (Backend + Frontend)..."
        log "info" "Frontend: npm run dev (porta 3050)"
        log "info" "Backend: nodemon (porta 8050)"
        
        exec npx concurrently \
            --names "API,WEB" \
            --prefix-colors "blue,green" \
            "nodemon backend/server/api.js --watch backend --watch config" \
            "cd frontend && npm run dev"
    else
        log "prod" "Iniciando produção completa (Backend + Frontend)..."
        log "info" "Frontend: npm run start (porta 3025)"
        log "info" "Backend: node (porta 8025)"
        
        export NODE_ENV=production
        exec npx concurrently \
            --names "API,WEB" \
            --prefix-colors "blue,green" \
            --restart-tries 3 \
            "NODE_ENV=production node backend/server/api.js" \
            "cd frontend && NODE_ENV=production npm run start"
    fi
}

# Função para build completo
build_all() {
    log "info" "Executando build completo..."
    
    # Build do frontend
    if [ -d "frontend" ]; then
        log "info" "Fazendo build do frontend..."
        cd frontend
        npm run build
        cd ..
    fi
    
    log "info" "Build completo finalizado ✓"
}

# Função para mostrar status
show_status() {
    log "info" "Status dos serviços:"
    
    # Verificar backend (Windows compatible)
    if tasklist //fi "imagename eq node.exe" 2>/dev/null | grep -q "node.exe" 2>/dev/null; then
        echo -e "  Backend: ${GREEN}Rodando${NC}"
    elif ps aux 2>/dev/null | grep -q "nodemon\|node.*api.js" 2>/dev/null; then
        echo -e "  Backend: ${GREEN}Rodando${NC}"
    else
        echo -e "  Backend: ${RED}Parado${NC}"
    fi
    
    # Verificar frontend (Windows compatible)
    if tasklist //fi "imagename eq node.exe" 2>/dev/null | grep -q "node.exe" 2>/dev/null; then
        echo -e "  Frontend: ${GREEN}Possivelmente Rodando${NC}"
    elif ps aux 2>/dev/null | grep -q "npm.*run" 2>/dev/null; then
        echo -e "  Frontend: ${GREEN}Rodando${NC}"
    else
        echo -e "  Frontend: ${RED}Parado${NC}"
    fi
    
    # Mostrar portas
    echo ""
    echo "Portas configuradas:"
    echo "  Desenvolvimento: Frontend 3050, Backend 8050"
    echo "  Produção: Frontend 3025, Backend 8025"
    echo ""
    echo "💡 Para verificar portas em uso:"
    echo "  netstat -an | findstr :3050"
    echo "  netstat -an | findstr :8050"
    echo "  netstat -an | findstr :3025"
    echo "  netstat -an | findstr :8025"
}

# Função para parar serviços
stop_services() {
    log "info" "Parando todos os serviços..."
    
    # Windows compatible
    if command -v taskkill &> /dev/null; then
        taskkill //F //IM node.exe 2>/dev/null || true
        taskkill //F //IM nodemon.exe 2>/dev/null || true
    else
        # Linux/Mac
        pkill -f "node backend/server/api.js" 2>/dev/null || true
        pkill -f "npm run" 2>/dev/null || true
        pkill -f "nodemon" 2>/dev/null || true
        pkill -f "concurrently" 2>/dev/null || true
    fi
    
    sleep 2
    log "info" "Serviços parados ✓"
}

# Verificar argumentos
case "${1:-help}" in
    "dev"|"development")
        check_dependencies "dev" "${2:-full}"
        case "${2:-full}" in
            "backend"|"api")
                start_backend "dev"
                ;;
            "frontend"|"web")
                start_frontend "dev"
                ;;
            "full"|"")
                start_full "dev"
                ;;
            *)
                error "Opção inválida para dev: $2"
                echo "Use: $0 dev [backend|frontend|full]"
                exit 1
                ;;
        esac
        ;;
    "prod"|"production")
        check_dependencies "prod" "${2:-full}"
        case "${2:-full}" in
            "backend"|"api")
                start_backend "prod"
                ;;
            "frontend"|"web")
                start_frontend "prod"
                ;;
            "full"|"")
                start_full "prod"
                ;;
            *)
                error "Opção inválida para prod: $2"
                echo "Use: $0 prod [backend|frontend|full]"
                exit 1
                ;;
        esac
        ;;
    "build")
        check_dependencies "prod" "full"
        build_all
        ;;
    "status")
        show_status
        ;;
    "stop")
        stop_services
        ;;
    "restart")
        stop_services
        sleep 2
        if [ "${2:-prod}" = "dev" ]; then
            log "info" "Reiniciando em modo desenvolvimento..."
            check_dependencies "dev" "full"
            start_full "dev"
        else
            log "info" "Reiniciando em modo produção..."
            check_dependencies "prod" "full"
            start_full "prod"
        fi
        ;;
    "help"|"-h"|"--help"|"")
        echo "=== STARBOY TRADING - SCRIPT UNIFICADO ==="
        echo ""
        echo "Uso: $0 [modo] [serviço]"
        echo ""
        echo "Modos Principais:"
        echo "  dev        - Modo desenvolvimento (npm run dev)"
        echo "  prod       - Modo produção (npm run start)"
        echo ""
        echo "Comandos de Gerenciamento:"
        echo "  build      - Executa build para produção"
        echo "  status     - Mostra status dos serviços"
        echo "  stop       - Para todos os serviços"
        echo "  restart    - Reinicia serviços (padrão: prod)"
        echo "  help       - Mostra esta ajuda"
        echo ""
        echo "Serviços (opcional):"
        echo "  backend    - Apenas backend/API"
        echo "  frontend   - Apenas frontend"
        echo "  full       - Ambos (padrão)"
        echo ""
        echo "Exemplos:"
        echo "  $0 dev              # Desenvolvimento completo"
        echo "  $0 prod             # Produção completa"
        echo "  $0 dev backend      # Apenas backend em dev"
        echo "  $0 prod frontend    # Apenas frontend em prod"
        echo "  $0 build            # Build para produção"
        echo "  $0 status           # Ver status"
        echo "  $0 stop             # Parar tudo"
        echo "  $0 restart dev      # Reiniciar em dev"
        echo ""
        echo "Comandos NPM equivalentes:"
        echo "  npm run dev         # = $0 dev"
        echo "  npm run start       # = $0 prod"
        echo "  npm run build       # = $0 build"
        echo "  npm run status      # = $0 status"
        echo "  npm run stop        # = $0 stop"
        echo ""
        echo "Portas:"
        echo "  Desenvolvimento: Frontend 3050, Backend 8050"
        echo "  Produção: Frontend 3025, Backend 8025"
        exit 0
        ;;
    *)
        error "Opção inválida: $1"
        echo "Use '$0 help' para ver as opções disponíveis"
        exit 1
        ;;
esac
