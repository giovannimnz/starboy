import ccxt
import pandas as pd
import numpy as np
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timedelta
import vectorbt as vbt
import logging
import os
import time
import sys
import traceback
from typing import Dict, Tuple, Union, List, Optional
from dotenv import load_dotenv
from pathlib import Path
import pathlib
import re
import asyncio
from telethon import TelegramClient, events
from telethon.tl.types import Channel, Chat, User, Message

sys.path.append(str(Path(__file__).parent))

# Importar credenciais do Telegram
try:
    from utils.senhas import pers_api_hash, pers_api_id
except ImportError:
    print("[ERRO] Não foi possível importar credenciais do Telegram de utils.senhas")
    pers_api_hash = None
    pers_api_id = None

# Configurar o caminho do .env
env_path = Path(__file__).parents[2] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações dos grupos do Telegram
def parse_grupos_origem():
    """Converte a string de grupos origem do .env em lista de inteiros"""
    grupos_str = os.getenv('GRUPOS_ORIGEM_IDS', '-4192806079')
    grupos = []
    
    if not grupos_str or grupos_str.strip() == '':
        print(f"[AVISO] GRUPOS_ORIGEM_IDS vazio no .env, usando valor padrão")
        return [-4192806079]
    
    for grupo in grupos_str.split(','):
        grupo = grupo.strip()
        if grupo:
            try:
                # Garantir que seja negativo
                grupo_id = int(grupo)
                if grupo_id > 0:
                    grupo_id = -grupo_id
                grupos.append(grupo_id)
            except ValueError:
                print(f"[ERRO] Grupo inválido no .env: {grupo}")
    
    return grupos if grupos else [-4192806079]

GRUPOS_ORIGEM_IDS = parse_grupos_origem()
print(f"[CONFIG] Grupos de origem configurados: {GRUPOS_ORIGEM_IDS}")

# Configurar o caminho do .env
env_path = Path(__file__).parents[2] / 'config' / '.env'
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
        # Adicionar o caminho correto para utils/senhas.py
        sys.path.append(str(Path(__file__).parent / 'utils'))
        from utils.senhas import API_KEY, API_SECRET
        BINANCE_CONFIG['apiKey'] = API_KEY
        BINANCE_CONFIG['secret'] = API_SECRET
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [CONFIG] Usando credenciais do senhas.py")
    except ImportError:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [ERRO] Credenciais Binance não encontradas")

try:
    from utils.analysis.divap_check import DIVAPAnalyzer
except ImportError as e:
    print(f"[ERRO] Não foi possível importar DIVAPAnalyzer: {e}")
    DIVAPAnalyzer = None

# Configuração de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("DIVAP_Backtest")

# Estratégias disponíveis
STRATEGIES = {
    "1": {
        "name": "Reverse Trailling 13", 
        "code": "reverse_trailling_13",
        "description": "Estratégia com trailing stop e distribuição de TPs",
        "tp_distribution": [0.25, 0.20, 0.25, 0.20, 0.10],  # % de redução por TP
        "timeout_multiplier": 3  # Multiplicador para timeout baseado no timeframe
    }
}

# Configurações de parsing
PREJUIZO_MAXIMO_PERCENTUAL_DO_CAPITAL_TOTAL = 4.90
TAXA_ENTRADA = 0.02
TAXA_SAIDA = 0.05

# Mapeamento de timeframes para minutos
TIMEFRAME_MINUTES = {
    '1m': 1,
    '3m': 3,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '2h': 120,
    '4h': 240,
    '6h': 360,
    '8h': 480,
    '12h': 720,
    '1d': 1440
}

# ===== FUNÇÕES DE PARSING DE MENSAGENS =====

def normalize_number(value):
    """Normaliza números no formato string (ex.: "1.234,56" -> "1234.56")."""
    if not isinstance(value, str):
        return value
    value = value.replace(",", ".")
    if value.count(".") > 1:
        parts = value.split(".")
        return ".".join(parts[:-1]) + "." + parts[-1]
    return value

def translate_side(side):
    """Traduz o lado da operação para português."""
    if not side: 
        return side
    side = side.upper()
    return "COMPRA" if side == "BUY" else "VENDA" if side == "SELL" else side

def clean_symbol(symbol):
    """Remove o sufixo '.P' do símbolo, se presente."""
    return symbol[:-2] if symbol and symbol.endswith(".P") else symbol

