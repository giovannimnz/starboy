#!/usr/bin/env python3
"""
Teste final de integração do sistema de indicadores após correções
"""

import sys
import os
from pathlib import Path
from datetime import datetime

# Adicionar ao path os diretórios necessários
current_dir = Path(__file__).parent
indicators_dir = current_dir.parents[2] / 'indicators'
sys.path.append(str(indicators_dir))

def test_imports():
    """Testa todos os imports principais dos módulos utilitários"""
    print("🔍 Testando imports dos módulos utilitários...")
    
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
        # Salvar o módulo sys.argv original
        original_argv = sys.argv[:]
        # Modificar sys.argv para simular que não estamos executando como script principal
        sys.argv = ['test']
        
        # Importar apenas as funções e classes, não executar
        import divap
        print("✅ divap.py importado com sucesso")
        
        # Restaurar sys.argv
        sys.argv = original_argv
        return True
    except Exception as e:
        print(f"❌ Erro ao importar divap.py: {e}")
        # Restaurar sys.argv em caso de erro
        sys.argv = original_argv
        return False

def test_divap_backtest_import():
    """Testa o import do divap_backtest"""
    print("\n🔍 Testando import do divap_backtest.py...")
    
    try:
        # Salvar o módulo sys.argv original
        original_argv = sys.argv[:]
        # Modificar sys.argv para simular que não estamos executando como script principal
        sys.argv = ['test']
        
        import divap_backtest
        print("✅ divap_backtest.py importado com sucesso")
        
        # Restaurar sys.argv
        sys.argv = original_argv
        return True
    except Exception as e:
        print(f"❌ Erro ao importar divap_backtest.py: {e}")
        # Restaurar sys.argv em caso de erro
        sys.argv = original_argv
        return False

def test_database_connections():
    """Testa as conexões com banco de dados"""
    print("\n🔍 Testando conexões com banco de dados...")
    
    try:
        from utils.exchange_bracket_updater import test_database_connection
        db_ok = test_database_connection()
        if db_ok:
            print("✅ Conexão com banco de dados OK")
            return True
        else:
            print("❌ Falha na conexão com banco de dados")
            return False
    except Exception as e:
        print(f"❌ Erro ao testar conexão com banco: {e}")
        return False

def test_configuration_loading():
    """Testa o carregamento das configurações"""
    print("\n🔍 Testando carregamento de configurações...")
    
    try:
        from dotenv import load_dotenv
        from pathlib import Path
        import os
        
        # Carregar .env
        env_path = Path(__file__).parents[3] / 'config' / '.env'
        load_dotenv(dotenv_path=env_path)
        
        # Verificar se as variáveis principais foram carregadas
        required_vars = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_NAME']
        missing_vars = []
        
        for var in required_vars:
            if not os.getenv(var):
                missing_vars.append(var)
        
        if missing_vars:
            print(f"❌ Variáveis de ambiente faltando: {missing_vars}")
            return False
        
        print("✅ Configurações carregadas com sucesso")
        return True
    except Exception as e:
        print(f"❌ Erro ao carregar configurações: {e}")
        return False

def main():
    """Função principal"""
    print("="*60)
    print("🎯 TESTE DE INTEGRAÇÃO - SISTEMA DE INDICADORES")
    print("="*60)
    print(f"Data/Hora: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print(f"Diretório: {Path(__file__).parent}")
    print("="*60)
    
    # Executar testes
    tests = [
        ("Configurações", test_configuration_loading),
        ("Imports", test_imports),
        ("Conexões DB", test_database_connections),
        ("Divap Import", test_divap_import),
        ("Divap Backtest Import", test_divap_backtest_import),
    ]
    
    results = []
    for test_name, test_func in tests:
        print(f"\n{'='*20} {test_name} {'='*20}")
        try:
            result = test_func()
            results.append(result)
            status = "✅ PASSOU" if result else "❌ FALHOU"
            print(f"Status: {status}")
        except Exception as e:
            print(f"❌ Erro no teste {test_name}: {e}")
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
        print("✅ Sistema de indicadores integro e pronto para uso")
    else:
        print("⚠️  Alguns testes falharam")
        print("🔧 Verifique os erros acima")
    
    print("="*60)
    return passed == total

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
