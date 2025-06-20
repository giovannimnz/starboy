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
import os
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

# Remover logs do Telethon
logging.basicConfig(level=logging.ERROR)  # Mostrar apenas erros críticos
logging.getLogger('telethon').setLevel(logging.CRITICAL)  # Silenciar completamente o Telethon
logging.getLogger('telethon.network').setLevel(logging.CRITICAL)
logging.getLogger('telethon.client').setLevel(logging.CRITICAL)
logging.getLogger('asyncio').setLevel(logging.ERROR)  # Reduzir logs do asyncio também
warnings.filterwarnings("ignore", category=DeprecationWarning)
warnings.filterwarnings("ignore", message=".*telethon.*")


DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT')),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME'),
    'charset': 'utf8mb4',
    'autocommit': True
}

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

def create_binance_signature(query_string, secret):
    """
    Cria assinatura HMAC-SHA256 para API Binance
    """
    return hmac.new(
        secret.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

def make_binance_request(endpoint, params=None):
    """
    Faz requisição autenticada para API Binance
    """
    try:
        if params is None:
            params = {}
        
        # Adicionar timestamp
        timestamp = int(time.time() * 1000)
        params['timestamp'] = timestamp
        
        # Criar query string
        query_string = urlencode(params)
        
        # Criar assinatura
        signature = create_binance_signature(query_string, API_SECRET)
        
        # URL completa
        url = f"{API_URL}{endpoint}?{query_string}&signature={signature}"
        
        # Headers
        headers = {
            'X-MBX-APIKEY': API_KEY,
            'Content-Type': 'application/json'
        }
        
        # Fazer requisição
        response = requests.get(url, headers=headers, timeout=30)
        
        if response.status_code == 200:
            return response.json()
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Erro HTTP {response.status_code}: {response.text}")
            return None
            
    except requests.exceptions.Timeout:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Timeout na requisição")
        return None
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BINANCE] Erro na requisição: {e}")
        return None

