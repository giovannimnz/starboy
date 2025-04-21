const sqlite3 = require('sqlite3').verbose();
let dbInstance = null;

function getDatabaseInstance() {
    if (!dbInstance) {
        dbInstance = new sqlite3.Database('./starboy1.db', sqlite3.OPEN_READWRITE, (err) => {
            if (err) {
                console.error('Erro ao conectar ao banco de dados:', err.message);
                dbInstance = null;
            } else {
            }
        });
    }
    return dbInstance;
}

function getAllOrdersBySymbol(db, symbol) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT id_externo, simbolo FROM ordens WHERE simbolo = ?";
        db.all(sql, [symbol], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}


function disconnectDatabase() {
    if (dbInstance) {
        dbInstance.close((err) => {
            if (err) {
                console.error('Erro ao fechar a conexão com o banco de dados:', err.message);
            } else {
                console.log('Conexão com o banco de dados encerrada.');
                dbInstance = null;
            }
        });
    }
}

function getAllPositionsFromDb(db) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM posicoes WHERE status = 'OPEN'";
        db.all(sql, [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

// Função para obter o último ID de posição aberta para um determinado símbolo
function getPositionIdBySymbol(db, symbol) {
    return new Promise((resolve, reject) => {
        // Busca o ID da última posição aberta para o símbolo fornecido
        db.get("SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' ORDER BY data_hora_abertura DESC LIMIT 1", [symbol], (err, row) => {
            if (err) {
                console.error('Erro ao buscar ID de posição:', err.message);
                reject(err);
            } else if (row) {
                resolve(row.id);
            } else {
                resolve(null);  // Retorna null se não houver posições abertas correspondentes
            }
        });
    });
}

// Função para verificar se existe uma posição aberta para um determinado símbolo
function checkPositionExists(db, symbol) {
    return new Promise((resolve, reject) => {
        db.get("SELECT id FROM posicoes WHERE simbolo = ? AND data_hora_fechamento IS NULL", [symbol], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row ? true : false);
            }
        });
    });
}

// Função para inserir uma nova posição no banco de dados e retornar o ID da posição inserida
function insertPosition(db, position) {
    return new Promise(async (resolve, reject) => {
        try {
            const exists = await checkPositionExists(db, position.simbolo);
            if (exists) {
                console.log(`Posição já existe para o símbolo: ${position.simbolo}`);
                resolve(null);  // Nada é inserido, retorna null para indicar que a posição já existe
            } else {
                const sql = `
                    INSERT INTO posicoes (
                        simbolo,
                        quantidade,
                        preco_medio,
                        status,
                        data_hora_abertura,
                        side,
                        leverage,
                        data_hora_ultima_atualizacao,
                        preco_entrada,
                        preco_corrente
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
                `;

                const params = [
                    position.simbolo,
                    position.quantidade,
                    position.preco_medio, // Assume-se igual a preco_entrada para simplificação, ajuste conforme necessário
                    'OPEN', // O status é sempre OPEN para posições novas ou não fechadas
                    position.data_hora_abertura,
                    position.side,
                    position.leverage,
                    position.data_hora_ultima_atualizacao,
                    position.preco_entrada,
                    position.preco_corrente
                ];

                db.run(sql, params, function(err) {
                    if (err) {
                        console.error('Erro ao inserir posição:', err.message);
                        reject(err);
                    } else {
                        console.log(`Posição inserida com sucesso com ID: ${this.lastID}`);
                        resolve(this.lastID);
                    }
                });
            }
        } catch (error) {
            reject(error);
        }
    });
}

// Função para verificar se uma ordem com um determinado id_externo já existe
function checkOrderExists(db, id_externo) {
    return new Promise((resolve, reject) => {
        db.get("SELECT 1 FROM ordens WHERE id_externo = ?", [id_externo], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row ? true : false);
            }
        });
    });
}

