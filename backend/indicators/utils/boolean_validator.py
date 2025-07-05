"""
Validador de booleanos para dados de webhook
"""

def validate_webhook_signals_data(data):
    """
    Valida dados de webhook signals
    
    Args:
        data: Dados a serem validados
        
    Returns:
        dict: Dados validados
    """
    if not isinstance(data, dict):
        return data
    
    # Aplicar normalização de booleanos
    validated_data = {}
    for key, value in data.items():
        if isinstance(value, str) and value.lower() in ['true', 'false']:
            validated_data[key] = normalize_boolean(value)
        else:
            validated_data[key] = value
    
    return validated_data

def normalize_boolean(value):
    """
    Normaliza valores booleanos
    
    Args:
        value: Valor a ser normalizado
        
    Returns:
        bool: Valor booleano normalizado
    """
    if isinstance(value, bool):
        return value
    
    if isinstance(value, str):
        return value.lower() in ['true', '1', 'yes', 'on']
    
    if isinstance(value, (int, float)):
        return bool(value)
    
    return False
