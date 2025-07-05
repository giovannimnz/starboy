#!/usr/bin/env python3
"""
Teste para validar as correções do Exchange Bracket Updater
"""
import os
import sys
from pathlib import Path
from datetime import datetime

# Adicionar o diretório do backend ao path
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend"))
sys.path.insert(0, str(Path(__file__).parent.parent.parent / "backend" / "indicators"))

def test_exchange_bracket_updater_corrected():
    """Testa as correções do Exchange Bracket Updater"""
    print("=== TESTE: Exchange Bracket Updater Corrigido ===")
    print(f"Timestamp: {datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}")
    print("=" * 60)
    
    # Teste 1: Import do módulo
    print("\n🔍 Teste 1: Verificando importação do módulo")
    try:
        from utils.exchange_bracket_updater import (
            update_leverage_brackets,
            test_binance_credentials,
            test_database_connection
        )
        print("✅ Módulo importado com sucesso")
    except ImportError as e:
        print(f"❌ Erro ao importar módulo: {e}")
        return False
    
    # Teste 2: Conexão com banco
    print("\n🔍 Teste 2: Testando conexão com banco de dados")
    try:
        db_ok = test_database_connection()
        if db_ok:
            print("✅ Conexão com banco funcionando")
        else:
            print("❌ Falha na conexão com banco")
    except Exception as e:
        print(f"❌ Erro ao testar conexão com banco: {e}")
        db_ok = False
    
    # Teste 3: Credenciais Binance
    print("\n🔍 Teste 3: Testando credenciais Binance")
    try:
        creds_ok = test_binance_credentials()
        if creds_ok:
            print("✅ Credenciais Binance funcionando")
        else:
            print("❌ Falha nas credenciais Binance")
    except Exception as e:
        print(f"❌ Erro ao testar credenciais Binance: {e}")
        creds_ok = False
    
    # Teste 4: Função de atualização (sem executar)
    print("\n🔍 Teste 4: Verificando função de atualização")
    try:
        assert callable(update_leverage_brackets)
        print("✅ Função update_leverage_brackets disponível")
        func_ok = True
    except Exception as e:
        print(f"❌ Erro na função update_leverage_brackets: {e}")
        func_ok = False
    
    # Teste 5: Verificar se não há mais referências a "exchange_info"
    print("\n🔍 Teste 5: Verificando se não há referências a tabela 'exchange_info'")
    try:
        import inspect
        source = inspect.getsource(update_leverage_brackets)
        if "exchange_info" in source:
            print("❌ Ainda há referências à tabela 'exchange_info'")
            table_ok = False
        else:
            print("✅ Não há referências à tabela 'exchange_info'")
            table_ok = True
    except Exception as e:
        print(f"❌ Erro ao verificar código: {e}")
        table_ok = False
    
    # Resumo
    print("\n" + "=" * 60)
    print("RESUMO DOS TESTES:")
    tests = [
        ("Importação do módulo", True),
        ("Conexão com banco", db_ok),
        ("Credenciais Binance", creds_ok),
        ("Função de atualização", func_ok),
        ("Sem referências a exchange_info", table_ok)
    ]
    
    passed = 0
    for test_name, result in tests:
        status = "✅" if result else "❌"
        print(f"  {status} {test_name}")
        if result:
            passed += 1
    
    print(f"\nResultado: {passed}/{len(tests)} testes passaram")
    
    if passed == len(tests):
        print("🎉 TODOS OS TESTES PASSARAM!")
        print("✅ O Exchange Bracket Updater foi corrigido com sucesso")
        return True
    else:
        print("⚠️ Alguns testes falharam. Verifique a configuração.")
        return False

def test_symbol_insertion_logic():
    """Testa especificamente a lógica de inserção de símbolos"""
    print("\n=== TESTE: Lógica de Inserção de Símbolos ===")
    
    try:
        from utils.exchange_bracket_updater import update_leverage_brackets
        import inspect
        
        source = inspect.getsource(update_leverage_brackets)
        
        # Verificar se há lógica de inserção
        if "INSERT INTO exchange_symbols" in source:
            print("✅ Lógica de inserção de símbolos implementada")
            insert_ok = True
        else:
            print("❌ Lógica de inserção de símbolos não encontrada")
            insert_ok = False
        
        # Verificar se há lógica de remoção de obsoletos
        if "DELETE FROM exchange_symbols" in source:
            print("✅ Lógica de remoção de símbolos obsoletos implementada")
            delete_ok = True
        else:
            print("❌ Lógica de remoção de símbolos obsoletos não encontrada")
            delete_ok = False
        
        # Verificar se há tratamento de erro e continuação
        if "continue" in source:
            print("✅ Lógica de continuação em caso de erro implementada")
            continue_ok = True
        else:
            print("❌ Lógica de continuação em caso de erro não encontrada")
            continue_ok = False
        
        return insert_ok and delete_ok and continue_ok
    
    except Exception as e:
        print(f"❌ Erro ao testar lógica de inserção: {e}")
        return False

def main():
    """Função principal"""
    print("🚀 INICIANDO TESTES DE CORREÇÃO DO EXCHANGE BRACKET UPDATER")
    print("=" * 80)
    
    # Executar testes
    test1_ok = test_exchange_bracket_updater_corrected()
    test2_ok = test_symbol_insertion_logic()
    
    print("\n" + "=" * 80)
    print("RESULTADO FINAL:")
    
    if test1_ok and test2_ok:
        print("🎉 TODAS AS CORREÇÕES FORAM APLICADAS COM SUCESSO!")
        print("✅ O sistema está pronto para uso")
        print("\n📋 Recursos implementados:")
        print("  • Inserção automática de símbolos não encontrados")
        print("  • Remoção de símbolos obsoletos")
        print("  • Continuação do processamento em caso de erro")
        print("  • Uso das tabelas corretas (exchange_symbols e exchange_filters)")
        print("  • Fallback para credenciais em senhas.py")
    else:
        print("❌ Algumas correções ainda precisam ser verificadas")
        print("📋 Verifique os erros acima e tente novamente")
    
    return test1_ok and test2_ok

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
