#!/usr/bin/env python3
"""
Testes simples de operações de banco de dados PostgreSQL
Versão simplificada sem async, apenas psycopg2 síncrono
"""

import os
import sys
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timedelta
from decimal import Decimal
from dotenv import load_dotenv

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

# Configuração do banco PostgreSQL
DB_CONFIG = {
    'host': os.getenv('DB_HOST', 'localhost'),
    'database': os.getenv('DB_NAME', 'starboy_postgres'),
    'user': os.getenv('DB_USER', 'postgres'),
    'password': os.getenv('DB_PASSWORD', 'password'),
    'port': int(os.getenv('DB_PORT', 5432))
}

class TestDatabaseOperationsFixed:
    """Classe para testes simples de operações de banco de dados"""
    
    def __init__(self):
        self.conn = None
    
    def setup(self):
        """Setup para os testes"""
        try:
            self.conn = psycopg2.connect(**DB_CONFIG)
            self.conn.autocommit = True
            print("✅ Conexão estabelecida com sucesso")
        except Exception as e:
            print(f"❌ Erro ao conectar: {e}")
            raise
    
    def teardown(self):
        """Cleanup após os testes"""
        if self.conn and not self.conn.closed:
            self.conn.close()
            print("✅ Conexão fechada")
    
    def cleanup_test_data(self):
        """Remove dados de teste"""
        if not self.conn or self.conn.closed:
            return
            
        cursor = self.conn.cursor()
        try:
            # Ordem de limpeza respeitando foreign keys
            tables = [
                'logs', 'signals_backtest', 'signals_msg', 'divap_analysis',
                'webhook_signals', 'monitoramento', 'ordens_fechadas', 
                'posicoes_fechadas', 'ordens', 'posicoes', 'exchange_filters',
                'exchange_symbols', 'exchange_leverage_brackets', 'contas',
                'configuracoes', 'corretoras', 'users'
            ]
            
            for table in tables:
                try:
                    cursor.execute(f"DELETE FROM {table} WHERE id >= 9000")
                except Exception as e:
                    pass  # Tabela pode não existir ou não ter campo id
            
        finally:
            cursor.close()

    def test_users_crud(self):
        """Testa operações CRUD na tabela users"""
        print("\n🧪 TESTE: OPERAÇÕES CRUD - USERS")
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        
        try:
            # CREATE - Inserir usuário
            user_data = {
                'id': 9001,
                'nome': 'João Silva Test',
                'email': 'joao.test@example.com',
                'senha': 'senha_hash_123',
                'ativa': True
            }
            
            cursor.execute("""
                INSERT INTO users (id, nome, email, senha, ativa)
                VALUES (%(id)s, %(nome)s, %(email)s, %(senha)s, %(ativa)s)
            """, user_data)
            print("  ✅ INSERT realizado")
            
            # READ - Buscar usuário
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_data['id'],))
            user = cursor.fetchone()
            assert user is not None
            assert user['nome'] == user_data['nome']
            assert user['email'] == user_data['email']
            assert user['ativa'] == user_data['ativa']
            print(f"  ✅ SELECT realizado: {user['nome']}")
            
            # UPDATE - Atualizar usuário
            new_nome = 'João Silva Santos'
            cursor.execute("""
                UPDATE users 
                SET nome = %s
                WHERE id = %s
            """, (new_nome, user_data['id']))
            
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_data['id'],))
            updated_user = cursor.fetchone()
            assert updated_user['nome'] == new_nome
            print(f"  ✅ UPDATE realizado: {updated_user['nome']}")
            
            # DELETE - Remover usuário
            cursor.execute("DELETE FROM users WHERE id = %s", (user_data['id'],))
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_data['id'],))
            deleted_user = cursor.fetchone()
            assert deleted_user is None
            print("  ✅ DELETE realizado")
            
        finally:
            cursor.close()

    def test_corretoras_crud(self):
        """Testa operações CRUD na tabela corretoras"""
        print("\n🧪 TESTE: OPERAÇÕES CRUD - CORRETORAS")
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        
        try:
            # CREATE
            corretora_data = {
                'id': 9002,
                'corretora': 'binance_test',
                'ambiente': 'testnet',
                'ativa': True
            }
            
            cursor.execute("""
                INSERT INTO corretoras (id, corretora, ambiente, ativa)
                VALUES (%(id)s, %(corretora)s, %(ambiente)s, %(ativa)s)
            """, corretora_data)
            print("  ✅ INSERT realizado")
            
            # READ
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_data['id'],))
            corretora = cursor.fetchone()
            assert corretora['corretora'] == corretora_data['corretora']
            assert corretora['ambiente'] == corretora_data['ambiente']
            print(f"  ✅ SELECT realizado: {corretora['corretora']}")
            
            # UPDATE
            new_ambiente = 'production'
            cursor.execute("""
                UPDATE corretoras 
                SET ambiente = %s
                WHERE id = %s
            """, (new_ambiente, corretora_data['id']))
            
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_data['id'],))
            updated_corretora = cursor.fetchone()
            assert updated_corretora['ambiente'] == new_ambiente
            print(f"  ✅ UPDATE realizado: {updated_corretora['ambiente']}")
            
            # DELETE
            cursor.execute("DELETE FROM corretoras WHERE id = %s", (corretora_data['id'],))
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_data['id'],))
            deleted_corretora = cursor.fetchone()
            assert deleted_corretora is None
            print("  ✅ DELETE realizado")
            
        finally:
            cursor.close()

    def test_signals_msg_crud(self):
        """Testa operações CRUD na tabela signals_msg"""
        print("\n🧪 TESTE: OPERAÇÕES CRUD - SIGNALS_MSG")
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        
        try:
            # CREATE
            signal_data = {
                'id': 9003,
                'message_id': 123456,
                'chat_id': -1001234567890,
                'text': 'Test signal message',
                'symbol': 'BTCUSDT',
                'created_at': datetime.now(),
                'message_source': 'test_source'
            }
            
            cursor.execute("""
                INSERT INTO signals_msg (id, message_id, chat_id, text, symbol, created_at, message_source)
                VALUES (%(id)s, %(message_id)s, %(chat_id)s, %(text)s, %(symbol)s, %(created_at)s, %(message_source)s)
            """, signal_data)
            print("  ✅ INSERT realizado")
            
            # READ
            cursor.execute("SELECT * FROM signals_msg WHERE id = %s", (signal_data['id'],))
            signal = cursor.fetchone()
            assert signal['symbol'] == signal_data['symbol']
            assert signal['text'] == signal_data['text']
            print(f"  ✅ SELECT realizado: {signal['symbol']}")
            
            # UPDATE
            new_symbol = 'ETHUSDT'
            cursor.execute("""
                UPDATE signals_msg 
                SET symbol = %s
                WHERE id = %s
            """, (new_symbol, signal_data['id']))
            
            cursor.execute("SELECT * FROM signals_msg WHERE id = %s", (signal_data['id'],))
            updated_signal = cursor.fetchone()
            assert updated_signal['symbol'] == new_symbol
            print(f"  ✅ UPDATE realizado: {updated_signal['symbol']}")
            
            # DELETE
            cursor.execute("DELETE FROM signals_msg WHERE id = %s", (signal_data['id'],))
            cursor.execute("SELECT * FROM signals_msg WHERE id = %s", (signal_data['id'],))
            deleted_signal = cursor.fetchone()
            assert deleted_signal is None
            print("  ✅ DELETE realizado")
            
        finally:
            cursor.close()

    def run_all_tests(self):
        """Executa todos os testes"""
        print("🚀 INICIANDO TESTES DE OPERAÇÕES DE BANCO - VERSÃO CORRIGIDA")
        print("=" * 70)
        
        try:
            self.setup()
            self.cleanup_test_data()
            
            # Executar testes
            self.test_users_crud()
            self.test_corretoras_crud()
            self.test_signals_msg_crud()
            
            print("\n" + "=" * 70)
            print("🎉 TODOS OS TESTES PASSARAM COM SUCESSO!")
            return True
            
        except Exception as e:
            print(f"\n❌ ERRO NOS TESTES: {e}")
            import traceback
            traceback.print_exc()
            return False
            
        finally:
            self.teardown()

if __name__ == "__main__":
    test_instance = TestDatabaseOperationsFixed()
    success = test_instance.run_all_tests()
    sys.exit(0 if success else 1)
