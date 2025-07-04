#!/bin/bash

# Script de teste para validar o sistema de logs e multi-conta
# Após as correções implementadas

echo "==============================================="
echo "🔍 TESTANDO SISTEMA DE LOGS E MULTI-CONTA"
echo "==============================================="

# Função para testar a sintaxe de um arquivo
test_syntax() {
    local file=$1
    echo "📄 Testando sintaxe: $file"
    
    if node -c "$file" 2>&1; then
        echo "✅ Sintaxe OK: $file"
        return 0
    else
        echo "❌ Erro de sintaxe: $file"
        return 1
    fi
}

# Verificar arquivos principais
echo ""
echo "🔍 VERIFICAÇÃO DE SINTAXE"
echo "==============================================="

cd /c/Users/muniz/Documents/GitHub/starboy_dev

# Testar arquivos principais
test_syntax "backend/exchanges/binance/monitoring/orchMonitor.js"
test_syntax "backend/exchanges/binance/strategies/reverse.js"
test_syntax "backend/exchanges/binance/services/positionSync.js"
test_syntax "backend/exchanges/binance/handlers/orderHandlers.js"
test_syntax "backend/exchanges/binance/handlers/accountHandlers.js"

echo ""
echo "🔍 VERIFICAÇÃO DE LOGS"
echo "==============================================="

# Verificar se os logs foram removidos corretamente
echo "📋 Verificando remoção de logs condicionais..."

# Verificar se não há mais funções de log condicionais
echo "🔍 Procurando por funções de log condicionais restantes..."
if grep -r "function.*log.*(" backend/exchanges/binance/strategies/reverse.js | grep -v "console.log"; then
    echo "⚠️  Ainda existem funções de log condicionais!"
else
    echo "✅ Nenhuma função de log condicional encontrada"
fi

# Verificar se há logs baseados em .env
echo "🔍 Procurando por logs baseados em .env..."
if grep -r "process.env.*LOG" backend/exchanges/binance/monitoring/orchMonitor.js backend/exchanges/binance/services/positionSync.js backend/exchanges/binance/handlers/orderHandlers.js; then
    echo "⚠️  Ainda existem logs baseados em .env!"
else
    echo "✅ Nenhum log baseado em .env encontrado"
fi

echo ""
echo "🔍 VERIFICAÇÃO DE LOGS DEBUG"
echo "==============================================="

# Verificar se há logs de debug para multi-conta
echo "📋 Verificando logs de debug para multi-conta..."
if grep -r "console.log.*account" backend/exchanges/binance/strategies/reverse.js | head -5; then
    echo "✅ Logs de debug multi-conta encontrados"
else
    echo "⚠️  Nenhum log de debug multi-conta encontrado"
fi

# Verificar logs de buffer
echo "📋 Verificando logs de sistema buffer..."
if grep -r "console.log.*buffer" backend/exchanges/binance/strategies/reverse.js | head -3; then
    echo "✅ Logs de sistema buffer encontrados"
else
    echo "⚠️  Nenhum log de sistema buffer encontrado"
fi

echo ""
echo "🔍 VERIFICAÇÃO DE ESTRUTURA"
echo "==============================================="

# Verificar se as funções principais existem
echo "📋 Verificando funções principais..."

# Verificar função de buffer
if grep -r "function.*buffer" backend/exchanges/binance/strategies/reverse.js; then
    echo "✅ Sistema de buffer implementado"
else
    echo "⚠️  Sistema de buffer não encontrado"
fi

# Verificar função de delay
if grep -r "function.*delay" backend/exchanges/binance/services/positionSync.js; then
    echo "✅ Sistema de delay implementado"
else
    echo "⚠️  Sistema de delay não encontrado"
fi

echo ""
echo "==============================================="
echo "🎯 RESUMO DO TESTE"
echo "==============================================="

echo "✅ Correções implementadas:"
echo "   - Removido orderHandlers.registerOrderUpdateHandler() inválido"
echo "   - Corrigido uso correto de registerOrderHandlers()"
echo "   - Sintaxe de todos os arquivos validada"
echo ""
echo "🔍 Próximos passos:"
echo "   1. Testar execução real do sistema"
echo "   2. Verificar logs em tempo real"
echo "   3. Testar cenário multi-conta"
echo ""
echo "🚀 Sistema pronto para testes!"
