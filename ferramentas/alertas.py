"""Lê as passagens publicadas nos grupos do Telegram e grava dados/alertas.json.

Roda sozinho no GitHub (ver .github/workflows/alertas.yml), com a sessão
criada por ferramentas/telegram_entrar.py. TELEGRAM_GRUPO pode ter vários
grupos, separados por vírgula.

Só entram, das últimas 24 horas, mensagens no formato de passagem (rota,
companhia, programa, milhas, datas e link) ou de promoção de pontos (título
entre 💸, resumo, validade e link). Guarda só esses dados e o link original;
resumos do dia, curiosidades e o resto do texto ficam de fora.
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
SITE_PROGRAMA = {
    'smiles': 'https://www.smiles.com.br/passagens', 'azul': 'https://www.voeazul.com.br',
    'latam': 'https://latampass.latam.com/pt_br/passagens', 'flying blue': 'https://www.flyingblue.com',
    'aadvantage': 'https://www.aa.com', 'iberia': 'https://www.iberia.com', 'tap': 'https://www.flytap.com',
    'aeroplan': 'https://www.aircanada.com/aeroplan', 'avios': 'https://www.britishairways.com', 'qatar': 'https://www.qatarairways.com',
}

# Promoções de pontos: título entre 💸, com Resumo, Validade e Link.
TITULO = re.compile(r'^\W*💸\s*(.+?)\s*💸\s*$', re.M)
BLOCO = lambda nome: re.compile(r'^\W*' + nome + r'[^\n]*\n((?:.+\n?)+)', re.M | re.I)


def ler_promocao(texto, urls_escondidas=()):
    """Promoção do canal (Clube Livelo, compra bonificada...); None se não for uma."""
    titulo = TITULO.search(texto or '')
    if not titulo:
        return None
    linhas = lambda nome: [l.strip(' -•') for l in (BLOCO(nome).search(texto) or [None, ''])[1].splitlines() if l.strip()]
    links = [u for u in re.findall(r'https?://\S+', ' '.join(linhas('🔗 Link'))) if not CONVITE.match(u)]
    links += [u for u in urls_escondidas if not CONVITE.match(u) and u not in links]
    if not links:
        return None
    campo = lambda nome: (re.search(r'^\W*' + nome + r'\s*:\s*(.+)$', texto, re.M | re.I) or [None, ''])[1].strip()
    termometro = re.search(r'^\W*🌡️?\s*(Milheiro [^\n]+|Recorde[^\n]+)$', texto, re.M)
    return {
        'tipo': 'promocao',
        'titulo': titulo.group(1).strip(),
        'ultimo_dia': bool(re.search(r'ÚLTIMO DIA|ULTIMO DIA|TERMINA HOJE', texto, re.I)),
        'selo': termometro.group(1).strip() if termometro else '',
        'resumo': ' '.join(linhas('🚀 Resumo')),
        'detalhes': linhas('📋 Mecânica')[:8],
        'parceiros': campo('✅ Parceiros'), 'validade': campo('✅ Validade'),
        'links': links[:3],
    }


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
    programa = campos.get('programa', link.group(1) if link else '')
    nome_link = link.group(1) if link else programa
    if not url or CONVITE.match(url):
        # Sem link da oferta: manda para a busca do site oficial do programa.
        url = next((u for chave, u in SITE_PROGRAMA.items() if chave in programa.lower()), '')
        if not url:
            return None
    return {
        'origem': nome(rota.group(1)), 'origem_iata': rota.group(2),
        'destino': nome(rota.group(3)), 'destino_iata': rota.group(4),
        'companhia': campos['companhia'], 'cabine': campos.get('cabine', ''),
        'programa': programa,
        'ida': campos['ida'], 'volta': campos.get('volta', ''),
        'datas_ida': datas(texto, 'Ida'), 'datas_volta': datas(texto, 'Volta'),
        'link': url, 'link_nome': nome_link,
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


def falhar(msg):
    """Erro visível nas anotações do GitHub (aparecem sem login; nunca levam as chaves)."""
    print(f'::error::{msg}')
    sys.exit(1)


async def main():
    env = {v: re.sub(r'\s+', '', os.environ.get(v, '')) for v in
           ('TELEGRAM_API_ID', 'TELEGRAM_API_HASH', 'TELEGRAM_SESSAO', 'TELEGRAM_GRUPO')}
    faltam = [v for v, x in env.items() if not x]
    if faltam:
        print('::warning::Telegram ainda não ligado (faltam ' + ', '.join(faltam) + '); nada a fazer.')
        return
    if not env['TELEGRAM_API_ID'].isdigit():
        falhar('TELEGRAM_API_ID deveria ter só números.')
    if len(env['TELEGRAM_API_HASH']) != 32:
        falhar(f"TELEGRAM_API_HASH veio com {len(env['TELEGRAM_API_HASH'])} caracteres (deveria ter 32).")
    try:
        sessao = StringSession(env['TELEGRAM_SESSAO'])
    except Exception:
        falhar(f"TELEGRAM_SESSAO não é uma sessão válida ({len(env['TELEGRAM_SESSAO'])} caracteres); copie de novo, inteira.")
    cliente = TelegramClient(sessao, int(env['TELEGRAM_API_ID']), env['TELEGRAM_API_HASH'],
                             device_model='Site Onde as Milhas Me Levam')
    try:
        await cliente.connect()
        autorizado = await cliente.is_user_authorized()
    except Exception as e:
        falhar(f'Não conectou no Telegram: {type(e).__name__}: {e}')
    if not autorizado:
        falhar('A sessão do Telegram foi encerrada. Rode ferramentas/telegram_entrar.py de novo.')
    alvos = {int(g) for g in re.findall(r'-?\d+', env['TELEGRAM_GRUPO'])}
    grupos = [d.entity async for d in cliente.iter_dialogs() if d.id in alvos]
    if not grupos:
        falhar(f'Nenhum dos {len(alvos)} grupos de TELEGRAM_GRUPO foi encontrado na conta.')
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
            p = ler_passagem(m.message, escondidas) or ler_promocao(m.message, escondidas)
            if p:
                passagens.append({'id': f'{grupo.id}-{m.id}',
                                  'data': m.date.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'), **p})
    await cliente.disconnect()
    passagens.sort(key=lambda p: p['data'], reverse=True)
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(passagens, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(passagens)} passagens das últimas {HORAS} h gravadas ({len(grupos)} grupos).')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception as e:
        falhar(f'{type(e).__name__}: {e}')
