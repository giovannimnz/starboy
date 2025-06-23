import asyncio
import os
import re
import signal
import sys
import traceback
import mysql.connector
from datetime import datetime, timedelta
from telethon import TelegramClient, events
from dotenv import load_dotenv
import pathlib
from senhas import pers_api_hash, pers_api_id, API_KEY, API_SECRET, API_URL
from pathlib import Path
import logging
import schedule
import time
import threading
import requests
import hmac
import hashlib
import json
from urllib.parse import urlencode
import warnings

# --- NOVO: Importa as funções de atualização do arquivo externo ---
from exchange_bracket_updater import update_leverage_brackets, test_binance_credentials, test_database_connection
from exchange_info_updater import update_exchange_info_database, CURRENT_EXCHANGE

# --- Configuração de Logging e Avisos ---
logging.basicConfig(level=logging.ERROR)
logging.getLogger('telethon').setLevel(logging.CRITICAL)
logging.getLogger('telethon.network').setLevel(logging.CRITICAL)
logging.getLogger('telethon.client').setLevel(logging.CRITICAL)
logging.getLogger('asyncio').setLevel(logging.ERROR)
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*telethon.*")

# --- Constantes e Configurações Globais ---
ENABLE_REVERSE_VERIFICATION = True
PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL = 4.90
TAXA_ENTRADA = 0.02
TAXA_SAIDA = 0.05

GRUPOS_ORIGEM_IDS = [-1002444455075, -1002059628218]
GRUPO_DESTINO_ID = -1002016807368
CONTA_ID = 1
GRUPO_FONTE_MAPEAMENTO = {
    -1002444455075: "Reverse",
    -1002059628218: "Manual-Reverse"

}

# --- Importações e Configurações de Módulos Locais ---
sys.path.append(str(Path(__file__).parent / 'analysis'))
try:
    from analysis.divap_check import DIVAPAnalyzer
except ImportError as e:
    print(f"[ERRO] Não foi possível importar DIVAPAnalyzer: {e}")
    DIVAPAnalyzer = None

# --- Carregamento de Variáveis de Ambiente ---
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

DB_CONFIG = {
    'host': DB_HOST,
    'port': DB_PORT,
    'user': DB_USER,
    'password': DB_PASSWORD,
    'database': DB_NAME,
    'charset': 'utf8mb4',
    'autocommit': True
}

# --- Cliente Telegram e Controles de Encerramento ---
client = TelegramClient('divap', pers_api_id, pers_api_hash)
shutdown_event = threading.Event()
divap_analyzer = None

# --- Funções do Agendador (Scheduler) ---

