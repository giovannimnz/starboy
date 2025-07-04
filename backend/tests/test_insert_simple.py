#!/usr/bin/env python3
"""
Teste simples de inserção na tabela users
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from datetime import datetime

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

print("🧪 Teste simples de inserção na tabela users")

try:
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    # Limpar dados de teste
    cursor.execute("DELETE FROM users WHERE id = 9001")
    print("✅ Limpeza de dados de teste")
    
    # Inserir usuário de teste
    user_data = {
        'id': 9001,
        'nome': 'Test User',
        'email': 'test@example.com',
        'senha': 'hashed_password',
        'atualizado_em': datetime.now()
    }
    
    cursor.execute("""
        INSERT INTO users (id, nome, email, senha, atualizado_em) 
        VALUES (%(id)s, %(nome)s, %(email)s, %(senha)s, %(atualizado_em)s)
    """, user_data)
    
    print("✅ Usuário inserido com sucesso")
    
    # Buscar usuário
    cursor.execute("SELECT * FROM users WHERE id = %s", (9001,))
    result = cursor.fetchone()
    
    if result:
        print(f"✅ Usuário encontrado: ID={result['id']}, Atualizado em={result['atualizado_em']}")
    else:
        print("❌ Usuário não encontrado")
    
    # Limpar dados de teste
    cursor.execute("DELETE FROM users WHERE id = 9001")
    print("✅ Dados de teste limpos")
    
    cursor.close()
    conn.close()
    
    print("🎉 Teste concluído com sucesso!")
    
except Exception as e:
    print(f"❌ Erro no teste: {e}")
    import traceback
    traceback.print_exc()
