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
            logger.info("Conexão com o banco de dados estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco de dados: {e}")
            raise

    def connect_exchange(self) -> None:
        try:
            self.exchange = ccxt.binanceusdm(self.binance_config)
            self.exchange.load_markets()
            logger.info("Conexão com a Binance estabelecida com sucesso")
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
                logger.warning(f"Nenhum sinal encontrado na data {date_str}" + (f" para o símbolo {symbol}" if symbol else ""))
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
        
        df['bull_divap'] = df["bull_div"] & df["high_volume"] & df["bull_reversal_pattern"]
        df['bear_divap'] = df["bear_div"] & df["high_volume"] & df["bear_reversal_pattern"]
        
        return df

    def analyze_signal(self, signal: Dict) -> Dict:
        symbol = signal["symbol"]
        timeframe = signal.get("timeframe", "15m")
        side = signal["side"]
        created_at = signal["created_at"]
        
        symbol_formatted = self._format_symbol_for_binance(symbol)
        td = self._get_timeframe_delta(timeframe)
        if not td:
            return {"error": f"Timeframe inválido: {timeframe}"}
        
        required_candles = max(RSI_PERIODS, VOLUME_SMA_PERIODS) + 3 * (PIVOT_LEFT + 1)
        since_dt = created_at - timedelta(minutes=td * required_candles)
        
        df = self.fetch_ohlcv_data(symbol_formatted, timeframe, since_dt, limit=500)
        if df.empty:
            return {"error": f"Não foi possível obter dados para {symbol}"}
        
        df = self.calculate_indicators(df)
        
        previous_candle_start_time = self._get_previous_candle_time(created_at, timeframe)
        
        try:
            previous_candle = df.loc[previous_candle_start_time]
            logger.info(f"Analisando candle que inicia em: {previous_candle.name}")
        except KeyError:
            return {"error": f"Candle de {previous_candle_start_time} não encontrado nos dados buscados."}

        # --- SEÇÃO DE DIAGNÓSTICO REATORADA ---
        # 1. Filtra o DataFrame para criar um recorte com dados até o candle do sinal.
        #    Usamos .copy() para evitar SettingWithCopyWarning.
        df_until_signal = df.loc[df.index <= previous_candle.name].copy()

        # 2. Coleta informações de diagnóstico a partir do DataFrame JÁ FILTRADO.
        candles_info = {
            "total_candles": len(df_until_signal),
            "first_candle_time": df_until_signal.index[0],
            "last_candle_time": df_until_signal.index[-1],
            "valid_rsi_candles": df_until_signal["RSI"].notna().sum(),
        }

        # 3. Coleta informações sobre os pivôs a partir do DataFrame JÁ FILTRADO.
        high_pivots_df = df_until_signal[df_until_signal["pivot_high"]].sort_index(ascending=False)
        low_pivots_df = df_until_signal[df_until_signal["pivot_low"]].sort_index(ascending=False)
        
        pivot_info = { "last_pivots": {} }
        if side.upper() == 'VENDA' and len(high_pivots_df) >= 2:
            pivot_info["last_pivots"]["last_high_pivot"] = high_pivots_df.iloc[0][['high', 'RSI']].rename({'high': 'price', 'RSI': 'rsi'}).to_dict()
            pivot_info["last_pivots"]["second_last_high_pivot"] = high_pivots_df.iloc[1][['high', 'RSI']].rename({'high': 'price', 'RSI': 'rsi'}).to_dict()
        elif side.upper() == 'COMPRA' and len(low_pivots_df) >= 2:
            pivot_info["last_pivots"]["last_low_pivot"] = low_pivots_df.iloc[0][['low', 'RSI']].rename({'low': 'price', 'RSI': 'rsi'}).to_dict()
            pivot_info["last_pivots"]["second_last_low_pivot"] = low_pivots_df.iloc[1][['low', 'RSI']].rename({'low': 'price', 'RSI': 'rsi'}).to_dict()
        
        # Preparar resultado da análise
        result = {
            "signal_id": signal["id"], "symbol": symbol, "timeframe": timeframe, "side": side,
            "created_at": created_at, "previous_candle_time": previous_candle.name,
            "is_bull_divap": bool(previous_candle["bull_divap"]),
            "is_bear_divap": bool(previous_candle["bear_divap"]),
            "rsi": float(previous_candle["RSI"]), "volume": float(previous_candle["volume"]),
            "volume_sma": float(previous_candle["VolSMA"]),
            "high_volume": bool(previous_candle["high_volume"]),
            "bull_div": bool(previous_candle["bull_div"]), "bear_div": bool(previous_candle["bear_div"]),
            "close_price": float(previous_candle["close"]),
            "bull_reversal_pattern": bool(previous_candle["bull_reversal_pattern"]),
            "bear_reversal_pattern": bool(previous_candle["bear_reversal_pattern"]),
            "candles_info": candles_info, "pivot_info": pivot_info
        }
        
        # Determinar a mensagem final
        if side.upper() == "COMPRA" and result["is_bull_divap"]:
            result["divap_confirmed"] = True
            result["message"] = "✅ Sinal de COMPRA confirmado como DIVAP altista"
        elif side.upper() == "VENDA" and result["is_bear_divap"]:
            result["divap_confirmed"] = True
            result["message"] = "✅ Sinal de VENDA confirmado como DIVAP baixista"
        else:
            result["divap_confirmed"] = False
            result["message"] = f"❌ Sinal de {side.upper()} NÃO confirmado como DIVAP"
        
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
        
        previous_candle_start = current_candle_start
        if current_time > current_candle_start:
             previous_candle_start = current_candle_start
        else: # Se o sinal chegar exatamente no início do candle, pegue o anterior
             previous_candle_start = current_candle_start - timedelta(minutes=tf_minutes)
        
        logger.info(f"Horário do sinal: {current_time}, Analisando candle que inicia em: {previous_candle_start}")
        return previous_candle_start

    def save_analysis_result(self, result: Dict) -> None:
        if "error" in result: return
        
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

    def print_analysis_result(self, result: Dict) -> None:
        if "error" in result:
            print(f"\n{'='*60}\n❌ ERRO: {result['error']}\n{'='*60}\n")
            return
        
        print(f"\n{'='*60}\n📊 ANÁLISE DIVAP - SINAL #{result['signal_id']} - {result['symbol']} ({result['timeframe']})\n{'='*60}")
        print(f"📅 Data/Hora do Sinal: {result['created_at']}")
        
        if 'candles_info' in result:
            print(f"📈 Período dos Dados: {result['candles_info']['first_candle_time']} a {result['candles_info']['last_candle_time']} ({result['candles_info']['total_candles']} candles)")
        
        candle_open_time = result['previous_candle_time']
        tf_minutes = self._get_timeframe_delta(result['timeframe'])
        candle_close_time = candle_open_time + timedelta(minutes=tf_minutes)
        print(f"🕯️  Candle Analisado: {candle_open_time} (Fechou em {candle_close_time})")
        
        print(f"📈 Direção: {result['side']} | 💹 Preço de Fechamento: {result['close_price']:.4f}\n{'-'*60}")
        
        print(f"🔍 INDICADORES DO CANDLE:")
        rsi_val, volume_sma = result.get('rsi'), result.get('volume_sma')
        print(f"  • RSI: {'Indisponível' if pd.isna(rsi_val) else f'{rsi_val:.2f}'}")
        print(f"  • Volume: {result.get('volume', 0):.0f} (Média: {'Indisponível' if pd.isna(volume_sma) else f'{volume_sma:.0f}'})")
        print(f"{'-'*60}")
        
        print("🔍 CONDIÇÕES DIVAP:")
        print(f"  • Volume > Média: {'✅ SIM' if result.get('high_volume') else '❌ NÃO'}")
        
        if result['side'].upper() == "COMPRA":
            print(f"  • Divergência Altista: {'✅ SIM' if result.get('bull_div') else '❌ NÃO'}")
            print(f"  • Padrão de Reversão de Alta: {'✅ SIM' if result.get('bull_reversal_pattern') else '❌ NÃO'}")
        else:
            print(f"  • Divergência Baixista: {'✅ SIM' if result.get('bear_div') else '❌ NÃO'}")
            print(f"  • Padrão de Reversão de Baixa: {'✅ SIM' if result.get('bear_reversal_pattern') else '❌ NÃO'}")
        
        if 'pivot_info' in result and 'last_pivots' in result['pivot_info']:
            pivots = result['pivot_info']['last_pivots']
            if result['side'].upper() == "VENDA" and "last_high_pivot" in pivots:
                last_high, second_high = pivots["last_high_pivot"], pivots["second_last_high_pivot"]
                print(f"  • Detalhe Div.: Topo Recente {second_high['price']:.2f} (RSI {second_high['rsi']:.1f}) -> {last_high['price']:.2f} (RSI {last_high['rsi']:.1f})")
            elif result['side'].upper() == "COMPRA" and "last_low_pivot" in pivots:
                last_low, second_low = pivots["last_low_pivot"], pivots["second_last_low_pivot"]
                
                # Adicionalmente, para maior robustez, você pode modificar a impressão:
                if 'rsi' in second_low and 'rsi' in last_low:
                    print(f"  • Detalhe Div.: Fundo Recente {second_low['price']:.2f} (RSI {second_low['rsi']:.1f}) -> {last_low['price']:.2f} (RSI {last_low['rsi']:.1f})")
                else:
                    print(f"  • Detalhe Div.: Fundo Recente {second_low['price']:.2f} -> {last_low['price']:.2f} (RSI indisponível)")
        
        print(f"\n🏆 CONCLUSÃO FINAL: {result.get('message', 'N/A')}\n{'='*60}\n")

    def _normalize_timeframe(self, timeframe: str) -> str:
        """
        Normaliza o timeframe para o formato aceito pela Binance.
        
        Args:
            timeframe: O timeframe a ser normalizado (ex: 1D, 4H, etc.)
            
        Returns:
            O timeframe normalizado (ex: 1d, 4h, etc.)
        """
        if not timeframe:
            return timeframe
            
        # Mapeia os timeframes comuns para o formato da Binance
        timeframe_map = {
            '1M': '1m', '3M': '3m', '5M': '5m', '15M': '15m', '30M': '30m',
            '1H': '1h', '2H': '2h', '4H': '4h', '6H': '6h', '8H': '8h', '12H': '12h',
            '1D': '1d', '3D': '3d', '1W': '1w', '1MO': '1M'  # Note que mês é 'M' maiúsculo
        }
        
        upper_tf = timeframe.upper()
        if upper_tf in timeframe_map:
            return timeframe_map[upper_tf]
        
        # Tenta extrair o número e a unidade para normalizar
        match = re.match(r'(\d+)([MHDW]O?)', upper_tf)
        if match:
            value, unit = match.group(1), match.group(2)
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

