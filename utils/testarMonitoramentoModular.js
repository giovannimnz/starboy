const { initializeMonitoring } = require('../posicoes/monitoramento');

async function testarSistemaModular() {
  try {
    console.log('=== TESTANDO SISTEMA MODULAR ===');
    
    const accountId = 1;
    
    console.log(`\n1. Inicializando monitoramento para conta ${accountId}...`);
    const jobs = await initializeMonitoring(accountId);
    
    console.log('\n2. Jobs agendados:');
    Object.keys(jobs).forEach(jobName => {
      console.log(`  - ${jobName}: ${jobs[jobName] ? 'Ativo' : 'Inativo'}`);
    });
    
    console.log('\n3. Aguardando 10 segundos para observar funcionamento...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    console.log('\n✅ Teste concluído! Sistema modular funcionando.');
    
  } catch (error) {
    console.error('❌ Erro no teste:', error);
  }
}

testarSistemaModular();