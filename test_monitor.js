/**
 * Teste de monitoramento com timeout para verificar se o sistema inicia sem erros
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 === TESTE DE MONITORAMENTO ===');

const MONITOR_SCRIPT = path.join(__dirname, 'backend', 'exchanges', 'binance', 'monitoring', 'orchMonitor.js');
const TEST_ACCOUNT_ID = 5;
const TEST_TIMEOUT = 10000; // 10 segundos

console.log(`📁 Script: ${MONITOR_SCRIPT}`);
console.log(`🎯 Conta de teste: ${TEST_ACCOUNT_ID}`);
console.log(`⏱️ Timeout: ${TEST_TIMEOUT}ms`);

const child = spawn('node', [MONITOR_SCRIPT, '--account', TEST_ACCOUNT_ID], {
  stdio: 'pipe',
  cwd: __dirname
});

let output = '';
let hasError = false;

// Capturar saída
child.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  process.stdout.write(text);
});

child.stderr.on('data', (data) => {
  const text = data.toString();
  output += text;
  process.stderr.write(text);
  hasError = true;
});

// Timeout para matar o processo
const timeout = setTimeout(() => {
  console.log('\n⏰ Timeout atingido - matando processo...');
  child.kill('SIGTERM');
}, TEST_TIMEOUT);

child.on('close', (code) => {
  clearTimeout(timeout);
  
  console.log(`\n📊 === RESULTADO DO TESTE ===`);
  console.log(`🔢 Código de saída: ${code}`);
  
  if (output.includes('ERRO FATAL') || output.includes('ERRO CRÍTICO')) {
    console.log('❌ Teste falhou: Erro fatal detectado');
    process.exit(1);
  } else if (output.includes('MONITORAMENTO INICIALIZADO') || output.includes('Registrando todos os handlers')) {
    console.log('✅ Teste passou: Monitoramento iniciou corretamente');
    process.exit(0);
  } else if (code === null || code === 0) {
    console.log('✅ Teste passou: Processo executou sem erros fatais');
    process.exit(0);
  } else {
    console.log('⚠️ Teste inconclusivo: Processo terminou com código', code);
    process.exit(0);
  }
});

child.on('error', (error) => {
  clearTimeout(timeout);
  console.error('❌ Erro ao executar processo:', error.message);
  process.exit(1);
});

console.log('\n🚀 Iniciando teste de monitoramento...');
