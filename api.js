const axios = require("axios");
const crypto = require("crypto");
require('dotenv').config();
const { getDatabaseInstance } = require('./db/conexao');

let websockets;
try {
  websockets = require('./websockets');
} catch (e) {
  console.log('WebSockets não carregado:', e.message);
}

// Cache para armazenar credenciais por conta
const accountCredentials = new Map();
// Cache TTL em milissegundos (1 hora)
const CACHE_TTL = 60 * 60 * 1000;
// Timestamp da última atualização do cache
let lastCacheTime = 0;

/**
 * Carrega credenciais do banco de dados para uma conta específica
 * @param {number} accountId - ID da conta (padrão: 1)
 * @param {boolean} forceRefresh - Se deve forçar atualização do cache
 * @returns {Promise<Object>} - Objeto com as credenciais
 */
async function loadCredentialsFromDatabase(options = {}) {
  try {
    const { accountId = 1, forceRefresh = false } = options;
    
    console.log(`[WEBSOCKETS] Iniciando carregamento de credenciais para conta ID: ${accountId}`);
    
    // Usar cache se disponível e não forçar atualização
    if (!forceRefresh && accountCredentials.has(accountId) && 
        (Date.now() - lastCacheTime < CACHE_TTL)) {
      console.log(`[WEBSOCKETS] Usando credenciais em cache para conta ${accountId}`);
      const cachedCreds = accountCredentials.get(accountId);
      
      // Configurar estado da conexão a partir do cache
      const accountState = websockets && typeof websockets.getAccountConnectionState === "function" ? websockets.getAccountConnectionState(accountId, true) : { apiKey: null, apiSecret: null, privateKey: null, apiUrl: null, wsApiUrl: null, wssMarketUrl: null };
      accountState.apiKey = cachedCreds.apiKey;
      accountState.apiSecret = cachedCreds.apiSecret;
      accountState.wsApiKey = cachedCreds.wsApiKey;
      accountState.wsApiSecret = cachedCreds.wsApiSecret;
      accountState.apiUrl = cachedCreds.apiUrl;
      accountState.wssMarketUrl = cachedCreds.wssMarketUrl;
      accountState.wsApiUrl = cachedCreds.wsApiUrl;
      accountState.corretora = cachedCreds.corretora;
      accountState.ambiente = cachedCreds.ambiente;
      
      return cachedCreds;
    }
    
    const db = await getDatabaseInstance();
    
    // Buscar conta e JOIN com a tabela corretoras para obter as URLs corretas
    const [rows] = await db.query(`
      SELECT 
        c.id,
        c.api_key, 
        c.api_secret, 
        c.ws_api_key, 
        c.ws_api_secret,
        c.id_corretora,
        cor.spot_rest_api_url,
        cor.futures_rest_api_url,
        cor.futures_ws_market_url,
        cor.futures_ws_api_url,
        cor.corretora,
        cor.ambiente
      FROM contas c
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1 AND cor.ativa = 1`,
      [accountId]
    );
    
    if (!accountInfo || accountInfo.length === 0) {
      throw new Error(`Conta ID ${accountId} não encontrada ou não está ativa`);
    }
    
    const account = accountInfo[0];
    
    // Verificar se o ambiente da corretora está consistente com suas URLs
    const isEnvProduction = account.ambiente === 'prd';
    const hasTestnetUrls = account.futures_rest_api_url.includes('testnet') || 
                          account.futures_ws_api_url.includes('testnet') ||
                          account.futures_ws_market_url.includes('testnet');
    
    let correctionsMade = false;
    
    if (isEnvProduction && hasTestnetUrls) {
      console.log(`[API] ⚠️ CORREÇÃO CRÍTICA: Corretora ${account.corretora} (ID: ${account.id_corretora}) 
                  está em ambiente PRODUÇÃO mas usando URLs de TESTNET`);
      
      // Corrigir URLs para ambiente de produção
      await db.query(`
        UPDATE corretoras 
        SET futures_rest_api_url = 'https://fapi.binance.com/fapi',
            futures_ws_market_url = 'wss://fstream.binance.com/ws',
            futures_ws_api_url = 'wss://fstream.binance.com/ws-api/v3'
        WHERE id = ?`,
        [account.id_corretora]
      );
      
      console.log(`[API] ✅ URLs corrigidas para ambiente de PRODUÇÃO`);
      correctionsMade = true;
    } else if (!isEnvProduction && !hasTestnetUrls) {
      console.log(`[API] ⚠️ CORREÇÃO CRÍTICA: Corretora ${account.corretora} (ID: ${account.id_corretora}) 
                  está em ambiente TESTNET mas usando URLs de PRODUÇÃO`);
      
      // Corrigir URLs para ambiente testnet
      await db.query(`
        UPDATE corretoras 
        SET futures_rest_api_url = 'https://testnet.binancefuture.com/fapi',
            futures_ws_market_url = 'wss://stream.binancefuture.com/ws',
            futures_ws_api_url = 'wss://stream.binancefuture.com/ws-api/v3'
        WHERE id = ?`,
        [account.id_corretora]
      );
      
      console.log(`[API] ✅ URLs corrigidas para ambiente de TESTNET`);
      correctionsMade = true;
    }
    
    // Se correções foram feitas, limpar cache
    if (correctionsMade) {
      // Limpar cache de credenciais
      accountCredentials.delete(accountId);
      lastCacheTime = 0;
      
      // Recarregar credenciais
      await loadCredentialsFromDatabase(accountId, true);
    }
    
    return correctionsMade;
  } catch (error) {
    console.error(`[API] Erro ao verificar consistência de ambiente: ${error.message}`);
    return false;
  }
}

// Aplique o mesmo padrão em todas as outras funções que usam accountId
module.exports = {
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
  closePosition, // Adicione a nova função aqui
  getPrice, // Adicione a função getPrice
  updateLeverageBracketsInDatabase, // Adicione a função updateLeverageBracketsInDatabase
  getLeverageBracketsFromDb, // Adicione a função getLeverageBracketsFromDb
  cancelPendingEntry,
  loadCredentialsFromDatabase,
  verifyAndFixEnvironmentConsistency
};