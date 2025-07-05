#!/usr/bin/env python3
"""
Script para verificar sinais no banco de dados
"""

import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime
import os
from dotenv import load_dotenv
from pathlib import Path

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[1] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def check_signals():
    """Verifica sinais no banco"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print("="*60)
        print("🔍 VERIFICAÇÃO DE SINAIS NO BANCO")
        print("="*60)
        
        # Verificar quantos sinais existem por chat_id_orig_sinal
        cursor.execute("""
            SELECT chat_id_orig_sinal, COUNT(*) as total
            FROM webhook_signals 
            WHERE chat_id_orig_sinal IS NOT NULL
            GROUP BY chat_id_orig_sinal
            ORDER BY total DESC
            LIMIT 10
        """)
        
        results = cursor.fetchall()
        print('\n📊 Sinais por chat_id_orig_sinal:')
        for row in results:
            print(f'   Chat ID: {row["chat_id_orig_sinal"]} - Total: {row["total"]}')
        
        # Verificar especificamente o canal solicitado
        cursor.execute("""
            SELECT COUNT(*) as total
            FROM webhook_signals 
            WHERE chat_id_orig_sinal = -1002444455075
        """)
        
        result = cursor.fetchone()
        print(f'\n🎯 Canal -1002444455075: {result["total"]} sinais')
        
        # Verificar os últimos 5 sinais deste canal
        cursor.execute("""
            SELECT symbol, side, created_at, chat_id_orig_sinal
            FROM webhook_signals 
            WHERE chat_id_orig_sinal = -1002444455075
            ORDER BY created_at DESC
            LIMIT 5
        """)
        
        results = cursor.fetchall()
        print('\n📋 Últimos 5 sinais do canal -1002444455075:')
        for row in results:
            formatted_date = row['created_at'].strftime('%d-%m-%Y %H:%M:%S')
            print(f'   {row["symbol"]} {row["side"]} - {formatted_date}')
        
        # Verificar sinais dos últimos 7 dias de qualquer canal
        cursor.execute("""
            SELECT chat_id_orig_sinal, symbol, side, created_at
            FROM webhook_signals 
            WHERE created_at >= NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 10
        """)
        
        results = cursor.fetchall()
        print('\n📅 Últimos 10 sinais dos últimos 7 dias:')
        for row in results:
            formatted_date = row['created_at'].strftime('%d-%m-%Y %H:%M:%S')
            print(f'   Canal: {row["chat_id_orig_sinal"]} - {row["symbol"]} {row["side"]} - {formatted_date}')
        
        # Verificar se existem sinais dos grupos configurados no .env
        grupos_origem = [-4192806079]  # Do .env
        cursor.execute("""
            SELECT COUNT(*) as total
            FROM webhook_signals 
            WHERE chat_id_orig_sinal = ANY(%s)
        """, (grupos_origem,))
        
        result = cursor.fetchone()
        print(f'\n🎯 Grupos configurados no .env ({grupos_origem}): {result["total"]} sinais')
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f'❌ Erro: {e}')

if __name__ == "__main__":
    check_signals()
