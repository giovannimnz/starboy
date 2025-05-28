from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token
import asyncio
import os
import mysql.connector
from urllib.parse import urlencode
from dotenv import load_dotenv
import pathlib

# Carregar variáveis de ambiente do arquivo .env na raiz do projeto
env_path = pathlib.Path(__file__).parents[1] / '.env'
load_dotenv(dotenv_path=env_path)

app = Quart(__name__)

# Configurações do banco de dados do arquivo .env
DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

# Log das configurações do banco para debug (opcional)
print(f"[DB] Configurações carregadas - Host: {DB_HOST}, Porta: {DB_PORT}, DB: {DB_NAME}")

# Grupos do Telegram para diferentes tipos de mensagens
entry_group_id    = 4217341650
stoploss_group_id = 4263252665

# Cliente Telegram
client = TelegramClient('divap', api_id, api_hash)

# Cache para armazenar os resultados das chamadas à API
leverage_brackets_cache = {}
cache_expiry = {}  # Para controlar quanto tempo manter os dados em cache

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
    return side  # Retornar o valor original se não for "BUY" ou "SELL"

# Função para limpar o símbolo (remover ".P" se presente)
def clean_symbol(symbol):
    if not symbol:
        return ""
    if symbol.endswith(".P"):
        return symbol[:-2]  # Remove os últimos 2 caracteres (".P")
    return symbol

# Envia mensagem para Telegram
async def send_telegram_message(chat_id, message):
    entity = await client.get_entity(chat_id)
    await client.send_message(entity, message, parse_mode='markdown')

def get_leverage_brackets_from_database(symbol=None):
    """
    Busca informações de leverage brackets do banco de dados MySQL
    
    Args:
        symbol (str, optional): Símbolo específico para consultar. Se None, retorna todos.
        
    Returns:
        dict: Dicionário com os brackets de alavancagem por símbolo
    """
    try:
        # Configurar conexão MySQL usando variáveis do .env
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT),
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor(dictionary=True)
        
        # Preparar a consulta SQL
        sql = """
        SELECT symbol, bracket, initial_leverage, notional_cap, 
               notional_floor, maint_margin_ratio, cum
        FROM alavancagem
        WHERE corretora = 'binance'
        """
        
        # Adicionar filtro por símbolo se fornecido
        params = []
        if symbol:
            sql += " AND symbol = %s"
            params.append(symbol)
        
        # Ordenar por símbolo e bracket
        sql += " ORDER BY symbol, bracket ASC"
        
        # Executar a consulta
        cursor.execute(sql, params)
        
        # Buscar todos os resultados
        results = cursor.fetchall()
        
        # Organizar os dados por símbolo para fácil acesso
        brackets_by_symbol = {}
        
        for row in results:
            symbol = row['symbol']
            
            # Inicializar o formato apropriado para o símbolo
            if symbol not in brackets_by_symbol:
                brackets_by_symbol[symbol] = []
            
            # Adicionar o bracket à lista do símbolo
            bracket_data = {
                'bracket': row['bracket'],
                'initialLeverage': row['initial_leverage'],
                'notionalCap': float(row['notional_cap']),
                'notionalFloor': float(row['notional_floor']),
                'maintMarginRatio': float(row['maint_margin_ratio']),
                'cum': float(row['cum'])
            }
            
            brackets_by_symbol[symbol].append(bracket_data)
        
        # Log de depuração para os símbolos encontrados
        symbol_count = len(brackets_by_symbol)
        if symbol_count > 0:
            
            # Exemplo de log detalhado para o símbolo específico se solicitado
            if symbol and symbol in brackets_by_symbol:
                brackets = brackets_by_symbol[symbol]
                max_lev = max([b.get('initialLeverage', 1) for b in brackets], default=1)
        else:
            print(f"[AVISO] Nenhum dado de alavancagem encontrado no banco de dados para {symbol or 'qualquer símbolo'}")
        
        return brackets_by_symbol
        
    except Exception as e:
        print(f"[ERRO] Falha ao buscar dados de alavancagem do banco de dados: {e}")
        # Usar API como fallback em caso de erro no banco

    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

