const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, './.env') });
const { forceProcessPendingSignals } = require('./posicoes/monitoramento');
const { getDatabaseInstance } = require('./db/conexao');

async function main() {
  try {
    console.log('[PROCESSOR] Iniciando processamento forçado de sinais pendentes...');
    
    // Processar para conta ID 1
    await forceProcessPendingSignals(1);
    
    console.log('[PROCESSOR] Processamento concluído!');
    process.exit(0);
  } catch (error) {
    console.error('[PROCESSOR] Erro durante o processamento:', error);
    process.exit(1);
  }
}

main();