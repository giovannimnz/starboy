#!/usr/bin/env python3
"""
Verifica e corrige a função de trigger update_timestamp_column
"""
import psycopg2
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def fix_triggers():
    """Corrige funções de trigger se necessário"""
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    cursor = conn.cursor()
    
    try:
        # Verificar se a função existe
        cursor.execute("SELECT proname FROM pg_proc WHERE proname = 'update_timestamp_column';")
        result = cursor.fetchone()
        
        if not result:
            print("❌ Função update_timestamp_column não encontrada. Criando...")
            
            # Criar a função
            cursor.execute("""
                CREATE OR REPLACE FUNCTION update_timestamp_column()
                RETURNS TRIGGER AS $$
                BEGIN
                    -- Para a tabela 'corretoras' que usa 'ultima_atualizacao'
                    IF TG_TABLE_NAME = 'corretoras' THEN
                        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
                    END IF;
                    
                    -- Para a tabela 'contas' que usa 'ultima_atualizacao'
                    IF TG_TABLE_NAME = 'contas' THEN
                        NEW.ultima_atualizacao = CURRENT_TIMESTAMP;
                    END IF;
                    
                    -- Para tabelas que usam 'atualizado_em'
                    IF TG_TABLE_NAME = 'users' THEN
                        NEW.atualizado_em = CURRENT_TIMESTAMP;
                    END IF;
                    
                    -- Para outras tabelas que possam usar nomes diferentes
                    IF TG_TABLE_NAME = 'exchange_symbols' THEN
                        NEW.updated_at = CURRENT_TIMESTAMP;
                    END IF;
                    
                    IF TG_TABLE_NAME = 'posicoes' THEN
                        NEW.data_hora_ultima_atualizacao = CURRENT_TIMESTAMP;
                        NEW.last_update = CURRENT_TIMESTAMP;
                    END IF;
                    
                    IF TG_TABLE_NAME = 'webhook_signals' THEN
                        NEW.updated_at = CURRENT_TIMESTAMP;
                    END IF;
                    
                    IF TG_TABLE_NAME = 'ordens' THEN
                        NEW.last_update = CURRENT_TIMESTAMP;
                    END IF;
                    
                    RETURN NEW;
                END;
                $$ language 'plpgsql';
            """)
            print("✅ Função update_timestamp_column criada com sucesso")
        else:
            print("✅ Função update_timestamp_column já existe")
        
        # Verificar se os triggers existem
        tables_with_triggers = [
            ('users', 'set_timestamp_users'),
            ('corretoras', 'set_timestamp_corretoras'),
            ('contas', 'set_timestamp_contas'),
            ('exchange_symbols', 'set_timestamp_exchange_symbols'),
            ('posicoes', 'set_timestamp_posicoes'),
            ('webhook_signals', 'set_timestamp_webhook_signals'),
            ('ordens', 'set_timestamp_ordens')
        ]
        
        for table_name, trigger_name in tables_with_triggers:
            cursor.execute(f"SELECT tgname FROM pg_trigger WHERE tgname = '{trigger_name}';")
            result = cursor.fetchone()
            
            if not result:
                print(f"❌ Trigger {trigger_name} não encontrado. Criando...")
                cursor.execute(f"""
                    CREATE TRIGGER {trigger_name}
                    BEFORE UPDATE ON {table_name}
                    FOR EACH ROW
                    EXECUTE FUNCTION update_timestamp_column();
                """)
                print(f"✅ Trigger {trigger_name} criado com sucesso")
            else:
                print(f"✅ Trigger {trigger_name} já existe")
    
    except Exception as e:
        print(f"❌ Erro: {e}")
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    fix_triggers()
