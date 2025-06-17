// Teste específico para reproduzir o problema accountId undefined
const websockets = require('../websockets');

// Mock da função para capturar exatamente onde está o problema
const originalSetupBookDepth = websockets.setupBookDepthWebsocket;

let callCount = 0;
websockets.setupBookDepthWebsocket = function(...args) {
  callCount++;
  console.log(`\n🔍 CHAMADA ${callCount} para setupBookDepthWebsocket:`);
  console.log('Argumentos:', args);
  console.log('Tipos:', args.map(arg => typeof arg));
  console.log('Stack trace:');
  console.log(new Error().stack);
  
  if (!args[1] || typeof args[1] !== 'number') {
    console.error('❌ PROBLEMA IDENTIFICADO!');
    console.error(`accountId inválido na chamada ${callCount}: ${args[1]} (tipo: ${typeof args[1]})`);
    
    // Mostrar onde foi chamado
    const stack = new Error().stack.split('\n');
    console.error('Chamado de:');
    stack.slice(1, 5).forEach(line => console.error('  ', line.trim()));
    
    throw new Error(`setupBookDepthWebsocket chamado com accountId inválido: ${args[1]}`);
  } else {
    console.log('✅ Chamada válida');
  }
  
  return originalSetupBookDepth.apply(this, args);
};

console.log('\n🧪 Teste instalado! Agora execute o monitoramento para capturar o erro.');
console.log('Execute: node posicoes/monitoramento.js --account 1');
console.log('\nO teste vai parar exatamente na chamada problemática e mostrar o stack trace completo.');

module.exports = { callCount };