const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { getDatabaseInstance } = require('../db/conexao');

async function configurarChavePEMAutomatico() {
  try {
    console.log('=== CONFIGURAÇÃO AUTOMÁTICA DA CHAVE ED25519 ===');
    
    // 1. Verificar se o arquivo PEM existe
    const pemPath = path.join(__dirname, 'binance_key', 'private_key.pem');
    
    try {
      await fs.access(pemPath);
      console.log('✅ Arquivo PEM encontrado:', pemPath);
    } catch (error) {
      console.log('❌ Arquivo PEM não encontrado em:', pemPath);
      
      // Criar o diretório se não existir
      const pemDir = path.dirname(pemPath);
      await fs.mkdir(pemDir, { recursive: true });
      
      // Criar arquivo PEM com o conteúdo fornecido
      const pemContent = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGBZNWZD0353l2WLOFi6sfIa7Oa5kHcgj89PfsJ+W8Fk
-----END PRIVATE KEY-----`;
      
      await fs.writeFile(pemPath, pemContent, 'utf8');
      console.log('✅ Arquivo PEM criado com sucesso');
    }
    
    // 2. Ler e processar o arquivo PEM
    const pemContent = await fs.readFile(pemPath, 'utf8');
    console.log('✅ Conteúdo PEM carregado');
    
    // 3. Extrair a chave privada - MÉTODO CORRIGIDO
    let privateKeyBase64;
    try {
      // Primeiro, criar o objeto de chave privada do PEM
      const keyObject = crypto.createPrivateKey({
        key: pemContent,
        format: 'pem',
        type: 'pkcs8'
      });
      
      console.log('✅ Objeto de chave criado com sucesso');
      
      // CORREÇÃO: Usar método compatível para extrair a chave raw
      // Método 1: Tentar exportar como DER e extrair os bytes
      let rawKey;
      try {
        const derKey = keyObject.export({
          format: 'der',
          type: 'pkcs8'
        });
        
        // Para Ed25519, os últimos 32 bytes do DER são a chave privada
        rawKey = derKey.slice(-32);
        console.log('✅ Chave extraída via método DER');
        
      } catch (derError) {
        console.log('⚠️ Método DER falhou, tentando método alternativo...');
        
        // Método 2: Usar crypto.KeyObject.asymmetricKeyDetails (Node.js 15+)
        try {
          const keyDetails = keyObject.asymmetricKeyDetails;
          if (keyDetails && keyDetails.rawPrivateKey) {
            rawKey = keyDetails.rawPrivateKey;
            console.log('✅ Chave extraída via asymmetricKeyDetails');
          }
        } catch (detailsError) {
          console.log('⚠️ asymmetricKeyDetails não disponível, usando método manual...');
          
          // Método 3: Decodificar o PEM manualmente
          const base64Data = pemContent
            .replace('-----BEGIN PRIVATE KEY-----', '')
            .replace('-----END PRIVATE KEY-----', '')
            .replace(/\n/g, '')
            .replace(/\r/g, '');
          
          const derBuffer = Buffer.from(base64Data, 'base64');
          
          // Para Ed25519 PKCS#8, a chave privada está nos últimos 32 bytes
          // Estrutura PKCS#8 para Ed25519: [header info] + [32 bytes de chave privada]
          rawKey = derBuffer.slice(-32);
          console.log('✅ Chave extraída via decodificação manual');
        }
      }
      
      if (!rawKey || rawKey.length !== 32) {
        throw new Error(`Chave Ed25519 extraída tem tamanho incorreto: ${rawKey ? rawKey.length : 0} bytes (esperado: 32)`);
      }
      
      // Converter para base64
      privateKeyBase64 = rawKey.toString('base64');
      
      console.log('✅ Chave privada extraída do PEM:');
      console.log(`- Tamanho: ${rawKey.length} bytes`);
      console.log(`- Base64: ${privateKeyBase64.substring(0, 20)}...`);
      
    } catch (keyError) {
      console.error('❌ Erro ao processar chave PEM:', keyError.message);
      throw new Error(`Falha ao extrair chave Ed25519: ${keyError.message}`);
    }
    
    // 4. Testar a chave
    await testarChaveEd25519(privateKeyBase64);
    
    // 5. Atualizar banco de dados
    const db = await getDatabaseInstance();
    
    await db.query(`
      UPDATE contas 
      SET ws_api_secret = ?, 
          private_key = ?,
          ultima_atualizacao = NOW()
      WHERE id = 1
    `, [privateKeyBase64, privateKeyBase64]);
    
    console.log('✅ Chave Ed25519 atualizada no banco de dados');
    
    // 6. Habilitar WebSocket API no .env
    await habilitarWebSocketAPI();
    
    console.log('\n🎯 CONFIGURAÇÃO CONCLUÍDA COM SUCESSO!');
    console.log('✅ Chave privada Ed25519 configurada corretamente');
    console.log('✅ WebSocket API habilitada');
    console.log('✅ Sistema pronto para uso completo');
    
    return true;
    
  } catch (error) {
    console.error('❌ Erro durante configuração:', error.message);
    return false;
  }
}

// Função para testar a chave Ed25519
async function testarChaveEd25519(privateKeyBase64) {
  try {
    console.log('\n=== TESTANDO CHAVE ED25519 ===');
    
    const payload = 'test_payload_' + Date.now();
    const privateKeyBuffer = Buffer.from(privateKeyBase64, 'base64');
    
    // Verificar tamanho
    if (privateKeyBuffer.length !== 32) {
      throw new Error(`Chave tem tamanho incorreto: ${privateKeyBuffer.length} bytes (esperado: 32)`);
    }
    
    // Criar objeto de chave
    const keyObject = crypto.createPrivateKey({
      key: privateKeyBuffer,
      format: 'raw',
      type: 'ed25519'
    });
    
    // Criar assinatura
    const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), keyObject);
    
    console.log('✅ Teste de assinatura bem-sucedido!');
    console.log(`- Payload: ${payload}`);
    console.log(`- Assinatura: ${signature.toString('base64').substring(0, 20)}...`);
    
    return true;
  } catch (testError) {
    console.error('❌ Erro no teste da chave:', testError.message);
    
    // Se o teste falhar, pode ser problema de compatibilidade
    console.log('\n⚠️ POSSÍVEIS SOLUÇÕES:');
    console.log('1. Verificar se o Node.js suporta Ed25519 (versão 12+)');
    console.log('2. A chave pode estar em formato incorreto');
    console.log('3. Usar biblioteca externa: npm install @noble/ed25519');
    
    throw testError;
  }
}

// Função para habilitar WebSocket API
async function habilitarWebSocketAPI() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = '';
    
    try {
      envContent = await fs.readFile(envPath, 'utf8');
    } catch (e) {
      console.log('Criando arquivo .env...');
    }
    
    // Remover linhas que desabilitam WebSocket API
    envContent = envContent.replace(/^DISABLE_WEBSOCKET_API=true.*$/gm, '');
    envContent = envContent.replace(/^# DISABLE_WEBSOCKET_API=true.*$/gm, '');
    
    // Adicionar comentário de confirmação
    if (!envContent.includes('# WebSocket API habilitada')) {
      envContent += '\n# WebSocket API habilitada - chave Ed25519 configurada corretamente\n# DISABLE_WEBSOCKET_API=false\n';
    }
    
    await fs.writeFile(envPath, envContent, 'utf8');
    console.log('✅ WebSocket API habilitada no .env');
    
  } catch (envError) {
    console.error('⚠️ Erro ao atualizar .env:', envError.message);
  }
}

// Executar configuração
configurarChavePEMAutomatico()
  .then(success => {
    if (success) {
      console.log('\n🚀 Agora você pode executar o monitoramento normalmente:');
      console.log('node posicoes/monitoramento.js');
    } else {
      console.log('\n❌ Configuração falhou. Verifique os erros acima.');
    }
    process.exit(success ? 0 : 1);
  })
  .catch(error => {
    console.error('❌ Erro fatal:', error);
    process.exit(1);
  });