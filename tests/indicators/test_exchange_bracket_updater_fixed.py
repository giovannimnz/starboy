#!/usr/bin/env python3
"""
Teste para validar o Exchange Bracket Updater corrigido
"""
import os
import sys
import pytest
from pathlib import Path
from datetime import datetime

# Adicionar o diretório do backend ao path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend" / "indicators"))

def test_exchange_bracket_updater_import():
    """Testa se o módulo exchange_bracket_updater pode ser importado"""
    try:
        from utils.exchange_bracket_updater import (
            update_leverage_brackets,
            test_binance_credentials,
            test_database_connection
        )
        print("✅ Módulo exchange_bracket_updater importado com sucesso")
        return True
    except ImportError as e:
        print(f"❌ Erro ao importar exchange_bracket_updater: {e}")
        return False

def test_database_connection():
    """Testa conexão com banco de dados"""
    try:
        from utils.exchange_bracket_updater import test_database_connection
        return test_database_connection()
    except Exception as e:
        print(f"❌ Erro ao testar conexão com banco: {e}")
        return False

def test_binance_credentials():
    """Testa credenciais da Binance"""
    try:
        from utils.exchange_bracket_updater import test_binance_credentials
        return test_binance_credentials()
    except Exception as e:
        print(f"❌ Erro ao testar credenciais Binance: {e}")
        return False

def test_bracket_update_function():
    """Testa se a função de atualização de brackets funciona"""
    try:
        from utils.exchange_bracket_updater import update_leverage_brackets
        # Não executar realmente, apenas verificar se a função existe
        assert callable(update_leverage_brackets)
        print("✅ Função update_leverage_brackets disponível")
        return True
    except Exception as e:
        print(f"❌ Erro ao testar função update_leverage_brackets: {e}")
        return False

def main():
    print("=== TESTE: Exchange Bracket Updater Corrigido ===")
    print(f"Timestamp: {datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}")
    print("=" * 60)
    
    tests = [
        ("Import do módulo", test_exchange_bracket_updater_import),
        ("Conexão com banco", test_database_connection),
        ("Credenciais Binance", test_binance_credentials),
        ("Função de atualização", test_bracket_update_function)
    ]
    
    results = []
    for test_name, test_func in tests:
        print(f"\n🔍 Executando: {test_name}")
        try:
            result = test_func()
            results.append((test_name, result))
            status = "✅ PASSOU" if result else "❌ FALHOU"
            print(f"   {status}")
        except Exception as e:
            results.append((test_name, False))
            print(f"   ❌ ERRO: {e}")
    
    print("\n" + "=" * 60)
    print("RESUMO DOS TESTES:")
    passed = sum(1 for _, result in results if result)
    total = len(results)
    
    for test_name, result in results:
        status = "✅" if result else "❌"
        print(f"  {status} {test_name}")
    
    print(f"\nResultado: {passed}/{total} testes passaram")
    
    if passed == total:
        print("🎉 TODOS OS TESTES PASSARAM!")
    else:
        print("⚠️ Alguns testes falharam. Verifique a configuração.")

if __name__ == "__main__":
    main()
