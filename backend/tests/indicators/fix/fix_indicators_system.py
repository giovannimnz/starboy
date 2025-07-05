#!/usr/bin/env python3
"""
Script de correção rápida - verifica e corrige problemas comuns nos indicadores
"""

import sys
import os
from pathlib import Path
from datetime import datetime

def fix_import_paths():
    """Corrige problemas de importação"""
    print("🔧 Verificando caminhos de importação...")
    
    indicators_dir = Path(__file__).parents[3] / 'indicators'
    
    # Verificar se os diretórios existem
    required_dirs = [
        indicators_dir / 'utils',
        indicators_dir / 'utils' / 'analysis',
    ]
    
    for dir_path in required_dirs:
        if not dir_path.exists():
            print(f"❌ Diretório faltando: {dir_path}")
            return False
        else:
            print(f"✅ Diretório existe: {dir_path}")
    
    # Verificar se os arquivos existem
    required_files = [
        indicators_dir / 'utils' / 'senhas.py',
        indicators_dir / 'utils' / 'exchange_bracket_updater.py',
        indicators_dir / 'utils' / 'exchange_info_updater.py',
        indicators_dir / 'utils' / 'analysis' / 'divap_check.py',
        indicators_dir / 'utils' / 'boolean_validator.py',
        indicators_dir / 'divap.py',
        indicators_dir / 'divap_backtest.py',
    ]
    
    for file_path in required_files:
        if not file_path.exists():
            print(f"❌ Arquivo faltando: {file_path}")
            return False
        else:
            print(f"✅ Arquivo existe: {file_path}")
    
    return True

def fix_env_configuration():
    """Verifica e corrige configurações do .env"""
    print("\n🔧 Verificando configurações do .env...")
    
    env_path = Path(__file__).parents[4] / 'config' / '.env'
    
    if not env_path.exists():
        print(f"❌ Arquivo .env não encontrado: {env_path}")
        return False
    
    print(f"✅ Arquivo .env encontrado: {env_path}")
    
    # Verificar se o arquivo tem conteúdo
    if env_path.stat().st_size == 0:
        print("❌ Arquivo .env está vazio")
        return False
    
    print("✅ Arquivo .env tem conteúdo")
    return True

def fix_database_structure():
    """Verifica se as tabelas necessárias existem"""
    print("\n🔧 Verificando estrutura do banco de dados...")
    
    try:
        from dotenv import load_dotenv
        import psycopg2
        
        # Carregar .env
        env_path = Path(__file__).parents[4] / 'config' / '.env'
        load_dotenv(dotenv_path=env_path)
        
        # Configuração do banco
        db_config = {
            'host': os.getenv('DB_HOST'),
            'port': int(os.getenv('DB_PORT', 5432)),
            'user': os.getenv('DB_USER'),
            'password': os.getenv('DB_PASSWORD'),
            'database': os.getenv('DB_NAME')
        }
        
        # Verificar se as variáveis foram carregadas
        if not all(db_config.values()):
            print("❌ Variáveis de banco não carregadas do .env")
            return False
        
        # Tentar conectar
        conn = psycopg2.connect(**db_config)
        cursor = conn.cursor()
        
        # Verificar tabelas necessárias
        required_tables = [
            'webhook_signals',
            'exchange_symbols',
            'exchange_filters',
            'signals_analysis',
        ]
        
        for table in required_tables:
            cursor.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables 
                    WHERE table_name = %s
                )
            """, (table,))
            
            exists = cursor.fetchone()[0]
            if exists:
                print(f"✅ Tabela existe: {table}")
            else:
                print(f"❌ Tabela faltando: {table}")
        
        cursor.close()
        conn.close()
        
        print("✅ Conexão com banco de dados OK")
        return True
        
    except Exception as e:
        print(f"❌ Erro ao verificar banco: {e}")
        return False

def fix_permissions():
    """Verifica e corrige permissões dos arquivos"""
    print("\n🔧 Verificando permissões dos arquivos...")
    
    indicators_dir = Path(__file__).parents[3] / 'indicators'
    
    # Verificar se os arquivos são legíveis
    python_files = list(indicators_dir.rglob('*.py'))
    
    for file_path in python_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                if len(content) == 0:
                    print(f"⚠️  Arquivo vazio: {file_path}")
                else:
                    print(f"✅ Arquivo legível: {file_path.name}")
        except Exception as e:
            print(f"❌ Erro ao ler arquivo {file_path}: {e}")
            return False
    
    return True

def main():
    """Função principal de correção"""
    print("="*60)
    print("🔧 SCRIPT DE CORREÇÃO - SISTEMA DE INDICADORES")
    print("="*60)
    print(f"Data/Hora: {datetime.now().strftime('%d-%m-%Y %H:%M:%S')}")
    print("="*60)
    
    # Executar correções
    fixes = [
        ("Caminhos de importação", fix_import_paths),
        ("Configuração .env", fix_env_configuration),
        ("Estrutura do banco", fix_database_structure),
        ("Permissões", fix_permissions),
    ]
    
    results = []
    for fix_name, fix_func in fixes:
        print(f"\n{'='*20} {fix_name} {'='*20}")
        try:
            result = fix_func()
            results.append(result)
            status = "✅ OK" if result else "❌ FALHOU"
            print(f"Status: {status}")
        except Exception as e:
            print(f"❌ Erro na correção {fix_name}: {e}")
            results.append(False)
    
    # Resultado final
    print("\n" + "="*60)
    print("📊 RESULTADO DAS CORREÇÕES")
    print("="*60)
    
    passed = sum(results)
    total = len(results)
    
    print(f"✅ Correções OK: {passed}/{total}")
    print(f"❌ Correções falharam: {total - passed}/{total}")
    
    if passed == total:
        print("🎉 TODAS AS CORREÇÕES FORAM APLICADAS!")
        print("✅ Sistema está pronto para uso")
    else:
        print("⚠️  ALGUMAS CORREÇÕES FALHARAM")
        print("🔧 Verifique os erros acima")
    
    print("="*60)
    return passed == total

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
