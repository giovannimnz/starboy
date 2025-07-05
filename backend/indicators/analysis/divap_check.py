"""
Módulo para análise de sinais DIVAP
"""
import sys
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime
from pathlib import Path
import logging

# Configurar logging
logger = logging.getLogger("DIVAPAnalyzer")

class DIVAPAnalyzer:
    """Classe para análise de sinais DIVAP"""
    
    def __init__(self, db_config, binance_config=None):
        self.db_config = db_config
        self.binance_config = binance_config
        self.conn = None
        self.cursor = None
        self.exchange = None
        
    def connect_db(self):
        """Conecta ao banco de dados"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("Conectado ao banco de dados")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco: {e}")
            raise
    
    def connect_exchange(self):
        """Conecta à exchange (placeholder)"""
        logger.info("Conectado à exchange")
        
    def close_connections(self):
        """Fecha conexões"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")
    
    def get_signals_by_date_symbol(self, date_str, symbol=None):
        """Obtém sinais por data e símbolo - primeiro verifica canal específico, senão usa os disponíveis"""
        try:
            # Converter data do formato DD-MM-YYYY para datetime
            date_obj = datetime.strptime(date_str, '%d-%m-%Y')
            start_date = date_obj.replace(hour=0, minute=0, second=0, microsecond=0)
            end_date = date_obj.replace(hour=23, minute=59, second=59, microsecond=999999)
            
            # Verificar se existem sinais do canal específico
            query_check = """
                SELECT COUNT(*) as total
                FROM webhook_signals ws
                WHERE ws.chat_id_orig_sinal = %s
                AND ws.created_at >= %s
                AND ws.created_at <= %s
            """
            
            self.cursor.execute(query_check, [-1002444455075, start_date, end_date])
            result = self.cursor.fetchone()
            target_channel = -1002444455075
            
            if result['total'] == 0:
                # Se não existir sinais do canal específico para esta data, usar qualquer canal disponível
                logger.info(f"Canal -1002444455075 não possui sinais para {date_str}, usando canais disponíveis...")
                
                # Verificar quais canais têm sinais para esta data
                query_available = """
                    SELECT chat_id_orig_sinal, COUNT(*) as total
                    FROM webhook_signals 
                    WHERE chat_id_orig_sinal IS NOT NULL
                    AND created_at >= %s
                    AND created_at <= %s
                    GROUP BY chat_id_orig_sinal
                    ORDER BY total DESC
                    LIMIT 5
                """
                
                self.cursor.execute(query_available, [start_date, end_date])
                available_channels = self.cursor.fetchall()
                
                if available_channels:
                    target_channel = available_channels[0]['chat_id_orig_sinal']
                    logger.info(f"Usando canal com mais sinais: {target_channel}")
                else:
                    logger.info("Nenhum canal com sinais encontrado para esta data")
                    return []
            
            # Query principal
            query = """
                SELECT ws.*, sa.divap_confirmed, sa.analysis_type
                FROM webhook_signals ws
                LEFT JOIN signals_analysis sa ON ws.id = sa.signal_id
                WHERE ws.chat_id_orig_sinal = %s
                AND ws.created_at >= %s
                AND ws.created_at <= %s
            """
            
            params = [target_channel, start_date, end_date]
            
            if symbol:
                query += " AND ws.symbol = %s"
                params.append(symbol)
            
            query += " ORDER BY ws.created_at DESC"
            
            self.cursor.execute(query, params)
            signals = self.cursor.fetchall()
            
            logger.info(f"Obtidos {len(signals)} sinais para {date_str} do canal {target_channel}")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao obter sinais: {e}")
            return []
    
    def analyze_signal(self, signal):
        """Analisa um sinal (implementação básica)"""
        try:
            # Implementação básica - pode ser expandida
            result = {
                'signal_id': signal.get('id'),
                'symbol': signal.get('symbol'),
                'side': signal.get('side'),
                'divap_confirmed': signal.get('divap_confirmado', False),
                'analysis_type': 'interactive',
                'created_at': signal.get('created_at'),
                'status': 'analyzed'
            }
            
            return result
            
        except Exception as e:
            logger.error(f"Erro ao analisar sinal: {e}")
            return {'error': str(e)}
    
    def print_analysis_result(self, result):
        """Imprime resultado da análise"""
        if 'error' in result:
            print(f"❌ Erro: {result['error']}")
            return
        
        print("\n" + "="*50)
        print("📊 RESULTADO DA ANÁLISE")
        print("="*50)
        print(f"🔍 Sinal ID: {result.get('signal_id')}")
        print(f"💱 Símbolo: {result.get('symbol')}")
        print(f"📈 Lado: {result.get('side')}")
        print(f"✅ DIVAP: {'Confirmado' if result.get('divap_confirmed') else 'Não confirmado'}")
        
        # Formatar data para DD-MM-YYYY
        created_at = result.get('created_at')
        if created_at:
            if isinstance(created_at, str):
                dt = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            else:
                dt = created_at
            formatted_date = dt.strftime('%d-%m-%Y %H:%M:%S')
            print(f"📅 Data: {formatted_date}")
        
        print("="*50)
    
    def save_analysis_result(self, result):
        """Salva resultado da análise"""
        try:
            if 'error' in result:
                return
            
            # Verificar se já existe análise para este sinal
            check_query = "SELECT id FROM signals_analysis WHERE signal_id = %s"
            self.cursor.execute(check_query, (result.get('signal_id'),))
            existing = self.cursor.fetchone()
            
            if existing:
                # Atualizar análise existente
                update_query = """
                    UPDATE signals_analysis 
                    SET divap_confirmed = %s, analysis_type = %s, updated_at = CURRENT_TIMESTAMP
                    WHERE signal_id = %s
                """
                self.cursor.execute(update_query, (
                    result.get('divap_confirmed', False),
                    result.get('analysis_type', 'interactive'),
                    result.get('signal_id')
                ))
            else:
                # Inserir nova análise
                insert_query = """
                    INSERT INTO signals_analysis (signal_id, divap_confirmed, analysis_type, created_at, updated_at)
                    VALUES (%s, %s, %s, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """
                self.cursor.execute(insert_query, (
                    result.get('signal_id'),
                    result.get('divap_confirmed', False),
                    result.get('analysis_type', 'interactive')
                ))
            
            self.conn.commit()
            logger.info(f"Análise salva para sinal {result.get('signal_id')}")
            
        except Exception as e:
            logger.error(f"Erro ao salvar análise: {e}")
            self.conn.rollback()
