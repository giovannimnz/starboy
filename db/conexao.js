const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs').promises;

// Pool de conexões MySQL
let dbPool = null;

// Inicializar a pool de conexões MySQL
async function initPool() {
  if (!dbPool) {
    dbPool = await mysql.createPool({
      host: process.env.DB_HOST,
      port: process.env.DB_PORT,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0
    });
    console.log(`Conexão com banco de dados MySQL estabelecida em: ${process.env.DB_HOST}:${process.env.DB_PORT}`);
  }
  return dbPool;
}

// Função para obter conexão com o banco de dados
async function getDatabaseInstance() {
  try {
    return await initPool();
  } catch (err) {
    console.error(`Erro ao conectar ao banco de dados MySQL:`, err.message);
    return null;
  }
}

// Função para inicializar as tabelas do banco de dados
async function initializeDatabase() {
  console.log('Inicializando banco de dados MySQL com tabelas...');
  
  try {
    const db = await getDatabaseInstance();
    
    // As tabelas já foram criadas pelo script createDb.js
    // Vamos apenas verificar se as colunas adicionais estão presentes em ordens
    
    await checkAndAddColumns();
    
    console.log('Inicialização do banco de dados concluída!');
  } catch (error) {
    console.error('Erro ao inicializar banco de dados:', error);
  }
}

