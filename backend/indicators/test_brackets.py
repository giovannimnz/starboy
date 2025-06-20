"""
Script para testar a atualização de brackets independentemente
"""
import sys
import os
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from divap import update_leverage_brackets_database, test_binance_credentials, test_database_connection

def main():
    print("=== TESTE DE ATUALIZAÇÃO DE BRACKETS ===\n")
    
    # Teste 1: Credenciais Binance
    print("1. Testando credenciais Binance...")
    if not test_binance_credentials():
        print("❌ FALHOU - Verifique as credenciais no senhas.py")
        return
    
    # Teste 2: Conexão com banco
    print("\n2. Testando conexão com banco...")
    if not test_database_connection():
        print("❌ FALHOU - Verifique a configuração do banco")
        return
    
    # Teste 3: Atualização completa
    print("\n3. Executando atualização completa...")
    success = update_leverage_brackets_database()
    
    if success:
        print("\n✅ TODOS OS TESTES PASSARAM!")
        print("A atualização de brackets está funcionando corretamente.")
    else:
        print("\n❌ FALHA NA ATUALIZAÇÃO!")
        print("Verifique os logs acima para detalhes.")

if __name__ == "__main__":
    main()