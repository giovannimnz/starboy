import asyncio
from telethon import TelegramClient
from senhas import api_hash, api_id

'''PRODUÇÃO'''
sessao = 'ATIUS-INDICATOR'

'''DESENVOLVIMENTO
sessao = 'MONITORAMENTO AF DEV'
'''

async def main():
    client = TelegramClient(sessao, api_id, api_hash)
    await client.start()
    print('Conectado com sucesso!')

    # Obtendo a lista de todos os diálogos
    async for dialog in client.iter_dialogs():
        print(f'Nome do Diálogo: {dialog.name}')
        print(f'ID do Diálogo: {dialog.id}')
        print('------------------------')

    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
