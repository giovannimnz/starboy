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
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s', handlers=[logging.StreamHandler()])
logger = logging.getLogger("DIV_Analyzer")

# Carregar variáveis de ambiente do arquivo .env
env_path = pathlib.Path(__file__).resolve().parents[2] / '.env'
load_dotenv(dotenv_path=env_path)

DB_HOST = os.getenv('DB_HOST')
DB_PORT = os.getenv('DB_PORT')
DB_USER = os.getenv('DB_USER')
DB_PASSWORD = os.getenv('DB_PASSWORD')
DB_NAME = os.getenv('DB_NAME')

DB_CONFIG = {"host": DB_HOST, "user": DB_USER, "password": DB_PASSWORD, "database": DB_NAME}
if DB_PORT:
    try: DB_CONFIG["port"] = int(DB_PORT)
    except (ValueError, TypeError): logger.warning(f"Valor de porta inválido: '{DB_PORT}'.")

API_KEY = os.getenv('API_KEY')
API_SECRET = os.getenv('API_SECRET')
BINANCE_CONFIG = {"apiKey": API_KEY, "secret": API_SECRET, "enableRateLimit": True, 'options': {'defaultType': 'future'}}

RSI_PERIODS = 14
VOLUME_SMA_PERIODS = 20
PIVOT_LEFT = 2