def extract_trade_info(message_text):
    """
    Extrai informações de trade de uma mensagem do Telegram.
    Adaptado do divap.py para uso no backtest.
    """
    if not message_text:
        return None
        
    # Normalizar texto
    text = message_text.strip()
    
    # Padrões de regex para extrair informações
    patterns = {
        'symbol': r'(?:PAIR:|Symbol:|Coin:|#)[\s]*([A-Z0-9]+(?:USDT|BUSD|BTC|ETH|BNB)?)',
        'side': r'(?:DIRECTION:|Side:|Action:|TYPE:)[\s]*([A-Z]+)',
        'leverage': r'(?:LEVERAGE:|Lev:|X)[\s]*([0-9]+)',
        'entry': r'(?:ENTRY:|Entry Price:|BUY:|SELL:|Price:)[\s]*([0-9,.]+)',
        'sl': r'(?:SL:|Stop Loss:|STOP:)[\s]*([0-9,.]+)',
        'tp1': r'(?:TP1:|Take Profit 1:|TARGET 1:|T1:)[\s]*([0-9,.]+)',
        'tp2': r'(?:TP2:|Take Profit 2:|TARGET 2:|T2:)[\s]*([0-9,.]+)',
        'tp3': r'(?:TP3:|Take Profit 3:|TARGET 3:|T3:)[\s]*([0-9,.]+)',
        'tp4': r'(?:TP4:|Take Profit 4:|TARGET 4:|T4:)[\s]*([0-9,.]+)',
        'tp5': r'(?:TP5:|Take Profit 5:|TARGET 5:|T5:)[\s]*([0-9,.]+)',
        'timeframe': r'(?:TIMEFRAME:|TF:|Time:)[\s]*([0-9]+[mhd])',
        'capital_pct': r'(?:RISK:|Risk:|Capital:)[\s]*([0-9,.]+)%?'
    }
    
    # Extrair informações usando regex
    extracted = {}
    for key, pattern in patterns.items():
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            extracted[key] = match.group(1).strip()
    
    # Se não encontrou informações básicas, tentar padrões mais flexíveis
    if not extracted.get('symbol'):
        # Buscar símbolos USDT
        symbol_match = re.search(r'([A-Z0-9]+)USDT', text, re.IGNORECASE)
        if symbol_match:
            extracted['symbol'] = symbol_match.group(0).upper()
    
    # Buscar LONG/SHORT
    if not extracted.get('side'):
        if re.search(r'\bLONG\b', text, re.IGNORECASE):
            extracted['side'] = 'LONG'
        elif re.search(r'\bSHORT\b', text, re.IGNORECASE):
            extracted['side'] = 'SHORT'
        elif re.search(r'\bBUY\b', text, re.IGNORECASE):
            extracted['side'] = 'BUY'
        elif re.search(r'\bSELL\b', text, re.IGNORECASE):
            extracted['side'] = 'SELL'
    
    # Validar se tem informações mínimas
    if not extracted.get('symbol') or not extracted.get('side'):
        return None
    
    # Processar e normalizar dados
    trade_info = {
        'symbol': clean_symbol(extracted.get('symbol', '')),
        'side': translate_side(extracted.get('side', '')),
        'leverage': int(extracted.get('leverage', 10)),
        'entry_price': float(normalize_number(extracted.get('entry', '0'))) if extracted.get('entry') else 0,
        'sl_price': float(normalize_number(extracted.get('sl', '0'))) if extracted.get('sl') else 0,
        'tp1_price': float(normalize_number(extracted.get('tp1', '0'))) if extracted.get('tp1') else 0,
        'tp2_price': float(normalize_number(extracted.get('tp2', '0'))) if extracted.get('tp2') else 0,
        'tp3_price': float(normalize_number(extracted.get('tp3', '0'))) if extracted.get('tp3') else 0,
        'tp4_price': float(normalize_number(extracted.get('tp4', '0'))) if extracted.get('tp4') else 0,
        'tp5_price': float(normalize_number(extracted.get('tp5', '0'))) if extracted.get('tp5') else 0,
        'timeframe': extracted.get('timeframe', '15m'),
        'capital_pct': float(normalize_number(extracted.get('capital_pct', '2'))) if extracted.get('capital_pct') else 2.0
    }
    
    # Validar preços
    if trade_info['entry_price'] <= 0:
        return None
    
    return trade_info

def save_signal_to_database(trade_info: Dict, message_date: datetime, chat_id: int, message_id: int, conn, cursor) -> Optional[int]:
    """
    Salva sinal extraído no banco de dados usando a data original da mensagem.
    """
    try:
        # Usar conta_id = 1 como padrão para backtest
        conta_id = 1
        
        insert_query = """
            INSERT INTO webhook_signals (
                symbol, side, leverage, entry_price, sl_price, 
                tp1_price, tp2_price, tp3_price, tp4_price, tp5_price,
                timeframe, capital_pct, status, conta_id, 
                chat_id_orig_sinal, message_id_orig, created_at, updated_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            RETURNING id
        """
        
        values = (
            trade_info['symbol'],
            trade_info['side'],
            trade_info['leverage'],
            trade_info['entry_price'],
            trade_info['sl_price'],
            trade_info['tp1_price'],
            trade_info['tp2_price'],
            trade_info['tp3_price'],
            trade_info['tp4_price'],
            trade_info['tp5_price'],
            trade_info['timeframe'],
            trade_info['capital_pct'],
            'active',
            conta_id,
            chat_id,
            message_id,
            message_date,  # Usar a data original da mensagem
            message_date
        )
        
        cursor.execute(insert_query, values)
        signal_id = cursor.fetchone()[0]
        conn.commit()
        
        logger.info(f"Sinal salvo no banco: {trade_info['symbol']} {trade_info['side']} - ID: {signal_id}")
        return signal_id
        
    except Exception as e:
        logger.error(f"Erro ao salvar sinal no banco: {e}")
        conn.rollback()
        return None

# ===== CLASSE TELEGRAM SCRAPER =====

