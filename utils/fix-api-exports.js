const fs = require('fs');
const path = require('path');

console.log('🔧 Corrigindo exports do api.js...\n');

// Função para fazer backup
function createBackup(filePath) {
  const backupPath = `${filePath}.backup.exports.${Date.now()}`;
  fs.copyFileSync(filePath, backupPath);
  console.log(`📁 Backup criado: ${backupPath}`);
}

// Corrigir api.js
console.log('1️⃣ Analisando e corrigindo api.js...');
const apiPath = path.join(__dirname, 'api.js');
createBackup(apiPath);

let apiContent = fs.readFileSync(apiPath, 'utf8');

// Primeiro, vamos identificar todas as funções que estão sendo exportadas mas não definidas
const exportedFunctions = [];
const definedFunctions = [];

// Extrair funções do module.exports
const moduleExportsMatch = apiContent.match(/module\.exports\s*=\s*\{([^}]+)\}/s);
if (moduleExportsMatch) {
  const exportsContent = moduleExportsMatch[1];
  const exports = exportsContent.split(',').map(item => item.trim().split(':')[0].trim()).filter(item => item && !item.startsWith('//'));
  exportedFunctions.push(...exports);
}

// Extrair funções definidas
const functionMatches = apiContent.matchAll(/(?:async\s+)?function\s+(\w+)\s*\(/g);
for (const match of functionMatches) {
  definedFunctions.push(match[1]);
}

console.log(`📊 Funções exportadas: ${exportedFunctions.length}`);
console.log(`📊 Funções definidas: ${definedFunctions.length}`);

// Identificar funções faltantes
const missingFunctions = exportedFunctions.filter(exported => !definedFunctions.includes(exported));
console.log(`❌ Funções faltantes: ${missingFunctions.join(', ')}`);

// Adicionar funções faltantes básicas
const missingFunctionImplementations = {
  'getAccountInfo': `
/**
 * Obtém informações da conta
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações da conta
 */
async function getAccountInfo(accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v2/account', {});
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao obter informações da conta \${accountId}:\`, error.message);
    throw error;
  }
}`,

  'getPrice': `
/**
 * Obtém o preço atual de um símbolo
 * @param {string} symbol - Símbolo do ativo
 * @param {number} accountId - ID da conta
 * @returns {Promise<number|null>} - Preço atual ou null em caso de erro
 */
async function getPrice(symbol, accountId) {
  try {
    console.log(\`[API_GETPRICE_DEBUG] getPrice - symbol: \${symbol}, accountId: \${accountId}, tipo accountId: \${typeof accountId}\`);
    
    if (!symbol || typeof symbol !== 'string') {
      throw new Error(\`Símbolo inválido: \${symbol}\`);
    }
    
    if (!accountId || typeof accountId !== 'number') {
      throw new Error(\`AccountId deve ser um número válido: \${accountId} (tipo: \${typeof accountId})\`);
    }

    const accountState = getAccountConnectionState(accountId);
    if (!accountState || !accountState.apiUrl) {
      console.warn(\`[API] Estado da conta \${accountId} não encontrado, tentando carregar credenciais...\`);
      await loadCredentialsFromDatabase(accountId);
      const newState = getAccountConnectionState(accountId);
      if (!newState || !newState.apiUrl) {
        throw new Error(\`Não foi possível obter URL da API para conta \${accountId}\`);
      }
    }

    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v1/ticker/price', { symbol });
    
    if (response && response.price) {
      const price = parseFloat(response.price);
      if (isNaN(price) || price <= 0) {
        console.error(\`[API] Preço inválido recebido para \${symbol}: \${response.price}\`);
        return null;
      }
      return price;
    } else {
      console.error(\`[API] Resposta inválida ao obter preço para \${symbol}:\`, response);
      return null;
    }
  } catch (error) {
    console.error(\`[API] Erro ao obter preço para \${symbol} (conta \${accountId}):\`, error.message);
    return null;
  }
}`,

  'getAllOpenPositions': `
/**
 * Obtém todas as posições abertas
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Array de posições abertas
 */
async function getAllOpenPositions(accountId) {
  try {
    console.log(\`[API] Obtendo posições abertas para conta \${accountId}...\`);
    
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v2/positionRisk', {});
    
    if (!Array.isArray(response)) {
      console.error(\`[API] Resposta inválida ao obter posições para conta \${accountId}:\`, response);
      return [];
    }

    const openPositions = response
      .filter(pos => parseFloat(pos.positionAmt) !== 0)
      .map(pos => ({
        simbolo: pos.symbol,
        quantidade: Math.abs(parseFloat(pos.positionAmt)),
        lado: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
        precoEntrada: parseFloat(pos.entryPrice),
        precoAtual: parseFloat(pos.markPrice),
        alavancagem: parseInt(pos.leverage) || 1,
        pnlNaoRealizado: parseFloat(pos.unRealizedProfit),
        margem: parseFloat(pos.isolatedMargin),
        tipo: pos.marginType === 'isolated' ? 'ISOLATED' : 'CROSS'
      }));

    console.log(\`[API] ✅ \${openPositions.length} posições abertas encontradas para conta \${accountId}\`);
    return openPositions;
  } catch (error) {
    console.error(\`[API] Erro ao obter posições abertas para conta \${accountId}:\`, error.message);
    throw error;
  }
}`,

  'getSymbolInfo': `
/**
 * Obtém informações de um símbolo
 * @param {string} symbol - Símbolo do ativo
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object|null>} - Informações do símbolo
 */
async function getSymbolInfo(symbol, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'GET', '/fapi/v1/exchangeInfo', {});
    
    if (response && response.symbols) {
      const symbolInfo = response.symbols.find(s => s.symbol === symbol);
      return symbolInfo || null;
    }
    
    return null;
  } catch (error) {
    console.error(\`[API] Erro ao obter informações do símbolo \${symbol}:\`, error.message);
    return null;
  }
}`,

  'getPrecision': `
/**
 * Obtém a precisão de um símbolo
 * @param {string} symbol - Símbolo do ativo
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Precisões do símbolo
 */
async function getPrecision(symbol, accountId) {
  try {
    const symbolInfo = await getSymbolInfo(symbol, accountId);
    
    if (!symbolInfo) {
      return { price: 2, quantity: 3 }; // Valores padrão
    }

    const priceFilter = symbolInfo.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');

    const pricePrecision = priceFilter ? -Math.log10(parseFloat(priceFilter.tickSize)) : 2;
    const quantityPrecision = lotSizeFilter ? -Math.log10(parseFloat(lotSizeFilter.stepSize)) : 3;

    return {
      price: Math.max(0, Math.min(8, pricePrecision)),
      quantity: Math.max(0, Math.min(8, quantityPrecision))
    };
  } catch (error) {
    console.error(\`[API] Erro ao obter precisão para \${symbol}:\`, error.message);
    return { price: 2, quantity: 3 };
  }
}`,

  'changeInitialLeverage': `
/**
 * Altera a alavancagem inicial
 * @param {string} symbol - Símbolo do ativo
 * @param {number} leverage - Nova alavancagem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da operação
 */
async function changeInitialLeverage(symbol, leverage, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/leverage', {
      symbol,
      leverage
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar alavancagem para \${symbol}:\`, error.message);
    throw error;
  }
}`,

  'changeMarginType': `
/**
 * Altera o tipo de margem
 * @param {string} symbol - Símbolo do ativo
 * @param {string} marginType - Tipo de margem (ISOLATED ou CROSSED)
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da operação
 */
async function changeMarginType(symbol, marginType, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/marginType', {
      symbol,
      marginType
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao alterar tipo de margem para \${symbol}:\`, error.message);
    throw error;
  }
}`,

  'createOrder': `
/**
 * Cria uma nova ordem
 * @param {Object} orderParams - Parâmetros da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado da ordem
 */
async function createOrder(orderParams, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'POST', '/fapi/v1/order', orderParams);
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao criar ordem:\`, error.message);
    throw error;
  }
}`,

  'cancelOrder': `
/**
 * Cancela uma ordem
 * @param {string} symbol - Símbolo do ativo
 * @param {string} orderId - ID da ordem
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Resultado do cancelamento
 */
async function cancelOrder(symbol, orderId, accountId) {
  try {
    const response = await makeAuthenticatedRequest(accountId, 'DELETE', '/fapi/v1/order', {
      symbol,
      orderId
    });
    return response;
  } catch (error) {
    console.error(\`[API] Erro ao cancelar ordem \${orderId}:\`, error.message);
    throw error;
  }
}`,

  'getCurrentLeverage': `
/**
 * Obtém a alavancagem atual de um símbolo
 * @param {string} symbol - Símbolo do ativo
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Alavancagem atual
 */
async function getCurrentLeverage(symbol, accountId) {
  try {
    const positions = await getAllOpenPositions(accountId);
    const position = positions.find(pos => pos.simbolo === symbol);
    return position ? position.alavancagem : 1;
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem atual para \${symbol}:\`, error.message);
    return 1;
  }
}`
};

// Adicionar funções faltantes
let functionsAdded = 0;
for (const missingFunc of missingFunctions) {
  if (missingFunctionImplementations[missingFunc]) {
    console.log(`➕ Adicionando função: ${missingFunc}`);
    apiContent = apiContent.replace(
      /module\.exports = \{/,
      `${missingFunctionImplementations[missingFunc]}\n\nmodule.exports = {`
    );
    functionsAdded++;
  } else {
    console.log(`⚠️ Implementação não encontrada para: ${missingFunc}`);
  }
}

// Corrigir o module.exports para incluir apenas funções que existem
const correctedExports = `module.exports = {
  getPrice,
  getAccountInfo,
  getAllOpenPositions,
  getSymbolInfo,
  getPrecision,
  changeInitialLeverage,
  changeMarginType,
  createOrder,
  cancelOrder,
  getListenKey,
  keepAliveListenKey,
  getCurrentLeverage,
  verifyAndFixEnvironmentConsistency,
  loadCredentialsFromDatabase,
  makeAuthenticatedRequest,
  getAccountConnectionState,
  getAllAccountConnections
};`;

apiContent = apiContent.replace(/module\.exports = \{[^}]*\}/s, correctedExports);

// Verificar se getDatabaseInstance está sendo importado
if (!apiContent.includes('const { getDatabaseInstance }')) {
  apiContent = apiContent.replace(
    /(const crypto = require\("crypto"\);)/,
    `$1\nconst { getDatabaseInstance } = require('./db/conexao');`
  );
  console.log('➕ Adicionada importação de getDatabaseInstance');
}

fs.writeFileSync(apiPath, apiContent, 'utf8');
console.log(`✅ api.js corrigido - ${functionsAdded} funções adicionadas`);

console.log('\n🎉 Correção concluída!');
console.log('\n📋 Resumo:');
console.log(`- Funções adicionadas: ${functionsAdded}`);
console.log('- module.exports corrigido');
console.log('- Importações verificadas');

console.log('\n🚀 Teste novamente:');
console.log('   node posicoes/monitoramento.js --account 1');