def run_scheduler():
    """
    Executa o scheduler em uma thread separada para tarefas agendadas.
    """
    #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Iniciando agendador de brackets e exchange info...")
    
    # Agendamento para chamar as funções importadas
    schedule.every().day.at("00:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("06:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("12:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("18:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    
    while not shutdown_event.is_set():
        try:
            schedule.run_pending()
            time.sleep(60)
        except Exception as e:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Erro no laço: {e}")
            time.sleep(60)
    
    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Encerrado.")

def initialize_bracket_scheduler():
    """
    Testa conexões, executa uma atualização inicial de brackets e exchange info, e inicia o scheduler.
    """
    try:
        print("\n" + "="*80)
        print("🟦🟦🟦   INICIALIZAÇÃO DO SISTEMA DE ATUALIZAÇÃO   🟦🟦🟦")
        print("="*80 + "\n")

        print("════════════════════════════════════════════════════════════════════════════════")
        print("🟨 ATUALIZAÇÃO DE BRACKETS (LEVERAGE) 🟨")
        print("════════════════════════════════════════════════════════════════════════════════")
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando testes de conexão...")

        binance_ok = test_binance_credentials()
        db_ok = test_database_connection()

        if not (binance_ok and db_ok):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Testes falharam. O agendador não será iniciado.")
            return

        # Capturar se houve mudanças nos brackets
        brackets_had_changes = update_leverage_brackets()

        print("\n" + "═"*80)
        print("🟩 ATUALIZAÇÃO DE EXCHANGE INFO 🟩")
        print("═"*80)
        
        # Capturar se houve mudanças no exchange info
        exchange_had_changes = update_exchange_info_database(CURRENT_EXCHANGE)

        print("\n" + "="*80)
        print("🟦🟦🟦   INICIALIZAÇÃO DO MONITORAMENTO   🟦🟦🟦")
        print("="*80 + "\n")

        # Inicia o scheduler em uma thread para não bloquear o programa principal
        scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
        scheduler_thread.start()

    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Erro crítico ao inicializar o agendador: {e}")

# --- Funções de Banco de Dados ---

def get_database_connection():
    """
    Obtém conexão com o banco de dados MySQL
    """
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except mysql.connector.Error as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DB] Erro ao conectar: {e}")
        return None

# --- Funções de Encerramento e Utilitários ---

def signal_handler_sync():
    """Função síncrona para lidar com o sinal de encerramento."""
    #print("\n[INFO] Sinal de encerramento recebido. Encerrando...")
    shutdown_event.set()

async def shutdown(client_instance):
    """Encerra o cliente e outras conexões de forma elegante."""
    #print("[INFO] Iniciando processo de encerramento...")
    try:
        schedule.clear()
        #print("[INFO] Jobs do scheduler limpos.")

        if divap_analyzer:
            divap_analyzer.close_connections()
            print("[INFO] Conexões do analisador DIVAP fechadas.")

        if client_instance and client_instance.is_connected():
            await client_instance.disconnect()
            print("[INFO] Cliente Telegram desconectado.")

    except Exception as e:
        print(f"[ERRO] Erro durante o encerramento: {e}")

def normalize_number(value):
    """Normaliza números no formato string (ex.: "1.234,56" -> "1234.56")."""
    if not isinstance(value, str):
        return value
    value = value.replace(",", ".")
    if value.count(".") > 1:
        last_dot = value.rindex(".")
        value = value[:last_dot].replace(".", "") + value[last_dot:]
    return value

def translate_side(side):
    """Traduz o lado da operação para português."""
    if not side: return ""
    side = side.upper()
    return "COMPRA" if side == "BUY" else "VENDA" if side == "SELL" else side

def clean_symbol(symbol):
    """Remove o sufixo '.P' do símbolo, se presente."""
    return symbol[:-2] if symbol and symbol.endswith(".P") else symbol

# --- Funções de Lógica de Negócio ---

def get_leverage_brackets_from_database(symbol=None):
    """
    Busca informações de leverage brackets do banco de dados MySQL
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)

        sql = """
              SELECT symbol, bracket, initial_leverage, notional_cap,
                     notional_floor, maint_margin_ratio, cum
              FROM exchange_leverage_brackets
              WHERE corretora = 'binance'
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
    Obtém o saldo base de cálculo da tabela conta (com fallback para contas)
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        sql = "SELECT saldo_base_calculo FROM contas WHERE ativa = 1 LIMIT 1"
        cursor.execute(sql)
        result = cursor.fetchone()
            
        if result and 'saldo_base_calculo' in result and result['saldo_base_calculo'] is not None:
            return float(result['saldo_base_calculo'])

        return 1000.0

    except Exception as e:
        print(f"[ERRO] Falha ao buscar saldo base de cálculo: {e}")
        return 1000.0
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para margem cruzada baseada na distância entrada/SL
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

    #print(f"\n[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")

    target_leverage = int(1 / sl_distance_pct)

    try:
        account_balance = get_account_base_balance()
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

        order_value = account_balance * (capital_percent / 100)
        
        max_leverage = 1
        bracket_leverage_limits = []
        
        for bracket in symbol_brackets:
            if "initialLeverage" not in bracket:
                continue
                
            bracket_leverage = int(bracket.get("initialLeverage", 1))
            notional_floor = float(bracket.get("notionalFloor", 0))
            notional_cap = float(bracket.get("notionalCap", float('inf')))
            
            position_value = order_value * bracket_leverage
            
            if position_value >= notional_floor and (notional_cap == float('inf') or position_value < notional_cap):
                max_leverage = max(max_leverage, bracket_leverage)
                bracket_leverage_limits.append(bracket_leverage)
                print(f"[DEBUG] Bracket elegível: Alavancagem {bracket_leverage}x, Valor posição: {position_value:.2f}, Limite: {notional_cap:.2f}")
        
        if bracket_leverage_limits:
            max_leverage = max(bracket_leverage_limits)
            print(f"[DEBUG] Alavancagem máxima: {max_leverage}x")
            print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")
        else:
            print(f"[AVISO] Nenhum bracket elegível encontrado para o valor da ordem. Usando alavancagem conservadora.")
            max_leverage = min(20, target_leverage)

    except Exception as e:
        print(f"[AVISO] Erro ao verificar alavancagem máxima: {e}. Usando valor padrão.")
        max_leverage = 20

    final_leverage = min(target_leverage, max_leverage)
    final_leverage = max(1, final_leverage)

    print(f" [INFO] Alavancagem final calculada para {cleaned_symbol}: {final_leverage}x (Ideal: {target_leverage}x, Máximo permitido: {max_leverage}x)")
    
    return final_leverage, sl_distance_pct

def save_to_database(trade_data):
    """
    Salva informações da operação no banco MySQL
    """
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        tp_prices = [None] * 5
        all_tps = trade_data.get('all_tps', [])
        for i in range(min(5, len(all_tps))):
            tp_prices[i] = all_tps[i]
        
        chat_id_origem = trade_data.get('chat_id_origem_sinal')
        if chat_id_origem and chat_id_origem > 0:
            chat_id_origem = -chat_id_origem
            
        chat_id_destino = trade_data.get('chat_id')
        if chat_id_destino and chat_id_destino > 0:
            chat_id_destino = -chat_id_destino
            
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price,
               chat_id, status, timeframe, message_id, message_id_orig, chat_id_orig_sinal,
               tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, message_source,
               divap_confirmado, cancelado_checker, error_message, conta_id)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],
            trade_data["stop_loss"],
            chat_id_destino,
            trade_data.get("status", "PENDING"),
            trade_data.get("timeframe", ""),
            trade_data.get("message_id"),
            trade_data.get("id_mensagem_origem_sinal"),
            chat_id_origem,
            tp_prices[0], tp_prices[1], tp_prices[2], tp_prices[3], tp_prices[4],
            trade_data.get("message_source"),
            trade_data.get("divap_confirmado", None),
            trade_data.get("cancelado_checker", None),
            trade_data.get("error_message", None),
            CONTA_ID
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Operação salva [ID: {signal_id}, Conta: {CONTA_ID}] [{trade_data['symbol']}]")
        return signal_id

    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro no banco ao salvar: {db_err}")
        
        if "Unknown column" in str(db_err):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Tentando fallback devido a coluna(s) desconhecida(s)...")
            
            try:
                sql_fallback = """
                    INSERT INTO webhook_signals
                    (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                     chat_id, status, message_id, message_id_orig, chat_id_orig_sinal, conta_id) 
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """
                values_fallback = (
                    trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                    trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                    trade_data["stop_loss"], chat_id_destino, "PENDING",
                    trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal"),
                    chat_id_origem, CONTA_ID
                )

                if cursor is None and conn:
                    cursor = conn.cursor()
                
                cursor.execute(sql_fallback, values_fallback)
                signal_id_fallback = cursor.lastrowid
                conn.commit()
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Operação salva com fallback (ID: {signal_id_fallback}, Conta: {CONTA_ID})")
                return signal_id_fallback

            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro durante tentativa de fallback: {e2}")
        
        return None

    except Exception as e_generic:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro genérico ao salvar no banco: {e_generic}")
        return None

    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()

