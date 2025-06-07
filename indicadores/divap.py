import asyncio
import os
import re
import signal
import sys
import traceback
import mysql.connector
from datetime import datetime
from telethon import TelegramClient, events
from dotenv import load_dotenv
import pathlib
from senhas import pers_api_hash, pers_api_id

# No início do arquivo, após os imports existentes
import sys
import os
from pathlib import Path

# Adicionar o diretório backtest ao path para permitir a importação
sys.path.append(str(Path(__file__).parent / 'backtest'))
from backtest.divap_check import DIVAPAnalyzer, DB_CONFIG, BINANCE_CONFIG

# Carregar variáveis de ambiente do arquivo .env na raiz do projeto
env_path = pathlib.Path(__file__).parents[1] / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco de dados do arquivo .env
DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

# IDs dos grupos - USANDO OS IDs INTERNOS CORRETOS COM SINAL NEGATIVO
GRUPOS_ORIGEM_IDS = [-1002444455075]  # Lista com os IDs dos grupos de origem
GRUPO_DESTINO_ID = -1002016807368  # ID do grupo de destino

# Mapeamento de IDs de grupo para nomes de fontes (NOVO)
GRUPO_FONTE_MAPEAMENTO = {
    -1002444455075: "divap"  # Quando o grupo for este ID, o valor será "divap"
    # Adicione mais mapeamentos conforme necessário para outros grupos
}

# Seletor de alvo - valor 2 corresponde ao segundo alvo (Alvo 2)
ALVO_SELECIONADO = None  # 1=Alvo 1, 2=Alvo 2, 3=Alvo 3, etc.

# Cliente Telegram
client = TelegramClient('divap', pers_api_id, pers_api_hash)

# Variável para controle de encerramento
shutdown_event = asyncio.Event()

# Função para tratamento de sinais (Ctrl+C)
def signal_handler():
    print("\n[INFO] Sinal de encerramento recebido. Encerrando...")
    shutdown_event.set()

# Função para encerramento elegante
async def shutdown(client):
    """Encerra o cliente e outras conexões de forma elegante"""
    try:
        print("[INFO] Desconectando cliente Telegram...")
        await client.disconnect()

        # Fechar conexões do analisador DIVAP
        if divap_analyzer:
            try:
                divap_analyzer.close_connections()
                print("[INFO] Conexões do analisador DIVAP fechadas")
            except Exception as e:
                print(f"[ERRO] Erro ao fechar conexões do analisador DIVAP: {e}")

        # Aguardar um pouco para garantir que todas as tarefas sejam encerradas
        await asyncio.sleep(1)

        tasks = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()]
        for task in tasks:
            task.cancel()

        # Aguardar o cancelamento das tarefas
        if tasks:
            print(f"[INFO] Cancelando {len(tasks)} tarefas pendentes...")
            await asyncio.gather(*tasks, return_exceptions=True)

        print("[INFO] Encerramento concluído. Até logo!")
    except Exception as e:
        print(f"[ERRO] Erro durante encerramento: {e}")

# Normaliza números no formato string (ex.: "1.234,56" -> "1234.56")
def normalize_number(value):
    if not isinstance(value, str):
        return value
    value = value.replace(",", ".")
    if value.count(".") > 1:
        last_dot = value.rindex(".")
        value = value[:last_dot].replace(".", "") + value[last_dot:]
    return value

# Função para traduzir o lado da operação para português
def translate_side(side):
    if not side:
        return ""
    side = side.upper()
    if side == "BUY":
        return "COMPRA"
    elif side == "SELL":
        return "VENDA"
    return side

# Função para limpar o símbolo (remover ".P" se presente)
def clean_symbol(symbol):
    if not symbol:
        return ""
    if symbol.endswith(".P"):
        return symbol[:-2]
    return symbol

