import asyncio
import os
import re
import sys
import traceback
import mysql.connector
from datetime import datetime, timedelta, timezone
from telethon import TelegramClient, events
from dotenv import load_dotenv
import pathlib
from pathlib import Path
import logging
import warnings

# Importar configurações do divap.py
sys.path.append(str(Path(__file__).parent.parent))
from divap import (
    extract_trade_info, format_trade_message, save_to_database, 
    save_message_to_database, initialize_divap_analyzer, verify_divap_pattern,
    pers_api_id, pers_api_hash, DB_CONFIG, CONTA_ID
)

# --- Configuração de Logging ---
logging.basicConfig(level=logging.ERROR)
logging.getLogger('telethon').setLevel(logging.CRITICAL)
warnings.filterwarnings("ignore", category=DeprecationWarning)

# --- Carregamento de Variáveis de Ambiente ---
env_path = pathlib.Path(__file__).parents[3] / 'config' / '.env'
load_dotenv(dotenv_path=env_path)

# --- Configurações Globais ---
GRUPOS_ORIGEM_DISPONIVEIS = {
    -1002444455075: "IA de Divap",
    -1002059628218: "Manual Divap"
}

GRUPOS_DESTINO_DISPONIVEIS = {
    -4118022548: "Starboy - Dev Entradas",
    -1002016807368: "Starboy - Entradas"
}

# ✅ LIMITES DA API TELEGRAM
TELEGRAM_RATE_LIMITS = {
    'messages_per_second': 1,      # 1 mensagem por segundo
    'messages_per_minute': 20,     # 20 mensagens por minuto
    'burst_limit': 5,              # Máximo 5 mensagens em rajada
    'delay_between_messages': 3    # 3 segundos entre mensagens para segurança
}

# Cliente Telegram
client = TelegramClient('divap_scraper', pers_api_id, pers_api_hash)