def extract_trade_info(message_text):
    """
    ===== FUNÇÃO COMPLETAMENTE REESCRITA PARA MÁXIMA COMPATIBILIDADE =====
    Extrai informações de trade da mensagem com suporte a múltiplos formatos
    """
    try:
        #print(f"\n🔍 [EXTRACT_DEBUG] Analisando mensagem:")
        #print(f"   Comprimento: {len(message_text)} caracteres")
        #print(f"   Primeiros 200 chars: {repr(message_text[:200])}")
        
        if not message_text or len(message_text.strip()) < 10:
            print(f"   ❌ Mensagem muito curta ou vazia")
            return None
        
        message_lower = message_text.lower()
        
        # Verificar se contém termos DIVAP obrigatórios
        divap_terms = [
            "divap",
            "possível divap", 
            "alerta de possível divap"
        ]
        
        has_divap = any(term in message_lower for term in divap_terms)
        
        # Verificar se tem estrutura básica de trade
        basic_terms = ["entrada", "alvo", "stop"]
        has_basic_structure = all(term in message_lower for term in basic_terms)
        
        print(f"\n   ✅ Contém DIVAP: {has_divap}")
        print(f"   ✅ Contém estrutura básica: {has_basic_structure}")
        
        if not (has_divap or has_basic_structure):
            print(f"   ❌ Não contém termos necessários")
            return None
        
        print(f"   ✅ Mensagem qualificada para processamento")
        
        # ===== EXTRAÇÃO DO SÍMBOLO =====
        symbol_patterns = [
            r'🚨\s*#([A-Z0-9]+)',                    # 🚨 #TRXUSDT
            r'#([A-Z0-9]+)\s+\d+[mhdwMD]',          # #TRXUSDT 15m
            r'#([A-Z0-9]+)\s+-\s+',                 # #TRXUSDT - Alerta
            r'#([A-Z0-9]+)',                        # #TRXUSDT (genérico)
            r'\b([A-Z]{2,10}USDT)\b',               # TRXUSDT (sem #)
        ]
        
        symbol = None
        for pattern in symbol_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                symbol = match.group(1).upper()
                break
        
        if not symbol:
            print("   ❌ Símbolo não encontrado")
            return None
        
        # Garantir que termina com USDT se não terminar
        if not symbol.endswith('USDT') and not symbol.endswith('BUSD'):
            symbol += 'USDT'
        
        print(f"   ✅ Símbolo extraído: {symbol}")
        
        # ===== EXTRAÇÃO DO TIMEFRAME =====
        timeframe_patterns = [
            r'#[A-Z0-9]+\s+(\d+[mhdwMD])',         # #TRXUSDT 15m
            r'(\d+[mhdwMD])\s+-\s+',               # 15m - Alerta
            r'\b(\d+[mhdwMD])\b',                  # 15m (genérico)
        ]
        
        timeframe = "15m"  # Padrão
        for pattern in timeframe_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                timeframe = match.group(1).lower()
                break
        
        print(f"   ✅ Timeframe extraído: {timeframe}")
        
        # ===== DETECÇÃO DO LADO DA OPERAÇÃO =====
        side = None
        
        # Padrões para detectar VENDA
        sell_patterns = [
            r'divap de venda',
            r'possível divap de venda',
            r'entrada abaixo de',
            r'stop acima de',
            r'\bvenda\b',
            r'\bsell\b',
            r'\bshort\b'
        ]
        
        # Padrões para detectar COMPRA
        buy_patterns = [
            r'divap de compra',
            r'possível divap de compra', 
            r'entrada acima de',
            r'stop abaixo de',
            r'\bcompra\b',
            r'\bbuy\b',
            r'\blong\b'
        ]
        
        for pattern in sell_patterns:
            if re.search(pattern, message_lower):
                side = "VENDA"
                break
        
        if not side:
            for pattern in buy_patterns:
                if re.search(pattern, message_lower):
                    side = "COMPRA"
                    break
        
        #print(f"   Lado detectado: {side}")
        
        # ===== EXTRAÇÃO DE PREÇOS =====
        
        # Padrões para ENTRADA (máxima flexibilidade)
        entry_patterns = [
            r'entrada\s+abaixo\s+de:\s*([0-9,.]+)',
            r'entrada\s+acima\s+de:\s*([0-9,.]+)',
            r'entrada\s*:\s*([0-9,.]+)',
            r'entry\s+below:\s*([0-9,.]+)',
            r'entry\s+above:\s*([0-9,.]+)',
            r'entry\s*:\s*([0-9,.]+)',
            r'entrada\s+em:\s*([0-9,.]+)',
            r'buy\s+at:\s*([0-9,.]+)',
            r'sell\s+at:\s*([0-9,.]+)'
        ]
        
        entry = None
        for pattern in entry_patterns:
            match = re.search(pattern, message_lower)
            if match:
                entry = float(normalize_number(match.group(1)))
                break
        
        if not entry:
            print("   ❌ Preço de entrada não encontrado")
            return None
        
        print(f"   ✅ Entrada extraída: {entry}")
        
        # Padrões para STOP LOSS (máxima flexibilidade)
        sl_patterns = [
            r'stop\s+acima\s+de:\s*([0-9,.]+)',
            r'stop\s+abaixo\s+de:\s*([0-9,.]+)',
            r'stop\s*:\s*([0-9,.]+)',
            r'stop\s+loss\s*:\s*([0-9,.]+)',
            r'sl\s*:\s*([0-9,.]+)',
            r'stoploss\s*:\s*([0-9,.]+)',
            r'stop\s+em:\s*([0-9,.]+)'
        ]
        
        stop_loss = None
        for pattern in sl_patterns:
            match = re.search(pattern, message_lower)
            if match:
                stop_loss = float(normalize_number(match.group(1)))
                break
        
        if not stop_loss:
            print("   ❌ Stop loss não encontrado")
            return None
        
        print(f"   ✅ Stop loss extraído: {stop_loss}")
        
        # ===== DETERMINAÇÃO AUTOMÁTICA DO LADO SE NÃO DETECTADO =====
        if not side:
            if entry > stop_loss:
                side = "VENDA"  # Entrada maior que stop = venda
                print("   ✅ Lado determinado automaticamente: VENDA (entrada > stop)")
            else:
                side = "COMPRA"  # Entrada menor que stop = compra
                print("   ✅ Lado determinado automaticamente: COMPRA (entrada < stop)")
        
        # ===== EXTRAÇÃO DE ALVOS (máxima flexibilidade) =====
        tp_patterns = [
            r'alvo\s+(\d+):\s*([0-9,.]+)',          # Alvo 01: 0.27448
            r'target\s+(\d+):\s*([0-9,.]+)',        # Target 1: 0.27448
            r'tp\s*(\d+):\s*([0-9,.]+)',            # TP1: 0.27448
            r'take\s+profit\s+(\d+):\s*([0-9,.]+)', # Take Profit 1: 0.27448
            r'alvo\s*:\s*([0-9,.]+)',               # Alvo: 0.27448 (sem número)
            r'target\s*:\s*([0-9,.]+)',             # Target: 0.27448
            r'tp\s*:\s*([0-9,.]+)'                  # TP: 0.27448
        ]
        
        all_tps = []
        tp_matches_with_numbers = []
        
        for pattern in tp_patterns:
            matches = re.findall(pattern, message_lower)
            for match in matches:
                if isinstance(match, tuple) and len(match) == 2:
                    # Alvo numerado
                    tp_number = int(match[0]) if match[0].isdigit() else len(tp_matches_with_numbers) + 1
                    tp_price = float(normalize_number(match[1]))
                    tp_matches_with_numbers.append((tp_number, tp_price))
                elif isinstance(match, str):
                    # Alvo sem número
                    tp_price = float(normalize_number(match))
                    all_tps.append(tp_price)
        
        # Ordenar alvos numerados e adicionar à lista
        tp_matches_with_numbers.sort(key=lambda x: x[0])
        for _, tp_price in tp_matches_with_numbers:
            all_tps.append(tp_price)
        
        # Remover duplicatas mantendo ordem
        seen = set()
        all_tps = [x for x in all_tps if not (x in seen or seen.add(x))]
        
        if not all_tps:
            print("   ❌ Nenhum alvo encontrado")
            return None
        
        print(f"   ✅ Alvos extraídos: {all_tps}")
        
        # ===== EXTRAÇÃO DE CAPITAL PERCENTUAL =====
        capital_patterns = [
            r'(\d+(?:\.\d+)?)%\s+do\s+capital',
            r'operar.*?com\s+(\d+(?:\.\d+)?)%',
            r'recomendamos.*?(\d+(?:\.\d+)?)%',
            r'usar\s+(\d+(?:\.\d+)?)%',
            r'capital:\s*(\d+(?:\.\d+)?)%'
        ]
        
        original_capital_pct = 5.0  # Padrão
        for pattern in capital_patterns:
            match = re.search(pattern, message_lower)
            if match:
                original_capital_pct = float(match.group(1))
                break
        
        print(f"   ✅ Capital percentual extraído: {original_capital_pct}%")
        print(f"   ✅ Lado detectado: {side}\n")
        
        # ===== CÁLCULOS FINAIS =====
        
        # Calcular alavancagem
        leverage, sl_distance_pct = calculate_ideal_leverage(symbol, entry, stop_loss, original_capital_pct, side)
        
        # Calcular capital percentual dinâmico
        taxa_entrada_decimal = TAXA_ENTRADA / 100
        taxa_saida_decimal = TAXA_SAIDA / 100
        prejuizo_maximo_decimal = PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL / 100
        
        taxas_totais = taxa_entrada_decimal + taxa_saida_decimal
        risco_por_operacao = sl_distance_pct + taxas_totais
        
        if leverage * risco_por_operacao > 0:
            capital_pct = (prejuizo_maximo_decimal / (leverage * risco_por_operacao)) * 100
            capital_pct = min(100.0, max(0.1, capital_pct))
            capital_pct = round(capital_pct, 2)
            
            print(f" [INFO] Capital calculado: {capital_pct:.2f}% (risco máximo: {PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL}%)\n")
        else:
            capital_pct = original_capital_pct
            print(f"   ⚠️ Usando capital original: {capital_pct:.2f}%")
        
        # TP principal (primeiro alvo)
        tp = all_tps[0] if all_tps else entry
        
        print(f"{'='*80}\n")
        print(f"🎯 [EXTRACT_SUCCESS] Sinal extraído com sucesso:\n")
        print(f"       Símbolo: {symbol} | Timeframe: {timeframe}")
        print(f"       Lado: {side} | Entrada: {entry} | Stop: {stop_loss}")
        print(f"       TPs: {all_tps}")
        print(f"       Alavancagem: {leverage}x | Capital: {capital_pct}%\n")
        
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "all_tps": all_tps,
            "chat_id": GRUPO_DESTINO_ID
        }

    except Exception as e:
        print(f"❌ [EXTRACT_ERROR] Falha ao extrair informações da mensagem: {e}")
        print(f"   Traceback completo:")
        traceback.print_exc()
        return None

