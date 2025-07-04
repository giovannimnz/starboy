#!/bin/bash

# Script para iniciar o projeto com todas as configurações de porta centralizadas

echo "🚀 Iniciando Starboy Dev com configurações centralizadas..."

# Carregar variáveis do .env
if [ -f "./config/.env" ]; then
    echo "📄 Carregando configurações do .env..."
    export $(cat ./config/.env | grep -v '#' | xargs)
    echo "✅ API_PORT: $API_PORT"
    echo "✅ FRONTEND_PORT: $FRONTEND_PORT"
else
    echo "⚠️  Arquivo .env não encontrado em ./config/.env"
    echo "📋 Usando valores padrão: API_PORT=8050, FRONTEND_PORT=3050"
    export API_PORT=8050
    export FRONTEND_PORT=3050
fi

# Função para iniciar o backend
start_backend() {
    echo "🔧 Iniciando Backend na porta $API_PORT..."
    cd backend && npm start &
    BACKEND_PID=$!
    echo "✅ Backend iniciado (PID: $BACKEND_PID)"
}

# Função para iniciar o frontend
start_frontend() {
    echo "🎨 Iniciando Frontend na porta $FRONTEND_PORT..."
    cd frontend && npm run dev &
    FRONTEND_PID=$!
    echo "✅ Frontend iniciado (PID: $FRONTEND_PID)"
}

# Função de cleanup
cleanup() {
    echo "🛑 Parando serviços..."
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null
        echo "✅ Backend parado"
    fi
    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null
        echo "✅ Frontend parado"
    fi
    exit 0
}

# Configurar trap para cleanup
trap cleanup SIGINT SIGTERM

# Verificar se é para iniciar apenas um serviço
case "$1" in
    "backend")
        start_backend
        wait $BACKEND_PID
        ;;
    "frontend")
        start_frontend
        wait $FRONTEND_PID
        ;;
    *)
        # Iniciar ambos os serviços
        start_backend
        sleep 2
        start_frontend
        
        # Obter IP da máquina
        if command -v ip &> /dev/null; then
            LOCAL_IP=$(ip route get 1 | awk '{print $NF; exit}')
        elif command -v ifconfig &> /dev/null; then
            LOCAL_IP=$(ifconfig | grep -E "inet.*broadcast" | awk '{print $2}' | head -1)
        else
            LOCAL_IP="<IP_DA_MAQUINA>"
        fi
        
        echo ""
        echo "🎯 Serviços iniciados:"
        echo "   📡 Backend:  http://0.0.0.0:$API_PORT"
        echo "   🌐 Frontend: http://0.0.0.0:$FRONTEND_PORT"
        echo "   📚 API Docs: http://0.0.0.0:$API_PORT/docs"
        echo ""
        echo "🌍 Acesso externo disponível em:"
        echo "   📡 Backend:  http://$LOCAL_IP:$API_PORT"
        echo "   🌐 Frontend: http://$LOCAL_IP:$FRONTEND_PORT"
        echo "   📚 API Docs: http://$LOCAL_IP:$API_PORT/docs"
        echo ""
        echo "💡 Para parar os serviços, pressione Ctrl+C"
        echo ""
        
        # Aguardar ambos os processos
        wait
        ;;
esac
