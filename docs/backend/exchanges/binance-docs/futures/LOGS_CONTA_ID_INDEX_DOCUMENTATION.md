# DOCUMENTAÇÃO - NOVO ÍNDICE logs.conta_id

## 📋 Resumo da Implementação

**Data:** 03 de Janeiro de 2025  
**Índice Adicionado:** `idx_logs_conta_id`  
**Tabela:** `logs`  
**Colunas:** `conta_id, data_hora`  

---

## 🎯 Objetivo

Otimizar consultas de logs filtradas por conta específica, melhorando a performance de:
- Dashboards de monitoramento por conta
- Relatórios de debug específicos de uma conta
- Análise de logs de problemas em contas individuais
- Filtros administrativos para visualizar apenas logs de determinada conta

---

## 💡 Justificativa

### Problema Identificado
- Consultas como `SELECT * FROM logs WHERE conta_id = ?` eram muito lentas
- Filtros por conta em interfaces de administração causavam timeouts
- Relatórios de debug por conta específica tinham performance inadequada
- Tabela `logs` pode crescer rapidamente, tornando consultas sem índice muito lentas

### Padrões de Consulta Comuns
```sql
-- Logs de uma conta específica (ordenados por data)
SELECT * FROM logs WHERE conta_id = 1 ORDER BY data_hora DESC LIMIT 100;

-- Logs de erro para uma conta
SELECT * FROM logs WHERE conta_id = 1 AND nivel = 'ERROR' ORDER BY data_hora DESC;

-- Contagem de logs por período para uma conta
SELECT COUNT(*) FROM logs WHERE conta_id = 1 AND data_hora >= '2025-01-01';

-- Limpeza de logs antigos por conta
DELETE FROM logs WHERE conta_id = 1 AND data_hora < '2024-12-01';
```

---

## 🔧 Implementação Técnica

### SQL do Índice
```sql
-- Índice para consultas por conta_id (filtros de logs por conta específica)
CREATE INDEX IF NOT EXISTS idx_logs_conta_id 
ON logs (conta_id, data_hora);
```

### Características do Índice
- **Tipo:** Índice composto
- **Primeira coluna:** `conta_id` (alta seletividade para filtros)
- **Segunda coluna:** `data_hora` (permite ordenação eficiente)
- **Compatibilidade:** MariaDB/MySQL
- **Tamanho estimado:** 10-20% do tamanho da tabela `logs`

---

## 📈 Performance Esperada

### Antes do Índice
```sql
EXPLAIN SELECT * FROM logs WHERE conta_id = 1 ORDER BY data_hora DESC LIMIT 100;
-- Resultado: Full table scan (muito lento para tabelas grandes)
-- Tipo: ALL
-- Rows: 500,000+ (toda a tabela)
-- Extra: Using where; Using filesort
```

### Após o Índice
```sql
EXPLAIN SELECT * FROM logs WHERE conta_id = 1 ORDER BY data_hora DESC LIMIT 100;
-- Resultado: Uso do índice (muito rápido)
-- Tipo: ref
-- Rows: ~1,000 (apenas logs da conta)
-- Extra: Using index condition
```

### Melhorias Esperadas
- **Consultas por conta:** 80-95% mais rápidas
- **Ordenação por data:** Sem necessidade de filesort adicional
- **Filtros compostos:** Performance otimizada para conta + data
- **Limpeza de dados:** DELETE mais eficiente

---

## 🗂️ Localização nos Arquivos

### SQL de Criação
**Arquivo:** `backend/core/database/migrations/database_indexes_optimization.sql`  
**Linha:** ~290 (aproximadamente)

### Documentação Principal
**Arquivo:** `OTIMIZACAO_BANCO_DADOS_RELATORIO.md`  
**Seção:** Tabelas de Log e Monitoramento

### Resumo Executivo
**Arquivo:** `OTIMIZACAO_INDICES_RESUMO_FINAL.md`  
**Seção:** Índices Mais Importantes (Prioridade ⭐)

---

## 🛠️ Scripts de Aplicação

### Aplicação via Script Shell
```bash
./apply_database_indexes.sh
```

### Aplicação via Script Node.js
```bash
node apply_indexes.js
```

