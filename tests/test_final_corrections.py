#!/usr/bin/env python3
"""
Teste final para verificar se todas as correções foram aplicadas corretamente
"""

import sys
import os
from pathlib import Path

# Adicionar o diretório backend ao path
sys.path.insert(0, str(Path(__file__).parent.parent))

def test_imports():
    """Testa todos os imports que estavam com problema"""
    print("🔍 Testando imports...")
    
    # Teste 1: Import do divap_backtest
    try:
        from backend.indicators.divap_backtest import BacktestEngine
        print("✅ divap_backtest importado com sucesso")
    except ImportError as e:
        print(f"❌ Erro ao importar divap_backtest: {e}")
    
    # Teste 2: Import do exchange_bracket_updater
    try:
        from backend.indicators.utils.exchange_bracket_updater import update_leverage_brackets
        print("✅ exchange_bracket_updater importado com sucesso")
    except ImportError as e:
        print(f"❌ Erro ao importar exchange_bracket_updater: {e}")
    
    # Teste 3: Import do exchange_info_updater
    try:
        from backend.indicators.utils.exchange_info_updater import update_exchange_info_database
        print("✅ exchange_info_updater importado com sucesso")
    except ImportError as e:
        print(f"❌ Erro ao importar exchange_info_updater: {e}")
    
    # Teste 4: Import do senhas
    try:
        from backend.indicators.utils.senhas import API_KEY, API_SECRET
        print("✅ senhas importado com sucesso")
    except ImportError as e:
        print(f"❌ Erro ao importar senhas: {e}")

def test_database_tables():
    """Testa se as tabelas corretas existem"""
    print("\n🔍 Testando estrutura do banco...")
    
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        from dotenv import load_dotenv
        
        # Carregar .env
        env_path = Path(__file__).parent.parent / 'config' / '.env'
        load_dotenv(dotenv_path=env_path)
        
        # Conectar ao banco
        conn = psycopg2.connect(
            host=os.getenv('DB_HOST'),
            port=int(os.getenv('DB_PORT', 5432)),
            user=os.getenv('DB_USER'),
            password=os.getenv('DB_PASSWORD'),
            database=os.getenv('DB_NAME')
        )
        
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verificar tabelas essenciais
        tables_to_check = [
            'exchange_symbols',
            'exchange_filters', 
            'exchange_leverage_brackets'
        ]
        
        for table in tables_to_check:
            cursor.execute(f"SELECT COUNT(*) as count FROM {table}")
            result = cursor.fetchone()
            print(f"✅ Tabela {table}: {result['count']} registros")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Erro ao testar banco: {e}")

def test_functionality():
    """Testa se as funcionalidades principais funcionam"""
    print("\n🔍 Testando funcionalidades...")
    
    try:
        # Teste do sistema de credenciais
        from backend.indicators.utils.exchange_bracket_updater import test_binance_credentials, test_database_connection
        
        if test_binance_credentials():
            print("✅ Credenciais Binance funcionando")
        else:
            print("❌ Problema com credenciais Binance")
        
        if test_database_connection():
            print("✅ Conexão com banco funcionando")
        else:
            print("❌ Problema com conexão do banco")
            
    except Exception as e:
        print(f"❌ Erro ao testar funcionalidades: {e}")

def main():
    """Função principal"""
    print("="*60)
    print("🎯 TESTE FINAL - VERIFICAÇÃO DE CORREÇÕES")
    print("="*60)
    
    test_imports()
    test_database_tables()
    test_functionality()
    
    print("\n" + "="*60)
    print("✅ TESTE CONCLUÍDO")
    print("="*60)

if __name__ == "__main__":
    main()
