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

# Fallback para senhas.py se as variáveis de ambiente não estiverem definidas
if not BINANCE_CONFIG['apiKey'] or not BINANCE_CONFIG['secret']:
    try:
        # Adicionar o diretório pai ao path para encontrar senhas.py
        import sys
        sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        from senhas import API_KEY, API_SECRET
        BINANCE_CONFIG['apiKey'] = API_KEY
        BINANCE_CONFIG['secret'] = API_SECRET
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [CONFIG] Usando credenciais do senhas.py")
    except ImportError:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [ERRO] Credenciais Binance não encontradas")

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
        symbols_inserted = 0
        
        for bracket_data in response:
            symbol = bracket_data['symbol']
            brackets = bracket_data['brackets']
            
            # Verificar se o símbolo existe na tabela exchange_symbols
            cursor.execute("""
                SELECT id FROM exchange_symbols 
                WHERE symbol = %s AND exchange = 'binance'
            """, (symbol,))
            
            symbol_result = cursor.fetchone()
            
            if not symbol_result:
                # Símbolo não encontrado, inserir automaticamente
                try:
                    # Obter informações básicas do símbolo da API
                    market_info = exchange.markets.get(symbol, {})
                    
                    cursor.execute("""
                        INSERT INTO exchange_symbols (exchange, symbol, status, base_asset, quote_asset, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s)
                        RETURNING id
                    """, (
                        'binance',
                        symbol,
                        'TRADING',
                        market_info.get('base', symbol.replace('USDT', '').replace('BUSD', '')),
                        market_info.get('quote', 'USDT'),
                        datetime.now()
                    ))
                    
                    symbol_id = cursor.fetchone()['id']
                    symbols_inserted += 1
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ➕ Símbolo {symbol} inserido automaticamente (ID: {symbol_id})")
                    
                except Exception as e:
                    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro ao inserir símbolo {symbol}: {e}")
                    continue
            else:
                symbol_id = symbol_result['id']
            
            # Processar cada bracket
            for bracket in brackets:
                bracket_num = bracket['bracket']
                
                # Verificar se o bracket já existe
                cursor.execute("""
                    SELECT id FROM exchange_leverage_brackets 
                    WHERE symbol = %s AND corretora = 'binance' AND bracket = %s
                """, (symbol, bracket_num))
                
                existing_bracket = cursor.fetchone()
                
                if existing_bracket:
                    # Atualizar bracket existente
                    cursor.execute("""
                        UPDATE exchange_leverage_brackets 
                        SET initial_leverage = %s, notional_cap = %s, notional_floor = %s,
                            maint_margin_ratio = %s, cum = %s, updated_at = %s
                        WHERE symbol = %s AND corretora = 'binance' AND bracket = %s
                    """, (
                        bracket['initialLeverage'],
                        bracket['notionalCap'],
                        bracket['notionalFloor'],
                        bracket['maintMarginRatio'],
                        bracket['cum'],
                        datetime.now(),
                        symbol,
                        bracket_num
                    ))
                    changes_count += 1
                else:
                    # Inserir novo bracket
                    cursor.execute("""
                        INSERT INTO exchange_leverage_brackets 
                        (symbol, corretora, bracket, initial_leverage, notional_cap, 
                         notional_floor, maint_margin_ratio, cum, updated_at)
                        VALUES (%s, 'binance', %s, %s, %s, %s, %s, %s, %s)
                    """, (
                        symbol,
                        bracket_num,
                        bracket['initialLeverage'],
                        bracket['notionalCap'],
                        bracket['notionalFloor'],
                        bracket['maintMarginRatio'],
                        bracket['cum'],
                        datetime.now()
                    ))
                    changes_count += 1
                    
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] 📊 Brackets processados para {symbol}")
        
        # Verificar e remover símbolos obsoletos (que não existem mais na Binance)
        cursor.execute("""
            SELECT DISTINCT symbol FROM exchange_leverage_brackets 
            WHERE corretora = 'binance'
        """)
        
        db_symbols = {row['symbol'] for row in cursor.fetchall()}
        api_symbols = {bracket_data['symbol'] for bracket_data in response}
        obsolete_symbols = db_symbols - api_symbols
        
        if obsolete_symbols:
            print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] 🗑️ Removendo {len(obsolete_symbols)} símbolos obsoletos")
            for obsolete_symbol in obsolete_symbols:
                cursor.execute("""
                    DELETE FROM exchange_leverage_brackets 
                    WHERE symbol = %s AND corretora = 'binance'
                """, (obsolete_symbol,))
                
                cursor.execute("""
                    DELETE FROM exchange_symbols 
                    WHERE symbol = %s AND exchange = 'binance'
                """, (obsolete_symbol,))
                
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] 🗑️ Removido símbolo obsoleto: {obsolete_symbol}")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ✅ Atualização de brackets concluída:")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}]   • {symbols_inserted} símbolos inseridos")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}]   • {changes_count} brackets atualizados")
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}]   • {len(obsolete_symbols)} símbolos obsoletos removidos")
        
        return changes_count > 0 or symbols_inserted > 0
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] ❌ Erro ao atualizar brackets: {e}")
        if 'conn' in locals():
            conn.rollback()
        return False

if __name__ == "__main__":
    print("Testando Exchange Bracket Updater...")
    print("="*50)
    
    if test_binance_credentials() and test_database_connection():
        update_leverage_brackets()
    else:
        print("❌ Falha nos testes de conectividade")
