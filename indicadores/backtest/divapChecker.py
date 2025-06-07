import ccxt
import pandas as pd
import numpy as np
import mysql.connector
from datetime import datetime, timedelta
import vectorbt as vbt
import logging
import os
import time
import sys
import traceback
from typing import Dict, Tuple, Union, List, Optional
from dotenv import load_dotenv
import pathlib

# Configuração de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("DIVAP_Analyzer")

# Carregar variáveis de ambiente do arquivo .env na raiz do projeto
env_path = pathlib.Path(__file__).parents[2] / '.env'
load_dotenv(dotenv_path=env_path)

DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

# Configuração da conexão com banco de dados
DB_CONFIG = {
    "host": DB_HOST,
    "user": DB_USER,
    "password": DB_PASSWORD,
    "database": DB_NAME
}

# Adicionar porta apenas se estiver definida
if DB_PORT:
    try:
        DB_CONFIG["port"] = int(DB_PORT)
    except (ValueError, TypeError):
        logger.warning(f"Valor de porta inválido no .env: '{DB_PORT}'. Usando porta padrão.")

# Configuração para API da Binance do arquivo .env
API_KEY = os.getenv('API_KEY')
API_SECRET = os.getenv('API_SECRET')

# Configuração da conexão com Binance
BINANCE_CONFIG = {
    "apiKey": API_KEY,
    "secret": API_SECRET,
    "enableRateLimit": True
}

# Parâmetros dos indicadores
RSI_PERIODS = 14
VOLUME_SMA_PERIODS = 20
PIVOT_LEFT = 2  # Períodos à esquerda para determinar pivôs (ajustado para dar mais contexto histórico)

