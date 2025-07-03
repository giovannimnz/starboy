// ===============================================
// STARBOY INSTANCE MANAGER
// Gerencia múltiplas instâncias de monitoramento em processos separados
// Cada conta roda em seu próprio processo Node.js independente
// ===============================================

const { getDatabaseInstance } = require('../../../core/database/conexao');
const { spawn } = require('child_process');
const path = require('path');

// Mapa global para controlar todas as instâncias ativas
const activeInstances = new Map();

/**
 * Inicia todas as instâncias ativas em processos separados
 * @returns {Promise<number>} - Número de instâncias iniciadas com sucesso
 */
async function startAllInstances() {
  try {
    console.log('[INSTANCE-MANAGER] 🚀 Iniciando todas as instâncias...');
    
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome FROM contas WHERE ativa = 1');
    
    if (accounts.length === 0) {
      console.log('[INSTANCE-MANAGER] ⚠️ Nenhuma conta ativa encontrada.');
      return 0;
    }
    
    console.log(`[INSTANCE-MANAGER] 📋 Encontradas ${accounts.length} contas ativas`);
    
    let successCount = 0;
    
    // Iniciar cada conta em processo separado (paralelismo)
    const promises = accounts.map(async (account) => {
      try {
        const success = await startInstance(account.id);
        if (success) successCount++;
        return success;
      } catch (error) {
        console.error(`[INSTANCE-MANAGER] ❌ Erro ao iniciar conta ${account.id}:`, error.message);
        return false;
      }
    });
    
    // Aguardar todas as inicializações
    await Promise.all(promises);
    
    console.log(`[INSTANCE-MANAGER] ✅ ${successCount}/${accounts.length} instâncias iniciadas com sucesso`);
    return successCount;
    
  } catch (error) {
    console.error('[INSTANCE-MANAGER] ❌ Erro fatal ao iniciar instâncias:', error);
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
    // Verificar se já está rodando
    if (activeInstances.has(accountId)) {
      const instance = activeInstances.get(accountId);
      if (!instance.process.killed) {
        console.log(`[INSTANCE-MANAGER] ⚠️ Conta ${accountId} já está ativa (PID: ${instance.process.pid})`);
        return true;
      } else {
        // Remover instância morta
        activeInstances.delete(accountId);
      }
    }
    
    // Validar conta no banco
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT nome FROM contas WHERE id = ? AND ativa = 1', [accountId]);
    
    if (!accounts || accounts.length === 0) {
      console.error(`[INSTANCE-MANAGER] ❌ Conta ID ${accountId} não encontrada ou inativa`);
      return false;
    }
    
    const accountName = accounts[0].nome;
    console.log(`[INSTANCE-MANAGER] 🚀 Iniciando processo para conta ${accountId} (${accountName})...`);
    
    // Criar processo separado para orchMonitor
    const monitoringScript = path.join(__dirname, '..', 'monitoring', 'orchMonitor.js');
    
    console.log(`[INSTANCE-MANAGER] 📁 Script: ${monitoringScript}`);
    
    const monitorProcess = spawn('node', [
      monitoringScript,
      '--account', 
      accountId.toString()
    ], {
      detached: false,  // Manter ligado ao processo pai
      stdio: ['pipe', 'pipe', 'pipe'], // Capturar all I/O
      env: { 
        ...process.env, 
        ACCOUNT_ID: accountId.toString(),
        NODE_ENV: process.env.NODE_ENV || 'production'
      },
      cwd: path.join(__dirname, '..', '..')  // Working directory na raiz do backend
    });
    
    // Registrar instância no mapa global
    const instanceData = {
      process: monitorProcess,
      startTime: new Date(),
      accountName: accountName,
      accountId: accountId,
      restartCount: 0
    };
    
    activeInstances.set(accountId, instanceData);
    
    // ===== CONFIGURAR HANDLERS DO PROCESSO =====
    
    // Capturar saída padrão
    monitorProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[CONTA-${accountId}] ${output}`);
      }
    });
    
    // Capturar erros
    monitorProcess.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (error) {
        console.error(`[CONTA-${accountId}] ❌ ${error}`);
      }
    });
    
    // Handler para erros do processo
    monitorProcess.on('error', (err) => {
      console.error(`[INSTANCE-MANAGER] ❌ Erro no processo da conta ${accountId}:`, err.message);
      activeInstances.delete(accountId);
    });
    
    // Handler para encerramento do processo
    monitorProcess.on('exit', (code, signal) => {
      const instance = activeInstances.get(accountId);
      if (instance) {
        const uptime = Math.floor((Date.now() - instance.startTime) / 1000);
        console.log(`[INSTANCE-MANAGER] 📤 Processo da conta ${accountId} encerrado:`);
        console.log(`  - Código de saída: ${code}`);
        console.log(`  - Sinal: ${signal || 'nenhum'}`);
        console.log(`  - Tempo ativo: ${uptime}s`);
        
        // Decidir se deve reiniciar automaticamente
        if (code !== 0 && uptime > 30) {  // Só reinicia se rodou por mais de 30 segundos
          console.log(`[INSTANCE-MANAGER] 🔄 Reiniciando conta ${accountId} automaticamente...`);
          instance.restartCount++;
          
          if (instance.restartCount <= 3) {  // Máximo 3 tentativas
            setTimeout(() => {
              startInstance(accountId).catch(err => {
                console.error(`[INSTANCE-MANAGER] ❌ Falha no restart automático da conta ${accountId}:`, err.message);
              });
            }, 5000);  // Aguardar 5 segundos antes de reiniciar
          } else {
            console.log(`[INSTANCE-MANAGER] ⚠️ Conta ${accountId} excedeu limite de restarts (${instance.restartCount})`);
          }
        } else if (uptime <= 5) {
          console.log(`[INSTANCE-MANAGER] ⚠️ Processo da conta ${accountId} terminou muito rápido (${uptime}s) - não reiniciando`);
        } else {
          console.log(`[INSTANCE-MANAGER] ✅ Encerramento normal da conta ${accountId} - não reiniciando`);
        }
        
        activeInstances.delete(accountId);
      }
    });
    
    // ===== VERIFICAR SE INICIOU CORRETAMENTE =====
    
    // Aguardar inicialização
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Verificar se ainda está rodando
    if (monitorProcess.killed || monitorProcess.exitCode !== null) {
      console.error(`[INSTANCE-MANAGER] ❌ Processo da conta ${accountId} falhou na inicialização`);
      activeInstances.delete(accountId);
      return false;
    }
    
    console.log(`[INSTANCE-MANAGER] ✅ Conta ${accountId} (${accountName}) iniciada com sucesso!`);
    console.log(`  - PID: ${monitorProcess.pid}`);
    console.log(`  - Comando: node ${monitoringScript} --account ${accountId}`);
    
    return true;
    
  } catch (error) {
    console.error(`[INSTANCE-MANAGER] ❌ Erro fatal ao iniciar conta ${accountId}:`, error.message);
    
    // Limpar instância em caso de erro
    if (activeInstances.has(accountId)) {
      activeInstances.delete(accountId);
    }
    
    return false;
  }
}

/**
 * Para uma instância específica
 * @param {number} accountId - ID da conta a ser parada
 * @returns {Promise<boolean>} - true se parada com sucesso
 */
async function stopInstance(accountId) {
  try {
    if (!activeInstances.has(accountId)) {
      console.log(`[INSTANCE-MANAGER] ⚠️ Conta ${accountId} não está ativa`);
      return false;
    }
    
    const instance = activeInstances.get(accountId);
    const { process: proc, accountName } = instance;
    
    if (proc.killed) {
      console.log(`[INSTANCE-MANAGER] ⚠️ Processo da conta ${accountId} já estava morto`);
      activeInstances.delete(accountId);
      return true;
    }
    
    console.log(`[INSTANCE-MANAGER] 🛑 Parando conta ${accountId} (${accountName}, PID: ${proc.pid})...`);
    
    // Tentar encerramento gracioso primeiro
    const killed = proc.kill('SIGTERM');
    
    if (killed) {
      // Aguardar encerramento gracioso
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Se ainda estiver rodando, forçar encerramento
      if (!proc.killed) {
        console.log(`[INSTANCE-MANAGER] ⚡ Forçando encerramento da conta ${accountId}...`);
        proc.kill('SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      activeInstances.delete(accountId);
      console.log(`[INSTANCE-MANAGER] ✅ Conta ${accountId} parada com sucesso`);
      return true;
      
    } else {
      console.error(`[INSTANCE-MANAGER] ❌ Falha ao enviar sinal para conta ${accountId}`);
      return false;
    }
    
  } catch (error) {
    console.error(`[INSTANCE-MANAGER] ❌ Erro ao parar conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Reinicia uma instância específica
 * @param {number} accountId - ID da conta a ser reiniciada
 * @returns {Promise<boolean>} - true se reiniciada com sucesso
 */
async function restartInstance(accountId) {
  try {
    console.log(`[INSTANCE-MANAGER] 🔄 Reiniciando conta ${accountId}...`);
    
    // Parar se estiver rodando
    if (activeInstances.has(accountId)) {
      const stopped = await stopInstance(accountId);
      if (!stopped) {
        console.error(`[INSTANCE-MANAGER] ❌ Não foi possível parar conta ${accountId} para reinício`);
        return false;
      }
      
      // Aguardar encerramento completo
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    // Iniciar novamente
    return await startInstance(accountId);
    
  } catch (error) {
    console.error(`[INSTANCE-MANAGER] ❌ Erro ao reiniciar conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Lista todas as instâncias ativas
 * @returns {Array} - Lista de instâncias com informações detalhadas
 */
function listActiveInstances() {
  const instances = [];
  
  for (const [accountId, instance] of activeInstances.entries()) {
    const now = Date.now();
    const uptimeMs = now - instance.startTime.getTime();
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    
    instances.push({
      accountId: accountId,
      name: instance.accountName,
      pid: instance.process.pid,
      startTime: instance.startTime,
      uptimeMs: uptimeMs,
      uptimeSeconds: uptimeSeconds,
      uptimeFormatted: formatUptime(uptimeSeconds),
      isRunning: !instance.process.killed && instance.process.exitCode === null,
      restartCount: instance.restartCount || 0
    });
  }
  
  return instances.sort((a, b) => a.accountId - b.accountId);
}

/**
 * Para todas as instâncias ativas
 * @returns {Promise<number>} - Número de instâncias paradas
 */
async function stopAllInstances() {
  const instanceIds = [...activeInstances.keys()];
  
  if (instanceIds.length === 0) {
    console.log('[INSTANCE-MANAGER] ℹ️ Nenhuma instância ativa para parar');
    return 0;
  }
  
  console.log(`[INSTANCE-MANAGER] 🛑 Parando ${instanceIds.length} instância(s)...`);
  
  // Parar todas em paralelo
  const promises = instanceIds.map(accountId => stopInstance(accountId));
  const results = await Promise.all(promises);
  
  const stoppedCount = results.filter(Boolean).length;
  console.log(`[INSTANCE-MANAGER] ✅ ${stoppedCount}/${instanceIds.length} instância(s) parada(s)`);
  
  return stoppedCount;
}

/**
 * Verifica se uma instância está rodando
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se estiver rodando
 */
function isInstanceRunning(accountId) {
  if (!activeInstances.has(accountId)) {
    return false;
  }
  
  const instance = activeInstances.get(accountId);
  return !instance.process.killed && instance.process.exitCode === null;
}

/**
 * Obtém estatísticas das instâncias
 * @returns {Object} - Estatísticas detalhadas
 */
function getInstanceStats() {
  const total = activeInstances.size;
  const instances = listActiveInstances();
  const running = instances.filter(inst => inst.isRunning).length;
  const stopped = total - running;
  
  const uptimes = instances.map(inst => inst.uptimeSeconds);
  const avgUptime = uptimes.length > 0 ? Math.floor(uptimes.reduce((a, b) => a + b, 0) / uptimes.length) : 0;
  
  return {
    total,
    running,
    stopped,
    averageUptimeSeconds: avgUptime,
    averageUptimeFormatted: formatUptime(avgUptime),
    instances: instances
  };
}

/**
 * Formata tempo em formato legível
 * @param {number} seconds - Tempo em segundos
 * @returns {string} - Tempo formatado
 */
function formatUptime(seconds) {
  if (seconds < 60) {
    return `${seconds}s`;
  }
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  
  if (minutes < 60) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  
  if (hours < 24) {
    return `${hours}h ${remainingMinutes}m ${remainingSeconds}s`;
  }
  
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  
  return `${days}d ${remainingHours}h ${remainingMinutes}m`;
}

// ===== EXPORTAR TODAS AS FUNÇÕES =====
module.exports = {
  startAllInstances,
  startInstance,
  stopInstance,
  stopAllInstances,
  restartInstance,
  listActiveInstances,
  isInstanceRunning,
  getInstanceStats,
  formatUptime,
  
  // Para debugging (não usar em produção)
  _getActiveInstancesMap: () => activeInstances
};