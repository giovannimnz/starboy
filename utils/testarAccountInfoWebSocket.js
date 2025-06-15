const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets');
const websocketApi = require('../websocketApi');

/**
 * Teste específico para getAccountInformationV2 via WebSocket API
 */
async function testarAccountInformationV2() {
  console.log('🚀 Iniciando teste detalhado de informações da conta via WebSocket API...\n');
  
  try {
    // === ETAPA 1: Verificar conexão com banco ===
    console.log('📊 ETAPA 1: Verificando conexão com banco de dados...');
    const db = await getDatabaseInstance();
    if (!db) {
      throw new Error('Não foi possível conectar ao banco de dados');
    }
    console.log('✅ Banco de dados conectado com sucesso\n');

    // === ETAPA 2: Carregar credenciais ===
    console.log('🔑 ETAPA 2: Carregando credenciais da conta 1...');
    try {
      const credentials = await websockets.loadCredentialsFromDatabase(1);
      console.log('✅ Credenciais carregadas com sucesso');
      console.log(`📋 Detalhes das credenciais:`);
      console.log(`- API Key: ${credentials.apiKey ? credentials.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- Secret Key: ${credentials.secretKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log(`- WS API Key: ${credentials.wsApiKey ? credentials.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
      console.log(`- Private Key: ${credentials.privateKey ? 'ENCONTRADA' : 'NÃO ENCONTRADA'}`);
      console.log();
    } catch (credError) {
      console.error('❌ Erro ao carregar credenciais:', credError.message);
      throw credError;
    }

    // === ETAPA 3: Verificar estado da conta ===
    console.log('🔗 ETAPA 3: Verificando estado da conexão da conta...');
    
    // CORREÇÃO: Usar função que existe e debug detalhado
    let accountState = websockets.getAccountConnectionState(1);
    
    if (!accountState) {
      console.log('⚠️ Estado da conta não existe ainda, tentando inicializar...');
      
      // Tentar obter todas as conexões para debug
      const allConnections = websockets.getAllAccountConnections();
      console.log(`📊 Total de conexões no mapa: ${allConnections.size}`);
      
      // Verificar se existe no accountConnections
      if (allConnections.has(1)) {
        console.log('✅ Conta 1 existe no mapa de conexões');
        accountState = allConnections.get(1);
      } else {
        console.log('❌ Conta 1 não existe no mapa de conexões');
        
        // Tentar forçar inicialização
        console.log('🔄 Tentando forçar inicialização do estado...');
        accountState = websockets.getAccountConnectionState(1, true); // Forçar criação
        
        if (!accountState) {
          throw new Error('Impossível inicializar estado da conta mesmo forçando');
        }
      }
    }
    
    console.log('📋 Informações do estado da conta:');
    console.log(`- API Key: ${accountState.apiKey ? accountState.apiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- WS API Key: ${accountState.wsApiKey ? accountState.wsApiKey.substring(0, 8) + '...' : 'NÃO ENCONTRADA'}`);
    console.log(`- Private Key: ${accountState.privateKey ? 'CONFIGURADA' : 'NÃO ENCONTRADA'}`);
    console.log(`- WS API URL: ${accountState.wsApiUrl || 'PADRÃO'}`);
    console.log(`- Authenticated: ${accountState.isAuthenticated || accountState.wsApiAuthenticated || false}`);
    console.log();

    // === ETAPA 4: Testar conexão WebSocket básica ===
    console.log('🌐 ETAPA 4: Testando conexão WebSocket API básica...');
    
    try {
      // Teste direto de conexão
      const wsApiUrl = accountState.wsApiUrl || 'wss://ws-fapi.binance.com/ws-fapi/v1';
      console.log(`🔄 Testando conexão direta em: ${wsApiUrl}`);
      
      const WebSocket = require('ws');
      const testWs = new WebSocket(wsApiUrl);
      
      const connectionTest = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          testWs.close();
          reject(new Error('Timeout na conexão básica'));
        }, 10000);
        
        testWs.on('open', () => {
          clearTimeout(timeout);
          console.log('✅ Conexão básica WebSocket API estabelecida!');
          
          // Testar comando básico
          testWs.send(JSON.stringify({
            id: 'test-connection',
            method: 'time',
            params: {}
          }));
        });
        
        testWs.on('message', (data) => {
          try {
            const response = JSON.parse(data);
            console.log('📨 Resposta do teste básico:', response);
            testWs.close();
            resolve(true);
          } catch (e) {
            console.log('📨 Resposta não-JSON:', data.toString());
            testWs.close();
            resolve(true);
          }
        });
        
        testWs.on('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
      
      console.log('✅ Teste de conexão básica foi bem-sucedido\n');
      
    } catch (wsError) {
      console.error('❌ Erro na conexão WebSocket básica:', wsError.message);
      console.log('⚠️ Continuando com teste usando sistema interno...\n');
    }

    // === ETAPA 5: Tentar inicializar WebSocket API via sistema ===
    console.log('🔧 ETAPA 5: Inicializando WebSocket API via sistema...');
    
    try {
      console.log('📞 Chamando websockets.startWebSocketApi(1)...');
      const wsConnected = await websockets.startWebSocketApi(1);
      
      if (wsConnected) {
        console.log('✅ WebSocket API inicializado com sucesso!');
      } else {
        console.log('⚠️ WebSocket API não foi inicializado, mas continuando...');
      }
    } catch (wsInitError) {
      console.warn('⚠️ Erro ao inicializar WebSocket API:', wsInitError.message);
    }
    console.log();

    // === ETAPA 6: Verificar status da sessão ===
    console.log('🔍 ETAPA 6: Verificando status da sessão WebSocket...');
    try {
      const sessionStatus = await websockets.checkSessionStatus(1);
      console.log('📊 Status da sessão:', JSON.stringify(sessionStatus, null, 2));
    } catch (sessionError) {
      console.warn('⚠️ Erro ao verificar status da sessão:', sessionError.message);
    }
    console.log();

    // === ETAPA 7: Testar getAccountInformationV2 ===
    console.log('🎯 ETAPA 7: Testando getAccountInformationV2...');
    
    try {
      console.log('📞 Chamando websocketApi.getAccountInformationV2(1)...');
      const accountInfo = await websocketApi.getAccountInformationV2({}, 1); // CORREÇÃO: Passar accountId explicitamente
      
      console.log('🎉 SUCESSO! Informações da conta obtidas via WebSocket API:');
      console.log('📊 Resposta completa:', JSON.stringify(accountInfo, null, 2));
      
      // Extrair informações importantes
      if (accountInfo && accountInfo.result) {
        const { totalWalletBalance, availableBalance, maxWithdrawAmount } = accountInfo.result;
        console.log('\n💰 Resumo Financeiro via WebSocket API:');
        console.log(`- Saldo Total: ${totalWalletBalance || 'N/A'} USDT`);
        console.log(`- Saldo Disponível: ${availableBalance || 'N/A'} USDT`);
        console.log(`- Máximo para Saque: ${maxWithdrawAmount || 'N/A'} USDT`);
      }
      
    } catch (apiError) {
      console.error('❌ Erro ao chamar getAccountInformationV2:', apiError.message);
      console.error('📋 Stack trace:', apiError.stack);
      
      // === ETAPA 7B: Teste alternativo via REST API ===
      console.log('\n🔄 ETAPA 7B: Tentando via REST API como fallback...');
      try {
        const api = require('../api');
        const restAccountInfo = await api.getAccountInfo(1);
        console.log('✅ REST API funcionou! Informações via REST:');
        console.log('📊 Saldo Total via REST:', restAccountInfo.totalWalletBalance || 'N/A');
      } catch (restError) {
        console.error('❌ REST API também falhou:', restError.message);
      }
    }

    // === ETAPA 8: Diagnóstico detalhado ===
    console.log('\n🔧 ETAPA 8: Diagnóstico detalhado do WebSocket...');
    
    console.log('🔍 Estado atual das conexões:');
    console.log(`- WebSocket API conectado: ${websockets.isWebSocketApiConnected(1)}`);
    console.log(`- WebSocket API autenticado: ${websockets.isWebSocketApiAuthenticated(1)}`);
    
    const allConnections = websockets.getAllAccountConnections();
    console.log(`- Total de conexões ativas: ${allConnections.size}`);
    
    if (allConnections.has(1)) {
      const conn = allConnections.get(1);
      console.log('📋 Detalhes da conexão da conta 1:');
      console.log(`  - wsApi existe: ${conn.wsApi ? 'SIM' : 'NÃO'}`);
      console.log(`  - wsApi estado: ${conn.wsApi ? conn.wsApi.readyState : 'N/A'}`);
      console.log(`  - isAuthenticated: ${conn.isAuthenticated}`);
      console.log(`  - wsApiAuthenticated: ${conn.wsApiAuthenticated}`);
      console.log(`  - requestCallbacks: ${conn.requestCallbacks ? conn.requestCallbacks.size : 'N/A'}`);
    }

    console.log('\n🎉 Teste concluído com diagnóstico completo!');

  } catch (error) {
    console.error('\n❌ ERRO GERAL NO TESTE:', error.message);
    console.error('📋 Stack trace completo:', error.stack);
  } finally {
    // === LIMPEZA ===
    console.log('\n🧹 Limpando conexões...');
    try {
      websockets.reset(1);
      console.log('✅ Conexões limpas com sucesso');
    } catch (cleanupError) {
      console.error('⚠️ Erro na limpeza:', cleanupError.message);
    }
    
    console.log('\n🏁 Teste finalizado');
    process.exit(0);
  }
}

// === FUNÇÃO AUXILIAR: Teste de conexão básica ===
async function testarConexaoBasica() {
  console.log('🔧 Testando conexão WebSocket básica...');
  
  const WebSocket = require('ws');
  const wsUrl = 'wss://ws-fapi.binance.com/ws-fapi/v1';
  
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => {
      ws.close();
      console.log('❌ Timeout na conexão básica');
      resolve(false);
    }, 5000);
    
    ws.on('open', () => {
      clearTimeout(timeout);
      console.log('✅ Conexão básica funcionou!');
      
      // Testar comando básico
      ws.send(JSON.stringify({
        id: 'test-basic',
        method: 'time',
        params: {}
      }));
    });
    
    ws.on('message', (data) => {
      try {
        const response = JSON.parse(data);
        console.log('📨 Resposta básica:', response);
        ws.close();
        resolve(true);
      } catch (e) {
        console.log('📨 Resposta não-JSON:', data.toString());
        ws.close();
        resolve(true);
      }
    });
    
    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.error('❌ Erro na conexão básica:', error.message);
      resolve(false);
    });
  });
}

// === EXECUÇÃO PRINCIPAL ===
console.log('='.repeat(60));
console.log('🧪 TESTE ESPECÍFICO: WebSocket API - Account Information V2');
console.log('='.repeat(60));
console.log();

// Executar teste básico primeiro
testarConexaoBasica().then(() => {
  console.log();
  // Depois executar teste completo
  testarAccountInformationV2();
});