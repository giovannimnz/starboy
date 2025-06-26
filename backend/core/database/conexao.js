const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

// Pool de conexões MySQL global
let pool = null;

// Configuração do banco de dados
const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 20,
  queueLimit: 0,
  waitForConnections: true,
  idleTimeout: 300000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4'
};

/**
 * Inicializa o pool de conexões MySQL
 * @returns {Promise<mysql.Pool>} - Pool de conexões
 */
/**
 * Inicializa o pool de conexões MySQL
 * @returns {Promise<mysql.Pool>} - Pool de conexões
 */
async function initPool() {
  try {
    if (pool) {
      console.log('[DB] Pool já existe, retornando instância existente');
      return pool;
    }

    console.log('[DB] Inicializando pool de conexões MySQL...');
    console.log(`[DB] Conectando a: ${dbConfig.host}:3306/${dbConfig.database}`);
    
    pool = mysql.createPool(dbConfig);
    
    const connection = await pool.getConnection();
    console.log('[DB] ✅ Pool de conexões MySQL inicializado com sucesso');
    connection.release();
    
    return pool;
  } catch (error) {
    console.error('[DB] ❌ Erro ao inicializar pool de conexões:', error.message);
    
    if (error.code === 'ER_BAD_DB_ERROR') {
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
    delete tempConfig.database; // Conectar sem especificar database
    
    const tempPool = mysql.createPool(tempConfig);
    const connection = await tempPool.getConnection();
    
    await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    console.log(`[DB] ✅ Database '${dbConfig.database}' criado com sucesso`);
    
    connection.release();
    tempPool.end();
  } catch (error) {
    console.error('[DB] ❌ Erro ao criar database:', error.message);
    throw error;
  }
}

/**
 * Obtém uma instância de conexão com o banco de dados
 * @param {number} accountId - ID da conta (opcional, para compatibilidade)
 * @returns {Promise<mysql.Pool>} - Pool de conexões
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
    
    if (pool && pool.pool && pool.pool.destroyed) {
      console.log('[DB] Pool foi destruído, reinicializando...');
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
 * Inicializa o banco de dados e suas tabelas
 * @returns {Promise<void>}
 */
async function initializeDatabase() {
  try {
    console.log('[DB] Inicializando banco de dados...');
    
    // Primeiro inicializar o pool
    await initPool();
    
    // Verificar se as tabelas principais existem
    await checkAndCreateTables();
    
    // Verificar e adicionar colunas faltantes
    await checkAndAddColumns();
    
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
    const [tables] = await db.query(`
      SELECT TABLE_NAME 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'contas'
    `, [dbConfig.database]);
    
    if (tables.length === 0) {
      console.log('[DB] Criando tabela "contas"...');
      await db.query(`
        CREATE TABLE contas (
          id INT PRIMARY KEY AUTO_INCREMENT,
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
          ativa TINYINT DEFAULT 1,
          max_posicoes INT DEFAULT 10,
          saldo_base_calculo DECIMAL(15,8) DEFAULT 0,
          saldo_futuros DECIMAL(15,8) DEFAULT 0,
          data_criacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          ultima_atualizacao TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          celular VARCHAR(20),
          telegram_bot_token VARCHAR(255),
          telegram_bot_token_controller VARCHAR(255)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
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
 * Verifica se uma tabela existe, se não cria uma versão básica
 * @param {string} tableName - Nome da tabela
 */
async function checkTable(tableName) {
  try {
    const db = await getDatabaseInstance();
    
    const [tables] = await db.query(`
      SELECT TABLE_NAME 
      FROM information_schema.TABLES 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `, [dbConfig.database, tableName]);
    
    if (tables.length === 0) {
      console.log(`[DB] Criando tabela "${tableName}"...`);
      
      switch (tableName) {
        case 'webhook_signals':
          await db.query(`
            CREATE TABLE webhook_signals (
              id INT PRIMARY KEY AUTO_INCREMENT,
              symbol VARCHAR(50) NOT NULL,
              side ENUM('BUY', 'SELL', 'COMPRA', 'VENDA') NOT NULL,
              entry_price DECIMAL(15,8),
              status ENUM('PENDING', 'PROCESSANDO', 'EXECUTED', 'ERROR', 'AGUARDANDO_ACIONAMENTO') DEFAULT 'PENDING',
              conta_id INT DEFAULT 1,
              error_message TEXT,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_status (status),
              INDEX idx_conta_id (conta_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `);
          break;
          
        case 'posicoes':
          await db.query(`
            CREATE TABLE posicoes (
              id INT PRIMARY KEY AUTO_INCREMENT,
              simbolo VARCHAR(50) NOT NULL,
              status ENUM('OPEN', 'CLOSED', 'PENDING') DEFAULT 'PENDING',
              conta_id INT DEFAULT 1,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_simbolo (simbolo),
              INDEX idx_status (status),
              INDEX idx_conta_id (conta_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `);
          break;
          
        case 'ordens':
          await db.query(`
            CREATE TABLE ordens (
              id INT PRIMARY KEY AUTO_INCREMENT,
              id_externo VARCHAR(100),
              simbolo VARCHAR(50) NOT NULL,
              status ENUM('OPEN', 'FILLED', 'CANCELED', 'PENDING') DEFAULT 'PENDING',
              conta_id INT DEFAULT 1,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
              INDEX idx_id_externo (id_externo),
              INDEX idx_simbolo (simbolo),
              INDEX idx_status (status),
              INDEX idx_conta_id (conta_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
          `);
          break;
      }
    }
    
  } catch (error) {
    console.error(`[DB] Erro ao verificar tabela ${tableName}:`, error.message);
  }
}

/**
 * Verifica e adiciona colunas faltantes nas tabelas
 */
async function checkAndAddColumns() {
  try {
    const db = await getDatabaseInstance();
    
    // Verificar se conta 1 existe, se não criar
    const [contas] = await db.query('SELECT id FROM contas WHERE id = 1');
    if (contas.length === 0) {
      console.log('[DB] Criando conta padrão (ID: 1)...');
      await db.query(`
        INSERT INTO contas (id, nome, ativa) 
        VALUES (1, 'Conta Principal', 1)
      `);
    }
    
  } catch (error) {
    console.error('[DB] Erro ao verificar/adicionar colunas:', error.message);
  }
}

/**
 * Fecha o pool de conexões
 */
async function closePool() {
  if (pool) {
    console.log('[DB] Fechando pool de conexões...');
    try {
      await pool.end();
      pool = null;
      console.log('[DB] Pool de conexões fechado');
    } catch (error) {
      console.error('[DB] Erro ao fechar pool:', error.message);
    }
  }
}


// Fechar pool graciosamente ao encerrar aplicação
//process.on('SIGINT', closePool);
//process.on('SIGTERM', closePool);
//process.on('exit', closePool);

// Obter todas as ordens por símbolo
async function getAllOrdersBySymbol(db, symbol) {
  try {
    const [rows] = await db.query("SELECT id_externo, simbolo FROM ordens WHERE simbolo = ?", [symbol]);
    return rows;
  } catch (error) {
    console.error(`Erro ao consultar ordens por símbolo: ${error.message}`);
    throw error;
  }
}

// Desconectar do banco de dados
async function disconnectDatabase() {
  if (dbPool) {
    try {
      await dbPool.end();
      console.log('Conexão com o banco de dados encerrada.');
      dbPool = null;
    } catch (error) {
      console.error('Erro ao fechar a conexão com o banco de dados:', error.message);
    }
  }
}

// Obter todas as posições do banco de dados
async function getAllPositionsFromDb(db) {
  try {
    const [rows] = await db.query("SELECT * FROM posicoes WHERE status = 'OPEN'");
    return rows;
  } catch (error) {
    console.error(`Erro ao consultar posições abertas: ${error.message}`);
    throw error;
  }
}

// Função para obter o último ID de posição aberta para um determinado símbolo
async function getPositionIdBySymbol(db, symbol) {
  try {
    const [rows] = await db.query(
        "SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' ORDER BY data_hora_abertura DESC LIMIT 1",
        [symbol]
    );
    return rows.length > 0 ? rows[0].id : null;
  } catch (error) {
    console.error('Erro ao buscar ID de posição:', error.message);
    throw error;
  }
}

// Exemplo de modificação para checkPositionExists
async function checkPositionExists(db, symbol, accountId) {
  try {
    const [rows] = await db.query(
      "SELECT id FROM posicoes WHERE simbolo = ? AND (status = 'OPEN' OR status = 'PENDING') AND conta_id = ?",
      [symbol, accountId]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`[MONITOR] Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

// Atualizar função insertPosition para usar formatDateForMySQL

async function insertPosition(connection, positionData, webhookSignalId = null) {
  try {
    // Verificar se o status é válido
    const validStatus = ['PENDING', 'OPEN', 'CLOSED', 'CANCELED', 'PENDING_ENTRY'];
    if (!validStatus.includes(positionData.status)) {
      throw new Error(`Status inválido: ${positionData.status}`);
    }

    const accountId = positionData.conta_id || connection.accountId || 1;
    
    // Modificar a verificação de posição para incluir conta_id
    const exists = await checkPositionExists(connection, positionData.simbolo, accountId);
    
    if (exists) {
      console.log(`Posição já existe para o símbolo: ${positionData.simbolo} na conta ${accountId}`);
      return null;
    } else {
      // Incluir conta_id na inserção
      const query = `INSERT INTO posicoes (
        simbolo, quantidade, preco_medio, status, data_hora_abertura, 
        side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig, conta_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

      const params = [
        positionData.simbolo,
        positionData.quantidade,
        positionData.preco_medio,
        'OPEN',
        formatDateForMySQL(positionData.data_hora_abertura),
        positionData.side,
        positionData.leverage,
        formatDateForMySQL(positionData.data_hora_ultima_atualizacao),
        positionData.preco_entrada,
        positionData.preco_corrente,
        positionData.orign_sig || null,
        accountId
      ];

      const [result] = await connection.query(query, params);
      const positionId = result.insertId;
      
      console.log(`Posição inserida com sucesso com ID: ${positionId} para conta ${accountId}`);
      
      // Atualizar também o webhook_signal se necessário, incluindo conta_id na condição
      if (webhookSignalId) {
        try {
          console.log(`Atualizando webhook_signals com position_id=${positionId} para signal_id=${webhookSignalId}`);
          await connection.query(
            `UPDATE webhook_signals SET position_id = ? WHERE id = ? AND conta_id = ?`,
            [positionId, webhookSignalId, accountId]
          );
        } catch (updateError) {
          console.error(`Erro ao atualizar position_id no webhook_signals: ${updateError.message}`);
        }
      } else {
        // Tentar encontrar um sinal correspondente por símbolo, mesmo sem o ID explícito
        try {
          // Buscar o sinal mais recente com status='EXECUTADO' e position_id=NULL para este símbolo
          const [signalRows] = await connection.query(
            `SELECT id FROM webhook_signals 
             WHERE symbol = ? AND status = 'EXECUTADO' AND position_id IS NULL 
             ORDER BY created_at DESC LIMIT 1`,
            [positionData.simbolo]
          );
          
          if (signalRows.length > 0) {
            const signalId = signalRows[0].id;
            console.log(`Encontrado webhook_signal_id=${signalId} para símbolo ${positionData.simbolo}. Atualizando com position_id=${positionId}`);
            await connection.query(
              `UPDATE webhook_signals SET position_id = ? WHERE id = ?`,
              [positionId, signalId]
            );
          }
        } catch (findError) {
          console.error(`Erro ao buscar/atualizar sinal para posição: ${findError.message}`);
          // Não interromper o fluxo por falha nessa atualização
        }
      }
      
      return positionId;
    }
  } catch (error) {
    console.error(`Erro ao inserir posição: ${error.message}`);
    throw error;
  }
}

// Verificar se uma ordem já existe
async function checkOrderExists(db, id_externo) {
  try {
    const [rows] = await db.query("SELECT 1 FROM ordens WHERE id_externo = ?", [id_externo]);
    return rows.length > 0;
  } catch (error) {
    console.error(`Erro ao verificar existência de ordem: ${error.message}`);
    throw error;
  }
}

// Atualizar função insertNewOrder para usar formatDateForMySQL

async function insertNewOrder(connection, orderData) {
  try {
    // Construir a query dinamicamente com base nas colunas disponíveis
    let columns = ['tipo_ordem', 'preco', 'quantidade', 'id_posicao', 'status', 
                  'data_hora_criacao', 'id_externo', 'side', 'simbolo', 
                  'tipo_ordem_bot', 'target', 'reduce_only', 'close_position', 
                  'last_update'];
                  
    let placeholders = Array(columns.length).fill('?');
    let values = [
      orderData.tipo_ordem,
      orderData.preco,
      orderData.quantidade,
      orderData.id_posicao,
      orderData.status,
      orderData.data_hora_criacao,
      orderData.id_externo,
      orderData.side,
      orderData.simbolo,
      orderData.tipo_ordem_bot,
      orderData.target,
      orderData.reduce_only ? 1 : 0,
      orderData.close_position ? 1 : 0,
      orderData.last_update
    ];
    
    // Verificar e adicionar orign_sig se existir no orderData e na tabela
    const [orignSigCheck] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);
    if (orignSigCheck.length > 0 && orderData.orign_sig) {
      columns.push('orign_sig');
      placeholders.push('?');
      values.push(orderData.orign_sig);
    }
    
    // Verificar e adicionar observacao se existir no orderData e na tabela
    const [observacaoCheck] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'observacao'`);
    if (observacaoCheck.length > 0 && orderData.observacao) {
      columns.push('observacao');
      placeholders.push('?');
      values.push(orderData.observacao);
    }
    
    const query = `INSERT INTO ordens (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
    
    const [result] = await connection.query(query, values);
    console.log(`Ordem de ${orderData.tipo_ordem_bot} inserida com sucesso: ${result.insertId}`);
    
    return result.insertId;
  } catch (error) {
    console.error(`Erro ao inserir ordem: ${error.message}`, error);
    throw error;
  }
}

// Inserir uma nova ordem durante a sincronização
async function insertOrder(db, tipo_ordem, preco, quantidade, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update) {
  try {
    console.log("Simbolo enviado para getPositionIdBySymbol:", simbolo);
    const id_posicao = await getPositionIdBySymbol(db, simbolo);
    if (!id_posicao) {
      console.log(`Nenhuma posição aberta encontrada para o símbolo: ${simbolo}`);
      return null;
    }

    const exists = await checkOrderExists(db, id_externo);
    if (exists) {
      console.log(`Ordem já existe para o ID externo: ${id_externo}`);
      return null;
    } else {
      const reduceOnlyValue = reduce_only ? 1 : 0;
      const closePositionValue = close_position ? 1 : 0;

      const [result] = await db.query(
          `INSERT INTO ordens (
          tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao,
            id_externo, side, simbolo, tipo_ordem_bot, target, reduceOnlyValue, closePositionValue, last_update
          ]
      );

      console.log(`Nova ordem inserida com ID ${result.insertId}.`);
      return result.insertId;
    }
  } catch (error) {
    console.error('Erro durante a inserção da ordem:', error);
    throw error;
  }
}

// Obter ordens abertas do banco de dados
async function getOpenOrdersFromDb(db) {
  try {
    const [rows] = await db.query("SELECT id_externo, simbolo FROM ordens WHERE status = 'OPEN'");
    return rows;
  } catch (error) {
    console.error(`Erro ao consultar ordens abertas: ${error.message}`);
    throw error;
  }
}

// Obter ordens com filtros específicos
async function getOrdersFromDb(db, params) {
  try {
    // Construir a consulta SQL base
    let sql = "SELECT id, id_externo, simbolo, tipo_ordem, preco, quantidade, " +
        "id_posicao, status, data_hora_criacao, side, tipo_ordem_bot, " +
        "target, reduce_only, close_position, last_update";

    // Verificar se as colunas adicionais existem
    const [columns] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ordens'`,
        [process.env.DB_NAME]
    );

    const columnNames = columns.map(col => col.COLUMN_NAME);

    // Adicionar colunas extras se existirem
    if (columnNames.includes("renew_sl_firs")) sql += ", renew_sl_firs";
    if (columnNames.includes("renew_sl_seco")) sql += ", renew_sl_seco";
    if (columnNames.includes("orign_sig")) sql += ", orign_sig";

    sql += " FROM ordens";

    // Adicionar condições WHERE
    let conditions = [];
    let sqlValues = [];

    if (params.status) {
      conditions.push("status = ?");
      sqlValues.push(params.status);
    }
    if (params.tipo_ordem_bot) {
      conditions.push("tipo_ordem_bot = ?");
      sqlValues.push(params.tipo_ordem_bot);
    }
    if (params.target) {
      conditions.push("target = ?");
      sqlValues.push(params.target);
    }
    if (params.id_externo) {
      conditions.push("id_externo = ?");
      sqlValues.push(params.id_externo);
    }

    // Adicionar condição para renew_sl_firs se existir
    if (params.renew_sl_firs !== undefined && columnNames.includes("renew_sl_firs")) {
      conditions.push("renew_sl_firs IS ?");
      sqlValues.push(params.renew_sl_firs);
    }

    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }

    const [rows] = await db.query(sql, sqlValues);

    // Preencher propriedades ausentes para manter consistência
    const completeRows = rows.map(row => {
      if (!row.hasOwnProperty('renew_sl_firs')) row.renew_sl_firs = null;
      if (!row.hasOwnProperty('renew_sl_seco')) row.renew_sl_seco = null;
      if (!row.hasOwnProperty('orign_sig')) row.orign_sig = null;
      return row;
    });

    return completeRows;
  } catch (error) {
    console.error(`Erro ao consultar ordens: ${error.message}`);
    throw error;
  }
}

// Obter posições por status
async function getPositionsFromDb(db, status) {
  try {
    const [rows] = await db.query(`SELECT * FROM posicoes WHERE status = ?`, [status]);
    return rows;
  } catch (error) {
    console.error(`Erro ao consultar posições: ${error.message}`);
    throw error;
  }
}

// Atualizar status de uma ordem
async function updateOrderStatus(db, orderId, newStatus) {
  try {
    await db.query("UPDATE ordens SET status = ? WHERE id = ?", [newStatus, orderId]);
    console.log(`Status da ordem ${orderId} atualizado para ${newStatus}`);
  } catch (error) {
    console.error(`Erro ao atualizar status da ordem ${orderId}: ${error.message}`);
    throw error;
  }
}

// Corrigir a função updatePositionStatus
async function updatePositionStatus(db, symbol, updates) {
  try {
    // Primeiro obter os dados atuais da posição para não substituir com NULL
    const [rows] = await db.query(
        'SELECT * FROM posicoes WHERE simbolo = ? AND status != "CLOSED" LIMIT 1',
        [symbol]
    );

    if (rows.length === 0) {
      console.error(`Posição não encontrada para o símbolo: ${symbol}`);
      return false;
    }

    const posicaoAtual = rows[0];
    const data_hora_ultima_atualizacao = getCurrentDateTimeAsString();

    // Atualizar apenas os campos fornecidos, mantendo os valores existentes para os demais
    const status = updates.status || posicaoAtual.status;
    const quantidade = updates.quantidade !== undefined ? updates.quantidade : posicaoAtual.quantidade;
    const preco_entrada = updates.preco_entrada !== undefined ? updates.preco_entrada : posicaoAtual.preco_entrada;
    const preco_corrente = updates.preco_corrente !== undefined ? updates.preco_corrente : posicaoAtual.preco_corrente;
    const preco_medio = updates.preco_medio !== undefined ? updates.preco_medio : posicaoAtual.preco_medio;

    await db.query(
        `UPDATE posicoes SET 
       quantidade = ?, 
       preco_entrada = ?, 
       preco_corrente = ?,
       preco_medio = ?, 
       status = ?, 
       data_hora_ultima_atualizacao = ? 
       WHERE simbolo = ? AND status != "CLOSED"`,
        [quantidade, preco_entrada, preco_corrente, preco_medio, status, data_hora_ultima_atualizacao, symbol]
    );

    console.log(`Dados da posição atualizados para o símbolo: ${symbol}`);
    return true;
  } catch (error) {
    console.error(`Erro ao atualizar dados da posição: ${error.message}`);
    throw error;
  }
}

// Atualizar posição no banco de dados
async function updatePositionInDb(db, positionId, quantidade, preco_entrada, preco_corrente, leverage) {
  try {
    if (!positionId) {
      throw new Error('ID da posição é undefined');
    }

    const data_hora_ultima_atualizacao = new Date().toISOString();

    await db.query(
        `UPDATE posicoes 
       SET quantidade = ?, preco_entrada = ?, preco_corrente = ?, 
       leverage = ?, data_hora_ultima_atualizacao = ?
       WHERE id = ?`,
        [quantidade, preco_entrada, preco_corrente, leverage, data_hora_ultima_atualizacao, positionId]
    );
    console.log(`Posição com ID ${positionId} atualizada com sucesso.`);
  } catch (error) {
    console.error(`Erro ao atualizar posição no banco de dados: ${error.message}`);
    throw error;
  }
}

// Atualizar a função moveClosedPositionsAndOrders para usar formatDateForMySQL

async function moveClosedPositionsAndOrders(db, positionId) {
  let connection;
  try {
    // Usar formatDateForMySQL para formatar a data atual
    const nowFormatted = formatDateForMySQL(new Date());

    // Iniciar transação
    connection = await db.getConnection();
    await connection.beginTransaction();

    // 1. Verificar se a posição existe
    const [positionResult] = await connection.query("SELECT * FROM posicoes WHERE id = ?", [positionId]);
    if (positionResult.length === 0) {
      console.log(`Posição com ID ${positionId} não encontrada.`);
      await connection.commit();
      return;
    }

    // 2. Verificar todas as ordens que referenciam esta posição
    const [orderResult] = await connection.query("SELECT * FROM ordens WHERE id_posicao = ?", [positionId]);
    console.log(`Encontradas ${orderResult.length} ordens para posição ${positionId}.`);

    // 3. ✅ INSERIR ORDENS NO HISTÓRICO COM TODOS OS CAMPOS
    if (orderResult.length > 0) {
      for (const order of orderResult) {
        await connection.query(`
          INSERT INTO ordens_fechadas (
            id_original, id_original_ordens, tipo_ordem, preco, quantidade, id_posicao, status,
            data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot,
            target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco,
            orign_sig, dados_originais_ws, quantidade_executada, preco_executado, observacao,
            conta_id, commission, commission_asset, trade_id, client_order_id, time_in_force,
            stop_price, execution_type, last_filled_quantity, last_filled_price, order_trade_time,
            realized_profit, position_side
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          order.id, // id_original
          order.id, // id_original_ordens
          order.tipo_ordem,
          order.preco,
          order.quantidade,
          order.id_posicao,
          order.status,
          formatDateForMySQL(order.data_hora_criacao || new Date()),
          order.id_externo,
          order.side,
          order.simbolo,
          order.tipo_ordem_bot,
          order.target,
          order.reduce_only,
          order.close_position,
          formatDateForMySQL(order.last_update || new Date()),
          order.renew_sl_firs,
          order.renew_sl_seco,
          order.orign_sig,
          order.dados_originais_ws,
          order.quantidade_executada || 0,
          order.preco_executado,
          order.observacao || 'Movida automaticamente para histórico',
          order.conta_id,
          order.commission || 0,
          order.commission_asset,
          order.trade_id,
          order.client_order_id,
          order.time_in_force,
          order.stop_price,
          order.execution_type,
          order.last_filled_quantity,
          order.last_filled_price,
          order.order_trade_time,
          order.realized_profit,
          order.position_side
        ]);
      }
      console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);
    }

    // 4. IMPORTANTE: Excluir ordens ANTES de excluir a posição
    await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
    console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);

    // 5. Verificar se ainda existem ordens referenciando esta posição (garantia extra)
    const [remainingOrders] = await connection.query(
        "SELECT COUNT(*) AS count FROM ordens WHERE id_posicao = ?",
        [positionId]
    );

    if (remainingOrders[0].count > 0) {
      throw new Error(`Ainda existem ${remainingOrders[0].count} ordens vinculadas à posição ${positionId}.`);
    }

    // 6. ✅ INSERIR POSIÇÃO NO HISTÓRICO COM TODOS OS CAMPOS
    const position = positionResult[0];
    await connection.query(`
      INSERT INTO posicoes_fechadas (
        id_original, simbolo, quantidade, quantidade_aberta, preco_medio, status,
        data_hora_abertura, data_hora_fechamento, motivo_fechamento,
        side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente,
        orign_sig, conta_id, trailing_stop_level, pnl_corrente, observacoes,
        breakeven_price, accumulated_realized, unrealized_pnl, margin_type,
        isolated_wallet, position_side, event_reason, webhook_data_raw
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      position.id, // id_original
      position.simbolo,
      position.quantidade,
      position.quantidade_aberta,
      position.preco_medio,
      position.status,
      formatDateForMySQL(position.data_hora_abertura),
      nowFormatted, // data_hora_fechamento
      'Movida automaticamente para histórico',
      position.side,
      position.leverage,
      formatDateForMySQL(position.data_hora_ultima_atualizacao || new Date()),
      position.preco_entrada,
      position.preco_corrente,
      position.orign_sig,
      position.conta_id,
      position.trailing_stop_level,
      position.pnl_corrente,
      position.observacoes,
      position.breakeven_price,
      position.accumulated_realized,
      position.unrealized_pnl,
      position.margin_type,
      position.isolated_wallet,
      position.position_side,
      position.event_reason,
      position.webhook_data_raw
    ]);
    console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);

    // 7. Agora é seguro excluir a posição
    await connection.query("DELETE FROM posicoes WHERE id = ?", [positionId]);
    console.log(`Posição com id ${positionId} excluída de posicoes.`);

    await connection.commit();
    console.log(`Posição ${positionId} e suas ordens movidas para histórico com sucesso.`);

  } catch (error) {
    if (connection) {
      await connection.rollback();
      console.error('Transação revertida:', error.message);
    }
    console.error(`Erro ao mover posições fechadas: ${error.message}`);
    throw error;
  } finally {
    if (connection) {
      connection.release();
    }
  }
}

// Obter uma posição pelo ID
async function getPositionById(db, positionId) {
  try {
    const [rows] = await db.query("SELECT * FROM posicoes WHERE id = ?", [positionId]);
    return rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error(`Erro ao consultar posição por ID: ${error.message}`);
    throw error;
  }
}

// Gerar string de data e hora atual
function getCurrentDateTimeAsString() {
  const now = new Date();
  now.setUTCHours(now.getUTCHours() - 0);
  return now.toISOString().replace('T', ' ').substring(0, 19);
}

// Formatar data e hora
function getDataHoraFormatada() {
  const data = new Date();

  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const ano = data.getFullYear();

  const horas = String(data.getHours()).padStart(2, '0');
  const minutos = String(data.getMinutes()).padStart(2, '0');
  const segundos = String(data.getSeconds()).padStart(2, '0');

  return `${dia}-${mes}-${ano} | ${horas}:${minutos}:${segundos}`;
}

// Atualizar flag de renovação de ordem
async function updateOrderRenewFlag(db, orderId) {
  try {
    await db.query("UPDATE ordens SET renew_sl_firs = 'TRUE' WHERE id = ?", [orderId]);
    console.log(`Flag de renovação atualizado para ordem ${orderId}`);
  } catch (error) {
    console.error(`Erro ao atualizar flag de renovação para ordem ${orderId}: ${error.message}`);
    throw error;
  }
}

// Inserir novo sinal de webhook
async function insertWebhookSignal(db, signalData) {
  try {
    const { symbol, side, leverage, capital_pct, status, created_at, chat_id } = signalData;

    const [result] = await db.query(
        `INSERT INTO webhook_signals 
       (symbol, side, leverage, capital_pct, status, created_at, chat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [symbol, side, leverage, capital_pct, status, created_at, chat_id]
    );

    console.log(`Sinal de webhook inserido com sucesso: ${result.insertId}`);
    return result.insertId;
  } catch (error) {
    console.error(`Erro ao inserir webhook signal: ${error.message}`);
    throw error;
  }
}

// Nos webhooks (onde o erro continua)
async function insertWebhookSignalWithDetails(db, testSymbol, positionId, orderId, tpPrice, slPrice) {
  try {
    await db.query(`
      INSERT INTO webhook_signals 
      (symbol, side, leverage, capital_pct, status, created_at, position_id, entry_order_id, tp_price, sl_price) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [testSymbol, 'COMPRA', 100, 1, 'PROCESSED', formatDateForMySQL(new Date()), positionId, orderId, tpPrice, slPrice]);
    console.log('Webhook signal with details inserted successfully.');
  } catch (error) {
    console.error(`Erro ao inserir webhook signal com detalhes: ${error.message}`);
    throw error;
  }
}

// Função auxiliar para formatar a data para MySQL
/**
 * Formata uma data para o formato aceito pelo MySQL (YYYY-MM-DD HH:MM:SS)
 * Corrige também datas futuras (ano 2025) para o ano atual
 * @param {Date|string|null} date - Data a ser formatada
 * @returns {string|null} - Data formatada para MySQL ou null se a entrada for null/undefined
 */
function formatDateForMySQL(date) {
  if (!date) return null;

  const d = new Date(date);

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

  // Formatar para YYYY-MM-DD HH:MM:SS (formato aceito pelo MySQL)
  const year = dateObj.getFullYear();
  const month = String(dateObj.getMonth() + 1).padStart(2, '0');
  const day = String(dateObj.getDate()).padStart(2, '0');
  const hours = String(dateObj.getHours()).padStart(2, '0');
  const minutes = String(dateObj.getMinutes()).padStart(2, '0');
  const seconds = String(dateObj.getSeconds()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Atualiza o saldo_futuros da conta e possivelmente o saldo_base_calculo_futuros
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} saldo_futuros - Novo valor de saldo
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<Object>} - Objeto com os valores atualizados
 */
async function updateAccountBalance(db, saldo, accountId) {
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório: ${accountId} (tipo: ${typeof accountId})`);
  }

  try {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Buscar saldo_futuros atual e saldo_base_calculo_futuros para conta específica
      const [currentAccount] = await connection.query(
          'SELECT saldo_futuros, saldo_base_calculo_futuros FROM contas WHERE id = ?',
          [accountId]
      );

      if (currentAccount.length === 0) {
        throw new Error(`Conta com ID ${accountId} não encontrada`);
      }

      const currentSaldo = parseFloat(currentAccount[0].saldo_futuros || 0);
      const currentBaseCalculo = parseFloat(currentAccount[0].saldo_base_calculo_futuros || 0);
      
      // ✅ CORREÇÃO: Lógica correta do saldo_base_calculo_futuros
      // saldo_base_calculo_futuros SÓ AUMENTA se o novo saldo_futuros for maior
      let novoBaseCalculo = currentBaseCalculo;
      
      if (saldo_futuros > currentBaseCalculo) {
        novoBaseCalculo = saldo;
        console.log(`[DB] Atualizando saldo_base_calculo_futuros da conta ${accountId}: ${currentBaseCalculo.toFixed(2)} → ${novoBaseCalculo.toFixed(2)}`);
      } else {
        console.log(`[DB] Mantendo saldo_base_calculo_futuros da conta ${accountId}: ${currentBaseCalculo.toFixed(2)} (saldo_futuros atual: ${saldo.toFixed(2)})`);
      }

      // 3. Atualizar valores no banco
      await connection.query(
          'UPDATE contas SET saldo_futuros = ?, saldo_base_calculo_futuros = ?, ultima_atualizacao = NOW() WHERE id = ?',
          [saldo, novoBaseCalculo, accountId]
      );

      await connection.commit();

      return {
        accountId: accountId,
        saldo: saldo,
        saldo_base_calculo_futuros: novoBaseCalculo
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(`[DB] Erro ao atualizar saldo_futuros da conta ${accountId}: ${error.message}`);
    throw error;
  }
}

/**
 * Obtém o saldo_base_calculo_futuros do banco de dados
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} accountId - ID da conta (obrigatório)
 * @returns {Promise<number>} - Valor do saldo_base_calculo_futuros
 */
async function getBaseCalculoBalance(db, accountId) {
  // CORREÇÃO: Validar accountId obrigatório
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório: ${accountId} (tipo: ${typeof accountId})`);
  }

  try {
    // CORREÇÃO: Usar tabela 'contas' em vez de 'conta'
    const [rows] = await db.query(
      'SELECT saldo_base_calculo_futuros FROM contas WHERE id = ?', 
      [accountId]
    );
    
    if (rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada`);
    }
    
    return parseFloat(rows[0].saldo_base_calculo_futuros || 0);
  } catch (error) {
    console.error(`[DB] Erro ao obter saldo_base_calculo_futuros da conta ${accountId}:`, error.message);
    throw error;
  }
}

/**
 * Obtém as credenciais da API da Binance do banco de dados
 * @param {Object} options - Opções de consulta
 * @param {boolean} options.forceRefresh - Se true, força uma nova consulta ao banco de dados
 * @param {number} options.accountId - ID da conta a ser consultada (obrigatório)
 * @returns {Promise<Object>} - Objeto com as credenciais
 */
async function getApiCredentials(options = {}) {
  // CORREÇÃO: Tornar accountId obrigatório
  const { forceRefresh = false, accountId } = options;
  
  if (!accountId || typeof accountId !== 'number') {
    throw new Error(`AccountId é obrigatório: ${accountId} (tipo: ${typeof accountId})`);
  }

  const cacheKey = `credentials_${accountId}`;
  
  if (!forceRefresh && credentialsCache.has(cacheKey)) {
    const cached = credentialsCache.get(cacheKey);
    const now = Date.now();
    
    if (now - cached.timestamp < CACHE_DURATION) {
      console.log(`[DB] Usando credenciais em cache para conta ${accountId}`);
      return cached.data;
    }
  }

  try {
    const db = await getDatabaseInstance();
    
    if (!db) {
      throw new Error('Não foi possível obter conexão com o banco de dados');
    }

    console.log(`[DB] Carregando credenciais da conta ${accountId} do banco de dados...`);
    
    // CORREÇÃO: Query usando tabela 'contas'
    const [rows] = await db.query(`
      SELECT 
        c.id,
        c.nome,
        c.api_key, 
        c.api_secret,
        c.ws_api_key,
        c.ws_api_secret,
        c.private_key,
        c.api_url,
        c.ws_url,
        c.ws_api_url,
        c.ativa,
        c.id_corretora,
        cor.corretora,
        cor.ambiente,
        cor.futures_rest_api_url,
        cor.futures_ws_api_url,
        cor.futures_ws_market_url
      FROM contas c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id
      WHERE c.id = ? AND c.ativa = 1
    `, [accountId]);

    if (rows.length === 0) {
      throw new Error(`Conta ${accountId} não encontrada no banco de dados ou não está ativa`);
    }

    const account = rows[0];
    
    const credentials = {
      accountId: accountId,
      accountName: account.nome,
      apiKey: account.api_key,
      apiSecret: account.api_secret,
      wsApiKey: account.ws_api_key,
      wsApiSecret: account.ws_api_secret,
      privateKey: account.private_key,
      apiUrl: account.api_url || account.futures_rest_api_url || 'https://fapi.binance.com/fapi',
      wsUrl: account.ws_url || account.futures_ws_market_url || 'wss://fstream.binance.com/ws',
      wsApiUrl: account.ws_api_url || account.futures_ws_api_url || 'wss://ws-fapi.binance.com/ws-fapi/v1',
      corretora: account.corretora || 'binance',
      ambiente: account.ambiente || 'prd'
    };

    console.log(`[DB] ✅ Credenciais carregadas para conta ${accountId} (${account.nome})`);
    
    return credentials;

  } catch (error) {
    console.error(`[DB] Erro ao carregar credenciais da conta ${accountId}:`, error.message);
    throw error;
  }
}

// Limpar cache de credenciais (útil para testes ou quando a conta é atualizada)
function clearCredentialsCache() {
  cachedCredentials = null;
  lastCacheTime = 0;
}

/**
 * Obtém as URLs da corretora do banco de dados
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} corretoraId - ID da corretora (padrão: 1 para Binance)
 * @returns {Promise<Object>} - Objeto com as URLs da corretora
 */
async function getCorretoraPorId(db, corretoraId = 1) {
  try {
    const [rows] = await db.query(
      `SELECT id, corretora, ambiente, spot_rest_api_url, futures_rest_api_url, 
              futures_ws_market_url, futures_ws_api_url, ativa
       FROM corretoras 
       WHERE id = ? AND ativa = 1`,
      [corretoraId]
    );

    if (rows.length === 0) {
      throw new Error(`Corretora com ID ${corretoraId} não encontrada ou não está ativa`);
    }

    return rows[0];
  } catch (error) {
    console.error(`[DB] Erro ao obter informações da corretora ID ${corretoraId}:`, error.message);
    throw error;
  }
}

// Exportar as funções
module.exports = {
  initPool,
  getDatabaseInstance,
  initializeDatabase,
  closePool,
  checkOrderExists,
  getOpenOrdersFromDb,
  getAllOrdersBySymbol,
  getPositionIdBySymbol,
  disconnectDatabase,
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
  formatDateForMySQL,
  updateAccountBalance,
  getBaseCalculoBalance,
  getCorretoraPorId
};


