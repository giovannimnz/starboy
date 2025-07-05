import os
import psycopg2

# Configuração simples do banco
host = os.getenv('DB_HOST', 'localhost')
user = os.getenv('DB_USER', 'postgres')
password = os.getenv('DB_PASSWORD', 'postgres')
database = os.getenv('DB_NAME', 'starboy_postgres')
port = int(os.getenv('DB_PORT', 5432))

print(f"Tentando conectar: {user}@{host}:{port}/{database}")

try:
    conn = psycopg2.connect(
        host=host,
        user=user,
        password=password,
        database=database,
        port=port
    )
    cursor = conn.cursor()
    
    print("✅ Conexão estabelecida!")
    
    # Verificar tabelas
    cursor.execute("""
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('signals_analysis', 'backtest_signals', 'backtest_results')
    """)
    
    tables = cursor.fetchall()
    print(f"📋 Tabelas encontradas: {[t[0] for t in tables]}")
    
    # Verificar estrutura signals_analysis
    cursor.execute("""
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'signals_analysis' 
        AND column_name = 'analysis_type'
    """)
    
    has_analysis_type = cursor.fetchall()
    if has_analysis_type:
        print("✅ Coluna 'analysis_type' existe em signals_analysis")
    else:
        print("❌ Coluna 'analysis_type' NÃO existe em signals_analysis")
    
    cursor.close()
    conn.close()
    print("✅ Validação concluída!")
    
except Exception as e:
    print(f"❌ Erro: {e}")
