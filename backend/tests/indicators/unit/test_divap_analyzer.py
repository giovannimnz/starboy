#!/usr/bin/env python3
"""
Testes unitários para o módulo DIVAPAnalyzer
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

class TestDIVAPAnalyzer(unittest.TestCase):
    """Testes para a classe DIVAPAnalyzer"""
    
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
        
        self.sample_signal = {
            'id': 1,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'entry_price': 50000,
            'sl_price': 49000
        }
    
    @patch('utils.analysis.divap_check.psycopg2.connect')
    def test_connect_db_success(self, mock_connect):
        """Testa conexão bem-sucedida com banco de dados"""
        # Configurar mock
        mock_conn = Mock()
        mock_cursor = Mock()
        mock_conn.cursor.return_value = mock_cursor
        mock_connect.return_value = mock_conn
        
        # Importar e testar
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        analyzer.connect_db()
        
        # Verificações
        self.assertIsNotNone(analyzer.conn)
        self.assertIsNotNone(analyzer.cursor)
        mock_connect.assert_called_once_with(**self.mock_db_config)
    
    @patch('utils.analysis.divap_check.ccxt.binance')
    def test_connect_exchange_success(self, mock_binance):
        """Testa conexão bem-sucedida com exchange"""
        # Configurar mock
        mock_exchange = Mock()
        mock_exchange.load_markets.return_value = None
        mock_binance.return_value = mock_exchange
        
        # Importar e testar
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        analyzer.connect_exchange()
        
        # Verificações
        self.assertIsNotNone(analyzer.exchange)
        mock_binance.assert_called_once_with(self.mock_binance_config)
        mock_exchange.load_markets.assert_called_once()
    
    def test_analyze_signal_incomplete_data(self):
        """Testa análise com dados incompletos"""
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        
        # Sinal incompleto
        incomplete_signal = {
            'id': 1,
            'symbol': 'BTCUSDT',
            # Faltam side, entry_price, sl_price
        }
        
        result = analyzer.analyze_signal(incomplete_signal)
        
        # Verificações
        self.assertFalse(result['divap_confirmed'])
        self.assertEqual(result['reason'], 'Dados do sinal incompletos')
        self.assertEqual(result['signal_id'], 1)
    
    def test_check_divap_pattern_valid_signal(self):
        """Testa verificação de padrão DIVAP com sinal válido"""
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        
        result = analyzer.check_divap_pattern(self.sample_signal)
        
        # Verificações
        self.assertIn('is_divap', result)
        self.assertIn('confidence', result)
        self.assertIn('reason', result)
        self.assertIn('risk_reward_ratio', result)
        self.assertIsInstance(result['is_divap'], bool)
        self.assertIsInstance(result['confidence'], (int, float))
    
    def test_check_divap_pattern_low_risk(self):
        """Testa padrão DIVAP com baixo risco"""
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        
        # Sinal com baixo risco (diferença pequena entre entry e stop loss)
        low_risk_signal = {
            'id': 1,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'entry_price': 50000,
            'sl_price': 49800  # Risco de apenas 0.4%
        }
        
        result = analyzer.check_divap_pattern(low_risk_signal)
        
        # Verificações
        self.assertTrue(result['is_divap'])  # Deve ser DIVAP por ter baixo risco
        self.assertGreater(result['confidence'], 90)  # Alta confiança
    
    def test_check_divap_pattern_high_risk(self):
        """Testa padrão DIVAP com alto risco"""
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        
        # Sinal com alto risco
        high_risk_signal = {
            'id': 1,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'entry_price': 50000,
            'sl_price': 45000  # Risco de 10%
        }
        
        result = analyzer.check_divap_pattern(high_risk_signal)
        
        # Verificações
        self.assertFalse(result['is_divap'])  # Não deve ser DIVAP por ter alto risco
        self.assertLess(result['confidence'], 50)  # Baixa confiança
    
    @patch('utils.analysis.divap_check.psycopg2.connect')
    def test_save_analysis_result_success(self, mock_connect):
        """Testa salvamento bem-sucedido de resultado"""
        # Configurar mock
        mock_conn = Mock()
        mock_cursor = Mock()
        mock_conn.cursor.return_value = mock_cursor
        mock_connect.return_value = mock_conn
        
        from utils.analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.mock_db_config, self.mock_binance_config)
        analyzer.conn = mock_conn
        analyzer.cursor = mock_cursor
        
        analysis_result = {
            'signal_id': 1,
            'divap_confirmed': True,
            'confidence': 85,
            'reason': 'Teste',
            'analysis_type': 'test'
        }
        
        analyzer.save_analysis_result(analysis_result)
        
        # Verificações
        mock_cursor.execute.assert_called_once()
        mock_conn.commit.assert_called_once()

if __name__ == '__main__':
    unittest.main()
