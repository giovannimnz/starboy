"""
Configuração de banco de dados para testes
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv()

# Configuração do banco PostgreSQL
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def get_database_connection():
    """Obtém uma conexão com o banco de dados PostgreSQL"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        return conn
    except psycopg2.Error as e:
        print(f"Erro ao conectar ao banco: {e}")
        return None

def test_connection():
    """Testa a conexão com o banco de dados"""
    conn = get_database_connection()
    if conn:
        try:
            cursor = conn.cursor()
            cursor.execute("SELECT version();")
            result = cursor.fetchone()
            print(f"Conexão bem-sucedida! PostgreSQL version: {result[0]}")
            cursor.close()
            conn.close()
            return True
        except psycopg2.Error as e:
            print(f"Erro ao testar conexão: {e}")
            return False
    return False

def execute_query(query, params=None, fetch=True):
    """Executa uma query no banco de dados"""
    conn = get_database_connection()
    if not conn:
        return None
    
    try:
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute(query, params)
        
        if fetch:
            if cursor.description:
                result = cursor.fetchall()
            else:
                result = None
        else:
            result = cursor.rowcount
            
        cursor.close()
        conn.close()
        return result
    except psycopg2.Error as e:
        print(f"Erro ao executar query: {e}")
        conn.close()
        return None
