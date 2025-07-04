#!/bin/bash

# Script para executar testes finais do projeto Starboy

echo "🏁 === EXECUÇÃO DE TESTES FINAIS ==="
echo "📅 Data: $(date)"

# Navegar para o diretório do projeto
cd /c/Users/muniz/Documents/GitHub/starboy_postgres

echo ""
echo "🧪 1. Teste básico..."
node test_basic.js

echo ""
echo "🔍 2. Validação final..."
node validate_final.js

echo ""
echo "📊 3. Verificando estrutura de arquivos..."
ls -la backend/exchanges/binance/monitoring/
ls -la backend/exchanges/binance/processes/

echo ""
echo "🗃️ 4. Testando conexão direta com banco..."
node -e "
const { getDatabaseInstance } = require('./backend/core/database/conexao');
getDatabaseInstance().then(db => {
  return db.query('SELECT COUNT(*) as count FROM contas');
}).then(result => {
  console.log('✅ Contas no banco:', result.rows[0].count);
}).catch(error => {
  console.error('❌ Erro:', error.message);
});
"

echo ""
echo "🏁 === TESTES FINAIS CONCLUÍDOS ==="