def load_leverage_brackets(symbol=None):
    """
    Carrega os brackets de alavancagem do banco de dados MySQL
    
    Args:
        symbol (str, optional): Símbolo específico para buscar
        
    Returns:
        dict: Dicionário com os brackets de alavancagem por símbolo
    """
    # Chama a função que busca do banco de dados
    brackets_data = get_leverage_brackets_from_database(symbol)
    
    # Se foi solicitado um símbolo específico e ele não existir nos dados
    if symbol and symbol not in brackets_data:
        # Tenta limpar o símbolo (remover .P se presente)
        cleaned_symbol = clean_symbol(symbol)
        if cleaned_symbol != symbol and cleaned_symbol in brackets_data:
            return {symbol: brackets_data[cleaned_symbol]}
        
        # Tenta encontrar um símbolo base (ex: BTCUSDT de BTCUSDT_210625)
        base_symbol = symbol.split('_')[0]
        if base_symbol != symbol and base_symbol in brackets_data:
            print(f"[INFO] Usando brackets de {base_symbol} para {symbol}")
            return {symbol: brackets_data[base_symbol]}
        
        # Se for um par com USDT e BTCUSDT existir nos dados
        if "USDT" in symbol and "BTCUSDT" in brackets_data:
            print(f"[INFO] Usando brackets de BTCUSDT como referência para {symbol}")
            return {symbol: brackets_data["BTCUSDT"]}
    
    return brackets_data

