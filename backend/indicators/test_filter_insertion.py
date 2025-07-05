#!/usr/bin/env python3
"""
Script para testar inserção de filtros após correção
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pathlib import Path
import datetime

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def test_filter_insertion():
    print("🧪 TESTE DE INSERÇÃO DE FILTROS")
    print("="*50)
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # 1. Verificar se existe algum símbolo para teste
        cursor.execute("SELECT id, symbol FROM exchange_symbols WHERE exchange = 'binance' LIMIT 1")
        symbol_row = cursor.fetchone()
        
        if not symbol_row:
            print("❌ Nenhum símbolo encontrado para teste")
            return False
        
        symbol_id = symbol_row['id']
        symbol_name = symbol_row['symbol']
        
        print(f"🎯 Testando com símbolo: {symbol_name} (ID: {symbol_id})")
        
        # 2. Verificar se já existe filtro para esse símbolo
        cursor.execute("""
            SELECT COUNT(*) as count 
            FROM exchange_filters 
            WHERE symbol_id = %s AND filter_type = 'TEST_FILTER'
        """, (symbol_id,))
        
        existing_count = cursor.fetchone()['count']
        
        if existing_count > 0:
            print(f"🧹 Removendo filtro de teste existente...")
            cursor.execute("DELETE FROM exchange_filters WHERE symbol_id = %s AND filter_type = 'TEST_FILTER'", (symbol_id,))
            conn.commit()
        
        # 3. Tentar inserir um filtro de teste
        print(f"➕ Inserindo filtro de teste...")
        filter_data = {
            'symbol_id': symbol_id,
            'filter_type': 'TEST_FILTER',
            'min_price': '0.01',
            'max_price': '100000.00',
            'tick_size': '0.01'
        }
        
        cols = ', '.join(filter_data.keys())
        vals = ', '.join(['%s'] * len(filter_data))
        sql = f"INSERT INTO exchange_filters ({cols}) VALUES ({vals})"
        
        cursor.execute(sql, tuple(filter_data.values()))
        conn.commit()
        
        print(f"✅ Filtro de teste inserido com sucesso!")
        
        # 4. Verificar se foi inserido corretamente
        cursor.execute("""
            SELECT * FROM exchange_filters 
            WHERE symbol_id = %s AND filter_type = 'TEST_FILTER'
        """, (symbol_id,))
        
        inserted_filter = cursor.fetchone()
        if inserted_filter:
            print(f"✅ Filtro verificado: ID {inserted_filter['id']}")
        else:
            print(f"❌ Filtro não foi encontrado após inserção")
            return False
        
        # 5. Limpar o teste
        print(f"🧹 Limpando filtro de teste...")
        cursor.execute("DELETE FROM exchange_filters WHERE symbol_id = %s AND filter_type = 'TEST_FILTER'", (symbol_id,))
        conn.commit()
        
        cursor.close()
        conn.close()
        
        print("="*50)
        print("✅ TESTE DE INSERÇÃO CONCLUÍDO COM SUCESSO!")
        print("="*50)
        
        return True
        
    except Exception as e:
        print(f"❌ Erro no teste: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = test_filter_insertion()
    if success:
        print("\n✅ O problema de chave estrangeira foi corrigido!")
    else:
        print("\n❌ Ainda há problemas com a inserção de filtros!")
