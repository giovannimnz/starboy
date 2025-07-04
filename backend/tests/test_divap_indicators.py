"""
Testes específicos para os módulos Python do sistema de trading
Testa todas as funcionalidades dos indicadores e sistema DIVAP
"""

import pytest
import psycopg2
from psycopg2.extras import RealDictCursor
import sys
import os
from datetime import datetime, timedelta
import json
from decimal import Decimal
from unittest.mock import Mock, patch, AsyncMock
import asyncio

# Adicionar paths do projeto para importações
project_root = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, project_root)
sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'indicators'))

class TestDivapIndicators:
    """Testes para os módulos de indicadores DIVAP"""
    
    @classmethod
    def setup_class(cls):
        """Setup inicial"""
        cls.db_config = {
            'host': 'localhost',
            'port': 5432,
            'user': 'postgres',
            'password': 'postgres',
            'database': 'starboy_test'
        }
    
    def setup_method(self):
        """Setup para cada teste"""
        self.conn = psycopg2.connect(**self.db_config)
        self.conn.autocommit = True
        self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        self.cleanup_test_data()
    
    def teardown_method(self):
        """Cleanup após cada teste"""
        self.cleanup_test_data()
        if self.cursor:
            self.cursor.close()
        if self.conn and not self.conn.closed:
            self.conn.close()
    
    def cleanup_test_data(self):
        """Remove dados de teste"""
        tables = [
            'divap_analysis', 'webhook_signals', 'exchange_leverage_brackets',
            'exchange_symbols', 'contas', 'corretoras', 'users'
        ]
        
        for table in tables:
            try:
                self.cursor.execute(f"DELETE FROM {table}")
            except Exception:
                pass

    def create_test_user_and_account(self):
        """Cria usuário e conta de teste"""
        # Criar usuário
        self.cursor.execute("""
            INSERT INTO users (nome, email, senha, ativo)
            VALUES (%s, %s, %s, %s) RETURNING id
        """, ('Test User', 'test@example.com', 'hash123', True))
        user_id = self.cursor.fetchone()['id']
        
        # Criar corretora
        self.cursor.execute("""
            INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
            VALUES (%s, %s, %s, %s) RETURNING id
        """, ('binance', 'testnet', 'Binance Test', True))
        corretora_id = self.cursor.fetchone()['id']
        
        # Criar conta
        self.cursor.execute("""
            INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora,
                              saldo_base_calculo_futuros, max_posicoes, telegram_chat_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """, ('Test Account', 'test_key', 'test_secret', True, user_id, corretora_id,
              Decimal('1000.00'), 5, -123456789))
        conta_id = self.cursor.fetchone()['id']
        
        return user_id, corretora_id, conta_id

    # =============== TESTES DO EXCHANGE BRACKET UPDATER ===============
    
    def test_exchange_bracket_updater_database_operations(self):
        """Testa operações de banco do exchange bracket updater"""
        import sys
        sys.path.append(os.path.join(os.path.dirname(__file__), '..', 'indicators'))
        
        from exchange_bracket_updater import get_database_connection
        
        # Testar conexão
        conn = get_database_connection()
        assert conn is not None
        assert not conn.closed
        
        # Criar dados de teste
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Inserir bracket de teste
        test_data = {
            'symbol': 'BTCUSDT',
            'corretora': 'binance',
            'bracket': 1,
            'initial_leverage': 125,
            'notional_cap': Decimal('5000.00'),
            'notional_floor': Decimal('0.00'),
            'maint_margin_ratio': Decimal('0.004'),
            'cum': Decimal('0.00')
        }
        
        cursor.execute("""
            INSERT INTO exchange_leverage_brackets 
            (symbol, corretora, bracket, initial_leverage, notional_cap, 
             notional_floor, maint_margin_ratio, cum)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (test_data['symbol'], test_data['corretora'], test_data['bracket'],
              test_data['initial_leverage'], test_data['notional_cap'],
              test_data['notional_floor'], test_data['maint_margin_ratio'],
              test_data['cum']))
        
        bracket_id = cursor.fetchone()['id']
        assert bracket_id is not None
        
        # Testar busca
        cursor.execute("""
            SELECT * FROM exchange_leverage_brackets 
            WHERE symbol = %s AND corretora = %s
        """, (test_data['symbol'], test_data['corretora']))
        
        result = cursor.fetchone()
        assert result['symbol'] == test_data['symbol']
        assert result['initial_leverage'] == test_data['initial_leverage']
        
        cursor.close()
        conn.close()
        print("✅ Exchange Bracket Updater database operations - PASSOU")

    def test_exchange_bracket_mock_api_response(self):
        """Testa processamento de resposta mock da API Binance"""
        # Mock da resposta da API Binance
        mock_api_response = [
            {
                "symbol": "BTCUSDT",
                "brackets": [
                    {
                        "bracket": 1,
                        "initialLeverage": 125,
                        "notionalCap": 5000,
                        "notionalFloor": 0,
                        "maintMarginRatio": 0.004,
                        "cum": 0.0
                    },
                    {
                        "bracket": 2,
                        "initialLeverage": 100,
                        "notionalCap": 25000,
                        "notionalFloor": 5000,
                        "maintMarginRatio": 0.005,
                        "cum": 5.0
                    }
                ]
            },
            {
                "symbol": "ETHUSDT",
                "brackets": [
                    {
                        "bracket": 1,
                        "initialLeverage": 75,
                        "notionalCap": 10000,
                        "notionalFloor": 0,
                        "maintMarginRatio": 0.006,
                        "cum": 0.0
                    }
                ]
            }
        ]
        
        # Processar dados mock
        processed_symbols = set()
        for symbol_data in mock_api_response:
            symbol = symbol_data.get('symbol')
            if symbol:
                processed_symbols.add(symbol)
                brackets = symbol_data.get('brackets', [])
                
                for bracket_data in brackets:
                    # Inserir no banco
                    self.cursor.execute("""
                        INSERT INTO exchange_leverage_brackets 
                        (symbol, corretora, bracket, initial_leverage, notional_cap,
                         notional_floor, maint_margin_ratio, cum)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        RETURNING id
                    """, (symbol, 'binance', bracket_data['bracket'],
                          bracket_data['initialLeverage'], bracket_data['notionalCap'],
                          bracket_data['notionalFloor'], bracket_data['maintMarginRatio'],
                          bracket_data['cum']))
        
        # Verificar inserção
        self.cursor.execute("""
            SELECT COUNT(*) as total, COUNT(DISTINCT symbol) as symbols
            FROM exchange_leverage_brackets
        """)
        result = self.cursor.fetchone()
        
        assert result['symbols'] == 2  # BTCUSDT e ETHUSDT
        assert result['total'] == 3    # 2 brackets BTC + 1 bracket ETH
        
        print("✅ Exchange Bracket Mock API Response - PASSOU")

    # =============== TESTES DO EXCHANGE INFO UPDATER ===============
    
    def test_exchange_info_updater_database_operations(self):
        """Testa operações de banco do exchange info updater"""
        from exchange_info_updater import get_database_connection
        
        # Testar conexão
        conn = get_database_connection()
        assert conn is not None
        assert not conn.closed
        
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        
        # Inserir symbol de teste
        test_symbol = {
            'exchange': 'binance',
            'symbol': 'BTCUSDT',
            'status': 'TRADING',
            'pair': 'BTCUSDT',
            'contract_type': 'PERPETUAL',
            'base_asset': 'BTC',
            'quote_asset': 'USDT',
            'margin_asset': 'USDT',
            'price_precision': 2,
            'quantity_precision': 6
        }
        
        cursor.execute("""
            INSERT INTO exchange_symbols 
            (exchange, symbol, status, pair, contract_type, base_asset, 
             quote_asset, margin_asset, price_precision, quantity_precision)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (test_symbol['exchange'], test_symbol['symbol'], test_symbol['status'],
              test_symbol['pair'], test_symbol['contract_type'], test_symbol['base_asset'],
              test_symbol['quote_asset'], test_symbol['margin_asset'],
              test_symbol['price_precision'], test_symbol['quantity_precision']))
        
        symbol_id = cursor.fetchone()['id']
        assert symbol_id is not None
        
        # Inserir filtro de teste
        cursor.execute("""
            INSERT INTO exchange_filters 
            (symbol_id, filter_type, min_price, max_price, tick_size)
            VALUES (%s, %s, %s, %s, %s)
        """, (symbol_id, 'PRICE_FILTER', Decimal('0.01'), Decimal('1000000'),
              Decimal('0.01')))
        
        # Verificar dados
        cursor.execute("""
            SELECT es.*, ef.filter_type, ef.min_price
            FROM exchange_symbols es
            LEFT JOIN exchange_filters ef ON es.id = ef.symbol_id
            WHERE es.symbol = %s
        """, (test_symbol['symbol'],))
        
        result = cursor.fetchone()
        assert result['symbol'] == test_symbol['symbol']
        assert result['filter_type'] == 'PRICE_FILTER'
        
        cursor.close()
        conn.close()
        print("✅ Exchange Info Updater database operations - PASSOU")

    # =============== TESTES DO DIVAP MAIN ===============
    
    def test_divap_get_leverage_brackets(self):
        """Testa função get_leverage_brackets_from_database"""
        # Inserir dados de teste
        test_brackets = [
            ('BTCUSDT', 'binance', 1, 125, 5000.00, 0.00, 0.004, 0.00),
            ('BTCUSDT', 'binance', 2, 100, 25000.00, 5000.00, 0.005, 5.00),
            ('ETHUSDT', 'binance', 1, 75, 10000.00, 0.00, 0.006, 0.00)
        ]
        
        for bracket in test_brackets:
            self.cursor.execute("""
                INSERT INTO exchange_leverage_brackets 
                (symbol, corretora, bracket, initial_leverage, notional_cap,
                 notional_floor, maint_margin_ratio, cum)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, bracket)
        
        # Importar e testar função
        from divap import get_leverage_brackets_from_database
        
        # Testar busca por símbolo específico
        btc_brackets = get_leverage_brackets_from_database('BTCUSDT')
        assert 'BTCUSDT' in btc_brackets
        assert len(btc_brackets['BTCUSDT']) == 2
        assert btc_brackets['BTCUSDT'][0]['bracket'] == 1
        assert btc_brackets['BTCUSDT'][0]['initialLeverage'] == 125
        
        # Testar busca de todos os símbolos
        all_brackets = get_leverage_brackets_from_database()
        assert 'BTCUSDT' in all_brackets
        assert 'ETHUSDT' in all_brackets
        assert len(all_brackets['BTCUSDT']) == 2
        assert len(all_brackets['ETHUSDT']) == 1
        
        print("✅ DIVAP get_leverage_brackets - PASSOU")

    def test_divap_get_active_accounts(self):
        """Testa função get_active_accounts"""
        # Criar conta de teste
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        # Criar conta inativa para teste
        self.cursor.execute("""
            INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
            VALUES (%s, %s, %s, %s, %s, %s)
        """, ('Inactive Account', 'key2', 'secret2', False, user_id, corretora_id))
        
        # Importar e testar função
        from divap import get_active_accounts
        
        active_accounts = get_active_accounts()
        assert len(active_accounts) == 1
        assert active_accounts[0]['nome'] == 'Test Account'
        assert active_accounts[0]['ativa'] == True
        
        print("✅ DIVAP get_active_accounts - PASSOU")

    def test_divap_extract_trade_info(self):
        """Testa função extract_trade_info com mensagens mock"""
        from divap import extract_trade_info
        
        # Mensagens de teste
        test_messages = [
            {
                'text': """
🚨 #BTCUSDT 15m - Alerta de possível DIVAP!

📊 Entrada: 45,000.00
🎯 Alvos:
   TP1: 46,000.00
   TP2: 47,000.00
   TP3: 48,000.00
🛡️ Stop Loss: 44,000.00
                """,
                'expected': {
                    'symbol': 'BTCUSDT',
                    'side': 'BUY',
                    'timeframe': '15m',
                    'entry': 45000.00
                }
            },
            {
                'text': """
🚨 #ETHUSDT 1h - Possível DIVAP VENDA!

📊 Entrada: 3,200.50
🎯 Alvos:
   TP1: 3,100.00
   TP2: 3,000.00
🛡️ Stop Loss: 3,300.00
                """,
                'expected': {
                    'symbol': 'ETHUSDT',
                    'side': 'SELL',
                    'timeframe': '1h',
                    'entry': 3200.50
                }
            }
        ]
        
        for test_case in test_messages:
            result = extract_trade_info(test_case['text'])
            
            if result:
                assert result['symbol'] == test_case['expected']['symbol']
                assert result['side'] == test_case['expected']['side']
                assert result['timeframe'] == test_case['expected']['timeframe']
                assert abs(float(result['entry']) - test_case['expected']['entry']) < 0.01
            else:
                assert False, f"Falha ao extrair informações da mensagem: {test_case['text'][:100]}..."
        
        print("✅ DIVAP extract_trade_info - PASSOU")

    def test_divap_save_to_database(self):
        """Testa função save_to_database"""
        # Criar conta de teste
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        # Importar função
        from divap import save_to_database
        
        # Dados de teste
        trade_data = {
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'leverage': 10,
            'capital_pct': 2.5,
            'entry': 45000.00,
            'stop_loss': 44000.00,
            'all_tps': [46000.00, 47000.00, 48000.00, 49000.00, 50000.00],
            'timeframe': '15m',
            'message_id': 12345,
            'id_mensagem_origem_sinal': 67890,
            'chat_id_origem_sinal': -123456789,
            'message_source': 'DIVAP',
            'status': 'PENDING',
            'divap_confirmado': True,
            'cancelado_checker': False
        }
        
        # Salvar no banco
        signal_ids = save_to_database(trade_data)
        
        assert signal_ids is not None
        assert len(signal_ids) == 1  # Uma conta ativa
        
        # Verificar dados salvos
        signal_id = signal_ids[0][1]
        self.cursor.execute("SELECT * FROM webhook_signals WHERE id = %s", (signal_id,))
        saved_signal = self.cursor.fetchone()
        
        assert saved_signal['symbol'] == trade_data['symbol']
        assert saved_signal['side'] == trade_data['side']
        assert saved_signal['leverage'] == trade_data['leverage']
        assert saved_signal['tp1_price'] == Decimal(str(trade_data['all_tps'][0]))
        
        print("✅ DIVAP save_to_database - PASSOU")

    # =============== TESTES DO DIVAP CHECK ANALYZER ===============
    
    def test_divap_analyzer_signal_operations(self):
        """Testa operações do DIVAPAnalyzer"""
        # Criar conta e signal de teste
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        self.cursor.execute("""
            INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct,
                                       entry_price, sl_price, status, timeframe)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (conta_id, 'BTCUSDT', 'BUY', 10, 2.5, 45000.00, 44000.00, 'PENDING', '15m'))
        
        signal_id = self.cursor.fetchone()['id']
        
        # Testar busca de sinal por ID
        from analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.db_config, {})
        analyzer.connect_db()
        
        # Buscar sinal
        signal = analyzer.get_signal_by_id(signal_id)
        assert signal is not None
        assert signal['symbol'] == 'BTCUSDT'
        assert signal['side'] == 'BUY'
        
        analyzer.close_connections()
        print("✅ DIVAP Analyzer signal operations - PASSOU")

    def test_divap_analyzer_save_analysis(self):
        """Testa salvamento de análise DIVAP"""
        # Criar signal de teste
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        self.cursor.execute("""
            INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct,
                                       entry_price, sl_price, status, timeframe)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
        """, (conta_id, 'BTCUSDT', 'BUY', 10, 2.5, 45000.00, 44000.00, 'PENDING', '15m'))
        
        signal_id = self.cursor.fetchone()['id']
        
        # Mock de resultado de análise
        analysis_result = {
            'signal_id': signal_id,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'timeframe': '15m',
            'created_at': datetime.now(),
            'divap_confirmed': True,
            'is_bull_divap': True,
            'is_bear_divap': False,
            'rsi': 65.5,
            'volume': 1500000,
            'volume_sma': 1200000,
            'high_volume': True,
            'high_volume_any': True,
            'bull_div': True,
            'bull_div_any': True,
            'bear_div': False,
            'bear_div_any': False,
            'message': 'DIVAP pattern confirmed with high volume and bullish divergence',
            'bull_reversal_pattern': True,
            'bear_reversal_pattern': False
        }
        
        # Importar e testar salvamento
        from analysis.divap_check import DIVAPAnalyzer
        
        analyzer = DIVAPAnalyzer(self.db_config, {})
        analyzer.connect_db()
        
        # Salvar análise
        analyzer.save_analysis_result(analysis_result)
        
        # Verificar análise salva
        self.cursor.execute("SELECT * FROM divap_analysis WHERE signal_id = %s", (signal_id,))
        saved_analysis = self.cursor.fetchone()
        
        assert saved_analysis['signal_id'] == signal_id
        assert saved_analysis['divap_confirmed'] == True
        assert saved_analysis['is_bull_divap'] == True
        assert saved_analysis['high_volume'] == True
        
        # Verificar atualização do signal
        self.cursor.execute("SELECT * FROM webhook_signals WHERE id = %s", (signal_id,))
        updated_signal = self.cursor.fetchone()
        
        assert updated_signal['divap_confirmado'] == True
        assert updated_signal['cancelado_checker'] == False
        assert updated_signal['status'] == 'PENDING'
        
        analyzer.close_connections()
        print("✅ DIVAP Analyzer save analysis - PASSOU")

    # =============== TESTES DE INTEGRAÇÃO ===============
    
    def test_full_workflow_integration(self):
        """Testa workflow completo do sistema"""
        # 1. Criar estrutura base
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        # 2. Inserir exchange data
        self.cursor.execute("""
            INSERT INTO exchange_symbols (exchange, symbol, status, base_asset, quote_asset)
            VALUES (%s, %s, %s, %s, %s)
        """, ('binance', 'BTCUSDT', 'TRADING', 'BTC', 'USDT'))
        
        self.cursor.execute("""
            INSERT INTO exchange_leverage_brackets 
            (symbol, corretora, bracket, initial_leverage, notional_cap,
             notional_floor, maint_margin_ratio, cum)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """, ('BTCUSDT', 'binance', 1, 125, 5000.00, 0.00, 0.004, 0.00))
        
        # 3. Simular recebimento de sinal
        trade_data = {
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'leverage': 10,
            'capital_pct': 2.5,
            'entry': 45000.00,
            'stop_loss': 44000.00,
            'all_tps': [46000.00, 47000.00, 48000.00],
            'timeframe': '15m',
            'message_source': 'DIVAP'
        }
        
        from divap import save_to_database
        signal_ids = save_to_database(trade_data)
        assert signal_ids is not None
        
        signal_id = signal_ids[0][1]
        
        # 4. Simular análise DIVAP
        analysis_result = {
            'signal_id': signal_id,
            'symbol': 'BTCUSDT',
            'side': 'BUY',
            'divap_confirmed': True,
            'is_bull_divap': True,
            'high_volume_any': True,
            'bull_div_any': True
        }
        
        from analysis.divap_check import DIVAPAnalyzer
        analyzer = DIVAPAnalyzer(self.db_config, {})
        analyzer.connect_db()
        analyzer.save_analysis_result(analysis_result)
        analyzer.close_connections()
        
        # 5. Verificar estado final
        self.cursor.execute("""
            SELECT 
                ws.*,
                da.divap_confirmed as analysis_confirmed,
                c.nome as conta_nome,
                u.nome as user_nome
            FROM webhook_signals ws
            LEFT JOIN divap_analysis da ON ws.id = da.signal_id
            JOIN contas c ON ws.conta_id = c.id
            JOIN users u ON c.user_id = u.id
            WHERE ws.id = %s
        """, (signal_id,))
        
        result = self.cursor.fetchone()
        
        assert result['symbol'] == 'BTCUSDT'
        assert result['side'] == 'BUY'
        assert result['divap_confirmado'] == True
        assert result['analysis_confirmed'] == True
        assert result['conta_nome'] == 'Test Account'
        assert result['user_nome'] == 'Test User'
        
        print("✅ Full Workflow Integration - PASSOU")

    # =============== TESTE DE PERFORMANCE ===============
    
    def test_bulk_operations_performance(self):
        """Testa performance com múltiplas operações"""
        import time
        
        # Criar estrutura base
        user_id, corretora_id, conta_id = self.create_test_user_and_account()
        
        # Inserir múltiplos symbols
        symbols = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'DOTUSDT', 'LINKUSDT']
        
        start_time = time.time()
        
        for symbol in symbols:
            # Exchange symbol
            self.cursor.execute("""
                INSERT INTO exchange_symbols (exchange, symbol, status, base_asset, quote_asset)
                VALUES (%s, %s, %s, %s, %s)
            """, ('binance', symbol, 'TRADING', symbol[:3], 'USDT'))
            
            # Leverage brackets
            for bracket in range(1, 4):
                self.cursor.execute("""
                    INSERT INTO exchange_leverage_brackets 
                    (symbol, corretora, bracket, initial_leverage, notional_cap,
                     notional_floor, maint_margin_ratio, cum)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """, (symbol, 'binance', bracket, 125-bracket*25, 5000*bracket, 
                      0 if bracket == 1 else 5000*(bracket-1), 0.004+bracket*0.001, bracket*5.0))
            
            # Webhook signals
            for i in range(10):
                self.cursor.execute("""
                    INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct,
                                               entry_price, sl_price, status, timeframe)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """, (conta_id, symbol, 'BUY' if i % 2 == 0 else 'SELL', 10, 2.5,
                      45000.00 + i*100, 44000.00 + i*100, 'PENDING', '15m'))
        
        insert_time = time.time() - start_time
        
        # Testar queries complexas
        start_time = time.time()
        
        self.cursor.execute("""
            SELECT 
                ws.symbol,
                COUNT(*) as signal_count,
                AVG(ws.entry_price) as avg_entry,
                COUNT(CASE WHEN ws.side = 'BUY' THEN 1 END) as buy_count,
                COUNT(CASE WHEN ws.side = 'SELL' THEN 1 END) as sell_count
            FROM webhook_signals ws
            JOIN contas c ON ws.conta_id = c.id
            GROUP BY ws.symbol
            ORDER BY signal_count DESC
        """)
        
        results = self.cursor.fetchall()
        query_time = time.time() - start_time
        
        assert len(results) == 5  # 5 symbols
        assert all(result['signal_count'] == 10 for result in results)
        
        print(f"✅ Bulk Operations Performance - PASSOU")
        print(f"   Insert time: {insert_time:.3f}s")
        print(f"   Query time: {query_time:.3f}s")
        print(f"   Total records: {len(symbols) * (1 + 3 + 10)} = {len(symbols) * 14}")