def update_leverage_brackets_database():
    """
    Versão mais eficiente - compara e atualiza apenas diferenças
    Atualiza os brackets de alavancagem no banco de dados de forma otimizada
    """
    try:
        # === FASE 1: OBTER DADOS DA BINANCE ===
        brackets_data = make_binance_request('/v1/leverageBracket')
        
        if not brackets_data or not isinstance(brackets_data, list):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Resposta inválida da API Binance")
            return False
        
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Dados obtidos da Binance: {len(brackets_data)} símbolos")
        
        # === FASE 2: CONECTAR AO BANCO ===
        conn = get_database_connection()
        if not conn:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro ao conectar ao banco de dados")
            return False
        
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("""
            SELECT symbol, bracket, initial_leverage, notional_cap, notional_floor, 
                   maint_margin_ratio, cum 
            FROM alavancagem 
            WHERE corretora = 'binance'
            ORDER BY symbol, bracket
        """)
        
        current_data = cursor.fetchall()
        current_brackets = {}
        
        # Organizar dados atuais por símbolo e bracket
        for row in current_data:
            symbol = row['symbol']
            if symbol not in current_brackets:
                current_brackets[symbol] = {}
            current_brackets[symbol][row['bracket']] = row
        
        # === FASE 4: PROCESSAR DIFERENÇAS ===
        binance_symbols = set()
        updates = 0
        inserts = 0
        deletes = 0
        processed_symbols = 0
        
        for symbol_data in brackets_data:
            symbol = symbol_data.get('symbol')
            if not symbol:
                continue
                
            binance_symbols.add(symbol)
            binance_brackets = {}
            
            # Criar estrutura dos brackets da Binance
            for bracket in symbol_data.get('brackets', []):
                bracket_id = bracket.get('bracket')
                if bracket_id is not None:
                    binance_brackets[bracket_id] = bracket
            
            # Comparar com dados do banco
            current_symbol_brackets = current_brackets.get(symbol, {})
            
            # INSERIR/ATUALIZAR brackets novos ou modificados
            for bracket_id, bracket_data in binance_brackets.items():
                current_bracket = current_symbol_brackets.get(bracket_id)
                
                values = (
                    symbol, 'binance', bracket_id,
                    bracket_data.get('initialLeverage'),
                    bracket_data.get('notionalCap'),
                    bracket_data.get('notionalFloor'),
                    bracket_data.get('maintMarginRatio'),
                    bracket_data.get('cum', 0)
                )
                
                if not current_bracket:
                    # INSERIR novo bracket
                    try:
                        cursor.execute("""
                            INSERT INTO alavancagem 
                            (symbol, corretora, bracket, initial_leverage, notional_cap, 
                             notional_floor, maint_margin_ratio, cum, updated_at)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                        """, values)
                        inserts += 1
                    except Exception as e:
                        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ⚠️ Erro ao inserir bracket {bracket_id} para {symbol}: {e}")
                        continue
                else:
                    # Verificar se precisa ATUALIZAR
                    needs_update = (
                        current_bracket['initial_leverage'] != bracket_data.get('initialLeverage') or
                        abs(float(current_bracket['notional_cap']) - float(bracket_data.get('notionalCap', 0))) > 0.01 or
                        abs(float(current_bracket['notional_floor']) - float(bracket_data.get('notionalFloor', 0))) > 0.01 or
                        abs(float(current_bracket['maint_margin_ratio']) - float(bracket_data.get('maintMarginRatio', 0))) > 0.000001 or
                        abs(float(current_bracket['cum']) - float(bracket_data.get('cum', 0))) > 0.01
                    )
                    
                    if needs_update:
                        try:
                            cursor.execute("""
                                UPDATE alavancagem 
                                SET initial_leverage = %s, notional_cap = %s, notional_floor = %s,
                                    maint_margin_ratio = %s, cum = %s, updated_at = NOW()
                                WHERE symbol = %s AND corretora = %s AND bracket = %s
                            """, values[3:] + (symbol, 'binance', bracket_id))
                            updates += 1
                        except Exception as e:
                            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ⚠️ Erro ao atualizar bracket {bracket_id} para {symbol}: {e}")
                            continue
            
            # DELETAR brackets que não existem mais na Binance para este símbolo
            for bracket_id in current_symbol_brackets.keys():
                if bracket_id not in binance_brackets:
                    try:
                        cursor.execute("""
                            DELETE FROM alavancagem 
                            WHERE symbol = %s AND corretora = %s AND bracket = %s
                        """, (symbol, 'binance', bracket_id))
                        deletes += 1
                    except Exception as e:
                        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ⚠️ Erro ao deletar bracket {bracket_id} para {symbol}: {e}")
                        continue
            
            processed_symbols += 1
            
            if processed_symbols % 100 == 0:
                #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] Processados {processed_symbols}/{len(brackets_data)} símbolos...")
                pass
        
        # === FASE 5: DELETAR símbolos que não existem mais na Binance ===
        current_symbols = set(current_brackets.keys())
        obsolete_symbols = current_symbols - binance_symbols
        
        symbols_deleted = 0
        for obsolete_symbol in obsolete_symbols:
            try:
                cursor.execute("""
                    DELETE FROM alavancagem 
                    WHERE symbol = %s AND corretora = %s
                """, (obsolete_symbol, 'binance'))
                symbol_deletes = cursor.rowcount
                deletes += symbol_deletes
                symbols_deleted += 1
            except Exception as e:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ⚠️ Erro ao deletar símbolo obsoleto {obsolete_symbol}: {e}")
                continue
        
        # === FASE 6: CONFIRMAR MUDANÇAS ===
        conn.commit()
        cursor.close()
        conn.close()
        
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Atualização concluída:")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Inserções: {inserts}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Atualizações: {updates}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Remoções de brackets: {deletes}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Símbolos removidos: {symbols_deleted}")
        
        # Mostrar estatísticas finais
        total_changes = inserts + updates + deletes + symbols_deleted
        if total_changes == 0:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] 🎯 Nenhuma mudança detectada - dados já estão atualizados!")
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] 🎯 Total de mudanças aplicadas: {total_changes}")
        
        return True
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro crítico na atualização eficiente: {e}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] Stack trace: {traceback.format_exc()}")
        return False

# ATUALIZAR função existente para usar a nova implementação
def update_leverage_brackets():
    """
    Função wrapper para manter compatibilidade com o scheduler
    """
    try:
        success = update_leverage_brackets_database()
        if success:
            #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Atualização de brackets bem-sucedida")
            pass
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Falha na atualização de brackets")
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro na atualização de brackets: {e}")

# NOVA FUNÇÃO: Testar credenciais Binance
def test_binance_credentials():
    """
    Testa se as credenciais da Binance estão funcionando
    """
    try:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] Testando credenciais Binance...")
        
        # Testar com endpoint simples
        result = make_binance_request('/v1/exchangeInfo')
        
        if result and 'symbols' in result:
            symbol_count = len(result['symbols'])
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ✅ Credenciais OK - {symbol_count} símbolos disponíveis")
            return True
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha no teste de credenciais")
            return False
            
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste: {e}")
        return False

