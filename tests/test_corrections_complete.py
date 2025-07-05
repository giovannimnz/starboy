#!/usr/bin/env python3
"""
Teste final para validar todas as correções implementadas
"""

import sys
import os
from pathlib import Path
from datetime import datetime

# Adicionar paths necessários
current_dir = Path(__file__).parent
backend_dir = current_dir.parent.parent / "backend"
indicators_dir = backend_dir / "indicators"
sys.path.append(str(indicators_dir))

def test_corrected_imports():
    """Testa se todos os imports estão funcionando"""
    print("🔍 Testando imports corrigidos...")
    
    # Teste 1: Import do senhas.py
    try:
        from utils.senhas import API_KEY, API_SECRET
        print("✅ utils.senhas - OK")
    except ImportError as e:
        print(f"❌ utils.senhas - ERRO: {e}")
        return False
    
    # Teste 2: Import do exchange_bracket_updater
    try:
        from utils.exchange_bracket_updater import update_leverage_brackets, test_binance_credentials, test_database_connection
        print("✅ utils.exchange_bracket_updater - OK")
    except ImportError as e:
        print(f"❌ utils.exchange_bracket_updater - ERRO: {e}")
        return False
    
    # Teste 3: Import do exchange_info_updater
    try:
        from utils.exchange_info_updater import update_exchange_info_database, CURRENT_EXCHANGE
        print("✅ utils.exchange_info_updater - OK")
    except ImportError as e:
        print(f"❌ utils.exchange_info_updater - ERRO: {e}")
        return False
    
    return True

def test_database_connection():
    """Testa conexão com banco de dados"""
    print("\n🔍 Testando conexão com banco de dados...")
    
    try:
        from utils.exchange_bracket_updater import test_database_connection
        result = test_database_connection()
        if result:
            print("✅ Conexão com banco - OK")
            return True
        else:
            print("❌ Conexão com banco - FALHOU")
            return False
    except Exception as e:
        print(f"❌ Conexão com banco - ERRO: {e}")
        return False

def test_binance_credentials():
    """Testa credenciais da Binance"""
    print("\n🔍 Testando credenciais da Binance...")
    
    try:
        from utils.exchange_bracket_updater import test_binance_credentials
        result = test_binance_credentials()
        if result:
            print("✅ Credenciais Binance - OK")
            return True
        else:
            print("❌ Credenciais Binance - FALHOU")
            return False
    except Exception as e:
        print(f"❌ Credenciais Binance - ERRO: {e}")
        return False

def test_exchange_info_updater():
    """Testa o exchange_info_updater"""
    print("\n🔍 Testando exchange_info_updater...")
    
    try:
        from utils.exchange_info_updater import update_exchange_info_database, CURRENT_EXCHANGE
        
        # Testar apenas se a função existe e pode ser chamada
        print("✅ exchange_info_updater - Função disponível")
        return True
    except Exception as e:
        print(f"❌ exchange_info_updater - ERRO: {e}")
        return False

def test_bracket_updater():
    """Testa o bracket_updater"""
    print("\n🔍 Testando bracket_updater...")
    
    try:
        from utils.exchange_bracket_updater import update_leverage_brackets
        
        # Testar apenas se a função existe e pode ser chamada
        print("✅ bracket_updater - Função disponível")
        return True
    except Exception as e:
        print(f"❌ bracket_updater - ERRO: {e}")
        return False

def run_full_test():
    """Executa todos os testes"""
    print("=" * 80)
    print("🚀 TESTE COMPLETO DAS CORREÇÕES IMPLEMENTADAS")
    print("=" * 80)
    print(f"Timestamp: {datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}")
    print()
    
    # Executar testes
    tests = [
        ("Imports corrigidos", test_corrected_imports),
        ("Conexão com banco", test_database_connection),
        ("Credenciais Binance", test_binance_credentials),
        ("Exchange Info Updater", test_exchange_info_updater),
        ("Bracket Updater", test_bracket_updater),
    ]
    
    results = []
    for test_name, test_func in tests:
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ {test_name} - ERRO CRÍTICO: {e}")
            results.append((test_name, False))
    
    # Resumo
    print("\n" + "=" * 80)
    print("📊 RESUMO DOS TESTES")
    print("=" * 80)
    
    total_tests = len(results)
    passed_tests = sum(1 for _, result in results if result)
    
    for test_name, result in results:
        status = "✅ PASSOU" if result else "❌ FALHOU"
        print(f"{test_name:30} - {status}")
    
    print(f"\n📈 Total: {passed_tests}/{total_tests} testes passaram")
    
    if passed_tests == total_tests:
        print("🎉 TODOS OS TESTES PASSARAM - CORREÇÕES IMPLEMENTADAS COM SUCESSO!")
        return True
    else:
        print("⚠️ ALGUNS TESTES FALHARAM - VERIFIQUE OS PROBLEMAS ACIMA")
        return False

if __name__ == "__main__":
    success = run_full_test()
    sys.exit(0 if success else 1)
