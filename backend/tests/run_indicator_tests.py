#!/usr/bin/env python3
"""
Script de execução de todos os testes do sistema de indicadores
"""

import sys
import os
import unittest
from pathlib import Path
from datetime import datetime

def discover_and_run_tests():
    """Descobre e executa todos os testes"""
    
    # Configurar paths
    current_dir = Path(__file__).parent
    tests_dir = current_dir / 'indicators'
    
    print("="*60)
    print("🧪 EXECUTANDO TESTES DO SISTEMA DE INDICADORES")
    print("="*60)
    print(f"Data/Hora: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print(f"Diretório de testes: {tests_dir}")
    print("="*60)
    
    # Descobrir testes
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    
    # Adicionar testes unitários
    unit_tests_dir = tests_dir / 'unit'
    if unit_tests_dir.exists():
        unit_suite = loader.discover(str(unit_tests_dir), pattern='test_*.py')
        suite.addTest(unit_suite)
        print(f"📦 Testes unitários descobertos em: {unit_tests_dir}")
    
    # Adicionar testes de integração
    integration_tests_dir = tests_dir / 'integration'
    if integration_tests_dir.exists():
        integration_suite = loader.discover(str(integration_tests_dir), pattern='test_*.py')
        suite.addTest(integration_suite)
        print(f"🔗 Testes de integração descobertos em: {integration_tests_dir}")
    
    # Executar testes
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    # Resultado final
    print("\n" + "="*60)
    print("📊 RESULTADO FINAL DOS TESTES")
    print("="*60)
    
    tests_run = result.testsRun
    failures = len(result.failures)
    errors = len(result.errors)
    success = tests_run - failures - errors
    
    print(f"🧪 Total de testes: {tests_run}")
    print(f"✅ Sucessos: {success}")
    print(f"❌ Falhas: {failures}")
    print(f"🔥 Erros: {errors}")
    
    if result.wasSuccessful():
        print("🎉 TODOS OS TESTES PASSARAM!")
    else:
        print("⚠️  ALGUNS TESTES FALHARAM")
        
        if result.failures:
            print("\n📝 FALHAS:")
            for test, traceback in result.failures:
                print(f"  - {test}: {traceback}")
        
        if result.errors:
            print("\n🔥 ERROS:")
            for test, traceback in result.errors:
                print(f"  - {test}: {traceback}")
    
    print("="*60)
    return result.wasSuccessful()

if __name__ == '__main__':
    success = discover_and_run_tests()
    sys.exit(0 if success else 1)
