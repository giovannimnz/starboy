#!/bin/bash

# Script para testar o sistema Starboy após correções

echo "🧪 === TESTE FINAL DO SISTEMA STARBOY ==="
echo "📅 Data: $(date)"
echo ""

# Navegar para o diretório do projeto
cd /c/Users/muniz/Documents/GitHub/starboy_postgres

echo "📁 Diretório atual: $(pwd)"
echo ""

echo "🔧 1. Verificando correções aplicadas..."
node FIXES_SUMMARY.js

echo ""
echo "🗃️ 2. Testando conexão com banco..."
node -e "
const { getDatabaseInstance } = require('./backend/core/database/conexao');
getDatabaseInstance().then(db => {
  return db.query('SELECT COUNT(*) as count FROM contas');
}).then(result => {
  console.log('✅ Conexão com banco: OK');
  console.log('📊 Contas no banco:', result.rows[0].count);
}).catch(error => {
  console.error('❌ Erro na conexão:', error.message);
});
"

echo ""
echo "🔑 3. Testando carregamento de credenciais..."
node -e "
const { loadCredentialsFromDatabase } = require('./backend/exchanges/binance/api/rest');
loadCredentialsFromDatabase(5).then(credentials => {
  console.log('✅ Credenciais carregadas com sucesso');
  console.log('   - apiUrl:', credentials.apiUrl ? 'DEFINIDO' : 'undefined');
  console.log('   - spotApiUrl:', credentials.spotApiUrl ? 'DEFINIDO' : 'undefined');
  console.log('   - ambiente:', credentials.ambiente || 'undefined');
}).catch(error => {
  console.error('❌ Erro ao carregar credenciais:', error.message);
});
"

echo ""
echo "🚀 4. Testando inicialização rápida do monitor..."
timeout 10 node backend/exchanges/binance/monitoring/orchMonitor.js --account 5 || echo "Monitor parado após 10 segundos (esperado)"

echo ""
echo "🏁 === TESTE FINAL CONCLUÍDO ==="
echo "Se não houve erros fatais acima, o sistema está funcionando!"
echo ""
echo "Para usar o sistema:"
echo "node backend/exchanges/binance/monitoring/orchMonitor.js --account 5"
