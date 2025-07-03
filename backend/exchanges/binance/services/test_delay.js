// ✅ TESTE DO SISTEMA DE DELAY PARA POSITIONSYNC.JS
const path = require('path');

// Simular as funções de controle de delay
const MIN_DELAY_BEFORE_SYNC_MS = 5 * 60 * 1000; // 5 minutos
const lastDetectedChanges = new Map();

function shouldWaitBeforeSync(symbol, accountId) {
  const key = `${accountId}_${symbol}`;
  const lastChange = lastDetectedChanges.get(key);
  
  if (!lastChange) {
    return false; // Primeira vez, pode sincronizar
  }
  
  const timeSinceLastChange = Date.now() - lastChange;
  return timeSinceLastChange < MIN_DELAY_BEFORE_SYNC_MS;
}

function recordChangeDetected(symbol, accountId) {
  const key = `${accountId}_${symbol}`;
  lastDetectedChanges.set(key, Date.now());
  console.log(`[SYNC_DELAY] 📝 Mudança registrada para ${symbol} (conta ${accountId}). Aguardando ${MIN_DELAY_BEFORE_SYNC_MS/1000/60} minutos antes de sincronizar.`);
}

// Teste principal
async function testDelayControl() {
  console.log('\n=== 🧪 TESTE DO SISTEMA DE DELAY ===\n');
  
  const accountId = 1;
  const symbol = 'BTCUSDT';
  
  // 1. Primeira verificação - deve permitir sincronização
  console.log('1️⃣ Primeira verificação (sem mudanças registradas):');
  const shouldWait1 = shouldWaitBeforeSync(symbol, accountId);
  console.log(`[TEST] Deve aguardar? ${shouldWait1} (esperado: false)`);
  
  // 2. Registrar uma mudança
  console.log('\n2️⃣ Registrando mudança detectada:');
  recordChangeDetected(symbol, accountId);
  
  // 3. Verificação imediata após registrar mudança - deve aguardar
  console.log('\n3️⃣ Verificação imediata após mudança:');
  const shouldWait2 = shouldWaitBeforeSync(symbol, accountId);
  console.log(`[TEST] Deve aguardar? ${shouldWait2} (esperado: true)`);
  
  // 4. Calcular tempo restante
  const key = `${accountId}_${symbol}`;
  const lastChange = lastDetectedChanges.get(key);
  const remainingTime = MIN_DELAY_BEFORE_SYNC_MS - (Date.now() - lastChange);
  const remainingMinutes = Math.ceil(remainingTime / 1000 / 60);
  console.log(`[TEST] Tempo restante: ${remainingMinutes} minutos`);
  
  // 5. Simular passagem de tempo (para teste, vamos reduzir o delay)
  console.log('\n4️⃣ Simulando passagem de 5 minutos...');
  
  // Simular que a mudança foi há 5 minutos
  const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
  lastDetectedChanges.set(key, fiveMinutesAgo);
  
  // 6. Verificação após 5 minutos - deve permitir sincronização
  console.log('\n5️⃣ Verificação após 5 minutos:');
  const shouldWait3 = shouldWaitBeforeSync(symbol, accountId);
  console.log(`[TEST] Deve aguardar? ${shouldWait3} (esperado: false)`);
  
  // 7. Teste com múltiplos símbolos
  console.log('\n6️⃣ Teste com múltiplos símbolos:');
  const symbols = ['ETHUSDT', 'ADAUSDT', 'DOTUSDT'];
  
  symbols.forEach(sym => {
    recordChangeDetected(sym, accountId);
    const wait = shouldWaitBeforeSync(sym, accountId);
    console.log(`[TEST] ${sym}: deve aguardar? ${wait}`);
  });
  
  // 8. Teste com múltiplas contas
  console.log('\n7️⃣ Teste com múltiplas contas:');
  const accounts = [1, 2, 3];
  
  accounts.forEach(acc => {
    recordChangeDetected('BTCUSDT', acc);
    const wait = shouldWaitBeforeSync('BTCUSDT', acc);
    console.log(`[TEST] Conta ${acc}: deve aguardar? ${wait}`);
  });
  
  // 9. Estado final do cache
  console.log('\n8️⃣ Estado do cache de mudanças:');
  console.log(`[TEST] Entradas no cache: ${lastDetectedChanges.size}`);
  for (const [key, timestamp] of lastDetectedChanges.entries()) {
    const age = Math.floor((Date.now() - timestamp) / 1000);
    console.log(`[TEST] ${key}: ${age} segundos atrás`);
  }
  
  console.log('\n=== ✅ TESTE DE DELAY CONCLUÍDO ===\n');
}

// Função para testar sincronização com delay
async function testSyncWithDelay() {
  console.log('\n=== 🧪 TESTE DE SINCRONIZAÇÃO COM DELAY ===\n');
  
  const accountId = 1;
  const mockPositions = [
    { simbolo: 'BTCUSDT', quantidade: 0.5 },
    { simbolo: 'ETHUSDT', quantidade: 2.0 },
    { simbolo: 'ADAUSDT', quantidade: 1000 }
  ];
  
  let syncCount = 0;
  let skipCount = 0;
  
  console.log('1️⃣ Primeira rodada de sincronização (sem histórico):');
  for (const pos of mockPositions) {
    if (shouldWaitBeforeSync(pos.simbolo, accountId)) {
      console.log(`[SYNC] ⏳ Pulando ${pos.simbolo} (aguardando delay)`);
      skipCount++;
    } else {
      console.log(`[SYNC] ✅ Sincronizando ${pos.simbolo}`);
      recordChangeDetected(pos.simbolo, accountId); // Registrar mudança após sincronizar
      syncCount++;
    }
  }
  
  console.log(`\n📊 Primeira rodada: ${syncCount} sincronizados, ${skipCount} pulados`);
  
  console.log('\n2️⃣ Segunda rodada de sincronização (com delay ativo):');
  syncCount = 0;
  skipCount = 0;
  
  for (const pos of mockPositions) {
    if (shouldWaitBeforeSync(pos.simbolo, accountId)) {
      const key = `${accountId}_${pos.simbolo}`;
      const lastChange = lastDetectedChanges.get(key);
      const remainingTime = MIN_DELAY_BEFORE_SYNC_MS - (Date.now() - lastChange);
      const remainingMinutes = Math.ceil(remainingTime / 1000 / 60);
      
      console.log(`[SYNC] ⏳ Pulando ${pos.simbolo} (${remainingMinutes} min restantes)`);
      skipCount++;
    } else {
      console.log(`[SYNC] ✅ Sincronizando ${pos.simbolo}`);
      syncCount++;
    }
  }
  
  console.log(`\n📊 Segunda rodada: ${syncCount} sincronizados, ${skipCount} pulados`);
  
  console.log('\n=== ✅ TESTE DE SINCRONIZAÇÃO CONCLUÍDO ===\n');
}

// Executar testes
async function runAllTests() {
  await testDelayControl();
  await testSyncWithDelay();
}

if (require.main === module) {
  runAllTests().catch(console.error);
}

module.exports = { 
  testDelayControl, 
  testSyncWithDelay,
  shouldWaitBeforeSync,
  recordChangeDetected
};
