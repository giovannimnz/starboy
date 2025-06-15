const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { createEd25519Signature, loadPrivateKeyFromPEMSync } = require('../websockets');

async function testarFallbackPEM() {
  try {
    console.log('=== TESTE DE FALLBACK PEM ===');
    
    // Testar carregamento direto do PEM
    const privateKey = loadPrivateKeyFromPEMSync(1);
    
    if (privateKey) {
      console.log('✅ Chave carregada do PEM:', privateKey.substring(0, 20) + '...');
      
      // Testar criação de assinatura
      const payload = 'test_payload_' + Date.now();
      const signature = createEd25519Signature(payload, privateKey, 1);
      
      console.log('✅ Assinatura criada:', signature.substring(0, 20) + '...');
      console.log('✅ Fallback PEM funcionando!');
    } else {
      console.log('❌ Falha ao carregar chave do PEM');
    }
    
  } catch (error) {
    console.error('❌ Erro no teste:', error.message);
  }
}

testarFallbackPEM();