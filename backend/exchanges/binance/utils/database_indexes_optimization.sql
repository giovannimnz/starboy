-- =====================================================================
-- SCRIPT DE OTIMIZAÇÃO DE ÍNDICES DO BANCO DE DADOS STARBOY
-- =====================================================================
-- Data: 3 de julho de 2025
-- Objetivo: Reduzir travamentos (lock wait timeout, deadlock) e acelerar 
--           leituras/escritas através de índices otimizados baseados na
--           análise detalhada do código backend
-- 
-- INSTRUÇÕES:
-- 1. Execute este script em ambiente de TESTE primeiro
-- 2. Monitore performance e locks após aplicação
-- 3. Aplique em produção durante janela de manutenção
-- 4. Use EXPLAIN nas queries principais após aplicação
-- =====================================================================

-- Verificar se os índices já existem antes de criar
-- (Para evitar erros se o script for executado novamente)

-- =====================================================================
-- TABELA: ordens (PRIORIDADE MÁXIMA - Mais crítica)
-- =====================================================================
-- Queries mais frequentes identificadas no código:
-- - SELECT * FROM ordens WHERE id_externo = ? AND simbolo = ? AND conta_id = ?
-- - SELECT * FROM ordens WHERE id_externo = ? AND conta_id = ?
-- - SELECT * FROM ordens WHERE id_posicao = ? AND conta_id = ?
-- - SELECT * FROM ordens WHERE status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = ?
-- - SELECT * FROM ordens WHERE simbolo = ? AND status = ? AND conta_id = ?
-- - UPDATE ordens SET ... WHERE id_externo = ? AND conta_id = ?
-- - DELETE FROM ordens WHERE id_externo = ? AND conta_id = ?

-- PRIORIDADE ALTA: Combinações mais usadas em operações críticas
DROP INDEX IF EXISTS idx_ordens_id_externo_conta_id ON ordens;
CREATE INDEX idx_ordens_id_externo_conta_id ON ordens (id_externo, conta_id);

DROP INDEX IF EXISTS idx_ordens_id_externo_simbolo_conta_id ON ordens;
CREATE INDEX idx_ordens_id_externo_simbolo_conta_id ON ordens (id_externo, simbolo, conta_id);

DROP INDEX IF EXISTS idx_ordens_id_posicao_conta_id ON ordens;
CREATE INDEX idx_ordens_id_posicao_conta_id ON ordens (id_posicao, conta_id);

-- PRIORIDADE MÉDIA: Para sincronização e monitoramento
DROP INDEX IF EXISTS idx_ordens_status_conta_id ON ordens;
CREATE INDEX idx_ordens_status_conta_id ON ordens (status, conta_id);

DROP INDEX IF EXISTS idx_ordens_simbolo_conta_id ON ordens;
CREATE INDEX idx_ordens_simbolo_conta_id ON ordens (simbolo, conta_id);

DROP INDEX IF EXISTS idx_ordens_simbolo_status_conta_id ON ordens;
CREATE INDEX idx_ordens_simbolo_status_conta_id ON ordens (simbolo, status, conta_id);

-- PRIORIDADE BAIXA: Para estratégias específicas
DROP INDEX IF EXISTS idx_ordens_orign_sig_status_conta_id ON ordens;
CREATE INDEX idx_ordens_orign_sig_status_conta_id ON ordens (orign_sig, status, conta_id);

-- Para ordenação temporal (usado em cleanup)
DROP INDEX IF EXISTS idx_ordens_last_update ON ordens;
CREATE INDEX idx_ordens_last_update ON ordens (last_update);

-- =====================================================================
-- TABELA: ordens_fechadas (para histórico)
-- =====================================================================
-- Queries identificadas:
-- - SELECT id FROM ordens_fechadas WHERE id_externo = ? AND conta_id = ?
-- - SELECT * FROM ordens_fechadas WHERE id_posicao = ? AND conta_id = ?

DROP INDEX IF EXISTS idx_ordens_fechadas_id_externo_conta_id ON ordens_fechadas;
CREATE INDEX idx_ordens_fechadas_id_externo_conta_id ON ordens_fechadas (id_externo, conta_id);

DROP INDEX IF EXISTS idx_ordens_fechadas_id_posicao_conta_id ON ordens_fechadas;
CREATE INDEX idx_ordens_fechadas_id_posicao_conta_id ON ordens_fechadas (id_posicao, conta_id);

