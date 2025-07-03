# 🔧 Sistema de Detecção e Correção de Posições Órfãs

## 📖 Visão Geral

Este sistema implementa uma funcionalidade de **fallback automático** que detecta posições abertas na corretora Binance que não foram criadas adequadamente pelo sistema de webhook, e automaticamente cria as ordens de proteção necessárias (Stop Loss, Realize Profits e Take Profit).

## 🎯 Objetivo

Resolver situações onde:
- Uma posição foi aberta na corretora mas não tem ordens de proteção (SL/TP/RP)
- O webhook falhou em criar as ordens de proteção
- Existe uma posição "órfã" sem gerenciamento de risco

## 🔍 Critérios para Detecção de Posição Órfã

Uma posição é considerada **órfã** quando atende TODOS os critérios:

1. **⏱️ Idade**: Posição existe na corretora há mais de **4 minutos**
2. **📋 Sem ordens ativas**: Não possui ordens abertas na corretora
3. **🛡️ Sem proteção**: 
   - OU não existe no banco de dados local
   - OU existe no banco mas não tem ordens de proteção (SL/TP/RP) ativas
4. **📊 Sinal disponível**: Existe um sinal na tabela `webhook_signals` com preços de SL/TP definidos

## 🏗️ Arquitetura

### Principais Funções

#### `detectAndFixOrphanPositions(accountId)`
- **Função principal** que coordena todo o processo
- Verifica todas as posições da corretora
- Identifica posições órfãs baseado nos critérios
- Chama a função de criação de ordens para cada órfã encontrada

#### `createMissingOrdersForPosition(accountId, position, latestSignal)`
- Cria as ordens SL/RP/TP para uma posição específica
- Usa os preços do último sinal para o símbolo
- Valida quantidades e preços antes de criar ordens
- Salva as ordens no banco de dados

### Integração com Sincronização

A detecção de órfãs foi integrada à função `syncPositionsWithAutoClose()` e é executada automaticamente durante a sincronização regular.

## 📊 Tipos de Ordens Criadas

### 🛑 Stop Loss (SL)
- **Tipo**: `STOP_MARKET`
- **Quantidade**: 100% da posição
- **Preço**: `signal.sl_price`
- **Reduce-Only**: ✅ Sim

### 🎯 Realize Profits (RP1-4)
- **Tipo**: `LIMIT` (Reduce-Only)
- **Distribuição**:
  - **RP1**: 25% da posição @ `signal.tp1_price`
  - **RP2**: 25% da posição @ `signal.tp2_price`
  - **RP3**: 25% da posição @ `signal.tp3_price`
  - **RP4**: 15% da posição @ `signal.tp4_price`

### 💰 Take Profit Final (TP)
- **Tipo**: `LIMIT` (Reduce-Only)
- **Quantidade**: 10% da posição (restante)
- **Preço**: `signal.tp5_price` ou `signal.tp_price`

## 🗄️ Estrutura do Banco de Dados

### Tabela `webhook_signals`
Campos utilizados para buscar o último sinal:
```sql
SELECT id, symbol, side, sl_price, tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, tp_price, created_at
FROM webhook_signals 
WHERE symbol = ? AND conta_id = ? 
ORDER BY created_at DESC 
LIMIT 1
```

### Tabela `ordens`
Ordens criadas são salvas com:
- `orign_sig`: `FALLBACK_{signal_id}` (identificação especial)
- `tipo_ordem_bot`: `STOP_LOSS`, `RP1`, `RP2`, `RP3`, `RP4`, `TP`
- `reduce_only`: `1` (todas as ordens são reduce-only)

## 🚀 Como Usar

### 1. Execução Automática
O sistema roda automaticamente durante a sincronização:
```javascript
const syncResults = await syncPositionsWithAutoClose(accountId);
// Inclui verificação de órfãs automaticamente
```

### 2. Execução Manual
```javascript
const { detectAndFixOrphanPositions } = require('./positionSync');

const results = await detectAndFixOrphanPositions(accountId);
console.log(`Órfãs corrigidas: ${results.fixed}`);
```

### 3. Teste e Validação
```bash
# Testar sem criar ordens reais
node test-orphan-positions.js 1 --dry-run

# Executar correção real
node test-orphan-positions.js 1
```

## 📈 Exemplo de Funcionamento

### Cenário:
- Posição BTCUSDT aberta na corretora: `0.1 BTC LONG`
- Idade da posição: 6 minutos
- Sem ordens de proteção ativas
- Último sinal disponível com preços SL/TP

