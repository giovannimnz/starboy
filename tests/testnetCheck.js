const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
const axios = require('axios');
const crypto = require('crypto');
const WebSocket = require('ws');

// Verifica se as variáveis essenciais foram carregadas
function checkEnvironment() {
  console.log('Verificando variáveis de ambiente...');
  
  const requiredVars = [
    'API_KEY', 'API_SECRET', 'API_URL', 'WS_URL', 'WS_API_URL',
    'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'
  ];
  
  const missing = requiredVars.filter(varName => !process.env[varName]);
  
  if (missing.length > 0) {
    console.error('⚠️ Variáveis de ambiente não encontradas:', missing.join(', '));
    console.error('Executando setup.js para criar .env.test...');
    
    // Tenta executar o setup novamente
    const setupTestEnv = require('./setup.js');
    
    // Recarrega as variáveis após o setup
    require('dotenv').config({ path: path.join(__dirname, '..', '.env.test') });
    
    // Verifica novamente
    const stillMissing = requiredVars.filter(varName => !process.env[varName]);
    if (stillMissing.length > 0) {
      console.error('❌ Mesmo após setup, variáveis ainda estão faltando:', stillMissing.join(', '));
      return false;
    }
  }
  
  console.log('✅ Todas as variáveis de ambiente necessárias foram carregadas');
  return true;
}

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

// Verificar conexão com os WebSockets
async function testWebSocketConnection() {
  try {
    console.log('\nVerificando conexão com WebSockets da Binance...');
    console.log(`WS Stream URL: ${process.env.WS_URL}`);
    console.log(`WS API URL: ${process.env.WS_API_URL}`);
    
    // Testar conexão com o WebSocket de streams de mercado
    const wsStream = new WebSocket(`${process.env.WS_URL}/ws/btcusdt@trade`);
    let streamConnected = false;
    
    const streamPromise = new Promise((resolve, reject) => {
      wsStream.on('open', () => {
        console.log('✅ Conexão com WebSocket de streams estabelecida!');
        streamConnected = true;
        wsStream.close();
        resolve(true);
      });
      
      wsStream.on('error', (error) => {
        console.error('Erro na conexão com WebSocket de streams:', error.message);
        reject(error);
      });
      
      // Timeout caso a conexão demore muito
      setTimeout(() => {
        if (!streamConnected) {
          wsStream.terminate();
          reject(new Error('Timeout na conexão com WebSocket de streams'));
        }
      }, 5000);
    });
    
    // Testar conexão com o WebSocket de API
    const wsApi = new WebSocket(process.env.WS_API_URL);
    let apiConnected = false;
    
    const apiPromise = new Promise((resolve, reject) => {
      wsApi.on('open', () => {
        console.log('✅ Conexão com WebSocket de API estabelecida!');
        apiConnected = true;
        wsApi.close();
        resolve(true);
      });
      
      wsApi.on('error', (error) => {
        console.error('Erro na conexão com WebSocket de API:', error.message);
        reject(error);
      });
      
      // Timeout caso a conexão demore muito
      setTimeout(() => {
        if (!apiConnected) {
          wsApi.terminate();
          reject(new Error('Timeout na conexão com WebSocket de API'));
        }
      }, 5000);
    });
    
    try {
      await Promise.all([streamPromise, apiPromise]);
      console.log('✅ Ambas as conexões WebSocket funcionam corretamente!');
      return true;
    } catch (error) {
      console.error('Falha ao testar WebSockets:', error.message);
      return false;
    }
  } catch (error) {
    console.error('Erro ao verificar WebSockets:', error.message);
    return false;
  }
}

// Executar testes
(async () => {
  // Primeiro verifica o ambiente
  if (!checkEnvironment()) {
    console.log('❌ Configuração de ambiente incompleta. Abortando testes.');
    process.exit(1);
  }
  
  const testnetOk = await testTestnetConnection();
  const dbOk = await testDbConnection();
  const wsOk = await testWebSocketConnection();
  
  if (testnetOk && dbOk && wsOk) {
    console.log('\n✅ Configuração de testnet está correta!');
  } else {
    console.log('\n❌ Há problemas na configuração do ambiente de teste.');
  }
})();