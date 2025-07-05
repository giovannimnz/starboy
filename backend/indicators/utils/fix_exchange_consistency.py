#!/usr/bin/env python3
"""
Script para verificar e corrigir problemas de chave estrangeira nas tabelas exchange
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import os
from dotenv import load_dotenv
import pathlib

# Carregar variáveis de ambiente
env_path = pathlib.Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco de dados
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

def verificar_inconsistencias():
    """Verifica inconsistências nas tabelas exchange"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        print("=" * 60)
        print("VERIFICAÇÃO DE INCONSISTÊNCIAS - TABELAS EXCHANGE")
        print("=" * 60)
        
        # 1. Verificar filtros órfãos (symbol_id que não existe)
        print("\n1. Verificando filtros órfãos...")
        cursor.execute("""
            SELECT ef.id, ef.symbol_id, ef.filter_type 
            FROM exchange_filters ef 
            LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id 
            WHERE es.id IS NULL
        """)
        
        filtros_orfaos = cursor.fetchall()
        if filtros_orfaos:
            print(f"❌ Encontrados {len(filtros_orfaos)} filtros órfãos:")
            for filtro in filtros_orfaos:
                print(f"   - ID: {filtro['id']}, symbol_id: {filtro['symbol_id']}, tipo: {filtro['filter_type']}")
        else:
            print("✅ Nenhum filtro órfão encontrado")
        
        # 2. Verificar símbolos sem filtros
        print("\n2. Verificando símbolos sem filtros...")
        cursor.execute("""
            SELECT es.id, es.symbol, es.exchange 
            FROM exchange_symbols es 
            LEFT JOIN exchange_filters ef ON es.id = ef.symbol_id 
            WHERE ef.symbol_id IS NULL
        """)
        
        simbolos_sem_filtros = cursor.fetchall()
        if simbolos_sem_filtros:
            print(f"⚠️ Encontrados {len(simbolos_sem_filtros)} símbolos sem filtros:")
            for simbolo in simbolos_sem_filtros[:10]:  # Mostrar apenas os primeiros 10
                print(f"   - ID: {simbolo['id']}, símbolo: {simbolo['symbol']}, exchange: {simbolo['exchange']}")
            if len(simbolos_sem_filtros) > 10:
                print(f"   ... e mais {len(simbolos_sem_filtros) - 10} símbolos")
        else:
            print("✅ Todos os símbolos têm filtros")
        
        # 3. Verificar IDs inválidos (0 ou negativos)
        print("\n3. Verificando IDs inválidos...")
        cursor.execute("SELECT COUNT(*) FROM exchange_filters WHERE symbol_id <= 0")
        filtros_id_invalido = cursor.fetchone()['count']
        
        if filtros_id_invalido > 0:
            print(f"❌ Encontrados {filtros_id_invalido} filtros com symbol_id inválido (<=0)")
        else:
            print("✅ Todos os filtros têm symbol_id válido")
        
        # 4. Estatísticas gerais
        print("\n4. Estatísticas gerais...")
        cursor.execute("SELECT COUNT(*) FROM exchange_symbols")
        total_simbolos = cursor.fetchone()['count']
        
        cursor.execute("SELECT COUNT(*) FROM exchange_filters")
        total_filtros = cursor.fetchone()['count']
        
        cursor.execute("SELECT COUNT(DISTINCT symbol_id) FROM exchange_filters")
        simbolos_com_filtros = cursor.fetchone()['count']
        
        print(f"   📊 Total de símbolos: {total_simbolos}")
        print(f"   📊 Total de filtros: {total_filtros}")
        print(f"   📊 Símbolos com filtros: {simbolos_com_filtros}")
        
        # 5. Propostas de correção
        print("\n5. Propostas de correção...")
        if filtros_orfaos:
            print("   🔧 Para corrigir filtros órfãos:")
            print("      - Opção 1: Deletar filtros órfãos")
            print("      - Opção 2: Recriar símbolos ausentes")
        
        if filtros_id_invalido > 0:
            print("   🔧 Para corrigir IDs inválidos:")
            print("      - Deletar filtros com symbol_id <= 0")
        
        cursor.close()
        conn.close()
        
        print("\n" + "=" * 60)
        print("VERIFICAÇÃO CONCLUÍDA")
        print("=" * 60)
        
        return len(filtros_orfaos) + filtros_id_invalido == 0
        
    except Exception as e:
        print(f"❌ Erro durante verificação: {e}")
        return False

def corrigir_inconsistencias():
    """Corrige as inconsistências encontradas"""
    try:
        conn = psycopg2.connect(**DB_CONFIG)
        cursor = conn.cursor()
        
        print("\n" + "=" * 60)
        print("CORREÇÃO DE INCONSISTÊNCIAS")
        print("=" * 60)
        
        # 1. Deletar filtros órfãos
        print("\n1. Removendo filtros órfãos...")
        cursor.execute("""
            DELETE FROM exchange_filters 
            WHERE id IN (
                SELECT ef.id 
                FROM exchange_filters ef 
                LEFT JOIN exchange_symbols es ON ef.symbol_id = es.id 
                WHERE es.id IS NULL
            )
        """)
        filtros_deletados = cursor.rowcount
        print(f"✅ {filtros_deletados} filtros órfãos removidos")
        
        # 2. Deletar filtros com IDs inválidos
        print("\n2. Removendo filtros com symbol_id inválido...")
        cursor.execute("DELETE FROM exchange_filters WHERE symbol_id <= 0")
        invalidos_deletados = cursor.rowcount
        print(f"✅ {invalidos_deletados} filtros com ID inválido removidos")
        
        conn.commit()
        cursor.close()
        conn.close()
        
        print(f"\n✅ Correção concluída!")
        print(f"   📝 Total de registros corrigidos: {filtros_deletados + invalidos_deletados}")
        
        return True
        
    except Exception as e:
        print(f"❌ Erro durante correção: {e}")
        return False

def main():
    """Função principal"""
    print("🔍 VERIFICADOR DE CONSISTÊNCIA - TABELAS EXCHANGE")
    
    # Verificar inconsistências
    is_consistent = verificar_inconsistencias()
    
    if not is_consistent:
        print("\n⚠️ Inconsistências encontradas!")
        resposta = input("\nDeseja corrigir automaticamente? (s/N): ").lower().strip()
        
        if resposta in ['s', 'sim', 'yes', 'y']:
            if corrigir_inconsistencias():
                print("\n🎉 Correções aplicadas com sucesso!")
                print("   Executando nova verificação...")
                verificar_inconsistencias()
            else:
                print("\n❌ Falha ao aplicar correções")
        else:
            print("\n📝 Nenhuma correção aplicada")
    else:
        print("\n✅ Banco de dados consistente!")

if __name__ == "__main__":
    main()
