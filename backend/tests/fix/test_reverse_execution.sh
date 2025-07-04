#!/bin/bash

echo "=== TESTE DE LOGS DO REVERSE.JS ==="

# Buscar logs do reverse.js nos últimos 2 minutos
echo "Buscando logs do reverse.js dos últimos 2 minutos..."

# Verificar se há logs de início de execução
echo ""
echo "1. Logs de INÍCIO de execução (deve mostrar para todas as contas):"
echo "Padrão: === INICIANDO EXECUÇÃO PARA SINAL"

# Verificar se há logs de criação de ordens SL/TP/RP
echo ""
echo "2. Logs de CRIAÇÃO de ordens (deve mostrar para todas as contas):"
echo "Padrão: Entrada considerada COMPLETA"

# Verificar se há logs de inserção no banco
echo ""
echo "3. Logs de INSERÇÃO no banco (deve mostrar para todas as contas):"
echo "Padrão: Inserindo dados do buffer no banco"

echo ""
echo "4. Logs de COMMIT da transação (deve mostrar para todas as contas):"
echo "Padrão: Transação COMMITADA com sucesso"

echo ""
echo "=== INSTRUÇÕES ==="
echo "1. Execute um sinal que acione o reverse.js"
echo "2. Verifique se os logs acima aparecem para TODAS as contas"
echo "3. Se apenas uma conta mostrar os logs, há um problema na execução múltipla"
echo ""
echo "Exemplo de grep para buscar logs:"
echo "  grep -E '(=== INICIANDO EXECUÇÃO|Entrada considerada COMPLETA|Inserindo dados do buffer|Transação COMMITADA)' /var/log/starboy/*.log"
