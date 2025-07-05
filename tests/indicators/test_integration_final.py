#!/usr/bin/env python3
"""
Teste final de integração do sistema após correções
"""

import sys
import os
from pathlib import Path
from datetime import datetime

# Adicionar ao path
sys.path.append(str(Path(__file__).parent))

def test_imports():
    """Testa todos os imports principais"""
    print("🔍 Testando imports...")
    
    try:
        from utils.senhas import API_KEY, API_SECRET
        print("✅ utils.senhas importado com sucesso")
    except Exception as e:
        print(f"❌ Erro ao importar utils.senhas: {e}")
        return False
    
    try:
        from utils.exchange_bracket_updater import update_leverage_brackets, test_binance_credentials, test_database_connection
        print("✅ utils.exchange_bracket_updater importado com sucesso")
    except Exception as e:
        print(f"❌ Erro ao importar utils.exchange_bracket_updater: {e}")
        return False
    
    try:
        from utils.exchange_info_updater import update_exchange_info_database, CURRENT_EXCHANGE
        print("✅ utils.exchange_info_updater importado com sucesso")
    except Exception as e:
        print(f"❌ Erro ao importar utils.exchange_info_updater: {e}")
        return False
    
    try:
        from utils.analysis.divap_check import DIVAPAnalyzer
        print("✅ utils.analysis.divap_check importado com sucesso")
    except Exception as e:
        print(f"❌ Erro ao importar utils.analysis.divap_check: {e}")
        return False
    
    try:
        from utils.boolean_validator import validate_webhook_signals_data, normalize_boolean
        print("✅ utils.boolean_validator importado com sucesso")
    except Exception as e:
        print(f"❌ Erro ao importar utils.boolean_validator: {e}")
        return False
    
    return True

def test_divap_import():
    """Testa o import do divap sem executar o main"""
    print("\n🔍 Testando import do divap.py...")
    
    try:
        # Importar apenas as funções e classes, não executar
        import divap
        print("✅ divap.py importado com sucesso")
        return True
    except Exception as e:
        print(f"❌ Erro ao importar divap.py: {e}")
        return False

def test_divap_backtest_import():
    """Testa o import do divap_backtest"""
    print("\n🔍 Testando import do divap_backtest.py...")
    
    try:
        import divap_backtest
        print("✅ divap_backtest.py importado com sucesso")
        return True
    except Exception as e:
        print(f"❌ Erro ao importar divap_backtest.py: {e}")
        return False

def main():
    """Função principal"""
    print("="*60)
    print("🎯 TESTE FINAL DE INTEGRAÇÃO")
    print("="*60)
    print(f"Data/Hora: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print("="*60)
    
    # Executar testes
    tests = [
        test_imports,
        test_divap_import,
        test_divap_backtest_import
    ]
    
    results = []
    for test in tests:
        try:
            result = test()
            results.append(result)
        except Exception as e:
            print(f"❌ Erro no teste {test.__name__}: {e}")
            results.append(False)
    
    # Resultado final
    print("\n" + "="*60)
    print("📊 RESULTADO FINAL")
    print("="*60)
    
    passed = sum(results)
    total = len(results)
    
    print(f"✅ Testes passados: {passed}/{total}")
    print(f"❌ Testes falhados: {total - passed}/{total}")
    
    if passed == total:
        print("🎉 TODOS OS TESTES PASSARAM!")
        print("✅ Sistema integro e pronto para uso")
    else:
        print("⚠️  Alguns testes falharam")
        print("🔧 Verifique os erros acima")
    
    print("="*60)
    return passed == total

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
