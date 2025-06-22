import os
import time
import datetime
import traceback
import requests
import mysql.connector
from dotenv import load_dotenv
import pathlib
import warnings
import logging

# Carregar variáveis de ambiente
env_path = pathlib.Path(__file__).parents[1] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração de logging
logging.basicConfig(level=logging.ERROR)
warnings.filterwarnings("ignore", category=DeprecationWarning)

# API URL da Binance Futures
API_URL = "https://fapi.binance.com/fapi"

# Define qual exchange este script irá processar
CURRENT_EXCHANGE = 'binance'

# Configurações do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': os.getenv('DB_PORT'),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME'),
    'charset': 'utf8mb4',
    'autocommit': True
}

def get_database_connection():
    """Obtém conexão com o banco de dados MySQL/MariaDB."""
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except mysql.connector.Error as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DB] Erro ao conectar: {e}")
        return None

def make_binance_request(endpoint, params=None):
    """Faz requisição pública para a API Binance."""
    try:
        url = f"{API_URL}{endpoint}"
        response = requests.get(url, params=params, timeout=30)
        
        if response.status_code == 200:
            return response.json()
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Erro HTTP {response.status_code}: {response.text}")
            return None
            
    except requests.exceptions.Timeout:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Timeout na requisição")
        return None
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Erro na requisição: {e}")
        return None

def update_exchange_info_database(exchange_name):
    """Atualiza as informações de símbolos e filtros no banco de dados para uma exchange específica."""
    try:
        # FASE 1: OBTER DADOS DA BINANCE
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] Buscando dados da Binance...")
        info_data = make_binance_request('/v1/exchangeInfo')
        
        if not info_data or 'symbols' not in info_data:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] ❌ Resposta inválida da API Binance")
            return False
        
        api_symbols_map = {s['symbol']: s for s in info_data['symbols']}

        # FASE 2: CONECTAR AO BANCO
        conn = get_database_connection()
        if not conn:
            return False
        
        cursor = conn.cursor(dictionary=True)
        
        # FASE 3: OBTER DADOS DO BANCO (APENAS DA EXCHANGE ATUAL)
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] Buscando dados do banco para a exchange '{exchange_name}'...")
        cursor.execute("""
        SELECT id, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset,
           price_precision, quantity_precision, base_asset_precision, quote_precision,
           onboard_date, liquidation_fee, market_take_bound
        FROM exchange_symbols WHERE exchange = %s
        """, (exchange_name,))
        db_symbols_map = {row['symbol']: row for row in cursor.fetchall()}
        
        # FASE 4: PROCESSAR DIFERENÇAS
        inserts, updates, deletes = 0, 0, 0
        
        for symbol, symbol_data in api_symbols_map.items():
            symbol_values = {
                'status': symbol_data.get('status'), 'pair': symbol_data.get('pair'),
                'contract_type': symbol_data.get('contractType'), 'base_asset': symbol_data.get('baseAsset'),
                'quote_asset': symbol_data.get('quoteAsset'), 'margin_asset': symbol_data.get('marginAsset'),
                'price_precision': symbol_data.get('pricePrecision'), 'quantity_precision': symbol_data.get('quantityPrecision'),
                'base_asset_precision': symbol_data.get('baseAssetPrecision'), 'quote_precision': symbol_data.get('quotePrecision'),
                'onboard_date': symbol_data.get('onboardDate'), 'liquidation_fee': symbol_data.get('liquidationFee'),
                'market_take_bound': symbol_data.get('marketTakeBound')
            }

            if symbol not in db_symbols_map:
                # INSERIR novo símbolo
                cols = ', '.join(symbol_values.keys())
                vals = ', '.join(['%s'] * len(symbol_values))
                sql = f"INSERT INTO exchange_symbols (exchange, symbol, {cols}) VALUES (%s, %s, {vals})"
                cursor.execute(sql, (exchange_name, symbol, *symbol_values.values()))
                symbol_id = cursor.lastrowid
                inserts += 1
            else:
                # ATUALIZAR símbolo existente SOMENTE SE ALGUM CAMPO MUDOU
                symbol_id = db_symbols_map[symbol]['id']
                db_row = db_symbols_map[symbol]
                needs_update = False
                for key in symbol_values:
                    if str(db_row.get(key)) != str(symbol_values[key]):
                        needs_update = True
                        break
                if needs_update:
                    update_cols = ', '.join([f"{key} = %s" for key in symbol_values.keys()])
                    sql = f"UPDATE exchange_symbols SET {update_cols} WHERE id = %s AND exchange = %s"
                    cursor.execute(sql, (*symbol_values.values(), symbol_id, exchange_name))
                    updates += 1

            # Sincronizar filtros: Deletar os antigos e inserir os novos
            cursor.execute("DELETE FROM exchange_filters WHERE symbol_id = %s", (symbol_id,))
            for f in symbol_data.get('filters', []):
                filter_values = {'symbol_id': symbol_id, 'filter_type': f.get('filterType'), 'min_price': f.get('minPrice'),
                                 'max_price': f.get('maxPrice'), 'tick_size': f.get('tickSize'), 'min_qty': f.get('minQty'),
                                 'max_qty': f.get('maxQty'), 'step_size': f.get('stepSize'), 'min_notional': f.get('notional'),
                                 'multiplier_up': f.get('multiplierUp'), 'multiplier_down': f.get('multiplierDown'),
                                 'multiplier_decimal': f.get('multiplierDecimal'),
                                 'limit_orders': f.get('limit') if f.get('filterType') == 'MAX_NUM_ORDERS' else None,
                                 'limit_algo_orders': f.get('limit') if f.get('filterType') == 'MAX_NUM_ALGO_ORDERS' else None}
                cols = ', '.join(filter_values.keys())
                vals = ', '.join(['%s'] * len(filter_values))
                sql = f"INSERT INTO exchange_filters ({cols}) VALUES ({vals})"
                cursor.execute(sql, tuple(filter_values.values()))

        # FASE 5: DELETAR símbolos obsoletos (DA EXCHANGE ATUAL)
        obsolete_symbols = set(db_symbols_map.keys()) - set(api_symbols_map.keys())
        if obsolete_symbols:
            placeholders = ', '.join(['%s'] * len(obsolete_symbols))
            sql = f"DELETE FROM exchange_symbols WHERE exchange = %s AND symbol IN ({placeholders})"
            params = [exchange_name] + list(obsolete_symbols)
            cursor.execute(sql, tuple(params))
            deletes = cursor.rowcount
        
        # FASE 6: CONFIRMAR E REPORTAR
        conn.commit()
        cursor.close()
        conn.close()

        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] ✅ Atualização para '{exchange_name}' concluída:")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Símbolos inseridos: {inserts}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Símbolos atualizados: {updates}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Símbolos removidos: {deletes}")
        return True
        
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] ❌ Erro crítico na atualização: {e}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] Stack trace: {traceback.format_exc()}")
        if 'conn' in locals() and conn.is_connected(): conn.rollback()
        return False

# Bloco para execução manual do script
if __name__ == '__main__':
    print("="*60)
    print(f"  Executando atualização manual para a exchange: '{CURRENT_EXCHANGE}'")
    print("="*60)
    
    conn_test = get_database_connection()
    if conn_test:
        conn_test.close()
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ✅ Conexão com banco OK.")
        update_exchange_info_database(CURRENT_EXCHANGE)
    else:
        print("\n[ERRO] A atualização não foi executada devido a falhas na conexão com o banco.")
        
    print("\nScript de atualização manual finalizado.")