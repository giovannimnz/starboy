#!/usr/bin/env python3
"""
Verifica estrutura das tabelas principais no banco PostgreSQL
"""
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

conn = psycopg2.connect(
    host=os.getenv('DB_HOST', 'localhost'),
    database=os.getenv('DB_NAME', 'starboy_postgres'),
    user=os.getenv('DB_USER', 'postgres'),
    password=os.getenv('DB_PASSWORD', 'password'),
    port=int(os.getenv('DB_PORT', 5432))
)
cursor = conn.cursor()

# Verificar estrutura das principais tabelas
tables = ['users', 'corretoras', 'contas', 'exchange_symbols', 'posicoes', 'ordens', 'webhook_signals']

for table in tables:
    print(f'\n=== TABELA: {table.upper()} ===')
    try:
        cursor.execute(f'''
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = '{table}' 
            ORDER BY ordinal_position
        ''')
        
        columns = cursor.fetchall()
        if columns:
            for col in columns:
                nullable = "NULL" if col[2] == "YES" else "NOT NULL"
                default = col[3] if col[3] else "No default"
                print(f'  {col[0]:<25} | {col[1]:<15} | {nullable:<8} | {default}')
        else:
            print(f'  ❌ Tabela {table} não encontrada')
    except Exception as e:
        print(f'  ❌ Erro ao verificar tabela {table}: {e}')

conn.close()
