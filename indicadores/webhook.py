from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token
import asyncio
import json
import os
import math
import mysql.connector
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

# Carrega os brackets de alavancagem do arquivo JSON
def load_leverage_brackets():
    """
    Carrega os brackets de alavancagem do arquivo JSON
    Trata formatos inconsistentes e garante que dados críticos estejam disponíveis
    """
    leverage_file = os.path.join(os.path.dirname(__file__), 'leverage.json')
    
    # Definição de bracktes completos para os principais pares (dados de referência)
    CRITICAL_SYMBOLS = {
        "BTCUSDT": [
            {"bracket": 1, "initialLeverage": 125, "notionalCap": 50000, "notionalFloor": 0, "maintMarginRatio": 0.004, "cum": 0},
            {"bracket": 2, "initialLeverage": 100, "notionalCap": 600000, "notionalFloor": 50000, "maintMarginRatio": 0.005, "cum": 50},
            {"bracket": 3, "initialLeverage": 75, "notionalCap": 3000000, "notionalFloor": 600000, "maintMarginRatio": 0.0065, "cum": 950},
            {"bracket": 4, "initialLeverage": 50, "notionalCap": 12000000, "notionalFloor": 3000000, "maintMarginRatio": 0.01, "cum": 11450},
            {"bracket": 5, "initialLeverage": 25, "notionalCap": 70000000, "notionalFloor": 12000000, "maintMarginRatio": 0.02, "cum": 131450},
            {"bracket": 6, "initialLeverage": 20, "notionalCap": 100000000, "notionalFloor": 70000000, "maintMarginRatio": 0.025, "cum": 481450},
            {"bracket": 7, "initialLeverage": 10, "notionalCap": 230000000, "notionalFloor": 100000000, "maintMarginRatio": 0.05, "cum": 2981450}
        ],
        "PAXGUSDT": [
            {"bracket": 1, "initialLeverage": 75, "notionalCap": 5000, "notionalFloor": 0, "maintMarginRatio": 0.01, "cum": 0},
            {"bracket": 2, "initialLeverage": 50, "notionalCap": 10000, "notionalFloor": 5000, "maintMarginRatio": 0.015, "cum": 25},
            {"bracket": 3, "initialLeverage": 25, "notionalCap": 30000, "notionalFloor": 10000, "maintMarginRatio": 0.02, "cum": 75},
            {"bracket": 4, "initialLeverage": 20, "notionalCap": 300000, "notionalFloor": 30000, "maintMarginRatio": 0.025, "cum": 225},
            {"bracket": 5, "initialLeverage": 10, "notionalCap": 900000, "notionalFloor": 300000, "maintMarginRatio": 0.05, "cum": 7725},
            {"bracket": 6, "initialLeverage": 5, "notionalCap": 2000000, "notionalFloor": 900000, "maintMarginRatio": 0.1, "cum": 52725}
        ],
        "ETHUSDT": [
            {"bracket": 1, "initialLeverage": 100, "notionalCap": 50000, "notionalFloor": 0, "maintMarginRatio": 0.005, "cum": 0},
            {"bracket": 2, "initialLeverage": 75, "notionalCap": 600000, "notionalFloor": 50000, "maintMarginRatio": 0.0065, "cum": 50},
            {"bracket": 3, "initialLeverage": 50, "notionalCap": 3000000, "notionalFloor": 600000, "maintMarginRatio": 0.01, "cum": 950},
            {"bracket": 4, "initialLeverage": 25, "notionalCap": 12000000, "notionalFloor": 3000000, "maintMarginRatio": 0.02, "cum": 11450},
            {"bracket": 5, "initialLeverage": 20, "notionalCap": 30000000, "notionalFloor": 12000000, "maintMarginRatio": 0.025, "cum": 131450},
            {"bracket": 6, "initialLeverage": 10, "notionalCap": 100000000, "notionalFloor": 30000000, "maintMarginRatio": 0.05, "cum": 381450},
            {"bracket": 7, "initialLeverage": 5, "notionalCap": 200000000, "notionalFloor": 100000000, "maintMarginRatio": 0.1, "cum": 2006450}
        ]
    }
    
    try:
        # Inicializa com os dados críticos conhecidos
        brackets_by_symbol = CRITICAL_SYMBOLS.copy()
        
        with open(leverage_file, 'r', encoding='utf-8') as file:
            # Limpa comentários e caracteres problemáticos
            lines = []
            for line in file:
                if not line.strip().startswith('//'):
                    # Substitui {…} por um objeto vazio para evitar erros de parsing
                    line = line.replace('{…}', '{}')
                    lines.append(line)
            
            content = ''.join(lines)
            
            try:
                brackets_data = json.loads(content)
                print(f"[INFO] Arquivo JSON carregado com sucesso: {len(brackets_data)} entradas")
                
                # Processa os dados do arquivo
                for item in brackets_data:
                    symbol = item.get('symbol')
                    brackets = item.get('brackets', [])
                    
                    # Só adiciona se tiver um símbolo definido e os brackets não estiverem vazios
                    if symbol and brackets and len(brackets) > 0:
                        # Verifica se há informações completas nos brackets
                        valid_brackets = any('initialLeverage' in bracket for bracket in brackets)
                        
                        if valid_brackets:
                            brackets_by_symbol[symbol] = brackets
                            print(f"[DEBUG] Brackets válidos encontrados para {symbol}")
                
            except json.JSONDecodeError as e:
                print(f"[ERRO] Falha ao decodificar JSON: {e}")
        
        # Para verificar se PAXGUSDT foi carregado corretamente
        if 'PAXGUSDT' in brackets_by_symbol:
            print(f"[INFO] PAXGUSDT encontrado com {len(brackets_by_symbol['PAXGUSDT'])} brackets")
        else:
            print(f"[AVISO] PAXGUSDT não encontrado no arquivo, usando dados de referência")
        
        print(f"[INFO] Total de símbolos carregados: {len(brackets_by_symbol)}")
        return brackets_by_symbol
        
    except Exception as e:
        print(f"[ERRO] Falha ao processar arquivo leverage.json: {e}")
        # Em caso de falha, retorna pelo menos os dados críticos
        return CRITICAL_SYMBOLS

