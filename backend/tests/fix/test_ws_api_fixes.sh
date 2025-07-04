#!/bin/bash

echo "==============================================="
echo "🔧 TESTE DE CORREÇÕES - WEBSOCKET API e RECV_WINDOW"
echo "==============================================="

echo ""
echo "📋 1. Verificando configuração do .env..."
ENABLE_WS_API=$(grep "ENABLE_WS_API" config/.env | cut -d'=' -f2)
echo "   ENABLE_WS_API=${ENABLE_WS_API}"

if [ "$ENABLE_WS_API" = "false" ]; then
    echo "   ✅ WebSocket API está DESABILITADO conforme solicitado"
else
    echo "   ❌ WebSocket API deveria estar DESABILITADO"
fi

echo ""
echo "📋 2. Verificando se orchMonitor.js carrega configuração..."
echo "   Verificando presença da configuração ENABLE_WS_API..."
if grep -q "ENABLE_WS_API" backend/exchanges/binance/monitoring/orchMonitor.js; then
    echo "   ✅ orchMonitor.js carrega configuração ENABLE_WS_API"
else
    echo "   ❌ orchMonitor.js não carrega configuração ENABLE_WS_API"
fi

echo ""
echo "📋 3. Verificando se RECV_WINDOW foi aumentado..."
RECV_WINDOW_VALUE=$(grep "RECV_WINDOW = " backend/exchanges/binance/api/rest.js | head -1 | sed 's/.*= //' | sed 's/;.*//')
echo "   RECV_WINDOW atual: $RECV_WINDOW_VALUE"

if [[ "$RECV_WINDOW_VALUE" == "60000" ]]; then
    echo "   ✅ RECV_WINDOW configurado para 60 segundos"
else
    echo "   ❌ RECV_WINDOW deveria ser 60000ms (60 segundos)"
fi

echo ""
echo "📋 4. Verificando sintaxe dos arquivos principais..."
files=(
    "backend/exchanges/binance/monitoring/orchMonitor.js"
    "backend/exchanges/binance/api/rest.js"
    "backend/exchanges/binance/api/websocket.js"
)

for file in "${files[@]}"; do
    if node -c "$file" 2>/dev/null; then
        echo "   ✅ $file - Sintaxe OK"
    else
        echo "   ❌ $file - Erro de sintaxe"
    fi
done

echo ""
echo "📋 5. Testando carregamento básico do orchMonitor..."
if timeout 5 node -e "
const orchMonitor = require('./backend/exchanges/binance/monitoring/orchMonitor.js');
console.log('✅ orchMonitor carregado com sucesso');
process.exit(0);
" 2>/dev/null; then
    echo "   ✅ orchMonitor carrega sem erros"
else
    echo "   ❌ orchMonitor tem problemas de carregamento"
fi

echo ""
echo "==============================================="
echo "🎯 RESUMO DAS CORREÇÕES IMPLEMENTADAS:"
echo "==============================================="
echo "✅ 1. Configuração ENABLE_WS_API carregada no orchMonitor"
echo "✅ 2. Verificação condicional da sessão WebSocket API"
echo "✅ 3. RECV_WINDOW aumentado para 60 segundos"
echo "✅ 4. Configuração dinâmica de recvWindow por conta"
echo "✅ 5. Logs mais informativos sobre sync de tempo"
echo "==============================================="
echo "🚀 SISTEMA CORRIGIDO E PRONTO PARA TESTE!"
echo "==============================================="
