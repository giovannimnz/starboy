#!/usr/bin/env python3
"""
Testes unitários para o módulo exchange_bracket_updater
"""

import sys
import os
import unittest
from pathlib import Path
from unittest.mock import Mock, patch, MagicMock

# Adicionar ao path
current_dir = Path(__file__).parent
indicators_dir = current_dir.parents[3] / 'indicators'
sys.path.append(str(indicators_dir))

class TestExchangeBracketUpdater(unittest.TestCase):
    """Testes para o módulo exchange_bracket_updater"""
    
    def setUp(self):
        """Configuração inicial para cada teste"""
        self.mock_db_config = {
            'host': 'localhost',
            'port': 5432,
            'user': 'test_user',
            'password': 'test_password',
            'database': 'test_db'
        }
        
        self.mock_binance_config = {
            'apiKey': 'test_key',
            'secret': 'test_secret',
            'sandbox': True,
            'enableRateLimit': True,
        }
    
    @patch('utils.exchange_bracket_updater.psycopg2.connect')
    def test_database_connection_success(self, mock_connect):
        """Testa conexão bem-sucedida com banco de dados"""
        # Configurar mock
        mock_conn = Mock()
        mock_cursor = Mock()
        mock_conn.cursor.return_value = mock_cursor
        mock_cursor.fetchone.return_value = (1,)
        mock_connect.return_value = mock_conn
        
        # Importar e testar
        from utils.exchange_bracket_updater import test_database_connection
        
        result = test_database_connection()
        
        # Verificações
        self.assertTrue(result)
        mock_connect.assert_called_once()
        mock_cursor.execute.assert_called_once_with("SELECT 1")
    
    @patch('utils.exchange_bracket_updater.psycopg2.connect')
    def test_database_connection_failure(self, mock_connect):
        """Testa falha na conexão com banco de dados"""
        # Configurar mock para falhar
        mock_connect.side_effect = Exception("Connection failed")
        
        # Importar e testar
        from utils.exchange_bracket_updater import test_database_connection
        
        result = test_database_connection()
        
        # Verificações
        self.assertFalse(result)
    
    @patch('utils.exchange_bracket_updater.ccxt.binance')
    def test_binance_credentials_success(self, mock_binance):
        """Testa credenciais válidas da Binance"""
        # Configurar mock
        mock_exchange = Mock()
        mock_exchange.load_markets.return_value = None
        mock_exchange.fetch_balance.return_value = {'USDT': {'free': 100}}
        mock_binance.return_value = mock_exchange
        
        # Importar e testar
        from utils.exchange_bracket_updater import test_binance_credentials
        
        result = test_binance_credentials()
        
        # Verificações
        self.assertTrue(result)
        mock_exchange.load_markets.assert_called_once()
        mock_exchange.fetch_balance.assert_called_once()
    
    @patch('utils.exchange_bracket_updater.ccxt.binance')
    def test_binance_credentials_failure(self, mock_binance):
        """Testa falha nas credenciais da Binance"""
        # Configurar mock para falhar
        mock_binance.side_effect = Exception("Invalid credentials")
        
        # Importar e testar
        from utils.exchange_bracket_updater import test_binance_credentials
        
        result = test_binance_credentials()
        
        # Verificações
        self.assertFalse(result)
    
    @patch('utils.exchange_bracket_updater.ccxt.binance')
    @patch('utils.exchange_bracket_updater.psycopg2.connect')
    def test_update_leverage_brackets_success(self, mock_connect, mock_binance):
        """Testa atualização bem-sucedida de brackets"""
        # Configurar mocks
        mock_exchange = Mock()
        mock_exchange.load_markets.return_value = None
        mock_exchange.fapiPrivateGetLeverageBracket.return_value = [
            {
                'symbol': 'BTCUSDT',
                'brackets': [
                    {'notionalCap': 5000, 'notionalFloor': 0, 'maintMarginRatio': 0.004, 'cum': 0}
                ]
            }
        ]
        mock_binance.return_value = mock_exchange
        
        mock_conn = Mock()
        mock_cursor = Mock()
        mock_conn.cursor.return_value = mock_cursor
        mock_cursor.fetchone.return_value = {'leverage_brackets': '[]'}
        mock_connect.return_value = mock_conn
        
        # Importar e testar
        from utils.exchange_bracket_updater import update_leverage_brackets
        
        result = update_leverage_brackets()
        
        # Verificações
        self.assertTrue(result)
        mock_exchange.load_markets.assert_called_once()
        mock_exchange.fapiPrivateGetLeverageBracket.assert_called_once()

if __name__ == '__main__':
    unittest.main()
