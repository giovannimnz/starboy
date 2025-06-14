const { getDatabaseInstance } = require('./db/conexao');
const monitoramento = require('./posicoes/monitoramento');

// Mapear contas ativas para seus jobs e recursos
const activeInstances = new Map();

/**
 * Inicia todas as instâncias ativas
 */
async function startAllInstances() {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar todas as contas ativas
    const [accounts] = await db.query('SELECT id, nome FROM contas WHERE ativa = 1');
    
    console.log(`[MANAGER] Iniciando ${accounts.length} instâncias de contas...`);
    
    // Iniciar cada instância
    for (const account of accounts) {
      await startInstance(account.id);
    }
    
    console.log('[MANAGER] Todas as instâncias iniciadas com sucesso');
    
  } catch (error) {
    console.error('[MANAGER] Erro ao iniciar instâncias:', error);
  }
}

/**
 * Inicia uma instância específica
 * @param {number} accountId - ID da conta a ser iniciada
 * @returns {Promise<boolean>} - true se iniciado com sucesso, false caso contrário
 */
async function startInstance(accountId) {
  try {
    if (activeInstances.has(accountId)) {
      console.log(`[MANAGER] Instância para conta ${accountId} já está ativa`);
      return true;
    }
    
    const db = await getDatabaseInstance(accountId);
    const [accounts] = await db.query('SELECT nome FROM contas WHERE id = ?', [accountId]);
    
    if (!accounts || accounts.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada`);
    }
    
    console.log(`[MANAGER] Iniciando instância para conta ${accountId} (${accounts[0].nome})...`);
    
    // Iniciar monitoramento para esta conta
    const jobs = await monitoramento.initializeMonitoring(accountId);
    
    // Registrar instância ativa
    activeInstances.set(accountId, {
      startTime: new Date(),
      accountName: accounts[0].nome,
      jobs
    });
    
    console.log(`[MANAGER] Instância para conta ${accountId} iniciada com sucesso`);
    return true;
  } catch (error) {
    console.error(`[MANAGER] Erro ao iniciar instância para conta ${accountId}:`, error);
    return false;
  }
}

/**
 * Para uma instância específica
 * @param {number} accountId - ID da conta a ser parada
 * @returns {Promise<boolean>} - true se parada com sucesso, false caso contrário
 */
async function stopInstance(accountId) {
  try {
    if (!activeInstances.has(accountId)) {
      console.log(`[MANAGER] Instância para conta ${accountId} não está ativa`);
      return false;
    }
    
    const instance = activeInstances.get(accountId);
    
    console.log(`[MANAGER] Parando instância para conta ${accountId} (${instance.accountName})...`);
    
    // Cancelar todos os jobs agendados
    if (instance.jobs) {
      Object.values(instance.jobs).forEach(job => {
        if (job && typeof job.cancel === 'function') {
          job.cancel();
        }
      });
    }
    
    // Remover do mapa de instâncias ativas
    activeInstances.delete(accountId);
    
    console.log(`[MANAGER] Instância para conta ${accountId} parada com sucesso`);
    return true;
  } catch (error) {
    console.error(`[MANAGER] Erro ao parar instância para conta ${accountId}:`, error);
    return false;
  }
}

/**
 * Reinicia uma instância específica
 * @param {number} accountId - ID da conta a ser reiniciada
 * @returns {Promise<boolean>} - true se reiniciada com sucesso, false caso contrário
 */
async function restartInstance(accountId) {
  try {
    console.log(`[MANAGER] Reiniciando instância para conta ${accountId}...`);
    
    // Parar instância se estiver ativa
    if (activeInstances.has(accountId)) {
      await stopInstance(accountId);
    }
    
    // Iniciar instância novamente
    return await startInstance(accountId);
  } catch (error) {
    console.error(`[MANAGER] Erro ao reiniciar instância para conta ${accountId}:`, error);
    return false;
  }
}

/**
 * Lista todas as instâncias ativas
 * @returns {Array} - Lista de instâncias ativas com informações resumidas
 */
function listActiveInstances() {
  const instances = [];
  
  for (const [accountId, instance] of activeInstances.entries()) {
    instances.push({
      accountId,
      name: instance.accountName,
      startTime: instance.startTime,
      uptime: Math.floor((Date.now() - instance.startTime) / 1000 / 60) // em minutos
    });
  }
  
  return instances;
}

module.exports = {
  startAllInstances,
  startInstance,
  stopInstance,
  restartInstance,
  listActiveInstances,
  activeInstances
};