#!/usr/bin/env python3
"""
Script para auditar o uso de RETURNING id em todo o backend
e verificar se há acessos incorretos ao resultado.
"""

import os
import re
import glob
from typing import List, Dict, Tuple

def find_returning_id_usage(directory: str) -> List[Dict]:
    """
    Encontra todos os arquivos que usam RETURNING id e verifica o acesso ao resultado.
    """
    results = []
    
    # Buscar arquivos Python
    pattern = os.path.join(directory, "**", "*.py")
    python_files = glob.glob(pattern, recursive=True)
    
    for file_path in python_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                lines = content.split('\n')
                
                # Verificar se tem RETURNING id
                returning_id_lines = []
                for i, line in enumerate(lines):
                    if 'RETURNING id' in line:
                        returning_id_lines.append(i + 1)
                
                if returning_id_lines:
                    # Verificar acesso ao resultado nas próximas linhas
                    issues = []
                    for line_num in returning_id_lines:
                        # Procurar nas próximas 10 linhas por acessos problemáticos
                        for j in range(line_num, min(line_num + 10, len(lines))):
                            line = lines[j]
                            
                            # Verificar padrões problemáticos
                            if 'result[0]' in line and 'fetchone()' in lines[j-1:j+2]:
                                issues.append({
                                    'line': j + 1,
                                    'code': line.strip(),
                                    'issue': 'Acesso result[0] após fetchone() - deveria ser result[\'id\']'
                                })
                            elif 'cursor.lastrowid' in line:
                                issues.append({
                                    'line': j + 1,
                                    'code': line.strip(),
                                    'issue': 'Uso de cursor.lastrowid - não funciona com RETURNING id'
                                })
                    
                    results.append({
                        'file': file_path,
                        'returning_id_lines': returning_id_lines,
                        'issues': issues
                    })
                    
        except Exception as e:
            print(f"❌ Erro ao processar {file_path}: {e}")
    
    return results

def print_audit_report(results: List[Dict]):
    """
    Imprime relatório de auditoria.
    """
    print("="*80)
    print("🔍 RELATÓRIO DE AUDITORIA - RETURNING ID")
    print("="*80)
    
    total_files = len(results)
    files_with_issues = sum(1 for r in results if r['issues'])
    
    print(f"📊 RESUMO:")
    print(f"   • Arquivos com RETURNING id: {total_files}")
    print(f"   • Arquivos com problemas: {files_with_issues}")
    print()
    
    if files_with_issues == 0:
        print("✅ Nenhum problema encontrado!")
        return
    
    print("❌ PROBLEMAS ENCONTRADOS:")
    print()
    
    for result in results:
        if result['issues']:
            print(f"📁 {result['file']}")
            print(f"   RETURNING id nas linhas: {result['returning_id_lines']}")
            for issue in result['issues']:
                print(f"   ❌ Linha {issue['line']}: {issue['issue']}")
                print(f"      Código: {issue['code']}")
            print()

def main():
    """
    Executa auditoria completa do backend.
    """
    backend_dir = os.path.join(os.path.dirname(__file__), '..')
    
    print("🔍 Iniciando auditoria de RETURNING id...")
    print(f"📁 Diretório: {backend_dir}")
    print()
    
    results = find_returning_id_usage(backend_dir)
    print_audit_report(results)
    
    # Verificar arquivos específicos mencionados nos logs
    print("\n" + "="*80)
    print("🎯 VERIFICAÇÃO ESPECÍFICA - ARQUIVOS MENCIONADOS")
    print("="*80)
    
    specific_files = [
        'exchange_info_updater.py',
        'divap.py',
        'divap_backtest.py'
    ]
    
    for filename in specific_files:
        file_results = [r for r in results if filename in r['file']]
        if file_results:
            for result in file_results:
                print(f"📁 {filename}:")
                if result['issues']:
                    print(f"   ❌ {len(result['issues'])} problema(s) encontrado(s)")
                    for issue in result['issues']:
                        print(f"      • Linha {issue['line']}: {issue['issue']}")
                else:
                    print(f"   ✅ Sem problemas")
        else:
            print(f"📁 {filename}: Não encontrado ou sem RETURNING id")
    
    print("\n" + "="*80)
    print("🔍 AUDITORIA CONCLUÍDA")
    print("="*80)

if __name__ == "__main__":
    main()
