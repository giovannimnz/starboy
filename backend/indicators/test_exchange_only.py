#!/usr/bin/env python3
"""
Script para testar apenas o exchange_info_updater com timeout
"""

import signal
import sys
import pathlib
from dotenv import load_dotenv
import os

# Timeout handler
def timeout_handler(signum, frame):
    print("\n❌ TIMEOUT: O script demorou mais de 30 segundos para executar")
    sys.exit(1)

# Configurar timeout de 30 segundos
signal.signal(signal.SIGALRM, timeout_handler)
signal.alarm(30)

try:
    # Carregar variáveis de ambiente do arquivo correto
    env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
    
    # Limpar variáveis existentes
    for key in ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']:
        if key in os.environ:
            del os.environ[key]
    
    load_dotenv(dotenv_path=env_path, override=True)
    
    print('🚀 EXECUTANDO EXCHANGE_INFO_UPDATER...')
    print('=' * 50)
    
    # Importar e executar
    from exchange_info_updater import update_exchange_info_database
    result = update_exchange_info_database('binance')
    
    # Cancelar timeout
    signal.alarm(0)
    
    print('=' * 50)
    print(f'✅ RESULTADO: {result}')
    print('✅ EXECUÇÃO CONCLUÍDA SEM ERROS!')
    
except ImportError as e:
    signal.alarm(0)
    print(f'❌ Erro de importação: {e}')
except Exception as e:
    signal.alarm(0)
    print(f'❌ Erro na execução: {e}')
    import traceback
    traceback.print_exc()
except KeyboardInterrupt:
    signal.alarm(0)
    print('\n❌ Execução interrompida pelo usuário')
    sys.exit(1)
