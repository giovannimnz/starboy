# CORREÇÃO DO RECV_WINDOW PARA AMBIENTES TESTNET/PRODUÇÃO

## Problema Identificado
O sistema estava tentando usar `recvWindow` de 120000ms (2 minutos) na Binance testnet, que tem limite máximo de 60000ms (1 minuto), causando erro:
```
'recvWindow' must be less than 60000.
```

## Correções Implementadas

### 1. Detecção Automática de Ambiente
- ✅ Implementada verificação de ambiente (testnet vs produção)
- ✅ Limites dinâmicos baseados no ambiente:
  - **Testnet**: máximo 59000ms (59 segundos)
  - **Produção**: máximo 180000ms (3 minutos)

### 2. Função `checkServerTime()` Atualizada
**Arquivo**: `backend/exchanges/binance/api/rest.js`

```javascript
// Verificar limites do ambiente (testnet vs produção)
const isTestnet = accountState && accountState.ambiente === 'testnet';
const maxRecvWindow = isTestnet ? 59000 : 180000;

// Aplicar limites corretos baseados na qualidade de sincronização E ambiente
if (targetTimeDiff <= 200) {
  recvWindow = Math.min(5000, maxRecvWindow);
} else if (targetTimeDiff <= 2000) {
  recvWindow = Math.min(40000, maxRecvWindow);
} else if (targetTimeDiff <= 5000) {
  // Para casos como 2081ms
  recvWindow = Math.min(isTestnet ? 59000 : 80000, maxRecvWindow);
}
```

### 3. Função `getOptimizedRecvWindow()` Atualizada
```javascript
function getOptimizedRecvWindow(accountId) {
  const accountState = getAccountState(accountId);
  
  // Verificar limites do ambiente
  const isTestnet = accountState && accountState.ambiente === 'testnet';
  const maxRecvWindow = isTestnet ? 59000 : 180000;
  
  if (accountState && accountState.recvWindow) {
    // Garantir que está dentro dos limites do ambiente
    return Math.min(accountState.recvWindow, maxRecvWindow);
  }
  
  // Fallback baseado no ambiente
  return isTestnet ? 59000 : 120000;
}
```

### 4. Atualização de Todas as Funções de API
- ✅ `getAllOpenPositions()` - usa `getOptimizedRecvWindow()`
- ✅ `makeAuthenticatedRequest()` - usa `getOptimizedRecvWindow()`
- ✅ `orchMonitor.js` - configuração de segurança respeitando limites

## Resultados dos Testes

### Conta 999 (Testnet):
```
[CONTA-999] 🏗️ Ambiente detectado: TESTNET (limite: 59000ms)
[CONTA-999] ⚙️ Configuração aplicada:
[CONTA-999]   - RECV_WINDOW: 59000ms
[CONTA-999]   - Qualidade: MUITO_RUIM
[CONTA-999]   - Offset de tempo: 2093ms
[TEST] ✅ RecvWindow dentro do limite para testnet
```

### Conta 1001 (Testnet):
```
[CONTA-1001] 🏗️ Ambiente detectado: TESTNET (limite: 59000ms)
[CONTA-1001] ⚙️ Configuração aplicada:
[CONTA-1001]   - RECV_WINDOW: 59000ms
[CONTA-1001]   - Qualidade: MUITO_RUIM
[CONTA-1001]   - Offset de tempo: 2087ms
[TEST] ✅ RecvWindow dentro do limite para testnet
```

## Qualidade de Sincronização

O sistema agora classifica adequadamente a sincronização de ~2000ms como "MUITO_RUIM" mas ainda funcional:

- **≤ 200ms**: EXCELENTE (5000ms)
- **≤ 500ms**: BOA (10000ms)
- **≤ 1000ms**: ACEITÁVEL (20000ms)
- **≤ 2000ms**: RUIM (40000ms)
- **≤ 5000ms**: MUITO_RUIM (59000ms para testnet, 80000ms para produção)
- **≤ 10000ms**: CRÍTICA (59000ms para testnet, 120000ms para produção)
- **> 10000ms**: INACEITÁVEL (máximo do ambiente)

## Verificação Final

Para verificar se a correção está funcionando:
```bash
./test_recv_window_fix.sh
```

## Recomendações para Melhorar Sincronização

Para reduzir a diferença de tempo de ~2000ms para valores menores:

1. **Verificar NTP**: `w32tm /query /status`
2. **Sincronizar manualmente**: `w32tm /resync`
3. **Verificar latência de rede**: `ping 8.8.8.8`
4. **Usar conexão com fio** em vez de WiFi
5. **Considerar VPS** com melhor conectividade

## Status
✅ **CORREÇÃO IMPLEMENTADA E TESTADA**
- Ambiente testnet agora usa máximo 59000ms
- Ambiente produção mantém máximo 180000ms
- Sistema detecta automaticamente o ambiente
- Todas as funções de API respeitam os limites corretos
