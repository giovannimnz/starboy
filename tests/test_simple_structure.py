#!/usr/bin/env python3
"""
Teste simples da estrutura do banco de dados
"""

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path
import os

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[1] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def main():
    print("🧪 TESTE SIMPLES DA ESTRUTURA")
    print("="*50)
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verificar se as tabelas existem
        tables = ['signals_analysis', 'backtest_signals', 'backtest_results']
        
        for table in tables:
            cursor.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_name = %s
                ) as exists
            """, (table,))
            exists = cursor.fetchone()['exists']
            print(f"Tabela {table}: {'✅' if exists else '❌'}")
        
        # Verificar coluna analysis_type
        cursor.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'signals_analysis' 
                AND column_name = 'analysis_type'
            ) as exists
        """)
        has_analysis_type = cursor.fetchone()['exists']
        print(f"Coluna analysis_type: {'✅' if has_analysis_type else '❌'}")
        
        # Verificar coluna signal_datetime
        cursor.execute("""
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns 
                WHERE table_name = 'backtest_signals' 
                AND column_name = 'signal_datetime'
            ) as exists
        """)
        has_signal_datetime = cursor.fetchone()['exists']
        print(f"Coluna signal_datetime: {'✅' if has_signal_datetime else '❌'}")
        
        cursor.close()
        conn.close()
        
        print("="*50)
        print("✅ TESTE CONCLUÍDO COM SUCESSO")
        
    except Exception as e:
        print(f"❌ Erro: {e}")

if __name__ == "__main__":
    main()
