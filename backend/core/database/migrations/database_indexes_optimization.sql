-- =========================================================================
-- SCRIPT DE OTIMIZAÇÃO DE ÍNDICES - STARBOY TRADING SYSTEM
-- =========================================================================
-- Data de Criação: Janeiro 2025
-- Última Atualização: Baseado na análise completa do código e padrões de consulta
-- Objetivo: Otimizar performance das consultas mais frequentes do sistema
-- 
-- INSTRUÇÕES DE USO:
-- 1. Faça backup da base de dados antes de aplicar
-- 2. Execute este script em ambiente de desenvolvimento primeiro
-- 3. Monitore a performance após aplicação
-- 4. Ajuste conforme necessário baseado no uso real
-- =========================================================================

-- Início da transação para aplicação atômica dos índices
START TRANSACTION;

SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0;
SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO';

-- =========================================================================
-- SEÇÃO 1: ÍNDICES PRINCIPAIS PARA TABELA 'posicoes'
-- =========================================================================
-- Esta tabela é uma das mais consultadas do sistema, especialmente para:
-- - Buscar posições abertas por conta e símbolo (reverse.js)
-- - Linking com webhook_signals (positionSync.js)
-- - Monitoramento de status de posições (orchMonitor.js)

-- CONSULTAS ANALISADAS NO CÓDIGO:
-- reverse.js:983: SELECT id FROM posicoes WHERE simbolo = ? AND status = 'OPEN' AND conta_id = ? ORDER BY id DESC LIMIT 1
-- positionSync.js:178: SELECT id, simbolo, quantidade, preco_entrada, preco_corrente, side FROM posicoes WHERE status = 'OPEN'
-- orchMonitor.js:172: SELECT id FROM posicoes WHERE status = ? AND conta_id = ?

-- Índice principal para a consulta mais crítica do sistema
CREATE INDEX IF NOT EXISTS idx_posicoes_simbolo_status_conta_id 
ON posicoes (simbolo, status, conta_id, id DESC);

-- Índice composto para consultas de posições abertas por conta
CREATE INDEX IF NOT EXISTS idx_posicoes_status_conta_simbolo 
ON posicoes (status, conta_id, simbolo);

-- Índice otimizado para posições abertas (sem filtro WHERE - MariaDB compatibility)
CREATE INDEX IF NOT EXISTS idx_posicoes_open_optimized 
ON posicoes (status, conta_id, data_hora_abertura);

-- Índice para ordenação por data de abertura (usado em relatórios e sync)
CREATE INDEX IF NOT EXISTS idx_posicoes_data_abertura 
ON posicoes (data_hora_abertura);

-- Índice para consultas por side e leverage (análise de estratégias)
CREATE INDEX IF NOT EXISTS idx_posicoes_side_leverage 
ON posicoes (side, leverage);

-- Índice para data de última atualização (usado para sincronização)
CREATE INDEX IF NOT EXISTS idx_posicoes_data_atualizacao 
ON posicoes (data_hora_ultima_atualizacao);

-- Índice para linking com webhook_signals (posições que podem receber signals)
CREATE INDEX IF NOT EXISTS idx_posicoes_origem_signal 
ON posicoes (orign_sig, conta_id, status);

-- =========================================================================
-- SEÇÃO 2: ÍNDICES PARA TABELA 'ordens'
-- =========================================================================
-- Tabela com alta frequência de inserções e consultas por:
-- - ID externo (ordem na exchange)
-- - Status das ordens
-- - Relacionamento com posições

-- CONSULTAS ANALISADAS NO CÓDIGO:
-- reverse.js:217: SELECT id_externo FROM ordens WHERE orign_sig = ? AND status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = ?
-- positionSync.js:409: SELECT id_externo, status, data_hora_criacao FROM ordens WHERE id_externo = ? AND conta_id = ?
-- positionSync.js:493: SELECT id_externo, simbolo, status, tipo_ordem_bot, data_hora_criacao FROM ordens WHERE conta_id = ?

-- Índice principal para consultas por origin signal (usado extensivamente em reverse.js)
CREATE INDEX IF NOT EXISTS idx_ordens_origin_signal_critical 
ON ordens (orign_sig, status, conta_id, id_externo);

