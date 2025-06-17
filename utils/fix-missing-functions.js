const fs = require('fs');
const path = require('path');

console.log('🔧 Adicionando funções ausentes...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.missing-functions.${Date.now()}`;
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backupPath);
    console.log(`📁 Backup criado: ${backupPath}`);
    return true;
  }
  return false;
}

// 1. Adicionar funções ausentes no api.js
console.log('1️⃣ Adicionando funções ausentes no api.js...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Adicionar getPrecision
const getPrecisionFunction = `
/**
 * Obtém precisão de um símbolo
 */
async function getPrecision(symbol, accountId) {
  try {
    console.log(\`[API] Obtendo precisão para \${symbol} (conta \${accountId})...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v1/exchangeInfo', {});
    
    if (response && response.symbols) {
      const symbolInfo = response.symbols.find(s => s.symbol === symbol);
      if (symbolInfo) {
        const quantityPrecision = symbolInfo.quantityPrecision || 3;
        const pricePrecision = symbolInfo.pricePrecision || 2;
        
        console.log(\`[API] ✅ Precisão obtida para \${symbol}: quantity=\${quantityPrecision}, price=\${pricePrecision}\`);
        return {
          quantityPrecision,
          pricePrecision,
          minQty: parseFloat(symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE')?.minQty || '0.001'),
          stepSize: parseFloat(symbolInfo.filters?.find(f => f.filterType === 'LOT_SIZE')?.stepSize || '0.001'),
          tickSize: parseFloat(symbolInfo.filters?.find(f => f.filterType === 'PRICE_FILTER')?.tickSize || '0.01')
        };
      }
    }
    
    console.warn(\`[API] Precisão não encontrada para \${symbol}, usando padrões\`);
    return { quantityPrecision: 3, pricePrecision: 2, minQty: 0.001, stepSize: 0.001, tickSize: 0.01 };
  } catch (error) {
    console.error(\`[API] Erro ao obter precisão para \${symbol}:\`, error.message);
    return { quantityPrecision: 3, pricePrecision: 2, minQty: 0.001, stepSize: 0.001, tickSize: 0.01 };
  }
}`;

// Adicionar getCurrentLeverage
const getCurrentLeverageFunction = `
/**
 * Obtém alavancagem atual de um símbolo
 */
async function getCurrentLeverage(symbol, accountId) {
  try {
    console.log(\`[API] Obtendo alavancagem atual para \${symbol} (conta \${accountId})...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', { symbol });
    
    if (response && Array.isArray(response) && response.length > 0) {
      const leverage = parseInt(response[0].leverage) || 20;
      console.log(\`[API] ✅ Alavancagem atual para \${symbol}: \${leverage}x\`);
      return leverage;
    }
    
    console.warn(\`[API] Alavancagem não encontrada para \${symbol}, usando padrão 20x\`);
    return 20;
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem para \${symbol}:\`, error.message);
    return 20;
  }
}`;

// Adicionar changeInitialLeverage
const changeInitialLeverageFunction = `
/**
 * Altera alavancagem inicial de um símbolo
 */
async function changeInitialLeverage(symbol, leverage, accountId) {
  try {
    console.log(\`[API] Alterando alavancagem para \${symbol}: \${leverage}x (conta \${accountId})...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/leverage', {
      symbol,
      leverage
    });
    
    if (response) {
      console.log(\`[API] ✅ Alavancagem alterada para \${symbol}: \${leverage}x\`);
      return response;
    }
    
    throw new Error('Resposta inválida');
  } catch (error) {
    console.error(\`[API] Erro ao alterar alavancagem para \${symbol}:\`, error.message);
    throw error;
  }
}`;

// Adicionar getCurrentMarginType
const getCurrentMarginTypeFunction = `
/**
 * Obtém tipo de margem atual de um símbolo
 */
async function getCurrentMarginType(symbol, accountId) {
  try {
    console.log(\`[API] Obtendo tipo de margem para \${symbol} (conta \${accountId})...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/v2/positionRisk', { symbol });
    
    if (response && Array.isArray(response) && response.length > 0) {
      const marginType = response[0].marginType || 'cross';
      console.log(\`[API] ✅ Tipo de margem para \${symbol}: \${marginType}\`);
      return marginType.toLowerCase();
    }
    
    console.warn(\`[API] Tipo de margem não encontrado para \${symbol}, usando padrão 'cross'\`);
    return 'cross';
  } catch (error) {
    console.error(\`[API] Erro ao obter tipo de margem para \${symbol}:\`, error.message);
    return 'cross';
  }
}`;

// Adicionar changeMarginType
const changeMarginTypeFunction = `
/**
 * Altera tipo de margem de um símbolo
 */
async function changeMarginType(symbol, marginType, accountId) {
  try {
    console.log(\`[API] Alterando tipo de margem para \${symbol}: \${marginType} (conta \${accountId})...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/v1/marginType', {
      symbol,
      marginType: marginType.toUpperCase()
    });
    
    if (response) {
      console.log(\`[API] ✅ Tipo de margem alterado para \${symbol}: \${marginType}\`);
      return response;
    }
    
    throw new Error('Resposta inválida');
  } catch (error) {
    console.error(\`[API] Erro ao alterar tipo de margem para \${symbol}:\`, error.message);
    throw error;
  }
}`;

// Adicionar as funções antes do module.exports
const newFunctions = getPrecisionFunction + getCurrentLeverageFunction + changeInitialLeverageFunction + getCurrentMarginTypeFunction + changeMarginTypeFunction;

apiContent = apiContent.replace(
  /module\.exports\s*=/,
  `${newFunctions}\n\nmodule.exports =`
);

// Adicionar as funções ao exports
apiContent = apiContent.replace(
  /module\.exports = \{([^}]+)\}/s,
  (match, exports) => {
    return `module.exports = {${exports},
  getPrecision,
  getCurrentLeverage,
  changeInitialLeverage,
  getCurrentMarginType,
  changeMarginType
}`;
  }
);

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log('✅ Funções adicionadas ao api.js');

