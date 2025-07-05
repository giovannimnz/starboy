-- =========================================================================
-- SCRIPT DE ATUALIZAÇÃO DAS TABELAS DE ANÁLISE
-- =========================================================================
-- Adiciona as colunas necessárias e ajusta as estruturas
-- =========================================================================

BEGIN;

-- Adicionar colunas que faltam na tabela backtest_signals
ALTER TABLE backtest_signals ADD COLUMN IF NOT EXISTS divap_confirmado BOOLEAN DEFAULT false;
ALTER TABLE backtest_signals ADD COLUMN IF NOT EXISTS cancelado_checker BOOLEAN DEFAULT false;

-- Adicionar colunas que faltam na tabela backtest_results
ALTER TABLE backtest_results ADD COLUMN IF NOT EXISTS strategy VARCHAR(100);

-- Atualizar comentários
COMMENT ON COLUMN backtest_signals.signal_datetime IS 'Data e hora do sinal original (mensagem do Telegram)';
COMMENT ON COLUMN backtest_signals.created_at IS 'Data e hora de criação do registro na tabela';
COMMENT ON COLUMN backtest_signals.divap_confirmado IS 'Se foi confirmado como padrão DIVAP';
COMMENT ON COLUMN backtest_signals.cancelado_checker IS 'Se foi cancelado pela verificação';

COMMENT ON COLUMN backtest_results.strategy IS 'Estratégia utilizada no backtest';
COMMENT ON COLUMN backtest_results.initial_capital IS 'Capital inicial da operação';
COMMENT ON COLUMN backtest_results.final_capital IS 'Capital final após a operação';
COMMENT ON COLUMN backtest_results.entry_price IS 'Preço de entrada da operação';
COMMENT ON COLUMN backtest_results.entry_fee IS 'Taxa de entrada da operação';

COMMIT;

-- Atualizar estatísticas
ANALYZE backtest_signals;
ANALYZE backtest_results;

SELECT 'Atualização das tabelas concluída com sucesso!' as resultado;
