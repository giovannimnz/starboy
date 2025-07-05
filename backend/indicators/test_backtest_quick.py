#!/usr/bin/env python3
"""
Script de teste rápido para o backtest
"""

import sys
import os
import logging
from pathlib import Path
from datetime import datetime, timedelta

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("TEST_Backtest")

# Adicionar paths
sys.path.append(str(Path(__file__).parent))
sys.path.append(str(Path(__file__).parent / 'utils'))

try:
    # Importar o BacktestEngine
    from divap_backtest import BacktestEngine, DB_CONFIG, BINANCE_CONFIG
    
    print("✅ Módulos importados com sucesso")
    
    # Criar instância do engine
    engine = BacktestEngine(DB_CONFIG, BINANCE_CONFIG)
    
    try:
        # Conectar ao banco
        engine.connect_db()
        print("✅ Conectado ao banco de dados")
        
        # Testar busca de sinais sem filtro de data
        print("\n🔍 Testando busca de sinais...")
        signals = engine.get_signals_for_backtest()
        
        if signals:
            print(f"✅ Encontrados {len(signals)} sinais")
            
            # Mostrar alguns exemplos
            print("\n📋 Primeiros 5 sinais:")
            for i, signal in enumerate(signals[:5]):
                signal_date = signal.get('created_at')
                if isinstance(signal_date, str):
                    signal_datetime = datetime.fromisoformat(signal_date.replace('Z', '+00:00'))
                else:
                    signal_datetime = signal_date
                formatted_date = signal_datetime.strftime('%d-%m-%Y %H:%M:%S')
                print(f"   {i+1}. {signal.get('symbol')} {signal.get('side')} - {formatted_date} - Canal: {signal.get('chat_id_orig_sinal')}")
            
            # Testar com filtro de data (últimos 7 dias)
            print("\n🔍 Testando com filtro de data (últimos 7 dias)...")
            engine.start_date = datetime.now() - timedelta(days=7)
            engine.end_date = datetime.now()
            
            signals_filtered = engine.get_signals_for_backtest()
            print(f"✅ Encontrados {len(signals_filtered)} sinais dos últimos 7 dias")
            
        else:
            print("❌ Nenhum sinal encontrado")
            
    except Exception as e:
        print(f"❌ Erro no teste: {e}")
        import traceback
        traceback.print_exc()
        
    finally:
        engine.close_connections()
        print("✅ Conexões fechadas")
        
except ImportError as e:
    print(f"❌ Erro ao importar módulos: {e}")
    import traceback
    traceback.print_exc()

print("\n" + "="*50)
print("TESTE CONCLUÍDO")
print("="*50)
