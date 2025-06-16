const crypto = require('crypto');
const mysql = require('mysql2/promise');

async function regenerateEd25519Key() {
  try {
    console.log('Gerando nova chave Ed25519...');
    
    // Gerar par de chaves Ed25519
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: {
        type: 'spki',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    });
    
    console.log('Chave gerada com sucesso!');
    console.log('Chave Pública (para configurar na Binance):');
    console.log(publicKey);
    
    // Conectar ao banco
    const connection = await mysql.createConnection({
      host: 'atius.com.br',
      user: 'ubuntu',
      password: 'Bkfigt!546',
      database: 'starboy'
    });
    
    // Atualizar chave privada no banco
    await connection.execute(
      'UPDATE contas SET private_key = ? WHERE id = 1',
      [privateKey]
    );
    
    console.log('✅ Chave privada atualizada no banco de dados');
    console.log('⚠️  IMPORTANTE: Configure a chave pública acima na sua conta Binance!');
    
    await connection.end();
    
  } catch (error) {
    console.error('Erro ao regenerar chave:', error);
  }
}

regenerateEd25519Key();