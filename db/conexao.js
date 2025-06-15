const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs').promises;
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Pool de conexões MySQL global
let pool = null;

// Configuração do banco de dados
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'starboy',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  acquireTimeout: 60000,
  timeout: 60000,
  reconnect: true,
  charset: 'utf8mb4'
};

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
    
    // Criar pool de conexões
    pool = mysql.createPool(dbConfig);
    
    // Testar conexão
    const connection = await pool.getConnection();
    console.log('[DB] ✅ Pool de conexões MySQL inicializado com sucesso');
    connection.release();
    
    return pool;
  } catch (error) {
    console.error('[DB] ❌ Erro ao inicializar pool de conexões:', error.message);
    
    // Tentar criar database se não existir
    if (error.code === 'ER_BAD_DB_ERROR') {
      console.log('[DB] Database não existe, tentando criar...');
      await createDatabaseIfNotExists();
      return await initPool(); // Tentar novamente
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
    // Se accountId for fornecido, apenas loggar para debug
    if (accountId && accountId !== 1) {
      console.log(`[DB] Solicitação de conexão para conta ${accountId}`);
    }
    
    // Garantir que o pool está inicializado
    if (!pool) {
      console.log('[DB] Pool não inicializado, inicializando agora...');
      await initPool();
    }
    
    // Testar se o pool ainda está ativo
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
          saldo DECIMAL(15,8) DEFAULT 0,
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
    await pool.end();
    pool = null;
    console.log('[DB] Pool de conexões fechado');
  }
}