# Calcula a alavancagem ideal para margem cruzada
def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para margem cruzada baseada apenas na distância entrada/SL
    """
    # Remover ".P" se presente no símbolo
    cleaned_symbol = clean_symbol(symbol)
    
    # Determinar se é posição long ou short
    is_long = True
    if side_raw:
        is_long = side_raw.upper() == "BUY"
    else:
        is_long = entry_price < stop_loss
    
    # Calcular a distância percentual até o stop loss
    if is_long:
        sl_distance_pct = abs((entry_price - stop_loss) / entry_price)
    else:
        sl_distance_pct = abs((stop_loss - entry_price) / entry_price)
    
    # Log para debug
    print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")
    
    # Alavancagem para perder exatamente 100% da margem alocada no stop loss
    target_leverage = int(1 / sl_distance_pct)
    #print(f"[DEBUG] {symbol}: Target alavancagem inicial: {target_leverage}x")
    
    # Buscar os brackets específicos para este símbolo apenas para conhecer a alavancagem máxima
    try:
        leverage_brackets = load_leverage_brackets(cleaned_symbol)
        
        # Obter os brackets para o símbolo
        symbol_brackets = []
        if cleaned_symbol in leverage_brackets:
            symbol_brackets = leverage_brackets[cleaned_symbol]
        
        # Se não encontrar brackets, tenta com outros métodos
        if not symbol_brackets:
            # Busca todos os brackets
            all_brackets = load_leverage_brackets()
            
            # Tenta com símbolo base
            base_symbol = cleaned_symbol.split('_')[0]
            if base_symbol in all_brackets:
                symbol_brackets = all_brackets[base_symbol]
            # Ou com BTCUSDT como fallback
            elif "BTCUSDT" in all_brackets:
                symbol_brackets = all_brackets["BTCUSDT"]
        
        # Encontrar a alavancagem máxima permitida para este símbolo
        max_leverage = 1  # Inicializar com valor mínimo em vez de valor máximo
        for bracket in symbol_brackets:
            if "initialLeverage" in bracket:
                bracket_leverage = int(bracket.get("initialLeverage", 1))
                max_leverage = max(max_leverage, bracket_leverage)
        
        #print(f"[INFO] Alavancagem máxima para {cleaned_symbol}: {max_leverage}x")
        
    except Exception as e:
        print(f"[AVISO] Erro ao obter alavancagem máxima: {e}. Usando valor padrão 125x.")
        max_leverage = 125  # Valor padrão se não conseguir obter da API
    
    # Com margem cruzada, a única limitação é a alavancagem máxima permitida
    final_leverage = min(target_leverage, max_leverage)
    final_leverage = max(1, final_leverage)  # Garantir pelo menos 1x
    
    print(f"[INFO] Alavancagem final calculada para {cleaned_symbol}: {final_leverage}x")
    return final_leverage

# Em vez de salvar no arquivo, inserir no banco de dados MySQL
def save_to_database(trade_data):
    """
    Salva informações da operação no banco de dados MySQL
    
    Args:
        trade_data (dict): Dicionário com informações da operação
    """
    try:
        # Configurar conexão MySQL usando variáveis do .env
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=DB_PORT,
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()
        
        # Inserir na tabela webhook_signals
        sql = """
        INSERT INTO webhook_signals
        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, status)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
        """
        
        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],
            trade_data["stop_loss"],
            trade_data["chat_id"],
            "PENDING"  # Status inicial
        )
        
        cursor.execute(sql, values)
        conn.commit()
        
        #print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no banco de dados: {trade_data['symbol']}")
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao salvar no banco: {e}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

@app.route('/webhook', methods=['POST'])
async def webhook():
    payload     = await request.get_json()
    alert_block = payload.get('alert', {})

    # 1) Validação do token enviado no JSON
    incoming_auth = alert_block.get('headers', {}).get('Authorization', '')
    expected_auth = f"Bearer {Bearer_Token}"
    if incoming_auth != expected_auth:
        return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401

    # 2) Extração do bloco de mensagem
    msg = alert_block.get('message', {})

    # Campos principais
    trade_id     = msg.get('id')
    symbol_raw   = msg.get('symbol')
    side_raw     = msg.get('side')
    leverage     = msg.get('leverage')
    capital_pct  = msg.get('capital')
    entry_raw    = msg.get('entry')
    tp_raw       = msg.get('tp')
    stop_raw     = msg.get('sl')
    message_type = msg.get('message_type', '')

    # 3) Normalização e tradução dos valores
    symbol     = clean_symbol(symbol_raw)
    side       = translate_side(side_raw)
    entry      = normalize_number(str(entry_raw))
    tp         = normalize_number(str(tp_raw))
    stop_loss  = normalize_number(str(stop_raw))
    
    # 4) Verificar se capital_pct foi fornecido
    if not capital_pct:
        return jsonify({'status': 'error', 'message': 'Percentual de capital não fornecido'}), 400
    
    # Sempre calcular alavancagem, ignorando o valor recebido
    capital_pct = float(capital_pct)
    
    # Calcular alavancagem usando a API da Binance
    leverage = calculate_ideal_leverage(
        symbol,
        float(entry),
        float(stop_loss),
        capital_pct,
        side_raw  # Passar a direção para cálculo mais preciso
    )

    # Antes de enviar a mensagem
    capital_int = int(float(capital_pct))  # Converter para inteiro

    # Timestamp para logs
    now = datetime.now().strftime("%d-%m-%Y | %H:%M:%S")

    # 5) Lógica de roteamento de mensagem conforme o message_type
    if message_type.startswith('new_trade'):
        text = (
            f"#{symbol}   {side}\n"
            "Inception\n\n"
            f"ALAVANCAGEM: {leverage}x\n"
            "MARGEM: CRUZADA\n"
            f"CAPITAL: {capital_int}%\n\n"
            f"ENTRADA: {entry}\n\n"  # Modificado para indicar aguardando execução
            f"ALVO: {tp}\n\n"
            f"STOP LOSS: {stop_loss}"
        )
        await send_telegram_message(entry_group_id, text)
        print(f"[{now}] Entrada enviada: {symbol} | id={trade_id}")

        # Salvar operação no banco de dados com status PENDING
        trade_data = {
            "id": trade_id,
            "symbol": symbol,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "chat_id": entry_group_id
        }
        save_to_database(trade_data)

    elif message_type.startswith('update') or message_type.startswith('stop_update'):
        text = (
            f"#{symbol}   {side}\n"
            "Inception\n\n"
            "Alvo atingido / Stop reposicionado\n\n"
            f"Novo SL: {stop_loss}"
        )
        await send_telegram_message(stoploss_group_id, text)
        print(f"[{now}] Reposicionamento enviado: {symbol} | id={trade_id}")

    else:
        return jsonify({'status': 'error', 'message': 'Tipo de mensagem desconhecido.'}), 400

    return jsonify({'status': 'success', 'id': trade_id, 'message_type': message_type}), 200

async def main():
    await client.start()
    await app.run_task(host='0.0.0.0', port=5050)

if __name__ == '__main__':
    asyncio.run(main())
