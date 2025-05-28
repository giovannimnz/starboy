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
ALVO_SELECIONADO = 1  # 1=Alvo 1, 2=Alvo 2, 3=Alvo 3, etc.

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
    Salva informações da operação no banco de dados MySQL e retorna o ID do sinal.
    """
    conn = None # Inicializar conn para o bloco finally
    cursor = None # Inicializar cursor para o bloco finally
    try:
        conn = mysql.connector.connect(
            host=DB_HOST,
            port=int(DB_PORT), # Garanta que DB_PORT seja string no .env e convertido aqui
            user=DB_USER,
            password=DB_PASSWORD,
            database=DB_NAME
        )
        cursor = conn.cursor()

        # SQL query incluindo a nova coluna message_id
        sql = """
              INSERT INTO webhook_signals
              (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price,
               chat_id, status, timeframe, message_id)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
              """

        values = (
            trade_data["symbol"],
            trade_data["side"],
            trade_data["leverage"],
            trade_data["capital_pct"],
            trade_data["entry"],
            trade_data["tp"],  # Já contém o selected_tp
            trade_data["stop_loss"],
            trade_data["chat_id"],
            "PENDING", # Status inicial
            trade_data.get("timeframe", ""), # Default para "" se não existir
            trade_data.get("message_id")  # Novo campo message_id
        )

        cursor.execute(sql, values)
        signal_id = cursor.lastrowid # Captura o ID do último registro inserido
        conn.commit()

        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva no banco de dados: {trade_data['symbol']} (ID: {signal_id})")
        return signal_id # Retorna o ID do sinal salvo

    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao salvar no banco: {e}")
        # O fallback existente para 'timeframe' permanece.
        if "Unknown column 'timeframe'" in str(e):
            try:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Tentando fallback: Salvar sem 'timeframe' mas com 'message_id'.")
                # Tentar salvar sem o timeframe, mas mantendo message_id
                sql_fallback = """
                        INSERT INTO webhook_signals
                        (symbol, side, leverage, capital_pct, entry_price, tp_price, sl_price, 
                         chat_id, status, message_id) 
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                        """
                values_fallback = (
                    trade_data["symbol"],
                    trade_data["side"],
                    trade_data["leverage"],
                    trade_data["capital_pct"],
                    trade_data["entry"],
                    trade_data["tp"],
                    trade_data["stop_loss"],
                    trade_data["chat_id"],
                    "PENDING",
                    trade_data.get("message_id") # Incluindo message_id no fallback
                )
                # É necessário um novo cursor ou reabrir se o anterior falhou e fechou a transação
                # No entanto, se o erro foi "Unknown column", o cursor e a conexão ainda devem estar ok para uma nova tentativa.
                # Se não estiver, esta chamada pode falhar.
                if cursor is None and conn: # Recriar cursor se ele foi fechado ou não foi criado
                     cursor = conn.cursor()
                elif cursor is None and conn is None: # Se a conexão falhou, não há muito o que fazer aqui
                     print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Conexão com DB não estabelecida, fallback não pode prosseguir.")
                     return None


                cursor.execute(sql_fallback, values_fallback)
                signal_id_fallback = cursor.lastrowid # Captura o ID do último registro inserido no fallback
                conn.commit()
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Operação salva sem timeframe (fallback) (ID: {signal_id_fallback})")
                return signal_id_fallback # Retorna o ID do sinal salvo via fallback
            except Exception as e2:
                print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro na segunda tentativa de salvar (fallback): {e2}")
        
        return None # Retorna None se todas as tentativas de salvar falharem ou outro erro ocorrer

    finally:
        if conn and conn.is_connected(): # Verifica se conn foi definida e está conectada
            if cursor: # Verifica se cursor foi definido
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
    Manipula novas mensagens, salvando todas e processando sinais de trade dos grupos de origem.
    """
    try:
        # --- INÍCIO DA NOVA LÓGICA PARA CAPTURAR TODAS AS MENSAGENS ---
        incoming_chat_id = event.chat_id
        incoming_message_id = event.message.id
        incoming_text = event.message.text
        # Usar o timestamp da mensagem do evento, se disponível e no formato correto,
        # ou formatar o datetime do evento. event.message.date já é um objeto datetime.
        incoming_created_at = event.message.date.strftime("%Y-%m-%d %H:%M:%S")

        is_reply = event.message.reply_to_msg_id is not None # Correção: event.message.reply_to_msg_id já é o ID
        reply_to_original_msg_id = None
        replied_signal_symbol = None
        replied_signal_id = None

        if is_reply:
            reply_to_original_msg_id = event.message.reply_to_msg_id
            # Verificar se é resposta a um sinal conhecido
            replied_signal_symbol, replied_signal_id = await check_if_reply_to_signal(reply_to_original_msg_id)
            print(f"[INFO] Mensagem ID {incoming_message_id} é uma resposta para {reply_to_original_msg_id}. Sinal associado: {replied_signal_symbol}, ID: {replied_signal_id}")

        # Registrar TODAS as mensagens recebidas (ou aquelas que passam por este handler)
        # A função save_message_to_database deve estar preparada para receber signal_id como None.
        save_message_to_database(
            message_id=incoming_message_id,
            chat_id=incoming_chat_id,
            text=incoming_text,
            is_reply=is_reply,
            reply_to_message_id=reply_to_original_msg_id,
            symbol=replied_signal_symbol, # Símbolo do sinal respondido, se houver
            signal_id=replied_signal_id, # ID do sinal respondido, se houver
            created_at=incoming_created_at
        )
        print(f"[INFO] Mensagem ID {incoming_message_id} de Chat ID {incoming_chat_id} salva em signals_msg.")
        # --- FIM DA NOVA LÓGICA PARA CAPTURAR TODAS AS MENSAGENS ---

        # Verificar se a mensagem é de um dos grupos de origem para processamento do SINAL DE TRADE
        if incoming_chat_id not in GRUPOS_ORIGEM_IDS:
            print(f"[INFO] Mensagem ID {incoming_message_id} de Chat ID {incoming_chat_id} não é de um grupo de origem de sinais. Processamento de sinal não aplicável.")
            return

        # Continuar com o resto do código existente se for de um grupo de origem
        chat = await event.get_chat() # 'chat' aqui será o grupo de origem
        print(f"[INFO] Nova mensagem de SINAL recebida do grupo/canal de origem {chat.id}: {incoming_message_id}")

        trade_info = await extract_trade_info(incoming_text)

        if not trade_info:
            print(f"[INFO] Mensagem ID {incoming_message_id} do grupo de origem não é um sinal de trade válido após extração.")
            return

        print(f"[INFO] Sinal de trade detectado de {chat.id} (Msg ID: {incoming_message_id}): {trade_info['symbol']} {trade_info['side']}")

        selected_tp = None
        if trade_info['all_tps'] and len(trade_info['all_tps']) >= ALVO_SELECIONADO:
            selected_tp = trade_info['all_tps'][ALVO_SELECIONADO - 1]
            print(f"[INFO] Selecionando Alvo {ALVO_SELECIONADO}: {selected_tp} para sinal da Msg ID {incoming_message_id}")
        else:
            selected_tp = trade_info['tp'] # Usa o primeiro TP se o selecionado não estiver disponível
            print(f"[INFO] Alvo {ALVO_SELECIONADO} não disponível para sinal da Msg ID {incoming_message_id}, usando Alvo 1: {selected_tp}")

        # Montagem da mensagem para o grupo de destino
        message_text_to_send = (
            f"#{trade_info['symbol']}  {trade_info['side']}\n"
        )
        if trade_info.get('timeframe'):
            message_text_to_send += f"{trade_info['timeframe']}\n"
        message_text_to_send += (
            "Divap\n\n" # Certifique-se que "Divap" é o que você quer aqui
            f"ALAVANCAGEM: {trade_info['leverage']}x\n"
            "MARGEM: CRUZADA\n"
            f"CAPITAL: {int(trade_info['capital_pct'])}%\n\n"
            f"ENTRADA: {trade_info['entry']}\n\n"
            f"ALVO: {selected_tp}\n\n"
            f"STOP LOSS: {trade_info['stop_loss']}"
        )

        print("\n[INFO] Mensagem de sinal a ser encaminhada:")
        print("-" * 50)
        print(message_text_to_send)
        print("-" * 50)

        sent_message_to_dest = await client.send_message(GRUPO_DESTINO_ID, message_text_to_send)
        sent_message_id = sent_message_to_dest.id
        
        # Registrar a mensagem ENVIADA ao grupo de destino em signals_msg
        sent_message_created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        save_message_to_database(
            message_id=sent_message_id,
            chat_id=GRUPO_DESTINO_ID,
            text=message_text_to_send,
            is_reply=False, # A mensagem enviada pelo bot geralmente não é uma resposta direta no contexto do signals_msg
            reply_to_message_id=None, # A menos que você queira vincular à mensagem original do GRUPO_ORIGEM_ID
            symbol=trade_info['symbol'], # Símbolo do sinal
            signal_id=None, # O signal_id ainda não foi gerado por save_to_database(trade_info)
            created_at=sent_message_created_at
        )
        print(f"[INFO] Mensagem de sinal (ID: {sent_message_id}) enviada para GRUPO_DESTINO_ID ({GRUPO_DESTINO_ID}) e registrada em signals_msg.")

        # Atualizar trade_info com dados relevantes para salvar o sinal
        trade_info['tp'] = selected_tp
        # `message_id` em trade_info deve referenciar a mensagem no GRUPO_DESTINO_ID
        # pois é ela que será atualizada com botões de status, etc.
        trade_info['message_id'] = sent_message_id
        # Adicionar o ID da mensagem original do grupo de origem para referência, se necessário
        trade_info['id_mensagem_origem_sinal'] = incoming_message_id 
        trade_info['chat_id_origem_sinal'] = incoming_chat_id

        # Salvar o sinal de trade na tabela principal de sinais (ex: webhook_signals)
        # Esta função deve retornar o ID do sinal salvo (signal_id_from_db)
        signal_id_from_db = save_to_database(trade_info) # Ex: retorna o ID da tabela webhook_signals

        # Atualizar o registro da mensagem ENVIADA em signals_msg com o signal_id_from_db
        if signal_id_from_db:
            conn_update = None # Declarar fora do try para uso no finally
            cursor_update = None
            try:
                conn_update = mysql.connector.connect(
                    host=DB_HOST,
                    port=int(DB_PORT), # Garanta que DB_PORT seja string no .env e convertido aqui
                    user=DB_USER,
                    password=DB_PASSWORD,
                    database=DB_NAME
                )
                cursor_update = conn_update.cursor()
                
                update_query = """
                    UPDATE signals_msg SET signal_id = %s
                    WHERE message_id = %s AND chat_id = %s
                """
                cursor_update.execute(update_query, (signal_id_from_db, sent_message_id, GRUPO_DESTINO_ID))
                conn_update.commit()
                print(f"[INFO] Tabela signals_msg atualizada com signal_id {signal_id_from_db} para Msg ID {sent_message_id} no Chat ID {GRUPO_DESTINO_ID}.")
            except Exception as e_update:
                print(f"[ERRO] Falha ao atualizar signals_msg com signal_id: {e_update}")
            finally:
                if conn_update and conn_update.is_connected():
                    if cursor_update:
                        cursor_update.close()
                    conn_update.close()
        else:
            print(f"[AVISO] Não foi possível obter signal_id de save_to_database para o sinal da Msg ID {incoming_message_id}. Tabela signals_msg não atualizada com signal_id.")

    except Exception as e:
        print(f"[ERRO GERAL] Falha ao processar mensagem ID {event.message.id if event and event.message else 'desconhecido'} de Chat ID {event.chat_id if event else 'desconhecido'}: {e}")
        import traceback
        print(traceback.format_exc())

