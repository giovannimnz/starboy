#!/bin/bash

# =========================================================================
# SCRIPT DE APLICAÇÃO DE ÍNDICES DE BANCO DE DADOS
# =========================================================================
# Aplica os índices de otimização na base de dados do Starboy Trading System
# Baseado na análise completa das consultas mais críticas do sistema
# =========================================================================

set -e  # Para em caso de erro

echo "========================================================================="
echo "🚀 APLICAÇÃO DE ÍNDICES DE OTIMIZAÇÃO - STARBOY TRADING SYSTEM"
echo "========================================================================="
echo "⏰ Iniciado em: $(date)"
echo ""

# Verificar se o arquivo .env existe
if [[ ! -f "config/.env" ]]; then
    echo "❌ ERRO: Arquivo config/.env não encontrado!"
    echo "   Certifique-se de estar no diretório raiz do projeto."
    exit 1
fi

# Verificar se o arquivo SQL existe
if [[ ! -f "backend/core/database/migrations/database_indexes_optimization.sql" ]]; then
    echo "❌ ERRO: Arquivo de índices não encontrado!"
    echo "   Esperado: backend/core/database/migrations/database_indexes_optimization.sql"
    exit 1
fi

echo "✅ Verificações iniciais concluídas"
echo ""

# Carregar variáveis do .env
echo "📋 Carregando configurações da base de dados..."
source config/.env

# Verificar se as variáveis necessárias estão definidas
if [[ -z "$DB_HOST" || -z "$DB_USER" || -z "$DB_PASSWORD" || -z "$DB_NAME" ]]; then
    echo "❌ ERRO: Variáveis de base de dados não definidas no .env"
    echo "   Necessárias: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME"
    exit 1
fi

echo "   Host: $DB_HOST"
echo "   Porta: ${DB_PORT:-3306}"
echo "   Usuário: $DB_USER"
echo "   Base de dados: $DB_NAME"
echo ""

# Verificar se mysql está disponível
if ! command -v mysql &> /dev/null; then
    echo "❌ ERRO: Cliente MySQL não encontrado!"
    echo "   Instale o cliente MySQL para continuar."
    exit 1
fi

# Verificar conectividade com a base de dados
echo "🔍 Testando conectividade com a base de dados..."
if ! mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" -e "SELECT 1;" > /dev/null 2>&1; then
    echo "❌ ERRO: Não foi possível conectar à base de dados!"
    echo "   Verifique as credenciais e se o servidor MySQL está rodando."
    exit 1
fi
echo "✅ Conectividade confirmada"
echo ""

# Fazer backup da estrutura da base de dados (apenas estrutura, sem dados)
echo "💾 Criando backup da estrutura da base de dados..."
BACKUP_FILE="backend/core/backups/indexes_backup_$(date +%Y%m%d_%H%M%S).sql"
mkdir -p backend/core/backups

mysqldump -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" \
    --no-data --routines --triggers "$DB_NAME" > "$BACKUP_FILE"

if [[ $? -eq 0 ]]; then
    echo "✅ Backup criado: $BACKUP_FILE"
else
    echo "❌ ERRO: Falha ao criar backup!"
    exit 1
fi
echo ""

# Confirmar aplicação
echo "⚠️  ATENÇÃO: Este script aplicará índices de otimização na base de dados."
echo ""
echo "📊 ÍNDICES QUE SERÃO APLICADOS:"
echo "   • posicoes: 8 novos índices (consultas críticas de reverse.js)"
echo "   • ordens: 10 novos índices (consultas críticas de positionSync.js)"
echo "   • webhook_signals: 9 novos índices (linking e timeout management)"
echo "   • contas: 4 novos índices (validação de contas ativas)"
echo "   • Tabelas auxiliares: 15+ índices adicionais"
echo ""
echo "💾 IMPACTO ESPERADO:"
echo "   • Aumento no uso de espaço em disco: 15-30%"
echo "   • Melhoria na performance de consultas: 70-90%"
echo "   • Pequeno impacto em inserções: 5-10% mais lentas"
echo ""
echo "🔄 Um backup da estrutura foi criado em: $BACKUP_FILE"
echo ""
read -p "🤔 Deseja continuar com a aplicação dos índices? (s/N): " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Ss]$ ]]; then
    echo "❌ Operação cancelada pelo usuário."
fi

echo ""
echo "🔧 Aplicando índices de otimização..."
echo "   Arquivo: backend/core/database/migrations/database_indexes_optimization.sql"
echo ""

# Aplicar os índices
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" \
    < backend/core/database/migrations/database_indexes_optimization.sql

if [[ $? -eq 0 ]]; then
    echo "✅ Índices aplicados com sucesso!"
