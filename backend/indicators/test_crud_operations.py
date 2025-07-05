#!/usr/bin/env python3
"""
Script para testar operações CRUD nas tabelas modificadas:
- signals_analysis
- backtest_signals  
- backtest_results
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import os
import sys
from datetime import datetime

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

def test_signals_analysis_crud():
    """Testa operações CRUD na tabela signals_analysis"""
    print("\n🧪 TESTANDO OPERAÇÕES CRUD - SIGNALS_ANALYSIS")
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. INSERT
        print("   📝 1. Testando INSERT...")
        insert_query = """
        INSERT INTO signals_analysis (
            signal_id, is_bull_divap, is_bear_divap, divap_confirmed,
            bull_reversal_pattern, bear_reversal_pattern, 
            analysis_type, rsi_value, macd_value, analyzed_at
        ) VALUES (
            99999, true, false, true,
            true, false,
            'trade', 65.5, 0.25, NOW()
        ) RETURNING id
        """
        cursor.execute(insert_query)
        record_id = cursor.fetchone()['id']
        conn.commit()
        print(f"   ✅ INSERT OK - ID: {record_id}")
        
        # 2. SELECT
        print("   📖 2. Testando SELECT...")
        cursor.execute("SELECT * FROM signals_analysis WHERE id = %s", (record_id,))
        record = cursor.fetchone()
        if record:
            print(f"   ✅ SELECT OK - analysis_type: {record['analysis_type']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE signals_analysis 
            SET analysis_type = 'backtest', rsi_value = 75.0 
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT analysis_type, rsi_value FROM signals_analysis WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['analysis_type'] == 'backtest' and updated_record['rsi_value'] == 75.0:
            print("   ✅ UPDATE OK")
        else:
            print("   ❌ UPDATE FALHOU")
            
        # 4. DELETE
        print("   🗑️  4. Testando DELETE...")
        cursor.execute("DELETE FROM signals_analysis WHERE id = %s", (record_id,))
        conn.commit()
        
        cursor.execute("SELECT * FROM signals_analysis WHERE id = %s", (record_id,))
        if cursor.fetchone() is None:
            print("   ✅ DELETE OK")
        else:
            print("   ❌ DELETE FALHOU")
            
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"   ❌ ERRO: {str(e)}")
        return False
    
    return True

def test_backtest_signals_crud():
    """Testa operações CRUD na tabela backtest_signals"""
    print("\n🧪 TESTANDO OPERAÇÕES CRUD - BACKTEST_SIGNALS")
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. INSERT
        print("   📝 1. Testando INSERT...")
        insert_query = """
        INSERT INTO backtest_signals (
            symbol, timeframe, action, price, quantity, 
            rsi_value, macd_value, created_at
        ) VALUES (
            'BTCUSDT', '1h', 'BUY', 50000.0, 0.001,
            30.5, -0.15, NOW()
        ) RETURNING id
        """
        cursor.execute(insert_query)
        record_id = cursor.fetchone()['id']
        conn.commit()
        print(f"   ✅ INSERT OK - ID: {record_id}")
        
        # 2. SELECT
        print("   📖 2. Testando SELECT...")
        cursor.execute("SELECT * FROM backtest_signals WHERE id = %s", (record_id,))
        record = cursor.fetchone()
        if record:
            print(f"   ✅ SELECT OK - symbol: {record['symbol']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE backtest_signals 
            SET price = 51000.0, quantity = 0.002 
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT price, quantity FROM backtest_signals WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['price'] == 51000.0 and updated_record['quantity'] == 0.002:
            print("   ✅ UPDATE OK")
        else:
            print("   ❌ UPDATE FALHOU")
            
        # 4. DELETE
        print("   🗑️  4. Testando DELETE...")
        cursor.execute("DELETE FROM backtest_signals WHERE id = %s", (record_id,))
        conn.commit()
        
        cursor.execute("SELECT * FROM backtest_signals WHERE id = %s", (record_id,))
        if cursor.fetchone() is None:
            print("   ✅ DELETE OK")
        else:
            print("   ❌ DELETE FALHOU")
            
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"   ❌ ERRO: {str(e)}")
        return False
    
    return True

def test_backtest_results_crud():
    """Testa operações CRUD na tabela backtest_results"""
    print("\n🧪 TESTANDO OPERAÇÕES CRUD - BACKTEST_RESULTS")
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. INSERT
        print("   📝 1. Testando INSERT...")
        insert_query = """
        INSERT INTO backtest_results (
            strategy_name, symbol, timeframe, start_date, end_date,
            total_trades, winning_trades, losing_trades, profit_loss,
            max_drawdown, sharpe_ratio, created_at
        ) VALUES (
            'DIVAP_STRATEGY', 'BTCUSDT', '1h', '2023-01-01', '2023-12-31',
            100, 65, 35, 1500.50,
            -250.75, 1.85, NOW()
        ) RETURNING id
        """
        cursor.execute(insert_query)
        record_id = cursor.fetchone()['id']
        conn.commit()
        print(f"   ✅ INSERT OK - ID: {record_id}")
        
        # 2. SELECT
        print("   📖 2. Testando SELECT...")
        cursor.execute("SELECT * FROM backtest_results WHERE id = %s", (record_id,))
        record = cursor.fetchone()
        if record:
            print(f"   ✅ SELECT OK - strategy: {record['strategy_name']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE backtest_results 
            SET profit_loss = 1750.25, sharpe_ratio = 2.10 
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT profit_loss, sharpe_ratio FROM backtest_results WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['profit_loss'] == 1750.25 and updated_record['sharpe_ratio'] == 2.10:
            print("   ✅ UPDATE OK")
        else:
            print("   ❌ UPDATE FALHOU")
            
        # 4. DELETE
        print("   🗑️  4. Testando DELETE...")
        cursor.execute("DELETE FROM backtest_results WHERE id = %s", (record_id,))
        conn.commit()
        
        cursor.execute("SELECT * FROM backtest_results WHERE id = %s", (record_id,))
        if cursor.fetchone() is None:
            print("   ✅ DELETE OK")
        else:
            print("   ❌ DELETE FALHOU")
            
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"   ❌ ERRO: {str(e)}")
        return False
    
    return True

def check_table_structure():
    """Verifica se as tabelas existem com a estrutura correta"""
    print("\n📊 VERIFICANDO ESTRUTURA DAS TABELAS")
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verificar tabelas existentes
        cursor.execute("""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('signals_analysis', 'backtest_signals', 'backtest_results')
            ORDER BY table_name
        """)
        
        tables = cursor.fetchall()
        print(f"   📋 Tabelas encontradas: {[t['table_name'] for t in tables]}")
        
        # Verificar se analysis_type existe em signals_analysis
        cursor.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'signals_analysis' 
            AND column_name = 'analysis_type'
        """)
        
        analysis_type_col = cursor.fetchone()
        if analysis_type_col:
            print(f"   ✅ Coluna 'analysis_type' encontrada: {analysis_type_col['data_type']}")
        else:
            print("   ❌ Coluna 'analysis_type' NÃO encontrada")
        
        # Contar registros
        cursor.execute("SELECT COUNT(*) as count FROM signals_analysis")
        signals_count = cursor.fetchone()['count']
        print(f"   📊 Registros em signals_analysis: {signals_count}")
        
        cursor.execute("SELECT COUNT(*) as count FROM backtest_signals")
        backtest_signals_count = cursor.fetchone()['count']
        print(f"   📊 Registros em backtest_signals: {backtest_signals_count}")
        
        cursor.execute("SELECT COUNT(*) as count FROM backtest_results")
        backtest_results_count = cursor.fetchone()['count']
        print(f"   📊 Registros em backtest_results: {backtest_results_count}")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"   ❌ ERRO: {str(e)}")
        return False
    
    return True

def main():
    """Função principal"""
    print("🚀 INICIANDO TESTE DE OPERAÇÕES CRUD NAS TABELAS MODIFICADAS")
    print("=" * 60)
    
    try:
        # Verificar estrutura
        if not check_table_structure():
            print("❌ Falha na verificação da estrutura")
            return
        
        # Testar cada tabela
        success_count = 0
        
        if test_signals_analysis_crud():
            success_count += 1
            
        if test_backtest_signals_crud():
            success_count += 1
            
        if test_backtest_results_crud():
            success_count += 1
        
        print("\n" + "=" * 60)
        print(f"🎯 RESULTADO FINAL: {success_count}/3 tabelas testadas com sucesso")
        
        if success_count == 3:
            print("✅ TODOS OS TESTES PASSARAM!")
        else:
            print("⚠️  ALGUNS TESTES FALHARAM")
            
    except Exception as e:
        print(f"❌ ERRO GERAL: {str(e)}")

if __name__ == "__main__":
    main()
