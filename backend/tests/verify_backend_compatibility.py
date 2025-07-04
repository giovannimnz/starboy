#!/usr/bin/env python3
"""
Verifica compatibilidade entre backend e banco de dados
"""
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

# Verificar tabela posicoes
print("=== VERIFICAÇÃO TABELA POSICOES ===")
cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'posicoes' ORDER BY ordinal_position")
posicoes_fields = [row[0] for row in cursor.fetchall()]

backend_posicoes_fields = [
    'simbolo', 'quantidade', 'quantidade_aberta', 'preco_medio', 'status',
    'data_hora_abertura', 'data_hora_fechamento', 'side', 'leverage',
    'data_hora_ultima_atualizacao', 'preco_entrada', 'preco_corrente',
    'conta_id'
]

print("Campos no banco:")
for field in posicoes_fields:
    if field != 'id':
        status = "✅" if field in backend_posicoes_fields else "⚠️"
        print(f"  {status} {field}")

print("\nCampos esperados pelo backend:")
for field in backend_posicoes_fields:
    status = "✅" if field in posicoes_fields else "❌"
    print(f"  {status} {field}")

# Verificar tabela ordens
print("\n=== VERIFICAÇÃO TABELA ORDENS ===")
cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'ordens' ORDER BY ordinal_position")
ordens_fields = [row[0] for row in cursor.fetchall()]

backend_ordens_fields = [
    'simbolo', 'quantidade', 'preco', 'side', 'type_order', 'status',
    'data_hora_criacao', 'data_hora_preenchimento', 'conta_id'
]

print("Campos no banco:")
for field in ordens_fields:
    if field != 'id':
        status = "✅" if field in backend_ordens_fields else "⚠️"
        print(f"  {status} {field}")

print("\nCampos esperados pelo backend:")
for field in backend_ordens_fields:
    status = "✅" if field in ordens_fields else "❌"
    print(f"  {status} {field}")

# Verificar tabela webhook_signals
print("\n=== VERIFICAÇÃO TABELA WEBHOOK_SIGNALS ===")
cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'webhook_signals' ORDER BY ordinal_position")
webhook_fields = [row[0] for row in cursor.fetchall()]

backend_webhook_fields = [
    'symbol', 'side', 'leverage', 'capital_pct', 'entry_price', 'stop_loss', 
    'take_profit', 'status', 'created_at', 'message_source'
]

print("Campos no banco:")
for field in webhook_fields:
    if field != 'id':
        status = "✅" if field in backend_webhook_fields else "⚠️"
        print(f"  {status} {field}")

print("\nCampos esperados pelo backend:")
for field in backend_webhook_fields:
    status = "✅" if field in webhook_fields else "❌"
    print(f"  {status} {field}")

conn.close()