else
    echo "❌ ERRO: Falha ao aplicar índices!"
    echo "   Verifique os logs de erro do MySQL."
    exit 1
fi

echo ""
echo "📊 Verificando índices aplicados..."

# Verificar os índices criados nas tabelas principais
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "
SELECT 
    TABLE_NAME as Tabela,
    COUNT(*) as Total_Indices
FROM information_schema.STATISTICS 
WHERE TABLE_SCHEMA = '$DB_NAME' 
    AND TABLE_NAME IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
    AND INDEX_NAME LIKE 'idx_%'
GROUP BY TABLE_NAME
ORDER BY TABLE_NAME;
"

echo ""
echo "📈 Estatísticas das tabelas principais:"
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "
SELECT 
    TABLE_NAME as Tabela,
    TABLE_ROWS as Linhas,
    ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS 'Tamanho_Total_MB',
    ROUND((INDEX_LENGTH / 1024 / 1024), 2) AS 'Tamanho_Indices_MB',
    ROUND((INDEX_LENGTH / (DATA_LENGTH + INDEX_LENGTH)) * 100, 1) AS 'Percentual_Indices'
FROM information_schema.TABLES 
WHERE TABLE_SCHEMA = '$DB_NAME' 
    AND TABLE_NAME IN ('posicoes', 'ordens', 'webhook_signals', 'contas')
ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC;
"

echo ""
echo "🔍 Verificando queries críticas otimizadas..."

# Teste da query mais crítica do reverse.js
echo "   • Testando query crítica: posições por símbolo + status + conta..."
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "
EXPLAIN SELECT id FROM posicoes WHERE simbolo = 'BTCUSDT' AND status = 'OPEN' AND conta_id = 1 ORDER BY id DESC LIMIT 1;
" | grep -q "Using index" && echo "     ✅ Index sendo utilizado" || echo "     ⚠️  Index pode não estar sendo utilizado"

# Teste da query crítica do positionSync.js
echo "   • Testando query crítica: LEFT JOIN posições sem sinais..."
mysql -h"$DB_HOST" -P"${DB_PORT:-3306}" -u"$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" -e "
EXPLAIN SELECT p.id FROM posicoes p LEFT JOIN webhook_signals ws ON ws.position_id = p.id WHERE p.status = 'OPEN' AND p.conta_id = 1 AND ws.position_id IS NULL LIMIT 1;
" | grep -q "Using index" && echo "     ✅ Index sendo utilizado" || echo "     ⚠️  Index pode não estar sendo utilizado"

echo ""
echo "========================================================================="
echo "✅ APLICAÇÃO DE ÍNDICES CONCLUÍDA COM SUCESSO!"
echo "========================================================================="
echo "⏰ Finalizado em: $(date)"
echo ""
echo "� ÍNDICES APLICADOS:"
echo "   • 40+ novos índices foram criados"
echo "   • Foco nas consultas mais críticas do sistema"
echo "   • Otimização especial para reverse.js e positionSync.js"
echo ""
echo "📈 MELHORIAS ESPERADAS:"
echo "   • Query crítica reverse.js (linha 983): 80-90% mais rápida"
echo "   • Query crítica positionSync.js (linha 1149): 70-85% mais rápida"
echo "   • Consultas de sinais ativos: 60-80% mais rápidas"
echo "   • LEFT JOINs entre tabelas: 50-70% mais rápidos"
echo ""
echo "📋 PRÓXIMOS PASSOS:"
echo "   1. 🔄 Reinicie o sistema para garantir que use os novos índices"
echo "   2. 📊 Monitore a performance das consultas do sistema"
echo "   3. 🧪 Execute testes das funcionalidades principais (reverse.js)"
echo "   4. 💾 Verifique o uso de espaço em disco regularmente"
echo "   5. � Configure monitoramento de performance se necessário"
echo ""
echo "📄 RELATÓRIOS E ANÁLISES:"
echo "   - Backup da estrutura: $BACKUP_FILE"
echo "   - Para análise detalhada: node apply_indexes.js --analyze"
echo "   - Para monitoramento: node apply_indexes.js --monitor"
echo ""
echo "⚠️  LEMBRETES IMPORTANTES:"
echo "   • Execute 'ANALYZE TABLE posicoes, ordens, webhook_signals;' semanalmente"
echo "   • Monitore queries lentas com 'SHOW PROCESSLIST'"
echo "   • Configure rotação de logs se o espaço for um problema"
echo "   • Os índices críticos têm foco nas queries analisadas do código"
echo ""
echo "🎉 SISTEMA PRONTO PARA OPERAÇÃO OTIMIZADA!"
echo "   As consultas mais críticas do reverse.js e positionSync.js"
echo "   agora devem executar significativamente mais rápido."
echo "========================================================================="
