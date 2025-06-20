const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const util = require('util');

// Carrega variáveis de ambiente
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Cria interface para ler input do usuário
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = util.promisify(rl.question).bind(rl);
const execPromise = util.promisify(exec);

// Diretório de backups
const backupDir = path.join(__dirname, '..', 'backups');

// Função principal
async function main() {
  try {
    console.log('===== RESTAURAÇÃO DE BANCO DE DADOS =====');
    
    // Verifica se o diretório de backups existe
    if (!fs.existsSync(backupDir)) {
      console.error(`Diretório de backups não encontrado: ${backupDir}`);
      return;
    }

    // Lista os arquivos de backup disponíveis
    const backupFiles = fs.readdirSync(backupDir)
      .filter(file => file.endsWith('.sql'))
      .sort((a, b) => {
        // Ordena por data/hora (mais recentes primeiro)
        return fs.statSync(path.join(backupDir, b)).mtime.getTime() - 
               fs.statSync(path.join(backupDir, a)).mtime.getTime();
      });

    if (backupFiles.length === 0) {
      console.error('Nenhum arquivo de backup encontrado.');
      return;
    }

    // Exibe os arquivos de backup disponíveis
    console.log('\nArquivos de backup disponíveis:');
    backupFiles.forEach((file, index) => {
      const stats = fs.statSync(path.join(backupDir, file));
      const size = (stats.size / (1024 * 1024)).toFixed(2);
      const date = stats.mtime.toLocaleString();
      console.log(`${index + 1}. ${file} (${size} MB) - ${date}`);
    });

    // Seleciona o arquivo para restauração
    const fileIndexStr = await question('\nDigite o número do arquivo de backup que deseja restaurar: ');
    const fileIndex = parseInt(fileIndexStr) - 1;

    if (isNaN(fileIndex) || fileIndex < 0 || fileIndex >= backupFiles.length) {
      console.error('Seleção inválida.');
      return;
    }

    const selectedFile = backupFiles[fileIndex];
    const backupFilePath = path.join(backupDir, selectedFile);
    
    // Extrai o nome do banco do arquivo de backup
    let defaultDbName = selectedFile.split('_')[0];
    
    // Pergunta o nome do banco de destino
    const targetDb = await question(`\nDigite o nome do banco de dados de destino [${defaultDbName}]: `);
    const dbName = targetDb.trim() || defaultDbName;

    console.log(`\nVocê selecionou:`);
    console.log(`- Arquivo de backup: ${selectedFile}`);
    console.log(`- Banco de dados de destino: ${dbName}`);

    // Aviso importante
    console.log('\n⚠️ ATENÇÃO! Esta operação irá apagar todos os dados existentes no banco selecionado!');
    const confirm = await question('Deseja continuar? (Digite "CONFIRMAR" para prosseguir): ');

    if (confirm !== 'CONFIRMAR') {
      console.log('Operação cancelada pelo usuário.');
      return;
    }

    // Verifica se o banco existe, se não, cria
    await createDatabaseIfNotExists(dbName);

    // Executa a restauração
    console.log('\nIniciando restauração...');
    
    // Cria o comando mysql
    const mysqlCmd = buildMysqlCommand(dbName, backupFilePath);
    
    // Executa o comando
    const { stdout, stderr } = await execPromise(mysqlCmd);
    
    if (stderr && !stderr.includes('Warning')) {
      console.warn(`Avisos durante a restauração: ${stderr}`);
    }

    console.log(`\nRestauração concluída com sucesso para o banco: ${dbName}`);
    
  } catch (error) {
    console.error(`Erro durante a restauração: ${error.message}`);
  } finally {
    rl.close();
  }
}

// Constrói o comando mysql para restauração
function buildMysqlCommand(database, inputFile) {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  // Comando para Windows
  return `mysql -h${host} -P${port} -u${user} -p${password} ${database} < "${inputFile}"`;
}

// Cria o banco de dados se não existir
async function createDatabaseIfNotExists(dbName) {
  try {
    // Conecta ao MySQL
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    // Verifica se o banco existe
    const [databases] = await connection.execute('SHOW DATABASES');
    const dbExists = databases.some(db => db.Database === dbName);

    if (!dbExists) {
      console.log(`Banco de dados '${dbName}' não existe. Criando...`);
      await connection.execute(`CREATE DATABASE ${dbName}`);
      console.log(`Banco de dados '${dbName}' criado com sucesso.`);
    } else {
      console.log(`Banco de dados '${dbName}' já existe.`);
    }

    await connection.end();
  } catch (error) {
    console.error(`Erro ao criar banco de dados: ${error.message}`);
    throw error;
  }
}

// Executa o script
main();