// Verificar e adicionar colunas faltantes
async function checkAndAddColumns() {
  try {
    const db = await getDatabaseInstance();
    
    // Verificar se coluna 'renew_sl_firs' existe na tabela 'ordens'
    let [columns] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ordens' AND COLUMN_NAME = 'renew_sl_firs'`, 
      [process.env.DB_NAME]);
    
    if (columns.length === 0) {
      console.log("Coluna renew_sl_firs não encontrada na tabela ordens. Adicionando...");
      await db.query("ALTER TABLE ordens ADD COLUMN renew_sl_firs VARCHAR(20)");
      console.log("Coluna renew_sl_firs adicionada à tabela ordens com sucesso.");
    }
    
    // Verificar se coluna 'renew_sl_seco' existe
    [columns] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ordens' AND COLUMN_NAME = 'renew_sl_seco'`, 
      [process.env.DB_NAME]);
    
    if (columns.length === 0) {
      console.log("Coluna renew_sl_seco não encontrada na tabela ordens. Adicionando...");
      await db.query("ALTER TABLE ordens ADD COLUMN renew_sl_seco VARCHAR(20)");
      console.log("Coluna renew_sl_seco adicionada à tabela ordens com sucesso.");
    }
    
    // Verificar se coluna 'orign_sig' existe
    [columns] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ordens' AND COLUMN_NAME = 'orign_sig'`, 
      [process.env.DB_NAME]);
    
    if (columns.length === 0) {
      console.log("Coluna orign_sig não encontrada na tabela ordens. Adicionando...");
      await db.query("ALTER TABLE ordens ADD COLUMN orign_sig VARCHAR(100)");
      console.log("Coluna orign_sig adicionada à tabela ordens com sucesso.");
    }
    
    // Verificar se coluna 'orign_sig' existe em posicoes
    [columns] = await db.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'posicoes' AND COLUMN_NAME = 'orign_sig'`, 
      [process.env.DB_NAME]);
    
    if (columns.length === 0) {
      console.log("Coluna orign_sig não encontrada na tabela posicoes. Adicionando...");
      await db.query("ALTER TABLE posicoes ADD COLUMN orign_sig VARCHAR(100)");
      console.log("Coluna orign_sig adicionada à tabela posicoes com sucesso.");
    }
    
  } catch (error) {
    console.error("Erro ao verificar e adicionar colunas:", error);
    throw error;
  }
}

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

// Verificar se existe uma posição aberta para um símbolo
async function checkPositionExists(db, symbol) {
  try {
    const [rows] = await db.query(
      "SELECT id FROM posicoes WHERE simbolo = ? AND data_hora_fechamento IS NULL", 
      [symbol]
    );
    return rows.length > 0;
  } catch (error) {
    console.error(`Erro ao verificar existência de posição: ${error.message}`);
    throw error;
  }
}

// Atualizar função insertPosition para usar formatDateForMySQL

async function insertPosition(db, position) {
  try {
    const exists = await checkPositionExists(db, position.simbolo);
    if (exists) {
      console.log(`Posição já existe para o símbolo: ${position.simbolo}`);
      return null;
    } else {
      // Verificar se a coluna orign_sig existe na tabela
      const [columns] = await db.query(
        `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS 
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'posicoes' AND COLUMN_NAME = 'orign_sig'`, 
        [process.env.DB_NAME]
      );
      
      const hasOrignSigColumn = columns.length > 0;
      
      // Formatar datas
      const formattedOpenTime = formatDateForMySQL(position.data_hora_abertura);
      const formattedUpdateTime = formatDateForMySQL(position.data_hora_ultima_atualizacao);
      
      let query, params;
      
      if (hasOrignSigColumn) {
        // Se a coluna existir, incluí-la na consulta
        query = `INSERT INTO posicoes (
          simbolo, quantidade, preco_medio, status, data_hora_abertura, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        params = [
          position.simbolo,
          position.quantidade,
          position.preco_medio,
          'OPEN', // O status é sempre OPEN para posições novas
          formattedOpenTime,
          position.side,
          position.leverage,
          formattedUpdateTime,
          position.preco_entrada,
          position.preco_corrente,
          position.orign_sig || null
        ];
      } else {
        // Se a coluna não existir, omití-la da consulta
        query = `INSERT INTO posicoes (
          simbolo, quantidade, preco_medio, status, data_hora_abertura, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        
        params = [
          position.simbolo,
          position.quantidade,
          position.preco_medio,
          'OPEN', // O status é sempre OPEN para posições novas
          formattedOpenTime,
          position.side,
          position.leverage,
          formattedUpdateTime,
          position.preco_entrada,
          position.preco_corrente
        ];
      }
      
      const [result] = await db.query(query, params);
      
      console.log(`Posição inserida com sucesso com ID: ${result.insertId}`);
      return result.insertId;
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

async function insertNewOrder(db, orderDetails) {
  try {
    const { tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update, orign_sig } = orderDetails;
    
    const reduceOnlyValue = reduce_only ? 1 : 0; // MySQL usa 1/0 para boolean
    const closePositionValue = close_position ? 1 : 0;
    
    // Formatar datas antes da inserção
    const formattedCreationTime = formatDateForMySQL(data_hora_criacao);
    const formattedUpdateTime = formatDateForMySQL(last_update);
    
    const [result] = await db.query(
      `INSERT INTO ordens (
        tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
        id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update, orign_sig
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tipo_ordem, preco, quantidade, id_posicao, status, formattedCreationTime,
        id_externo, side, simbolo, tipo_ordem_bot, target, reduceOnlyValue, closePositionValue, formattedUpdateTime, orign_sig
      ]
    );
    
    if (tipo_ordem_bot === "REDUCAO PARCIAL" && target) {
      console.log(`Ordem de ${tipo_ordem_bot} ${target} inserida com sucesso: ${result.insertId}`);
    } else {
      console.log(`Ordem de ${tipo_ordem_bot} inserida com sucesso: ${result.insertId}`);
    }
    
    return result.insertId;
  } catch (error) {
    console.error(`Erro ao inserir ordem: ${error.message}`);
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
    
    // Verificar se a coluna orign_sig existe na tabela posicoes
    const [columns] = await connection.query(`SHOW COLUMNS FROM posicoes LIKE 'orign_sig'`);
    const hasOrignSig = columns.length > 0;
    
    // Copiar posição para tabela histórica com consulta dinâmica
    if (hasOrignSig) {
      // Se a coluna existir, incluir na consulta
      await connection.query(
        `INSERT INTO posicoes_fechadas 
         (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig)
         SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
         FROM posicoes WHERE id = ?`,
        [nowFormatted, positionId] // Usar a data formatada aqui
      );
    } else {
      // Se a coluna não existir, omitir da consulta
      await connection.query(
        `INSERT INTO posicoes_fechadas 
         (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente)
         SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?, 
          side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente
         FROM posicoes WHERE id = ?`,
        [nowFormatted, positionId] // Usar a data formatada aqui
      );
    }
    
    console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);
    
    // Resto da função permanece igual...
    
    // Fazer o mesmo para a tabela de ordens
    const [orderColumns] = await connection.query(`SHOW COLUMNS FROM ordens LIKE 'orign_sig'`);
    const hasOrderOrignSig = orderColumns.length > 0;
    
    // Copiar ordens para tabela histórica
    if (hasOrderOrignSig) {
      await connection.query(
        `INSERT INTO ordens_fechadas 
         (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
          last_update, renew_sl_firs, renew_sl_seco, orign_sig)
         SELECT tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
          last_update, renew_sl_firs, renew_sl_seco, orign_sig
         FROM ordens WHERE id_posicao = ?`,
        [positionId]
      );
    } else {
      await connection.query(
        `INSERT INTO ordens_fechadas 
         (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
          last_update, renew_sl_firs, renew_sl_seco)
         SELECT tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, 
          id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, 
          last_update, renew_sl_firs, renew_sl_seco
         FROM ordens WHERE id_posicao = ?`,
        [positionId]
      );
    }
    
    console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);
    
    // Excluir posição original
    await connection.query("DELETE FROM posicoes WHERE id = ?", [positionId]);
    console.log(`Posição com id ${positionId} excluída de posicoes.`);
    
    // Excluir ordens originais
    await connection.query("DELETE FROM ordens WHERE id_posicao = ?", [positionId]);
    console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);
    
    // Commit da transação
    await connection.commit();
    console.log(`Posição e ordens associadas com id_posicao ${positionId} movidas e excluídas com sucesso.`);
    
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
  
  // Corrigir ano se estiver no futuro (provavelmente um bug)
  const currentYear = new Date().getFullYear();
  if (dateObj.getFullYear() > currentYear) {
    dateObj.setFullYear(currentYear);
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

// Exportar as funções
module.exports = {
  getDatabaseInstance,
  checkOrderExists,
  getOpenOrdersFromDb,
  getAllOrdersBySymbol,
  getPositionIdBySymbol,
  disconnectDatabase,
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
  initializeDatabase,
  updateOrderRenewFlag,
  insertWebhookSignal,
  insertWebhookSignalWithDetails,
  formatDateForMySQL  // Adicione esta linha
};