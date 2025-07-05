#!/usr/bin/env python3
"""
Verificar estruturas de todas as tabelas importantes
"""

import os
import psycopg2
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'database': os.getenv('DB_NAME'),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def check_table_structure(table_name):
    """Verifica a estrutura de uma tabela"""
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT column_name, data_type, is_nullable, column_default 
        FROM information_schema.columns 
        WHERE table_name = %s 
        ORDER BY ordinal_position;
    """, (table_name,))
    
    columns = cursor.fetchall()
    print(f'\n=== ESTRUTURA DA TABELA {table_name.upper()} ===')
    for col in columns:
        nullable = "NULL" if col[2] == "YES" else "NOT NULL"
        default = f"DEFAULT: {col[3]}" if col[3] else "NO DEFAULT"
        print(f'  {col[0]}: {col[1]} - {nullable} - {default}')
    
    cursor.close()
    conn.close()
    return columns

# Verificar estruturas das principais tabelas
tables_to_check = [
    'users', 'corretoras', 'contas', 'configuracoes',
    'exchange_symbols', 'exchange_filters', 'exchange_leverage_brackets',
    'posicoes', 'ordens', 'monitoramento', 'webhook_signals',
    'signals_analysis', 'signals_msg', 'ordens_fechadas', 
    'posicoes_fechadas', 'logs', 'backtest_signals'
]

print("🔍 VERIFICANDO ESTRUTURAS DE TODAS AS TABELAS")
print("=" * 60)

table_structures = {}
for table in tables_to_check:
    try:
        columns = check_table_structure(table)
        table_structures[table] = columns
    except Exception as e:
        print(f"❌ Erro ao verificar tabela {table}: {e}")

print(f"\n✅ Verificação concluída para {len(table_structures)} tabelas")
