# Migração dos Scripts Python para PostgreSQL

## Resumo das Alterações

Este documento descreve todas as alterações realizadas para migrar os scripts Python da pasta `backend/indicators` de MySQL/MariaDB para PostgreSQL.

## Arquivos Modificados

### 1. `divap.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Remoção de configurações específicas do MySQL (`charset`, `autocommit`)
- Ajuste do `DB_CONFIG` para PostgreSQL
- Substituição de `cursor(dictionary=True)` por `cursor(cursor_factory=RealDictCursor)`
- Ajuste de verificação de conexão de `conn.is_connected()` para `not conn.closed`
- Conversão de valores booleanos de `1/0` para `true/false`
- Substituição de `cursor.lastrowid` por `RETURNING id` clause
- Autocommit habilitado manualmente com `conn.autocommit = True`

### 2. `exchange_bracket_updater.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Ajuste do `DB_CONFIG` removendo `charset` e `autocommit`
- Substituição de `cursor(dictionary=True)` por `cursor(cursor_factory=RealDictCursor)`
- Conversão de `NOW()` para `CURRENT_TIMESTAMP`
- Autocommit habilitado manualmente

### 3. `exchange_info_updater.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Ajuste do `DB_CONFIG` para PostgreSQL
- Substituição de `cursor(dictionary=True)` por `cursor(cursor_factory=RealDictCursor)`
- Autocommit habilitado manualmente

### 4. `analysis/divap_check.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Substituição de `cursor(dictionary=True)` por `cursor(cursor_factory=RealDictCursor)`
- Conversão de `ON DUPLICATE KEY UPDATE` para `ON CONFLICT ... DO UPDATE SET`
- Substituição de `VALUES(campo)` por `EXCLUDED.campo` no PostgreSQL

### 5. `backtest/divap_backtest.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Import atualizado para usar `RealDictCursor`

### 6. `backtest/divap_scraper.py`
**Principais alterações:**
- Substituição de `mysql.connector` por `psycopg2`
- Import atualizado para usar `RealDictCursor`

### 7. `backtest/test_group_access.py`
**Sem alterações:** Arquivo não usa banco de dados

### 8. `senhas.py`
**Sem alterações:** Arquivo contém apenas configurações de API

### 9. `session-login.py`
**Sem alterações:** Arquivo não usa banco de dados

## Principais Diferenças MySQL vs PostgreSQL

### Drivers e Conexão
```python
# MySQL
import mysql.connector
conn = mysql.connector.connect(**DB_CONFIG)
cursor = conn.cursor(dictionary=True)

# PostgreSQL
import psycopg2
from psycopg2.extras import RealDictCursor
conn = psycopg2.connect(**DB_CONFIG)
cursor = conn.cursor(cursor_factory=RealDictCursor)
```

### Configuração de Banco
```python
# MySQL
DB_CONFIG = {
    'host': host,
    'port': port,
    'user': user,
    'password': password,
    'database': database,
    'charset': 'utf8mb4',
    'autocommit': True
}

# PostgreSQL
DB_CONFIG = {
    'host': host,
    'port': port or 5432,
    'user': user,
    'password': password,
    'database': database
}
# Autocommit manual: conn.autocommit = True
```

### Verificação de Conexão
```python
# MySQL
if conn.is_connected():

# PostgreSQL
if not conn.closed:
```

### Valores Booleanos
```python
# MySQL
WHERE ativa = 1

# PostgreSQL
WHERE ativa = true
```

### Obter ID Inserido
```python
# MySQL
cursor.execute(sql, values)
id = cursor.lastrowid

# PostgreSQL
sql += " RETURNING id"
cursor.execute(sql, values)
id = cursor.fetchone()['id']
```

### Funções de Data
```python
# MySQL
updated_at = NOW()

# PostgreSQL
updated_at = CURRENT_TIMESTAMP
```

### UPSERT (INSERT ou UPDATE)
```python
# MySQL
INSERT ... ON DUPLICATE KEY UPDATE field=VALUES(field)

# PostgreSQL
INSERT ... ON CONFLICT (key) DO UPDATE SET field=EXCLUDED.field
```

## Compatibilidade com a Estrutura PostgreSQL

Todos os scripts foram ajustados para trabalhar com a estrutura definida em `create_postgres_db.sql`, incluindo:

- Tipos de dados corretos (SERIAL, TIMESTAMPTZ, BOOLEAN)
- Nomes de tabelas e colunas mantidos
- Constraints e relacionamentos preservados
- Triggers e funções PostgreSQL utilizados

## Status da Migração

✅ **Concluído:** Todos os arquivos Python foram migrados com sucesso para PostgreSQL
✅ **Testado:** Sintaxe validada sem erros de compilação
✅ **Compatível:** Estrutura alinhada com o DDL PostgreSQL do projeto

## Próximos Passos

1. Testar execução real dos scripts com PostgreSQL
2. Verificar se todas as queries retornam os resultados esperados
3. Validar integração com o restante do sistema
4. Executar testes de funcionalidade end-to-end
