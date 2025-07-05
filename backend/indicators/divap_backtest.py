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
        sys.path.append(str(Path(__file__).parent / 'utils'))
        from senhas import API_KEY, API_SECRET
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
        "tp_distribution": [0.25, 0.20, 0.25, 0.20, 0.10]  # % de redução por TP
    }
}

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
                fee_str = input("\n💸 Digite a taxa percentual (ex: 0.02 para 0.02%): ").strip()
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
                start_date = input("Data inicial (YYYY-MM-DD): ").strip()
                end_date = input("Data final (YYYY-MM-DD): ").strip()
                try:
                    self.start_date = datetime.strptime(start_date, "%Y-%m-%d")
                    self.end_date = datetime.strptime(end_date, "%Y-%m-%d")
                    print(f"✅ Período: {start_date} até {end_date}")
                    break
                except ValueError:
                    print("❌ Formato de data inválido. Use YYYY-MM-DD")
            elif period_choice == "2":
                self.start_date = None
                self.end_date = None
                print("✅ Analisando desde o início")
                break
            else:
                print("❌ Opção inválida")
    
    def get_signals_for_backtest(self) -> List[Dict]:
        """Obtém sinais para backtest"""
        try:
            query = """
                SELECT ws.*, sa.divap_confirmed, sa.analysis_type
                FROM webhook_signals ws
                LEFT JOIN signals_analysis sa ON ws.id = sa.signal_id
                WHERE 1=1
            """
            
            params = []
            
            if self.start_date:
                query += " AND ws.created_at >= %s"
                params.append(self.start_date)
            
            if self.end_date:
                query += " AND ws.created_at <= %s"
                params.append(self.end_date)
            
            query += " ORDER BY ws.created_at ASC"
            
            self.cursor.execute(query, params)
            signals = self.cursor.fetchall()
            
            logger.info(f"Obtidos {len(signals)} sinais para backtest")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao obter sinais: {e}")
            return []
    
    def analyze_signal_divap(self, signal: Dict) -> Dict:
        """Analisa se o sinal é DIVAP usando DIVAPAnalyzer"""
        try:
            analyzer = DIVAPAnalyzer(self.db_config, self.binance_config)
            analyzer.connect_db()
            analyzer.connect_exchange()
            
            # Analisar o sinal
            result = analyzer.analyze_signal(signal)
            
            # Salvar na tabela signals_analysis com analysis_type='backtest'
            if result and 'signal_id' in result:
                result['analysis_type'] = 'backtest'
                analyzer.save_analysis_result(result)
            
            analyzer.close_connections()
            return result
            
        except Exception as e:
            logger.error(f"Erro na análise DIVAP: {e}")
            return {"error": str(e)}
    
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
    
    def simulate_trade(self, signal: Dict, backtest_signal_id: int) -> Dict:
        """Simula uma operação completa"""
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
            
            # Calcular quantidade baseada no capital
            position_size = self.current_capital * 0.05  # 5% do capital por trade
            
            # Calcular taxa de entrada
            entry_fee = position_size * (self.base_fee / 100)
            
            # Simular entrada
            total_cost = position_size + entry_fee
            
            # Simular saídas nos TPs
            tp_results = []
            remaining_position = position_size
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
            
            # Calcular capital final
            final_capital = self.current_capital + total_profit
            
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
                'strategy': self.strategy['code']
            }
            
            # Adicionar dados dos TPs
            for tp_result in tp_results:
                result_data.update(tp_result)
            
            # Salvar no banco
            result_id = self.save_backtest_result(result_data)
            
            # Atualizar capital atual
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
                    tp5_profit, tp5_fee, created_at, updated_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
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
        
        successful_trades = 0
        failed_trades = 0
        
        for i, signal in enumerate(signals, 1):
            print(f"\n🔍 Processando sinal {i}/{len(signals)}: {signal.get('symbol')}")
            
            # Analisar se é DIVAP
            divap_result = self.analyze_signal_divap(signal)
            
            if "error" in divap_result:
                print(f"❌ Erro na análise: {divap_result['error']}")
                failed_trades += 1
                continue
            
            divap_confirmed = divap_result.get('divap_confirmed', False)
            
            # Salvar sinal de backtest
            backtest_signal_id = self.save_backtest_signal(signal, divap_confirmed, not divap_confirmed)
            
            if divap_confirmed:
                print(f"✅ DIVAP confirmado - Executando trade")
                
                # Simular trade
                trade_result = self.simulate_trade(signal, backtest_signal_id)
                
                if trade_result:
                    pnl = trade_result.get('total_pnl', 0)
                    print(f"💰 PnL: ${pnl:,.2f} | Capital: ${self.current_capital:,.2f}")
                    successful_trades += 1
                else:
                    print("❌ Erro na simulação do trade")
                    failed_trades += 1
            else:
                print(f"❌ DIVAP não confirmado - Trade cancelado")
                failed_trades += 1
        
        # Resultado final
        print("\n" + "="*60)
        print("🎯 RESULTADO DO BACKTEST")
        print("="*60)
        print(f"💰 Capital inicial: ${self.initial_capital:,.2f}")
        print(f"💰 Capital final: ${self.current_capital:,.2f}")
        print(f"📈 PnL total: ${self.current_capital - self.initial_capital:,.2f}")
        print(f"📊 Trades executados: {successful_trades}")
        print(f"❌ Trades cancelados: {failed_trades}")
        print(f"🎯 Taxa de sucesso: {(successful_trades / len(signals) * 100):.1f}%")
        print("="*60)

def interactive_mode():
    """Modo interativo para análise individual"""
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
                print("\n🎯 EXECUTANDO BACKTEST...")
                analyzer.close_connections()
                
                # Executar backtest
                engine = BacktestEngine(DB_CONFIG, BINANCE_CONFIG)
                try:
                    engine.connect_db()
                    engine.connect_exchange()
                    engine.setup_backtest()
                    engine.run_backtest()
                except Exception as e:
                    logger.error(f"Erro no backtest: {e}")
                finally:
                    engine.close_connections()
                
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

def main():
    """Função principal"""
    print("\n" + "="*60)
    print("🎯 SISTEMA DE BACKTEST DIVAP")
    print("="*60)
    print("Este programa permite análise de sinais e execução de backtests")
    print("para a estratégia DIVAP com dados históricos.")
    print("="*60)
    
    interactive_mode()

if __name__ == "__main__":
    main()
