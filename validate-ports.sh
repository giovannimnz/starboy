#!/bin/bash

# Script para validar as configurações de porta centralizadas

echo "🔍 Validando configurações de porta centralizadas..."
echo ""

# Carregar .env
if [ -f "./config/.env" ]; then
    source ./config/.env
    echo "✅ Arquivo .env carregado"
else
    echo "❌ Arquivo .env não encontrado em ./config/.env"
    exit 1
fi

# Validar variáveis obrigatórias
echo ""
echo "📋 Verificando variáveis obrigatórias:"

check_var() {
    local var_name=$1
    local var_value=${!1}
    
    if [ -z "$var_value" ]; then
        echo "❌ $var_name: NÃO DEFINIDA"
        return 1
    else
        echo "✅ $var_name: $var_value"
        return 0
    fi
}

# Variáveis obrigatórias
REQUIRED_VARS=(
    "API_PORT"
    "API_HOST" 
    "FRONTEND_PORT"
    "FRONTEND_HOST"
    "FRONTEND_URL"
    "DB_PORT"
    "WEBHOOK_URL"
)

ERROR_COUNT=0
for var in "${REQUIRED_VARS[@]}"; do
    if ! check_var "$var"; then
        ((ERROR_COUNT++))
    fi
done

echo ""
echo "🔍 Verificando arquivos de configuração:"

# Verificar se os arquivos usam as variáveis corretas
check_file_config() {
    local file=$1
    local pattern=$2
    local description=$3
    
    if [ -f "$file" ]; then
        if grep -q "$pattern" "$file"; then
            echo "✅ $description"
        else
            echo "❌ $description - padrão não encontrado: $pattern"
            ((ERROR_COUNT++))
        fi
    else
        echo "⚠️  $description - arquivo não encontrado: $file"
    fi
}

# Verificar configurações nos arquivos
check_file_config "backend/server/api.js" "process.env.API_PORT" "Backend usa API_PORT"
check_file_config "backend/server/api.js" "process.env.FRONTEND_PORT" "Backend usa FRONTEND_PORT para CORS"
check_file_config "frontend/package.json" "FRONTEND_PORT" "Frontend package.json usa FRONTEND_PORT"
check_file_config "backend/indicators/divap.py" "API_PORT" "Python script usa API_PORT para webhook"

echo ""
echo "🌐 Testando conectividade das portas:"

# Função para testar se uma porta está em uso
test_port() {
    local port=$1
    local service=$2
    
    if command -v nc >/dev/null 2>&1; then
        if nc -z localhost $port 2>/dev/null; then
            echo "⚠️  Porta $port ($service): EM USO"
        else
            echo "✅ Porta $port ($service): DISPONÍVEL"
        fi
    else
        echo "ℹ️  Porta $port ($service): nc não disponível para teste"
    fi
}

test_port "$API_PORT" "Backend API"
test_port "$FRONTEND_PORT" "Frontend"
test_port "$DB_PORT" "Database"

echo ""
echo "📊 Resumo da validação:"

if [ $ERROR_COUNT -eq 0 ]; then
    echo "✅ Todas as configurações estão corretas!"
    echo "🚀 Pronto para desenvolvimento com portas centralizadas"
    exit 0
else
    echo "❌ Encontrados $ERROR_COUNT problemas na configuração"
    echo "🔧 Corrija os problemas antes de continuar"
    exit 1
fi
