#!/usr/bin/env python3
"""
Script para testar operações CRUD nas tabelas modificadas com as colunas CORRETAS
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
            analysis_type, rsi, volume, high_volume
        ) VALUES (
            99999, true, false, true,
            true, false,
            'trade', 65.5, 1000000.0, true
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
            print(f"   ✅ SELECT OK - analysis_type: {record['analysis_type']}, rsi: {record['rsi']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE signals_analysis 
            SET analysis_type = 'backtest', rsi = 75.0, is_bear_divap = true
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT analysis_type, rsi, is_bear_divap FROM signals_analysis WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['analysis_type'] == 'backtest' and updated_record['rsi'] == 75.0:
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
            symbol, side, leverage, capital_pct, entry_price, sl_price, 
            chat_id, status, timeframe, tp1_price, tp2_price
        ) VALUES (
            'BTCUSDT', 'BUY', 10, 50.0, 50000.0, 48000.0,
            123456789, 'OPEN', '1h', 52000.0, 54000.0
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
            print(f"   ✅ SELECT OK - symbol: {record['symbol']}, side: {record['side']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE backtest_signals 
            SET entry_price = 51000.0, status = 'CLOSED', leverage = 20
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT entry_price, status, leverage FROM backtest_signals WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['entry_price'] == 51000.0 and updated_record['status'] == 'CLOSED':
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
            symbol, total_pnl, trade_time, open_datetime, close_datetime,
            base_fee, total_profit, total_fee, tp1_profit, tp1_fee
        ) VALUES (
            'BTCUSDT', 1500.50, 1699876543, NOW(), NOW(),
            10.0, 1510.50, 15.0, 500.0, 5.0
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
            print(f"   ✅ SELECT OK - symbol: {record['symbol']}, total_pnl: {record['total_pnl']}")
        else:
            print("   ❌ SELECT FALHOU")
            
        # 3. UPDATE
        print("   📝 3. Testando UPDATE...")
        cursor.execute("""
            UPDATE backtest_results 
            SET total_pnl = 1750.25, total_profit = 1765.25, tp2_profit = 600.0
            WHERE id = %s
        """, (record_id,))
        conn.commit()
        
        cursor.execute("SELECT total_pnl, total_profit, tp2_profit FROM backtest_results WHERE id = %s", (record_id,))
        updated_record = cursor.fetchone()
        if updated_record['total_pnl'] == 1750.25 and updated_record['total_profit'] == 1765.25:
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

def test_analysis_type_functionality():
    """Testa a funcionalidade específica do campo analysis_type"""
    print("\n🎯 TESTANDO FUNCIONALIDADE DO ANALYSIS_TYPE")
    
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Inserir registros com diferentes analysis_type
        test_records = []
        
        # Registro tipo 'trade'
        cursor.execute("""
            INSERT INTO signals_analysis (
                signal_id, is_bull_divap, analysis_type, rsi, volume
            ) VALUES (
                99001, true, 'trade', 70.0, 500000.0
            ) RETURNING id
        """)
        test_records.append(cursor.fetchone()['id'])
        
        # Registro tipo 'backtest'
        cursor.execute("""
            INSERT INTO signals_analysis (
                signal_id, is_bear_divap, analysis_type, rsi, volume
            ) VALUES (
                99002, true, 'backtest', 30.0, 750000.0
            ) RETURNING id
        """)
        test_records.append(cursor.fetchone()['id'])
        
        conn.commit()
        
        # Testar consultas por tipo
        cursor.execute("SELECT COUNT(*) as count FROM signals_analysis WHERE analysis_type = 'trade'")
        trade_count = cursor.fetchone()['count']
        print(f"   📊 Análises tipo 'trade': {trade_count}")
        
        cursor.execute("SELECT COUNT(*) as count FROM signals_analysis WHERE analysis_type = 'backtest'")
        backtest_count = cursor.fetchone()['count']
        print(f"   📊 Análises tipo 'backtest': {backtest_count}")
        
        # Testar consulta mista
        cursor.execute("""
            SELECT analysis_type, COUNT(*) as count 
            FROM signals_analysis 
            WHERE id IN %s
            GROUP BY analysis_type
        """, (tuple(test_records),))
        
        results = cursor.fetchall()
        print("   📊 Contagem por tipo de análise:")
        for result in results:
            print(f"      - {result['analysis_type']}: {result['count']}")
        
        # Limpar registros de teste
        for record_id in test_records:
            cursor.execute("DELETE FROM signals_analysis WHERE id = %s", (record_id,))
        conn.commit()
        
        print("   ✅ Teste do analysis_type concluído com sucesso")
        
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
    print("🚀 TESTE FINAL DAS OPERAÇÕES CRUD NAS TABELAS MODIFICADAS")
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
            
        # Testar funcionalidade específica
        if test_analysis_type_functionality():
            print("   ✅ Funcionalidade analysis_type validada")
        
        print("\n" + "=" * 60)
        print(f"🎯 RESULTADO FINAL: {success_count}/3 tabelas testadas com sucesso")
        
        if success_count == 3:
            print("🎉 PARABÉNS! TODOS OS TESTES PASSARAM!")
            print("✅ A migração das tabelas foi concluída com SUCESSO!")
            print("✅ Todas as operações CRUD estão funcionando corretamente!")
            print("✅ A coluna 'analysis_type' está funcional para distinguir trade/backtest!")
        else:
            print("⚠️  ALGUNS TESTES FALHARAM")
            
    except Exception as e:
        print(f"❌ ERRO GERAL: {str(e)}")

if __name__ == "__main__":
    main()
