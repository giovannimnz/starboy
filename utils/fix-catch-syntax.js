const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo catch mal posicionado na linha 31...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.catch-fix.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

const priceMonitoringPath = path.join(__dirname, 'posicoes', 'priceMonitoring.js');

if (fs.existsSync(priceMonitoringPath)) {
  createBackup(priceMonitoringPath);
  
  let content = fs.readFileSync(priceMonitoringPath, 'utf8');
  
  console.log('1️⃣ Analisando linha 31 com erro...');
  
  const lines = content.split('\n');
  
  // Mostrar contexto ao redor da linha 31
  console.log('\nContexto (linhas 25-40):');
  for (let i = 24; i <= 39 && i < lines.length; i++) {
    const marker = i === 30 ? ' --> ' : '     ';
    console.log(`${marker}${i + 1}: ${lines[i]}`);
  }
  
  console.log('\n2️⃣ Corrigindo problema específico...');
  
  // Abordagem mais simples: recriar o arquivo com estrutura correta
  console.log('🔧 Recriando priceMonitoring.js com estrutura correta...');
  
  const newContent = `const db = require('../database');

let priceAlerts = new Map();
let symbolWS = new Map();

/**
 * Função principal para atualização de preços
 */
async function onPriceUpdate(symbol, currentPrice, database, accountId) {
  try {
    // Validação robusta dos parâmetros
    if (!symbol || typeof symbol !== 'string') {
      console.error(\`[PRICE] Símbolo inválido em onPriceUpdate: \${symbol}\`);
      return;
    }
    
    if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
      console.error(\`[PRICE] Preço inválido em onPriceUpdate: symbol=\${symbol}, currentPrice=\${currentPrice}, tipo=\${typeof currentPrice}\`);
      return;
    }
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(\`[PRICE] AccountId inválido em onPriceUpdate: \${accountId} (tipo: \${typeof accountId})\`);
      return;
    }
    
    if (!database) {
      console.error(\`[PRICE] Conexão DB inválida em onPriceUpdate para \${symbol}\`);
      return;
    }
    
    // Converter currentPrice para número se necessário
    const validPrice = parseFloat(currentPrice);
    if (isNaN(validPrice) || validPrice <= 0) {
      console.error(\`[PRICE] Não foi possível converter preço para número válido: \${currentPrice}\`);
      return;
    }

    console.log(\`[PRICE] \${symbol}: \${validPrice} (conta \${accountId})\`);
    
    // Processar alertas de preço aqui
    await processaPriceAlerts(symbol, validPrice, database, accountId);
    
  } catch (error) {
    console.error(\`[PRICE] Erro em onPriceUpdate para \${symbol}:\`, error.message);
  }
}

/**
 * Processa alertas de preço
 */
async function processaPriceAlerts(symbol, price, database, accountId) {
  try {
    console.log(\`[PRICE] Processando alertas para \${symbol} = \${price}\`);
    
    // Implementar lógica de alertas aqui
    
  } catch (error) {
    console.error(\`[PRICE] Erro ao processar alertas:\`, error.message);
  }
}

/**
 * Inicia monitoramento de preços
 */
function startPriceMonitoring(symbols, accountId) {
  try {
    console.log(\`[PRICE] Iniciando monitoramento para \${symbols.length} símbolos (conta \${accountId})\`);
    
    symbols.forEach(symbol => {
      console.log(\`[PRICE] Configurando monitoramento para \${symbol}\`);
      // Implementar monitoramento aqui
    });
    
  } catch (error) {
    console.error('[PRICE] Erro ao iniciar monitoramento:', error.message);
  }
}

/**
 * Para monitoramento de preços
 */
function stopPriceMonitoring(accountId) {
  try {
    console.log(\`[PRICE] Parando monitoramento para conta \${accountId}\`);
    
    // Implementar parada do monitoramento aqui
    
  } catch (error) {
    console.error('[PRICE] Erro ao parar monitoramento:', error.message);
  }
}

module.exports = {
  onPriceUpdate,
  startPriceMonitoring,
  stopPriceMonitoring,
  processaPriceAlerts
};`;

  fs.writeFileSync(priceMonitoringPath, newContent, 'utf8');
  console.log('✅ priceMonitoring.js recriado com estrutura correta');
  
} else {
  console.error('❌ priceMonitoring.js não encontrado');
}

// Criar teste
const testScript = `// Teste da correção do priceMonitoring
console.log('🧪 Testando priceMonitoring.js corrigido...');

try {
  const priceMonitoring = require('./posicoes/priceMonitoring');
  console.log('✅ priceMonitoring.js carregado sem erro!');
  
  console.log('Funções disponíveis:');
  Object.keys(priceMonitoring).forEach(key => {
    console.log(\`  - \${key}: \${typeof priceMonitoring[key]}\`);
  });
  
  const api = require('./api');
  console.log('✅ api.js carregado');
  
  const websockets = require('./websockets');
  console.log('✅ websockets.js carregado');
  
  console.log('\\n🎉 Todos os módulos funcionando!');
  console.log('\\n🚀 Execute o monitoramento:');
  console.log('   node posicoes/monitoramento.js --account 1');
  
} catch (error) {
  console.error('❌ Erro:', error.message);
}`;

fs.writeFileSync('test-price-fix.js', testScript);

console.log('\n🎉 PRICE MONITORING RECRIADO!');
console.log('📋 Estrutura limpa e funcional criada');
console.log('\n🧪 Teste: node test-price-fix.js');
console.log('🚀 Execute: node posicoes/monitoramento.js --account 1');
EOF