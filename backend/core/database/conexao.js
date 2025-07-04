const { Pool } = require('pg');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

// Pool de conexões PostgreSQL global
let pool = null;

// Cache para credenciais de API
let apiCredentialsCache = new Map();

// Configuração do banco de dados
const dbConfig = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 20, // connectionLimit equivalente
  idleTimeoutMillis: 300000,
  connectionTimeoutMillis: 2000
};

/**
 * Inicializa o pool de conexões PostgreSQL
 * @returns {Promise<Pool>} - Pool de conexões
 */
async function initPool() {
  try {
    if (pool) {
      console.log('[DB] Pool já existe, retornando instância existente');
      return pool;
    }

    pool = new Pool(dbConfig);
    
    const client = await pool.connect();
    client.release();
    
    return pool;
  } catch (error) {
    console.error('[DB] ❌ Erro ao inicializar pool de conexões:', error.message);
    
    if (error.code === '3D000') { // database does not exist
      console.log('[DB] Database não existe, tentando criar...');
      await createDatabaseIfNotExists();
      return await initPool();
    }
    
    throw error;
  }
}

/**
 * Cria o database se não existir
 */
async function createDatabaseIfNotExists() {
  try {
    const tempConfig = { ...dbConfig };
    tempConfig.database = 'postgres'; // Conectar ao DB padrão
    
    const tempPool = new Pool(tempConfig);
    const client = await tempPool.connect();
    
    await client.query(`CREATE DATABASE "${dbConfig.database}"`);
    console.log(`[DB] ✅ Database '${dbConfig.database}' criado com sucesso`);
    
    client.release();
    await tempPool.end();
  } catch (error) {
    if (error.code !== '42P04') { // database already exists
      console.error('[DB] ❌ Erro ao criar database:', error.message);
      throw error;
    }
  }
}

/**
 * Obtém uma instância de conexão com o banco de dados
 * @param {number} accountId - ID da conta (opcional, para compatibilidade)
 * @returns {Promise<Pool>} - Pool de conexões
 */
async function getDatabaseInstance(accountId = null) {
  try {
    if (accountId && accountId !== 1) {
      //console.log(`[DB] Solicitação de conexão para conta ${accountId}`);
    }
    
    // CORREÇÃO: Verificar se está em processo de shutdown
    if (process.env.SHUTTING_DOWN === 'true') {
      throw new Error('Sistema em processo de shutdown');
    }
    
    if (!pool) {
      console.log('[DB] Pool não inicializado, inicializando agora...');
      await initPool();
    }
    
    if (pool && pool.ended) {
      console.log('[DB] Pool foi encerrado, reinicializando...');
      pool = null;
      await initPool();
    }
    
    return pool;
    
  } catch (error) {
    console.error(`[DB] Erro ao obter instância do banco:`, error.message);
    throw error;
  }
}

/**
 * Testa a conectividade com o banco de dados
 * @returns {Promise<boolean>} - true se conectou com sucesso
 */
async function testConnection() {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query('SELECT CURRENT_TIMESTAMP');
    console.log('[DB] ✅ Teste de conectividade bem-sucedido');
    return true;
  } catch (error) {
    console.error('[DB] ❌ Falha no teste de conectividade:', error.message);
    return false;
  }
}

/**
 * Inicializa o banco de dados e suas tabelas
 * @returns {Promise<void>}
 */
async function initializeDatabase() {
  try {
    console.log('[DB] Inicializando banco de dados...');
    
    await initPool();
    await checkAndCreateTables();
    
    console.log('[DB] ✅ Banco de dados inicializado com sucesso');
    
  } catch (error) {
    console.error('[DB] ❌ Erro ao inicializar banco de dados:', error.message);
    throw error;
  }
}

/**
 * Verifica e cria tabelas principais se não existirem
 */
