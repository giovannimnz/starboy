const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../config/.env') });
const { initializeDatabase, getDatabaseInstance, initPool } = require('../../../core/database/conexao');
const readline = require('readline');

const {
  startInstance,
  stopInstance,
  restartInstance,
  listActiveInstances,
  startAllInstances,
  stopAllInstances,
  isInstanceRunning,
  getInstanceStats
} = require('../processes/instanceManager');

// Cria interface para leitura de comandos
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Função para limpeza de tela multiplataforma
function clearScreenMultiplatform() {
  try {
    // Método 1: console.clear() - Funciona na maioria dos casos
    console.clear();
    
    // Método 2: ANSI escape codes - Compatível com terminais modernos
    process.stdout.write('\u001b[2J\u001b[0;0H');
    
    // Método 3: Fallback específico para plataforma
    if (process.platform === 'win32') {
      // Windows - Usar comando cls via spawn se necessário
      try {
        const { spawn } = require('child_process');
        const cls = spawn('cmd', ['/c', 'cls'], { stdio: 'inherit' });
        cls.on('error', () => {
          // Silenciar erros do cmd, já usamos outros métodos
        });
      } catch (winError) {
        // Silenciar erros do Windows
      }
    } else {
      // Linux/Mac - Usar comando clear
      try {
        const { spawn } = require('child_process');
        const clear = spawn('clear', [], { stdio: 'inherit' });
        clear.on('error', () => {
          // Silenciar erros do clear, já usamos outros métodos
        });
      } catch (nixError) {
        // Silenciar erros do Linux/Mac
      }
    }
    
  } catch (error) {
    console.error(`[APP] ⚠️ Não foi possível limpar a tela: ${error.message}`);
    console.error(`[APP] 🖥️ Plataforma: ${process.platform}`);
    console.error(`[APP] 📺 Terminal: ${process.env.TERM || 'não detectado'}`);
    
    // Fallback final: adicionar linhas em branco
    console.log('\n'.repeat(50));
    console.log(`[APP] 📄 Usando fallback de linhas em branco`);
  }
}

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

// Menu principal
async function showMenu() {
  clearScreenMultiplatform();
  console.log('===== STARBOY MULTI-CONTA =====');
  console.log('1. Iniciar todas as contas');
  console.log('2. Listar contas ativas');
  console.log('3. Iniciar conta específica');
  console.log('4. Parar conta específica');
  console.log('5. Reiniciar conta específica');
  console.log('6. Monitorar estatísticas');
  console.log('0. Sair');
  
  const escolha = await pergunta('\nEscolha uma opção: ');
  
  switch (escolha) {
    case '1':
      await iniciarTodasContas();
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
      await mostrarEstatisticas();
      break;
    case '0':
      await encerrar();
      return;
    default:
      console.log('Opção inválida!');
      break;
  }
  
  await pergunta('\nPressione Enter para continuar...');
  await showMenu();
}

// Iniciar todas as contas
async function iniciarTodasContas() {
  console.log('\n===== INICIANDO TODAS AS CONTAS =====');
  
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome FROM contas WHERE ativa = 1');
    
    if (accounts.length === 0) {
      console.log('Nenhuma conta ativa encontrada.');
      return;
    }
    
    console.log(`Encontradas ${accounts.length} contas ativas. Iniciando...`);
    
    const sucessos = await startAllInstances();
    console.log(`\n✅ ${sucessos}/${accounts.length} contas iniciadas com sucesso!`);
    
  } catch (error) {
    console.error('Erro ao iniciar todas as contas:', error.message);
  }
}

// Listar contas ativas
async function listarContasAtivas() {
  console.log('\n===== STATUS DAS CONTAS =====');
  
  const instancias = listActiveInstances();
  
  if (instancias.length === 0) {
    console.log('Nenhuma conta está ativa no momento.');
  } else {
    console.log('\n🟢 CONTAS ATIVAS:');
    instancias.forEach(inst => {
      console.log(`  [${inst.accountId}] ${inst.name} - Ativo há ${inst.uptimeFormatted} (PID: ${inst.pid})`);
    });
  }

  // Mostrar também contas disponíveis mas não ativas
  try {
    const db = await getDatabaseInstance();
    const [allAccounts] = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = 1');
    
    const inactiveAccounts = allAccounts.filter(acc => 
      !instancias.some(inst => inst.accountId === acc.id));
    
    if (inactiveAccounts.length > 0) {
      console.log('\n⚪ CONTAS DISPONÍVEIS (INATIVAS):');
      inactiveAccounts.forEach(acc => {
        console.log(`  [${acc.id}] ${acc.nome} - Pronta para iniciar`);
      });
    }
  } catch (error) {
    console.error('Erro ao listar contas disponíveis:', error.message);
  }
}

