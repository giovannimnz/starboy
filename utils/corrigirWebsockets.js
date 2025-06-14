const fs = require('fs').promises;
const path = require('path');

async function corrigirWebsockets() {
  try {
    console.log('Adicionando função isWebSocketApiConnected ao websockets.js');
    
    // Caminho do arquivo websockets.js
    const websocketsFile = path.join(__dirname, '..', 'websockets.js');
    
    // Ler o conteúdo atual do arquivo
    let content = await fs.readFile(websocketsFile, 'utf8');
    
    // Verificar se a função já existe
    if (content.includes('function isWebSocketApiConnected')) {
      console.log('A função isWebSocketApiConnected já existe, mas não está na lista de exportações.');
    } else {
      // Adicionar a implementação da função antes do module.exports
      const newFunction = `
/**
 * Verifica se a conexão WebSocket API está ativa
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se conectado
 */
function isWebSocketApiConnected(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return false;
  
  return accountState.wsApiConnection && 
         accountState.wsApiConnection.readyState === WebSocket.OPEN;
}

`;

      // Encontrar a posição correta para inserir a função (antes do module.exports)
      const moduleExportsIndex = content.lastIndexOf('module.exports');
      if (moduleExportsIndex === -1) {
        throw new Error('Não foi possível encontrar module.exports no arquivo');
      }

      // Inserir a função antes do module.exports
      content = content.slice(0, moduleExportsIndex) + newFunction + content.slice(moduleExportsIndex);
      console.log('Função isWebSocketApiConnected adicionada');
    }

    // Verificar também a função isWebSocketApiAuthenticated
    if (!content.includes('function isWebSocketApiAuthenticated')) {
      // Adicionar também essa função que pode estar faltando
      const authFunction = `
/**
 * Verifica se a conexão WebSocket API está autenticada
 * @param {number} accountId - ID da conta
 * @returns {boolean} - true se autenticado
 */
function isWebSocketApiAuthenticated(accountId = 1) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return false;
  
  return accountState.wsApiAuthenticated === true;
}

`;

      // Encontrar a posição correta para inserir a função (antes do module.exports)
      const moduleExportsIndex = content.lastIndexOf('module.exports');
      if (moduleExportsIndex === -1) {
        throw new Error('Não foi possível encontrar module.exports no arquivo');
      }

      // Inserir a função antes do module.exports
      content = content.slice(0, moduleExportsIndex) + authFunction + content.slice(moduleExportsIndex);
      console.log('Função isWebSocketApiAuthenticated adicionada');
    }

    // Adicionar função reset que também pode estar faltando
    if (!content.includes('function reset(')) {
      const resetFunction = `
/**
 * Reinicia as conexões WebSocket para uma conta específica
 * @param {number} accountId - ID da conta
 */
function reset(accountId = 1) {
  // Limpar WebSocket API
  cleanupWebSocketApi(accountId);
  
  // Limpar WebSockets de preço
  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets) {
    for (const [symbol, ws] of priceWebsockets.entries()) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    priceWebsockets.clear();
  }
  
  // Limpar userDataWebSocket
  const accountState = getAccountConnectionState(accountId);
  if (accountState) {
    if (accountState.userDataWebSocket && accountState.userDataWebSocket.readyState !== WebSocket.CLOSED) {
      accountState.userDataWebSocket.close();
    }
    
    accountState.userDataWebSocket = null;
    
    // Limpar keepalive do listenKey
    if (accountState.listenKeyKeepAliveInterval) {
      clearInterval(accountState.listenKeyKeepAliveInterval);
      accountState.listenKeyKeepAliveInterval = null;
    }
  }
  
  console.log(\`[WEBSOCKETS] Todas as conexões WebSocket foram reiniciadas para conta \${accountId}\`);
}

`;

      // Encontrar a posição correta para inserir a função (antes do module.exports)
      const moduleExportsIndex = content.lastIndexOf('module.exports');
      if (moduleExportsIndex === -1) {
        throw new Error('Não foi possível encontrar module.exports no arquivo');
      }

      // Inserir a função antes do module.exports
      content = content.slice(0, moduleExportsIndex) + resetFunction + content.slice(moduleExportsIndex);
      console.log('Função reset adicionada');
    }

    // Salvar as alterações
    await fs.writeFile(websocketsFile, content, 'utf8');
    console.log('Arquivo websockets.js atualizado com sucesso!');
    
    // Agora verificar e atualizar o websocketApi.js para usar a função getCredentials
    const websocketApiFile = path.join(__dirname, '..', 'websocketApi.js');
    let apiContent = await fs.readFile(websocketApiFile, 'utf8');
    
    // Verificar se há referência a getCredentials
    if (apiContent.includes('const credentials = await websockets.getCredentials(')) {
      // Substituir com código que funciona com ou sem a função getCredentials
      apiContent = apiContent.replace(
        /const credentials = await websockets\.getCredentials\(accountId\);/g,
        `// Obter credenciais de forma segura
    let credentials;
    try {
      // Tentar usar getCredentials se existir
      if (typeof websockets.getCredentials === 'function') {
        credentials = await websockets.getCredentials(accountId);
      } else {
        // Fallback: obter do estado da conexão
        const accountState = websockets.getAccountConnectionState(accountId);
        if (!accountState) {
          throw new Error(\`Estado da conexão não encontrado para conta \${accountId}\`);
        }
        
        credentials = {
          apiKey: accountState.apiKey,
          apiSecret: accountState.apiSecret,
          apiUrl: accountState.apiUrl,
          wsApiUrl: accountState.wsApiUrl
        };
      }
    } catch (credError) {
      console.error(\`[WS-API] Erro ao obter credenciais: \${credError.message}\`);
      throw credError;
    }`
      );
      
      console.log('Código de obtenção de credenciais no websocketApi.js atualizado');
      await fs.writeFile(websocketApiFile, apiContent, 'utf8');
    }
    
    console.log('\nCorreções aplicadas com sucesso. Execute novamente seus scripts.');
    
  } catch (error) {
    console.error('Erro ao atualizar websockets.js:', error);
  }
}

corrigirWebsockets();