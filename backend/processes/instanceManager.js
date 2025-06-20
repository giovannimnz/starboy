const { getDatabaseInstance } = require('../core/database/conexao');
const { spawn } = require('child_process');
const path = require('path');

// Mapear contas ativas para seus processos
const activeInstances = new Map();

/**
 * Inicia todas as instâncias ativas em processos separados
 */
async function startAllInstances() {
  try {
    const db = await getDatabaseInstance();
    
    // Buscar todas as contas ativas
    const [accounts] = await db.query('SELECT id, nome FROM contas WHERE ativa = 1');
    
    console.log(`[MANAGER] Iniciando ${accounts.length} instâncias de contas em processos separados...`);
    
    let successCount = 0;
    // Iniciar cada instância em processo separado
    for (const account of accounts) {
      const success = await startInstance(account.id);
      if (success) successCount++;
    }
    
    console.log(`[MANAGER] ${successCount}/${accounts.length} instâncias iniciadas com sucesso`);
    return successCount;
    
  } catch (error) {
    console.error('[MANAGER] Erro ao iniciar instâncias:', error);
    return 0;
  }
}

/**
 * Inicia uma instância específica em processo separado
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
    const [accounts] = await db.query('SELECT nome FROM contas WHERE id = ? AND ativa = 1', [accountId]);
    
    if (!accounts || accounts.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }
    
    console.log(`[MANAGER] Iniciando processo separado para conta ${accountId} (${accounts[0].nome})...`);
    
    // Criar processo separado para esta conta
    const monitorProcess = spawn('node', [
      path.join(__dirname, 'posicoes', 'monitoramento.js'), 
      '--account', 
      accountId.toString()
    ], {
      detached: false,  // Manter ligado ao processo pai para controle
      stdio: ['pipe', 'pipe', 'pipe'], // Capturar stdout/stderr
      env: { ...process.env, ACCOUNT_ID: accountId.toString() }
    });
    
    // Registrar instância ativa
    activeInstances.set(accountId, {
      process: monitorProcess,
      startTime: new Date(),
      accountName: accounts[0].nome,
      accountId: accountId
    });
    
    // Configurar handlers para o processo
    monitorProcess.stdout.on('data', (data) => {
      console.log(`[CONTA-${accountId}] ${data.toString().trim()}`);
    });
    
    monitorProcess.stderr.on('data', (data) => {
      console.error(`[CONTA-${accountId}] ERRO: ${data.toString().trim()}`);
    });
    
    monitorProcess.on('error', (err) => {
      console.error(`[MANAGER] Erro no processo da conta ${accountId}:`, err.message);
      activeInstances.delete(accountId);
    });
    
    monitorProcess.on('exit', (code, signal) => {
      console.log(`[MANAGER] Processo da conta ${accountId} encerrado (Código: ${code}, Sinal: ${signal || 'nenhum'})`);
      activeInstances.delete(accountId);
    });
    
    // Aguardar um momento para verificar se o processo iniciou corretamente
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    if (monitorProcess.killed) {
      throw new Error(`Processo para conta ${accountId} foi encerrado prematuramente`);
    }
    
    console.log(`[MANAGER] Processo para conta ${accountId} iniciado com sucesso (PID: ${monitorProcess.pid})`);
    return true;
    
  } catch (error) {
    console.error(`[MANAGER] Erro ao iniciar instância para conta ${accountId}:`, error);
    // Limpar instância se houve erro
    if (activeInstances.has(accountId)) {
      activeInstances.delete(accountId);
    }
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
    
    console.log(`[MANAGER] Parando processo da conta ${accountId} (${instance.accountName}, PID: ${instance.process.pid})...`);
    
    // Enviar sinal SIGTERM para encerramento gracioso
    const killed = instance.process.kill('SIGTERM');
    
    if (killed) {
      // Aguardar um momento para o processo encerrar
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Se ainda estiver rodando, forçar encerramento
      if (!instance.process.killed) {
        console.log(`[MANAGER] Forçando encerramento do processo da conta ${accountId}...`);
        instance.process.kill('SIGKILL');
      }
      
      activeInstances.delete(accountId);
      console.log(`[MANAGER] Processo da conta ${accountId} parado com sucesso`);
      return true;
    } else {
      console.error(`[MANAGER] Falha ao enviar sinal para o processo da conta ${accountId}`);
      return false;
    }
    
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
      const stopped = await stopInstance(accountId);
      if (!stopped) {
        console.error(`[MANAGER] Não foi possível parar a conta ${accountId} para reinício`);
        return false;
      }
      
      // Aguardar um momento para o processo encerrar completamente
      await new Promise(resolve => setTimeout(resolve, 2000));
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
    const uptimeMs = Date.now() - instance.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    
    instances.push({
      accountId,
      name: instance.accountName,
      pid: instance.process.pid,
      startTime: instance.startTime,
      uptimeSeconds: uptimeSeconds,
      uptimeFormatted: formatUptime(uptimeSeconds),
      isRunning: !instance.process.killed
    });
  }
  
  return instances;
}

/**
 * Formata o tempo de atividade em formato legível
 * @param {number} seconds - Tempo em segundos
 * @returns {string} - Tempo formatado
 */
function formatUptime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
}

/**
 * Para todas as instâncias ativas
 * @returns {Promise<number>} - Número de instâncias paradas
 */
async function stopAllInstances() {
  const instanceIds = [...activeInstances.keys()];
  console.log(`[MANAGER] Parando ${instanceIds.length} instâncias ativas...`);
  
  let stoppedCount = 0;
  for (const accountId of instanceIds) {
    const stopped = await stopInstance(accountId);
    if (stopped) stoppedCount++;
  }
  
  console.log(`[MANAGER] ${stoppedCount}/${instanceIds.length} instâncias paradas`);
  return stoppedCount;
}

/**
 * Verifica se uma instância está rodando
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se estiver rodando
 */
function isInstanceRunning(accountId) {
  if (!activeInstances.has(accountId)) return false;
  
  const instance = activeInstances.get(accountId);
  return !instance.process.killed;
}

/**
 * Obtém estatísticas das instâncias
 * @returns {Object} - Estatísticas das instâncias
 */
function getInstanceStats() {
  const total = activeInstances.size;
  const running = [...activeInstances.values()].filter(inst => !inst.process.killed).length;
  
  return {
    total,
    running,
    stopped: total - running
  };
}

module.exports = {
  startAllInstances,
  startInstance,
  stopInstance,
  stopAllInstances,
  restartInstance,
  listActiveInstances,
  isInstanceRunning,
  getInstanceStats,
  activeInstances
};