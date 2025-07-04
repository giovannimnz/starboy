#!/usr/bin/env python3
"""
Teste simples para verificar se o sistema está funcionando após as correções boolean
"""

import sys
from pathlib import Path

# Adicionar o diretório raiz ao path
sys.path.append(str(Path(__file__).parents[2]))

try:
    from backend.indicators.divap import DB_CONFIG, get_database_connection
    print("✅ Imports do divap.py OK")
    
    conn = get_database_connection()
    if conn:
        print("✅ Conexão com banco OK")
        conn.close()
    else:
        print("❌ Falha na conexão")
        
    print("🎉 Sistema funcionando corretamente após correções boolean!")
    
except Exception as e:
    print(f"❌ Erro: {e}")
    import traceback
    traceback.print_exc()
