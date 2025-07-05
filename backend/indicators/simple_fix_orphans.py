#!/usr/bin/env python3
"""
Script simples para corrigir registros órfãos na tabela exchange_filters
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path
import datetime

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def main():
    print("="*60)
    print("🛠️  CORREÇÃO DE REGISTROS ÓRFÃOS - EXCHANGE_FILTERS")
    print("="*60)
    
    try:
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. Verificar registros órfãos
        print("🔍 Verificando registros órfãos...")
        cursor.execute("""
            SELECT COUNT(*) as orphaned_count
            FROM exchange_filters ef
            LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
            WHERE es.id IS NULL
        """)
        
        orphaned_count = cursor.fetchone()['orphaned_count']
        print(f"📊 Registros órfãos encontrados: {orphaned_count}")
        
        if orphaned_count > 0:
            # Mostrar alguns exemplos
            cursor.execute("""
                SELECT ef.id, ef.symbol_id, ef.filter_type
                FROM exchange_filters ef
                LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
                WHERE es.id IS NULL
                ORDER BY ef.symbol_id, ef.filter_type
                LIMIT 5
            """)
            
            examples = cursor.fetchall()
            print("📋 Exemplos de registros órfãos:")
            for example in examples:
                print(f"   - ID: {example['id']}, Symbol_ID: {example['symbol_id']}, Filter: {example['filter_type']}")
            
            # Remover registros órfãos
            print("🧹 Removendo registros órfãos...")
            cursor.execute("""
                DELETE FROM exchange_filters 
                WHERE id IN (
                    SELECT ef.id 
                    FROM exchange_filters ef
                    LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
                    WHERE es.id IS NULL
                )
            """)
            
            deleted_count = cursor.rowcount
            conn.commit()
            print(f"✅ {deleted_count} registros órfãos removidos com sucesso!")
        else:
            print("✅ Nenhum registro órfão encontrado!")
        
        # 2. Verificar integridade final
        print("🔍 Verificando integridade final...")
        cursor.execute("""
            SELECT 
                COUNT(*) as total_filters,
                COUNT(CASE WHEN es.id IS NOT NULL THEN 1 END) as valid_filters,
                COUNT(CASE WHEN es.id IS NULL THEN 1 END) as invalid_filters
            FROM exchange_filters ef
            LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
        """)
        
        stats = cursor.fetchone()
        print(f"📊 Filtros totais: {stats['total_filters']}")
        print(f"📊 Filtros válidos: {stats['valid_filters']}")
        print(f"📊 Filtros inválidos: {stats['invalid_filters']}")
        
        if stats['invalid_filters'] == 0:
            print("✅ Todos os filtros agora têm chaves estrangeiras válidas!")
        else:
            print(f"⚠️  Ainda existem {stats['invalid_filters']} filtros inválidos!")
        
        cursor.close()
        conn.close()
        
        print("="*60)
        print("✅ CORREÇÃO CONCLUÍDA COM SUCESSO!")
        print("="*60)
        
    except Exception as e:
        print(f"❌ Erro: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
