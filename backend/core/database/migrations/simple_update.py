#!/usr/bin/env python3
"""
Script simples para atualizar as tabelas de análise
"""

import psycopg2
from psycopg2 import sql

def main():
    """Função principal"""
    print("=" * 50)
    print("ATUALIZAÇÃO DAS TABELAS DE ANÁLISE")
    print("=" * 50)
    
    try:
        # Conectar ao banco (ajuste os parâmetros conforme necessário)
        conn = psycopg2.connect(
            host="atius.com.br",
            port="8745",
            user="postgres",
            password="Bkfigt!546",
            database="starboy_dev"
        )
        
        cursor = conn.cursor()
        
        print("🔄 Atualizando estrutura das tabelas de análise...")
        
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
        
        conn.commit()
        
        print("✅ Atualização executada com sucesso!")
        
        # Validar estrutura das tabelas
        print("🔍 Validando estrutura das tabelas...")
        
        # Verificar colunas da tabela backtest_signals
        cursor.execute("""
            SELECT column_name, data_type
            FROM information_schema.columns 
            WHERE table_name = 'backtest_signals'
            ORDER BY ordinal_position
        """)
        
        colunas_backtest_signals = cursor.fetchall()
        print(f"✅ Tabela backtest_signals possui {len(colunas_backtest_signals)} colunas")
        
        # Verificar colunas da tabela backtest_results
        cursor.execute("""
            SELECT column_name, data_type
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
        
        cursor.close()
        conn.close()
        
        print("\n🎉 Atualização concluída com sucesso!")
        print("=" * 50)
        
    except Exception as e:
        print(f"❌ Erro durante a atualização: {str(e)}")
        print("=" * 50)

if __name__ == "__main__":
    main()