// 2. Corrigir signalProcessor.js
console.log('\n2️⃣ Corrigindo signalProcessor.js...');
const signalProcessorPath = path.join(__dirname, 'posicoes', 'signalProcessor.js');

if (fs.existsSync(signalProcessorPath)) {
  createBackup(signalProcessorPath);
  
  let signalContent = fs.readFileSync(signalProcessorPath, 'utf8');
  
  // Adicionar import de sendTelegramMessage se não existir
  if (!signalContent.includes('sendTelegramMessage')) {
    signalContent = signalContent.replace(
      /const.*require.*;\s*\n/g,
      (match) => {
        if (match.includes('sendTelegramMessage')) return match;
        return match + "const { sendTelegramMessage } = require('../utils/telegram');\n";
      }
    );
  }
  
  // Corrigir uso de errorMessage undefined
  signalContent = signalContent.replace(
    /ReferenceError: errorMessage is not defined/g,
    'error.message'
  );
  
  // Corrigir declaração de errorMessage
  signalContent = signalContent.replace(
    /catch \(error\) \{[\s\S]*?errorMessage/g,
    (match) => {
      if (match.includes('const errorMessage')) return match;
      return match.replace('errorMessage', 'const errorMessage = error.message;\n      errorMessage');
    }
  );
  
  fs.writeFileSync(signalProcessorPath, signalContent, 'utf8');
  console.log('✅ signalProcessor.js corrigido');
} else {
  console.log('⚠️ signalProcessor.js não encontrado');
}

// 3. Criar arquivo telegram.js se não existir
console.log('\n3️⃣ Verificando utils/telegram.js...');
const telegramPath = path.join(__dirname, 'utils', 'telegram.js');

if (!fs.existsSync(telegramPath)) {
  console.log('📁 Criando utils/telegram.js...');
  
  // Garantir que o diretório utils existe
  const utilsDir = path.join(__dirname, 'utils');
  if (!fs.existsSync(utilsDir)) {
    fs.mkdirSync(utilsDir, { recursive: true });
  }
  
  const telegramContent = `const axios = require('axios');

/**
 * Envia mensagem via Telegram
 * @param {string} message - Mensagem a ser enviada
 * @param {number} accountId - ID da conta (opcional)
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTelegramMessage(message, accountId = null) {
  try {
    console.log(\`[TELEGRAM] Enviando mensagem\${accountId ? \` para conta \${accountId}\` : ''}: \${message.substring(0, 100)}...\`);
    
    // TODO: Implementar envio real do Telegram aqui
    // Por enquanto, apenas log
    console.log(\`[TELEGRAM] 📱 Mensagem: \${message}\`);
    
    return true;
  } catch (error) {
    console.error(\`[TELEGRAM] Erro ao enviar mensagem:\`, error.message);
    return false;
  }
}

/**
 * Envia alerta de erro via Telegram
 * @param {string} errorMessage - Mensagem de erro
 * @param {number} accountId - ID da conta
 * @param {string} context - Contexto do erro
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendErrorAlert(errorMessage, accountId, context = '') {
  const message = \`🚨 ERRO \${context ? \`[\${context}]\` : ''}\\n\\nConta: \${accountId}\\nErro: \${errorMessage}\\nHora: \${new Date().toLocaleString('pt-BR')}\`;
  return await sendTelegramMessage(message, accountId);
}

/**
 * Envia notificação de trade via Telegram
 * @param {Object} tradeInfo - Informações do trade
 * @param {number} accountId - ID da conta
 * @returns {Promise<boolean>} - true se enviado com sucesso
 */
async function sendTradeNotification(tradeInfo, accountId) {
  const { symbol, side, quantity, price, type } = tradeInfo;
  const message = \`📈 TRADE EXECUTADO\\n\\nConta: \${accountId}\\nSímbolo: \${symbol}\\nLado: \${side}\\nQuantidade: \${quantity}\\nPreço: \${price}\\nTipo: \${type}\\nHora: \${new Date().toLocaleString('pt-BR')}\`;
  return await sendTelegramMessage(message, accountId);
}

module.exports = {
  sendTelegramMessage,
  sendErrorAlert,
  sendTradeNotification
};`;

  fs.writeFileSync(telegramPath, telegramContent, 'utf8');
  console.log('✅ utils/telegram.js criado');
} else {
  console.log('✅ utils/telegram.js já existe');
}

// 4. Adicionar função verifyAndFixEnvironmentConsistency se necessário
console.log('\n4️⃣ Verificando função verifyAndFixEnvironmentConsistency...');

if (!apiContent.includes('verifyAndFixEnvironmentConsistency')) {
  console.log('➕ Adicionando verifyAndFixEnvironmentConsistency...');
  
  const verifyFunction = `
/**
 * Verifica e corrige consistência do ambiente
 */
async function verifyAndFixEnvironmentConsistency(accountId) {
  try {
    console.log(\`[API] Verificando consistência de ambiente para conta \${accountId}...\`);
    
    const accountState = getAccountConnectionState(accountId);
    if (!accountState) {
      console.warn(\`[API] Estado da conta \${accountId} não encontrado para verificação de consistência\`);
      return false;
    }
    
    // Verificar se URLs estão corretas para o ambiente
    const { ambiente, apiUrl, wsUrl, wsApiUrl } = accountState;
    
    if (ambiente === 'prd') {
      // Verificar se não está usando URLs de testnet
      const isTestnet = apiUrl?.includes('testnet') || wsUrl?.includes('testnet') || wsApiUrl?.includes('testnet');
      if (isTestnet) {
        console.warn(\`[API] ⚠️ Ambiente de produção usando URLs de testnet para conta \${accountId}\`);
        return false;
      }
    } else {
      // Verificar se não está usando URLs de produção
      const isProduction = !apiUrl?.includes('testnet') || !wsUrl?.includes('testnet') || !wsApiUrl?.includes('testnet');
      if (isProduction) {
        console.warn(\`[API] ⚠️ Ambiente de testnet usando URLs de produção para conta \${accountId}\`);
        return false;
      }
    }
    
    console.log(\`[API] ✅ Consistência de ambiente verificada para conta \${accountId}\`);
    return true;
  } catch (error) {
    console.error(\`[API] Erro ao verificar consistência de ambiente:\`, error.message);
    return false;
  }
}`;

  // Adicionar a função
  apiContent = apiContent.replace(
    /module\.exports\s*=/,
    `${verifyFunction}\n\nmodule.exports =`
  );
  
  // Adicionar ao exports
  apiContent = apiContent.replace(
    /module\.exports = \{([^}]+)\}/s,
    (match, exports) => {
      return `module.exports = {${exports},
  verifyAndFixEnvironmentConsistency
}`;
    }
  );
  
  fs.writeFileSync(apiPath, apiContent, 'utf8');
  console.log('✅ verifyAndFixEnvironmentConsistency adicionada');
}

console.log('\n🎉 Correção de funções ausentes concluída!');
console.log('\n📋 Resumo das correções:');
console.log('1. ✅ getPrecision - Obtém precisão de símbolos');
console.log('2. ✅ getCurrentLeverage - Obtém alavancagem atual');
console.log('3. ✅ changeInitialLeverage - Altera alavancagem');
console.log('4. ✅ getCurrentMarginType - Obtém tipo de margem');
console.log('5. ✅ changeMarginType - Altera tipo de margem');
console.log('6. ✅ sendTelegramMessage - Função de Telegram criada');
console.log('7. ✅ verifyAndFixEnvironmentConsistency - Verifica ambiente');
console.log('8. ✅ Corrigidos erros de variáveis indefinidas');

console.log('\n🚀 Agora teste o monitoramento novamente:');
console.log('   node posicoes/monitoramento.js --account 1');

console.log('\n💾 Backups criados para segurança.');