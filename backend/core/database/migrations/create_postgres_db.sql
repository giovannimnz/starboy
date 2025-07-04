-- =========================================================================
-- SCRIPT DE CRIAÇÃO DO BANCO DE DADOS E ESTRUTURA - POSTGRESQL
-- =========================================================================
-- Sistema: Starboy Trading System
-- Objetivo: Criar a estrutura completa do banco de dados, incluindo tabelas,
--           chaves, índices e gatilhos para o PostgreSQL.
-- =========================================================================

-- Inicia uma transação para garantir que todas as operações sejam atômicas
BEGIN;

-- -------------------------------------------------------------------------
-- SEÇÃO 1: FUNÇÃO DE GATILHO (TRIGGER) PARA ATUALIZAÇÃO DE TIMESTAMPS
-- -------------------------------------------------------------------------
-- Esta função será usada para simular o comportamento 'ON UPDATE CURRENT_TIMESTAMP' do MySQL.
CREATE OR REPLACE FUNCTION update_timestamp_column()
RETURNS TRIGGER AS $$
BEGIN
    -- Para a tabela 'users' que usa 'atualizado_em'
    IF TG_TABLE_NAME = 'users' THEN
        NEW.atualizado_em = CURRENT_TIMESTAMP;
    END IF;
    -- Para a tabela 'contas' que usa 'ultima_atualizacao'
    IF TG_TABLE_NAME = 'contas' THEN
        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
    END IF;
    -- Para outras tabelas que possam usar nomes diferentes
    IF TG_TABLE_NAME = 'corretoras' THEN
        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
    END IF;
    IF TG_TABLE_NAME = 'exchange_symbols' THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
    IF TG_TABLE_NAME = 'posicoes' THEN
        NEW.data_hora_ultima_atualizacao = CURRENT_TIMESTAMP;
        NEW.last_update = CURRENT_TIMESTAMP;
    END IF;
     IF TG_TABLE_NAME = 'webhook_signals' THEN
        NEW.updated_at = CURRENT_TIMESTAMP;
    END IF;
     IF TG_TABLE_NAME = 'ordens' THEN
        NEW.last_update = CURRENT_TIMESTAMP;
    END IF;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- -------------------------------------------------------------------------
-- SEÇÃO 2: CRIAÇÃO DAS TABELAS
-- -------------------------------------------------------------------------
-- A ordem de criação respeita as dependências de chaves estrangeiras.

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(20),
    nome VARCHAR(255) NOT NULL,
    sobrenome VARCHAR(255),
    email VARCHAR(255) NOT NULL UNIQUE,
    senha VARCHAR(255) NOT NULL,
    ativa BOOLEAN NOT NULL DEFAULT true,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON COLUMN users.senha IS 'Armazenará o HASH da senha, nunca a senha em texto plano';

CREATE TABLE IF NOT EXISTS corretoras (
    id SERIAL PRIMARY KEY,
    corretora VARCHAR(50) NOT NULL,
    ambiente VARCHAR(20) NOT NULL,
    spot_rest_api_url VARCHAR(255),
    futures_rest_api_url VARCHAR(255),
    futures_ws_market_url VARCHAR(255),
    futures_ws_api_url VARCHAR(255),
    ativa BOOLEAN DEFAULT true,
    data_criacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    ultima_atualizacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (corretora, ambiente)
);
COMMENT ON COLUMN corretoras.corretora IS 'Nome da corretora (ex: binance, bybit)';
COMMENT ON COLUMN corretoras.ambiente IS 'Ambiente (ex: prd, testnet, dev)';
COMMENT ON TABLE corretoras IS 'Configurações de URLs de APIs por corretora e ambiente';

