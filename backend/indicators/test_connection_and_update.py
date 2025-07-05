#!/usr/bin/env python3
"""
Script para testar conexão com banco de dados usando configurações do .env
"""

import psycopg2
from dotenv import load_dotenv
import os
import pathlib

# Carregar variáveis de ambiente do arquivo correto
env_path = pathlib.Path(__file__).parents[2] / 'config' / '.env'
print(f'Carregando .env de: {env_path}')
print(f'Arquivo existe: {env_path.exists()}')

# Limpar variáveis existentes que podem interferir
for key in ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']:
    if key in os.environ:
        del os.environ[key]

load_dotenv(dotenv_path=env_path, override=True)

# Verificar se as variáveis foram carregadas corretamente
print(f'DB_HOST carregado: {os.getenv("DB_HOST")}')
print(f'DB_PORT carregado: {os.getenv("DB_PORT")}')

db_config = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

print('TESTANDO CONEXAO COM BANCO DE DADOS REMOTO')
print('=' * 60)
print(f'Host: {db_config["host"]}')
print(f'Port: {db_config["port"]}')
print(f'User: {db_config["user"]}')
print(f'Database: {db_config["database"]}')
print('=' * 60)

try:
    conn = psycopg2.connect(**db_config)
    print('Conexao estabelecida com sucesso!')
    cursor = conn.cursor()
    cursor.execute('SELECT version();')
    version = cursor.fetchone()
    print(f'PostgreSQL Version: {version[0][:50]}...')
    
    # Verificar se a tabela exchange_symbols existe
    cursor.execute("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'exchange_symbols';")
    table_exists = cursor.fetchone()[0]
    print(f'Tabela exchange_symbols existe: {"Sim" if table_exists > 0 else "Nao"}')
    
    if table_exists > 0:
        cursor.execute("SELECT COUNT(*) FROM exchange_symbols WHERE exchange = 'binance';")
        count = cursor.fetchone()[0]
        print(f'Simbolos Binance no banco: {count}')
    
    cursor.close()
    conn.close()
    print('Teste de conexao concluido!')
    
except Exception as e:
    print(f'Erro na conexao: {e}')

print('\nAgora executando o exchange_info_updater...')
print('=' * 60)

# Importar e executar o exchange_info_updater
try:
    from exchange_info_updater import update_exchange_info_database
    result = update_exchange_info_database('binance')
    print(f'Resultado da atualizacao: {result}')
except Exception as e:
    print(f'Erro na atualizacao: {e}')
    import traceback
    traceback.print_exc()
