const path = require('path');
// Primeiro carrega o arquivo .env original para acessar as credenciais da testnet
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const fs = require('fs').promises;
const mysql = require('mysql2/promise');

// Criar arquivo .env.test com configurações para testnet
async function setupTestEnv() {
  console.log('Configurando ambiente de teste...');
  
  // Criar arquivo .env.test com as credenciais da testnet
  const envTestPath = path.join(__dirname, '..', '.env.test');
  const envContent = `
# Testnet da Binance
API_KEY=${process.env.TESTNET_API_KEY}
API_SECRET=${process.env.TESTNET_API_SECRET}
API_URL=${process.env.TESTNET_API_URL}
WS_URL=${process.env.TESTNET_WS_URL}
BOT_TOKEN=${process.env.BOT_TOKEN}

# Banco de dados de teste
DB_DRIVER=${process.env.TESTNET_DB_DRIVER}
DB_HOST=${process.env.TESTNET_DB_HOST}
DB_PORT=${process.env.TESTNET_DB_PORT}
DB_USER=${process.env.TESTNET_DB_USER}
DB_PASSWORD=${process.env.TESTNET_DB_PASSWORD}
DB_NAME=${process.env.TESTNET_DB_NAME}
`;

  await fs.writeFile(envTestPath, envContent);
  console.log('Arquivo .env.test criado com configurações para testnet');
  
  // Criar banco de dados de teste
  try {
    const connection = await mysql.createConnection({
      host: process.env.TESTNET_DB_HOST,
      port: process.env.TESTNET_DB_PORT,
      user: process.env.TESTNET_DB_USER,
      password: process.env.TESTNET_DB_PASSWORD
    });
    
    // Criar banco de dados de teste
    await connection.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.TESTNET_DB_NAME}`);
    console.log(`Banco de dados ${process.env.TESTNET_DB_NAME} criado ou já existente`);
    
    // Selecionar o banco de dados
    await connection.execute(`USE ${process.env.TESTNET_DB_NAME}`);
    
    // Executar script para criar tabelas no banco de teste
    console.log('Criando tabelas no banco de dados de teste...');
    // Importar módulo de criação do banco
    const createDb = require(path.join(__dirname, '..', 'db', 'createDb.js'));
    
    // Se createDb for uma função, executá-la
    if (typeof createDb === 'function') {
      await createDb();
    }
    
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
    await fs.mkdir(positionsDir, { recursive: true });
  }
  
  // Criar arquivo posicoes.json vazio para testes
  const positionsFile = path.join(positionsDir, 'posicoes.json');
  await fs.writeFile(positionsFile, '[]');
  
  console.log('Configuração do ambiente de teste concluída com sucesso!');
}

// Executar setup imediatamente quando o módulo for carregado
(async () => {
  try {
    await setupTestEnv();
  } catch (error) {
    console.error('Erro durante configuração do ambiente de teste:', error);
    process.exit(1);
  }
})();

module.exports = setupTestEnv;