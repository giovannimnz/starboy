#!/usr/bin/env python3
"""
Script para executar a migração das tabelas de análise
"""

import psycopg2
import os
from pathlib import Path
from dotenv import load_dotenv

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[4] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configuração do banco
DB_CONFIG = {
    "host": os.getenv('DB_HOST'),
    "user": os.getenv('DB_USER'),
    "password": os.getenv('DB_PASSWORD'),
    "database": os.getenv('DB_NAME'),
    "port": int(os.getenv('DB_PORT', 5432))
}

def run_migration():
    """Executa a migração das tabelas"""
    try:
        # Conectar ao banco
        conn = psycopg2.connect(**DB_CONFIG)
        conn.autocommit = True
        cursor = conn.cursor()
        
        print("🔄 Executando migração das tabelas de análise...")
        
        # Ler o arquivo SQL de migração
        migration_file = Path(__file__).parent / 'migrate_analysis_tables.sql'
        with open(migration_file, 'r', encoding='utf-8') as f:
            migration_sql = f.read()
        
        # Executar migração
        cursor.execute(migration_sql)
        
        print("✅ Migração executada com sucesso!")
        
        # Verificar se as tabelas foram criadas
        cursor.execute("""
            SELECT table_name FROM information_schema.tables 
            WHERE table_schema = 'public' AND table_name IN ('signals_analysis', 'backtest_signals', 'backtest_results')
            ORDER BY table_name
        """)
        
        tables = cursor.fetchall()
        print(f"📋 Tabelas criadas/atualizadas: {[t[0] for t in tables]}")
        
        # Verificar se dados foram migrados
        cursor.execute("SELECT COUNT(*) FROM signals_analysis")
        count = cursor.fetchone()[0]
        print(f"📊 Registros na tabela signals_analysis: {count}")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ Erro durante a migração: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    run_migration()