def interactive_mode():
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        while True:
            print("\n" + "="*60 + "\n🔍 ANALISADOR DIVAP - MODO INTERATIVO\n" + "="*60)
            print("1. Analisar sinal por ID")
            print("2. Analisar sinal por data e símbolo")
            print("3. Sair")
            choice = input("\nEscolha uma opção (1-3): ").strip()
            
            if choice == "1":
                try:
                    signal_id = int(input("Digite o ID do sinal: ").strip())
                    # Esta funcionalidade precisaria da função get_signal_by_id, que não está no escopo atual.
                    print("Funcionalidade de busca por ID a ser implementada.")
                except (ValueError, TypeError):
                    print("\n❌ ID inválido. Digite um número inteiro.")
            
            elif choice == "2":
                date_str = input("Digite a data (DD-MM-AAAA): ").strip()
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
                            print(f"{i+1}. ID: {s['id']} - {s['symbol']} {tf} {s['side']} @ {s['created_at']}")
                        
                        try:
                            choice_idx = int(input("\nDigite o número do sinal para analisar (ou 0 para voltar): ").strip())
                            if 1 <= choice_idx <= len(signals):
                                result = analyzer.analyze_signal(signals[choice_idx-1])
                                analyzer.print_analysis_result(result)
                                analyzer.save_analysis_result(result)
                        except (ValueError, TypeError):
                            print("\n❌ Digite um número válido.")
                except ValueError:
                    print("\n❌ Formato de data inválido. Use DD-MM-AAAA.")
            
            elif choice == "3":
                print("\n👋 Saindo...")
                break
            else:
                print("\n❌ Opção inválida.")
    except Exception as e:
        logger.error(f"ERRO CRÍTICO NO MODO INTERATIVO: {e}")
        traceback.print_exc()
    finally:
        analyzer.close_connections()

def main():
    print("\n" + "="*60 + "\n💎 ANALISADOR DIVAP v2.0\n" + "="*60)
    print("Este programa analisa sinais para a estratégia DIVAP.")
    interactive_mode()

if __name__ == "__main__":
    main()