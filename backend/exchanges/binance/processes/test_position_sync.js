/**
 * Teste específico para verificar se a sincronização de posições está funcionando
 * após as correções dos erros de dbPositions e triggers.
 */
const path = require('path');
const { syncPositionsWithExchange } = require('../services/positionSync');
const { loadCredentialsFromDatabase } = require('../api/rest');

async function testPositionSync() {
    console.log('🔄 === TESTE DE SINCRONIZAÇÃO DE POSIÇÕES ===');
    console.log('📊 Testando conta ID: 5');
    
    try {
        // Carregar credenciais primeiro
        console.log('🔑 Carregando credenciais...');
        await loadCredentialsFromDatabase(5);
        console.log('✅ Credenciais carregadas com sucesso');
        
        // Testar sincronização de posições
        console.log('🔄 Iniciando sincronização...');
        const result = await syncPositionsWithExchange(5);
        
        console.log('✅ Sincronização executada com sucesso!');
        console.log('📊 Resultado:', JSON.stringify(result, null, 2));
        
        // Verificar se o resultado tem as propriedades esperadas
        const expectedProps = ['exchangePositions', 'dbPositions', 'missingInDb', 'missingInExchange', 'updated', 'errors'];
        const missing = expectedProps.filter(prop => !(prop in result));
        
        if (missing.length > 0) {
            console.log('⚠️ Propriedades faltando no resultado:', missing);
        } else {
            console.log('✅ Todas as propriedades estão presentes no resultado');
        }
        
        // Verificar se houve erros
        if (result.errors && result.errors.length > 0) {
            console.log('❌ Erros encontrados durante sincronização:');
            result.errors.forEach((error, index) => {
                console.log(`   ${index + 1}. ${error}`);
            });
        } else {
            console.log('✅ Nenhum erro encontrado durante sincronização');
        }
        
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Erro durante teste de sincronização:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Executar teste
testPositionSync();
