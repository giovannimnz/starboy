const fs = require('fs').promises;
const path = require('path');

async function desabilitarWebSocketAPI() {
  try {
    console.log('=== DESABILITANDO WEBSOCKET API TEMPORARIAMENTE ===');
    
    // 1. Comentar inicialização da WebSocket API em monitoramento.js
    const monitoramentoPath = path.join(__dirname, '..', 'posicoes', 'monitoramento.js');
    let conteudo = await fs.readFile(monitoramentoPath, 'utf8');
    
    // Comentar a linha que inicializa WebSocket API
    conteudo = conteudo.replace(
      /(\s+)await websocketApi\.initializeHandlers\(accountId\);/g,
      '$1// await websocketApi.initializeHandlers(accountId); // Temporariamente desabilitado'
    );
    
    await fs.writeFile(monitoramentoPath, conteudo, 'utf8');
    console.log('✅ WebSocket API desabilitada em monitoramento.js');
    
    // 2. Comentar em websocketApi.js para evitar erros
    const websocketApiPath = path.join(__dirname, '..', 'websocketApi.js');
    let conteudoWsApi = await fs.readFile(websocketApiPath, 'utf8');
    
    // Adicionar verificação no início das funções principais
    const verificacao = `
    // Verificação temporária - WebSocket API desabilitada
    if (process.env.DISABLE_WEBSOCKET_API === 'true') {
      console.log('[WS-API] WebSocket API está temporariamente desabilitada');
      return null;
    }
    `;
    
    // Inserir verificação na função initializeHandlers
    conteudoWsApi = conteudoWsApi.replace(
      /(async function initializeHandlers\(accountId = 1\) \{)/,
      `$1${verificacao}`
    );
    
    await fs.writeFile(websocketApiPath, conteudoWsApi, 'utf8');
    console.log('✅ Verificação adicionada em websocketApi.js');
    
    // 3. Atualizar .env para desabilitar
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = await fs.readFile(envPath, 'utf8');
    
    if (!envContent.includes('DISABLE_WEBSOCKET_API')) {
      envContent += '\n# Temporariamente desabilitado devido a problemas com chave Ed25519\nDISABLE_WEBSOCKET_API=true\n';
      await fs.writeFile(envPath, envContent, 'utf8');
      console.log('✅ Variável DISABLE_WEBSOCKET_API adicionada ao .env');
    }
    
    console.log('\n✅ WebSocket API desabilitada temporariamente');
    console.log('O sistema funcionará apenas com APIs REST e WebSocket de preços');
    console.log('\nPara reabilitar:');
    console.log('1. Configure uma chave privada Ed25519 válida no banco');
    console.log('2. Altere DISABLE_WEBSOCKET_API=false no .env');
    console.log('3. Descomente as linhas em monitoramento.js');
    
  } catch (error) {
    console.error('❌ Erro ao desabilitar WebSocket API:', error);
  }
}

desabilitarWebSocketAPI();