def save_message_to_database(message_id, chat_id, text, is_reply=False, 
                            reply_to_message_id=None, symbol=None, signal_id=None, 
                            created_at=None, message_source=None):
    """
    Salva uma mensagem do Telegram na tabela signals_msg
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        if not created_at:
            created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
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
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro ao registrar mensagem: {e}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def initialize_divap_analyzer():
    """Inicializa o analisador DIVAP"""
    global divap_analyzer
    if divap_analyzer is None and DIVAPAnalyzer:
        try:
            divap_analyzer = DIVAPAnalyzer(
                db_config={
                    "host": DB_HOST,
                    "user": DB_USER,
                    "password": DB_PASSWORD,
                    "database": DB_NAME,
                    "port": DB_PORT,
                },
                binance_config={
                    "apiKey": API_KEY,
                    "secret": API_SECRET,
                    "enableRateLimit": True
                }
            )
            divap_analyzer.connect_db()
            divap_analyzer.connect_exchange()
            print("                 [INFO] ✅ Analisador DIVAP inicializado com sucesso")
            return True
        except Exception as e:
            print(f"[ERRO] ❌ Falha ao inicializar analisador DIVAP: {e}")
            divap_analyzer = None
            return False
    return divap_analyzer is not None

async def verify_divap_pattern(trade_info):
    """Verifica se o sinal corresponde a um padrão DIVAP válido"""
    global divap_analyzer
    
    if not divap_analyzer:
        success = initialize_divap_analyzer()
        if not success:
            print("[ERRO] Não foi possível inicializar analisador DIVAP")
            return (True, None)  # Permitir em caso de erro
    
    mock_signal = {
        "id": 0,
        "symbol": trade_info["symbol"],
        "side": trade_info["side"],
        "timeframe": trade_info.get("timeframe", "15m"),
        "created_at": datetime.now()
    }
    
    try:
        analysis_result = divap_analyzer.analyze_signal(mock_signal)
        
        if "error" in analysis_result:
            print(f"[AVISO] Erro na análise DIVAP: {analysis_result['error']}")
            return (True, None)
        
        is_divap_confirmed = analysis_result.get("divap_confirmed", False)
        
        if is_divap_confirmed:
            print(f"\n[INFO] ✅ PADRÃO DIVAP CONFIRMADO para {trade_info['symbol']} {trade_info['side']}")
            return (True, None)
        else:
            error_msg = "Padrão DIVAP não confirmado"
            has_volume = analysis_result.get("high_volume_any", False)
            
            if trade_info["side"].upper() == "COMPRA":
                has_divergence = analysis_result.get("bull_div_any", False)
                divergence_type = "altista"
            else:
                has_divergence = analysis_result.get("bear_div_any", False)
                divergence_type = "baixista"
            
            if not has_volume and not has_divergence:
                error_msg = f"Volume abaixo da média e divergência {divergence_type} não encontrada"
            elif not has_volume:
                error_msg = "Volume abaixo da média"
            elif not has_divergence:
                error_msg = f"Divergência {divergence_type} não encontrada"
            
            return (False, error_msg)
            
    except Exception as e:
        print(f"[ERRO] Falha na verificação DIVAP: {e}")
        return (True, None)

def format_trade_message(trade_info, grupo_origem_nome=None):
    """
    Formata a mensagem de trade para envio no padrão solicitado - SEMPRE com todos os TPs
    """
    nome_indicador = grupo_origem_nome or "Divap"
    capital_value = trade_info['capital_pct']
    if capital_value == int(capital_value):
        capital_str = f"{int(capital_value)}%"
    else:
        capital_str = f"{capital_value:.2f}%"

    # Cabeçalho
    header = f"#{trade_info['symbol']}  {trade_info['side']}\n{trade_info.get('timeframe', '15m')}\n{nome_indicador}\n"

    # Corpo
    corpo = (
        f"\nALAVANCAGEM: {trade_info['leverage']}x\n"
        f"MARGEM: CRUZADA\n"
        f"CAPITAL: {capital_str}\n"
        f"\nENTRADA: {trade_info['entry']}\n"
    )

    # ✅ SEMPRE TODOS OS ALVOS (TPs)
    tps = trade_info.get('all_tps', [])
    if tps:
        for idx, tp in enumerate(tps, 1):
            corpo += f"\nALVO {idx}: {tp}"
    else:
        # Fallback se não houver all_tps
        corpo += f"\nALVO 1: {trade_info.get('tp', trade_info['entry'])}"

    corpo += f"\n\nSTOP LOSS: {trade_info['stop_loss']}"

    return header + corpo

# --- Adicionado para processamento assíncrono de mensagens ---
from asyncio import Queue
import concurrent.futures

# Adicionar no início do arquivo
message_queue = Queue()
processing_semaphore = asyncio.Semaphore(3)  # Máximo 3 processamentos simultâneos

async def process_message_async(event_data):
    """Processa uma mensagem de forma assíncrona"""
    async with processing_semaphore:
        try:
            await handle_new_message_improved(event_data)
        except Exception as e:
            print(f"❌ Erro ao processar mensagem assíncrona: {e}")

async def message_queue_processor():
    """Processa a fila de mensagens continuamente"""
    while True:
        try:
            # Pegar mensagem da fila (timeout de 1s)
            event_data = await asyncio.wait_for(message_queue.get(), timeout=1.0)
            
            # Processar em paralelo
            asyncio.create_task(process_message_async(event_data))
            
        except asyncio.TimeoutError:
            continue
        except Exception as e:
            print(f"❌ Erro no processador de fila: {e}")

async def debug_message_handler(event):
    """Handler otimizado - adiciona à fila rapidamente"""
    try:
        # Extrair dados essenciais rapidamente
        event_data = {
            'chat_id': event.chat_id if hasattr(event, 'chat_id') else 'N/A',
            'message_id': event.message.id if hasattr(event, 'message') and hasattr(event.message, 'id') else 'N/A',
            'text': event.message.text if hasattr(event, 'message') and hasattr(event.message, 'text') else 'N/A',
            'date': event.message.date if hasattr(event, 'message') and hasattr(event.message, 'date') else None,
            'reply_to_msg_id': event.message.reply_to_msg_id if hasattr(event, 'message') and hasattr(event.message, 'reply_to_msg_id') else None
        }
        
        # Garantir chat_id negativo
        if isinstance(event_data['chat_id'], int) and event_data['chat_id'] > 0:
            event_data['chat_id'] = -event_data['chat_id']
        
        # Adicionar à fila para processamento assíncrono
        await message_queue.put(event_data)
        
        print(f"📥 Mensagem adicionada à fila: {event_data['chat_id']} - {event_data['message_id']}")
        
    except Exception as e:
        print(f"❌ Erro ao adicionar mensagem à fila: {e}")

async def handle_new_message_improved(event_data):
    """Versão melhorada do handler usando dados da fila"""
    incoming_message_id = event_data['message_id']
    incoming_chat_id = event_data['chat_id']
    incoming_text = event_data['text']
    
    message_source = GRUPO_FONTE_MAPEAMENTO.get(incoming_chat_id)
    
    print(f"{'='*80}\n")
    print(f"\n🔄 [HANDLE_MESSAGE] Processando mensagem (ASSÍNCRONO):")
    print(f"   Chat ID: {incoming_chat_id}")
    print(f"   Message ID: {incoming_message_id}")
    print(f"   Message Source: {message_source}")
    print(f"   Timestamp: {datetime.now().strftime('%H:%M:%S.%f')[:-3]}")
    
    # Resto do código mantém igual...
    # (usar event_data ao invés de event.message.*)

# --- Funções do Agendador (Scheduler) ---

def run_scheduler():
    """
    Executa o scheduler em uma thread separada para tarefas agendadas.
    """
    #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Iniciando agendador de brackets e exchange info...")
    
    # Agendamento para chamar as funções importadas
    schedule.every().day.at("00:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("06:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("12:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    schedule.every().day.at("18:00").do(lambda: (update_leverage_brackets(), update_exchange_info_database(CURRENT_EXCHANGE)))
    
    while not shutdown_event.is_set():
        try:
            schedule.run_pending()
            time.sleep(60)
        except Exception as e:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Erro no laço: {e}")
            time.sleep(60)
    
    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Encerrado.")

def initialize_bracket_scheduler():
    """
    Testa conexões, executa uma atualização inicial de brackets e exchange info, e inicia o scheduler.
    """
    try:
        print("\n" + "="*80)
        print("🟦🟦🟦   INICIALIZAÇÃO DO SISTEMA DE ATUALIZAÇÃO   🟦🟦🟦")
        print("="*80 + "\n")

        print("════════════════════════════════════════════════════════════════════════════════")
        print("🟨 ATUALIZAÇÃO DE BRACKETS (LEVERAGE) 🟨")
        print("════════════════════════════════════════════════════════════════════════════════")
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando testes de conexão...")

        binance_ok = test_binance_credentials()
        db_ok = test_database_connection()

        if not (binance_ok and db_ok):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Testes falharam. O agendador não será iniciado.")
            return

        # Capturar se houve mudanças nos brackets
        brackets_had_changes = update_leverage_brackets()

        print("\n" + "═"*80)
        print("🟩 ATUALIZAÇÃO DE EXCHANGE INFO 🟩")
        print("═"*80)
        
        # Capturar se houve mudanças no exchange info
        exchange_had_changes = update_exchange_info_database(CURRENT_EXCHANGE)

        print("\n" + "="*80)
        print("🟦🟦🟦   INICIALIZAÇÃO DO MONITORAMENTO   🟦🟦🟦")
        print("="*80 + "\n")

        # Inicia o scheduler em uma thread para não bloquear o programa principal
        scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
        scheduler_thread.start()

    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Erro crítico ao inicializar o agendador: {e}")

# --- Funções de Banco de Dados ---

def get_database_connection():
    """
    Obtém conexão com o banco de dados MySQL
    """
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except mysql.connector.Error as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DB] Erro ao conectar: {e}")
        return None

# --- Funções de Encerramento e Utilitários ---

def signal_handler_sync():
    """Função síncrona para lidar com o sinal de encerramento."""
    #print("\n[INFO] Sinal de encerramento recebido. Encerrando...")
    shutdown_event.set()

async def shutdown(client_instance):
    """Encerra o cliente e outras conexões de forma elegante."""
    #print("[INFO] Iniciando processo de encerramento...")
    try:
        schedule.clear()
        #print("[INFO] Jobs do scheduler limpos.")

        if divap_analyzer:
            divap_analyzer.close_connections()
            print("[INFO] Conexões do analisador DIVAP fechadas.")

        if client_instance and client_instance.is_connected():
            await client_instance.disconnect()
            print("[INFO] Cliente Telegram desconectado.")

    except Exception as e:
        print(f"[ERRO] Erro durante o encerramento: {e}")

def normalize_number(value):
    """Normaliza números no formato string (ex.: "1.234,56" -> "1234.56")."""
    if not isinstance(value, str):
        return value
    value = value.replace(",", ".")
    if value.count(".") > 1:
        last_dot = value.rindex(".")
        value = value[:last_dot].replace(".", "") + value[last_dot:]
    return value

def translate_side(side):
    """Traduz o lado da operação para português."""
    if not side: return ""
    side = side.upper()
    return "COMPRA" if side == "BUY" else "VENDA" if side == "SELL" else side

def clean_symbol(symbol):
    """Remove o sufixo '.P' do símbolo, se presente."""
    return symbol[:-2] if symbol and symbol.endswith(".P") else symbol

# --- Funções de Lógica de Negócio ---

def get_leverage_brackets_from_database(symbol=None):
    """
    Busca informações de leverage brackets do banco de dados MySQL
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)

        sql = """
              SELECT symbol, bracket, initial_leverage, notional_cap,
                     notional_floor, maint_margin_ratio, cum
              FROM exchange_leverage_brackets
              WHERE corretora = 'binance'
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
    Obtém o saldo base de cálculo da tabela conta (com fallback para contas)
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        sql = "SELECT saldo_base_calculo FROM contas WHERE ativa = 1 LIMIT 1"
        cursor.execute(sql)
        result = cursor.fetchone()
            
        if result and 'saldo_base_calculo' in result and result['saldo_base_calculo'] is not None:
            return float(result['saldo_base_calculo'])

        return 1000.0

    except Exception as e:
        print(f"[ERRO] Falha ao buscar saldo base de cálculo: {e}")
        return 1000.0
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para margem cruzada baseada na distância entrada/SL
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

    #print(f"\n[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")

    target_leverage = int(1 / sl_distance_pct)

    try:
        account_balance = get_account_base_balance()
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

        order_value = account_balance * (capital_percent / 100)
        
        max_leverage = 1
        bracket_leverage_limits = []
        
        for bracket in symbol_brackets:
            if "initialLeverage" not in bracket:
                continue
                
            bracket_leverage = int(bracket.get("initialLeverage", 1))
            notional_floor = float(bracket.get("notionalFloor", 0))
            notional_cap = float(bracket.get("notionalCap", float('inf')))
            
            position_value = order_value * bracket_leverage
            
            if position_value >= notional_floor and (notional_cap == float('inf') or position_value < notional_cap):
                max_leverage = max(max_leverage, bracket_leverage)
                bracket_leverage_limits.append(bracket_leverage)
                print(f"[DEBUG] Bracket elegível: Alavancagem {bracket_leverage}x, Valor posição: {position_value:.2f}, Limite: {notional_cap:.2f}")
        
        if bracket_leverage_limits:
            max_leverage = max(bracket_leverage_limits)
            print(f"[DEBUG] Alavancagem máxima: {max_leverage}x")
            print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")
        else:
            print(f"[AVISO] Nenhum bracket elegível encontrado para o valor da ordem. Usando alavancagem conservadora.")
            max_leverage = min(20, target_leverage)

    except Exception as e:
        print(f"[AVISO] Erro ao verificar alavancagem máxima: {e}. Usando valor padrão.")
        max_leverage = 20

    final_leverage = min(target_leverage, max_leverage)
    final_leverage = max(1, final_leverage)

    print(f" [INFO] Alavancagem final calculada para {cleaned_symbol}: {final_leverage}x (Ideal: {target_leverage}x, Máximo permitido: {max_leverage}x)")
    
    return final_leverage, sl_distance_pct

def save_to_database(trade_data):
    """
    Salva informações da operação no banco MySQL
    """
    conn = None
    cursor = None
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        tp_prices = [None] * 5
        all_tps = trade_data.get('all_tps', [])
        for i in range(min(5, len(all_tps))):
            tp_prices[i] = all_tps[i]
        
        chat_id_origem = trade_data.get('chat_id_origem_sinal')
        if chat_id_origem and chat_id_origem > 0:
            chat_id_origem = -chat_id_origem
            
        chat_id_destino = trade_data.get('chat_id')
        if chat_id_destino and chat_id_destino > 0:
            chat_id_destino = -chat_id_destino
            
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price,
               chat_id, status, timeframe, message_id, message_id_orig, chat_id_orig_sinal,
               tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, message_source,
               divap_confirmado, cancelado_checker, error_message, conta_id)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],
            trade_data["stop_loss"],
            chat_id_destino,
            trade_data.get("status", "PENDING"),
            trade_data.get("timeframe", ""),
            trade_data.get("message_id"),
            trade_data.get("id_mensagem_origem_sinal"),
            chat_id_origem,
            tp_prices[0], tp_prices[1], tp_prices[2], tp_prices[3], tp_prices[4],
            trade_data.get("message_source"),
            trade_data.get("divap_confirmado", None),
            trade_data.get("cancelado_checker", None),
            trade_data.get("error_message", None),
            CONTA_ID
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Operação salva [ID: {signal_id}, Conta: {CONTA_ID}] [{trade_data['symbol']}]")
        return signal_id

    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro no banco ao salvar: {db_err}")
        
        if "Unknown column" in str(db_err):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Tentando fallback devido a coluna(s) desconhecida(s)...")
            
            try:
                sql_fallback = """
                    INSERT INTO webhook_signals
                    (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                     chat_id, status, message_id, message_id_orig, chat_id_orig_sinal, conta_id) 
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """
                values_fallback = (
                    trade_data["symbol"], trade_data["side"], trade_data["leverage"],
                    trade_data["capital_pct"], trade_data["entry"], trade_data["tp"],
                    trade_data["stop_loss"], chat_id_destino, "PENDING",
                    trade_data.get("message_id"), trade_data.get("id_mensagem_origem_sinal"),
                    chat_id_origem, CONTA_ID
                )

                if cursor is None and conn:
                    cursor = conn.cursor()
                
                cursor.execute(sql_fallback, values_fallback)
                signal_id_fallback = cursor.lastrowid
                conn.commit()
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Operação salva com fallback (ID: {signal_id_fallback}, Conta: {CONTA_ID})")
                return signal_id_fallback

            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro durante tentativa de fallback: {e2}")
        
        return None

    except Exception as e_generic:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro genérico ao salvar no banco: {e_generic}")
        return None

    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()

def extract_trade_info(message_text):
    """
    ===== FUNÇÃO COMPLETAMENTE REESCRITA PARA MÁXIMA COMPATIBILIDADE =====
    Extrai informações de trade da mensagem com suporte a múltiplos formatos
    """
    try:
        #print(f"\n🔍 [EXTRACT_DEBUG] Analisando mensagem:")
        #print(f"   Comprimento: {len(message_text)} caracteres")
        #print(f"   Primeiros 200 chars: {repr(message_text[:200])}")
        
        if not message_text or len(message_text.strip()) < 10:
            print(f"   ❌ Mensagem muito curta ou vazia")
            return None
        
        message_lower = message_text.lower()
        
        # Verificar se contém termos DIVAP obrigatórios
        divap_terms = [
            "divap",
            "possível divap", 
            "alerta de possível divap"
        ]
        
        has_divap = any(term in message_lower for term in divap_terms)
        
        # Verificar se tem estrutura básica de trade
        basic_terms = ["entrada", "alvo", "stop"]
        has_basic_structure = all(term in message_lower for term in basic_terms)
        
        print(f"\n   ✅ Contém DIVAP: {has_divap}")
        print(f"   ✅ Contém estrutura básica: {has_basic_structure}")
        
        if not (has_divap or has_basic_structure):
            print(f"   ❌ Não contém termos necessários")
            return None
        
        print(f"   ✅ Mensagem qualificada para processamento")
        
        # ===== EXTRAÇÃO DO SÍMBOLO =====
        symbol_patterns = [
            r'🚨\s*#([A-Z0-9]+)',                    # 🚨 #TRXUSDT
            r'#([A-Z0-9]+)\s+\d+[mhdwMD]',          # #TRXUSDT 15m
            r'#([A-Z0-9]+)\s+-\s+',                 # #TRXUSDT - Alerta
            r'#([A-Z0-9]+)',                        # #TRXUSDT (genérico)
            r'\b([A-Z]{2,10}USDT)\b',               # TRXUSDT (sem #)
        ]
        
        symbol = None
        for pattern in symbol_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                symbol = match.group(1).upper()
                break
        
        if not symbol:
            print("   ❌ Símbolo não encontrado")
            return None
        
        # Garantir que termina com USDT se não terminar
        if not symbol.endswith('USDT') and not symbol.endswith('BUSD'):
            symbol += 'USDT'
        
        print(f"   ✅ Símbolo extraído: {symbol}")
        
        # ===== EXTRAÇÃO DO TIMEFRAME =====
        timeframe_patterns = [
            r'#[A-Z0-9]+\s+(\d+[mhdwMD])',         # #TRXUSDT 15m
            r'(\d+[mhdwMD])\s+-\s+',               # 15m - Alerta
            r'\b(\d+[mhdwMD])\b',                  # 15m (genérico)
        ]
        
        timeframe = "15m"  # Padrão
        for pattern in timeframe_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                timeframe = match.group(1).lower()
                break
        
        print(f"   ✅ Timeframe extraído: {timeframe}")
        
        # ===== DETECÇÃO DO LADO DA OPERAÇÃO =====
        side = None
        
        # Padrões para detectar VENDA
        sell_patterns = [
            r'divap de venda',
            r'possível divap de venda',
            r'entrada abaixo de',
            r'stop acima de',
            r'\bvenda\b',
            r'\bsell\b',
            r'\bshort\b'
        ]
        
        # Padrões para detectar COMPRA
        buy_patterns = [
            r'divap de compra',
            r'possível divap de compra', 
            r'entrada acima de',
            r'stop abaixo de',
            r'\bcompra\b',
            r'\bbuy\b',
            r'\blong\b'
        ]
        
        for pattern in sell_patterns:
            if re.search(pattern, message_lower):
                side = "VENDA"
                break
        
        if not side:
            for pattern in buy_patterns:
                if re.search(pattern, message_lower):
                    side = "COMPRA"
                    break
        
        #print(f"   Lado detectado: {side}")
        
        # ===== EXTRAÇÃO DE PREÇOS =====
        
        # Padrões para ENTRADA (máxima flexibilidade)
        entry_patterns = [
            r'entrada\s+abaixo\s+de:\s*([0-9,.]+)',
            r'entrada\s+acima\s+de:\s*([0-9,.]+)',
            r'entrada\s*:\s*([0-9,.]+)',
            r'entry\s+below:\s*([0-9,.]+)',
            r'entry\s+above:\s*([0-9,.]+)',
            r'entry\s*:\s*([0-9,.]+)',
            r'entrada\s+em:\s*([0-9,.]+)',
            r'buy\s+at:\s*([0-9,.]+)',
            r'sell\s+at:\s*([0-9,.]+)'
        ]
        
        entry = None
        for pattern in entry_patterns:
            match = re.search(pattern, message_lower)
            if match:
                entry = float(normalize_number(match.group(1)))
                break
        
        if not entry:
            print("   ❌ Preço de entrada não encontrado")
            return None
        
        print(f"   ✅ Entrada extraída: {entry}")
        
        # Padrões para STOP LOSS (máxima flexibilidade)
        sl_patterns = [
            r'stop\s+acima\s+de:\s*([0-9,.]+)',
            r'stop\s+abaixo\s+de:\s*([0-9,.]+)',
            r'stop\s*:\s*([0-9,.]+)',
            r'stop\s+loss\s*:\s*([0-9,.]+)',
            r'sl\s*:\s*([0-9,.]+)',
            r'stoploss\s*:\s*([0-9,.]+)',
            r'stop\s+em:\s*([0-9,.]+)'
        ]
        
        stop_loss = None
        for pattern in sl_patterns:
            match = re.search(pattern, message_lower)
            if match:
                stop_loss = float(normalize_number(match.group(1)))
                break
        
        if not stop_loss:
            print("   ❌ Stop loss não encontrado")
            return None
        
        print(f"   ✅ Stop loss extraído: {stop_loss}")
        
        # ===== DETERMINAÇÃO AUTOMÁTICA DO LADO SE NÃO DETECTADO =====
        if not side:
            if entry > stop_loss:
                side = "VENDA"  # Entrada maior que stop = venda
                print("   ✅ Lado determinado automaticamente: VENDA (entrada > stop)")
            else:
                side = "COMPRA"  # Entrada menor que stop = compra
                print("   ✅ Lado determinado automaticamente: COMPRA (entrada < stop)")
        
        # ===== EXTRAÇÃO DE ALVOS (máxima flexibilidade) =====
        tp_patterns = [
            r'alvo\s+(\d+):\s*([0-9,.]+)',          # Alvo 01: 0.27448
            r'target\s+(\d+):\s*([0-9,.]+)',        # Target 1: 0.27448
            r'tp\s*(\d+):\s*([0-9,.]+)',            # TP1: 0.27448
            r'take\s+profit\s+(\d+):\s*([0-9,.]+)', # Take Profit 1: 0.27448
            r'alvo\s*:\s*([0-9,.]+)',               # Alvo: 0.27448 (sem número)
            r'target\s*:\s*([0-9,.]+)',             # Target: 0.27448
            r'tp\s*:\s*([0-9,.]+)'                  # TP: 0.27448
        ]
        
        all_tps = []
        tp_matches_with_numbers = []
        
        for pattern in tp_patterns:
            matches = re.findall(pattern, message_lower)
            for match in matches:
                if isinstance(match, tuple) and len(match) == 2:
                    # Alvo numerado
                    tp_number = int(match[0]) if match[0].isdigit() else len(tp_matches_with_numbers) + 1
                    tp_price = float(normalize_number(match[1]))
                    tp_matches_with_numbers.append((tp_number, tp_price))
                elif isinstance(match, str):
                    # Alvo sem número
                    tp_price = float(normalize_number(match))
                    all_tps.append(tp_price)
        
        # Ordenar alvos numerados e adicionar à lista
        tp_matches_with_numbers.sort(key=lambda x: x[0])
        for _, tp_price in tp_matches_with_numbers:
            all_tps.append(tp_price)
        
        # Remover duplicatas mantendo ordem
        seen = set()
        all_tps = [x for x in all_tps if not (x in seen or seen.add(x))]
        
        if not all_tps:
            print("   ❌ Nenhum alvo encontrado")
            return None
        
        print(f"   ✅ Alvos extraídos: {all_tps}")
        
        # ===== EXTRAÇÃO DE CAPITAL PERCENTUAL =====
        capital_patterns = [
            r'(\d+(?:\.\d+)?)%\s+do\s+capital',
            r'operar.*?com\s+(\d+(?:\.\d+)?)%',
            r'recomendamos.*?(\d+(?:\.\d+)?)%',
            r'usar\s+(\d+(?:\.\d+)?)%',
            r'capital:\s*(\d+(?:\.\d+)?)%'
        ]
        
        original_capital_pct = 5.0  # Padrão
        for pattern in capital_patterns:
            match = re.search(pattern, message_lower)
            if match:
                original_capital_pct = float(match.group(1))
                break
        
        print(f"   ✅ Capital percentual extraído: {original_capital_pct}%")
        print(f"   ✅ Lado detectado: {side}\n")
        
        # ===== CÁLCULOS FINAIS =====
        
        # Calcular alavancagem
        leverage, sl_distance_pct = calculate_ideal_leverage(symbol, entry, stop_loss, original_capital_pct, side)
        
        # Calcular capital percentual dinâmico
        taxa_entrada_decimal = TAXA_ENTRADA / 100
        taxa_saida_decimal = TAXA_SAIDA / 100
        prejuizo_maximo_decimal = PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL / 100
        
        taxas_totais = taxa_entrada_decimal + taxa_saida_decimal
        risco_por_operacao = sl_distance_pct + taxas_totais
        
        if leverage * risco_por_operacao > 0:
            capital_pct = (prejuizo_maximo_decimal / (leverage * risco_por_operacao)) * 100
            capital_pct = min(100.0, max(0.1, capital_pct))
            capital_pct = round(capital_pct, 2)
            
            print(f" [INFO] Capital calculado: {capital_pct:.2f}% (risco máximo: {PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL}%)\n")
        else:
            capital_pct = original_capital_pct
            print(f"   ⚠️ Usando capital original: {capital_pct:.2f}%")
        
        # TP principal (primeiro alvo)
        tp = all_tps[0] if all_tps else entry
        
        print(f"{'='*80}\n")
        print(f"🎯 [EXTRACT_SUCCESS] Sinal extraído com sucesso:\n")
        print(f"       Símbolo: {symbol} | Timeframe: {timeframe}")
        print(f"       Lado: {side} | Entrada: {entry} | Stop: {stop_loss}")
        print(f"       TPs: {all_tps}")
        print(f"       Alavancagem: {leverage}x | Capital: {capital_pct}%\n")
        
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "leverage": leverage,           
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "all_tps": all_tps,
            "chat_id": GRUPO_DESTINO_ID
        }

    except Exception as e:
        print(f"❌ [EXTRACT_ERROR] Falha ao extrair informações da mensagem: {e}")
        print(f"   Traceback completo:")
        traceback.print_exc()
        return None

def save_message_to_database(message_id, chat_id, text, is_reply=False, 
                            reply_to_message_id=None, symbol=None, signal_id=None, 
                            created_at=None, message_source=None):
    """
    Salva uma mensagem do Telegram na tabela signals_msg
    """
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        if not created_at:
            created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
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
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro ao registrar mensagem: {e}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def initialize_divap_analyzer():
    """Inicializa o analisador DIVAP"""
    global divap_analyzer
    if divap_analyzer is None and DIVAPAnalyzer:
        try:
            divap_analyzer = DIVAPAnalyzer(
                db_config={
                    "host": DB_HOST,
                    "user": DB_USER,
                    "password": DB_PASSWORD,
                    "database": DB_NAME,
                    "port": DB_PORT,
                },
                binance_config={
                    "apiKey": API_KEY,
                    "secret": API_SECRET,
                    "enableRateLimit": True
                }
            )
            divap_analyzer.connect_db()
            divap_analyzer.connect_exchange()
            print("                 [INFO] ✅ Analisador DIVAP inicializado com sucesso")
            return True
        except Exception as e:
            print(f"[ERRO] ❌ Falha ao inicializar analisador DIVAP: {e}")
            divap_analyzer = None
            return False
    return divap_analyzer is not None

async def verify_divap_pattern(trade_info):
    """Verifica se o sinal corresponde a um padrão DIVAP válido"""
    global divap_analyzer
    
    if not divap_analyzer:
        success = initialize_divap_analyzer()
        if not success:
            print("[ERRO] Não foi possível inicializar analisador DIVAP")
            return (True, None)  # Permitir em caso de erro
    
    mock_signal = {
        "id": 0,
        "symbol": trade_info["symbol"],
        "side": trade_info["side"],
        "timeframe": trade_info.get("timeframe", "15m"),
        "created_at": datetime.now()
    }
    
    try:
        analysis_result = divap_analyzer.analyze_signal(mock_signal)
        
        if "error" in analysis_result:
            print(f"[AVISO] Erro na análise DIVAP: {analysis_result['error']}")
            return (True, None)
        
        is_divap_confirmed = analysis_result.get("divap_confirmed", False)
        
        if is_divap_confirmed:
            print(f"\n[INFO] ✅ PADRÃO DIVAP CONFIRMADO para {trade_info['symbol']} {trade_info['side']}")
            return (True, None)
        else:
            error_msg = "Padrão DIVAP não confirmado"
            has_volume = analysis_result.get("high_volume_any", False)
            
            if trade_info["side"].upper() == "COMPRA":
                has_divergence = analysis_result.get("bull_div_any", False)
                divergence_type = "altista"
            else:
                has_divergence = analysis_result.get("bear_div_any", False)
                divergence_type = "baixista"
            
            if not has_volume and not has_divergence:
                error_msg = f"Volume abaixo da média e divergência {divergence_type} não encontrada"
            elif not has_volume:
                error_msg = "Volume abaixo da média"
            elif not has_divergence:
                error_msg = f"Divergência {divergence_type} não encontrada"
            
            return (False, error_msg)
            
    except Exception as e:
        print(f"[ERRO] Falha na verificação DIVAP: {e}")
        return (True, None)

def format_trade_message(trade_info, grupo_origem_nome=None):
    """
    Formata a mensagem de trade para envio no padrão solicitado - SEMPRE com todos os TPs
    """
    nome_indicador = grupo_origem_nome or "Divap"
    capital_value = trade_info['capital_pct']
    if capital_value == int(capital_value):
        capital_str = f"{int(capital_value)}%"
    else:
        capital_str = f"{capital_value:.2f}%"

    # Cabeçalho
    header = f"#{trade_info['symbol']}  {trade_info['side']}\n{trade_info.get('timeframe', '15m')}\n{nome_indicador}\n"

    # Corpo
    corpo = (
        f"\nALAVANCAGEM: {trade_info['leverage']}x\n"
        f"MARGEM: CRUZADA\n"
        f"CAPITAL: {capital_str}\n"
        f"\nENTRADA: {trade_info['entry']}\n"
    )

    # ✅ SEMPRE TODOS OS ALVOS (TPs)
    tps = trade_info.get('all_tps', [])
    if tps:
        for idx, tp in enumerate(tps, 1):
            corpo += f"\nALVO {idx}: {tp}"
    else:
        # Fallback se não houver all_tps
        corpo += f"\nALVO 1: {trade_info.get('tp', trade_info['entry'])}"

    corpo += f"\n\nSTOP LOSS: {trade_info['stop_loss']}"

    return header + corpo

async def main():
    # Iniciar processador de fila
    print(f"📋 Iniciando processador de fila de mensagens...")
    asyncio.create_task(message_queue_processor())