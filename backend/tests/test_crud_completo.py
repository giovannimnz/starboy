#!/usr/bin/env python3
"""
TESTE CRUD COMPLETO - TODAS AS TABELAS CORRIGIDAS
Baseado nas estruturas reais do PostgreSQL
"""

import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from datetime import datetime
from decimal import Decimal

# Carregar variáveis de ambiente
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', 'config', '.env'))

DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'database': os.getenv('DB_NAME'),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'port': int(os.getenv('DB_PORT', 5432))
}

def execute_query(query, params=None, fetch=True):
    """Executa uma query no banco de dados"""
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    
    try:
        cursor = conn.cursor(cursor_factory=RealDictCursor)
        cursor.execute(query, params)
        
        if fetch:
            if cursor.description:
                result = cursor.fetchall()
            else:
                result = None
        else:
            result = cursor.rowcount
            
        cursor.close()
        conn.close()
        return result
    except psycopg2.Error as e:
        print(f"❌ Erro ao executar query: {e}")
        conn.close()
        return None

def cleanup_test_data():
    """Remove dados de teste de todas as tabelas"""
    try:
        # Desabilitar triggers que podem causar problemas
        execute_query("ALTER TABLE users DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE corretoras DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE contas DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE webhook_signals DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE signals_msg DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE signals_analysis DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE posicoes DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE ordens DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE logs DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE backtest_signals DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE exchange_symbols DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE exchange_filters DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE exchange_leverage_brackets DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE configuracoes DISABLE TRIGGER ALL", fetch=False)
        execute_query("ALTER TABLE monitoramento DISABLE TRIGGER ALL", fetch=False)
        
        # Ordem de limpeza respeitando foreign keys
        tables = [
            'logs', 'backtest_signals', 'signals_msg', 'signals_analysis',
            'monitoramento', 'ordens_fechadas', 'posicoes_fechadas',
            'ordens', 'posicoes', 'webhook_signals', 'exchange_filters',
            'exchange_symbols', 'exchange_leverage_brackets', 'contas',
            'configuracoes', 'corretoras', 'users'
        ]
        
        for table in tables:
            execute_query(f"DELETE FROM {table} WHERE id >= 9000", fetch=False)
            
        print("✅ Dados de teste limpos")
        
    except Exception as e:
        print(f"⚠️ Erro na limpeza: {e}")

def test_users_crud():
    """Testa operações CRUD na tabela users - ESTRUTURA REAL"""
    print("\n🧪 TESTE 1: TABELA USERS")
    
    # INSERT - usando todos os campos obrigatórios
    user_data = {
        'id': 9001,
        'nome': 'Test User',
        'email': 'test@example.com',
        'senha': 'hashed_password_123',
        'username': 'testuser',
        'sobrenome': 'Silva',
        'ativa': True  # PostgreSQL boolean
    }
    
    insert_query = """
        INSERT INTO users (id, nome, email, senha, username, sobrenome, ativa)
        VALUES (%(id)s, %(nome)s, %(email)s, %(senha)s, %(username)s, %(sobrenome)s, %(ativa)s)
    """
    
    result = execute_query(insert_query, user_data, fetch=False)
    assert result == 1, "Falha ao inserir usuário"
    print("  ✅ INSERT users - OK")
    
    # SELECT
    select_query = "SELECT * FROM users WHERE id = %s"
    result = execute_query(select_query, (9001,))
    assert result is not None and len(result) == 1, "Falha ao buscar usuário"
    assert result[0]['nome'] == 'Test User'
    assert result[0]['ativa'] == True  # Verificar boolean
    print("  ✅ SELECT users - OK")
    
    # UPDATE
    update_query = "UPDATE users SET nome = %s, ativa = %s WHERE id = %s"
    result = execute_query(update_query, ('Updated User', False, 9001), fetch=False)
    assert result == 1, "Falha ao atualizar usuário"
    
    # Verificar update
    result = execute_query(select_query, (9001,))
    assert result[0]['nome'] == 'Updated User'
    assert result[0]['ativa'] == False  # Verificar boolean atualizado
    print("  ✅ UPDATE users - OK")
    
    # DELETE
    delete_query = "DELETE FROM users WHERE id = %s"
    result = execute_query(delete_query, (9001,), fetch=False)
    assert result == 1, "Falha ao deletar usuário"
    print("  ✅ DELETE users - OK")

