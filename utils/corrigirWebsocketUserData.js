const fs = require('fs').promises;
const path = require('path');

async function corrigirWebsocketUserData() {
  try {
    console.log('=== CORRIGINDO WEBSOCKET USER DATA STREAM ===');
    
    const websocketsPath = path.join(__dirname, '..', 'websockets.js');
    let conteudo = await fs.readFile(websocketsPath, 'utf8');
    
    // Corrigir a função startUserDataStream para usar a URL correta
    const funcaoCorrigida = `
/**
 * Inicia o stream de dados do usuário
 * @param {Object} db - Conexão com o banco de dados (opcional)
 * @param {number} accountId - ID da conta
 * @returns {Promise<string>} - O listenKey gerado
 */
async function startUserDataStream(db, accountId = 1) {
  try {
    // Garantir que as credenciais estão carregadas
    await loadCredentialsFromDatabase({ accountId });
    
    const accountState = getAccountConnectionState(accountId, true);
    
    // Verificar se já existe uma conexão ativa
    if (accountState.userDataWebSocket && 
        accountState.userDataWebSocket.readyState === WebSocket.OPEN) {
      console.log(\`[WEBSOCKET] UserDataStream já está ativo para conta \${accountId}\`);
      return accountState.currentListenKey;
    }
    
    // Obter um novo listenKey
    const listenKey = await createListenKey(accountId);
    accountState.currentListenKey = listenKey;
    
    if (listenKey) {
      // Construir URL correta para o WebSocket UserData
      const wsUrl = \`\${accountState.wssMarketUrl}/ws/\${listenKey}\`;
      console.log(\`[WEBSOCKET] Conectando UserDataStream para conta \${accountId}: \${wsUrl}\`);
      
      const ws = new WebSocket(wsUrl);
      
      ws.on('open', () => {
        console.log(\`[WEBSOCKET] UserDataStream conectado para conta \${accountId}\`);
        accountState.userDataWebSocket = ws;
        
        // Iniciar keep-alive do listenKey
        startListenKeyKeepAlive(listenKey, accountId);
      });
      
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data);
          
          // Processar diferentes tipos de eventos
          if (message.e === 'ORDER_TRADE_UPDATE') {
            console.log(\`[WEBSOCKET] Atualização de ordem recebida para conta \${accountId}:\`, message.o.i);
            if (accountState.handlers && accountState.handlers.handleOrderUpdate) {
              await accountState.handlers.handleOrderUpdate(message.o, db, accountId);
            }
          } else if (message.e === 'ACCOUNT_UPDATE') {
            console.log(\`[WEBSOCKET] Atualização de conta recebida para conta \${accountId}\`);
            if (accountState.handlers && accountState.handlers.handleAccountUpdate) {
              await accountState.handlers.handleAccountUpdate(message, db, accountId);
            }
          }
        } catch (parseError) {
          console.error(\`[WEBSOCKET] Erro ao processar mensagem UserData para conta \${accountId}:\`, parseError);
        }
      });
      
      ws.on('error', (error) => {
        console.error(\`[WEBSOCKET] Erro na conexão de dados do usuário para conta \${accountId}:\`, error);
        
        // Limpar estado
        accountState.userDataWebSocket = null;
        if (accountState.listenKeyKeepAliveInterval) {
          clearInterval(accountState.listenKeyKeepAliveInterval);
          accountState.listenKeyKeepAliveInterval = null;
        }
        
        // NÃO tentar reconectar automaticamente para evitar loop infinito
        console.log(\`[WEBSOCKET] UserDataStream será reiniciado apenas quando necessário para conta \${accountId}\`);
      });
      
      ws.on('close', () => {
        console.log(\`[WEBSOCKET] Conexão de dados do usuário fechada para conta \${accountId}\`);
        
        // Limpar estado
        accountState.userDataWebSocket = null;
        if (accountState.listenKeyKeepAliveInterval) {
          clearInterval(accountState.listenKeyKeepAliveInterval);
          accountState.listenKeyKeepAliveInterval = null;
        }
      });
      
      return listenKey;
    } else {
      throw new Error(\`Falha ao obter listenKey para conta \${accountId}\`);
    }
  } catch (error) {
    console.error(\`[WEBSOCKETS] Erro ao iniciar stream de dados do usuário para conta \${accountId}:\`, error.message);
    throw error;
  }
}`;

    // Substituir a função existente
    conteudo = conteudo.replace(
      /async function startUserDataStream\(db, accountId = 1\)[\s\S]*?^}/m,
      funcaoCorrigida.trim()
    );
    
    await fs.writeFile(websocketsPath, conteudo, 'utf8');
    console.log('✅ WebSocket UserDataStream corrigido com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir WebSocket UserDataStream:', error);
  }
}

corrigirWebsocketUserData();