const { getDatabaseInstance } = require('../db/conexao');

async function verificarChavePrivada() {
  try {
    console.log('=== VERIFICAÇÃO DA CHAVE PRIVADA ED25519 ===');
    
    const db = await getDatabaseInstance();
    
    // Verificar credenciais da conta 1 - usando estrutura correta
    const [contas] = await db.query(`
      SELECT c.id, c.nome, c.api_key, c.api_secret, 
             c.ws_api_key, c.ws_api_secret, c.api_url, c.ws_api_url,
             cor.corretora, cor.ambiente
      FROM contas c 
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = 1
    `);
    
    if (contas.length === 0) {
      console.log('❌ Conta ID 1 não encontrada');
      return;
    }
    
    const conta = contas[0];
    console.log('Informações da Conta:');
    console.log(`- ID: ${conta.id}`);
    console.log(`- Nome: ${conta.nome}`);
    console.log(`- Corretora: ${conta.corretora} (${conta.ambiente})`);
    console.log(`- API Key: ${conta.api_key ? `${conta.api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- API Secret: ${conta.api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    console.log(`- WS API Key: ${conta.ws_api_key ? `${conta.ws_api_key.substring(0, 8)}...` : '❌ Não configurada'}`);
    console.log(`- WS API Secret (Private Key Ed25519): ${conta.ws_api_secret ? '✅ Configurada' : '❌ Não configurada'}`);
    
    // Verificar se ws_api_secret (private_key) está vazia ou null
    if (!conta.ws_api_secret || conta.ws_api_secret.trim() === '') {
      console.log('\n⚠️ PROBLEMA IDENTIFICADO: Private Key Ed25519 (ws_api_secret) está vazia!');
      console.log('\nSoluções possíveis:');
      console.log('1. Se você tem uma chave privada Ed25519, atualize o banco de dados:');
      console.log('   UPDATE contas SET ws_api_secret = "SUA_CHAVE_PRIVADA_ED25519" WHERE id = 1;');
      console.log('2. Se você só tem API Key/Secret padrão, a WebSocket API não funcionará');
      console.log('3. Gere uma nova chave Ed25519 na Binance (API Management → Edit API)');
      
      console.log('\n🔧 SOLUÇÃO TEMPORÁRIA: Desabilitar WebSocket API');
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('\nDeseja desabilitar temporariamente a WebSocket API? (s/n): ', async (resposta) => {
        if (resposta.toLowerCase() === 's' || resposta.toLowerCase() === 'sim') {
          try {
            await desabilitarWebSocketAPI();
            console.log('✅ WebSocket API desabilitada temporariamente');
          } catch (error) {
            console.error('❌ Erro ao desabilitar WebSocket API:', error.message);
          }
        } else {
          console.log('\nPara habilitar a WebSocket API:');
          console.log('1. Acesse sua conta Binance');
          console.log('2. Vá em API Management');
          console.log('3. Edite sua API Key e habilite Ed25519');
          console.log('4. Copie a Private Key e execute:');
          console.log('   UPDATE contas SET ws_api_secret = "SUA_PRIVATE_KEY" WHERE id = 1;');
        }
        rl.close();
        process.exit(0);
      });
    } else {
      // Verificar se a chave privada tem o formato correto
      let privateKey = conta.ws_api_secret;
      
      // Se começar com 0x, remover
      if (privateKey.startsWith('0x')) {
        privateKey = privateKey.slice(2);
      }
      
      console.log(`\nAnalisando chave privada...`);
      console.log(`- Tamanho da string: ${privateKey.length} caracteres`);
      
      // Tentar converter para Buffer
      try {
        const keyBuffer = Buffer.from(privateKey, 'hex');
        console.log(`- Tamanho em bytes: ${keyBuffer.length} bytes`);
        
        if (keyBuffer.length === 32) {
          console.log('✅ Chave privada Ed25519 tem tamanho correto (32 bytes)');
          console.log('✅ Formato parece válido para Ed25519');
        } else {
          console.log(`❌ Chave privada Ed25519 tem tamanho incorreto: ${keyBuffer.length} bytes (esperado: 32)`);
          console.log('⚠️ Esta pode ser uma API Secret normal, não uma chave Ed25519');
          console.log('\n🔧 Recomendação: Gerar nova chave Ed25519 na Binance');
        }
      } catch (hexError) {
        console.log('❌ Erro ao interpretar como hexadecimal:', hexError.message);
        console.log('⚠️ A chave não está em formato hexadecimal válido');
        
        // Verificar se é base64
        try {
          const base64Buffer = Buffer.from(privateKey, 'base64');
          console.log(`- Tentativa base64: ${base64Buffer.length} bytes`);
          if (base64Buffer.length === 32) {
            console.log('✅ Pode ser uma chave Ed25519 em base64');
          }
        } catch (base64Error) {
          console.log('❌ Também não é base64 válido');
        }
      }
    }
    
  } catch (error) {
    console.error('❌ Erro:', error);
  }
}

async function desabilitarWebSocketAPI() {
  const fs = require('fs').promises;
  const path = require('path');
  
  try {
    // 1. Atualizar .env
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = await fs.readFile(envPath, 'utf8');
    
    if (!envContent.includes('DISABLE_WEBSOCKET_API')) {
      envContent += '\n# WebSocket API desabilitada - chave Ed25519 não configurada\nDISABLE_WEBSOCKET_API=true\n';
      await fs.writeFile(envPath, envContent, 'utf8');
    }
    
    console.log('✅ Variável DISABLE_WEBSOCKET_API=true adicionada ao .env');
    
  } catch (error) {
    console.error('❌ Erro ao desabilitar WebSocket API:', error);
    throw error;
  }
}

verificarChavePrivada();