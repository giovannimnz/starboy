"""
Testes completos para operações de banco de dados PostgreSQL
Cobre todas as operações CRUD com dados mock
"""

import pytest
import psycopg2
from psycopg2.extras import RealDictCursor
import sys
import os
from datetime import datetime, timedelta
import json
from decimal import Decimal

# Importar configurações
from database_config import get_database_connection, test_connection, execute_query

class TestDatabaseOperations:
    """Classe para testes de operações de banco de dados"""
    
    @classmethod
    def setup_class(cls):
        """Configuração inicial para os testes"""
        print("🔧 Configurando testes...")
        
        # Testar conexão
        if not test_connection():
            raise Exception("Não foi possível conectar ao banco de dados")
        
        print("✅ Conexão com banco estabelecida")
        
        # Limpar dados de teste se existirem
        cls.cleanup_test_data()
        print("✅ Dados de teste limpos")
        
    def setup_method(self):
        """Setup para cada teste"""
        pass
        
    def teardown_method(self):
        """Cleanup após cada teste"""
        # Limpar dados de teste
        self.cleanup_test_data()
    
    @classmethod
    def cleanup_test_data(cls):
        """Remove dados de teste"""
        conn = get_database_connection()
        if not conn:
            return
            
        try:
            cursor = conn.cursor()
            
            # Ordem de limpeza respeitando foreign keys
            tables = [
                'logs', 'backtest_signals', 'signals_msg', 'signals_analysis',
                'webhook_signals', 'monitoramento', 'ordens_fechadas', 
                'posicoes_fechadas', 'ordens', 'posicoes', 'exchange_filters',
                'exchange_symbols', 'exchange_leverage_brackets', 'contas',
                'configuracoes', 'corretoras', 'users'
            ]
            
            for table in tables:
                cursor.execute(f"DELETE FROM {table} WHERE id >= 9000")
            
            cursor.close()
            conn.close()
            
        except psycopg2.Error as e:
            print(f"Erro ao limpar dados: {e}")
            conn.close()
    
    # ===============================
    # TESTES TABELA USERS
    # ===============================
    
    def test_users_crud(self):
        """Testa operações CRUD na tabela users"""
        print("\n🧪 Testando operações CRUD - USERS")
        
        # INSERT
        user_data = {
            'id': 9001,
            'nome': 'Test User',
            'email': 'test@example.com',
            'senha': 'hashed_password',
            'username': 'testuser',
            'ativa': True
        }
        
        insert_query = """
            INSERT INTO users (id, nome, email, senha, username, ativa)
            VALUES (%(id)s, %(nome)s, %(email)s, %(senha)s, %(username)s, %(ativa)s)
        """
        
        result = execute_query(insert_query, user_data, fetch=False)
        assert result == 1, "Falha ao inserir usuário"
        print("✅ INSERT users - OK")
        
        # SELECT
        select_query = "SELECT * FROM users WHERE id = %s"
        result = execute_query(select_query, (9001,))
        assert result is not None and len(result) == 1, "Falha ao buscar usuário"
        assert result[0]['nome'] == 'Test User'
        print("✅ SELECT users - OK")
        
        # UPDATE
        update_query = "UPDATE users SET nome = %s WHERE id = %s"
        result = execute_query(update_query, ('Updated User', 9001), fetch=False)
        assert result == 1, "Falha ao atualizar usuário"
        
        # Verificar update
        result = execute_query(select_query, (9001,))
        assert result[0]['nome'] == 'Updated User'
        print("✅ UPDATE users - OK")
        
        # DELETE
        delete_query = "DELETE FROM users WHERE id = %s"
        result = execute_query(delete_query, (9001,), fetch=False)
        assert result == 1, "Falha ao deletar usuário"
        
        # Verificar delete
        result = execute_query(select_query, (9001,))
        assert result is None or len(result) == 0
        print("✅ DELETE users - OK")
    
    # ===============================
    # TESTES TABELA CORRETORAS
    # ===============================
    
    def test_corretoras_crud(self):
        """Testa operações CRUD na tabela corretoras"""
        print("\n🧪 Testando operações CRUD - CORRETORAS")
        
        # INSERT
        corretora_data = {
            'id': 9002,
            'corretora': 'Test Broker',
            'ambiente': 'test',
            'spot_rest_api_url': 'https://api.testbroker.com/spot',
            'futures_rest_api_url': 'https://api.testbroker.com/futures',
            'ativa': True
        }
        
        insert_query = """
            INSERT INTO corretoras (id, corretora, ambiente, spot_rest_api_url, futures_rest_api_url, ativa)
            VALUES (%(id)s, %(corretora)s, %(ambiente)s, %(spot_rest_api_url)s, %(futures_rest_api_url)s, %(ativa)s)
        """
        
        result = execute_query(insert_query, corretora_data, fetch=False)
        assert result == 1, "Falha ao inserir corretora"
        print("✅ INSERT corretoras - OK")
        
        # SELECT
        select_query = "SELECT * FROM corretoras WHERE id = %s"
        result = execute_query(select_query, (9002,))
        assert result is not None and len(result) == 1, "Falha ao buscar corretora"
        assert result[0]['corretora'] == 'Test Broker'
        print("✅ SELECT corretoras - OK")
        
        # UPDATE
        update_query = "UPDATE corretoras SET corretora = %s WHERE id = %s"
        result = execute_query(update_query, ('Updated Broker', 9002), fetch=False)
        assert result == 1, "Falha ao atualizar corretora"
        
        # Verificar update
        result = execute_query(select_query, (9002,))
        assert result[0]['corretora'] == 'Updated Broker'
        print("✅ UPDATE corretoras - OK")
        
        # DELETE
        delete_query = "DELETE FROM corretoras WHERE id = %s"
        result = execute_query(delete_query, (9002,), fetch=False)
        assert result == 1, "Falha ao deletar corretora"
        
        # Verificar delete
        result = execute_query(select_query, (9002,))
        assert result is None or len(result) == 0
        print("✅ DELETE corretoras - OK")
    
    # ===============================
    # TESTES TABELA SIGNALS_MSG
    # ===============================
    
    def test_signals_msg_crud(self):
        """Testa operações CRUD na tabela signals_msg"""
        print("\n🧪 Testando operações CRUD - SIGNALS_MSG")
        
        # INSERT
        signal_data = {
            'id': 9006,
            'message_id': 123456,
            'chat_id': -1001234567890,
            'text': 'Test signal message',
            'symbol': 'BTCUSDT',
            'signal_id': 'TEST_SIGNAL_001',
            'created_at': datetime.now(),
            'message_source': 'test_source'
        }
        
        insert_query = """
            INSERT INTO signals_msg (id, message_id, chat_id, text, symbol, signal_id, created_at, message_source)
            VALUES (%(id)s, %(message_id)s, %(chat_id)s, %(text)s, %(symbol)s, %(signal_id)s, %(created_at)s, %(message_source)s)
        """
        
        result = execute_query(insert_query, signal_data, fetch=False)
        assert result == 1, "Falha ao inserir signal_msg"
        print("✅ INSERT signals_msg - OK")
        
        # SELECT
        select_query = "SELECT * FROM signals_msg WHERE id = %s"
        result = execute_query(select_query, (9006,))
        assert result is not None and len(result) == 1, "Falha ao buscar signal_msg"
        assert result[0]['symbol'] == 'BTCUSDT'
        print("✅ SELECT signals_msg - OK")
        
        # UPDATE
        update_query = "UPDATE signals_msg SET symbol = %s WHERE id = %s"
        result = execute_query(update_query, ('ETHUSDT', 9006), fetch=False)
        assert result == 1, "Falha ao atualizar signal_msg"
        
        # Verificar update
        result = execute_query(select_query, (9006,))
        assert result[0]['symbol'] == 'ETHUSDT'
        print("✅ UPDATE signals_msg - OK")
        
        # DELETE
        delete_query = "DELETE FROM signals_msg WHERE id = %s"
        result = execute_query(delete_query, (9006,), fetch=False)
        assert result == 1, "Falha ao deletar signal_msg"
        
        # Verificar delete
        result = execute_query(select_query, (9006,))
        assert result is None or len(result) == 0
        print("✅ DELETE signals_msg - OK")
    
    # ===============================
    # TESTES TABELA DIVAP_ANALYSIS
    # ===============================
    
    def test_signals_analysis_crud(self):
        """Testa operações CRUD na tabela signals_analysis"""
        print("\n🧪 Testando operações CRUD - DIVAP_ANALYSIS")
        
        # INSERT
        divap_data = {
            'id': 9007,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'price': Decimal('50000.00'),
            'quantity': Decimal('0.001'),
            'divap_confirmado': True,
            'divap_score': Decimal('0.85'),
            'created_at': datetime.now(),
            'status': 'ACTIVE'
        }
        
        insert_query = """
            INSERT INTO signals_analysis (id, symbol, side, price, quantity, divap_confirmado, divap_score, created_at, status)
            VALUES (%(id)s, %(symbol)s, %(side)s, %(price)s, %(quantity)s, %(divap_confirmado)s, %(divap_score)s, %(created_at)s, %(status)s)
        """
        
        result = execute_query(insert_query, divap_data, fetch=False)
        assert result == 1, "Falha ao inserir signals_analysis"
        print("✅ INSERT signals_analysis - OK")
        
        # SELECT
        select_query = "SELECT * FROM signals_analysis WHERE id = %s"
        result = execute_query(select_query, (9007,))
        assert result is not None and len(result) == 1, "Falha ao buscar signals_analysis"
        assert result[0]['symbol'] == 'BTCUSDT'
        assert result[0]['divap_confirmado'] == True
        print("✅ SELECT signals_analysis - OK")
        
        # UPDATE
        update_query = "UPDATE signals_analysis SET status = %s WHERE id = %s"
        result = execute_query(update_query, ('CLOSED', 9007), fetch=False)
        assert result == 1, "Falha ao atualizar signals_analysis"
        
        # Verificar update
        result = execute_query(select_query, (9007,))
        assert result[0]['status'] == 'CLOSED'
        print("✅ UPDATE signals_analysis - OK")
        
        # DELETE
        delete_query = "DELETE FROM signals_analysis WHERE id = %s"
        result = execute_query(delete_query, (9007,), fetch=False)
        assert result == 1, "Falha ao deletar signals_analysis"
        
        # Verificar delete
        result = execute_query(select_query, (9007,))
        assert result is None or len(result) == 0
        print("✅ DELETE signals_analysis - OK")

