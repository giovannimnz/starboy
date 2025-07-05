#!/usr/bin/env python3
"""
Script de teste para verificar as mudanças no backtest
"""

import sys
import os
from pathlib import Path
from datetime import datetime

# Adicionar o path para importar o módulo
sys.path.append(str(Path(__file__).parent))

try:
    from divap_backtest import BacktestEngine
    print("✅ Módulo divap_backtest importado com sucesso")
    
    # Testar a configuração do DB
    DB_CONFIG = {
        'host': 'atius.com.br',
        'port': 8745,
        'user': 'postgres',
        'password': 'Bkfigt!546',
        'database': 'starboy_dev'
    }
    
    BINANCE_CONFIG = {
        'apiKey': 'test',
        'secret': 'test',
        'sandbox': False,
        'enableRateLimit': True,
    }
    
    # Criar instância do engine
    engine = BacktestEngine(DB_CONFIG, BINANCE_CONFIG)
    print("✅ BacktestEngine instanciado com sucesso")
    
    # Testar conexão com o banco
    try:
        engine.connect_db()
        print("✅ Conexão com banco de dados bem-sucedida")
        
        # Testar método get_signals_for_backtest
        engine.start_date = datetime(2025, 7, 3)
        engine.end_date = datetime(2025, 7, 4)
        
        signals = engine.get_signals_for_backtest()
        print(f"✅ Método get_signals_for_backtest executado: {len(signals)} sinais encontrados")
        
        if signals:
            print("📋 Primeiros sinais encontrados:")
            for i, signal in enumerate(signals[:3]):
                signal_date = signal.get('created_at')
                if isinstance(signal_date, str):
                    signal_datetime = datetime.fromisoformat(signal_date.replace('Z', '+00:00'))
                else:
                    signal_datetime = signal_date
                formatted_date = signal_datetime.strftime('%d-%m-%Y %H:%M:%S')
                print(f"  {i+1}. {signal.get('symbol')} - {formatted_date}")
        
    except Exception as e:
        print(f"❌ Erro na conexão com banco: {e}")
    
    finally:
        engine.close_connections()
        print("✅ Conexões fechadas")
        
except ImportError as e:
    print(f"❌ Erro ao importar módulo: {e}")
except Exception as e:
    print(f"❌ Erro geral: {e}")

print("\n" + "="*50)
print("TESTE CONCLUÍDO")
print("="*50)