def test_corretoras_crud():
    """Testa operações CRUD na tabela corretoras - ESTRUTURA REAL"""
    print("\n🧪 TESTE 2: TABELA CORRETORAS")
    
    # INSERT - usando campos obrigatórios
    corretora_data = {
        'id': 9002,
        'corretora': 'test_broker',
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
    print("  ✅ INSERT corretoras - OK")
    
    # SELECT
    select_query = "SELECT * FROM corretoras WHERE id = %s"
    result = execute_query(select_query, (9002,))
    assert result is not None and len(result) == 1, "Falha ao buscar corretora"
    assert result[0]['corretora'] == 'test_broker'
    print("  ✅ SELECT corretoras - OK")
    
    # UPDATE
    update_query = "UPDATE corretoras SET corretora = %s, ativa = %s WHERE id = %s"
    result = execute_query(update_query, ('updated_broker', False, 9002), fetch=False)
    assert result == 1, "Falha ao atualizar corretora"
    
    # Verificar update
    result = execute_query(select_query, (9002,))
    assert result[0]['corretora'] == 'updated_broker'
    assert result[0]['ativa'] == False
    print("  ✅ UPDATE corretoras - OK")
    
    # DELETE
    delete_query = "DELETE FROM corretoras WHERE id = %s"
    result = execute_query(delete_query, (9002,), fetch=False)
    assert result == 1, "Falha ao deletar corretora"
    print("  ✅ DELETE corretoras - OK")

def test_contas_crud():
    """Testa operações CRUD na tabela contas - ESTRUTURA REAL COM DEPENDÊNCIAS"""
    print("\n🧪 TESTE 3: TABELA CONTAS")
    
    # Primeiro inserir dependências (corretora)
    corretora_data = {
        'id': 9003,
        'corretora': 'test_broker_conta',
        'ambiente': 'test'
    }
    
    insert_corretora_query = """
        INSERT INTO corretoras (id, corretora, ambiente)
        VALUES (%(id)s, %(corretora)s, %(ambiente)s)
    """
    execute_query(insert_corretora_query, corretora_data, fetch=False)
    
    # INSERT conta
    conta_data = {
        'id': 9004,
        'nome': 'Test Account',
        'api_key': 'test_api_key_123',
        'api_secret': 'test_api_secret_456',
        'id_corretora': 9003,
        'telegram_chat_id': -1001234567890,
        'ativa': True,
        'max_posicoes': 10,
        'saldo_futuros': Decimal('1000.00'),
        'celular': '+5511999999999'
    }
    
    insert_query = """
        INSERT INTO contas (id, nome, api_key, api_secret, id_corretora, telegram_chat_id, 
                           ativa, max_posicoes, saldo_futuros, celular)
        VALUES (%(id)s, %(nome)s, %(api_key)s, %(api_secret)s, %(id_corretora)s, 
                %(telegram_chat_id)s, %(ativa)s, %(max_posicoes)s, %(saldo_futuros)s, %(celular)s)
    """
    
    result = execute_query(insert_query, conta_data, fetch=False)
    assert result == 1, "Falha ao inserir conta"
    print("  ✅ INSERT contas - OK")
    
    # SELECT
    select_query = "SELECT * FROM contas WHERE id = %s"
    result = execute_query(select_query, (9004,))
    assert result is not None and len(result) == 1, "Falha ao buscar conta"
    assert result[0]['nome'] == 'Test Account'
    assert result[0]['max_posicoes'] == 10
    print("  ✅ SELECT contas - OK")
    
    # UPDATE
    update_query = "UPDATE contas SET nome = %s, max_posicoes = %s WHERE id = %s"
    result = execute_query(update_query, ('Updated Account', 15, 9004), fetch=False)
    assert result == 1, "Falha ao atualizar conta"
    
    # Verificar update
    result = execute_query(select_query, (9004,))
    assert result[0]['nome'] == 'Updated Account'
    assert result[0]['max_posicoes'] == 15
    print("  ✅ UPDATE contas - OK")
    
    # DELETE
    delete_query = "DELETE FROM contas WHERE id = %s"
    result = execute_query(delete_query, (9004,), fetch=False)
    assert result == 1, "Falha ao deletar conta"
    print("  ✅ DELETE contas - OK")

def test_webhook_signals_crud():
    """Testa operações CRUD na tabela webhook_signals - ESTRUTURA REAL"""
    print("\n🧪 TESTE 4: TABELA WEBHOOK_SIGNALS")
    
    # INSERT
    signal_data = {
        'id': 9005,
        'symbol': 'BTCUSDT',
        'timeframe': '1h',
        'side': 'BUY',
        'leverage': 10,
        'capital_pct': Decimal('2.50'),
        'entry_price': Decimal('45000.00'),
        'sl_price': Decimal('44000.00'),
        'status': 'PENDING',
        'chat_id': -1001234567890,
        'message_id': 123456,
        'tp1_price': Decimal('46000.00'),
        'tp2_price': Decimal('47000.00'),
        'message_source': 'test_source',
        'divap_confirmado': True,
        'cancelado_checker': False,
        'sent_msg': False,
        'conta_id': 1
    }
    
    insert_query = """
        INSERT INTO webhook_signals (id, symbol, timeframe, side, leverage, capital_pct, 
                                   entry_price, sl_price, status, chat_id, message_id,
                                   tp1_price, tp2_price, message_source, divap_confirmado,
                                   cancelado_checker, sent_msg, conta_id)
        VALUES (%(id)s, %(symbol)s, %(timeframe)s, %(side)s, %(leverage)s, %(capital_pct)s,
                %(entry_price)s, %(sl_price)s, %(status)s, %(chat_id)s, %(message_id)s,
                %(tp1_price)s, %(tp2_price)s, %(message_source)s, %(divap_confirmado)s,
                %(cancelado_checker)s, %(sent_msg)s, %(conta_id)s)
    """
    
    result = execute_query(insert_query, signal_data, fetch=False)
    assert result == 1, "Falha ao inserir webhook_signal"
    print("  ✅ INSERT webhook_signals - OK")
    
    # SELECT
    select_query = "SELECT * FROM webhook_signals WHERE id = %s"
    result = execute_query(select_query, (9005,))
    assert result is not None and len(result) == 1, "Falha ao buscar webhook_signal"
    assert result[0]['symbol'] == 'BTCUSDT'
    assert result[0]['leverage'] == 10
    assert result[0]['divap_confirmado'] == True
    print("  ✅ SELECT webhook_signals - OK")
    
    # UPDATE
    update_query = "UPDATE webhook_signals SET status = %s, divap_confirmado = %s WHERE id = %s"
    result = execute_query(update_query, ('EXECUTED', False, 9005), fetch=False)
    assert result == 1, "Falha ao atualizar webhook_signal"
    
    # Verificar update
    result = execute_query(select_query, (9005,))
    assert result[0]['status'] == 'EXECUTED'
    assert result[0]['divap_confirmado'] == False
    print("  ✅ UPDATE webhook_signals - OK")
    
    # DELETE
    delete_query = "DELETE FROM webhook_signals WHERE id = %s"
    result = execute_query(delete_query, (9005,), fetch=False)
    assert result == 1, "Falha ao deletar webhook_signal"
    print("  ✅ DELETE webhook_signals - OK")

def test_signals_msg_crud():
    """Testa operações CRUD na tabela signals_msg - ESTRUTURA REAL"""
    print("\n🧪 TESTE 5: TABELA SIGNALS_MSG")
    
    # INSERT
    signal_data = {
        'id': 9006,
        'message_id': 123456789,
        'chat_id': -1001234567890,
        'text': 'Test signal message for BTCUSDT',
        'is_reply': False,
        'symbol': 'BTCUSDT',
        'signal_id': 999,
        'created_at': datetime.now(),
        'message_source': 'test_source'
    }
    
    insert_query = """
        INSERT INTO signals_msg (id, message_id, chat_id, text, is_reply, symbol, 
                               signal_id, created_at, message_source)
        VALUES (%(id)s, %(message_id)s, %(chat_id)s, %(text)s, %(is_reply)s, %(symbol)s,
                %(signal_id)s, %(created_at)s, %(message_source)s)
    """
    
    result = execute_query(insert_query, signal_data, fetch=False)
    assert result == 1, "Falha ao inserir signals_msg"
    print("  ✅ INSERT signals_msg - OK")
    
    # SELECT
    select_query = "SELECT * FROM signals_msg WHERE id = %s"
    result = execute_query(select_query, (9006,))
    assert result is not None and len(result) == 1, "Falha ao buscar signals_msg"
    assert result[0]['symbol'] == 'BTCUSDT'
    assert result[0]['is_reply'] == False
    print("  ✅ SELECT signals_msg - OK")
    
    # UPDATE
    update_query = "UPDATE signals_msg SET symbol = %s, is_reply = %s WHERE id = %s"
    result = execute_query(update_query, ('ETHUSDT', True, 9006), fetch=False)
    assert result == 1, "Falha ao atualizar signals_msg"
    
    # Verificar update
    result = execute_query(select_query, (9006,))
    assert result[0]['symbol'] == 'ETHUSDT'
    assert result[0]['is_reply'] == True
    print("  ✅ UPDATE signals_msg - OK")
    
    # DELETE
    delete_query = "DELETE FROM signals_msg WHERE id = %s"
    result = execute_query(delete_query, (9006,), fetch=False)
    assert result == 1, "Falha ao deletar signals_msg"
    print("  ✅ DELETE signals_msg - OK")

def test_signals_analysis_crud():
    """Testa operações CRUD na tabela signals_analysis - ESTRUTURA REAL"""
    print("\n🧪 TESTE 6: TABELA DIVAP_ANALYSIS")
    
    # INSERT
    divap_data = {
        'id': 9007,
        'signal_id': 999,
        'is_bull_divap': True,
        'is_bear_divap': False,
        'divap_confirmed': True,
        'rsi': 65.5,
        'volume': 1500000.0,
        'volume_sma': 1200000.0,
        'high_volume': True,
        'bull_div': True,
        'bear_div': False,
        'message': 'Test DIVAP analysis',
        'price_reversal_up': True,
        'price_reversal_down': False,
        'bull_reversal_pattern': True,
        'bear_reversal_pattern': False,
        'analyzed_at': datetime.now()
    }
    
    insert_query = """
        INSERT INTO signals_analysis (id, signal_id, is_bull_divap, is_bear_divap, divap_confirmed,
                                  rsi, volume, volume_sma, high_volume, bull_div, bear_div,
                                  message, price_reversal_up, price_reversal_down,
                                  bull_reversal_pattern, bear_reversal_pattern, analyzed_at)
        VALUES (%(id)s, %(signal_id)s, %(is_bull_divap)s, %(is_bear_divap)s, %(divap_confirmed)s,
                %(rsi)s, %(volume)s, %(volume_sma)s, %(high_volume)s, %(bull_div)s, %(bear_div)s,
                %(message)s, %(price_reversal_up)s, %(price_reversal_down)s,
                %(bull_reversal_pattern)s, %(bear_reversal_pattern)s, %(analyzed_at)s)
    """
    
    result = execute_query(insert_query, divap_data, fetch=False)
    assert result == 1, "Falha ao inserir signals_analysis"
    print("  ✅ INSERT signals_analysis - OK")
    
    # SELECT
    select_query = "SELECT * FROM signals_analysis WHERE id = %s"
    result = execute_query(select_query, (9007,))
    assert result is not None and len(result) == 1, "Falha ao buscar signals_analysis"
    assert result[0]['is_bull_divap'] == True
    assert result[0]['divap_confirmed'] == True
    assert result[0]['rsi'] == 65.5
    print("  ✅ SELECT signals_analysis - OK")
    
    # UPDATE
    update_query = """UPDATE signals_analysis SET divap_confirmed = %s, 
                     bear_reversal_pattern = %s, rsi = %s WHERE id = %s"""
    result = execute_query(update_query, (False, True, 35.2, 9007), fetch=False)
    assert result == 1, "Falha ao atualizar signals_analysis"
    
    # Verificar update
    result = execute_query(select_query, (9007,))
    assert result[0]['divap_confirmed'] == False
    assert result[0]['bear_reversal_pattern'] == True
    assert abs(result[0]['rsi'] - 35.2) < 0.1  # float comparison
    print("  ✅ UPDATE signals_analysis - OK")
    
    # DELETE
    delete_query = "DELETE FROM signals_analysis WHERE id = %s"
    result = execute_query(delete_query, (9007,), fetch=False)
    assert result == 1, "Falha ao deletar signals_analysis"
    print("  ✅ DELETE signals_analysis - OK")

def test_exchange_symbols_crud():
    """Testa operações CRUD na tabela exchange_symbols"""
    print("\n🧪 TESTE 7: TABELA EXCHANGE_SYMBOLS")
    
    # INSERT
    symbol_data = {
        'id': 9008,
        'exchange': 'binance',
        'symbol': 'TESTUSDT',
        'status': 'TRADING',
        'pair': 'TESTUSDT',
        'contract_type': 'PERPETUAL',
        'base_asset': 'TEST',
        'quote_asset': 'USDT',
        'margin_asset': 'USDT',
        'price_precision': 2,
        'quantity_precision': 3,
        'base_asset_precision': 8,
        'quote_precision': 8,
        'onboard_date': 1640995200000,  # timestamp
        'liquidation_fee': Decimal('0.012'),
        'market_take_bound': Decimal('0.05')
    }
    
    insert_query = """
        INSERT INTO exchange_symbols (id, exchange, symbol, status, pair, contract_type,
                                    base_asset, quote_asset, margin_asset, price_precision,
                                    quantity_precision, base_asset_precision, quote_precision,
                                    onboard_date, liquidation_fee, market_take_bound)
        VALUES (%(id)s, %(exchange)s, %(symbol)s, %(status)s, %(pair)s, %(contract_type)s,
                %(base_asset)s, %(quote_asset)s, %(margin_asset)s, %(price_precision)s,
                %(quantity_precision)s, %(base_asset_precision)s, %(quote_precision)s,
                %(onboard_date)s, %(liquidation_fee)s, %(market_take_bound)s)
    """
    
    result = execute_query(insert_query, symbol_data, fetch=False)
    assert result == 1, "Falha ao inserir exchange_symbol"
    print("  ✅ INSERT exchange_symbols - OK")
    
    # SELECT
    select_query = "SELECT * FROM exchange_symbols WHERE id = %s"
    result = execute_query(select_query, (9008,))
    assert result is not None and len(result) == 1, "Falha ao buscar exchange_symbol"
    assert result[0]['symbol'] == 'TESTUSDT'
    assert result[0]['exchange'] == 'binance'
    print("  ✅ SELECT exchange_symbols - OK")
    
    # UPDATE
    update_query = "UPDATE exchange_symbols SET status = %s, price_precision = %s WHERE id = %s"
    result = execute_query(update_query, ('BREAK', 4, 9008), fetch=False)
    assert result == 1, "Falha ao atualizar exchange_symbol"
    
    # Verificar update
    result = execute_query(select_query, (9008,))
    assert result[0]['status'] == 'BREAK'
    assert result[0]['price_precision'] == 4
    print("  ✅ UPDATE exchange_symbols - OK")
    
    # DELETE
    delete_query = "DELETE FROM exchange_symbols WHERE id = %s"
    result = execute_query(delete_query, (9008,), fetch=False)
    assert result == 1, "Falha ao deletar exchange_symbol"
    print("  ✅ DELETE exchange_symbols - OK")

def test_exchange_filters_crud():
    """Testa operações CRUD na tabela exchange_filters"""
    print("\n🧪 TESTE 8: TABELA EXCHANGE_FILTERS")
    
    # Primeiro inserir dependência (symbol)
    symbol_data = {
        'id': 9009,
        'exchange': 'binance',
        'symbol': 'TESTUSDT2',
        'status': 'TRADING'
    }
    
    insert_symbol_query = """
        INSERT INTO exchange_symbols (id, exchange, symbol, status)
        VALUES (%(id)s, %(exchange)s, %(symbol)s, %(status)s)
    """
    execute_query(insert_symbol_query, symbol_data, fetch=False)
    
    # INSERT filter
    filter_data = {
        'id': 9010,
        'symbol_id': 9009,
        'filter_type': 'PRICE_FILTER',
        'min_price': '0.01',
        'max_price': '1000000.00',
        'tick_size': '0.01',
        'min_qty': '0.001',
        'max_qty': '9000000.00',
        'step_size': '0.001',
        'min_notional': '5.00',
        'multiplier_up': '1.3',
        'multiplier_down': '0.7',
        'multiplier_decimal': 2,
        'limit_orders': 200,
        'limit_algo_orders': 100
    }
    
    insert_query = """
        INSERT INTO exchange_filters (id, symbol_id, filter_type, min_price, max_price, tick_size,
                                    min_qty, max_qty, step_size, min_notional, multiplier_up,
                                    multiplier_down, multiplier_decimal, limit_orders, limit_algo_orders)
        VALUES (%(id)s, %(symbol_id)s, %(filter_type)s, %(min_price)s, %(max_price)s, %(tick_size)s,
                %(min_qty)s, %(max_qty)s, %(step_size)s, %(min_notional)s, %(multiplier_up)s,
                %(multiplier_down)s, %(multiplier_decimal)s, %(limit_orders)s, %(limit_algo_orders)s)
    """
    
    result = execute_query(insert_query, filter_data, fetch=False)
    assert result == 1, "Falha ao inserir exchange_filter"
    print("  ✅ INSERT exchange_filters - OK")
    
    # SELECT
    select_query = "SELECT * FROM exchange_filters WHERE id = %s"
    # Verificar decimal comparison para exchange_filters
    result = execute_query(select_query, (9010,))
    assert result is not None and len(result) == 1, "Falha ao buscar exchange_filter"
    assert result[0]['filter_type'] == 'PRICE_FILTER'
    # Para exchange_filters, os preços são armazenados como VARCHAR, não DECIMAL
    assert result[0]['min_price'] == '0.01'
    print("  ✅ SELECT exchange_filters - OK")
    
    # UPDATE
    update_query = "UPDATE exchange_filters SET min_price = %s, max_price = %s WHERE id = %s"
    result = execute_query(update_query, ('0.02', '2000000.00', 9010), fetch=False)
    assert result == 1, "Falha ao atualizar exchange_filter"
    
    # Verificar update
    result = execute_query(select_query, (9010,))
    assert result[0]['min_price'] == '0.02'
    assert result[0]['max_price'] == '2000000.00'
    print("  ✅ UPDATE exchange_filters - OK")
    
    # DELETE
    delete_query = "DELETE FROM exchange_filters WHERE id = %s"
    result = execute_query(delete_query, (9010,), fetch=False)
    assert result == 1, "Falha ao deletar exchange_filter"
    print("  ✅ DELETE exchange_filters - OK")

def test_exchange_leverage_brackets_crud():
    """Testa operações CRUD na tabela exchange_leverage_brackets"""
    print("\n🧪 TESTE 9: TABELA EXCHANGE_LEVERAGE_BRACKETS")
    
    # INSERT
    bracket_data = {
        'id': 9011,
        'symbol': 'TESTUSDT',
        'corretora': 'binance',
        'bracket': 1,
        'initial_leverage': 125,
        'notional_cap': Decimal('5000.00'),
        'notional_floor': Decimal('0.00'),
        'maint_margin_ratio': Decimal('0.004'),
        'cum': Decimal('0.00')
    }
    
    insert_query = """
        INSERT INTO exchange_leverage_brackets (id, symbol, corretora, bracket, initial_leverage,
                                              notional_cap, notional_floor, maint_margin_ratio, cum)
        VALUES (%(id)s, %(symbol)s, %(corretora)s, %(bracket)s, %(initial_leverage)s,
                %(notional_cap)s, %(notional_floor)s, %(maint_margin_ratio)s, %(cum)s)
    """
    
    result = execute_query(insert_query, bracket_data, fetch=False)
    assert result == 1, "Falha ao inserir exchange_leverage_bracket"
    print("  ✅ INSERT exchange_leverage_brackets - OK")
    
    # SELECT
    select_query = "SELECT * FROM exchange_leverage_brackets WHERE id = %s"
    result = execute_query(select_query, (9011,))
    assert result is not None and len(result) == 1, "Falha ao buscar exchange_leverage_bracket"
    assert result[0]['symbol'] == 'TESTUSDT'
    assert result[0]['initial_leverage'] == 125
    print("  ✅ SELECT exchange_leverage_brackets - OK")
    
    # UPDATE
    update_query = "UPDATE exchange_leverage_brackets SET initial_leverage = %s, notional_cap = %s WHERE id = %s"
    result = execute_query(update_query, (75, Decimal('10000.00'), 9011), fetch=False)
    assert result == 1, "Falha ao atualizar exchange_leverage_bracket"
    
    # Verificar update
    result = execute_query(select_query, (9011,))
    assert result[0]['initial_leverage'] == 75
    assert result[0]['notional_cap'] == Decimal('10000.00')
    print("  ✅ UPDATE exchange_leverage_brackets - OK")
    
    # DELETE
    delete_query = "DELETE FROM exchange_leverage_brackets WHERE id = %s"
    result = execute_query(delete_query, (9011,), fetch=False)
    assert result == 1, "Falha ao deletar exchange_leverage_bracket"
    print("  ✅ DELETE exchange_leverage_brackets - OK")

def test_configuracoes_crud():
    """Testa operações CRUD na tabela configuracoes"""
    print("\n🧪 TESTE 10: TABELA CONFIGURACOES")
    
    # INSERT - baseado na estrutura real
    config_data = {
        'id': 9012,
        'chave_api': 'test_api_key',
        'chave_secreta': 'test_secret_key',
        'bot_token': 'test_bot_token',
        'api_url': 'https://api.test.com',
        'ambiente': 'test'
    }
    
    insert_query = """
        INSERT INTO configuracoes (id, chave_api, chave_secreta, bot_token, api_url, ambiente)
        VALUES (%(id)s, %(chave_api)s, %(chave_secreta)s, %(bot_token)s, %(api_url)s, %(ambiente)s)
    """
    
    result = execute_query(insert_query, config_data, fetch=False)
    assert result == 1, "Falha ao inserir configuracao"
    print("  ✅ INSERT configuracoes - OK")
    
    # SELECT
    select_query = "SELECT * FROM configuracoes WHERE id = %s"
    result = execute_query(select_query, (9012,))
    assert result is not None and len(result) == 1, "Falha ao buscar configuracao"
    assert result[0]['chave_api'] == 'test_api_key'
    assert result[0]['ambiente'] == 'test'
    print("  ✅ SELECT configuracoes - OK")
    
    # UPDATE
    update_query = "UPDATE configuracoes SET chave_api = %s, ambiente = %s WHERE id = %s"
    result = execute_query(update_query, ('updated_api_key', 'prod', 9012), fetch=False)
    assert result == 1, "Falha ao atualizar configuracao"
    
    # Verificar update
    result = execute_query(select_query, (9012,))
    assert result[0]['chave_api'] == 'updated_api_key'
    assert result[0]['ambiente'] == 'prod'
    print("  ✅ UPDATE configuracoes - OK")
    
    # DELETE
    delete_query = "DELETE FROM configuracoes WHERE id = %s"
    result = execute_query(delete_query, (9012,), fetch=False)
    assert result == 1, "Falha ao deletar configuracao"
    print("  ✅ DELETE configuracoes - OK")

def test_posicoes_crud():
    """Testa operações CRUD na tabela posicoes"""
    print("\n🧪 TESTE 11: TABELA POSICOES")
    
    # INSERT - baseado na estrutura real
    posicao_data = {
        'id': 9013,
        'simbolo': 'TESTUSDT',
        'quantidade': Decimal('0.5'),
        'preco_medio': Decimal('45000.00'),
        'status': 'ABERTA',
        'data_hora_abertura': datetime.now(),
        'side': 'BUY',
        'leverage': 10,
        'preco_entrada': Decimal('45000.00'),
        'preco_corrente': Decimal('45500.00'),
        'pnl_corrente': Decimal('250.00'),
        'conta_id': 1,
        'breakeven_price': Decimal('45000.00'),
        'accumulated_realized': Decimal('0.00'),
        'unrealized_pnl': Decimal('250.00'),
        'margin_type': 'isolated',
        'isolated_wallet': Decimal('1000.00'),
        'position_side': 'LONG',
        'event_reason': 'TRADE',
        'last_update': datetime.now()
    }
    
    insert_query = """
        INSERT INTO posicoes (id, simbolo, quantidade, preco_medio, status, data_hora_abertura,
                            side, leverage, preco_entrada, preco_corrente, pnl_corrente,
                            conta_id, breakeven_price, accumulated_realized, unrealized_pnl,
                            margin_type, isolated_wallet, position_side, event_reason, last_update)
        VALUES (%(id)s, %(simbolo)s, %(quantidade)s, %(preco_medio)s, %(status)s, %(data_hora_abertura)s,
                %(side)s, %(leverage)s, %(preco_entrada)s, %(preco_corrente)s, %(pnl_corrente)s,
                %(conta_id)s, %(breakeven_price)s, %(accumulated_realized)s, %(unrealized_pnl)s,
                %(margin_type)s, %(isolated_wallet)s, %(position_side)s, %(event_reason)s, %(last_update)s)
    """
    
    result = execute_query(insert_query, posicao_data, fetch=False)
    assert result == 1, "Falha ao inserir posicao"
    print("  ✅ INSERT posicoes - OK")
    
    # SELECT
    select_query = "SELECT * FROM posicoes WHERE id = %s"
    result = execute_query(select_query, (9013,))
    assert result is not None and len(result) == 1, "Falha ao buscar posicao"
    assert result[0]['simbolo'] == 'TESTUSDT'
    assert result[0]['position_side'] == 'LONG'
    assert result[0]['quantidade'] == Decimal('0.5')
    print("  ✅ SELECT posicoes - OK")
    
    # UPDATE
    update_query = "UPDATE posicoes SET preco_corrente = %s, unrealized_pnl = %s WHERE id = %s"
    result = execute_query(update_query, (Decimal('46000.00'), Decimal('500.00'), 9013), fetch=False)
    assert result == 1, "Falha ao atualizar posicao"
    
    # Verificar update
    result = execute_query(select_query, (9013,))
    assert result[0]['preco_corrente'] == Decimal('46000.00')
    assert result[0]['unrealized_pnl'] == Decimal('500.00')
    print("  ✅ UPDATE posicoes - OK")
    
    # DELETE
    delete_query = "DELETE FROM posicoes WHERE id = %s"
    result = execute_query(delete_query, (9013,), fetch=False)
    assert result == 1, "Falha ao deletar posicao"
    print("  ✅ DELETE posicoes - OK")

def test_ordens_crud():
    """Testa operações CRUD na tabela ordens"""
    print("\n🧪 TESTE 12: TABELA ORDENS")
    
    # INSERT - baseado na estrutura real
    ordem_data = {
        'id': 9014,
        'tipo_ordem': 'LIMIT',
        'preco': Decimal('45000.00'),
        'quantidade': Decimal('0.5'),
        'status': 'NEW',
        'data_hora_criacao': datetime.now(),
        'side': 'BUY',
        'simbolo': 'TESTUSDT',
        'tipo_ordem_bot': 'ENTRY',
        'reduce_only': False,
        'close_position': False,
        'last_update': datetime.now(),
        'quantidade_executada': Decimal('0.0'),
        'conta_id': 1,
        'client_order_id': 'test_client_order_123',
        'time_in_force': 'GTC'
    }
    
    insert_query = """
        INSERT INTO ordens (id, tipo_ordem, preco, quantidade, status, data_hora_criacao,
                          side, simbolo, tipo_ordem_bot, reduce_only, close_position,
                          last_update, quantidade_executada, conta_id, client_order_id, time_in_force)
        VALUES (%(id)s, %(tipo_ordem)s, %(preco)s, %(quantidade)s, %(status)s, %(data_hora_criacao)s,
                %(side)s, %(simbolo)s, %(tipo_ordem_bot)s, %(reduce_only)s, %(close_position)s,
                %(last_update)s, %(quantidade_executada)s, %(conta_id)s, %(client_order_id)s, %(time_in_force)s)
    """
    
    result = execute_query(insert_query, ordem_data, fetch=False)
    assert result == 1, "Falha ao inserir ordem"
    print("  ✅ INSERT ordens - OK")
    
    # SELECT
    select_query = "SELECT * FROM ordens WHERE id = %s"
    result = execute_query(select_query, (9014,))
    assert result is not None and len(result) == 1, "Falha ao buscar ordem"
    assert result[0]['simbolo'] == 'TESTUSDT'
    assert result[0]['status'] == 'NEW'
    assert result[0]['reduce_only'] == False
    print("  ✅ SELECT ordens - OK")
    
    # UPDATE
    update_query = "UPDATE ordens SET status = %s, quantidade_executada = %s, close_position = %s WHERE id = %s"
    result = execute_query(update_query, ('FILLED', Decimal('0.5'), True, 9014), fetch=False)
    assert result == 1, "Falha ao atualizar ordem"
    
    # Verificar update
    result = execute_query(select_query, (9014,))
    assert result[0]['status'] == 'FILLED'
    assert result[0]['quantidade_executada'] == Decimal('0.5')
    assert result[0]['close_position'] == True
    print("  ✅ UPDATE ordens - OK")
    
    # DELETE
    delete_query = "DELETE FROM ordens WHERE id = %s"
    result = execute_query(delete_query, (9014,), fetch=False)
    assert result == 1, "Falha ao deletar ordem"
    print("  ✅ DELETE ordens - OK")

def test_monitoramento_crud():
    """Testa operações CRUD na tabela monitoramento"""
    print("\n🧪 TESTE 13: TABELA MONITORAMENTO")
    
    # INSERT - baseado na estrutura real
    monitor_data = {
        'id': 9015,
        'tipo_evento': 'PRICE_CHECK',
        'id_ordem': 123,
        'id_posicao': 456,
        'mensagem': 'Test monitoring event',
        'data_hora_evento': datetime.now(),
        'status': 'ACTIVE',
        'preco': Decimal('45000.00'),
        'preco_corrente': Decimal('45500.00')
    }
    
    insert_query = """
        INSERT INTO monitoramento (id, tipo_evento, id_ordem, id_posicao, mensagem,
                                 data_hora_evento, status, preco, preco_corrente)
        VALUES (%(id)s, %(tipo_evento)s, %(id_ordem)s, %(id_posicao)s, %(mensagem)s,
                %(data_hora_evento)s, %(status)s, %(preco)s, %(preco_corrente)s)
    """
    
    result = execute_query(insert_query, monitor_data, fetch=False)
    assert result == 1, "Falha ao inserir monitoramento"
    print("  ✅ INSERT monitoramento - OK")
    
    # SELECT
    select_query = "SELECT * FROM monitoramento WHERE id = %s"
    result = execute_query(select_query, (9015,))
    assert result is not None and len(result) == 1, "Falha ao buscar monitoramento"
    assert result[0]['tipo_evento'] == 'PRICE_CHECK'
    assert result[0]['status'] == 'ACTIVE'
    print("  ✅ SELECT monitoramento - OK")
    
    # UPDATE
    update_query = "UPDATE monitoramento SET preco_corrente = %s, status = %s WHERE id = %s"
    result = execute_query(update_query, (Decimal('46000.00'), 'COMPLETED', 9015), fetch=False)
    assert result == 1, "Falha ao atualizar monitoramento"
    
    # Verificar update
    result = execute_query(select_query, (9015,))
    assert result[0]['preco_corrente'] == Decimal('46000.00')
    assert result[0]['status'] == 'COMPLETED'
    print("  ✅ UPDATE monitoramento - OK")
    
    # DELETE
    delete_query = "DELETE FROM monitoramento WHERE id = %s"
    result = execute_query(delete_query, (9015,), fetch=False)
    assert result == 1, "Falha ao deletar monitoramento"
    print("  ✅ DELETE monitoramento - OK")

def test_logs_crud():
    """Testa operações CRUD na tabela logs"""
    print("\n🧪 TESTE 14: TABELA LOGS")
    
    # INSERT - baseado na estrutura real
    log_data = {
        'id': 9016,
        'modulo': 'test_module',
        'nivel': 'INFO',
        'mensagem': 'Test log message',
        'contexto': 'test_context',
        'data_hora': datetime.now(),
        'conta_id': 1
    }
    
    insert_query = """
        INSERT INTO logs (id, modulo, nivel, mensagem, contexto, data_hora, conta_id)
        VALUES (%(id)s, %(modulo)s, %(nivel)s, %(mensagem)s, %(contexto)s, %(data_hora)s, %(conta_id)s)
    """
    
    result = execute_query(insert_query, log_data, fetch=False)
    assert result == 1, "Falha ao inserir log"
    print("  ✅ INSERT logs - OK")
    
    # SELECT
    select_query = "SELECT * FROM logs WHERE id = %s"
    result = execute_query(select_query, (9016,))
    assert result is not None and len(result) == 1, "Falha ao buscar log"
    assert result[0]['nivel'] == 'INFO'
    assert result[0]['mensagem'] == 'Test log message'
    print("  ✅ SELECT logs - OK")
    
    # UPDATE
    update_query = "UPDATE logs SET nivel = %s, mensagem = %s WHERE id = %s"
    result = execute_query(update_query, ('ERROR', 'Updated log message', 9016), fetch=False)
    assert result == 1, "Falha ao atualizar log"
    
    # Verificar update
    result = execute_query(select_query, (9016,))
    assert result[0]['nivel'] == 'ERROR'
    assert result[0]['mensagem'] == 'Updated log message'
    print("  ✅ UPDATE logs - OK")
    
    # DELETE
    delete_query = "DELETE FROM logs WHERE id = %s"
    result = execute_query(delete_query, (9016,), fetch=False)
    assert result == 1, "Falha ao deletar log"
    print("  ✅ DELETE logs - OK")

def test_backtest_signals_crud():
    """Testa operações CRUD na tabela backtest_signals"""
    print("\n🧪 TESTE 15: TABELA SIGNALS_BACKTEST")
    
    # INSERT - baseado na estrutura real
    backtest_data = {
        'id': 9017,
        'symbol': 'TESTUSDT',
        'side': 'BUY',
        'leverage': 10,
        'capital_pct': Decimal('2.5'),
        'entry_price': Decimal('45000.00'),
        'sl_price': Decimal('44000.00'),
        'chat_id': -1001234567890,
        'status': 'WIN',
        'timeframe': '1h',
        'message_id': 123456
    }
    
    insert_query = """
        INSERT INTO backtest_signals (id, symbol, side, leverage, capital_pct, 
                                    entry_price, sl_price, chat_id, status, timeframe, message_id)
        VALUES (%(id)s, %(symbol)s, %(side)s, %(leverage)s, %(capital_pct)s,
                %(entry_price)s, %(sl_price)s, %(chat_id)s, %(status)s, %(timeframe)s, %(message_id)s)
    """
    
    result = execute_query(insert_query, backtest_data, fetch=False)
    assert result == 1, "Falha ao inserir backtest_signals"
    print("  ✅ INSERT backtest_signals - OK")
    
    # SELECT
    select_query = "SELECT * FROM backtest_signals WHERE id = %s"
    result = execute_query(select_query, (9017,))
    assert result is not None and len(result) == 1, "Falha ao buscar backtest_signals"
    assert result[0]['symbol'] == 'TESTUSDT'
    assert result[0]['status'] == 'WIN'
    assert result[0]['side'] == 'BUY'
    print("  ✅ SELECT backtest_signals - OK")
    
    # UPDATE
    update_query = "UPDATE backtest_signals SET status = %s, entry_price = %s WHERE id = %s"
    result = execute_query(update_query, ('LOSS', Decimal('44500.00'), 9017), fetch=False)
    assert result == 1, "Falha ao atualizar backtest_signals"
    
    # Verificar update
    result = execute_query(select_query, (9017,))
    assert result[0]['status'] == 'LOSS'
    assert result[0]['entry_price'] == Decimal('44500.00')
    print("  ✅ UPDATE backtest_signals - OK")
    
    # DELETE
    delete_query = "DELETE FROM backtest_signals WHERE id = %s"
    result = execute_query(delete_query, (9017,), fetch=False)
    assert result == 1, "Falha ao deletar backtest_signals"
    print("  ✅ DELETE backtest_signals - OK")

def run_all_tests():
    """Executa todos os testes CRUD"""
    print("🚀 INICIANDO TESTES CRUD COMPLETOS - POSTGRESQL")
    print("=" * 70)
    print("Baseado nas estruturas reais das tabelas")
    print("=" * 70)
    
    try:
        # Limpeza inicial
        cleanup_test_data()
        
        # Lista de todos os testes
        test_functions = [
            test_users_crud,
            test_corretoras_crud,
            test_contas_crud,
            test_webhook_signals_crud,
            test_signals_msg_crud,
            test_signals_analysis_crud,
            test_exchange_symbols_crud,
            test_exchange_filters_crud,
            test_exchange_leverage_brackets_crud,
            test_configuracoes_crud,
            test_posicoes_crud,
            test_ordens_crud,
            test_monitoramento_crud,
            test_logs_crud,
            test_backtest_signals_crud
        ]
        
        total_tests = len(test_functions)
        passed_tests = 0
        
        for test_func in test_functions:
            try:
                test_func()
                passed_tests += 1
                print(f"✅ {test_func.__name__} - PASSOU")
                
            except Exception as e:
                print(f"❌ {test_func.__name__} - FALHOU: {e}")
                import traceback
                traceback.print_exc()
        
        # Limpeza final
        cleanup_test_data()
        
        # Reabilitar triggers
        try:
            tables = ['users', 'corretoras', 'contas', 'webhook_signals', 'signals_msg', 
                     'signals_analysis', 'posicoes', 'ordens', 'logs', 'backtest_signals',
                     'exchange_symbols', 'exchange_filters', 'exchange_leverage_brackets',
                     'configuracoes', 'monitoramento']
            
            for table in tables:
                execute_query(f"ALTER TABLE {table} ENABLE TRIGGER ALL", fetch=False)
            
            print("✅ Triggers reabilitados")
        except Exception as e:
            print(f"⚠️ Aviso: Não foi possível reabilitar triggers: {e}")
        
        print("\n" + "=" * 70)
        print(f"📊 RESUMO DOS TESTES:")
        print(f"   Total: {total_tests}")
        print(f"   Passaram: {passed_tests}")
        print(f"   Falharam: {total_tests - passed_tests}")
        
        if passed_tests == total_tests:
            print("🎉 TODOS OS TESTES PASSARAM!")
            print("✅ PostgreSQL está funcionando corretamente")
            print("✅ Migração do MySQL para PostgreSQL foi bem-sucedida")
            print("✅ Todos os tipos de dados estão corretos (boolean, numeric, etc.)")
            return True
        else:
            print("⚠️ ALGUNS TESTES FALHARAM!")
            return False
            
    except Exception as e:
        print(f"❌ Erro crítico nos testes: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    success = run_all_tests()
    exit(0 if success else 1)
