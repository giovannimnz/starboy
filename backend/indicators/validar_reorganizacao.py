#!/usr/bin/env python3
"""
Script de validação da reorganização da pasta indicators
"""

import sys
from pathlib import Path

def test_structure():
    """Testa se a estrutura foi reorganizada corretamente"""
    print("🔍 Validando estrutura da pasta indicators...")
    
    indicators_path = Path(__file__).parent
    
    # Arquivos que devem estar na raiz
    root_files = ['divap.py', 'divap_backtest.py', '__init__.py']
    
    # Arquivos que devem estar em utils
    utils_files = ['senhas.py', 'exchange_bracket_updater.py', 'exchange_info_updater.py', 'session-login.py']
    
    # Pastas que devem estar em utils
    utils_folders = ['analysis', 'backtest']
    
    print(f"📁 Verificando estrutura em: {indicators_path}")
    
    # Verificar arquivos na raiz
    print("\n📋 Arquivos na raiz:")
    for file in root_files:
        file_path = indicators_path / file
        if file_path.exists():
            print(f"  ✅ {file}")
        else:
            print(f"  ❌ {file} - NÃO ENCONTRADO")
    
    # Verificar pasta utils
    utils_path = indicators_path / 'utils'
    if utils_path.exists():
        print(f"\n📁 Pasta utils encontrada: {utils_path}")
        
        # Verificar arquivos em utils
        print("\n📋 Arquivos em utils:")
        for file in utils_files:
            file_path = utils_path / file
            if file_path.exists():
                print(f"  ✅ {file}")
            else:
                print(f"  ❌ {file} - NÃO ENCONTRADO")
        
        # Verificar pastas em utils
        print("\n📁 Pastas em utils:")
        for folder in utils_folders:
            folder_path = utils_path / folder
            if folder_path.exists():
                print(f"  ✅ {folder}/")
            else:
                print(f"  ❌ {folder}/ - NÃO ENCONTRADO")
    else:
        print("  ❌ Pasta utils - NÃO ENCONTRADA")
    
    return True

def test_imports():
    """Testa se os imports estão funcionando"""
    print("\n🔍 Testando imports...")
    
    try:
        print("  📦 Testando import de divap_backtest...")
        import divap_backtest
        print("  ✅ divap_backtest importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar divap_backtest: {e}")
    
    try:
        print("  📦 Testando import de divap...")
        import divap
        print("  ✅ divap importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar divap: {e}")
    
    try:
        print("  📦 Testando import de utils.senhas...")
        from utils.senhas import pers_api_hash, pers_api_id
        print("  ✅ utils.senhas importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar utils.senhas: {e}")
    
    try:
        print("  📦 Testando import de utils.exchange_bracket_updater...")
        from utils.exchange_bracket_updater import update_leverage_brackets
        print("  ✅ utils.exchange_bracket_updater importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar utils.exchange_bracket_updater: {e}")
    
    try:
        print("  📦 Testando import de utils.exchange_info_updater...")
        from utils.exchange_info_updater import update_exchange_info_database
        print("  ✅ utils.exchange_info_updater importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar utils.exchange_info_updater: {e}")
    
    try:
        print("  📦 Testando import de utils.analysis.divap_check...")
        from utils.analysis.divap_check import DIVAPAnalyzer
        print("  ✅ utils.analysis.divap_check importado com sucesso")
    except Exception as e:
        print(f"  ❌ Erro ao importar utils.analysis.divap_check: {e}")
    
    return True

def main():
    """Função principal"""
    print("="*70)
    print("🔧 VALIDAÇÃO DA REORGANIZAÇÃO DA PASTA INDICATORS")
    print("="*70)
    
    test_structure()
    test_imports()
    
    print("\n" + "="*70)
    print("✅ VALIDAÇÃO CONCLUÍDA!")
    print("="*70)

if __name__ == "__main__":
    main()
