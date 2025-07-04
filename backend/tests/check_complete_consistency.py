#!/usr/bin/env python3
"""
Script para verificar inconsistências completas entre backend e banco de dados.
Verifica se há campos sendo usados com nomes diferentes ou campos ausentes.
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import re
import os
import json
from pathlib import Path

# Configuração do banco
DB_CONFIG = {
    'host': 'localhost',
    'database': 'starboy',
    'user': 'muniz',
    'password': 'cpx12345',
    'port': 5432
}

def get_database_connection():
    """Conecta ao banco PostgreSQL"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        return conn
    except Exception as e:
        print(f"Erro ao conectar ao banco: {e}")
        return None

def get_table_columns(conn, table_name):
    """Obtém as colunas de uma tabela"""
    try:
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = %s AND table_schema = 'public'
            ORDER BY ordinal_position
        """, (table_name,))
        return cursor.fetchall()
    except Exception as e:
        print(f"Erro ao obter colunas da tabela {table_name}: {e}")
        return []

def extract_sql_fields_from_file(file_path):
    """Extrai campos SQL mencionados em arquivos JS"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Padrões para encontrar campos SQL
        patterns = [
            r'INSERT INTO\s+(\w+)\s*\([^)]+\)',
            r'UPDATE\s+(\w+)\s+SET\s+([^WHERE]+)',
            r'SELECT\s+([^FROM]+)\s+FROM\s+(\w+)',
            r'(\w+)\s*=\s*\$\d+',
            r'(\w+)\s*:\s*[^,}]+',
            r'\.(\w+)\s*,',
            r'SET\s+(\w+)\s*=',
            r'WHERE\s+(\w+)\s*[=<>!]',
        ]
        
        fields = set()
        for pattern in patterns:
            matches = re.findall(pattern, content, re.IGNORECASE | re.MULTILINE)
            for match in matches:
                if isinstance(match, tuple):
                    for field in match:
                        if field and field.replace('_', '').isalnum():
                            fields.add(field.strip())
                else:
                    if match and match.replace('_', '').isalnum():
                        fields.add(match.strip())
        
        return fields
    except Exception as e:
        print(f"Erro ao processar arquivo {file_path}: {e}")
        return set()

def scan_backend_files():
    """Escaneia todos os arquivos do backend para encontrar campos SQL"""
    backend_dir = Path("c:/Users/muniz/Documents/GitHub/starboy_postgres/backend")
    all_fields = set()
    
    # Extensões a serem verificadas
    extensions = ['.js', '.py']
    
    for ext in extensions:
        for file_path in backend_dir.rglob(f'*{ext}'):
            if file_path.is_file():
                fields = extract_sql_fields_from_file(file_path)
                all_fields.update(fields)
    
    return all_fields

def check_field_consistency():
    """Verifica consistência entre campos do backend e banco"""
    print("=== VERIFICAÇÃO DE CONSISTÊNCIA COMPLETA ===\n")
    
    # Conectar ao banco
    conn = get_database_connection()
    if not conn:
        return
    
    # Tabelas principais para verificar
    main_tables = [
        'users', 'corretoras', 'contas', 'configuracoes', 'exchange_symbols',
        'exchange_filters', 'exchange_leverage_brackets', 'posicoes', 'ordens',
        'monitoramento', 'logs', 'webhook_signals', 'signals_msg', 'posicoes_fechadas',
        'ordens_fechadas'
    ]
    
    # Obter campos do banco
    db_fields = {}
    for table in main_tables:
        columns = get_table_columns(conn, table)
        if columns:
            db_fields[table] = {col['column_name'] for col in columns}
    
    # Escanear campos do backend
    backend_fields = scan_backend_files()
    
    # Campos comuns que podem ter nomes diferentes
    field_mappings = {
        'tipo_ordem': 'type_order',
        'sl_price': 'stop_loss',
        'tp_price': 'take_profit',
        'data_hora_criacao': 'created_at',
        'data_hora_abertura': 'opened_at',
        'data_hora_fechamento': 'closed_at',
        'data_hora_ultima_atualizacao': 'last_updated',
        'ultima_atualizacao': 'updated_at',
        'data_criacao': 'created_at',
        'preco_medio': 'avg_price',
        'preco_entrada': 'entry_price',
        'preco_corrente': 'current_price',
        'quantidade_aberta': 'open_quantity',
        'quantidade_executada': 'filled_quantity',
        'preco_executado': 'filled_price',
    }
    
    # Verificar inconsistências
    print("1. CAMPOS POTENCIALMENTE INCONSISTENTES:")
    print("-" * 50)
    
    for table_name, table_fields in db_fields.items():
        print(f"\n📊 Tabela: {table_name}")
        
        # Verificar mapeamentos conhecidos
        for db_field, alt_field in field_mappings.items():
            if db_field in table_fields and alt_field in backend_fields:
                print(f"  ⚠️  Campo '{db_field}' (banco) pode conflitar com '{alt_field}' (backend)")
            elif db_field not in table_fields and alt_field in backend_fields:
                print(f"  ❌ Campo '{alt_field}' (backend) não encontrado no banco (esperado: '{db_field}')")
    
    print("\n2. CAMPOS DO BACKEND NÃO ENCONTRADOS NO BANCO:")
    print("-" * 50)
    
    # Campos que parecem ser de banco mas não foram encontrados
    potential_db_fields = {f for f in backend_fields if '_' in f and len(f) > 3}
    all_db_fields = set()
    for fields in db_fields.values():
        all_db_fields.update(fields)
    
    missing_fields = potential_db_fields - all_db_fields
    for field in sorted(missing_fields):
        if field not in ['console', 'error', 'log', 'info', 'warn', 'debug']:
            print(f"  ❓ {field}")
    
    print("\n3. CAMPOS DO BANCO NÃO USADOS NO BACKEND:")
    print("-" * 50)
    
    unused_fields = all_db_fields - backend_fields
    for field in sorted(unused_fields):
        if field not in ['id', 'created_at', 'updated_at']:
            print(f"  📋 {field}")
    
    print("\n4. VERIFICAÇÃO ESPECÍFICA DE INSERTS:")
    print("-" * 50)
    
    # Verificar especificamente os INSERTs que vimos
    insert_issues = []
    
    # Verificar se 'tipo_ordem' existe em todas as tabelas onde é usado
    for table in ['ordens', 'ordens_fechadas']:
        if table in db_fields:
            if 'tipo_ordem' not in db_fields[table]:
                insert_issues.append(f"Campo 'tipo_ordem' não encontrado na tabela '{table}'")
    
    for issue in insert_issues:
        print(f"  ❌ {issue}")
    
    print("\n5. RESUMO:")
    print("-" * 50)
    print(f"Total de campos encontrados no backend: {len(backend_fields)}")
    print(f"Total de campos no banco: {len(all_db_fields)}")
    print(f"Campos comuns: {len(backend_fields & all_db_fields)}")
    print(f"Campos apenas no backend: {len(backend_fields - all_db_fields)}")
    print(f"Campos apenas no banco: {len(all_db_fields - backend_fields)}")
    
    conn.close()

if __name__ == "__main__":
    check_field_consistency()