### Aplicação Manual
```sql
-- Conectar ao banco e executar:
CREATE INDEX IF NOT EXISTS idx_logs_conta_id ON logs (conta_id, data_hora);

-- Verificar se foi criado:
SHOW INDEX FROM logs WHERE Key_name = 'idx_logs_conta_id';

-- Atualizar estatísticas:
ANALYZE TABLE logs;
```

---

## 📊 Monitoramento

### Verificar Uso do Índice
```sql
-- Verificar se o índice está sendo usado
EXPLAIN SELECT * FROM logs WHERE conta_id = 1 ORDER BY data_hora DESC LIMIT 100;

-- Verificar estatísticas do índice
SELECT 
    INDEX_NAME,
    CARDINALITY,
    SUB_PART,
    NULLABLE
FROM information_schema.STATISTICS 
WHERE TABLE_NAME = 'logs' 
AND INDEX_NAME = 'idx_logs_conta_id';
```

### Verificar Performance
```sql
-- Tamanho do índice
SELECT 
    INDEX_NAME,
    ROUND(STAT_VALUE * @@innodb_page_size / 1024 / 1024, 2) AS 'Index Size (MB)'
FROM mysql.innodb_index_stats 
WHERE TABLE_NAME = 'logs' 
AND INDEX_NAME = 'idx_logs_conta_id'
AND STAT_NAME = 'size';

-- Performance comparativa
-- Execute antes e depois de criar o índice:
SET @start_time = NOW(6);
SELECT COUNT(*) FROM logs WHERE conta_id = 1;
SELECT TIMEDIFF(NOW(6), @start_time) AS 'Query Time';
```

---

## ⚠️ Considerações Importantes

### Impacto na Performance
- **Inserções:** Podem ficar ligeiramente mais lentas (~5-10%)
- **Consultas:** Significativamente mais rápidas (80-95%)
- **Espaço:** Aumento de ~15-25% no tamanho da tabela `logs`

### Manutenção
- **Fragmentação:** Monitorar periodicamente com `SHOW TABLE STATUS`
- **Estatísticas:** Executar `ANALYZE TABLE logs` semanalmente
- **Limpeza:** Considerar rotação/arquivamento de logs antigos

### Cenários de Remoção
```sql
-- Se necessário remover o índice:
DROP INDEX idx_logs_conta_id ON logs;

-- Motivos para remoção:
-- 1. Uso excessivo de espaço em disco
-- 2. Performance de inserção muito impactada
-- 3. Índice não sendo utilizado pelas consultas
```

---

## 🔍 Validação da Implementação

### Checklist de Verificação
- [ ] Índice criado com sucesso
- [ ] Sem erros durante a criação
- [ ] EXPLAIN mostra uso do índice
- [ ] Performance das consultas melhorada
- [ ] Impacto nas inserções aceitável
- [ ] Espaço em disco adequado

### Comandos de Validação
```sql
-- 1. Verificar se o índice existe
SHOW INDEX FROM logs WHERE Key_name = 'idx_logs_conta_id';

-- 2. Testar performance
EXPLAIN SELECT * FROM logs WHERE conta_id = 1 ORDER BY data_hora DESC LIMIT 100;

-- 3. Verificar tamanho
SELECT 
    TABLE_NAME,
    ROUND(((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024), 2) AS 'Total Size (MB)',
    ROUND((INDEX_LENGTH / 1024 / 1024), 2) AS 'Index Size (MB)'
FROM information_schema.TABLES 
WHERE TABLE_NAME = 'logs';

-- 4. Testar consulta real
SELECT COUNT(*) FROM logs WHERE conta_id = 1 AND data_hora >= CURDATE();
```

---

## 📋 Histórico de Mudanças

| Data | Versão | Alteração | Autor |
|------|---------|-----------|-------|
| 03/01/2025 | 1.0 | Criação inicial do índice | Sistema |
| 03/01/2025 | 1.0 | Documentação completa | Sistema |

---

## 🎯 Próximos Passos

1. **Aplicar o índice** usando um dos scripts disponíveis
2. **Monitorar performance** por 24-48 horas
3. **Verificar impacto** nas inserções de logs
4. **Ajustar configurações** se necessário
5. **Documentar resultados** para futuras otimizações

---

**Status:** ✅ Pronto para aplicação  
**Prioridade:** ⭐ Média (melhoria de qualidade de vida)  
**Impacto:** Positivo para administração e debug do sistema
