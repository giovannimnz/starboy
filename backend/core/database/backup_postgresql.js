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

// Diretório para salvar backups
const backupDir = path.join(__dirname, '..', 'backups');

// Função principal
async function main() {
  try {
    console.log('===== BACKUP DE BANCO DE DADOS POSTGRESQL =====');
    
    // Verifica se o diretório de backups existe, se não, cria
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
      console.log(`Diretório de backups criado: ${backupDir}`);
    }

    // Configuração do PostgreSQL
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'starboy_trading'
    };

    // Testa conexão com o banco
    console.log('Testando conexão com o banco...');
    const pool = new Pool(config);
    
    try {
      const client = await pool.connect();
      console.log('Conexão com PostgreSQL estabelecida com sucesso!');
      client.release();
    } catch (error) {
      console.error('Erro ao conectar com o banco:', error.message);
      process.exit(1);
    }

    // Lista os bancos disponíveis
    console.log('\nListando bancos disponíveis...');
    const adminPool = new Pool({
      ...config,
      database: 'postgres' // Conecta ao banco padrão para listar outros bancos
    });

    const adminClient = await adminPool.connect();
    const result = await adminClient.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
    adminClient.release();
    await adminPool.end();

    const databases = result.rows.map(row => row.datname);
    console.log('\nBancos disponíveis:');
    databases.forEach((db, index) => {
      console.log(`${index + 1}. ${db}`);
    });

    // Seleciona o banco para backup
    const dbIndex = await question('\nSelecione o número do banco para backup: ');
    const selectedDb = databases[parseInt(dbIndex) - 1];

    if (!selectedDb) {
      console.log('Seleção inválida!');
      process.exit(1);
    }

    console.log(`\nBanco selecionado: ${selectedDb}`);

    // Gera nome do arquivo de backup
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `${selectedDb}_backup_${timestamp}.sql`;
    const backupFilePath = path.join(backupDir, backupFileName);

    // Cria o comando pg_dump
    const pgDumpCmd = buildPgDumpCommand(selectedDb, backupFilePath, config);

    console.log('\nIniciando backup...');
    const { stdout, stderr } = await execPromise(pgDumpCmd);

    if (stderr) {
      console.log('Avisos do pg_dump:', stderr);
    }

    console.log('\n✅ Backup concluído com sucesso!');
    console.log(`Arquivo salvo em: ${backupFilePath}`);

    // Mostra informações do arquivo
    const stats = fs.statSync(backupFilePath);
    console.log(`Tamanho do arquivo: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    await pool.end();
    rl.close();

  } catch (error) {
    console.error('Erro durante o backup:', error.message);
    process.exit(1);
  }
}

// Constrói o comando pg_dump
function buildPgDumpCommand(database, outputFile, config) {
  const { host, port, user, password } = config;
  
  // Define variáveis de ambiente para autenticação
  const envVars = `PGPASSWORD="${password}"`;
  
  // Comando pg_dump completo
  return `${envVars} pg_dump -h ${host} -p ${port} -U ${user} -d ${database} --no-owner --no-privileges --clean --if-exists > "${outputFile}"`;
}

// Função para listagem de bancos (caso necessário)
async function listDatabases() {
  try {
    // Conecta ao PostgreSQL
    const config = {
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || '',
      database: 'postgres'
    };

    const pool = new Pool(config);
    const client = await pool.connect();
    
    const result = await client.query('SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname');
    
    client.release();
    await pool.end();
    
    return result.rows.map(row => row.datname);
  } catch (error) {
    console.error('Erro ao listar bancos:', error.message);
    return [];
  }
}

// Executa o script se chamado diretamente
if (require.main === module) {
  main();
}

module.exports = { main, listDatabases };
