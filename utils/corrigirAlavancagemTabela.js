const fs = require('fs').promises;
const path = require('path');

async function corrigirAlavancagemTabela() {
  try {
    console.log('=== CORRIGINDO FUNÇÕES PARA USAR TABELA ALAVANCAGEM ===');
    
    const apiPath = path.join(__dirname, '..', 'api.js');
    let conteudo = await fs.readFile(apiPath, 'utf8');
    
    // Função corrigida updateLeverageBracketsInDatabase
    const updateLeverageBracketsCorrigida = `
/**
 * Atualiza brackets de alavancagem no banco de dados
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function updateLeverageBracketsInDatabase(exchange = 'binance', accountId = 1) {
  try {
    console.log(\`[API] Atualizando brackets de alavancagem para \${exchange}...\`);
    
    const db = await getDatabaseInstance(accountId);
    
    // Verificar última atualização
    const [lastUpdate] = await db.query(
      'SELECT MAX(updated_at) as ultima_atualizacao FROM alavancagem WHERE corretora = ?',
      [exchange]
    );
    
    const lastUpdateTime = lastUpdate[0]?.ultima_atualizacao;
    const now = new Date();
    const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
    
    if (lastUpdateTime && new Date(lastUpdateTime) > sixHoursAgo) {
      const timeDiff = Math.round((now - new Date(lastUpdateTime)) / (1000 * 60 * 60 * 10)) / 100;
      console.log(\`[API] Última atualização de alavancagem para \${exchange} foi há \${timeDiff} horas\`);
      console.log(\`[API] Brackets de alavancagem foram atualizados recentemente. Pulando atualização.\`);
      return;
    }
    
    // Obter brackets da API
    const brackets = await getAllLeverageBrackets(null, accountId);
    
    // Limpar dados antigos
    await db.query('DELETE FROM alavancagem WHERE corretora = ?', [exchange]);
    
    // Inserir novos dados
    for (const bracket of brackets) {
      for (let i = 0; i < bracket.brackets.length; i++) {
        const levelBracket = bracket.brackets[i];
        await db.query(
          \`INSERT INTO alavancagem 
           (symbol, corretora, bracket, initial_leverage, notional_cap, notional_floor, maint_margin_ratio, cum, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())\`,
          [
            bracket.symbol,
            exchange,
            i + 1, // bracket number (1, 2, 3, etc.)
            parseInt(levelBracket.initialLeverage),
            parseFloat(levelBracket.notionalCap),
            parseFloat(levelBracket.notionalFloor),
            parseFloat(levelBracket.maintMarginRatio),
            parseFloat(levelBracket.cum)
          ]
        );
      }
    }
    
    console.log(\`[API] Brackets de alavancagem atualizados com sucesso para \${exchange}\`);
  } catch (error) {
    console.error(\`[API] Erro ao atualizar brackets de alavancagem:\`, error.message);
    // Não re-throw o erro para não quebrar a inicialização
  }
}`;

    // Função corrigida getLeverageBracketsFromDb
    const getLeverageBracketsCorrigida = `
/**
 * Obtém brackets de alavancagem do banco de dados
 * @param {string} symbol - Símbolo do par
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Brackets do banco de dados
 */
async function getLeverageBracketsFromDb(symbol, exchange = 'binance', accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    const [brackets] = await db.query(
      \`SELECT 
        id,
        symbol,
        corretora,
        bracket,
        initial_leverage,
        notional_cap,
        notional_floor,
        maint_margin_ratio,
        cum,
        updated_at
       FROM alavancagem 
       WHERE symbol = ? AND corretora = ? 
       ORDER BY bracket ASC\`,
      [symbol, exchange]
    );
    
    return brackets;
  } catch (error) {
    console.error(\`[API] Erro ao obter brackets do banco para \${symbol}:\`, error.message);
    return [];
  }
}`;

    // Nova função para obter alavancagem máxima de um símbolo
    const getMaxLeverageFromDbCorrigida = `
/**
 * Obtém alavancagem máxima para um símbolo do banco de dados
 * @param {string} symbol - Símbolo do par
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Alavancagem máxima
 */
async function getMaxLeverageFromDb(symbol, exchange = 'binance', accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    const [result] = await db.query(
      \`SELECT MAX(initial_leverage) as max_leverage 
       FROM alavancagem 
       WHERE symbol = ? AND corretora = ?\`,
      [symbol, exchange]
    );
    
    return result[0]?.max_leverage || 20; // Default 20x se não encontrar
  } catch (error) {
    console.error(\`[API] Erro ao obter alavancagem máxima do banco para \${symbol}:\`, error.message);
    return 20; // Default
  }
}`;

    // Nova função para obter informações de margem baseada no notional
    const getMarginInfoFromDbCorrigida = `
/**
 * Obtém informações de margem baseada no valor notional
 * @param {string} symbol - Símbolo do par
 * @param {number} notionalValue - Valor notional da posição
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações de margem
 */
async function getMarginInfoFromDb(symbol, notionalValue, exchange = 'binance', accountId = 1) {
  try {
    const db = await getDatabaseInstance(accountId);
    
    const [brackets] = await db.query(
      \`SELECT 
        bracket,
        initial_leverage,
        notional_cap,
        notional_floor,
        maint_margin_ratio,
        cum
       FROM alavancagem 
       WHERE symbol = ? AND corretora = ? 
         AND notional_floor <= ? 
         AND (notional_cap >= ? OR notional_cap = 0)
       ORDER BY bracket ASC
       LIMIT 1\`,
      [symbol, exchange, notionalValue, notionalValue]
    );
    
    if (brackets.length === 0) {
      // Se não encontrar, pegar o primeiro bracket disponível
      const [fallback] = await db.query(
        \`SELECT * FROM alavancagem 
         WHERE symbol = ? AND corretora = ? 
         ORDER BY bracket ASC 
         LIMIT 1\`,
        [symbol, exchange]
      );
      
      return fallback[0] || {
        bracket: 1,
        initial_leverage: 20,
        notional_cap: 50000,
        notional_floor: 0,
        maint_margin_ratio: 0.004,
        cum: 0
      };
    }
    
    return brackets[0];
  } catch (error) {
    console.error(\`[API] Erro ao obter informações de margem do banco para \${symbol}:\`, error.message);
    return {
      bracket: 1,
      initial_leverage: 20,
      notional_cap: 50000,
      notional_floor: 0,
      maint_margin_ratio: 0.004,
      cum: 0
    };
  }
}`;

    // Função para calcular margem necessária
    const calculateRequiredMarginCorrigida = `
/**
 * Calcula margem necessária baseada no valor notional
 * @param {string} symbol - Símbolo do par
 * @param {number} notionalValue - Valor notional da posição
 * @param {number} leverage - Alavancagem a ser usada
 * @param {string} exchange - Nome da corretora
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Informações de margem calculada
 */
async function calculateRequiredMargin(symbol, notionalValue, leverage, exchange = 'binance', accountId = 1) {
  try {
    const marginInfo = await getMarginInfoFromDb(symbol, notionalValue, exchange, accountId);
    
    // Verificar se a alavancagem solicitada é permitida
    if (leverage > marginInfo.initial_leverage) {
      throw new Error(\`Alavancagem \${leverage}x não permitida para \${symbol}. Máxima: \${marginInfo.initial_leverage}x\`);
    }
    
    // Calcular margem inicial
    const initialMargin = notionalValue / leverage;
    
    // Calcular margem de manutenção
    const maintMargin = (notionalValue * marginInfo.maint_margin_ratio) - marginInfo.cum;
    
    return {
      symbol,
      notionalValue,
      leverage,
      bracket: marginInfo.bracket,
      initialMargin: parseFloat(initialMargin.toFixed(8)),
      maintMargin: parseFloat(maintMargin.toFixed(8)),
      maintMarginRatio: marginInfo.maint_margin_ratio,
      maxLeverage: marginInfo.initial_leverage,
      notionalCap: marginInfo.notional_cap,
      notionalFloor: marginInfo.notional_floor
    };
  } catch (error) {
    console.error(\`[API] Erro ao calcular margem necessária para \${symbol}:\`, error.message);
    throw error;
  }
}`;

    // Substituir as funções no arquivo
    conteudo = conteudo.replace(
      /async function updateLeverageBracketsInDatabase\(exchange = 'binance', accountId = 1\)[\s\S]*?^}/m,
      updateLeverageBracketsCorrigida.trim()
    );
    
    conteudo = conteudo.replace(
      /async function getLeverageBracketsFromDb\(symbol, exchange = 'binance', accountId = 1\)[\s\S]*?^}/m,
      getLeverageBracketsCorrigida.trim()
    );
    
    // Adicionar novas funções antes do module.exports
    const moduleExportsIndex = conteudo.lastIndexOf('module.exports');
    const novasFuncoes = `
${getMaxLeverageFromDbCorrigida}

${getMarginInfoFromDbCorrigida}

${calculateRequiredMarginCorrigida}

`;
    
    conteudo = conteudo.slice(0, moduleExportsIndex) + novasFuncoes + conteudo.slice(moduleExportsIndex);
    
    // Atualizar module.exports para incluir as novas funções
    conteudo = conteudo.replace(
      /module\.exports = \{[\s\S]*?\};/,
      `module.exports = {
  getFuturesAccountBalanceDetails,
  getMaxLeverage,
  getCurrentLeverage,
  getCurrentMarginType,
  changeInitialLeverage,
  changeMarginType,
  newOrder,
  newEntryOrder,
  newLimitMakerOrder,
  editOrder,
  newReduceOnlyOrder,
  newStopOrder,
  newStopOrTpLimitOrder,
  newTakeProfitOrder,
  getTickSize,
  roundPriceToTickSize,
  getPrecision,
  getOpenOrders,
  getRecentOrders,
  getOrderStatus,
  getMultipleOrderStatus,
  getPositionDetails,
  getAllOpenPositions,
  obterSaldoPosicao,
  cancelOrder,
  transferBetweenAccounts,
  cancelAllOpenOrders,
  encerrarPosicao,
  getAllLeverageBrackets,
  setPositionMode,
  getPositionMode,
  closePosition,
  getPrice,
  updateLeverageBracketsInDatabase,
  getLeverageBracketsFromDb,
  getMaxLeverageFromDb,
  getMarginInfoFromDb,
  calculateRequiredMargin,
  cancelPendingEntry,
  loadCredentialsFromDatabase,
  verifyAndFixEnvironmentConsistency
};`
    );
    
    await fs.writeFile(apiPath, conteudo, 'utf8');
    console.log('✅ Funções de alavancagem corrigidas para usar a tabela existente!');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir funções de alavancagem:', error);
  }
}

corrigirAlavancagemTabela();