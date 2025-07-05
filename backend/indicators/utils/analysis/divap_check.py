"""
Analisador DIVAP para verificação de padrões em sinais de trading
"""

import os
import sys
import ccxt
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timedelta
import json
import logging
from pathlib import Path
from dotenv import load_dotenv

# Configurar o caminho do .env
env_path = Path(__file__).parents[4] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

# Configurações da Binance
BINANCE_CONFIG = {
    'apiKey': os.getenv('BINANCE_API_KEY'),
    'secret': os.getenv('BINANCE_SECRET_KEY'),
    'sandbox': False,
    'enableRateLimit': True,
}

# Fallback para senhas.py se as variáveis de ambiente não estiverem definidas
if not BINANCE_CONFIG['apiKey'] or not BINANCE_CONFIG['secret']:
    try:
        sys.path.append(str(Path(__file__).parent.parent))
        from senhas import API_KEY, API_SECRET
        BINANCE_CONFIG['apiKey'] = API_KEY
        BINANCE_CONFIG['secret'] = API_SECRET
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [CONFIG] Usando credenciais do senhas.py")
    except ImportError:
        print(f"[{datetime.now().strftime('%d-%m-%Y | %H:%M:%S')}] [ERRO] Credenciais Binance não encontradas")

logger = logging.getLogger(__name__)

class DIVAPAnalyzer:
    """
    Analisador DIVAP para verificação de padrões em sinais de trading
    """
    
    def __init__(self, db_config=None, binance_config=None):
        self.db_config = db_config or DB_CONFIG
        self.binance_config = binance_config or BINANCE_CONFIG
        self.conn = None
        self.cursor = None
        self.exchange = None
        
    def connect_db(self):
        """Conecta ao banco de dados"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("Conectado ao banco de dados PostgreSQL")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco: {e}")
            raise
    
    def connect_exchange(self):
        """Conecta à exchange Binance"""
        try:
            self.exchange = ccxt.binance(self.binance_config)
            self.exchange.load_markets()
            logger.info("Conectado à Binance")
        except Exception as e:
            logger.error(f"Erro ao conectar à Binance: {e}")
            raise
    
    def close_connections(self):
        """Fecha as conexões"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")
    
    def analyze_signal(self, signal_data):
        """
        Analisa um sinal para verificar se é DIVAP
        
        Args:
            signal_data: Dados do sinal a ser analisado
            
        Returns:
            dict: Resultado da análise
        """
        try:
            # Análise básica do sinal
            symbol = signal_data.get('symbol', '')
            side = signal_data.get('side', '')
            entry_price = float(signal_data.get('entry_price', 0))
            stop_loss = float(signal_data.get('sl_price', 0))
            
            # Verificar se é um sinal válido
            if not symbol or not side or not entry_price or not stop_loss:
                return {
                    'signal_id': signal_data.get('id'),
                    'divap_confirmed': False,
                    'reason': 'Dados do sinal incompletos',
                    'analysis_type': 'divap_check'
                }
            
            # Análise DIVAP (implementação simplificada)
            divap_result = self.check_divap_pattern(signal_data)
            
            return {
                'signal_id': signal_data.get('id'),
                'divap_confirmed': divap_result['is_divap'],
                'confidence': divap_result.get('confidence', 0),
                'reason': divap_result.get('reason', 'Análise concluída'),
                'analysis_type': 'divap_check'
            }
            
        except Exception as e:
            logger.error(f"Erro na análise do sinal: {e}")
            return {
                'signal_id': signal_data.get('id'),
                'divap_confirmed': False,
                'reason': f'Erro na análise: {str(e)}',
                'analysis_type': 'divap_check'
            }
    
    def check_divap_pattern(self, signal_data):
        """
        Verifica se o sinal apresenta padrão DIVAP
        
        Args:
            signal_data: Dados do sinal
            
        Returns:
            dict: Resultado da verificação
        """
        try:
            # Implementação simplificada do padrão DIVAP
            entry_price = float(signal_data.get('entry_price', 0))
            stop_loss = float(signal_data.get('sl_price', 0))
            
            # Critérios básicos para DIVAP (exemplo)
            risk_reward_ratio = abs(entry_price - stop_loss) / entry_price
            is_divap = risk_reward_ratio < 0.1  # Risco menor que 10%
            confidence = max(0, 100 - risk_reward_ratio * 100)
            
            return {
                'is_divap': is_divap,
                'confidence': confidence,
                'reason': f'Risk/Reward ratio: {risk_reward_ratio:.2f}',
                'risk_reward_ratio': risk_reward_ratio
            }
            
        except Exception as e:
            logger.error(f"Erro ao verificar padrão DIVAP: {e}")
            return {
                'is_divap': False,
                'confidence': 0,
                'reason': f'Erro na verificação: {str(e)}'
            }
    
    def save_analysis_result(self, analysis_result):
        """Salva o resultado da análise no banco"""
        try:
            insert_query = """
                INSERT INTO signals_analysis (
                    signal_id, divap_confirmed, confidence, reason,
                    analysis_type, created_at
                ) VALUES (
                    %s, %s, %s, %s, %s, %s
                )
                ON CONFLICT (signal_id, analysis_type) 
                DO UPDATE SET
                    divap_confirmed = EXCLUDED.divap_confirmed,
                    confidence = EXCLUDED.confidence,
                    reason = EXCLUDED.reason,
                    updated_at = %s
            """
            
            values = (
                analysis_result.get('signal_id'),
                analysis_result.get('divap_confirmed'),
                analysis_result.get('confidence'),
                analysis_result.get('reason'),
                analysis_result.get('analysis_type'),
                datetime.now(),
                datetime.now()
            )
            
            self.cursor.execute(insert_query, values)
            self.conn.commit()
            
            logger.info(f"Resultado da análise salvo para sinal {analysis_result.get('signal_id')}")
            
        except Exception as e:
            logger.error(f"Erro ao salvar resultado da análise: {e}")
            if self.conn:
                self.conn.rollback()

if __name__ == "__main__":
    # Teste do analisador
    analyzer = DIVAPAnalyzer()
    
    print("Teste do DIVAPAnalyzer")
    print("Configurações carregadas:", bool(DB_CONFIG.get('host')))