async function checkAndCreateTables() {
  try {
    const db = await getDatabaseInstance();
    
    // Verificar se tabela 'contas' existe
    const tablesResult = await db.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename = 'contas'
    `);
    
    if (tablesResult.rows.length === 0) {
      console.log('[DB] Criando tabela "contas"...');
      await db.query(`
        CREATE TABLE contas (
          id SERIAL PRIMARY KEY,
          nome VARCHAR(255) NOT NULL,
          descricao TEXT,
          id_corretora INT,
          api_key VARCHAR(255),
          api_secret VARCHAR(255),
          ws_api_key VARCHAR(255),
          ws_api_secret TEXT,
          private_key TEXT,
          api_url VARCHAR(255),
          ws_url VARCHAR(255),
          ws_api_url VARCHAR(255),
          telegram_chat_id VARCHAR(255),
          ativa BOOLEAN DEFAULT true,
          max_posicoes INT DEFAULT 10,
          saldo_base_calculo DECIMAL(15,8) DEFAULT 0,
          saldo_futuros DECIMAL(15,8) DEFAULT 0,
          data_criacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          ultima_atualizacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          celular VARCHAR(20),
          telegram_bot_token VARCHAR(255),
          telegram_bot_token_controller VARCHAR(255)
        )
      `);
      
      // Criar trigger para atualizar ultima_atualizacao
      await db.query(`
        CREATE OR REPLACE FUNCTION update_ultima_atualizacao_contas()
        RETURNS TRIGGER AS $$
        BEGIN
          NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
          RETURN NEW;
        END;
        $$ language 'plpgsql';
        
        CREATE TRIGGER update_contas_ultima_atualizacao
        BEFORE UPDATE ON contas
        FOR EACH ROW
        EXECUTE FUNCTION update_ultima_atualizacao_contas();
      `);
    }
    
    // Verificar outras tabelas essenciais
    await checkTable('webhook_signals');
    await checkTable('posicoes');
    await checkTable('ordens');
    
  } catch (error) {
    console.error('[DB] Erro ao verificar/criar tabelas:', error.message);
    throw error;
  }
}

/**
 * Verifica se uma tabela existe
 * @param {string} tableName - Nome da tabela
 */
async function checkTable(tableName) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT tablename 
      FROM pg_tables 
      WHERE schemaname = 'public' AND tablename = $1
    `, [tableName]);
    
    if (result.rows.length === 0) {
      console.log(`[DB] Tabela "${tableName}" não encontrada, deve ser criada via migration`);
    }
  } catch (error) {
    console.error(`[DB] Erro ao verificar tabela ${tableName}:`, error.message);
  }
}

/**
 * Obtém credenciais de API para uma conta específica
 * @param {number} accountId - ID da conta
 * @returns {Promise<Object>} - Credenciais da conta
 */