def run_all_tests():
    """Executa todos os testes"""
    print("🚀 INICIANDO TESTES DE BANCO DE DADOS POSTGRESQL")
    print("=" * 60)
    
    # Instanciar classe de teste
    test_instance = TestDatabaseOperations()
    
    try:
        # Setup inicial
        TestDatabaseOperations.setup_class()
        
        # Executar testes
        test_methods = [
            'test_users_crud',
            'test_corretoras_crud',
            'test_signals_msg_crud',
            'test_signals_analysis_crud'
        ]
        
        total_tests = len(test_methods)
        passed_tests = 0
        
        for method_name in test_methods:
            try:
                print(f"\n🧪 Executando {method_name}...")
                test_instance.setup_method()
                
                method = getattr(test_instance, method_name)
                method()
                
                test_instance.teardown_method()
                passed_tests += 1
                print(f"✅ {method_name} - PASSOU")
                
            except Exception as e:
                print(f"❌ {method_name} - FALHOU: {e}")
                test_instance.teardown_method()
        
        print("\n" + "=" * 60)
        print(f"📊 RESUMO DOS TESTES:")
        print(f"   Total: {total_tests}")
        print(f"   Passaram: {passed_tests}")
        print(f"   Falharam: {total_tests - passed_tests}")
        
        if passed_tests == total_tests:
            print("🎉 TODOS OS TESTES PASSARAM!")
        else:
            print("⚠️ ALGUNS TESTES FALHARAM!")
            
    except Exception as e:
        print(f"❌ Erro crítico nos testes: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    run_all_tests()
