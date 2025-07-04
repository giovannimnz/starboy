#!/bin/bash

# Script de validação final completa do sistema Starboy PostgreSQL
# Executa todas as verificações necessárias para garantir o funcionamento

echo "🎯 STARBOY POSTGRESQL - VALIDAÇÃO FINAL COMPLETA"
echo "==============================================="
echo ""
echo "🕐 Iniciando validação em: $(date)"
echo ""

# Cores para output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Contadores
TESTS_PASSED=0
TESTS_FAILED=0
WARNINGS=0

# Função para log de sucesso
log_success() {
    echo -e "${GREEN}✅ $1${NC}"
    ((TESTS_PASSED++))
}

# Função para log de erro
log_error() {
    echo -e "${RED}❌ $1${NC}"
    ((TESTS_FAILED++))
}

# Função para log de warning
log_warning() {
    echo -e "${YELLOW}⚠️ $1${NC}"
    ((WARNINGS++))
}

# Função para log de info
log_info() {
    echo -e "${BLUE}ℹ️ $1${NC}"
}

echo "📋 1. VERIFICANDO ESTRUTURA DE ARQUIVOS"
echo "----------------------------------------"

# Verificar arquivos críticos
critical_files=(
    "backend/core/database/conexao.js"
    "backend/core/database/backup.js"
    "backend/core/database/restore.js"
    "backend/exchanges/binance/monitoring/orchMonitor.js"
    "backend/exchanges/binance/monitoring/signalProcessor.js"
    "backend/exchanges/binance/api/rest.js"
    "backend/exchanges/binance/api/websocket.js"
    "backend/exchanges/binance/services/telegramHelper.js"
    "backend/exchanges/binance/services/positionSync.js"
    "backend/server/api.js"
    "package.json"
)

for file in "${critical_files[@]}"; do
    if [ -f "$file" ]; then
        log_success "Arquivo encontrado: $file"
    else
        log_error "Arquivo não encontrado: $file"
    fi
done

echo ""
echo "📦 2. VERIFICANDO DEPENDÊNCIAS"
echo "------------------------------"

# Verificar se Node.js está instalado
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version)
    log_success "Node.js instalado: $NODE_VERSION"
else
    log_error "Node.js não encontrado"
fi

# Verificar se npm está instalado
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm --version)
    log_success "npm instalado: $NPM_VERSION"
else
    log_error "npm não encontrado"
fi

# Verificar dependências do package.json
if [ -f "package.json" ]; then
    log_info "Verificando dependências do package.json..."
    
    # Verificar se node_modules existe
    if [ -d "node_modules" ]; then
        log_success "node_modules encontrado"
    else
        log_warning "node_modules não encontrado - execute 'npm install'"
    fi
    
    # Verificar dependências críticas
    critical_deps=("pg" "express" "node-telegram-bot-api" "ws")
    for dep in "${critical_deps[@]}"; do
        if grep -q "\"$dep\":" package.json; then
            log_success "Dependência encontrada: $dep"
        else
            log_error "Dependência não encontrada: $dep"
        fi
    done
else
    log_error "package.json não encontrado"
fi

echo ""
echo "🗄️ 3. TESTANDO CONEXÃO COM BANCO"
echo "---------------------------------"

# Testar conexão com banco
log_info "Testando conexão com PostgreSQL..."
if node -e "
const { getDatabaseInstance } = require('./backend/core/database/conexao');
getDatabaseInstance().then(db => {
    console.log('✅ Banco conectado com sucesso');
    return db.query('SELECT 1 as test');
}).then(() => {
    console.log('✅ Query de teste executada');
    process.exit(0);
}).catch(error => {
    console.error('❌ Erro no banco:', error.message);
    process.exit(1);
});
" 2>/dev/null; then
    log_success "Conexão com banco PostgreSQL OK"
else
    log_error "Falha na conexão com banco PostgreSQL"
fi

# Verificar tabelas principais
log_info "Verificando tabelas principais..."
if node -e "
const { getDatabaseInstance } = require('./backend/core/database/conexao');
(async () => {
    const db = await getDatabaseInstance();
    const tables = ['contas', 'posicoes', 'ordens', 'sinais'];
    
    for (const table of tables) {
        const result = await db.query('SELECT table_name FROM information_schema.tables WHERE table_schema = \$1 AND table_name = \$2', ['public', table]);
        if (result.rows.length > 0) {
            console.log('✅ Tabela ' + table + ' encontrada');
        } else {
            console.log('❌ Tabela ' + table + ' não encontrada');
        }
    }
})();
" 2>/dev/null; then
    log_success "Verificação de tabelas concluída"
else
    log_error "Erro ao verificar tabelas"
fi

echo ""
echo "🔍 4. VERIFICANDO PADRÕES DE CÓDIGO"
echo "-----------------------------------"

# Verificar se não há referências ao MySQL
if grep -r "mysql" backend/ --include="*.js" --exclude-dir=node_modules | grep -v "formatDateForPostgreSQL" | grep -v "mysql2" >/dev/null 2>&1; then
    log_warning "Referências ao MySQL encontradas (pode ser normal em comentários)"
else
    log_success "Nenhuma referência problemática ao MySQL encontrada"
fi

# Verificar se usa getDatabaseInstance corretamente
if grep -r "getDatabaseInstance" backend/ --include="*.js" >/dev/null 2>&1; then
    log_success "Uso de getDatabaseInstance encontrado"
else
    log_warning "getDatabaseInstance não encontrado - verifique imports"
fi

# Verificar se usa telegramHelper ao invés de telegramBot
if grep -r "telegramHelper" backend/ --include="*.js" >/dev/null 2>&1; then
    log_success "Uso de telegramHelper encontrado"
else
    log_warning "telegramHelper não encontrado"
fi

echo ""
echo "🚀 5. TESTE DE FUNCIONALIDADE BÁSICA"
echo "------------------------------------"

# Teste de validação simplificado
log_info "Executando teste de validação simplificado..."
if node test_validation.js >/dev/null 2>&1; then
    log_success "Teste de validação básica passou"
else
    log_error "Teste de validação básica falhou"
fi

echo ""
echo "📊 RESUMO DA VALIDAÇÃO"
echo "====================="
echo ""
echo -e "${GREEN}✅ Testes passou: $TESTS_PASSED${NC}"
echo -e "${RED}❌ Testes falharam: $TESTS_FAILED${NC}"
echo -e "${YELLOW}⚠️ Avisos: $WARNINGS${NC}"
echo ""

# Conclusão
if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}🎉 SISTEMA VALIDADO COM SUCESSO!${NC}"
    echo -e "${GREEN}🚀 O sistema está pronto para uso${NC}"
    echo ""
    echo "Para iniciar o sistema:"
    echo "  • API: npm run api"
    echo "  • Monitor: node backend/exchanges/binance/monitoring/orchMonitor.js --account 1"
    echo ""
    exit 0
else
    echo -e "${RED}❌ VALIDAÇÃO FALHOU!${NC}"
    echo -e "${RED}Corrija os erros listados acima antes de usar o sistema${NC}"
    echo ""
    exit 1
fi