# Calcula a alavancagem ideal para margem isolada
def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para garantir que:
    1. Se o stop loss for atingido, a perda será de 100% da margem alocada
    2. A liquidação só ocorrerá após o preço atingir o stop loss
    """
    # Remover ".P" se presente no símbolo
    cleaned_symbol = clean_symbol(symbol)
    
    # Carregar brackets de alavancagem
    leverage_brackets = load_leverage_brackets()
    
    # Determinar se é posição long ou short baseado na direção do trade
    is_long = True  # Padrão para long
    if side_raw:
        is_long = side_raw.upper() == "BUY"
    else:
        # Se side_raw não for fornecido, inferir pela posição dos preços
        is_long = entry_price < stop_loss
    
    # Calcular a distância percentual até o stop loss
    if is_long:
        sl_distance_pct = abs((entry_price - stop_loss) / entry_price)
    else:
        sl_distance_pct = abs((stop_loss - entry_price) / entry_price)
    
    # Log para debug
    print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")
    
    # Alavancagem para perder exatamente 100% da margem alocada no stop loss
    target_leverage = int(1 / sl_distance_pct)  # Arredondamento para baixo
    print(f"[DEBUG] {symbol}: Target alavancagem inicial: {target_leverage}x")

    # Obter os brackets para o símbolo específico
    symbol_brackets = None
    
    # Tentar encontrar o símbolo exato
    if cleaned_symbol in leverage_brackets:
        symbol_brackets = leverage_brackets[cleaned_symbol]
    else:
        # Procurar por símbolos base (ex: BTCUSDT de BTCUSDT_240628)
        base_symbol = cleaned_symbol.split('_')[0]
        if base_symbol in leverage_brackets:
            symbol_brackets = leverage_brackets[base_symbol]
            print(f"[INFO] Usando brackets de {base_symbol} para {cleaned_symbol}")
        # Se não encontrar, tenta usar BTCUSDT como referência para qualquer par USDT
        elif "USDT" in cleaned_symbol and "BTCUSDT" in leverage_brackets:
            symbol_brackets = leverage_brackets["BTCUSDT"]
            print(f"[INFO] Usando brackets de BTCUSDT como referência para {cleaned_symbol}")
    
    # Encontra a alavancagem máxima permitida para este símbolo
    if not symbol_brackets or len(symbol_brackets) == 0:
        print(f"[ERRO] Não foi possível encontrar brackets para {cleaned_symbol}")
        # Retorna alavancagem calculada com fator de segurança (90%)
        return max(1, min(int(target_leverage * 0.9), 125))
    
    # Extrai as alavancagens disponíveis nos brackets
    max_leverage = 1
    for bracket in symbol_brackets:
        if "initialLeverage" in bracket:
            bracket_leverage = bracket["initialLeverage"]
            max_leverage = max(max_leverage, bracket_leverage)
    
    print(f"[INFO] Alavancagem máxima para {cleaned_symbol}: {max_leverage}x")
    
    # Ajusta a alavancagem calculada para não exceder o máximo permitido
    final_leverage = min(target_leverage, max_leverage)
    # Garante pelo menos 1x de alavancagem
    final_leverage = max(1, final_leverage)
    
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
    
    # Calcular alavancagem para perder exatamente o capital alocado no SL
    leverage = calculate_ideal_leverage(
        symbol,
        float(entry),
        float(stop_loss),
        capital_pct,
        side_raw
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
