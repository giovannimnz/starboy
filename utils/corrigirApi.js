const fs = require('fs').promises;
const path = require('path');

async function corrigirApi() {
  try {
    console.log('=== CORRIGINDO API.JS ===');
    
    const apiPath = path.join(__dirname, '..', 'api.js');
    let conteudo = await fs.readFile(apiPath, 'utf8');
    
    // Corrigir a query para usar os nomes corretos das colunas
    const queryCorrigida = `
    const [rows] = await db.query(\`
      SELECT 
        c.id,
        c.api_key, 
        c.api_secret, 
        c.ws_api_key, 
        c.ws_api_secret,
        c.id_corretora,
        cor.spot_rest_api_url,
        cor.futures_rest_api_url,
        cor.futures_ws_market_url,
        cor.futures_ws_api_url,
        cor.corretora,
        cor.ambiente
      FROM contas c
      JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1 AND cor.ativa = 1\`,
      [accountId]
    );`;
    
    // Substituir a query incorreta
    conteudo = conteudo.replace(
      /const \[rows\] = await db\.query\(`[\s\S]*?FROM contas c[\s\S]*?WHERE c\.id = \? AND c\.ativa = 1[\s\S]*?`[\s\S]*?\[accountId\]\);/,
      queryCorrigida.trim()
    );
    
    await fs.writeFile(apiPath, conteudo, 'utf8');
    console.log('✅ Arquivo api.js corrigido com sucesso!');
    
  } catch (error) {
    console.error('❌ Erro ao corrigir api.js:', error);
  }
}

corrigirApi();