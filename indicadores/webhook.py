from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token
import asyncio

app = Quart(__name__)

# Grupos do Telegram para diferentes tipos de mensagens
entry_group_id = 4217341650
stoploss_group_id = 4263252665

# Cliente Telegram
client = TelegramClient('ATIUS-INDICATOR', api_id, api_hash)

# Normaliza números no formato string (ex.: "1.234,56" -> "1234.56")
def normalize_number(value):
    if not isinstance(value, str):
        return value
    value = value.replace(",", ".")
    if value.count(".") > 1:
        last_dot = value.rindex(".")
        value = value[:last_dot].replace(".", "") + value[last_dot:]
    return value

# Envia mensagem para Telegram
async def send_telegram_message(chat_id, message):
    entity = await client.get_entity(chat_id)
    await client.send_message(entity, message, parse_mode='markdown')

@app.route('/webhook', methods=['POST'])
async def webhook():
    payload = await request.get_json()
    # Esperamos o layout:
    # { "alert": {
    #     "message": { ...campos... },
    #     "headers": {"Authorization":"Bearer ..."}
    #   }
    # }
    alert_block = payload.get('alert', {})
    message = alert_block.get('message', {})

    # Extrai campos
    trade_id     = message.get('id')
    symbol       = message.get('symbol')
    side         = message.get('side')
    leverage     = message.get('leverage')
    capital_pct  = message.get('capital')
    entry_raw    = message.get('entry')
    tp_raw       = message.get('tp')
    stop_raw     = message.get('sl')
    message_type = message.get('message_type')

    # Normaliza valores numéricos
    entry     = normalize_number(str(entry_raw))
    tp        = normalize_number(str(tp_raw))
    stop_loss = normalize_number(str(stop_raw))

    # Timestamp para logs
    now = datetime.now().strftime("%d-%m-%Y | %H:%M:%S")

    if message_type == "entrada":
        text = f"""
#{symbol}   {side}
ATIUS INDICATOR

ALAVANCAGEM: {leverage}x
MARGEM: ISOLADA
CAPITAL: {capital_pct}%

ENTRADA: {entry}

ALVO: {tp}

STOP LOSS: {stop_loss}
"""
        await send_telegram_message(entry_group_id, text)
        print(f"[{now}] Entrada enviada: {symbol} | id={trade_id}")

    elif message_type == "reposicionamento":
        text = f"""
#{symbol}
ATIUS INDICATOR
Alvo atingido
Novo SL: {stop_loss}
"""
        await send_telegram_message(stoploss_group_id, text)
        print(f"[{now}] Reposicionamento enviado: {symbol} | id={trade_id}")

    else:
        return jsonify({'status': 'error', 'message': 'Tipo de mensagem desconhecido.'}), 400

    return jsonify({'status': 'success', 'id': trade_id, 'message_type': message_type})

async def main():
    await client.start()
    await app.run_task(host='0.0.0.0', port=5050)

if __name__ == '__main__':
    asyncio.run(main())
