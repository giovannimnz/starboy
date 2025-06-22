import asyncio
from datetime import datetime, timezone, timedelta
from telethon import TelegramClient
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
            
        except Exception as e:
            print(f"❌ Erro ao acessar mensagens por data: {e}")
    
    finally:
        await client.disconnect()

if __name__ == "__main__":
    asyncio.run(test_group_access())