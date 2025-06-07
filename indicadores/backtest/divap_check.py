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
import re

# Configuração de logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("DIVAP_Checker")

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
PIVOT_LEFT = 2  # Períodos à esquerda para determinar pivôs

class DIVAPAnalyzer:
    def __init__(self, db_config: Dict, binance_config: Dict):
        self.db_config = db_config
        self.binance_config = binance_config
        self.exchange = None
        self.conn = None
        self.cursor = None

    def connect_db(self) -> None:
        try:
            self.conn = mysql.connector.connect(**self.db_config)
            self.cursor = self.conn.cursor(dictionary=True)
            #logger.info("Conexão com o banco de dados estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco de dados: {e}")
            raise

    def connect_exchange(self) -> None:
        try:
            self.exchange = ccxt.binanceusdm(self.binance_config)
            self.exchange.load_markets()
            #logger.info("Conexão com a Binance estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar à Binance: {e}")
            raise

    def close_connections(self) -> None:
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")

    def get_signals_by_date_symbol(self, date_str: str, symbol: str = None) -> List[Dict]:
        try:
            # Converte a data de DD-MM-AAAA para AAAA-MM-DD para a consulta SQL
            date_obj = datetime.strptime(date_str, "%d-%m-%Y")
            sql_date_str = date_obj.strftime("%Y-%m-%d")
            
            query = "SELECT * FROM webhook_signals WHERE DATE(created_at) = %s"
            params = [sql_date_str]
            
            if symbol:
                query += " AND symbol = %s"
                params.append(symbol)
                
            query += " ORDER BY created_at DESC"
            
            self.cursor.execute(query, tuple(params))
            signals = self.cursor.fetchall()
            
            if not signals:
                logger.warning(f"\n\nNenhum sinal encontrado na data {date_str}" + (f" para o símbolo {symbol}" if symbol else ""))
            else:
                logger.info(f"Encontrados {len(signals)} sinais na data {date_str}" + (f" para o símbolo {symbol}" if symbol else ""))
            return signals
        except Exception as e:
            logger.error(f"Erro ao buscar sinais por data e símbolo: {e}")
            raise

    def fetch_ohlcv_data(self, symbol: str, timeframe: str, since_dt: datetime, limit: int = 100) -> pd.DataFrame:
        try:
            since_ts = int(since_dt.timestamp() * 1000)
            normalized_timeframe = self._normalize_timeframe(timeframe)
            logger.info(f"Buscando dados OHLCV para {symbol} no timeframe {timeframe} (normalizado para {normalized_timeframe})")
            
            candles = self.exchange.fetch_ohlcv(symbol=symbol, timeframe=normalized_timeframe, since=since_ts, limit=limit)
            
            if not candles:
                logger.warning(f"Nenhum dado OHLCV encontrado para {symbol} no timeframe {timeframe}")
                return pd.DataFrame()
            
            df = pd.DataFrame(candles, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
            df.set_index("timestamp", inplace=True)
            logger.info(f"Dados OHLCV obtidos: {len(df)} candles de {df.index[0]} a {df.index[-1]}")
            return df
        except Exception as e:
            logger.error(f"Erro ao buscar dados OHLCV: {e}")
            raise

    def detect_candlestick_patterns(self, df: pd.DataFrame) -> pd.DataFrame:
        df['body_size'] = abs(df['close'] - df['open'])
        df['upper_shadow'] = df['high'] - df[['open', 'close']].max(axis=1)
        df['lower_shadow'] = df[['open', 'close']].min(axis=1) - df['low']
        df['candle_size'] = df['high'] - df['low']
        
        df['hammer'] = (
            (df['close'] > df['open']) & 
            (df['lower_shadow'] > 2 * df['body_size']) &
            (df['upper_shadow'] < 0.2 * df['body_size']) &
            (df['body_size'] < 0.3 * df['candle_size'])
        )

        df['shooting_star'] = (
            (df['close'] < df['open']) & 
            (df['upper_shadow'] > 2 * abs(df['body_size'])) &
            (df['lower_shadow'] < 0.2 * abs(df['body_size'])) &
            (abs(df['body_size']) < 0.3 * df['candle_size'])
        )
            
        bull_engulfing = pd.Series(False, index=df.index)
        bear_engulfing = pd.Series(False, index=df.index)
        
        for i in range(1, len(df)):
            prev = df.iloc[i-1]
            curr = df.iloc[i]
            if (prev['close'] < prev['open'] and curr['close'] > curr['open'] and
                curr['open'] <= prev['close'] and curr['close'] >= prev['open']):
                bull_engulfing.iloc[i] = True
            
            if (prev['close'] > prev['open'] and curr['close'] < curr['open'] and
                curr['open'] >= prev['close'] and curr['close'] <= prev['open']):
                bear_engulfing.iloc[i] = True
        
        df['bull_engulfing'] = bull_engulfing
        df['bear_engulfing'] = bear_engulfing
        return df

    def calculate_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty:
            return df
        
        df['RSI'] = vbt.indicators.basic.RSI.run(df["close"], window=RSI_PERIODS).rsi
        df['VolSMA'] = df["volume"].rolling(window=VOLUME_SMA_PERIODS, min_periods=1).mean()
        df['high_volume'] = df["volume"] > df["VolSMA"]
        
        window_pivot = PIVOT_LEFT + 1
        df['pivot_low'] = df["low"] == df["low"].rolling(window=window_pivot, min_periods=1).min()
        df['pivot_high'] = df["high"] == df["high"].rolling(window=window_pivot, min_periods=1).max()
        
        df = self.detect_candlestick_patterns(df)
        
        var_pivot_low_price_1 = pd.Series(np.nan, index=df.index)
        var_pivot_low_rsi_1 = pd.Series(np.nan, index=df.index)
        var_pivot_high_price_1 = pd.Series(np.nan, index=df.index)
        var_pivot_high_rsi_1 = pd.Series(np.nan, index=df.index)

        bull_div = pd.Series(False, index=df.index)
        bear_div = pd.Series(False, index=df.index)
        
        last_low_pivot_price, last_low_pivot_rsi = np.nan, np.nan
        second_last_low_pivot_price, second_last_low_pivot_rsi = np.nan, np.nan
        last_high_pivot_price, last_high_pivot_rsi = np.nan, np.nan
        second_last_high_pivot_price, second_last_high_pivot_rsi = np.nan, np.nan

        for i in range(len(df)):
            if df["pivot_low"].iloc[i]:
                second_last_low_pivot_price, second_last_low_pivot_rsi = last_low_pivot_price, last_low_pivot_rsi
                last_low_pivot_price, last_low_pivot_rsi = df["low"].iloc[i], df["RSI"].iloc[i]
            
            if df["pivot_high"].iloc[i]:
                second_last_high_pivot_price, second_last_high_pivot_rsi = last_high_pivot_price, last_high_pivot_rsi
                last_high_pivot_price, last_high_pivot_rsi = df["high"].iloc[i], df["RSI"].iloc[i]

            if not pd.isna(last_low_pivot_price) and not pd.isna(second_last_low_pivot_price):
                if (last_low_pivot_price < second_last_low_pivot_price and 
                    last_low_pivot_rsi > second_last_low_pivot_rsi):
                    bull_div.iloc[i] = True

            if not pd.isna(last_high_pivot_price) and not pd.isna(second_last_high_pivot_price):
                if (last_high_pivot_price > second_last_high_pivot_price and 
                    last_high_pivot_rsi < second_last_high_pivot_rsi):
                    bear_div.iloc[i] = True
        
        df['bull_div'] = bull_div
        df['bear_div'] = bear_div
        
        df['bull_reversal_pattern'] = df["hammer"] | df["bull_engulfing"]
        df['bear_reversal_pattern'] = df["shooting_star"] | df["bear_engulfing"]
        
        df['bull_divap'] = df["bull_div"] & df["high_volume"]
        df['bear_divap'] = df["bear_div"] & df["high_volume"]
        
        return df

    def analyze_signal(self, signal: Dict) -> Dict:
        symbol = signal["symbol"]
        
        # Garantir que timeframe seja válido mesmo quando NULL ou vazio
        timeframe = signal.get("timeframe")
        if not timeframe or timeframe.strip() == "":
            timeframe = "15m"  # Valor padrão quando vazio ou NULL
            logger.warning(f"Sinal #{signal['id']} - {symbol} com timeframe vazio, usando padrão: {timeframe}")
    
        side = signal["side"]
        created_at = signal["created_at"]
        
        symbol_formatted = self._format_symbol_for_binance(symbol)
        tf_minutes = self._get_timeframe_delta(timeframe)
        if not tf_minutes:
            return {"error": f"Timeframe inválido: {timeframe}"}

        required_candles = max(RSI_PERIODS, VOLUME_SMA_PERIODS) + PIVOT_LEFT + 30
        since_dt = created_at - timedelta(minutes=tf_minutes * required_candles)
        
        df = self.fetch_ohlcv_data(symbol_formatted, timeframe, since_dt, limit=500)
        if df.empty:
            return {"error": f"Não foi possível obter dados para {symbol}"}
        
        df = self.calculate_indicators(df)

        # Captura até 3 candles anteriores (n-1, n-2, n-3)
        candle_times = []
        candle_times.append(self._get_previous_candle_time(created_at, timeframe))  # Candle n-1
        candle_times.append(candle_times[-1] - timedelta(minutes=tf_minutes))       # Candle n-2
        candle_times.append(candle_times[-1] - timedelta(minutes=tf_minutes))       # Candle n-3

        # Se existirem no DataFrame, vamos armazená-los
        candles_data = []
        for ct in candle_times:
            candles_data.append(df.loc[ct] if ct in df.index else None)

        # Verifica se pelo menos um dos 3 candles teve Volume > Média
        high_volume_any = any(c is not None and c.get("high_volume", False) for c in candles_data)

        # Verifica se houve divergência de acordo com o lado da operação em algum dos 3 candles
        if side.upper() == "COMPRA":
            bull_div_any = any(c is not None and c.get("bull_div", False) for c in candles_data)
            is_bull_divap = high_volume_any and bull_div_any
            is_bear_divap = False
        else:
            bear_div_any = any(c is not None and c.get("bear_div", False) for c in candles_data)
            is_bear_divap = high_volume_any and bear_div_any
            is_bull_divap = False

        # Monta o dicionário de resultado
        result = {
            "signal_id": signal["id"],
            "symbol": symbol,
            "timeframe": timeframe,
            "side": side,
            "created_at": created_at,
            "candles_used": [t for t in candle_times],
            "is_bull_divap": is_bull_divap,
            "is_bear_divap": is_bear_divap,
        }

        # Se for COMPRA, valida is_bull_divap, senão, is_bear_divap
        if (side.upper() == "COMPRA" and is_bull_divap) or (side.upper() == "VENDA" and is_bear_divap):
            result["divap_confirmed"] = True
            result["message"] = f"✅ Sinal de {side.upper()} confirmado (condições de volume e divergência em até 3 candles)."
        else:
            result["divap_confirmed"] = False
            result["message"] = f"❌ Sinal de {side.upper()} NÃO confirmado (não houve volume e divergência simultâneos em até 3 candles)."
        
        # Adicionar informações para compatibilidade com print_analysis_result
        result["high_volume_any"] = high_volume_any
        result["bull_div_any"] = bull_div_any if side.upper() == "COMPRA" else False
        result["bear_div_any"] = bear_div_any if side.upper() == "VENDA" else False
        
        return result

    def _get_timeframe_delta(self, timeframe: str) -> Optional[int]:
        if not timeframe: return None
        tf = timeframe.strip().lower()
        match = re.match(r'(\d+)([mhdw])', tf)
        if match:
            value, unit = int(match.group(1)), match.group(2)
            multipliers = {'m': 1, 'h': 60, 'd': 1440, 'w': 10080}
            return value * multipliers[unit]
        logger.warning(f"Formato de timeframe não reconhecido: {timeframe}")
        return None

    def _format_symbol_for_binance(self, symbol: str) -> str:
        if '/' in symbol: return symbol
        for quote in ["USDT", "BUSD", "USDC", "BTC", "USD"]:
            if symbol.endswith(quote):
                return f"{symbol[:-len(quote)]}/{quote}"
        return symbol

    def _get_previous_candle_time(self, current_time: datetime, timeframe: str) -> datetime:
        tf_minutes = self._get_timeframe_delta(timeframe)
        if not tf_minutes: return current_time
    
        # Calcula o início do candle atual
        current_candle_start = current_time
        if tf_minutes < 60:
            candle_start_minute = (current_time.minute // tf_minutes) * tf_minutes
            current_candle_start = current_time.replace(minute=candle_start_minute, second=0, microsecond=0)
        elif tf_minutes < 1440:
            hours_tf = tf_minutes // 60
            candle_start_hour = (current_time.hour // hours_tf) * hours_tf
            current_candle_start = current_time.replace(hour=candle_start_hour, minute=0, second=0, microsecond=0)
        else:
            current_candle_start = current_time.replace(hour=0, minute=0, second=0, microsecond=0)
        
        # SEMPRE pega o candle anterior ao candle atual
        previous_candle_start = current_candle_start - timedelta(minutes=tf_minutes)
        
        logger.info(f"Horário do sinal: {current_time}, Candle atual inicia em: {current_candle_start}, Analisando candle anterior que inicia em: {previous_candle_start}")
        return previous_candle_start

    def save_analysis_result(self, result: Dict) -> None:
        if "error" in result:
            signal_id = result.get("signal_id")
            error_msg = result.get("error")
            logger.error(f"Erro na análise do sinal #{signal_id}: {error_msg}")
            
            # Atualizar o sinal no banco para indicar problema
            try:
                update_query = """
                    UPDATE webhook_signals 
                    SET divap_confirmado = 0,
                        cancelado_checker = 1,
                        status = 'CANCELED',
                        error_message = %s
                    WHERE id = %s
                """
                self.cursor.execute(update_query, (f"Erro na análise: {error_msg}", signal_id))
                self.conn.commit()
                logger.info(f"Sinal #{signal_id} marcado como cancelado devido a erro na análise")
            except Exception as e:
                logger.error(f"Erro ao atualizar status do sinal com erro: {e}")
            
            return
        
        try:
            rsi_to_save = result.get("rsi")
            volume_sma_to_save = result.get("volume_sma")
            values = (
                result.get("signal_id"), result.get("is_bull_divap", False),
                result.get("is_bear_divap", False), result.get("divap_confirmed", False),
                0 if pd.isna(rsi_to_save) else rsi_to_save,
                result.get("volume", 0),
                0 if pd.isna(volume_sma_to_save) else volume_sma_to_save,
                result.get("high_volume", False), result.get("bull_div", False),
                result.get("bear_div", False), result.get("message", ""),
                result.get("bull_reversal_pattern", False),
                result.get("bear_reversal_pattern", False), datetime.now()
            )

            sql = """
                INSERT INTO divap_analysis (
                    signal_id, is_bull_divap, is_bear_divap, divap_confirmed, 
                    rsi, volume, volume_sma, high_volume, bull_div, bear_div, 
                    message, bull_reversal_pattern, bear_reversal_pattern, analyzed_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    is_bull_divap=VALUES(is_bull_divap), is_bear_divap=VALUES(is_bear_divap),
                    divap_confirmed=VALUES(divap_confirmed), rsi=VALUES(rsi), volume=VALUES(volume), 
                    volume_sma=VALUES(volume_sma), high_volume=VALUES(high_volume), 
                    bull_div=VALUES(bull_div), bear_div=VALUES(bear_div), message=VALUES(message),
                    bull_reversal_pattern=VALUES(bull_reversal_pattern),
                    bear_reversal_pattern=VALUES(bear_reversal_pattern), analyzed_at=VALUES(analyzed_at)
            """
            self.cursor.execute(sql, values)
            self.conn.commit()
            logger.info(f"Análise do sinal {result.get('signal_id')} salva no banco de dados")
        except Exception as e:
            logger.error(f"Erro ao salvar análise: {e}")
        
        try:
            # Atualizar a tabela webhook_signals
            signal_id = result.get("signal_id")
            is_divap_confirmed = result.get("divap_confirmed", False)
            
            # Determinar a mensagem de erro se não for confirmado
            error_message = None
            if not is_divap_confirmed:
                has_volume = result.get("high_volume_any", False)
                has_divergence = False
                
                if result.get("side", "").upper() == "COMPRA":
                    has_divergence = result.get("bull_div_any", False)
                    divergence_type = "altista"
                else:  # VENDA
                    has_divergence = result.get("bear_div_any", False)
                    divergence_type = "baixista"
                
                if not has_volume and not has_divergence:
                    error_message = f"Volume abaixo da média e divergência {divergence_type} não ocorreu"
                elif not has_volume:
                    error_message = "Volume abaixo da média"
                elif not has_divergence:
                    error_message = f"Divergência {divergence_type} não ocorreu"
    
            # Atualizar a tabela webhook_signals
            update_query = """
                UPDATE webhook_signals 
                SET divap_confirmado = %s,
                    cancelado_checker = %s,
                    status = CASE 
                             WHEN %s THEN 'PENDING' 
                             ELSE 'CANCELED' 
                             END
            """
            
            update_params = [is_divap_confirmed, not is_divap_confirmed, is_divap_confirmed]
            
            # Se não for confirmado, também atualizar a mensagem de erro
            if not is_divap_confirmed:
                update_query += ", error_message = %s"
                update_params.append(error_message)
            
            update_query += " WHERE id = %s"
            update_params.append(signal_id)
            
            self.cursor.execute(update_query, tuple(update_params))
            self.conn.commit()
            
            if is_divap_confirmed:
                logger.info(f"Sinal #{signal_id} atualizado: DIVAP confirmado = {is_divap_confirmed}, status = PENDING")
            else:
                logger.info(f"Sinal #{signal_id} atualizado: DIVAP confirmado = {is_divap_confirmed}, status = CANCELED")
        
        except Exception as e:
            logger.error(f"Erro ao atualizar status do sinal: {e}")

    def print_analysis_result(self, result: Dict) -> None:
        if "error" in result:
            print(f"\n{'='*60}\n❌ ERRO: {result['error']}\n{'='*60}\n")
            return
        
        print(f"\n{'='*60}\n📊 ANÁLISE DIVAP - SINAL #{result['signal_id']} - {result['symbol']} ({result['timeframe']})\n{'='*60}")
        print(f"📅 Data/Hora do Sinal: {result['created_at']}")
        
        # Informações sobre os candles analisados
        tf_minutes = self._get_timeframe_delta(result['timeframe'])
        
        # Mostrar os candles analisados (até 3)
        if 'candles_used' in result:
            print(f"\n🕯️ CANDLES ANALISADOS:")
            for i, candle_time in enumerate(result['candles_used']):
                print(f"  • Candle {i+1}: {candle_time} a {candle_time + timedelta(minutes=tf_minutes)}")
        
        # Mostrar volume e divergência encontrados
        print(f"\n🔍 CONDIÇÕES DIVAP:")
        
        # Volume acima da média em algum dos candles?
        print(f"  • Volume > Média: {'✅ SIM' if result.get('high_volume_any', False) else '❌ NÃO'}")
        
        # Divergência encontrada em algum dos candles?
        if result['side'].upper() == "COMPRA":
            print(f"  • Divergência Altista: {'✅ SIM' if result.get('bull_div_any', False) else '❌ NÃO'}")
        else:
            print(f"  • Divergência Baixista: {'✅ SIM' if result.get('bear_div_any', False) else '❌ NÃO'}")
        
        # Conclusão final
        print(f"\n🏆 CONCLUSÃO FINAL: {result.get('message', 'N/A')}")
        status = "✅ CONFIRMADO" if result.get('divap_confirmed', False) else "❌ NÃO CONFIRMADO"
        print(f"📊 Status DIVAP: {status}")
        print(f"{'='*60}\n")

    def _normalize_timeframe(self, timeframe: str) -> str:
        """
        Normaliza o timeframe para o formato aceito pela Binance.
        """
        if not timeframe:
            return timeframe
        
        # Verificação específica para 240m -> 4h
        if timeframe.upper() == '240M':
            return '4h'
        
        # Mapeia os timeframes comuns para o formato da Binance
        timeframe_map = {
            '1M': '1m', '3M': '3m', '5M': '5m', '15M': '15m', '30M': '30m',
            '1H': '1h', '2H': '2h', '4H': '4h', '6H': '6h', '8H': '8h', '12H': '12h',
            '1D': '1d', '3D': '3d', '1W': '1w', '1MO': '1M'
        }
        
        upper_tf = timeframe.upper()
        if upper_tf in timeframe_map:
            return timeframe_map[upper_tf]
        
        # Tenta extrair o número e a unidade para normalizar
        match = re.match(r'(\d+)([MmHhDdWw]O?)', timeframe)
        if match:
            value, unit = match.group(1), match.group(2).upper()
            
            # Conversões especiais de minutos para horas
            if unit == 'M' and int(value) % 60 == 0 and int(value) >= 60:
                hours = int(value) // 60
                return f"{hours}h"
                
            if unit == 'M':
                return f"{value}m"
            elif unit == 'H':
                return f"{value}h"
            elif unit == 'D':
                return f"{value}d"
            elif unit == 'W':
                return f"{value}w"
            elif unit == 'MO':
                return f"{value}M"
        
        return timeframe.lower()  # Retorna em minúsculas como fallback

    def get_signal_by_id(self, signal_id: int) -> Optional[Dict]:
        """
        Busca um sinal específico pelo seu ID.
        
        Args:
            signal_id: O ID do sinal a ser buscado
            
        Returns:
            O sinal encontrado ou None se não existir
        """
        try:
            query = "SELECT * FROM webhook_signals WHERE id = %s"
            self.cursor.execute(query, (signal_id,))
            signal = self.cursor.fetchone()
            
            if not signal:
                logger.warning(f"Nenhum sinal encontrado com ID {signal_id}")
                return None
            
            logger.info(f"Sinal #{signal_id} encontrado: {signal['symbol']} {signal.get('timeframe', 'N/A')} {signal['side']}")
            return signal
        except Exception as e:
            logger.error(f"Erro ao buscar sinal por ID {signal_id}: {e}")
            raise

    def get_unanalyzed_signals(self, limit: int = 100) -> List[Dict]:
        """
        Busca sinais que ainda não foram analisados pelo sistema DIVAP.
        
        Args:
            limit: Número máximo de sinais a retornar
            
        Returns:
            Lista de sinais não analisados
        """
        try:
            query = """
                SELECT ws.* FROM webhook_signals ws
                LEFT JOIN divap_analysis da ON ws.id = da.signal_id
                WHERE da.signal_id IS NULL
                ORDER BY ws.created_at DESC
                LIMIT %s
            """
            self.cursor.execute(query, (limit,))
            signals = self.cursor.fetchall()
            
            if not signals:
                logger.info(f"Nenhum sinal não analisado encontrado")
            else:
                logger.info(f"Encontrados {len(signals)} sinais não analisados")
            return signals
        except Exception as e:
            logger.error(f"Erro ao buscar sinais não analisados: {e}")
            raise

    def monitor_all_signals(self, period_days: int = None, limit: int = 100) -> Dict:
        """
        Monitora e analisa múltiplos sinais, salvando os resultados.
        
        Args:
            period_days: Se fornecido, analisa sinais dos últimos X dias. 
                         Se None, analisa sinais não analisados.
            limit: Número máximo de sinais a processar
            
        Returns:
            Dicionário com estatísticas da análise
        """
        try:
            if period_days:
                # Busca sinais dos últimos X dias
                query = """
                    SELECT * FROM webhook_signals 
                    WHERE created_at >= DATE_SUB(NOW(), INTERVAL %s DAY)
                    ORDER BY created_at DESC
                    LIMIT %s
                """
                self.cursor.execute(query, (period_days, limit))
                signals = self.cursor.fetchall()
                period_desc = f"dos últimos {period_days} dias"
            else:
                signals = self.get_unanalyzed_signals(limit=limit)
                period_desc = "não analisados"
            
            if not signals:
                logger.info(f"Nenhum sinal {period_desc} encontrado para monitorar")
                return {"total": 0, "success": 0, "error": 0, "divap_confirmed": 0}
            
            results = {
                "total": len(signals),
                "success": 0,
                "error": 0,
                "divap_confirmed": 0,
                "symbols": {}
            }
            
            logger.info(f"Monitorando {len(signals)} sinais {period_desc}...")
            
            for i, signal in enumerate(signals):
                symbol = signal['symbol']
                if symbol not in results["symbols"]:
                    results["symbols"][symbol] = {"total": 0, "confirmed": 0}
                results["symbols"][symbol]["total"] += 1
                
                logger.info(f"Processando {i+1}/{len(signals)}: #{signal['id']} - {symbol} {signal.get('timeframe', 'N/A')} {signal['side']}")
                
                try:
                    result = self.analyze_signal(signal)
                    
                    if "error" in result:
                        results["error"] += 1
                        logger.error(f"Erro: {result['error']}")
                    else:
                        results["success"] += 1
                        self.save_analysis_result(result)
                        
                        if result.get("divap_confirmed", False):
                            results["divap_confirmed"] += 1
                            results["symbols"][symbol]["confirmed"] += 1
                            logger.info(f"DIVAP confirmado: {result.get('message', '')}")
                        else:
                            logger.info(f"DIVAP não confirmado: {result.get('message', '')}")
                    
                except Exception as e:
                    logger.error(f"Erro ao processar sinal #{signal['id']}: {e}")
                    results["error"] += 1
            
            return results
        
        except Exception as e:
            logger.error(f"Erro no monitoramento de sinais: {e}")
            raise

    def monitor_signals_realtime(self):
        """
        Monitora a tabela webhook_signals em tempo real.
        Processa apenas sinais com divap_confirmado=NULL e cancelado_checker=NULL,
        realizando análise e salvando o resultado.
        """
        try:
            # Verificar quantos sinais existem no total na tabela
            self.cursor.execute("SELECT COUNT(*) AS total_signals FROM webhook_signals")
            total_signals_row = self.cursor.fetchone()
            total_signals = total_signals_row["total_signals"] or 0
            
            # Verificar quantos sinais pendentes existem
            self.cursor.execute("""
                SELECT COUNT(*) AS total_pending 
                FROM webhook_signals 
                WHERE divap_confirmado IS NULL 
                AND cancelado_checker IS NULL
            """)
            pending_count_row = self.cursor.fetchone()
            total_pending = pending_count_row["total_pending"] or 0
            
            # Obter o ID mais recente no banco para referência
            self.cursor.execute("SELECT MAX(id) AS max_id FROM webhook_signals")
            max_id_row = self.cursor.fetchone()
            max_id = max_id_row["max_id"] or 0
            
            # Próximo ID esperado seria max_id + 1
            next_expected_id = max_id + 1
            
            # Obter o menor ID de sinal não processado (se existir)
            next_id_to_process = None
            if total_pending > 0:
                self.cursor.execute("""
                    SELECT MIN(id) AS min_id 
                    FROM webhook_signals 
                    WHERE divap_confirmado IS NULL 
                    AND cancelado_checker IS NULL
                """)
                row = self.cursor.fetchone()
                next_id_to_process = row["min_id"]
                last_processed_id = next_id_to_process - 1
            else:
                # Se não houver sinais pendentes, o último processado é o máximo atual
                last_processed_id = max_id
            
            if total_pending > 0:
                logger.info(f"Sinais pendentes: {total_pending}")
                logger.info(f"Próximo sinal a ser processado: ID {next_id_to_process}")
            else:
                logger.info(f"Nenhum sinal pendente encontrado")
                #logger.info(f"Todos os {total_signals} sinais existentes já foram processados")
            
            #logger.info(f"Maior ID atual no banco: {max_id}")
            logger.info(f"Aguardando novos sinais (Próximo ID: {next_expected_id})...")

            # Log detalhado da situação atual
            logger.info(f"Monitoramento iniciado...")
            #logger.info(f"Total de sinais na tabela: {total_signals}")
            
            last_check_had_signals = False
            last_status_time = datetime.now()
            
            while True:
                # Verificar conexão a cada iteração
                if not self.conn.is_connected():
                    logger.warning("[ALERTA] Conexão perdida, reconectando...")
                    self.connect_db()
                
                # Buscar apenas sinais não processados (com ambos campos NULL)
                self.cursor.execute("""
                    SELECT * FROM webhook_signals 
                    WHERE divap_confirmado IS NULL 
                    AND cancelado_checker IS NULL
                    ORDER BY id ASC
                """)
                new_signals = self.cursor.fetchall()
                
                # Só mostra mensagens se encontrou sinais
                if new_signals:
                    logger.info(f"Encontrados {len(new_signals)} sinais não processados!")
                    
                    # Processa os sinais
                    for signal in new_signals:
                        logger.info(f"Processando sinal #{signal['id']} - {signal['symbol']} {signal.get('timeframe', 'N/A')} {signal['side']}")
                        result = self.analyze_signal(signal)
                        self.save_analysis_result(result)
                        last_processed_id = signal["id"]
                    
                    last_check_had_signals = True
                    last_status_time = datetime.now()
                    
                    # Após processar todos, verificar quantos ainda estão pendentes
                    self.cursor.execute("""
                        SELECT COUNT(*) AS remaining_pending 
                        FROM webhook_signals 
                        WHERE divap_confirmado IS NULL 
                        AND cancelado_checker IS NULL
                    """)
                    remaining_row = self.cursor.fetchone()
                    remaining = remaining_row["remaining_pending"] or 0
                    
                    if remaining > 0:
                        self.cursor.execute("""
                            SELECT MIN(id) AS next_id 
                            FROM webhook_signals 
                            WHERE divap_confirmado IS NULL 
                            AND cancelado_checker IS NULL
                        """)
                        next_row = self.cursor.fetchone()
                        next_id = next_row["next_id"]
                        logger.info(f"Restam {remaining} sinais pendentes. Próximo ID a ser processado: {next_id}")
                    else:
                        # Atualizar o total de sinais e o próximo esperado
                        self.cursor.execute("SELECT COUNT(*) AS total_signals FROM webhook_signals")
                        current_total_row = self.cursor.fetchone()
                        current_total = current_total_row["total_signals"] or 0
                        
                        self.cursor.execute("SELECT MAX(id) AS current_max FROM webhook_signals")
                        current_max_row = self.cursor.fetchone()
                        current_max = current_max_row["current_max"] or 0
                        
                        next_expected = current_max + 1
                        logger.info(f"Todos os {current_total} sinais foram processados! Aguardando novo sinal (próximo ID esperado: {next_expected})")
            
                # Mostrar mensagem apenas se mudou de estado ou se passou tempo suficiente
                elif last_check_had_signals or (datetime.now() - last_status_time).total_seconds() >= 1800:  # 30 minutos
                    # Verificar se há algum novo sinal pendente
                    self.cursor.execute("""
                        SELECT COUNT(*) AS current_pending 
                        FROM webhook_signals 
                        WHERE divap_confirmado IS NULL 
                        AND cancelado_checker IS NULL
                    """)
                    current_row = self.cursor.fetchone()
                    current_pending = current_row["current_pending"] or 0
                    
                    # Obter total atualizado e próximo ID esperado
                    self.cursor.execute("SELECT COUNT(*) AS total_signals FROM webhook_signals")
                    current_total_row = self.cursor.fetchone()
                    current_total = current_total_row["total_signals"] or 0
                    
                    self.cursor.execute("SELECT MAX(id) AS current_max FROM webhook_signals")
                    current_max_row = self.cursor.fetchone()
                    current_max = current_max_row["current_max"] or 0
                    
                    next_expected = current_max + 1
                    
                    if current_pending > 0:
                        self.cursor.execute("""
                            SELECT MIN(id) AS next_id 
                            FROM webhook_signals 
                            WHERE divap_confirmado IS NULL 
                            AND cancelado_checker IS NULL
                        """)
                        next_row = self.cursor.fetchone()
                        next_id = next_row["next_id"]
                        logger.info(f"Existem {current_pending} sinais pendentes de {current_total} total. Próximo ID a ser processado: {next_id}")
                    else:
                        logger.info(f"Nenhum sinal pendente encontrado. Total de sinais: {current_total}, Último ID: {current_max}")
                        logger.info(f"Aguardando novos sinais (próximo ID esperado: {next_expected})...")
                
                # Importante: pausa entre verificações
                time.sleep(2)
    
        except KeyboardInterrupt:
            logger.info("\nMonitoramento interrompido pelo usuário.")
            return
        except Exception as e:
            logger.error(f"Erro no monitoramento em tempo real: {e}")
            traceback.print_exc()
            
def check_pending_signals():
    """
    Função principal para verificar sinais pendentes.
    Executada quando o script é iniciado diretamente.
    """
    #logger.info("Iniciando serviço de verificação DIVAP para sinais pendentes")
    
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        
        # Inicia o monitoramento em tempo real
        analyzer.monitor_signals_realtime()
    except Exception as e:
        logger.error(f"Erro crítico no serviço de verificação DIVAP: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()
        logger.info("Serviço de verificação DIVAP encerrado")

if __name__ == "__main__":
    check_pending_signals()