async function getApiCredentials(accountId) {
  try {
    // Verificar cache primeiro
    const cacheKey = `account_${accountId}`;
    if (apiCredentialsCache.has(cacheKey)) {
      const cached = apiCredentialsCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 300000) { // 5 minutos
        return cached.data;
      }
    }

    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT api_key, api_secret, ws_api_key, ws_api_secret, telegram_bot_token, telegram_chat_id, nome
      FROM contas 
      WHERE id = $1 AND ativa = true
    `, [accountId]);

    if (result.rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada ou inativa`);
    }

    const credentials = result.rows[0];
    
    // Armazenar no cache
    apiCredentialsCache.set(cacheKey, {
      data: credentials,
      timestamp: Date.now()
    });

    return credentials;
  } catch (error) {
    console.error(`[DB] Erro ao obter credenciais da conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Limpa o cache de credenciais
 */
function clearCredentialsCache() {
  apiCredentialsCache.clear();
}

/**
 * Obtém todas as posições do banco de dados
 * @param {number} accountId - ID da conta
 * @returns {Promise<Array>} - Array de posições
 */
async function getAllPositionsFromDb(accountId) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT * FROM posicoes 
      WHERE conta_id = $1 AND status = 'ABERTA'
      ORDER BY id DESC
    `, [accountId]);
    
    return result.rows;
  } catch (error) {
    console.error(`[DB] Erro ao obter posições da conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Insere uma nova posição no banco de dados
 * @param {Object} positionData - Dados da posição
 * @returns {Promise<number>} - ID da posição inserida
 */
async function insertPosition(positionData) {
  const db = await getDatabaseInstance();
  
  try {
    const query = `
      INSERT INTO posicoes (
        simbolo, quantidade, quantidade_aberta, preco_medio, status, 
        data_hora_abertura, data_hora_fechamento, side, leverage, 
        data_hora_ultima_atualizacao, preco_entrada, preco_corrente, 
        orign_sig, trailing_stop_level, pnl_corrente, conta_id, 
        observacoes, breakeven_price, accumulated_realized, unrealized_pnl, 
        total_realized, total_commission, liquid_pnl, margin_type, 
        isolated_wallet, position_side, event_reason, webhook_data_raw, 
        last_update
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 
        $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29
      ) RETURNING id
    `;
    
    const values = [
      positionData.simbolo,
      positionData.quantidade,
      positionData.quantidade_aberta,
      positionData.preco_medio,
      positionData.status,
      positionData.data_hora_abertura ? formatDateForPostgreSQL(positionData.data_hora_abertura) : formatDateForPostgreSQL(new Date()),
      positionData.data_hora_fechamento ? formatDateForPostgreSQL(positionData.data_hora_fechamento) : null,
      positionData.side,
      positionData.leverage,
      positionData.data_hora_ultima_atualizacao ? formatDateForPostgreSQL(positionData.data_hora_ultima_atualizacao) : formatDateForPostgreSQL(new Date()),
      positionData.preco_entrada,
      positionData.preco_corrente,
      positionData.orign_sig,
      positionData.trailing_stop_level,
      positionData.pnl_corrente,
      positionData.conta_id,
      positionData.observacoes,
      positionData.breakeven_price,
      positionData.accumulated_realized,
      positionData.unrealized_pnl,
      positionData.total_realized,
      positionData.total_commission,
      positionData.liquid_pnl,
      positionData.margin_type,
      positionData.isolated_wallet,
      positionData.position_side,
      positionData.event_reason,
      positionData.webhook_data_raw,
      positionData.last_update ? formatDateForPostgreSQL(positionData.last_update) : null
    ];
    
    const result = await db.query(query, values);
    return result.rows[0].id;
  } catch (error) {
    console.error('[DB] Erro ao inserir posição:', error.message);
    throw error;
  }
}

/**
 * Insere uma nova ordem no banco de dados (legacy)
 * @param {Array} orderData - Dados da ordem em formato array
 * @returns {Promise<number>} - ID da ordem inserida
 */
async function insertOrder(orderData) {
  const db = await getDatabaseInstance();
  
  try {
    const query = `
      INSERT INTO ordens (
        data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, 
        reduce_only, close_position, last_update, preco, quantidade, 
        tipo_ordem, status, id_posicao, target, orign_sig, conta_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
      ) RETURNING id
    `;
    
    const result = await db.query(query, orderData);
    return result.rows[0].id;
  } catch (error) {
    console.error('[DB] Erro ao inserir ordem:', error.message);
    throw error;
  }
}

/**
 * Insere uma nova ordem no banco de dados
 * @param {Object} orderData - Dados da ordem
 * @returns {Promise<number>} - ID da ordem inserida
 */
async function insertNewOrder(orderData) {
  const db = await getDatabaseInstance();
  
  try {
    const query = `
      INSERT INTO ordens (
        simbolo, quantidade, preco, side, tipo_ordem, status, id_posicao, 
        id_externo, data_hora_criacao, tipo_ordem_bot, target, 
        reduce_only, close_position, last_update, renew_sl_firs, 
        renew_sl_seco, renew_sl_terc, renew_sl_quar, renew_sl_quin, 
        renew_sl_seis, renew_sl_sete, renew_sl_oito, renew_sl_nove, 
        renew_sl_dez, preco_sl_original, preco_tp_original, 
        gtd_auto_cancel_time, time_in_force, client_order_id, 
        orign_sig, account_id, is_maker_side, commission, 
        commission_asset, price_protection, conta_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, 
        $29, $30, $31, $32, $33, $34, $35, $36
      ) RETURNING id
    `;
    
    const values = [
      orderData.simbolo,
      orderData.quantidade,
      orderData.preco,
      orderData.side,
      orderData.tipo,
      orderData.status,
      orderData.id_posicao,
      orderData.id_externo,
      orderData.data_hora_criacao,
      orderData.tipo_ordem_bot,
      orderData.target,
      orderData.reduce_only || false,
      orderData.close_position || false,
      orderData.last_update,
      orderData.renew_sl_firs,
      orderData.renew_sl_seco,
      orderData.renew_sl_terc,
      orderData.renew_sl_quar,
      orderData.renew_sl_quin,
      orderData.renew_sl_seis,
      orderData.renew_sl_sete,
      orderData.renew_sl_oito,
      orderData.renew_sl_nove,
      orderData.renew_sl_dez,
      orderData.preco_sl_original,
      orderData.preco_tp_original,
      orderData.gtd_auto_cancel_time,
      orderData.time_in_force,
      orderData.client_order_id,
      orderData.orign_sig,
      orderData.account_id,
      orderData.is_maker_side || false,
      orderData.commission,
      orderData.commission_asset,
      orderData.price_protection || false,
      orderData.conta_id
    ];
    
    const result = await db.query(query, values);
    return result.rows[0].id;
  } catch (error) {
    console.error('[DB] Erro ao inserir ordem:', error.message);
    throw error;
  }
}

/**
 * Obtém data e hora atual formatada
 * @returns {string} - Data e hora formatada
 */
function getCurrentDateTimeAsString() {
  return new Date().toISOString();
}

/**
 * Obtém ordens do banco de dados
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo (opcional)
 * @returns {Promise<Array>} - Array de ordens
 */
async function getOrdersFromDb(accountId, symbol = null) {
  try {
    const db = await getDatabaseInstance();
    let query = `
      SELECT * FROM ordens 
      WHERE conta_id = $1 AND status IN ('NEW', 'PARTIALLY_FILLED')
    `;
    const params = [accountId];
    
    if (symbol) {
      query += ` AND simbolo = $2`;
      params.push(symbol);
    }
    
    query += ` ORDER BY id DESC`;
    
    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    console.error(`[DB] Erro ao obter ordens da conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Obtém posições do banco de dados
 * @param {number} accountId - ID da conta
 * @param {string} symbol - Símbolo (opcional)
 * @returns {Promise<Array>} - Array de posições
 */
async function getPositionsFromDb(accountId, symbol = null) {
  try {
    const db = await getDatabaseInstance();
    let query = `
      SELECT * FROM posicoes 
      WHERE conta_id = $1 AND status = 'ABERTA'
    `;
    const params = [accountId];
    
    if (symbol) {
      query += ` AND simbolo = $2`;
      params.push(symbol);
    }
    
    query += ` ORDER BY id DESC`;
    
    const result = await db.query(query, params);
    return result.rows;
  } catch (error) {
    console.error(`[DB] Erro ao obter posições da conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Atualiza o status de uma ordem
 * @param {number} orderId - ID da ordem
 * @param {string} status - Novo status
 * @returns {Promise<void>}
 */
async function updateOrderStatus(orderId, status) {
  try {
    const db = await getDatabaseInstance();
    await db.query(`
      UPDATE ordens 
      SET status = $1, last_update = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [status, orderId]);
  } catch (error) {
    console.error(`[DB] Erro ao atualizar status da ordem ${orderId}:`, error.message);
    throw error;
  }
}

/**
 * Atualiza o status de uma posição
 * @param {number} positionId - ID da posição
 * @param {string} status - Novo status
 * @returns {Promise<void>}
 */
async function updatePositionStatus(positionId, status) {
  try {
    const db = await getDatabaseInstance();
    await db.query(`
      UPDATE posicoes 
      SET status = $1, data_hora_ultima_atualizacao = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [status, positionId]);
  } catch (error) {
    console.error(`[DB] Erro ao atualizar status da posição ${positionId}:`, error.message);
    throw error;
  }
}

/**
 * Atualiza dados de uma posição
 * @param {number} positionId - ID da posição
 * @param {Object} updateData - Dados para atualização
 * @returns {Promise<void>}
 */
async function updatePositionInDb(positionId, updateData) {
  try {
    const db = await getDatabaseInstance();
    
    const fields = [];
    const values = [];
    let paramIndex = 1;
    
    for (const [key, value] of Object.entries(updateData)) {
      if (value !== undefined) {
        fields.push(`${key} = $${paramIndex}`);
        values.push(value);
        paramIndex++;
      }
    }
    
    if (fields.length === 0) {
      return;
    }
    
    const query = `
      UPDATE posicoes 
      SET ${fields.join(', ')}, data_hora_ultima_atualizacao = CURRENT_TIMESTAMP
      WHERE id = $${paramIndex}
    `;
    values.push(positionId);
    
    await db.query(query, values);
  } catch (error) {
    console.error(`[DB] Erro ao atualizar posição ${positionId}:`, error.message);
    throw error;
  }
}

/**
 * Move posições e ordens fechadas para tabelas históricas
 * @param {number} accountId - ID da conta
 * @returns {Promise<void>}
 */
async function moveClosedPositionsAndOrders(accountId) {
  const db = await getDatabaseInstance();
  const client = await db.connect();
  
  try {
    await client.query('BEGIN');
    
    // Mover posições fechadas
    const closedPositions = await client.query(`
      SELECT * FROM posicoes 
      WHERE conta_id = $1 AND status = 'FECHADA'
    `, [accountId]);
    
    for (const position of closedPositions.rows) {
      await client.query(`
        INSERT INTO posicoes_fechadas (
          id_original, simbolo, quantidade, quantidade_aberta, preco_medio, 
          status, data_hora_abertura, data_hora_fechamento, side, leverage, 
          data_hora_ultima_atualizacao, preco_entrada, preco_corrente, 
          orign_sig, trailing_stop_level, pnl_corrente, conta_id, 
          observacoes, breakeven_price, accumulated_realized, unrealized_pnl, 
          total_realized, total_commission, liquid_pnl, margin_type, 
          isolated_wallet, position_side, event_reason, webhook_data_raw, 
          last_update
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 
          $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
        )
      `, [
        position.id, position.simbolo, position.quantidade, position.quantidade_aberta,
        position.preco_medio, position.status, position.data_hora_abertura,
        position.data_hora_fechamento, position.side, position.leverage,
        position.data_hora_ultima_atualizacao, position.preco_entrada,
        position.preco_corrente, position.orign_sig, position.trailing_stop_level,
        position.pnl_corrente, position.conta_id, position.observacoes,
        position.breakeven_price, position.accumulated_realized, position.unrealized_pnl,
        position.total_realized, position.total_commission, position.liquid_pnl,
        position.margin_type, position.isolated_wallet, position.position_side,
        position.event_reason, position.webhook_data_raw, position.last_update
      ]);
    }
    
    // Mover ordens fechadas
    const closedOrders = await client.query(`
      SELECT * FROM ordens 
      WHERE conta_id = $1 AND status IN ('FILLED', 'CANCELED', 'EXPIRED')
    `, [accountId]);
    
    for (const order of closedOrders.rows) {
      await client.query(`
        INSERT INTO ordens_fechadas (
          id_original, simbolo, quantidade, preco, side, tipo, status, 
          id_posicao, id_externo, data_hora_criacao, tipo_ordem_bot, 
          target, reduce_only, close_position, last_update, conta_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
        )
      `, [
        order.id, order.simbolo, order.quantidade, order.preco, order.side,
        order.tipo, order.status, order.id_posicao, order.id_externo,
        order.data_hora_criacao, order.tipo_ordem_bot, order.target,
        order.reduce_only, order.close_position, order.last_update, order.conta_id
      ]);
    }
    
    // Remover das tabelas principais
    await client.query(`DELETE FROM posicoes WHERE conta_id = $1 AND status = 'FECHADA'`, [accountId]);
    await client.query(`DELETE FROM ordens WHERE conta_id = $1 AND status IN ('FILLED', 'CANCELED', 'EXPIRED')`, [accountId]);
    
    await client.query('COMMIT');
    
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Obtém posição por ID
 * @param {number} positionId - ID da posição
 * @returns {Promise<Object>} - Dados da posição
 */
async function getPositionById(positionId) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT * FROM posicoes WHERE id = $1
    `, [positionId]);
    
    return result.rows[0] || null;
  } catch (error) {
    console.error(`[DB] Erro ao obter posição ${positionId}:`, error.message);
    throw error;
  }
}

/**
 * Obtém data e hora formatada
 * @returns {string} - Data e hora formatada
 */
function getDataHoraFormatada() {
  return new Date().toISOString();
}

/**
 * Atualiza flag de renovação de ordem
 * @param {number} orderId - ID da ordem
 * @param {string} renewField - Campo de renovação
 * @param {boolean} value - Valor
 * @returns {Promise<void>}
 */
async function updateOrderRenewFlag(orderId, renewField, value) {
  try {
    const db = await getDatabaseInstance();
    await db.query(`
      UPDATE ordens 
      SET ${renewField} = $1, last_update = CURRENT_TIMESTAMP
      WHERE id = $2
    `, [value, orderId]);
  } catch (error) {
    console.error(`[DB] Erro ao atualizar flag de renovação:`, error.message);
    throw error;
  }
}

/**
 * Insere um signal de webhook
 * @param {Object} signalData - Dados do signal
 * @returns {Promise<number>} - ID do signal inserido
 */
async function insertWebhookSignal(signalData) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      INSERT INTO webhook_signals (
        symbol, side, timeframe, status, conta_id, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) RETURNING id
    `, [
      signalData.symbol,
      signalData.side,
      signalData.timeframe,
      signalData.status,
      signalData.conta_id
    ]);
    
    return result.rows[0].id;
  } catch (error) {
    console.error('[DB] Erro ao inserir webhook signal:', error.message);
    throw error;
  }
}

/**
 * Insere um signal de webhook com detalhes
 * @param {Object} signalData - Dados do signal
 * @returns {Promise<number>} - ID do signal inserido
 */
async function insertWebhookSignalWithDetails(signalData) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      INSERT INTO webhook_signals (
        symbol, side, timeframe, status, conta_id, message_id, chat_id,
        entry_price, sl_price, tp_price, quantity, leverage, divap_confirmado,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      ) RETURNING id
    `, [
      signalData.symbol,
      signalData.side,
      signalData.timeframe,
      signalData.status,
      signalData.conta_id,
      signalData.message_id,
      signalData.chat_id,
      signalData.entry_price,
      signalData.sl_price,
      signalData.tp_price,
      signalData.quantity,
      signalData.leverage,
      signalData.divap_confirmado || false
    ]);
    
    return result.rows[0].id;
  } catch (error) {
    console.error('[DB] Erro ao inserir webhook signal com detalhes:', error.message);
    throw error;
  }
}