DROP INDEX IF EXISTS idx_ordens_fechadas_simbolo_conta_id ON ordens_fechadas;
CREATE INDEX idx_ordens_fechadas_simbolo_conta_id ON ordens_fechadas (simbolo, conta_id);

-- =====================================================================
-- TABELA: posicoes (PRIORIDADE ALTA)
-- =====================================================================
-- Queries mais frequentes identificadas:
-- - SELECT * FROM posicoes WHERE status = 'OPEN' AND conta_id = ?
-- - SELECT * FROM posicoes WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ?
-- - SELECT * FROM posicoes WHERE simbolo = ? AND conta_id = ?
-- - SELECT * FROM posicoes WHERE id = ? AND conta_id = ?
-- - SELECT DISTINCT simbolo FROM posicoes WHERE conta_id = ?

-- PRIORIDADE ALTA: Combinações críticas para performance
DROP INDEX IF EXISTS idx_posicoes_status_conta_id ON posicoes;
CREATE INDEX idx_posicoes_status_conta_id ON posicoes (status, conta_id);

DROP INDEX IF EXISTS idx_posicoes_simbolo_status_conta_id ON posicoes;
CREATE INDEX idx_posicoes_simbolo_status_conta_id ON posicoes (simbolo, status, conta_id);

DROP INDEX IF EXISTS idx_posicoes_simbolo_conta_id ON posicoes;
CREATE INDEX idx_posicoes_simbolo_conta_id ON posicoes (simbolo, conta_id);

-- PRIORIDADE MÉDIA: Para operações de atualização
DROP INDEX IF EXISTS idx_posicoes_id_conta_id ON posicoes;
CREATE INDEX idx_posicoes_id_conta_id ON posicoes (id, conta_id);

-- Para ordenação temporal (usado em relatórios)
DROP INDEX IF EXISTS idx_posicoes_data_abertura ON posicoes;
CREATE INDEX idx_posicoes_data_abertura ON posicoes (data_hora_abertura);

DROP INDEX IF EXISTS idx_posicoes_last_update ON posicoes;
-- =====================================================================
-- TABELA: posicoes_fechadas (para histórico)
-- =====================================================================
-- Queries identificadas:
-- - SELECT * FROM posicoes_fechadas WHERE id_original = ? AND conta_id = ?
-- - SELECT * FROM posicoes_fechadas WHERE simbolo = ? AND conta_id = ?

DROP INDEX IF EXISTS idx_posicoes_fechadas_id_original_conta_id ON posicoes_fechadas;
CREATE INDEX idx_posicoes_fechadas_id_original_conta_id ON posicoes_fechadas (id_original, conta_id);

DROP INDEX IF EXISTS idx_posicoes_fechadas_simbolo_conta_id ON posicoes_fechadas;
CREATE INDEX idx_posicoes_fechadas_simbolo_conta_id ON posicoes_fechadas (simbolo, conta_id);

-- =====================================================================
-- TABELA: webhook_signals (PRIORIDADE ALTA)
-- =====================================================================
-- Queries mais frequentes identificadas:
-- - SELECT tp1_price, tp3_price, entry_price, sl_price, symbol, side FROM webhook_signals WHERE position_id = ? ORDER BY created_at DESC LIMIT 1
-- - SELECT message_source FROM webhook_signals WHERE symbol = ? AND conta_id = ? ORDER BY created_at DESC LIMIT 1
-- - SELECT * FROM webhook_signals WHERE symbol = ? AND conta_id = ? AND status = 'EXECUTADO' AND (position_id IS NULL OR position_id = 0) ORDER BY created_at DESC LIMIT 1
-- - SELECT * FROM webhook_signals WHERE symbol = ? AND conta_id = ? AND (position_id IS NULL OR position_id = 0) ORDER BY created_at DESC LIMIT 5

-- PRIORIDADE ALTA: Queries críticas para trailing stop e vinculação
DROP INDEX IF EXISTS idx_webhook_signals_position_id_created_at ON webhook_signals;
CREATE INDEX idx_webhook_signals_position_id_created_at ON webhook_signals (position_id, created_at DESC);

DROP INDEX IF EXISTS idx_webhook_signals_symbol_conta_id_created_at ON webhook_signals;
CREATE INDEX idx_webhook_signals_symbol_conta_id_created_at ON webhook_signals (symbol, conta_id, created_at DESC);

