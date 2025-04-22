const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const fs = require('fs').promises;
const mysql = require('mysql2/promise');

// Criar arquivo .env.test com configurações para testnet
async function setupTestEnv() {
  console.log('Configurando ambiente de teste...');
  
  // Criar arquivo .env.test se não existir
  const envTestPath = path.join(__dirname, '..', '.env.test');
  const envContent = `
# Testnet da Binance
API_KEY=${process.env.TESTNET_API_KEY || process.env.API_KEY}
API_SECRET=${process.env.TESTNET_API_SECRET || process.env.API_SECRET}
API_URL=https://testnet.binancefuture.com/fapi
WS_URL=wss://stream.binancefuture.com
BOT_TOKEN=${process.env.BOT_TOKEN}

# Banco de dados de teste
DB_DRIVER=mysql
DB_HOST=${process.env.DB_HOST}
DB_PORT=${process.env.DB_PORT}
DB_USER=${process.env.DB_USER}
DB_PASSWORD=${process.env.DB_PASSWORD}
DB_NAME=${process.env.DB_NAME}_test
`;

  await fs.writeFile(envTestPath, envContent);
  console.log('Arquivo .env.test criado com configurações para testnet');
  
  // Criar banco de dados de teste
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD
    });
    
    // Criar banco de dados de teste
    await connection.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME}_test`);
    console.log(`Banco de dados ${process.env.DB_NAME}_test criado ou já existente`);
    
    // Importar esquema do banco principal para o banco de teste
    const createDbPath = path.join(__dirname, '..', 'db', 'createDb.js');
    require(createDbPath);
    
    await connection.end();
  } catch (error) {
    console.error('Erro ao configurar banco de dados de teste:', error);
    throw error;
  }
  
  // Criar diretório posicoes se não existir
  const positionsDir = path.join(__dirname, '..', 'posicoes');
  try {
    await fs.access(positionsDir);
  } catch (error) {
    await fs.mkdir(positionsDir);
  }
  
  // Criar arquivo posicoes.json vazio para testes
  const positionsFile = path.join(positionsDir, 'posicoes.json');
  await fs.writeFile(positionsFile, '[]');
}

module.exports = setupTestEnv;