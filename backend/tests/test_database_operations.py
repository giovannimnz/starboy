"""
Testes completos para operações de banco de dados PostgreSQL
Cobre todas as operações CRUD com dados mock
"""

import psycopg2
from psycopg2.extras import RealDictCursor
import sys
import os
from datetime import datetime, timedelta
import json
from decimal import Decimal

# Adicionar path do projeto
sys.path.append(os.path.join(os.path.dirname(__file__), '..'))

# Importar configurações
from database_config import get_database_connection, test_connection, execute_query

class TestDatabaseOperations:
    """Classe para testes de operações de banco de dados"""
    
    def __init__(self):
        """Inicializar teste"""
        self.conn = None
        
    def setup(self):
        """Setup para os testes"""
        self.conn = get_database_connection()
        
    def teardown(self):
        """Cleanup após os testes"""
        if self.conn and not self.conn.closed:
            # Limpar dados de teste
            self.cleanup_test_data()
            self.conn.close()
    
    def cleanup_test_data(self):
        """Remove dados de teste"""
        if not self.conn or self.conn.closed:
            return
            
        cursor = self.conn.cursor()
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
                print(f"Erro ao limpar tabela {table}: {e}")
        
        cursor.close()

    # =============== TESTES DE USUÁRIOS ===============
    
    def test_users_crud(self):
        """Testa operações CRUD na tabela users"""
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        
        try:
            # CREATE - Inserir usuário
            user_data = {
                'nome': 'João Silva',
                'email': 'joao@example.com',
                'senha': 'senha_hash_123',
                'ativa': True
            }
            
            cursor.execute("""
                INSERT INTO users (nome, email, senha, ativa)
                VALUES (%(nome)s, %(email)s, %(senha)s, %(ativa)s)
                RETURNING id
            """, user_data)
            
            result = cursor.fetchone()
            user_id = result['id']
            assert user_id is not None
            print(f"✅ User criado com ID: {user_id}")
            
            # READ - Buscar usuário
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            user = cursor.fetchone()
            assert user is not None
            assert user['nome'] == user_data['nome']
            assert user['email'] == user_data['email']
            assert user['ativa'] == user_data['ativa']
            print(f"✅ User encontrado: {user['nome']}")
            
            # UPDATE - Atualizar usuário
            new_nome = 'João Silva Santos'
            cursor.execute("""
                UPDATE users 
                SET nome = %s
                WHERE id = %s
            """, (new_nome, user_id))
            
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            updated_user = cursor.fetchone()
            assert updated_user['nome'] == new_nome
            print(f"✅ User atualizado: {updated_user['nome']}")
            
            # DELETE - Remover usuário
            cursor.execute("DELETE FROM users WHERE id = %s", (user_id,))
            cursor.execute("SELECT * FROM users WHERE id = %s", (user_id,))
            deleted_user = cursor.fetchone()
            assert deleted_user is None
            print("✅ User deletado com sucesso")
            
        finally:
            cursor.close()

    # =============== TESTES DE CORRETORAS ===============
    
    def test_corretoras_crud(self):
        """Testa operações CRUD na tabela corretoras"""
        cursor = self.conn.cursor(cursor_factory=RealDictCursor)
        
        try:
            # CREATE
            corretora_data = {
                'corretora': 'binance',
                'ambiente': 'testnet',
                'ativa': True
            }
            
            cursor.execute("""
                INSERT INTO corretoras (corretora, ambiente, ativa)
                VALUES (%(corretora)s, %(ambiente)s, %(ativa)s)
                RETURNING id
            """, corretora_data)
            
            result = cursor.fetchone()
            corretora_id = result['id']
            assert corretora_id is not None
            print(f"✅ Corretora criada com ID: {corretora_id}")
            
            # READ
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_id,))
            corretora = cursor.fetchone()
            assert corretora['corretora'] == corretora_data['corretora']
            assert corretora['ambiente'] == corretora_data['ambiente']
            print(f"✅ Corretora encontrada: {corretora['corretora']}")
            
            # UPDATE
            new_ambiente = 'production'
            cursor.execute("""
                UPDATE corretoras 
                SET ambiente = %s
                WHERE id = %s
            """, (new_ambiente, corretora_id))
            
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_id,))
            updated_corretora = cursor.fetchone()
            assert updated_corretora['ambiente'] == new_ambiente
            print(f"✅ Corretora atualizada: {updated_corretora['ambiente']}")
            
            # DELETE
            cursor.execute("DELETE FROM corretoras WHERE id = %s", (corretora_id,))
            cursor.execute("SELECT * FROM corretoras WHERE id = %s", (corretora_id,))
            deleted_corretora = cursor.fetchone()
            assert deleted_corretora is None
            print("✅ Corretora deletada com sucesso")
            
        finally:
            cursor.close()
            print("✅ Corretora deletada com sucesso")

    # =============== TESTES DE CONTAS ===============
    
    async def test_contas_crud(self):
        """Testa operações CRUD na tabela contas"""
        async with self.pool.acquire() as conn:
            # Primeiro criar usuário e corretora
            user_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo)
                VALUES ($1, $2, $3, $4) RETURNING id
            """, 'Teste User', 'teste@example.com', 'hash123', True)
            user_id = user_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ($1, $2, $3, $4) RETURNING id
            """, 'binance', 'testnet', 'Binance Test', True)
            corretora_id = corretora_result['id']
            
            # CREATE
            conta_data = {
                'nome': 'Conta Principal',
                'api_key': 'test_api_key_123',
                'api_secret': 'test_secret_456',
                'ativa': True,
                'saldo_base_calculo_futuros': Decimal('1000.00'),
                'max_posicoes': 5,
                'telegram_chat_id': -123456789,
                'user_id': user_id,
                'id_corretora': corretora_id
            }
            
            result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, saldo_base_calculo_futuros, 
                                  max_posicoes, telegram_chat_id, user_id, id_corretora)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING id
            """, conta_data['nome'], conta_data['api_key'], conta_data['api_secret'],
                conta_data['ativa'], conta_data['saldo_base_calculo_futuros'],
                conta_data['max_posicoes'], conta_data['telegram_chat_id'],
                conta_data['user_id'], conta_data['id_corretora'])
            
            conta_id = result['id']
            assert conta_id is not None
            print(f"✅ Conta criada com ID: {conta_id}")
            
            # READ
            conta = await conn.fetchrow("SELECT * FROM contas WHERE id = $1", conta_id)
            assert conta['nome'] == conta_data['nome']
            assert conta['saldo_base_calculo_futuros'] == conta_data['saldo_base_calculo_futuros']
            print(f"✅ Conta encontrada: {conta['nome']}")
            
            # UPDATE
            novo_saldo = Decimal('2000.00')
            await conn.execute("""
                UPDATE contas 
                SET saldo_base_calculo_futuros = $1, atualizado_em = $2 
                WHERE id = $3
            """, novo_saldo, datetime.now(), conta_id)
            
            updated_conta = await conn.fetchrow("SELECT * FROM contas WHERE id = $1", conta_id)
            assert updated_conta['saldo_base_calculo_futuros'] == novo_saldo
            print(f"✅ Conta atualizada: saldo = {updated_conta['saldo_base_calculo_futuros']}")
            
            # DELETE
            await conn.execute("DELETE FROM contas WHERE id = $1", conta_id)
            deleted_conta = await conn.fetchrow("SELECT * FROM contas WHERE id = $1", conta_id)
            assert deleted_conta is None
            print("✅ Conta deletada com sucesso")

    # =============== TESTES DE EXCHANGE SYMBOLS ===============
    
    async def test_exchange_symbols_crud(self):
        """Testa operações CRUD na tabela exchange_symbols"""
        async with self.pool.acquire() as conn:
            # CREATE
            symbol_data = {
                'exchange': 'binance',
                'symbol': 'BTCUSDT',
                'status': 'TRADING',
                'pair': 'BTCUSDT',
                'contract_type': 'PERPETUAL',
                'base_asset': 'BTC',
                'quote_asset': 'USDT',
                'margin_asset': 'USDT',
                'price_precision': 2,
                'quantity_precision': 6,
                'base_asset_precision': 8,
                'quote_precision': 8,
                'liquidation_fee': Decimal('0.005'),
                'market_take_bound': Decimal('0.10')
            }
            
            result = await conn.fetchrow("""
                INSERT INTO exchange_symbols (exchange, symbol, status, pair, contract_type,
                                            base_asset, quote_asset, margin_asset, price_precision,
                                            quantity_precision, base_asset_precision, quote_precision,
                                            liquidation_fee, market_take_bound)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING id
            """, symbol_data['exchange'], symbol_data['symbol'], symbol_data['status'],
                symbol_data['pair'], symbol_data['contract_type'], symbol_data['base_asset'],
                symbol_data['quote_asset'], symbol_data['margin_asset'], symbol_data['price_precision'],
                symbol_data['quantity_precision'], symbol_data['base_asset_precision'],
                symbol_data['quote_precision'], symbol_data['liquidation_fee'],
                symbol_data['market_take_bound'])
            
            symbol_id = result['id']
            assert symbol_id is not None
            print(f"✅ Exchange Symbol criado com ID: {symbol_id}")
            
            # READ
            symbol = await conn.fetchrow("SELECT * FROM exchange_symbols WHERE id = $1", symbol_id)
            assert symbol['symbol'] == symbol_data['symbol']
            assert symbol['exchange'] == symbol_data['exchange']
            print(f"✅ Symbol encontrado: {symbol['symbol']}")
            
            # UPDATE
            new_status = 'BREAK'
            await conn.execute("""
                UPDATE exchange_symbols 
                SET status = $1, atualizado_em = $2 
                WHERE id = $3
            """, new_status, datetime.now(), symbol_id)
            
            updated_symbol = await conn.fetchrow("SELECT * FROM exchange_symbols WHERE id = $1", symbol_id)
            assert updated_symbol['status'] == new_status
            print(f"✅ Symbol atualizado: status = {updated_symbol['status']}")
            
            # DELETE
            await conn.execute("DELETE FROM exchange_symbols WHERE id = $1", symbol_id)
            deleted_symbol = await conn.fetchrow("SELECT * FROM exchange_symbols WHERE id = $1", symbol_id)
            assert deleted_symbol is None
            print("✅ Symbol deletado com sucesso")

    # =============== TESTES DE EXCHANGE LEVERAGE BRACKETS ===============
    
    async def test_leverage_brackets_crud(self):
        """Testa operações CRUD na tabela exchange_leverage_brackets"""
        async with self.pool.acquire() as conn:
            # CREATE
            bracket_data = {
                'symbol': 'BTCUSDT',
                'corretora': 'binance',
                'bracket': 1,
                'initial_leverage': 125,
                'notional_cap': Decimal('5000.00'),
                'notional_floor': Decimal('0.00'),
                'maint_margin_ratio': Decimal('0.004'),
                'cum': Decimal('0.00')
            }
            
            result = await conn.fetchrow("""
                INSERT INTO exchange_leverage_brackets (symbol, corretora, bracket, initial_leverage,
                                                       notional_cap, notional_floor, maint_margin_ratio, cum)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id
            """, bracket_data['symbol'], bracket_data['corretora'], bracket_data['bracket'],
                bracket_data['initial_leverage'], bracket_data['notional_cap'],
                bracket_data['notional_floor'], bracket_data['maint_margin_ratio'],
                bracket_data['cum'])
            
            bracket_id = result['id']
            assert bracket_id is not None
            print(f"✅ Leverage Bracket criado com ID: {bracket_id}")
            
            # READ
            bracket = await conn.fetchrow("SELECT * FROM exchange_leverage_brackets WHERE id = $1", bracket_id)
            assert bracket['symbol'] == bracket_data['symbol']
            assert bracket['initial_leverage'] == bracket_data['initial_leverage']
            print(f"✅ Bracket encontrado: {bracket['symbol']} - {bracket['initial_leverage']}x")
            
            # UPDATE
            new_leverage = 100
            await conn.execute("""
                UPDATE exchange_leverage_brackets 
                SET initial_leverage = $1, updated_at = $2 
                WHERE id = $3
            """, new_leverage, datetime.now(), bracket_id)
            
            updated_bracket = await conn.fetchrow("SELECT * FROM exchange_leverage_brackets WHERE id = $1", bracket_id)
            assert updated_bracket['initial_leverage'] == new_leverage
            print(f"✅ Bracket atualizado: leverage = {updated_bracket['initial_leverage']}x")
            
            # DELETE
            await conn.execute("DELETE FROM exchange_leverage_brackets WHERE id = $1", bracket_id)
            deleted_bracket = await conn.fetchrow("SELECT * FROM exchange_leverage_brackets WHERE id = $1", bracket_id)
            assert deleted_bracket is None
            print("✅ Bracket deletado com sucesso")

    # =============== TESTES DE POSIÇÕES ===============
    
    async def test_posicoes_crud(self):
        """Testa operações CRUD na tabela posicoes"""
        async with self.pool.acquire() as conn:
            # Criar conta primeiro
            conta_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) VALUES ('Test', 'test@test.com', 'hash', true)
                RETURNING id
            """)
            user_id = conta_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Test', true) RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
                VALUES ('Test Account', 'key', 'secret', true, $1, $2) RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            # CREATE
            posicao_data = {
                'conta_id': conta_id,
                'symbol': 'BTCUSDT',
                'position_amt': Decimal('0.001'),
                'entry_price': Decimal('45000.00'),
                'mark_price': Decimal('45500.00'),
                'unrealized_pnl': Decimal('0.50'),
                'position_side': 'LONG',
                'status': 'OPEN',
                'margin_type': 'isolated',
                'isolated_wallet': Decimal('100.00'),
                'breakeven_price': Decimal('45000.00'),
                'accumulated_realized': Decimal('0.00'),
                'event_reason': 'ORDER_TRADE_UPDATE',
                'last_update': datetime.now()
            }
            
            result = await conn.fetchrow("""
                INSERT INTO posicoes (conta_id, symbol, position_amt, entry_price, mark_price,
                                    unrealized_pnl, position_side, status, margin_type,
                                    isolated_wallet, breakeven_price, accumulated_realized,
                                    event_reason, last_update)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING id
            """, posicao_data['conta_id'], posicao_data['symbol'], posicao_data['position_amt'],
                posicao_data['entry_price'], posicao_data['mark_price'], posicao_data['unrealized_pnl'],
                posicao_data['position_side'], posicao_data['status'], posicao_data['margin_type'],
                posicao_data['isolated_wallet'], posicao_data['breakeven_price'],
                posicao_data['accumulated_realized'], posicao_data['event_reason'],
                posicao_data['last_update'])
            
            posicao_id = result['id']
            assert posicao_id is not None
            print(f"✅ Posição criada com ID: {posicao_id}")
            
            # READ
            posicao = await conn.fetchrow("SELECT * FROM posicoes WHERE id = $1", posicao_id)
            assert posicao['symbol'] == posicao_data['symbol']
            assert posicao['position_side'] == posicao_data['position_side']
            print(f"✅ Posição encontrada: {posicao['symbol']} {posicao['position_side']}")
            
            # UPDATE
            new_mark_price = Decimal('46000.00')
            new_unrealized_pnl = Decimal('1.00')
            await conn.execute("""
                UPDATE posicoes 
                SET mark_price = $1, unrealized_pnl = $2, last_update = $3
                WHERE id = $4
            """, new_mark_price, new_unrealized_pnl, datetime.now(), posicao_id)
            
            updated_posicao = await conn.fetchrow("SELECT * FROM posicoes WHERE id = $1", posicao_id)
            assert updated_posicao['mark_price'] == new_mark_price
            assert updated_posicao['unrealized_pnl'] == new_unrealized_pnl
            print(f"✅ Posição atualizada: mark_price = {updated_posicao['mark_price']}")
            
            # DELETE
            await conn.execute("DELETE FROM posicoes WHERE id = $1", posicao_id)
            deleted_posicao = await conn.fetchrow("SELECT * FROM posicoes WHERE id = $1", posicao_id)
            assert deleted_posicao is None
            print("✅ Posição deletada com sucesso")

    # =============== TESTES DE ORDENS ===============
    
    async def test_ordens_crud(self):
        """Testa operações CRUD na tabela ordens"""
        async with self.pool.acquire() as conn:
            # Criar dependências
            conta_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) VALUES ('Test', 'test@test.com', 'hash', true)
                RETURNING id
            """)
            user_id = conta_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Test', true) RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
                VALUES ('Test Account', 'key', 'secret', true, $1, $2) RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            # CREATE
            ordem_data = {
                'conta_id': conta_id,
                'symbol': 'BTCUSDT',
                'order_id': 123456789,
                'client_order_id': 'test_order_001',
                'side': 'BUY',
                'order_type': 'LIMIT',
                'time_in_force': 'GTC',
                'quantity': Decimal('0.001'),
                'price': Decimal('45000.00'),
                'status': 'NEW',
                'executed_qty': Decimal('0.000'),
                'cumulative_quote_qty': Decimal('0.00'),
                'avg_price': Decimal('0.00'),
                'order_time': datetime.now(),
                'update_time': datetime.now(),
                'position_side': 'LONG',
                'reduce_only': False,
                'close_position': False
            }
            
            result = await conn.fetchrow("""
                INSERT INTO ordens (conta_id, symbol, order_id, client_order_id, side, order_type,
                                  time_in_force, quantity, price, status, executed_qty,
                                  cumulative_quote_qty, avg_price, order_time, update_time,
                                  position_side, reduce_only, close_position)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
                RETURNING id
            """, ordem_data['conta_id'], ordem_data['symbol'], ordem_data['order_id'],
                ordem_data['client_order_id'], ordem_data['side'], ordem_data['order_type'],
                ordem_data['time_in_force'], ordem_data['quantity'], ordem_data['price'],
                ordem_data['status'], ordem_data['executed_qty'], ordem_data['cumulative_quote_qty'],
                ordem_data['avg_price'], ordem_data['order_time'], ordem_data['update_time'],
                ordem_data['position_side'], ordem_data['reduce_only'], ordem_data['close_position'])
            
            ordem_id = result['id']
            assert ordem_id is not None
            print(f"✅ Ordem criada com ID: {ordem_id}")
            
            # READ
            ordem = await conn.fetchrow("SELECT * FROM ordens WHERE id = $1", ordem_id)
            assert ordem['symbol'] == ordem_data['symbol']
            assert ordem['side'] == ordem_data['side']
            assert ordem['status'] == ordem_data['status']
            print(f"✅ Ordem encontrada: {ordem['symbol']} {ordem['side']} - {ordem['status']}")
            
            # UPDATE
            new_status = 'FILLED'
            new_executed_qty = ordem_data['quantity']
            await conn.execute("""
                UPDATE ordens 
                SET status = $1, executed_qty = $2, update_time = $3
                WHERE id = $4
            """, new_status, new_executed_qty, datetime.now(), ordem_id)
            
            updated_ordem = await conn.fetchrow("SELECT * FROM ordens WHERE id = $1", ordem_id)
            assert updated_ordem['status'] == new_status
            assert updated_ordem['executed_qty'] == new_executed_qty
            print(f"✅ Ordem atualizada: status = {updated_ordem['status']}")
            
            # DELETE
            await conn.execute("DELETE FROM ordens WHERE id = $1", ordem_id)
            deleted_ordem = await conn.fetchrow("SELECT * FROM ordens WHERE id = $1", ordem_id)
            assert deleted_ordem is None
            print("✅ Ordem deletada com sucesso")

    # =============== TESTES DE WEBHOOK SIGNALS ===============
    
    async def test_webhook_signals_crud(self):
        """Testa operações CRUD na tabela webhook_signals"""
        async with self.pool.acquire() as conn:
            # Criar conta
            conta_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) VALUES ('Test', 'test@test.com', 'hash', true)
                RETURNING id
            """)
            user_id = conta_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Test', true) RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
                VALUES ('Test Account', 'key', 'secret', true, $1, $2) RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            # CREATE
            signal_data = {
                'conta_id': conta_id,
                'symbol': 'BTCUSDT',
                'side': 'BUY',
                'leverage': 10,
                'capital_pct': Decimal('2.5'),
                'entry_price': Decimal('45000.00'),
                'sl_price': Decimal('44000.00'),
                'tp1_price': Decimal('46000.00'),
                'tp2_price': Decimal('47000.00'),
                'tp3_price': Decimal('48000.00'),
                'tp4_price': Decimal('49000.00'),
                'tp5_price': Decimal('50000.00'),
                'chat_id': -123456789,
                'status': 'PENDING',
                'timeframe': '15m',
                'message_id': 12345,
                'message_source': 'DIVAP',
                'divap_confirmado': True,
                'cancelado_checker': False
            }
            
            result = await conn.fetchrow("""
                INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct, 
                                           entry_price, sl_price, tp1_price, tp2_price, tp3_price,
                                           tp4_price, tp5_price, chat_id, status, timeframe,
                                           message_id, message_source, divap_confirmado, cancelado_checker)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                RETURNING id
            """, signal_data['conta_id'], signal_data['symbol'], signal_data['side'],
                signal_data['leverage'], signal_data['capital_pct'], signal_data['entry_price'],
                signal_data['sl_price'], signal_data['tp1_price'], signal_data['tp2_price'],
                signal_data['tp3_price'], signal_data['tp4_price'], signal_data['tp5_price'],
                signal_data['chat_id'], signal_data['status'], signal_data['timeframe'],
                signal_data['message_id'], signal_data['message_source'],
                signal_data['divap_confirmado'], signal_data['cancelado_checker'])
            
            signal_id = result['id']
            assert signal_id is not None
            print(f"✅ Webhook Signal criado com ID: {signal_id}")
            
            # READ
            signal = await conn.fetchrow("SELECT * FROM webhook_signals WHERE id = $1", signal_id)
            assert signal['symbol'] == signal_data['symbol']
            assert signal['side'] == signal_data['side']
            assert signal['status'] == signal_data['status']
            print(f"✅ Signal encontrado: {signal['symbol']} {signal['side']} - {signal['status']}")
            
            # UPDATE
            new_status = 'EXECUTED'
            await conn.execute("""
                UPDATE webhook_signals 
                SET status = $1, atualizado_em = $2
                WHERE id = $3
            """, new_status, datetime.now(), signal_id)
            
            updated_signal = await conn.fetchrow("SELECT * FROM webhook_signals WHERE id = $1", signal_id)
            assert updated_signal['status'] == new_status
            print(f"✅ Signal atualizado: status = {updated_signal['status']}")
            
            # DELETE
            await conn.execute("DELETE FROM webhook_signals WHERE id = $1", signal_id)
            deleted_signal = await conn.fetchrow("SELECT * FROM webhook_signals WHERE id = $1", signal_id)
            assert deleted_signal is None
            print("✅ Signal deletado com sucesso")

    # =============== TESTES DE DIVAP ANALYSIS ===============
    
    async def test_divap_analysis_crud(self):
        """Testa operações CRUD na tabela divap_analysis"""
        async with self.pool.acquire() as conn:
            # Criar signal primeiro
            conta_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) VALUES ('Test', 'test@test.com', 'hash', true)
                RETURNING id
            """)
            user_id = conta_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Test', true) RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
                VALUES ('Test Account', 'key', 'secret', true, $1, $2) RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            signal_result = await conn.fetchrow("""
                INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct, entry_price, sl_price, status)
                VALUES ($1, 'BTCUSDT', 'BUY', 10, 2.5, 45000.00, 44000.00, 'PENDING') RETURNING id
            """, conta_id)
            signal_id = signal_result['id']
            
            # CREATE
            analysis_data = {
                'signal_id': signal_id,
                'is_bull_divap': True,
                'is_bear_divap': False,
                'divap_confirmed': True,
                'rsi': Decimal('65.5'),
                'volume': Decimal('1500000'),
                'volume_sma': Decimal('1200000'),
                'high_volume': True,
                'bull_div': True,
                'bear_div': False,
                'message': 'DIVAP pattern confirmed with high volume',
                'bull_reversal_pattern': True,
                'bear_reversal_pattern': False
            }
            
            result = await conn.fetchrow("""
                INSERT INTO divap_analysis (signal_id, is_bull_divap, is_bear_divap, divap_confirmed,
                                          rsi, volume, volume_sma, high_volume, bull_div, bear_div,
                                          message, bull_reversal_pattern, bear_reversal_pattern)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
                RETURNING id
            """, analysis_data['signal_id'], analysis_data['is_bull_divap'], analysis_data['is_bear_divap'],
                analysis_data['divap_confirmed'], analysis_data['rsi'], analysis_data['volume'],
                analysis_data['volume_sma'], analysis_data['high_volume'], analysis_data['bull_div'],
                analysis_data['bear_div'], analysis_data['message'], analysis_data['bull_reversal_pattern'],
                analysis_data['bear_reversal_pattern'])
            
            analysis_id = result['id']
            assert analysis_id is not None
            print(f"✅ DIVAP Analysis criada com ID: {analysis_id}")
            
            # READ
            analysis = await conn.fetchrow("SELECT * FROM divap_analysis WHERE id = $1", analysis_id)
            assert analysis['signal_id'] == analysis_data['signal_id']
            assert analysis['divap_confirmed'] == analysis_data['divap_confirmed']
            print(f"✅ Analysis encontrada: Signal {analysis['signal_id']} - Confirmed: {analysis['divap_confirmed']}")
            
            # UPDATE
            new_message = 'Updated analysis with additional confirmation'
            await conn.execute("""
                UPDATE divap_analysis 
                SET message = $1, analyzed_at = $2
                WHERE id = $3
            """, new_message, datetime.now(), analysis_id)
            
            updated_analysis = await conn.fetchrow("SELECT * FROM divap_analysis WHERE id = $1", analysis_id)
            assert updated_analysis['message'] == new_message
            print(f"✅ Analysis atualizada: message = {updated_analysis['message'][:50]}...")
            
            # DELETE
            await conn.execute("DELETE FROM divap_analysis WHERE id = $1", analysis_id)
            deleted_analysis = await conn.fetchrow("SELECT * FROM divap_analysis WHERE id = $1", analysis_id)
            assert deleted_analysis is None
            print("✅ Analysis deletada com sucesso")

    # =============== TESTES DE LOGS ===============
    
    async def test_logs_crud(self):
        """Testa operações CRUD na tabela logs"""
        async with self.pool.acquire() as conn:
            # Criar conta
            conta_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) VALUES ('Test', 'test@test.com', 'hash', true)
                RETURNING id
            """)
            user_id = conta_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Test', true) RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora)
                VALUES ('Test Account', 'key', 'secret', true, $1, $2) RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            # CREATE
            log_data = {
                'conta_id': conta_id,
                'modulo': 'webhook',
                'nivel': 'INFO',
                'mensagem': 'Teste de log do sistema',
                'detalhes': json.dumps({'symbol': 'BTCUSDT', 'action': 'test'}),
                'timestamp': datetime.now()
            }
            
            result = await conn.fetchrow("""
                INSERT INTO logs (conta_id, modulo, nivel, mensagem, detalhes, timestamp)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id
            """, log_data['conta_id'], log_data['modulo'], log_data['nivel'],
                log_data['mensagem'], log_data['detalhes'], log_data['timestamp'])
            
            log_id = result['id']
            assert log_id is not None
            print(f"✅ Log criado com ID: {log_id}")
            
            # READ
            log = await conn.fetchrow("SELECT * FROM logs WHERE id = $1", log_id)
            assert log['modulo'] == log_data['modulo']
            assert log['nivel'] == log_data['nivel']
            print(f"✅ Log encontrado: {log['modulo']} - {log['nivel']}")
            
            # UPDATE
            new_nivel = 'WARNING'
            await conn.execute("""
                UPDATE logs 
                SET nivel = $1
                WHERE id = $2
            """, new_nivel, log_id)
            
            updated_log = await conn.fetchrow("SELECT * FROM logs WHERE id = $1", log_id)
            assert updated_log['nivel'] == new_nivel
            print(f"✅ Log atualizado: nivel = {updated_log['nivel']}")
            
            # DELETE
            await conn.execute("DELETE FROM logs WHERE id = $1", log_id)
            deleted_log = await conn.fetchrow("SELECT * FROM logs WHERE id = $1", log_id)
            assert deleted_log is None
            print("✅ Log deletado com sucesso")

    # =============== TESTE DE OPERAÇÕES COMPLEXAS ===============
    
    async def test_complex_queries(self):
        """Testa queries complexas com JOINs e agregações"""
        async with self.pool.acquire() as conn:
            # Criar dados de teste completos
            user_result = await conn.fetchrow("""
                INSERT INTO users (nome, email, senha, ativo) 
                VALUES ('Complex Test User', 'complex@test.com', 'hash', true) 
                RETURNING id
            """)
            user_id = user_result['id']
            
            corretora_result = await conn.fetchrow("""
                INSERT INTO corretoras (corretora, ambiente, nome_exibicao, ativa)
                VALUES ('binance', 'testnet', 'Binance Test', true) 
                RETURNING id
            """)
            corretora_id = corretora_result['id']
            
            conta_result = await conn.fetchrow("""
                INSERT INTO contas (nome, api_key, api_secret, ativa, user_id, id_corretora,
                                  saldo_base_calculo_futuros, max_posicoes, telegram_chat_id)
                VALUES ('Complex Test Account', 'key123', 'secret456', true, $1, $2,
                        1000.00, 5, -123456789)
                RETURNING id
            """, user_id, corretora_id)
            conta_id = conta_result['id']
            
            # Criar múltiplos signals
            symbols = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT']
            signal_ids = []
            
            for symbol in symbols:
                signal_result = await conn.fetchrow("""
                    INSERT INTO webhook_signals (conta_id, symbol, side, leverage, capital_pct, 
                                               entry_price, sl_price, status, timeframe)
                    VALUES ($1, $2, 'BUY', 10, 2.5, 45000.00, 44000.00, 'PENDING', '15m')
                    RETURNING id
                """, conta_id, symbol)
                signal_ids.append(signal_result['id'])
            
            # Query complexa: Buscar signals com informações da conta e usuário
            results = await conn.fetch("""
                SELECT 
                    ws.id as signal_id,
                    ws.symbol,
                    ws.side,
                    ws.status,
                    ws.created_at,
                    c.nome as conta_nome,
                    c.saldo_base_calculo_futuros,
                    u.nome as user_nome,
                    u.email as user_email,
                    cor.nome_exibicao as corretora_nome
                FROM webhook_signals ws
                JOIN contas c ON ws.conta_id = c.id
                JOIN users u ON c.user_id = u.id
                JOIN corretoras cor ON c.id_corretora = cor.id
                WHERE ws.conta_id = $1
                ORDER BY ws.created_at DESC
            """, conta_id)
            
            assert len(results) == 3
            for result in results:
                assert result['conta_nome'] == 'Complex Test Account'
                assert result['user_nome'] == 'Complex Test User'
                assert result['corretora_nome'] == 'Binance Test'
            
            print(f"✅ Query complexa executada: {len(results)} registros encontrados")
            
            # Agregação: Contar signals por status
            status_count = await conn.fetchrow("""
                SELECT 
                    COUNT(*) as total_signals,
                    COUNT(CASE WHEN status = 'PENDING' THEN 1 END) as pending_count,
                    COUNT(CASE WHEN status = 'EXECUTED' THEN 1 END) as executed_count,
                    AVG(capital_pct) as avg_capital_pct
                FROM webhook_signals 
                WHERE conta_id = $1
            """, conta_id)
            
            assert status_count['total_signals'] == 3
            assert status_count['pending_count'] == 3
            assert status_count['executed_count'] == 0
            print(f"✅ Agregação executada: {status_count['total_signals']} signals total")

