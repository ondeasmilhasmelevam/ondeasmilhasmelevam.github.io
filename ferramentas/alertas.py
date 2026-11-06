"""Lê as passagens publicadas nos grupos do Telegram e grava dados/alertas.json.

Roda sozinho no GitHub (ver .github/workflows/alertas.yml), com a sessão
criada por ferramentas/telegram_entrar.py. TELEGRAM_GRUPO pode ter vários
grupos, separados por vírgula.

Só entram, das últimas 48 horas, mensagens no formato de passagem (rota,
companhia, programa, milhas, datas e link) ou de promoção de pontos (título
entre 💸, resumo, validade e link). Guarda só esses dados e o link original;
resumos do dia, curiosidades e o resto do texto ficam de fora. A promoção
com validade fica até o fim do dia da validade, mesmo depois das 48 horas.
Em grupos (não canais), só valem as mensagens dos administradores.
"""
import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from telethon import TelegramClient
from telethon.sessions import StringSession
from telethon.tl.types import (ChannelParticipantAdmin, ChannelParticipantCreator, ChannelParticipantsAdmins,
                               ChatParticipantAdmin, ChatParticipantCreator, MessageEntityTextUrl, PeerChannel)

HORAS = 48
SAIDA = Path(__file__).resolve().parent.parent / 'dados' / 'alertas.json'
# Datas e link de emissão das passagens são da assinatura: saem do arquivo público e vão para o
# servidor. A lista inteira fica em alertas-completo.json (fora do git), para o Instagram.
SO_ASSINANTE = ('datas_ida', 'datas_volta', 'link')
# O servidor também recebe a rota de cada passagem, para avisar quem tem Meu Radar.
CAMPOS_RADAR = ('origem', 'origem_iata', 'destino', 'destino_iata', 'companhia', 'cabine', 'programa', 'ida', 'volta', 'link_nome')
COMPLETO = SAIDA.with_name('alertas-completo.json')
ENVIADO = SAIDA.with_name('.alertas-enviado')
SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev'
# Canais lidos pelo nome, além dos ids de TELEGRAM_GRUPO (a conta precisa estar no canal).
CANAIS_POR_NOME = ('VMM - Passagens Internacionais', 'OndeAsMilhasMeLevam Europa')
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


BRASILIA = timezone(timedelta(hours=-3))
DIAS_PROMO = 60  # até onde volta no canal procurando promoções ainda válidas


def fim_da_validade(validade, postada):
    """'30/10' ou '28/10/2026' → fim desse dia em Brasília (ISO); '' se não der para ler.
    Sem ano, vale o ano da postagem (ou o seguinte, se a data já tiver passado)."""
    d = re.search(r'(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', validade or '')
    if not d:
        return ''
    dia, mes = int(d.group(1)), int(d.group(2))
    ano = int(d.group(3)) if d.group(3) else postada.astimezone(BRASILIA).year
    if ano < 100:
        ano += 2000
    try:
        fim = datetime(ano, mes, dia, 23, 59, 59, tzinfo=BRASILIA)
    except ValueError:
        return ''
    if not d.group(3) and fim < postada - timedelta(days=7):
        fim = fim.replace(year=ano + 1)
    return fim.isoformat()


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


# Outro formato (grupos do próprio site): "Rota: Recife (REC) → Madrid (MAD)", "Programa:", "Custo: 656k + taxas",
# "Trajeto: Ida e Volta", "Cabine: Executiva - Azul", "Data: 21/02 a 05/03/2027".
CAMPO_ROTA = re.compile(r'^\W*(Rota|Programa|Custo|Trajeto|Cabine|Data)\s*:\s*(.+)$', re.I | re.M)
MESES = ('Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez')


