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
from pathlib import Path
import pathlib
import re

sys.path.append(str(Path(__file__).parent / '../analysis'))
try:
    from analysis.divap_check import DIVAPAnalyzer, DB_CONFIG, BINANCE_CONFIG
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

def interactive_mode():
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
            print("5. Sair")
            choice = input("\nEscolha uma opção (1-5): ").strip()
            
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
    print("\n" + "="*60 + "\n💎 ANALISADOR DIVAP - BACKTEST\n" + "="*60)
    print("Este programa analisa sinais históricos para a estratégia DIVAP.")
    interactive_mode()

if __name__ == "__main__":
    main()