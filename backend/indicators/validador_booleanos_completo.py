#!/usr/bin/env python3
"""
Validador Completo de Booleanos para PostgreSQL
Verifica se todos os valores booleanos estão corretos em operações de banco de dados
"""

import os
import re
import sys
from pathlib import Path

def scan_python_files(directory):
    """Escaneia todos os arquivos Python em busca de problemas com booleanos"""
    issues = []
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith('.py'):
                filepath = os.path.join(root, file)
                relative_path = os.path.relpath(filepath, directory)
                
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        content = f.read()
                        lines = content.split('\n')
                        
                        # Verificar problemas linha por linha
                        for i, line in enumerate(lines, 1):
                            line_issues = check_line_for_boolean_issues(line, relative_path, i)
                            issues.extend(line_issues)
                            
                except Exception as e:
                    print(f"Erro ao ler {relative_path}: {e}")
    
    return issues

def check_line_for_boolean_issues(line, filepath, line_number):
    """Verifica uma linha específica em busca de problemas com booleanos"""
    issues = []
    
    # Padrões problemáticos
    patterns = [
        # 1. Valores hardcoded no SQL
        (r'(INSERT INTO|UPDATE).*(true|false)', 'Valor booleano hardcoded em SQL'),
        (r'(INSERT INTO|UPDATE).*\b[01]\b', 'Valor numérico 0/1 em SQL (pode ser boolean)'),
        
        # 2. Comparações com strings
        (r'== ["\']true["\']', 'Comparação com string "true"'),
        (r'== ["\']false["\']', 'Comparação com string "false"'),
        
        # 3. Atribuições problemáticas
        (r'= ["\']true["\']', 'Atribuição de string "true" a variável'),
        (r'= ["\']false["\']', 'Atribuição de string "false" a variável'),
        
        # 4. Campos específicos que devem ser booleanos
        (r'(divap_confirmado|cancelado_checker|ativa|enabled|is_|has_).*= [01]', 'Campo booleano recebendo 0/1'),
        
        # 5. Parâmetros em queries
        (r'%s.*[01].*divap|divap.*[01].*%s', 'Possível valor 0/1 em parâmetro de query DIVAP'),
    ]
    
    for pattern, message in patterns:
        if re.search(pattern, line, re.IGNORECASE):
            # Ignorar comentários
            if line.strip().startswith('#'):
                continue
                
            issues.append({
                'file': filepath,
                'line': line_number,
                'content': line.strip(),
                'issue': message
            })
    
    return issues

def validate_sql_queries(directory):
    """Valida especificamente queries SQL em busca de problemas"""
    sql_issues = []
    
    for root, dirs, files in os.walk(directory):
        for file in files:
            if file.endswith('.py'):
                filepath = os.path.join(root, file)
                relative_path = os.path.relpath(filepath, directory)
                
                try:
                    with open(filepath, 'r', encoding='utf-8') as f:
                        content = f.read()
                        
                        # Procurar por queries SQL
                        sql_patterns = [
                            r'INSERT INTO.*VALUES.*\([^)]*\)',
                            r'UPDATE.*SET.*=.*',
                            r'cursor\.execute\([^)]*\)',
                        ]
                        
                        for pattern in sql_patterns:
                            matches = re.finditer(pattern, content, re.IGNORECASE | re.DOTALL)
                            for match in matches:
                                query = match.group(0)
                                
                                # Verificar se a query contém valores booleanos problemáticos
                                if re.search(r'\b(true|false)\b', query, re.IGNORECASE):
                                    line_number = content[:match.start()].count('\n') + 1
                                    sql_issues.append({
                                        'file': relative_path,
                                        'line': line_number,
                                        'query': query[:100] + '...' if len(query) > 100 else query,
                                        'issue': 'Query SQL com valores booleanos hardcoded'
                                    })
                                    
                except Exception as e:
                    print(f"Erro ao validar SQL em {relative_path}: {e}")
    
    return sql_issues

def main():
    print("🔍 VALIDADOR COMPLETO DE BOOLEANOS PARA POSTGRESQL")
    print("="*60)
    
    # Diretório atual
    current_dir = Path(__file__).parent
    
    # Escanear arquivos Python
    print("\n📋 Escaneando arquivos Python...")
    issues = scan_python_files(current_dir)
    
    # Validar queries SQL
    print("📋 Validando queries SQL...")
    sql_issues = validate_sql_queries(current_dir)
    
    # Exibir resultados
    print(f"\n📊 RESULTADOS:")
    print(f"   • Problemas gerais encontrados: {len(issues)}")
    print(f"   • Problemas em queries SQL: {len(sql_issues)}")
    
    if issues:
        print(f"\n⚠️ PROBLEMAS GERAIS:")
        for issue in issues:
            print(f"   📄 {issue['file']}:{issue['line']}")
            print(f"      🔍 {issue['issue']}")
            print(f"      📝 {issue['content']}")
            print()
    
    if sql_issues:
        print(f"\n⚠️ PROBLEMAS EM QUERIES SQL:")
        for issue in sql_issues:
            print(f"   📄 {issue['file']}:{issue['line']}")
            print(f"      🔍 {issue['issue']}")
            print(f"      📝 {issue['query']}")
            print()
    
    if not issues and not sql_issues:
        print(f"\n✅ Nenhum problema encontrado!")
        print(f"   Todos os valores booleanos parecem estar corretos.")
    else:
        print(f"\n❌ Encontrados {len(issues) + len(sql_issues)} problemas no total.")
        print(f"   Verifique os arquivos listados acima.")
    
    print("\n" + "="*60)
    print("🏁 Validação concluída.")

if __name__ == "__main__":
    main()