def ler_passagem_rota(texto, urls_escondidas=()):
    campos = {k.lower(): v.strip() for k, v in CAMPO_ROTA.findall(texto or '')}
    lugares = re.findall(LUGAR, campos.get('rota', ''))
    if len(lugares) < 2 or not campos.get('custo') or not campos.get('programa'):
        return None
    custo = re.match(r'([\d.,]+)\s*(k|mil)?', campos['custo'], re.I)
    if not custo:
        return None
    n = float(custo.group(1).replace('.', '').replace(',', '.')) * (1000 if custo.group(2) else 1)
    resto = campos['custo'][custo.end():].strip()
    ida_volta = 'volta' in campos.get('trajeto', '').lower()
    # "pontos" e não "milhas": o valor do formato é o total, e o termômetro compara por trecho
    valor = f"{int(n):,} pontos {resto}".replace(',', '.').strip() + (', ida e volta' if ida_volta else '')
    cabine, _, cia = campos.get('cabine', '').partition(' - ')
    programa = campos['programa']
    datas_ida, datas_volta = [], []
    d = re.findall(r'(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?', campos.get('data', ''))
    ano = next((a for *_, a in reversed(d) if a), '')[-2:]
    for i, (dia, mes, a) in enumerate(d[:2]):
        if 1 <= int(mes) <= 12:
            (datas_ida if i == 0 else datas_volta).append({'mes': f'{MESES[int(mes) - 1]}/{(a or ano)[-2:]}', 'dias': dia.zfill(2)})
    url = next((u for u in urls_escondidas if not CONVITE.match(u)), '') or next((u for chave, u in SITE_PROGRAMA.items() if chave in programa.lower()), '')
    if not url:
        return None
    return {
        'origem': nome(lugares[0][0]), 'origem_iata': lugares[0][1],
        'destino': nome(lugares[1][0]), 'destino_iata': lugares[1][1],
        'companhia': cia.strip() or programa, 'cabine': cabine.strip(), 'programa': programa,
        'ida': valor, 'volta': '', 'datas_ida': datas_ida, 'datas_volta': datas_volta,
        'link': url, 'link_nome': programa,
    }


def ler_passagem(texto, urls_escondidas=()):
    """Transforma a mensagem do grupo nos campos da passagem; None se não for uma."""
    if not ROTA.search(texto or '') and CAMPO_ROTA.search(texto or ''):
        return ler_passagem_rota(texto, urls_escondidas)
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


