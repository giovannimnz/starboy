"""
Utilitário para validação e normalização de valores booleanos para PostgreSQL.

Este módulo garante que todos os valores booleanos sejam tratados corretamente
quando enviados para o banco de dados PostgreSQL.
"""

import logging
from typing import Any, Union, Optional

logger = logging.getLogger(__name__)

def normalize_boolean(value: Any) -> Optional[bool]:
    """
    Normaliza um valor para boolean Python (True/False) ou None.
    
    Args:
        value: Valor a ser normalizado
        
    Returns:
        bool ou None: Valor normalizado
    """
    if value is None:
        return None
    
    if isinstance(value, bool):
        return value
    
    if isinstance(value, (int, float)):
        return bool(value)
    
    if isinstance(value, str):
        value_lower = value.lower().strip()
        if value_lower in ('true', '1', 'yes', 'sim', 'y', 's'):
            return True
        elif value_lower in ('false', '0', 'no', 'não', 'n'):
            return False
        else:
            logger.warning(f"Valor string não reconhecido para boolean: '{value}' - retornando False")
            return False
    
    logger.warning(f"Tipo não suportado para normalização boolean: {type(value)} - retornando False")
    return False

def validate_boolean_fields(data: dict, required_fields: list = None, optional_fields: list = None) -> dict:
    """
    Valida e normaliza campos booleanos em um dicionário.
    
    Args:
        data: Dicionário com os dados
        required_fields: Lista de campos obrigatórios que devem ser boolean
        optional_fields: Lista de campos opcionais que podem ser boolean ou None
        
    Returns:
        dict: Dicionário com campos normalizados
    """
    normalized_data = data.copy()
    
    # Processar campos obrigatórios
    if required_fields:
        for field in required_fields:
            if field in normalized_data:
                normalized_data[field] = normalize_boolean(normalized_data[field])
                if normalized_data[field] is None:
                    logger.warning(f"Campo obrigatório '{field}' resultou em None - definindo como False")
                    normalized_data[field] = False
            else:
                logger.warning(f"Campo obrigatório '{field}' não encontrado - definindo como False")
                normalized_data[field] = False
    
    # Processar campos opcionais
    if optional_fields:
        for field in optional_fields:
            if field in normalized_data:
                normalized_data[field] = normalize_boolean(normalized_data[field])
    
    return normalized_data

def validate_webhook_signals_data(data: dict) -> dict:
    """
    Valida especificamente os dados para a tabela webhook_signals.
    
    Args:
        data: Dados do webhook signal
        
    Returns:
        dict: Dados validados
    """
    boolean_fields = [
        'divap_confirmado',
        'cancelado_checker'
    ]
    
    return validate_boolean_fields(data, optional_fields=boolean_fields)

def validate_signals_analysis_data(data: dict) -> dict:
    """
    Valida especificamente os dados para a tabela signals_analysis.
    
    Args:
        data: Dados da análise DIVAP
        
    Returns:
        dict: Dados validados
    """
    boolean_fields = [
        'is_bull_divap',
        'is_bear_divap',
        'divap_confirmed',
        'high_volume',
        'bull_div',
        'bear_div',
        'bull_reversal_pattern',
        'bear_reversal_pattern'
    ]
    
    return validate_boolean_fields(data, optional_fields=boolean_fields)

# Manter função antiga para compatibilidade
def validate_divap_analysis_data(data: dict) -> dict:
    """
    Função de compatibilidade que chama validate_signals_analysis_data.
    DEPRECATED: Use validate_signals_analysis_data em vez disso.
    """
    return validate_signals_analysis_data(data)

def validate_sql_boolean_params(params: tuple) -> tuple:
    """
    Valida e normaliza parâmetros booleanos em uma tupla de parâmetros SQL.
    
    Args:
        params: Tupla de parâmetros para SQL
        
    Returns:
        tuple: Tupla com parâmetros normalizados
    """
    normalized_params = []
    
    for param in params:
        if isinstance(param, bool):
            normalized_params.append(param)
        elif param is None:
            normalized_params.append(None)
        else:
            # Tentar normalizar se parecer ser um valor boolean
            str_param = str(param).lower().strip()
            if str_param in ('true', 'false', '1', '0'):
                normalized_params.append(normalize_boolean(param))
            else:
                normalized_params.append(param)
    
    return tuple(normalized_params)

# Constantes para campos booleanos conhecidos do sistema
WEBHOOK_SIGNALS_BOOLEAN_FIELDS = [
    'divap_confirmado',
    'cancelado_checker'
]

DIVAP_ANALYSIS_BOOLEAN_FIELDS = [
    'is_bull_divap',
    'is_bear_divap',
    'divap_confirmed',
    'high_volume',
    'bull_div',
    'bear_div',
    'bull_reversal_pattern',
    'bear_reversal_pattern'
]

EXCHANGE_SYMBOLS_BOOLEAN_FIELDS = [
    'status'  # Se for usado como boolean
]

def log_boolean_validation_error(field_name: str, original_value: Any, normalized_value: Any):
    """
    Registra um erro de validação de campo booleano.
    
    Args:
        field_name: Nome do campo
        original_value: Valor original
        normalized_value: Valor normalizado
    """
    logger.error(
        f"Validação boolean para campo '{field_name}': "
        f"'{original_value}' ({type(original_value).__name__}) -> "
        f"'{normalized_value}' ({type(normalized_value).__name__})"
    )

def test_boolean_validator():
    """
    Testa o validador de booleanos com diferentes tipos de entrada.
    """
    print("=== TESTE DO VALIDADOR DE BOOLEANOS ===")
    
    test_cases = [
        # (input, expected_output)
        (True, True),
        (False, False),
        (1, True),
        (0, False),
        ("true", True),
        ("false", False),
        ("TRUE", True),
        ("FALSE", False),
        ("1", True),
        ("0", False),
        ("yes", True),
        ("no", False),
        ("sim", True),
        ("não", False),
        (None, None),
        ("", False),
        ("invalid", False),
        ([], False),
        ({}, False),
    ]
    
    for input_val, expected in test_cases:
        result = normalize_boolean(input_val)
        status = "✅" if result == expected else "❌"
        print(f"{status} {input_val} ({type(input_val).__name__}) -> {result} (esperado: {expected})")
    
    print("\n=== TESTE DE VALIDAÇÃO DE WEBHOOK SIGNALS ===")
    
    test_data = {
        'symbol': 'BTCUSDT',
        'side': 'BUY',
        'divap_confirmado': "true",
        'cancelado_checker': 0,
        'other_field': 'value'
    }
    
    validated = validate_webhook_signals_data(test_data)
    print(f"Dados originais: {test_data}")
    print(f"Dados validados: {validated}")
    
    print("\n=== TESTE CONCLUÍDO ===")

if __name__ == "__main__":
    test_boolean_validator()
