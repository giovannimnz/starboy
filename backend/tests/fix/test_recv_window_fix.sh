#!/bin/bash

echo "=== TESTE DE CORREÇÃO DO RECV_WINDOW ==="
echo "Verificando se o recvWindow está respeitando os limites do ambiente..."
echo ""

# Função para testar uma conta específica
test_account() {
    local account_id=$1
    echo "📋 Testando conta $account_id..."
    
    # Executar o teste com timeout de 30 segundos
    timeout 30s node -e "
    const { loadCredentialsFromDatabase, checkServerTime, getOptimizedRecvWindow } = require('./backend/exchanges/binance/api/rest');
    
    async function testAccount() {
        try {
            console.log('[TEST] 🔍 Carregando credenciais da conta $account_id...');
            await loadCredentialsFromDatabase($account_id);
            
            console.log('[TEST] ⏰ Verificando sincronização de tempo...');
            const syncResult = await checkServerTime($account_id);
            
            console.log('[TEST] 📊 Obtendo recvWindow otimizado...');
            const recvWindow = getOptimizedRecvWindow($account_id);
            
            console.log('[TEST] ✅ Resultados:');
            console.log('[TEST]   - Sincronização: ' + (syncResult ? 'SUCESSO' : 'FALHA'));
            console.log('[TEST]   - RecvWindow: ' + recvWindow + 'ms');
            
            // Verificar se está dentro dos limites
            if (recvWindow <= 59000) {
                console.log('[TEST] ✅ RecvWindow dentro do limite para testnet/produção');
            } else {
                console.log('[TEST] ❌ RecvWindow acima do limite para testnet (59000ms)');
            }
            
        } catch (error) {
            console.error('[TEST] ❌ Erro durante teste:', error.message);
        }
    }
    
    testAccount();
    " 2>/dev/null
    
    echo ""
}

# Testar contas específicas
echo "🧪 Iniciando testes de recvWindow..."
echo ""

test_account 999
test_account 1001

echo "=== TESTE CONCLUÍDO ==="
echo ""
echo "🔧 Se ainda houver problemas, verificar:"
echo "   1. Ambiente da conta (testnet vs produção)"
echo "   2. Qualidade da sincronização de tempo"
echo "   3. Logs detalhados do sistema"
