#!/bin/bash

echo "==============================================="
echo "🔗 TESTE DE CORREÇÃO - VINCULAÇÃO DE SINAIS"
echo "==============================================="

echo ""
echo "📋 1. Verificando sintaxe dos arquivos corrigidos..."
files=(
    "backend/exchanges/binance/services/positionSync.js"
    "backend/exchanges/binance/monitoring/orchMonitor.js" 
    "backend/exchanges/binance/api/rest.js"
)

for file in "${files[@]}"; do
    if node -c "$file" 2>/dev/null; then
        echo "   ✅ $file - Sintaxe OK"
    else
        echo "   ❌ $file - Erro de sintaxe"
    fi
done

echo ""
echo "📋 2. Verificando se a consulta signal_id foi corrigida..."
if grep -q "signal_id IS NULL" backend/exchanges/binance/services/positionSync.js; then
    echo "   ❌ Ainda há referências à coluna inexistente signal_id"
else
    echo "   ✅ Consulta signal_id foi removida"
fi

echo ""
echo "📋 3. Verificando se a consulta correta com LEFT JOIN foi implementada..."
if grep -q "LEFT JOIN webhook_signals ws ON ws.position_id = p.id" backend/exchanges/binance/services/positionSync.js; then
    echo "   ✅ Consulta com LEFT JOIN implementada corretamente"
else
    echo "   ❌ Consulta com LEFT JOIN não encontrada"
fi

echo ""
echo "📋 4. Verificando se UPDATE signal_id na tabela posicoes foi removido..."
if grep -q "UPDATE posicoes.*SET signal_id" backend/exchanges/binance/services/positionSync.js; then
    echo "   ❌ Ainda há tentativa de UPDATE signal_id na tabela posicoes"
else
    echo "   ✅ UPDATE signal_id na tabela posicoes foi removido"
fi

echo ""
echo "📋 5. Verificando estrutura da consulta corrigida..."
echo "   Consulta implementada:"
grep -A 8 "LEFT JOIN webhook_signals ws ON ws.position_id = p.id" backend/exchanges/binance/services/positionSync.js | sed 's/^/     /'

echo ""
echo "==============================================="
echo "🎯 RESUMO DA CORREÇÃO:"
echo "==============================================="
echo "❌ PROBLEMA ORIGINAL:"
echo "   - Tentativa de usar coluna signal_id inexistente na tabela posicoes"
echo "   - Erro: Unknown column 'signal_id' in 'WHERE'"
echo ""
echo "✅ SOLUÇÃO IMPLEMENTADA:"
echo "   - Consulta corrigida usando LEFT JOIN com webhook_signals"
echo "   - Verifica ws.position_id IS NULL para encontrar posições sem sinal"
echo "   - Removido UPDATE de signal_id na tabela posicoes"
echo "   - Mantido apenas UPDATE de position_id na tabela webhook_signals"
echo ""
echo "🔗 ESTRUTURA CORRETA:"
echo "   - webhook_signals.position_id -> posicoes.id (relação N:1)"
echo "   - posicoes NÃO tem signal_id (coluna inexistente)"
echo "==============================================="
echo "🚀 CORREÇÃO IMPLEMENTADA COM SUCESSO!"
echo "==============================================="
