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

sys.path.append(str(Path(__file__).parent))
try:
    from utils.analysis.divap_check import DIVAPAnalyzer, DB_CONFIG, BINANCE_CONFIG
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
AVAILABLE_STRATEGIES = {
    "1": {
        "name": "Reverse Trailling 13",
        "db_name": "reverse_trailling_13",
        "description": "Estratégia com trailing stop loss e 5 take profits",
        "profit_distribution": [0.25, 0.20, 0.25, 0.20, 0.10]  # TP1 a TP5
    }
}

class DIVAPBacktester:
    def __init__(self):
        self.analyzer = DIVAPAnalyzer(DB_CONFIG, BINANCE_CONFIG) if DIVAPAnalyzer else None
        self.initial_capital = 0
        self.current_capital = 0
        self.strategy = None
        self.base_fee_rate = 0.0002  # Taxa padrão 0.02%
        self.start_date = None
        self.end_date = None
        
    def setup_configuration(self):
        """Configura os parâmetros do backtest"""
        print("\n" + "="*60)
        print("🔧 CONFIGURAÇÃO DO BACKTEST DIVAP")
        print("="*60)
        
        # 1. Saldo inicial
        while True:
            try:
                capital_input = input("\n💰 Digite o saldo inicial (ex: 1000): ").strip()
                self.initial_capital = float(capital_input)
                self.current_capital = self.initial_capital
                if self.initial_capital > 0:
                    break
                else:
                    print("❌ O saldo deve ser maior que zero")
            except ValueError:
                print("❌ Digite um valor numérico válido")
        
        # 2. Selecionar estratégia
        print("\n📈 ESTRATÉGIAS DISPONÍVEIS:")
        for key, strategy in AVAILABLE_STRATEGIES.items():
            print(f"   {key}. {strategy['name']}")
            print(f"      {strategy['description']}")
        
        while True:
            strategy_choice = input("\nEscolha uma estratégia (1): ").strip()
            if strategy_choice in AVAILABLE_STRATEGIES:
                self.strategy = AVAILABLE_STRATEGIES[strategy_choice]
                break
            else:
                print("❌ Estratégia inválida")
        
        # 3. Taxa percentual
        while True:
            try:
                fee_input = input(f"\n💸 Taxa percentual (padrão: {self.base_fee_rate*100}%): ").strip()
                if fee_input:
                    self.base_fee_rate = float(fee_input) / 100
                break
            except ValueError:
                print("❌ Digite um valor numérico válido")
        
        # 4. Período de datas
        print("\n📅 PERÍODO DO BACKTEST:")
        print("1. Desde o início (todas as mensagens)")
        print("2. Período específico")
        
        while True:
            period_choice = input("\nEscolha uma opção (1-2): ").strip()
            if period_choice == "1":
                self.start_date = None
                self.end_date = None
                break
            elif period_choice == "2":
                while True:
                    try:
                        start_input = input("Data início (DD-MM-AAAA): ").strip()
                        self.start_date = datetime.strptime(start_input, "%d-%m-%Y")
                        break
                    except ValueError:
                        print("❌ Formato inválido. Use DD-MM-AAAA")
                
                while True:
                    try:
                        end_input = input("Data fim (DD-MM-AAAA): ").strip()
                        self.end_date = datetime.strptime(end_input, "%d-%m-%Y")
                        if self.end_date >= self.start_date:
                            break
                        else:
                            print("❌ Data fim deve ser posterior à data início")
                    except ValueError:
                        print("❌ Formato inválido. Use DD-MM-AAAA")
                break
            else:
                print("❌ Opção inválida")
        
        # Resumo da configuração
        print(f"\n📋 RESUMO DA CONFIGURAÇÃO:")
        print(f"   💰 Saldo inicial: ${self.initial_capital:,.2f}")
        print(f"   📈 Estratégia: {self.strategy['name']}")
        print(f"   💸 Taxa: {self.base_fee_rate*100:.4f}%")
        if self.start_date:
            print(f"   📅 Período: {self.start_date.strftime('%d/%m/%Y')} até {self.end_date.strftime('%d/%m/%Y')}")
        else:
            print(f"   📅 Período: Desde o início")
        
        confirm = input("\n✅ Confirmar configuração? (s/N): ").strip().lower()
        return confirm in ['s', 'sim', 'y', 'yes']
    
    def get_backtest_signals(self):
        """Busca sinais para backtest baseado no período configurado"""
        try:
            if not self.analyzer:
                raise Exception("DIVAPAnalyzer não disponível")
                
            self.analyzer.connect_db()
            
            # Construir query baseado no período
            if self.start_date and self.end_date:
                query = """
                    SELECT * FROM webhook_signals 
                    WHERE created_at >= %s AND created_at <= %s
                    ORDER BY created_at ASC
                """
                params = (self.start_date, self.end_date + timedelta(days=1))
            else:
                query = """
                    SELECT * FROM webhook_signals 
                    ORDER BY created_at ASC
                """
                params = ()
            
            self.analyzer.cursor.execute(query, params)
            signals = self.analyzer.cursor.fetchall()
            
            logger.info(f"Encontrados {len(signals)} sinais para backtest")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao buscar sinais: {e}")
            return []
    
    def analyze_divap_signal(self, signal):
        """Analisa se o sinal é DIVAP confirmado"""
        try:
            if not self.analyzer:
                return False, "Analyzer não disponível"
            
            result = self.analyzer.analyze_signal(signal)
            
            if "error" in result:
                return False, result["error"]
            
            # Salvar análise como 'backtest'
            self.save_backtest_analysis(result, signal)
            
            return result.get("divap_confirmed", False), result.get("message", "")
            
        except Exception as e:
            logger.error(f"Erro na análise DIVAP: {e}")
            return False, str(e)
    
    def save_backtest_analysis(self, analysis_result, signal):
        """Salva análise marcada como backtest"""
        try:
            # Preparar dados para salvar
            values = (
                signal["id"], analysis_result.get("is_bull_divap", False),
                analysis_result.get("is_bear_divap", False), analysis_result.get("divap_confirmed", False),
                analysis_result.get("rsi", 0), analysis_result.get("volume", 0),
                analysis_result.get("volume_sma", 0), analysis_result.get("high_volume", False),
                analysis_result.get("bull_div", False), analysis_result.get("bear_div", False),
                analysis_result.get("message", ""), analysis_result.get("bull_reversal_pattern", False),
                analysis_result.get("bear_reversal_pattern", False), 'backtest', datetime.now()
            )
            
            sql = """
                INSERT INTO signals_analysis (
                    signal_id, is_bull_divap, is_bear_divap, divap_confirmed, 
                    rsi, volume, volume_sma, high_volume, bull_div, bear_div, 
                    message, bull_reversal_pattern, bear_reversal_pattern, analysis_type, analyzed_at
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (signal_id) DO UPDATE SET
                    analysis_type=EXCLUDED.analysis_type, analyzed_at=EXCLUDED.analyzed_at
            """
            
            self.analyzer.cursor.execute(sql, values)
            self.analyzer.conn.commit()
            
        except Exception as e:
            logger.error(f"Erro ao salvar análise backtest: {e}")
    
    def save_backtest_signal(self, signal, signal_datetime=None):
        """Salva sinal na tabela backtest_signals"""
        try:
            values = (
                signal["symbol"], signal["side"], signal.get("leverage", 1),
                signal.get("capital_pct", 100), signal["entry_price"], signal.get("sl_price"),
                signal.get("chat_id"), "BACKTEST", signal.get("timeframe"),
                signal.get("message_id"), signal.get("message_id_orig"), signal.get("chat_id_orig_sinal"),
                signal.get("tp1_price"), signal.get("tp2_price"), signal.get("tp3_price"),
                signal.get("tp4_price"), signal.get("tp5_price"), signal_datetime or signal["created_at"]
            )
            
            sql = """
                INSERT INTO backtest_signals (
                    symbol, side, leverage, capital_pct, entry_price, sl_price,
                    chat_id, status, timeframe, message_id, message_id_orig, chat_id_orig_sinal,
                    tp1_price, tp2_price, tp3_price, tp4_price, tp5_price, signal_datetime
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """
            
            self.analyzer.cursor.execute(sql, values)
            result = self.analyzer.cursor.fetchone()
            self.analyzer.conn.commit()
            
            return result["id"] if result else None
            
        except Exception as e:
            logger.error(f"Erro ao salvar backtest signal: {e}")
            return None
    
    def simulate_trade(self, signal):
        """Simula uma operação de trade com a estratégia configurada"""
        try:
            symbol = signal["symbol"]
            side = signal["side"]
            entry_price = float(signal["entry_price"])
            sl_price = float(signal.get("sl_price", 0))
            timeframe = signal.get("timeframe", "15m")
            
            # Calcular timeout baseado no timeframe
            tf_minutes = self.get_timeframe_minutes(timeframe)
            timeout_minutes = tf_minutes * 3
            
            # Simular dados de mercado usando ccxt
            if not self.analyzer.exchange:
                self.analyzer.connect_exchange()
            
            # Buscar dados históricos
            since_dt = signal["created_at"] - timedelta(hours=24)  # 24h antes do sinal
            end_dt = signal["created_at"] + timedelta(minutes=timeout_minutes + 60)  # Timeout + margem
            
            ohlcv_data = self.get_historical_data(symbol, timeframe, since_dt, end_dt)
            
            if ohlcv_data.empty:
                return None, "Dados de mercado não disponíveis"
            
            # Executar simulação da estratégia
            trade_result = self.execute_strategy_simulation(
                ohlcv_data, signal, entry_price, sl_price, timeout_minutes
            )
            
            if trade_result:
                # Salvar resultado
                self.save_backtest_result(trade_result)
                # Atualizar capital
                self.current_capital = trade_result["final_capital"]
            
            return trade_result, "Simulação concluída"
            
        except Exception as e:
            logger.error(f"Erro na simulação: {e}")
            return None, str(e)
    
    def get_timeframe_minutes(self, timeframe):
        """Converte timeframe para minutos"""
        if not timeframe:
            return 15
        tf = timeframe.lower()
        if 'm' in tf:
            return int(tf.replace('m', ''))
        elif 'h' in tf:
            return int(tf.replace('h', '')) * 60
        elif 'd' in tf:
            return int(tf.replace('d', '')) * 1440
        return 15
    
    def get_historical_data(self, symbol, timeframe, start_dt, end_dt):
        """Busca dados históricos do mercado"""
        try:
            # Normalizar símbolo
            if '/' not in symbol:
                symbol = f"{symbol}/USDT" if not symbol.endswith('USDT') else f"{symbol[:-4]}/USDT"
            
            since_ts = int(start_dt.timestamp() * 1000)
            limit = min(1000, int((end_dt - start_dt).total_seconds() / (self.get_timeframe_minutes(timeframe) * 60)) + 10)
            
            candles = self.analyzer.exchange.fetch_ohlcv(symbol, timeframe, since_ts, limit)
            
            if not candles:
                return pd.DataFrame()
            
            df = pd.DataFrame(candles, columns=["timestamp", "open", "high", "low", "close", "volume"])
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
            df.set_index("timestamp", inplace=True)
            
            return df
            
        except Exception as e:
            logger.error(f"Erro ao buscar dados históricos: {e}")
            return pd.DataFrame()
    
    def execute_strategy_simulation(self, ohlcv_data, signal, entry_price, sl_price, timeout_minutes):
        """Executa simulação da estratégia Reverse Trailing 13"""
        try:
            side = signal["side"].upper()
            symbol = signal["symbol"]
            signal_time = signal["created_at"]
            
            # Calcular posição baseada no capital atual
            position_size = self.current_capital * 0.02  # 2% do capital por trade
            
            # Calcular take profits
            tp_prices = self.calculate_take_profits(entry_price, sl_price, side)
            
            # Inicializar resultado
            result = {
                "symbol": symbol,
                "initial_capital": self.current_capital,
                "final_capital": self.current_capital,
                "total_pnl": 0,
                "entry_price": entry_price,
                "strategy": self.strategy["db_name"],
                "open_datetime": None,
                "close_datetime": None,
                "entry_fee": 0,
                "total_fee": 0,
                "base_fee": self.base_fee_rate,
                "tp1_profit": 0, "tp1_fee": 0,
                "tp2_profit": 0, "tp2_fee": 0,
                "tp3_profit": 0, "tp3_fee": 0,
                "tp4_profit": 0, "tp4_fee": 0,
                "tp5_profit": 0, "tp5_fee": 0,
                "sl_profit": 0, "sl_fee": 0,
                "last_tp": None,
                "third_to_last_tp": None
            }
            
            # Encontrar entrada
            entry_time, entry_executed = self.find_entry_point(
                ohlcv_data, signal_time, entry_price, sl_price, side, timeout_minutes
            )
            
            if not entry_executed:
                result["close_datetime"] = signal_time + timedelta(minutes=timeout_minutes)
                return result  # Trade cancelado
            
            result["open_datetime"] = entry_time
            result["entry_fee"] = position_size * self.base_fee_rate
            result["total_fee"] = result["entry_fee"]
            
            # Simular execução com trailing stop
            exit_result = self.simulate_exit_strategy(
                ohlcv_data, entry_time, entry_price, sl_price, tp_prices, position_size, side
            )
            
            result.update(exit_result)
            result["final_capital"] = self.current_capital + result["total_pnl"]
            
            return result
            
        except Exception as e:
            logger.error(f"Erro na simulação da estratégia: {e}")
            return None
    
    def calculate_take_profits(self, entry_price, sl_price, side):
        """Calcula os 5 take profits baseado na estratégia"""
        if side == "LONG" or side == "COMPRA":
            risk = entry_price - sl_price
            return [
                entry_price + (risk * 1.5),  # TP1
                entry_price + (risk * 2.0),  # TP2
                entry_price + (risk * 3.0),  # TP3
                entry_price + (risk * 4.0),  # TP4
                entry_price + (risk * 5.0),  # TP5
            ]
        else:  # SHORT/VENDA
            risk = sl_price - entry_price
            return [
                entry_price - (risk * 1.5),  # TP1
                entry_price - (risk * 2.0),  # TP2
                entry_price - (risk * 3.0),  # TP3
                entry_price - (risk * 4.0),  # TP4
                entry_price - (risk * 5.0),  # TP5
            ]
    
    def find_entry_point(self, ohlcv_data, signal_time, entry_price, sl_price, side, timeout_minutes):
        """Encontra o ponto de entrada dentro do timeout"""
        try:
            timeout_time = signal_time + timedelta(minutes=timeout_minutes)
            
            for timestamp, row in ohlcv_data.iterrows():
                if timestamp < signal_time:
                    continue
                if timestamp > timeout_time:
                    break
                
                # Verificar se SL foi atingido antes da entrada
                if side in ["LONG", "COMPRA"]:
                    if row["low"] <= sl_price:
                        return None, False  # SL atingido antes da entrada
                    if row["high"] >= entry_price:
                        return timestamp, True  # Entrada executada
                else:  # SHORT/VENDA
                    if row["high"] >= sl_price:
                        return None, False  # SL atingido antes da entrada
                    if row["low"] <= entry_price:
                        return timestamp, True  # Entrada executada
            
            return None, False  # Timeout sem entrada
            
        except Exception as e:
            logger.error(f"Erro ao encontrar entrada: {e}")
            return None, False
    
    def simulate_exit_strategy(self, ohlcv_data, entry_time, entry_price, sl_price, tp_prices, position_size, side):
        """Simula a estratégia de saída com trailing stop"""
        try:
            result = {
                "close_datetime": entry_time,
                "tp1_profit": 0, "tp1_fee": 0,
                "tp2_profit": 0, "tp2_fee": 0,
                "tp3_profit": 0, "tp3_fee": 0,
                "tp4_profit": 0, "tp4_fee": 0,
                "tp5_profit": 0, "tp5_fee": 0,
                "sl_profit": 0, "sl_fee": 0,
                "total_pnl": 0,
                "last_tp": None,
                "third_to_last_tp": None
            }
            
            current_sl = sl_price
            remaining_position = position_size
            distribution = self.strategy["profit_distribution"]
            tps_hit = []
            
            for timestamp, row in ohlcv_data.iterrows():
                if timestamp <= entry_time:
                    continue
                
                result["close_datetime"] = timestamp
                
                # Verificar TPs
                for i, tp_price in enumerate(tp_prices):
                    if i in tps_hit:
                        continue
                    
                    tp_hit = False
                    if side in ["LONG", "COMPRA"]:
                        tp_hit = row["high"] >= tp_price
                    else:
                        tp_hit = row["low"] <= tp_price
                    
                    if tp_hit:
                        tps_hit.append(i)
                        partial_size = remaining_position * distribution[i]
                        remaining_position -= partial_size
                        
                        # Calcular lucro
                        if side in ["LONG", "COMPRA"]:
                            profit = partial_size * (tp_price - entry_price) / entry_price
                        else:
                            profit = partial_size * (entry_price - tp_price) / entry_price
                        
                        fee = partial_size * self.base_fee_rate
                        net_profit = profit - fee
                        
                        result[f"tp{i+1}_profit"] = net_profit
                        result[f"tp{i+1}_fee"] = fee
                        result["total_pnl"] += net_profit
                        result["total_fee"] += fee
                        
                        # Trailing stop logic
                        if i == 0:  # TP1 hit - move SL to entry
                            current_sl = entry_price
                        elif i == 2:  # TP3 hit - move SL to TP1
                            current_sl = tp_prices[0]
                
                # Verificar SL
                sl_hit = False
                if side in ["LONG", "COMPRA"]:
                    sl_hit = row["low"] <= current_sl
                else:
                    sl_hit = row["high"] >= current_sl
                
                if sl_hit and remaining_position > 0:
                    # Calcular lucro/perda do SL
                    if side in ["LONG", "COMPRA"]:
                        profit = remaining_position * (current_sl - entry_price) / entry_price
                    else:
                        profit = remaining_position * (entry_price - current_sl) / entry_price
                    
                    fee = remaining_position * self.base_fee_rate
                    net_profit = profit - fee
                    
                    result["sl_profit"] = net_profit
                    result["sl_fee"] = fee
                    result["total_pnl"] += net_profit
                    result["total_fee"] += fee
                    
                    break
                
                if remaining_position <= 0:
                    break
            
            # Determinar último e penúltimo TP
            if len(tps_hit) >= 2:
                result["last_tp"] = tps_hit[-1] + 1
                result["third_to_last_tp"] = tps_hit[-2] + 1
            elif len(tps_hit) == 1:
                result["last_tp"] = tps_hit[0] + 1
                result["third_to_last_tp"] = 0  # Entry
            else:
                result["last_tp"] = 0  # SL
                result["third_to_last_tp"] = 0  # Entry
            
            return result
            
        except Exception as e:
            logger.error(f"Erro na simulação de saída: {e}")
            return {"total_pnl": 0}
    
    def save_backtest_result(self, result):
        """Salva resultado do backtest na tabela backtest_results"""
        try:
            values = (
                result["symbol"], result["initial_capital"], result["final_capital"],
                result["total_pnl"], int(time.time()), result.get("open_datetime"),
                result.get("close_datetime"), result["base_fee"], result.get("total_profit", result["total_pnl"]),
                result["total_fee"], result["entry_price"], result["entry_fee"],
                result["tp1_profit"], result["tp1_fee"], result["tp2_profit"], result["tp2_fee"],
                result["tp3_profit"], result["tp3_fee"], result["tp4_profit"], result["tp4_fee"],
                result["tp5_profit"], result["tp5_fee"], result["sl_profit"], result["sl_fee"],
                result.get("third_to_last_tp"), result.get("last_tp"), result["strategy"]
            )
            
            sql = """
                INSERT INTO backtest_results (
                    symbol, initial_capital, final_capital, total_pnl, trade_time,
                    open_datetime, close_datetime, base_fee, total_profit, total_fee,
                    entry_price, entry_fee, tp1_profit, tp1_fee, tp2_profit, tp2_fee,
                    tp3_profit, tp3_fee, tp4_profit, tp4_fee, tp5_profit, tp5_fee,
                    sl_profit, sl_fee, third_to_last_tp, last_tp, strategy
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """
            
            self.analyzer.cursor.execute(sql, values)
            self.analyzer.conn.commit()
            
        except Exception as e:
            logger.error(f"Erro ao salvar resultado: {e}")
    
    def run_backtest(self):
        """Executa o backtest completo"""
        try:
            if not self.setup_configuration():
                print("\n❌ Configuração cancelada")
                return
            
            print(f"\n🚀 INICIANDO BACKTEST...")
            
            if not self.analyzer:
                print("❌ DIVAPAnalyzer não disponível")
                return
            
            self.analyzer.connect_db()
            self.analyzer.connect_exchange()
            
            signals = self.get_backtest_signals()
            if not signals:
                print("❌ Nenhum sinal encontrado para o período")
                return
            
            print(f"📊 Processando {len(signals)} sinais...")
            
            total_trades = 0
            successful_trades = 0
            divap_confirmed = 0
            
            for i, signal in enumerate(signals):
                print(f"\n[{i+1}/{len(signals)}] Processando sinal {signal['id']} - {signal['symbol']}")
                
                # Analisar DIVAP
                is_divap, divap_message = self.analyze_divap_signal(signal)
                
                if is_divap:
                    divap_confirmed += 1
                    print(f"   ✅ DIVAP Confirmado: {divap_message}")
                    
                    # Salvar sinal de backtest
                    backtest_signal_id = self.save_backtest_signal(signal)
                    
                    # Simular trade
                    trade_result, trade_message = self.simulate_trade(signal)
                    
                    if trade_result:
                        total_trades += 1
                        if trade_result["total_pnl"] > 0:
                            successful_trades += 1
                        
                        print(f"   💰 PnL: ${trade_result['total_pnl']:.2f} | Capital: ${trade_result['final_capital']:.2f}")
                    else:
                        print(f"   ❌ Erro na simulação: {trade_message}")
                else:
                    print(f"   ❌ DIVAP Rejeitado: {divap_message}")
                
                # Rate limiting
                time.sleep(0.1)
            
            # Relatório final
            self.print_final_report(len(signals), divap_confirmed, total_trades, successful_trades)
            
        except Exception as e:
            logger.error(f"Erro no backtest: {e}")
            traceback.print_exc()
        finally:
            if self.analyzer:
                self.analyzer.close_connections()
    
    def print_final_report(self, total_signals, divap_confirmed, total_trades, successful_trades):
        """Imprime relatório final do backtest"""
        print(f"\n" + "="*60)
        print(f"📊 RELATÓRIO FINAL DO BACKTEST")
        print(f"="*60)
        print(f"💰 Capital inicial: ${self.initial_capital:,.2f}")
        print(f"💰 Capital final: ${self.current_capital:,.2f}")
        print(f"📈 PnL total: ${self.current_capital - self.initial_capital:,.2f}")
        print(f"📈 Retorno: {((self.current_capital / self.initial_capital - 1) * 100):+.2f}%")
        print(f"")
        print(f"📊 Estatísticas:")
        print(f"   📧 Total de sinais: {total_signals}")
        print(f"   ✅ DIVAP confirmados: {divap_confirmed}")
        print(f"   📈 Trades executados: {total_trades}")
        print(f"   🎯 Trades lucrativos: {successful_trades}")
        if total_trades > 0:
            print(f"   📊 Taxa de acerto: {(successful_trades/total_trades*100):.1f}%")
        print(f"="*60)

def interactive_mode():
    """Modo interativo original (mantido para compatibilidade)"""
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
            print("5. 🚀 BACKTEST COMPLETO")
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
                # Novo modo backtest
                backtester = DIVAPBacktester()
                backtester.run_backtest()
            
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

def main():
    print("\n" + "="*60 + "\n💎 ANALISADOR DIVAP - BACKTEST AVANÇADO\n" + "="*60)
    print("Este programa realiza análise e backtest de sinais DIVAP com estratégias avançadas.")
    print("Funcionalidades:")
    print("• Análise DIVAP em tempo real")
    print("• Backtest com estratégias configuráveis")
    print("• Simulação de trailing stop loss")
    print("• Cálculo de fees e P&L realistas")
    interactive_mode()

if __name__ == "__main__":
    main()