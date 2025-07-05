#!/usr/bin/env python3
"""
Script para verificar se a tabela divap_analysis ainda existe e removê-la se necessário
"""

import psycopg2
from psycopg2.extras import RealDictCursor

# Configurações do banco
DB_CONFIG = {
    'host': 'atius.com.br',
    'port': 8745,
    'user': 'postgres',
    'password': 'Bkfigt!546',
    'database': 'starboy_dev'
}

def get_connection():
    """Obtém conexão com o banco"""
    return psycopg2.connect(**DB_CONFIG)

def check_old_table():
    """Verifica se a tabela divap_analysis ainda existe"""
    try:
        conn = get_connection()
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Verificar se a tabela divap_analysis existe
        cursor.execute("""
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = 'divap_analysis'
        """)
        
        old_table = cursor.fetchone()
        
        if old_table:
            print("⚠️  TABELA ANTIGA ENCONTRADA: divap_analysis")
            
            # Contar registros
            cursor.execute("SELECT COUNT(*) as count FROM divap_analysis")
            count = cursor.fetchone()['count']
            print(f"   📊 Registros na tabela antiga: {count}")
            
            if count > 0:
                print("   ⚠️  ATENÇÃO: A tabela antiga contém dados!")
                print("   💡 Recomenda-se verificar se todos os dados foram migrados antes de remover")
                return False
            else:
                print("   ✅ Tabela antiga vazia - seguro para remoção")
                return True
        else:
            print("✅ TABELA ANTIGA NÃO ENCONTRADA - migração limpa!")
            return True
            
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ ERRO: {str(e)}")
        return False

def remove_old_table():
    """Remove a tabela divap_analysis antiga"""
    try:
        conn = get_connection()
        cursor = conn.cursor()
        
        print("🗑️  REMOVENDO TABELA ANTIGA...")
        cursor.execute("DROP TABLE IF EXISTS divap_analysis CASCADE")
        conn.commit()
        
        print("✅ Tabela 'divap_analysis' removida com sucesso")
        
        cursor.close()
        conn.close()
        
    except Exception as e:
        print(f"❌ ERRO ao remover tabela: {str(e)}")
        return False
    
    return True

def main():
    """Função principal"""
    print("🔍 VERIFICANDO TABELA ANTIGA - divap_analysis")
    print("=" * 50)
    
    if check_old_table():
        # Perguntar se deve remover (simulando resposta positiva para automação)
        print("\n🤔 A tabela antiga pode ser removida?")
        print("   💡 Resposta automática: SIM (tabela vazia ou inexistente)")
        
        if remove_old_table():
            print("\n✅ LIMPEZA CONCLUÍDA COM SUCESSO!")
        else:
            print("\n⚠️  LIMPEZA FALHOU")
    else:
        print("\n⚠️  TABELA ANTIGA CONTÉM DADOS - não removida automaticamente")
        print("   💡 Verifique manualmente se todos os dados foram migrados")

if __name__ == "__main__":
    main()