def enviar_para_assinantes(passagens):
    """Manda datas, link e rota de cada passagem para o servidor da assinatura (servidor/worker.js),
    que guarda no Firestore só para assinantes. Entra com o token OIDC da execução no GitHub;
    só reenvia quando algo mudou."""
    completos = {p['id']: {k: p[k] for k in SO_ASSINANTE + CAMPOS_RADAR if k in p} for p in passagens if p.get('tipo') != 'promocao'}
    corpo = json.dumps(completos, ensure_ascii=False, sort_keys=True)
    marca = hashlib.sha256(corpo.encode()).hexdigest()
    if ENVIADO.exists() and ENVIADO.read_text() == marca:
        return
    pedido_url, pedido_token = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL'), os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
    if not pedido_url:
        print('::warning::Sem token do GitHub (rodando fora do Actions?); datas e links não foram para os assinantes.')
        return
    try:
        oidc = requests.get(pedido_url, params={'audience': SERVIDOR}, headers={'Authorization': f'Bearer {pedido_token}'}, timeout=20).json()['value']
        r = requests.post(f'{SERVIDOR}/alertas', data=corpo.encode(), timeout=30,
                          headers={'Authorization': f'Bearer {oidc}', 'Content-Type': 'application/json'})
        r.raise_for_status()
        ENVIADO.write_text(marca)
    except Exception as e:
        print(f'::warning::Datas e links não chegaram aos assinantes agora ({type(e).__name__}); tenta na próxima volta.')


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
    grupos = [d.entity async for d in cliente.iter_dialogs() if d.id in alvos or (d.name or '').strip() in CANAIS_POR_NOME]
    if not grupos:
        falhar(f'Nenhum dos {len(alvos)} grupos de TELEGRAM_GRUPO foi encontrado na conta.')
    limite = datetime.now(timezone.utc) - timedelta(hours=HORAS)

    agora = datetime.now(timezone.utc)
    limite_promo = agora - timedelta(days=DIAS_PROMO)
    passagens = []
    for grupo in grupos:
        antes = len(passagens)
        autores = await quem_publica(cliente, grupo)
        tem_promo = False
        async for m in cliente.iter_messages(grupo, limit=3000):
            antiga = m.date < limite
            # Depois das 48 h, só segue voltando no canal que tem promoções (elas valem até a validade).
            if m.date < limite_promo or (antiga and not tem_promo):
                break
            do_grupo = isinstance(m.from_id, PeerChannel) or m.from_id is None  # canal ou admin anônimo
            if autores is not None and not do_grupo and m.sender_id not in autores:
                continue
            escondidas = [e.url for e in (m.entities or []) if isinstance(e, MessageEntityTextUrl)]
            p = None if antiga else ler_passagem(m.message, escondidas)
            if not p:
                p = ler_promocao(m.message, escondidas)
                if p:
                    tem_promo = True
                    p['ate'] = fim_da_validade(p['validade'], m.date)
                    vale_ate = datetime.fromisoformat(p['ate']) if p['ate'] else m.date + timedelta(hours=HORAS)
                    if vale_ate < agora:
                        continue
            if p:
                passagens.append({'id': f'{grupo.id}-{m.id}',
                                  'data': m.date.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'), **p})
        print(f'{getattr(grupo, "title", grupo.id)}: {len(passagens) - antes} passagens/promoções')
    await cliente.disconnect()
    passagens.sort(key=lambda p: p['data'], reverse=True)
    SAIDA.parent.mkdir(exist_ok=True)
    COMPLETO.write_text(json.dumps(passagens, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    enviar_para_assinantes(passagens)
    publico = [{k: v for k, v in p.items() if k not in SO_ASSINANTE} if p.get('tipo') != 'promocao' else p for p in passagens]
    SAIDA.write_text(json.dumps(publico, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    try:
        atualizar_numeros(passagens, agora)
    except Exception as e:  # os números são enfeite: nunca param os alertas
        print(f'::warning::Números do site não atualizados: {type(e).__name__}: {e}')
    print(f'{len(passagens)} itens gravados ({sum(1 for p in passagens if p.get("tipo") == "promocao")} promoções, {len(grupos)} grupos).')


# Prova social no site e no e-mail da semana: quantas passagens e promoções apareceram nos
# últimos 30 dias e as melhores achadas. O histórico (35 dias, só rota e milhas, sem datas
# nem link) fica em dados/historico.json; o resumo pequeno que o site lê, em dados/numeros.json.
HISTORICO = SAIDA.with_name('historico.json')
NUMEROS = SAIDA.with_name('numeros.json')
CAMPOS_HISTORICO = ('tipo', 'titulo', 'origem', 'origem_iata', 'destino', 'destino_iata', 'cabine', 'programa', 'ida', 'volta')


def melhores(itens, quantos):
    """Passagens boas no termômetro primeiro, depois as de menos milhas; um destino de cada."""
    from instagram import BONS, milhas, nivel
    vistos, saida = set(), []
    for a in sorted(itens, key=lambda a: (BONS.index(nivel(a)) if nivel(a) in BONS else 9, milhas(a.get('ida')))):
        if a.get('destino_iata') in vistos or milhas(a.get('ida')) >= 10 ** 9 or nivel(a) in ('caro', 'péssimo'):
            continue
        vistos.add(a.get('destino_iata'))
        saida.append({**{k: a.get(k, '') for k in ('id', 'origem', 'origem_iata', 'destino', 'destino_iata', 'cabine', 'programa', 'data')},
                      'milhas': milhas(a.get('ida')), 'nivel': nivel(a)})
        if len(saida) == quantos:
            break
    return saida


def destaques_semana(itens):
    """E-mail da semana: 2 nacionais e 2 internacionais em econômica e 1 executiva, as melhores de cada.
    Se faltar algum tipo na semana, completa com as melhores que sobraram."""
    from instagram import BR
    exe = lambda a: bool(re.search(r'execut|primeira|first|business|premium', a.get('cabine') or '', re.I))
    nac = lambda a: a.get('origem_iata') in BR and a.get('destino_iata') in BR
    eco = [a for a in itens if not exe(a)]
    saida = []
    for grupo, lista, quantos in (('Nacional', [a for a in eco if nac(a)], 2), ('Internacional', [a for a in eco if not nac(a)], 2),
                                  ('Executiva', [a for a in itens if exe(a)], 1)):
        usados = {d['destino_iata'] for d in saida}
        saida += [{**d, 'grupo': grupo} for d in melhores([a for a in lista if a.get('destino_iata') not in usados], quantos)]
    if len(saida) < 5:
        usados = {d['destino_iata'] for d in saida}
        saida += [{**d, 'grupo': 'Executiva' if exe(d) else 'Nacional' if nac(d) else 'Internacional'}
                  for d in melhores([a for a in itens if a.get('destino_iata') not in usados], 5 - len(saida))]
    return saida


def candidatas_semana(itens):
    """Até 80 boas da semana (um destino de cada, por cabine), com a região: o servidor escolhe entre elas as do
    e-mail de quem disse de onde sai e para onde quer ir."""
    from instagram import BR
    try:
        termo = json.loads((Path(__file__).resolve().parent.parent / 'dados' / 'termometro.json').read_text(encoding='utf-8'))
        regiao_de = {i: ('america-do-sul' if r['id'].startswith('america-do-sul') else r['id']) for r in termo['regioes'] for i in r['aeroportos']}
    except Exception:
        regiao_de = {}
    exe = lambda a: bool(re.search(r'execut|primeira|first|business|premium', a.get('cabine') or '', re.I))
    saida = []
    # econômica e executiva separadas: um destino de cada em cada cabine (senão a executiva some atrás da econômica)
    for d in melhores([a for a in itens if not exe(a)], 60) + melhores([a for a in itens if exe(a)], 20):
        brasil = d.get('origem_iata') in BR and d.get('destino_iata') in BR
        saida.append({**d, 'regiao': 'brasil' if brasil else regiao_de.get(d.get('destino_iata'), 'outros')})
    return saida


ROTAS = Path(__file__).resolve().parent.parent / 'img' / 'rotas'


def fotos_rotas(listas):
    """Foto dividida origem/destino de cada destaque (img/rotas/GRU-LIS.jpg), para o e-mail da semana.
    Só baixa a foto da rota que ainda não tem; apaga as que saíram dos destaques."""
    from instagram import faixa_fotos
    ROTAS.mkdir(parents=True, exist_ok=True)
    usadas = set()
    for d in (d for lista in listas for d in lista):
        if not (re.fullmatch(r'[A-Z]{3}', d.get('origem_iata') or '') and re.fullmatch(r'[A-Z]{3}', d.get('destino_iata') or '')):
            continue
        nome = f"{d['origem_iata']}-{d['destino_iata']}.jpg"
        arq = ROTAS / nome
        if not arq.exists():
            try:
                img = faixa_fotos(d, 1120, 360, sombra=False)
            except Exception as e:
                print(f'::warning::Foto da rota {nome} não saiu: {e}')
                img = None
            if img is None:
                continue
            img.convert('RGB').save(arq, 'JPEG', quality=78, optimize=True)
        d['foto'] = f'img/rotas/{nome}'
        usadas.add(nome)
    for f in ROTAS.glob('*.jpg'):
        if f.name not in usadas:
            f.unlink()


def atualizar_numeros(passagens, agora):
    try:
        hist = json.loads(HISTORICO.read_text(encoding='utf-8'))
    except Exception:
        hist = {}
    for p in passagens:
        hist.setdefault(p['id'], {'data': p['data'], **{k: p[k] for k in CAMPOS_HISTORICO if p.get(k)}})
    data = lambda dias: (agora - timedelta(days=dias)).isoformat().replace('+00:00', 'Z')
    hist = {k: v for k, v in hist.items() if v['data'] >= data(35)}
    HISTORICO.write_text(json.dumps(hist, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    mes = [{**a, 'id': k} for k, a in hist.items() if a['data'] >= data(30)]
    viagens = [a for a in mes if a.get('tipo') != 'promocao']
    semana = [a for a in viagens if a['data'] >= data(7)]
    numeros = {
        'atualizado': agora.isoformat().replace('+00:00', 'Z'),
        'dias': 30,
        'passagens': len(viagens),
        'promocoes': sum(1 for a in mes if a.get('tipo') == 'promocao'),
        'destinos': len({a.get('destino_iata') for a in viagens}),
        'executiva': sum(1 for a in viagens if re.search(r'execut|primeira|first|business|premium', a.get('cabine') or '', re.I)),
        'destaques': melhores(viagens, 6),
        'semana': {'passagens': len(semana), 'destaques': destaques_semana(semana), 'candidatas': candidatas_semana(semana)},
    }
    try:
        fotos_rotas([numeros['destaques'], numeros['semana']['destaques']])
    except Exception as e:  # sem foto o e-mail sai igual, só sem imagem
        print(f'::warning::Fotos das rotas não atualizadas: {type(e).__name__}: {e}')
    NUMEROS.write_text(json.dumps(numeros, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except SystemExit:
        raise
    except Exception as e:
        falhar(f'{type(e).__name__}: {e}')
