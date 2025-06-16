const rateLimits = new Map(); // Por accountId

/**
 * Monitora rate limits da API Binance
 * @param {number} accountId - ID da conta
 * @param {Array} rateLimitData - Dados de rate limit da resposta
 */
function updateRateLimits(accountId, rateLimitData) {
  if (!rateLimitData || !Array.isArray(rateLimitData)) return;
  
  const accountLimits = rateLimits.get(accountId) || {};
  
  rateLimitData.forEach(limit => {
    accountLimits[limit.rateLimitType] = {
      interval: limit.interval,
      intervalNum: limit.intervalNum,
      limit: limit.limit,
      count: limit.count,
      percentage: ((limit.count / limit.limit) * 100).toFixed(1),
      lastUpdate: new Date()
    };
  });
  
  rateLimits.set(accountId, accountLimits);
  
  // Alertar se uso estiver alto
  rateLimitData.forEach(limit => {
    const usage = (limit.count / limit.limit) * 100;
    if (usage > 80) {
      console.log(`⚠️ [RATE-LIMIT] Conta ${accountId}: ${limit.rateLimitType} em ${usage.toFixed(1)}% (${limit.count}/${limit.limit})`);
    }
  });
}

/**
 * Obtém status atual dos rate limits
 * @param {number} accountId - ID da conta
 * @returns {Object} Status dos rate limits
 */
function getRateLimitStatus(accountId) {
  return rateLimits.get(accountId) || {};
}

module.exports = { updateRateLimits, getRateLimitStatus };