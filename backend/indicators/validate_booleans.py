#!/usr/bin/env python3
"""
Script para validar o uso correto de valores booleanos em operações SQL.
Este script verifica se há valores booleanos hardcoded em queries SQL ou 
outros padrões que possam causar problemas com PostgreSQL.
"""

import os
import re
from pathlib import Path
from typing import List, Dict, Tuple

def find_boolean_issues(file_path: str) -> List[Dict]:
    """
    Encontra possíveis problemas com valores booleanos em um arquivo Python.
    
    Args:
        file_path: Caminho para o arquivo
        
    Returns:
        Lista de problemas encontrados
    """
    issues = []
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            lines = content.split('\n')
    except (FileNotFoundError, UnicodeDecodeError):
        return issues
    
    # Padrões problemáticos para encontrar
    patterns = [
        # SQL com valores booleanos hardcoded
        (r'SET\s+\w+\s*=\s*(true|false|TRUE|FALSE)\s*[,\s]', 'SQL com boolean hardcoded'),
        (r'VALUES\s*\([^)]*\b(true|false|TRUE|FALSE)\b[^)]*\)', 'INSERT com boolean hardcoded'),
        (r'WHERE\s+\w+\s*=\s*(true|false|TRUE|FALSE)', 'WHERE com boolean hardcoded'),
        
        # Possíveis conversões problemáticas
        (r'int\s*\(\s*True\s*\)', 'Conversão int(True)'),
        (r'int\s*\(\s*False\s*\)', 'Conversão int(False)'),
        (r'str\s*\(\s*True\s*\)', 'Conversão str(True)'),
        (r'str\s*\(\s*False\s*\)', 'Conversão str(False)'),
        
        # Strings com valores booleanos
        (r'["\']true["\']', 'String "true"'),
        (r'["\']false["\']', 'String "false"'),
        (r'["\']TRUE["\']', 'String "TRUE"'),
        (r'["\']FALSE["\']', 'String "FALSE"'),
        
        # Atribuições com 0/1 para campos que deveriam ser boolean
        (r'(divap_confirmado|cancelado_checker|is_\w+)\s*=\s*[01]', 'Atribuição 0/1 para campo boolean'),
    ]
    
    for line_num, line in enumerate(lines, 1):
        for pattern, description in patterns:
            matches = re.finditer(pattern, line, re.IGNORECASE)
            for match in matches:
                issues.append({
                    'file': file_path,
                    'line': line_num,
                    'column': match.start(),
                    'description': description,
                    'matched_text': match.group(0),
                    'full_line': line.strip()
                })
    
    return issues

def scan_directory(directory: str) -> List[Dict]:
    """
    Escaneia um diretório recursivamente em busca de problemas com booleanos.
    
    Args:
        directory: Diretório para escanear
        
    Returns:
        Lista de todos os problemas encontrados
    """
    all_issues = []
    
    for root, dirs, files in os.walk(directory):
        # Ignorar diretórios de cache e ambiente virtual
        dirs[:] = [d for d in dirs if not d.startswith('.') and d != '__pycache__']
        
        for file in files:
            if file.endswith('.py'):
                file_path = os.path.join(root, file)
                issues = find_boolean_issues(file_path)
                all_issues.extend(issues)
    
    return all_issues

def print_issues_report(issues: List[Dict]):
    """
    Imprime um relatório dos problemas encontrados.
    
    Args:
        issues: Lista de problemas
    """
    if not issues:
        print("✅ Nenhum problema com valores booleanos foi encontrado!")
        return
    
    print(f"⚠️  Encontrados {len(issues)} possíveis problemas com valores booleanos:")
    print("=" * 80)
    
    # Agrupar por arquivo
    by_file = {}
    for issue in issues:
        file_name = os.path.basename(issue['file'])
        if file_name not in by_file:
            by_file[file_name] = []
        by_file[file_name].append(issue)
    
    for file_name, file_issues in by_file.items():
        print(f"\n📄 {file_name}:")
        for issue in file_issues:
            print(f"  Linha {issue['line']}: {issue['description']}")
            print(f"    Texto: {issue['matched_text']}")
            print(f"    Contexto: {issue['full_line']}")
            print()

def generate_fixes_summary(issues: List[Dict]) -> Dict[str, int]:
    """
    Gera um resumo dos tipos de problemas encontrados.
    
    Args:
        issues: Lista de problemas
        
    Returns:
        Dicionário com contagem por tipo de problema
    """
    summary = {}
    for issue in issues:
        desc = issue['description']
        summary[desc] = summary.get(desc, 0) + 1
    
    return summary

def main():
    """
    Função principal do script de validação.
    """
    print("🔍 VALIDADOR DE VALORES BOOLEANOS PARA POSTGRESQL")
    print("=" * 60)
    
    # Diretório para escanear
    indicators_dir = Path(__file__).parent.parent / "indicators"
    
    if not indicators_dir.exists():
        print(f"❌ Diretório não encontrado: {indicators_dir}")
        return
    
    print(f"📁 Escaneando diretório: {indicators_dir}")
    print("   Procurando por problemas com valores booleanos...")
    
    # Escanear arquivos
    issues = scan_directory(str(indicators_dir))
    
    # Gerar relatório
    print_issues_report(issues)
    
    # Resumo por tipo de problema
    if issues:
        summary = generate_fixes_summary(issues)
        print("\n📊 RESUMO POR TIPO DE PROBLEMA:")
        print("-" * 40)
        for problem_type, count in sorted(summary.items()):
            print(f"  {problem_type}: {count}")
        
        print(f"\n📋 RECOMENDAÇÕES:")
        print("  1. Substitua valores booleanos hardcoded em SQL por parâmetros (%s)")
        print("  2. Use True/False do Python em vez de 'true'/'false' strings")
        print("  3. Evite conversões int(True)/int(False) - use valores boolean diretamente")
        print("  4. Para campos boolean, use True/False em vez de 1/0")
        print("  5. Use o validador boolean_validator.py para normalizar valores")
    
    print("\n✅ Validação concluída!")

if __name__ == "__main__":
    main()