def get_leverage_brackets_from_database(symbol=None):
    """
    Busca informações de leverage brackets do banco de dados MySQL
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)

        sql = """
              SELECT symbol, bracket, initial_leverage, notional_cap,
                     notional_floor, maint_margin_ratio, cum
              FROM alavancagem
              WHERE corretora = 'binance' \
              """

        params = []
        if symbol:
            sql += " AND symbol = %s"
            params.append(symbol)

        sql += " ORDER BY symbol, bracket ASC"
        cursor.execute(sql, params)
        results = cursor.fetchall()

        brackets_by_symbol = {}
        for row in results:
            symbol = row['symbol']
            if symbol not in brackets_by_symbol:
                brackets_by_symbol[symbol] = []

            bracket_data = {
                'bracket': row['bracket'],
                'initialLeverage': row['initial_leverage'],
                'notionalCap': float(row['notional_cap']),
                'notionalFloor': float(row['notional_floor']),
                'maintMarginRatio': float(row['maint_margin_ratio']),
                'cum': float(row['cum'])
            }

            brackets_by_symbol[symbol].append(bracket_data)

        return brackets_by_symbol

    except Exception as e:
        print(f"[ERRO] Falha ao buscar dados de alavancagem do banco de dados: {e}")
        return {}
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def load_leverage_brackets(symbol=None):
    """
    Carrega os brackets de alavancagem do banco de dados MySQL
    """
    brackets_data = get_leverage_brackets_from_database(symbol)

    if symbol and symbol not in brackets_data:
        cleaned_symbol = clean_symbol(symbol)
        if cleaned_symbol != symbol and cleaned_symbol in brackets_data:
            return {symbol: brackets_data[cleaned_symbol]}

        base_symbol = symbol.split('_')[0]
        if base_symbol != symbol and base_symbol in brackets_data:
            print(f"[INFO] Usando brackets de {base_symbol} para {symbol}")
            return {symbol: brackets_data[base_symbol]}
        
        if "USDT" in symbol and "BTCUSDT" in brackets_data:
            print(f"[INFO] Usando brackets de BTCUSDT como referência para {symbol}")
            return {symbol: brackets_data["BTCUSDT"]}

    return brackets_data

def get_account_base_balance():
    """
    Obtém o saldo base de cálculo da tabela conta
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        # Obter o saldo base de cálculo da primeira conta ativa
        sql = "SELECT saldo_base_calculo FROM conta WHERE ativa = 1 LIMIT 1"
        cursor.execute(sql)
        result = cursor.fetchone()
        
        if result and 'saldo_base_calculo' in result and result['saldo_base_calculo'] is not None:
            return float(result['saldo_base_calculo'])
        else:
            print("[AVISO] Saldo base de cálculo não encontrado. Usando valor padrão.")
            return 10000.0  # Valor padrão se não encontrar
            
    except Exception as e:
        print(f"[ERRO] Falha ao buscar saldo base de cálculo: {e}")
        return 10000.0  # Valor padrão em caso de erro
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para margem cruzada baseada na distância entrada/SL
    e verifica se está condizente com o saldo disponível
    """
    cleaned_symbol = clean_symbol(symbol)

    is_long = True
    if side_raw:
        is_long = side_raw.upper() in ("BUY", "COMPRA")
    else:
        is_long = entry_price < stop_loss

    if is_long:
        sl_distance_pct = abs((entry_price - stop_loss) / entry_price)
    else:
        sl_distance_pct = abs((stop_loss - entry_price) / entry_price)

    print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")

    # Calcular alavancagem com base na distância até o SL
    target_leverage = int(1 / sl_distance_pct)

    try:
        # Obter o saldo base de cálculo
        account_balance = get_account_base_balance()
        #print(f"[DEBUG] Saldo base de cálculo: {account_balance:.2f} USDT")
        
        # Obter os brackets de alavancagem para o símbolo
        leverage_brackets = load_leverage_brackets(cleaned_symbol)
        symbol_brackets = []

        if cleaned_symbol in leverage_brackets:
            symbol_brackets = leverage_brackets[cleaned_symbol]

        if not symbol_brackets:
            all_brackets = load_leverage_brackets()
            base_symbol = cleaned_symbol.split('_')[0]

            if base_symbol in all_brackets:
                symbol_brackets = all_brackets[base_symbol]
            elif "BTCUSDT" in all_brackets:
                symbol_brackets = all_brackets["BTCUSDT"]

        # Valor para ordem (com base na porcentagem de capital)
        order_value = account_balance * (capital_percent / 100)
        #print(f"[DEBUG] Valor da ordem: {order_value:.2f} USDT (Saldo {account_balance:.2f} * {capital_percent}%)")
        
        max_leverage = 1
        bracket_leverage_limits = []
        
        # Verificar cada bracket para determinar a alavancagem máxima permitida
        for bracket in symbol_brackets:
            if "initialLeverage" not in bracket:
                continue
                
            bracket_leverage = int(bracket.get("initialLeverage", 1))
            notional_floor = float(bracket.get("notionalFloor", 0))
            notional_cap = float(bracket.get("notionalCap", float('inf')))
            
            # Valor da posição = valor da ordem * alavancagem
            position_value = order_value * bracket_leverage
            
            # Verificar se o valor da posição está dentro dos limites do bracket
            if position_value >= notional_floor and (notional_cap == float('inf') or position_value < notional_cap):
                max_leverage = max(max_leverage, bracket_leverage)
                bracket_leverage_limits.append(bracket_leverage)
                print(f"[DEBUG] Bracket elegível: Alavancagem {bracket_leverage}x, Valor posição: {position_value:.2f}, Limites: {notional_floor:.2f} - {notional_cap:.2f}")
            else:
                #print(f"[DEBUG] Bracket não elegível: Alavancagem {bracket_leverage}x, Valor posição: {position_value:.2f}, Limites: {notional_floor:.2f} - {notional_cap:.2f}")
                pass
        
        if bracket_leverage_limits:
            max_leverage = max(bracket_leverage_limits)
            print(f"[DEBUG] Alavancagem máxima permitida pelos brackets: {max_leverage}x")
        else:
            print(f"[AVISO] Nenhum bracket elegível encontrado para o valor da ordem. Usando alavancagem conservadora.")
            max_leverage = min(20, target_leverage)  # Valor conservador

    except Exception as e:
        print(f"[AVISO] Erro ao verificar alavancagem máxima: {e}. Usando valor padrão.")
        max_leverage = 20  # Valor mais conservador em caso de erro

    # A alavancagem final é o menor valor entre a alavancagem ideal e a alavancagem máxima permitida
    final_leverage = min(target_leverage, max_leverage)
    final_leverage = max(1, final_leverage)  # Mínimo de 1x

    print(f"[INFO] Alavancagem final calculada para {cleaned_symbol}: {final_leverage}x (Ideal: {target_leverage}x, Máximo permitido: {max_leverage}x)")
    return final_leverage

def save_to_database(trade_data):
    """
    Saves trade operation information to the MySQL database and returns the signal ID.
    """
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        # Prepare TP1 to TP5 values
        tp_prices = [None] * 5 # Initialize a list with 5 None values by default
        
        all_tps = trade_data.get('all_tps', []) # Get all TPs from trade_data, default to empty list
        for i in range(min(5, len(all_tps))): # Fill with available values, up to 5
            tp_prices[i] = all_tps[i]
            
        # SQL query including the new columns tp1_price to tp5_price and message_source
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price,
               chat_id, status, timeframe, message_id, message_id_orig,
               tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, message_source,
               divap_confirmado, cancelado_checker, error_message)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],  # Selected target for tp_price (main TP)
            trade_data["stop_loss"],
            trade_data["chat_id"],
            trade_data.get("status", "PENDING"),  # Status agora vem do trade_data ou é PENDING por padrão
            trade_data.get("timeframe", ""),
            trade_data.get("message_id"),
            trade_data.get("id_mensagem_origem_sinal"),
            tp_prices[0],  # tp1_price
            tp_prices[1],  # tp2_price
            tp_prices[2],  # tp3_price
            tp_prices[3],  # tp4_price
            tp_prices[4],  # tp5_price
            trade_data.get("message_source"),
            trade_data.get("divap_confirmado", None),
            trade_data.get("cancelado_checker", None),
            trade_data.get("error_message", None)
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid # Get the ID of the inserted row
        conn.commit()

        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operation saved to database: {trade_data['symbol']} (ID: {signal_id})")
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] TPs saved: TP1={tp_prices[0]}, TP2={tp_prices[1]}, TP3={tp_prices[2]}, TP4={tp_prices[3]}, TP5={tp_prices[4]}")
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Message source: {trade_data.get('message_source')}")
        return signal_id

    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Database error while saving: {db_err}")
        
        # Fallback logic for "Unknown column" errors
        if "Unknown column" in str(db_err):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Attempting fallback due to unknown column(s)...")
            
            sql_fallback = None
            values_fallback = None

            try:
                # Case 1: 'timeframe' column is missing
                if "Unknown column 'timeframe'" in str(db_err):
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: 'timeframe' column missing. Saving with TPs.")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, message_id, message_id_orig,
                         tp1_price, tp2_price, tp3_price, tp4_price, tp5_price) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    # tp_prices is already defined from the main try block
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal"),
                        tp_prices[0], tp_prices[1], tp_prices[2], tp_prices[3], tp_prices[4]
                    )
                
                # Case 2: One of 'tpX_price' columns is missing
                elif any(f"Unknown column 'tp{i}_price'" in str(db_err) for i in range(1, 6)):
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: TP1-TP5 column(s) missing. Saving with timeframe (if available).")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, timeframe, message_id, message_id_orig) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("timeframe", ""), trade_data.get("message_id"),
                        trade_data.get("id_mensagem_origem_sinal")
                    )
                
                # Case 3: Other "Unknown column" error (e.g. 'message_id_orig' or other combinations)
                # This attempts a more basic insert without timeframe and without individual TPs.
                else:
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: Other unknown column. Basic insert attempt.")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, message_id, message_id_orig) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal")
                    )

                if sql_fallback and values_fallback:
                    if cursor is None and conn: # Recreate cursor if it was not created or closed due to severe error
                        cursor = conn.cursor()
                    elif cursor is None and conn is None:
                        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] DB connection not established, fallback cannot proceed.")
                        return None

                    cursor.execute(sql_fallback, values_fallback)
                    signal_id_fallback = cursor.lastrowid
                    conn.commit()
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operation saved with fallback (ID: {signal_id_fallback})")
                    return signal_id_fallback
                else: # Should not happen if "Unknown column" was in db_err string
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback logic did not determine a query for error: {db_err}")

            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Error during fallback attempt: {e2}")
        
        return None # Return None if the main try failed and fallback was not successful or not applicable

    except Exception as e_generic:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Generic error while saving to database: {e_generic}")
        return None

    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()

def find_additional_databases():
    """
    Encontra todos os bancos de dados adicionais configurados no arquivo .env
    """
    additional_dbs = []
    
    # Procurar por DB_NAME_2, DB_NAME_3, etc. no arquivo .env
    i = 2
    while True:
        db_name_key = f"DB_NAME_{i}"
        db_name = os.getenv(db_name_key)
        
        if db_name:
            additional_dbs.append(db_name)
            i += 1
        else:
            break
    
    return additional_dbs

def save_to_additional_database(trade_data, db_name, tp_prices):
    """
    Salva os dados de trade em um banco de dados adicional
    """
    conn = None
    cursor = None
    
    try:
        # Conectar ao banco de dados adicional
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=db_name
        )
        cursor = conn.cursor()
        
        # Verificar se a tabela webhook_signals existe no banco adicional
        cursor.execute(f"SHOW TABLES LIKE 'webhook_signals'")
        if not cursor.fetchone():
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Tabela webhook_signals não encontrada no banco {db_name}. Pulando...")
            return
        
        # Verificar as colunas disponíveis na tabela do banco adicional
        cursor.execute(f"DESCRIBE webhook_signals")
        columns = {row[0].lower(): row for row in cursor.fetchall()}
        
        # Construir a consulta SQL dinamicamente com base nas colunas disponíveis
        available_columns = []
        values = []
        value_placeholders = []
        
        # Mapeamento de campos de trade_data para colunas da tabela
        field_mappings = {
            'symbol': 'symbol',
            'side': 'side',
            'leverage': 'leverage',
            'capital_pct': 'capital_pct',
            'entry': 'entry_price',
            'tp': 'tp_price',
            'stop_loss': 'sl_price',
            'chat_id': 'chat_id',
            'timeframe': 'timeframe',
            'message_id': 'message_id',
            'id_mensagem_origem_sinal': 'message_id_orig',
            'message_source': 'message_source'
        }
        
        # Adicionar colunas básicas
        for field, column in field_mappings.items():
            if column.lower() in columns:
                available_columns.append(column)
                value_placeholders.append('%s')
                
                # Valores especiais
                if field == 'message_source':
                    values.append(trade_data.get(field))
                else:
                    values.append(trade_data.get(field))
        
        # Adicionar status sempre como "PENDING"
        if 'status' in columns:
            available_columns.append('status')
            value_placeholders.append('%s')
            values.append('PENDING')
        
        # Adicionar colunas de TP1 a TP5 se disponíveis
        for i in range(5):
            tp_column = f'tp{i+1}_price'
            if tp_column in columns:
                available_columns.append(tp_column)
                value_placeholders.append('%s')
                values.append(tp_prices[i] if i < len(tp_prices) else None)
        
        # Construir e executar a consulta SQL
        if available_columns:
            sql = f"""
                  INSERT INTO webhook_signals
                  ({', '.join(available_columns)})
                  VALUES ({', '.join(value_placeholders)})
                  """
            
            cursor.execute(sql, tuple(values))
            additional_id = cursor.lastrowid
            conn.commit()
            
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operation also saved to additional database {db_name} (ID: {additional_id})")
        
    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Error saving to additional database {db_name}: {db_err}")
    
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Generic error while saving to additional database {db_name}: {e}")
    
    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()
    """
    Saves trade operation information to the MySQL database and returns the signal ID.
    """
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        # Prepare TP1 to TP5 values
        tp_prices = [None] # Initialize a list with 5 None values by default
        
        all_tps = trade_data.get('all_tps', []) # Get all TPs from trade_data, default to empty list
        for i in range(min(5, len(all_tps))): # Fill with available values, up to 5
            tp_prices[i] = all_tps[i]
            
        # SQL query including the new columns tp1_price to tp5_price and message_source
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price,
               chat_id, status, timeframe, message_id, message_id_orig,
               tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, message_source,
               divap_confirmado, cancelado_checker, error_message)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],  # Selected target for tp_price (main TP)
            trade_data["stop_loss"],
            trade_data["chat_id"],
            trade_data.get("status", "PENDING"),  # Status agora vem do trade_data ou é PENDING por padrão
            trade_data.get("timeframe", ""),
            trade_data.get("message_id"),
            trade_data.get("id_mensagem_origem_sinal"),
            tp_prices[0],  # tp1_price
            tp_prices[1],  # tp2_price
            tp_prices[2],  # tp3_price
            tp_prices[3],  # tp4_price
            tp_prices[4],  # tp5_price
            trade_data.get("message_source"),
            trade_data.get("divap_confirmado", None),
            trade_data.get("cancelado_checker", None),
            trade_data.get("error_message", None)
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid # Get the ID of the inserted row
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operation saved to database: {trade_data['symbol']} (ID: {signal_id})")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] TPs saved: TP1={tp_prices[0]}, TP2={tp_prices[1]}, TP3={tp_prices[2]}, TP4={tp_prices[3]}, TP5={tp_prices[4]}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Message source: {trade_data.get('message_source')}")
        return signal_id

    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Database error while saving: {db_err}")
        
        # Fallback logic for "Unknown column" errors
        if "Unknown column" in str(db_err):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Attempting fallback due to unknown column(s)...")
            
            sql_fallback = None
            values_fallback = None

            try:
                # Case 1: 'timeframe' column is missing
                if "Unknown column 'timeframe'" in str(db_err):
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: 'timeframe' column missing. Saving with TPs.")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, message_id, message_id_orig,
                         tp1_price, tp2_price, tp3_price, tp4_price, tp5_price) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    # tp_prices is already defined from the main try block
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal"),
                        tp_prices[0], tp_prices[1], tp_prices[2], tp_prices[3], tp_prices[4]
                    )
                
                # Case 2: One of 'tpX_price' columns is missing
                elif any(f"Unknown column 'tp{i}_price'" in str(db_err) for i in range(1, 6)):
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: TP1-TP5 column(s) missing. Saving with timeframe (if available).")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, timeframe, message_id, message_id_orig) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("timeframe", ""), trade_data.get("message_id"),
                        trade_data.get("id_mensagem_origem_sinal")
                    )
                
                # Case 3: Other "Unknown column" error (e.g. 'message_id_orig' or other combinations)
                # This attempts a more basic insert without timeframe and without individual TPs.
                else:
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback: Other unknown column. Basic insert attempt.")
                    sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, message_id, message_id_orig) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                    values_fallback = (
                        trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                        trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                        trade_data["stop_loss"], trade_data["chat_id"], "PENDING",
                        trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal")
                    )

                if sql_fallback and values_fallback:
                    if cursor is None and conn: # Recreate cursor if it was not created or closed due to severe error
                        cursor = conn.cursor()
                    elif cursor is None and conn is None:
                        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] DB connection not established, fallback cannot proceed.")
                        return None

                    cursor.execute(sql_fallback, values_fallback)
                    signal_id_fallback = cursor.lastrowid
                    conn.commit()
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operation saved with fallback (ID: {signal_id_fallback})")
                    return signal_id_fallback
                else: # Should not happen if "Unknown column" was in db_err string
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Fallback logic did not determine a query for error: {db_err}")

            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Error during fallback attempt: {e2}")
        
        return None # Return None if the main try failed and fallback was not successful or not applicable

    except Exception as e_generic:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Generic error while saving to database: {e_generic}")
        return None

    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()

# Função para extrair informações da mensagem do Telegram
async def extract_trade_info(message_text):
    """
    Extrai informações de trade da mensagem do Telegram usando regex
    """
    try:
        # Verificar se contém todos os termos obrigatórios
        required_terms = ["DIVAP", "Entrada", "Alvo", "Stop"]
        for term in required_terms:
            if term.lower() not in message_text.lower():
                print(f"[INFO] Termo obrigatório '{term}' não encontrado na mensagem")
                return None

        # Padrões para extrair informações
        symbol_pattern = r'#([A-Z0-9]+)'
        # Padrão para capturar o timeframe (15m, 1h, 4h, 1D, etc.) - incluindo D maiúsculo
        timeframe_pattern = r'#[A-Z0-9]+\s+([0-9]+[mhdwMD])'

        # Detectar o lado (compra/venda)
        if "compra" in message_text.lower():
            side = "COMPRA"
        elif "venda" in message_text.lower():
            side = "VENDA"
        else:
            # Tentar determinar pelo preço de entrada e stop
            entry_pattern = r'Entrada\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'
            sl_pattern = r'Stop\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'

            entry_match = re.search(entry_pattern, message_text)
            sl_match = re.search(sl_pattern, message_text)

            if entry_match and sl_match:
                entry = float(normalize_number(entry_match.group(1)))
                stop_loss = float(normalize_number(sl_match.group(1)))

                # Se entrada > stop, é venda; caso contrário, é compra
                side = "VENDA" if entry > stop_loss else "COMPRA"
            else:
                print("[ERRO] Não foi possível determinar o lado (compra/venda)")
                return None

        # Capturar entrada e stop
        entry_pattern = r'Entrada\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'
        sl_pattern = r'Stop\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'

        # Padrão para múltiplos alvos
        tp_pattern = r'Alvo\s+(?:\d+):\s*([0-9,.]+)'

        # Capital/risco
        capital_pattern = r'(\d+)%\s+do\s+capital'

        # Extrair dados
        symbol_match = re.search(symbol_pattern, message_text)
        timeframe_match = re.search(timeframe_pattern, message_text)
        entry_match = re.search(entry_pattern, message_text)
        sl_match = re.search(sl_pattern, message_text)
        capital_match = re.search(capital_pattern, message_text)

        # Extrair todos os alvos
        tp_matches = re.findall(tp_pattern, message_text)

        if not (symbol_match and entry_match and sl_match and tp_matches):
            print("[ERRO] Formato de mensagem não reconhecido")
            return None

        symbol = symbol_match.group(1)
        timeframe = timeframe_match.group(1).lower() if timeframe_match else ""
        entry = float(normalize_number(entry_match.group(1)))
        stop_loss = float(normalize_number(sl_match.group(1)))
        capital_pct = float(capital_match.group(1)) if capital_match else 5.0  # Valor padrão

        # Usar o primeiro alvo como TP principal
        tp = float(normalize_number(tp_matches[0])) if tp_matches else None

        # Calcular alavancagem
        leverage = calculate_ideal_leverage(symbol, entry, stop_loss, capital_pct, side)

        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "all_tps": [float(normalize_number(tp)) for tp in tp_matches] if tp_matches else [],
            "chat_id": GRUPO_DESTINO_ID
        }

    except Exception as e:
        print(f"[ERRO] Falha ao extrair informações: {e}")
        return None

# Adicionar esta função após a função extract_trade_info() e antes de handle_new_message()
async def verify_divap_pattern(trade_info):
    """
    Verifica se o sinal identificado realmente corresponde a um padrão DIVAP válido.
    
    Args:
        trade_info: Dicionário com informações do trade
        
    Returns:
        tuple: (is_valid_divap, error_message)
            is_valid_divap: True se for DIVAP válido, False caso contrário
            error_message: Mensagem de erro se não for DIVAP válido, None caso seja
    """
    global divap_analyzer
    
    # Verificar se o analisador está inicializado
    if not divap_analyzer:
        success = initialize_divap_analyzer()
        if not success:
            print(f"[ERRO] Não foi possível inicializar o analisador DIVAP para verificação")
            return (True, None)  # Falhar para aberto (permitir o sinal) em caso de erro no analisador
    
    # Criamos um objeto de sinal que simula um registro do banco de dados
    # para poder usar a função analyze_signal do DIVAPAnalyzer
    mock_signal = {
        "id": 0,  # Será ignorado pois ainda não temos ID
        "symbol": trade_info["symbol"],
        "side": trade_info["side"],
        "timeframe": trade_info.get("timeframe", "15m"),  # Padrão 15m se não especificado
        "created_at": datetime.now()
    }
    
    try:
        # Realizar a análise DIVAP
        analysis_result = divap_analyzer.analyze_signal(mock_signal)
        
        # Verificar se há erro na análise
        if "error" in analysis_result:
            print(f"[AVISO] Erro na análise DIVAP: {analysis_result['error']}. Permitindo sinal como precaução.")
            return (True, None)  # Permitir o sinal em caso de erro na análise
        
        # Verificar se o padrão DIVAP foi confirmado
        is_divap_confirmed = analysis_result.get("divap_confirmed", False)
        
        if is_divap_confirmed:
            print(f"[INFO] PADRÃO DIVAP CONFIRMADO para {trade_info['symbol']} {trade_info['side']}")
            return (True, None)
        else:
            # Determinar a mensagem de erro específica
            error_msg = "Padrão DIVAP não confirmado"
            
            has_volume = analysis_result.get("high_volume_any", False)
            has_divergence = False
            
            if trade_info["side"].upper() == "COMPRA":
                has_divergence = analysis_result.get("bull_div_any", False)
                divergence_type = "altista"
            else:  # VENDA
                has_divergence = analysis_result.get("bear_div_any", False)
                divergence_type = "baixista"
            
            if not has_volume and not has_divergence:
                error_msg = f"Volume abaixo da média e divergência {divergence_type} não encontrada"
            elif not has_volume:
                error_msg = "Volume abaixo da média"
            elif not has_divergence:
                error_msg = f"Divergência {divergence_type} não encontrada"
            
            #print(f"[AVISO] SINAL REJEITADO: {error_msg}")
            return (False, error_msg)
            
    except Exception as e:
        print(f"[ERRO] Falha na verificação DIVAP: {e}")
        print(traceback.format_exc())
        return (True, None)  # Em caso de erro, permitir o sinal como precaução

# Handler para monitorar mensagens em todos os grupos de origem
@client.on(events.NewMessage())
async def handle_new_message(event):
    """
    Manipula novas mensagens. Processa sinais de trade dos grupos de origem.
    """
    incoming_message_id = event.message.id if event and hasattr(event, 'message') and hasattr(event.message, 'id') else 'desconhecido'
    incoming_chat_id = event.chat_id if event and hasattr(event, 'chat_id') else 'desconhecido'

    # Obter a fonte da mensagem com base no chat_id (NOVO)
    message_source = GRUPO_FONTE_MAPEAMENTO.get(incoming_chat_id)
    
    try:
        incoming_chat_id = event.chat_id
        incoming_message_id = event.message.id
        incoming_text = event.message.text

        if not incoming_text:
            return

        incoming_created_at = event.message.date.strftime("%Y-%m-%d %H:%M:%S")
        GRUPOS_PERMITIDOS_PARA_REGISTRO = GRUPOS_ORIGEM_IDS #+ [GRUPO_DESTINO_ID] 
        is_incoming_reply = event.message.reply_to_msg_id is not None
        incoming_reply_to_id = event.message.reply_to_msg_id if is_incoming_reply else None

        # 1. PRIMEIRO, processar se for um SINAL DE TRADE de um GRUPO DE ORIGEM
        if incoming_chat_id in GRUPOS_ORIGEM_IDS:
            chat_obj = await event.get_chat() 
            print(f"[INFO] Mensagem ID {incoming_message_id} de GRUPO DE ORIGEM {chat_obj.id if chat_obj else incoming_chat_id}. Verificando se é sinal...")
            
            trade_info = await extract_trade_info(incoming_text)

            if trade_info:
                print(f"[INFO] Sinal de trade detectado em msg ID {incoming_message_id}: {trade_info['symbol']} {trade_info['side']}")
                
                # NOVO: Verificar se é realmente um padrão DIVAP válido
                is_valid_divap, error_message = await verify_divap_pattern(trade_info)
                
                # Se for DIVAP válido, seguir com o fluxo normal de envio
                if is_valid_divap:
                    selected_tp = None
                    if ALVO_SELECIONADO is not None:
                        if trade_info.get('all_tps') and len(trade_info['all_tps']) >= ALVO_SELECIONADO:
                            selected_tp = trade_info['all_tps'][ALVO_SELECIONADO - 1]
                        elif trade_info.get('tp'):
                            selected_tp = trade_info.get('tp')
                        elif trade_info.get('all_tps'):
                            selected_tp = trade_info['all_tps'][0]
                    
                    if selected_tp is None and trade_info.get('all_tps'):
                        print(f"[INFO] Enviando todos os {len(trade_info.get('all_tps'))} alvos.")
                    elif selected_tp is None:
                        print(f"[AVISO] Sinal da Msg ID {incoming_message_id} (Símbolo: {trade_info['symbol']}) não tem nenhum TP. Enviando apenas com entrada e SL.")

                    message_text_to_send = format_trade_message(trade_info, selected_tp)
                    print(f"\n[INFO] Mensagem de sinal formatada para envio (Origem Msg ID: {incoming_message_id}):\n{'-'*50}\n{message_text_to_send}\n{'-'*50}")

                    # Garantir que tp_price nunca seja NULL
                    if selected_tp is None:
                    # Se não há TP selecionado, usar o último alvo como tp_price para o banco de dados
                    # Isso evita o erro "Column 'tp_price' cannot be null"
                        if trade_info.get('all_tps') and len(trade_info['all_tps']) > 0:
                    # Usar o último alvo disponível
                            trade_info['tp'] = trade_info['all_tps'][-1]
                            #print(f"[INFO] Sem alvo específico selecionado. Usando último alvo ({trade_info['tp']}) como tp_price para o banco.")
                        else:
                            # Se não houver alvos disponíveis, usar o preço de entrada como fallback
                            trade_info['tp'] = trade_info['entry']
                            print(f"[AVISO] Sem alvos disponíveis. Usando preço de entrada ({trade_info['entry']}) como tp_price para o banco.")
                    else:
                        trade_info['tp'] = selected_tp

                    trade_info['id_mensagem_origem_sinal'] = incoming_message_id
                    trade_info['chat_id_origem_sinal'] = incoming_chat_id
                    trade_info['chat_id'] = GRUPO_DESTINO_ID 
                    trade_info['message_source'] = message_source  # Adicionar message_source                

                    # Enviar a mensagem ao grupo destino
                    sent_message_to_dest = await client.send_message(GRUPO_DESTINO_ID, message_text_to_send)
                    sent_message_id_in_dest = sent_message_to_dest.id
                    sent_message_created_at = sent_message_to_dest.date.strftime("%Y-%m-%d %H:%M:%S")
                    
                    trade_info['message_id'] = sent_message_id_in_dest
                    trade_info['divap_confirmado'] = 1
                    trade_info['cancelado_checker'] = 0
                    trade_info['message_source'] = message_source
                    
                    # Salvar com status PENDING (padrão)
                    signal_id_from_webhook_db = save_to_database(trade_info) 
                    
                    if signal_id_from_webhook_db:
                        print(f"[INFO] Sinal salvo em webhook_signals com ID: {signal_id_from_webhook_db}")
                        save_message_to_database( 
                            message_id=incoming_message_id,
                            chat_id=incoming_chat_id,
                            text=incoming_text,
                            is_reply=is_incoming_reply,
                            reply_to_message_id=incoming_reply_to_id,
                            symbol=trade_info['symbol'], 
                            signal_id=signal_id_from_webhook_db, 
                            created_at=incoming_created_at,
                            message_source=message_source                        
                        )
                        #print(f"[INFO] Mensagem original ID {incoming_message_id} (Chat {incoming_chat_id}) registrada em signals_msg com Sinal ID {signal_id_from_webhook_db}.")
                        
                        save_message_to_database(
                            message_id=sent_message_id_in_dest,
                            chat_id=GRUPO_DESTINO_ID,
                            text=message_text_to_send,
                            is_reply=False, 
                            reply_to_message_id=None,
                            symbol=trade_info['symbol'], 
                            signal_id=signal_id_from_webhook_db, 
                            created_at=sent_message_created_at,
                            message_source=message_source                         

                        )
                        #print(f"[INFO] Mensagem enviada ID {sent_message_id_in_dest} (Chat {GRUPO_DESTINO_ID}) registrada em signals_msg com Sinal ID {signal_id_from_webhook_db}.")
                    else:
                        print(f"[AVISO] Falha ao salvar sinal em webhook_signals para msg origem {incoming_message_id}. Mensagens em signals_msg não terão signal_id associado por este fluxo.")
                        save_message_to_database(
                            message_id=incoming_message_id,
                            chat_id=incoming_chat_id,
                            text=incoming_text,
                            is_reply=is_incoming_reply,
                            reply_to_message_id=incoming_reply_to_id,
                            symbol=trade_info.get('symbol'),
                            signal_id=None,
                            created_at=incoming_created_at,
                            message_source=message_source
                        )

                else:
                    # DIVAP NÃO confirmado - Salvar no banco com status CANCELED
                    #print(f"[INFO] Sinal de trade REJEITADO para {trade_info['symbol']}: {error_message}")
                    
                    trade_info['id_mensagem_origem_sinal'] = incoming_message_id
                    trade_info['chat_id_origem_sinal'] = incoming_chat_id
                    trade_info['chat_id'] = GRUPO_DESTINO_ID
                    trade_info['message_source'] = message_source
                    trade_info['divap_confirmado'] = 0
                    trade_info['cancelado_checker'] = 1
                    trade_info['status'] = 'CANCELED'
                    trade_info['error_message'] = error_message
                    
                    # Salvar sem enviar para o grupo destino
                    save_to_database(trade_info)
                    
                    # Registrar a mensagem original
                    save_message_to_database(
                        message_id=incoming_message_id,
                        chat_id=incoming_chat_id,
                        text=incoming_text,
                        is_reply=is_incoming_reply,
                        reply_to_message_id=incoming_reply_to_id,
                        symbol=trade_info.get('symbol'),
                        signal_id=None,
                        created_at=incoming_created_at,
                        message_source=message_source
                    )

                return 
            else: 
                print(f"[INFO] Mensagem ID {incoming_message_id} de GRUPO DE ORIGEM não é um sinal de trade parseável.")

        # --- INÍCIO DO TRECHO MODIFICADO (ETAPA 4) ---
        # 4. Para mensagens de GRUPOS PERMITIDOS que NÃO SÃO SINAIS DE TRADE PROCESSADOS ACIMA
        #    (ou seja, msgs de GRUPO_DESTINO_ID, ou msgs de GRUPO_ORIGEM_ID que não eram sinais válidos)
        if incoming_chat_id in GRUPOS_PERMITIDOS_PARA_REGISTRO:
            print(f"[INFO] Processando mensagem ID {incoming_message_id} de Chat ID {incoming_chat_id} para registro geral em signals_msg.")
            
            related_symbol = None
            related_signal_id = None

            # Verificar se esta mensagem está diretamente associada a um sinal
            direct_symbol, direct_signal_id = await get_symbol_from_webhook_signals(incoming_message_id, incoming_chat_id)
            if direct_signal_id:
                related_symbol = direct_symbol
                related_signal_id = direct_signal_id
                print(f"[INFO] Mensagem ID {incoming_message_id} diretamente associada ao Sinal ID {related_signal_id}.")
            elif is_incoming_reply:
                # É uma resposta a outra mensagem - verificar relação com sinal
                replied_s, replied_sid = await check_if_reply_to_signal(incoming_reply_to_id, incoming_chat_id)
                if replied_sid:
                    related_symbol = replied_s
                    related_signal_id = replied_sid
                    print(f"[INFO] Mensagem ID {incoming_message_id} é resposta ao Sinal ID {related_signal_id}.")
                else:
                    # IMPORTANTE: Mesmo que a mensagem respondida não esteja relacionada a um sinal,
                    # ainda assim registramos a mensagem atual
                    print(f"[INFO] Mensagem ID {incoming_message_id} é resposta a uma mensagem sem relação com sinais.")
            
            # SEMPRE registrar a mensagem em signals_msg, independente de ser uma resposta ou ter relação com sinal
            save_message_to_database(
                message_id=incoming_message_id,
                chat_id=incoming_chat_id,
                text=incoming_text,
                is_reply=is_incoming_reply,
                reply_to_message_id=incoming_reply_to_id,
                symbol=related_symbol, # Pode ser None
                signal_id=related_signal_id, # Pode ser None
                created_at=incoming_created_at,
                message_source=message_source
            )
            
            if related_signal_id:
                print(f"[INFO] Mensagem ID {incoming_message_id} registrada e associada ao Sinal ID: {related_signal_id}")
            else:
                print(f"[INFO] Mensagem ID {incoming_message_id} registrada sem associação a um sinal.")

        else:
            # Esta mensagem não é de um grupo de origem (para sinais) nem de um grupo permitido para registro geral.
            # Esta condição else corresponde ao if da Etapa 4.
            #print(f"[INFO] Mensagem ID {incoming_message_id} de Chat ID {incoming_chat_id} não pertence a GRUPOS_PERMITIDOS_PARA_REGISTRO (após falhar checagem de GRUPOS_ORIGEM_IDS). Ignorando completamente.")
            pass

    except Exception as e:
        print(f"[ERRO GERAL EM HANDLE_NEW_MESSAGE] Falha ao processar mensagem ID {incoming_message_id} de Chat ID {incoming_chat_id}: {e}")
        print(traceback.format_exc())

# Nova função para registrar mensagens no banco de dados
def save_message_to_database(message_id, chat_id, text, is_reply=False, 
                            reply_to_message_id=None, symbol=None, signal_id=None, 
                            created_at=None, message_source=None):
    """
    Salva uma mensagem do Telegram na tabela signals_msg
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        # Se não fornecido, usar o timestamp atual
        if not created_at:
            created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # Preparar a query com message_source
        sql = """
              INSERT INTO signals_msg
              (message_id, chat_id, text, is_reply, reply_to_message_id, symbol, signal_id, created_at, message_source)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
              """
              
        values = (
            message_id,
            chat_id,
            text,
            is_reply,
            reply_to_message_id,
            symbol,
            signal_id,
            created_at,
            message_source
        )
        
        cursor.execute(sql, values)
        conn.commit()
        
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Mensagem {message_id} registrada na tabela signals_msg")
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao registrar mensagem: {e}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

