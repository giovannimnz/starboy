#!/usr/bin/env python3
"""
Script para debug detalhado do exchange_info_updater
"""

import os
import time
import datetime
import traceback
import requests
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
import pathlib
import warnings
import logging

# Carregar variáveis de ambiente
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'

# Limpar variáveis existentes
for key in ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']:
    if key in os.environ:
        del os.environ[key]

load_dotenv(dotenv_path=env_path, override=True)

print('🔧 INICIANDO DEBUG DO EXCHANGE_INFO_UPDATER')
print('=' * 60)

# Configuração de logging
logging.basicConfig(level=logging.INFO)
warnings.filterwarnings("ignore", category=DeprecationWarning)

# API URL da Binance Futures
API_URL = "https://fapi.binance.com/fapi"

# Configurações do banco de dados
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

def get_database_connection():
    """Obtém conexão com o banco de dados PostgreSQL."""
    try:
        print('🔌 Tentando conectar ao banco...')
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        print('✅ Conexão estabelecida!')
        return conn
    except psycopg2.Error as e:
        print(f'❌ Erro ao conectar: {e}')
        return None

def make_binance_request(endpoint, params=None):
    """Faz requisição pública para a API Binance."""
    try:
        print(f'🌐 Fazendo requisição para: {API_URL}{endpoint}')
        url = f"{API_URL}{endpoint}"
        response = requests.get(url, params=params, timeout=30)
        
        if response.status_code == 200:
            data = response.json()
            print(f'✅ Resposta recebida: {len(data.get("symbols", []))} símbolos')
            return data
        else:
            print(f'❌ Erro HTTP {response.status_code}: {response.text}')
            return None
            
    except requests.exceptions.Timeout:
        print('❌ Timeout na requisição')
        return None
    except Exception as e:
        print(f'❌ Erro na requisição: {e}')
        return None

def update_exchange_info_database_debug():
    """Versão debug da função de atualização."""
    try:
        print('\n📥 FASE 1: OBTENDO DADOS DA BINANCE')
        info_data = make_binance_request('/v1/exchangeInfo')
        
        if not info_data or 'symbols' not in info_data:
            print('❌ Resposta inválida da API Binance')
            return False
        
        api_symbols_map = {s['symbol']: s for s in info_data['symbols']}
        print(f'📊 Símbolos obtidos da API: {len(api_symbols_map)}')

        print('\n🔌 FASE 2: CONECTANDO AO BANCO')
        conn = get_database_connection()
        if not conn:
            return False
        
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print('\n📊 FASE 3: OBTENDO DADOS DO BANCO')
        cursor.execute("""
        SELECT id, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset,
               price_precision, quantity_precision, base_asset_precision, quote_precision,
               onboard_date, liquidation_fee, market_take_bound
        FROM exchange_symbols WHERE exchange = %s
        """, ('binance',))
        db_symbols = cursor.fetchall()
        db_symbols_map = {row['symbol']: row for row in db_symbols}
        print(f'📊 Símbolos no banco: {len(db_symbols_map)}')
        
        print('\n🔄 FASE 4: PROCESSANDO DIFERENÇAS...')
        inserts, updates = 0, 0
        
        # Processar apenas os primeiros 5 símbolos para teste
        symbols_to_process = list(api_symbols_map.items())[:5]
        print(f'🎯 Processando {len(symbols_to_process)} símbolos (teste)')
        
        for i, (symbol, symbol_data) in enumerate(symbols_to_process, 1):
            print(f'  [{i}/{len(symbols_to_process)}] Processando {symbol}...')
            
            symbol_values = {
                'status': symbol_data.get('status'),
                'pair': symbol_data.get('pair'),
                'contract_type': symbol_data.get('contractType'),
                'base_asset': symbol_data.get('baseAsset'),
                'quote_asset': symbol_data.get('quoteAsset'),
                'margin_asset': symbol_data.get('marginAsset'),
                'price_precision': int(symbol_data.get('pricePrecision', 0)),
                'quantity_precision': int(symbol_data.get('quantityPrecision', 0)),
                'base_asset_precision': int(symbol_data.get('baseAssetPrecision', 0)),
                'quote_precision': int(symbol_data.get('quotePrecision', 0)),
                'onboard_date': int(symbol_data.get('onboardDate', 0)) if symbol_data.get('onboardDate') else None,
                'liquidation_fee': float(symbol_data.get('liquidationFee', 0)) if symbol_data.get('liquidationFee') else None,
                'market_take_bound': float(symbol_data.get('marketTakeBound', 0)) if symbol_data.get('marketTakeBound') else None
            }

            if symbol not in db_symbols_map:
                print(f'    🆕 Inserindo novo símbolo: {symbol}')
                cols = ', '.join(symbol_values.keys())
                vals = ', '.join(['%s'] * len(symbol_values))
                sql = f"INSERT INTO exchange_symbols (exchange, symbol, {cols}) VALUES (%s, %s, {vals}) RETURNING id"
                
                try:
                    cursor.execute(sql, ('binance', symbol, *symbol_values.values()))
                    result = cursor.fetchone()
                    symbol_id = result['id'] if result else None
                    print(f'    ✅ Símbolo inserido com ID: {symbol_id}')
                    inserts += 1
                except Exception as e:
                    print(f'    ❌ Erro ao inserir: {e}')
            else:
                print(f'    🔄 Símbolo já existe: {symbol}')
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print(f'\n✅ PROCESSAMENTO CONCLUÍDO!')
        print(f'   Inserções: {inserts}')
        print(f'   Atualizações: {updates}')
        return True
        
    except Exception as e:
        print(f'\n❌ ERRO CRÍTICO: {e}')
        traceback.print_exc()
        return False

# Executar o debug
if __name__ == '__main__':
    result = update_exchange_info_database_debug()
    print(f'\n🎯 RESULTADO FINAL: {result}')
