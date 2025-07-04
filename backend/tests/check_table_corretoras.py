#!/usr/bin/env python3
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

conn = psycopg2.connect(
    host=os.getenv('DB_HOST', 'localhost'),
    database=os.getenv('DB_NAME', 'starboy_postgres'),
    user=os.getenv('DB_USER', 'postgres'),
    password=os.getenv('DB_PASSWORD', 'password'),
    port=int(os.getenv('DB_PORT', 5432))
)
cursor = conn.cursor()

# Verificar se a função update_timestamp_column existe
cursor.execute("SELECT proname FROM pg_proc WHERE proname = 'update_timestamp_column';")
result = cursor.fetchone()
if result:
    print('Função update_timestamp_column encontrada')
else:
    print('Função update_timestamp_column NÃO encontrada')
    
# Verificar se há funções de trigger
cursor.execute("SELECT proname FROM pg_proc WHERE proname LIKE '%trigger%';")
result = cursor.fetchall()
if result:
    print('Funções de trigger encontradas:')
    for func in result:
        print(f'  - {func[0]}')
else:
    print('Nenhuma função de trigger encontrada')

# Verificar definição do trigger
cursor.execute("SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'set_timestamp_corretoras';")
result = cursor.fetchone()
if result:
    print('\nDefinição do trigger set_timestamp_corretoras:')
    print(result[0])
else:
    print('\nTrigger set_timestamp_corretoras não encontrado')

conn.close()
