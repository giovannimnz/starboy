#!/usr/bin/env python3
"""
Script simples de teste de conexão
"""

import os
import psycopg2
from dotenv import load_dotenv
from pathlib import Path

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

print("Configuração do banco:")
for key, value in DB_CONFIG.items():
    if key == 'password':
        print(f"  {key}: {'*' * len(value) if value else 'None'}")
    else:
        print(f"  {key}: {value}")

try:
    print("\nTestando conexão...")
    conn = psycopg2.connect(**DB_CONFIG)
    cursor = conn.cursor()
    
    cursor.execute("SELECT COUNT(*) FROM exchange_filters")
    total_filters = cursor.fetchone()[0]
    print(f"Total de filtros: {total_filters}")
    
    cursor.execute("""
        SELECT COUNT(*) 
        FROM exchange_filters ef
        LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
        WHERE es.id IS NULL
    """)
    orphaned_filters = cursor.fetchone()[0]
    print(f"Filtros órfãos: {orphaned_filters}")
    
    cursor.close()
    conn.close()
    print("✅ Conexão OK!")
    
except Exception as e:
    print(f"❌ Erro: {e}")
