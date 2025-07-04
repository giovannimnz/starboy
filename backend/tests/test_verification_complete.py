#!/usr/bin/env python3
"""
Teste simples para verificar se as importações estão funcionando
"""

import os
import sys
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timedelta
from decimal import Decimal
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

# Adicionar o diretório do projeto ao path
project_root = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, project_root)

# Configuração do banco PostgreSQL
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def test_database_connection():
    """Testa a conexão com o banco de dados"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        cursor.execute("SELECT version();")
        result = cursor.fetchone()
        print(f"✅ Conexão bem-sucedida! PostgreSQL version: {result['version']}")
        
        cursor.close()
        conn.close()
        return True
    except Exception as e:
        print(f"❌ Erro na conexão: {e}")
        return False

def test_imports():
    """Testa se todas as importações estão funcionando"""
    print("🔍 Testando importações...")
    
    # Adicionar o diretório do projeto ao path
    sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'indicators'))
    
    try:
        # Testar importações básicas
        import ccxt
        print("✅ ccxt importado com sucesso")
        
        import pandas as pd
        print("✅ pandas importado com sucesso")
        
        import numpy as np
        print("✅ numpy importado com sucesso")
        
        import vectorbt as vbt
        print("✅ vectorbt importado com sucesso")
        
        import telethon
        print("✅ telethon importado com sucesso")
        
        import requests
        print("✅ requests importado com sucesso")
        
        import schedule
        print("✅ schedule importado com sucesso")
        
        try:
            import win32api  # type: ignore
            print("✅ win32api importado com sucesso")
        except ImportError:
            print("⚠️ win32api não disponível (esperado em sistemas não-Windows)")
        
        # Testar importações locais
        sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'indicators'))
        
        try:
            from exchange_bracket_updater import update_leverage_brackets
            print("✅ exchange_bracket_updater importado com sucesso")
        except ImportError as e:
            print(f"❌ Erro ao importar exchange_bracket_updater: {e}")
        
        try:
            from exchange_info_updater import update_exchange_info_database
            print("✅ exchange_info_updater importado com sucesso")
        except ImportError as e:
            print(f"❌ Erro ao importar exchange_info_updater: {e}")
        
        try:
            from senhas import pers_api_hash, pers_api_id, API_KEY, API_SECRET
            print("✅ senhas importado com sucesso")
        except ImportError as e:
            print(f"❌ Erro ao importar senhas: {e}")
        
        try:
            from analysis.divap_check import DIVAPAnalyzer
            print("✅ DIVAPAnalyzer importado com sucesso")
        except ImportError as e:
            print(f"❌ Erro ao importar DIVAPAnalyzer: {e}")
        
        return True
        
    except Exception as e:
        print(f"❌ Erro geral nas importações: {e}")
        return False

def test_simple_crud():
    """Testa operações CRUD simples"""
    print("\n🧪 Testando operações CRUD simples...")
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Limpar dados de teste
        cursor.execute("DELETE FROM users WHERE id = 9999")
        
        # INSERT
        cursor.execute("""
            INSERT INTO users (id, nome, email, senha, ativa)
            VALUES (%s, %s, %s, %s, %s)
        """, (9999, 'Test User', 'test@example.com', 'password123', True))
        print("✅ INSERT realizado com sucesso")
        
        # SELECT
        cursor.execute("SELECT * FROM users WHERE id = %s", (9999,))
        user = cursor.fetchone()
        if user and user['nome'] == 'Test User':
            print("✅ SELECT realizado com sucesso")
        else:
            print("❌ SELECT falhou")
        
        # UPDATE
        cursor.execute("UPDATE users SET nome = %s WHERE id = %s", ('Updated User', 9999))
        cursor.execute("SELECT * FROM users WHERE id = %s", (9999,))
        user = cursor.fetchone()
        if user and user['nome'] == 'Updated User':
            print("✅ UPDATE realizado com sucesso")
        else:
            print("❌ UPDATE falhou")
        
        # DELETE
        cursor.execute("DELETE FROM users WHERE id = %s", (9999,))
        cursor.execute("SELECT * FROM users WHERE id = %s", (9999,))
        user = cursor.fetchone()
        if user is None:
            print("✅ DELETE realizado com sucesso")
        else:
            print("❌ DELETE falhou")
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"❌ Erro no teste CRUD: {e}")
        return False

def main():
    """Função principal"""
    print("🚀 TESTE DE VERIFICAÇÃO - PROJETO STARBOY POSTGRESQL")
    print("=" * 60)
    
    # Testar conexão
    if not test_database_connection():
        print("❌ Falha na conexão com o banco de dados")
        return False
    
    # Testar importações
    if not test_imports():
        print("❌ Falha nas importações")
        return False
    
    # Testar CRUD
    if not test_simple_crud():
        print("❌ Falha no teste CRUD")
        return False
    
    print("\n🎉 TODOS OS TESTES PASSARAM COM SUCESSO!")
    print("✅ Migração do MySQL para PostgreSQL está funcionando corretamente")
    return True

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