### Processo:
1. **Detecção**: Sistema identifica posição órfã
2. **Busca sinal**: Encontra último sinal para BTCUSDT
3. **Criação de ordens**:
   ```
   SL:  0.1 BTC @ $45,000 (STOP_MARKET)
   RP1: 0.025 BTC @ $52,000 (LIMIT)
   RP2: 0.025 BTC @ $55,000 (LIMIT)
   RP3: 0.025 BTC @ $58,000 (LIMIT)
   RP4: 0.015 BTC @ $60,000 (LIMIT)
   TP:  0.01 BTC @ $65,000 (LIMIT)
   ```
4. **Salvamento**: Ordens salvas no banco com `orign_sig = FALLBACK_123`

## 🛡️ Validações e Segurança

### Validações Implementadas:
- ✅ Idade mínima da posição (4 minutos)
- ✅ Ausência de ordens ativas na corretora
- ✅ Validação de quantidades mínimas
- ✅ Ajuste automático de quantidades conforme regras da Binance
- ✅ Arredondamento de preços conforme tick size
- ✅ Verificação de sinal disponível com preços válidos

### Tratamento de Erros:
- 🔄 Retry automático em caso de deadlock no banco
- 📝 Log detalhado de todos os passos
- 🚨 Continuação do processo mesmo se uma ordem falhar
- 📊 Relatório completo de sucessos e erros

## 📋 Logs e Monitoramento

### Identificadores de Log:
- `[ORPHAN_DETECTION]`: Processo principal de detecção
- `[MISSING_ORDERS]`: Criação de ordens específicas
- `[SYNC_AUTO]`: Integração com sincronização

### Exemplo de Logs:
```
[ORPHAN_DETECTION] 🔍 Detectando posições órfãs para conta 1...
[ORPHAN_DETECTION] 📊 Encontradas 3 posições na corretora
[ORPHAN_DETECTION] 🔍 Verificando BTCUSDT (idade: 6 min)...
[ORPHAN_DETECTION] ⚠️ BTCUSDT: posição existe no banco mas SEM ordens de proteção, tratando como órfã!
[MISSING_ORDERS] 🔧 Criando ordens SL/RPs/TP para posição órfã: BTCUSDT (0.1)
[MISSING_ORDERS] 🛑 Criando STOP LOSS: 0.1000 @ 45000.00
[MISSING_ORDERS] ✅ STOP LOSS criado: 1234567890
[MISSING_ORDERS] 🎯 Criando RP1: 0.0250 @ 52000.00 (25%)
[MISSING_ORDERS] ✅ RP1 criado: 1234567891
[ORPHAN_DETECTION] ✅ BTCUSDT: 5 ordens de proteção criadas com sucesso!
```

## 🔧 Configuração

### Parâmetros Ajustáveis:
```javascript
// Idade mínima para considerar órfã (4 minutos)
const MIN_POSITION_AGE_MINUTES = 4;

// Distribuição de Take Profits
const TP_DISTRIBUTION = {
  rp1: 0.25, // 25%
  rp2: 0.25, // 25%
  rp3: 0.25, // 25%
  rp4: 0.15, // 15%
  tp:  0.10  // 10%
};
```

## 🚀 Benefícios

1. **🛡️ Segurança**: Posições nunca ficam sem proteção
2. **🔄 Automático**: Funciona sem intervenção manual
3. **📊 Inteligente**: Usa dados dos sinais originais
4. **🎯 Preciso**: Valida todas as quantidades e preços
5. **📝 Auditável**: Logs detalhados de todas as ações
6. **⚡ Eficiente**: Integrado ao processo de sincronização

## 🔍 Solução de Problemas

### Problema: Órfã não detectada
**Verificar:**
- Posição tem mais de 4 minutos?
- Não tem ordens ativas na corretora?
- Existe sinal com preços SL/TP válidos?

### Problema: Ordem não criada
**Verificar:**
- Saldo suficiente na conta?
- Quantidade atende aos requisitos mínimos?
- Preços estão dentro dos limites permitidos?

### Problema: Muitos erros de validação
**Ação:**
- Verificar configurações de precisão do símbolo
- Ajustar distribuição de percentuais dos TPs
- Verificar conectividade com API da Binance

## 📚 Referências

- **Arquivo principal**: `positionSync.js`
- **Arquivo de teste**: `test-orphan-positions.js`
- **Funções de API**: `rest.js`
- **Banco de dados**: `conexao.js`

---

## 💡 Próximas Melhorias

1. **📊 Dashboard**: Interface visual para monitorar órfãs
2. **⚙️ Configuração**: Percentuais de TP ajustáveis por conta
3. **📈 Métricas**: Estatísticas de órfãs detectadas e corrigidas
4. **🔔 Alertas**: Notificações quando órfãs são detectadas
5. **🧪 Testes**: Suite de testes automatizados mais abrangente
