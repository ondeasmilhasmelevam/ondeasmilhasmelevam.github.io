"""Busca as notícias de cartões nos feeds (RSS) e grava dados/noticias.json.

Roda sozinho no GitHub (ver .github/workflows/noticias.yml). Guarda só
título, data, link e fonte: o texto da notícia fica no site de origem.
"""
import html
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
] + [
    {'fonte': 'Passageiro de Primeira', 'url': f'https://passageirodeprimeira.com/categorias/noticias/feed/?paged={p}'}
    for p in (1, 2)
]
# Notícias de milhas e viagens (companhias, programas, rotas, salas). Guias que
# não são notícia ("como acumular", "o que é") ficam de fora, assim como ofertas.
MILHAS = re.compile(
    r'milhas|pontos|avios|award|resgate|programa|smiles|latam|azul|gol\b|tap\b|iberia|british|qatar|emirates|united|'
    r'american|air france|klm|flying blue|livelo|esfera|sala vip|lounge|rota|voo|voos|codeshare|alianca|companhia'
)
GUIA = re.compile(r'^(como|o que|quais|qual|quanto|vale a pena|guia|dicas?|entenda|saiba|veja|conheca)\b|\?$')
# Só novidades de cartões (pelo título): lançamentos, mudanças de regra,
# parcerias. Ofertas e promoções ficam de fora (pedido do Felipe).
ASSUNTO = re.compile(
    r'\bcart(ao|oes)\b|anuidade|sala(s)? vip|lounge|priority pass|loungekey|dragon pass|'
    r'visa infinite|mastercard black|parceria|pontos? por dolar'
)
FORA = re.compile(
    r'desconto|cupo|post oculto|resumo|so hoje|ultimos dias|ultima chance|ganhe|cashback|'
    r'% de bonus|bonus na transferencia|promoca|oferece|oferta|a partir de r\$|'
    r'anuidade gratis|primeira anuidade|1 ano de anuidade|peca o seu|confira|muito bom|bom demais|pesquisa'
)


# Título com cara de notícia (mudança, lançamento) entra mesmo que cite oferta.
NOTICIA = re.compile(r'parceria|\blanca|lancamento|novas regras|vai mudar|\bmuda|reduz|aumenta|encerra|acaba|deixa de|passa a')


def e_novidade(titulo, cats=''):
    t = sem_acento(titulo)
    if not ASSUNTO.search(t) or re.search(r'pesquisa|cupo|post oculto|resumo', sem_acento(cats) + ' ' + t):
        return False
    return bool(NOTICIA.search(t)) or not FORA.search(t)


def tema(titulo, cats=''):
    """'cartoes', 'milhas' ou '' (fica de fora)."""
    t = sem_acento(titulo)
    # Guias, avisos do próprio site, ofertas de resgate e assuntos que não são de viagem ficam de fora.
    if GUIA.search(t) or re.search(r'cupo|post oculto|resumo|canal|whatsapp|roupa|emita|a partir de \d|nomad|ganhe', t):
        return ''
    if e_novidade(titulo, cats):
        return 'cartoes'
    if MILHAS.search(t) and (NOTICIA.search(t) or re.search(r'anuncia|estreia|libera|nova|novo|novas|novos|inaugura|fecha|retoma|suspende|tera', t) or not FORA.search(t)):
        return 'milhas'
    return ''


MAXIMO = 40
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
        assunto = tema(titulo, cats)
        if not assunto:
            continue
        try:
            data = parsedate_to_datetime(item.findtext('pubDate')).date().isoformat()
        except Exception:
            data = ''
        itens.append({'titulo': titulo, 'data': data, 'link': link, 'fonte': feed['fonte'], 'tema': assunto})
    return itens


# Cartões e milhas do Melhores Destinos (notícias e emissões): a seção não tem feed, então a
# lista vem das próprias páginas; a data, de cada artigo. Entra tudo dessa seção (pedido do Felipe), como tema milhas.
MD_LISTAS = ('https://www.melhoresdestinos.com.br/noticias-milhas-e-cartoes', 'https://www.melhoresdestinos.com.br/emissoes-com-milhas')
MD_POR_LISTA = 12
MD_ARTIGO = re.compile(r'<a[^>]+href="(https://www\.melhoresdestinos\.com\.br/milhas/[^"#?]+)"[^>]*>\s*(?:<[^>]+>\s*)*([^<]{20,200})<')


def baixar(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (OndeAsMilhasMeLevam noticias)'})
    return urllib.request.urlopen(req, timeout=30).read().decode('utf-8', 'replace')


def ler_melhores_destinos():
    itens, vistos = [], set()
    achados = []
    for lista in MD_LISTAS:
        unicos = [x for x in dict.fromkeys(MD_ARTIGO.findall(baixar(lista))) if x[0] not in {a for a, _ in achados}]
        achados += unicos[:MD_POR_LISTA]
    for link, titulo in achados:
        if link in vistos:
            continue
        vistos.add(link)
        data = ''
        try:
            m = re.search(r'(?:published_time|datePublished)[^0-9]{0,30}(\d{4}-\d{2}-\d{2})', baixar(link))
            data = m.group(1) if m else ''
        except Exception:
            pass
        itens.append({'titulo': html.unescape(titulo).strip(), 'data': data, 'link': link, 'fonte': 'Melhores Destinos', 'tema': 'milhas'})
    return itens


def main():
    todas, erros = [], 0
    try:
        todas += ler_melhores_destinos()
    except Exception as e:
        print(f'Falhou Melhores Destinos: {e}', file=sys.stderr)
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
    # As já guardadas passam pelo mesmo filtro (o filtro pode ter ficado mais rígido).
    try:
        for n in json.loads(SAIDA.read_text(encoding='utf-8')):
            if n.get('fonte') != 'Melhores Destinos':  # essa fonte entra inteira
                n['tema'] = tema(n.get('titulo', ''))
            if n['tema']:
                todas.append(n)
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
