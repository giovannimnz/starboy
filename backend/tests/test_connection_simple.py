#!/usr/bin/env python3
"""
Teste simples de conexão com PostgreSQL
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

print("🔧 Configurações do banco:")
print(f"  DB_HOST: {os.getenv('DB_HOST')}")
print(f"  DB_PORT: {os.getenv('DB_PORT')}")
print(f"  DB_USER: {os.getenv('DB_USER')}")
print(f"  DB_NAME: {os.getenv('DB_NAME')}")
print(f"  DB_PASSWORD: {'*' * len(os.getenv('DB_PASSWORD', ''))}")

# Configuração do banco PostgreSQL
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

print(f"\n🔌 Tentando conectar ao banco...")

try:
    conn = psycopg2.connect(**DB_CONFIG)
    print("✅ Conexão estabelecida com sucesso!")
    
    cursor = conn.cursor()
    cursor.execute("SELECT version();")
    result = cursor.fetchone()
    print(f"📋 PostgreSQL version: {result[0]}")
    
    # Testar se as tabelas existem
    cursor.execute("""
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        ORDER BY table_name;
    """)
    tables = cursor.fetchall()
    print(f"\n📊 Tabelas encontradas ({len(tables)}):")
    for table in tables:
        print(f"  - {table[0]}")
    
    cursor.close()
    conn.close()
    
except psycopg2.Error as e:
    print(f"❌ Erro ao conectar ao banco: {e}")
    print(f"📋 Detalhes do erro: {e.pgerror if hasattr(e, 'pgerror') else 'N/A'}")
    
except Exception as e:
    print(f"❌ Erro genérico: {e}")
    
print("\n🔚 Teste de conexão finalizado.")