# Função para verificar se uma mensagem é resposta a um sinal
async def check_if_reply_to_signal(reply_to_message_id, chat_id=None):
    """
    Verifica se uma mensagem é uma resposta a um sinal de trade, 
    potencialmente subindo na cadeia de respostas.
    
    Args:
        reply_to_message_id: ID da mensagem à qual está respondendo.
        chat_id: ID do chat onde a mensagem original (a respondida) foi enviada (opcional, mas recomendado).
    
    Returns:
        tuple: (symbol, signal_id) se for resposta a um sinal, (None, None) caso contrário.
                 signal_id é o ID da tabela webhook_signals.
    """
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        # 1. Verificar se não vai duplicar na tabela webhook_signals (sinais principais)
        sql_webhook = """
            SELECT id, symbol FROM webhook_signals 
            WHERE (message_id = %s AND chat_id = %s) 
               OR (message_id_orig = %s AND chat_id_orig_sinal = %s) 
               OR registry_message_id = %s 
        """
        sql_webhook_refined = """
            SELECT id, symbol FROM webhook_signals 
            WHERE (message_id = %s AND chat_id = %s)  /* Mensagem no destino */
               OR (message_id_orig = %s AND chat_id_orig_sinal = %s) /* Mensagem na origem */
               OR registry_message_id = %s /* ID de registro alternativo */
        """
        
        # Usando a query da sua proposta que é mais simples:
        cursor.execute(
            "SELECT id, symbol FROM webhook_signals WHERE message_id = %s OR message_id_orig = %s OR registry_message_id = %s",
            (reply_to_message_id, reply_to_message_id, reply_to_message_id)
        )
        result_ws = cursor.fetchone()
        if result_ws:
            return (result_ws['symbol'], result_ws['id'])
            
        # 2. Se não encontrar em webhook_signals, verificar na tabela signals_msg
        #    Isto busca se a mensagem respondida foi registrada em signals_msg e tem um signal_id associado.
        sql_signals_msg = "SELECT sm.symbol, sm.signal_id FROM signals_msg sm WHERE sm.message_id = %s"
        params_sm = [reply_to_message_id]
        
        if chat_id: # Se o chat_id da mensagem respondida é conhecido, use para refinar a busca
            sql_signals_msg += " AND sm.chat_id = %s"
            params_sm.append(chat_id)
            
        cursor.execute(sql_signals_msg, tuple(params_sm)) # Converter lista para tupla para o execute
        
        result_sm = cursor.fetchone()
        # Verifica se encontrou, se tem 'symbol' e se 'signal_id' não é None (ou 0 se for o caso)
        if result_sm and result_sm.get('symbol') and result_sm.get('signal_id') is not None:
            return (result_sm['symbol'], result_sm['signal_id'])
        
        # 3. Lógica Recursiva: Se não encontrou um sinal direto, verificar se a mensagem respondida
        
        if not (result_sm and result_sm.get('symbol') and result_sm.get('signal_id') is not None) :
            # Buscar a mensagem "pai" da mensagem atual (reply_to_message_id) na tabela signals_msg
            sql_recursive_parent_check = """
                SELECT sm.reply_to_message_id
                FROM signals_msg sm
                WHERE sm.message_id = %s AND sm.chat_id = %s AND sm.is_reply = TRUE
            """
            # Para esta busca, precisamos do chat_id da mensagem atual que estamos inspecionando (reply_to_message_id)
            # Se chat_id não foi fornecido, esta etapa recursiva pode ser menos confiável ou pulada.
            if chat_id:
                cursor.execute(sql_recursive_parent_check, (reply_to_message_id, chat_id))
                parent_message_info = cursor.fetchone()
                
                if parent_message_info and parent_message_info.get('reply_to_message_id'):
                    parent_msg_id = parent_message_info['reply_to_message_id']
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Recursão: Verificando mensagem pai ID {parent_msg_id} para o sinal.")
                    # O chat_id passado para a recursão deve ser o da mensagem pai,
                    return await check_if_reply_to_signal(parent_msg_id, chat_id) 
            else:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Recursão pulada: chat_id não fornecido para a mensagem {reply_to_message_id}.")

        return (None, None) # Se nenhuma das condições anteriores for atendida
            
    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro de banco de dados em check_if_reply_to_signal: {db_err}")
        print(traceback.format_exc())
        return (None, None)
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro genérico em check_if_reply_to_signal: {e}")
        print(traceback.format_exc())
        return (None, None)
    finally:
        if cursor: # Fechar cursor primeiro
            cursor.close()
        if conn and conn.is_connected(): # Depois fechar conexão
            conn.close()

