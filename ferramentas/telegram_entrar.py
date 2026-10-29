"""Liga o site ao Telegram do Felipe: rode uma vez, no seu computador.

    pip install telethon qrcode
    python ferramentas/telegram_entrar.py

1. Pede o api_id e o api_hash (de my.telegram.org > API development tools).
2. Mostra um QR Code: no celular, Telegram > Configurações > Dispositivos >
   Conectar dispositivo, e aponte para a tela.
3. Lista seus grupos e canais para você escolher de onde vêm os alertas.
4. Grava os 4 valores num arquivo na sua pasta de usuário, para colar nos
   segredos do GitHub. Depois de colar, apague o arquivo.

O acesso fica guardado só nos segredos do GitHub. Para cortar a qualquer
momento: Telegram > Configurações > Dispositivos > encerrar a sessão.
"""
import asyncio
import getpass
from pathlib import Path

import qrcode
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

SEGREDOS = 'https://github.com/ondeasmilhasmelevam/ondeasmilhasmelevam.github.io/settings/secrets/actions'
ARQUIVO = Path.home() / 'telegram-alertas-SEGREDO.txt'


def mostrar_qr(url):
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.print_ascii(invert=True)


async def entrar(cliente):
    await cliente.connect()
    login = await cliente.qr_login()
    while True:
        print('\nNo celular: Telegram > Configurações > Dispositivos > Conectar dispositivo\n')
        mostrar_qr(login.url)
        try:
            await login.wait(timeout=60)
            return
        except asyncio.TimeoutError:
            print('O QR venceu; gerando outro...')
            await login.recreate()
        except SessionPasswordNeededError:
            senha = getpass.getpass('Sua conta tem verificação em duas etapas. Digite a senha (não aparece na tela): ')
            await cliente.sign_in(password=senha)
            return


async def escolher_grupo(cliente):
    opcoes = [d async for d in cliente.iter_dialogs() if d.is_group or d.is_channel]
    print('\nSeus grupos e canais:')
    for i, d in enumerate(opcoes, 1):
        print(f'{i:3}. {d.name}  ({"canal" if d.is_channel and not d.is_group else "grupo"})')
    while True:
        n = input('\nNúmero do grupo dos alertas: ').strip()
        if n.isdigit() and 1 <= int(n) <= len(opcoes):
            return opcoes[int(n) - 1]


async def main():
    api_id = int(input('api_id (só números): ').strip())
    api_hash = getpass.getpass('api_hash (não aparece na tela): ').strip()
    cliente = TelegramClient(StringSession(), api_id, api_hash, device_model='Site Onde as Milhas Me Levam')
    await entrar(cliente)
    eu = await cliente.get_me()
    print(f'\nConectado como {eu.first_name}.')
    grupo = await escolher_grupo(cliente)
    ARQUIVO.write_text(
        'Cole cada valor como um segredo em:\n' + SEGREDOS + '\n'
        '(New repository secret > Name = o nome da esquerda, Secret = o valor)\n\n'
        f'TELEGRAM_API_ID\n{api_id}\n\n'
        f'TELEGRAM_API_HASH\n{api_hash}\n\n'
        f'TELEGRAM_GRUPO\n{grupo.id}\n\n'
        f'TELEGRAM_SESSAO\n{cliente.session.save()}\n\n'
        'Depois de colar os 4, APAGUE este arquivo: a sessão dá acesso à sua conta do Telegram.\n',
        encoding='utf-8')
    await cliente.disconnect()
    print(f'\nPronto: grupo "{grupo.name}".\nOs valores estão em {ARQUIVO}\nCole nos segredos do GitHub e apague o arquivo.')


if __name__ == '__main__':
    asyncio.run(main())