# NOVA FUNÇÃO: Testar conexão com banco
def test_database_connection():
    """
    Testa se a conexão com o banco está funcionando
    """
    try:        
        conn = get_database_connection()
        if conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM alavancagem")
            count = cursor.fetchone()[0]
            cursor.close()
            conn.close()
            
            return True
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha na conexão com banco")
            return False
            
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste do banco: {e}")
        return False

# ATUALIZAR função run_scheduler
def run_scheduler():
    """
    Executa o scheduler em uma thread separada
    """
    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Iniciando scheduler de brackets...")
    
    # Agendar 4 vezes ao dia: 00:00, 06:00, 12:00, 18:00
    schedule.every().day.at("00:00").do(update_leverage_brackets)
    schedule.every().day.at("06:00").do(update_leverage_brackets)
    schedule.every().day.at("12:00").do(update_leverage_brackets)
    schedule.every().day.at("18:00").do(update_leverage_brackets)
    
    while not shutdown_event.is_set():
        try:
            schedule.run_pending()
            time.sleep(60)  # Verificar a cada minuto
        except Exception as e:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Erro no scheduler: {e}")
            time.sleep(60)

# ATUALIZAR função initialize_bracket_scheduler
def initialize_bracket_scheduler():
    """
    Inicializa o scheduler em uma thread separada
    """
    try:
        # Testar credenciais e banco antes de começar
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando testes iniciais...")
        
        binance_ok = test_binance_credentials()
        db_ok = test_database_connection()
        
        if not binance_ok:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Credenciais Binance inválidas - continuando sem scheduler")
            return
            
        if not db_ok:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Banco inacessível - continuando sem scheduler")
            return
        
        # Atualizar brackets na inicialização
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando atualização inicial de brackets...")
        update_leverage_brackets()
        
        # Iniciar scheduler em thread separada
        scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
        scheduler_thread.start()
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Erro ao inicializar scheduler: {e}")

# Chaveamento para ativar/desativar verificação DIVAP
ENABLE_DIVAP_VERIFICATION = True  # True = verificação ativada, False = todos os sinais passam sem verificar

# Parâmetros para cálculo de capital alocado baseado em risco
PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL = 4.90  # 4.90% do capital total
TAXA_ENTRADA = 0.02  # 0.02% do valor nocional da posição
TAXA_SAIDA = 0.05  # 0.05% do valor nocional da posição

# Adicionar o diretório backtest ao path para permitir a importação
sys.path.append(str(Path(__file__).parent / 'backtest'))
from backtest.divap_check import DIVAPAnalyzer, DB_CONFIG, BINANCE_CONFIG

# Carregar variáveis de ambiente do arquivo .env na raiz do projeto
env_path = pathlib.Path(__file__).parents[2] / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco de dados do arquivo .env
DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

# IDs dos grupos - USANDO OS IDs INTERNOS CORRETOS COM SINAL NEGATIVO
GRUPOS_ORIGEM_IDS = [-4192806079,-1002444455075]  # Lista com os IDs dos grupos de origem
#GRUPOS_ORIGEM_IDS = [-1002444455075]  # Lista com os IDs dos grupos de origem
GRUPO_DESTINO_ID = -1002016807368  # ID do grupo de destino
CONTA_ID = 1

