#!/usr/bin/env python3
"""
Verificar estrutura da tabela users
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

conn = psycopg2.connect(**DB_CONFIG)
cursor = conn.cursor()

# Verificar estrutura da tabela users
cursor.execute("""
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_name = 'users' 
    ORDER BY ordinal_position;
""")

columns = cursor.fetchall()
print('Estrutura da tabela users:')
for col in columns:
    print(f'  {col[0]}: {col[1]} - NULL: {col[2]} - Default: {col[3]}')

# Verificar estrutura da tabela corretoras
cursor.execute("""
    SELECT column_name, data_type, is_nullable, column_default 
    FROM information_schema.columns 
    WHERE table_name = 'corretoras' 
    ORDER BY ordinal_position;
""")

columns = cursor.fetchall()
print('\nEstrutura da tabela corretoras:')
for col in columns:
    print(f'  {col[0]}: {col[1]} - NULL: {col[2]} - Default: {col[3]}')

cursor.close()
conn.close()
