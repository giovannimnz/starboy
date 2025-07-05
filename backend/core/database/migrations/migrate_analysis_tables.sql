-- =========================================================================
-- SCRIPT DE MIGRAÇÃO - REESTRUTURAÇÃO DAS TABELAS DE ANÁLISE
-- =========================================================================
-- Este script migra os dados de divap_analysis para signals_analysis
-- e renomeia signals_backtest para backtest_signals
-- Também cria a nova tabela backtest_results
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- PARTE 1: CRIAR NOVA TABELA signals_analysis
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS signals_analysis (
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
    bear_reversal_pattern BOOLEAN DEFAULT false,
    analysis_type VARCHAR(20) DEFAULT 'trade'
);

-- -------------------------------------------------------------------------
-- PARTE 2: MIGRAR DADOS DA TABELA ANTIGA PARA A NOVA
-- -------------------------------------------------------------------------

-- Verificar se a tabela divap_analysis existe antes de migrar
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'divap_analysis') THEN
        -- Migrar dados existentes
        INSERT INTO signals_analysis (
            signal_id, is_bull_divap, is_bear_divap, divap_confirmed, rsi, volume, 
            volume_sma, high_volume, bull_div, bear_div, message, price_reversal_up, 
            price_reversal_down, analyzed_at, bull_reversal_pattern, bear_reversal_pattern, 
            analysis_type
        )
        SELECT 
            signal_id, is_bull_divap, is_bear_divap, divap_confirmed, rsi, volume, 
            volume_sma, high_volume, bull_div, bear_div, message, price_reversal_up, 
            price_reversal_down, analyzed_at, bull_reversal_pattern, bear_reversal_pattern,
            'trade' as analysis_type
        FROM divap_analysis
        ON CONFLICT (signal_id) DO NOTHING;
        
        RAISE NOTICE 'Dados migrados de divap_analysis para signals_analysis';
    ELSE
        RAISE NOTICE 'Tabela divap_analysis não encontrada, pulando migração';
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- PARTE 3: RENOMEAR TABELA signals_backtest PARA backtest_signals
-- -------------------------------------------------------------------------

-- Verificar se a tabela signals_backtest existe antes de renomear
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'signals_backtest') THEN
        -- Renomear tabela
        ALTER TABLE signals_backtest RENAME TO backtest_signals;
        RAISE NOTICE 'Tabela signals_backtest renomeada para backtest_signals';
    ELSE
        RAISE NOTICE 'Tabela signals_backtest não encontrada, criando backtest_signals';
        -- Criar a tabela se não existir
        CREATE TABLE IF NOT EXISTS backtest_signals (
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
    END IF;
END $$;

-- -------------------------------------------------------------------------
-- PARTE 4: CRIAR NOVA TABELA backtest_results
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS backtest_results (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(50) NOT NULL,
    total_pnl DECIMAL(20,8),
    trade_time BIGINT,
    open_datetime TIMESTAMPTZ,
    close_datetime TIMESTAMPTZ,
    base_fee DECIMAL(20,8),
    total_profit DECIMAL(20,8),
    total_fee DECIMAL(20,8),
    tp1_profit DECIMAL(20,8),
    tp1_fee DECIMAL(20,8),
    tp2_profit DECIMAL(20,8),
    tp2_fee DECIMAL(20,8),
    tp3_profit DECIMAL(20,8),
    tp3_fee DECIMAL(20,8),
    tp4_profit DECIMAL(20,8),
    tp4_fee DECIMAL(20,8),
    tp5_profit DECIMAL(20,8),
    tp5_fee DECIMAL(20,8),
    sl_profit DECIMAL(20,8),
    sl_fee DECIMAL(20,8),
    third_to_last_tp DECIMAL(20,8),
    last_tp DECIMAL(20,8),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------------------
-- PARTE 5: CRIAR ÍNDICES OTIMIZADOS
-- -------------------------------------------------------------------------

-- Índices para signals_analysis
CREATE INDEX IF NOT EXISTS idx_signals_analysis_confirmed ON signals_analysis (divap_confirmed, analyzed_at);
CREATE INDEX IF NOT EXISTS idx_signals_analysis_patterns ON signals_analysis (bull_reversal_pattern, bear_reversal_pattern);
CREATE INDEX IF NOT EXISTS idx_signals_analysis_signal ON signals_analysis (signal_id);
CREATE INDEX IF NOT EXISTS idx_signals_analysis_type ON signals_analysis (analysis_type, analyzed_at);

-- Índices para backtest_signals
CREATE INDEX IF NOT EXISTS idx_backtest_signals_symbol ON backtest_signals (symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_backtest_signals_status ON backtest_signals (status, created_at);

-- Índices para backtest_results
CREATE INDEX IF NOT EXISTS idx_backtest_results_symbol ON backtest_results (symbol, created_at);
CREATE INDEX IF NOT EXISTS idx_backtest_results_pnl ON backtest_results (total_pnl, symbol);

-- -------------------------------------------------------------------------
-- PARTE 6: ATUALIZAR ESTATÍSTICAS
-- -------------------------------------------------------------------------

ANALYZE signals_analysis;
ANALYZE backtest_signals;
ANALYZE backtest_results;

COMMIT;

-- =========================================================================
-- RELATÓRIO DE MIGRAÇÃO
-- =========================================================================

DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'MIGRAÇÃO CONCLUÍDA COM SUCESSO!';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Tabelas criadas/atualizadas:';
    RAISE NOTICE '- signals_analysis (nova estrutura)';
    RAISE NOTICE '- backtest_signals (renomeada)';
    RAISE NOTICE '- backtest_results (nova tabela)';
    RAISE NOTICE '========================================';
END $$;
