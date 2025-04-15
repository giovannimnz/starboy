from quart import Quart, request, jsonify
from telethon import TelegramClient
from datetime import datetime
from senhas import api_hash, api_id, Bearer_Token
import asyncio

app = Quart(__name__)

# Grupos do Telegram para diferentes tipos de mensagens
entry_group_id = 4276162083
stoploss_group_id = 4276162083

# Criação do cliente Telegram com API ID e API Hash
client = TelegramClient('ATIUS-INDICATOR', api_id, api_hash)

# Token para autenticação no Webhook Atius
#WH_TOKEN = Bearer_Token

def normalize_number(value):
    value = value.replace(",", ".")
    
    if value.count(".") > 1:
        last_dot_index = value.rindex(".")
        value = value[:last_dot_index].replace(".", "") + value[last_dot_index:]
    
    return value

async def send_telegram_message(chat_id, message):
    entity = await client.get_entity(chat_id)  # Resolve a entidade antes de enviar a mensagem
    await client.send_message(entity, message, parse_mode='markdown')

@app.route('/webhook', methods=['POST'])
async def webhook():
    # Remover a verificação do token
    # token = request.headers.get('Authorization')
    # if token != f"Bearer {WH_TOKEN}":
    #    return jsonify({'status': 'error', 'message': 'Unauthorized'}), 401

    data = await request.get_json()
    message_type = data.get('message_type')
    symbol = data.get('symbol')
    side = data.get('side')
    leverage = data.get('leverage')
    capital = data.get('capital')
    entry = normalize_number(data.get('entry'))
    tp1 = normalize_number(data.get('tp1'))
    tp2 = normalize_number(data.get('tp2'))
    stop_loss = normalize_number(data.get('sl'))
    trade_id = data.get('id')

    # Obtém a data e hora atuais para log
    data_hora_atual = datetime.now()
    data_hora_formatada = data_hora_atual.strftime("%d-%m-%Y | %H:%M:%S")
    
    # Montar a mensagem com base no tipo de mensagem
    if message_type == "entrada":
        message = f"""
#{symbol}   {side}
ATIUS INDICATOR

ALAVANCAGEM: {leverage}x
MARGEM: ISOLADA
CAPITAL: {capital}%

ENTRADA: {entry}

ALVO 1: {tp1}
ALVO 2: {tp2}

STOP LOSS: {stop_loss}
        """
        # Enviar para o grupo de entrada
        await send_telegram_message(entry_group_id, message)
        print('__________________________________\n\n  Nova Entrada Enviada\n    ', data_hora_formatada, '\n__________________________________\n\n', message, '\n__________________________________')

    elif message_type == "reposicionamento":
        message = f"""
#{symbol}
ATIUS INDICATOR
Alvo de marcação atingido
Novo SL: {stop_loss}
        """
        # Enviar para o grupo de reposicionamento de stop loss
        await send_telegram_message(stoploss_group_id, message)
        print("__________________________________\n\n  Novo Reposicionamento Enviado\n     ", data_hora_formatada, "\n__________________________________\n\n", message, "\n__________________________________")
        
    else:
        return jsonify({'status': 'error', 'message': 'Tipo de mensagem desconhecido.'}), 400

    return jsonify({'status': 'success', 'id': trade_id, 'message_type': message_type})

async def main():
    await client.start()
    await app.run_task(host='0.0.0.0', port=5050)

if __name__ == '__main__':
    asyncio.run(main())