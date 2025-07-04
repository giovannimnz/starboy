# ÍNDICE DE ARQUIVOS DE CORREÇÃO (FIX)

## 📁 Estrutura Organizacional

### 🔧 Scripts de Correção
**Localização:** `scripts/fix/`
- Scripts executáveis para aplicar correções
- Executar com: `node scripts/fix/[script-name].js`

### 🧪 Testes de Correção  
**Localização:** `backend/tests/fix/`
- Scripts de teste para validar correções
- Executar com: `./backend/tests/fix/[test-name].sh`

### 📚 Documentação por Categoria

#### 🗄️ Database & Performance
**Localização:** `docs/backend/exchanges/binance-docs/database/`
- Otimizações de banco de dados
- Índices e performance
- Logs e auditoria

#### 🌐 API & WebSocket
**Localização:** `docs/backend/exchanges/binance-docs/api-fixes/`
- Correções de API REST
- Melhorias em WebSocket
- Sincronização de tempo
- RecvWindow e timeouts

#### 📊 Sistema & Monitoramento
**Localização:** `docs/backend/exchanges/binance-docs/monitoring/`
- Correções do sistema de monitoramento
- Logs e debugging
- Relatórios de sistema

#### 📈 Trading de Futuros
**Localização:** `docs/backend/exchanges/binance-docs/futures/`
- Estratégias e algoritmos
- Buffer de ordens
- Vinculação de sinais

---

## 🚀 Como Usar

1. **Aplicar Correção:**
   ```bash
   cd scripts/fix
   node [script-name].js
   ```

2. **Testar Correção:**
   ```bash
   cd backend/tests/fix
   ./test_[test-name].sh
   ```

3. **Consultar Documentação:**
   Navegar até a categoria apropriada em `docs/backend/exchanges/binance-docs/`

---
*Atualizado em: 2025-07-03T12:03:07.129Z*
*Gerado por: reorganize-fix-structure.js*
