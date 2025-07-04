/**
 * Teste completo para verificar se todas as correções de positionSync foram aplicadas
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');
const { loadCredentialsFromDatabase } = require('../api/rest');
const { 
  syncPositionsWithExchange, 
  syncOrdersWithExchange, 
  logOpenPositionsAndOrdersVisual,
  moveClosedPositionsToHistory
} = require('../services/positionSync');

async function testAllPositionSyncFixes() {
  console.log('🔧 === TESTE COMPLETO DE CORREÇÕES POSITIONSYNC ===');
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
    
    // 3. Testar syncPositionsWithExchange
    console.log('🔄 3. Testando syncPositionsWithExchange...');
    try {
      const syncResult = await syncPositionsWithExchange(accountId);
      console.log('✅ syncPositionsWithExchange executado com sucesso');
      console.log('📊 Resultado:', {
        exchangePositions: syncResult.exchangePositions,
        dbPositions: syncResult.dbPositions,
        updated: syncResult.updated,
        errors: syncResult.errors.length
      });
    } catch (syncError) {
      console.error('❌ Erro em syncPositionsWithExchange:', syncError.message);
    }
    
    // 4. Testar syncOrdersWithExchange
    console.log('🔄 4. Testando syncOrdersWithExchange...');
    try {
      const orderSyncResult = await syncOrdersWithExchange(accountId);
      console.log('✅ syncOrdersWithExchange executado com sucesso');
      console.log('📊 Resultado:', JSON.stringify(orderSyncResult, null, 2));
    } catch (orderSyncError) {
      console.error('❌ Erro em syncOrdersWithExchange:', orderSyncError.message);
    }
    
    // 5. Testar logOpenPositionsAndOrdersVisual
    console.log('🔍 5. Testando logOpenPositionsAndOrdersVisual...');
    try {
      await logOpenPositionsAndOrdersVisual(accountId);
      console.log('✅ logOpenPositionsAndOrdersVisual executado com sucesso');
    } catch (logError) {
      console.error('❌ Erro em logOpenPositionsAndOrdersVisual:', logError.message);
    }
    
    // 6. Testar moveClosedPositionsToHistory
    console.log('📚 6. Testando moveClosedPositionsToHistory...');
    try {
      const moveResult = await moveClosedPositionsToHistory(accountId);
      console.log('✅ moveClosedPositionsToHistory executado com sucesso');
      console.log('📊 Resultado:', moveResult);
    } catch (moveError) {
      console.error('❌ Erro em moveClosedPositionsToHistory:', moveError.message);
    }
    
    console.log('🎉 === TESTE COMPLETO CONCLUÍDO ===');
    process.exit(0);
    
  } catch (error) {
    console.error('❌ Erro crítico durante teste:', error.message);
    console.error('Stack:', error.stack);
    process.exit(1);
  }
}

// Executar teste
testAllPositionSyncFixes();
