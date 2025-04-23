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
                quantidade DECIMAL(20, 8) NOT NULL DEFAULT 0,
                preco_medio DECIMAL(20, 8) NOT NULL DEFAULT 0,
                status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
                data_hora_abertura DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                data_hora_fechamento DATETIME NULL,
                side VARCHAR(20) DEFAULT 'BUY',
                leverage INT DEFAULT 1,
                data_hora_ultima_atualizacao DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
                preco_entrada DECIMAL(20, 8) NOT NULL DEFAULT 0,
                preco_corrente DECIMAL(20, 8) NOT NULL DEFAULT 0,
                orign_sig VARCHAR(100) NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes" criada.');
        
        // Tabela ordens (criar antes devido à foreign key em historico_ordens)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ordens (
                id INT AUTO_INCREMENT PRIMARY KEY,
                tipo_ordem VARCHAR(50) NOT NULL,
                preco DECIMAL(20, 8) NOT NULL DEFAULT 0,
                quantidade DECIMAL(20, 8) NOT NULL DEFAULT 0,
                id_posicao INT,
                status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
                data_hora_criacao DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                id_externo BIGINT NULL,
                side VARCHAR(20) DEFAULT 'BUY',
                simbolo VARCHAR(50) NOT NULL,
                tipo_ordem_bot VARCHAR(50) NULL,
                target INT NULL,
                reduce_only BOOLEAN DEFAULT FALSE,
                close_position BOOLEAN DEFAULT FALSE,
                last_update DATETIME NULL DEFAULT CURRENT_TIMESTAMP,
                orign_sig VARCHAR(100) NULL,
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
        
        // Tabela webhook_signals
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS webhook_signals (
                id INT AUTO_INCREMENT PRIMARY KEY,
                symbol VARCHAR(50) NOT NULL,
                side VARCHAR(10) NOT NULL,
                leverage INT NOT NULL,
                capital_pct DECIMAL(5,2) NOT NULL,
                entry_price DECIMAL(20,8) NOT NULL,
                tp_price DECIMAL(20,8) NOT NULL,
                sl_price DECIMAL(20,8) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
                error_message TEXT,
                position_id INT,
                entry_order_id BIGINT,
                tp_order_id BIGINT,
                sl_order_id BIGINT,
                chat_id BIGINT,
                message_id BIGINT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                
                INDEX idx_status (status),
                INDEX idx_symbol (symbol),
                INDEX idx_position_id (position_id),
                FOREIGN KEY (position_id) REFERENCES posicoes(id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "webhook_signals" criada.');
        
        // Tabela posicoes_fechadas
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS posicoes_fechadas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_original INT,
                simbolo VARCHAR(50) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
                preco_medio DECIMAL(20,8) NOT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_abertura DATETIME NOT NULL,
                data_hora_fechamento DATETIME,
                motivo_fechamento VARCHAR(100),
                side VARCHAR(20),
                leverage INT,
                data_hora_ultima_atualizacao DATETIME,
                preco_entrada DECIMAL(20,8),
                preco_corrente DECIMAL(20,8),
                orign_sig VARCHAR(100),
                
                INDEX idx_simbolo (simbolo),
                INDEX idx_status (status),
                INDEX idx_id_original (id_original)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes_fechadas" criada.');
          
        // Tabela ordens_fechadas
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ordens_fechadas (
                id INT AUTO_INCREMENT PRIMARY KEY,
                id_original INT,
                tipo_ordem VARCHAR(50) NOT NULL,
                preco DECIMAL(20,8) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
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
                renew_sl_firs VARCHAR(20),
                renew_sl_seco VARCHAR(20),
                orign_sig VARCHAR(100),
                
                INDEX idx_simbolo (simbolo),
                INDEX idx_status (status),
                INDEX idx_id_posicao (id_posicao),
                INDEX idx_id_original (id_original)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens_fechadas" criada.');
        
        // Inserir registro inicial na tabela controle_posicoes se não existir
        const [rows] = await connection.execute('SELECT COUNT(*) as count FROM controle_posicoes');
        if (rows[0].count === 0) {
            await connection.execute('INSERT INTO controle_posicoes (total_abertas, limite_atual) VALUES (0, 5)');
            console.log('✅ Registro inicial de controle_posicoes criado.');
        }

        // Adicionar coluna orign_sig em posicoes_fechadas se não existir
        try {
            await connection.execute(`
                ALTER TABLE posicoes_fechadas 
                ADD COLUMN IF NOT EXISTS orign_sig VARCHAR(100) NULL
            `);
            console.log('✅ Coluna orign_sig adicionada à tabela posicoes_fechadas.');
        } catch (error) {
            console.log('Coluna orign_sig já existe na tabela posicoes_fechadas ou erro:', error.message);
        }

        // Adicionar coluna orign_sig em ordens_fechadas se não existir
        try {
            await connection.execute(`
                ALTER TABLE ordens_fechadas 
                ADD COLUMN IF NOT EXISTS orign_sig VARCHAR(100) NULL
            `);
            console.log('✅ Coluna orign_sig adicionada à tabela ordens_fechadas.');
        } catch (error) {
            console.log('Coluna orign_sig já existe na tabela ordens_fechadas ou erro:', error.message);
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