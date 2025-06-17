const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDatabaseInstance } = require('../db/conexao');

async function verificarTabelaContasAtualizada() {
  try {
    console.log('🔍 Verificando estrutura ATUAL da tabela contas...\n');
    
    const db = await getDatabaseInstance();
    
    // Verificar estrutura da tabela contas
    console.log('📊 ESTRUTURA ATUAL DA TABELA CONTAS:');
    const [structure] = await db.query('DESCRIBE contas');
    structure.forEach(field => {
      console.log(`  - ${field.Field}: ${field.Type} ${field.Null === 'NO' ? '(NOT NULL)' : '(NULL)'}${field.Key ? ` [${field.Key}]` : ''}`);
    });
    
    // Verificar se há dados na conta 1
    console.log('\n💰 DADOS DA CONTA 1:');
    const [conta1] = await db.query(`
      SELECT id, nome, api_key, ws_api_key, private_key, id_corretora, ativa 
      FROM contas 
      WHERE id = 1
    `);
    
    if (conta1.length > 0) {
      const c = conta1[0];
      console.log(`- ID: ${c.id}`);
      console.log(`- Nome: ${c.nome}`);
      console.log(`- API Key: ${c.api_key ? c.api_key.substring(0, 8) + '...' : '❌ Não configurada'}`);
      console.log(`- WS API Key: ${c.ws_api_key ? c.ws_api_key.substring(0, 8) + '...' : '❌ Não configurada'}`);
      console.log(`- Private Key: ${c.private_key ? '✅ Configurada' : '❌ Não configurada'}`);
      console.log(`- ID Corretora: ${c.id_corretora || 'NULL'}`);
      console.log(`- Ativa: ${c.ativa ? 'SIM' : 'NÃO'}`);
    } else {
      console.log('❌ Conta 1 não encontrada');
    }
    
    // Verificar corretoras
    console.log('\n📊 CORRETORAS DISPONÍVEIS:');
    const [corretoras] = await db.query(`
      SELECT id, corretora, ambiente, spot_rest_api_url, futures_ws_market_url, futures_ws_api_url 
      FROM corretoras 
      WHERE ativa = 1
    `);
    
    if (corretoras.length > 0) {
      corretoras.forEach(cor => {
        console.log(`  - ID ${cor.id}: ${cor.corretora} (${cor.ambiente})`);
        console.log(`    API: ${cor.spot_rest_api_url}`);
        console.log(`    WS Market: ${cor.futures_ws_market_url}`);
        console.log(`    WS API: ${cor.futures_ws_api_url}`);
      });
    } else {
      console.log('❌ Nenhuma corretora ativa encontrada');
    }
    
    // Teste da query corrigida
    console.log('\n🧪 TESTE DA QUERY CORRIGIDA:');
    const [testQuery] = await db.query(`
      SELECT 
        c.id,
        c.nome,
        c.api_key, 
        c.api_secret,
        c.ws_api_key, 
        c.ws_api_secret, 
        c.private_key,
        c.ativa,
        c.id_corretora,
        cor.spot_rest_api_url as api_url,
        cor.futures_ws_market_url as ws_url,
        cor.futures_ws_api_url as ws_api_url,
        cor.ambiente,
        cor.corretora
      FROM contas c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = 1 AND c.ativa = 1
    `);
    
    if (testQuery.length > 0) {
      console.log('✅ Query funciona corretamente!');
      const result = testQuery[0];
      console.log(`- Conta: ${result.nome}`);
      console.log(`- Corretora: ${result.corretora || 'NULL'}`);
      console.log(`- Ambiente: ${result.ambiente || 'NULL'}`);
      console.log(`- API URL: ${result.api_url || 'NULL'}`);
      console.log(`- WS URL: ${result.ws_url || 'NULL'}`);
      console.log(`- WS API URL: ${result.ws_api_url || 'NULL'}`);
    } else {
      console.log('❌ Query não retornou resultados');
    }
    
    console.log('\n🎉 Verificação concluída!');
    
  } catch (error) {
    console.error('❌ Erro na verificação:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

if (require.main === module) {
  verificarTabelaContasAtualizada();
}

module.exports = { verificarTabelaContasAtualizada };