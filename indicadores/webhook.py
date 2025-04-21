from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token
import asyncio
import json
import os
import math

app = Quart(__name__)

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
    leverage_file = os.path.join(os.path.dirname(__file__), 'leverage.json')
    with open(leverage_file, 'r') as file:
        brackets_data = json.load(file)
    
    # Organizar por símbolo para fácil acesso
    brackets_by_symbol = {}
    for item in brackets_data:
        symbol = item.get('symbol')
        brackets = item.get('brackets', [])
        if symbol and brackets:
            brackets_by_symbol[symbol] = brackets
    
    return brackets_by_symbol

# Calcula a alavancagem ideal para margem isolada
def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent):
    """
    Calcula a alavancagem ideal para garantir que:
    1. Se o stop loss for atingido, a perda será de 100% da margem alocada
    2. A liquidação só ocorrerá após o preço atingir o stop loss
    
    Args:
        symbol (str): O símbolo do ativo (ex: BTCUSDT)
        entry_price (float): Preço de entrada
        stop_loss (float): Preço do stop loss
        capital_percent (float): Porcentagem do capital total alocado como margem
        
    Returns:
        int: Alavancagem ideal (sempre um número inteiro arredondado para baixo)
    """
    # Remover ".P" se presente no símbolo
    cleaned_symbol = clean_symbol(symbol)
    
    # Carregar brackets de alavancagem
    leverage_brackets = load_leverage_brackets()
    
    # Determinar se é posição long ou short
    is_long = entry_price < stop_loss
    
    # Calcular a distância percentual até o stop loss
    if is_long:
        sl_distance_pct = abs((entry_price - stop_loss) / entry_price)
    else:
        sl_distance_pct = abs((stop_loss - entry_price) / entry_price)
    
    # Alavancagem para perder exatamente 100% da margem alocada no stop loss
    # Se perco x% com alavancagem 1x, preciso de alavancagem 1/x para perder 100%
    # Usa int() para garantir arredondamento para baixo e retorno de número inteiro
    target_leverage = int(1 / sl_distance_pct)  # Arredondamento para baixo
    
    # Obter os brackets para o símbolo específico
    symbol_brackets = leverage_brackets.get(cleaned_symbol, [])
    if not symbol_brackets:
        # Se não encontrar brackets específicos, usar o valor calculado com um fator de segurança
        # Garantir que seja um número inteiro arredondado para baixo
        return max(1, min(int(target_leverage * 0.9), 125))
    
    # Encontrar o bracket apropriado e verificar margens de manutenção
    max_safe_leverage = target_leverage
    
    for i, bracket in enumerate(symbol_brackets):
        # Extrair a margem de manutenção real deste bracket, se disponível
        maint_margin_rate = bracket.get('maintMarginRatio', 0.004 * (i + 1))
        
        # Para não ser liquidado antes do stop loss:
        # A distância até liquidação deve ser maior que a distância até o SL
        # Distância até liquidação = 1/alavancagem + taxa_margem_manutenção
        liquidation_threshold = (1 / max_safe_leverage) + maint_margin_rate
        
        # Se a liquidação ocorreria antes do SL, reduzir alavancagem
        if liquidation_threshold <= sl_distance_pct:
            # Esta alavancagem é segura, não precisamos ajustar
            pass
        else:
            # Ajustar alavancagem para que liquidação ocorra após o SL
            # Nova alavancagem = 1 / (sl_distance_pct - maint_margin_rate)
            # Deve garantir que: 1/lev + maint_rate > sl_distance_pct
            if sl_distance_pct > maint_margin_rate:
                # Garantir arredondamento para baixo (número inteiro)
                safe_leverage = int(1 / (sl_distance_pct - maint_margin_rate))
                max_safe_leverage = min(max_safe_leverage, safe_leverage)
            else:
                # Caso extremo: stop muito próximo do preço de entrada
                max_safe_leverage = 1  # Usar alavancagem mínima
            
        # Verificar limites de bracket
        if i < len(symbol_brackets) - 1:
            next_bracket = symbol_brackets[i+1]
            # Se tiver informação de notional máximo para este bracket
            if 'notionalCap' in bracket and 'notionalFloor' in next_bracket:
                # Calcular tamanho da posição aproximado
                position_size_approx = entry_price * (1 * (capital_percent / 100)) * max_safe_leverage
                
                if position_size_approx > bracket['notionalCap']:
                    # Se passar para o próximo bracket, continuar verificação
                    continue
            # Se não tiver informações exatas de limite, verificar "cum" (método alternativo)
            elif 'cum' in next_bracket:
                position_size_approx = entry_price * (1 * (capital_percent / 100)) * max_safe_leverage
                if position_size_approx > next_bracket['cum']:
                    continue
    
    # Limitações finais - garantir número inteiro
    max_safe_leverage = min(int(max_safe_leverage), 125)  # Max 125x na Binance, garantir inteiro
    max_safe_leverage = max(1, max_safe_leverage)         # Min 1x
    
    # Retorna alavancagem como número inteiro
    return max_safe_leverage

