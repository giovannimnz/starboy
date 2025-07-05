#!/usr/bin/env python3
"""
Script de teste para validar as mudanças estruturais no banco de dados
e no sistema de backtest DIVAP
"""

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path
import os
from datetime import datetime
import sys

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

def test_database_structure():
    """Testa a estrutura do banco de dados"""
    print("="*60)
    print("🧪 TESTE DA ESTRUTURA DO BANCO DE DADOS")
    print("="*60)
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. Verificar se signals_analysis tem a coluna analysis_type
        print("\n1. Testando tabela signals_analysis:")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'signals_analysis' 
            AND column_name = 'analysis_type'
        """)
        result = cursor.fetchone()
        if result:
            print(f"   ✅ Coluna analysis_type: {result['data_type']}")
        else:
            print("   ❌ Coluna analysis_type não encontrada")
        
        # 2. Verificar se backtest_signals tem a coluna signal_datetime
        print("\n2. Testando tabela backtest_signals:")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'backtest_signals' 
            AND column_name = 'signal_datetime'
        """)
        result = cursor.fetchone()
        if result:
            print(f"   ✅ Coluna signal_datetime: {result['data_type']}")
        else:
            print("   ❌ Coluna signal_datetime não encontrada")
        
        # 3. Verificar estrutura da tabela backtest_results
        print("\n3. Testando tabela backtest_results:")
        required_columns = [
            'symbol', 'initial_capital', 'final_capital', 'entry_price', 
            'entry_fee', 'strategy', 'third_to_last_tp', 'last_tp'
        ]
        
        cursor.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'backtest_results'
        """)
        existing_columns = [row['column_name'] for row in cursor.fetchall()]
        
        for col in required_columns:
            if col in existing_columns:
                print(f"   ✅ Coluna {col}: OK")
            else:
                print(f"   ❌ Coluna {col}: FALTANDO")
        
        # 4. Testar inserção em signals_analysis
        print("\n4. Testando inserção em signals_analysis:")
        try:
            cursor.execute("""
                INSERT INTO signals_analysis (
                    signal_id, divap_confirmed, analysis_type, analyzed_at
                ) VALUES (9999, true, 'backtest', %s)
                RETURNING id
            """, (datetime.now(),))
            
            analysis_id = cursor.fetchone()['id']
            print(f"   ✅ Inserção bem-sucedida - ID: {analysis_id}")
            
            # Limpar teste
            cursor.execute("DELETE FROM signals_analysis WHERE id = %s", (analysis_id,))
            
        except Exception as e:
            print(f"   ❌ Erro na inserção: {e}")
        
        # 5. Testar inserção em backtest_signals
        print("\n5. Testando inserção em backtest_signals:")
        try:
            cursor.execute("""
                INSERT INTO backtest_signals (
                    symbol, side, entry_price, signal_datetime, 
                    divap_confirmado, cancelado_checker
                ) VALUES (
                    'BTCUSDT', 'COMPRA', 50000.0, %s, true, false
                )
                RETURNING id
            """, (datetime.now(),))
            
            backtest_id = cursor.fetchone()['id']
            print(f"   ✅ Inserção bem-sucedida - ID: {backtest_id}")
            
            # Limpar teste
            cursor.execute("DELETE FROM backtest_signals WHERE id = %s", (backtest_id,))
            
        except Exception as e:
            print(f"   ❌ Erro na inserção: {e}")
        
        # 6. Testar inserção em backtest_results
        print("\n6. Testando inserção em backtest_results:")
        try:
            cursor.execute("""
                INSERT INTO backtest_results (
                    symbol, initial_capital, final_capital, total_pnl,
                    entry_price, entry_fee, strategy
                ) VALUES (
                    'BTCUSDT', 1000.0, 1050.0, 50.0, 50000.0, 1.0, 'reverse_trailling_13'
                )
                RETURNING id
            """)
            
            result_id = cursor.fetchone()['id']
            print(f"   ✅ Inserção bem-sucedida - ID: {result_id}")
            
            # Limpar teste
            cursor.execute("DELETE FROM backtest_results WHERE id = %s", (result_id,))
            
        except Exception as e:
            print(f"   ❌ Erro na inserção: {e}")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print("\n" + "="*60)
        print("✅ TESTE DA ESTRUTURA CONCLUÍDO")
        print("="*60)
        
    except Exception as e:
        print(f"\n❌ Erro no teste: {e}")
        return False
    
    return True

def test_divap_backtest_import():
    """Testa se o módulo divap_backtest pode ser importado"""
    print("\n" + "="*60)
    print("🧪 TESTE DE IMPORTAÇÃO DO DIVAP_BACKTEST")
    print("="*60)
    
    try:
        # Adicionar o caminho para o módulo
        backend_path = Path(__file__).parents[1] / 'backend' / 'indicators'
        sys.path.insert(0, str(backend_path))
        
        # Tentar importar
        import divap_backtest
        print("✅ Módulo divap_backtest importado com sucesso")
        
        # Verificar se as classes existem
        if hasattr(divap_backtest, 'BacktestEngine'):
            print("✅ Classe BacktestEngine encontrada")
        else:
            print("❌ Classe BacktestEngine não encontrada")
        
        # Verificar se as estratégias estão definidas
        if hasattr(divap_backtest, 'STRATEGIES'):
            strategies = divap_backtest.STRATEGIES
            print(f"✅ Estratégias disponíveis: {len(strategies)}")
            for key, strategy in strategies.items():
                print(f"   - {key}: {strategy['name']}")
        else:
            print("❌ Estratégias não definidas")
        
        print("\n✅ TESTE DE IMPORTAÇÃO CONCLUÍDO")
        return True
        
    except Exception as e:
        print(f"❌ Erro na importação: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Função principal de teste"""
    print("\n🧪 INICIANDO TESTES DE VALIDAÇÃO")
    print("Verificando se as mudanças estruturais foram aplicadas corretamente...")
    
    # Executar testes
    test1_passed = test_database_structure()
    test2_passed = test_divap_backtest_import()
    
    # Resultado final
    print("\n" + "="*60)
    print("📊 RESUMO DOS TESTES")
    print("="*60)
    print(f"Estrutura do banco: {'✅ PASSOU' if test1_passed else '❌ FALHOU'}")
    print(f"Importação do módulo: {'✅ PASSOU' if test2_passed else '❌ FALHOU'}")
    
    if test1_passed and test2_passed:
        print("\n🎉 TODOS OS TESTES PASSARAM!")
        print("O sistema está pronto para uso.")
    else:
        print("\n⚠️  ALGUNS TESTES FALHARAM!")
        print("Verifique os erros acima antes de continuar.")
    
    print("="*60)

if __name__ == "__main__":
    main()
