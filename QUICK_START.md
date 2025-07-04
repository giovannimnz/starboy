# 🚀 GUIA DE INICIALIZAÇÃO RÁPIDA - STARBOY POSTGRES

## 📋 Passos para Inicializar o Sistema

### 1. **Verificar Dados Básicos**
```bash
node backend/exchanges/binance/processes/setup_basic_data.js
```

### 2. **Listar Contas Disponíveis**
```bash
node backend/exchanges/binance/processes/list_accounts.js
```

### 3. **Executar Monitoramento**
```bash
node backend/exchanges/binance/monitoring/orchMonitor.js --account 5
```

---

## 🔧 Configuração Inicial

### Credenciais da API (OBRIGATÓRIO)
Antes de usar em produção, configure as credenciais reais:

```sql
-- Conectar ao PostgreSQL
psql -U postgres -d starboy_db

-- Atualizar credenciais
UPDATE contas SET 
  api_key = 'SUA_API_KEY_BINANCE',
  api_secret = 'SUA_API_SECRET_BINANCE'
WHERE id = 5;
```

---

## 🏁 Comandos Essenciais

### Iniciar Sistema Completo
```bash
# 1. Verificar configuração
node backend/exchanges/binance/processes/setup_basic_data.js

# 2. Iniciar monitoramento
node backend/exchanges/binance/monitoring/orchMonitor.js --account 5
```

### Testes Rápidos
```bash
# Teste básico
node test_basic.js

# Teste de conexão
node -e "
const { getDatabaseInstance } = require('./backend/core/database/conexao');
getDatabaseInstance().then(db => {
  return db.query('SELECT COUNT(*) as count FROM contas');
}).then(result => {
  console.log('✅ Contas no banco:', result.rows[0].count);
});
"
```

---

## 📊 Status do Sistema

- ✅ **Banco de dados**: PostgreSQL configurado
- ✅ **Backend**: Node.js com todas as correções
- ✅ **Monitoramento**: Sistema de orquestração funcional
- ✅ **Testes**: Todos os testes básicos passando

---

## 🎯 Próximos Passos

1. **Configure as credenciais da API**
2. **Execute o monitoramento**
3. **Monitore os logs**
4. **Ajuste conforme necessário**

---

*Sistema pronto para uso - Migração concluída com sucesso!*
