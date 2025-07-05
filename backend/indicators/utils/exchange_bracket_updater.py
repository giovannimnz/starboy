import os
import ccxt
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime
import json
from dotenv import load_dotenv
from pathlib import Path

# Configurar o caminho do .env
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

# Configurações da Binance
BINANCE_CONFIG = {
    'apiKey': os.getenv('BINANCE_API_KEY'),
    'secret': os.getenv('BINANCE_SECRET_KEY'),
    'sandbox': False,
    'enableRateLimit': True,
}

def test_binance_credentials():
    """Testa as credenciais da Binance"""
    try:
        exchange = ccxt.binance(BINANCE_CONFIG)
        exchange.load_markets()
        account = exchange.fetch_balance()
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Credenciais Binance válidas")
        return True
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro nas credenciais Binance: {e}")
        return False

def test_database_connection():
    """Testa a conexão com o banco de dados"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor()
        cursor.execute("SELECT 1")
        cursor.fetchone()
        cursor.close()
        conn.close()
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Conexão com banco de dados válida")
        return True
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro na conexão com banco: {e}")
        return False

def update_leverage_brackets():
    """Atualiza os brackets de leverage das moedas"""
    try:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] 🔄 Iniciando atualização de brackets...")
        
        # Conectar na Binance
        exchange = ccxt.binance(BINANCE_CONFIG)
        exchange.load_markets()
        
        # Obter brackets via API privada
        response = exchange.fapiPrivateGetLeverageBracket()
        
        # Conectar no banco
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        changes_count = 0
        
        for bracket_data in response:
            symbol = bracket_data['symbol']
            brackets = bracket_data['brackets']
            
            # Verificar se existe na tabela
            cursor.execute("""
                SELECT leverage_brackets FROM exchange_info 
                WHERE symbol = %s AND exchange = 'binance'
            """, (symbol,))
            
            result = cursor.fetchone()
            
            if result:
                # Comparar brackets
                current_brackets = result['leverage_brackets']
                new_brackets = json.dumps(brackets, sort_keys=True)
                
                if current_brackets != new_brackets:
                    # Atualizar brackets
                    cursor.execute("""
                        UPDATE exchange_info 
                        SET leverage_brackets = %s, updated_at = %s
                        WHERE symbol = %s AND exchange = 'binance'
                    """, (new_brackets, datetime.now(), symbol))
                    changes_count += 1
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] 📊 Brackets atualizados para {symbol}")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Atualização de brackets concluída. {changes_count} alterações")
        return changes_count > 0
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro ao atualizar brackets: {e}")
        return False

if __name__ == "__main__":
    print("Testando Exchange Bracket Updater...")
    print("="*50)
    
    if test_binance_credentials() and test_database_connection():
        update_leverage_brackets()
    else:
        print("❌ Falha nos testes de conectividade")
