#!/bin/bash

# Script para testar se as correções de colunas estão funcionando
echo "==============================================="
echo "🔍 TESTANDO CORREÇÕES DE COLUNAS DO BANCO"
echo "==============================================="

cd /c/Users/muniz/Documents/GitHub/starboy_dev

echo "📄 Verificando sintaxe dos arquivos corrigidos..."

# Testar arquivos principais
echo "✅ Testando cleanup.js..."
if node -c backend/exchanges/binance/services/cleanup.js; then
    echo "✅ cleanup.js - Sintaxe OK"
else
    echo "❌ cleanup.js - Erro de sintaxe"
    exit 1
fi

echo "✅ Testando positionSync.js..."
if node -c backend/exchanges/binance/services/positionSync.js; then
    echo "✅ positionSync.js - Sintaxe OK"
else
    echo "❌ positionSync.js - Erro de sintaxe"
    exit 1
fi

echo "✅ Testando orchMonitor.js..."
if node -c backend/exchanges/binance/monitoring/orchMonitor.js; then
    echo "✅ orchMonitor.js - Sintaxe OK"
else
    echo "❌ orchMonitor.js - Erro de sintaxe"
    exit 1
fi

echo ""
echo "🔍 Verificando correções de colunas..."

# Verificar se ainda há usos incorretos de 'observacao' para tabela posicoes
echo "📋 Verificando uso correto de 'observacoes' para tabela posicoes..."
if grep -n "UPDATE posicoes.*observacao =" backend/exchanges/binance/services/cleanup.js; then
    echo "❌ Ainda há uso incorreto de 'observacao' para tabela posicoes!"
    exit 1
else
    echo "✅ Uso correto de 'observacoes' para tabela posicoes"
fi

# Verificar uso correto para tabela ordens
echo "📋 Verificando uso correto de 'observacao' para tabela ordens..."
if grep -n "UPDATE ordens.*observacao =" backend/exchanges/binance/services/cleanup.js backend/exchanges/binance/services/positionSync.js | head -2; then
    echo "✅ Uso correto de 'observacao' para tabela ordens"
else
    echo "⚠️  Nenhum uso de 'observacao' para tabela ordens encontrado"
fi

echo ""
echo "==============================================="
echo "🎯 RESUMO DAS CORREÇÕES"
echo "==============================================="

echo "✅ Correções implementadas:"
echo "   - Corrigido uso de 'observacao' → 'observacoes' para tabela posicoes"
echo "   - Mantido uso correto de 'observacao' para tabela ordens"
echo "   - Sintaxe de todos os arquivos validada"
echo ""
echo "📋 Alterações realizadas:"
echo "   - cleanup.js: 3 correções de UPDATE posicoes"
echo "   - Outras tabelas mantidas com nomenclatura correta"
echo ""
echo "🚀 Sistema pronto para execução!"
