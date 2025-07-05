#!/usr/bin/env python3
"""
Script de teste para verificar se o exchange_info_updater está funcionando
"""

import os
import sys
import pathlib
from dotenv import load_dotenv

# Adicionar o diretório utils ao path
sys.path.append(str(pathlib.Path(__file__).parent / 'utils'))

# Carregar variáveis de ambiente
env_path = pathlib.Path(__file__).parents[1] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

print("🔧 TESTE DE CONFIGURAÇÃO DO EXCHANGE_INFO_UPDATER")
print("="*70)

print("📁 Verificando variáveis de ambiente...")
print(f"   DB_HOST: {os.getenv('DB_HOST')}")
print(f"   DB_PORT: {os.getenv('DB_PORT')}")
print(f"   DB_USER: {os.getenv('DB_USER')}")
print(f"   DB_PASSWORD: {'*' * len(os.getenv('DB_PASSWORD', '')) if os.getenv('DB_PASSWORD') else 'None'}")
print(f"   DB_NAME: {os.getenv('DB_NAME')}")

print("\n📦 Testando importação...")
try:
    from exchange_info_updater import get_database_connection, make_binance_request, update_exchange_info_database
    print("✅ Importação do exchange_info_updater: OK")
except Exception as e:
    print(f"❌ Erro na importação: {e}")
    sys.exit(1)

print("\n🔌 Testando conexão com banco...")
try:
    conn = get_database_connection()
    if conn:
        print("✅ Conexão com banco: OK")
        conn.close()
    else:
        print("❌ Conexão com banco: ERRO")
        sys.exit(1)
except Exception as e:
    print(f"❌ Erro na conexão: {e}")
    sys.exit(1)

print("\n🌐 Testando API Binance...")
try:
    response = make_binance_request('/v1/exchangeInfo')
    if response and 'symbols' in response:
        print(f"✅ API Binance: OK ({len(response['symbols'])} símbolos)")
    else:
        print("❌ API Binance: Resposta inválida")
        sys.exit(1)
except Exception as e:
    print(f"❌ Erro na API: {e}")
    sys.exit(1)

print("\n🚀 Executando atualização completa...")
try:
    result = update_exchange_info_database('binance')
    if result:
        print("✅ Atualização concluída com sucesso!")
    else:
        print("❌ Atualização falhou!")
        sys.exit(1)
except Exception as e:
    print(f"❌ Erro na atualização: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)

print("\n🎉 TODOS OS TESTES PASSARAM!")
print("✅ O exchange_info_updater está funcionando corretamente!")