-- Índice composto para consultas por conta e status (positionSync.js)
CREATE INDEX IF NOT EXISTS idx_ordens_conta_status_simbolo 
ON ordens (conta_id, status, simbolo, data_hora_criacao);

-- Índice para buscar ordens por ID externo e conta (callbacks da exchange)
CREATE INDEX IF NOT EXISTS idx_ordens_id_externo_conta 
ON ordens (id_externo, conta_id, status);

-- Índice para consultas por tipo de ordem e status
CREATE INDEX IF NOT EXISTS idx_ordens_tipo_status_conta 
ON ordens (tipo_ordem_bot, status, conta_id);

-- Índice para reduce_only orders (importante para fechamento de posições)
CREATE INDEX IF NOT EXISTS idx_ordens_reduce_only_critical 
ON ordens (reduce_only, status, simbolo, conta_id);

-- Índice para client_order_id (usado em callbacks da Binance)
CREATE INDEX IF NOT EXISTS idx_ordens_client_order_id 
ON ordens (client_order_id);

-- Índice para consultas por posição e status
CREATE INDEX IF NOT EXISTS idx_ordens_posicao_status 
ON ordens (id_posicao, status);

-- Índice para data de criação (cleanup e monitoring)
CREATE INDEX IF NOT EXISTS idx_ordens_data_criacao 
ON ordens (data_hora_criacao);

-- Índice para target (usado em take profits)
CREATE INDEX IF NOT EXISTS idx_ordens_target_simbolo 
ON ordens (target, simbolo, conta_id);

-- Índice para ordens pendentes (query crítica de performance)
CREATE INDEX IF NOT EXISTS idx_ordens_pending_critical 
ON ordens (conta_id, status, simbolo, data_hora_criacao);

-- =========================================================================
-- SEÇÃO 3: ÍNDICES PARA TABELA 'webhook_signals'
-- =========================================================================
-- Tabela crítica para o processamento de sinais

-- CONSULTAS ANALISADAS NO CÓDIGO:
-- positionSync.js:1040: SELECT id, symbol, side, sl_price, tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, tp_price, created_at FROM webhook_signals WHERE position_id IS NULL AND conta_id = ?
-- positionSync.js:1149: SELECT p.id, p.simbolo FROM posicoes p LEFT JOIN webhook_signals ws ON ws.position_id = p.id WHERE p.status = 'OPEN' AND p.conta_id = ? AND ws.position_id IS NULL
-- orchMonitor.js:588: SELECT symbol FROM webhook_signals WHERE status = 'AGUARDANDO_ACIONAMENTO' AND conta_id = ?

-- Índice principal para linking de sinais com posições
CREATE INDEX IF NOT EXISTS idx_webhook_signals_position_linking 
ON webhook_signals (position_id, conta_id, status, symbol);

-- Índice para consultas de sinais sem posição vinculada (query crítica)
CREATE INDEX IF NOT EXISTS idx_webhook_signals_unlinked 
ON webhook_signals (position_id, conta_id, symbol, created_at);

-- Índice para consultas de sinais ativos por conta
CREATE INDEX IF NOT EXISTS idx_webhook_signals_active_status 
ON webhook_signals (status, conta_id, symbol, created_at);

-- Índice para timeout management (expiração de sinais)
CREATE INDEX IF NOT EXISTS idx_webhook_signals_timeout 
ON webhook_signals (timeout_at, status, conta_id);

-- Índice para mensagens do Telegram
CREATE INDEX IF NOT EXISTS idx_webhook_signals_telegram 
ON webhook_signals (chat_id, message_id, message_id_orig);

-- Índice para consultas por timeframe e side (análise de padrões)
CREATE INDEX IF NOT EXISTS idx_webhook_signals_timeframe_side 
ON webhook_signals (timeframe, side, status, conta_id);

-- Índice para data de criação (ordenação temporal)
CREATE INDEX IF NOT EXISTS idx_webhook_signals_created_at 
ON webhook_signals (created_at);

-- Índice para cleanup de dados antigos (performance crítica)
CREATE INDEX IF NOT EXISTS idx_webhook_signals_cleanup 
ON webhook_signals (status, updated_at, conta_id);

