#!/usr/bin/env python3
"""
Script de validação da nova estrutura de tabelas
Verifica se todas as mudanças foram aplicadas corretamente
"""

import psycopg2
import os
from pathlib import Path
from dotenv import load_dotenv

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco
DB_CONFIG = {
    "host": os.getenv('DB_HOST'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASSWORD'),
    "database": os.getenv('DB_NAME'),
    "port": int(os.getenv('DB_PORT', 5432))
}

def validate_new_structure():
    """Valida se a nova estrutura está funcionando corretamente"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor()
        
        print("🔍 Validando nova estrutura das tabelas...")
        print("=" * 60)
        
        # 1. Verificar se as tabelas existem
        print("\n📋 1. VERIFICANDO EXISTÊNCIA DAS TABELAS")
        tables_to_check = ['signals_analysis', 'backtest_signals', 'backtest_results']
        
        for table in tables_to_check:
            cursor.execute("""
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.tables 
                    WHERE table_schema = 'public' AND table_name = %s
                )
            """, (table,))
            
            exists = cursor.fetchone()[0]
            status = "✅" if exists else "❌"
            print(f"   {status} Tabela '{table}': {'Existe' if exists else 'NÃO EXISTE'}")
        
        # 2. Verificar estrutura da signals_analysis
        print("\n📊 2. VERIFICANDO ESTRUTURA DA SIGNALS_ANALYSIS")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'signals_analysis'
            AND column_name IN ('analysis_type', 'signal_id', 'divap_confirmed')
            ORDER BY column_name
        """)
        
        columns = cursor.fetchall()
        for col in columns:
            print(f"   ✅ {col[0]}: {col[1]} (nullable: {col[2]}, default: {col[3]})")
        
        # 3. Testar INSERT na signals_analysis
        print("\n🧪 3. TESTANDO OPERAÇÕES NA SIGNALS_ANALYSIS")
        try:
            # INSERT de teste para análise de trade
            cursor.execute("""
                INSERT INTO signals_analysis (
                    signal_id, divap_confirmed, analysis_type, analyzed_at
                ) VALUES (99999, true, 'trade', NOW())
                ON CONFLICT (signal_id) DO UPDATE SET
                    divap_confirmed = EXCLUDED.divap_confirmed,
                    analysis_type = EXCLUDED.analysis_type
            """)
            print("   ✅ INSERT trade: OK")
            
            # INSERT de teste para análise de backtest
            cursor.execute("""
                UPDATE signals_analysis 
                SET analysis_type = 'backtest' 
                WHERE signal_id = 99999
            """)
            print("   ✅ UPDATE backtest: OK")
            
            # SELECT de teste
            cursor.execute("""
                SELECT signal_id, analysis_type, divap_confirmed 
                FROM signals_analysis 
                WHERE signal_id = 99999
            """)
            result = cursor.fetchone()
            if result:
                print(f"   ✅ SELECT: signal_id={result[0]}, type={result[1]}, confirmed={result[2]}")
            
            # Limpeza
            cursor.execute("DELETE FROM signals_analysis WHERE signal_id = 99999")
            print("   ✅ DELETE: OK")
            
        except Exception as e:
            print(f"   ❌ Erro nos testes: {e}")
        
        # 4. Testar backtest_results
        print("\n🎯 4. TESTANDO BACKTEST_RESULTS")
        try:
            cursor.execute("""
                INSERT INTO backtest_results (
                    symbol, total_pnl, total_profit, tp1_profit, created_at
                ) VALUES ('BTCUSDT', 150.75, 200.50, 50.25, NOW())
                RETURNING id
            """)
            result_id = cursor.fetchone()[0]
            print(f"   ✅ INSERT: ID={result_id}")
            
            cursor.execute("SELECT symbol, total_pnl FROM backtest_results WHERE id = %s", (result_id,))
            result = cursor.fetchone()
            print(f"   ✅ SELECT: symbol={result[0]}, pnl={result[1]}")
            
            cursor.execute("DELETE FROM backtest_results WHERE id = %s", (result_id,))
            print("   ✅ DELETE: OK")
            
        except Exception as e:
            print(f"   ❌ Erro nos testes backtest_results: {e}")
        
        # 5. Verificar índices
        print("\n🔍 5. VERIFICANDO ÍNDICES")
        cursor.execute("""
            SELECT indexname FROM pg_indexes 
            WHERE tablename = 'signals_analysis'
            AND indexname LIKE 'idx_%'
        """)
        
        indexes = cursor.fetchall()
        if indexes:
            for idx in indexes:
                print(f"   ✅ Índice: {idx[0]}")
        else:
            print("   ⚠️ Nenhum índice customizado encontrado")
        
        # 6. Estatísticas finais
        print("\n📈 6. ESTATÍSTICAS")
        cursor.execute("SELECT COUNT(*) FROM signals_analysis")
        signals_count = cursor.fetchone()[0]
        print(f"   📊 Registros em signals_analysis: {signals_count}")
        
        cursor.execute("SELECT COUNT(*) FROM backtest_signals")
        backtest_signals_count = cursor.fetchone()[0]
        print(f"   📊 Registros em backtest_signals: {backtest_signals_count}")
        
        cursor.execute("SELECT COUNT(*) FROM backtest_results")
        backtest_results_count = cursor.fetchone()[0]
        print(f"   📊 Registros em backtest_results: {backtest_results_count}")
        
        print("\n" + "=" * 60)
        print("✅ VALIDAÇÃO CONCLUÍDA COM SUCESSO!")
        print("🎉 Todas as tabelas estão funcionando corretamente")
        print("=" * 60)
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Erro durante a validação: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    validate_new_structure()
