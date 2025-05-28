import asyncio
import os
import re
import signal
import sys
import mysql.connector
from datetime import datetime
from telethon import TelegramClient, events
from dotenv import load_dotenv
import pathlib
from senhas import pers_api_hash, pers_api_id

# Carregar variáveis de ambiente do arquivo .env na raiz do projeto
env_path = pathlib.Path(__file__).parents[1] / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco de dados do arquivo .env
DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

# IDs dos grupos - USANDO OS IDs INTERNOS CORRETOS COM SINAL NEGATIVO
GRUPOS_ORIGEM_IDS = [-1002444455075, -4192806079]  # Lista com os IDs dos grupos de origem
GRUPO_DESTINO_ID = -1002016807368  # ID do grupo de destino

# Seletor de alvo - valor 2 corresponde ao segundo alvo (Alvo 2)
ALVO_SELECIONADO = 2  # 1=Alvo 1, 2=Alvo 2, 3=Alvo 3, etc.

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

def calculate_ideal_leverage(symbol, entry_price, stop_loss, capital_percent, side_raw=None):
    """
    Calcula a alavancagem ideal para margem cruzada baseada na distância entrada/SL
    """
    cleaned_symbol = clean_symbol(symbol)

    is_long = True
    if side_raw:
        is_long = side_raw.upper() == "BUY"
    else:
        is_long = entry_price < stop_loss

    if is_long:
        sl_distance_pct = abs((entry_price - stop_loss) / entry_price)
    else:
        sl_distance_pct = abs((stop_loss - entry_price) / entry_price)

    print(f"[DEBUG] {symbol}: Distância até SL: {sl_distance_pct:.6f} ({sl_distance_pct*100:.2f}%)")

    target_leverage = int(1 / sl_distance_pct)

    try:
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

        max_leverage = 1
        for bracket in symbol_brackets:
            if "initialLeverage" in bracket:
                bracket_leverage = int(bracket.get("initialLeverage", 1))
                max_leverage = max(max_leverage, bracket_leverage)

    except Exception as e:
        print(f"[AVISO] Erro ao obter alavancagem máxima: {e}. Usando valor padrão 125x.")
        max_leverage = 125

    final_leverage = min(target_leverage, max_leverage)
    final_leverage = max(1, final_leverage)

    print(f"[INFO] Alavancagem final calculada para {cleaned_symbol}: {final_leverage}x")
    return final_leverage

def save_to_database(trade_data):
    """
    Salva informações da operação no banco de dados MySQL
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

        # Verificar se já existe a coluna timeframe na tabela
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, status, timeframe)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s) \
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
            "PENDING",
            trade_data.get("timeframe", "")  # Novo campo timeframe
        )

        cursor.execute(sql, values)
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no banco de dados: {trade_data['symbol']}")

    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao salvar no banco: {e}")
        # Verificar se o erro é por falta da coluna timeframe
        if "Unknown column 'timeframe'" in str(e):
            try:
                # Tentar salvar sem o timeframe
                sql = """
                      INSERT INTO webhook_signals
                      (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, chat_id, status)
                      VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) \
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
                    "PENDING"
                )
                cursor.execute(sql, values)
                conn.commit()
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva sem timeframe")
            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro na segunda tentativa: {e2}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

# Função para extrair informações da mensagem do Telegram
async def extract_trade_info(message_text):
    """
    Extrai informações de trade da mensagem do Telegram usando regex
    """
    try:
        # Verificar se contém todos os termos obrigatórios
        required_terms = ["DIVAP", "Entrada", "Alvo", "Stop"]
        for term in required_terms:
            if term.lower() not in message_text.lower():
                print(f"[INFO] Termo obrigatório '{term}' não encontrado na mensagem")
                return None

        # Padrões para extrair informações
        symbol_pattern = r'#([A-Z0-9]+)'
        # Padrão para capturar o timeframe (15m, 1h, 4h, etc.)
        timeframe_pattern = r'#[A-Z0-9]+\s+([0-9]+[mhdwM])'

        # Detectar o lado (compra/venda)
        if "compra" in message_text.lower():
            side = "COMPRA"
        elif "venda" in message_text.lower():
            side = "VENDA"
        else:
            # Tentar determinar pelo preço de entrada e stop
            entry_pattern = r'Entrada\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'
            sl_pattern = r'Stop\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'

            entry_match = re.search(entry_pattern, message_text)
            sl_match = re.search(sl_pattern, message_text)

            if entry_match and sl_match:
                entry = float(normalize_number(entry_match.group(1)))
                stop_loss = float(normalize_number(sl_match.group(1)))

                # Se entrada > stop, é venda; caso contrário, é compra
                side = "VENDA" if entry > stop_loss else "COMPRA"
            else:
                print("[ERRO] Não foi possível determinar o lado (compra/venda)")
                return None

        # Capturar entrada e stop
        entry_pattern = r'Entrada\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'
        sl_pattern = r'Stop\s+(?:acima|abaixo)\s+de:\s*([0-9,.]+)'

        # Padrão para múltiplos alvos
        tp_pattern = r'Alvo\s+(?:\d+):\s*([0-9,.]+)'

        # Capital/risco
        capital_pattern = r'(\d+)%\s+do\s+capital'

        # Extrair dados
        symbol_match = re.search(symbol_pattern, message_text)
        timeframe_match = re.search(timeframe_pattern, message_text)
        entry_match = re.search(entry_pattern, message_text)
        sl_match = re.search(sl_pattern, message_text)
        capital_match = re.search(capital_pattern, message_text)

        # Extrair todos os alvos
        tp_matches = re.findall(tp_pattern, message_text)

        if not (symbol_match and entry_match and sl_match and tp_matches):
            print("[ERRO] Formato de mensagem não reconhecido")
            return None

        symbol = symbol_match.group(1)
        timeframe = timeframe_match.group(1) if timeframe_match else ""
        entry = float(normalize_number(entry_match.group(1)))
        stop_loss = float(normalize_number(sl_match.group(1)))
        capital_pct = float(capital_match.group(1)) if capital_match else 5.0  # Valor padrão

        # Usar o primeiro alvo como TP principal
        tp = float(normalize_number(tp_matches[0])) if tp_matches else None

        # Calcular alavancagem
        leverage = calculate_ideal_leverage(symbol, entry, stop_loss, capital_pct, side)

        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "leverage": leverage,
            "capital_pct": capital_pct,
            "entry": entry,
            "tp": tp,
            "stop_loss": stop_loss,
            "all_tps": [float(normalize_number(tp)) for tp in tp_matches] if tp_matches else [],
            "chat_id": GRUPO_DESTINO_ID
        }

    except Exception as e:
        print(f"[ERRO] Falha ao extrair informações: {e}")
        return None

