const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../../config/.env') });

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

        // Tabelas conforme modelo fornecido
        // 1. configuracoes
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS configuracoes (
                id INT NOT NULL AUTO_INCREMENT,
                chave_api VARCHAR(255) NOT NULL,
                chave_secreta VARCHAR(255) NOT NULL,
                bot_token VARCHAR(255) DEFAULT NULL,
                api_url VARCHAR(255) DEFAULT NULL,
                ambiente VARCHAR(50) DEFAULT NULL,
                PRIMARY KEY (id),
                KEY idx_configuracoes_id (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "configuracoes" criada.');

        // 2. corretoras (necessária para FK em contas)
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS corretoras (
                id INT NOT NULL AUTO_INCREMENT,
                corretora VARCHAR(50) NOT NULL,
                ambiente VARCHAR(20) NOT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY idx_corretora_ambiente (corretora, ambiente)
            ) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "corretoras" criada.');

        // 3. contas
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
                saldo_cross_wallet DECIMAL(20,8) DEFAULT NULL COMMENT 'Cross Wallet Balance (cw)',
                balance_change DECIMAL(20,8) DEFAULT NULL COMMENT 'Balance Change except PnL and Commission (bc)',
                last_event_reason VARCHAR(50) DEFAULT NULL COMMENT 'Event reason type (m)',
                event_time BIGINT DEFAULT NULL COMMENT 'Event Time timestamp (E)',
                transaction_time BIGINT DEFAULT NULL COMMENT 'Transaction Time (T)',
                PRIMARY KEY (id),
                KEY fk_contas_corretora (id_corretora),
                CONSTRAINT fk_contas_corretora FOREIGN KEY (id_corretora) REFERENCES corretoras (id) ON DELETE SET NULL ON UPDATE CASCADE
            ) ENGINE=InnoDB AUTO_INCREMENT=1000 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "contas" criada.');

        // 4. controle_posicoes
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS controle_posicoes (
                total_abertas INT DEFAULT 0,
                limite_atual INT NOT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "controle_posicoes" criada.');

        // 5. divap_analysis
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

        // 6. exchange_symbols
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS exchange_symbols (
                id INT NOT NULL AUTO_INCREMENT,
                exchange VARCHAR(50) NOT NULL,
                symbol VARCHAR(30) NOT NULL,
                status VARCHAR(20) DEFAULT NULL,
                pair VARCHAR(30) DEFAULT NULL,
                contract_type VARCHAR(30) DEFAULT NULL,
                base_asset VARCHAR(20) DEFAULT NULL,
                quote_asset VARCHAR(20) DEFAULT NULL,
                margin_asset VARCHAR(20) DEFAULT NULL,
                price_precision INT DEFAULT NULL,
                quantity_precision INT DEFAULT NULL,
                base_asset_precision INT DEFAULT NULL,
                quote_precision INT DEFAULT NULL,
                onboard_date BIGINT DEFAULT NULL,
                liquidation_fee DECIMAL(10,5) DEFAULT NULL,
                market_take_bound DECIMAL(10,5) DEFAULT NULL,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY unique_exchange_symbol (exchange, symbol),
                KEY symbol (symbol)
            ) ENGINE=InnoDB AUTO_INCREMENT=520 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        console.log('✅ Tabela "exchange_symbols" criada.');

        // 7. exchange_filters
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS exchange_filters (
                id INT NOT NULL AUTO_INCREMENT,
                symbol_id INT NOT NULL,
                filter_type VARCHAR(50) NOT NULL,
                min_price VARCHAR(50) DEFAULT NULL,
                max_price VARCHAR(50) DEFAULT NULL,
                tick_size VARCHAR(50) DEFAULT NULL,
                min_qty VARCHAR(50) DEFAULT NULL,
                max_qty VARCHAR(50) DEFAULT NULL,
                step_size VARCHAR(50) DEFAULT NULL,
                min_notional VARCHAR(50) DEFAULT NULL,
                multiplier_up VARCHAR(50) DEFAULT NULL,
                multiplier_down VARCHAR(50) DEFAULT NULL,
                multiplier_decimal INT DEFAULT NULL,
                limit_orders INT DEFAULT NULL,
                limit_algo_orders INT DEFAULT NULL,
                PRIMARY KEY (id),
                UNIQUE KEY unique_symbol_filter (symbol_id, filter_type),
                CONSTRAINT exchange_filters_ibfk_1 FOREIGN KEY (symbol_id) REFERENCES exchange_symbols (id) ON DELETE CASCADE
            ) ENGINE=InnoDB AUTO_INCREMENT=24559 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
        `);
        console.log('✅ Tabela "exchange_filters" criada.');

        // 8. exchange_leverage_brackets
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS exchange_leverage_brackets (
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
            ) ENGINE=InnoDB AUTO_INCREMENT=208211 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "exchange_leverage_brackets" criada.');

        // 9. posicoes
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
                breakeven_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Breakeven Price (bep)',
                accumulated_realized DECIMAL(20,8) DEFAULT NULL COMMENT 'Accumulated Realized PnL (cr)',
                unrealized_pnl DECIMAL(20,8) DEFAULT NULL COMMENT 'Unrealized PnL (up)',
                margin_type VARCHAR(20) DEFAULT NULL COMMENT 'Margin Type - isolated/cross (mt)',
                isolated_wallet DECIMAL(20,8) DEFAULT NULL COMMENT 'Isolated Wallet amount (iw)',
                position_side VARCHAR(10) DEFAULT NULL COMMENT 'Position Side - LONG/SHORT/BOTH (ps)',
                event_reason VARCHAR(50) DEFAULT NULL COMMENT 'Reason for update (m)',
                webhook_data_raw LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Raw webhook data for debugging' CHECK (json_valid(webhook_data_raw)),
                PRIMARY KEY (id),
                KEY idx_conta_id (conta_id)
            ) ENGINE=InnoDB AUTO_INCREMENT=3738 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes" criada.');

        // 10. posicoes_fechadas
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
            ) ENGINE=InnoDB AUTO_INCREMENT=95 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "posicoes_fechadas" criada.');

        // 11. ordens
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
                client_order_id VARCHAR(100) DEFAULT NULL COMMENT 'Client Order Id da Binance (o.c)',
                time_in_force VARCHAR(10) DEFAULT NULL COMMENT 'Time in Force (o.f)',
                stop_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Stop Price (o.sp)',
                execution_type VARCHAR(20) DEFAULT NULL COMMENT 'Execution Type (o.x)',
                last_filled_quantity DECIMAL(20,8) DEFAULT NULL COMMENT 'Order Last Filled Quantity (o.l)',
                last_filled_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Last Filled Price (o.L)',
                order_trade_time BIGINT DEFAULT NULL COMMENT 'Order Trade Time (o.T)',
                bids_notional DECIMAL(20,8) DEFAULT NULL COMMENT 'Bids Notional (o.b)',
                ask_notional DECIMAL(20,8) DEFAULT NULL COMMENT 'Ask Notional (o.a)',
                is_maker_side TINYINT(1) DEFAULT NULL COMMENT 'Is this trade the maker side (o.m)',
                stop_price_working_type VARCHAR(20) DEFAULT NULL COMMENT 'Stop Price Working Type (o.wt)',
                original_order_type VARCHAR(30) DEFAULT NULL COMMENT 'Original Order Type (o.ot)',
                position_side VARCHAR(10) DEFAULT NULL COMMENT 'Position Side (o.ps)',
                activation_price DECIMAL(20,8) DEFAULT NULL COMMENT 'Activation Price (o.AP)',
                callback_rate DECIMAL(10,4) DEFAULT NULL COMMENT 'Callback Rate (o.cr)',
                price_protection TINYINT(1) DEFAULT NULL COMMENT 'Price protection (o.pP)',
                realized_profit DECIMAL(20,8) DEFAULT NULL COMMENT 'Realized Profit (o.rp)',
                stp_mode VARCHAR(20) DEFAULT NULL COMMENT 'STP mode (o.V)',
                price_match_mode VARCHAR(20) DEFAULT NULL COMMENT 'Price match mode (o.pm)',
                gtd_auto_cancel_time BIGINT DEFAULT NULL COMMENT 'TIF GTD order auto cancel time (o.gtd)',
                PRIMARY KEY (id),
                KEY idx_conta_id (conta_id),
                KEY idx_id_externo_simbolo (id_externo, simbolo),
                KEY fk_ordens_posicoes (id_posicao),
                CONSTRAINT fk_ordens_posicoes FOREIGN KEY (id_posicao) REFERENCES posicoes (id) ON DELETE SET NULL ON UPDATE CASCADE
            ) ENGINE=InnoDB AUTO_INCREMENT=1062 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens" criada.');

        // 12. ordens_fechadas
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
            ) ENGINE=InnoDB AUTO_INCREMENT=917 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "ordens_fechadas" criada.');

        // 13. webhook_signals
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
            ) ENGINE=InnoDB AUTO_INCREMENT=303 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "webhook_signals" criada.');

        // 14. signals_msg
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
            ) ENGINE=InnoDB AUTO_INCREMENT=704 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "signals_msg" criada.');

        // 15. monitoramento
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS monitoramento (
                id INT NOT NULL AUTO_INCREMENT,
                tipo_evento VARCHAR(50) NOT NULL,
                id_ordem INT NOT NULL,
                id_posicao INT DEFAULT NULL,
                mensagem TEXT DEFAULT NULL,
                data_hora_evento DATETIME NOT NULL,
                status VARCHAR(50) DEFAULT NULL,
                preco DECIMAL(20,8) DEFAULT NULL,
                preco_corrente DECIMAL(20,8) DEFAULT NULL,
                PRIMARY KEY (id),
                KEY id_ordem (id_ordem),
                KEY id_posicao (id_posicao),
                CONSTRAINT monitoramento_ibfk_1 FOREIGN KEY (id_ordem) REFERENCES ordens (id),
                CONSTRAINT monitoramento_ibfk_2 FOREIGN KEY (id_posicao) REFERENCES posicoes (id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        console.log('✅ Tabela "monitoramento" criada.');

        console.log('\n🚀 Banco de dados "starboy" criado com sucesso! Todas as tabelas foram criadas conforme o novo modelo.');
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