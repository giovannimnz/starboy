const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function createDatabase() {
    console.log('Iniciando criação do banco de dados MySQL...');
    console.log(`Host: ${process.env.DB_HOST}, Porta: ${process.env.DB_PORT}, Usuário: ${process.env.DB_USER}`);
    
    // Primeiro, conectar sem especificar o banco de dados
    let connection;
    
    try {
        connection = await mysql.createConnection({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD
        });
        
        console.log('Conexão estabelecida com sucesso.');
        
        // Criar banco de dados se não existir
        console.log('Criando banco de dados "starboy" se não existir...');
        await connection.execute(`CREATE DATABASE IF NOT EXISTS ${process.env.DB_NAME} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
        console.log(`✅ Banco de dados "${process.env.DB_NAME}" criado ou já existente.`);
        
        // Selecionar o banco de dados
        await connection.execute(`USE ${process.env.DB_NAME}`);
        console.log(`Banco de dados "${process.env.DB_NAME}" selecionado.`);
        
        // Criar tabelas
        console.log('Criando tabelas...');
        
        // Tabela configuracoes
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS configuracoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                chave_api VARCHAR(255) NOT NULL,
                chave_secreta VARCHAR(255) NOT NULL,
                bot_token VARCHAR(255),
                api_url VARCHAR(255),
                ambiente VARCHAR(50),
                INDEX idx_configuracoes_id (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "configuracoes" criada.');
        
        // Tabela conta
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS conta (
                id INT AUTO_INCREMENT PRIMARY KEY,
                saldo DECIMAL(20, 8),
                margem_manutencao DECIMAL(20, 8),
                saldo_nao_realizado DECIMAL(20, 8)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "conta" criada.');
        
        // Tabela controle_posicoes
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS controle_posicoes (
                total_abertas INT DEFAULT 0,
                limite_atual INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "controle_posicoes" criada.');
        
        // Tabela posicoes (criar antes para as foreign keys)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS posicoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                simbolo VARCHAR(50) NOT NULL,
                quantidade DECIMAL(20, 8) NOT NULL,
                preco_medio DECIMAL(20, 8) NOT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_abertura DATETIME NOT NULL,
                data_hora_fechamento DATETIME,
                side VARCHAR(20),
                leverage INT,
                data_hora_ultima_atualizacao DATETIME,
                preco_entrada DECIMAL(20, 8),
                preco_corrente DECIMAL(20, 8)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes" criada.');
        
        // Tabela ordens (criar antes devido à foreign key em historico_ordens)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ordens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tipo_ordem VARCHAR(50) NOT NULL,
                preco DECIMAL(20, 8) NOT NULL,
                quantidade DECIMAL(20, 8) NOT NULL,
                id_posicao INT,
                status VARCHAR(50) NOT NULL,
                data_hora_criacao DATETIME,
                id_externo BIGINT,
                side VARCHAR(20),
                simbolo VARCHAR(50),
                tipo_ordem_bot VARCHAR(50),
                target INT,
                reduce_only BOOLEAN,
                close_position BOOLEAN,
                last_update DATETIME,
                FOREIGN KEY (id_posicao) REFERENCES posicoes(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens" criada.');
        
        // Tabela historico_ordens
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS historico_ordens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_posicao INT,
                id_ordem INT,
                tipo_evento VARCHAR(50) NOT NULL,
                data_hora_evento DATETIME NOT NULL,
                resultado DECIMAL(20, 8),
                tipo_ordem_bot VARCHAR(50),
                target INT,
                reduce_only BOOLEAN,
                close_position BOOLEAN,
                last_update DATETIME,
                FOREIGN KEY (id_posicao) REFERENCES posicoes(id),
                FOREIGN KEY (id_ordem) REFERENCES ordens(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "historico_ordens" criada.');
        
        // Tabela historico_posicoes
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS historico_posicoes (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_posicao INT,
                tipo_evento VARCHAR(50) NOT NULL,
                data_hora_evento DATETIME NOT NULL,
                resultado DECIMAL(20, 8),
                tipo_ordem_bot VARCHAR(50),
                target INT,
                reduce_only BOOLEAN,
                close_position BOOLEAN,
                last_update DATETIME,
                FOREIGN KEY (id_posicao) REFERENCES posicoes(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "historico_posicoes" criada.');
        
        // Tabela monitoramento
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS monitoramento (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tipo_evento VARCHAR(50) NOT NULL,
                id_ordem INT NOT NULL,
                id_posicao INT,
                mensagem TEXT,
                data_hora_evento DATETIME NOT NULL,
                status VARCHAR(50),
                preco DECIMAL(20, 8),
                preco_corrente DECIMAL(20, 8),
                FOREIGN KEY (id_ordem) REFERENCES ordens(id),
                FOREIGN KEY (id_posicao) REFERENCES posicoes(id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "monitoramento" criada.');
        
        // Inserir registro inicial na tabela controle_posicoes se não existir
        const [rows] = await connection.execute('SELECT COUNT(*) as count FROM controle_posicoes');
        if (rows[0].count === 0) {
            await connection.execute('INSERT INTO controle_posicoes (total_abertas, limite_atual) VALUES (0, 5)');
            console.log('✅ Registro inicial de controle_posicoes criado.');
        }
        
        console.log('\n🚀 Banco de dados "starboy" criado com sucesso! Todas as tabelas foram criadas.');
        
    } catch (error) {
        console.error('❌ Erro ao criar banco de dados:', error);
        console.error('Detalhes do erro:', error.message);
        throw error;
    } finally {
        if (connection) {
            await connection.end();
            console.log('Conexão encerrada.');
        }
    }
}

// Executar a criação do banco de dados no servidor
createDatabase()
    .then(() => {
        console.log('Processo finalizado com sucesso!');
    })
    .catch(err => {
        console.error('Falha no processo:', err);
        process.exit(1);
    });