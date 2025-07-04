#!/bin/bash
echo "🔄 TESTE DE RE-SINCRONIZAÇÃO FORÇADA - CONTA 1001"
echo "=================================================="

# Função para testar a re-sincronização de tempo
node -e "
const { forceTimeResync, checkServerTime, getAccountState } = require('./backend/exchanges/binance/api/rest');
const { loadCredentialsFromDatabase } = require('./backend/exchanges/binance/api/rest');

async function testForceResync() {
  try {
    console.log('🔍 ETAPA 1: Carregando credenciais da conta 1001...');
    await loadCredentialsFromDatabase(1001);
    
    console.log('\\n📊 ETAPA 2: Verificando sincronização atual...');
    const currentSync = await checkServerTime(1001);
    const currentState = getAccountState(1001);
    
    if (currentState) {
      console.log('Estado atual da conta 1001:');
      console.log('  - Qualidade:', currentState.syncQuality || 'DESCONHECIDA');
      console.log('  - RECV_WINDOW:', currentState.recvWindow || 'NÃO_DEFINIDO');
      console.log('  - Offset de tempo:', currentState.timeOffset || 0);
    }
    
    console.log('\\n🔄 ETAPA 3: Executando re-sincronização forçada...');
    const resyncResult = await forceTimeResync(1001, 3);
    
    console.log('\\n📋 ETAPA 4: Resultado da re-sincronização:');
    console.log('  - Sucesso:', resyncResult.success);
    console.log('  - Tentativas:', resyncResult.attempts);
    console.log('  - Qualidade final:', resyncResult.quality);
    console.log('  - RECV_WINDOW final:', resyncResult.recvWindow);
    console.log('  - Offset final:', resyncResult.timeOffset);
    console.log('  - Mensagem:', resyncResult.message);
    
    console.log('\\n✅ TESTE CONCLUÍDO');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
    console.error(error.stack);
  }
}

testForceResync();
"

echo ""
echo "🔍 VERIFICANDO ESTADO FINAL DA CONTA 1001..."

# Verificar o estado final
node -e "
const { getAccountState } = require('./backend/exchanges/binance/api/rest');

const state = getAccountState(1001);
if (state) {
  console.log('📊 Estado final da conta 1001:');
  console.log('  - Qualidade de sincronização:', state.syncQuality || 'NÃO_DEFINIDA');
  console.log('  - RECV_WINDOW:', state.recvWindow || 'NÃO_DEFINIDO');
  console.log('  - Offset de tempo:', state.timeOffset || 0, 'ms');
  console.log('  - Última verificação:', state.lastTimeSyncCheck ? new Date(state.lastTimeSyncCheck).toISOString() : 'NUNCA');
  console.log('  - Latência média de rede:', state.avgNetworkLatency || 'DESCONHECIDA');
} else {
  console.log('❌ Estado da conta 1001 não encontrado');
}
"

echo ""
echo "✅ Teste de re-sincronização concluído!"
