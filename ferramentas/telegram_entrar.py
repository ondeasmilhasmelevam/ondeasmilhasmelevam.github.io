"""Liga o site ao Telegram do Felipe: rode uma vez, no seu computador.

    pip install telethon qrcode
    python ferramentas/telegram_entrar.py

1. Pede o api_id e o api_hash (de my.telegram.org > API development tools).
2. Mostra um QR Code: no celular, Telegram > Configurações > Dispositivos >
   Conectar dispositivo, e aponte para a tela.
3. Lista seus grupos e canais para você escolher de onde vêm as passagens
   (pode escolher vários, separados por vírgula).
4. Grava os 4 valores num arquivo na sua pasta de usuário, para colar nos
   segredos do GitHub. Depois de colar, apague o arquivo.

O acesso fica guardado só nos segredos do GitHub. Para cortar a qualquer
momento: Telegram > Configurações > Dispositivos > encerrar a sessão.
"""
import asyncio
import getpass
import os
import re
from pathlib import Path

import qrcode
from telethon import TelegramClient
from telethon.errors import ApiIdInvalidError, SessionPasswordNeededError
from telethon.sessions import StringSession

SEGREDOS = 'https://github.com/ondeasmilhasmelevam/ondeasmilhasmelevam.github.io/settings/secrets/actions'
ARQUIVO = Path.home() / 'telegram-alertas-SEGREDO.txt'


def mostrar_qr(url):
    """Abre o QR como imagem (o desenho no terminal nem sempre dá para ler)."""
    qr = qrcode.QRCode(border=4, box_size=10)
    qr.add_data(url)
    imagem = Path.home() / 'telegram-qrcode.png'
    try:
        qr.make_image().save(imagem)
        os.startfile(imagem)
        print(f'O QR Code abriu numa janela ({imagem}).')
    except Exception:
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
        ns = [int(n) for n in input('\nNúmeros dos grupos das passagens (ex.: 3, 7): ').replace(',', ' ').split() if n.isdigit()]
        if ns and all(1 <= n <= len(opcoes) for n in ns):
            return [opcoes[n - 1] for n in dict.fromkeys(ns)]


def pedir_chaves():
    """Confere o formato antes de tentar: api_id só números, api_hash 32 letras/números."""
    while True:
        api_id = re.sub(r'\D', '', input('\napi_id (só números): '))
        api_hash = re.sub(r'[^0-9a-fA-F]', '', input('api_hash (32 letras e números): ')).lower()
        if api_id and len(api_hash) == 32:
            return int(api_id), api_hash
        print(f'Não parece certo: o api_id veio com {len(api_id)} números e o api_hash com {len(api_hash)} '
              'caracteres (deveriam ser 32). Copie de novo do my.telegram.org.')


async def main():
    while True:
        api_id, api_hash = pedir_chaves()
        cliente = TelegramClient(StringSession(), api_id, api_hash, device_model='Site Onde as Milhas Me Levam')
        try:
            await entrar(cliente)
            break
        except ApiIdInvalidError:
            await cliente.disconnect()
            print('O Telegram não aceitou esse par de chaves. Confira se o api_id e o api_hash são do mesmo app '
                  'e se não trocou um pelo outro.')
    (Path.home() / 'telegram-qrcode.png').unlink(missing_ok=True)
    eu = await cliente.get_me()
    print(f'\nConectado como {eu.first_name}.')
    grupos = await escolher_grupo(cliente)
    ARQUIVO.write_text(
        'Cole cada valor como um segredo em:\n' + SEGREDOS + '\n'
        '(New repository secret > Name = o nome da esquerda, Secret = o valor)\n\n'
        f'TELEGRAM_API_ID\n{api_id}\n\n'
        f'TELEGRAM_API_HASH\n{api_hash}\n\n'
        f'TELEGRAM_GRUPO\n{",".join(str(g.id) for g in grupos)}\n\n'
        f'TELEGRAM_SESSAO\n{cliente.session.save()}\n\n'
        'Depois de colar os 4, APAGUE este arquivo: a sessão dá acesso à sua conta do Telegram.\n',
        encoding='utf-8')
    await cliente.disconnect()
    print(f'\nPronto: {", ".join(g.name for g in grupos)}.\nOs valores estão em {ARQUIVO}\nCole nos segredos do GitHub e apague o arquivo.')


if __name__ == '__main__':
    asyncio.run(main())