// Iniciar conta específica
async function iniciarContaEspecifica() {
  console.log('\n===== INICIAR CONTA ESPECÍFICA =====');
  
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = 1');
    
    if (accounts.length === 0) {
      console.log('Nenhuma conta ativa encontrada.');
      return;
    }
    
    console.log('\n📋 CONTAS DISPONÍVEIS:');
    accounts.forEach(acc => {
      const status = isInstanceRunning(acc.id) ? '🟢 ATIVA' : '⚪ INATIVA';
      console.log(`  [${acc.id}] ${acc.nome} - ${status}`);
    });
    
  } catch (error) {
    console.error('Erro ao listar contas:', error.message);
    return;
  }
  
  const idConta = await pergunta('\nDigite o ID da conta a ser iniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('❌ ID de conta inválido!');
    return;
  }
  
  if (isInstanceRunning(accountId)) {
    console.log(`⚠️ Conta ID ${accountId} já está ativa!`);
    return;
  }
  
  console.log(`\n🚀 Iniciando conta ID ${accountId}...`);
  
  try {
    const resultado = await startInstance(accountId);
    
    if (resultado) {
      console.log(`✅ Conta ID ${accountId} iniciada com sucesso!`);
    } else {
      console.log(`❌ Falha ao iniciar conta ID ${accountId}.`);
    }
  } catch (error) {
    console.error(`❌ Erro ao iniciar conta ${accountId}:`, error.message);
  }
}

// Parar conta específica
async function pararContaEspecifica() {
  console.log('\n===== PARAR CONTA ESPECÍFICA =====');
  
  const instancias = listActiveInstances();
  
  if (instancias.length === 0) {
    console.log('Não há contas ativas para parar.');
    return;
  }
  
  console.log('\n🟢 CONTAS ATIVAS:');
  instancias.forEach(inst => {
    console.log(`  [${inst.accountId}] ${inst.name} - Ativo há ${inst.uptimeFormatted} (PID: ${inst.pid})`);
  });
  
  const idConta = await pergunta('\nDigite o ID da conta a ser parada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('❌ ID de conta inválido!');
    return;
  }
  
  if (!isInstanceRunning(accountId)) {
    console.log(`⚠️ Conta ID ${accountId} não está ativa!`);
    return;
  }
  
  console.log(`\n🛑 Parando conta ID ${accountId}...`);
  
  try {
    const resultado = await stopInstance(accountId);
    
    if (resultado) {
      console.log(`✅ Conta ID ${accountId} parada com sucesso!`);
    } else {
      console.log(`❌ Falha ao parar conta ID ${accountId}.`);
    }
  } catch (error) {
    console.error(`❌ Erro ao parar conta ${accountId}:`, error.message);
  }
}

// Reiniciar conta específica
async function reiniciarContaEspecifica() {
  console.log('\n===== REINICIAR CONTA ESPECÍFICA =====');
  
  try {
    const db = await getDatabaseInstance();
    const [accounts] = await db.query('SELECT id, nome, ativa FROM contas WHERE ativa = 1');
    
    if (accounts.length === 0) {
      console.log('Nenhuma conta ativa encontrada.');
      return;
    }
    
    console.log('\n📋 CONTAS DISPONÍVEIS:');
    accounts.forEach(acc => {
      const status = isInstanceRunning(acc.id) ? '🟢 ATIVA' : '⚪ INATIVA';
      console.log(`  [${acc.id}] ${acc.nome} - ${status}`);
    });
    
  } catch (error) {
    console.error('Erro ao listar contas:', error.message);
    return;
  }
  
  const idConta = await pergunta('\nDigite o ID da conta a ser reiniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('❌ ID de conta inválido!');
    return;
  }
  
  console.log(`\n🔄 Reiniciando conta ID ${accountId}...`);
  
  try {
    const resultado = await restartInstance(accountId);
    
    if (resultado) {
      console.log(`✅ Conta ID ${accountId} reiniciada com sucesso!`);
    } else {
      console.log(`❌ Falha ao reiniciar conta ID ${accountId}.`);
    }
  } catch (error) {
    console.error(`❌ Erro ao reiniciar conta ${accountId}:`, error.message);
  }
}

