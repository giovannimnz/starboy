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
env_path = pathlib.Path(__file__).parents[1] / '.env'
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
PIVOT_LEFT = 1  # Períodos à esquerda para determinar pivôs
PIVOT_RIGHT = 2  # Períodos à direita para determinar pivôs

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
                SELECT * FROM webhook_signals
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
        
        # Calcular média de volume
        df["VolSMA"] = df["volume"].rolling(window=VOLUME_SMA_PERIODS).mean()
        
        # Identificar candles com volume acima da média
        df["high_volume"] = df["volume"] > df["VolSMA"]
        
        # Detectar pivôs (topos e fundos)
        window = PIVOT_LEFT + PIVOT_RIGHT + 1
        
        # Centro do pivô
        pivot_low_center = df["low"] == df["low"].rolling(window, center=True).min()
        pivot_high_center = df["high"] == df["high"].rolling(window, center=True).max()
        
        # Alinhar pivôs
        df["pivot_low"] = pivot_low_center.shift(PIVOT_RIGHT).fillna(False).astype(bool)
        df["pivot_high"] = pivot_high_center.shift(PIVOT_RIGHT).fillna(False).astype(bool)
        
        # Preço e RSI nos pivôs
        df["pl_price"] = df["low"].where(pivot_low_center).shift(PIVOT_RIGHT)
        df["pl_rsi"] = df["RSI"].where(pivot_low_center).shift(PIVOT_RIGHT)
        df["ph_price"] = df["high"].where(pivot_high_center).shift(PIVOT_RIGHT)
        df["ph_rsi"] = df["RSI"].where(pivot_high_center).shift(PIVOT_RIGHT)
        
        # Detectar divergências
        # Inicializar séries para armazenar valores de pivôs anteriores
        var_pivot_low_price1 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_price2 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_rsi1 = pd.Series(float('nan'), index=df.index)
        var_pivot_low_rsi2 = pd.Series(float('nan'), index=df.index)
        
        var_pivot_high_price1 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_price2 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_rsi1 = pd.Series(float('nan'), index=df.index)
        var_pivot_high_rsi2 = pd.Series(float('nan'), index=df.index)
        
        # Séries para divergências
        bull_div = pd.Series(False, index=df.index)
        bear_div = pd.Series(False, index=df.index)
        
        # Processamento de pivôs e detecção de divergências
        for i in range(len(df)):
            # Para pivôs de baixa (lows)
            if i > 0 and df["pivot_low"].iloc[i]:
                # Mover valores do pivô anterior
                var_pivot_low_price2.iloc[i] = var_pivot_low_price1.iloc[i-1]
                var_pivot_low_rsi2.iloc[i] = var_pivot_low_rsi1.iloc[i-1]
                
                # Atualizar com valores do novo pivô
                var_pivot_low_price1.iloc[i] = df["low"].iloc[i]
                var_pivot_low_rsi1.iloc[i] = df["RSI"].iloc[i]
            else:
                # Manter valores anteriores
                if i > 0:
                    var_pivot_low_price1.iloc[i] = var_pivot_low_price1.iloc[i-1]
                    var_pivot_low_price2.iloc[i] = var_pivot_low_price2.iloc[i-1]
                    var_pivot_low_rsi1.iloc[i] = var_pivot_low_rsi1.iloc[i-1]
                    var_pivot_low_rsi2.iloc[i] = var_pivot_low_rsi2.iloc[i-1]
            
            # Para pivôs de alta (highs)
            if i > 0 and df["pivot_high"].iloc[i]:
                # Mover valores do pivô anterior
                var_pivot_high_price2.iloc[i] = var_pivot_high_price1.iloc[i-1]
                var_pivot_high_rsi2.iloc[i] = var_pivot_high_rsi1.iloc[i-1]
                
                # Atualizar com valores do novo pivô
                var_pivot_high_price1.iloc[i] = df["high"].iloc[i]
                var_pivot_high_rsi1.iloc[i] = df["RSI"].iloc[i]
            else:
                # Manter valores anteriores
                if i > 0:
                    var_pivot_high_price1.iloc[i] = var_pivot_high_price1.iloc[i-1]
                    var_pivot_high_price2.iloc[i] = var_pivot_high_price2.iloc[i-1]
                    var_pivot_high_rsi1.iloc[i] = var_pivot_high_rsi1.iloc[i-1]
                    var_pivot_high_rsi2.iloc[i] = var_pivot_high_rsi2.iloc[i-1]
            
            # Verificar divergência de alta (bullish)
            if (i > 0 and
                df["pivot_low"].iloc[i] and
                not pd.isna(var_pivot_low_price1.iloc[i]) and
                not pd.isna(var_pivot_low_price2.iloc[i]) and
                var_pivot_low_price1.iloc[i] < var_pivot_low_price2.iloc[i] and
                var_pivot_low_rsi1.iloc[i] > var_pivot_low_rsi2.iloc[i]):
                bull_div.iloc[i] = True
            
            # Verificar divergência de baixa (bearish)
            if (i > 0 and
                df["pivot_high"].iloc[i] and
                not pd.isna(var_pivot_high_price1.iloc[i]) and
                not pd.isna(var_pivot_high_price2.iloc[i]) and
                var_pivot_high_price1.iloc[i] > var_pivot_high_price2.iloc[i] and
                var_pivot_high_rsi1.iloc[i] < var_pivot_high_rsi2.iloc[i]):
                bear_div.iloc[i] = True
        
        # Adicionar divergências ao DataFrame
        df["bull_div"] = bull_div
        df["bear_div"] = bear_div
        
        # Identificar DIVAP (Divergência + Volume acima da média)
        df["bull_divap"] = df["bull_div"] & df["high_volume"]
        df["bear_divap"] = df["bear_div"] & df["high_volume"]
        
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
        timeframe = signal.get("timeframe", "15m")  # Default 15m se não especificado
        side = signal["side"]
        created_at = signal["created_at"]
        
        # Definir o formato do símbolo para a Binance
        symbol_formatted = self._format_symbol_for_binance(symbol)
        
        # Definir período para análise (buscando candles antes do sinal)
        td = self._get_timeframe_delta(timeframe)
        if not td:
            logger.error(f"Timeframe inválido: {timeframe}")
            return {"error": f"Timeframe inválido: {timeframe}"}
        
        # Calcular o horário de início para buscar dados (50 candles antes)
        since_dt = created_at - timedelta(minutes=td * 50)
        
        # Buscar dados OHLCV
        df = self.fetch_ohlcv_data(symbol_formatted, timeframe, since_dt, limit=100)
        if df.empty:
            return {"error": f"Não foi possível obter dados para {symbol} no timeframe {timeframe}"}
        
        # Calcular indicadores
        df = self.calculate_indicators(df)
        
        # Encontrar o candle anterior ao sinal
        previous_candle_time = self._get_previous_candle_time(created_at, timeframe)
        
        # Encontrar o índice do candle mais próximo
        closest_idx = self._find_closest_candle(df, previous_candle_time)
        if closest_idx is None:
            return {"error": f"Não foi possível encontrar o candle anterior ao sinal"}
        
        previous_candle = df.iloc[closest_idx]
        
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
            "close_price": float(previous_candle["close"])
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
        Converte o timeframe para um valor em minutos.
        
        Args:
            timeframe: String do timeframe (1m, 5m, 15m, 1h, etc.)
            
        Returns:
            int: Número de minutos correspondente ao timeframe
        """
        tf_dict = {
            "1m": 1,
            "3m": 3,
            "5m": 5,
            "15m": 15,
            "30m": 30,
            "1h": 60,
            "2h": 120,
            "4h": 240,
            "6h": 360,
            "8h": 480,
            "12h": 720,
            "1d": 1440,
            "3d": 4320,
            "1w": 10080
        }
        return tf_dict.get(timeframe.lower())

    def _format_symbol_for_binance(self, symbol: str) -> str:
        """
        Formata o símbolo para o formato aceito pela Binance.
        
        Args:
            symbol: Símbolo (ex: BTCUSDT)
            
        Returns:
            str: Símbolo formatado (ex: BTC/USDT)
        """
        # Se já estiver no formato correto, retorna como está
        if '/' in symbol:
            return symbol
        
        # Caso contrário, tenta formatar
        if "USDT" in symbol:
            return f"{symbol[:-4]}/USDT"
        elif "BTC" in symbol:
            return f"{symbol[:-3]}/BTC"
        else:
            # Tenta identificar outros pares comuns
            for quote in ["BUSD", "USDC", "USD"]:
                if symbol.endswith(quote):
                    return f"{symbol[:-len(quote)]}/{quote}"
        
        # Se não conseguir determinar, retorna o símbolo original
        logger.warning(f"Não foi possível formatar o símbolo: {symbol}")
        return symbol

    def _get_previous_candle_time(self, current_time: datetime, timeframe: str) -> datetime:
        """
        Calcula o horário do candle anterior.
        
        Args:
            current_time: Horário atual
            timeframe: Timeframe em formato string
            
        Returns:
            datetime: Horário do candle anterior
        """
        tf_minutes = self._get_timeframe_delta(timeframe)
        if not tf_minutes:
            return current_time
        
        # Calcular o início do candle atual
        minutes = current_time.minute
        hours = current_time.hour
        days = current_time.day
        
        if tf_minutes < 60:  # Menos de uma hora
            candle_start_minute = (minutes // tf_minutes) * tf_minutes
            current_candle_start = current_time.replace(minute=candle_start_minute, second=0, microsecond=0)
        elif tf_minutes < 1440:  # Menos de um dia
            hours_tf = tf_minutes // 60
            candle_start_hour = (hours // hours_tf) * hours_tf
            current_candle_start = current_time.replace(hour=candle_start_hour, minute=0, second=0, microsecond=0)
        else:  # Diário ou maior
            days_tf = tf_minutes // 1440
            # Implementação simplificada para diário
            current_candle_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # Calcular o início do candle anterior
        previous_candle_start = current_candle_start - timedelta(minutes=tf_minutes)
        
        return previous_candle_start

    def _find_closest_candle(self, df: pd.DataFrame, target_time: datetime) -> Optional[int]:
        """
        Encontra o índice do candle mais próximo do horário alvo.
        
        Args:
            df: DataFrame com dados OHLCV
            target_time: Horário alvo
            
        Returns:
            int: Índice do candle mais próximo
        """
        if df.empty:
            return None
        
        # Converter para timestamp para comparação
        target_ts = pd.Timestamp(target_time)
        
        # Encontrar o candle mais próximo
        closest_idx = (df.index - target_ts).abs().argmin()
        
        return closest_idx

    def monitor_new_signals(self, poll_interval: int = 10):
        """
        Monitora continuamente novos sinais no banco de dados.
        
        Args:
            poll_interval: Intervalo em segundos para checar novos sinais
        """
        logger.info(f"Iniciando monitoramento de novos sinais. Intervalo de verificação: {poll_interval} segundos")
        
        # Armazenar o ID do último sinal processado
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
                    
                    # Analisar o sinal
                    result = self.analyze_signal(signal)
                    
                    # Atualizar o último ID processado
                    if signal['id'] > last_processed_id:
                        last_processed_id = signal['id']
                    
                    # Exibir resultado da análise
                    self.print_analysis_result(result)
                    
                    # Salvar resultado da análise
                    self.save_analysis_result(result)
                
                # Aguardar antes da próxima verificação
                time.sleep(poll_interval)
                
        except KeyboardInterrupt:
            logger.info("Monitoramento interrompido pelo usuário")
        except Exception as e:
            logger.error(f"Erro durante o monitoramento: {e}")
            traceback.print_exc()

    def get_last_signal_id(self) -> int:
        """
        Obtém o ID do último sinal na tabela webhook_signals.
        
        Returns:
            int: ID do último sinal ou 0 se não houver sinais
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
        
        Args:
            last_id: ID do último sinal processado
            
        Returns:
            List[Dict]: Lista de novos sinais
        """
        try:
            query = """
                SELECT * FROM webhook_signals
                WHERE id > %s
                ORDER BY id ASC
            """
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
        # Verificar se já existe uma tabela para os resultados
        self.create_analysis_table_if_not_exists()
        
        try:
            sql = """
                INSERT INTO divap_analysis (
                    signal_id, is_bull_divap, is_bear_divap, 
                    divap_confirmed, rsi, volume, volume_sma,
                    high_volume, bull_div, bear_div, message,
                    analyzed_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
                )
                ON DUPLICATE KEY UPDATE
                    is_bull_divap = VALUES(is_bull_divap),
                    is_bear_divap = VALUES(is_bear_divap),
                    divap_confirmed = VALUES(divap_confirmed),
                    rsi = VALUES(rsi),
                    volume = VALUES(volume),
                    volume_sma = VALUES(volume_sma),
                    high_volume = VALUES(high_volume),
                    bull_div = VALUES(bull_div),
                    bear_div = VALUES(bear_div),
                    message = VALUES(message),
                    analyzed_at = VALUES(analyzed_at)
            """
            
            values = (
                result.get("signal_id"),
                result.get("is_bull_divap", False),
                result.get("is_bear_divap", False),
                result.get("divap_confirmed", False),
                result.get("rsi", 0),
                result.get("volume", 0),
                result.get("volume_sma", 0),
                result.get("high_volume", False),
                result.get("bull_div", False),
                result.get("bear_div", False),
                result.get("message", ""),
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
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    signal_id INT,
                    is_bull_divap BOOLEAN DEFAULT FALSE,
                    is_bear_divap BOOLEAN DEFAULT FALSE,
                    divap_confirmed BOOLEAN DEFAULT FALSE,
                    rsi FLOAT,
                    volume DOUBLE,
                    volume_sma DOUBLE,
                    high_volume BOOLEAN DEFAULT FALSE,
                    bull_div BOOLEAN DEFAULT FALSE,
                    bear_div BOOLEAN DEFAULT FALSE,
                    message TEXT,
                    analyzed_at DATETIME,
                    UNIQUE KEY (signal_id)
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
            print(f"\n{'=' * 60}")
            print(f"❌ ERRO: {result['error']}")
            print(f"{'=' * 60}\n")
            return
        
        # Formatação dos resultados
        print(f"\n{'=' * 60}")
        print(f"📊 ANÁLISE DIVAP - SINAL #{result['signal_id']} - {result['symbol']} ({result['timeframe']})")
        print(f"{'=' * 60}")
        print(f"📅 Data/Hora: {result['created_at']}")
        print(f"🕯️  Candle analisado: {result['previous_candle_time']}")
        print(f"📈 Direção: {result['side']}")
        print(f"💹 Preço de fechamento: {result['close_price']:.8f}")
        print(f"{'=' * 60}")
        
        print(f"🔍 INDICADORES:")
        print(f"  • RSI: {result['rsi']:.2f}")
        print(f"  • Volume: {result['volume']:.0f}")
        print(f"  • Média de Volume: {result['volume_sma']:.0f}")
        
        # Resultados da análise
        print(f"\n🔍 RESULTADOS:")
        
        # Formatar com cores e símbolos para melhor visualização (no terminal)
        if result['high_volume']:
            print(f"  • Volume acima da média: ✅ SIM")
        else:
            print(f"  • Volume acima da média: ❌ NÃO")
            
        if result['bull_div']:
            print(f"  • Divergência altista: ✅ SIM")
        else:
            print(f"  • Divergência altista: ❌ NÃO")
            
        if result['bear_div']:
            print(f"  • Divergência baixista: ✅ SIM")
        else:
            print(f"  • Divergência baixista: ❌ NÃO")
        
        print(f"\n🏆 CONCLUSÃO:")
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
                signal_id = input("Digite o ID do sinal: ").strip()
                try:
                    signal_id = int(signal_id)
                    signal = analyzer.get_signal_by_id(signal_id)
                    if signal:
                        result = analyzer.analyze_signal(signal)
                        analyzer.print_analysis_result(result)
                        analyzer.save_analysis_result(result)
                    else:
                        print(f"\n❌ Sinal com ID {signal_id} não encontrado.")
                except ValueError:
                    print("\n❌ ID inválido. Digite um número inteiro.")
            
            elif choice == "2":
                date_str = input("Digite a data (AAAA-MM-DD): ").strip()
                symbol = input("Digite o símbolo (deixe em branco para todos): ").strip().upper() or None
                
                try:
                    # Validar formato da data
                    datetime.strptime(date_str, "%Y-%m-%d")
                    
                    signals = analyzer.get_signals_by_date_symbol(date_str, symbol)
                    if signals:
                        print(f"\n📋 Encontrados {len(signals)} sinais na data {date_str}" + (f" para {symbol}" if symbol else ""))
                        print("\nLista de sinais:")
                        for i, signal in enumerate(signals):
                            print(f"{i+1}. ID: {signal['id']} - {signal['symbol']} - {signal['side']} - {signal['created_at']}")
                        
                        choice_idx = input("\nDigite o número do sinal para analisar (ou 0 para voltar): ").strip()
                        try:
                            choice_idx = int(choice_idx)
                            if 1 <= choice_idx <= len(signals):
                                signal = signals[choice_idx-1]
                                result = analyzer.analyze_signal(signal)
                                analyzer.print_analysis_result(result)
                                analyzer.save_analysis_result(result)
                            elif choice_idx != 0:
                                print("\n❌ Opção inválida.")
                        except ValueError:
                            print("\n❌ Digite um número válido.")
                    else:
                        print(f"\n❌ Nenhum sinal encontrado na data {date_str}" + (f" para {symbol}" if symbol else ""))
                
                except ValueError:
                    print("\n❌ Formato de data inválido. Use AAAA-MM-DD.")
            
            elif choice == "3":
                signal = analyzer.get_latest_signal()
                if signal:
                    result = analyzer.analyze_signal(signal)
                    analyzer.print_analysis_result(result)
                    analyzer.save_analysis_result(result)
                else:
                    print("\n❌ Nenhum sinal encontrado no banco de dados.")
            
            elif choice == "4":
                print("\n👋 Saindo do modo interativo...")
                break
            
            else:
                print("\n❌ Opção inválida. Por favor, escolha entre 1 e 4.")
    
    except Exception as e:
        print(f"\n❌ ERRO: {e}")
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
        print("🔍 ANALISADOR DIVAP - MODO MONITORAMENTO")
        print("=" * 60)
        print("Monitorando novos sinais em tempo real...")
        print("Pressione Ctrl+C para interromper")
        print("=" * 60)
        
        # Iniciar monitoramento
        analyzer.monitor_new_signals()
    
    except Exception as e:
        print(f"\n❌ ERRO: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()

def main():
    print("\n" + "=" * 60)
    print("🔍 ANALISADOR DIVAP v1.0")
    print("=" * 60)
    print("Este programa analisa sinais de trading para verificar")
    print("se correspondem ao padrão DIVAP (Divergência + Volume Acima da Média)")
    print("=" * 60)
    print("1. Analisar sinais específicos (Modo Interativo)")
    print("2. Iniciar monitoramento em tempo real")
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