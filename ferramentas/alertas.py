"""Lê os alertas de passagens do grupo do Telegram e grava dados/alertas.json.

Roda sozinho no GitHub (ver .github/workflows/alertas.yml), com a sessão
criada por ferramentas/telegram_entrar.py. Guarda só as mensagens das
últimas 24 horas, e só de quem publica (canal ou administradores do
grupo): nada de nome, telefone ou mensagem dos outros participantes.
"""
import asyncio
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import (ChannelParticipantAdmin, ChannelParticipantCreator, ChannelParticipantsAdmins,
                               ChatParticipantAdmin, ChatParticipantCreator, MessageEntityTextUrl, PeerChannel)

HORAS = 24
SAIDA = Path(__file__).resolve().parent.parent / 'dados' / 'alertas.json'
# Telefones e convites do grupo não vão para o site.
TELEFONE = re.compile(r'(?<!\w)(\+?55[\s.-]?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}(?!\w)')
CONVITE = re.compile(r'(https?://)?(t\.me|telegram\.me)/(\+|joinchat/)\S+', re.I)


def limpar(texto):
    texto = CONVITE.sub('', texto or '')
    texto = TELEFONE.sub('', texto)
    return re.sub(r'\n{3,}', '\n\n', texto).strip()


async def quem_publica(cliente, grupo):
    """Ids de quem pode aparecer no site: os administradores do grupo."""
    if getattr(grupo, 'broadcast', False):
        return None  # canal: todas as postagens são do próprio canal
    ids = set()
    try:
        async for u in cliente.iter_participants(grupo, filter=ChannelParticipantsAdmins):
            ids.add(u.id)
    except Exception:  # grupo pequeno (não supergrupo): olha cada participante
        async for u in cliente.iter_participants(grupo):
            if isinstance(getattr(u, 'participant', None), (ChatParticipantAdmin, ChatParticipantCreator,
                                                            ChannelParticipantAdmin, ChannelParticipantCreator)):
                ids.add(u.id)
    return ids


async def main():
    faltam = [v for v in ('TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSAO', 'TELEGRAM_GRUPO') if not os.environ.get(v)]
    if faltam:
        print('Telegram ainda não ligado (faltam ' + ', '.join(faltam) + '); nada a fazer.')
        return
    cliente = TelegramClient(StringSession(os.environ['TELEGRAM_SESSAO']), int(os.environ['TELEGRAM_API_ID']),
                             os.environ['TELEGRAM_API_HASH'], device_model='Site Onde as Milhas Me Levam')
    await cliente.connect()
    if not await cliente.is_user_authorized():
        sys.exit('A sessão do Telegram foi encerrada. Rode ferramentas/telegram_entrar.py de novo.')
    alvo = int(os.environ['TELEGRAM_GRUPO'])
    grupo = next((d.entity async for d in cliente.iter_dialogs() if d.id == alvo), None)
    if grupo is None:
        sys.exit('Grupo não encontrado na conta. Rode ferramentas/telegram_entrar.py de novo.')
    autores = await quem_publica(cliente, grupo)
    usuario = getattr(grupo, 'username', None)
    limite = datetime.now(timezone.utc) - timedelta(hours=HORAS)

    alertas = []
    async for m in cliente.iter_messages(grupo, limit=300):
        if m.date < limite:
            break
        do_grupo = isinstance(m.from_id, PeerChannel) or m.from_id is None  # canal ou admin anônimo
        if autores is not None and not do_grupo and m.sender_id not in autores:
            continue
        texto = limpar(m.message)
        if not texto:
            continue
        links = [e.url for e in (m.entities or []) if isinstance(e, MessageEntityTextUrl) and not CONVITE.search(e.url)]
        alertas.append({
            'id': m.id,
            'data': m.date.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'texto': texto,
            'links': list(dict.fromkeys(links)),
            'link': f'https://t.me/{usuario}/{m.id}' if usuario else '',
        })
    await cliente.disconnect()
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(alertas, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(alertas)} alertas das últimas {HORAS} h gravados.')


if __name__ == '__main__':
    asyncio.run(main())
