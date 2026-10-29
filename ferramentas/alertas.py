"""Lê as passagens publicadas nos grupos do Telegram e grava dados/alertas.json.

Roda sozinho no GitHub (ver .github/workflows/alertas.yml), com a sessão
criada por ferramentas/telegram_entrar.py. TELEGRAM_GRUPO pode ter vários
grupos, separados por vírgula.

Só entram mensagens no formato de passagem (rota, companhia, programa,
milhas, datas e link) das últimas 24 horas. Guarda só esses dados e o link
original da oferta; resumos, curiosidades e o resto do texto ficam de fora.
Em grupos (não canais), só valem as mensagens dos administradores.
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
CONVITE = re.compile(r'(https?://)?(t\.me|telegram\.me)/', re.I)

LUGAR = r'([^\n()]*?)\s*\(([A-Z]{3})\)'
ROTA = re.compile(LUGAR + r'[^\n()]*?\s[xX×]\s' + LUGAR)
CAMPO = re.compile(r'^\W*(Companhia|Cabine|Programa|IDA|VOLTA)\s*:\s*(.+)$', re.I | re.M)
LINK = re.compile(r'Link para \(([^)]*)\)\s*:\s*(https?://\S+)', re.I)
MES = re.compile(r'^([A-Z]{3})(\d{2})\s*:\s*(.+)$')


def nome(t):
    """Tira emojis e bandeiras das pontas do nome da cidade."""
    return re.sub(r'^[^\wÀ-ÿ]+|[^\wÀ-ÿ)]+$', '', t).strip()


def datas(texto, rotulo):
    """'Datas de Ida:' seguido de linhas 'FEV27: 16, 20 a 22' até a linha em branco."""
    m = re.search(r'Datas de ' + rotulo + r'\s*:\s*\n((?:.+\n?)+)', texto, re.I)
    saida = []
    for linha in (m.group(1).splitlines() if m else []):
        d = MES.match(linha.strip())
        if not d:
            break
        saida.append({'mes': f'{d.group(1).title()}/{d.group(2)}', 'dias': d.group(3).strip()})
    return saida


def ler_passagem(texto, urls_escondidas=()):
    """Transforma a mensagem do grupo nos campos da passagem; None se não for uma."""
    rota = ROTA.search(texto or '')
    campos = {k.lower(): v.strip() for k, v in CAMPO.findall(texto or '')}
    if not rota or 'companhia' not in campos or 'ida' not in campos:
        return None
    link = LINK.search(texto)
    url = link.group(2) if link else next((u for u in urls_escondidas if not CONVITE.match(u)), '')
    if not url or CONVITE.match(url):
        return None
    return {
        'origem': nome(rota.group(1)), 'origem_iata': rota.group(2),
        'destino': nome(rota.group(3)), 'destino_iata': rota.group(4),
        'companhia': campos['companhia'], 'cabine': campos.get('cabine', ''),
        'programa': campos.get('programa', link.group(1) if link else ''),
        'ida': campos['ida'], 'volta': campos.get('volta', ''),
        'datas_ida': datas(texto, 'Ida'), 'datas_volta': datas(texto, 'Volta'),
        'link': url, 'link_nome': link.group(1) if link else campos.get('programa', ''),
    }


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
    alvos = {int(g) for g in re.findall(r'-?\d+', os.environ['TELEGRAM_GRUPO'])}
    grupos = [d.entity async for d in cliente.iter_dialogs() if d.id in alvos]
    if not grupos:
        sys.exit('Nenhum grupo encontrado na conta. Rode ferramentas/telegram_entrar.py de novo.')
    limite = datetime.now(timezone.utc) - timedelta(hours=HORAS)

    passagens = []
    for grupo in grupos:
        autores = await quem_publica(cliente, grupo)
        async for m in cliente.iter_messages(grupo, limit=500):
            if m.date < limite:
                break
            do_grupo = isinstance(m.from_id, PeerChannel) or m.from_id is None  # canal ou admin anônimo
            if autores is not None and not do_grupo and m.sender_id not in autores:
                continue
            escondidas = [e.url for e in (m.entities or []) if isinstance(e, MessageEntityTextUrl)]
            p = ler_passagem(m.message, escondidas)
            if p:
                passagens.append({'id': f'{grupo.id}-{m.id}',
                                  'data': m.date.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'), **p})
    await cliente.disconnect()
    passagens.sort(key=lambda p: p['data'], reverse=True)
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(passagens, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(passagens)} passagens das últimas {HORAS} h gravadas ({len(grupos)} grupos).')


if __name__ == '__main__':
    asyncio.run(main())
