#!/usr/bin/env python3
"""
Teste direto para verificar campos específicos que podem estar inconsistentes
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

def test_field_consistency():
    """Testa consistência de campos específicos"""
    
    print("=== TESTE DE CONSISTÊNCIA DE CAMPOS ===\n")
    
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verificar campos específicos da tabela ordens
        print("1. VERIFICANDO CAMPOS DA TABELA 'ordens':")
        cursor.execute("""
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'ordens' AND table_schema = 'public'
            ORDER BY ordinal_position
        """)
        
        ordens_fields = cursor.fetchall()
        ordens_field_names = [field['column_name'] for field in ordens_fields]
        
        print(f"   Campos encontrados: {len(ordens_field_names)}")
        for field in ordens_field_names:
            print(f"   - {field}")
        
        # Verificar campos específicos que podem estar inconsistentes
        print("\n2. VERIFICANDO CAMPOS ESPECÍFICOS:")
        
        critical_fields = [
            'tipo_ordem', 'type_order', 'sl_price', 'stop_loss', 'tp_price', 
            'take_profit', 'data_hora_preenchimento', 'filled_at'
        ]
        
        for field in critical_fields:
            if field in ordens_field_names:
                print(f"   ✅ {field} - EXISTE")
            else:
                print(f"   ❌ {field} - NÃO EXISTE")
        
        # Verificar se há campos com nomes similares
        print("\n3. VERIFICANDO CAMPOS SIMILARES:")
        similar_patterns = [
            ('tipo', 'type'),
            ('preco', 'price'),
            ('quantidade', 'quantity'),
            ('data_hora', 'datetime'),
            ('sl', 'stop'),
            ('tp', 'take')
        ]
        
        for pattern1, pattern2 in similar_patterns:
            fields1 = [f for f in ordens_field_names if pattern1 in f.lower()]
            fields2 = [f for f in ordens_field_names if pattern2 in f.lower()]
            
            if fields1 or fields2:
                print(f"   📋 Campos com '{pattern1}': {fields1}")
                print(f"   📋 Campos com '{pattern2}': {fields2}")
        
        # Teste de INSERT para verificar se campos funcionam
        print("\n4. TESTANDO INSERT NA TABELA 'ordens':")
        
        # Primeiro, verificar se existe uma posição para referenciar
        cursor.execute("SELECT id FROM posicoes LIMIT 1")
        posicao_result = cursor.fetchone()
        
        if posicao_result:
            posicao_id = posicao_result['id']
            
            # Testar INSERT com campos existentes
            try:
                cursor.execute("""
                    INSERT INTO ordens (
                        tipo_ordem, preco, quantidade, simbolo, side, status,
                        data_hora_criacao, id_posicao, conta_id
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    RETURNING id
                """, (
                    'LIMIT', 50000.0, 0.001, 'BTCUSDT', 'BUY', 'NEW',
                    'CURRENT_TIMESTAMP', posicao_id, 1
                ))
                
                ordem_id = cursor.fetchone()['id']
                print(f"   ✅ INSERT funcionou - ID: {ordem_id}")
                
                # Limpar dados de teste
                cursor.execute("DELETE FROM ordens WHERE id = %s", (ordem_id,))
                print(f"   🧹 Dados de teste removidos")
                
            except Exception as e:
                print(f"   ❌ Erro no INSERT: {e}")
        
        else:
            print("   ⚠️  Nenhuma posição encontrada para testar INSERT")
        
        # Verificar outras tabelas críticas
        print("\n5. VERIFICANDO OUTRAS TABELAS CRÍTICAS:")
        
        tables_to_check = ['webhook_signals', 'posicoes', 'contas']
        
        for table in tables_to_check:
            cursor.execute("""
                SELECT column_name 
                FROM information_schema.columns 
                WHERE table_name = %s AND table_schema = 'public'
            """, (table,))
            
            fields = [row['column_name'] for row in cursor.fetchall()]
            print(f"   📊 {table}: {len(fields)} campos")
            
            # Verificar campos específicos por tabela
            if table == 'webhook_signals':
                if 'sl_price' in fields:
                    print(f"      ✅ sl_price existe")
                if 'tp_price' in fields:
                    print(f"      ✅ tp_price existe")
            
            elif table == 'posicoes':
                if 'preco_medio' in fields:
                    print(f"      ✅ preco_medio existe")
                if 'data_hora_abertura' in fields:
                    print(f"      ✅ data_hora_abertura existe")
        
        cursor.close()
        conn.close()
        
        print("\n🎉 VERIFICAÇÃO COMPLETA!")
        
    except Exception as e:
        print(f"❌ Erro durante verificação: {e}")

if __name__ == "__main__":
    test_field_consistency()
