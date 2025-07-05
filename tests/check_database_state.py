#!/usr/bin/env python3
"""
Script para verificar o estado atual das tabelas no banco de dados
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

def check_table_exists(cursor, table_name):
    """Verifica se uma tabela existe"""
    cursor.execute('''
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables 
            WHERE table_name = %s
        ) as exists
    ''', (table_name,))
    return cursor.fetchone()['exists']

def check_column_exists(cursor, table_name, column_name):
    """Verifica se uma coluna existe em uma tabela"""
    cursor.execute('''
        SELECT EXISTS (
            SELECT 1 FROM information_schema.columns 
            WHERE table_name = %s 
            AND column_name = %s
        ) as exists
    ''', (table_name, column_name))
    return cursor.fetchone()['exists']

def get_table_count(cursor, table_name):
    """Obtém o número de registros em uma tabela"""
    cursor.execute(f'SELECT COUNT(*) as count FROM {table_name}')
    return cursor.fetchone()['count']

def main():
    try:
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print("=== VERIFICAÇÃO DO ESTADO ATUAL DO BANCO DE DADOS ===")
        print()
        
        # Verificar tabelas relevantes
        tables_to_check = [
            'signals_analysis',
            'signals_analysis', 
            'backtest_signals',
            'backtest_signals',
            'backtest_results'
        ]
        
        for table in tables_to_check:
            exists = check_table_exists(cursor, table)
            print(f"Tabela {table}: {'EXISTE' if exists else 'NÃO EXISTE'}")
            
            if exists:
                count = get_table_count(cursor, table)
                print(f"  -> Registros: {count}")
                
                # Verificações específicas
                if table == 'signals_analysis':
                    has_analysis_type = check_column_exists(cursor, table, 'analysis_type')
                    print(f"  -> Coluna analysis_type: {'EXISTE' if has_analysis_type else 'NÃO EXISTE'}")
                
                if table == 'backtest_signals':
                    has_signal_datetime = check_column_exists(cursor, table, 'signal_datetime')
                    print(f"  -> Coluna signal_datetime: {'EXISTE' if has_signal_datetime else 'NÃO EXISTE'}")
            
            print()
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f'Erro: {e}')
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