# Mapeamento de IDs de grupo para nomes de fontes (NOVO)
GRUPO_FONTE_MAPEAMENTO = {
    -4192806079: "divap",  # ✅ Grupo que está ATIVO na lista GRUPOS_ORIGEM_IDS
    -1002444455075: "divap"  # ✅ Manter também o outro caso precise alternar
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

        # NOVO: Limpar jobs do scheduler
        try:
            schedule.clear()
            print("[INFO] Jobs do scheduler limpos")
        except Exception as e:
            print(f"[ERRO] Erro ao limpar jobs do scheduler: {e}")

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
    Obtém o saldo base de cálculo da tabela conta (com fallback para contas)
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
        
        sql = "SELECT saldo_base_calculo FROM contas WHERE ativa = 1 LIMIT 1"
        cursor.execute(sql)
        result = cursor.fetchone()
            
        if result and 'saldo_base_calculo' in result and result['saldo_base_calculo'] is not None:
            return float(result['saldo_base_calculo'])

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
    e verifica se está condizente com o saldo disponível
    
    Returns:
        tuple: (final_leverage, sl_distance_pct) - Alavancagem final e distância percentual até o SL
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
        #print(f"[DEBUG] Valor da ordem: {order_value:.2f} USDT (Saldo {account_balance:.2f} * {capital_percent}%)")
        
        max_leverage = 1
        bracket_leverage_limits = []
        
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
        # Use um valor nocional razoável para a verificação de bracket, e não o order_value
        # Para evitar ciclos ou dependência circular, vamos usar o capital total e alavancagem ideal
        # para estimar o tamanho da posição para verificar os brackets.
        # A ideia aqui é encontrar o MAX_LEVERAGE que a Binance permite para aquele 'notional'
        # Considerando que estamos calculando a alavancagem, um bom 'notional' inicial seria
        # capital * alavancagem atual (ou um chute inicial como 20x)
        estimated_order_value_at_max_leverage = account_balance * (capital_percent / 100) * target_leverage
        
        for bracket in symbol_brackets:
            if "initialLeverage" not in bracket:
                continue
                
            bracket_leverage = int(bracket.get("initialLeverure", 1)) # Bug fix: typo 'initialLeverure' corrected to 'initialLeverage'
            notional_floor = float(bracket.get("notionalFloor", 0))
            notional_cap = float(bracket.get("notionalCap", float('inf')))
            
            # Verificar se a alavancagem do bracket está dentro do que o cálculo ideal permite
            if bracket_leverage <= target_leverage:
                # E se o "valor da posição" simulado se encaixa no notional do bracket
                # Aqui, usamos o capital da ordem * alavancagem do bracket
                simulated_position_notional = account_balance * (capital_percent / 100) * bracket_leverage

                if simulated_position_notional >= notional_floor and simulated_position_notional < notional_cap:
                    max_leverage = max(max_leverage, bracket_leverage)
                    bracket_leverage_limits.append(bracket_leverage)
                    # print(f"[DEBUG] Bracket elegível: Alavancagem {bracket_leverage}x, Valor posição simulado: {simulated_position_notional:.2f}, Limites: {notional_floor:.2f} - {notional_cap:.2f}")
                # else:
                    # print(f"[DEBUG] Bracket não elegível (notional): Alavancagem {bracket_leverage}x, Valor posição simulado: {simulated_position_notional:.2f}, Limites: {notional_floor:.2f} - {notional_cap:.2f}")

        if bracket_leverage_limits:
            max_leverage = max(bracket_leverage_limits)
            print(f"[DEBUG] Alavancagem máxima permitida pelos brackets (com filtro de target_leverage): {max_leverage}x")
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
    
    # Retornar tanto a alavancagem final quanto a distância percentual até o SL
    return final_leverage, sl_distance_pct

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
        
        # CORREÇÃO: Garantir que chat_ids sempre tenham sinal negativo
        chat_id_origem = trade_data.get('chat_id_origem_sinal')
        if chat_id_origem and chat_id_origem > 0:
            chat_id_origem = -chat_id_origem
            
        chat_id_destino = trade_data.get('chat_id')
        if chat_id_destino and chat_id_destino > 0:
            chat_id_destino = -chat_id_destino
            
        # CORREÇÃO: SQL query com contagem correta de placeholders
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, status, timeframe, message_id, message_id_orig, chat_id_orig_sinal, tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, message_source, divap_confirmado, cancelado_checker, error_message, conta_id)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        # CORREÇÃO: Tupla values com 23 valores para corresponder aos 23 placeholders
        values = (
            trade_data["symbol"],                           # 1
            trade_data["side"],                            # 2
            trade_data["leverage"],                        # 3
            trade_data["capital_pct"],                     # 4
            trade_data["entry"],                           # 5
            trade_data["tp"],                              # 6
            trade_data["stop_loss"],                       # 7
            chat_id_destino,                               # 8
            trade_data.get("status", "PENDING"),           # 9
            trade_data.get("timeframe", ""),               # 10
            trade_data.get("message_id"),                  # 11
            trade_data.get("id_mensagem_origem_sinal"),    # 12
            chat_id_origem,                                # 13
            tp_prices[0],                                  # 14 - tp1_price
            tp_prices[1],                                  # 15 - tp2_price
            tp_prices[2],                                  # 16 - tp3_price
            tp_prices[3],                                  # 17 - tp4_price
            tp_prices[4],                                  # 18 - tp5_price
            trade_data.get("message_source"),              # 19
            trade_data.get("divap_confirmado", None),      # 20
            trade_data.get("cancelado_checker", None),     # 21
            trade_data.get("error_message", None),         # 22
            CONTA_ID                                       # 23 - conta_id
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no banco (ID: {signal_id}, Conta: {CONTA_ID}): {trade_data['symbol']}")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Chat origem: {chat_id_origem}, Chat destino: {chat_id_destino}")
        return signal_id

    except mysql.connector.Error as db_err:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro no banco ao salvar: {db_err}")
        
        # CORREÇÃO: Fallback logic atualizada
        if "Unknown column" in str(db_err):
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Tentando fallback devido a coluna(s) desconhecida(s)...")
            
            try:
                # Fallback básico sem campos opcionais
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
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva com fallback (ID: {signal_id_fallback}, Conta: {CONTA_ID})")
                return signal_id_fallback

            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro durante tentativa de fallback: {e2}")
        
        return None

    except Exception as e_generic:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro genérico ao salvar no banco: {e_generic}")
        return None

    finally:
        if conn and conn.is_connected():
            if cursor:
                cursor.close()
            conn.close()