class DIVAPAnalyzer:
    def __init__(self, db_config: Dict, binance_config: Dict):
        """
        Inicializa o analisador DIVAP com configurações de banco de dados e da Binance.
        
        Args:
            db_config: Configuração para conexão com o banco de dados
            binance_config: Configuração para API da Binance
        """
        self.db_config = db_config
        self.binance_config = binance_config
        self.exchange = None
        self.conn = None
        self.cursor = None

    def connect_db(self) -> None:
        """Conecta ao banco de dados MySQL."""
        try:
            self.conn = mysql.connector.connect(**self.db_config)
            self.cursor = self.conn.cursor(dictionary=True)
            logger.info("Conexão com o banco de dados estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco de dados: {e}")
            raise

    def connect_exchange(self) -> None:
        """Conecta à Binance."""
        try:
            self.exchange = ccxt.binanceusdm(self.binance_config)
            self.exchange.load_markets()
            logger.info("Conexão com a Binance estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar à Binance: {e}")
            raise

    def close_connections(self) -> None:
        """Fecha as conexões com o banco de dados e exchange."""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")

    def get_latest_signal(self) -> Dict:
        """
        Obtém o sinal mais recente da tabela webhook_signals.
        
        Returns:
            Dict: Dicionário contendo os dados do sinal
        """
        query = """
            SELECT * FROM webhook_signals
            ORDER BY created_at DESC
            LIMIT 1
        """
        try:
            self.cursor.execute(query)
            signal = self.cursor.fetchone()
            if not signal:
                logger.warning("Nenhum sinal encontrado no banco de dados")
                return {}
            
            logger.info(f"Sinal encontrado: {signal['id']} - {signal['symbol']} - {signal['side']}")
            return signal
        except Exception as e:
            logger.error(f"Erro ao buscar sinal: {e}")
            raise

    def get_signal_by_id(self, signal_id: int) -> Dict:
        """
        Obtém um sinal específico pelo ID na tabela webhook_signals.
        
        Args:
            signal_id: ID do sinal a ser buscado
            
        Returns:
            Dict: Dicionário contendo os dados do sinal
        """
        query = """
            SELECT * FROM webhook_signals
            WHERE id = %s
        """
        try:
            self.cursor.execute(query, (signal_id,))
            signal = self.cursor.fetchone()
            if not signal:
                logger.warning(f"Nenhum sinal encontrado com ID {signal_id}")
                return {}
            
            logger.info(f"Sinal encontrado: {signal['id']} - {signal['symbol']} - {signal['side']}")
            return signal
        except Exception as e:
            logger.error(f"Erro ao buscar sinal por ID: {e}")
            raise

    def get_signals_by_date_symbol(self, date_str: str, symbol: str = None) -> List[Dict]:
        """
        Busca sinais pela data e símbolo (opcional) na tabela webhook_signals.
        
        Args:
            date_str: Data no formato 'YYYY-MM-DD'
            symbol: Símbolo (opcional)
            
        Returns:
            List[Dict]: Lista de sinais encontrados
        """
        try:
            query = """
                SELECT id, symbol, timeframe, side, created_at, updated_at, 
                       entry_price, tp_price, sl_price, status 
                FROM webhook_signals
                WHERE DATE(created_at) = %s
            """
            params = [date_str]
            
            if symbol:
                query += " AND symbol = %s"
                params.append(symbol)
                
            query += " ORDER BY created_at DESC"
            
            self.cursor.execute(query, tuple(params))
            signals = self.cursor.fetchall()
            
            if not signals:
                logger.warning(f"Nenhum sinal encontrado na data {date_str}" + (f" para o símbolo {symbol}" if symbol else ""))
                return []
            
            logger.info(f"Encontrados {len(signals)} sinais na data {date_str}" + (f" para o símbolo {symbol}" if symbol else ""))
            return signals
        except Exception as e:
            logger.error(f"Erro ao buscar sinais por data e símbolo: {e}")
            raise

    def fetch_ohlcv_data(self, symbol: str, timeframe: str, since_dt: datetime, 
                         limit: int = 100) -> pd.DataFrame:
        """
        Busca dados OHLCV da Binance.
        
        Args:
            symbol: Símbolo do par de trading
            timeframe: Período do timeframe (1m, 15m, 1h, etc)
            since_dt: Data/hora inicial para buscar dados
            limit: Número máximo de candles a serem retornados
            
        Returns:
            pd.DataFrame: DataFrame com dados OHLCV
        """
        try:
            # Converter para timestamp em milissegundos
            since_ts = int(since_dt.timestamp() * 1000)
            
            # Buscar dados da Binance
            candles = self.exchange.fetch_ohlcv(
                symbol=symbol, 
                timeframe=timeframe, 
                since=since_ts, 
                limit=limit
            )
            
            if not candles:
                logger.warning(f"Nenhum dado OHLCV encontrado para {symbol} no timeframe {timeframe}")
                return pd.DataFrame()
            
            # Criar DataFrame
            df = pd.DataFrame(candles, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
            df.set_index("timestamp", inplace=True)
            
            logger.info(f"Dados OHLCV obtidos: {len(df)} candles de {df.index[0]} a {df.index[-1]}")
            return df
            
        except Exception as e:
            logger.error(f"Erro ao buscar dados OHLCV: {e}")
            raise

    def detect_price_reversals(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Detecta reversões de preço sem depender de padrões de velas específicos.
        Uma reversão é identificada quando há uma mudança na direção do preço.
        
        Args:
            df: DataFrame com dados OHLCV
            
        Returns:
            pd.DataFrame: DataFrame com reversões identificadas
        """
        # Inicializar colunas para reversões
        df['price_reversal_up'] = False  # Reversão de baixa para alta
        df['price_reversal_down'] = False  # Reversão de alta para baixa
        
        # Calcular média móvel curta para suavizar o preço e identificar tendência
        df['price_sma_short'] = df['close'].rolling(window=3, min_periods=1).mean()
        
        # Calcular a direção da tendência (positiva = alta, negativa = baixa)
        df['trend_direction'] = df['price_sma_short'].diff(2).apply(lambda x: 1 if x > 0 else (-1 if x < 0 else 0))
        
        # Identificar reversões (mudança de direção)
        for i in range(3, len(df)):
            # Verificar inversão de baixa para alta
            if (df['trend_direction'].iloc[i-2] < 0 and 
                df['trend_direction'].iloc[i-1] <= 0 and 
                df['trend_direction'].iloc[i] > 0):
                df.loc[df.index[i], 'price_reversal_up'] = True
            
            # Verificar inversão de alta para baixa
            if (df['trend_direction'].iloc[i-2] > 0 and 
                df['trend_direction'].iloc[i-1] >= 0 and 
                df['trend_direction'].iloc[i] < 0):
                df.loc[df.index[i], 'price_reversal_down'] = True
        
        return df

    def calculate_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        """
        Calcula os indicadores necessários para a análise DIVAP.
        
        Args:
            df: DataFrame com dados OHLCV
            
        Returns:
            pd.DataFrame: DataFrame com indicadores calculados
        """
        if df.empty:
            logger.error("DataFrame vazio, não é possível calcular indicadores")
            return df
        
        # Calcular RSI 
        df["RSI"] = vbt.indicators.basic.RSI.run(df["close"], window=RSI_PERIODS).rsi
        
        # Calcular média de volume com min_periods=1 para evitar NaN no início.
        df["VolSMA"] = df["volume"].rolling(window=VOLUME_SMA_PERIODS, min_periods=1).mean()
        
        # Identificar candles com volume acima da média 
        df["high_volume"] = df["volume"] > df["VolSMA"]
        
        # Detectar pivôs (topos e fundos) para divergência
        window_pivot = PIVOT_LEFT + 1
        
        # Detectar topos e fundos para divergência
        df["pivot_low"] = df["low"] == df["low"].rolling(window=window_pivot, min_periods=1).min()
        df["pivot_high"] = df["high"] == df["high"].rolling(window=window_pivot, min_periods=1).max()
        
        # Detectar reversões de preço (não usamos mais padrões de velas específicos)
        df = self.detect_price_reversals(df)
        
        # Inicializar séries para armazenar valores de pivôs anteriores
        # Estes armazenarão o último e o penúltimo pivô de cada tipo para cálculo de divergência
        var_pivot_low_price_1 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_price_2 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_rsi_1 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_rsi_2 = pd.Series(float('nan'), index=df.index)
        
        var_pivot_high_price_1 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_price_2 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_rsi_1 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_rsi_2 = pd.Series(float('nan'), index=df.index)
        
        bull_div = pd.Series(False, index=df.index)
        bear_div = pd.Series(False, index=df.index)
        
        # Processamento de pivôs e detecção de divergências 
        last_low_pivot_price = np.nan
        last_low_pivot_rsi = np.nan
        second_last_low_pivot_price = np.nan
        second_last_low_pivot_rsi = np.nan

        last_high_pivot_price = np.nan
        last_high_pivot_rsi = np.nan
        second_last_high_pivot_price = np.nan
        second_last_high_pivot_rsi = np.nan

        for i in range(len(df)):
            # Atualizar pivôs de baixa (lows)
            if df["pivot_low"].iloc[i] and not pd.isna(df["low"].iloc[i]) and not pd.isna(df["RSI"].iloc[i]):
                second_last_low_pivot_price = last_low_pivot_price
                second_last_low_pivot_rsi = last_low_pivot_rsi
                last_low_pivot_price = df["low"].iloc[i]
                last_low_pivot_rsi = df["RSI"].iloc[i]
            
            var_pivot_low_price_1.iloc[i] = last_low_pivot_price
            var_pivot_low_price_2.iloc[i] = second_last_low_pivot_price
            var_pivot_low_rsi_1.iloc[i] = last_low_pivot_rsi
            var_pivot_low_rsi_2.iloc[i] = second_last_low_pivot_rsi

            # Atualizar pivôs de alta (highs)
            if df["pivot_high"].iloc[i] and not pd.isna(df["high"].iloc[i]) and not pd.isna(df["RSI"].iloc[i]):
                second_last_high_pivot_price = last_high_pivot_price
                second_last_high_pivot_rsi = last_high_pivot_rsi
                last_high_pivot_price = df["high"].iloc[i]
                last_high_pivot_rsi = df["RSI"].iloc[i]

            var_pivot_high_price_1.iloc[i] = last_high_pivot_price
            var_pivot_high_price_2.iloc[i] = second_last_high_pivot_price
            var_pivot_high_rsi_1.iloc[i] = last_high_pivot_rsi
            var_pivot_high_rsi_2.iloc[i] = second_last_high_pivot_rsi

            # Verificar divergência de alta (bullish) 
            # Preço faz fundo mais baixo, IFR faz fundo mais alto 
            if (not pd.isna(var_pivot_low_price_1.iloc[i]) and
                not pd.isna(var_pivot_low_price_2.iloc[i]) and
                var_pivot_low_price_1.iloc[i] < var_pivot_low_price_2.iloc[i] and
                var_pivot_low_rsi_1.iloc[i] > var_pivot_low_rsi_2.iloc[i]):
                bull_div.iloc[i] = True
            
            # Verificar divergência de baixa (bearish) 
            # Preço faz topo mais alto, IFR faz topo mais baixo 
            if (not pd.isna(var_pivot_high_price_1.iloc[i]) and
                not pd.isna(var_pivot_high_price_2.iloc[i]) and
                var_pivot_high_price_1.iloc[i] > var_pivot_high_price_2.iloc[i] and
                var_pivot_high_rsi_1.iloc[i] < var_pivot_high_rsi_2.iloc[i]):
                bear_div.iloc[i] = True
        
        # Adicionar divergências ao DataFrame
        df["bull_div"] = bull_div
        df["bear_div"] = bear_div
        
        # Identificar DIVAP completo (todos os critérios juntos)
        # Agora usamos reversão de preço em vez de padrões de velas específicos
        df["bull_divap"] = (df["bull_div"] & df["high_volume"] & df["price_reversal_up"])
        df["bear_divap"] = (df["bear_div"] & df["high_volume"] & df["price_reversal_down"])
        
        return df

    def analyze_signal(self, signal: Dict) -> Dict:
        """
        Analisa um sinal específico para verificar se é um DIVAP.
        
        Args:
            signal: Dicionário contendo os dados do sinal
            
        Returns:
            Dict: Resultado da análise
        """
        symbol = signal["symbol"]
        timeframe = signal.get("timeframe")
        if not timeframe:
            logger.warning(f"Timeframe não encontrado para o sinal #{signal['id']}. Usando timeframe padrão (15m).")
            timeframe = "15m"
        logger.info(f"Analisando sinal #{signal['id']} com timeframe: {timeframe}")
        side = signal["side"]
        created_at = signal["created_at"]
        
        # Definir o formato do símbolo para a Binance
        symbol_formatted = self._format_symbol_for_binance(symbol)
        
        # Definir período para análise (buscando candles antes do sinal)
        td = self._get_timeframe_delta(timeframe)
        if not td:
            logger.error(f"Timeframe inválido: {timeframe}")
            return {"error": f"Timeframe inválido: {timeframe}"}
        
        # Ajustar o 'since_dt' para buscar candles o suficiente para os indicadores e pivôs.
        required_candles = max(RSI_PERIODS, VOLUME_SMA_PERIODS, PIVOT_LEFT) + 5 # Adicione uma margem
        since_dt = created_at - timedelta(minutes=td * required_candles)
        
        # Buscar dados OHLCV
        df = self.fetch_ohlcv_data(symbol_formatted, timeframe, since_dt, limit=200) # Aumentei o limit para garantir dados suficientes
        if df.empty:
            return {"error": f"Não foi possível obter dados para {symbol} no timeframe {timeframe}"}
        
        # Calcular indicadores
        df = self.calculate_indicators(df)
        
        # Calcular o início do candle onde o sinal foi "criado"
        previous_candle_start_time = self._get_previous_candle_time(created_at, timeframe)
        
        try:
            # Encontra o candle que começa exatamente no horário calculado
            if previous_candle_start_time in df.index:
                previous_candle = df.loc[previous_candle_start_time]
            else:
                # Se não encontrar exatamente, procura o candle mais próximo
                closest_idx_time = df.index.asof(previous_candle_start_time)
                if closest_idx_time is None:
                    raise ValueError("Não foi possível encontrar o candle anterior ao sinal.")
                
                previous_candle = df.loc[closest_idx_time]
                
            logger.info(f"Analisando candle que inicia em: {previous_candle.name}")
            
        except Exception as e:
            logger.error(f"Erro ao encontrar o candle de análise: {e}")
            logger.info(f"Horário do sinal: {created_at}, Horário de início do candle anterior: {previous_candle_start_time}")
            logger.info(f"Índices do DataFrame: {df.index.min()} a {df.index.max()}")
            return {"error": f"Não foi possível encontrar o candle anterior ao sinal: {e}"}
        
        # Verificar se é um DIVAP
        is_bull_divap = previous_candle["bull_divap"]
        is_bear_divap = previous_candle["bear_divap"]
        
        # Preparar resultado da análise
        result = {
            "signal_id": signal["id"],
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "created_at": created_at,
            "previous_candle_time": previous_candle.name,
            "is_bull_divap": bool(is_bull_divap),
            "is_bear_divap": bool(is_bear_divap),
            "rsi": float(previous_candle["RSI"]),
            "volume": float(previous_candle["volume"]),
            "volume_sma": float(previous_candle["VolSMA"]),
            "high_volume": bool(previous_candle["high_volume"]),
            "bull_div": bool(previous_candle["bull_div"]),
            "bear_div": bool(previous_candle["bear_div"]),
            "close_price": float(previous_candle["close"]),
            "price_reversal_up": bool(previous_candle["price_reversal_up"]),
            "price_reversal_down": bool(previous_candle["price_reversal_down"])
        }
        
        # Determinar se o sinal é consistente com o DIVAP 
        if side.upper() == "COMPRA" and is_bull_divap:
            result["divap_confirmed"] = True
            result["message"] = "✅ Sinal de COMPRA confirmado como DIVAP altista"
        elif side.upper() == "VENDA" and is_bear_divap:
            result["divap_confirmed"] = True
            result["message"] = "✅ Sinal de VENDA confirmado como DIVAP baixista"
        else:
            result["divap_confirmed"] = False
            if side.upper() == "COMPRA":
                result["message"] = "❌ Sinal de COMPRA NÃO confirmado como DIVAP altista"
            else:
                result["message"] = "❌ Sinal de VENDA NÃO confirmado como DIVAP baixista"
        
        return result

    def _get_timeframe_delta(self, timeframe: str) -> Optional[int]:
        """
        Converte o timeframe para um valor em minutos, aceitando múltiplos formatos.
        
        Args:
            timeframe: String do timeframe em vários formatos possíveis
                      (1m, 5m, 15m, 1h, 1H, 60m, 4h, 4H, 240m, etc.)
                
        Returns:
            int: Número de minutos correspondente ao timeframe ou None se inválido
        """
        if not timeframe:
            return None
            
        # Normalizar o input (remover espaços, converter para minúsculas)
        tf = timeframe.strip().lower()
        
        # Dicionário expandido com múltiplos formatos para cada timeframe
        tf_dict = {
            # Formatos para minutos
            "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, 
            # Formatos para horas (tanto em 'h' quanto equivalente em minutos)
            "1h": 60, "60m": 60, 
            "2h": 120, "120m": 120,
            "4h": 240, "240m": 240, 
            "6h": 360, "360m": 360,
            "8h": 480, "480m": 480,
            "12h": 720, "720m": 720,
            # Formatos para dias
            "1d": 1440, "1440m": 1440, "24h": 1440,
            "3d": 4320, "4320m": 4320, "72h": 4320,
            # Formatos para semanas
            "1w": 10080, "10080m": 10080, "168h": 10080, "7d": 10080
        }
        
        # Verificar no dicionário
        if tf in tf_dict:
            return tf_dict[tf]
        
        # Se não encontrou, tentar analisar o padrão
        import re
        match = re.match(r'(\d+)([mhdw])', tf)
        if match:
            value, unit = match.groups()
            value = int(value)
            
            # Converter para minutos baseado na unidade
            if unit == 'm':
                return value
            elif unit == 'h':
                return value * 60
            elif unit == 'd':
                return value * 1440  # 24h * 60m
            elif unit == 'w':
                return value * 10080  # 7d * 24h * 60m
        
        # Suporte especial para formatos com letras maiúsculas (1H, 4H, etc)
        match = re.match(r'(\d+)([MHDW])', timeframe)
        if match:
            value, unit = match.groups()
            value = int(value)
            
            # Converter para minutos baseado na unidade
            if unit == 'M':
                return value
            elif unit == 'H':
                return value * 60
            elif unit == 'D':
                return value * 1440
            elif unit == 'W':
                return value * 10080
                
        logger.warning(f"Formato de timeframe não reconhecido: {timeframe}")
        return None

    def _format_symbol_for_binance(self, symbol: str) -> str:
        """
        Formata o símbolo para o formato aceito pela Binance.
        
        Args:
            symbol: Símbolo (ex: BTCUSDT)
            
        Returns:
            str: Símbolo formatado (ex: BTC/USDT)
        """
        if '/' in symbol:
            return symbol
        for quote in ["USDT", "BUSD", "USDC", "BTC", "USD"]:
            if symbol.endswith(quote):
                return f"{symbol[:-len(quote)]}/{quote}"
        logger.warning(f"Não foi possível formatar o símbolo: {symbol}")
        return symbol

    def _get_previous_candle_time(self, current_time: datetime, timeframe: str) -> datetime:
        """
        Calcula o horário de início do candle anterior ao sinal.
        
        Args:
            current_time: Horário do sinal
            timeframe: Timeframe do gráfico
            
        Returns:
            datetime: Horário de início do candle anterior
        """
        tf_minutes = self._get_timeframe_delta(timeframe)
        if not tf_minutes:
            logger.error(f"Timeframe inválido: {timeframe}")
            return current_time
        
        # Primeiro, encontre o início do candle atual
        if tf_minutes < 60:  # Menos de uma hora (1m, 3m, 5m, 15m, 30m)
            candle_start_minute = (current_time.minute // tf_minutes) * tf_minutes
            current_candle_start = current_time.replace(minute=candle_start_minute, second=0, microsecond=0)
        elif tf_minutes < 1440:  # Menos de um dia (1h, 2h, 4h, etc)
            hours_tf = tf_minutes // 60
            candle_start_hour = (current_time.hour // hours_tf) * hours_tf
            current_candle_start = current_time.replace(hour=candle_start_hour, minute=0, second=0, microsecond=0)
        else:  # Diário ou maior
            current_candle_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Se o horário do sinal coincide exatamente com o início de um candle,
        # então o candle anterior é o que acabou de se fechar
        previous_candle_start = current_candle_start - timedelta(minutes=tf_minutes)
        
        logger.info(f"Horário do sinal: {current_time}, Candle atual inicia em: {current_candle_start}, Analisando candle anterior que inicia em: {previous_candle_start}")
        return previous_candle_start

    def monitor_new_signals(self, poll_interval: int = 10):
        """
        Monitora continuamente novos sinais no banco de dados.
        
        Args:
            poll_interval: Intervalo em segundos para checar novos sinais
        """
        logger.info(f"Iniciando monitoramento de novos sinais. Intervalo de verificação: {poll_interval} segundos")
        
        last_processed_id = self.get_last_signal_id()
        if last_processed_id:
            logger.info(f"Último sinal processado: ID {last_processed_id}")
        else:
            logger.info("Nenhum sinal anterior encontrado. Monitorando a partir de agora.")
        
        try:
            while True:
                new_signals = self.get_new_signals(last_processed_id)
                
                for signal in new_signals:
                    logger.info(f"Novo sinal detectado: {signal['id']} - {signal['symbol']} - {signal['side']}")
                    result = self.analyze_signal(signal)
                    if signal['id'] > last_processed_id:
                        last_processed_id = signal['id']
                    self.print_analysis_result(result)
                    self.save_analysis_result(result)
                
                time.sleep(poll_interval)
                
        except KeyboardInterrupt:
            logger.info("Monitoramento interrompido pelo usuário")
        except Exception as e:
            logger.error(f"Erro durante o monitoramento: {e}")
            traceback.print_exc()

    def get_last_signal_id(self) -> int:
        """
        Obtém o ID do último sinal na tabela webhook_signals.
        """
        try:
            query = "SELECT MAX(id) as max_id FROM webhook_signals"
            self.cursor.execute(query)
            result = self.cursor.fetchone()
            return result['max_id'] if result and result['max_id'] is not None else 0
        except Exception as e:
            logger.error(f"Erro ao obter último ID: {e}")
            return 0

    def get_new_signals(self, last_id: int) -> List[Dict]:
        """
        Busca sinais novos desde o último ID processado.
        """
        try:
            query = "SELECT * FROM webhook_signals WHERE id > %s ORDER BY id ASC"
            self.cursor.execute(query, (last_id,))
            return self.cursor.fetchall()
        except Exception as e:
            logger.error(f"Erro ao buscar novos sinais: {e}")
            return []

    def save_analysis_result(self, result: Dict) -> None:
        """
        Salva o resultado da análise no banco de dados.
        
        Args:
            result: Resultado da análise
        """
        if "error" in result:
            return # Não salva resultados com erro
            
        self.create_analysis_table_if_not_exists()
        
        try:
            # >>> ALTERAÇÃO 2: Tratar NaN antes de salvar <<<
            # Converte qualquer valor NaN para 0, conforme solicitado.
            rsi_to_save = result.get("rsi")
            volume_to_save = result.get("volume")
            volume_sma_to_save = result.get("volume_sma")

            rsi_to_save = 0 if rsi_to_save is None or pd.isna(rsi_to_save) else rsi_to_save
            volume_to_save = 0 if volume_to_save is None or pd.isna(volume_to_save) else volume_to_save
            volume_sma_to_save = 0 if volume_sma_to_save is None or pd.isna(volume_sma_to_save) else volume_sma_to_save

            sql = """
                INSERT INTO divap_analysis (
                    signal_id, is_bull_divap, is_bear_divap, divap_confirmed, 
                    rsi, volume, volume_sma, high_volume, bull_div, bear_div, 
                    message, price_reversal_up, price_reversal_down, analyzed_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    is_bull_divap = VALUES(is_bull_divap), is_bear_divap = VALUES(is_bear_divap),
                    divap_confirmed = VALUES(divap_confirmed), rsi = VALUES(rsi),
                    volume = VALUES(volume), volume_sma = VALUES(volume_sma),
                    high_volume = VALUES(high_volume), bull_div = VALUES(bull_div),
                    bear_div = VALUES(bear_div), message = VALUES(message),
                    price_reversal_up = VALUES(price_reversal_up), 
                    price_reversal_down = VALUES(price_reversal_down),
                    analyzed_at = VALUES(analyzed_at)
            """
            
            values = (
                result.get("signal_id"),
                result.get("is_bull_divap", False),
                result.get("is_bear_divap", False),
                result.get("divap_confirmed", False),
                rsi_to_save,
                volume_to_save,
                volume_sma_to_save,
                result.get("high_volume", False),
                result.get("bull_div", False),
                result.get("bear_div", False),
                result.get("message", ""),
                result.get("price_reversal_up", False),
                result.get("price_reversal_down", False),
                datetime.now()
            )
            
            self.cursor.execute(sql, values)
            self.conn.commit()
            logger.info(f"Análise do sinal {result.get('signal_id')} salva no banco de dados")
            
        except Exception as e:
            logger.error(f"Erro ao salvar análise: {e}")

    def create_analysis_table_if_not_exists(self) -> None:
        """Cria a tabela para armazenar os resultados de análise caso não exista."""
        try:
            sql = """
                CREATE TABLE IF NOT EXISTS divap_analysis (
                    id INT AUTO_INCREMENT PRIMARY KEY, signal_id INT,
                    is_bull_divap BOOLEAN DEFAULT FALSE, is_bear_divap BOOLEAN DEFAULT FALSE,
                    divap_confirmed BOOLEAN DEFAULT FALSE, rsi FLOAT, volume DOUBLE,
                    volume_sma DOUBLE, high_volume BOOLEAN DEFAULT FALSE,
                    bull_div BOOLEAN DEFAULT FALSE, bear_div BOOLEAN DEFAULT FALSE,
                    message TEXT, price_reversal_up BOOLEAN DEFAULT FALSE, 
                    price_reversal_down BOOLEAN DEFAULT FALSE,
                    analyzed_at DATETIME, UNIQUE KEY (signal_id)
                )
            """
            self.cursor.execute(sql)
            self.conn.commit()
        except Exception as e:
            logger.error(f"Erro ao criar tabela de análise: {e}")

    def print_analysis_result(self, result: Dict) -> None:
        """
        Imprime os resultados da análise de forma formatada.
        
        Args:
            result: Resultado da análise
        """
        if "error" in result:
            print(f"\n{'=' * 60}\n❌ ERRO: {result['error']}\n{'=' * 60}\n")
            return
        
        print(f"\n{'=' * 60}")
        print(f"📊 ANÁLISE DIVAP - SINAL #{result['signal_id']} - {result['symbol']} ({result['timeframe']})")
        print(f"{'=' * 60}")
        print(f"📅 Data/Hora do Sinal: {result['created_at']}")
        
        # >>> ALTERAÇÃO 3: Tratar NaN na exibição dos resultados <<<
        if 'previous_candle_time' in result:
            candle_open_time = result['previous_candle_time']
            tf_minutes = self._get_timeframe_delta(result['timeframe'])
            candle_close_time = candle_open_time + timedelta(minutes=tf_minutes)
            print(f"🕯️  Candle analisado:")
            print(f"    • Abertura: {candle_open_time}")
            print(f"    • Fechamento: {candle_close_time}")
        else:
            print(f"🕯️  Candle analisado (início): {result['previous_candle_time']}")
        
        print(f"📈 Direção: {result['side']}")
        print(f"💹 Preço de fechamento: {result['close_price']:.8f}")
        print(f"{'=' * 60}")
        
        print(f"🔍 INDICADORES:")
        
        rsi_val = result['rsi']
        volume_sma = result['volume_sma']
        
        if pd.isna(rsi_val):
            print(f"  • RSI: Indisponível (dados insuficientes)")
        else:
            print(f"  • RSI: {rsi_val:.2f}")
            
        print(f"  • Volume: {result['volume']:.0f}")

        if pd.isna(volume_sma):
            print(f"  • Média de Volume: Indisponível (dados insuficientes)")
        else:
            print(f"  • Média de Volume: {volume_sma:.0f}")
        
        print(f"\n🔍 RESULTADOS DA CONFLUÊNCIA DIVAP:")
        print(f"  • Volume acima da média: {'✅ SIM' if result['high_volume'] else '❌ NÃO'}")
        print(f"  • Divergência altista: {'✅ SIM' if result['bull_div'] else '❌ NÃO'}")
        print(f"  • Divergência baixista: {'✅ SIM' if result['bear_div'] else '❌ NÃO'}")
        print(f"  • Reversão de preço (baixa para alta): {'✅ SIM' if result['price_reversal_up'] else '❌ NÃO'}")
        print(f"  • Reversão de preço (alta para baixa): {'✅ SIM' if result['price_reversal_down'] else '❌ NÃO'}")

        print(f"\n🏆 CONCLUSÃO FINAL:")
        print(f"  {result['message']}")
        print(f"{'=' * 60}\n")

def interactive_mode():
    """Função para modo interativo do analisador DIVAP"""
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        while True:
            print("\n" + "=" * 60)
            print("🔍 ANALISADOR DIVAP - MODO INTERATIVO")
            print("=" * 60)
            print("1. Analisar sinal por ID")
            print("2. Analisar sinal por data e símbolo")
            print("3. Analisar último sinal")
            print("4. Sair")
            choice = input("\nEscolha uma opção (1-4): ").strip()
            
            if choice == "1":
                try:
                    signal_id = int(input("Digite o ID do sinal: ").strip())
                    signal = analyzer.get_signal_by_id(signal_id)
                    if signal:
                        result = analyzer.analyze_signal(signal)
                        analyzer.print_analysis_result(result)
                        analyzer.save_analysis_result(result)
                except (ValueError, TypeError):
                    print("\n❌ ID inválido. Digite um número inteiro.")
            
            elif choice == "2":
                date_str = input("Digite a data (AAAA-MM-DD): ").strip()
                symbol = input("Digite o símbolo (deixe em branco para todos): ").strip().upper() or None
                try:
                    datetime.strptime(date_str, "%Y-%m-%d")
                    signals = analyzer.get_signals_by_date_symbol(date_str, symbol)
                    if signals:
                        print(f"\n📋 Encontrados {len(signals)} sinais na data {date_str}" + (f" para {symbol}" if symbol else ""))
                        for i, s in enumerate(signals):
                            timeframe = s.get('timeframe', 'N/A')  # Usa 'N/A' se o timeframe não estiver disponível
                            print(f"{i+1}. ID: {s['id']} - {s['symbol']} - {s['side']} - Timeframe: {timeframe} - {s['created_at']}")
                        try:
                            choice_idx = int(input("\nDigite o número do sinal para analisar (ou 0 para voltar): ").strip())
                            if 1 <= choice_idx <= len(signals):
                                result = analyzer.analyze_signal(signals[choice_idx-1])
                                analyzer.print_analysis_result(result)
                                analyzer.save_analysis_result(result)
                        except (ValueError, TypeError):
                            print("\n❌ Digite um número válido.")
                except ValueError:
                    print("\n❌ Formato de data inválido. Use AAAA-MM-DD.")
            
            elif choice == "3":
                signal = analyzer.get_latest_signal()
                if signal:
                    result = analyzer.analyze_signal(signal)
                    analyzer.print_analysis_result(result)
                    analyzer.save_analysis_result(result)
            
            elif choice == "4":
                print("\n👋 Saindo do modo interativo...")
                break
            else:
                print("\n❌ Opção inválida.")
    except Exception as e:
        logger.error(f"ERRO CRÍTICO NO MODO INTERATIVO: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()

def monitoring_mode():
    """Função para modo de monitoramento do analisador DIVAP"""
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        print("\n" + "=" * 60)
        print("📡 ANALISADOR DIVAP - MODO MONITORAMENTO")
        print("Monitorando novos sinais... Pressione Ctrl+C para interromper.")
        print("=" * 60)
        analyzer.monitor_new_signals()
    except Exception as e:
        logger.error(f"ERRO CRÍTICO NO MODO DE MONITORAMENTO: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()

def main():
    print("\n" + "=" * 60)
    print("💎 ANALISADOR DIVAP v1.0")
    print("=" * 60)
    print("Este programa analisa sinais para verificar a confluência")
    print("do padrão DIVAP (Divergência + Volume + Padrão de Reversão)")
    print("=" * 60)
    print("1. Analisar sinais específicos (Modo Interativo)")
    print("2. Iniciar monitoramento em tempo real (Modo Monitoramento)")
    print("=" * 60)
    
    choice = input("\nEscolha uma opção (1-2): ").strip()
    
    if choice == "1":
        interactive_mode()
    elif choice == "2":
        monitoring_mode()
    else:
        print("\n❌ Opção inválida. Saindo...")

if __name__ == "__main__":
    main()