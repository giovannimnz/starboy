#!/usr/bin/env python3
"""
Script simples para testar a conectividade e verificar se o erro de chave estrangeira foi corrigido.
"""

import sys
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
import pathlib

# Carregar variáveis de ambiente
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco
DB_CONFIG = {
    "host": os.getenv('DB_HOST'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASSWORD'),
    "database": os.getenv('DB_NAME'),
    "port": int(os.getenv('DB_PORT', 5432))
}

def test_exchange_consistency():
    """Testa a consistência das tabelas de exchange"""
    try:
        print("="*60)
        print("🔍 TESTE DE CONSISTÊNCIA DAS TABELAS DE EXCHANGE")
        print("="*60)
        
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print("✅ Conectado ao banco de dados")
        
        # 1. Verificar registros órfãos em exchange_filters
        cursor.execute("""
            SELECT COUNT(*) as orphaned_filters 
            FROM exchange_filters ef
            LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
            WHERE es.id IS NULL
        """)
        orphaned_filters = cursor.fetchone()['orphaned_filters']
        
        print(f"📊 Registros órfãos em exchange_filters: {orphaned_filters}")
        
        # 2. Verificar totais
        cursor.execute("SELECT COUNT(*) as total_symbols FROM exchange_symbols")
        total_symbols = cursor.fetchone()['total_symbols']
        
        cursor.execute("SELECT COUNT(*) as total_filters FROM exchange_filters")
        total_filters = cursor.fetchone()['total_filters']
        
        print(f"📊 Total de símbolos: {total_symbols}")
        print(f"📊 Total de filtros: {total_filters}")
        
        # 3. Verificar se há symbol_id = 0 ou NULL
        cursor.execute("""
            SELECT COUNT(*) as invalid_symbol_ids 
            FROM exchange_filters 
            WHERE symbol_id IS NULL OR symbol_id <= 0
        """)
        invalid_symbol_ids = cursor.fetchone()['invalid_symbol_ids']
        
        print(f"📊 Filtros com symbol_id inválido: {invalid_symbol_ids}")
        
        # 4. Verificar integridade das chaves estrangeiras
        cursor.execute("""
            SELECT COUNT(*) as valid_filters 
            FROM exchange_filters ef
            INNER JOIN exchange_symbols es ON ef.symbol_id = es.id
        """)
        valid_filters = cursor.fetchone()['valid_filters']
        
        print(f"📊 Filtros válidos (com chave estrangeira correta): {valid_filters}")
        
        # Resultado final
        print("="*60)
        if orphaned_filters == 0 and invalid_symbol_ids == 0:
            print("✅ TESTE PASSOU: Não há problemas de integridade!")
            print("✅ O erro de chave estrangeira foi corrigido!")
        else:
            print("❌ TESTE FALHOU: Ainda há problemas de integridade")
            if orphaned_filters > 0:
                print(f"   - {orphaned_filters} registros órfãos encontrados")
            if invalid_symbol_ids > 0:
                print(f"   - {invalid_symbol_ids} symbol_id inválidos encontrados")
        
        print("="*60)
        
        cursor.close()
        conn.close()
        
        return orphaned_filters == 0 and invalid_symbol_ids == 0
        
    except Exception as e:
        print(f"❌ Erro durante o teste: {e}")
        return False

if __name__ == "__main__":
    success = test_exchange_consistency()
    if success:
        print("\n🎉 Teste de consistência passou! O erro foi corrigido.")
    else:
        print("\n💥 Teste de consistência falhou! Ainda há problemas.")
        sys.exit(1)