-- Índice para divap analysis
CREATE INDEX IF NOT EXISTS idx_webhook_signals_divap 
ON webhook_signals (divap_confirmado, cancelado_checker, symbol);

-- =========================================================================
-- SEÇÃO 4: ÍNDICES PARA TABELA 'contas'
-- =========================================================================
-- Tabela consultada frequentemente para validação de contas ativas

-- CONSULTAS ANALISADAS NO CÓDIGO:
-- reverse.js:1616: SELECT saldo_base_calculo_futuros FROM contas WHERE id = ? AND ativa = 1

-- Índice principal para consultas de contas ativas por ID
CREATE INDEX IF NOT EXISTS idx_contas_id_ativa 
ON contas (id, ativa);

-- Índice para consultas por status ativo
CREATE INDEX IF NOT EXISTS idx_contas_ativa 
ON contas (ativa);

-- Índice para corretora (para consultas por exchange)
CREATE INDEX IF NOT EXISTS idx_contas_corretora_ativa 
ON contas (id_corretora, ativa);

-- Índice para usuário
CREATE INDEX IF NOT EXISTS idx_contas_user_ativa 
ON contas (user_id, ativa);

-- =========================================================================
-- SEÇÃO 5: ÍNDICES PARA TABELAS DE EXCHANGE
-- =========================================================================

-- Índices para exchange_symbols (consultado para validação de símbolos)
CREATE INDEX IF NOT EXISTS idx_exchange_symbols_status_exchange 
ON exchange_symbols (status, exchange);

-- Índice para consultas por assets
CREATE INDEX IF NOT EXISTS idx_exchange_symbols_assets 
ON exchange_symbols (base_asset, quote_asset);

-- Índice para consultas de leverage brackets
CREATE INDEX IF NOT EXISTS idx_leverage_brackets_symbol_corretora 
ON exchange_leverage_brackets (symbol, corretora, updated_at);

-- Índice para bracket inicial
CREATE INDEX IF NOT EXISTS idx_leverage_brackets_initial 
ON exchange_leverage_brackets (initial_leverage, symbol);

-- =========================================================================
-- SEÇÃO 6: ÍNDICES PARA TABELAS DE LOG E MONITORAMENTO
-- =========================================================================

-- Índices para tabela de logs (importante para debugging)
CREATE INDEX IF NOT EXISTS idx_logs_data_nivel 
ON logs (data_hora, nivel);

CREATE INDEX IF NOT EXISTS idx_logs_modulo_conta 
ON logs (modulo, conta_id, data_hora);

-- Índice para consultas por conta_id (filtros de logs por conta específica)
CREATE INDEX IF NOT EXISTS idx_logs_conta_id 
ON logs (conta_id, data_hora);

-- Índices para monitoramento
CREATE INDEX IF NOT EXISTS idx_monitoramento_evento_data 
ON monitoramento (tipo_evento, data_hora_evento);

CREATE INDEX IF NOT EXISTS idx_monitoramento_ordem_posicao 
ON monitoramento (id_ordem, id_posicao);

-- =========================================================================
-- SEÇÃO 7: ÍNDICES PARA TABELAS HISTÓRICAS
-- =========================================================================

-- Índices para ordens_fechadas (usado em relatórios)
CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_simbolo_data 
ON ordens_fechadas (simbolo, data_hora_criacao);

CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_status_conta 
ON ordens_fechadas (status, conta_id);

CREATE INDEX IF NOT EXISTS idx_ordens_fechadas_id_original 
ON ordens_fechadas (id_original, id_original_ordens);

-- Índices para posicoes_fechadas
CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_simbolo_data 
ON posicoes_fechadas (simbolo, data_hora_fechamento);

CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_pnl 
ON posicoes_fechadas (liquid_pnl, data_hora_fechamento);

CREATE INDEX IF NOT EXISTS idx_posicoes_fechadas_id_original 
ON posicoes_fechadas (id_original);

-- =========================================================================
-- SEÇÃO 8: ÍNDICES PARA TABELAS DE ANÁLISE
-- =========================================================================

-- Índices para divap_analysis
CREATE INDEX IF NOT EXISTS idx_divap_analysis_confirmed 
ON divap_analysis (divap_confirmed, analyzed_at);