DROP INDEX IF EXISTS idx_webhook_signals_symbol_conta_id_status_position_id ON webhook_signals;
CREATE INDEX idx_webhook_signals_symbol_conta_id_status_position_id ON webhook_signals (symbol, conta_id, status, position_id);

-- PRIORIDADE MÉDIA: Para processamento geral
DROP INDEX IF EXISTS idx_webhook_signals_status_conta_id ON webhook_signals;
CREATE INDEX idx_webhook_signals_status_conta_id ON webhook_signals (status, conta_id);

-- Para timeout e expiração (usado em cleanup)
DROP INDEX IF EXISTS idx_webhook_signals_timeout_at ON webhook_signals;
CREATE INDEX idx_webhook_signals_timeout_at ON webhook_signals (timeout_at);

-- =====================================================================
-- TABELA: contas (PRIORIDADE MÉDIA)
-- =====================================================================
-- Queries identificadas:
-- - SELECT * FROM contas WHERE id = ? (autenticação)
-- - SELECT * FROM contas WHERE ativa = 1 (contas ativas)

-- PRIORIDADE ALTA: Essencial para autenticação (já coberto por PRIMARY KEY)
-- DROP INDEX IF EXISTS idx_contas_id ON contas;
-- CREATE INDEX idx_contas_id ON contas (id);

DROP INDEX IF EXISTS idx_contas_ativa ON contas;
CREATE INDEX idx_contas_ativa ON contas (ativa);

-- =====================================================================
-- TABELA: exchange_symbols (PRIORIDADE BAIXA)
-- =====================================================================
-- Queries identificadas:
-- - SELECT * FROM exchange_symbols WHERE symbol = ? AND exchange = ?
-- - SELECT * FROM exchange_symbols WHERE status = 'TRADING'

DROP INDEX IF EXISTS idx_exchange_symbols_symbol_exchange ON exchange_symbols;
CREATE INDEX idx_exchange_symbols_symbol_exchange ON exchange_symbols (symbol, exchange);

DROP INDEX IF EXISTS idx_exchange_symbols_status ON exchange_symbols;
CREATE INDEX idx_exchange_symbols_status ON exchange_symbols (status);

-- =====================================================================
-- TABELA: exchange_filters (PRIORIDADE BAIXA)
-- =====================================================================
-- Queries identificadas:
-- - SELECT * FROM exchange_filters WHERE symbol_id = ? AND filter_type = ?

DROP INDEX IF EXISTS idx_exchange_filters_symbol_id_filter_type ON exchange_filters;
CREATE INDEX idx_exchange_filters_symbol_id_filter_type ON exchange_filters (symbol_id, filter_type);

-- =====================================================================
-- TABELA: exchange_leverage_brackets (PRIORIDADE BAIXA)
-- =====================================================================
-- Queries identificadas:
-- - SELECT * FROM exchange_leverage_brackets WHERE symbol = ? AND corretora = ?

DROP INDEX IF EXISTS idx_exchange_leverage_brackets_symbol_corretora ON exchange_leverage_brackets;
CREATE INDEX idx_exchange_leverage_brackets_symbol_corretora ON exchange_leverage_brackets (symbol, corretora);

-- =====================================================================
-- VERIFICAÇÕES E COMANDOS ÚTEIS
-- =====================================================================

-- Verificar se todos os índices foram criados
SELECT 
    TABLE_NAME,
    INDEX_NAME,
    COLUMN_NAME,
    SEQ_IN_INDEX,
    CARDINALITY
FROM INFORMATION_SCHEMA.STATISTICS 
WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('ordens', 'ordens_fechadas', 'posicoes', 'posicoes_fechadas', 'webhook_signals', 'contas', 'exchange_symbols', 'exchange_filters', 'exchange_leverage_brackets')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- Verificar tamanho dos índices
SELECT 
    TABLE_NAME,
    INDEX_NAME,
    ROUND(STAT_VALUE * @@innodb_page_size / 1024 / 1024, 2) AS 'Size_MB'
FROM INFORMATION_SCHEMA.INNODB_SYS_TABLESTATS 
WHERE TABLE_NAME LIKE '%ordens%' OR TABLE_NAME LIKE '%posicoes%' OR TABLE_NAME LIKE '%webhook_signals%';

