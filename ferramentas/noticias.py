"""Busca as notícias de cartões nos feeds (RSS) e grava dados/noticias.json.

Roda sozinho no GitHub (ver .github/workflows/noticias.yml). Guarda só
título, data, link e fonte: o texto da notícia fica no site de origem.
"""
import json
import re
import sys
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from pathlib import Path

FEEDS = [
    {'fonte': 'Melhores Cartões', 'url': f'https://www.melhorescartoes.com.br/feed?paged={p}'}
    for p in (1, 2, 3)
]
# Só novidades de cartões (pelo título): lançamentos, mudanças de regra,
# parcerias. Ofertas e promoções ficam de fora (pedido do Felipe).
ASSUNTO = re.compile(
    r'\bcart(ao|oes)\b|anuidade|sala(s)? vip|lounge|priority pass|loungekey|dragon pass|'
    r'visa infinite|mastercard black|parceria|pontos? por dolar'
)
FORA = re.compile(
    r'desconto|cupo|post oculto|resumo|so hoje|ultimos dias|ultima chance|ganhe|cashback|'
    r'% de bonus|bonus na transferencia|promoca|oferece ate|a partir de r\$'
)
MAXIMO = 30
SAIDA = Path(__file__).resolve().parent.parent / 'dados' / 'noticias.json'


def sem_acento(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t or '') if unicodedata.category(c) != 'Mn').lower()


def ler_feed(feed):
    req = urllib.request.Request(feed['url'], headers={'User-Agent': 'Mozilla/5.0 (OndeAsMilhasMeLevam noticias)'})
    raiz = ET.fromstring(urllib.request.urlopen(req, timeout=30).read())
    itens = []
    for item in raiz.iter('item'):
        titulo = (item.findtext('title') or '').strip()
        link = (item.findtext('link') or '').strip()
        cats = ' '.join(c.text or '' for c in item.findall('category'))
        if not titulo or not link.startswith('http'):
            continue
        if FORA.search(sem_acento(cats + ' ' + titulo)) or not ASSUNTO.search(sem_acento(titulo)):
            continue
        try:
            data = parsedate_to_datetime(item.findtext('pubDate')).date().isoformat()
        except Exception:
            data = ''
        itens.append({'titulo': titulo, 'data': data, 'link': link, 'fonte': feed['fonte']})
    return itens


def main():
    todas, erros = [], 0
    for feed in FEEDS:
        try:
            todas += ler_feed(feed)
        except Exception as e:  # um feed fora do ar não derruba os outros
            erros += 1
            print(f"Falhou {feed['fonte']}: {e}", file=sys.stderr)
    if erros == len(FEEDS):
        print('Nenhum feed respondeu; mantendo o arquivo anterior.', file=sys.stderr)
        return
    # Junta com as já guardadas: o feed só traz os posts mais recentes.
    try:
        todas += json.loads(SAIDA.read_text(encoding='utf-8'))
    except Exception:
        pass
    vistos, lista = set(), []
    for n in sorted(todas, key=lambda n: n.get('data', ''), reverse=True):
        if n['link'] in vistos:
            continue
        vistos.add(n['link'])
        lista.append(n)
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(lista[:MAXIMO], ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(lista[:MAXIMO])} notícias gravadas em {SAIDA}')


if __name__ == '__main__':
    main()
