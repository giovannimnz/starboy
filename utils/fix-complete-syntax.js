const fs = require('fs');
const path = require('path');

console.log('🔧 Análise e correção completa de sintaxe...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.complete.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// Função para analisar sintaxe de um arquivo
function analyzeSyntax(filePath, fileName) {
  console.log(`\n🔍 Analisando ${fileName}...`);
  
  if (!fs.existsSync(filePath)) {
    console.log(`❌ Arquivo não encontrado: ${filePath}`);
    return { valid: false, errors: [`Arquivo não encontrado: ${filePath}`] };
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const errors = [];
  let openBraces = 0;
  let openParens = 0;
  let openBrackets = 0;
  let inTryBlock = false;
  let tryStackDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // Verificar try/catch/finally
    if (line.includes('try {') || line.match(/try\s*\{/)) {
      inTryBlock = true;
      tryStackDepth++;
    }
    
    if (line.includes('} catch') || line.includes('} finally')) {
      if (tryStackDepth > 0) {
        tryStackDepth--;
        if (tryStackDepth === 0) inTryBlock = false;
      }
    }
    
    // Verificar blocos try órfãos
    if (line.trim() === '}' && inTryBlock && tryStackDepth === 1) {
      // Verificar se a próxima linha não é catch ou finally
      const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
      if (!nextLine.startsWith('catch') && !nextLine.startsWith('finally') && 
          !nextLine.startsWith('} catch') && !nextLine.startsWith('} finally')) {
        errors.push(`Linha ${lineNumber}: Bloco try sem catch ou finally`);
      }
    }
    
    // Contar delimitadores
    for (const char of line) {
      switch (char) {
        case '{': openBraces++; break;
        case '}': openBraces--; break;
        case '(': openParens++; break;
        case ')': openParens--; break;
        case '[': openBrackets++; break;
        case ']': openBrackets--; break;
      }
    }
    
    // Verificar padrões problemáticos específicos
    if (line.includes("= 'Graceful shutdown');")) {
      errors.push(`Linha ${lineNumber}: Sintaxe inválida - "${line.trim()}"`);
    }
    
    if (line.match(/const\s+\w+\s+=\s*'[^']*'\s*\);/)) {
      errors.push(`Linha ${lineNumber}: Declaração de const mal formada - "${line.trim()}"`);
    }
    
    // Verificar strings não fechadas
    const singleQuotes = (line.match(/'/g) || []).length;
    const doubleQuotes = (line.match(/"/g) || []).length;
    const backticks = (line.match(/`/g) || []).length;
    
    if (singleQuotes % 2 !== 0 || doubleQuotes % 2 !== 0 || backticks % 2 !== 0) {
      errors.push(`Linha ${lineNumber}: Possível string não fechada - "${line.trim()}"`);
    }
  }
  
  // Verificar balanceamento geral
  if (openBraces !== 0) {
    errors.push(`Chaves desbalanceadas: ${openBraces > 0 ? openBraces + ' abertas a mais' : Math.abs(openBraces) + ' fechadas a mais'}`);
  }
  
  if (openParens !== 0) {
    errors.push(`Parênteses desbalanceados: ${openParens > 0 ? openParens + ' abertos a mais' : Math.abs(openParens) + ' fechados a mais'}`);
  }
  
  if (openBrackets !== 0) {
    errors.push(`Colchetes desbalanceados: ${openBrackets > 0 ? openBrackets + ' abertos a mais' : Math.abs(openBrackets) + ' fechados a mais'}`);
  }

  if (errors.length === 0) {
    console.log(`✅ ${fileName} - Sintaxe parece estar correta`);
    return { valid: true, errors: [] };
  } else {
    console.log(`❌ ${fileName} - ${errors.length} erro(s) encontrado(s):`);
    errors.forEach(error => console.log(`  - ${error}`));
    return { valid: false, errors };
  }
}

// Função para corrigir websockets.js especificamente
function fixWebsocketsJs() {
  const websocketsPath = path.join(__dirname, 'websockets.js');
  console.log('\n🔧 Corrigindo websockets.js...');
  
  if (!createBackup(websocketsPath)) return false;
  
  let content = fs.readFileSync(websocketsPath, 'utf8');
  let lines = content.split('\n');
  let fixed = false;
  
  // Encontrar e corrigir try blocks órfãos
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;
    
    // Procurar por try blocks problemáticos na área da linha 1100
    if (lineNumber >= 1095 && lineNumber <= 1105) {
      console.log(`🔍 Linha ${lineNumber}: ${line.trim()}`);
      
      // Se encontrar um } sozinho após um try
      if (line.trim() === '}' && i > 0) {
        // Verificar linhas anteriores para try
        let foundTry = false;
        for (let j = Math.max(0, i - 10); j < i; j++) {
          if (lines[j].includes('try {') || lines[j].match(/try\s*\{/)) {
            foundTry = true;
            break;
          }
        }
        
        if (foundTry) {
          // Verificar se próxima linha é catch/finally
          const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
          if (!nextLine.startsWith('catch') && !nextLine.startsWith('finally')) {
            console.log(`🔧 Adicionando catch após linha ${lineNumber}`);
            lines.splice(i + 1, 0, '  } catch (error) {');
            lines.splice(i + 2, 0, '    console.error(`[WEBSOCKETS] Erro capturado: ${error.message}`);');
            lines.splice(i + 3, 0, '  }');
            fixed = true;
            break;
          }
        }
      }
    }
    
    // Corrigir linhas específicas problemáticas
    if (line.includes("const accountState = 'Graceful shutdown');")) {
      console.log(`🔧 Corrigindo linha ${lineNumber}`);
      lines[i] = "    const accountState = getAccountConnectionState(accountId);";
      fixed = true;
    }
    
    if (line.match(/const\s+\w+\s+=\s*'[^']*'\s*\);/)) {
      console.log(`🔧 Corrigindo declaração mal formada na linha ${lineNumber}`);
      const match = line.match(/const\s+(\w+)/);
      if (match && match[1] === 'accountState') {
        lines[i] = "    const accountState = getAccountConnectionState(accountId);";
        fixed = true;
      }
    }
  }
  
  if (fixed) {
    const correctedContent = lines.join('\n');
    fs.writeFileSync(websocketsPath, correctedContent, 'utf8');
    console.log('✅ websockets.js corrigido');
    return true;
  } else {
    console.log('⚠️ Nenhuma correção óbvia aplicada');
    return false;
  }
}

// Função para criar um websockets.js limpo e funcional
function createCleanWebsocketsJs() {
  const websocketsPath = path.join(__dirname, 'websockets.js');
  console.log('\n🔧 Criando websockets.js limpo...');
  
  createBackup(websocketsPath);
  
  const cleanWebsocketsContent = `const WebSocket = require('ws');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDatabaseInstance } = require('./db/conexao');
const api = require('./api');
const { getAccountConnectionState } = require('./api');

// Variáveis para as bibliotecas Ed25519
let nobleEd25519SignFunction = null;
let tweetnaclInstance = null;

// Função para carregar @noble/ed25519 dinamicamente
async function loadNobleEd25519() {
  if (nobleEd25519SignFunction) return true;
  try {
    const nobleModule = await import('@noble/ed25519');
    if (nobleModule && typeof nobleModule.sign === 'function') {
      nobleEd25519SignFunction = nobleModule.sign;
      console.log('[WS-API] @noble/ed25519 carregado dinamicamente com sucesso.');
      return true;
    }
    console.log('[WS-API] @noble/ed25519 carregado, mas a função sign não foi encontrada.');
    return false;
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') {
        console.warn('[WS-API] Falha ao carregar @noble/ed25519 dinamicamente:', e.message);
    } else {
        console.log('[WS-API] @noble/ed25519 não instalado, pulando.');
    }
    return false;
  }
}

// Carregar tweetnacl
try {
  tweetnaclInstance = require('tweetnacl');
  console.log('[WS-API] tweetnacl carregado com sucesso.');
} catch (e) {
  console.log('[WS-API] tweetnacl não disponível, será usado apenas crypto nativo ou @noble/ed25519 (se disponível).');
}

const priceWebsocketsByAccount = new Map();

function getAllAccountConnections() {
  console.warn("[WEBSOCKETS] getAllAccountConnections pode estar retornando dados incompletos. Use getAccountConnectionState de api.js");
  return priceWebsocketsByAccount;
}

function getPriceWebsockets(accountId, create = false) {
  if (!priceWebsocketsByAccount.has(accountId) && create) {
    priceWebsocketsByAccount.set(accountId, new Map());
  }
  return priceWebsocketsByAccount.get(accountId) || new Map();
}

/**
 * Cria assinatura Ed25519.
 */
async function createEd25519Signature(payload, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiSecret) {
    throw new Error(\`Chave privada Ed25519 (ws_api_secret no formato PEM) não encontrada para conta \${accountId}\`);
  }
  const pemPrivateKey = accountState.wsApiSecret;

  console.log(\`[WS-API] Gerando assinatura Ed25519 para conta \${accountId}\`);
  
  const payloadBuffer = Buffer.from(payload, 'ascii');

  try {
    if (typeof pemPrivateKey !== 'string' || !pemPrivateKey.includes('-----BEGIN PRIVATE KEY-----')) {
        throw new Error('Chave privada não está no formato PEM string esperado.');
    }
    const privateKeyObject = crypto.createPrivateKey({
      key: pemPrivateKey,
      format: 'pem'
    });
    const signatureBuffer = crypto.sign(null, payloadBuffer, privateKeyObject);
    const signature = signatureBuffer.toString('base64');
    console.log(\`[WS-API] ✅ Assinatura Ed25519 criada com crypto nativo para conta \${accountId}\`);
    return signature;
  } catch (nativeCryptoError) {
    console.warn(\`[WS-API] Falha ao assinar com crypto nativo para conta \${accountId}: \${nativeCryptoError.message}\`);
    throw nativeCryptoError;
  }
}

/**
 * Cria uma requisição assinada para a API WebSocket
 */
async function createSignedRequest(method, params = {}, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    console.warn(\`[WS-API] Estado da conta \${accountId} não encontrado em createSignedRequest.\`);
    await api.loadCredentialsFromDatabase(accountId);
    const newState = getAccountConnectionState(accountId);
    if (!newState) {
      throw new Error(\`Estado da conexão não encontrado para conta \${accountId}.\`);
    }
  }
  
  const currentAccountState = getAccountConnectionState(accountId);
  if (!currentAccountState) {
      throw new Error(\`Estado da conexão não encontrado para conta \${accountId}.\`);
  }

  const requestId = uuidv4();
  
  if (method === 'ping' || method === 'pong' || method === 'session.status') {
    return {
      id: requestId,
      method,
      params: params || {}
    };
  }
  
  const requestParams = {
    ...params,
    apiKey: currentAccountState.wsApiKey || currentAccountState.apiKey,
    timestamp: Date.now()
  };
  
  const sortedParams = Object.keys(requestParams)
    .filter(key => key !== 'signature')
    .sort()
    .map(key => \`\${key}=\${requestParams[key]}\`)
    .join('&');
  
  const signature = await createEd25519Signature(sortedParams, accountId);
  requestParams.signature = signature;
  
  return {
    id: requestId,
    method,
    params: requestParams
  };
}

/**
 * Inicia conexão WebSocket API para uma conta
 */
async function startWebSocketApi(accountId) {
  try {
    await api.loadCredentialsFromDatabase(accountId);
    let accountState = getAccountConnectionState(accountId);

    if (!accountState || !accountState.wsApiKey || !accountState.wsApiUrl) {
      console.error(\`[WS-API] Credenciais ou URL da WebSocket API não encontradas para conta \${accountId}\`);
      return false;
    }

    if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
      console.log(\`[WS-API] Conexão WebSocket API já está ativa para conta \${accountId}\`);
      return true;
    }

    console.log(\`[WS-API] Iniciando WebSocket API para conta \${accountId}...\`);
    const endpoint = accountState.wsApiUrl;

    return new Promise((resolve, reject) => {
      const wsInstance = new WebSocket(endpoint);
      accountState.wsApiConnection = wsInstance;

      const connectionTimeout = setTimeout(() => {
        if (wsInstance.readyState !== WebSocket.OPEN) {
          console.error(\`[WS-API] Timeout ao conectar WebSocket API para conta \${accountId}\`);
          wsInstance.terminate();
          reject(new Error(\`Timeout ao conectar WebSocket API para conta \${accountId}\`));
        }
      }, 30000);

      wsInstance.on('open', async () => {
        clearTimeout(connectionTimeout);
        console.log(\`[WS-API] ✅ Conexão WebSocket API estabelecida para conta \${accountId}\`);
        
        try {
          const authenticated = await authenticateWebSocketApi(wsInstance, accountId);
          resolve(authenticated);
        } catch (authError) {
          console.error(\`[WS-API] Erro durante a autenticação para conta \${accountId}:\`, authError.message);
          wsInstance.close(1008, "Authentication Error");
          reject(authError);
        }
      });

      wsInstance.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          handleWebSocketApiMessage(message, accountId);
        } catch (e) {
          console.error('[WS-API] Erro ao parsear mensagem JSON:', e, data.toString().substring(0, 500));
        }
      });

      wsInstance.on('error', (error) => {
        clearTimeout(connectionTimeout);
        console.error(\`[WS-API] Erro na conexão WebSocket API para conta \${accountId}: \${error.message}\`);
        reject(error);
      });

      wsInstance.on('close', (code, reason) => {
        clearTimeout(connectionTimeout);
        console.log(\`[WS-API] Conexão WebSocket API fechada para conta \${accountId}. Code: \${code}\`);
        cleanupWebSocketApi(accountId);
      });
    });

  } catch (error) {
    console.error(\`[WS-API] Erro ao iniciar WebSocket API para conta \${accountId}:\`, error.message);
    return false;
  }
}

/**
 * Processa mensagens recebidas via WebSocket API
 */
function handleWebSocketApiMessage(message, accountId) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState) {
      console.error(\`[WS-API] Estado da conta \${accountId} não encontrado\`);
      return;
    }
    
    if (message.id) {
      const callbackEntry = accountState.wsApiRequestCallbacks.get(message.id);
      if (callbackEntry) {
        if (typeof callbackEntry === 'function') {
          callbackEntry(message);
        } else if (typeof callbackEntry === 'object' && callbackEntry.resolve) {
          clearTimeout(callbackEntry.timer);
          if (message.error) {
            callbackEntry.reject(message);
          } else {
            callbackEntry.resolve(message);
          }
        }
        accountState.wsApiRequestCallbacks.delete(message.id);
      }
    } else if (message.method === 'ping') {
      console.log(\`[WS-API] Ping recebido do servidor para conta \${accountId}\`);
      sendPong(message.id, accountId); 
    } else if (message.method === 'pong') {
      console.log(\`[WS-API] Pong recebido do servidor para conta \${accountId}\`);
      accountState.lastPongTime = Date.now();
    }
  } catch (error) {
    console.error(\`[WS-API] Erro ao processar mensagem para conta \${accountId}:\`, error.message);
  }
}

/**
 * Limpa recursos do WebSocket API
 */
function cleanupWebSocketApi(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) return;

  if (accountState.pingInterval) {
    clearInterval(accountState.pingInterval);
    accountState.pingInterval = null;
  }

  const wsConn = accountState.wsApiConnection;
  if (wsConn) {
    wsConn.removeAllListeners();
    if (wsConn.readyState === WebSocket.OPEN || wsConn.readyState === WebSocket.CONNECTING) {
      try {
        wsConn.terminate();
      } catch (e) {
        console.warn(\`[WS-API] Erro ao terminar conexão para conta \${accountId}: \${e.message}\`);
      }
    }
  }
  accountState.wsApiConnection = null;
  accountState.wsApiAuthenticated = false;
  
  if (accountState.wsApiRequestCallbacks) {
    accountState.wsApiRequestCallbacks.clear();
  }
}

/**
 * Envia pong em resposta a ping
 */
function sendPong(pingId, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiConnection) {
    return;
  }
  
  try {
    const pongRequest = { method: 'pong' };
    if (pingId) pongRequest.id = pingId;
    accountState.wsApiConnection.send(JSON.stringify(pongRequest));
  } catch (error) {
    console.error(\`[WS-API] Erro ao enviar pong para conta \${accountId}:\`, error);
  }
}

/**
 * Verifica o status da sessão
 */
async function checkSessionStatus(accountId) {
  try {
    const request = await createSignedRequest('session.status', {}, accountId);
    const response = await sendWebSocketApiRequest(request, 30000, accountId);
    
    const accountState = getAccountConnectionState(accountId, true);
    if (response && response.result) {
      accountState.wsApiAuthenticated = response.result.apiKey !== null;
    } else {
      accountState.wsApiAuthenticated = false;
    }
    
    return response;
  } catch (error) {
    console.error(\`[WS-API] Erro ao verificar status da sessão para conta \${accountId}:\`, error.message);
    return null;
  }
}

/**
 * Autentica na WebSocket API
 */
async function authenticateWebSocketApi(ws, accountId) {
  try {
    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.wsApiKey || !accountState.wsApiSecret) {
      throw new Error(\`Credenciais WebSocket incompletas para conta \${accountId}\`);
    }

    console.log(\`[WS-API] Iniciando autenticação para conta \${accountId}...\`);

    const timestamp = Date.now();
    const authParams = {
      apiKey: accountState.wsApiKey,
      timestamp: timestamp
    };

    const sortedKeys = Object.keys(authParams).sort();
    const payload = sortedKeys.map(key => \`\${key}=\${authParams[key]}\`).join('&');
    const signature = await createEd25519Signature(payload, accountId);

    const authRequest = {
      id: \`auth-\${timestamp}-\${accountId}\`,
      method: 'session.logon',
      params: {
        apiKey: authParams.apiKey,
        signature: signature,
        timestamp: authParams.timestamp
      }
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(\`Timeout na autenticação WebSocket API\`));
      }, 30000);

      accountState.wsApiRequestCallbacks.set(authRequest.id, (responseMessage) => {
        clearTimeout(timeoutId);
        
        if (responseMessage.status === 200 && responseMessage.result) {
          console.log(\`[WS-API] ✅ Autenticação bem-sucedida para conta \${accountId}\`);
          accountState.wsApiAuthenticated = true;
          resolve(true);
        } else {
          const errorMsg = responseMessage.error?.msg || 'Erro na autenticação';
          console.error(\`[WS-API] Falha na autenticação para conta \${accountId}:\`, errorMsg);
          reject(new Error(\`Falha na autenticação: \${errorMsg}\`));
        }
      });

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(authRequest));
      } else {
        clearTimeout(timeoutId);
        accountState.wsApiRequestCallbacks.delete(authRequest.id);
        reject(new Error('WebSocket não está aberto para autenticação.'));
      }
    });

  } catch (error) {
    console.error(\`[WS-API] Erro na autenticação para conta \${accountId}:\`, error.message);
    throw error;
  }
}

/**
 * Envia requisição via WebSocket API
 */
async function sendWebSocketApiRequest(request, timeout = 30000, accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState || !accountState.wsApiConnection) {
    throw new Error(\`WebSocket API não conectado para conta \${accountId}\`);
  }

  const requestId = request.id || uuidv4();
  request.id = requestId;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      accountState.wsApiRequestCallbacks.delete(requestId);
      reject(new Error(\`Timeout para requisição \${requestId}\`));
    }, timeout);

    accountState.wsApiRequestCallbacks.set(requestId, { resolve, reject, timer });

    try {
      if (accountState.wsApiConnection.readyState === WebSocket.OPEN) {
        accountState.wsApiConnection.send(JSON.stringify(request));
      } else {
        clearTimeout(timer);
        accountState.wsApiRequestCallbacks.delete(requestId);
        reject(new Error('WebSocket connection closed'));
      }
    } catch (error) {
      clearTimeout(timer);
      accountState.wsApiRequestCallbacks.delete(requestId);
      reject(error);
    }
  });
}

/**
 * Garante que existe um websocket de preço para o símbolo
 */
async function ensurePriceWebsocketExists(symbol, accountId) {
  const priceWebsockets = getPriceWebsockets(accountId, true);
  
  if (priceWebsockets.has(symbol) && priceWebsockets.get(symbol).readyState === WebSocket.OPEN) {
    return;
  }

  const accountState = getAccountConnectionState(accountId, true);
  if (!accountState.wsUrl) {
    await api.loadCredentialsFromDatabase(accountId);
  }
  
  const updatedAccountState = getAccountConnectionState(accountId);
  if (!updatedAccountState || !updatedAccountState.wsUrl) {
      console.error(\`[WEBSOCKET] URL de mercado não encontrada para conta \${accountId}\`);
      return;
  }

  console.log(\`[WEBSOCKET] Iniciando monitoramento de preço para \${symbol} (conta \${accountId})\`);

  const wsEndpointUrl = \`\${updatedAccountState.wsUrl}/ws/\${symbol.toLowerCase()}@bookTicker\`;
  const ws = new WebSocket(wsEndpointUrl);

  ws.on('open', () => {
    console.log(\`[WEBSOCKET] Conexão de preço aberta para \${symbol} (conta \${accountId})\`);
  });

  ws.on('message', async (data) => {
    try {
      const tickerData = JSON.parse(data);
      await handlePriceUpdate(symbol, tickerData, accountId);
    } catch (error) {
      console.error(\`[WEBSOCKET] Erro ao processar dados de preço para \${symbol}:\`, error);
    }
  });

  ws.on('error', (error) => {
    console.error(\`[WEBSOCKET] Erro na conexão de preço para \${symbol}:\`, error.message);
  });

  ws.on('close', () => {
    console.log(\`[WEBSOCKET] Conexão de preço fechada para \${symbol}\`);
  });

  priceWebsockets.set(symbol, ws);
}

/**
 * Processa atualizações de preço
 */
async function handlePriceUpdate(symbol, tickerData, accountId) {
  try {
    const accountState = getAccountConnectionState(accountId, true);
    let db = accountState.dbInstance;
    
    if (!db) {
      try {
        db = await getDatabaseInstance(accountId);
        accountState.dbInstance = db;
      } catch (dbError) {
        console.error(\`[WEBSOCKETS] Erro ao obter DB para \${symbol}:\`, dbError.message);
        return;
      }
    }

    const bestBid = parseFloat(tickerData.b);
    const bestAsk = parseFloat(tickerData.a);
    const currentPrice = (bestBid + bestAsk) / 2;

    if (accountState.monitoringCallbacks && accountState.monitoringCallbacks.onPriceUpdate) {
      await accountState.monitoringCallbacks.onPriceUpdate(symbol, currentPrice, db, accountId);
    }
  } catch (error) {
    console.error(\`[WEBSOCKETS] Erro ao processar atualização de preço:\`, error);
  }
}

/**
 * Configura websocket para BookTicker
 */
function setupBookDepthWebsocket(symbol, callback, accountId) {
  const accountState = getAccountConnectionState(accountId, true);
  const wsEndpoint = \`\${accountState.wsUrl}/\${symbol.toLowerCase()}@bookTicker\`;
  
  const ws = new WebSocket(wsEndpoint);
  
  ws.on('open', () => {
    console.log(\`[WEBSOCKET] BookTicker conectado para \${symbol}\`);
  });
  
  ws.on('message', (data) => {
    try {
      const tickerData = JSON.parse(data);
      if (tickerData && tickerData.b && tickerData.a) {
        const bestBid = parseFloat(tickerData.b);
        const bestAsk = parseFloat(tickerData.a);
        
        if (!isNaN(bestBid) && !isNaN(bestAsk)) {
          callback({
            bestBid, 
            bestAsk,
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
}

/**
 * Para o monitoramento de preço
 */
function stopPriceMonitoring(symbol, accountId) {
  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets && priceWebsockets.has(symbol)) {
    priceWebsockets.get(symbol).close();
    priceWebsockets.delete(symbol);
    return true;
  }
  return false;
}

/**
 * Inicia stream de dados do usuário
 */
async function startUserDataStream(db, accountId) {
  try {
    const listenKey = await api.getListenKey(accountId);
    if (!listenKey) {
      throw new Error(\`Falha ao obter ListenKey para conta \${accountId}\`);
    }

    const accountState = getAccountConnectionState(accountId, true);
    const userDataEndpoint = \`\${accountState.wsUrl}/ws/\${listenKey}\`;
    
    const ws = new WebSocket(userDataEndpoint);
    accountState.userDataStream = ws;

    ws.on('open', () => {
      console.log(\`[WEBSOCKET] UserDataStream conectado para conta \${accountId}\`);
    });

    ws.on('message', async (data) => {
      try {
        await handleUserDataMessage(data, accountId, db);
      } catch (e) {
        console.error(\`[WEBSOCKET] Erro no UserDataStream:\`, e.message);
      }
    });

    ws.on('error', (error) => {
      console.error(\`[WEBSOCKET] Erro no UserDataStream:\`, error.message);
    });

    ws.on('close', () => {
      console.log(\`[WEBSOCKET] UserDataStream fechado para conta \${accountId}\`);
    });

  } catch (error) {
    console.error(\`[WEBSOCKETS] Erro ao iniciar UserDataStream:\`, error.message);
    throw error;
  }
}

/**
 * Processa mensagens do UserDataStream
 */
async function handleUserDataMessage(jsonData, accountId, db) {
  try {
    const message = JSON.parse(jsonData.toString());
    const accountState = getAccountConnectionState(accountId);
    
    if (!accountState || !accountState.monitoringCallbacks) {
      return;
    }

    const { handleOrderUpdate, handleAccountUpdate } = accountState.monitoringCallbacks;

    if (message.e) {
      switch (message.e) {
        case 'ORDER_TRADE_UPDATE':
          if (handleOrderUpdate) {
            await handleOrderUpdate(message, db);
          }
          break;
        case 'ACCOUNT_UPDATE':
          if (handleAccountUpdate) {
            await handleAccountUpdate(message, db);
          }
          break;
      }
    }
  } catch (error) {
    console.error(\`[WEBSOCKET] Erro ao processar UserDataStream:\`, error.message);
  }
}

/**
 * Para o UserDataStream
 */
function stopUserDataStream(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (accountState && accountState.userDataStream) {
    accountState.userDataStream.close();
    accountState.userDataStream = null;
  }
}

/**
 * Define callbacks de monitoramento
 */
function setMonitoringCallbacks(callbackHandlers, accountId) {
  const accountState = getAccountConnectionState(accountId, true);
  accountState.monitoringCallbacks = { ...accountState.monitoringCallbacks, ...callbackHandlers };
  return accountState.monitoringCallbacks;
}

/**
 * Obtém handlers
 */
function getHandlers(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState ? accountState.monitoringCallbacks : {};
}

/**
 * Obtém credenciais
 */
function getCredentials(accountId) {
  const accountState = getAccountConnectionState(accountId);
  if (!accountState) {
    return null;
  }
  
  return {
    accountId: accountState.accountId,
    apiKey: accountState.apiKey,
    secretKey: accountState.secretKey,
    wsApiKey: accountState.wsApiKey,
    wsApiSecret: accountState.wsApiSecret,
    apiUrl: accountState.apiUrl,
    wsUrl: accountState.wsUrl,
    wsApiUrl: accountState.wsApiUrl
  };
}

/**
 * Garante que WebSocket API existe
 */
async function ensureWebSocketApiExists(accountId) {
  try {
    let accountState = getAccountConnectionState(accountId);
    
    if (!accountState || !accountState.wsApiKey) {
      await api.loadCredentialsFromDatabase(accountId);
      accountState = getAccountConnectionState(accountId);
      
      if (!accountState || !accountState.wsApiKey) {
        return false;
      }
    }

    if (accountState.wsApiConnection && accountState.wsApiConnection.readyState === WebSocket.OPEN) {
      return accountState.wsApiAuthenticated;
    }

    return await startWebSocketApi(accountId);
    
  } catch (error) {
    console.error(\`[WEBSOCKETS] Erro ao garantir WebSocket API:\`, error.message);
    return false;
  }
}

/**
 * Verifica se WebSocket API está conectado
 */
function isWebSocketApiConnected(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState && 
         accountState.wsApiConnection && 
         accountState.wsApiConnection.readyState === WebSocket.OPEN;
}

/**
 * Verifica se WebSocket API está autenticado
 */
function isWebSocketApiAuthenticated(accountId) {
  const accountState = getAccountConnectionState(accountId);
  return accountState && accountState.wsApiAuthenticated === true;
}

/**
 * Reset
 */
function reset(accountId) {
  cleanupWebSocketApi(accountId);
  stopUserDataStream(accountId);
  const priceWebsockets = getPriceWebsockets(accountId);
  if (priceWebsockets) {
    for (const [symbol, ws] of priceWebsockets.entries()) {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
      }
    }
    priceWebsockets.clear();
  }
}

/**
 * Limpeza completa da conta
 */
function forceCleanupAccount(accountId) {
  console.log(\`[WEBSOCKET] Limpeza completa para conta \${accountId}...\`);
  reset(accountId);
}

module.exports = {
  startUserDataStream,
  setupBookDepthWebsocket,
  ensurePriceWebsocketExists,
  stopPriceMonitoring,
  reset,
  startWebSocketApi,
  authenticateWebSocketApi,
  sendWebSocketApiRequest,
  createSignedRequest,
  checkSessionStatus,
  cleanupWebSocketApi,
  isWebSocketApiAuthenticated,
  isWebSocketApiConnected,
  setMonitoringCallbacks,
  getHandlers,
  getCredentials,
  ensureWebSocketApiExists,
  getAllAccountConnections,
  handleWebSocketApiMessage,
  createEd25519Signature,
  forceCleanupAccount,
  loadNobleEd25519,
};`;

  fs.writeFileSync(websocketsPath, cleanWebsocketsContent, 'utf8');
  console.log('✅ websockets.js recriado com sintaxe limpa');
  return true;
}

// Executar análise e correções
console.log('🔍 ANÁLISE COMPLETA DE SINTAXE\n');

const files = [
  { path: path.join(__dirname, 'websockets.js'), name: 'websockets.js' },
  { path: path.join(__dirname, 'api.js'), name: 'api.js' },
  { path: path.join(__dirname, 'websocketApi.js'), name: 'websocketApi.js' },
  { path: path.join(__dirname, 'posicoes', 'monitoramento.js'), name: 'monitoramento.js' }
];

let hasErrors = false;

for (const file of files) {
  const result = analyzeSyntax(file.path, file.name);
  if (!result.valid) {
    hasErrors = true;
  }
}

if (hasErrors) {
  console.log('\n🔧 APLICANDO CORREÇÕES...\n');
  
  // Corrigir websockets.js (principal problema)
  if (!fixWebsocketsJs()) {
    console.log('🔧 Tentativa de correção automática falhou, criando arquivo limpo...');
    createCleanWebsocketsJs();
  }
  
  console.log('\n✅ CORREÇÕES APLICADAS');
} else {
  console.log('\n✅ Todos os arquivos parecem ter sintaxe correta');
}

console.log('\n🚀 Teste agora:');
console.log('   node posicoes/monitoramento.js --account 1');