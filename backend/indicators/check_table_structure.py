#!/usr/bin/env python3
"""
Script para verificar a estrutura real das tabelas
"""

import psycopg2
from psycopg2.extras import RealDictCursor

# Configurações do banco
DB_CONFIG = {
    'host': 'atius.com.br',
    'port': 8745,
    'user': 'postgres',
    'password': 'Bkfigt!546',
    'database': 'starboy_dev'
}

def get_connection():
    """Obtém conexão com o banco"""
    return psycopg2.connect(**DB_CONFIG)

def check_table_columns():
    """Verifica as colunas reais das tabelas"""
    print("🔍 VERIFICANDO COLUNAS DAS TABELAS")
    print("=" * 50)
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        tables = ['signals_analysis', 'backtest_signals', 'backtest_results']
        
        for table in tables:
            print(f"\n📋 TABELA: {table}")
            cursor.execute("""
                SELECT column_name, data_type, is_nullable, column_default
                FROM information_schema.columns 
                WHERE table_name = %s
                ORDER BY ordinal_position
            """, (table,))
            
            columns = cursor.fetchall()
            if columns:
                for col in columns:
                    nullable = "NULL" if col['is_nullable'] == 'YES' else "NOT NULL"
                    default = f" DEFAULT {col['column_default']}" if col['column_default'] else ""
                    print(f"   - {col['column_name']}: {col['data_type']} {nullable}{default}")
            else:
                print(f"   ❌ Tabela {table} não encontrada")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ ERRO: {str(e)}")

def main():
    check_table_columns()

if __name__ == "__main__":
    main()
