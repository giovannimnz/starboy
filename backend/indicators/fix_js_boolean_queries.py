#!/usr/bin/env python3
"""
Script para corrigir automaticamente queries JavaScript com valores booleanos hardcoded
"""

import os
import re
import glob
from pathlib import Path

def fix_boolean_queries_in_file(file_path):
    """Corrige queries com valores booleanos hardcoded em um arquivo JavaScript"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        original_content = content
        changes_made = []
        
        # Padrões para correção
        patterns = [
            # WHERE ativa = true -> WHERE ativa = $n
            (
                r'(WHERE\s+[\w.]*ativa\s*=\s*)true(\s*[,\s\)}`])',
                lambda m, param_num: f'{m.group(1)}${param_num}{m.group(2)}'
            ),
            # WHERE ativa = false -> WHERE ativa = $n  
            (
                r'(WHERE\s+[\w.]*ativa\s*=\s*)false(\s*[,\s\)}`])',
                lambda m, param_num: f'{m.group(1)}${param_num}{m.group(2)}'
            ),
            # SET ativa = false -> SET ativa = $n
            (
                r'(SET\s+[\w.]*ativa\s*=\s*)false(\s*[,\s\)}`])',
                lambda m, param_num: f'{m.group(1)}${param_num}{m.group(2)}'
            ),
        ]
        
        # Aplicar correções
        for pattern, replacer in patterns:
            matches = list(re.finditer(pattern, content, re.IGNORECASE))
            
            for match in reversed(matches):  # Reverse para não afetar posições
                # Determinar o número do parâmetro
                before_match = content[:match.start()]
                existing_params = len(re.findall(r'\$\d+', before_match))
                param_num = existing_params + 1
                
                # Fazer a substituição
                replacement = replacer(match, param_num)
                content = content[:match.start()] + replacement + content[match.end():]
                
                # Registrar mudança
                changes_made.append({
                    'original': match.group(0),
                    'replacement': replacement,
                    'line': before_match.count('\n') + 1
                })
        
        # Salvar se houve mudanças
        if content != original_content:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
            return changes_made
        
        return []
        
    except Exception as e:
        print(f"Erro ao processar {file_path}: {e}")
        return []

def fix_all_javascript_files():
    """Corrige todos os arquivos JavaScript no backend"""
    backend_dir = Path(__file__).parent.parent
    
    # Encontrar todos os arquivos .js
    js_files = []
    for root, dirs, files in os.walk(backend_dir):
        for file in files:
            if file.endswith('.js'):
                js_files.append(os.path.join(root, file))
    
    total_changes = 0
    files_modified = 0
    
    print("🔧 CORRIGINDO QUERIES JAVASCRIPT COM VALORES BOOLEANOS HARDCODED")
    print("="*70)
    
    for js_file in js_files:
        relative_path = os.path.relpath(js_file, backend_dir)
        changes = fix_boolean_queries_in_file(js_file)
        
        if changes:
            files_modified += 1
            total_changes += len(changes)
            print(f"\n📄 {relative_path}")
            for change in changes:
                print(f"   Linha {change['line']}: {change['original']} -> {change['replacement']}")
    
    print(f"\n📊 RESUMO:")
    print(f"   📁 Arquivos verificados: {len(js_files)}")
    print(f"   📝 Arquivos modificados: {files_modified}")
    print(f"   🔧 Total de correções: {total_changes}")
    
    if total_changes > 0:
        print(f"\n⚠️  IMPORTANTE: Após as correções, você precisa:")
        print(f"   1. Revisar os parâmetros nas chamadas das queries")
        print(f"   2. Adicionar 'true' ou 'false' nos arrays de parâmetros")
        print(f"   3. Testar as funcionalidades afetadas")
    else:
        print(f"\n✅ Nenhuma correção necessária!")

if __name__ == "__main__":
    fix_all_javascript_files()
