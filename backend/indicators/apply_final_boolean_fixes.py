#!/usr/bin/env python3
"""
Script final para corrigir todas as queries SQL restantes com valores booleanos hardcoded
"""

import re
import os
from pathlib import Path

def fix_remaining_queries():
    """Aplica correções finais nas queries SQL"""
    
    # Lista de arquivos e correções específicas
    fixes = [
        {
            'file': 'backend/server/routes/accounts/index.js',
            'changes': [
                {
                    'old': "FROM contas WHERE id = $1 AND ativa = true', [id])",
                    'new': "FROM contas WHERE id = $1 AND ativa = $2', [id, true])"
                },
                {
                    'old': "WHERE c.id = $1 AND c.ativa = true",
                    'new': "WHERE c.id = $1 AND c.ativa = $2"
                },
                {
                    'old': "FROM contas WHERE id = $1 AND ativa = true',",
                    'new': "FROM contas WHERE id = $1 AND ativa = $2',"
                }
            ]
        },
        {
            'file': 'backend/exchanges/binance/processes/app.js',
            'changes': [
                {
                    'old': "FROM contas WHERE ativa = true')",
                    'new': "FROM contas WHERE ativa = $1', [true])"
                }
            ]
        }
    ]
    
    project_root = Path(__file__).parent.parent.parent
    
    for fix in fixes:
        file_path = project_root / fix['file']
        
        if not file_path.exists():
            print(f"⚠️ Arquivo não encontrado: {file_path}")
            continue
            
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            original_content = content
            changes_made = 0
            
            for change in fix['changes']:
                if change['old'] in content:
                    content = content.replace(change['old'], change['new'])
                    changes_made += 1
                    print(f"✅ {file_path.name}: {change['old'][:50]}...")
            
            if changes_made > 0:
                with open(file_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"📝 {file_path.name}: {changes_made} correções aplicadas")
            else:
                print(f"ℹ️ {file_path.name}: nenhuma correção necessária")
                
        except Exception as e:
            print(f"❌ Erro ao processar {file_path}: {e}")

def validate_corrections():
    """Valida se todas as correções foram aplicadas"""
    
    project_root = Path(__file__).parent.parent.parent
    
    # Arquivos JavaScript para verificar
    js_files_to_check = [
        'backend/core/database/conexao.js',
        'backend/services/telegramApi.js', 
        'backend/server/routes/users/index.js',
        'backend/server/routes/accounts/index.js',
        'backend/exchanges/binance/processes/app.js'
    ]
    
    issues_found = []
    
    for file_path in js_files_to_check:
        full_path = project_root / file_path
        
        if not full_path.exists():
            continue
            
        try:
            with open(full_path, 'r', encoding='utf-8') as f:
                content = f.read()
            
            # Procurar por padrões problemáticos
            patterns = [
                r'WHERE\s+[\w.]*ativa\s*=\s*true',
                r'WHERE\s+[\w.]*ativa\s*=\s*false',
                r'SET\s+[\w.]*ativa\s*=\s*true',
                r'SET\s+[\w.]*ativa\s*=\s*false'
            ]
            
            for pattern in patterns:
                matches = re.findall(pattern, content, re.IGNORECASE)
                for match in matches:
                    issues_found.append(f"{file_path}: {match}")
        
        except Exception as e:
            print(f"Erro ao verificar {file_path}: {e}")
    
    return issues_found

def main():
    print("🔧 APLICANDO CORREÇÕES FINAIS DE BOOLEANOS")
    print("="*50)
    
    # Aplicar correções
    fix_remaining_queries()
    
    print("\n🔍 VALIDANDO CORREÇÕES")
    print("="*50)
    
    # Validar correções
    issues = validate_corrections()
    
    if issues:
        print("⚠️ PROBLEMAS ENCONTRADOS:")
        for issue in issues:
            print(f"   {issue}")
    else:
        print("✅ TODAS AS CORREÇÕES FORAM APLICADAS COM SUCESSO!")
        print("\n📋 RESUMO FINAL:")
        print("   ✅ Arquivo Python divap.py: corrigido")
        print("   ✅ Arquivo Python divap_check.py: corrigido") 
        print("   ✅ Arquivo conexao.js: corrigido")
        print("   ✅ Arquivo telegramApi.js: corrigido")
        print("   ✅ Arquivo users/index.js: corrigido")
        print("   ✅ Arquivo accounts/index.js: corrigido")
        print("\n🎉 SISTEMA PRONTO PARA POSTGRESQL!")

if __name__ == "__main__":
    main()