# Handler para monitorar mensagens em todos os grupos de origem
@client.on(events.NewMessage())
async def handle_new_message(event):
    """
    Manipula novas mensagens no grupo de origem
    """
    try:
        # Verificar se a mensagem é de um dos grupos de origem
        chat_id = event.chat_id
        if chat_id not in GRUPOS_ORIGEM_IDS:
            return

        chat = await event.get_chat()
        print(f"[INFO] Nova mensagem recebida do grupo/canal {chat.id}: {event.message.id}")

        # Extrair informações da mensagem
        trade_info = await extract_trade_info(event.message.text)

        if not trade_info:
            print("[INFO] Mensagem ignorada - não é um sinal de trade")
            return

        print(f"[INFO] Sinal de trade detectado de {chat.id}: {trade_info['symbol']} {trade_info['side']}")

        # Selecionar o alvo específico conforme configuração (ajustando índice para base 1)
        selected_tp = None
        if trade_info['all_tps'] and len(trade_info['all_tps']) >= ALVO_SELECIONADO:
            # Ajuste do índice: ALVO_SELECIONADO=2 corresponde ao índice 1 no array
            selected_tp = trade_info['all_tps'][ALVO_SELECIONADO - 1]
            print(f"[INFO] Selecionando Alvo {ALVO_SELECIONADO}: {selected_tp}")
        else:
            # Se o alvo selecionado não existir, usa o primeiro alvo
            selected_tp = trade_info['tp']
            print(f"[INFO] Alvo {ALVO_SELECIONADO} não disponível, usando Alvo 1: {selected_tp}")

        # Criar mensagem formatada para o grupo de destino
        message_text = (
            f"#{trade_info['symbol']}   {trade_info['side']}\n"
        )

        # Adicionar timeframe abaixo do símbolo
        if trade_info.get('timeframe'):
            message_text += f"{trade_info['timeframe']}\n"

        message_text += (
            "Divap\n\n"
            f"ALAVANCAGEM: {trade_info['leverage']}x\n"
            "MARGEM: CRUZADA\n"
            f"CAPITAL: {int(trade_info['capital_pct'])}%\n\n"
            f"ENTRADA: {trade_info['entry']}\n\n"
        )

        # Adicionar apenas o alvo selecionado (sem número)
        message_text += f"ALVO: {selected_tp}\n\n"
        message_text += f"STOP LOSS: {trade_info['stop_loss']}"

        # Imprimir a mensagem encaminhada no terminal
        print("\n[INFO] Mensagem a ser encaminhada:")
        print("-" * 50)
        print(message_text)
        print("-" * 50)

        # Enviar para o grupo de destino
        await client.send_message(GRUPO_DESTINO_ID, message_text)
        print(f"[INFO] Mensagem encaminhada para o grupo de destino")

        # Atualizar o valor de TP para salvar no banco de dados
        trade_info['tp'] = selected_tp

        # Salvar no banco de dados
        save_to_database(trade_info)

    except Exception as e:
        print(f"[ERRO] Falha ao processar mensagem: {e}")

async def main():
    """
    Função principal para iniciar o cliente
    """
    print("[INFO] Iniciando monitoramento do Telegram...")

    # Iniciar o cliente
    await client.start()
    print("[INFO] Cliente Telethon conectado")

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
        print("[INFO] Verificando acesso aos grupos de origem:")
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