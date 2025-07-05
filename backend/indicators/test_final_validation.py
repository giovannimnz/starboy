#!/usr/bin/env python3
"""
Script de teste final para validar que o erro KeyError: 0 foi corrigido
"""

import os
import sys
import pathlib
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

# Carregar variáveis de ambiente do arquivo correto
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'

# Limpar variáveis existentes
for key in ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']:
    if key in os.environ:
        del os.environ[key]

load_dotenv(dotenv_path=env_path, override=True)

print('🔧 TESTE FINAL - VALIDAÇÃO DA CORREÇÃO KeyError: 0')
print('=' * 70)

# Configurações do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

print(f'📊 Configurações do banco:')
print(f'   Host: {DB_CONFIG["host"]}')
print(f'   Port: {DB_CONFIG["port"]}')
print(f'   Database: {DB_CONFIG["database"]}')

def test_returning_id_syntax():
    """Teste específico para verificar se result['id'] funciona"""
    try:
        print('\n🧪 TESTE: Inserção com RETURNING id')
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Remover símbolo de teste se existir
        cursor.execute("DELETE FROM exchange_symbols WHERE symbol = 'TEST_KEYERROR_FIX'")
        
        # Testar inserção com RETURNING id
        sql = """
        INSERT INTO exchange_symbols (exchange, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset,
                                    price_precision, quantity_precision, base_asset_precision, quote_precision)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """
        
        values = ('binance', 'TEST_KEYERROR_FIX', 'TESTING', 'TEST', 'PERPETUAL', 
                 'TEST', 'USDT', 'USDT', 2, 3, 8, 8)
        
        cursor.execute(sql, values)
        result = cursor.fetchone()
        
        # ESTE É O TESTE CRÍTICO - DEVE SER result['id'] E NÃO result[0]
        symbol_id = result['id'] if result else None
        
        print(f'   ✅ result["id"] funciona: {symbol_id}')
        print(f'   ✅ Tipo do resultado: {type(result)}')
        
        # Limpar teste
        cursor.execute("DELETE FROM exchange_symbols WHERE symbol = 'TEST_KEYERROR_FIX'")
        conn.commit()
        cursor.close()
        conn.close()
        
        return True
        
    except KeyError as e:
        print(f'   ❌ ERRO KeyError: {e}')
        return False
    except Exception as e:
        print(f'   ❌ ERRO: {e}')
        return False

def test_exchange_info_updater():
    """Teste da função completa do exchange_info_updater"""
    try:
        print('\n🚀 TESTE: Execução do exchange_info_updater')
        
        # Importar e executar
        sys.path.append(str(pathlib.Path(__file__).parent / 'utils'))
        from backend.indicators.utils.exchange_info_updater import update_exchange_info_database
        
        # Executar com dados limitados para teste
        result = update_exchange_info_database('binance')
        print(f'   ✅ Execução concluída: {result}')
        return True
        
    except Exception as e:
        print(f'   ❌ ERRO na execução: {e}')
        import traceback
        traceback.print_exc()
        return False

def main():
    # Teste 1: Verificar sintaxe RETURNING id
    test1_ok = test_returning_id_syntax()
    
    # Teste 2: Executar função completa
    test2_ok = test_exchange_info_updater()
    
    # Resultado final
    print('\n' + '=' * 70)
    print('🎯 RESULTADO FINAL DOS TESTES:')
    print('=' * 70)
    print(f'✅ Sintaxe RETURNING id: {"OK" if test1_ok else "FALHOU"}')
    print(f'✅ Execução completa: {"OK" if test2_ok else "FALHOU"}')
    
    if test1_ok and test2_ok:
        print('\n🎉 TODOS OS TESTES PASSARAM!')
        print('✅ O erro KeyError: 0 foi corrigido com sucesso!')
    else:
        print('\n❌ ALGUNS TESTES FALHARAM!')
        print('⚠️ O erro KeyError: 0 ainda pode estar presente')

if __name__ == '__main__':
    main()
