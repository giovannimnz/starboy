// Script de teste para verificar se os logs do reverse.js estão funcionando
const path = require('path');
const { reverseLog, reverseError, reverseWarn, priceWSLog } = require('./backend/exchanges/binance/strategies/reverse.js');

console.log('=== TESTE DE LOGS DO REVERSE.JS ===');

// Teste de log normal (deve aparecer)
console.log('\n1. Teste de reverseLog (DEVE APARECER):');
reverseLog('[TESTE] Este é um log normal do reverse.js');

// Teste de log de erro (deve aparecer)
console.log('\n2. Teste de reverseError (DEVE APARECER):');
reverseError('[TESTE] Este é um erro do reverse.js');

// Teste de log de warning (deve aparecer)
console.log('\n3. Teste de reverseWarn (DEVE APARECER):');
reverseWarn('[TESTE] Este é um warning do reverse.js');

// Teste de log de preço (NÃO deve aparecer)
console.log('\n4. Teste de priceWSLog (NÃO DEVE APARECER):');
priceWSLog('[TESTE] Este é um log de preço do WebSocket (suprimido)');

console.log('\n=== TESTE CONCLUÍDO ===');
console.log('Se você viu apenas os logs 1, 2 e 3, o sistema está funcionando corretamente!');
