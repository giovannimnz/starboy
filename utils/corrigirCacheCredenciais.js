const fs = require('fs').promises;
const path = require('path');

async function corrigirCacheCredenciais() {
  try {
    console.log('Corrigindo inconsistência no nome da variável de cache de credenciais...');
    
    // Caminho para o arquivo api.js
    const apiFilePath = path.join(__dirname, '..', 'api.js');
    
    // Ler o conteúdo atual do arquivo
    const conteudo = await fs.readFile(apiFilePath, 'utf8');
    
    // Verificar qual nomenclatura o arquivo usa predominantemente
    const contarAccountCredentials = (conteudo.match(/accountCredentials/g) || []).length;
    const contarAccountCredentialsCache = (conteudo.match(/accountCredentialsCache/g) || []).length;
    
    let novoConteudo;
    
    if (contarAccountCredentials > contarAccountCredentialsCache) {
      // Se 'accountCredentials' é usado mais frequentemente, substituir 'accountCredentialsCache' por 'accountCredentials'
      console.log('Substituindo "accountCredentialsCache" por "accountCredentials"...');
      novoConteudo = conteudo.replace(/accountCredentialsCache/g, 'accountCredentials');
    } else {
      // Caso contrário, substituir 'accountCredentials' por 'accountCredentialsCache' e adicionar declaração
      console.log('Substituindo "accountCredentials" por "accountCredentialsCache" e adicionando declaração...');
      
      // Verificar se já existe a declaração para 'accountCredentialsCache'
      if (!conteudo.includes('const accountCredentialsCache = new Map()')) {
        // Substituir a declaração atual
        novoConteudo = conteudo.replace(
          /const accountCredentials = new Map\(\);/,
          'const accountCredentialsCache = new Map();'
        );
      } else {
        novoConteudo = conteudo;
      }
      
      // Substituir as referências restantes
      novoConteudo = novoConteudo.replace(/accountCredentials\./g, 'accountCredentialsCache.');
      novoConteudo = novoConteudo.replace(/accountCredentials\)/g, 'accountCredentialsCache)');
      novoConteudo = novoConteudo.replace(/accountCredentials,/g, 'accountCredentialsCache,');
    }
    
    // Salvar o arquivo corrigido
    await fs.writeFile(apiFilePath, novoConteudo);
    
    console.log('Correção aplicada com sucesso!');
    console.log('Por favor, reinicie o sistema para aplicar as alterações.');
  } catch (error) {
    console.error('Erro ao corrigir o arquivo:', error);
  }
}

// Executar a função de correção
corrigirCacheCredenciais();