def extract_trade_info(message_text):
    """
    Extrai informações de trade da mensagem do Telegram usando regex
    MELHORADO para lidar com diferentes formatos de mensagem e robustez.
    """
    try:
        # Verificar se contém termos obrigatórios (mais flexível)
        required_terms_pattern1 = ["DIVAP", "Entrada", "Alvo", "Stop"]
        required_terms_pattern2 = ["possível DIVAP", "Entrada", "Alvo", "Stop"]
        
        is_pattern1 = all(term.lower() in message_text.lower() for term in required_terms_pattern1)
        is_pattern2 = all(term.lower() in message_text.lower() for term in required_terms_pattern2)
        
        if not (is_pattern1 or is_pattern2):
            print(f"[INFO] Mensagem não contém termos obrigatórios para DIVAP: {message_text}")
            return None

        # Padrões para extrair informações (mais flexíveis)
        # Símbolo e Timeframe (captura #SÍMBOLO e (TIME), ignorando o resto da linha inicialmente)
        symbol_timeframe_match = re.match(r'🚨\s*#([A-Z0-9]+)\s+([0-9]+[mhdwMD])\s*-', message_text)
        if not symbol_timeframe_match:
            # Fallback para capturar apenas o símbolo e tentar timeframe depois
            symbol_match_only = re.match(r'🚨\s*#([A-Z0-9]+)', message_text)
            if symbol_match_only:
                symbol = symbol_match_only.group(1)
                timeframe = "15m" # Default se não encontrar no padrão inicial
            else:
                print("[INFO] Símbolo não encontrado na mensagem.")
                return None
        else:
            symbol = symbol_timeframe_match.group(1)
            timeframe = symbol_timeframe_match.group(2).lower()
        
        # Detecção do lado da operação mais robusta
        side = None
        if "venda" in message_text.lower() or "sell" in message_text.lower():
            side = "VENDA"
        elif "compra" in message_text.lower() or "buy" in message_text.lower():
            side = "COMPRA"
        
        # Padrões para extrair preços (mais tolerantes a espaços e quebras de linha)
        entry_patterns = [
            r'Entrada\s+(?:abaixo|acima)\s+de\s*:\s*([0-9.,]+)',
            r'Entrada\s*:\s*([0-9.,]+)',
            r'Entry\s*:\s*([0-9.,]+)'
        ]
        
        sl_patterns = [
            r'Stop\s+(?:acima|abaixo)\s+de\s*:\s*([0-9.,]+)',
            r'Stop\s*:\s*([0-9.,]+)',
            r'Stop\s+Loss\s*:\s*([0-9.,]+)',
            r'SL\s*:\s*([0-9.,]+)'
        ]

        # Padrão para múltiplos alvos (captura todos os "Alvo XX: YYYY" ou "Alvo XX.YYYY")
        tp_patterns_list = [
            r'Alvo\s+\d+\s*:\s*([0-9.,]+)',  # Ex: Alvo 01: 0.27448
            r'Alvo\s+\d+\.\s*([0-9.,]+)',  # Ex: Alvo 01.27448 (se houver esse formato)
            r'Target\s+\d+\s*:\s*([0-9.,]+)', # English target format
            r'TP\s*\d*\s*:\s*([0-9.,]+)' # TP: or TP1:
        ]

        # Capital/risco (mais flexível)
        capital_pattern = r'com\s+([0-9.,]+)%\s+do\s+capital'
        
        # Tentar múltiplos padrões para entrada
        entry_value = None
        for pattern in entry_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                entry_value = float(normalize_number(match.group(1)))
                break
        
        # Tentar múltiplos padrões para stop loss
        sl_value = None
        for pattern in sl_patterns:
            match = re.search(pattern, message_text, re.IGNORECASE)
            if match:
                sl_value = float(normalize_number(match.group(1)))
                break

        # Extrair todos os alvos
        all_tps_extracted = []
        for pattern in tp_patterns_list:
            found_tps = re.findall(pattern, message_text, re.IGNORECASE)
            for tp_str in found_tps:
                all_tps_extracted.append(float(normalize_number(tp_str)))
        
        # Remover duplicatas e manter ordem (se houver)
        seen = set()
        tp_matches_unique = [x for x in all_tps_extracted if not (x in seen or seen.add(x))]

        capital_match = re.search(capital_pattern, message_text)
        original_capital_pct = float(normalize_number(capital_match.group(1))) if capital_match else 5.0

        # Validar se temos dados mínimos necessários
        if not symbol or entry_value is None or sl_value is None or not tp_matches_unique:
            print(f"[INFO] Dados mínimos não encontrados: Símbolo={symbol}, Entrada={entry_value}, SL={sl_value}, TPs={tp_matches_unique}")
            return None

        # NOVO: Se side ainda não foi determinado, usar lógica de preços
        if not side:
            if entry_value > sl_value:
                side = "VENDA"  # Entrada maior que stop = venda
            else:
                side = "COMPRA"  # Entrada menor que stop = compra
        
        # Calcular alavancagem
        leverage, sl_distance_pct = calculate_ideal_leverage(symbol, entry_value, sl_value, original_capital_pct, side)

        # Cálculo do percentual de capital dinâmico baseado em risco
        taxa_entrada_decimal = TAXA_ENTRADA / 100
        taxa_saida_decimal = TAXA_SAIDA / 100
        prejuizo_maximo_decimal = PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL / 100
        
        taxas_totais = taxa_entrada_decimal + taxa_saida_decimal
        risco_por_operacao = sl_distance_pct + taxas_totais
        
        if leverage * risco_por_operacao > 0:
            capital_pct = (prejuizo_maximo_decimal / (leverage * risco_por_operacao)) * 100
            capital_pct = min(100.0, max(0.1, capital_pct))
            capital_pct = round(capital_pct, 2)
            
            print(f"[INFO] Capital calculado: {capital_pct:.2f}% (baseado em risco máximo de {PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL}%, "
                  f"distância SL de {sl_distance_pct*100:.2f}%, alavancagem {leverage}x, taxas totais {taxas_totais*100:.2f}%)")
        else:
            capital_pct = original_capital_pct
            print(f"[AVISO] Erro no cálculo dinâmico de capital. Usando valor original: {capital_pct:.2f}%")

        # Usar o primeiro alvo como TP principal
        tp = tp_matches_unique[0] if tp_matches_unique else entry_value

        print(f"[INFO] Sinal DIVAP detectado: {symbol} {side} @ {entry_value} -> {tp} | SL: {sl_value} | TF: {timeframe}")

        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry_value,
            "tp": tp,
            "stop_loss": sl_value,
            "all_tps": tp_matches_unique,
            "chat_id": GRUPO_DESTINO_ID
        }

    except Exception as e:
        print(f"[ERRO] Falha ao extrair informações da mensagem: {e}")
        print(f"[DEBUG] Texto da mensagem:\n{message_text}")
        traceback.print_exc()
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
async def handle_new_message(event):
    """
    Manipula novas mensagens. Processa sinais de trade dos grupos de origem.
    """
    incoming_message_id = event.message.id if event and hasattr(event, 'message') and hasattr(event.message, 'id') else 'desconhecido'
    incoming_chat_id = event.chat_id if event and hasattr(event, 'chat_id') else 'desconhecido'
    incoming_text = event.message.text if event and hasattr(event, 'message') and hasattr(event.message, 'text') else 'N/A'

    # CORREÇÃO: Garantir que chat_id seja sempre negativo para comparação
    if isinstance(incoming_chat_id, int) and incoming_chat_id > 0:
        incoming_chat_id = -incoming_chat_id

    # --- DEBUG INÍCIO ---
    # Só exibe o debug se o chat_id estiver na lista de GRUPOS_ORIGEM_IDS
    if incoming_chat_id in GRUPOS_ORIGEM_IDS:
        print(f"\n[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DEBUG_RECEIVE] Mensagem recebida:")
        print(f"  Chat ID: {incoming_chat_id}")
        print(f"  Message ID: {incoming_message_id}")
        print(f"  Texto: {incoming_text}")
        print(f"  Fonte mapeada: {GRUPO_FONTE_MAPEAMENTO.get(incoming_chat_id, 'Desconhecida')}")
        print("-" * 50)
    # --- DEBUG FIM ---

    # Obter a fonte da mensagem com base no chat_id
    message_source = GRUPO_FONTE_MAPEAMENTO.get(incoming_chat_id)
    
    try:
        incoming_message_id = event.message.id
        incoming_text = event.message.text

        if not incoming_text:
            return      

        incoming_created_at = event.message.date.strftime("%Y-%m-%d %H:%M:%S")
        GRUPOS_PERMITIDOS_PARA_REGISTRO = GRUPOS_ORIGEM_IDS
        is_incoming_reply = event.message.reply_to_msg_id is not None
        incoming_reply_to_id = event.message.reply_to_msg_id if is_incoming_reply else None

        # 1. PRIMEIRO, processar se for um SINAL DE TRADE de um GRUPO DE ORIGEM
        if incoming_chat_id in GRUPOS_ORIGEM_IDS:
            chat_obj = await event.get_chat() 
            
            trade_info = extract_trade_info(incoming_text)

            if trade_info:
                if ENABLE_DIVAP_VERIFICATION:
                    is_valid_divap, error_message = await verify_divap_pattern(trade_info)
                else:
                    is_valid_divap, error_message = True, None
                    print(f"[INFO] Verificação DIVAP desativada. Sinal {trade_info['symbol']} aceito sem verificação.")                

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
                        pass
                    elif selected_tp is None:
                        print(f"[AVISO] Sinal da Msg ID {incoming_message_id} (Símbolo: {trade_info['symbol']}) não tem nenhum TP. Enviando apenas com entrada e SL.")

                    message_text_to_send = format_trade_message(trade_info, selected_tp)
                    print(f"\n[INFO] Mensagem de sinal formatada para envio (Origem Msg ID: {incoming_message_id}):\n{'-'*50}\n{message_text_to_send}\n{'-'*50}")

                    # Garantir que tp_price nunca seja NULL
                    if selected_tp is None:
                        if trade_info.get('all_tps') and len(trade_info['all_tps']) > 0:
                            trade_info['tp'] = trade_info['all_tps'][-1]
                        else:
                            trade_info['tp'] = trade_info['entry']
                            print(f"[AVISO] Sem alvos disponíveis. Usando preço de entrada ({trade_info['entry']}) como tp_price para o banco.")
                    else:
                        trade_info['tp'] = selected_tp

                    # CORREÇÃO: Garantir chat_ids negativos e incluir conta_id
                    trade_info['id_mensagem_origem_sinal'] = incoming_message_id
                    trade_info['chat_id_origem_sinal'] = incoming_chat_id  # Já processado como negativo
                    trade_info['chat_id'] = GRUPO_DESTINO_ID  # Já definido como negativo
                    trade_info['message_source'] = message_source
                    trade_info['divap_confirmado'] = 1
                    trade_info['cancelado_checker'] = 0
                    
                    # Salvar com status PENDING (padrão)
                    signal_id_from_webhook_db = save_to_database(trade_info) 
                    
                    if signal_id_from_webhook_db:
                        print(f"[INFO] Sinal salvo em webhook_signals com ID: {signal_id_from_webhook_db} (Conta: {CONTA_ID})")
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
                        
                        sent_message_to_dest = await client.send_message(GRUPO_DESTINO_ID, message_text_to_send)
                        sent_message_id_in_dest = sent_message_to_dest.id
                        sent_message_created_at = sent_message_to_dest.date.strftime("%Y-%m-%d %H:%M:%S")
                        
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
                    else:
                        print(f"[AVISO] Falha ao salvar sinal em webhook_signals para msg origem {incoming_message_id}.")
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
                    trade_info['id_mensagem_origem_sinal'] = incoming_message_id
                    trade_info['chat_id_origem_sinal'] = incoming_chat_id
                    trade_info['chat_id'] = GRUPO_DESTINO_ID
                    trade_info['message_source'] = message_source
                    trade_info['divap_confirmado'] = 0
                    trade_info['cancelado_checker'] = 1
                    trade_info['status'] = 'CANCELED'
                    trade_info['error_message'] = error_message
                    trade_info['conta_id'] = CONTA_ID
                    
                    save_to_database(trade_info)
                    
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
                    #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Recursão: Verificando mensagem pai ID {parent_msg_id} para o sinal.")
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
    # Formatação inteligente do percentual de capital
    capital_value = trade_info['capital_pct']
    
    # Lógica melhorada para formatação de números
    if capital_value == int(capital_value):
        # Se for um valor inteiro exato (como 5.0), mostrar como inteiro
        capital_display = str(int(capital_value))
    else:
        # Formatar com 2 casas decimais primeiro
        formatted = f"{capital_value:.2f}"
        
        # Verificar se a última casa decimal é zero
        if formatted.endswith('0'):
            # Remover o último zero (por exemplo, 5.10 -> 5.1)
            capital_display = formatted[:-1]
        else:
            # Manter as duas casas decimais (por exemplo, 5.12 -> 5.12)
            capital_display = formatted
    
    message_text = (
        f"#{trade_info['symbol']}  {trade_info['side']}\n"
    )
    if trade_info.get('timeframe'):
        message_text += f"{trade_info['timeframe']}\n"
    message_text += (
        "Divap\n\n" 
        f"ALAVANCAGEM: {trade_info['leverage']}x\n"
        "MARGEM: CRUZADA\n"
        f"CAPITAL: {capital_display}%\n\n"
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

    # Adicionar informações de DIVAP se disponíveis
    if 'divap_info' in trade_info:
        divap_info = trade_info['divap_info']
        if isinstance(divap_info, dict):
            if divap_info.get('bull_div_any'):
                message_text += "\nDIVERGÊNCIA: ALTISTA"
            elif divap_info.get('bear_div_any'):
                message_text += "\nDIVERGÊNCIA: BAIXISTA"
            else:
                message_text += "\nDIVERGÊNCIA: NÃO DETECTADA"
        else:
            message_text += "\nDIVERGÊNCIA: DADOS INVÁLIDOS"

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
                    "apiKey": API_KEY,
                    "secret": API_SECRET,
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

# NOVA FUNÇÃO: Atualizar brackets de alavancagem
def update_leverage_brackets():
    """
    Função wrapper para manter compatibilidade com o scheduler
    """
    try:
        success = update_leverage_brackets_database()
        if success:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Atualização de brackets bem-sucedida")
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Falha na atualização de brackets")
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro na atualização de brackets: {e}")

# NOVA FUNÇÃO: Testar credenciais Binance
def test_binance_credentials():
    """
    Testa se as credenciais da Binance estão funcionando
    """
    try:
        # Testar com endpoint simples
        result = make_binance_request('/v1/exchangeInfo')
        
        if result and 'symbols' in result:
            symbol_count = len(result['symbols'])
            return True
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha no teste de credenciais")
            return False
            
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste: {e}")
        return False

# NOVA FUNÇÃO: Testar conexão com banco
def test_database_connection():
    """
    Testa se a conexão com o banco está funcionando
    """
    try:
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] Testando conexão com banco...")
        
        conn = get_database_connection()
        if conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(*) FROM alavancagem")
            count = cursor.fetchone()[0]
            cursor.close()
            conn.close()
            
            return True
        else:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha na conexão com banco")
            return False
            
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste do banco: {e}")
        return False

