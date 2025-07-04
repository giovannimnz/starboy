const { getDatabaseInstance } = require('../../../core/database/conexao');
const { moveClosedPositionsToHistory } = require('./positionSync');

/**
 * Script para corrigir posições que estão como CLOSED mas não foram movidas para histórico
 */
async function fixClosedPositions(accountId = 999) {
  try {
    console.log(`[FIX_CLOSED] 🔧 Iniciando correção de posições CLOSED para conta ${accountId}...`);
    
    const db = await getDatabaseInstance();
    
    // Verificar posições CLOSED
    const [closedPositions] = await db.query(`
      SELECT id, simbolo, status, data_hora_fechamento, liquid_pnl
      FROM posicoes 
      WHERE status = 'CLOSED' AND conta_id = $1
    `, [accountId]);
    
    console.log(`[FIX_CLOSED] 📊 Encontradas ${closedPositions.length} posições CLOSED na tabela ativa`);
    
    if (closedPositions.length > 0) {
      // Listar as posições encontradas
      closedPositions.forEach(pos => {
        console.log(`[FIX_CLOSED] 📋 ID: ${pos.id}, Símbolo: ${pos.simbolo}, PnL: ${pos.liquid_pnl || 0}, Fechamento: ${pos.data_hora_fechamento}`);
      });
      
      // Mover para histórico
      const results = await moveClosedPositionsToHistory(accountId);
      
      console.log(`[FIX_CLOSED] ✅ Correção concluída:`);
      console.log(`[FIX_CLOSED]   - Posições movidas: ${results.moved}`);
      console.log(`[FIX_CLOSED]   - Erros: ${results.errors.length}`);
      
      if (results.errors.length > 0) {
        console.log(`[FIX_CLOSED] ❌ Erros encontrados:`);
        results.errors.forEach(error => console.log(`[FIX_CLOSED]   - ${error}`));
      }
    } else {
      console.log(`[FIX_CLOSED] ✅ Nenhuma posição CLOSED encontrada na tabela ativa`);
    }
    
    // Verificar se foram movidas
    const [remainingClosed] = await db.query(`
      SELECT COUNT(*) as count FROM posicoes WHERE status = 'CLOSED' AND conta_id = $1
    `, [accountId]);
    
    console.log(`[FIX_CLOSED] 📊 Posições CLOSED restantes: ${remainingClosed[0].count}`);
    
  } catch (error) {
    console.error(`[FIX_CLOSED] ❌ Erro na correção:`, error.message);
  }
}

// Executar automaticamente se chamado diretamente
if (require.main === module) {
  fixClosedPositions(999).then(() => {
    console.log('[FIX_CLOSED] 🎉 Script finalizado');
    process.exit(0);
  }).catch(error => {
    console.error('[FIX_CLOSED] ❌ Erro crítico:', error.message);
    process.exit(1);
  });
}

module.exports = { fixClosedPositions };
