# 🔧 Fallback System: Detecção e Correção de Posições Órfãs

## 📖 Resumo

Foi implementado um **sistema de fallback automático** que detecta posições abertas na corretora Binance que não possuem ordens de proteção (SL/TP/RP) e automaticamente cria essas ordens baseadas no último sinal disponível para o símbolo.

## 🚀 Como Usar

### 1. Execução Automática (Recomendado)
O sistema roda automaticamente durante a sincronização de posições:
```bash
# O sistema já está integrado ao monitoramento regular
# Não é necessária nenhuma ação adicional
```

### 2. Teste Manual (Simulação)
```bash
# Testar sem criar ordens reais
npm run test:orphans:dry 1

# Ou diretamente:
node backend/exchanges/binance/services/test-orphan-positions.js 1 --dry-run
```

### 3. Execução Manual (Real)
```bash
# Executar correção real para conta 1
npm run test:orphans 1

# Ou diretamente:
node backend/exchanges/binance/services/test-orphan-positions.js 1
```

### 4. Verificar ajuda
```bash
node backend/exchanges/binance/services/test-orphan-positions.js --help
```

## 🔍 Critérios de Detecção

Uma posição é considerada **órfã** quando:
- ✅ **Idade**: Existe há mais de 4 minutos na corretora
- ✅ **Sem ordens**: Não tem ordens abertas na corretora
- ✅ **Sem proteção**: Não tem ordens SL/TP/RP no banco local
- ✅ **Sinal disponível**: Existe sinal com preços SL/TP na tabela `webhook_signals`

## 📊 Ordens Criadas

Para cada posição órfã detectada, o sistema cria:

### 🛑 Stop Loss
- **1 ordem** STOP_MARKET para 100% da posição
- Preço: `signal.sl_price`

### 🎯 Realize Profits (4 ordens)
- **RP1**: 25% da posição @ `signal.tp1_price`
- **RP2**: 25% da posição @ `signal.tp2_price`
- **RP3**: 25% da posição @ `signal.tp3_price`
- **RP4**: 15% da posição @ `signal.tp4_price`

### 💰 Take Profit Final
- **TP**: 10% da posição @ `signal.tp5_price` ou `signal.tp_price`

## 📈 Exemplo Prático

```bash
# Situação: Posição BTCUSDT 0.1 BTC LONG órfã de 6 minutos
$ npm run test:orphans 1

# Resultado:
[ORPHAN_DETECTION] 🔍 Detectando posições órfãs para conta 1...
[ORPHAN_DETECTION] ⚠️ BTCUSDT: posição órfã detectada!
[MISSING_ORDERS] 🛑 Criando STOP LOSS: 0.1000 @ 45000.00
[MISSING_ORDERS] ✅ STOP LOSS criado: 1234567890
[MISSING_ORDERS] 🎯 Criando RP1: 0.0250 @ 52000.00 (25%)
[MISSING_ORDERS] ✅ RP1 criado: 1234567891
# ... (mais 4 ordens de TP)
[ORPHAN_DETECTION] ✅ BTCUSDT: 5 ordens de proteção criadas!
```

## 🔧 Integração com Código Existente

### Em `positionSync.js`
```javascript
// A função já está integrada automaticamente
const { detectAndFixOrphanPositions } = require('./positionSync');

// Executar manualmente se necessário
const results = await detectAndFixOrphanPositions(accountId);
console.log(`Órfãs corrigidas: ${results.fixed}`);
```

### No Monitoramento Regular
```javascript
// Em orchMonitor.js ou similar
// A detecção roda automaticamente na sincronização
const syncResults = await syncPositionsWithAutoClose(accountId);

// Verificar se órfãs foram corrigidas
if (syncResults.orphansFixed > 0) {
  console.log(`${syncResults.orphansFixed} posições órfãs corrigidas!`);
}
```

## 📝 Logs e Identificação

### Tags de Log:
- `[ORPHAN_DETECTION]`: Processo principal
- `[MISSING_ORDERS]`: Criação de ordens
- `[SYNC_AUTO]`: Integração com sincronização

### Identificação no Banco:
Ordens criadas pelo sistema órfã são marcadas com:
- `orign_sig`: `FALLBACK_{signal_id}`
- `tipo_ordem_bot`: `STOP_LOSS`, `RP1`, `RP2`, `RP3`, `RP4`, `TP`

## ⚠️ Considerações Importantes

### Requisitos:
1. **Sinal válido**: Deve existir um sinal com preços SL/TP para o símbolo
2. **Saldo suficiente**: Conta deve ter margin suficiente
3. **Quantidades válidas**: Ordens devem atender aos requisitos mínimos da Binance

### Limitações:
1. **Apenas posições órfãs**: Não sobrescreve ordens existentes
2. **4 minutos mínimo**: Não processa posições muito recentes
3. **Último sinal**: Usa sempre o sinal mais recente para o símbolo

## 🛡️ Segurança

### Validações Automáticas:
- ✅ Verificação de idade da posição
- ✅ Validação de quantidades mínimas
- ✅ Ajuste automático conforme regras da Binance
- ✅ Arredondamento de preços conforme tick size
- ✅ Verificação de sinal válido com preços

### Proteções:
- 🔒 Não cria ordens duplicadas
- 🔄 Retry automático em deadlocks
- 📝 Log detalhado de todas as ações
- 🚨 Continua mesmo se uma ordem falhar

## 📚 Arquivos Relacionados

- **`positionSync.js`**: Implementação principal
- **`test-orphan-positions.js`**: Script de teste
- **`ORPHAN_POSITIONS_GUIDE.md`**: Documentação completa
- **`rest.js`**: Funções de API para criar ordens

## 🔍 Solução de Problemas

### Órfã não detectada?
1. Verificar se posição tem mais de 4 minutos
2. Confirmar que não há ordens ativas na corretora
3. Verificar se existe sinal com preços SL/TP válidos

### Ordem não criada?
1. Verificar saldo na conta
2. Confirmar quantidade mínima do símbolo
3. Verificar se preços estão dentro dos limites

### Muitos erros?
1. Verificar conectividade com API Binance
2. Confirmar configurações de precisão
3. Verificar se sinais têm preços válidos

## 📞 Suporte

Em caso de problemas:
1. Verificar logs com tag `[ORPHAN_DETECTION]`
2. Executar teste em modo dry-run primeiro
3. Verificar se a funcionalidade está ativa no monitoramento

---

## 💡 Benefícios

✅ **Automático**: Funciona sem intervenção manual  
✅ **Seguro**: Múltiplas validações e proteções  
✅ **Inteligente**: Usa dados dos sinais originais  
✅ **Auditável**: Logs detalhados de todas as ações  
✅ **Eficiente**: Integrado ao processo de sincronização  
✅ **Confiável**: Baseado na mesma lógica do reverse.js

**Resultado**: Nenhuma posição fica sem proteção, garantindo gestão de risco adequada mesmo em situações de falha do sistema principal.