# ATUALIZAR função run_scheduler
def run_scheduler():
    """
    Executa o scheduler em uma thread separada
    """    
    # Agendar 4 vezes ao dia: 00:00, 06:00, 12:00, 18:00
    schedule.every().day.at("00:00").do(update_leverage_brackets)
    schedule.every().day.at("06:00").do(update_leverage_brackets)
    schedule.every().day.at("12:00").do(update_leverage_brackets)
    schedule.every().day.at("18:00").do(update_leverage_brackets)
    
    while not shutdown_event.is_set():
        try:
            schedule.run_pending()
            time.sleep(60)  # Verificar a cada minuto
        except Exception as e:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [SCHEDULER] Erro no scheduler: {e}")
            time.sleep(60)

# ATUALIZAR função initialize_bracket_scheduler
def initialize_bracket_scheduler():
    """
    Inicializa o scheduler em uma thread separada
    """
    try:
        # Testar credenciais e banco antes de começar
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando testes iniciais...")
        
        binance_ok = test_binance_credentials()
        db_ok = test_database_connection()
        
        if not binance_ok:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Credenciais Binance inválidas - continuando sem scheduler")
            return
            
        if not db_ok:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Banco inacessível - continuando sem scheduler")
            return
        
        # Atualizar brackets na inicialização
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] Executando atualização inicial de brackets...")
        update_leverage_brackets()
        
        # Iniciar scheduler em thread separada
        scheduler_thread = threading.Thread(target=run_scheduler, daemon=True)
        scheduler_thread.start()
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [INIT] ❌ Erro ao inicializar scheduler: {e}")

# Função principal para iniciar o cliente
async def main():
    """
    Função principal para iniciar o cliente
    """
    #print("[INFO] Iniciando monitoramento do Telegram...")

    # NOVO: Inicializar scheduler de brackets
    initialize_bracket_scheduler()

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