# Nova função para registrar mensagens no banco de dados
def save_message_to_database(message_id, chat_id, text, is_reply=False, 
                            reply_to_message_id=None, symbol=None, signal_id=None, 
                            created_at=None):
    """
    Salva uma mensagem do Telegram na tabela signals_msg
    
    Args:
        message_id: ID da mensagem no Telegram
        chat_id: ID do chat onde a mensagem foi enviada
        text: Conteúdo da mensagem
        is_reply: Se é uma resposta a outra mensagem
        reply_to_message_id: ID da mensagem à qual esta responde
        symbol: Símbolo relacionado (se identificado)
        signal_id: ID do sinal na tabela webhook_signals (se relacionado)
        created_at: Timestamp da mensagem (se não fornecido, usa o atual)
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

        # Se não fornecido, usar o timestamp atual
        if not created_at:
            created_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        
        # Preparar a query
        sql = """
              INSERT INTO signals_msg
              (message_id, chat_id, text, is_reply, reply_to_message_id, symbol, signal_id, created_at)
              VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
              """
              
        values = (
            message_id,
            chat_id,
            text,
            is_reply,
            reply_to_message_id,
            symbol,
            signal_id,
            created_at
        )
        
        cursor.execute(sql, values)
        conn.commit()
        
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Mensagem {message_id} registrada na tabela signals_msg")
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao registrar mensagem: {e}")
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

# Função para verificar se uma mensagem é resposta a um sinal
async def check_if_reply_to_signal(reply_to_message_id):
    """
    Verifica se uma mensagem é uma resposta a um sinal de trade
    
    Args:
        reply_to_message_id: ID da mensagem à qual está respondendo
    
    Returns:
        tuple: (symbol, signal_id) se for resposta a um sinal, (None, None) caso contrário
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
        
        # Primeiro, verificar na tabela webhook_signals
        cursor.execute("""
            SELECT id, symbol FROM webhook_signals 
            WHERE message_id = %s OR registry_message_id = %s
        """, (reply_to_message_id, reply_to_message_id))
        
        result = cursor.fetchone()
        if result:
            return (result['symbol'], result['id'])
            
        # Se não encontrar, verificar na tabela signals_msg
        cursor.execute("""
            SELECT symbol, signal_id FROM signals_msg 
            WHERE message_id = %s
        """, (reply_to_message_id,))
        
        result = cursor.fetchone()
        if result and result['symbol']:
            return (result['symbol'], result['signal_id'])
            
        return (None, None)
        
    except Exception as e:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] Erro ao verificar resposta: {e}")
        return (None, None)
    finally:
        if 'conn' in locals() and conn.is_connected():
            cursor.close()
            conn.close()

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