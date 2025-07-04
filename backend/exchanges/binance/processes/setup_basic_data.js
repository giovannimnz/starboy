/**
 * Script para verificar e criar dados básicos no banco de dados
 */

const { getDatabaseInstance } = require('../../../core/database/conexao');

async function checkAndCreateBasicData() {
  try {
    console.log('🔍 === VERIFICANDO DADOS BÁSICOS NO BANCO ===');
    
    const db = await getDatabaseInstance();
    
    // 1. Verificar se existem corretoras
    console.log('\n📊 Verificando corretoras...');
    const corretorasResult = await db.query('SELECT COUNT(*) as count FROM corretoras');
    const corretorasCount = parseInt(corretorasResult.rows[0].count);
    
    console.log(`📊 Corretoras encontradas: ${corretorasCount}`);
    
    if (corretorasCount === 0) {
      console.log('➕ Criando corretora padrão (Binance Testnet)...');
      
      await db.query(`
        INSERT INTO corretoras (
          corretora, 
          ambiente, 
          futures_rest_api_url, 
          spot_rest_api_url, 
          futures_ws_market_url, 
          futures_ws_api_url
        ) VALUES (
          'binance', 
          'testnet', 
          'https://testnet.binancefuture.com', 
          'https://testnet.binance.vision', 
          'wss://stream.binancefuture.com/ws', 
          'wss://testnet.binancefuture.com/ws-api/v3'
        )
      `);
      
      console.log('✅ Corretora Binance Testnet criada');
    }
    
    // 2. Verificar se existem usuários
    console.log('\n👥 Verificando usuários...');
    const usersResult = await db.query('SELECT COUNT(*) as count FROM users');
    const usersCount = parseInt(usersResult.rows[0].count);
    
    console.log(`👥 Usuários encontrados: ${usersCount}`);
    
    if (usersCount === 0) {
      console.log('➕ Criando usuário padrão...');
      
      await db.query(`
        INSERT INTO users (
          nome, 
          email, 
          senha, 
          ativo
        ) VALUES (
          'Usuário Padrão', 
          'admin@starboy.com', 
          'hash_da_senha_aqui', 
          true
        )
      `);
      
      console.log('✅ Usuário padrão criado');
    }
    
    // 3. Verificar se existem contas
    console.log('\n🏦 Verificando contas...');
    const contasResult = await db.query('SELECT COUNT(*) as count FROM contas');
    const contasCount = parseInt(contasResult.rows[0].count);
    
    console.log(`🏦 Contas encontradas: ${contasCount}`);
    
    if (contasCount === 0) {
      console.log('➕ Criando conta padrão...');
      
      // Buscar ID da primeira corretora
      const corretoraResult = await db.query('SELECT id FROM corretoras LIMIT 1');
      const corretoraId = corretoraResult.rows[0].id;
      
      // Buscar ID do primeiro usuário
      const userResult = await db.query('SELECT id FROM users LIMIT 1');
      const userId = userResult.rows[0].id;
      
      await db.query(`
        INSERT INTO contas (
          nome, 
          id_corretora, 
          user_id,
          api_key, 
          api_secret, 
          ativa
        ) VALUES (
          'Conta Teste 1', 
          $1, 
          $2,
          'sua_api_key_aqui', 
          'sua_api_secret_aqui', 
          true
        )
      `, [corretoraId, userId]);
      
      console.log('✅ Conta padrão criada');
    }
    
    // 4. Listar contas disponíveis
    console.log('\n📋 === CONTAS DISPONÍVEIS ===');
    const allAccountsResult = await db.query(`
      SELECT c.id, c.nome, c.ativa, cor.corretora, cor.ambiente 
      FROM contas c 
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id 
      ORDER BY c.id
    `);
    
    const allAccounts = allAccountsResult.rows;
    console.log(`📋 Total de contas: ${allAccounts.length}`);
    
    allAccounts.forEach(account => {
      console.log(`📋   - ID: ${account.id}, Nome: ${account.nome}, Ativa: ${account.ativa}, Corretora: ${account.corretora} (${account.ambiente})`);
    });
    
    console.log('\n🎯 === INSTRUÇÕES ===');
    if (allAccounts.length > 0) {
      const firstAccount = allAccounts[0];
      console.log(`✅ Use: node orchMonitor.js --account ${firstAccount.id}`);
      console.log(`✅ Para testar com a conta: "${firstAccount.nome}"`);
    } else {
      console.log('❌ Nenhuma conta encontrada - algo deu errado na criação');
    }
    
  } catch (error) {
    console.error('❌ Erro ao verificar/criar dados básicos:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Executar se for chamado diretamente
if (require.main === module) {
  checkAndCreateBasicData();
}

module.exports = { checkAndCreateBasicData };
