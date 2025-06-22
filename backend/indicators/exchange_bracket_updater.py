import os
import time
import datetime
import hmac
import hashlib
import json
import traceback
import requests
import mysql.connector
from urllib.parse import urlencode
from dotenv import load_dotenv
import pathlib
import warnings
import logging

# Carregar variáveis de ambiente do arquivo .env
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Importar senhas após carregar o .env
from senhas import API_KEY, API_SECRET, API_URL

# Configuração de logging
logging.basicConfig(level=logging.ERROR)
warnings.filterwarnings("ignore", category=DeprecationWarning)

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
    """
    Obtém conexão com o banco de dados MySQL.
    """
    try:
        conn = mysql.connector.connect(**DB_CONFIG)
        return conn
    except mysql.connector.Error as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [DB] Erro ao conectar: {e}")
        return None

def create_binance_signature(query_string, secret):
    """
    Cria assinatura HMAC-SHA256 para API Binance.
    """
    return hmac.new(
        secret.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()

def make_binance_request(endpoint, params=None):
    """
    Faz requisição autenticada para API Binance.
    """
    try:
        if params is None:
            params = {}
        
        timestamp = int(time.time() * 1000)
        params['timestamp'] = timestamp
        
        query_string = urlencode(params)
        signature = create_binance_signature(query_string, API_SECRET)
        
        url = f"{API_URL}{endpoint}?{query_string}&signature={signature}"
        
        headers = {
            'X-MBX-APIKEY': API_KEY,
            'Content-Type': 'application/json'
        }
        
        response = requests.get(url, headers=headers, timeout=30)
        
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

def update_leverage_brackets_database():
    """
    Atualiza os brackets de alavancagem no banco de dados de forma otimizada.
    """
    try:
        # FASE 1: OBTER DADOS DA BINANCE
        brackets_data = make_binance_request('/v1/leverageBracket')
        
        if not brackets_data or not isinstance(brackets_data, list):
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Resposta inválida da API Binance")
            return False
        
        # FASE 2: CONECTAR AO BANCO
        conn = get_database_connection()
        if not conn:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro ao conectar ao banco de dados")
            return False
        
        cursor = conn.cursor(dictionary=True)
        
        cursor.execute("SELECT symbol, bracket, initial_leverage, notional_cap, notional_floor, maint_margin_ratio, cum FROM exchange_leverage_brackets WHERE corretora = 'binance' ORDER BY symbol, bracket")
        current_data = cursor.fetchall()
        
        current_brackets = {}
        for row in current_data:
            symbol = row['symbol']
            if symbol not in current_brackets:
                current_brackets[symbol] = {}
            current_brackets[symbol][row['bracket']] = row
        
        # FASE 4: PROCESSAR DIFERENÇAS
        binance_symbols, updates, inserts, deletes, processed_symbols = set(), 0, 0, 0, 0
        
        for symbol_data in brackets_data:
            symbol = symbol_data.get('symbol')
            if not symbol: continue
                
            binance_symbols.add(symbol)
            binance_brackets = {b.get('bracket'): b for b in symbol_data.get('brackets', []) if b.get('bracket') is not None}
            current_symbol_brackets = current_brackets.get(symbol, {})
            
            # INSERIR/ATUALIZAR
            for bracket_id, bracket_data in binance_brackets.items():
                current_bracket = current_symbol_brackets.get(bracket_id)
                values = (symbol, 'binance', bracket_id, bracket_data.get('initialLeverage'), bracket_data.get('notionalCap'), bracket_data.get('notionalFloor'), bracket_data.get('maintMarginRatio'), bracket_data.get('cum', 0))
                
                if not current_bracket:
                    cursor.execute("INSERT INTO alavancagem (symbol, corretora, bracket, initial_leverage, notional_cap, notional_floor, maint_margin_ratio, cum, updated_at) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())", values)
                    inserts += 1
                else:
                    needs_update = (current_bracket['initial_leverage'] != bracket_data.get('initialLeverage') or abs(float(current_bracket['notional_cap']) - float(bracket_data.get('notionalCap', 0))) > 0.01 or abs(float(current_bracket['notional_floor']) - float(bracket_data.get('notionalFloor', 0))) > 0.01 or abs(float(current_bracket['maint_margin_ratio']) - float(bracket_data.get('maintMarginRatio', 0))) > 0.000001 or abs(float(current_bracket['cum']) - float(bracket_data.get('cum', 0))) > 0.01)
                    if needs_update:
                        cursor.execute("UPDATE alavancagem SET initial_leverage = %s, notional_cap = %s, notional_floor = %s, maint_margin_ratio = %s, cum = %s, updated_at = NOW() WHERE symbol = %s AND corretora = %s AND bracket = %s", values[3:] + (symbol, 'binance', bracket_id))
                        updates += 1
            
            # DELETAR
            for bracket_id in current_symbol_brackets:
                if bracket_id not in binance_brackets:
                    cursor.execute("DELETE FROM exchange_leverage_brackets WHERE symbol = %s AND corretora = %s AND bracket = %s", (symbol, 'binance', bracket_id))
                    deletes += 1
            
            processed_symbols += 1
        
        # FASE 5: DELETAR símbolos obsoletos
        obsolete_symbols = set(current_brackets.keys()) - binance_symbols
        symbols_deleted = 0
        for obsolete_symbol in obsolete_symbols:
            cursor.execute("DELETE FROM exchange_leverage_brackets WHERE symbol = %s AND corretora = %s", (obsolete_symbol, 'binance'))
            deletes += cursor.rowcount
            symbols_deleted += 1
        
        # FASE 6: CONFIRMAR E REPORTAR
        conn.commit()
        cursor.close()
        conn.close()
        
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Atualização concluída:")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Inserções: {inserts}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Atualizações: {updates}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Remoções: {deletes}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS]   - Símbolos removidos: {symbols_deleted}")
        
        total_changes = inserts + updates + deletes
        if total_changes == 0:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] 🎯 Nenhuma mudança detectada.")
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] 🎯 Total de mudanças aplicadas: {total_changes}")
        
        return True
        
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro crítico na atualização: {e}")
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] Stack trace: {traceback.format_exc()}")
        return False