class TelegramScraper:
    """Scraper para buscar mensagens históricas do Telegram"""
    
    def __init__(self, db_config: Dict):
        self.db_config = db_config
        self.conn = None
        self.cursor = None
        self.client = None
        
    def connect_db(self):
        """Conecta ao banco de dados"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("Telegram Scraper conectado ao banco")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco: {e}")
            raise
    
    async def connect_telegram(self):
        """Conecta ao Telegram"""
        try:
            if not pers_api_id or not pers_api_hash:
                raise ValueError("Credenciais do Telegram não configuradas")
            
            self.client = TelegramClient('backtest_session', pers_api_id, pers_api_hash)
            await self.client.start()
            logger.info("Conectado ao Telegram")
            
        except Exception as e:
            logger.error(f"Erro ao conectar ao Telegram: {e}")
            raise
    
    async def get_messages_from_channel(self, channel_id: int, start_date: datetime = None, end_date: datetime = None, limit: int = 1000):
        """
        Busca mensagens históricas de um canal do Telegram.
        """
        try:
            messages = []
            
            # Buscar mensagens
            async for message in self.client.iter_messages(
                channel_id, 
                offset_date=end_date if end_date else None,
                reverse=True,
                limit=limit
            ):
                if not message.text:
                    continue
                    
                # Filtrar por data se especificado
                if start_date and message.date < start_date:
                    continue
                if end_date and message.date > end_date:
                    continue
                
                messages.append({
                    'id': message.id,
                    'text': message.text,
                    'date': message.date,
                    'chat_id': channel_id
                })
            
            logger.info(f"Obtidas {len(messages)} mensagens do canal {channel_id}")
            return messages
            
        except Exception as e:
            logger.error(f"Erro ao buscar mensagens do canal {channel_id}: {e}")
            return []
    
    async def scrape_and_save_signals(self, channels: List[int], start_date: datetime = None, end_date: datetime = None):
        """
        Faz scraping de mensagens e salva sinais no banco.
        """
        total_signals = 0
        
        for channel_id in channels:
            logger.info(f"Fazendo scraping do canal {channel_id}")
            
            messages = await self.get_messages_from_channel(channel_id, start_date, end_date)
            
            for message in messages:
                # Tentar extrair informações de trade
                trade_info = extract_trade_info(message['text'])
                
                if trade_info:
                    # Salvar no banco usando a data original da mensagem
                    signal_id = save_signal_to_database(
                        trade_info, 
                        message['date'], 
                        message['chat_id'], 
                        message['id'],
                        self.conn,
                        self.cursor
                    )
                    
                    if signal_id:
                        total_signals += 1
                        logger.info(f"Sinal {total_signals}: {trade_info['symbol']} {trade_info['side']} - {message['date']}")
        
        logger.info(f"Scraping concluído: {total_signals} sinais salvos")
        return total_signals
    
    async def close_connections(self):
        """Fecha conexões"""
        if self.client:
            await self.client.disconnect()
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões do Telegram Scraper fechadas")

class BacktestEngine:
    def __init__(self, db_config: Dict, binance_config: Dict):
        self.db_config = db_config
        self.binance_config = binance_config
        self.exchange = None
        self.conn = None
        self.cursor = None
        self.initial_capital = 0
        self.current_capital = 0
        self.strategy = None
        self.base_fee = 0.0
        self.start_date = None
        self.end_date = None
        self.cancelled_trades = 0
        self.executed_trades = 0
        
    def connect_db(self) -> None:
        """Conecta ao banco de dados"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("Conectado ao banco de dados PostgreSQL")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco: {e}")
            raise
    
    def connect_exchange(self) -> None:
        """Conecta à exchange Binance"""
        try:
            self.exchange = ccxt.binance(self.binance_config)
            logger.info("Conectado à Binance")
        except Exception as e:
            logger.error(f"Erro ao conectar à Binance: {e}")
            raise
    
    def close_connections(self) -> None:
        """Fecha as conexões"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")
    
    def setup_backtest(self):
        """Configura os parâmetros do backtest"""
        print("\n" + "="*60)
        print("🎯 CONFIGURAÇÃO DO BACKTEST")
        print("="*60)
        
        # Solicitar capital inicial
        while True:
            try:
                capital_str = input("\n💰 Digite o capital inicial (USDT): ").strip()
                self.initial_capital = float(capital_str)
                self.current_capital = self.initial_capital
                print(f"✅ Capital inicial definido: ${self.initial_capital:,.2f}")
                break
            except ValueError:
                print("❌ Por favor, digite um valor numérico válido")
        
        # Solicitar estratégia
        print("\n📊 ESTRATÉGIAS DISPONÍVEIS:")
        for key, strategy in STRATEGIES.items():
            print(f"{key}. {strategy['name']} - {strategy['description']}")
        
        while True:
            choice = input("\nEscolha uma estratégia (1): ").strip()
            if choice in STRATEGIES:
                self.strategy = STRATEGIES[choice]
                print(f"✅ Estratégia selecionada: {self.strategy['name']}")
                break
            else:
                print("❌ Opção inválida. Digite 1")
        
        # Solicitar taxa percentual
        while True:
            try:
                fee_str = input("\n💸 Digite a taxa percentual base (ex: 0.02 para 0.02%): ").strip()
                self.base_fee = float(fee_str)
                print(f"✅ Taxa definida: {self.base_fee}%")
                break
            except ValueError:
                print("❌ Por favor, digite um valor numérico válido")
        
        # Solicitar período de datas
        print("\n📅 PERÍODO DE ANÁLISE:")
        print("1. Período específico")
        print("2. Desde o início")
        
        while True:
            period_choice = input("\nEscolha uma opção (1-2): ").strip()
            if period_choice == "1":
                start_date = input("Data inicial (DD-MM-YYYY): ").strip()
                end_date = input("Data final (DD-MM-YYYY): ").strip()
                try:
                    self.start_date = datetime.strptime(start_date, "%d-%m-%Y")
                    self.end_date = datetime.strptime(end_date, "%d-%m-%Y")
                    print(f"✅ Período: {start_date} até {end_date}")
                    break
                except ValueError:
                    print("❌ Formato de data inválido. Use DD-MM-YYYY")
            elif period_choice == "2":
                self.start_date = None
                self.end_date = None
                print("✅ Analisando desde o início")
                break
            else:
                print("❌ Opção inválida")
                
    def should_cancel_entry(self, signal: Dict, current_time: datetime) -> bool:
        """Verifica se a entrada deve ser cancelada"""
        # Verificar timeout baseado no timeframe
        timeframe = signal.get('timeframe', '15m')
        timeout_minutes = TIMEFRAME_MINUTES.get(timeframe, 15) * self.strategy['timeout_multiplier']
        
        signal_time = signal.get('created_at')
        if isinstance(signal_time, str):
            signal_time = datetime.fromisoformat(signal_time.replace('Z', '+00:00'))
        
        # Verificar se excedeu o timeout
        if (current_time - signal_time).total_seconds() > timeout_minutes * 60:
            return True
        
        # Verificar se SL foi atingido antes da entrada
        entry_price = float(signal.get('entry_price', 0))
        sl_price = float(signal.get('sl_price', 0))
        side = signal.get('side', '').upper()
        
        # Simular preço de mercado (aqui você usaria dados reais)
        # Por simplicidade, vamos assumir que o preço de mercado é o próprio entry_price
        market_price = entry_price
        
        # Para LONG: se o preço de mercado caiu abaixo do SL, cancelar
        if side == 'COMPRA' and market_price <= sl_price:
            return True
        
        # Para SHORT: se o preço de mercado subiu acima do SL, cancelar
        if side == 'VENDA' and market_price >= sl_price:
            return True
        
        return False
    
    def should_enter_position(self, signal: Dict, current_time: datetime) -> bool:
        """Verifica se deve entrar na posição"""
        entry_price = float(signal.get('entry_price', 0))
        side = signal.get('side', '').upper()
        
        # Simular preço de mercado
        market_price = entry_price  # Simplificação - usar dados reais do mercado
        
        # Para LONG: entrar quando o preço de mercado for superior ao preço de entrada
        if side == 'COMPRA' and market_price > entry_price:
            return True
        
        # Para SHORT: entrar quando o preço de mercado for inferior ao preço de entrada
        if side == 'VENDA' and market_price < entry_price:
            return True
        
        return False
    
    def get_signals_for_backtest(self) -> List[Dict]:
        """Obtém sinais para backtest - primeiro verifica se existe o canal específico, senão usa os configurados"""
        try:
            # Primeiro, verificar se existem sinais do canal específico solicitado
            query_check = """
                SELECT COUNT(*) as total
                FROM webhook_signals ws
                WHERE ws.chat_id_orig_sinal = %s
            """
            
            self.cursor.execute(query_check, [-1002444455075])
            result = self.cursor.fetchone()
            target_channel = -1002444455075
            
            if result['total'] == 0:
                # Se não existir sinais do canal específico, usar os grupos configurados no .env
                print("⚠️  Canal -1002444455075 não possui sinais, usando grupos configurados...")
                
                # Verificar quais canais têm sinais disponíveis
                query_available = """
                    SELECT chat_id_orig_sinal, COUNT(*) as total
                    FROM webhook_signals 
                    WHERE chat_id_orig_sinal IS NOT NULL
                    GROUP BY chat_id_orig_sinal
                    ORDER BY total DESC
                    LIMIT 5
                """
                
                self.cursor.execute(query_available)
                available_channels = self.cursor.fetchall()
                
                print("\n📊 Canais com sinais disponíveis:")
                for channel in available_channels:
                    print(f"   Chat ID: {channel['chat_id_orig_sinal']} - Total: {channel['total']}")
                
                # Usar o canal com mais sinais, ou o configurado no .env se existir
                grupos_origem_env = [-4192806079]  # Do .env
                
                # Verificar se o grupo do .env tem sinais
                query_env_check = """
                    SELECT COUNT(*) as total
                    FROM webhook_signals ws
                    WHERE ws.chat_id_orig_sinal = %s
                """
                
                self.cursor.execute(query_env_check, [grupos_origem_env[0]])
                env_result = self.cursor.fetchone()
                
                if env_result['total'] > 0:
                    target_channel = grupos_origem_env[0]
                    print(f"✅ Usando canal configurado no .env: {target_channel}")
                else:
                    # Usar o canal com mais sinais
                    if available_channels:
                        target_channel = available_channels[0]['chat_id_orig_sinal']
                        print(f"✅ Usando canal com mais sinais: {target_channel}")
                    else:
                        print("❌ Nenhum canal com sinais encontrado")
                        return []
            else:
                print(f"✅ Usando canal específico: {target_channel}")
            
            # Query principal para obter sinais
            query = """
                SELECT ws.*, sa.divap_confirmed, sa.analysis_type
                FROM webhook_signals ws
                LEFT JOIN signals_analysis sa ON ws.id = sa.signal_id
                WHERE ws.chat_id_orig_sinal = %s
            """
            
            params = [target_channel]
            
            if self.start_date:
                query += " AND ws.created_at >= %s"
                params.append(self.start_date)
            
            if self.end_date:
                query += " AND ws.created_at <= %s"
                params.append(self.end_date)
            
            query += " ORDER BY ws.created_at ASC"
            
            self.cursor.execute(query, params)
            signals = self.cursor.fetchall()
            
            logger.info(f"Obtidos {len(signals)} sinais para backtest do canal {target_channel}")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao obter sinais: {e}")
            return []
    
    def analyze_signal_divap(self, signal: Dict) -> Dict:
        """Analisa se o sinal é DIVAP usando DIVAPAnalyzer"""
        try:
            if DIVAPAnalyzer is None:
                logger.error("DIVAPAnalyzer não está disponível")
                return {"error": "DIVAPAnalyzer não disponível"}
            
            analyzer = DIVAPAnalyzer(self.db_config, self.binance_config)
            analyzer.connect_db()
            analyzer.connect_exchange()
            
            # Analisar o sinal
            result = analyzer.analyze_signal(signal)
            
            # Salvar na tabela signals_analysis com analysis_type='backtest'
            if result and 'signal_id' in result:
                self.save_signal_analysis(result, signal['id'])
            
            analyzer.close_connections()
            return result
            
        except Exception as e:
            logger.error(f"Erro na análise DIVAP: {e}")
            return {"error": str(e)}
    
    def save_signal_analysis(self, analysis_result: Dict, signal_id: int) -> None:
        """Salva análise de sinal na tabela signals_analysis"""
        try:
            insert_query = """
                INSERT INTO signals_analysis (
                    signal_id, is_bull_divap, is_bear_divap, divap_confirmed,
                    rsi, volume, volume_sma, high_volume, bull_div, bear_div,
                    message, price_reversal_up, price_reversal_down, analyzed_at,
                    bull_reversal_pattern, bear_reversal_pattern, analysis_type
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (signal_id) DO UPDATE SET
                    divap_confirmed = EXCLUDED.divap_confirmed,
                    analyzed_at = EXCLUDED.analyzed_at,
                    analysis_type = EXCLUDED.analysis_type
            """
            
            values = (
                signal_id,
                analysis_result.get('is_bull_divap', False),
                analysis_result.get('is_bear_divap', False),
                analysis_result.get('divap_confirmed', False),
                analysis_result.get('rsi'),
                analysis_result.get('volume'),
                analysis_result.get('volume_sma'),
                analysis_result.get('high_volume', False),
                analysis_result.get('bull_div', False),
                analysis_result.get('bear_div', False),
                analysis_result.get('message'),
                analysis_result.get('price_reversal_up', False),
                analysis_result.get('price_reversal_down', False),
                datetime.now(),
                analysis_result.get('bull_reversal_pattern', False),
                analysis_result.get('bear_reversal_pattern', False),
                'backtest'
            )
            
            self.cursor.execute(insert_query, values)
            self.conn.commit()
            
        except Exception as e:
            logger.error(f"Erro ao salvar análise de sinal: {e}")
    
    def save_backtest_signal(self, signal: Dict, divap_confirmed: bool, cancelled: bool) -> int:
        """Salva o sinal na tabela backtest_signals"""
        try:
            insert_query = """
                INSERT INTO backtest_signals (
                    symbol, side, leverage, capital_pct, entry_price, sl_price,
                    tp1_price, tp2_price, tp3_price, tp4_price, tp5_price,
                    signal_datetime, divap_confirmado, cancelado_checker,
                    created_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING id
            """
            
            values = (
                signal.get('symbol'),
                signal.get('side'),
                signal.get('leverage'),
                signal.get('capital_pct'),
                signal.get('entry_price'),
                signal.get('sl_price'),
                signal.get('tp1_price'),
                signal.get('tp2_price'),
                signal.get('tp3_price'),
                signal.get('tp4_price'),
                signal.get('tp5_price'),
                signal.get('created_at'),  # signal_datetime
                divap_confirmed,
                cancelled,
                datetime.now(),
                datetime.now()
            )
            
            self.cursor.execute(insert_query, values)
            result = self.cursor.fetchone()
            self.conn.commit()
            
            return result['id'] if result else None
            
        except Exception as e:
            logger.error(f"Erro ao salvar sinal de backtest: {e}")
            return None
    
    def simulate_trade_with_trailing_stop(self, signal: Dict, backtest_signal_id: int) -> Dict:
        """Simula uma operação completa com trailing stop"""
        try:
            symbol = signal.get('symbol')
            side = signal.get('side', '').upper()
            entry_price = float(signal.get('entry_price', 0))
            sl_price = float(signal.get('sl_price', 0))
            
            # Preços dos TPs
            tp_prices = [
                float(signal.get('tp1_price', 0)),
                float(signal.get('tp2_price', 0)),
                float(signal.get('tp3_price', 0)),
                float(signal.get('tp4_price', 0)),
                float(signal.get('tp5_price', 0))
            ]
            
            # Calcular quantidade baseada no capital (5% do capital por trade)
            position_size = self.current_capital * 0.05
            
            # Calcular taxa de entrada
            entry_fee = position_size * (self.base_fee / 100)
            
            # Simular entrada
            total_cost = position_size + entry_fee
            
            # Variáveis para trailing stop
            current_sl = sl_price
            remaining_position = position_size
            
            # Simular saídas nos TPs com trailing stop
            tp_results = []
            total_profit = 0
            total_fees = entry_fee
            
            for i, (tp_price, reduction_pct) in enumerate(zip(tp_prices, self.strategy['tp_distribution'])):
                if tp_price > 0:
                    # Calcular quantidade para este TP
                    tp_quantity = remaining_position * reduction_pct
                    
                    # Calcular lucro/prejuízo
                    if side == 'COMPRA':
                        profit = tp_quantity * (tp_price - entry_price) / entry_price
                    else:  # VENDA
                        profit = tp_quantity * (entry_price - tp_price) / entry_price
                    
                    # Calcular taxa de saída
                    exit_fee = tp_quantity * (self.base_fee / 100)
                    
                    # Lucro líquido
                    net_profit = profit - exit_fee
                    
                    tp_results.append({
                        f'tp{i+1}_profit': net_profit,
                        f'tp{i+1}_fee': exit_fee
                    })
                    
                    total_profit += net_profit
                    total_fees += exit_fee
                    remaining_position -= tp_quantity
                    
                    # Implementar trailing stop
                    if i == 0:  # Após TP1, mover SL para entrada
                        current_sl = entry_price
                    elif i == 2:  # Após TP3, mover SL para TP1
                        current_sl = tp_prices[0]
            
            # Calcular capital final
            final_capital = self.current_capital + total_profit
            
            # Definir third_to_last_tp e last_tp
            third_to_last_tp = tp_prices[2] if len(tp_prices) >= 3 else None
            last_tp = tp_prices[-1] if tp_prices else None
            
            # Salvar resultado
            result_data = {
                'symbol': symbol,
                'initial_capital': self.current_capital,
                'final_capital': final_capital,
                'total_pnl': total_profit,
                'open_datetime': signal.get('created_at'),
                'close_datetime': datetime.now(),
                'base_fee': self.base_fee,
                'total_profit': total_profit,
                'total_fee': total_fees,
                'entry_price': entry_price,
                'entry_fee': entry_fee,
                'strategy': self.strategy['code'],
                'third_to_last_tp': third_to_last_tp,
                'last_tp': last_tp,
                'backtest_signal_id': backtest_signal_id
            }
            
            # Adicionar dados dos TPs
            for tp_result in tp_results:
                result_data.update(tp_result)
            
            # Salvar no banco
            result_id = self.save_backtest_result(result_data)
            
            # Atualizar capital atual para o próximo trade
            self.current_capital = final_capital
            
            return result_data
            
        except Exception as e:
            logger.error(f"Erro na simulação do trade: {e}")
            return {}
    
    def save_backtest_result(self, result_data: Dict) -> int:
        """Salva resultado do backtest"""
        try:
            insert_query = """
                INSERT INTO backtest_results (
                    symbol, initial_capital, final_capital, total_pnl,
                    open_datetime, close_datetime, base_fee, total_profit,
                    total_fee, entry_price, entry_fee, strategy,
                    tp1_profit, tp1_fee, tp2_profit, tp2_fee,
                    tp3_profit, tp3_fee, tp4_profit, tp4_fee,
                    tp5_profit, tp5_fee, third_to_last_tp, last_tp,
                    created_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                RETURNING id
            """
            
            values = (
                result_data.get('symbol'),
                result_data.get('initial_capital'),
                result_data.get('final_capital'),
                result_data.get('total_pnl'),
                result_data.get('open_datetime'),
                result_data.get('close_datetime'),
                result_data.get('base_fee'),
                result_data.get('total_profit'),
                result_data.get('total_fee'),
                result_data.get('entry_price'),
                result_data.get('entry_fee'),
                result_data.get('strategy'),
                result_data.get('tp1_profit'),
                result_data.get('tp1_fee'),
                result_data.get('tp2_profit'),
                result_data.get('tp2_fee'),
                result_data.get('tp3_profit'),
                result_data.get('tp3_fee'),
                result_data.get('tp4_profit'),
                result_data.get('tp4_fee'),
                result_data.get('tp5_profit'),
                result_data.get('tp5_fee'),
                result_data.get('third_to_last_tp'),
                result_data.get('last_tp'),
                datetime.now(),
                datetime.now()
            )
            
            self.cursor.execute(insert_query, values)
            result = self.cursor.fetchone()
            self.conn.commit()
            
            return result['id'] if result else None
            
        except Exception as e:
            logger.error(f"Erro ao salvar resultado do backtest: {e}")
            return None
    
    def run_backtest(self):
        """Executa o backtest completo"""
        print("\n🚀 INICIANDO BACKTEST...")
        print("="*60)
        
        # Obter sinais
        signals = self.get_signals_for_backtest()
        
        if not signals:
            print("❌ Nenhum sinal encontrado para o período")
            return
        
        print(f"📊 Total de sinais: {len(signals)}")
        print(f"💰 Capital inicial: ${self.initial_capital:,.2f}")
        print(f"📈 Estratégia: {self.strategy['name']}")
        print(f"💸 Taxa base: {self.base_fee}%")
        print("="*60)
        
        successful_trades = 0
        cancelled_trades = 0
        
        for i, signal in enumerate(signals, 1):
            # Formatar data para DD-MM-YYYY
            signal_date = signal.get('created_at')
            if isinstance(signal_date, str):
                signal_datetime = datetime.fromisoformat(signal_date.replace('Z', '+00:00'))
            else:
                signal_datetime = signal_date
            
            formatted_date = signal_datetime.strftime('%d-%m-%Y %H:%M:%S')
            
            print(f"\n🔍 Processando sinal {i}/{len(signals)}: {signal.get('symbol')} em {formatted_date}")
            
            # Verificar se deve cancelar entrada
            current_time = datetime.now()
            if self.should_cancel_entry(signal, current_time):
                print(f"❌ Entrada cancelada (timeout ou SL atingido)")
                self.save_backtest_signal(signal, False, True)
                cancelled_trades += 1
                continue
            
            # Analisar se é DIVAP
            divap_result = self.analyze_signal_divap(signal)
            
            if "error" in divap_result:
                print(f"❌ Erro na análise: {divap_result['error']}")
                self.save_backtest_signal(signal, False, True)
                cancelled_trades += 1
                continue
            
            divap_confirmed = divap_result.get('divap_confirmed', False)
            
            # Salvar sinal de backtest
            backtest_signal_id = self.save_backtest_signal(signal, divap_confirmed, not divap_confirmed)
            
            if divap_confirmed:
                print(f"✅ DIVAP confirmado - Executando trade")
                
                # Verificar se deve entrar na posição
                if self.should_enter_position(signal, current_time):
                    # Simular trade com trailing stop
                    trade_result = self.simulate_trade_with_trailing_stop(signal, backtest_signal_id)
                    
                    if trade_result:
                        pnl = trade_result.get('total_pnl', 0)
                        print(f"💰 PnL: ${pnl:,.2f} | Capital: ${self.current_capital:,.2f}")
                        successful_trades += 1
                    else:
                        print("❌ Erro na simulação do trade")
                        cancelled_trades += 1
                else:
                    print(f"❌ Condições de entrada não atendidas")
                    cancelled_trades += 1
            else:
                print(f"❌ DIVAP não confirmado - Trade cancelado")
                cancelled_trades += 1
        
        # Resultado final
        print("\n" + "="*60)
        print("🎯 RESULTADO DO BACKTEST")
        print("="*60)
        print(f"💰 Capital inicial: ${self.initial_capital:,.2f}")
        print(f"💰 Capital final: ${self.current_capital:,.2f}")
        pnl_total = self.current_capital - self.initial_capital
        pnl_percent = (pnl_total / self.initial_capital) * 100
        print(f"📈 PnL total: ${pnl_total:,.2f} ({pnl_percent:.2f}%)")
        print(f"📊 Trades executados: {successful_trades}")
        print(f"❌ Trades cancelados: {cancelled_trades}")
        total_signals = successful_trades + cancelled_trades
        if total_signals > 0:
            success_rate = (successful_trades / total_signals) * 100
            print(f"🎯 Taxa de sucesso: {success_rate:.1f}%")
        print(f"🔄 Estratégia: {self.strategy['name']}")
        print("="*60)
        
        # Salvar resumo do backtest
        self.save_backtest_summary(successful_trades, cancelled_trades, pnl_total)
    
    def save_backtest_summary(self, successful_trades: int, cancelled_trades: int, pnl_total: float):
        """Salva resumo do backtest (opcional - para relatórios futuros)"""
        try:
            # Aqui você pode criar uma tabela de resumos de backtest se necessário
            logger.info(f"Backtest concluído - Trades: {successful_trades}, Cancelados: {cancelled_trades}, PnL: ${pnl_total:,.2f}")
        except Exception as e:
            logger.error(f"Erro ao salvar resumo do backtest: {e}")

def backtest_mode():
    """Modo de backtest"""
    print("\n" + "="*60)
    print("🎯 SISTEMA DE BACKTEST DIVAP")
    print("="*60)
    print("Executa backtest completo de sinais históricos")
    print("com análise DIVAP e simulação de trades.")
    print("="*60)
    
    engine = BacktestEngine(DB_CONFIG, BINANCE_CONFIG)
    try:
        engine.connect_db()
        engine.connect_exchange()
        engine.setup_backtest()
        engine.run_backtest()
    except Exception as e:
        logger.error(f"Erro no backtest: {e}")
        traceback.print_exc()
    finally:
        engine.close_connections()

def interactive_mode():
    """Modo interativo para análise individual"""
    if DIVAPAnalyzer is None:
        print("\n❌ DIVAPAnalyzer não está disponível. Verifique as dependências.")
        return
    
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        while True:
            print("\n" + "="*60 + "\n🔍 ANALISADOR DIVAP - MODO INTERATIVO\n" + "="*60)
            print("1. Analisar sinal por ID")
            print("2. Analisar sinal por data e símbolo")
            print("3. Monitorar todos os sinais")
            print("4. Monitoramento em tempo real")
            print("5. Executar Backtest")
            print("6. Sair")
            choice = input("\nEscolha uma opção (1-6): ").strip()
            
            if choice == "1":
                try:
                    signal_id = int(input("Digite o ID do sinal: ").strip())
                    signal = analyzer.get_signal_by_id(signal_id)
        
                    if signal:
                        result = analyzer.analyze_signal(signal)
                        analyzer.print_analysis_result(result)
                        analyzer.save_analysis_result(result)
                    else:
                        print(f"\n❌ Sinal com ID {signal_id} não encontrado.")
                except (ValueError, TypeError):
                    print("\n❌ ID inválido. Digite um número inteiro.")
            
            elif choice == "2":
                date_str = input("Digite a data (DD-MM-YYYY): ").strip()
                symbol_input = input("Digite o símbolo (ex: ETH ou ETHUSDT): ").strip()
                
                try:
                    datetime.strptime(date_str, "%d-%m-%Y")
                    
                    if symbol_input:
                        symbol = symbol_input.upper()
                        if not symbol.endswith("USDT"):
                            symbol += "USDT"
                    else:
                        symbol = None

                    signals = analyzer.get_signals_by_date_symbol(date_str, symbol)
                    if signals:
                        print(f"\n📋 Encontrados {len(signals)} sinais:")
                        for i, s in enumerate(signals):
                            tf = s.get('timeframe', 'N/A')
                            # Formatar data para DD-MM-YYYY
                            signal_date = s.get('created_at')
                            if isinstance(signal_date, str):
                                signal_datetime = datetime.fromisoformat(signal_date.replace('Z', '+00:00'))
                            else:
                                signal_datetime = signal_date
                            formatted_date = signal_datetime.strftime('%d-%m-%Y %H:%M:%S')
                            print(f"{i+1}. ID: {s['id']} - {s['symbol']} {tf} {s['side']} @ {formatted_date}")
                        
                        try:
                            choice_idx = int(input("\nDigite o número do sinal para analisar (ou 0 para voltar): ").strip())
                            if 1 <= choice_idx <= len(signals):
                                result = analyzer.analyze_signal(signals[choice_idx-1])
                                analyzer.print_analysis_result(result)
                                analyzer.save_analysis_result(result)
                        except (ValueError, TypeError):
                            print("\n❌ Digite um número válido.")
                except ValueError:
                    print("\n❌ Formato de data inválido. Use DD-MM-YYYY.")
            
            elif choice == "3":
                print("\n🔍 MONITOR DE SINAIS")
                print("1. Monitorar sinais não analisados")
                print("2. Monitorar sinais dos últimos X dias")
                print("3. Voltar")
                
                monitor_choice = input("\nEscolha uma opção (1-3): ").strip()
                
                if monitor_choice == "1":
                    limit = input("Número máximo de sinais (padrão: 100): ").strip()
                    limit = int(limit) if limit.isdigit() else 100
                    analyzer.monitor_all_signals(period_days=None, limit=limit)
                
                elif monitor_choice == "2":
                    days = input("Número de dias para análise (padrão: 7): ").strip()
                    days = int(days) if days.isdigit() else 7
                    
                    limit = input("Número máximo de sinais (padrão: 100): ").strip()
                    limit = int(limit) if limit.isdigit() else 100
                    
                    analyzer.monitor_all_signals(period_days=days, limit=limit)
            
            elif choice == "4":
                print("\nIniciando monitoramento em tempo real da tabela webhook_signals...")
                analyzer.monitor_signals_realtime()
            
            elif choice == "5":
                print("\n🎯 EXECUTANDO BACKTEST...")
                analyzer.close_connections()
                backtest_mode()
                # Reconectar analyzer
                analyzer.connect_db()
                analyzer.connect_exchange()
            
            elif choice == "6":
                print("\n👋 Saindo...")
                break
            else:
                print("\n❌ Opção inválida.")
    except Exception as e:
        logger.error(f"ERRO CRÍTICO NO MODO INTERATIVO: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()

def telegram_scraper_mode():
    """Modo de scraping do Telegram"""
    print("\n" + "="*60)
    print("📱 SCRAPING DO TELEGRAM")
    print("="*60)
    print("Busca mensagens históricas do Telegram, extrai sinais")
    print("e salva no banco com a data original da mensagem.")
    print("="*60)
    
    scraper = TelegramScraper(DB_CONFIG)
    
    try:
        # Conectar ao banco e Telegram
        scraper.connect_db()
        asyncio.run(scraper.connect_telegram())
        
        # Configurar canais
        print(f"\n📡 Canais configurados: {GRUPOS_ORIGEM_IDS}")
        
        # Solicitar período de scraping
        print("\n📅 PERÍODO DE SCRAPING:")
        print("1. Período específico")
        print("2. Últimos 30 dias")
        print("3. Últimos 7 dias")
        print("4. Desde o início")
        
        period_choice = input("\nEscolha uma opção (1-4): ").strip()
        
        start_date = None
        end_date = None
        
        if period_choice == "1":
            start_str = input("Data inicial (DD-MM-YYYY): ").strip()
            end_str = input("Data final (DD-MM-YYYY): ").strip()
            try:
                start_date = datetime.strptime(start_str, "%d-%m-%Y")
                end_date = datetime.strptime(end_str, "%d-%m-%Y")
                print(f"✅ Período: {start_date.strftime('%d-%m-%Y')} a {end_date.strftime('%d-%m-%Y')}")
            except ValueError:
                print("❌ Formato de data inválido. Usando padrão (últimos 7 dias)")
                end_date = datetime.now()
                start_date = end_date - timedelta(days=7)
        elif period_choice == "2":
            end_date = datetime.now()
            start_date = end_date - timedelta(days=30)
            print("✅ Período: Últimos 30 dias")
        elif period_choice == "3":
            end_date = datetime.now()
            start_date = end_date - timedelta(days=7)
            print("✅ Período: Últimos 7 dias")
        elif period_choice == "4":
            start_date = None
            end_date = None
            print("✅ Período: Desde o início")
        else:
            print("❌ Opção inválida. Usando padrão (últimos 7 dias)")
            end_date = datetime.now()
            start_date = end_date - timedelta(days=7)
        
        # Executar scraping
        print(f"\n🚀 Iniciando scraping...")
        total_signals = asyncio.run(scraper.scrape_and_save_signals(GRUPOS_ORIGEM_IDS, start_date, end_date))
        
        print(f"\n✅ Scraping concluído!")
        print(f"📊 Total de sinais salvos: {total_signals}")
        
        # Perguntar se quer executar backtest
        if total_signals > 0:
            run_backtest = input("\n🎯 Deseja executar backtest com os sinais encontrados? (s/n): ").strip().lower()
            if run_backtest == 's':
                backtest_mode()
        
    except Exception as e:
        logger.error(f"Erro no scraping do Telegram: {e}")
        traceback.print_exc()
    finally:
        asyncio.run(scraper.close_connections())

def main():
    """Função principal"""
    print("\n" + "="*60)
    print("🎯 SISTEMA DE BACKTEST DIVAP")
    print("="*60)
    print("Este programa permite análise de sinais e execução de backtests")
    print("para a estratégia DIVAP com dados históricos.")
    print("="*60)
    
    print("\nModos disponíveis:")
    print("1. Modo Interativo (análise individual)")
    print("2. Modo Backtest (análise em lote)")
    print("3. Scraping do Telegram (buscar mensagens históricas)")
    print("4. Sair")
    
    choice = input("\nEscolha um modo (1-4): ").strip()
    
    if choice == "1":
        interactive_mode()
    elif choice == "2":
        backtest_mode()
    elif choice == "3":
        telegram_scraper_mode()
    elif choice == "4":
        print("\n👋 Saindo...")
    else:
        print("\n❌ Opção inválida.")

if __name__ == "__main__":
    main()