-- =====================================================================
-- COMANDOS PARA MANUTENÇÃO DOS ÍNDICES
-- =====================================================================

-- Analisar fragmentação dos índices (executar periodicamente)
-- ANALYZE TABLE ordens, ordens_fechadas, posicoes, posicoes_fechadas, webhook_signals;

-- Otimizar tabelas se necessário (usar com cuidado em produção)
-- OPTIMIZE TABLE ordens, ordens_fechadas, posicoes, posicoes_fechadas, webhook_signals;

-- Verificar uso dos índices (após aplicação)
-- SELECT * FROM INFORMATION_SCHEMA.INDEX_STATISTICS WHERE TABLE_SCHEMA = DATABASE();

-- =====================================================================
-- MONITORAMENTO DE PERFORMANCE
-- =====================================================================

-- Verificar slow queries após aplicação dos índices
-- SET GLOBAL slow_query_log = 'ON';
-- SET GLOBAL long_query_time = 1; -- queries > 1 segundo
-- SHOW VARIABLES LIKE 'slow_query_log_file';

-- Monitorar locks e deadlocks
-- SHOW ENGINE INNODB STATUS;
-- SELECT * FROM INFORMATION_SCHEMA.INNODB_LOCKS;
-- SELECT * FROM INFORMATION_SCHEMA.INNODB_LOCK_WAITS;

-- =====================================================================
-- QUERIES PARA TESTAR PERFORMANCE DOS ÍNDICES
-- =====================================================================

-- Testar índices das ordens (substitua ? pelos valores reais)
-- EXPLAIN SELECT * FROM ordens WHERE id_externo = '12345' AND conta_id = 1;
-- EXPLAIN SELECT * FROM ordens WHERE id_externo = '12345' AND simbolo = 'BTCUSDT' AND conta_id = 1;
-- EXPLAIN SELECT * FROM ordens WHERE id_posicao = 123 AND conta_id = 1;
-- EXPLAIN SELECT * FROM ordens WHERE status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = 1;

-- Testar índices das posições
-- EXPLAIN SELECT * FROM posicoes WHERE status = 'OPEN' AND conta_id = 1;
-- EXPLAIN SELECT * FROM posicoes WHERE simbolo = 'BTCUSDT' AND status = 'OPEN' AND conta_id = 1;
-- EXPLAIN SELECT DISTINCT simbolo FROM posicoes WHERE conta_id = 1;

-- Testar índices dos sinais
-- EXPLAIN SELECT tp1_price, tp3_price, entry_price, sl_price, symbol, side FROM webhook_signals WHERE position_id = 123 ORDER BY created_at DESC LIMIT 1;
-- EXPLAIN SELECT message_source FROM webhook_signals WHERE symbol = 'BTCUSDT' AND conta_id = 1 ORDER BY created_at DESC LIMIT 1;

-- =====================================================================
-- NOTAS IMPORTANTES
-- =====================================================================
-- 
-- 1. PRIORIDADE DE APLICAÇÃO:
--    - Primeiro: ordens (mais crítica, muitos locks)
--    - Segundo: posicoes (sincronização e trailing stop)
--    - Terceiro: webhook_signals (processamento de sinais)
--    - Quarto: demais tabelas
--
-- 2. IMPACTO ESPERADO:
--    - Redução de 60-80% no tempo de queries de busca
--    - Diminuição significativa de lock wait timeout
--    - Redução de deadlocks em operações concorrentes
--    - Melhoria na performance de sincronização
--
-- 3. CUIDADOS:
--    - Índices aumentam o uso de espaço em disco
--    - Podem tornar INSERTs/UPDATEs ligeiramente mais lentos
--    - Monitorar uso de memória após aplicação
--    - Criar índices em horários de baixo movimento
--
-- 4. QUERIES CRÍTICAS IDENTIFICADAS NO CÓDIGO:
--    - Handler de ordens: busca por id_externo + conta_id
--    - Sincronização: busca por simbolo + status + conta_id
--    - Trailing stop: busca por position_id + created_at DESC
--    - Cleanup: busca por id_posicao + conta_id
--    - Vinculação: busca por symbol + conta_id + status
--
-- 5. PRÓXIMOS PASSOS:
--    - Aplicar em ambiente de teste
--    - Monitorar performance por 24-48h
--    - Usar EXPLAIN nas queries principais
--    - Ajustar conforme necessário
--    - Aplicar em produção
-- =====================================================================
