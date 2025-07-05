#!/usr/bin/env python3
"""
Script de Teste para Validação de Booleanos PostgreSQL
Testa se todas as correções estão funcionando corretamente
"""

import os
import sys
import psycopg2
from pathlib import Path
import traceback

# Adicionar diretório pai ao path
sys.path.append(str(Path(__file__).parent))

def test_boolean_queries():
    """Testa queries booleanas específicas"""
    print("🧪 TESTANDO QUERIES BOOLEANAS")
    print("="*50)
    
    # Importar configurações
    try:
        from utils.senhas import get_db_config
        DB_CONFIG = get_db_config()
    except ImportError:
        # Configuração alternativa
        from dotenv import load_dotenv
        import pathlib
        
        env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
        load_dotenv(dotenv_path=env_path)
        
        DB_CONFIG = {
            'host': os.getenv('DB_HOST'),
            'port': int(os.getenv('DB_PORT', 5432)),
            'user': os.getenv('DB_USER'),
            'password': os.getenv('DB_PASSWORD'),
            'database': os.getenv('DB_NAME')
        }
    
    try:
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor()
        
        # Teste 1: Query com parâmetro booleano
        print("📝 Teste 1: Query com parâmetro booleano")
        cursor.execute("SELECT COUNT(*) FROM contas WHERE ativa = %s", (True,))
        result = cursor.fetchone()
        print(f"   ✅ Contas ativas encontradas: {result[0]}")
        
        # Teste 2: INSERT com valores booleanos
        print("📝 Teste 2: INSERT com valores booleanos (simulado)")
        test_query = """
            SELECT %s as test_bool1, %s as test_bool2, %s as test_bool3
        """
        cursor.execute(test_query, (True, False, None))
        result = cursor.fetchone()
        print(f"   ✅ Valores booleanos: {result}")
        
        # Teste 3: Verificar se tabela signals_analysis existe
        print("📝 Teste 3: Verificar estrutura da tabela signals_analysis")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'signals_analysis' 
            AND column_name LIKE '%_divap%' OR column_name LIKE '%confirmed%'
        """)
        columns = cursor.fetchall()
        if columns:
            print("   ✅ Colunas booleanas encontradas:")
            for col in columns:
                print(f"      - {col[0]}: {col[1]} (nullable: {col[2]})")
        else:
            print("   ⚠️ Tabela signals_analysis não encontrada ou sem colunas booleanas")
        
        # Teste 4: Verificar se tabela webhook_signals existe
        print("📝 Teste 4: Verificar estrutura da tabela webhook_signals")
        cursor.execute("""
            SELECT column_name, data_type, is_nullable 
            FROM information_schema.columns 
            WHERE table_name = 'webhook_signals' 
            AND (column_name LIKE '%confirmado%' OR column_name LIKE '%cancelado%')
        """)
        columns = cursor.fetchall()
        if columns:
            print("   ✅ Colunas booleanas encontradas:")
            for col in columns:
                print(f"      - {col[0]}: {col[1]} (nullable: {col[2]})")
        else:
            print("   ⚠️ Tabela webhook_signals não encontrada ou sem colunas booleanas")
        
        cursor.close()
        conn.close()
        
        print("\n✅ TODOS OS TESTES PASSARAM!")
        return True
        
    except Exception as e:
        print(f"\n❌ ERRO NO TESTE: {e}")
        traceback.print_exc()
        return False

def validate_imports():
    """Valida se os imports estão funcionando"""
    print("\n🔍 VALIDANDO IMPORTS")
    print("="*50)
    
    try:
        # Testar import do validador
        from utils.boolean_validator import validate_webhook_signals_data, normalize_boolean
        print("✅ Import do validador de booleanos: OK")
        
        # Testar as funções
        test_data = {'divap_confirmado': 'true', 'cancelado_checker': 0}
        validated = validate_webhook_signals_data(test_data)
        print(f"✅ Validação de dados: {validated}")
        
        # Testar normalização
        normalized = normalize_boolean('true')
        print(f"✅ Normalização: 'true' -> {normalized}")
        
    except ImportError as e:
        print(f"⚠️ Import do validador falhou: {e}")
        return False
    except Exception as e:
        print(f"❌ Erro na validação: {e}")
        return False
    
    return True

def main():
    print("🚀 TESTE DE VALIDAÇÃO DE BOOLEANOS POSTGRESQL")
    print("="*60)
    
    # Teste 1: Validar imports
    imports_ok = validate_imports()
    
    # Teste 2: Validar queries booleanas
    queries_ok = test_boolean_queries()
    
    # Resultado final
    print("\n" + "="*60)
    if imports_ok and queries_ok:
        print("🎉 TODOS OS TESTES PASSARAM!")
        print("   ✅ Imports funcionando corretamente")
        print("   ✅ Queries booleanas funcionando corretamente")
        print("   ✅ Sistema pronto para uso com PostgreSQL")
    else:
        print("❌ ALGUNS TESTES FALHARAM!")
        if not imports_ok:
            print("   ❌ Problema com imports")
        if not queries_ok:
            print("   ❌ Problema com queries booleanas")
    
    print("="*60)

if __name__ == "__main__":
    main()
