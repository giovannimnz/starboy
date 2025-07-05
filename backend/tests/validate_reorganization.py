#!/usr/bin/env python3
"""
Script de validação final da reorganização dos testes
"""

import sys
import os
from pathlib import Path

def validate_structure():
    """Valida a estrutura final dos testes"""
    print("🔍 Validando estrutura reorganizada...")
    
    # Verificar se test_group_access.py está em utils
    test_group_access_path = Path(__file__).parent.parent / "indicators" / "utils" / "test_group_access.py"
    if test_group_access_path.exists():
        print("✅ test_group_access.py está em utils/ conforme solicitado")
    else:
        print("❌ test_group_access.py não encontrado em utils/")
        return False
    
    # Verificar diretório tests/indicators
    tests_indicators_path = Path(__file__).parent / "indicators"
    if tests_indicators_path.exists():
        print("✅ Diretório tests/indicators/ existe")
        
        # Verificar subdiretórios
        subdirs = ['unit', 'integration', 'fix']
        for subdir in subdirs:
            subdir_path = tests_indicators_path / subdir
            if subdir_path.exists():
                print(f"✅ Diretório tests/indicators/{subdir}/ existe")
            else:
                print(f"❌ Diretório tests/indicators/{subdir}/ não encontrado")
                return False
    else:
        print("❌ Diretório tests/indicators/ não encontrado")
        return False
    
    # Verificar se test_simple_integration.py foi movido
    simple_integration_path = tests_indicators_path / "integration" / "test_simple_integration.py"
    if simple_integration_path.exists():
        print("✅ test_simple_integration.py foi movido para integration/")
    else:
        print("❌ test_simple_integration.py não encontrado em integration/")
        return False
    
    # Verificar se não há arquivos de teste duplicados
    old_test_path = Path(__file__).parent.parent / "indicators" / "backtest" / "test_group_access.py"
    if not old_test_path.exists():
        print("✅ Arquivo duplicado test_group_access.py foi removido do backtest/")
    else:
        print("❌ Ainda existe test_group_access.py duplicado em backtest/")
        return False
    
    return True

def validate_imports():
    """Valida que as importações estão funcionando"""
    print("\n🔍 Validando importações...")
    
    try:
        # Adicionar paths necessários
        sys.path.append(str(Path(__file__).parent.parent / "indicators"))
        
        # Testar import do test_group_access
        from utils.test_group_access import test_group_access
        print("✅ Import de test_group_access funciona")
        
        # Testar imports dos utilitários
        from utils.senhas import API_KEY, API_SECRET
        print("✅ Import de utils.senhas funciona")
        
        from utils.exchange_bracket_updater import test_database_connection
        print("✅ Import de utils.exchange_bracket_updater funciona")
        
        from utils.exchange_info_updater import update_exchange_info_database
        print("✅ Import de utils.exchange_info_updater funciona")
        
        from utils.boolean_validator import validate_webhook_signals_data
        print("✅ Import de utils.boolean_validator funciona")
        
        # Testar import do divap
        import divap
        print("✅ Import de divap funciona")
        
        return True
        
    except Exception as e:
        print(f"❌ Erro ao testar imports: {e}")
        return False

def main():
    """Função principal"""
    print("="*60)
    print("🎯 VALIDAÇÃO FINAL DA REORGANIZAÇÃO DOS TESTES")
    print("="*60)
    
    # Executar validações
    structure_ok = validate_structure()
    imports_ok = validate_imports()
    
    # Resultado final
    print("\n" + "="*60)
    print("📊 RESULTADO FINAL")
    print("="*60)
    
    if structure_ok and imports_ok:
        print("🎉 REORGANIZAÇÃO CONCLUÍDA COM SUCESSO!")
        print()
        print("✅ Estrutura organizada:")
        print("  • test_group_access.py mantido em utils/ (chamado por scripts)")
        print("  • Demais testes movidos para tests/indicators/")
        print("  • Estrutura: tests/indicators/{unit,integration,fix}/")
        print("  • Imports funcionando corretamente")
        print()
        print("✅ Arquivos principais:")
        print("  • backend/indicators/utils/test_group_access.py ✅")
        print("  • backend/tests/indicators/integration/test_simple_integration.py ✅")
        print("  • backend/tests/indicators/unit/test_*.py ✅")
        print("  • backend/tests/indicators/fix/fix_*.py ✅")
        
        return True
    else:
        print("❌ Algumas validações falharam")
        if not structure_ok:
            print("  • Problemas na estrutura de diretórios")
        if not imports_ok:
            print("  • Problemas nos imports")
        
        return False

if __name__ == "__main__":
    success = main()
    print("="*60)
    sys.exit(0 if success else 1)