if __name__ == "__main__":
    import asyncio
    
    def run_all_tests():
        """Executa todos os testes"""
        test_class = TestDivapIndicators()
        test_class.setup_class()
        
        tests = [
            test_class.test_exchange_bracket_updater_database_operations,
            test_class.test_exchange_bracket_mock_api_response,
            test_class.test_exchange_info_updater_database_operations,
            test_class.test_divap_get_leverage_brackets,
            test_class.test_divap_get_active_accounts,
            test_class.test_divap_extract_trade_info,
            test_class.test_divap_save_to_database,
            test_class.test_divap_analyzer_signal_operations,
            test_class.test_divap_analyzer_save_analysis,
            test_class.test_full_workflow_integration,
            test_class.test_bulk_operations_performance
        ]
        
        print("🚀 Iniciando testes dos módulos DIVAP...")
        print("="*60)
        
        passed = 0
        failed = 0
        
        for i, test in enumerate(tests, 1):
            try:
                test_class.setup_method()
                print(f"\n[{i}/{len(tests)}] Executando {test.__name__}...")
                test()
                test_class.teardown_method()
                passed += 1
            except Exception as e:
                print(f"❌ {test.__name__} - FALHOU: {e}")
                test_class.teardown_method()
                failed += 1
        
        print("\n" + "="*60)
        print(f"🎉 Testes dos módulos DIVAP concluídos!")
        print(f"✅ Passaram: {passed}")
        print(f"❌ Falharam: {failed}")
        print(f"📊 Taxa de sucesso: {(passed/(passed+failed)*100):.1f}%")
    
    # Executar testes
    run_all_tests()
