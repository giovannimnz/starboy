const api = require('./api');
const { getDatabaseInstance, formatDateForMySQL } = require('./db/conexao');
const websockets = require('./websockets');

// Função para enviar requisições WebSocket API
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  return new Promise((resolve, reject) => {
    console.log(`[WS-API] Enviando requisição WebSocket para conta ${accountId}:`, request);
    
    if (!accountId || typeof accountId !== 'number') {
      console.error(`[WS-API] AccountId inválido: ${accountId}`);
      return reject(new Error('AccountId é obrigatório e deve ser um número'));
    }

    const { getAccountConnectionState } = api;
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiConnection) {
      console.error(`[WS-API] WebSocket não conectado para conta ${accountId}`);
      return reject(new Error('WebSocket não conectado'));
    }

    const connection = accountState.wsApiConnection;
    if (connection.readyState !== 1) {
      console.error(`[WS-API] WebSocket não está no estado OPEN para conta ${accountId}, estado atual: ${connection.readyState}`);
      return reject(new Error('WebSocket não está conectado'));
    }

    const requestId = Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    const message = {
      id: requestId,
      method: request.method,
      params: request.params || {}
    };

    const timeoutId = setTimeout(() => {
      if (accountState.wsApiRequestCallbacks && accountState.wsApiRequestCallbacks.has(requestId)) {
        accountState.wsApiRequestCallbacks.delete(requestId);
      }
      console.error(`[WS-API] Timeout na requisição ${request.method} para conta ${accountId}`);
      reject(new Error(`Timeout na requisição ${request.method}`));
    }, timeout);

    if (!accountState.wsApiRequestCallbacks) {
      accountState.wsApiRequestCallbacks = new Map();
    }
    
    accountState.wsApiRequestCallbacks.set(requestId, (response) => {
      clearTimeout(timeoutId);
      
      if (response.error) {
        console.error(`[WS-API] Erro na resposta ${request.method} para conta ${accountId}:`, response.error);
        reject(new Error(`API Error: ${response.error.code} - ${response.error.msg}`));
      } else {
        console.log(`[WS-API] ✅ Resposta recebida para ${request.method} (conta ${accountId})`);
        resolve(response);
      }
    });

    try {
      connection.send(JSON.stringify(message));
      console.log(`[WS-API] Mensagem enviada para conta ${accountId}: ${request.method}`);
    } catch (error) {
      clearTimeout(timeoutId);
      if (accountState.wsApiRequestCallbacks) {
        accountState.wsApiRequestCallbacks.delete(requestId);
      }
      console.error(`[WS-API] Erro ao enviar mensagem para conta ${accountId}:`, error.message);
      reject(error);
    }
  });
}

/**
 * Obtém informações detalhadas da conta através da WebSocket API V2
 */
async function getAccountInformationV2(params = {}, accountId) {
  try {
    console.log(`[WS-API] Obtendo informações da conta ${accountId} via WebSocket API V2...`);
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(`AccountId é obrigatório e deve ser um número: ${accountId}`);
    }
    
    if (!websockets.isWebSocketApiConnected(accountId)) {
      console.log(`[WS-API] WebSocket não conectado para conta ${accountId}, tentando conectar...`);
      await websockets.startWebSocketApi(accountId);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    const request = {
      method: 'account.status',
      params: { ...params }
    };
    
    console.log(`[WS-API] Enviando requisição account.status para conta ${accountId}...`);
    const response = await sendWebSocketApiRequest(request, 30000, accountId);

    if (response && response.result) {
      console.log(`[WS-API] ✅ Informações da conta ${accountId} recebidas com sucesso.`);
      return {
        status: 200,
        result: response.result
      };
    } else if (response && response.error) {
      console.error(`[WS-API] Erro da API ao obter informações da conta ${accountId}:`, response.error);
      return { 
        status: 400,
        error: { 
          message: `API Error: ${response.error.code} - ${response.error.msg}`, 
          code: response.error.code 
        } 
      };
    } else {
      console.error(`[WS-API] Resposta inesperada de account.status para conta ${accountId}:`, response);
      return { 
        status: 500,
        error: { 
          message: 'Resposta inesperada de account.status' 
        } 
      };
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao obter informações da conta ${accountId}:`, error.message);
    return { 
      status: 500,
      error: { 
        message: `Erro na comunicação: ${error.message}` 
      } 
    };
  }
}

/**
 * Obtém saldo da conta através da WebSocket API
 */
async function getAccountBalance(params = {}, accountId) {
  try {
    const result = await getAccountInformationV2(params, accountId);
    
    if (result.status === 200 && result.result) {
      const accountData = result.result;
      return {
        success: true,
        totalWalletBalance: parseFloat(accountData.totalWalletBalance || 0),
        availableBalance: parseFloat(accountData.availableBalance || 0),
        maxWithdrawAmount: parseFloat(accountData.maxWithdrawAmount || 0),
        feeTier: accountData.feeTier || 0,
        canTrade: accountData.canTrade || false,
        canWithdraw: accountData.canWithdraw || false,
        canDeposit: accountData.canDeposit || false,
        updateTime: accountData.updateTime
      };
    } else {
      return {
        success: false,
        error: result.error?.message || 'Falha ao obter saldo'
      };
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao obter saldo da conta ${accountId}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Sincroniza saldo da conta via WebSocket
 */
async function syncAccountBalanceViaWebSocket(accountId) {
  try {
    console.log(`[WS-API] Sincronizando saldo da conta ${accountId} via WebSocket...`);
    
    const balance = await getAccountBalance({}, accountId);
    
    if (balance.success) {
      console.log(`[WS-API] ✅ Saldo sincronizado para conta ${accountId}:`, {
        total: balance.totalWalletBalance,
        disponível: balance.availableBalance
      });
      return balance;
    } else {
      console.error(`[WS-API] Erro ao obter saldo da conta ${accountId}:`, balance.error);
      throw new Error(balance.error);
    }
  } catch (error) {
    console.error(`[WS-API] Erro ao sincronizar saldo da conta ${accountId} via WebSocket:`, error.message);
    throw new Error(`Falha ao obter informações da conta ${accountId}: ${error.message}`);
  }
}

module.exports = {
  getAccountInformationV2,
  getAccountBalance,
  syncAccountBalanceViaWebSocket
};