CREATE INDEX IF NOT EXISTS idx_divap_analysis_patterns 
ON divap_analysis (bull_reversal_pattern, bear_reversal_pattern);

CREATE INDEX IF NOT EXISTS idx_divap_analysis_signal 
ON divap_analysis (signal_id);

-- Índices para signals_msg
CREATE INDEX IF NOT EXISTS idx_signals_msg_chat_date 
ON signals_msg (chat_id, created_at);

CREATE INDEX IF NOT EXISTS idx_signals_msg_reply_chain 
ON signals_msg (reply_to_message_id, message_id);

CREATE INDEX IF NOT EXISTS idx_signals_msg_symbol 
ON signals_msg (symbol, signal_id);

-- =========================================================================
-- SEÇÃO 9: ÍNDICES COMPOSTOS AVANÇADOS PARA PERFORMANCE CRÍTICA
-- =========================================================================

-- Índice para a query mais crítica do sistema: LEFT JOIN entre posicoes e webhook_signals
CREATE INDEX IF NOT EXISTS idx_critical_position_signal_join 
ON posicoes (status, conta_id, id);

-- Suporte ao LEFT JOIN para buscar posições sem sinais vinculados
CREATE INDEX IF NOT EXISTS idx_critical_webhook_signal_join 
ON webhook_signals (position_id, conta_id);

-- Índice para sync de posições com a exchange
CREATE INDEX IF NOT EXISTS idx_critical_sync_positions 
ON posicoes (conta_id, simbolo, status, data_hora_ultima_atualizacao);

-- Índice para buscar símbolos únicos por conta
CREATE INDEX IF NOT EXISTS idx_critical_distinct_symbols 
ON posicoes (conta_id, simbolo);

-- =========================================================================
-- SEÇÃO 10: ANÁLISE E ESTATÍSTICAS DOS ÍNDICES
-- =========================================================================

-- Atualiza as estatísticas das tabelas para otimizar o plano de execução
ANALYZE TABLE posicoes;
ANALYZE TABLE ordens;
ANALYZE TABLE webhook_signals;
ANALYZE TABLE contas;
ANALYZE TABLE exchange_symbols;
ANALYZE TABLE exchange_leverage_brackets;
ANALYZE TABLE logs;
ANALYZE TABLE monitoramento;
ANALYZE TABLE ordens_fechadas;
ANALYZE TABLE posicoes_fechadas;
ANALYZE TABLE divap_analysis;
ANALYZE TABLE signals_msg;

-- =========================================================================
-- FINALIZAÇÃO
-- =========================================================================

-- Restaura configurações originais
SET SQL_MODE=@OLD_SQL_MODE;
SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS;

-- Confirma todas as alterações
COMMIT;

-- =========================================================================
-- RELATÓRIO DE ÍNDICES APLICADOS
-- =========================================================================
SELECT 
    'OTIMIZAÇÃO DE ÍNDICES CONCLUÍDA' as status,
    NOW() as aplicado_em,
    COUNT(*) as total_indices_verificados
FROM information_schema.STATISTICS 
WHERE TABLE_SCHEMA = DATABASE();

-- =========================================================================
-- QUERIES DE VERIFICAÇÃO DE PERFORMANCE
-- =========================================================================

-- Verificar uso dos índices nas consultas mais críticas:

-- 1. Consulta crítica de posições abertas (reverse.js)
-- EXPLAIN SELECT id FROM posicoes WHERE simbolo = 'BTCUSDT' AND status = 'OPEN' AND conta_id = 1 ORDER BY id DESC LIMIT 1;

-- 2. Consulta crítica de ordens por origin signal (reverse.js)
-- EXPLAIN SELECT id_externo FROM ordens WHERE orign_sig = 'test_signal' AND status IN ('NEW', 'PARTIALLY_FILLED') AND conta_id = 1;

-- 3. Consulta crítica de LEFT JOIN (positionSync.js)
-- EXPLAIN SELECT p.id, p.simbolo FROM posicoes p LEFT JOIN webhook_signals ws ON ws.position_id = p.id WHERE p.status = 'OPEN' AND p.conta_id = 1 AND ws.position_id IS NULL;