/**
 * Formata uma data para PostgreSQL
 * Corrige também datas futuras (ano 2025) para o ano atual
 * @param {Date|string|null} date - Data a ser formatada
 * @returns {string|null} - Data formatada para PostgreSQL ou null se a entrada for null/undefined
 */
function formatDateForPostgreSQL(date) {
  if (!date) return null;

  // Converter para objeto Date se for string
  let dateObj = date instanceof Date ? date : new Date(date);

  // Corrigir ano se estiver no futuro (bug comum em alguns sistemas)
  const currentYear = new Date().getFullYear();
  const currentDate = new Date();

  if (dateObj.getFullYear() > currentYear) {
    console.log(`[DB] Corrigindo data futura: ${dateObj.toISOString()} → ano atual`);
    dateObj.setFullYear(currentYear);
  }

  // Verificar se a data ainda está no futuro (mesmo após corrigir o ano)
  if (dateObj > currentDate) {
    console.log(`[DB] Data ainda no futuro após correção do ano, ajustando para data atual`);
    dateObj = new Date(); // Usar data atual
  }

  // PostgreSQL aceita ISO format
  return dateObj.toISOString();
}

/**
 * Mantém compatibilidade com código existente
 * @param {Date|string|null} date - Data a ser formatada
 * @returns {string|null} - Data formatada
 */