CREATE TABLE IF NOT EXISTS contas (
    id SERIAL PRIMARY KEY,
    nome VARCHAR(100) NOT NULL,
    descricao TEXT,
    id_corretora INT DEFAULT 1,
    api_key VARCHAR(255) NOT NULL,
    api_secret VARCHAR(255) NOT NULL,
    ws_api_key VARCHAR(255),
    ws_api_secret VARCHAR(255),
    testnet_spot_api_key VARCHAR(255),
    testnet_spot_api_secret VARCHAR(255),
    telegram_chat_id BIGINT,
    ativa BOOLEAN DEFAULT true,
    max_posicoes INT DEFAULT 5,
    saldo_futuros DECIMAL(20,8),
    saldo_spot DECIMAL(20,8),
    saldo_base_calculo_futuros DECIMAL(20,8),
    saldo_base_calculo_spot DECIMAL(20,8),
    data_criacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    ultima_atualizacao TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    celular VARCHAR(20),
    telegram_bot_token VARCHAR(255),
    telegram_bot_token_controller VARCHAR(255),
    saldo_cross_wallet DECIMAL(20,8),
    balance_change DECIMAL(20,8),
    last_event_reason VARCHAR(50),
    event_time BIGINT,
    transaction_time BIGINT,
    user_id INT
);
COMMENT ON COLUMN contas.id_corretora IS 'ID da corretora associada a esta conta';
COMMENT ON COLUMN contas.saldo_cross_wallet IS 'Cross Wallet Balance (cw)';
COMMENT ON COLUMN contas.balance_change IS 'Balance Change except PnL and Commission (bc)';
COMMENT ON COLUMN contas.last_event_reason IS 'Event reason type (m)';
COMMENT ON COLUMN contas.event_time IS 'Event Time timestamp (E)';
COMMENT ON COLUMN contas.transaction_time IS 'Transaction Time (T)';
COMMENT ON COLUMN contas.user_id IS 'ID do usuário do sistema ao qual esta conta pertence';

