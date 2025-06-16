const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, './.env') });
const { initializeDatabase, getDatabaseInstance } = require('./db/conexao');
const readline = require('readline');
const { spawn } = require('child_process');
const { initPool, formatDateForMySQL } = require('./db/conexao');

// CORREÇÃO: REMOVER esta linha que causa conflito
// const { gracefulShutdown } = require('./posicoes/monitoramento');

// Mapear contas ativas para seus processos
const activeInstances = new Map();

// Cria interface para leitura de comandos
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Função auxiliar para fazer perguntas
function pergunta(texto) {
  return new Promise((resolve) => {
    rl.question(texto, resolve);
  });
}

/**
 * Formatar tempo de execução
 * @param {number} seconds - Segundos de execução
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
 * Inicializa uma nova instância para uma conta específica
 * @param {number} accountId - ID da conta a inicializar
 * @returns {Promise<boolean>} - true se inicializado com sucesso
 */
async function startInstance(accountId) {
  try {
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId inválido: ${accountId} (tipo: ${typeof accountId})`);
    }

    if (activeInstances.has(accountId)) {
      console.log(`[APP] A conta ${accountId} já está em execução`);
      return true;
    }

    // Verificar se a conta existe e está ativa
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT nome FROM contas WHERE id = ? AND ativa = 1', [accountId]);
    
    if (!accounts || accounts.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }

    console.log(`[APP] Iniciando monitoramento para conta ${accountId} (${accounts[0].nome})...`);
    
    // Iniciar em processo separado passando accountId
    const monitorProcess = spawn('node', [
      'posicoes/monitoramento.js', 
      '--account', 
      accountId.toString()
    ], {
      detached: false, // CORREÇÃO: Não detached para melhor controle
      stdio: ['pipe', 'pipe', 'pipe'] // CORREÇÃO: Capturar stdout/stderr
    });
    
    // NOVO: Capturar e processar logs do processo filho
    monitorProcess.stdout.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.log(`[CONTA-${accountId}] ${output}`);
      }
    });
    
    monitorProcess.stderr.on('data', (data) => {
      const output = data.toString().trim();
      if (output) {
        console.error(`[CONTA-${accountId}] ERRO: ${output}`);
      }
    });
    
    // Registrar o processo
    activeInstances.set(accountId, {
      process: monitorProcess,
      startTime: new Date(),
      accountName: accounts[0].nome,
      accountId: accountId,
      restartCount: 0 // NOVO: Contador de reinicializações
    });
    
    // Configurar handlers para o processo
    monitorProcess.on('error', (err) => {
      console.error(`[APP] ❌ Erro ao iniciar processo para conta ${accountId}:`, err.message);
      activeInstances.delete(accountId);
    });
    
    monitorProcess.on('exit', (code, signal) => {
      const instance = activeInstances.get(accountId);
      
      if (instance) {
        console.log(`[APP] 📊 Processo para conta ${accountId} encerrado:`);
        console.log(`  - Código de saída: ${code}`);
        console.log(`  - Sinal: ${signal || 'nenhum'}`);
        console.log(`  - Tempo ativo: ${formatUptime(Math.floor((Date.now() - instance.startTime.getTime()) / 1000))}`);
        
        // NOVO: Analisar se deve reiniciar automaticamente
        const shouldRestart = analyzeRestartNeed(code, signal, instance);
        
        if (shouldRestart) {
          console.log(`[APP] 🔄 Reinicializando conta ${accountId} automaticamente...`);
          
          // Incrementar contador
          instance.restartCount++;
          
          // Limitar tentativas de restart
          if (instance.restartCount > 3) {
            console.log(`[APP] ⚠️ Muitas tentativas de restart para conta ${accountId} - parando`);
            activeInstances.delete(accountId);
            return;
          }
          
          // Aguardar um pouco antes de reiniciar
          setTimeout(async () => {
            try {
              activeInstances.delete(accountId);
              await startInstance(accountId);
            } catch (restartError) {
              console.error(`[APP] ❌ Falha ao reiniciar conta ${accountId}:`, restartError.message);
            }
          }, 5000); // 5 segundos de delay
          
        } else {
          console.log(`[APP] ✅ Encerramento normal da conta ${accountId} - não reiniciando`);
          activeInstances.delete(accountId);
        }
      }
    });
    
    console.log(`[APP] ✅ Conta ${accountId} (${accounts[0].nome}) iniciada com sucesso!`);
    return true;
    
  } catch (error) {
    console.error(`[APP] ❌ Erro ao iniciar instância para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Interrompe uma instância em execução
 * @param {number} accountId - ID da conta a ser parada
 * @returns {Promise<boolean>} - true se parada com sucesso
 */
async function stopInstance(accountId) {
  try {
    if (!activeInstances.has(accountId)) {
      console.log(`[APP] A conta ${accountId} não está em execução`);
      return true;
    }

    const instance = activeInstances.get(accountId);
    console.log(`[APP] Parando conta ${accountId} (${instance.accountName})...`);
    
    // Enviar SIGTERM para encerramento gracioso
    instance.process.kill('SIGTERM');
    
    // Aguardar um pouco e depois forçar se necessário
    setTimeout(() => {
      if (activeInstances.has(accountId)) {
        console.log(`[APP] Forçando encerramento da conta ${accountId}...`);
        instance.process.kill('SIGKILL');
        activeInstances.delete(accountId);
      }
    }, 5000);
    
    return true;
    
  } catch (error) {
    console.error(`[APP] Erro ao parar instância para conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * NOVA FUNÇÃO: Analisa se o processo deve ser reiniciado
 * @param {number} code - Código de saída
 * @param {string} signal - Sinal de encerramento
 * @param {Object} instance - Instância do processo
 * @returns {boolean} - true se deve reiniciar
 */
function analyzeRestartNeed(code, signal, instance) {
  // Não reiniciar se foi encerramento gracioso (Ctrl+C, SIGTERM)
  if (signal === 'SIGTERM' || signal === 'SIGINT' || signal === 'SIGQUIT') {
    return false;
  }
  
  // Não reiniciar se saiu com código 0 (sucesso)
  if (code === 0) {
    return false;
  }
  
  // Não reiniciar se foi muito rápido (menos de 30 segundos)
  const uptime = Date.now() - instance.startTime.getTime();
  if (uptime < 30000) {
    console.log(`[APP] ⚠️ Processo da conta ${instance.accountId} terminou muito rápido (${Math.floor(uptime/1000)}s) - não reiniciando`);
    return false;
  }
  
  // Não reiniciar se já tentou muitas vezes
  if (instance.restartCount >= 3) {
    return false;
  }
  
  // Reiniciar em outros casos (crashes, erros não tratados, etc.)
  return true;
}

/**
 * Inicia todas as contas ativas do sistema
 * @returns {Promise<number>} - Número de contas iniciadas com sucesso
 */
async function startAllInstances() {
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome FROM contas WHERE ativa = 1');
    
    console.log(`[APP] Iniciando ${accounts.length} conta(s) ativa(s)...`);
    
    let successCount = 0;
    for (const account of accounts) {
      const success = await startInstance(account.id);
      if (success) successCount++;
    }
    
    console.log(`[APP] ${successCount} de ${accounts.length} conta(s) iniciada(s) com sucesso`);
    return successCount;
  } catch (error) {
    console.error('[APP] Erro ao iniciar todas as contas:', error.message);
    return 0;
  }
}

/**
 * Reinicia uma instância específica
 * @param {number} accountId - ID da conta a ser reiniciada
 * @returns {Promise<boolean>} - true se reiniciada com sucesso
 */
async function restartInstance(accountId) {
  try {
    console.log(`[APP] Reiniciando conta ${accountId}...`);
    
    // Parar primeiro
    await stopInstance(accountId);
    
    // Aguardar um pouco
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Iniciar novamente
    return await startInstance(accountId);
    
  } catch (error) {
    console.error(`[APP] Erro ao reiniciar conta ${accountId}:`, error.message);
    return false;
  }
}

/**
 * Lista todas as instâncias em execução
 * @returns {Array<Object>} - Lista de instâncias ativas
 */
function listActiveInstances() {
  const instances = [];
  
  for (const [accountId, instance] of activeInstances.entries()) {
    const uptimeSeconds = Math.floor((Date.now() - instance.startTime.getTime()) / 1000);
    
    instances.push({
      accountId: accountId,
      name: instance.accountName,
      startTime: instance.startTime,
      uptime: uptimeSeconds,
      uptimeFormatted: formatUptime(uptimeSeconds)
    });
  }
  
  return instances;
}

// Menu principal
async function showMenu() {
  console.clear();
  console.log('===== STARBOY MULTI-CONTA =====');
  console.log('1. Iniciar todas as contas');
  console.log('2. Listar contas ativas');
  console.log('3. Iniciar conta específica');
  console.log('4. Parar conta específica');
  console.log('5. Reiniciar conta específica');
  console.log('6. Monitorar logs do sistema');
  console.log('0. Sair');
  
  const escolha = await pergunta('\nEscolha uma opção: ');
  
  switch (escolha) {
    case '1':
      await startAllInstances();
      break;
    case '2':
      await listarContasAtivas();
      break;
    case '3':
      await iniciarContaEspecifica();
      break;
    case '4':
      await pararContaEspecifica();
      break;
    case '5':
      await reiniciarContaEspecifica();
      break;
    case '6':
      await mostrarMonitorLogs();
      break;
    case '0':
      await encerrar();
      return;
    default:
      console.log('Opção inválida!');
      break;
  }
  
  // Aguardar antes de mostrar o menu novamente
  await pergunta('\nPressione Enter para continuar...');
  await showMenu();
}

// Listar contas ativas
async function listarContasAtivas() {
  const instancias = listActiveInstances();
  
  if (instancias.length === 0) {
    console.log('\nNão há contas ativas no momento.');
    return;
  }
  
  console.log('\n=== CONTAS ATIVAS ===');
  instancias.forEach(inst => {
    console.log(`[${inst.accountId}] ${inst.name} - Ativo há ${inst.uptimeFormatted}`);
  });

  // Mostrar também contas disponíveis mas não ativas
  try {
    const db = await getDatabaseInstance();
    const [allAccounts] = await db.query('SELECT id, nome, ativa FROM contas');
    
    const inactiveAccounts = allAccounts.filter(acc => 
      acc.ativa === 1 && !instancias.some(inst => inst.accountId === acc.id));
    
    if (inactiveAccounts.length > 0) {
      console.log('\n=== CONTAS DISPONÍVEIS (NÃO ATIVAS) ===');
      inactiveAccounts.forEach(acc => {
        console.log(`[${acc.id}] ${acc.nome} - Disponível para iniciar`);
      });
    }
  } catch (error) {
    console.error('Erro ao listar contas disponíveis:', error.message);
  }
}

// Iniciar conta específica
async function iniciarContaEspecifica() {
  // Mostrar contas disponíveis primeiro
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = 1');
    
    console.log('\n=== CONTAS DISPONÍVEIS ===');
    accounts.forEach(acc => {
      const status = activeInstances.has(acc.id) ? 'ATIVA' : 'INATIVA';
      console.log(`[${acc.id}] ${acc.nome} - ${status}`);
    });
    
  } catch (error) {
    console.error('Erro ao listar contas disponíveis:', error.message);
  }
  
  const idConta = await pergunta('\nDigite o ID da conta a ser iniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`\nIniciando conta ID ${accountId}...`);
  const resultado = await startInstance(accountId);
  
  if (resultado) {
    console.log(`\nConta ID ${accountId} iniciada com sucesso!`);
  } else {
    console.log(`\nFalha ao iniciar conta ID ${accountId}.`);
  }
}

// Parar conta específica
async function pararContaEspecifica() {
  const instancias = listActiveInstances();
  
  if (instancias.length === 0) {
    console.log('\nNão há contas ativas para parar.');
    return;
  }
  
  console.log('\n=== CONTAS ATIVAS ===');
  instancias.forEach(inst => {
    console.log(`[${inst.accountId}] ${inst.name} - Ativo há ${inst.uptimeFormatted}`);
  });
  
  const idConta = await pergunta('\nDigite o ID da conta a ser parada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`\nParando conta ID ${accountId}...`);
  const resultado = await stopInstance(accountId);
  
  if (resultado) {
    console.log(`\nConta ID ${accountId} parada com sucesso!`);
  } else {
    console.log(`\nFalha ao parar conta ID ${accountId}.`);
  }
}

// Reiniciar conta específica
async function reiniciarContaEspecifica() {
  // Mostrar todas as contas disponíveis
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = 1');
    
    console.log('\n=== CONTAS DISPONÍVEIS ===');
    accounts.forEach(acc => {
      const status = activeInstances.has(acc.id) ? 'ATIVA' : 'INATIVA';
      console.log(`[${acc.id}] ${acc.nome} - ${status}`);
    });
    
  } catch (error) {
    console.error('Erro ao listar contas disponíveis:', error.message);
  }
  
  const idConta = await pergunta('\nDigite o ID da conta a ser reiniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`\nReiniciando conta ID ${accountId}...`);
  const resultado = await restartInstance(accountId);
  
  if (resultado) {
    console.log(`\nConta ID ${accountId} reiniciada com sucesso!`);
  } else {
    console.log(`\nFalha ao reiniciar conta ID ${accountId}.`);
  }
}

// Monitor de logs
async function mostrarMonitorLogs() {
  console.clear();
  console.log('===== MONITOR DE LOGS =====');
  console.log('Mostrando logs do sistema...');
  console.log('Pressione CTRL+C para retornar ao menu principal');
  console.log('================================================\n');
  
  try {
    // Spawn do comando "tail" para acompanhar logs em tempo real
    const tailProcess = spawn('tail', ['-f', path.join(process.cwd(), 'logs/system.log')]);
    
    // Redirecionar saída para o console
    tailProcess.stdout.on('data', (data) => {
      process.stdout.write(data);
    });
    
    tailProcess.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    
    // Encerrar o processo quando o usuário pressionar CTRL+C
    process.once('SIGINT', () => {
      tailProcess.kill();
      console.log('\nMonitoramento de logs encerrado.');
    });
    
    // Aguardar o fim do processo
    await new Promise((resolve) => {
      tailProcess.on('close', resolve);
    });
    
  } catch (error) {
    console.error('Erro ao monitorar logs:', error.message);
  }
}

// Encerrar todas as instâncias e sair
async function encerrar() {
  console.log('\nEncerrando todas as instâncias...');
  
  const instancias = Array.from(activeInstances.keys());
  
  for (const accountId of instancias) {
    await stopInstance(accountId);
  }
  
  console.log('Saindo...');
  rl.close();
  process.exit(0);
}

// Handler para encerramento gracioso
process.on('SIGINT', async () => {
  console.log('\nRecebido sinal de interrupção. Encerrando...');
  await encerrar();
});

process.on('SIGTERM', async () => {
  console.log('\nRecebido sinal de término. Encerrando...');
  await encerrar();
});

// Inicializar sistema
async function init() {
  try {
    console.log('Inicializando banco de dados...');
    
    await initPool();
    await initializeDatabase();
    
    // Verificar opções de linha de comando
    const args = process.argv.slice(2);
    
    if (args.includes('--start-all')) {
      // Modo automático - iniciar todas as contas
      await startAllInstances();
      console.log('Todas as contas foram iniciadas automaticamente.');
      process.exit(0);
      
    } else if (args.includes('--account')) {
      // Iniciar conta específica
      const accountIdIndex = args.indexOf('--account') + 1;
      if (accountIdIndex < args.length) {
        const accountId = parseInt(args[accountIdIndex]);
        if (!isNaN(accountId) && accountId > 0) {
          const success = await startInstance(accountId);
          if (success) {
            console.log(`Conta ID ${accountId} iniciada com sucesso.`);
            process.exit(0);
          } else {
            console.error(`Falha ao iniciar conta ID ${accountId}.`);
            process.exit(1);
          }
        } else {
          console.error('ID de conta inválido!');
          process.exit(1);
        }
      } else {
        console.error('ID de conta não especificado após --account');
        process.exit(1);
      }
      
    } else {
      // Modo interativo - mostrar menu
      await showMenu();
    }
    
  } catch (error) {
    console.error('Erro na inicialização:', error.message);
    process.exit(1);
  }
}

// Iniciar aplicação
init();