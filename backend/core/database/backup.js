const mysql = require('mysql2/promise');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const dotenv = require('dotenv');
const util = require('util');
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

// Cria interface para ler input do usuário
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = util.promisify(rl.question).bind(rl);
const execPromise = util.promisify(exec);

// Diretório para salvar backups
const backupDir = path.join(__dirname, '..', 'backups');

// Função principal
async function main() {
  try {
    console.log('===== BACKUP DE BANCO DE DADOS =====');
    
    // Verifica se o diretório de backups existe, se não, cria
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Diretório de backups criado: ${backupDir}`);
    }

    // Obtém os bancos de dados disponíveis
    const databases = await getDatabases();
    
    if (databases.length === 0) {
      console.error('Não foi possível encontrar bancos de dados disponíveis.');
      return;
    }

    // Exibe os bancos disponíveis
    console.log('\nBancos de dados disponíveis:');
    databases.forEach((db, index) => {
      console.log(`${index + 1}. ${db}`);
    });

    // Seleciona o banco para backup
    const dbIndexStr = await question('\nDigite o número do banco que deseja fazer backup: ');
    const dbIndex = parseInt(dbIndexStr) - 1;

    if (isNaN(dbIndex) || dbIndex < 0 || dbIndex >= databases.length) {
      console.error('Seleção inválida.');
      return;
    }

    const selectedDb = databases[dbIndex];
    console.log(`\nBanco selecionado: ${selectedDb}`);

    // Confirma a operação
    const confirm = await question('Confirma o backup? (S/N): ');
    if (confirm.toLowerCase() !== 's') {
      console.log('Operação cancelada pelo usuário.');
      return;
    }

    // Executa o backup
    console.log('\nIniciando backup...');
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${selectedDb}_${timestamp}.sql`;
    const backupFilePath = path.join(backupDir, backupFileName);

    // Cria o comando mysqldump
    const mysqldumpCmd = buildMysqldumpCommand(selectedDb, backupFilePath);
    
    // Executa o comando
    const { stdout, stderr } = await execPromise(mysqldumpCmd);
    
    if (stderr && !stderr.includes('Warning')) {
      throw new Error(`Erro ao executar backup: ${stderr}`);
    }

    console.log(`\nBackup concluído com sucesso: ${backupFilePath}`);
    console.log(`Tamanho do arquivo: ${(fs.statSync(backupFilePath).size / (1024 * 1024)).toFixed(2)} MB`);
    
  } catch (error) {
    console.error(`Erro durante o backup: ${error.message}`);
  } finally {
    rl.close();
  }
}

// Constrói o comando mysqldump
function buildMysqldumpCommand(database, outputFile) {
  const host = process.env.DB_HOST;
  const port = process.env.DB_PORT;
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;

  // Comando simplificado compatível com versões mais antigas do MySQL
  return `mysqldump -h${host} -P${port} -u${user} -p${password} --routines --triggers --events ${database} > "${outputFile}"`;
}

// Obtém a lista de bancos de dados disponíveis
async function getDatabases() {
  try {
    // Conecta ao MySQL
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });

    // Consulta bancos disponíveis
    const [rows] = await connection.execute('SHOW DATABASES');
    await connection.end();

    // Filtra bancos do sistema
    return rows
      .map(row => row.Database)
      .filter(db => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(db));
      
  } catch (error) {
    console.error(`Erro ao conectar ao MySQL: ${error.message}`);
    return [];
  }
}

// Executa o script
main();