// Mostrar estatísticas
async function mostrarEstatisticas() {
  console.log('\n===== ESTATÍSTICAS DO SISTEMA =====');
  
  const stats = getInstanceStats();
  const instancias = listActiveInstances();
  
  console.log(`📊 Total de instâncias: ${stats.total}`);
  console.log(`🟢 Rodando: ${stats.running}`);
  console.log(`🔴 Paradas: ${stats.stopped}`);
  
  if (instancias.length > 0) {
    console.log('\n📈 DETALHES DAS INSTÂNCIAS ATIVAS:');
    instancias.forEach(inst => {
      console.log(`  [${inst.accountId}] ${inst.name}`);
      console.log(`    • PID: ${inst.pid}`);
      console.log(`    • Iniciado: ${inst.startTime.toLocaleString()}`);
      console.log(`    • Tempo ativo: ${inst.uptimeFormatted}`);
      console.log(`    • Status: ${inst.isRunning ? '🟢 Rodando' : '🔴 Parado'}`);
      console.log('');
    });
  }
  
  try {
    const db = await getDatabaseInstance();
    const [totalAccounts] = await db.query('SELECT COUNT(*) as total FROM contas WHERE ativa = 1');
    const totalAtivas = totalAccounts[0].total;
    
    console.log(`📋 Total de contas no banco: ${totalAtivas}`);
    console.log(`🚀 Taxa de utilização: ${totalAtivas > 0 ? ((stats.running / totalAtivas) * 100).toFixed(1) : 0}%`);
    
  } catch (error) {
    console.error('Erro ao consultar banco de dados:', error.message);
  }
}

// Encerrar todas as instâncias e sair
async function encerrar() {
  console.log('\n===== ENCERRANDO SISTEMA =====');
  
  const stats = getInstanceStats();
  
  if (stats.running > 0) {
    console.log(`Encerrando ${stats.running} instância(s) ativa(s)...`);
    
    const paradas = await stopAllInstances();
    console.log(`✅ ${paradas} instância(s) encerrada(s) com sucesso.`);
  } else {
    console.log('Nenhuma instância ativa para encerrar.');
  }
  
  console.log('👋 Saindo...');
  rl.close();
  process.exit(0);
}

// Handler para encerramento gracioso
process.on('SIGINT', async () => {
  console.log('\n🛑 Recebido sinal de interrupção (CTRL+C)...');
  await encerrar();
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Recebido sinal de término...');
  await encerrar();
});

// Tratamento de erros não capturados
process.on('uncaughtException', (error) => {
  console.error('❌ Erro não capturado:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Promise rejeitada não tratada:', reason);
  process.exit(1);
});

// Inicializar sistema
async function init() {
  try {
    console.log('🚀 Inicializando sistema Starboy Multi-Conta...');
    console.log('📊 Inicializando banco de dados...');
    
    await initPool();
    await initializeDatabase();
    
    console.log('✅ Banco de dados inicializado com sucesso!');
    
    // Verificar opções de linha de comando
    const args = process.argv.slice(2);
    
    if (args.includes('--start-all')) {
      // Modo automático - iniciar todas as contas
      console.log('🤖 Modo automático: iniciando todas as contas...');
      const sucessos = await startAllInstances();
      console.log(`✅ ${sucessos} conta(s) iniciada(s) automaticamente.`);
      
      // Manter o processo vivo para gerenciar as instâncias
      console.log('💤 Sistema rodando em segundo plano. Pressione CTRL+C para encerrar.');
      
      // Aguardar sinal de encerramento
      await new Promise(resolve => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
      });
      
    } else if (args.includes('--account')) {
      // Iniciar conta específica
      const accountIdIndex = args.indexOf('--account') + 1;
      if (accountIdIndex < args.length) {
        const accountId = parseInt(args[accountIdIndex]);
        if (!isNaN(accountId) && accountId > 0) {
          console.log(`🎯 Iniciando conta específica: ${accountId}...`);
          const success = await startInstance(accountId);
          if (success) {
            console.log(`✅ Conta ID ${accountId} iniciada com sucesso.`);
            
            // Manter o processo vivo
            console.log('💤 Sistema rodando. Pressione CTRL+C para encerrar.');
            await new Promise(resolve => {
              process.on('SIGINT', resolve);
              process.on('SIGTERM', resolve);
            });
          } else {
            console.error(`❌ Falha ao iniciar conta ID ${accountId}.`);
            process.exit(1);
          }
        } else {
          console.error('❌ ID de conta inválido!');
          process.exit(1);
        }
      } else {
        console.error('❌ ID de conta não especificado após --account');
        process.exit(1);
      }
      
    } else {
      // Modo interativo - mostrar menu
      console.log('🎮 Modo interativo iniciado.');
      await showMenu();
    }
    
  } catch (error) {
    console.error('❌ Erro na inicialização:', error.message);
    console.error('Stack trace:', error.stack);
    process.exit(1);
  }
}

// Iniciar aplicação
init().catch(error => {
  console.error('❌ Erro fatal na inicialização:', error);
  process.exit(1);
});