if __name__ == "__main__":
    import asyncio
    
    async def run_all_tests():
        """Executa todos os testes"""
        test_class = TestDatabaseOperations()
        test_class.setup_class()
        
        tests = [
            test_class.test_users_crud,
            test_class.test_corretoras_crud,
            test_class.test_contas_crud,
            test_class.test_exchange_symbols_crud,
            test_class.test_leverage_brackets_crud,
            test_class.test_posicoes_crud,
            test_class.test_ordens_crud,
            test_class.test_webhook_signals_crud,
            test_class.test_divap_analysis_crud,
            test_class.test_logs_crud,
            test_class.test_complex_queries
        ]
        
        print("🚀 Iniciando testes de banco de dados PostgreSQL...")
        print("="*60)
        
        for i, test in enumerate(tests, 1):
            try:
                await test_class.setup_method()
                print(f"\n[{i}/{len(tests)}] Executando {test.__name__}...")
                await test()
                await test_class.teardown_method()
                print(f"✅ {test.__name__} - PASSOU")
            except Exception as e:
                print(f"❌ {test.__name__} - FALHOU: {e}")
                await test_class.teardown_method()
        
        print("\n" + "="*60)
        print("🎉 Testes de banco de dados concluídos!")
    
    # Executar testes
    asyncio.run(run_all_tests())
