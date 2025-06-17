const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo URL do WebSocket BookTicker...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.websocket-url.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

console.log('1️⃣ Corrigindo websockets.js...');
const websocketsPath = path.join(__dirname, 'websockets.js');

if (fs.existsSync(websocketsPath)) {
  createBackup(websocketsPath);
  
  let content = fs.readFileSync(websocketsPath, 'utf8');
  
  console.log('2️⃣ Procurando função setupBookDepthWebsocket...');
  
  // Encontrar e substituir a função setupBookDepthWebsocket
  const functionMatch = content.match(/(function setupBookDepthWebsocket[\s\S]*?return ws;\s*})/);
  
  if (functionMatch) {
    console.log('✅ Função setupBookDepthWebsocket encontrada');
    
    // Nova implementação corrigida da função
    const newFunction = `function setupBookDepthWebsocket(symbol, callback, accountId) {
  // Validação do accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[WEBSOCKET] AccountId inválido para setupBookDepthWebsocket: \${accountId} (tipo: \${typeof accountId})\`);
    throw new Error(\`AccountId é obrigatório e deve ser um número, recebido: \${accountId}\`);
  }
  
  console.log(\`[WEBSOCKET] setupBookDepthWebsocket chamado para conta \${accountId}\`);

  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState || !accountState.wsUrl) {
    console.error(\`[WEBSOCKET] Estado da conta \${accountId} não encontrado ou sem wsUrl\`);
    throw new Error(\`Estado da conta \${accountId} inválido\`);
  }

  // URL CORRIGIDA: incluir /ws/ no caminho
  const wsEndpoint = \`\${accountState.wsUrl}/ws/\${symbol.toLowerCase()}@bookTicker\`;
  console.log(\`[WEBSOCKET] Conectando ao BookTicker em tempo real: \${wsEndpoint}\`);
  
  let ws = new WebSocket(wsEndpoint);
  let connectionTimeout = null;
  let heartbeatInterval = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_ATTEMPTS = 5;

  connectionTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      console.error(\`[WEBSOCKET] Timeout ao estabelecer conexão para \${symbol} BookTicker\`);
      ws.terminate();
    }
  }, 10000);

  ws.on('open', () => {
    console.log(\`[WEBSOCKET] BookTicker WebSocket conectado para \${symbol}\`);
    clearTimeout(connectionTimeout);
    reconnectAttempt = 0;

    heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 15000);
  });
  
  ws.on('message', (data) => {
    try {
      const tickerData = JSON.parse(data);
      
      if (tickerData && 
          (tickerData.e === 'bookTicker' || tickerData.e === undefined) && 
          typeof tickerData.b === 'string' && 
          typeof tickerData.a === 'string') {
        
        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        const bestBidQty = parseFloat(tickerData.B || '0');
        const bestAskQty = parseFloat(tickerData.A || '0');
        
        if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid > 0 && bestAsk > 0) {
          callback({
            bestBid, 
            bestAsk,
            bestBidQty,
            bestAskQty,
            timestamp: tickerData.E || Date.now()
          });
        } else {
          console.log(\`[WEBSOCKET] Valores numéricos inválidos em BookTicker para \${symbol}: bid=\${bestBid}, ask=\${bestAsk}\`);
        }
      } else {
        console.log(\`[WEBSOCKET] Formato inesperado de dados BookTicker para \${symbol}: \${JSON.stringify(tickerData).substring(0, 200)}\`);
      }
    } catch (error) {
      console.error(\`[WEBSOCKET] Erro ao processar BookTicker para \${symbol}:\`, error.message);
    }
  });
  
  ws.on('error', (error) => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatInterval);
    console.error(\`[WEBSOCKET] Erro na conexão BookTicker:\`, error.message);
  });
  
  ws.on('close', (code, reason) => {
    clearTimeout(connectionTimeout);
    clearInterval(heartbeatInterval);
    console.log(\`[WEBSOCKET] BookTicker fechado para \${symbol} (código: \${code})\`);
    
    // Não fazer reconexão automática - deixar o sistema gerenciar
  });
  
  return ws;
}`;

    // Substituir a função antiga pela nova
    content = content.replace(functionMatch[0], newFunction);
    
    console.log('✅ Função setupBookDepthWebsocket substituída');
  } else {
    console.log('⚠️ Função setupBookDepthWebsocket não encontrada, adicionando nova...');
    
    // Se não encontrou a função, adicionar no final
    content += `

// Função corrigida setupBookDepthWebsocket
function setupBookDepthWebsocket(symbol, callback, accountId) {
  // Validação do accountId
  if (!accountId || typeof accountId !== 'number') {
    console.error(\`[WEBSOCKET] AccountId inválido para setupBookDepthWebsocket: \${accountId} (tipo: \${typeof accountId})\`);
    throw new Error(\`AccountId é obrigatório e deve ser um número, recebido: \${accountId}\`);
  }
  
  console.log(\`[WEBSOCKET] setupBookDepthWebsocket chamado para conta \${accountId}\`);

  const accountState = getAccountConnectionState(accountId, true);
  
  if (!accountState || !accountState.wsUrl) {
    console.error(\`[WEBSOCKET] Estado da conta \${accountId} não encontrado ou sem wsUrl\`);
    throw new Error(\`Estado da conta \${accountId} inválido\`);
  }

  // URL CORRIGIDA: incluir /ws/ no caminho
  const wsEndpoint = \`\${accountState.wsUrl}/ws/\${symbol.toLowerCase()}@bookTicker\`;
  console.log(\`[WEBSOCKET] Conectando ao BookTicker em tempo real: \${wsEndpoint}\`);
  
  const ws = new WebSocket(wsEndpoint);

  ws.on('open', () => {
    console.log(\`[WEBSOCKET] BookTicker WebSocket conectado para \${symbol}\`);
  });
  
  ws.on('message', (data) => {
    try {
      const tickerData = JSON.parse(data);
      
      if (tickerData && tickerData.b && tickerData.a) {
        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        
        if (!isNaN(bestBid) && !isNaN(bestAsk) && bestBid > 0 && bestAsk > 0) {
          callback({
            bestBid, 
            bestAsk,
            bestBidQty: parseFloat(tickerData.B || '0'),
            bestAskQty: parseFloat(tickerData.A || '0'),
            timestamp: tickerData.E || Date.now()
          });
        }
      }
    } catch (error) {
      console.error(\`[WEBSOCKET] Erro ao processar BookTicker:\`, error.message);
    }
  });
  
  ws.on('error', (error) => {
    console.error(\`[WEBSOCKET] Erro na conexão BookTicker:\`, error.message);
  });
  
  ws.on('close', () => {
    console.log(\`[WEBSOCKET] BookTicker fechado para \${symbol}\`);
  });
  
  return ws;
}`;
  }
  
  // Também corrigir outras URLs de WebSocket se existirem
  console.log('3️⃣ Corrigindo outras URLs de WebSocket...');
  
  // Padrões de URL incorretos que precisam ser corrigidos
  const urlPatterns = [
    {
      name: 'bookTicker sem /ws/',
      wrong: /(\$\{[^}]+\})\/([a-z]+@bookTicker)/g,
      correct: '$1/ws/$2'
    },
    {
      name: 'aggTrade sem /ws/',
      wrong: /(\$\{[^}]+\})\/([a-z]+@aggTrade)/g,