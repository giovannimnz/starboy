#!/usr/bin/env python3
"""
Script de teste para verificar a estrutura das tabelas
"""

import psycopg2
from psycopg2.extras import RealDictCursor

def test_database_structure():
    """Testa a estrutura do banco de dados"""
    try:
        print("=" * 50)
        print("TESTE DA ESTRUTURA DO BANCO DE DADOS")
        print("=" * 50)
        
        # Conectar ao banco
        conn = psycopg2.connect(
            host="atius.com.br",
            port="8745",
            user="postgres",
            password="Bkfigt!546",
            database="starboy_dev"
        )
        
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Testar tabela signals_analysis
        print("\n📊 TABELA: signals_analysis")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'signals_analysis'
            ORDER BY ordinal_position
        """)
        
        colunas = cursor.fetchall()
        print(f"✅ Colunas ({len(colunas)}):")
        for col in colunas:
            print(f"   - {col['column_name']} ({col['data_type']})")
        
        # Testar tabela backtest_signals
        print("\n📊 TABELA: backtest_signals")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'backtest_signals'
            ORDER BY ordinal_position
        """)
        
        colunas = cursor.fetchall()
        print(f"✅ Colunas ({len(colunas)}):")
        for col in colunas:
            print(f"   - {col['column_name']} ({col['data_type']})")
        
        # Testar tabela backtest_results
        print("\n📊 TABELA: backtest_results")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'backtest_results'
            ORDER BY ordinal_position
        """)
        
        colunas = cursor.fetchall()
        print(f"✅ Colunas ({len(colunas)}):")
        for col in colunas:
            print(f"   - {col['column_name']} ({col['data_type']})")
        
        # Contar registros
        print("\n📈 REGISTROS:")
        
        cursor.execute("SELECT COUNT(*) FROM signals_analysis")
        count = cursor.fetchone()['count']
        print(f"   - signals_analysis: {count}")
        
        cursor.execute("SELECT COUNT(*) FROM backtest_signals")
        count = cursor.fetchone()['count']
        print(f"   - backtest_signals: {count}")
        
        cursor.execute("SELECT COUNT(*) FROM backtest_results")
        count = cursor.fetchone()['count']
        print(f"   - backtest_results: {count}")
        
        cursor.execute("SELECT COUNT(*) FROM webhook_signals")
        count = cursor.fetchone()['count']
        print(f"   - webhook_signals: {count}")
        
        cursor.close()
        conn.close()
        
        print("\n✅ Teste concluído com sucesso!")
        print("=" * 50)
        
    except Exception as e:
        print(f"❌ Erro no teste: {e}")

if __name__ == "__main__":
    test_database_structure()