CREATE TABLE IF NOT EXISTS configuracoes (
    id SERIAL PRIMARY KEY,
    chave_api VARCHAR(255) NOT NULL,
    chave_secreta VARCHAR(255) NOT NULL,
    bot_token VARCHAR(255),
    api_url VARCHAR(255),
    ambiente VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS exchange_symbols (
    id SERIAL PRIMARY KEY,
    exchange VARCHAR(50) NOT NULL,
    symbol VARCHAR(30) NOT NULL,
    status VARCHAR(20),
    pair VARCHAR(30),
    contract_type VARCHAR(30),
    base_asset VARCHAR(20),
    quote_asset VARCHAR(20),
    margin_asset VARCHAR(20),
    price_precision INT,
    quantity_precision INT,
    base_asset_precision INT,
    quote_precision INT,
    onboard_date BIGINT,
    liquidation_fee DECIMAL(10,5),
    market_take_bound DECIMAL(10,5),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (exchange, symbol)
);

CREATE TABLE IF NOT EXISTS exchange_filters (
    id SERIAL PRIMARY KEY,
    symbol_id INT NOT NULL,
    filter_type VARCHAR(50) NOT NULL,
    min_price VARCHAR(50),
    max_price VARCHAR(50),
    tick_size VARCHAR(50),
    min_qty VARCHAR(50),
    max_qty VARCHAR(50),
    step_size VARCHAR(50),
    min_notional VARCHAR(50),
    multiplier_up VARCHAR(50),
    multiplier_down VARCHAR(50),
    multiplier_decimal INT,
    limit_orders INT,
    limit_algo_orders INT,
    UNIQUE (symbol_id, filter_type)
);

CREATE TABLE IF NOT EXISTS exchange_leverage_brackets (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    corretora VARCHAR(50) NOT NULL,
    bracket INT NOT NULL,
    initial_leverage INT NOT NULL,
    notional_cap DECIMAL(50,2) NOT NULL,
    notional_floor DECIMAL(15,2) NOT NULL,
    maint_margin_ratio DECIMAL(8,6) NOT NULL,
    cum DECIMAL(15,2) NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (symbol, corretora, bracket)
);

CREATE TABLE IF NOT EXISTS posicoes (
    id SERIAL PRIMARY KEY,
    simbolo VARCHAR(50) NOT NULL,
    quantidade DECIMAL(20,8) NOT NULL,
    quantidade_aberta DECIMAL(20,8),
    preco_medio DECIMAL(20,8) NOT NULL,
    status VARCHAR(50) NOT NULL,
    data_hora_abertura TIMESTAMPTZ NOT NULL,
    data_hora_fechamento TIMESTAMPTZ,
    side VARCHAR(20),
    leverage INT,
    data_hora_ultima_atualizacao TIMESTAMPTZ,
    preco_entrada DECIMAL(20,8),
    preco_corrente DECIMAL(20,8),
    orign_sig VARCHAR(100),
    trailing_stop_level VARCHAR(20) DEFAULT 'ORIGINAL',
    pnl_corrente DECIMAL(20,8) DEFAULT 0.00,
    conta_id INT DEFAULT 1,
    observacoes TEXT,
    breakeven_price DECIMAL(20,8),
    accumulated_realized DECIMAL(20,8),
    unrealized_pnl DECIMAL(20,8),
    total_realized DECIMAL(20,8) DEFAULT 0.00,
    total_commission DECIMAL(20,8) DEFAULT 0.00,
    liquid_pnl DECIMAL(20,8) DEFAULT 0.00,
    margin_type VARCHAR(20),
    isolated_wallet DECIMAL(20,8),
    position_side VARCHAR(10),
    event_reason VARCHAR(50),
    webhook_data_raw JSONB,
    last_update TIMESTAMPTZ
);
COMMENT ON COLUMN posicoes.breakeven_price IS 'Breakeven Price (bep)';
COMMENT ON COLUMN posicoes.accumulated_realized IS 'Accumulated Realized PnL (cr)';
COMMENT ON COLUMN posicoes.unrealized_pnl IS 'Unrealized PnL (up)';
COMMENT ON COLUMN posicoes.margin_type IS 'Margin Type - isolated/cross (mt)';
COMMENT ON COLUMN posicoes.isolated_wallet IS 'Isolated Wallet amount (iw)';
COMMENT ON COLUMN posicoes.position_side IS 'Position Side - LONG/SHORT/BOTH (ps)';
COMMENT ON COLUMN posicoes.event_reason IS 'Reason for update (m)';
COMMENT ON COLUMN posicoes.webhook_data_raw IS 'Raw webhook data for debugging';

CREATE TABLE IF NOT EXISTS ordens (
    id SERIAL PRIMARY KEY,
    tipo_ordem VARCHAR(50) NOT NULL,
    preco DECIMAL(20,8) NOT NULL,
    quantidade DECIMAL(20,8) NOT NULL,
    id_posicao INT,
    status VARCHAR(50) NOT NULL,
    data_hora_criacao TIMESTAMPTZ,
    id_externo VARCHAR(100),
    side VARCHAR(20),
    simbolo VARCHAR(50),
    tipo_ordem_bot VARCHAR(50),
    target INT,
    reduce_only BOOLEAN,
    close_position BOOLEAN,
    last_update TIMESTAMPTZ,
    orign_sig VARCHAR(100),
    observacao VARCHAR(255),
    preco_executado DECIMAL(20,8),
    quantidade_executada DECIMAL(20,8) DEFAULT 0.00,
    dados_originais_ws TEXT,
    conta_id INT DEFAULT 1,
    renew_sl_firs VARCHAR(20),
    renew_sl_seco VARCHAR(20),
    commission DECIMAL(20,8) DEFAULT 0.00,
    commission_asset VARCHAR(10),
    trade_id BIGINT,
    client_order_id VARCHAR(100),
    time_in_force VARCHAR(10),
    stop_price DECIMAL(20,8),
    execution_type VARCHAR(20),
    last_filled_quantity DECIMAL(20,8),
    last_filled_price DECIMAL(20,8),
    order_trade_time BIGINT,
    bids_notional DECIMAL(20,8),
    ask_notional DECIMAL(20,8),
    is_maker_side BOOLEAN,
    stop_price_working_type VARCHAR(20),
    original_order_type VARCHAR(30),
    position_side VARCHAR(10),
    activation_price DECIMAL(20,8),
    callback_rate DECIMAL(10,4),
    price_protection BOOLEAN,
    realized_profit DECIMAL(20,8),
    stp_mode VARCHAR(20),
    price_match_mode VARCHAR(20),
    gtd_auto_cancel_time BIGINT
);
COMMENT ON COLUMN ordens.client_order_id IS 'Client Order Id da Binance (o.c)';
-- ... outros comentários para ordens ...

CREATE TABLE IF NOT EXISTS monitoramento (
    id SERIAL PRIMARY KEY,
    tipo_evento VARCHAR(50) NOT NULL,
    id_ordem INT NOT NULL,
    id_posicao INT,
    mensagem TEXT,
    data_hora_evento TIMESTAMPTZ NOT NULL,
    status VARCHAR(50),
    preco DECIMAL(20,8),
    preco_corrente DECIMAL(20,8)
);

CREATE TABLE IF NOT EXISTS webhook_signals (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    timeframe VARCHAR(10),
    side VARCHAR(10) NOT NULL,
    leverage INT NOT NULL,
    capital_pct DECIMAL(5,2) NOT NULL,
    entry_price DECIMAL(20,8) NOT NULL,
    sl_price DECIMAL(20,8) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'PENDING',
    error_message TEXT,
    position_id INT,
    sl_order_id BIGINT,
    chat_id BIGINT,
    message_id BIGINT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    timeout_at TIMESTAMPTZ,
    max_lifetime_minutes INT,
    registry_message_id BIGINT,
    message_id_orig BIGINT,
    chat_id_orig_sinal BIGINT,
    tp1_price DECIMAL(20,8),
    tp2_price DECIMAL(20,8),
    tp3_price DECIMAL(20,8),
    tp4_price DECIMAL(20,8),
    tp5_price DECIMAL(20,8),
    message_source VARCHAR(50),
    divap_confirmado BOOLEAN,
    cancelado_checker BOOLEAN,
    sent_msg BOOLEAN DEFAULT false,
    conta_id INT NOT NULL
);

CREATE TABLE IF NOT EXISTS divap_analysis (
    id SERIAL PRIMARY KEY,
    signal_id INT UNIQUE,
    is_bull_divap BOOLEAN DEFAULT false,
    is_bear_divap BOOLEAN DEFAULT false,
    divap_confirmed BOOLEAN DEFAULT false,
    rsi REAL,
    volume DOUBLE PRECISION,
    volume_sma DOUBLE PRECISION,
    high_volume BOOLEAN DEFAULT false,
    bull_div BOOLEAN DEFAULT false,
    bear_div BOOLEAN DEFAULT false,
    message TEXT,
    price_reversal_up BOOLEAN DEFAULT false,
    price_reversal_down BOOLEAN DEFAULT false,
    analyzed_at TIMESTAMPTZ,
    bull_reversal_pattern BOOLEAN DEFAULT false,
    bear_reversal_pattern BOOLEAN DEFAULT false
);

CREATE TABLE IF NOT EXISTS signals_msg (
    id SERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL,
    chat_id BIGINT NOT NULL,
    text TEXT NOT NULL,
    is_reply BOOLEAN NOT NULL DEFAULT false,
    reply_to_message_id BIGINT,
    symbol VARCHAR(50),
    signal_id INT,
    created_at TIMESTAMPTZ NOT NULL,
    registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message_source VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS ordens_fechadas (
    id SERIAL PRIMARY KEY,
    id_original INT,
    tipo_ordem VARCHAR(50) NOT NULL,
    preco DECIMAL(20,8) NOT NULL,
    quantidade DECIMAL(20,8) NOT NULL,
    id_posicao INT,
    status VARCHAR(50) NOT NULL,
    data_hora_criacao TIMESTAMPTZ,
    id_externo VARCHAR(100),
    side VARCHAR(20),
    simbolo VARCHAR(50),
    tipo_ordem_bot VARCHAR(50),
    target INT,
    reduce_only BOOLEAN,
    close_position BOOLEAN,
    last_update TIMESTAMPTZ,
    renew_sl_firs VARCHAR(20),
    renew_sl_seco VARCHAR(20),
    orign_sig VARCHAR(100),
    dados_originais_ws TEXT,
    quantidade_executada DECIMAL(20,8) DEFAULT 0.00,
    preco_executado DECIMAL(20,8),
    observacao VARCHAR(255),
    id_original_ordens INT,
    conta_id INT DEFAULT 1,
    commission DECIMAL(20,8) DEFAULT 0.00,
    commission_asset VARCHAR(10),
    trade_id BIGINT,
    client_order_id VARCHAR(255),
    time_in_force VARCHAR(20),
    stop_price DECIMAL(20,8),
    execution_type VARCHAR(50),
    last_filled_quantity DECIMAL(20,8),
    last_filled_price DECIMAL(20,8),
    order_trade_time BIGINT,
    realized_profit DECIMAL(20,8),
    position_side VARCHAR(20)
);

CREATE TABLE IF NOT EXISTS posicoes_fechadas (
    id SERIAL PRIMARY KEY,
    id_original INT,
    simbolo VARCHAR(50) NOT NULL,
    quantidade DECIMAL(20,8) NOT NULL,
    preco_medio DECIMAL(20,8) NOT NULL,
    status VARCHAR(50) NOT NULL,
    data_hora_abertura TIMESTAMPTZ NOT NULL,
    data_hora_fechamento TIMESTAMPTZ,
    motivo_fechamento TEXT,
    side VARCHAR(20),
    leverage INT,
    data_hora_ultima_atualizacao TIMESTAMPTZ,
    preco_entrada DECIMAL(20,8),
    preco_corrente DECIMAL(20,8),
    orign_sig VARCHAR(100),
    conta_id INT DEFAULT 1,
    quantidade_aberta DECIMAL(20,8),
    trailing_stop_level VARCHAR(20) DEFAULT 'ORIGINAL',
    pnl_corrente DECIMAL(20,8) DEFAULT 0.00,
    breakeven_price DECIMAL(20,8),
    accumulated_realized DECIMAL(20,8),
    unrealized_pnl DECIMAL(20,8),
    total_realized DECIMAL(20,8) DEFAULT 0.00,
    total_commission DECIMAL(20,8) DEFAULT 0.00,
    liquid_pnl DECIMAL(20,8) DEFAULT 0.00,
    margin_type VARCHAR(20),
    isolated_wallet DECIMAL(20,8),
    position_side VARCHAR(20),
    event_reason VARCHAR(50),
    webhook_data_raw TEXT,
    observacoes TEXT,
    last_update TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS logs (
    id SERIAL PRIMARY KEY,
    modulo VARCHAR(50),
    nivel VARCHAR(20) NOT NULL,
    mensagem TEXT NOT NULL,
    contexto VARCHAR(255),
    data_hora TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    conta_id INT
);
COMMENT ON COLUMN logs.modulo IS 'Módulo que gerou o log (ex: webhook, monitoramento)';

CREATE TABLE IF NOT EXISTS signals_backtest (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(32) NOT NULL,
    side VARCHAR(16) NOT NULL,
    leverage INT,
    capital_pct DECIMAL(8,4),
    entry_price DECIMAL(18,8),
    sl_price DECIMAL(18,8),
    chat_id BIGINT,
    status VARCHAR(32),
    timeframe VARCHAR(16),
    message_id BIGINT,
    message_id_orig BIGINT,
    chat_id_orig_sinal BIGINT,
    tp1_price DECIMAL(18,8),
    tp2_price DECIMAL(18,8),
    tp3_price DECIMAL(18,8),
    tp4_price DECIMAL(18,8),
    tp5_price DECIMAL(18,8),
    message_source VARCHAR(64),
    divap_confirmado BOOLEAN,
    cancelado_checker BOOLEAN,
    error_message VARCHAR(255),
    conta_id INT,
    created_at TIMESTAMPTZ
);


-- -------------------------------------------------------------------------
-- SEÇÃO 3: CRIAÇÃO DE CHAVES ESTRANGEIRAS (FOREIGN KEYS)
-- -------------------------------------------------------------------------
-- Aplicadas após a criação de todas as tabelas para evitar erros de dependência.

ALTER TABLE contas
    ADD CONSTRAINT fk_contas_corretora FOREIGN KEY (id_corretora) REFERENCES corretoras (id) ON DELETE SET NULL ON UPDATE CASCADE,
    ADD CONSTRAINT fk_contas_users FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL;

ALTER TABLE exchange_filters
    ADD CONSTRAINT fk_exchange_filters_symbol FOREIGN KEY (symbol_id) REFERENCES exchange_symbols (id) ON DELETE CASCADE;

ALTER TABLE ordens
    ADD CONSTRAINT fk_ordens_posicoes FOREIGN KEY (id_posicao) REFERENCES posicoes (id) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE monitoramento
    ADD CONSTRAINT fk_monitoramento_ordem FOREIGN KEY (id_ordem) REFERENCES ordens (id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_monitoramento_posicao FOREIGN KEY (id_posicao) REFERENCES posicoes (id) ON DELETE SET NULL;

ALTER TABLE webhook_signals
    ADD CONSTRAINT fk_webhook_signals_posicao FOREIGN KEY (position_id) REFERENCES posicoes (id) ON DELETE SET NULL;

ALTER TABLE signals_msg
    ADD CONSTRAINT fk_signals_msg_signal FOREIGN KEY (signal_id) REFERENCES webhook_signals (id) ON DELETE SET NULL;

-- -------------------------------------------------------------------------
-- SEÇÃO 4: APLICAÇÃO DOS GATILHOS DE ATUALIZAÇÃO
-- -------------------------------------------------------------------------

CREATE TRIGGER set_timestamp_users
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_corretoras
BEFORE UPDATE ON corretoras
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_contas
BEFORE UPDATE ON contas
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_exchange_symbols
BEFORE UPDATE ON exchange_symbols
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_posicoes
BEFORE UPDATE ON posicoes
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_webhook_signals
BEFORE UPDATE ON webhook_signals
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

CREATE TRIGGER set_timestamp_ordens
BEFORE UPDATE ON ordens
FOR EACH ROW
EXECUTE FUNCTION update_timestamp_column();

-- -------------------------------------------------------------------------
-- SEÇÃO 5: CRIAÇÃO DOS ÍNDICES DE OTIMIZAÇÃO
-- -------------------------------------------------------------------------
-- Baseado no seu arquivo database_indexes_optimization.sql

-- Tabela 'posicoes'
CREATE INDEX IF NOT EXISTS idx_posicoes_simbolo_status_conta_id ON posicoes (simbolo, status, conta_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_posicoes_status_conta_simbolo ON posicoes (status, conta_id, simbolo);
CREATE INDEX IF NOT EXISTS idx_posicoes_open_optimized ON posicoes (status, conta_id, data_hora_abertura);
CREATE INDEX IF NOT EXISTS idx_posicoes_data_abertura ON posicoes (data_hora_abertura);
CREATE INDEX IF NOT EXISTS idx_posicoes_side_leverage ON posicoes (side, leverage);
CREATE INDEX IF NOT EXISTS idx_posicoes_data_atualizacao ON posicoes (data_hora_ultima_atualizacao);
CREATE INDEX IF NOT EXISTS idx_posicoes_origem_signal ON posicoes (orign_sig, conta_id, status);

-- Tabela 'ordens'
CREATE INDEX IF NOT EXISTS idx_ordens_origin_signal_critical ON ordens (orign_sig, status, conta_id, id_externo);
CREATE INDEX IF NOT EXISTS idx_ordens_conta_status_simbolo ON ordens (conta_id, status, simbolo, data_hora_criacao);
CREATE INDEX IF NOT EXISTS idx_ordens_id_externo_conta ON ordens (id_externo, conta_id, status);
CREATE INDEX IF NOT EXISTS idx_ordens_tipo_status_conta ON ordens (tipo_ordem_bot, status, conta_id);
CREATE INDEX IF NOT EXISTS idx_ordens_reduce_only_critical ON ordens (reduce_only, status, simbolo, conta_id);
CREATE INDEX IF NOT EXISTS idx_ordens_client_order_id ON ordens (client_order_id);
CREATE INDEX IF NOT EXISTS idx_ordens_posicao_status ON ordens (id_posicao, status);
CREATE INDEX IF NOT EXISTS idx_ordens_data_criacao ON ordens (data_hora_criacao);
CREATE INDEX IF NOT EXISTS idx_ordens_target_simbolo ON ordens (target, simbolo, conta_id);
CREATE INDEX IF NOT EXISTS idx_ordens_pending_critical ON ordens (conta_id, status, simbolo, data_hora_criacao);

-- Tabela 'webhook_signals'
CREATE INDEX IF NOT EXISTS idx_webhook_signals_position_linking ON webhook_signals (position_id, conta_id, status, symbol);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_unlinked ON webhook_signals (position_id, conta_id, symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_active_status ON webhook_signals (status, conta_id, symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_timeout ON webhook_signals (timeout_at, status, conta_id);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_telegram ON webhook_signals (chat_id, message_id, message_id_orig);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_timeframe_side ON webhook_signals (timeframe, side, status, conta_id);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_created_at ON webhook_signals (created_at);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_cleanup ON webhook_signals (status, updated_at, conta_id);
CREATE INDEX IF NOT EXISTS idx_webhook_signals_divap ON webhook_signals (divap_confirmado, cancelado_checker, symbol);

-- Tabela 'contas'
CREATE INDEX IF NOT EXISTS idx_contas_id_ativa ON contas (id, ativa);
CREATE INDEX IF NOT EXISTS idx_contas_ativa ON contas (ativa);
CREATE INDEX IF NOT EXISTS idx_contas_corretora_ativa ON contas (id_corretora, ativa);
CREATE INDEX IF NOT EXISTS idx_contas_user_ativa ON contas (user_id, ativa);

-- Tabelas de Exchange
CREATE INDEX IF NOT EXISTS idx_exchange_symbols_status_exchange ON exchange_symbols (status, exchange);
CREATE INDEX IF NOT EXISTS idx_exchange_symbols_assets ON exchange_symbols (base_asset, quote_asset);
CREATE INDEX IF NOT EXISTS idx_leverage_brackets_symbol_corretora ON exchange_leverage_brackets (symbol, corretora, updated_at);
CREATE INDEX IF NOT EXISTS idx_leverage_brackets_initial ON exchange_leverage_brackets (initial_leverage, symbol);

-- Tabelas de Log e Monitoramento
CREATE INDEX IF NOT EXISTS idx_logs_data_nivel ON logs (data_hora, nivel);
CREATE INDEX IF NOT EXISTS idx_logs_modulo_conta ON logs (modulo, conta_id, data_hora);
CREATE INDEX IF NOT EXISTS idx_logs_conta_id ON logs (conta_id, data_hora);
CREATE INDEX IF NOT EXISTS idx_monitoramento_evento_data ON monitoramento (tipo_evento, data_hora_evento);
CREATE INDEX IF NOT EXISTS idx_monitoramento_ordem_posicao ON monitoramento (id_ordem, id_posicao);

-- Tabelas Históricas
CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_simbolo_data ON ordens_fechadas (simbolo, data_hora_criacao);
CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_status_conta ON ordens_fechadas (status, conta_id);
CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_id_original ON ordens_fechadas (id_original, id_original_ordens);
CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_simbolo_data ON posicoes_fechadas (simbolo, data_hora_fechamento);
CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_pnl ON posicoes_fechadas (liquid_pnl, data_hora_fechamento);
CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_id_original ON posicoes_fechadas (id_original);

-- Tabelas de Análise
CREATE INDEX IF NOT EXISTS idx_divap_analysis_confirmed ON divap_analysis (divap_confirmed, analyzed_at);
CREATE INDEX IF NOT EXISTS idx_divap_analysis_patterns ON divap_analysis (bull_reversal_pattern, bear_reversal_pattern);
CREATE INDEX IF NOT EXISTS idx_divap_analysis_signal ON divap_analysis (signal_id);
CREATE INDEX IF NOT EXISTS idx_signals_msg_chat_date ON signals_msg (chat_id, created_at);
CREATE INDEX IF NOT EXISTS idx_signals_msg_reply_chain ON signals_msg (reply_to_message_id, message_id);
CREATE INDEX IF NOT EXISTS idx_signals_msg_symbol ON signals_msg (symbol, signal_id);

-- Índices Compostos Avançados
CREATE INDEX IF NOT EXISTS idx_critical_position_signal_join ON posicoes (status, conta_id, id);
CREATE INDEX IF NOT EXISTS idx_critical_webhook_signal_join ON webhook_signals (position_id, conta_id);
CREATE INDEX IF NOT EXISTS idx_critical_sync_positions ON posicoes (conta_id, simbolo, status, data_hora_ultima_atualizacao);
CREATE INDEX IF NOT EXISTS idx_critical_distinct_symbols ON posicoes (conta_id, simbolo);

-- -------------------------------------------------------------------------
-- SEÇÃO 6: ANÁLISE DAS TABELAS
-- -------------------------------------------------------------------------
-- Atualiza as estatísticas para que o planejador de consultas do PostgreSQL
-- possa usar os novos índices de forma eficiente.

ANALYZE users;
ANALYZE corretoras;
ANALYZE contas;
ANALYZE configuracoes;
ANALYZE exchange_symbols;
ANALYZE exchange_filters;
ANALYZE exchange_leverage_brackets;
ANALYZE posicoes;
ANALYZE ordens;
ANALYZE monitoramento;
ANALYZE webhook_signals;
ANALYZE divap_analysis;
ANALYZE signals_msg;
ANALYZE ordens_fechadas;
ANALYZE posicoes_fechadas;
ANALYZE logs;
ANALYZE signals_backtest;

-- Confirma todas as alterações da transação
COMMIT;