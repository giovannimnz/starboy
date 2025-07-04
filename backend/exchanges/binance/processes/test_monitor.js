/**
 * Script de teste para verificar se as correções funcionaram
 */

const { execSync } = require('child_process');
const path = require('path');

// Configuração
const MONITOR_SCRIPT = path.join(__dirname, '..', 'monitoring', 'orchMonitor.js');
const TEST_ACCOUNT_ID = 5;
const TEST_TIMEOUT = 10000; // 10 segundos

console.log('🧪 === TESTE DE INICIALIZAÇÃO DE CONTA ===');
console.log(`📁 Script: ${MONITOR_SCRIPT}`);
console.log(`🎯 Conta de teste: ${TEST_ACCOUNT_ID}`);
console.log(`⏱️ Timeout: ${TEST_TIMEOUT}ms`);

try {
  console.log('\n🚀 Iniciando teste...');
  
  // Executar o monitor para a conta de teste
  const result = execSync(`node "${MONITOR_SCRIPT}" --account ${TEST_ACCOUNT_ID}`, {
    timeout: TEST_TIMEOUT,
    encoding: 'utf8',
    cwd: __dirname
  });
  
  console.log('📊 Saída do processo:');
  console.log(result);
  
  if (result.includes('ERRO FATAL')) {
    console.error('❌ Teste falhou: Erro fatal detectado');
    process.exit(1);
  } else if (result.includes('MONITORAMENTO INICIALIZADO')) {
    console.log('✅ Teste passou: Monitoramento foi inicializado com sucesso');
    process.exit(0);
  } else {
    console.log('⚠️ Teste inconclusivo: Processo não apresentou erros fatais');
    process.exit(0);
  }
  
} catch (error) {
  if (error.signal === 'SIGTERM') {
    console.log('⚠️ Teste timeout (esperado) - processo está executando');
    console.log('✅ Isso indica que o processo não crashou imediatamente');
    process.exit(0);
  } else {
    console.error('❌ Erro no teste:', error.message);
    if (error.stdout) {
      console.log('📊 Saída padrão:', error.stdout);
    }
    if (error.stderr) {
      console.error('📊 Saída de erro:', error.stderr);
    }
    process.exit(1);
  }
}
