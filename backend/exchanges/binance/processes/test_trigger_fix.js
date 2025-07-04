/**
 * Script simples para testar a correção de triggers
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function testTriggerFix() {
    console.log('🧪 === TESTE DE CORREÇÃO DE TRIGGERS ===');
    
    try {
        const db = await getDatabaseInstance();
        console.log('✅ Conectado ao banco de dados');
        
        // Testar update na tabela contas
        console.log('📊 Testando update na tabela contas...');
        const result = await db.query('UPDATE contas SET saldo_spot = COALESCE(saldo_spot, 0) + 0.01 WHERE id = 5 RETURNING id, saldo_spot');
        
        if (result.rows.length > 0) {
            console.log('✅ Update executado com sucesso!');
            console.log('📋 Conta atualizada:', result.rows[0]);
        } else {
            console.log('⚠️ Nenhuma conta encontrada com ID 5');
        }
        
        console.log('🎉 Teste concluído com sucesso!');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erro durante teste:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

testTriggerFix();
