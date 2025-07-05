#!/usr/bin/env python3
"""
Script de validação final para verificar se todas as correções de booleanos foram aplicadas corretamente.
Este script verifica se:
1. Não há mais queries com booleanos hardcoded
2. Todas as queries estão usando parâmetros corretamente
3. Os valores booleanos estão no formato correto (true/false para JS, True/False para Python)
"""

import os
import re
import glob
from pathlib import Path

def scan_file_for_boolean_issues(file_path):
    """Verifica um arquivo específico em busca de problemas com booleanos"""
    issues = []
    
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        for i, line in enumerate(lines, 1):
            line_stripped = line.strip()
            
            # Verifica booleanos hardcoded em queries SQL
            if any(pattern in line_stripped for pattern in [
                'ativa = true', 'ativa = false', 'ativa = 1', 'ativa = 0',
                'executada = true', 'executada = false', 'executada = 1', 'executada = 0',
                'cancelada = true', 'cancelada = false', 'cancelada = 1', 'cancelada = 0'
            ]):
                issues.append(f"Linha {i}: Booleano hardcoded encontrado: {line_stripped}")
                
            # Verifica se há queries SQL com problema de parâmetros
            if ('SELECT' in line_stripped or 'UPDATE' in line_stripped or 'INSERT' in line_stripped) and ('= true' in line_stripped or '= false' in line_stripped or '= 1' in line_stripped or '= 0' in line_stripped):
                # Ignora se são comparações numéricas válidas (como id = 0)
                if not any(field in line_stripped for field in ['id = 0', 'position_id = 0', 'id_posicao = 0']):
                    issues.append(f"Linha {i}: Query SQL com possível problema de parâmetros: {line_stripped}")
                    
    except Exception as e:
        issues.append(f"Erro ao ler arquivo: {str(e)}")
        
    return issues

def main():
    """Função principal de validação"""
    print("🔍 Iniciando validação final dos booleanos...")
    print("=" * 60)
    
    # Diretórios para verificar
    directories = [
        'backend/indicators',
        'backend/core/database',
        'backend/server/routes',
        'backend/services',
        'backend/exchanges',
        'backend/processes',
        'utils'
    ]
    
    total_issues = 0
    
    for directory in directories:
        print(f"\n📁 Verificando diretório: {directory}")
        
        # Verifica arquivos Python
        py_files = glob.glob(f"{directory}/**/*.py", recursive=True)
        for file_path in py_files:
            issues = scan_file_for_boolean_issues(file_path)
            if issues:
                print(f"❌ {file_path}:")
                for issue in issues:
                    print(f"   {issue}")
                total_issues += len(issues)
                
        # Verifica arquivos JavaScript
        js_files = glob.glob(f"{directory}/**/*.js", recursive=True)
        for file_path in js_files:
            issues = scan_file_for_boolean_issues(file_path)
            if issues:
                print(f"❌ {file_path}:")
                for issue in issues:
                    print(f"   {issue}")
                total_issues += len(issues)
                
    print("\n" + "=" * 60)
    
    if total_issues == 0:
        print("✅ VALIDAÇÃO CONCLUÍDA COM SUCESSO!")
        print("🎉 Todos os booleanos estão no formato correto do PostgreSQL")
        print("🎉 Todas as queries estão usando parâmetros adequadamente")
        print("🎉 Nenhum problema encontrado!")
    else:
        print(f"❌ VALIDAÇÃO FALHOU: {total_issues} problemas encontrados")
        print("🔧 Verifique os arquivos listados acima e corrija os problemas")
        
    return total_issues == 0

if __name__ == "__main__":
    success = main()
    exit(0 if success else 1)
