#!/usr/bin/env python3
"""
Script para verificar e corrigir inconsistências nas tabelas exchange_symbols e exchange_filters.
Este script:
1. Verifica se há registros órfãos em exchange_filters (symbol_id que não existe em exchange_symbols)
2. Remove registros órfãos se encontrados
3. Verifica integridade das chaves estrangeiras
4. Relata estatísticas finais
"""

import datetime
import sys
import os
import traceback

# Adicionar o diretório backend/indicators ao Python path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'utils'))

import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': os.getenv('DB_PORT', 5432),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def get_postgres_connection():
    """Cria uma conexão com o banco PostgreSQL"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        return conn
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DB] Erro ao conectar: {e}")
        return None

def fix_exchange_consistency():
    """
    Verifica e corrige inconsistências nas tabelas de exchange
    """
    print("="*80)
    print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] Iniciando verificação de consistência...")
    print("="*80)
    
    try:
        # Conectar ao banco
        conn = get_postgres_connection()
        if not conn:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ❌ Erro: Não foi possível conectar ao banco")
            return False
        
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. VERIFICAR REGISTROS ÓRFÃOS EM exchange_filters
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 🔍 Verificando registros órfãos...")
        
        cursor.execute("""
            SELECT COUNT(*) as total_filters 
            FROM exchange_filters
        """)
        total_filters = cursor.fetchone()['total_filters']
        
        cursor.execute("""
            SELECT COUNT(*) as orphaned_filters 
            FROM exchange_filters ef
            LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
            WHERE es.id IS NULL
        """)
        orphaned_filters = cursor.fetchone()['orphaned_filters']
        
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Total de filtros: {total_filters}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Filtros órfãos: {orphaned_filters}")
        
        if orphaned_filters > 0:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ⚠️ Encontrados {orphaned_filters} registros órfãos em exchange_filters")
            
            # Mostrar detalhes dos registros órfãos
            cursor.execute("""
                SELECT ef.id, ef.symbol_id, ef.filter_type 
                FROM exchange_filters ef
                LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id
                WHERE es.id IS NULL
                ORDER BY ef.symbol_id, ef.filter_type
                LIMIT 10
            """)
            
            orphaned_details = cursor.fetchall()
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📋 Amostra de registros órfãos:")
            for record in orphaned_details:
                print(f"   - ID: {record['id']}, Symbol_ID: {record['symbol_id']}, Filter: {record['filter_type']}")
            
            # Confirmar remoção
            response = input("Deseja remover os registros órfãos? (s/N): ").strip().lower()
            if response in ['s', 'sim', 'y', 'yes']:
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
                print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ✅ {deleted_count} registros órfãos removidos")
            else:
                print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ⏭️ Remoção cancelada pelo usuário")
        
        # 2. VERIFICAR INTEGRIDADE DAS CHAVES ESTRANGEIRAS
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 🔍 Verificando integridade das chaves estrangeiras...")
        
        cursor.execute("""
            SELECT COUNT(*) as total_symbols 
            FROM exchange_symbols
        """)
        total_symbols = cursor.fetchone()['total_symbols']
        
        cursor.execute("""
            SELECT COUNT(DISTINCT ef.symbol_id) as symbols_with_filters 
            FROM exchange_filters ef
            INNER JOIN exchange_symbols es ON ef.symbol_id = es.id
        """)
        symbols_with_filters = cursor.fetchone()['symbols_with_filters']
        
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Total de símbolos: {total_symbols}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Símbolos com filtros: {symbols_with_filters}")
        
        # 3. VERIFICAR DISTRIBUIÇÃO DE FILTROS POR EXCHANGE
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 🔍 Verificando distribuição por exchange...")
        
        cursor.execute("""
            SELECT es.exchange, 
                   COUNT(DISTINCT es.id) as total_symbols,
                   COUNT(ef.id) as total_filters,
                   COUNT(ef.id)::float / COUNT(DISTINCT es.id) as avg_filters_per_symbol
            FROM exchange_symbols es
            LEFT JOIN exchange_filters ef ON es.id = ef.symbol_id
            GROUP BY es.exchange
            ORDER BY es.exchange
        """)
        
        exchange_stats = cursor.fetchall()
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Estatísticas por exchange:")
        for stat in exchange_stats:
            print(f"   - {stat['exchange']}: {stat['total_symbols']} símbolos, {stat['total_filters']} filtros, {stat['avg_filters_per_symbol']:.2f} filtros/símbolo")
        
        # 4. VERIFICAR VALORES INVÁLIDOS
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 🔍 Verificando valores inválidos...")
        
        cursor.execute("""
            SELECT COUNT(*) as invalid_symbol_ids 
            FROM exchange_filters 
            WHERE symbol_id IS NULL OR symbol_id <= 0
        """)
        invalid_symbol_ids = cursor.fetchone()['invalid_symbol_ids']
        
        if invalid_symbol_ids > 0:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ⚠️ Encontrados {invalid_symbol_ids} registros com symbol_id inválido")
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ✅ Todos os symbol_id são válidos")
        
        # 5. ESTATÍSTICAS FINAIS
        cursor.execute("""
            SELECT COUNT(*) as final_total_filters 
            FROM exchange_filters ef
            INNER JOIN exchange_symbols es ON ef.symbol_id = es.id
        """)
        final_total_filters = cursor.fetchone()['final_total_filters']
        
        print("="*80)
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ✅ Verificação de consistência concluída")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] 📊 Filtros válidos finais: {final_total_filters}")
        print("="*80)
        
        cursor.close()
        conn.close()
        return True
        
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] ❌ Erro crítico: {e}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-FIX] Stack trace: {traceback.format_exc()}")
        return False

if __name__ == "__main__":
    success = fix_exchange_consistency()
    if success:
        print("\n✅ Script de correção de consistência executado com sucesso!")
    else:
        print("\n❌ Script de correção de consistência falhou!")
        sys.exit(1)