-- 4. Consulta crítica de sinais sem posição (positionSync.js)
-- EXPLAIN SELECT id, symbol FROM webhook_signals WHERE position_id IS NULL AND conta_id = 1;

-- =========================================================================
-- MONITORAMENTO E MANUTENÇÃO
-- =========================================================================

/*
PONTOS A MONITORAR APÓS APLICAÇÃO:

1. PERFORMANCE DE QUERIES CRÍTICAS:
   - reverse.js: Busca de posições abertas por símbolo
   - positionSync.js: LEFT JOIN entre posições e sinais
   - orchMonitor.js: Consultas de sinais ativos
   - Todas as consultas com ORDER BY e LIMIT

2. USO DE ESPAÇO EM DISCO:
   - Os índices aumentarão significativamente o uso de espaço
   - Monitore especialmente as tabelas posicoes, ordens e webhook_signals
   - Configure rotação de logs e arquivamento de dados antigos

3. PERFORMANCE DE INSERÇÕES:
   - Inserções em posicoes, ordens e webhook_signals podem ficar mais lentas
   - Monitore especialmente durante alta frequência de trades
   - Considere batch inserts se necessário

4. MANUTENÇÃO PERIÓDICA:
   - Execute ANALYZE TABLE semanalmente
   - Monitore fragmentação dos índices mensalmente
   - Execute OPTIMIZE TABLE durante janelas de manutenção

5. QUERIES DE MONITORAMENTO RECOMENDADAS:
   
   -- Verificar queries lentas:
   SELECT * FROM information_schema.PROCESSLIST WHERE Command != 'Sleep' AND Time > 1;
   
   -- Verificar uso dos índices:
   SELECT TABLE_NAME, INDEX_NAME, CARDINALITY 
   FROM information_schema.STATISTICS 
   WHERE TABLE_SCHEMA = DATABASE() 
   ORDER BY TABLE_NAME, CARDINALITY DESC;
   
   -- Verificar fragmentação das tabelas:
   SHOW TABLE STATUS WHERE Name IN ('posicoes', 'ordens', 'webhook_signals');
   
   -- Verificar tamanho das tabelas e índices:
   SELECT 
       TABLE_NAME,
       ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS 'DB Size (MB)',
       ROUND((INDEX_LENGTH / 1024 / 1024), 2) AS 'Index Size (MB)'
   FROM information_schema.TABLES 
   WHERE TABLE_SCHEMA = DATABASE()
   ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC;

6. CENÁRIOS DE REMOÇÃO DE ÍNDICES:
   Se algum índice não estiver sendo usado ou causar problemas de performance:
   
   -- Verificar uso dos índices:
   SELECT OBJECT_SCHEMA, OBJECT_NAME, INDEX_NAME, COUNT_FETCH, COUNT_INSERT, COUNT_UPDATE, COUNT_DELETE
   FROM performance_schema.table_io_waits_summary_by_index_usage
   WHERE OBJECT_SCHEMA = DATABASE()
   ORDER BY COUNT_FETCH DESC;
   
   -- Remover índices não utilizados (exemplo):
   -- DROP INDEX idx_nome_do_indice ON nome_da_tabela;

7. OTIMIZAÇÕES ADICIONAIS RECOMENDADAS:
   - Considere particionamento das tabelas por data para dados históricos
   - Implemente arquivamento automático de posições e ordens fechadas
   - Configure cache de consultas para queries frequentes
   - Monitore o buffer pool do InnoDB para otimizar memória

QUERIES MAIS IMPACTADAS POR ESTES ÍNDICES:
- ✅ reverse.js linha 983: Busca de posições por símbolo + status + conta
- ✅ reverse.js linha 217: Busca de ordens por origin signal + status + conta  
- ✅ positionSync.js linha 1149: LEFT JOIN posições sem sinais vinculados
- ✅ positionSync.js linha 1040: Busca de sinais sem posição vinculada
- ✅ orchMonitor.js linha 588: Busca de sinais aguardando acionamento
- ✅ positionSync.js linha 409: Busca de ordens por ID externo + conta
- ✅ positionSync.js linha 178: Busca de posições abertas
- ✅ Todas as consultas com ORDER BY id DESC LIMIT 1
*/
