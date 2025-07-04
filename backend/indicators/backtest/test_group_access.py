import asyncio
import sys
from datetime import datetime, timezone, timedelta
from telethon import TelegramClient
from pathlib import Path

# ✅ CORRIGIR: Adicionar o diretório pai ao path para encontrar divap.py
sys.path.append(str(Path(__file__).parent.parent))

# ✅ AGORA IMPORTAR do divap.py
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent))
from divap import pers_api_id, pers_api_hash

async def test_group_access():
    client = TelegramClient('test_access', pers_api_id, pers_api_hash)
    
    try:
        await client.start()
        
        grupo_id = -1002444455075  # divap
        
        print("🔍 Testando acesso ao grupo...")
        
        # Teste 1: Informações do grupo
        try:
            entity = await client.get_entity(grupo_id)
            print(f"✅ Acesso ao grupo: {entity.title}")
            print(f"   📊 Tipo: {type(entity).__name__}")
            print(f"   👥 Membros: {getattr(entity, 'participants_count', 'N/A')}")
        except Exception as e:
            print(f"❌ Erro ao acessar grupo: {e}")
            return
        
        # Teste 2: Últimas mensagens (sem filtro de data)
        print("\n🔍 Testando acesso às mensagens recentes...")
        try:
            messages = []
            async for message in client.iter_messages(grupo_id, limit=10):
                if message.text:
                    messages.append(message)
            
            print(f"✅ Encontradas {len(messages)} mensagens recentes")
            if messages:
                print(f"   📅 Mensagem mais recente: {messages[0].date}")
                print(f"   📅 Mensagem mais antiga (das 10): {messages[-1].date}")
                
                # ✅ ADICIONAR: Mostrar preview das mensagens
                print(f"\n📝 Preview das mensagens:")
                for i, msg in enumerate(messages[:3]):  # Mostrar apenas as 3 mais recentes
                    preview = msg.text[:100] + "..." if len(msg.text) > 100 else msg.text
                    print(f"   {i+1}. {msg.date}: {preview}")
                
        except Exception as e:
            print(f"❌ Erro ao acessar mensagens: {e}")
            return
        
        # Teste 3: Mensagens em data específica
        print("\n🔍 Testando acesso a mensagens de uma data específica...")
        try:
            data_teste = datetime(2025, 6, 20, tzinfo=timezone.utc)
            messages_date = []
            
            async for message in client.iter_messages(
                grupo_id, 
                offset_date=data_teste + timedelta(days=1),
                reverse=True,
                limit=50
            ):
                if message.date.date() == data_teste.date() and message.text:
                    messages_date.append(message)
            
            print(f"✅ Encontradas {len(messages_date)} mensagens em 20/06/2025")
            
            # ✅ ADICIONAR: Se encontrou mensagens, mostrar algumas
            if messages_date:
                print(f"\n📝 Mensagens de 20/06/2025:")
                for i, msg in enumerate(messages_date[:3]):  # Mostrar apenas as 3 primeiras
                    preview = msg.text[:100] + "..." if len(msg.text) > 100 else msg.text
                    print(f"   {i+1}. {msg.date}: {preview}")
            
        except Exception as e:
            print(f"❌ Erro ao acessar mensagens por data: {e}")
        
        # ✅ TESTE 4: Teste com período mais amplo
        print("\n🔍 Testando período mais amplo (últimos 7 dias)...")
        try:
            data_limite = datetime.now(timezone.utc) - timedelta(days=7)
            messages_week = []
            
            async for message in client.iter_messages(grupo_id, limit=100):
                if message.date >= data_limite and message.text:
                    messages_week.append(message)
            
            print(f"✅ Encontradas {len(messages_week)} mensagens nos últimos 7 dias")
            
            # Agrupar por dia
            if messages_week:
                days_count = {}
                for msg in messages_week:
                    day_key = msg.date.date()
                    days_count[day_key] = days_count.get(day_key, 0) + 1
                
                print(f"\n📊 Distribuição por dia:")
                for day, count in sorted(days_count.items(), reverse=True):
                    print(f"   {day}: {count} mensagens")
            
        except Exception as e:
            print(f"❌ Erro ao acessar mensagens da semana: {e}")
    
    finally:
        await client.disconnect()

if __name__ == "__main__":
    asyncio.run(test_group_access())