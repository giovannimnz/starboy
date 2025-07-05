-- Script SQL para corrigir inconsistências na tabela exchange_filters
-- Remove registros órfãos onde symbol_id não existe em exchange_symbols

-- 1. Mostrar estatísticas antes da correção
SELECT 
    'ANTES DA CORREÇÃO' as status,
    COUNT(*) as total_filters,
    COUNT(DISTINCT ef.symbol_id) as unique_symbol_ids
FROM exchange_filters ef;

-- 2. Mostrar registros órfãos
SELECT 
    'REGISTROS ÓRFÃOS' as status,
    COUNT(*) as orphaned_filters
FROM exchange_filters ef
LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
WHERE es.id IS NULL;

-- 3. Mostrar detalhes dos registros órfãos (limitado a 20 para não sobrecarregar)
SELECT 
    ef.id,
    ef.symbol_id,
    ef.filter_type,
    ef.min_price,
    ef.max_price
FROM exchange_filters ef
LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
WHERE es.id IS NULL
ORDER BY ef.symbol_id, ef.filter_type
LIMIT 20;

-- 4. Remover registros órfãos
DELETE FROM exchange_filters 
WHERE id IN (
    SELECT ef.id 
    FROM exchange_filters ef
    LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
    WHERE es.id IS NULL
);

-- 5. Mostrar estatísticas após a correção
SELECT 
    'APÓS A CORREÇÃO' as status,
    COUNT(*) as total_filters,
    COUNT(DISTINCT ef.symbol_id) as unique_symbol_ids
FROM exchange_filters ef;

-- 6. Verificar integridade das chaves estrangeiras
SELECT 
    'VERIFICAÇÃO FINAL' as status,
    COUNT(*) as total_filters,
    COUNT(CASE WHEN es.id IS NOT NULL THEN 1 END) as valid_filters,
    COUNT(CASE WHEN es.id IS NULL THEN 1 END) as invalid_filters
FROM exchange_filters ef
LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id;

-- 7. Estatísticas por exchange
SELECT 
    es.exchange,
    COUNT(DISTINCT es.id) as total_symbols,
    COUNT(ef.id) as total_filters,
    ROUND(COUNT(ef.id)::numeric / COUNT(DISTINCT es.id), 2) as avg_filters_per_symbol
FROM exchange_symbols es
LEFT JOIN exchange_filters ef ON es.id = ef.symbol_id
GROUP BY es.exchange
ORDER BY es.exchange;