async def get_symbol_from_webhook_signals(message_id, chat_id=None):
    """
    Verifica se uma mensagem está relacionada a um trade na tabela webhook_signals
    
    Args:
        message_id: ID da mensagem do Telegram
        chat_id: ID do chat onde a mensagem foi enviada (opcional)
        
    Returns:
        tuple: (symbol, signal_id) se a mensagem estiver relacionada a um trade
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        # Verificar se esta mensagem tem um sinal associado diretamente
        sql = """
            SELECT id, symbol FROM webhook_signals 
            WHERE message_id = %s OR message_id_orig = %s
        """
        cursor.execute(sql, (message_id, message_id))
        
        result = cursor.fetchone()
        if result:
            return (result['symbol'], result['id'])
            
        return (None, None)
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao verificar sinal relacionado: {e}")
        return (None, None)
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

# Função para formatar a mensagem de trade
def format_trade_message(trade_info, selected_tp):
    """
    Formata a mensagem de trade para envio ao grupo de destino
    """
    message_text = (
        f"#{trade_info['symbol']}  {trade_info['side']}\n"
    )
    if trade_info.get('timeframe'):
        message_text += f"{trade_info['timeframe']}\n"
    message_text += (
        "Divap\n\n" 
        f"ALAVANCAGEM: {trade_info['leverage']}x\n"
        "MARGEM: CRUZADA\n"
        f"CAPITAL: {int(trade_info['capital_pct'])}%\n\n"
        f"ENTRADA: {trade_info['entry']}\n\n"
    )

    # Verificar se temos um alvo selecionado ou se devemos mostrar todos
    all_tps = trade_info.get('all_tps', [])
    
    if selected_tp is None and all_tps:
        # Se não há alvo selecionado mas temos TPs disponíveis, mostrar todos
        for i, tp in enumerate(all_tps):
            message_text += f"ALVO {i+1}: {tp}\n"
        message_text += "\n"
    elif len(all_tps) > 1 and selected_tp is not None:
        # Se temos múltiplos alvos e um foi selecionado, mostrar qual estamos usando
        tp_index = 0
        for i, tp in enumerate(all_tps):
            if abs(float(tp) - float(selected_tp)) < 0.00001:  # Comparação com tolerância para números flutuantes
                tp_index = i + 1
                break
        message_text += f"ALVO {tp_index}: {selected_tp}\n\n"
    elif selected_tp is not None:
        # Se temos apenas um alvo ou selected_tp não está em all_tps
        message_text += f"ALVO: {selected_tp}\n\n"
        
    message_text += f"STOP LOSS: {trade_info['stop_loss']}"
    return message_text

# Após a definição das constantes globais

# Inicializar o analisador DIVAP
divap_analyzer = None

def initialize_divap_analyzer():
    global divap_analyzer
    if divap_analyzer is None:
        try:
            divap_analyzer = DIVAPAnalyzer(
                db_config={
                    "host": DB_HOST,
                    "user": DB_USER,
                    "password": DB_PASSWORD,
                    "database": DB_NAME
                },
                binance_config={
                    "apiKey": os.getenv('API_KEY'),
                    "secret": os.getenv('API_SECRET'),
                    "enableRateLimit": True
                }
            )
            divap_analyzer.connect_db()
            divap_analyzer.connect_exchange()
            print(f"[INFO] Analisador DIVAP inicializado com sucesso")
            return True
        except Exception as e:
            print(f"[ERRO] Falha ao inicializar analisador DIVAP: {e}")
            return False
    return True

async def main():
    """
    Função principal para iniciar o cliente
    """
    print("[INFO] Iniciando monitoramento do Telegram...")

    # Inicializar o analisador DIVAP
    initialize_divap_analyzer()

    # Iniciar o cliente
    await client.start()
    #print("[INFO] Cliente Telethon conectado")

    # Configurar tratamento de sinais para Windows e Unix
    try:
        if os.name == 'nt':  # Windows
            import win32api
            win32api.SetConsoleCtrlHandler(lambda x: signal_handler(), True)
        else:  # Unix/Linux/Mac
            loop = asyncio.get_event_loop()
            for sig in (signal.SIGINT, signal.SIGTERM):
                loop.add_signal_handler(sig, signal_handler)
    except Exception as e:
        print(f"[AVISO] Não foi possível configurar manipulador de sinais: {e}")

    # Verificar se conseguimos acessar os grupos
    try:
        #print("[INFO] Verificando acesso aos grupos de origem:")
        for grupo_id in GRUPOS_ORIGEM_IDS:
            try:
                # Usar get_entity diretamente com o ID interno
                origem = await client.get_entity(grupo_id)
                tipo = "Canal" if getattr(origem, "broadcast", False) else "Supergrupo" if getattr(origem, "megagroup", False) else "Grupo"
                print(f"[INFO] {tipo} de origem: {getattr(origem, 'title', 'Sem título')} (ID: {grupo_id})")
            except Exception as e:
                print(f"[ERRO] Não foi possível acessar o grupo/canal {grupo_id}: {e}")

        try:
            # Usar get_entity diretamente com o ID interno
            destino = await client.get_entity(GRUPO_DESTINO_ID)
            tipo = "Canal" if getattr(destino, "broadcast", False) else "Supergrupo" if getattr(destino, "megagroup", False) else "Grupo"
            print(f"[INFO] Enviando para {tipo} de destino: {getattr(destino, 'title', 'Sem título')}")
        except Exception as e:
            print(f"[ERRO] Não foi possível acessar o grupo/canal de destino {GRUPO_DESTINO_ID}: {e}")
            return

    except Exception as e:
        print(f"[ERRO] Falha ao acessar grupos: {e}")
        return
    try:
        await shutdown_event.wait()
    finally:
        # Garantir que o cliente seja desconectado
        await shutdown(client)

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[INFO] Interrompido pelo usuário")
    except Exception as e:
        print(f"[ERRO] Erro não tratado: {e}")
    finally:
        print("[INFO] Script encerrado")