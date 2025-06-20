const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function createDatabase() {
    console.log('Iniciando criação do banco de dados MySQL...');
    console.log(`Host: ${process.env.DB_HOST}, Porta: ${process.env.DB_PORT}, Usuário: ${process.env.DB_USER}`);
    
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
        
        // ✅ FASE 1: CRIAR TABELAS SEM FOREIGN KEYS PRIMEIRO
        console.log('FASE 1: Criando tabelas base sem foreign keys...');

        // 1. Tabela corretoras (independente)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS corretoras (
                id INT NOT NULL AUTO_INCREMENT,
                corretora VARCHAR(50) NOT NULL COMMENT 'Nome da corretora (ex: binance, bybit)',
                ambiente VARCHAR(20) NOT NULL COMMENT 'Ambiente (ex: prd, testnet, dev)',
                spot_rest_api_url VARCHAR(255) DEFAULT NULL COMMENT 'URL da API REST para o mercado spot',
                futures_rest_api_url VARCHAR(255) DEFAULT NULL COMMENT 'URL da API REST para o mercado de futuros',
                futures_ws_market_url VARCHAR(255) DEFAULT NULL COMMENT 'URL do WebSocket para dados de mercado de futuros',
                futures_ws_api_url VARCHAR(255) DEFAULT NULL COMMENT 'URL do WebSocket API para futuros',
                ativa TINYINT(1) DEFAULT 1 COMMENT 'Se esta configuração está ativa',
                data_criacao TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
                ultima_atualizacao TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY idx_corretora_ambiente (corretora, ambiente)
            ) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci 
            COMMENT='Configurações de URLs de APIs por corretora e ambiente'
        `);
        console.log('✅ Tabela "corretoras" criada.');

        // 2. Tabela posicoes (independente, será referenciada)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS posicoes (
                id INT NOT NULL AUTO_INCREMENT,
                simbolo VARCHAR(50) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
                quantidade_aberta DECIMAL(20,8) DEFAULT NULL,
                preco_medio DECIMAL(20,8) NOT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_abertura DATETIME NOT NULL,
                data_hora_fechamento DATETIME DEFAULT NULL,
                side VARCHAR(20) DEFAULT NULL,
                leverage INT DEFAULT NULL,
                data_hora_ultima_atualizacao DATETIME DEFAULT NULL,
                preco_entrada DECIMAL(20,8) DEFAULT NULL,
                preco_corrente DECIMAL(20,8) DEFAULT NULL,
                orign_sig VARCHAR(100) DEFAULT NULL,
                trailing_stop_level VARCHAR(20) DEFAULT 'ORIGINAL',
                pnl_corrente DECIMAL(20,8) DEFAULT 0.00000000,
                conta_id INT DEFAULT 1,
                observacoes TEXT DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_conta_id (conta_id)
            ) ENGINE=InnoDB AUTO_INCREMENT=3727 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes" criada.');

        // 3. Tabelas independentes (sem foreign keys)
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

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS controle_posicoes (
                total_abertas INT DEFAULT 0,
                limite_atual INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "controle_posicoes" criada.');

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS alavancagem (
                id INT NOT NULL AUTO_INCREMENT,
                symbol VARCHAR(50) NOT NULL,
                corretora VARCHAR(50) NOT NULL,
                bracket INT NOT NULL,
                initial_leverage INT NOT NULL,
                notional_cap DECIMAL(50,2) NOT NULL,
                notional_floor DECIMAL(15,2) NOT NULL,
                maint_margin_ratio DECIMAL(8,6) NOT NULL,
                cum DECIMAL(15,2) NOT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY symbol (symbol, corretora, bracket)
            ) ENGINE=InnoDB AUTO_INCREMENT=208177 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "alavancagem" criada.');

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS posicoes_fechadas (
                id INT NOT NULL AUTO_INCREMENT,
                id_original INT DEFAULT NULL,
                simbolo VARCHAR(50) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
                preco_medio DECIMAL(20,8) NOT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_abertura DATETIME NOT NULL,
                data_hora_fechamento DATETIME DEFAULT NULL,
                motivo_fechamento VARCHAR(100) DEFAULT NULL,
                side VARCHAR(20) DEFAULT NULL,
                leverage INT DEFAULT NULL,
                data_hora_ultima_atualizacao DATETIME DEFAULT NULL,
                preco_entrada DECIMAL(20,8) DEFAULT NULL,
                preco_corrente DECIMAL(20,8) DEFAULT NULL,
                orign_sig VARCHAR(100) DEFAULT NULL,
                conta_id INT DEFAULT 1,
                PRIMARY KEY (id),
                KEY idx_simbolo (simbolo),
                KEY idx_status (status),
                KEY idx_id_original (id_original)
            ) ENGINE=InnoDB AUTO_INCREMENT=83 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes_fechadas" criada.');

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ordens_fechadas (
                id INT NOT NULL AUTO_INCREMENT,
                id_original INT DEFAULT NULL,
                tipo_ordem VARCHAR(50) NOT NULL,
                preco DECIMAL(20,8) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
                id_posicao INT DEFAULT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_criacao DATETIME DEFAULT NULL,
                id_externo VARCHAR(100) DEFAULT NULL,
                side VARCHAR(20) DEFAULT NULL,
                simbolo VARCHAR(50) DEFAULT NULL,
                tipo_ordem_bot VARCHAR(50) DEFAULT NULL,
                target INT DEFAULT NULL,
                reduce_only TINYINT(1) DEFAULT NULL,
                close_position TINYINT(1) DEFAULT NULL,
                last_update DATETIME DEFAULT NULL,
                renew_sl_firs VARCHAR(20) DEFAULT NULL,
                renew_sl_seco VARCHAR(20) DEFAULT NULL,
                orign_sig VARCHAR(100) DEFAULT NULL,
                dados_originais_ws TEXT DEFAULT NULL,
                quantidade_executada DECIMAL(20,8) DEFAULT 0.00000000,
                preco_executado DECIMAL(20,8) DEFAULT NULL,
                observacao VARCHAR(255) DEFAULT NULL,
                id_original_ordens INT DEFAULT NULL,
                conta_id INT DEFAULT 1,
                PRIMARY KEY (id),
                KEY idx_simbolo (simbolo),
                KEY idx_status (status),
                KEY idx_id_posicao (id_posicao),
                KEY idx_id_original (id_original),
                KEY idx_id_original_ordens (id_original_ordens)
            ) ENGINE=InnoDB AUTO_INCREMENT=562 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens_fechadas" criada.');

        await connection.execute(`
            CREATE TABLE IF NOT EXISTS divap_analysis (
                id INT NOT NULL AUTO_INCREMENT,
                signal_id INT DEFAULT NULL,
                is_bull_divap TINYINT(1) DEFAULT 0,
                is_bear_divap TINYINT(1) DEFAULT 0,
                divap_confirmed TINYINT(1) DEFAULT 0,
                rsi FLOAT DEFAULT NULL,
                volume DOUBLE DEFAULT NULL,
                volume_sma DOUBLE DEFAULT NULL,
                high_volume TINYINT(1) DEFAULT 0,
                bull_div TINYINT(1) DEFAULT 0,
                bear_div TINYINT(1) DEFAULT 0,
                message TEXT DEFAULT NULL,
                price_reversal_up TINYINT(1) DEFAULT 0,
                price_reversal_down TINYINT(1) DEFAULT 0,
                analyzed_at DATETIME DEFAULT NULL,
                bull_reversal_pattern TINYINT(1) DEFAULT 0,
                bear_reversal_pattern TINYINT(1) DEFAULT 0,
                PRIMARY KEY (id),
                UNIQUE KEY signal_id (signal_id)
            ) ENGINE=InnoDB AUTO_INCREMENT=490 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "divap_analysis" criada.');

        // ✅ FASE 2: CRIAR TABELAS COM FOREIGN KEYS
        console.log('\nFASE 2: Criando tabelas com foreign keys...');

        // 4. Tabela contas (referencia corretoras)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS contas (
                id INT NOT NULL AUTO_INCREMENT,
                nome VARCHAR(100) NOT NULL,
                descricao TEXT DEFAULT NULL,
                id_corretora INT DEFAULT 1 COMMENT 'ID da corretora associada a esta conta',
                api_key VARCHAR(255) NOT NULL,
                api_secret VARCHAR(255) NOT NULL,
                ws_api_key VARCHAR(255) DEFAULT NULL,
                ws_api_secret VARCHAR(255) DEFAULT NULL,
                telegram_chat_id BIGINT DEFAULT NULL,
                ativa TINYINT(1) DEFAULT 1,
                max_posicoes INT DEFAULT 5,
                saldo_base_calculo DECIMAL(20,8) DEFAULT NULL,
                saldo DECIMAL(20,8) DEFAULT NULL,
                data_criacao DATETIME DEFAULT CURRENT_TIMESTAMP,
                ultima_atualizacao DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                celular VARCHAR(20) DEFAULT NULL,
                telegram_bot_token VARCHAR(255) DEFAULT NULL,
                telegram_bot_token_controller VARCHAR(255) DEFAULT NULL,
                PRIMARY KEY (id),
                KEY fk_contas_corretora (id_corretora),
                CONSTRAINT fk_contas_corretora FOREIGN KEY (id_corretora) REFERENCES corretoras (id) ON DELETE SET NULL ON UPDATE CASCADE
            ) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "contas" criada.');

        // 5. Tabela webhook_signals (referencia posicoes)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS webhook_signals (
                id INT NOT NULL AUTO_INCREMENT,
                symbol VARCHAR(50) NOT NULL,
                timeframe VARCHAR(10) DEFAULT NULL,
                side VARCHAR(10) NOT NULL,
                leverage INT NOT NULL,
                capital_pct DECIMAL(5,2) NOT NULL,
                entry_price DECIMAL(20,8) NOT NULL,
                tp_price DECIMAL(20,8) NOT NULL,
                sl_price DECIMAL(20,8) NOT NULL,
                status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
                error_message TEXT DEFAULT NULL,
                position_id INT DEFAULT NULL,
                entry_order_id BIGINT DEFAULT NULL,
                tp_order_id BIGINT DEFAULT NULL,
                sl_order_id BIGINT DEFAULT NULL,
                chat_id BIGINT DEFAULT NULL,
                message_id BIGINT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                timeout_at DATETIME DEFAULT NULL COMMENT 'Horário calculado para timeout',
                max_lifetime_minutes INT DEFAULT NULL COMMENT 'Tempo máximo de vida em minutos',
                registry_message_id BIGINT DEFAULT NULL,
                message_id_orig BIGINT DEFAULT NULL COMMENT 'ID da mensagem original no grupo de origem',
                chat_id_orig_sinal BIGINT DEFAULT NULL,
                tp1_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Preço do primeiro alvo',
                tp2_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Preço do segundo alvo',
                tp3_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Preço do terceiro alvo',
                tp4_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Preço do quarto alvo',
                tp5_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Preço do quinto alvo',
                message_source VARCHAR(50) DEFAULT NULL,
                divap_confirmado TINYINT(1) DEFAULT NULL,
                cancelado_checker TINYINT(1) DEFAULT NULL,
                sent_msg TINYINT(1) DEFAULT 0,
                conta_id INT DEFAULT 1,
                PRIMARY KEY (id),
                KEY idx_status (status),
                KEY idx_symbol (symbol),
                KEY idx_position_id (position_id),
                KEY idx_conta_id (conta_id),
                CONSTRAINT webhook_signals_ibfk_1 FOREIGN KEY (position_id) REFERENCES posicoes (id) ON DELETE SET NULL
            ) ENGINE=InnoDB AUTO_INCREMENT=254 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "webhook_signals" criada.');

        // 6. Tabela ordens (referencia posicoes)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS ordens (
                id INT NOT NULL AUTO_INCREMENT,
                tipo_ordem VARCHAR(50) NOT NULL,
                preco DECIMAL(20,8) NOT NULL,
                quantidade DECIMAL(20,8) NOT NULL,
                id_posicao INT DEFAULT NULL,
                status VARCHAR(50) NOT NULL,
                data_hora_criacao DATETIME DEFAULT NULL,
                id_externo VARCHAR(100) DEFAULT NULL,
                side VARCHAR(20) DEFAULT NULL,
                simbolo VARCHAR(50) DEFAULT NULL,
                tipo_ordem_bot VARCHAR(50) DEFAULT NULL,
                target INT DEFAULT NULL,
                reduce_only TINYINT(1) DEFAULT NULL,
                close_position TINYINT(1) DEFAULT NULL,
                last_update DATETIME DEFAULT NULL,
                orign_sig VARCHAR(100) DEFAULT NULL,
                observacao VARCHAR(255) DEFAULT NULL,
                preco_executado DECIMAL(20,8) DEFAULT NULL,
                quantidade_executada DECIMAL(20,8) DEFAULT 0.00000000,
                dados_originais_ws TEXT DEFAULT NULL,
                conta_id INT DEFAULT 1,
                renew_sl_firs VARCHAR(20) DEFAULT NULL,
                renew_sl_seco VARCHAR(20) DEFAULT NULL,
                commission DECIMAL(20,8) DEFAULT 0.00000000,
                commission_asset VARCHAR(10) DEFAULT NULL,
                trade_id BIGINT DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_conta_id (conta_id),
                KEY idx_id_externo_simbolo (id_externo, simbolo),
                KEY fk_ordens_posicoes (id_posicao),
                CONSTRAINT fk_ordens_posicoes FOREIGN KEY (id_posicao) REFERENCES posicoes (id) ON DELETE SET NULL ON UPDATE CASCADE
            ) ENGINE=InnoDB AUTO_INCREMENT=688 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens" criada.');

        // 7. Tabela signals_msg (referencia webhook_signals)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS signals_msg (
                id INT NOT NULL AUTO_INCREMENT,
                message_id BIGINT NOT NULL COMMENT 'ID da mensagem no Telegram',
                chat_id BIGINT NOT NULL COMMENT 'ID do chat onde a mensagem foi enviada',
                text TEXT NOT NULL COMMENT 'Conteúdo da mensagem',
                is_reply TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Se é uma resposta a outra mensagem',
                reply_to_message_id BIGINT DEFAULT NULL COMMENT 'ID da mensagem à qual esta responde',
                symbol VARCHAR(50) DEFAULT NULL COMMENT 'Símbolo relacionado (se identificado)',
                signal_id INT DEFAULT NULL COMMENT 'ID do sinal na tabela webhook_signals (se relacionado)',
                created_at DATETIME NOT NULL COMMENT 'Timestamp da mensagem',
                registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT 'Timestamp de registro no banco',
                message_source VARCHAR(50) DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_message_id (message_id),
                KEY idx_chat_id (chat_id),
                KEY idx_symbol (symbol),
                KEY idx_reply_to (reply_to_message_id),
                KEY idx_signal_id (signal_id),
                CONSTRAINT signals_msg_ibfk_1 FOREIGN KEY (signal_id) REFERENCES webhook_signals (id) ON DELETE SET NULL
            ) ENGINE=InnoDB AUTO_INCREMENT=639 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "signals_msg" criada.');

        // ✅ PROBLEMA CORRIGIDO: Tabela monitoramento SEM foreign key para ordens
        // (porque referencia id_externo, não id)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS monitoramento (
                id INT NOT NULL AUTO_INCREMENT,
                tipo_evento VARCHAR(50) NOT NULL,
                id_ordem VARCHAR(100) NOT NULL COMMENT 'ID externo da ordem (não FK)',
                id_posicao INT DEFAULT NULL,
                mensagem TEXT DEFAULT NULL,
                data_hora_evento DATETIME NOT NULL,
                status VARCHAR(50) DEFAULT NULL,
                preco DECIMAL(20,8) DEFAULT NULL,
                preco_corrente DECIMAL(20,8) DEFAULT NULL,
                simbolo VARCHAR(50) DEFAULT NULL,
                conta_id INT DEFAULT 1,
                PRIMARY KEY (id),
                KEY idx_id_ordem (id_ordem),
                KEY idx_id_posicao (id_posicao),
                KEY idx_simbolo (simbolo),
                CONSTRAINT monitoramento_ibfk_1 FOREIGN KEY (id_posicao) REFERENCES posicoes (id) ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "monitoramento" criada.');

        // ✅ FASE 3: INSERIR DADOS INICIAIS
        console.log('\nFASE 3: Inserindo dados iniciais...');

        // Inserir registro inicial na tabela controle_posicoes se não existir
        const [rows] = await connection.execute('SELECT COUNT(*) as count FROM controle_posicoes');
        if (rows[0].count === 0) {
            await connection.execute('INSERT INTO controle_posicoes (total_abertas, limite_atual) VALUES (0, 5)');
            console.log('✅ Registro inicial de controle_posicoes criado.');
        }

        // Inserir corretora padrão Binance se não existir
        const [corretoras] = await connection.execute('SELECT COUNT(*) as count FROM corretoras WHERE id = 1');
        if (corretoras[0].count === 0) {
            await connection.execute(`
                INSERT INTO corretoras (id, corretora, ambiente, futures_rest_api_url, futures_ws_market_url, futures_ws_api_url, ativa) 
                VALUES (1, 'binance', 'prd', 'https://fapi.binance.com/fapi', 'wss://fstream.binance.com', 'wss://ws-fapi.binance.com/ws-fapi/v1', 1)
            `);
            console.log('✅ Corretora padrão Binance PRD criada.');
        }

        // Inserir conta padrão se não existir
        const [contas] = await connection.execute('SELECT COUNT(*) as count FROM contas WHERE id = 1');
        if (contas[0].count === 0) {
            await connection.execute(`
                INSERT INTO contas (id, nome, id_corretora, api_key, api_secret, ativa) 
                VALUES (1, 'Conta Principal', 1, 'INSIRA_SUA_API_KEY', 'INSIRA_SUA_API_SECRET', 1)
            `);
            console.log('✅ Conta padrão criada (ID: 1). LEMBRE-SE DE ATUALIZAR AS CREDENCIAIS!');
        }

        console.log('\n🚀 Banco de dados "starboy" criado com sucesso! Todas as tabelas foram criadas.');
        console.log('\n📋 PRÓXIMOS PASSOS:');
        console.log('1. ✅ Atualizar credenciais da API na tabela "contas"');
        console.log('2. ✅ Configurar tokens do Telegram na tabela "contas"');
        console.log('3. ✅ Verificar configurações da corretora na tabela "corretoras"');
        
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

// Executar a criação do banco de dados
createDatabase()
    .then(() => {
        console.log('Processo finalizado com sucesso!');
    })
    .catch(err => {
        console.error('Falha no processo:', err);
        process.exit(1);
    });