const { getDatabaseInstance } = require('../db/conexao');

async function corrigirFormatoChave() {
  try {
    console.log('=== CORRIGINDO FORMATO DA CHAVE ED25519 ===');
    
    const db = await getDatabaseInstance();
    
    // Obter a chave atual
    const [contas] = await db.query(`
      SELECT ws_api_secret FROM contas WHERE id = 1
    `);
    
    if (contas.length === 0) {
      console.log('❌ Conta não encontrada');
      return;
    }
    
    const chaveAtual = contas[0].ws_api_secret;
    console.log(`Chave atual: ${chaveAtual.substring(0, 20)}... (${chaveAtual.length} chars)`);
    
    // Tentar diferentes formatos de conversão
    let chaveCorrigida = null;
    let formatoDetectado = 'desconhecido';
    
    // 1. Tentar como base64
    try {
      const bufferBase64 = Buffer.from(chaveAtual, 'base64');
      if (bufferBase64.length === 32) {
        chaveCorrigida = bufferBase64.toString('hex');
        formatoDetectado = 'base64';
        console.log('✅ Formato base64 detectado e convertido para hex');
      }
    } catch (e) {
      console.log('❌ Não é base64 válido');
    }
    
    // 2. Tentar como hex direto (remover possíveis prefixos)
    if (!chaveCorrigida) {
      let chaveHex = chaveAtual;
      
      // Remover prefixos comuns
      if (chaveHex.startsWith('0x')) chaveHex = chaveHex.slice(2);
      if (chaveHex.startsWith('ed25519:')) chaveHex = chaveHex.slice(8);
      
      try {
        const bufferHex = Buffer.from(chaveHex, 'hex');
        if (bufferHex.length === 32) {
          chaveCorrigida = chaveHex;
          formatoDetectado = 'hex';
          console.log('✅ Formato hex detectado');
        }
      } catch (e) {
        console.log('❌ Não é hex válido');
      }
    }
    
    // 3. Tentar outros formatos comuns
    if (!chaveCorrigida) {
      // Algumas APIs retornam chaves com padding ou encoding especial
      try {
        // Tentar remover padding/caracteres especiais e converter
        const chaveProcessada = chaveAtual.replace(/[^A-Za-z0-9+/]/g, '');
        const bufferProcessada = Buffer.from(chaveProcessada, 'base64');
        
        if (bufferProcessada.length === 32) {
          chaveCorrigida = bufferProcessada.toString('hex');
          formatoDetectado = 'base64_processado';
          console.log('✅ Formato base64 processado detectado');
        }
      } catch (e) {
        console.log('❌ Processamento adicional falhou');
      }
    }
    
    if (chaveCorrigida) {
      console.log(`\n🔧 Chave corrigida detectada:`);
      console.log(`- Formato original: ${formatoDetectado}`);
      console.log(`- Tamanho em hex: ${chaveCorrigida.length} caracteres`);
      console.log(`- Tamanho em bytes: ${Buffer.from(chaveCorrigida, 'hex').length} bytes`);
      console.log(`- Chave hex: ${chaveCorrigida.substring(0, 20)}...`);
      
      // Perguntar se quer atualizar
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('\nDeseja atualizar a chave no banco de dados com o formato correto? (s/n): ', async (resposta) => {
        if (resposta.toLowerCase() === 's' || resposta.toLowerCase() === 'sim') {
          try {
            await db.query(
              'UPDATE contas SET ws_api_secret = ? WHERE id = 1',
              [chaveCorrigida]
            );
            console.log('✅ Chave atualizada no banco de dados com sucesso!');
            console.log('🎯 Agora você pode continuar usando o sistema normalmente.');
          } catch (updateError) {
            console.error('❌ Erro ao atualizar chave:', updateError.message);
          }
        } else {
          console.log('⚠️ Chave não foi atualizada. Sistema pode não funcionar corretamente.');
        }
        rl.close();
        process.exit(0);
      });
    } else {
      console.log('\n❌ Não foi possível converter a chave para formato Ed25519 válido');
      console.log('\n📋 Opções:');
      console.log('1. Verificar se a chave foi copiada corretamente da Binance');
      console.log('2. Gerar uma nova chave Ed25519 na Binance');
      console.log('3. Desabilitar temporariamente a WebSocket API');
      
      // Oferecer desabilitar WebSocket API
      const readline = require('readline');
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
      });
      
      rl.question('\nDeseja desabilitar a WebSocket API temporariamente? (s/n): ', async (resposta) => {
        if (resposta.toLowerCase() === 's') {
          try {
            // Criar arquivo .env para desabilitar
            const envPath = path.join(__dirname, '..', '.env');
            let envContent = '';
            
            try {
              envContent = await fs.readFile(envPath, 'utf8');
            } catch (e) {
              // Arquivo não existe, criar novo
            }
            
            if (!envContent.includes('DISABLE_WEBSOCKET_API')) {
              envContent += '\n# WebSocket API desabilitada - chave Ed25519 inválida\nDISABLE_WEBSOCKET_API=true\n';
              await fs.writeFile(envPath, envContent, 'utf8');
              console.log('✅ WebSocket API desabilitada no .env');
            }
            
            console.log('🎯 Sistema funcionará apenas com APIs REST (suficiente para operações básicas)');
          } catch (envError) {
            console.error('❌ Erro ao atualizar .env:', envError.message);
          }
        }
        rl.close();
        process.exit(0);
      });
    }
    
  } catch (error) {
    console.error('❌ Erro:', error);
  }
}

corrigirFormatoChave();