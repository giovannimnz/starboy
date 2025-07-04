// ============================================================================
// EXEMPLO DE USO DA NOVA IMPLEMENTAÇÃO DO REVERSE
// ============================================================================
// Este arquivo demonstra como usar o novo sistema de reverse melhorado
// ============================================================================

const { executeReverse } = require('./test_reverse_improved');

// Exemplo de sinal para teste
const exampleSignal = {
    id: 123,
    symbol: 'BTCUSDT',
    side: 'BUY', // ou 'COMPRA'
    leverage: 10,
    capital_pct: 5, // 5% do saldo
    entry_price: 45000,
    sl_price: 44000,
    tp1_price: 46000,
    tp2_price: 47000,
    tp3_price: 48000,
    tp4_price: 49000,
    tp5_price: 50000
};

const currentPrice = 45000;
const accountId = 1002; // Substitua pelo ID da sua conta

async function exemploDeUso() {
    console.log('🚀 Executando exemplo da nova implementação do reverse...');
    console.log('============================================================');
    
    try {
        const resultado = await executeReverse(exampleSignal, currentPrice, accountId);
        
        if (resultado.success) {
            console.log('✅ Entrada executada com sucesso!');
            console.log('📊 Detalhes:');
            console.log(`   - Position ID: ${resultado.positionId}`);
            console.log(`   - Order ID: ${resultado.entryOrderId}`);
            console.log(`   - Quantidade preenchida: ${resultado.filledQuantity}`);
            console.log(`   - Preço médio: ${resultado.averagePrice}`);
        } else {
            console.log('❌ Falha na execução:');
            console.log(`   - Erro: ${resultado.error}`);
        }
        
    } catch (error) {
        console.error('❌ Erro durante execução:', error.message);
    }
}

// Executar apenas se este arquivo for chamado diretamente
if (require.main === module) {
    exemploDeUso().then(() => {
        console.log('🏁 Exemplo finalizado');
        process.exit(0);
    }).catch(error => {
        console.error('💥 Erro fatal:', error.message);
        process.exit(1);
    });
}

module.exports = {
    exemploDeUso,
    exampleSignal
};
