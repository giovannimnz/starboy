#!/usr/bin/env python3
"""
Script para adicionar as colunas necessárias às tabelas de análise
"""

import sys
import os
from pathlib import Path

# Adicionar o diretório backend ao path
backend_path = Path(__file__).parent.parent.parent
sys.path.insert(0, str(backend_path))

# Importar conexão do banco
import psycopg2
from dotenv import load_dotenv

# Carregar variáveis de ambiente do .env
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

def getDatabaseInstance():
    class MockPool:
        def getconn(self):
            return psycopg2.connect(
                host=os.getenv('DB_HOST', 'localhost'),
                port=int(os.getenv('DB_PORT', '5432')),
                user=os.getenv('DB_USER', 'postgres'),
                password=os.getenv('DB_PASSWORD', ''),
                database=os.getenv('DB_NAME', 'starboy_postgres')
            )
        def putconn(self, conn):
            conn.close()
    return MockPool()

def executar_atualizacao():
    """Executa a atualização das tabelas"""
    try:
        print("🔄 Atualizando estrutura das tabelas de análise...")
        
        # Conectar ao banco
        pool = getDatabaseInstance()
        conn = pool.getconn()
        
        if not conn:
            print("❌ Erro ao conectar ao banco de dados")
            return False
        
        cursor = conn.cursor()
        
        # Adicionar colunas que faltam na tabela backtest_signals
        print("📝 Adicionando colunas na tabela backtest_signals...")
        
        cursor.execute("""
            ALTER TABLE backtest_signals 
            ADD COLUMN IF NOT EXISTS divap_confirmado BOOLEAN DEFAULT false,
            ADD COLUMN IF NOT EXISTS cancelado_checker BOOLEAN DEFAULT false
        """)
        
        # Adicionar colunas que faltam na tabela backtest_results
        print("📝 Adicionando colunas na tabela backtest_results...")
        
        cursor.execute("""
            ALTER TABLE backtest_results 
            ADD COLUMN IF NOT EXISTS strategy VARCHAR(100)
        """)
        
        # Atualizar comentários
        print("📝 Atualizando comentários das tabelas...")
        
        cursor.execute("""
            COMMENT ON COLUMN backtest_signals.signal_datetime IS 'Data e hora do sinal original (mensagem do Telegram)';
            COMMENT ON COLUMN backtest_signals.created_at IS 'Data e hora de criação do registro na tabela';
            COMMENT ON COLUMN backtest_signals.divap_confirmado IS 'Se foi confirmado como padrão DIVAP';
            COMMENT ON COLUMN backtest_signals.cancelado_checker IS 'Se foi cancelado pela verificação';
            
            COMMENT ON COLUMN backtest_results.strategy IS 'Estratégia utilizada no backtest';
            COMMENT ON COLUMN backtest_results.initial_capital IS 'Capital inicial da operação';
            COMMENT ON COLUMN backtest_results.final_capital IS 'Capital final após a operação';
            COMMENT ON COLUMN backtest_results.entry_price IS 'Preço de entrada da operação';
            COMMENT ON COLUMN backtest_results.entry_fee IS 'Taxa de entrada da operação';
        """)
        
        conn.commit()
        
        print("✅ Atualização executada com sucesso!")
        
        # Validar estrutura das tabelas
        validar_estrutura(cursor)
        
        cursor.close()
        pool.putconn(conn)
        
        return True
        
    except Exception as e:
        print(f"❌ Erro durante a atualização: {str(e)}")
        return False

def validar_estrutura(cursor):
    """Valida a estrutura das tabelas"""
    try:
        print("🔍 Validando estrutura das tabelas...")
        
        # Verificar colunas da tabela backtest_signals
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'backtest_signals'
            ORDER BY ordinal_position
        """)
        
        colunas_backtest_signals = cursor.fetchall()
        print(f"✅ Tabela backtest_signals possui {len(colunas_backtest_signals)} colunas")
        
        # Verificar colunas da tabela backtest_results
        cursor.execute("""
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'backtest_results'
            ORDER BY ordinal_position
        """)
        
        colunas_backtest_results = cursor.fetchall()
        print(f"✅ Tabela backtest_results possui {len(colunas_backtest_results)} colunas")
        
        # Verificar se colunas específicas existem
        colunas_necessarias_signals = ['divap_confirmado', 'cancelado_checker', 'signal_datetime']
        for coluna in colunas_necessarias_signals:
            if any(col[0] == coluna for col in colunas_backtest_signals):
                print(f"   ✅ Coluna '{coluna}' existe em backtest_signals")
            else:
                print(f"   ❌ Coluna '{coluna}' não existe em backtest_signals")
        
        colunas_necessarias_results = ['strategy', 'initial_capital', 'final_capital', 'entry_price', 'entry_fee']
        for coluna in colunas_necessarias_results:
            if any(col[0] == coluna for col in colunas_backtest_results):
                print(f"   ✅ Coluna '{coluna}' existe em backtest_results")
            else:
                print(f"   ❌ Coluna '{coluna}' não existe em backtest_results")
                
    except Exception as e:
        print(f"❌ Erro na validação: {str(e)}")

def main():
    """Função principal"""
    print("=" * 50)
    print("ATUALIZAÇÃO DAS TABELAS DE ANÁLISE")
    print("=" * 50)
    
    if executar_atualizacao():
        print("\n🎉 Atualização concluída com sucesso!")
        print("=" * 50)
    else:
        print("\n❌ Atualização falhou!")
        print("=" * 50)
        sys.exit(1)

if __name__ == "__main__":
    main()
