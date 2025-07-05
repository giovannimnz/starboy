#!/usr/bin/env python3
"""
Teste simples para verificar se as correções de booleanos estão funcionando
"""

import sys
import os
from pathlib import Path

# Adicionar path
sys.path.append(str(Path(__file__).parent))

def test_boolean_validator():
    """Testa o validador de booleanos"""
    print("🧪 Testando validador de booleanos...")
    
    try:
        # Importar validador
        from utils.boolean_validator import validate_webhook_signals_data, normalize_boolean
        
        # Testar normalização
        test_cases = [
            ('true', True),
            ('false', False),
            ('True', True),
            ('False', False),
            (1, True),
            (0, False),
            ('1', True),
            ('0', False),
            (True, True),
            (False, False),
        ]
        
        print("📝 Testando normalização de booleanos:")
        for input_val, expected in test_cases:
            result = normalize_boolean(input_val)
            status = "✅" if result == expected else "❌"
            print(f"   {status} {input_val} -> {result} (esperado: {expected})")
        
        # Testar validação de dados
        print("\n📝 Testando validação de dados webhook_signals:")
        test_data = {
            'divap_confirmado': 'true',
            'cancelado_checker': 0,
            'ativa': 1,
            'enabled': 'false'
        }
        
        validated = validate_webhook_signals_data(test_data)
        print(f"   Dados originais: {test_data}")
        print(f"   Dados validados: {validated}")
        
        # Verificar se os valores foram normalizados corretamente
        expected_values = {
            'divap_confirmado': True,
            'cancelado_checker': False,
            'ativa': True,
            'enabled': False
        }
        
        all_correct = True
        for key, expected_val in expected_values.items():
            if validated.get(key) != expected_val:
                print(f"   ❌ {key}: {validated.get(key)} != {expected_val}")
                all_correct = False
        
        if all_correct:
            print("   ✅ Todos os valores foram normalizados corretamente!")
        
        return True
        
    except Exception as e:
        print(f"❌ Erro no teste: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    print("🚀 TESTE SIMPLES DE VALIDAÇÃO DE BOOLEANOS")
    print("="*50)
    
    success = test_boolean_validator()
    
    if success:
        print("\n✅ TESTE PASSOU!")
        print("   O validador de booleanos está funcionando corretamente")
    else:
        print("\n❌ TESTE FALHOU!")
        print("   Há problemas com o validador de booleanos")
    
    print("="*50)

if __name__ == "__main__":
    main()
