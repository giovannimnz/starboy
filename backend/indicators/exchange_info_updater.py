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
        
        # FASE 3: OBTER DADOS DO BANCO (TODOS OS CAMPOS RELEVANTES)
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] Buscando dados do banco para a exchange '{exchange_name}'...")
        cursor.execute("""
        SELECT id, symbol, status, pair, contract_type, base_asset, quote_asset, margin_asset,
               price_precision, quantity_precision, base_asset_precision, quote_precision,
               onboard_date, liquidation_fee, market_take_bound
        FROM exchange_symbols WHERE exchange = %s
        """, (exchange_name,))
        db_symbols_map = {row['symbol']: row for row in cursor.fetchall()}
        
        # FASE 3.5: OBTER FILTROS EXISTENTES DO BANCO
        cursor.execute("""
        SELECT es.symbol, ef.filter_type, ef.min_price, ef.max_price, ef.tick_size, 
               ef.min_qty, ef.max_qty, ef.step_size, ef.min_notional,
               ef.multiplier_up, ef.multiplier_down, ef.multiplier_decimal,
               ef.limit_orders, ef.limit_algo_orders
        FROM exchange_symbols es
        JOIN exchange_filters ef ON es.id = ef.symbol_id
        WHERE es.exchange = %s
        """, (exchange_name,))
        
        db_filters_map = {}
        for row in cursor.fetchall():
            symbol = row['symbol']
            if symbol not in db_filters_map:
                db_filters_map[symbol] = {}
            db_filters_map[symbol][row['filter_type']] = row
        
        # FASE 4: PROCESSAR DIFERENÇAS
        inserts, updates, deletes = 0, 0, 0
        filter_inserts, filter_updates, filter_deletes = 0, 0, 0
        
        for symbol, symbol_data in api_symbols_map.items():
            # ✅ NORMALIZAR VALORES PARA COMPARAÇÃO CONSISTENTE
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
                # INSERIR novo símbolo
                cols = ', '.join(symbol_values.keys())
                vals = ', '.join(['%s'] * len(symbol_values))
                sql = f"INSERT INTO exchange_symbols (exchange, symbol, {cols}) VALUES (%s, %s, {vals})"
                cursor.execute(sql, (exchange_name, symbol, *symbol_values.values()))
                symbol_id = cursor.lastrowid
                inserts += 1
            else:
                # ✅ COMPARAÇÃO MELHORADA - NORMALIZAR ANTES DE COMPARAR
                symbol_id = db_symbols_map[symbol]['id']
                db_row = db_symbols_map[symbol]
                needs_update = False
                
                for key, new_value in symbol_values.items():
                    db_value = db_row.get(key)
                    
                    # Normalizar valores para comparação
                    if isinstance(new_value, (int, float)) and db_value is not None:
                        db_value = type(new_value)(db_value)
                    elif new_value is None and db_value is None:
                        continue  # Ambos são None, não há diferença
                    elif str(new_value) != str(db_value):
                        needs_update = True
                        break
                
                if needs_update:
                    update_cols = ', '.join([f"{key} = %s" for key in symbol_values.keys()])
                    sql = f"UPDATE exchange_symbols SET {update_cols} WHERE id = %s AND exchange = %s"
                    cursor.execute(sql, (*symbol_values.values(), symbol_id, exchange_name))
                    updates += 1

            # ✅ SINCRONIZAR FILTROS DE FORMA INTELIGENTE (SÓ ATUALIZA O QUE MUDOU)
            api_filters = symbol_data.get('filters', [])
            db_filters = db_filters_map.get(symbol, {})
            
            # Mapear filtros da API
            api_filters_map = {}
            for f in api_filters:
                filter_type = f.get('filterType')
                if filter_type:
                    api_filters_map[filter_type] = {
                        'filter_type': filter_type,
                        'min_price': f.get('minPrice'),
                        'max_price': f.get('maxPrice'),
                        'tick_size': f.get('tickSize'),
                        'min_qty': f.get('minQty'),
                        'max_qty': f.get('maxQty'),
                        'step_size': f.get('stepSize'),
                        'min_notional': f.get('notional'),
                        'multiplier_up': f.get('multiplierUp'),
                        'multiplier_down': f.get('multiplierDown'),
                        'multiplier_decimal': f.get('multiplierDecimal'),
                        'limit_orders': f.get('limit') if filter_type == 'MAX_NUM_ORDERS' else None,
                        'limit_algo_orders': f.get('limit') if filter_type == 'MAX_NUM_ALGO_ORDERS' else None
                    }
            
            # Comparar filtros existentes com novos
            for filter_type, api_filter in api_filters_map.items():
                db_filter = db_filters.get(filter_type)
                
                if not db_filter:
                    # INSERIR novo filtro
                    filter_values = {**api_filter, 'symbol_id': symbol_id}
                    cols = ', '.join(filter_values.keys())
                    vals = ', '.join(['%s'] * len(filter_values))
                    sql = f"INSERT INTO exchange_filters ({cols}) VALUES ({vals})"
                    cursor.execute(sql, tuple(filter_values.values()))
                    filter_inserts += 1
                else:
                    # VERIFICAR se filtro precisa ser atualizado
                    needs_filter_update = False
                    for key, new_val in api_filter.items():
                        if key == 'filter_type':
                            continue  # Já sabemos que são iguais
                        db_val = db_filter.get(key)
                        if str(new_val) != str(db_val):
                            needs_filter_update = True
                            break
                    
                    if needs_filter_update:
                        # ATUALIZAR filtro existente
                        update_cols = ', '.join([f"{key} = %s" for key in api_filter.keys() if key != 'filter_type'])
                        update_values = [v for k, v in api_filter.items() if k != 'filter_type']
                        sql = f"UPDATE exchange_filters SET {update_cols} WHERE symbol_id = %s AND filter_type = %s"
                        cursor.execute(sql, (*update_values, symbol_id, filter_type))
                        filter_updates += 1
            
            # DELETAR filtros obsoletos
            for filter_type in db_filters.keys():
                if filter_type not in api_filters_map:
                    cursor.execute("DELETE FROM exchange_filters WHERE symbol_id = %s AND filter_type = %s", (symbol_id, filter_type))
                    filter_deletes += 1

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
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Filtros inseridos: {filter_inserts}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Filtros atualizados: {filter_updates}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO]   - Filtros removidos: {filter_deletes}")
        
        total_changes = inserts + updates + deletes + filter_inserts + filter_updates + filter_deletes
        if total_changes == 0:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] 🎯 Nenhuma mudança detectada.")
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] 🎯 Total de mudanças aplicadas: {total_changes}")
        
        return True
        
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] ❌ Erro crítico na atualização: {e}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [EXCHANGE-INFO] Stack trace: {traceback.format_exc()}")
        if 'conn' in locals() and conn.is_connected(): 
            conn.rollback()
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