# Modificar a função save_to_positions_file para incluir estado
def save_to_positions_file(trade_data):
    """
    Salva informações de uma operação no arquivo posicoes.json
    
    Args:
        trade_data (dict): Dicionário contendo informações da operação
    """
    # Definir o caminho do arquivo
    positions_file = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'posicoes', 'posicoes.json')
    
    # Garantir que a pasta exista
    os.makedirs(os.path.dirname(positions_file), exist_ok=True)
    
    # Ler arquivo existente ou criar uma lista vazia
    try:
        with open(positions_file, 'r') as file:
            content = file.read()
            positions = json.loads(content) if content.strip() else []
    except (FileNotFoundError, json.JSONDecodeError):
        positions = []
    
    # Adicionar status e timestamp
    trade_data["status"] = "PENDING_ENTRY"  # Status inicial para monitoramento
    trade_data["updated_at"] = datetime.now().strftime("%d-%m-%Y | %H:%M:%S")
    trade_data["entry_order_id"] = None
    trade_data["tp_order_id"] = None
    trade_data["sl_order_id"] = None
    trade_data["position_qty"] = 0
    
    # Adicionar nova operação à lista
    positions.append(trade_data)
    
    # Salvar arquivo atualizado
    with open(positions_file, 'w') as file:
        json.dump(positions, file, indent=2)
    
    print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no arquivo posicoes.json: {trade_data['symbol']}")

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
    
    # 4) Calcular alavancagem ideal (se não foi fornecida)
    if not leverage:
        # Usar valor padrão se capital_pct não foi fornecido
        capital_pct = float(capital_pct or 10.0)  # Default: 10% do capital
        
        # Calcular alavancagem para perder exatamente o capital alocado no SL
        leverage = calculate_ideal_leverage(
            symbol,
            float(entry),
            float(stop_loss),
            capital_pct
        )

    # Timestamp para logs
    now = datetime.now().strftime("%d-%m-%Y | %H:%M:%S")

    # 5) Lógica de roteamento de mensagem conforme o message_type
    if message_type.startswith('new_trade'):
        text = (
            f"#{symbol}   {side}\n"
            "Inception\n\n"
            f"ALAVANCAGEM: {leverage}x\n"
            "MARGEM: ISOLADA\n"
            f"CAPITAL: {capital_pct}%\n\n"
            f"ENTRADA: {entry} (Aguardando execução)\n\n"  # Modificado para indicar aguardando execução
            f"ALVO: {tp}\n\n"
            f"STOP LOSS: {stop_loss}"
        )
        await send_telegram_message(entry_group_id, text)
        print(f"[{now}] Entrada enviada: {symbol} | id={trade_id}")

        # Salvar operação no arquivo posicoes.json com status PENDING
        trade_data = {
            "id": trade_id,
            "symbol": symbol,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "timestamp": now,
            "message_id": None,  # Será preenchido pelo monitoramento.js após enviar confirmação
            "chat_id": entry_group_id  # Para poder atualizar/apagar a mensagem posteriormente
        }
        save_to_positions_file(trade_data)

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
