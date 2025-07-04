#!/usr/bin/env python3
"""
Teste final de consistência para verificar se todos os campos estão alinhados
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import os
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

# Configuração do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy'),
    'user': os.getenv('DB_USER', 'muniz'),
    'password': os.getenv('DB_PASSWORD', 'cpx12345'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def test_final_consistency():
    """Teste final de consistência"""
    print("=== TESTE FINAL DE CONSISTÊNCIA ===\n")
    
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    cursor = conn.cursor(cursor_factory=RealDictCursor)
    
    # 1. Testar INSERT na tabela webhook_signals
    print("1. Testando INSERT na tabela webhook_signals...")
    try:
        cursor.execute("""
            INSERT INTO webhook_signals (
                symbol, side, leverage, capital_pct, entry_price, sl_price,
                tp1_price, tp2_price, status, conta_id, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
            RETURNING id
        """, (
            'BTCUSDT', 'BUY', 10, 5.0, 50000.0, 49000.0, 
            51000.0, 52000.0, 'PENDING', 1
        ))
        
        signal_id = cursor.fetchone()['id']
        print(f"   ✅ INSERT webhook_signals funcionou - ID: {signal_id}")
        
        # Limpar dados de teste
        cursor.execute("DELETE FROM webhook_signals WHERE id = %s", (signal_id,))
        print("   🧹 Dados de teste removidos")
        
    except Exception as e:
        print(f"   ❌ Erro no INSERT webhook_signals: {e}")
    
    # 2. Testar INSERT na tabela ordens
    print("\n2. Testando INSERT na tabela ordens...")
    try:
        cursor.execute("""
            INSERT INTO ordens (
                tipo_ordem, preco, quantidade, simbolo, side, status,
                data_hora_criacao, conta_id
            ) VALUES (%s, %s, %s, %s, %s, %s, CURRENT_TIMESTAMP, %s)
            RETURNING id
        """, (
            'LIMIT', 50000.0, 0.001, 'BTCUSDT', 'BUY', 'NEW', 1
        ))
        
        ordem_id = cursor.fetchone()['id']
        print(f"   ✅ INSERT ordens funcionou - ID: {ordem_id}")
        
        # Limpar dados de teste
        cursor.execute("DELETE FROM ordens WHERE id = %s", (ordem_id,))
        print("   🧹 Dados de teste removidos")
        
    except Exception as e:
        print(f"   ❌ Erro no INSERT ordens: {e}")
    
    # 3. Verificar se todos os campos críticos existem
    print("\n3. Verificando campos críticos...")
    critical_checks = [
        ('ordens', 'tipo_ordem'),
        ('webhook_signals', 'sl_price'),
        ('webhook_signals', 'tp1_price'),
        ('posicoes', 'preco_medio'),
        ('contas', 'saldo_base_calculo_futuros'),
    ]
    
    for table, field in critical_checks:
        cursor.execute("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = %s AND column_name = %s AND table_schema = 'public'
        """, (table, field))
        
        result = cursor.fetchone()
        if result:
            print(f"   ✅ {table}.{field} existe")
        else:
            print(f"   ❌ {table}.{field} NÃO EXISTE")
    
    # 4. Verificar se existem triggers ativos
    print("\n4. Verificando triggers...")
    cursor.execute("""
        SELECT trigger_name, event_object_table, action_statement
        FROM information_schema.triggers
        WHERE trigger_schema = 'public'
        ORDER BY event_object_table, trigger_name
    """)
    
    triggers = cursor.fetchall()
    if triggers:
        print(f"   📋 {len(triggers)} triggers encontrados:")
        for trigger in triggers:
            print(f"      - {trigger['trigger_name']} na tabela {trigger['event_object_table']}")
    else:
        print("   ⚠️  Nenhum trigger encontrado")
    
    cursor.close()
    conn.close()
    
    print("\n🎉 TESTE FINAL COMPLETO!")

if __name__ == "__main__":
    test_final_consistency()