function formatDateForPostgreSQL(date) {
  return formatDateForPostgreSQL(date);
}

/**
 * Atualiza o saldo_futuros da conta e possivelmente o saldo_base_calculo_futuros
 * @param {Object} db - Pool de conexões com o banco de dados
 * @param {number} saldo - Novo valor de saldo
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object>} - Objeto com os valores atualizados
 */
async function updateAccountBalance(db, saldo, accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório: ${accountId} (tipo: ${typeof accountId})`);
  }

  const client = await db.connect();
  
  try {
    await client.query('BEGIN');

    // 1. Buscar saldo_futuros atual e saldo_base_calculo_futuros para conta específica
    const currentBalanceResult = await client.query(`
      SELECT saldo_futuros, saldo_base_calculo_futuros 
      FROM contas 
      WHERE id = $1 AND ativa = true
    `, [accountId]);

    if (currentBalanceResult.rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada ou inativa`);
    }

    const currentBalance = currentBalanceResult.rows[0];
    const currentSaldoFuturos = parseFloat(currentBalance.saldo_futuros) || 0;
    const currentSaldoBaseCalculo = parseFloat(currentBalance.saldo_base_calculo_futuros) || 0;

    // 2. Se saldo_base_calculo_futuros for null ou 0, definir como saldo atual
    let newSaldoBaseCalculo = currentSaldoBaseCalculo;
    if (currentSaldoBaseCalculo === 0) {
      newSaldoBaseCalculo = saldo;
    }

    // 3. Atualizar saldo_futuros
    await client.query(`
      UPDATE contas 
      SET saldo_futuros = $1, saldo_base_calculo_futuros = $2
      WHERE id = $3
    `, [saldo, newSaldoBaseCalculo, accountId]);

    await client.query('COMMIT');

    return {
      saldo_futuros: saldo,
      saldo_base_calculo_futuros: newSaldoBaseCalculo,
      saldo_anterior: currentSaldoFuturos,
      conta_id: accountId
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Obtém saldo base de cálculo
 * @param {number} accountId - ID da conta
 * @returns {Promise<number>} - Saldo base de cálculo
 */
async function getBaseCalculoBalance(accountId) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT saldo_base_calculo_futuros 
      FROM contas 
      WHERE id = $1 AND ativa = true
    `, [accountId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada ou inativa`);
    }
    
    return parseFloat(result.rows[0].saldo_base_calculo_futuros) || 0;
  } catch (error) {
    console.error(`[DB] Erro ao obter saldo base de cálculo:`, error.message);
    throw error;
  }
}

