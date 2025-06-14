const instanceManager = require('./instanceManager');
const { initializeDatabase } = require('./db/conexao');
const readline = require('readline');

// Cria interface para leitura de comandos
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Função auxiliar para fazer perguntas
function pergunta(texto) {
  return new Promise((resolve) => {
    rl.question(texto, (resposta) => {
      resolve(resposta);
    });
  });
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
  console.log('0. Sair');
  
  const escolha = await pergunta('\nEscolha uma opção: ');
  
  switch (escolha) {
    case '1':
      await instanceManager.startAllInstances();
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
    case '0':
      console.log('Encerrando...');
      rl.close();
      process.exit(0);
      return;
    default:
      console.log('Opção inválida!');
  }
  
  await pergunta('\nPressione ENTER para voltar ao menu...');
  await showMenu();
}

// Listar contas ativas
async function listarContasAtivas() {
  const instancias = instanceManager.listActiveInstances();
  
  if (instancias.length === 0) {
    console.log('Não há contas ativas no momento.');
    return;
  }
  
  console.log('\n=== CONTAS ATIVAS ===');
  instancias.forEach(inst => {
    console.log(`[${inst.accountId}] ${inst.name} - Ativo há ${inst.uptime} minutos`);
  });
}

// Iniciar conta específica
async function iniciarContaEspecifica() {
  const idConta = await pergunta('Digite o ID da conta a ser iniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`Iniciando conta ID ${accountId}...`);
  const resultado = await instanceManager.startInstance(accountId);
  
  if (resultado) {
    console.log(`Conta ID ${accountId} iniciada com sucesso!`);
  } else {
    console.log(`Falha ao iniciar conta ID ${accountId}.`);
  }
}

// Parar conta específica
async function pararContaEspecifica() {
  const idConta = await pergunta('Digite o ID da conta a ser parada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`Parando conta ID ${accountId}...`);
  const resultado = await instanceManager.stopInstance(accountId);
  
  if (resultado) {
    console.log(`Conta ID ${accountId} parada com sucesso!`);
  } else {
    console.log(`Falha ao parar conta ID ${accountId}.`);
  }
}

// Reiniciar conta específica
async function reiniciarContaEspecifica() {
  const idConta = await pergunta('Digite o ID da conta a ser reiniciada: ');
  const accountId = parseInt(idConta);
  
  if (isNaN(accountId) || accountId <= 0) {
    console.log('ID de conta inválido!');
    return;
  }
  
  console.log(`Reiniciando conta ID ${accountId}...`);
  const resultado = await instanceManager.restartInstance(accountId);
  
  if (resultado) {
    console.log(`Conta ID ${accountId} reiniciada com sucesso!`);
  } else {
    console.log(`Falha ao reiniciar conta ID ${accountId}.`);
  }
}

// Inicializar sistema
async function init() {
  try {
    console.log('Inicializando banco de dados...');
    await initializeDatabase();
    
    // Verificar opções de linha de comando
    const args = process.argv.slice(2);
    
    if (args.includes('--start-all')) {
      // Modo automático - iniciar todas as contas
      await instanceManager.startAllInstances();
      console.log('Todas as contas foram iniciadas automaticamente.');
      
    } else if (args.includes('--account')) {
      // Iniciar conta específica
      const accountIdIndex = args.indexOf('--account') + 1;
      if (accountIdIndex < args.length) {
        const accountId = parseInt(args[accountIdIndex]);
        if (!isNaN(accountId) && accountId > 0) {
          await instanceManager.startInstance(accountId);
          console.log(`Conta ID ${accountId} iniciada com sucesso.`);
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
    console.error('Erro na inicialização:', error);
    process.exit(1);
  }
}

// Iniciar aplicação
init();