def update_leverage_brackets():
    """
    Função wrapper para chamar a atualização do banco de dados.
    """
    try:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] Iniciando atualização de brackets...")
        success = update_leverage_brackets_database()
        if success:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ✅ Processo de atualização de brackets bem-sucedido.")
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Falha no processo de atualização de brackets.")
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [BRACKETS] ❌ Erro ao chamar update_leverage_brackets: {e}")

def test_binance_credentials():
    """
    Testa se as credenciais da Binance estão funcionando.
    """
    try:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] Testando credenciais Binance...")
        result = make_binance_request('/v1/exchangeInfo')
        if result and 'symbols' in result:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ✅ Credenciais OK - {len(result['symbols'])} símbolos disponíveis")
            return True
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha no teste de credenciais")
            return False
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste: {e}")
        return False

def test_database_connection():
    """
    Testa se a conexão com o banco de dados está funcionando.
    """
    try:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] Testando conexão com o banco de dados...")
        conn = get_database_connection()
        if conn:
            cursor = conn.cursor()
            cursor.execute("SELECT COUNT(1) FROM exchange_leverage_brackets")
            count = cursor.fetchone()[0]
            cursor.close()
            conn.close()
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ✅ Conexão com banco OK ({count} registros em 'alavancagem')")
            return True
        else:
            print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Falha na conexão com banco")
            return False
    except Exception as e:
        print(f"[{datetime.datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [TEST] ❌ Erro no teste do banco: {e}")
        return False

# Bloco para execução manual do script
if __name__ == '__main__':
    print("="*50)
    print("Executando atualização manual de Brackets de Alavancagem...")
    print("="*50)
    
    # Testar conexões primeiro
    if test_database_connection() and test_binance_credentials():
        update_leverage_brackets()
    else:
        print("\n[ERRO] A atualização não foi executada devido a falhas nos testes de conexão.")
        
    print("\nScript de atualização manual finalizado.")