#!/usr/bin/env python3
"""
DIVAP Scraper - Busca sinais do banco de dados para análise
"""

import sys
import os
import psycopg2
from psycopg2.extras import RealDictCursor
from datetime import datetime, timedelta
from pathlib import Path
from dotenv import load_dotenv
import logging

# Configurar logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("DIVAP_Scraper")

# Configurar paths
sys.path.append(str(Path(__file__).parent.parent))

# Carregar variáveis de ambiente
env_path = Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# Configurações do banco
DB_CONFIG = {
    'host': os.getenv('DB_HOST'),
    'port': int(os.getenv('DB_PORT', 5432)),
    'user': os.getenv('DB_USER'),
    'password': os.getenv('DB_PASSWORD'),
    'database': os.getenv('DB_NAME')
}

class DivapScraper:
    """Scraper para buscar sinais DIVAP do banco de dados"""
    
    def __init__(self, db_config):
        self.db_config = db_config
        self.conn = None
        self.cursor = None
        
    def connect_db(self):
        """Conecta ao banco de dados"""
        try:
            self.conn = psycopg2.connect(**self.db_config)
            self.cursor = self.conn.cursor(cursor_factory=RealDictCursor)
            logger.info("Conectado ao banco de dados")
        except Exception as e:
            logger.error(f"Erro ao conectar ao banco: {e}")
            raise
    
    def close_connections(self):
        """Fecha conexões"""
        if self.cursor:
            self.cursor.close()
        if self.conn:
            self.conn.close()
        logger.info("Conexões fechadas")
    
    def get_available_channels(self):
        """Obtém canais disponíveis com sinais"""
        try:
            query = """
                SELECT 
                    chat_id_orig_sinal,
                    COUNT(*) as total_signals,
                    MIN(created_at) as first_signal,
                    MAX(created_at) as last_signal
                FROM webhook_signals 
                WHERE chat_id_orig_sinal IS NOT NULL
                GROUP BY chat_id_orig_sinal
                ORDER BY total_signals DESC
            """
            
            self.cursor.execute(query)
            channels = self.cursor.fetchall()
            
            logger.info(f"Encontrados {len(channels)} canais com sinais")
            return channels
            
        except Exception as e:
            logger.error(f"Erro ao obter canais: {e}")
            return []
    
    def get_signals_by_channel(self, channel_id, start_date=None, end_date=None, limit=None):
        """Obtém sinais de um canal específico"""
        try:
            query = """
                SELECT ws.*, sa.divap_confirmed, sa.analysis_type
                FROM webhook_signals ws
                LEFT JOIN signals_analysis sa ON ws.id = sa.signal_id
                WHERE ws.chat_id_orig_sinal = %s
            """
            
            params = [channel_id]
            
            if start_date:
                query += " AND ws.created_at >= %s"
                params.append(start_date)
            
            if end_date:
                query += " AND ws.created_at <= %s"
                params.append(end_date)
            
            query += " ORDER BY ws.created_at DESC"
            
            if limit:
                query += " LIMIT %s"
                params.append(limit)
            
            self.cursor.execute(query, params)
            signals = self.cursor.fetchall()
            
            logger.info(f"Obtidos {len(signals)} sinais do canal {channel_id}")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao obter sinais: {e}")
            return []
    
    def get_signals_by_date_range(self, start_date, end_date, channel_id=None):
        """Obtém sinais por período de data"""
        try:
            query = """
                SELECT ws.*, sa.divap_confirmed, sa.analysis_type
                FROM webhook_signals ws
                LEFT JOIN signals_analysis sa ON ws.id = sa.signal_id
                WHERE ws.created_at >= %s AND ws.created_at <= %s
            """
            
            params = [start_date, end_date]
            
            if channel_id:
                query += " AND ws.chat_id_orig_sinal = %s"
                params.append(channel_id)
            
            query += " ORDER BY ws.created_at DESC"
            
            self.cursor.execute(query, params)
            signals = self.cursor.fetchall()
            
            logger.info(f"Obtidos {len(signals)} sinais do período")
            return signals
            
        except Exception as e:
            logger.error(f"Erro ao obter sinais: {e}")
            return []
    
    def print_channels_summary(self):
        """Imprime resumo dos canais disponíveis"""
        channels = self.get_available_channels()
        
        if not channels:
            print("❌ Nenhum canal com sinais encontrado")
            return
        
        print("\n" + "="*80)
        print("📊 RESUMO DOS CANAIS DISPONÍVEIS")
        print("="*80)
        
        for channel in channels:
            first_signal = channel['first_signal'].strftime('%d-%m-%Y %H:%M:%S')
            last_signal = channel['last_signal'].strftime('%d-%m-%Y %H:%M:%S')
            
            print(f"\n🔗 Canal: {channel['chat_id_orig_sinal']}")
            print(f"   📊 Total de sinais: {channel['total_signals']}")
            print(f"   📅 Primeiro sinal: {first_signal}")
            print(f"   📅 Último sinal: {last_signal}")
    
    def print_signals_summary(self, signals, title="SINAIS"):
        """Imprime resumo dos sinais"""
        if not signals:
            print("❌ Nenhum sinal encontrado")
            return
        
        print(f"\n" + "="*80)
        print(f"📋 {title}")
        print("="*80)
        
        for i, signal in enumerate(signals[:10]):  # Mostrar apenas os primeiros 10
            signal_date = signal.get('created_at')
            if isinstance(signal_date, str):
                signal_datetime = datetime.fromisoformat(signal_date.replace('Z', '+00:00'))
            else:
                signal_datetime = signal_date
            
            formatted_date = signal_datetime.strftime('%d-%m-%Y %H:%M:%S')
            divap_status = "✅ DIVAP" if signal.get('divap_confirmed') else "❌ Não DIVAP"
            
            print(f"{i+1:2d}. {signal.get('symbol'):10} {signal.get('side'):6} - {formatted_date} - {divap_status}")
        
        if len(signals) > 10:
            print(f"... e mais {len(signals) - 10} sinais")

def main():
    """Função principal"""
    print("="*80)
    print("🔍 DIVAP SCRAPER - ANÁLISE DE SINAIS DO BANCO")
    print("="*80)
    
    scraper = DivapScraper(DB_CONFIG)
    
    try:
        scraper.connect_db()
        
        # Mostrar resumo dos canais
        scraper.print_channels_summary()
        
        # Obter sinais dos últimos 7 dias
        print("\n🔍 Buscando sinais dos últimos 7 dias...")
        end_date = datetime.now()
        start_date = end_date - timedelta(days=7)
        
        signals = scraper.get_signals_by_date_range(start_date, end_date)
        scraper.print_signals_summary(signals, "SINAIS DOS ÚLTIMOS 7 DIAS")
        
        # Buscar sinais do canal específico se solicitado
        target_channel = -1002444455075
        print(f"\n🔍 Buscando sinais do canal específico {target_channel}...")
        
        specific_signals = scraper.get_signals_by_channel(target_channel, limit=10)
        scraper.print_signals_summary(specific_signals, f"SINAIS DO CANAL {target_channel}")
        
    except Exception as e:
        logger.error(f"Erro no scraper: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        scraper.close_connections()

if __name__ == "__main__":
    main()
