const { Pool } = require('pg');
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

// Diretório de backups
const backupDir = path.join(__dirname, '..', 'backups');

// Função principal
async function main() {
  try {
    console.log('===== RESTAURAÇÃO DE BANCO DE DADOS POSTGRESQL =====');
    
    // Verifica se o diretório de backups existe
    if (!fs.existsSync(backupDir)) {
      console.error(`Diretório de backups não encontrado: ${backupDir}`);
      return;
    }

    // Lista os arquivos de backup disponíveis
    const backupFiles = fs.readdirSync(backupDir).filter(file => file.endsWith('.sql'));
    
    if (backupFiles.length === 0) {
      console.log('Nenhum arquivo de backup encontrado no diretório.');
      return;
    }

    console.log('\nArquivos de backup disponíveis:');
    backupFiles.forEach((file, index) => {
      const filePath = path.join(backupDir, file);
      const stats = fs.statSync(filePath);
      const size = (stats.size / 1024 / 1024).toFixed(2);
      const date = stats.mtime.toLocaleDateString('pt-BR');
      const time = stats.mtime.toLocaleTimeString('pt-BR');
      console.log(`${index + 1}. ${file} (${size} MB) - ${date} ${time}`);
    });

    // Seleciona o arquivo de backup
    const fileIndex = await question('\nSelecione o número do arquivo de backup: ');
    const selectedFile = backupFiles[parseInt(fileIndex) - 1];

    if (!selectedFile) {
      console.log('Seleção inválida!');
      process.exit(1);
    }

    const backupFilePath = path.join(backupDir, selectedFile);
    console.log(`\nArquivo selecionado: ${selectedFile}`);

    // Configuração do PostgreSQL
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'starboy_trading'
    };

    // Pergunta o banco de destino
    console.log('\nBancos disponíveis:');
    const databases = await listDatabases(config);
    databases.forEach((db, index) => {
      console.log(`${index + 1}. ${db}`);
    });

    const dbIndex = await question('\nSelecione o banco de destino (ou digite um nome para criar novo): ');
    let targetDatabase;
    
    if (isNaN(dbIndex)) {
      // Nome de banco digitado
      targetDatabase = dbIndex.trim();
      console.log(`\nCriando banco: ${targetDatabase}`);
      await createDatabase(targetDatabase, config);
    } else {
      // Número selecionado
      targetDatabase = databases[parseInt(dbIndex) - 1];
      if (!targetDatabase) {
        console.log('Seleção inválida!');
        process.exit(1);
      }
    }

    console.log(`\nBanco de destino: ${targetDatabase}`);

    // Confirmação
    const confirm = await question('\n⚠️  ATENÇÃO: Esta operação irá substituir todos os dados do banco de destino.\nDeseja continuar? (digite "CONFIRMAR" para prosseguir): ');
    
    if (confirm !== 'CONFIRMAR') {
      console.log('Operação cancelada.');
      return;
    }

    // Restaura o backup
    console.log('\nIniciando restauração...');
    await restoreDatabase(backupFilePath, targetDatabase, config);

    console.log('\n✅ Restauração concluída com sucesso!');
    rl.close();

  } catch (error) {
    console.error('Erro durante a restauração:', error.message);
    process.exit(1);
  }
}

// Lista bancos disponíveis
async function listDatabases(config) {
  const adminPool = new Pool({
    ...config,
    database: 'postgres'
  });

  try {
    const client = await adminPool.connect();
    const result = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
    client.release();
    return result.rows.map(row => row.datname);
  } catch (error) {
    console.error('Erro ao listar bancos:', error.message);
    return [];
  } finally {
    await adminPool.end();
  }
}

// Cria um novo banco
async function createDatabase(databaseName, config) {
  const adminPool = new Pool({
    ...config,
    database: 'postgres'
  });

  try {
    const client = await adminPool.connect();
    await client.query(`CREATE DATABASE "${databaseName}"`);
    client.release();
    console.log(`Banco "${databaseName}" criado com sucesso!`);
  } catch (error) {
    if (error.code === '42P04') {
      console.log(`Banco "${databaseName}" já existe.`);
    } else {
      throw error;
    }
  } finally {
    await adminPool.end();
  }
}

// Restaura o banco de dados
async function restoreDatabase(backupFilePath, targetDatabase, config) {
  const { host, port, user, password } = config;
  
  // Define variáveis de ambiente para autenticação
  const envVars = `PGPASSWORD="${password}"`;
  
  // Comando psql para restaurar
  const restoreCmd = `${envVars} psql -h ${host} -p ${port} -U ${user} -d ${targetDatabase} < "${backupFilePath}"`;
  
  try {
    const { stdout, stderr } = await execPromise(restoreCmd);
    
    if (stderr) {
      console.log('Avisos do psql:', stderr);
    }
    
    if (stdout) {
      console.log('Saída do psql:', stdout);
    }
    
  } catch (error) {
    console.error('Erro durante a restauração:', error.message);
    throw error;
  }
}

// Função para verificar se o arquivo existe
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

// Executa o script se chamado diretamente
if (require.main === module) {
  main();
}

module.exports = { main, listDatabases, createDatabase, restoreDatabase };
