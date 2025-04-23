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
WS_API_URL=${process.env.TESTNET_WS_API_URL}
BOT_TOKEN=${process.env.BOT_TOKEN}

# Banco de dados de teste
DB_HOST=${process.env.TESTNET_DB_HOST}
DB_PORT=${process.env.TESTNET_DB_PORT}
DB_USER=${process.env.TESTNET_DB_USER}
DB_PASSWORD=${process.env.TESTNET_DB_PASSWORD}
DB_NAME=${process.env.TESTNET_DB_NAME}
DB_DRIVER=${process.env.TESTNET_DB_DRIVER}
`;

  await fs.writeFile(envTestPath, envContent);
  console.log('Arquivo .env.test criado com configurações para testnet');
  
  // Configurar as variáveis de ambiente para uso nos testes
  require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });

  // Verificar se as variáveis necessárias foram carregadas
  console.log('Setup de teste: verificando variáveis de ambiente críticas...');
  console.log(`DB_HOST: ${process.env.DB_HOST ? 'OK' : 'AUSENTE'}`);
  console.log(`DB_USER: ${process.env.DB_USER ? 'OK' : 'AUSENTE'}`);
  console.log(`DB_PASSWORD: ${process.env.DB_PASSWORD ? 'OK (comprimento: ' + process.env.DB_PASSWORD.length + ')' : 'AUSENTE'}`);
  console.log(`DB_NAME: ${process.env.DB_NAME ? 'OK' : 'AUSENTE'}`);
  console.log(`WS_URL: ${process.env.WS_URL ? 'OK' : 'AUSENTE'}`);
  console.log(`WS_API_URL: ${process.env.WS_API_URL ? 'OK' : 'AUSENTE'}`);

  // Resto do código continua...
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