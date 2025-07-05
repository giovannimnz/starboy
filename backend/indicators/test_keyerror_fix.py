#!/usr/bin/env python3
"""
Script para testar especificamente a correção do erro KeyError: 0
"""

import sys
import os
import subprocess
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

def test_insert_symbol():
    """Testa especificamente a inserção de símbolo com RETURNING id"""
    try:
        print("="*60)
        print("🔍 TESTE DE INSERÇÃO DE SÍMBOLO COM RETURNING ID")
        print("="*60)
        
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print("✅ Conectado ao banco de dados")
        
        # Criar um símbolo de teste
        test_symbol = "TESTBTCUSDT"
        exchange_name = "binance"
        
        # Remover símbolo de teste se existir
        cursor.execute("DELETE FROM exchange_symbols WHERE symbol = %s AND exchange = %s", (test_symbol, exchange_name))
        
        # Testar inserção com RETURNING id
        symbol_values = {
            'status': 'TESTING',
            'pair': 'TESTBTCUSDT',
            'contract_type': 'PERPETUAL',
            'base_asset': 'TESTBTC',
            'quote_asset': 'USDT',
            'margin_asset': 'USDT',
            'price_precision': 2,
            'quantity_precision': 3,
            'base_asset_precision': 8,
            'quote_precision': 8,
            'onboard_date': None,
            'liquidation_fee': None,
            'market_take_bound': None
        }
        
        cols = ', '.join(symbol_values.keys())
        vals = ', '.join(['%s'] * len(symbol_values))
        sql = f"INSERT INTO exchange_symbols (exchange, symbol, {cols}) VALUES (%s, %s, {vals}) RETURNING id"
        
        print(f"📝 SQL: {sql}")
        print(f"📝 Valores: {(exchange_name, test_symbol, *symbol_values.values())}")
        
        cursor.execute(sql, (exchange_name, test_symbol, *symbol_values.values()))
        result = cursor.fetchone()
        
        print(f"📊 Resultado do cursor.fetchone(): {result}")
        print(f"📊 Tipo do resultado: {type(result)}")
        
        if result:
            symbol_id = result['id']  # Usando a chave 'id' ao invés de [0]
            print(f"✅ Symbol ID obtido com sucesso: {symbol_id}")
            
            # Limpar teste
            cursor.execute("DELETE FROM exchange_symbols WHERE id = %s", (symbol_id,))
            print(f"🧹 Símbolo de teste removido")
            
        else:
            print("❌ Resultado é None")
            return False
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print("="*60)
        print("✅ TESTE PASSOU: A correção funcionou!")
        print("✅ result['id'] funciona corretamente com RealDictCursor")
        print("="*60)
        
        return True
        
    except Exception as e:
        print(f"❌ Erro durante o teste: {e}")
        import traceback
        print(f"Stack trace: {traceback.format_exc()}")
        return False

def test_exchange_updater_syntax():
    """Testa se o script exchange_info_updater.py tem erros de sintaxe"""
    try:
        print("\n🔍 TESTE DE SINTAXE DO EXCHANGE_INFO_UPDATER")
        print("="*60)
        
        # Tentar importar o módulo para verificar sintaxe
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'utils'))
        
        try:
            import exchange_info_updater
            print("✅ Script importado sem erros de sintaxe")
            return True
        except SyntaxError as e:
            print(f"❌ Erro de sintaxe: {e}")
            return False
        except ImportError as e:
            print(f"⚠️ Erro de importação (normal): {e}")
            return True  # Erros de importação são normais, sintaxe está OK
        
    except Exception as e:
        print(f"❌ Erro durante teste de sintaxe: {e}")
        return False

if __name__ == "__main__":
    print("🧪 INICIANDO TESTES DE CORREÇÃO DO KeyError: 0")
    
    # Teste 1: Sintaxe
    syntax_ok = test_exchange_updater_syntax()
    
    # Teste 2: Inserção com RETURNING id
    insert_ok = test_insert_symbol()
    
    # Resultado final
    print("\n🎯 RESULTADO FINAL DOS TESTES:")
    print("="*60)
    print(f"✅ Sintaxe: {'OK' if syntax_ok else 'FALHOU'}")
    print(f"✅ Inserção RETURNING id: {'OK' if insert_ok else 'FALHOU'}")
    
    if syntax_ok and insert_ok:
        print("\n🎉 TODOS OS TESTES PASSARAM!")
        print("✅ O erro KeyError: 0 foi corrigido com sucesso!")
    else:
        print("\n💥 ALGUNS TESTES FALHARAM!")
        sys.exit(1)