/**
 * Obtém dados de uma corretora por ID
 * @param {number} corretoraId - ID da corretora
 * @returns {Promise<Object>} - Dados da corretora
 */
async function getCorretoraPorId(corretoraId) {
  try {
    const db = await getDatabaseInstance();
    const result = await db.query(`
      SELECT * FROM corretoras 
      WHERE id = $1 AND ativa = true
    `, [corretoraId]);
    
    return result.rows[0] || null;
  } catch (error) {
    console.error(`[DB] Erro ao obter corretora ${corretoraId}:`, error.message);
    throw error;
  }
}

/**
 * Registra um log no banco de dados
 * @param {string} nivel - Nível do log
 * @param {string} mensagem - Mensagem do log
 * @param {string} modulo - Módulo que gerou o log
 * @param {number} contaId - ID da conta (opcional)
 * @returns {Promise<void>}
 */
async function registrarLog(nivel, mensagem, modulo, contaId = null) {
  try {
    const db = await getDatabaseInstance();
    await db.query(`
      INSERT INTO logs (nivel, mensagem, modulo, conta_id, data_hora)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
    `, [nivel, mensagem, modulo, contaId]);
  } catch (error) {
    console.error('[DB] Erro ao registrar log:', error.message);
    // Não propagar erro de log para não quebrar o fluxo principal
  }
}