async function insertNewOrder(db, orderDetails) {
    const { tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update } = orderDetails;
    const sql = `INSERT INTO ordens (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    try {
        const result = await new Promise((resolve, reject) => {
            // Convertendo reduce_only para 't' ou 'f'
            const reduceOnlyValue = reduce_only ? 't' : 'f';
            const closePositionValue = close_position ? 't' : 'f'; // Adicionando conversão para close_position
            db.run(sql, [tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduceOnlyValue, closePositionValue, last_update], function(err) {
                if (err) {
                    reject(err);
                } else {
                    if (tipo_ordem_bot === "REDUCAO PARCIAL" && target) {
                        console.log(`Ordem de ${tipo_ordem_bot} ${target} inserida com sucesso: ${this.lastID}`);
                    } else {
                        console.log(`Ordem de ${tipo_ordem_bot} inserida com sucesso: ${this.lastID}`);
                    }
                    resolve(this.lastID);
                }
            });
        });
        return result;
    } catch (error) {
        console.error(`Erro ao inserir ordem: ${error.message}`);
        throw error;
    }
}

// Função para inserir uma nova ordem no banco de dados ao sincronizar com o banco de dados
function insertOrder(db, tipo_ordem, preco, quantidade, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log("Simbolo enviado para getPositionIdBySymbol:", simbolo);
            const id_posicao = await getPositionIdBySymbol(db, simbolo);
            if (!id_posicao) {
                console.log(`Nenhuma posição aberta encontrada para o símbolo: ${simbolo}`);
                resolve(null);
                return;
            }

            const exists = await checkOrderExists(db, id_externo);
            if (exists) {
                console.log(`Ordem já existe para o ID externo: ${id_externo}`);
                resolve(null);  // Nada é inserido, retorna null para indicar que a ordem já existe
            } else {
                db.run(
                    `INSERT INTO ordens (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update],
                    function (err) {
                        if (err) {
                            console.error('Erro ao inserir ordem:', err.message);
                            reject(err);
                        } else {
                            console.log(`Nova ordem inserida com ID ${this.lastID}.`);
                            resolve(this.lastID);
                        }
                    }
                );
            }
        } catch (error) {
            console.error('Erro durante a inserção da ordem:', error);
            reject(error);
        }
    });
}

function getOpenOrdersFromDb(db) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT id_externo, simbolo FROM ordens WHERE status = 'OPEN'";
        db.all(sql, [], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}


function getOrdersFromDb(db, params) {
    return new Promise((resolve, reject) => {
        if (!db || typeof db.all !== 'function') {
            return reject(new Error('Invalid database connection'));
        }

        let sql = "SELECT id_externo, simbolo, tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, side, tipo_ordem_bot, target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco, orign_sig FROM ordens";
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
        if (params.renew_sl_firs !== undefined) {
            conditions.push("renew_sl_firs IS ?");
            sqlValues.push(params.renew_sl_firs);
        }

        if (conditions.length > 0) {
            sql += " WHERE " + conditions.join(" AND ");
        }

        db.all(sql, sqlValues, (err, rows) => {
            if (err) {
                console.error("Error running SQL: " + sql);
                console.error(err);
                reject(err);
            } else if (rows.length === 0) {
                console.log("Nenhuma ordem encontrada para os critérios fornecidos.");
                resolve([]);
            } else {
                resolve(rows);
            }
        });
    });
}


