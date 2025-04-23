const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const axios = require('axios');
const crypto = require('crypto');

async function testTestnetConnection() {
  try {
    console.log('Verificando conexão com Testnet da Binance...');
    console.log(`API URL: ${process.env.API_URL}`);
    console.log(`API Key: ${process.env.API_KEY.substring(0, 5)}...`);
    
    // Timestamp para a requisição
    const timestamp = Date.now();
    
    // Parâmetros da requisição
    const params = {
      timestamp,
      recvWindow: 5000
    };
    
    // Gerar assinatura
    const queryString = new URLSearchParams(params).toString();
    const signature = crypto
      .createHmac('sha256', process.env.API_SECRET)
      .update(queryString)
      .digest('hex');
    
    // URL completa
    const url = `${process.env.API_URL}/v2/balance?${queryString}&signature=${signature}`;
    
    // Fazer a requisição
    const response = await axios({
      method: 'GET',
      url,
      headers: {
        'X-MBX-APIKEY': process.env.API_KEY
      }
    });
    
    console.log('Conexão com Testnet bem-sucedida!');
    console.log('Saldos disponíveis:');
    response.data.forEach(asset => {
      if (parseFloat(asset.balance) > 0) {
        console.log(`${asset.asset}: ${asset.balance}`);
      }
    });
    
    return true;
  } catch (error) {
    console.error('Erro ao conectar com Testnet:', error.response ? error.response.data : error.message);
    return false;
  }
}

// Verificar conexão com banco de dados
async function testDbConnection() {
  try {
    console.log('\nVerificando conexão com banco de dados...');
    console.log(`Host: ${process.env.DB_HOST}`);
    console.log(`Database: ${process.env.DB_NAME}`);
    
    const mysql = require('mysql2/promise');
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });
    
    const [rows] = await connection.query('SHOW TABLES');
    console.log('Conexão com banco de dados bem-sucedida!');
    console.log(`Tabelas disponíveis: ${rows.length}`);
    
    await connection.end();
    return true;
  } catch (error) {
    console.error('Erro ao conectar com banco de dados:', error.message);
    return false;
  }
}

// Executar testes
(async () => {
  const testnetOk = await testTestnetConnection();
  const dbOk = await testDbConnection();
  
  if (testnetOk && dbOk) {
    console.log('\n✅ Configuração de testnet está correta!');
  } else {
    console.log('\n❌ Há problemas na configuração do ambiente de teste.');
  }
})();