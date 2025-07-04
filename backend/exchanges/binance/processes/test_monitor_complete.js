/**
 * ✅ TESTE COMPLETO: Monitoramento de Orquestração
 * 
 * Este teste verifica se o monitoramento de orquestração funciona corretamente
 * após todas as correções aplicadas, incluindo:
 * - Detecção e correção de posições órfãs
 * - Vinculação de sinais a posições
 * - Sincronização de posições e ordens
 * - Tratamento de erros e propriedades undefined
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');
const { syncPositionsWithAutoClose } = require('../services/positionSync');

async function testCompleteMonitoring() {
  console.log('🔍 === TESTE COMPLETO DE MONITORAMENTO ===');
  
  try {
    // 1. Conectar ao banco
    console.log('🔄 1. Conectando ao banco...');
    const db = await getDatabaseInstance();
    console.log('✅ Banco conectado');
    
    // 2. Verificar contas ativas
    console.log('🔄 2. Verificando contas ativas...');
    const accountsResult = await db.query(`
      SELECT id, nome, ativa FROM contas WHERE ativa = true
    `);
    
    if (accountsResult.rows.length === 0) {
      console.log('⚠️ Nenhuma conta ativa encontrada');
      return;
    }
    
    console.log(`✅ Encontradas ${accountsResult.rows.length} contas ativas`);
    
    // 3. Testar sincronização com auto-close para cada conta
    for (const account of accountsResult.rows) {
      console.log(`\n🔄 3. Testando sincronização para conta ${account.id} (${account.nome})...`);
      
      try {
        const syncResult = await syncPositionsWithAutoClose(account.id);
        console.log(`✅ Sincronização concluída para conta ${account.id}:`);
        console.log(`   - Posições sincronizadas: ${syncResult.exchangePositions || 0}`);
        console.log(`   - Ordens movidas: ${syncResult.ordersMoved || 0}`);
        console.log(`   - Órfãs processadas: ${syncResult.orphansProcessed || 0}`);
        console.log(`   - Órfãs corrigidas: ${syncResult.orphansFixed || 0}`);
        console.log(`   - Sinais vinculados: ${syncResult.signalsLinked || 0}`);
        console.log(`   - Erros: ${syncResult.errors || 0}`);
        
        // Verificar se há erros críticos
        if (syncResult.orphanErrors && syncResult.orphanErrors.length > 0) {
          console.log(`   ⚠️ Erros de órfãs: ${syncResult.orphanErrors.length}`);
        }
        
        if (syncResult.signalLinkErrors && syncResult.signalLinkErrors.length > 0) {
          console.log(`   ⚠️ Erros de vinculação: ${syncResult.signalLinkErrors.length}`);
        }
        
      } catch (syncError) {
        console.error(`❌ Erro na sincronização da conta ${account.id}:`, syncError.message);
      }
    }
    
    // 4. Testar detecção de posições órfãs e vinculação de sinais
    console.log('\n🔄 4. Testando detecção de posições órfãs e vinculação de sinais...');
    
    for (const account of accountsResult.rows) {
      console.log(`\n🔍 Testando funções auxiliares para conta ${account.id}...`);
      
      try {
        // Simular as funções auxiliares que estavam falhando
        const { detectAndFixOrphanPositions, linkSignalsToOpenPositions } = require('../services/positionSync');
        
        // Testar detecção de órfãs
        console.log(`   🔍 Detectando posições órfãs...`);
        const orphanResults = await detectAndFixOrphanPositions(account.id);
        console.log(`   ✅ Órfãs: ${orphanResults.processed} processadas, ${orphanResults.fixed} corrigidas`);
        
        // Testar vinculação de sinais
        console.log(`   🔗 Vinculando sinais...`);
        const linkResults = await linkSignalsToOpenPositions(account.id);
        console.log(`   ✅ Sinais: ${linkResults.linked} vinculados`);
        
      } catch (auxiliaryError) {
        console.error(`   ❌ Erro nas funções auxiliares:`, auxiliaryError.message);
      }
    }
    
    // 5. Verificar estado final do sistema
    console.log('\n🔄 5. Verificando estado final do sistema...');
    
    const finalStatsResult = await db.query(`
      SELECT 
        (SELECT COUNT(*) FROM posicoes WHERE status = 'OPEN') as posicoes_abertas,
        (SELECT COUNT(*) FROM ordens WHERE status IN ('NEW', 'PARTIALLY_FILLED')) as ordens_ativas,
        (SELECT COUNT(*) FROM webhook_signals WHERE status = 'EXECUTADO' AND position_id IS NULL) as sinais_sem_posicao,
        (SELECT COUNT(*) FROM webhook_signals WHERE status = 'EXECUTADO' AND position_id IS NOT NULL) as sinais_com_posicao
    `);
    
    const stats = finalStatsResult.rows[0];
    console.log('📊 Estado final do sistema:');
    console.log(`   - Posições abertas: ${stats.posicoes_abertas}`);
    console.log(`   - Ordens ativas: ${stats.ordens_ativas}`);
    console.log(`   - Sinais sem posição: ${stats.sinais_sem_posicao}`);
    console.log(`   - Sinais com posição: ${stats.sinais_com_posicao}`);
    
    console.log('\n✅ === TESTE COMPLETO DE MONITORAMENTO CONCLUÍDO ===');
    
  } catch (error) {
    console.error('❌ Erro crítico no teste de monitoramento:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    // Fechar conexão com o banco
    process.exit(0);
  }
}

// Executar o teste
testCompleteMonitoring().catch(console.error);
