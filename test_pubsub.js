/**
 * Script de teste para validar a implementação do Pub/Sub nos WebSockets
 */

const websockets = require('./backend/exchanges/binance/api/websocket');

console.log('🧪 TESTE DO SISTEMA PUB/SUB WEBSOCKET');
console.log('=====================================\n');

// Simular dados de teste
const testAccountId = 1;
const testMessage = {
    e: 'ACCOUNT_UPDATE',
    E: Date.now(),
    T: Date.now(),
    a: {
        m: 'ORDER',
        B: [
            { a: 'USDT', wb: '1000.0', cw: '950.0' }
        ],
        P: [
            { s: 'BTCUSDT', pa: '0.001', ep: '50000.0' }
        ]
    }
};

console.log('1. Testando sistema de eventos...');

// Teste 1: Registrar listener simples
console.log('📋 Registrando listener de teste...');
websockets.on('testEvent', (data) => {
    console.log('✅ Evento testEvent recebido:', data);
}, testAccountId, 'testListener');

// Teste 2: Emitir evento
console.log('📤 Emitindo evento de teste...');
websockets.emit('testEvent', testAccountId, { message: 'Teste funcionando!' });

// Teste 3: Testar evento accountUpdate
console.log('\n2. Testando evento accountUpdate...');
websockets.on('accountUpdate', (jsonData) => {
    console.log('✅ AccountUpdate recebido para conta', testAccountId);
    console.log('   - Event type:', jsonData.e);
    console.log('   - Balances:', jsonData.a?.B?.length || 0);
    console.log('   - Positions:', jsonData.a?.P?.length || 0);
}, testAccountId, 'testAccountListener');

// Emitir evento accountUpdate
console.log('📤 Emitindo evento accountUpdate...');
websockets.emit('accountUpdate', testAccountId, testMessage);

// Teste 4: Testar evento orderUpdate
console.log('\n3. Testando evento orderUpdate...');
websockets.on('orderUpdate', (orderData) => {
    console.log('✅ OrderUpdate recebido para conta', testAccountId);
    console.log('   - Order ID:', orderData.o?.i || orderData.i);
    console.log('   - Symbol:', orderData.o?.s || orderData.s);
    console.log('   - Status:', orderData.o?.X || orderData.X);
}, testAccountId, 'testOrderListener');

const testOrder = {
    e: 'ORDER_TRADE_UPDATE',
    o: {
        i: '12345',
        s: 'BTCUSDT',
        X: 'FILLED',
        x: 'TRADE'
    }
};

console.log('📤 Emitindo evento orderUpdate...');
websockets.emit('orderUpdate', testAccountId, testOrder);

// Teste 5: Testar priceUpdate
console.log('\n4. Testando evento priceUpdate...');
websockets.on('priceUpdate', (symbol, tickerData) => {
    console.log('✅ PriceUpdate recebido para conta', testAccountId);
    console.log('   - Symbol:', symbol);
    console.log('   - Price:', tickerData.c || tickerData.currentPrice);
}, testAccountId, 'testPriceListener');

console.log('📤 Emitindo evento priceUpdate...');
websockets.emit('priceUpdate', testAccountId, 'BTCUSDT', { c: '50000.0', currentPrice: 50000 });

// Teste 6: Remover listener
console.log('\n5. Testando remoção de listener...');
websockets.off('testEvent', 'testListener', testAccountId);
console.log('📤 Tentando emitir evento após remoção...');
websockets.emit('testEvent', testAccountId, { message: 'Este evento não deve ser recebido' });

setTimeout(() => {
    console.log('\n✅ Testes do sistema Pub/Sub concluídos!');
    console.log('Se você viu os eventos sendo recebidos, o sistema está funcionando corretamente.');
}, 1000);
