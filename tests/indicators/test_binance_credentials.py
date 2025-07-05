#!/usr/bin/env python3
"""
Teste de carregamento das credenciais da Binance
"""

import os
import sys
from pathlib import Path
from dotenv import load_dotenv

# Carregar .env
env_path = Path(__file__).parents[3] / 'config' / '.env'
print(f"Caminho do .env: {env_path}")
print(f"Arquivo existe: {env_path.exists()}")

load_dotenv(dotenv_path=env_path)

# Verificar carregamento
api_key = os.getenv('BINANCE_API_KEY')
secret_key = os.getenv('BINANCE_SECRET_KEY')

print(f"BINANCE_API_KEY carregada: {bool(api_key)}")
print(f"BINANCE_SECRET_KEY carregada: {bool(secret_key)}")

if api_key:
    print(f"API Key: {api_key[:10]}...")
if secret_key:
    print(f"Secret Key: {secret_key[:10]}...")

# Teste de fallback
if not api_key or not secret_key:
    print("Testando fallback para senhas.py...")
    sys.path.append(str(Path(__file__).parent))
    try:
        from senhas import API_KEY, API_SECRET
        print(f"Fallback API Key: {API_KEY[:10]}...")
        print(f"Fallback Secret Key: {API_SECRET[:10]}...")
    except ImportError as e:
        print(f"Erro no fallback: {e}")
