cd /home/ubuntu/atius/starboy

# Testar credenciais isoladamente
node -e "
const { loadCredentialsFromDatabase } = require('./api');
(async () => {
  try {
    console.log('Testando carregamento de credenciais...');
    const creds = await loadCredentialsFromDatabase({ accountId: 1, forceRefresh: true });
    console.log('✅ Credenciais carregadas:');
    console.log('- API Key:', creds.apiKey ? creds.apiKey.substring(0, 8) + '...' : 'FALTANDO');
    console.log('- Secret Key tipo:', typeof creds.secretKey);
    console.log('- Secret Key length:', creds.secretKey ? creds.secretKey.length : 'N/A');
    console.log('- Secret Key primeiro char:', creds.secretKey ? creds.secretKey[0] : 'N/A');
    console.log('- Secret Key último char:', creds.secretKey ? creds.secretKey[creds.secretKey.length-1] : 'N/A');
    
    // Testar criação de assinatura
    const crypto = require('crypto');
    const testQuery = 'symbol=BTCUSDT&timestamp=' + Date.now();
    const signature = crypto.createHmac('sha256', creds.secretKey).update(testQuery).digest('hex');
    console.log('✅ Assinatura teste criada com sucesso:', signature.substring(0, 16) + '...');
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    console.error('Stack:', error.stack);
  }
  process.exit(0);
})();
"