/**
 * Encerra o pool de conexões de forma segura
 */
async function closePool() {
  if (pool) {
    console.log('[DB] Encerrando pool de conexões PostgreSQL...');
    await pool.end();
    pool = null;
    console.log('[DB] ✅ Pool de conexões PostgreSQL encerrado');
  }
}

// Gerenciamento de desligamento gracioso
process.on('SIGINT', async () => {
  console.log('\n[DB] Recebido SIGINT, encerrando conexões...');
  await closePool();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n[DB] Recebido SIGTERM, encerrando conexões...');
  await closePool();
  process.exit(0);
});

module.exports = {
  getDatabaseInstance,
  initPool,
  testConnection,
  initializeDatabase,
  checkAndCreateTables,
  getApiCredentials,
  clearCredentialsCache,
  getAllPositionsFromDb,
  insertPosition,
  insertOrder,
  insertNewOrder,
  getCurrentDateTimeAsString,
  getOrdersFromDb,
  getPositionsFromDb,
  updateOrderStatus,
  updatePositionStatus,
  updatePositionInDb,
  moveClosedPositionsAndOrders,
  getPositionById,
  getDataHoraFormatada,
  updateOrderRenewFlag,
  insertWebhookSignal,
  insertWebhookSignalWithDetails,
  formatDateForPostgreSQL,
  formatDateForPostgreSQL,
  updateAccountBalance,
  getBaseCalculoBalance,
  getCorretoraPorId,
  registrarLog,
  closePool
};
