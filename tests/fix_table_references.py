#!/usr/bin/env python3
"""
Script para corrigir as referências antigas nos testes
Atualizar referências de:
- divap_analysis -> signals_analysis
- signals_backtest -> backtest_signals
"""

import os
import re
from pathlib import Path

# Mapeamento das tabelas antigas para as novas
TABLE_MAPPINGS = {
    'divap_analysis': 'signals_analysis',
    'signals_backtest': 'backtest_signals'
}

def update_file_references(file_path, mappings):
    """Atualiza as referências de tabelas em um arquivo"""
    with open(file_path, 'r', encoding='utf-8') as f:
        content = f.read()
    
    original_content = content
    
    # Substituir referências às tabelas
    for old_table, new_table in mappings.items():
        # Substituir referências diretas
        content = re.sub(r'\b' + old_table + r'\b', new_table, content)
        
        # Substituir em comentários e strings
        content = content.replace(f'"{old_table}"', f'"{new_table}"')
        content = content.replace(f"'{old_table}'", f"'{new_table}'")
        
        # Substituir em nomes de funções/métodos
        content = content.replace(f'test_{old_table}', f'test_{new_table}')
        content = content.replace(f'TESTE_{old_table.upper()}', f'TESTE_{new_table.upper()}')
    
    # Verificar se houve mudanças
    if content != original_content:
        with open(file_path, 'w', encoding='utf-8') as f:
            f.write(content)
        return True
    return False

def main():
    print("=== CORRIGINDO REFERÊNCIAS DE TABELAS NOS TESTES ===")
    print()
    
    # Diretório de testes
    test_dir = Path(__file__).parent
    backend_test_dir = test_dir.parent / 'backend' / 'tests'
    
    # Padrões de arquivos para verificar
    patterns = ['*.py', '*.md']
    
    updated_files = []
    
    # Processar arquivos no diretório de testes atual
    for pattern in patterns:
        for file_path in test_dir.glob(pattern):
            if file_path.name != Path(__file__).name:  # Não processar este próprio arquivo
                if update_file_references(file_path, TABLE_MAPPINGS):
                    updated_files.append(str(file_path))
                    print(f"✅ Atualizado: {file_path}")
    
    # Processar arquivos no diretório de testes do backend
    if backend_test_dir.exists():
        for pattern in patterns:
            for file_path in backend_test_dir.rglob(pattern):
                if update_file_references(file_path, TABLE_MAPPINGS):
                    updated_files.append(str(file_path))
                    print(f"✅ Atualizado: {file_path}")
    
    print()
    print(f"Total de arquivos atualizados: {len(updated_files)}")
    
    if updated_files:
        print("\nArquivos modificados:")
        for file_path in updated_files:
            print(f"  - {file_path}")
    else:
        print("Nenhum arquivo precisou ser atualizado.")

if __name__ == "__main__":
    main()