class DIVAnalyzer:
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
            logger.error(f"Erro ao conectar ao banco de dados: {e}"); raise

    def connect_exchange(self) -> None:
        try:
            self.exchange = ccxt.binance(self.binance_config)
            self.exchange.load_markets()
            logger.info("Conexão com a Binance estabelecida com sucesso")
        except Exception as e:
            logger.error(f"Erro ao conectar à Binance: {e}"); raise

    def close_connections(self) -> None:
        if self.cursor: self.cursor.close()
        if self.conn: self.conn.close()
        logger.info("Conexões fechadas")

    def get_signal_by_id(self, signal_id: int) -> Optional[Dict]:
        try:
            query = "SELECT * FROM webhook_signals WHERE id = %s"
            self.cursor.execute(query, (signal_id,))
            signal = self.cursor.fetchone()
            if not signal:
                logger.warning(f"Nenhum sinal encontrado com ID {signal_id}")
            else:
                logger.info(f"Sinal #{signal_id} encontrado: {signal['symbol']} {signal.get('timeframe', 'N/A')} {signal['side']}")
            return signal
        except Exception as e:
            logger.error(f"Erro ao buscar sinal por ID {signal_id}: {e}"); raise

    def get_signals_by_date_symbol(self, date_str: str, symbol: str = None) -> List[Dict]:
        try:
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
            logger.info(f"Encontrados {len(signals)} sinais na data {date_str}" + (f" para {symbol}" if symbol else ""))
            return signals
        except Exception as e:
            logger.error(f"Erro ao buscar sinais por data e símbolo: {e}"); raise

    def get_unanalyzed_signals(self, limit: int = 100) -> List[Dict]:
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
                logger.info("Nenhum sinal não analisado encontrado")
            else:
                logger.info(f"Encontrados {len(signals)} sinais não analisados")
            return signals
        except Exception as e:
            logger.error(f"Erro ao buscar sinais não analisados: {e}"); raise

    def fetch_ohlcv_data(self, symbol: str, timeframe: str, since_dt: datetime, limit: int = 500) -> pd.DataFrame:
        try:
            since_ts = int(since_dt.timestamp() * 1000)
            normalized_timeframe = self._normalize_timeframe(timeframe)
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
            logger.error(f"Erro ao buscar dados OHLCV: {e}"); raise
    
    def calculate_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        if df.empty: return df
        df['RSI'] = vbt.indicators.basic.RSI.run(df["close"], window=RSI_PERIODS).rsi
        df['VolSMA'] = df["volume"].rolling(window=VOLUME_SMA_PERIODS, min_periods=1).mean()
        df['high_volume'] = df["volume"] > df["VolSMA"]
        
        window_pivot = PIVOT_LEFT + 1
        df['pivot_low'] = df["low"] == df["low"].rolling(window=window_pivot, min_periods=1).min()
        df['pivot_high'] = df["high"] == df["high"].rolling(window=window_pivot, min_periods=1).max()
        
        bull_div, bear_div = pd.Series(False, index=df.index), pd.Series(False, index=df.index)
        last_low_price, last_low_rsi, second_last_low_price, second_last_low_rsi = np.nan, np.nan, np.nan, np.nan
        last_high_price, last_high_rsi, second_last_high_price, second_last_high_rsi = np.nan, np.nan, np.nan, np.nan

        for i in range(len(df)):
            if df["pivot_low"].iloc[i]:
                second_last_low_price, second_last_low_rsi = last_low_price, last_low_rsi
                last_low_price, last_low_rsi = df["low"].iloc[i], df["RSI"].iloc[i]
            if df["pivot_high"].iloc[i]:
                second_last_high_price, second_last_high_rsi = last_high_price, last_high_rsi
                last_high_price, last_high_rsi = df["high"].iloc[i], df["RSI"].iloc[i]

            if not pd.isna(last_low_price) and not pd.isna(second_last_low_price):
                if (last_low_price < second_last_low_price and last_low_rsi > second_last_low_rsi):
                    bull_div.iloc[i] = True
            if not pd.isna(last_high_price) and not pd.isna(second_last_high_price):
                if (last_high_price > second_last_high_price and last_high_rsi < second_last_high_rsi):
                    bear_div.iloc[i] = True
        
        df['bull_div'], df['bear_div'] = bull_div, bear_div
        return df

    def analyze_signal(self, signal: Dict) -> Dict:
        symbol, timeframe, side, created_at = signal["symbol"], signal.get("timeframe", "15m"), signal["side"], signal["created_at"]
        symbol_formatted = self._format_symbol_for_binance(symbol)
        td = self._get_timeframe_delta(timeframe)
        if not td: return {"error": f"Timeframe inválido: {timeframe}"}
        
        required_candles = max(RSI_PERIODS, VOLUME_SMA_PERIODS) + PIVOT_LEFT + 60
        since_dt = created_at - timedelta(minutes=td * required_candles)
        
        df = self.fetch_ohlcv_data(symbol_formatted, timeframe, since_dt)
        if df.empty: return {"error": f"Não foi possível obter dados para {symbol}"}
        
        df = self.calculate_indicators(df)
        
        c1_start_time = self._get_previous_candle_time(created_at, timeframe)
        c2_start_time = c1_start_time - timedelta(minutes=td)
        c3_start_time = c2_start_time - timedelta(minutes=td)
        
        candles_to_check_series = []
        for t in [c1_start_time, c2_start_time, c3_start_time]:
            if t in df.index:
                candles_to_check_series.append(df.loc[t])
            else:
                logger.warning(f"Candle de {t} não encontrado nos dados.")
        
        if not candles_to_check_series:
            return {"error": f"Nenhum dos 3 candles anteriores foi encontrado."}

        has_divergence_in_window = False
        has_high_volume_in_window = False

        for candle in candles_to_check_series:
            if (side.upper() == 'COMPRA' and candle.get('bull_div')) or \
               (side.upper() == 'VENDA' and candle.get('bear_div')):
                has_divergence_in_window = True
            if candle.get('high_volume'):
                has_high_volume_in_window = True
        
        div_confirmed = has_divergence_in_window and has_high_volume_in_window
        
        result = {
            "signal_id": signal["id"], "symbol": symbol, "timeframe": timeframe, "side": side,
            "created_at": created_at, "div_confirmed": div_confirmed,
            "has_divergence_in_window": has_divergence_in_window,
            "has_high_volume_in_window": has_high_volume_in_window,
            "c1_details": self._get_candle_details(candles_to_check_series[0]),
            "c2_details": self._get_candle_details(candles_to_check_series[1]) if len(candles_to_check_series) > 1 else None,
            "c3_details": self._get_candle_details(candles_to_check_series[2]) if len(candles_to_check_series) > 2 else None,
        }

        if div_confirmed:
            result["message"] = f"✅ Sinal de {side.upper()} confirmado como DIV na janela de 3 candles"
        else:
            result["message"] = f"❌ Sinal de {side.upper()} NÃO confirmado como DIV na janela de 3 candles"
        
        return result

    def _get_candle_details(self, candle_series: Optional[pd.Series]) -> Optional[Dict]:
        if candle_series is None: return None
        return {
            "time": candle_series.name, "close_price": float(candle_series.get("close", 0)),
            "rsi": float(candle_series.get("RSI", np.nan)), "volume": float(candle_series.get("volume", 0)),
            "volume_sma": float(candle_series.get("VolSMA", np.nan)), "high_volume": bool(candle_series.get("high_volume", False)),
            "bull_div": bool(candle_series.get("bull_div", False)), "bear_div": bool(candle_series.get("bear_div", False))
        }

    def _normalize_timeframe(self, timeframe: str) -> str:
        if not timeframe: return '15m'
        upper_tf = timeframe.upper()
        if upper_tf == '240M': return '4h'
        timeframe_map = {'1M':'1m', '3M':'3m', '5M':'5m', '15M':'15m', '30M':'30m', '1H':'1h', '2H':'2h', '4H':'4h', '6H':'6h', '8H':'8h', '12H':'12h', '1D':'1d', '3D':'3d', '1W':'1w', '1MO':'1M'}
        return timeframe_map.get(upper_tf, timeframe.lower())

    def _get_timeframe_delta(self, timeframe: str) -> Optional[int]:
        if not timeframe: return None
        tf = self._normalize_timeframe(timeframe).lower()
        match = re.match(r'(\d+)([mhdw])', tf)
        if match:
            value, unit = int(match.group(1)), match.group(2)
            return value * {'m': 1, 'h': 60, 'd': 1440, 'w': 10080}.get(unit, 0)
        return None

    def _format_symbol_for_binance(self, symbol: str) -> str:
        if '/' in symbol: return symbol
        for quote in ["USDT", "BUSD", "USDC", "BTC", "USD"]:
            if symbol.endswith(quote): return f"{symbol[:-len(quote)]}/{quote}"
        return symbol

    def _get_previous_candle_time(self, current_time: datetime, timeframe: str) -> datetime:
        tf_minutes = self._get_timeframe_delta(timeframe)
        if not tf_minutes: return current_time
        ts = int(current_time.timestamp())
        previous_ts = (ts // (tf_minutes * 60)) * (tf_minutes * 60) - (tf_minutes * 60)
        previous_dt = datetime.fromtimestamp(previous_ts)
        logger.info(f"Sinal @ {current_time}, analisando candle que iniciou em: {previous_dt}")
        return previous_dt

    def save_analysis_result(self, result: Dict) -> None:
        if "error" in result: return
        self.create_analysis_table_if_not_exists()
        
        try:
            c1_details = result.get("c1_details", {})
            div_confirmed = result.get("div_confirmed", False)
            rsi_val, vol_sma_val = c1_details.get("rsi"), c1_details.get("volume_sma")

            sql_analysis = """
                INSERT INTO divap_analysis (signal_id, div_confirmed, rsi, volume, volume_sma, high_volume, bull_div, bear_div, message, analyzed_at) 
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE div_confirmed=VALUES(div_confirmed), rsi=VALUES(rsi), volume=VALUES(volume), 
                volume_sma=VALUES(volume_sma), high_volume=VALUES(high_volume), bull_div=VALUES(bull_div), 
                bear_div=VALUES(bear_div), message=VALUES(message), analyzed_at=VALUES(analyzed_at)"""
            
            values_analysis = (
                result.get("signal_id"), div_confirmed, (None if pd.isna(rsi_val) else rsi_val), 
                c1_details.get("volume"), (None if pd.isna(vol_sma_val) else vol_sma_val), 
                c1_details.get("high_volume"), c1_details.get("bull_div"), c1_details.get("bear_div"), 
                result.get("message", ""), datetime.now()
            )
            self.cursor.execute(sql_analysis, values_analysis)
            
            error_message = None
            if not div_confirmed:
                reasons = []
                if not result.get("has_divergence_in_window"): reasons.append("Nenhuma divergência na janela")
                if not result.get("has_high_volume_in_window"): reasons.append("Nenhum volume alto na janela")
                error_message = " e ".join(reasons) or "Condições não atendidas"
            
            sql_update = "UPDATE webhook_signals SET divap_confirmado = %s, cancelado_checker = %s, status = %s, error_message = %s WHERE id = %s"
            status = 'CONFIRMED' if div_confirmed else 'CANCELED'
            params_update = (div_confirmed, not div_confirmed, status, error_message, result.get("signal_id"))
            self.cursor.execute(sql_update, params_update)

            self.conn.commit()
            logger.info(f"Análise e status do sinal #{result.get('signal_id')} salvos/atualizados.")
        except Exception as e:
            logger.error(f"Erro ao salvar análise e atualizar sinal: {e}"); self.conn.rollback()

    def create_analysis_table_if_not_exists(self) -> None:
        try:
            sql = """
                CREATE TABLE IF NOT EXISTS divap_analysis (
                    id INT AUTO_INCREMENT PRIMARY KEY, signal_id INT,
                    div_confirmed BOOLEAN, rsi FLOAT, volume DOUBLE, volume_sma DOUBLE, 
                    high_volume BOOLEAN, bull_div BOOLEAN, bear_div BOOLEAN, 
                    message TEXT, analyzed_at DATETIME, UNIQUE KEY (signal_id)
                )"""
            self.cursor.execute(sql)
            self.conn.commit()
        except Exception as e:
            logger.error(f"Erro ao criar tabela de análise: {e}")

    def print_analysis_result(self, result: Dict) -> None:
        if "error" in result:
            print(f"\n{'='*60}\n❌ ERRO: {result['error']}\n{'='*60}\n"); return
        
        print(f"\n{'='*60}\n📊 ANÁLISE DIV (Janela de 3 Candles) - SINAL #{result['signal_id']} - {result['symbol']} ({result['timeframe']})\n{'='*60}")
        print(f"📅 Data/Hora do Sinal: {result['created_at']}")
        
        tf_minutes = self._get_timeframe_delta(result['timeframe'])

        def print_candle_info(candle_data, title):
            if not candle_data: print(f"\n🕯️ {title}: Dados não disponíveis."); return
            open_time = candle_data['time']
            close_time = open_time + timedelta(minutes=tf_minutes if tf_minutes else 0)
            print(f"\n🕯️ {title}:")
            print(f"  • Período: {open_time} a {close_time}")
            rsi, vol_sma = candle_data.get('rsi'), candle_data.get('volume_sma')
            print(f"  • RSI: {'N/A' if pd.isna(rsi) else f'{rsi:.2f}'} | Volume: {candle_data.get('volume', 0):.0f} (Média: {'N/A' if pd.isna(vol_sma) else f'{vol_sma:.0f}'})")
            is_div = candle_data.get('bull_div') if result['side'].upper() == 'COMPRA' else candle_data.get('bear_div')
            print(f"  • CONDIÇÕES: Volume > Média: {'✅' if candle_data.get('high_volume') else '❌'} | Divergência: {'✅' if is_div else '❌'}")

        print_candle_info(result.get("c1_details"), "PRIMEIRO CANDLE ANTERIOR (C1)")
        print_candle_info(result.get("c2_details"), "SEGUNDO CANDLE ANTERIOR (C2)")
        print_candle_info(result.get("c3_details"), "TERCEIRO CANDLE ANTERIOR (C3)")
        
        print(f"\n{'-'*60}\n✅ RESULTADO DA JANELA DE 3 CANDLES:")
        print(f"  • Divergência encontrada na janela: {'✅ SIM' if result.get('has_divergence_in_window') else '❌ NÃO'}")
        print(f"  • Volume alto encontrado na janela: {'✅ SIM' if result.get('has_high_volume_in_window') else '❌ NÃO'}")
        
        print(f"\n🏆 CONCLUSÃO FINAL: {result.get('message', 'N/A')}\n{'='*60}\n")
    
    def monitor_all_signals(self, period_days: int = None, limit: int = 100) -> Dict:
        try:
            if period_days:
                query = "SELECT * FROM webhook_signals WHERE created_at >= DATE_SUB(NOW(), INTERVAL %s DAY) ORDER BY created_at DESC LIMIT %s"
                self.cursor.execute(query, (period_days, limit))
                signals = self.cursor.fetchall()
                period_desc = f"dos últimos {period_days} dias"
            else:
                signals = self.get_unanalyzed_signals(limit=limit)
                period_desc = "não analisados"
            
            if not signals:
                logger.info(f"Nenhum sinal {period_desc} encontrado para monitorar"); return {"total": 0, "success": 0, "error": 0, "confirmed": 0}
            
            stats = {"total": len(signals), "success": 0, "error": 0, "confirmed": 0, "symbols": {}}
            print(f"\n🔍 Monitorando {len(signals)} sinais {period_desc}...")
            
            for i, signal in enumerate(signals):
                symbol = signal['symbol']
                stats["symbols"].setdefault(symbol, {"total": 0, "confirmed": 0})["total"] += 1
                
                print(f"\nProcessando {i+1}/{len(signals)}: #{signal['id']} - {symbol} {signal.get('timeframe', 'N/A')} {signal['side']}")
                
                try:
                    result = self.analyze_signal(signal)
                    if "error" in result:
                        stats["error"] += 1; print(f"❌ Erro: {result['error']}")
                    else:
                        stats["success"] += 1
                        self.save_analysis_result(result)
                        if result.get("div_confirmed", False):
                            stats["confirmed"] += 1; stats["symbols"][symbol]["confirmed"] += 1
                        print(result.get('message', ''))
                except Exception as e:
                    logger.error(f"Erro ao processar sinal #{signal['id']}: {e}"); stats["error"] += 1
            
            confirmed_percent = round(stats['confirmed']/stats['total']*100 if stats['total'] > 0 else 0, 1)
            print(f"\n{'='*60}\n📊 RELATÓRIO DE MONITORAMENTO\n  • Sinais Totais: {stats['total']}\n  • Sucesso: {stats['success']}\n  • Erros: {stats['error']}\n  • Confirmados: {stats['confirmed']} ({confirmed_percent}%)\n")
            if stats["symbols"]:
                print("🏆 TOP SÍMBOLOS COM DIV:")
                sorted_symbols = sorted(stats["symbols"].items(), key=lambda x: x[1]["confirmed"], reverse=True)
                for symbol, data in sorted_symbols[:5]:
                    if data["confirmed"] > 0:
                        symbol_percent = round(data["confirmed"]/data["total"]*100, 1)
                        print(f"  • {symbol}: {data['confirmed']}/{data['total']} ({symbol_percent}%)")
            print("="*60)
            return stats
        except Exception as e:
            logger.error(f"Erro no monitoramento de sinais: {e}"); raise

def interactive_mode():
    analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG)
    try:
        analyzer.connect_db()
        analyzer.connect_exchange()
        while True:
            print("\n" + "="*60 + "\n🔍 ANALISADOR DIV v4.1 (Completo) - MODO INTERATIVO\n" + "="*60)
            print("1. Analisar sinal por ID")
            print("2. Analisar sinais por data")
            print("3. Monitorar sinais em lote")
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
                except (ValueError, TypeError): print("❌ ID inválido.")
            
            elif choice == "2":
                try:
                    date_str = input("Digite a data (DD-MM-AAAA): ").strip()
                    symbol_input = input("Digite o símbolo (ex: ETH ou ETHUSDT, opcional): ").strip()
                    symbol = symbol_input.upper() if symbol_input else None
                    if symbol and not symbol.endswith("USDT"): symbol += "USDT"
                    signals = analyzer.get_signals_by_date_symbol(date_str, symbol)
                    if signals:
                        print(f"\n📋 Sinais encontrados:")
                        for i, s in enumerate(signals): print(f"{i+1}. ID:{s['id']} {s['symbol']} {s.get('timeframe','N/A')} {s['side']}")
                        choice_idx = int(input("\nDigite o número do sinal para analisar (ou 0 para voltar): ").strip())
                        if 1 <= choice_idx <= len(signals):
                            result = analyzer.analyze_signal(signals[choice_idx-1])
                            analyzer.print_analysis_result(result)
                            analyzer.save_analysis_result(result)
                except ValueError: print("❌ Formato de data inválido.")
                except Exception as e: logger.error(f"Erro na opção 2: {e}")

            elif choice == "3":
                print("\n🔍 MONITOR DE SINAIS\n1. Monitorar sinais não analisados\n2. Monitorar sinais dos últimos X dias\n3. Voltar")
                monitor_choice = input("\nEscolha uma opção (1-3): ").strip()
                if monitor_choice == "1":
                    limit = int(input("Número máximo de sinais (padrão 100): ").strip() or 100)
                    analyzer.monitor_all_signals(period_days=None, limit=limit)
                elif monitor_choice == "2":
                    days = int(input("Número de dias para análise (padrão 7): ").strip() or 7)
                    limit = int(input("Número máximo de sinais (padrão 100): ").strip() or 100)
                    analyzer.monitor_all_signals(period_days=days, limit=limit)
            
            elif choice == "4":
                print("\n👋 Saindo..."); break
            else:
                print("❌ Opção inválida.")
    except Exception as e:
        logger.error(f"ERRO CRÍTICO: {e}"); traceback.print_exc()
    finally:
        analyzer.close_connections()

if __name__ == "__main__":
    interactive_mode()