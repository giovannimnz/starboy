const fs = require('fs').promises;
const path = require('path');

async function corrigirReferenciaFuncao() {
  try {
    console.log('Iniciando correção da referência à função getAccountConnectionState...');
    
    // Caminho para o arquivo api.js
    const apiFilePath = path.join(__dirname, '..', 'api.js');
    
    // Ler o conteúdo atual do arquivo
    let conteudo = await fs.readFile(apiFilePath, 'utf8');
    
    // Verificar se o problema existe no arquivo
    if (conteudo.includes('const accountState = getAccountConnectionState(')) {
      console.log('Problema encontrado no arquivo api.js. Aplicando correção...');
      
      // Substituir todas as chamadas diretas à função pela versão correta
      const conteudoCorrigido = conteudo.replace(
        /const accountState = getAccountConnectionState\(([^)]+)\)/g,
        'const accountState = websockets && typeof websockets.getAccountConnectionState === "function" ? websockets.getAccountConnectionState($1) : { apiKey: null, apiSecret: null, privateKey: null, apiUrl: null, wsApiUrl: null, wssMarketUrl: null }'
      );
      
      // Verificar se houve mudanças
      if (conteudoCorrigido !== conteudo) {
        // Salvar arquivo corrigido
        await fs.writeFile(apiFilePath, conteudoCorrigido, 'utf8');
        console.log('✅ Correção aplicada com sucesso ao arquivo api.js!');
        console.log('Por favor, reinicie o sistema para aplicar as alterações.');
      } else {
        console.log('⚠️ Padrão encontrado, mas substituição não efetuada. Verifique manualmente.');
      }
    } else {
      console.log('O problema não foi encontrado no padrão esperado. Verificando outras possibilidades...');
      
      // Adicionar função local caso não esteja usando a do websockets
      if (!conteudo.includes('function getAccountConnectionState(')) {
        console.log('Adicionando função getAccountConnectionState local como solução alternativa...');
        
        // Adicionar a função no início do arquivo, após as importações
        const novaFuncao = `
// Função local para evitar dependência direta do websockets
function getAccountConnectionState(accountId = 1, create = false) {
  // Se o módulo websockets estiver disponível, usar sua função
  if (websockets && typeof websockets.getAccountConnectionState === 'function') {
    return websockets.getAccountConnectionState(accountId, create);
  }
  
  // Caso contrário, retornar um objeto padrão com propriedades vazias
  return {
    apiKey: null,
    apiSecret: null,
    privateKey: null,
    apiUrl: process.env.API_URL || 'https://fapi.binance.com/fapi',
    wsApiUrl: process.env.WS_API_URL || 'wss://ws-fapi.binance.com/ws-fapi',
    wssMarketUrl: process.env.WS_URL || 'wss://fstream.binance.com/ws'
  };
}
`;
        
        // Encontrar ponto de inserção após as importações
        const posicaoInsercao = conteudo.indexOf('// Cache para armazenar credenciais por conta');
        if (posicaoInsercao !== -1) {
          conteudo = conteudo.slice(0, posicaoInsercao) + novaFuncao + conteudo.slice(posicaoInsercao);
          await fs.writeFile(apiFilePath, conteudo, 'utf8');
          console.log('✅ Função getAccountConnectionState adicionada ao arquivo api.js como solução alternativa!');
          console.log('Por favor, reinicie o sistema para aplicar as alterações.');
        } else {
          console.log('⚠️ Não foi possível encontrar um ponto adequado para inserir a função. Verifique manualmente.');
        }
      }
    }
    
  } catch (error) {
    console.error('Erro ao corrigir o arquivo:', error);
  }
}

// Executar a função de correção
corrigirReferenciaFuncao();