/**
 * Teste específico para syncPositionsWithAutoClose
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');
const { loadCredentialsFromDatabase } = require('../api/rest');
const { syncPositionsWithAutoClose } = require('../services/positionSync');

async function testSyncPositionsWithAutoClose() {
  console.log('🔧 === TESTE ESPECÍFICO: syncPositionsWithAutoClose ===');
  console.log('📊 Testando conta ID: 5');
  
  const accountId = 5;
  
  try {
    // 1. Conectar ao banco
    console.log('📊 1. Conectando ao banco...');
    const db = await getDatabaseInstance();
    console.log('✅ Banco conectado');
    
    // 2. Carregar credenciais
    console.log('🔑 2. Carregando credenciais...');
    await loadCredentialsFromDatabase(accountId);
    console.log('✅ Credenciais carregadas');
    
    // 3. Testar syncPositionsWithAutoClose
    console.log('🔄 3. Testando syncPositionsWithAutoClose...');
    try {
      const syncResult = await syncPositionsWithAutoClose(accountId);
      console.log('✅ syncPositionsWithAutoClose executado com sucesso');
      console.log('📊 Resultado:', {
        checked: syncResult.checked,
        movedToHistory: syncResult.movedToHistory,
        updatedPrices: syncResult.updatedPrices,
        errors: syncResult.errors.length
      });
    } catch (syncError) {
      console.error('❌ Erro em syncPositionsWithAutoClose:', syncError.message);
      console.error('Stack:', syncError.stack);
      process.exit(1);
    }
    
    console.log('🎉 === TESTE CONCLUÍDO COM SUCESSO ===');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erro crítico durante teste:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Executar teste
testSyncPositionsWithAutoClose();