function getPositionsFromDb(db, status) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM posicoes WHERE status = ?`;
        db.all(sql, [status], (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

function updateOrderStatus(db, orderId, newStatus) {
    return new Promise((resolve, reject) => {
        const sql = "UPDATE ordens SET status = ? WHERE id = ?";
        db.run(sql, [newStatus, orderId], function(err) {
            if (err) {
                console.error(`Erro ao atualizar status da ordem ${orderId}: ${err.message}`);
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// Função para atualizar o status de uma posição
function updatePositionStatus(db, symbol, data) {
    const { quantidade, preco_entrada, preco_corrente, leverage } = data;
    const data_hora_ultima_atualizacao = getCurrentDateTimeAsString(); // Adicionando a data e hora atualizada

    const sql = `UPDATE posicoes SET 
                 quantidade = ?, 
                 preco_entrada = ?, 
                 preco_corrente = ?,
                 leverage = ?,
                 data_hora_ultima_atualizacao = ?
                 WHERE simbolo = ?`;

    db.run(sql, [quantidade, preco_entrada, preco_corrente, leverage, data_hora_ultima_atualizacao, symbol], function(err) {
        if (err) {
            console.error('Erro ao atualizar dados da posição:', err.message);
            return;
        }
        console.log(`Dados da posição atualizados para o símbolo: ${symbol}`);
    });
}

function updatePositionInDb(db, positionId, quantidade, preco_entrada, preco_corrente, leverage) {
    return new Promise((resolve, reject) => {
        if (!positionId) {
            console.error('ID da posição é undefined. Não foi possível atualizar a posição.');
            return reject(new Error('ID da posição é undefined'));
        }
        const sql = `
            UPDATE posicoes 
            SET quantidade = ?, preco_entrada = ?, preco_corrente = ?, leverage = ?, data_hora_ultima_atualizacao = ?
            WHERE id = ?
        `;
        const data_hora_ultima_atualizacao = new Date().toISOString();
        db.run(sql, [quantidade, preco_entrada, preco_corrente, leverage, data_hora_ultima_atualizacao, positionId], function(err) {
            if (err) {
                console.error('Erro ao atualizar posição no banco de dados:', err.message);
                reject(err);
            } else {
                console.log(`Posição com ID ${positionId} atualizada com sucesso.`);
                resolve();
            }
        });
    });
}

async function moveClosedPositionsAndOrders(db, positionId) {
    const now = new Date().toISOString();

    let transactionActive = false;

    try {
        // Iniciar a transação somente se não houver uma transação ativa
        await new Promise((resolve, reject) => {
            db.run("BEGIN TRANSACTION", function(err) {
                if (err) {
                    if (err.message.includes("cannot start a transaction within a transaction")) {
                        console.log('Transação já iniciada. Continuando...');
                        resolve();
                    } else {
                        console.error('Erro ao iniciar a transação:', err.message);
                        reject(err);
                    }
                } else {
                    transactionActive = true;
                    resolve();
                }
            });
        });

        const positionQuery = `
            INSERT INTO posicoes_fechadas 
            (simbolo, quantidade, preco_medio, status, data_hora_abertura, data_hora_fechamento, side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig)
            SELECT simbolo, quantidade, preco_medio, status, data_hora_abertura, ?, side, leverage, data_hora_ultima_atualizacao, preco_entrada, preco_corrente, orign_sig
            FROM posicoes WHERE id = ?`;

        await new Promise((resolve, reject) => {
            db.run(positionQuery, [now, positionId], function(err) {
                if (err) {
                    console.error('Erro ao mover posição fechada:', err.message);
                    reject(err);
                } else {
                    console.log(`Posição com id ${positionId} movida para posicoes_fechadas.`);
                    resolve();
                }
            });
        });

        const ordersQuery = `
            INSERT INTO ordens_fechadas 
            (tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco, orign_sig)
            SELECT tipo_ordem, preco, quantidade, id_posicao, status, data_hora_criacao, id_externo, side, simbolo, tipo_ordem_bot, target, reduce_only, close_position, last_update, renew_sl_firs, renew_sl_seco, orign_sig 
            FROM ordens WHERE id_posicao = ?`;

        await new Promise((resolve, reject) => {
            db.run(ordersQuery, [positionId], function(err) {
                if (err) {
                    console.error('Erro ao mover ordens fechadas:', err.message);
                    reject(err);
                } else {
                    console.log(`Ordens com id_posicao ${positionId} movidas para ordens_fechadas.`);
                    resolve();
                }
            });
        });

        const deletePositionQuery = "DELETE FROM posicoes WHERE id = ?";
        await new Promise((resolve, reject) => {
            db.run(deletePositionQuery, [positionId], function(err) {
                if (err) {
                    console.error('Erro ao excluir posição fechada:', err.message);
                    reject(err);
                } else {
                    console.log(`Posição com id ${positionId} excluída de posicoes.`);
                    resolve();
                }
            });
        });

        const deleteOrdersQuery = "DELETE FROM ordens WHERE id_posicao = ?";
        await new Promise((resolve, reject) => {
            db.run(deleteOrdersQuery, [positionId], function(err) {
                if (err) {
                    console.error('Erro ao excluir ordens fechadas:', err.message);
                    reject(err);
                } else {
                    console.log(`Ordens com id_posicao ${positionId} excluídas de ordens.`);
                    resolve();
                }
            });
        });

        if (transactionActive) {
            await new Promise((resolve, reject) => {
                db.run("COMMIT", function(err) {
                    if (err) {
                        console.error('Erro ao cometer a transação:', err.message);
                        reject(err);
                    } else {
                        transactionActive = false;
                        resolve();
                    }
                });
            });
        }

        console.log(`Posição e ordens associadas com id_posicao ${positionId} movidas e excluídas com sucesso.`);

    } catch (error) {
        if (transactionActive) {
            await new Promise((resolve, reject) => {
                db.run("ROLLBACK", function(err) {
                    if (err) {
                        console.error('Erro ao reverter a transação:', err.message);
                        reject(err);
                    } else {
                        transactionActive = false;
                        resolve();
                    }
                });
            });
        }
        throw error;
    }
}



// Nova função para obter uma posição específica pelo ID
function getPositionById(db, positionId) {
    return new Promise((resolve, reject) => {
        const sql = "SELECT * FROM posicoes WHERE id = ?";
        db.get(sql, [positionId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

// Gerar data e hora formatadas como string
function getCurrentDateTimeAsString() {
    const now = new Date();
    now.setUTCHours(now.getUTCHours() - 0);
    const formattedDateTime = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    return formattedDateTime;
}

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
  
  //console.log(dataHora);

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
    getDataHoraFormatada
};