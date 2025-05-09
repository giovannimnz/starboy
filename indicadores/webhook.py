from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token, API_KEY, API_SECRET, API_URL
import asyncio
import json
import os
import math
import mysql.connector
import requests
import hmac
import hashlib
import time
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
client = TelegramClient('webhook', api_id, api_hash)

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

# Definir limites de risco por símbolo (em porcentagem do capital total)
RISK_LIMITS = {
    "BTCUSDT": 0.25,  # 25% para BTCUSDT
    "PAXGUSDT": 0.50,  # 50% para PAXGUSDT
    "default": 0.10   # 10% para outros símbolos
}

def get_binance_signature(query_string):
    """
    Gera a assinatura HMAC-SHA256 necessária para autenticar requisições à API Binance
    """
    signature = hmac.new(
        API_SECRET.encode('utf-8'),
        query_string.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return signature

def get_leverage_brackets_from_binance(symbol=None):
    """
    Busca informações de leverage brackets diretamente da API da Binance
    
    Args:
        symbol (str, optional): Símbolo específico para consultar. Se None, retorna todos.
        
    Returns:
        dict: Dicionário com os brackets de alavancagem por símbolo
    """
    # Cache TTL (Time To Live) em segundos - 3600 = 1 hora
    CACHE_TTL = 3600
    
    # Verificar se os dados estão em cache e se ainda são válidos
    current_time = time.time()
    cache_key = symbol if symbol else "ALL_SYMBOLS"
    
    if cache_key in leverage_brackets_cache:
        if current_time < cache_expiry.get(cache_key, 0):
            print(f"[INFO] Usando dados de brackets de alavancagem em cache para {cache_key}")
            return leverage_brackets_cache[cache_key]
    
    # Prepara a requisição para a API da Binance
    endpoint = f"{API_URL}/v1/leverageBracket"
    timestamp = int(time.time() * 1000)
    params = {'timestamp': timestamp}
    
    # Adiciona o símbolo se especificado
    if symbol:
        params['symbol'] = symbol
    
    # Cria a string de consulta para assinatura
    query_string = urlencode(params)
    
    # Gera a assinatura
    signature = get_binance_signature(query_string)
    
    # Adiciona a assinatura à query string
    full_url = f"{endpoint}?{query_string}&signature={signature}"
    
    # Configura os headers com a API key
    headers = {
        'X-MBX-APIKEY': API_KEY
    }
    
    try:
        # Faz a requisição para a API
        response = requests.get(full_url, headers=headers)
        response.raise_for_status()  # Levanta exceção para códigos de erro HTTP
        
        data = response.json()
        print(f"[DEBUG] Resposta da API Binance: {json.dumps(data)[:200]}...")
        
        # Organiza os dados por símbolo para fácil acesso
        brackets_by_symbol = {}
        
        # IMPORTANTE: A resposta para um único símbolo é diferente de múltiplos símbolos
        if symbol:
            # Se for um único símbolo, a resposta é uma lista com um único item
            if isinstance(data, list) and len(data) > 0:
                for item in data:
                    sym = item.get('symbol')
                    if sym:
                        brackets_by_symbol[sym] = item.get('brackets', [])
            else:
                # Ou pode ser diretamente um objeto
                sym = data.get('symbol', symbol)
                brackets_by_symbol[sym] = data.get('brackets', [])
        else:
            # Para múltiplos símbolos, a resposta é sempre uma lista
            for item in data:
                sym = item.get('symbol')
                if sym:
                    brackets_by_symbol[sym] = item.get('brackets', [])
        
        # Depuração para verificar o que foi processado
        for sym, brackets in brackets_by_symbol.items():
            max_lev = 1
            for bracket in brackets:
                if "initialLeverage" in bracket:
                    max_lev = max(max_lev, bracket["initialLeverage"])
            print(f"[DEBUG] Símbolo: {sym}, Brackets: {len(brackets)}, Max Leverage: {max_lev}x")
        
        # Salva no cache
        leverage_brackets_cache[cache_key] = brackets_by_symbol
        cache_expiry[cache_key] = current_time + CACHE_TTL
        
        print(f"[INFO] Dados de alavancagem da Binance atualizados para {cache_key}")
        return brackets_by_symbol
        
    except Exception as e:
        print(f"[ERRO] Falha ao buscar dados de alavancagem da Binance: {e}")
        
        # Caso tenha dados em cache, mesmo vencidos, use-os como fallback
        if cache_key in leverage_brackets_cache:
            print(f"[INFO] Usando dados em cache vencidos como fallback para {cache_key}")
            return leverage_brackets_cache[cache_key]
        
        # Se não houver cache, propaga o erro
        raise Exception(f"Não foi possível obter informações de alavancagem para {symbol or 'todos os símbolos'}")

# Substituir a função de carregamento de arquivo JSON
def load_leverage_brackets(symbol=None):
    """
    Carrega os brackets de alavancagem da API da Binance
    
    Args:
        symbol (str, optional): Símbolo específico para buscar
        
    Returns:
        dict: Dicionário com os brackets de alavancagem por símbolo
    """
    # Chama a função que busca da API
    brackets_data = get_leverage_brackets_from_binance(symbol)
    
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

# Calcula a alavancagem ideal para margem isolada
def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal baseada nos dados da API da Binance
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
    print(f"[DEBUG] {symbol}: Target alavancagem inicial: {target_leverage}x")
    
    # Buscar os brackets específicos para este símbolo
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
    
    # Se ainda não tiver brackets, usa valores padrão de segurança
    if not symbol_brackets:
        print(f"[AVISO] Não foi possível obter brackets para {cleaned_symbol}, usando valores padrão")
        return max(1, min(int(target_leverage * 0.9), 125))
    
    # Ordenar brackets por notionalFloor para processá-los corretamente
    symbol_brackets = sorted(symbol_brackets, key=lambda x: x.get('notionalFloor', 0))
    
    # Encontrar a alavancagem máxima permitida para este símbolo
    max_leverage = 1
    for bracket in symbol_brackets:
        if "initialLeverage" in bracket:
            bracket_leverage = int(bracket.get("initialLeverage", 1))
            max_leverage = max(max_leverage, bracket_leverage)
    
    print(f"[INFO] Alavancagem máxima para {cleaned_symbol}: {max_leverage}x")
    
    # Estimar o tamanho da posição
    capital_usd = 1000  # Valor estimado de capital total em USD para cálculos
    position_size = (capital_usd * (capital_percent / 100))  # Tamanho da posição em USD
    
    # Encontrar o bracket apropriado para o tamanho estimado da posição
    appropriate_bracket = symbol_brackets[0]  # Começa com o menor bracket
    
    for bracket in symbol_brackets:
        if position_size <= bracket.get('notionalCap', float('inf')):
            appropriate_bracket = bracket
            break
    
    # Extrair a margem de manutenção do bracket apropriado
    maint_margin_rate = appropriate_bracket.get('maintMarginRatio', 0.01)
    print(f"[DEBUG] Usando margem de manutenção: {maint_margin_rate:.6f} ({maint_margin_rate*100:.2f}%)")
    
    # Verificar se a liquidação ocorreria antes do SL com a target alavancagem
    initial_max_safe_leverage = min(target_leverage, max_leverage)
    liquidation_threshold = (1 / initial_max_safe_leverage) + maint_margin_rate
    
    print(f"[DEBUG] Thresholds - Dist. SL: {sl_distance_pct*100:.4f}%, Liquidação: {liquidation_threshold*100:.4f}%")
    
    # Ajustar alavancagem se necessário
    if liquidation_threshold > sl_distance_pct:
        print(f"[AVISO] Liquidação ({liquidation_threshold*100:.4f}%) ocorreria antes do SL ({sl_distance_pct*100:.4f}%)")
        
        if sl_distance_pct > maint_margin_rate:
            # Recalcular alavancagem para que a liquidação ocorra após o SL
            adjusted_leverage = int(1 / (sl_distance_pct - maint_margin_rate))
            max_safe_leverage = min(adjusted_leverage, max_leverage)
            print(f"[DEBUG] Alavancagem ajustada para {adjusted_leverage}x (máx: {max_leverage}x)")
        else:
            # Stop muito próximo - usar alavancagem segura
            max_safe_leverage = min(int(max_leverage * 0.2), 10)  # 20% da máx, no máximo 10x
            print(f"[AVISO] SL muito próximo do preço de entrada. Usando alavancagem conservadora: {max_safe_leverage}x")
    else:
        max_safe_leverage = initial_max_safe_leverage
        print(f"[DEBUG] Thresholds OK. Mantendo alavancagem de {max_safe_leverage}x")
    
    # Garantir que esteja dentro dos limites
    final_leverage = max(1, max_safe_leverage)
    
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
        
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no banco de dados: {trade_data['symbol']}")
        
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
            "MARGEM: ISOLADA\n"
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