// Fechar pool graciosamente ao encerrar aplicação
process.on('SIGINT', closePool);
process.on('SIGTERM', closePool);
process.on('exit', closePool);

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
async function checkPositionExists(db, symbol, accountId = 1) {
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

    // 3. Construir esquemas dinâmicos para mover ordens
    const [renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_firs'`);
    const [renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'renew_sl_seco'`);
    const [orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);

    const [dest_renew_sl_firs] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_firs'`);
    const [dest_renew_sl_seco] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'renew_sl_seco'`);
    const [dest_orign_sig] = await connection.query(`SHOW COLUMNS FROM ordens_fechadas LIKE 'orign_sig'`);

    let sourceCols = "tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, " +
        "id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, " +
        "last_update";

    let destCols = sourceCols;

    if (renew_sl_firs.length > 0 && dest_renew_sl_firs.length > 0) {
      sourceCols += ", renew_sl_firs";
      destCols += ", renew_sl_firs";
    }

    if (renew_sl_seco.length > 0 && dest_renew_sl_seco.length > 0) {
      sourceCols += ", renew_sl_seco";
      destCols += ", renew_sl_seco";
    }

    if (orign_sig.length > 0 && dest_orign_sig.length > 0) {
      sourceCols += ", orign_sig";
      destCols += ", orign_sig";
    }

    // 4. Inserir ordens na tabela de histórico
    if (orderResult.length > 0) {
      await connection.query(
          `INSERT INTO ordens_fechadas (${destCols})
         SELECT ${sourceCols} FROM ordens WHERE id_posicao = ?`,
          [positionId]
      );
      console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);
    }

    // 5. IMPORTANTE: Excluir ordens ANTES de excluir a posição
    await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
    console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);

    // 6. Verificar se ainda existem ordens referenciando esta posição (garantia extra)
    const [remainingOrders] = await connection.query(
        "SELECT COUNT(*) AS count FROM ordens WHERE id_posicao = ?",
        [positionId]
    );

    if (remainingOrders[0].count > 0) {
      throw new Error(`Ainda existem ${remainingOrders[0].count} ordens vinculadas à posição ${positionId}.`);
    }

    // 7. Verificar se posição tem coluna orign_sig
    const [posColumns] = await connection.query(`SHOW COLUMNS FROM posicoes LIKE 'orign_sig'`);
    const hasOrignSig = posColumns.length > 0;

    // 8. Copiar posição para tabela histórica com consulta dinâmica
    if (hasOrignSig) {
      await connection.query(
          `INSERT INTO posicoes_fechadas 
         (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig)
         SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
         FROM posicoes WHERE id = ?`,
          [nowFormatted, positionId]
      );
    } else {
      await connection.query(
          `INSERT INTO posicoes_fechadas 
         (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente)
         SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente
         FROM posicoes WHERE id = ?`,
          [nowFormatted, positionId]
      );
    }
    console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);

    // 9. Agora é seguro excluir a posição
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
 * Atualiza o saldo da conta e possivelmente o saldo_base_calculo
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} saldo - Novo valor de saldo
 * @param {number} accountId - ID da conta (padrão: 1)
 * @returns {Promise<Object>} - Objeto com os valores atualizados
 */
async function updateAccountBalance(db, saldo, accountId = 1) {
  try {
    const connection = await db.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Buscar saldo atual e saldo_base_calculo
      const [currentAccount] = await connection.query(
          'SELECT saldo, saldo_base_calculo FROM conta WHERE id = ?',
          [accountId]
      );

      if (currentAccount.length === 0) {
        throw new Error(`Conta com ID ${accountId} não encontrada`);
      }

      const currentSaldo = parseFloat(currentAccount[0].saldo || 0);
      let baseCalculo = parseFloat(currentAccount[0].saldo_base_calculo || 0);

      // 2. Se o saldo_base_calculo ainda não existe ou é zero, inicializar com o saldo atual
      if (baseCalculo === 0) {
        baseCalculo = saldo;
      }
      // 3. Se o novo saldo for maior que o saldo_base_calculo atual, atualizar o saldo_base_calculo
      else if (saldo > baseCalculo) {
        baseCalculo = saldo;
        //console.log(`[DB] Saldo base de cálculo atualizado para: ${baseCalculo.toFixed(2)} USDT`);
      } else {
        //console.log(`[DB] Saldo diminuiu de ${currentSaldo.toFixed(2)} para ${saldo.toFixed(2)}, mantendo saldo base: ${baseCalculo.toFixed(2)} USDT`);
      }

      // 4. Atualizar o saldo e possivelmente o saldo_base_calculo
      await connection.query(
          'UPDATE conta SET saldo = ?, saldo_base_calculo = ? WHERE id = ?',
          [saldo, baseCalculo, accountId]
      );

      await connection.commit();

      return {
        saldo: saldo,
        saldo_base_calculo: baseCalculo
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error(`[DB] Erro ao atualizar saldo da conta: ${error.message}`);
    throw error;
  }
}

/**
 * Obtém o saldo_base_calculo do banco de dados
 * @param {Object} db - Conexão com o banco de dados
 * @param {number} accountId - ID da conta (padrão: 1)
 * @returns {Promise<number>} - Valor do saldo_base_calculo
 */
async function getBaseCalculoBalance(db, accountId = 1) {
  try {
    const [rows] = await db.query(
        'SELECT saldo_base_calculo FROM conta WHERE id = ?',
        [accountId]
    );

    if (rows.length === 0) {
      throw new Error(`Conta com ID ${accountId} não encontrada`);
    }

    const baseCalculo = parseFloat(rows[0].saldo_base_calculo || 0);
    return baseCalculo;
  } catch (error) {
    console.error(`[DB] Erro ao obter saldo base de cálculo: ${error.message}`);
    throw error;
  }
}

/**
 * Obtém as credenciais da API da Binance do banco de dados
 * @param {Object} options - Opções de consulta (opcional)
 * @param {boolean} options.forceRefresh - Se true, força uma nova consulta ao banco de dados
 * @param {number} options.accountId - ID da conta a ser consultada (padrão: 1)
 * @returns {Promise<Object>} - Objeto com as credenciais
 */
async function getApiCredentials(options = {}) {
  const { forceRefresh = false, accountId = 1 } = options;
  const currentTime = Date.now();
  
  // Usar cache se disponível e não expirado, a menos que forceRefresh seja true
  if (cachedCredentials && !forceRefresh && (currentTime - lastCacheTime < CACHE_TTL)) {
    return cachedCredentials;
  }
  
  try {
    const db = await getDatabaseInstance();
    
    if (!db) {
      throw new Error('Não foi possível obter conexão com o banco de dados');
    }
    
    // Consulta modificada para fazer um JOIN com a tabela de corretoras
    const [rows] = await db.query(`
      SELECT 
        c.rest_apikey,
        c.rest_secretkey,
        c.ws_apikey,
        c.ws_secretkey,
        c.ambiente,
        c.corretora,
        cor.id as corretora_id,
        cor.spot_rest_api_url,
        cor.futures_rest_api_url,
        cor.futures_ws_market_url,
        cor.futures_ws_api_url
      FROM conta c
      LEFT JOIN corretoras cor ON c.id_corretora = cor.id AND cor.ativa = 1 AND cor.corretora = c.corretora AND cor.ambiente = c.ambiente  
      WHERE c.id = ? AND c.ativa = 1
    `, [accountId]);
    
    if (rows.length === 0) {
      throw new Error(`Conta com ID ${accountId} não encontrada ou não está ativa`);
    }

    // Se não encontrou uma corretora vinculada, tentar encontrar por nome e ambiente
    if (!rows[0].corretora_id) {
      const [corretoras] = await db.query(`
        SELECT *
        FROM corretoras 
        WHERE corretora = ? AND ambiente = ? AND ativa = 1
        LIMIT 1
      `, [rows[0].corretora, rows[0].ambiente]);

      if (corretoras.length > 0) {
        // Vincular a conta à corretora encontrada
        await db.query(
          'UPDATE conta SET id_corretora = ? WHERE id = ?',
          [corretoras[0].id, accountId]
        );
        
        // Adicionar URLs ao resultado
        rows[0].corretora_id = corretoras[0].id;
        rows[0].spot_rest_api_url = corretoras[0].spot_rest_api_url;
        rows[0].futures_rest_api_url = corretoras[0].futures_rest_api_url;
        rows[0].futures_ws_market_url = corretoras[0].futures_ws_market_url;
        rows[0].futures_ws_api_url = corretoras[0].futures_ws_api_url;
        
        console.log(`[DB] Conta ID ${accountId} vinculada automaticamente à corretora ID ${corretoras[0].id}`);
      }
    }
    
    // Construir o objeto de credenciais
    const credentials = {
      restApiKey: rows[0].rest_apikey,
      restSecretKey: rows[0].rest_secretkey,
      wsApiKey: rows[0].ws_apikey,
      wsSecretKey: rows[0].ws_secretkey,
      ambiente: rows[0].ambiente,
      corretora: rows[0].corretora,
      isProd: rows[0].ambiente === 'prd',
      
      // Adicionar URLs da corretora
      urls: {
        spotRestApiUrl: rows[0].spot_rest_api_url,
        futuresRestApiUrl: rows[0].futures_rest_api_url,
        futuresWsMarketUrl: rows[0].futures_ws_market_url,
        futuresWsApiUrl: rows[0].futures_ws_api_url
      },
      
      // ID da corretora vinculada
      corretoraId: rows[0].corretora_id
    };
    
    // Atualizar cache
    cachedCredentials = credentials;
    lastCacheTime = currentTime;
    
    console.log(`[DB] Credenciais da API carregadas do banco de dados (ambiente: ${credentials.ambiente}, corretora: ${credentials.corretora})`);
    return credentials;
  } catch (error) {
    console.error(`[DB] Erro ao obter credenciais da API: ${error.message}`);
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
  // ...outras funções existentes...
};