class DivapScraper:
    def __init__(self):
        self.client = client
        self.config = {
            'grupo_origem': None,
            'grupo_destino': None,
            'data_inicio': None,
            'data_fim': None,
            'verificar_divap': False,
            'salvar_banco': False
        }
        self.estatisticas = {
            'total_mensagens': 0,
            'mensagens_validas': 0,
            'divap_confirmados': 0,
            'divap_rejeitados': 0,
            'enviadas': 0,
            'salvas_banco': 0,
            'erros': 0
        }
        # ✅ CONTROLE DE RATE LIMITING
        self.message_count = 0
        self.start_time = datetime.now()
        self.last_message_time = None

    async def inicializar(self):
        """Inicializa o cliente Telegram"""
        try:
            await self.client.start()
            print("✅ Cliente Telegram conectado com sucesso")
            return True
        except Exception as e:
            print(f"❌ Erro ao conectar cliente Telegram: {e}")
            return False

    def configurar_parametros(self):
        """Configura os parâmetros do scraping interativamente"""
        print("\n" + "="*70)
        print("🔧 CONFIGURAÇÃO DO SCRAPER DIVAP")
        print("="*70)

        # 1. Selecionar grupo de origem
        print("\n📥 GRUPOS DE ORIGEM DISPONÍVEIS:")
        grupos_origem_lista = list(GRUPOS_ORIGEM_DISPONIVEIS.items())
        for i, (grupo_id, nome) in enumerate(grupos_origem_lista, 1):
            print(f"{i}. {nome} (ID: {grupo_id})")

        while True:
            try:
                escolha = int(input(f"\nEscolha o grupo de origem (1-{len(grupos_origem_lista)}): "))
                if 1 <= escolha <= len(grupos_origem_lista):
                    self.config['grupo_origem'] = grupos_origem_lista[escolha-1][0]
                    nome_origem = grupos_origem_lista[escolha-1][1]
                    print(f"✅ Grupo de origem selecionado: {nome_origem}")
                    break
                else:
                    print("❌ Opção inválida!")
            except ValueError:
                print("❌ Digite um número válido!")

        # 2. Selecionar grupo de destino
        print("\n📤 GRUPOS DE DESTINO DISPONÍVEIS:")
        grupos_destino_lista = list(GRUPOS_DESTINO_DISPONIVEIS.items())
        for i, (grupo_id, nome) in enumerate(grupos_destino_lista, 1):
            print(f"{i}. {nome} (ID: {grupo_id})")

        while True:
            try:
                escolha = int(input(f"\nEscolha o grupo de destino (1-{len(grupos_destino_lista)}): "))
                if 1 <= escolha <= len(grupos_destino_lista):
                    self.config['grupo_destino'] = grupos_destino_lista[escolha-1][0]
                    nome_destino = grupos_destino_lista[escolha-1][1]
                    print(f"✅ Grupo de destino selecionado: {nome_destino}")
                    break
                else:
                    print("❌ Opção inválida!")
            except ValueError:
                print("❌ Digite um número válido!")

        # 3. Configurar período de datas
        print("\n📅 PERÍODO DE SCRAPING:")
        while True:
            try:
                data_inicio_str = input("Data de início (DD/MM/AAAA): ").strip()
                self.config['data_inicio'] = datetime.strptime(data_inicio_str, "%d/%m/%Y").replace(tzinfo=timezone.utc)
                break
            except ValueError:
                print("❌ Formato de data inválido! Use DD/MM/AAAA")

        while True:
            try:
                data_fim_str = input("Data de fim (DD/MM/AAAA): ").strip()
                self.config['data_fim'] = datetime.strptime(data_fim_str, "%d/%m/%Y").replace(
                    hour=23, minute=59, second=59, tzinfo=timezone.utc
                )
                break
            except ValueError:
                print("❌ Formato de data inválido! Use DD/MM/AAAA")

        if self.config['data_inicio'] > self.config['data_fim']:
            print("⚠️ Data de início é posterior à data de fim. Invertendo...")
            self.config['data_inicio'], self.config['data_fim'] = self.config['data_fim'], self.config['data_inicio']

        # 4. Configurar verificação DIVAP
        while True:
            resp = input("\n🔍 Fazer verificação DIVAP? (s/n): ").strip().lower()
            if resp in ['s', 'sim', 'y', 'yes']:
                self.config['verificar_divap'] = True
                print("✅ Verificação DIVAP ativada")
                break
            elif resp in ['n', 'nao', 'não', 'no']:
                self.config['verificar_divap'] = False
                print("✅ Verificação DIVAP desativada")
                break
            else:
                print("❌ Responda com 's' para sim ou 'n' para não")

        # 5. Configurar salvamento no banco
        while True:
            resp = input("\n💾 Salvar no banco de dados? (s/n): ").strip().lower()
            if resp in ['s', 'sim', 'y', 'yes']:
                self.config['salvar_banco'] = True
                print("✅ Salvamento no banco ativado")
                break
            elif resp in ['n', 'nao', 'não', 'no']:
                self.config['salvar_banco'] = False
                print("✅ Salvamento no banco desativado")
                break
            else:
                print("❌ Responda com 's' para sim ou 'n' para não")

        # Resumo da configuração
        print(f"\n📋 RESUMO DA CONFIGURAÇÃO:")
        print(f"   🔍 Grupo origem: {nome_origem}")
        print(f"   📤 Grupo destino: {nome_destino}")
        print(f"   📅 Período: {self.config['data_inicio'].strftime('%d/%m/%Y')} até {self.config['data_fim'].strftime('%d/%m/%Y')}")
        print(f"   🔬 Verificação DIVAP: {'Sim' if self.config['verificar_divap'] else 'Não'}")
        print(f"   💾 Salvar no banco: {'Sim' if self.config['salvar_banco'] else 'Não'}")

        while True:
            confirmacao = input("\n✅ Confirmar configuração? (s/n): ").strip().lower()
            if confirmacao in ['s', 'sim', 'y', 'yes']:
                return True
            elif confirmacao in ['n', 'nao', 'não', 'no']:
                print("❌ Configuração cancelada")
                return False
            else:
                print("❌ Responda com 's' para sim ou 'n' para não")

    async def buscar_mensagens_historicas(self):
        """Busca mensagens históricas do grupo no período especificado"""
        try:
            print(f"\n🔍 Buscando mensagens históricas...")
            print(f"   📅 Período: {self.config['data_inicio']} até {self.config['data_fim']}")
            
            # Verificar acesso ao grupo primeiro
            try:
                entity = await self.client.get_entity(self.config['grupo_origem'])
                print(f"✅ Grupo encontrado: {entity.title}")
            except Exception as e:
                print(f"❌ Erro ao acessar grupo: {e}")
                return []
            
            # Buscar mensagens
            mensagens = []
            total_processadas = 0
            
            print("🔍 Buscando mensagens por período...")
            
            async for message in self.client.iter_messages(
                self.config['grupo_origem'],
                limit=1000
            ):
                total_processadas += 1
                
                if total_processadas % 100 == 0:
                    print(f"   📊 Processadas {total_processadas} mensagens")
                
                if message.date < self.config['data_inicio']:
                    print(f"   ⏹️ Chegou antes do período desejado após {total_processadas} mensagens")
                    break
                
                if (message.date >= self.config['data_inicio'] and 
                    message.date <= self.config['data_fim'] and 
                    message.text):
                    mensagens.append(message)
                    
            print(f"✅ Encontradas {len(mensagens)} mensagens no período (processadas {total_processadas} no total)")
            self.estatisticas['total_mensagens'] = len(mensagens)
            return mensagens
            
        except Exception as e:
            print(f"❌ Erro ao buscar mensagens históricas: {e}")
            traceback.print_exc()
            return []

    def filtrar_mensagens_validas(self, mensagens):
        """Filtra mensagens que contêm sinais válidos"""
        mensagens_validas = []
        
        print(f"\n🔍 Filtrando mensagens válidas...")
        
        for i, message in enumerate(mensagens, 1):
            if i % 50 == 0:
                print(f"   Processando {i}/{len(mensagens)}...")
                
            try:
                trade_info = extract_trade_info(message.text)
                if trade_info:
                    mensagens_validas.append({
                        'message': message,
                        'trade_info': trade_info,
                        'processed': False
                    })
                    
            except Exception as e:
                print(f"⚠️ Erro ao processar mensagem {message.id}: {e}")
                self.estatisticas['erros'] += 1

        print(f"✅ {len(mensagens_validas)} mensagens contêm sinais válidos")
        self.estatisticas['mensagens_validas'] = len(mensagens_validas)
        return mensagens_validas

    def exibir_resumo_por_dia(self, mensagens_validas):
        """✅ NOVA FUNÇÃO: Exibe resumo de mensagens por dia antes do processamento"""
        if not mensagens_validas:
            return True
        
        # Agrupar mensagens por dia
        mensagens_por_dia = {}
        for item in mensagens_validas:
            message = item['message']
            trade_info = item['trade_info']
            data = message.date.date()
            
            if data not in mensagens_por_dia:
                mensagens_por_dia[data] = []
            
            mensagens_por_dia[data].append({
                'hora': message.date.strftime('%H:%M:%S'),
                'symbol': trade_info['symbol'],
                'side': trade_info['side'],
                'message_id': message.id
            })
        
        # Exibir resumo
        print(f"\n📊 RESUMO DE MENSAGENS ELEGÍVEIS PARA ENCAMINHAMENTO:")
        print("="*80)
        
        total_dias = len(mensagens_por_dia)
        total_mensagens = len(mensagens_validas)
        
        for data in sorted(mensagens_por_dia.keys()):
            mensagens_do_dia = mensagens_por_dia[data]
            print(f"\n📅 {data.strftime('%d/%m/%Y')} - {len(mensagens_do_dia)} mensagens:")
            
            for msg in mensagens_do_dia:
                print(f"   🕒 {msg['hora']} - {msg['symbol']} {msg['side']} (ID: {msg['message_id']})")
        
        print(f"\n" + "="*80)
        print(f"📈 RESUMO GERAL:")
        print(f"   📅 Total de dias: {total_dias}")
        print(f"   📧 Total de mensagens: {total_mensagens}")
        print(f"   ⚡ Taxa de envio: 1 mensagem a cada {TELEGRAM_RATE_LIMITS['delay_between_messages']} segundos")
        
        # Calcular tempo estimado
        tempo_total_segundos = total_mensagens * TELEGRAM_RATE_LIMITS['delay_between_messages']
        tempo_total_minutos = tempo_total_segundos / 60
        
        if tempo_total_minutos < 60:
            tempo_str = f"{tempo_total_minutos:.1f} minutos"
        else:
            horas = int(tempo_total_minutos // 60)
            minutos = int(tempo_total_minutos % 60)
            tempo_str = f"{horas}h{minutos:02d}m"
        
        print(f"   ⏱️ Tempo estimado: {tempo_str}")
        print("="*80)
        
        # Confirmação do usuário
        print(f"\n⚠️ ATENÇÃO: As mensagens acima serão enviadas para o grupo destino!")
        print(f"   🎯 Destino: {GRUPOS_DESTINO_DISPONIVEIS[self.config['grupo_destino']]}")
        print(f"   💾 Salvar no banco: {'Sim' if self.config['salvar_banco'] else 'Não'}")
        print(f"   🔍 Verificar DIVAP: {'Sim' if self.config['verificar_divap'] else 'Não'}")
        
        while True:
            confirmacao = input(f"\n✅ Confirmar o encaminhamento de {total_mensagens} mensagens? (s/n): ").strip().lower()
            if confirmacao in ['s', 'sim', 'y', 'yes']:
                print(f"✅ Encaminhamento confirmado! Iniciando processamento...")
                return True
            elif confirmacao in ['n', 'nao', 'não', 'no']:
                print(f"❌ Encaminhamento cancelado pelo usuário")
                return False
            else:
                print("❌ Responda com 's' para sim ou 'n' para não")

    async def aplicar_rate_limiting(self):
        """✅ NOVA FUNÇÃO: Aplica rate limiting para respeitar limites da API Telegram"""
        now = datetime.now()
        
        # Se é a primeira mensagem, apenas registra o tempo
        if self.last_message_time is None:
            self.last_message_time = now
            self.message_count = 1
            return
        
        # Calcular tempo desde a última mensagem
        time_since_last = (now - self.last_message_time).total_seconds()
        
        # Aplicar delay mínimo entre mensagens
        min_delay = TELEGRAM_RATE_LIMITS['delay_between_messages']
        if time_since_last < min_delay:
            delay_needed = min_delay - time_since_last
            print(f"   ⏳ Rate limiting: aguardando {delay_needed:.1f}s...")
            await asyncio.sleep(delay_needed)
        
        # Verificar limite por minuto
        time_since_start = (now - self.start_time).total_seconds()
        if time_since_start < 60 and self.message_count >= TELEGRAM_RATE_LIMITS['messages_per_minute']:
            wait_time = 60 - time_since_start
            print(f"   ⏳ Limite por minuto atingido. Aguardando {wait_time:.1f}s...")
            await asyncio.sleep(wait_time)
            # Reset contadores
            self.message_count = 0
            self.start_time = datetime.now()
        
        # Atualizar contadores
        self.message_count += 1
        self.last_message_time = datetime.now()

    async def processar_mensagem(self, item, index, total):
        """Processa uma mensagem individual com rate limiting"""
        message = item['message']
        trade_info = item['trade_info']
        
        try:
            print(f"\n📤 Processando {index}/{total}: {trade_info['symbol']} {trade_info['side']} ({message.date})")
            
            # Aplicar rate limiting antes de cada mensagem
            await self.aplicar_rate_limiting()
            
            # Determinar source baseado no grupo origem
            message_source = GRUPOS_ORIGEM_DISPONIVEIS.get(self.config['grupo_origem'], 'divap')
            
            # Verificação DIVAP se habilitada
            is_valid_divap = True
            error_message = None
            
            if self.config['verificar_divap']:
                try:
                    is_valid_divap, error_message = await verify_divap_pattern(trade_info)
                    if is_valid_divap:
                        self.estatisticas['divap_confirmados'] += 1
                    else:
                        self.estatisticas['divap_rejeitados'] += 1
                        print(f"   ❌ DIVAP rejeitado: {error_message}")
                except Exception as e:
                    print(f"   ⚠️ Erro na verificação DIVAP: {e}")
                    is_valid_divap = True

            # Preparar dados para envio/salvamento
            trade_info['id_mensagem_origem_sinal'] = message.id
            trade_info['chat_id_origem_sinal'] = self.config['grupo_origem']
            trade_info['chat_id'] = self.config['grupo_destino']
            trade_info['message_source'] = message_source
            trade_info['conta_id'] = CONTA_ID

            if is_valid_divap:
                # Formatear mensagem
                grupo_origem_nome = message_source.capitalize()
                message_text_to_send = format_trade_message(trade_info, grupo_origem_nome)
                
                # Enviar mensagem
                sent_message = await self.client.send_message(
                    self.config['grupo_destino'], 
                    message_text_to_send
                )
                
                trade_info['message_id'] = sent_message.id
                trade_info['divap_confirmado'] = 1
                trade_info['cancelado_checker'] = 0
                
                self.estatisticas['enviadas'] += 1
                print(f"   ✅ Mensagem enviada (ID: {sent_message.id})")
                
                # Salvar no banco se habilitado
                if self.config['salvar_banco']:
                    signal_id = save_to_database(trade_info)
                    if signal_id:
                        self.estatisticas['salvas_banco'] += 1
                        
                        # Salvar mensagens relacionadas
                        save_message_to_database(
                            message_id=message.id,
                            chat_id=self.config['grupo_origem'],
                            text=message.text,
                            is_reply=False,
                            reply_to_message_id=None,
                            symbol=trade_info['symbol'],
                            signal_id=signal_id,
                            created_at=message.date.strftime("%Y-%m-%d %H:%M:%S"),
                            message_source=message_source
                        )
                        
                        save_message_to_database(
                            message_id=sent_message.id,
                            chat_id=self.config['grupo_destino'],
                            text=message_text_to_send,
                            is_reply=False,
                            reply_to_message_id=None,
                            symbol=trade_info['symbol'],
                            signal_id=signal_id,
                            created_at=sent_message.date.strftime("%Y-%m-%d %H:%M:%S"),
                            message_source=message_source
                        )
                        print(f"   💾 Salvo no banco (ID: {signal_id})")
                    
            else:
                # DIVAP não confirmado
                if self.config['salvar_banco']:
                    trade_info['divap_confirmado'] = 0
                    trade_info['cancelado_checker'] = 1
                    trade_info['status'] = 'CANCELED'
                    trade_info['error_message'] = error_message
                    
                    save_to_database(trade_info)
                    print(f"   💾 Salvo como cancelado no banco")

            return True
            
        except Exception as e:
            print(f"   ❌ Erro ao processar mensagem {message.id}: {e}")
            self.estatisticas['erros'] += 1
            return False

    async def executar_scraping(self):
        """Executa o processo completo de scraping"""
        try:
            print(f"\n🚀 INICIANDO SCRAPING...")
            
            # Inicializar DIVAP analyzer se necessário
            if self.config['verificar_divap']:
                print("🔍 Inicializando analisador DIVAP...")
                if not initialize_divap_analyzer():
                    print("⚠️ Falha ao inicializar DIVAP analyzer. Continuando sem verificação...")
                    self.config['verificar_divap'] = False

            # Buscar mensagens históricas
            mensagens = await self.buscar_mensagens_historicas()
            if not mensagens:
                print("❌ Nenhuma mensagem encontrada no período")
                return False

            # Filtrar mensagens válidas
            mensagens_validas = self.filtrar_mensagens_validas(mensagens)
            if not mensagens_validas:
                print("❌ Nenhuma mensagem válida encontrada")
                return False

            # ✅ NOVA FUNCIONALIDADE: Exibir resumo e pedir confirmação
            if not self.exibir_resumo_por_dia(mensagens_validas):
                print("❌ Operação cancelada pelo usuário")
                return False

            # Processar mensagens
            print(f"\n📤 Iniciando envio de {len(mensagens_validas)} mensagens...")
            print(f"⚡ Taxa de envio: 1 mensagem a cada {TELEGRAM_RATE_LIMITS['delay_between_messages']} segundos")
            
            for i, item in enumerate(mensagens_validas, 1):
                sucesso = await self.processar_mensagem(item, i, len(mensagens_validas))
                item['processed'] = sucesso
                
                # Mostrar progresso a cada 5 mensagens
                if i % 5 == 0 or i == len(mensagens_validas):
                    progresso = (i / len(mensagens_validas)) * 100
                    print(f"\n📊 Progresso: {i}/{len(mensagens_validas)} ({progresso:.1f}%)")

            return True
            
        except Exception as e:
            print(f"❌ Erro durante o scraping: {e}")
            traceback.print_exc()
            return False

    def mostrar_estatisticas(self):
        """Mostra estatísticas finais do processo"""
        print(f"\n📊 ESTATÍSTICAS FINAIS:")
        print("="*50)
        print(f"   📈 Total de mensagens analisadas: {self.estatisticas['total_mensagens']}")
        print(f"   ✅ Mensagens com sinais válidos: {self.estatisticas['mensagens_validas']}")
        
        if self.config['verificar_divap']:
            print(f"   🔍 DIVAP confirmados: {self.estatisticas['divap_confirmados']}")
            print(f"   ❌ DIVAP rejeitados: {self.estatisticas['divap_rejeitados']}")
        
        print(f"   📤 Mensagens enviadas: {self.estatisticas['enviadas']}")
        
        if self.config['salvar_banco']:
            print(f"   💾 Sinais salvos no banco: {self.estatisticas['salvas_banco']}")
            
        print(f"   ⚠️ Erros encontrados: {self.estatisticas['erros']}")
        
        # Taxa de sucesso
        if self.estatisticas['mensagens_validas'] > 0:
            taxa_envio = (self.estatisticas['enviadas'] / self.estatisticas['mensagens_validas']) * 100
            print(f"   📊 Taxa de envio: {taxa_envio:.1f}%")

    async def encerrar(self):
        """Encerra o cliente Telegram"""
        try:
            if self.client.is_connected():
                await self.client.disconnect()
            print("✅ Cliente desconectado")
        except Exception as e:
            print(f"⚠️ Erro ao desconectar: {e}")

async def main():
    """Função principal"""
    print("="*70)
    print("🔍 DIVAP SCRAPER - EXTRATOR DE MENSAGENS HISTÓRICAS")
    print("="*70)
    print("Este utilitário permite extrair e reprocessar mensagens históricas")
    print("dos grupos DIVAP em um período específico.")
    print("\n⚠️ IMPORTANTE: Respeita os limites da API do Telegram")
    print(f"   • Máximo {TELEGRAM_RATE_LIMITS['messages_per_minute']} mensagens por minuto")
    print(f"   • Delay de {TELEGRAM_RATE_LIMITS['delay_between_messages']} segundos entre mensagens")
    print("="*70)

    scraper = DivapScraper()
    
    try:
        # Inicializar cliente
        if not await scraper.inicializar():
            return

        # Configurar parâmetros
        if not scraper.configurar_parametros():
            return

        # Executar scraping
        sucesso = await scraper.executar_scraping()
        
        # Mostrar estatísticas
        scraper.mostrar_estatisticas()
        
        if sucesso:
            print(f"\n✅ Scraping concluído com sucesso!")
        else:
            print(f"\n⚠️ Scraping concluído com problemas")

    except KeyboardInterrupt:
        print(f"\n⚠️ Processo interrompido pelo usuário")
    except Exception as e:
        print(f"\n❌ Erro crítico: {e}")
        traceback.print_exc()
    finally:
        await scraper.encerrar()

if __name__ == "__main__":
    asyncio.run(main())