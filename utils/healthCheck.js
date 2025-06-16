const { getDatabaseInstance } = require('../db/conexao');
const websockets = require('../websockets');

/**
 * Executa verificação completa de saúde do sistema
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} Status de saúde
 */
async function performHealthCheck(accountId) {
  const healthStatus = {
    timestamp: new Date().toISOString(),
    accountId: accountId,
    overall: 'healthy',
    components: {}
  };
  
  try {
    // 1. Verificar banco de dados
    const db = await getDatabaseInstance();
    const [dbTest] = await db.query('SELECT 1 as test');
    healthStatus.components.database = {
      status: dbTest[0]?.test === 1 ? 'healthy' : 'unhealthy',
      responseTime: 'fast'
    };
    
    // 2. Verificar WebSocket API
    const wsConnected = websockets.isWebSocketApiConnected(accountId);
    const wsAuthenticated = websockets.isWebSocketApiAuthenticated(accountId);
    healthStatus.components.websocketApi = {
      status: wsConnected && wsAuthenticated ? 'healthy' : 'degraded',
      connected: wsConnected,
      authenticated: wsAuthenticated
    };
    
    // 3. Verificar UserDataStream
    const allConnections = websockets.getAllAccountConnections();
    const accountConnection = allConnections.get(accountId);
    healthStatus.components.userDataStream = {
      status: accountConnection?.userDataStream ? 'healthy' : 'disconnected',
      connected: !!accountConnection?.userDataStream
    };
    
    // 4. Verificar sinais pendentes
    const [pendingSignals] = await db.query(
      'SELECT COUNT(*) as count FROM webhook_signals WHERE status = "PENDING" AND conta_id = ?', 
      [accountId]
    );
    healthStatus.components.signalProcessor = {
      status: 'healthy',
      pendingSignals: pendingSignals[0]?.count || 0
    };
    
    // Determinar status geral
    const componentStatuses = Object.values(healthStatus.components).map(c => c.status);
    if (componentStatuses.includes('unhealthy')) {
      healthStatus.overall = 'unhealthy';
    } else if (componentStatuses.includes('degraded')) {
      healthStatus.overall = 'degraded';
    }
    
  } catch (error) {
    healthStatus.overall = 'unhealthy';
    healthStatus.error = error.message;
  }
  
  return healthStatus;
}

module.exports = { performHealthCheck };