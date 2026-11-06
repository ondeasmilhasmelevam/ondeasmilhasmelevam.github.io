"""Páginas de destino para o Google: /destinos/<destino>/, a lista /destinos/, sitemap.xml e robots.txt.

O site é uma página só (as seções trocam pelo #), então o Google só enxerga a página inicial.
Aqui cada guia de destino (dados/guias.json) vira uma página de verdade, com o texto do guia,
as passagens com milhas vistas nos últimos 30 dias (dados/historico.json, sem datas nem link:
isso é do assinante) e o preço bom em milhas do Termômetro. Quem procura "passagem com milhas
para Lisboa" no Google cai aqui e é chamado para o alerta grátis ou a assinatura.

Roda todo dia no GitHub depois do guia (ver .github/workflows/guias.yml). A foto de cada destino
vem do Wikimedia Commons e fica guardada em dados/fotos-destinos.json (busca só as que faltam).
"""
import html
import json
import re
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / 'dados'
PASTA = RAIZ / 'destinos'
SITE = 'https://ondeasmilhasmelevam.com.br'
FOTOS = DADOS / 'fotos-destinos.json'
FOTOS_POR_VEZ = 60
DIAS = 30
CABINES = (('Econômica', 'eco'), ('Executiva', 'exe'))
e = lambda t: html.escape(str(t or ''), quote=True)
mil = lambda v: f'{v:,}'.replace(',', '.')


def ler(nome, padrao):
    try:
        return json.loads((DADOS / nome).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return padrao


def slug(g):
    return re.sub(r'\.html?$', '', g['slug'])


def milhas(texto):
    m = re.search(r'(\d{1,3}(?:\.\d{3})+|\d+)', str(texto or ''))
    return int(m.group(1).replace('.', '')) if m else 0


def foto_commons(g):
    """Uma foto larga do lugar no Wikimedia Commons (mesma busca do site)."""
    pais = g.get('pais') if g.get('pais') and g.get('pais') != g['nome'] else ''
    for termo in ('skyline', 'panorama', ''):
        q = urllib.parse.urlencode({'action': 'query', 'format': 'json', 'generator': 'search', 'gsrnamespace': '6',
                                    'gsrsearch': re.sub(r'\s+', ' ', f'"{g["nome"]}" {pais} {termo} filetype:bitmap'), 'gsrlimit': '30',
                                    'prop': 'imageinfo', 'iiprop': 'url|size', 'iiurlwidth': '1280'})
        req = urllib.request.Request(f'https://commons.wikimedia.org/w/api.php?{q}', headers={'User-Agent': 'OndeAsMilhasMeLevam/1.0 (site)'})
        with urllib.request.urlopen(req, timeout=20) as r:
            paginas = sorted(json.load(r).get('query', {}).get('pages', {}).values(), key=lambda p: p.get('index', 0))
        for p in paginas:
            i = (p.get('imageinfo') or [{}])[0]
            if i.get('width', 0) >= 1200 and 1.3 <= i['width'] / max(i.get('height', 1), 1) <= 2.6:
                return {'url': i['thumburl'], 'pagina': i.get('descriptionurl', '')}
    return {}


def fotos(guias):
    cache = ler('fotos-destinos.json', {})
    faltam = [g for g in guias if slug(g) not in cache][:FOTOS_POR_VEZ]
    for g in faltam:
        try:
            cache[slug(g)] = foto_commons(g)
        except Exception as erro:  # sem foto hoje; tenta de novo amanhã
            print(f'Foto de {g["nome"]}: {erro}')
            if '429' in str(erro):  # o Commons pediu calma: o resto fica para a próxima
                break
        time.sleep(2)
    FOTOS.write_text(json.dumps(cache, ensure_ascii=False, indent=1, sort_keys=True), encoding='utf-8')
    return cache


def passagens_por_iata():
    corte = (datetime.now(timezone.utc) - timedelta(days=DIAS)).strftime('%Y-%m-%dT%H:%M:%SZ')
    por = defaultdict(list)
    for p in ler('historico.json', {}).values():
        if p.get('data', '') >= corte and p.get('destino_iata') and milhas(p.get('ida')):
            por[p['destino_iata']].append(p)
    return por


def regiao_termometro(iata, termo):
    return next((r for r in termo.get('regioes', []) if iata in r.get('aeroportos', [])), None)


CABECA = '''<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{titulo}</title>
<meta name="description" content="{descricao}">
<link rel="canonical" href="{url}">
<meta name="theme-color" content="#070C17">
<meta property="og:title" content="{titulo}">
<meta property="og:description" content="{descricao}">
<meta property="og:image" content="{imagem}">
<meta property="og:url" content="{url}">
<meta property="og:type" content="article">
<meta property="og:locale" content="pt_BR">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/img/icone-192.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@700&family=Manrope:wght@400;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/destinos/destinos.css?v=1">
<script type="application/ld+json">{ld}</script>
</head>
<body>
<header class="topo"><a class="marca" href="/"><img src="/img/icone-192.png" alt="" width="32" height="32"><b>Onde as Milhas Me Levam</b></a>
<nav><a href="/destinos/">Destinos</a><a href="/#passagens">Passagens</a><a class="botao" href="/#gratis">Alerta grátis</a></nav></header>
'''
RODAPE = '''<footer class="rodape"><p><a href="/">Onde as Milhas Me Levam</a> · alertas de passagens com milhas e promoções de pontos ·
<a href="https://instagram.com/ondeasmilhasmelevam">@ondeasmilhasmelevam</a></p>
<p class="fino">Preços em milhas mudam a todo momento e dependem de disponibilidade. Conteúdo informativo, não é recomendação.</p></footer>
</body>
</html>
'''


def chamada(nome):
    return f'''<section class="chamada">
<h2>Quer saber quando aparecer passagem com milhas para {e(nome)}?</h2>
<p>Toda semana mandamos as melhores passagens com milhas no seu e-mail, de graça. Assinantes recebem cada uma na hora, com as datas e o link para emitir.</p>
<p class="acoes"><a class="botao" href="/#gratis">Receber grátis no e-mail</a><a class="botao vazado" href="/#assinar">Ver a assinatura</a></p>
</section>'''


def pagina_destino(g, foto, vistas, termo, vizinhos):
    s, nome = slug(g), g['nome']
    url = f'{SITE}/destinos/{s}/'
    iata = g.get('aeroporto_iata') or ''
    titulo = f'Passagem com milhas para {nome}: preço bom, melhor época e guia'
    descricao = f'Quantas milhas custa ir para {nome}, passagens com milhas vistas nos últimos {DIAS} dias, melhor época e o que fazer. {g.get("resumo", "")}'[:300]
    partes = []
    fatos = [('Melhor época', g.get('melhor_epoca')), ('Quantos dias', g.get('quantos_dias')), ('Aeroporto', iata),
             ('Moeda', g.get('moeda')), ('Idioma', g.get('idioma')), ('Documentos', g.get('documentos'))]
    partes.append(f'<p class="lead">{e(g.get("resumo"))}</p>')
    partes.append('<dl class="fatos">' + ''.join(f'<div><dt>{e(a)}</dt><dd>{e(b)}</dd></div>' for a, b in fatos if b) + '</dl>')

    # Passagens com milhas vistas (sem data e sem link: isso é da assinatura)
    if vistas:
        linhas, menores = [], []
        for cab, _ in CABINES:  # o menor de cada programa: milhas de programas diferentes não se comparam
            menor = {}
            for p in vistas:
                if p.get('cabine') == cab and (p.get('programa') not in menor or milhas(p['ida']) < milhas(menor[p['programa']]['ida'])):
                    menor[p.get('programa')] = p
            if menor:
                itens = sorted(menor.values(), key=lambda p: milhas(p['ida']))[:4]
                menores.append(f'<li><b>{cab}</b>, menor trecho visto por programa: ' + ' · '.join(
                    f'{e(p.get("programa"))} <b>{mil(milhas(p["ida"]))}</b>' for p in itens) + '</li>')
        for p in sorted(vistas, key=lambda p: p['data'], reverse=True)[:10]:
            linhas.append(f'<tr><td>{e(p.get("origem"))} <small>{e(p.get("origem_iata"))}</small></td><td>{e(p.get("cabine"))}</td>'
                          f'<td>{e(p.get("programa"))}</td><td class="num">{e(p.get("ida"))}</td></tr>')
        partes.append(f'''<section><h2>Passagens com milhas para {e(nome)} nos últimos {DIAS} dias</h2>
<p>Nosso robô encontrou <b>{len(vistas)} {"passagem" if len(vistas) == 1 else "passagens"}</b> com milhas para {e(nome)} no último mês.</p>
<ul class="menores">{"".join(menores)}</ul>
<div class="tabela"><table><thead><tr><th>Saindo de</th><th>Cabine</th><th>Programa</th><th>Ida</th></tr></thead><tbody>{"".join(linhas)}</tbody></table></div>
<p class="fino">As datas e o link para emitir cada uma vão na hora para os assinantes, antes de esgotar.</p></section>''')
    else:
        partes.append(f'<section><h2>Passagens com milhas para {e(nome)}</h2><p>Não vimos passagem com milhas para {e(nome)} nos últimos {DIAS} dias. '
                      'Deixe seu e-mail e a gente avisa quando aparecer.</p></section>')

    # Termômetro: a partir de quantas milhas o trecho já é bom
    r = regiao_termometro(iata, termo) if iata else None
    if r:
        itens = []
        for cab, chave in CABINES:
            bom = (r.get('cabines', {}).get(chave) or {}).get('bom') or {}
            if bom:
                progs = ', '.join(f'{termo["programas"].get(k, k)} até {mil(v)}' for k, v in sorted(bom.items(), key=lambda kv: kv[1]))
                itens.append(f'<li><b>{cab}</b>: {e(progs)}</li>')
        if itens:
            partes.append(f'''<section><h2>Quantas milhas é um bom preço para {e(nome)}?</h2>
<p>Pelo nosso <a href="/#termometro">Termômetro de milhas</a> ({e(r["nome"])}), por trecho e por pessoa, sem as taxas:</p><ul>{"".join(itens)}</ul></section>''')

    if g.get('destaques'):
        partes.append(f'<section><h2>O que não perder em {e(nome)}</h2><ul>' + ''.join(f'<li>{e(x)}</li>' for x in g['destaques']) + '</ul></section>')
    for chave, rotulo in (('quando_ir', 'Quando ir'), ('como_chegar', 'Como chegar'), ('onde_ficar', 'Onde ficar'), ('o_que_fazer', 'O que fazer'),
                          ('passeios', 'Passeios'), ('praias', 'Praias'), ('pontos_turisticos', 'Pontos turísticos'), ('onde_comer', 'Onde comer')):
        sec = (g.get('secoes') or {}).get(chave) or {}
        if sec.get('resumo') or sec.get('itens'):
            partes.append(f'<section><h2>{rotulo}: {e(nome)}</h2>' + (f'<p>{e(sec.get("resumo"))}</p>' if sec.get('resumo') else '') +
                          ('<ul class="itens">' + ''.join(f'<li><b>{e(i.get("nome"))}</b> {e(i.get("texto"))}</li>' for i in sec.get('itens', [])) + '</ul>' if sec.get('itens') else '') +
                          '</section>')
    if g.get('dicas'):
        partes.append(f'<section><h2>Dicas para {e(nome)}</h2><ul>' + ''.join(f'<li>{e(x)}</li>' for x in g['dicas']) + '</ul></section>')
    partes.append(chamada(nome))
    if vizinhos:
        partes.append(f'<section><h2>Outros destinos: {e(g.get("regiao"))}</h2><ul class="vizinhos">' +
                      ''.join(f'<li><a href="/destinos/{slug(v)}/">{e(v["nome"])}</a></li>' for v in vizinhos) + '</ul></section>')

    ld = [{'@context': 'https://schema.org', '@type': 'TouristDestination', 'name': nome, 'description': g.get('resumo', ''), 'url': url,
           **({'image': foto['url']} if foto.get('url') else {})},
          {'@context': 'https://schema.org', '@type': 'BreadcrumbList', 'itemListElement': [
              {'@type': 'ListItem', 'position': 1, 'name': 'Início', 'item': SITE + '/'},
              {'@type': 'ListItem', 'position': 2, 'name': 'Destinos', 'item': SITE + '/destinos/'},
              {'@type': 'ListItem', 'position': 3, 'name': nome, 'item': url}]}]
    topo = (f'<div class="capa" style="background-image:url(\'{e(foto["url"])}\')">' if foto.get('url') else '<div class="capa sem-foto">')
    credito = f'<a class="credito" href="{e(foto.get("pagina"))}" rel="nofollow">Foto: Wikimedia Commons</a>' if foto.get('url') else ''
    return (CABECA.format(titulo=e(titulo), descricao=e(descricao), url=url, imagem=e(foto.get('url') or SITE + '/img/compartilhar.jpg'),
                          ld=json.dumps(ld, ensure_ascii=False).replace('</', '<\\/'))
            + f'''<main>
<nav class="trilha"><a href="/">Início</a> › <a href="/destinos/">Destinos</a> › {e(nome)}</nav>
{topo}<div><small>{e(" · ".join(x for x in (g.get("regiao"), g.get("pais")) if x))}</small><h1>Passagem com milhas para {e(nome)}</h1></div>{credito}</div>
{"".join(partes)}
<p class="fino">Atualizado em {datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=-3))).strftime("%d/%m/%Y")}.</p>
</main>
''' + RODAPE)


def pagina_lista(guias, por_iata):
    grupos = defaultdict(list)
    for g in guias:
        grupos[('Brasil' if g.get('tipo') == 'nacional' else 'Exterior', g.get('regiao') or 'Outros')].append(g)
    blocos = []
    for tipo in ('Exterior', 'Brasil'):
        regioes = sorted(r for t, r in grupos if t == tipo)
        blocos.append(f'<h2>{"Destinos internacionais" if tipo == "Exterior" else "Destinos no Brasil"}</h2>')
        for r in regioes:
            itens = []
            for g in sorted(grupos[(tipo, r)], key=lambda g: g['nome']):
                n = len(por_iata.get(g.get('aeroporto_iata') or '', []))
                itens.append(f'<li><a href="/destinos/{slug(g)}/">{e(g["nome"])}</a>' + (f' <small>{n} com milhas no mês</small>' if n else '') + '</li>')
            blocos.append(f'<h3>{e(r)}</h3><ul class="lista">{"".join(itens)}</ul>')
    titulo = 'Passagens com milhas por destino: preços e guias de viagem'
    descricao = f'Guia de {len(guias)} destinos com quanto custa a passagem com milhas, melhor época, o que fazer e as passagens vistas no último mês.'
    url = SITE + '/destinos/'
    ld = {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': titulo, 'url': url, 'description': descricao}
    return (CABECA.format(titulo=e(titulo), descricao=e(descricao), url=url, imagem=SITE + '/img/compartilhar.jpg', ld=json.dumps(ld, ensure_ascii=False))
            + f'<main><nav class="trilha"><a href="/">Início</a> › Destinos</nav><h1>Passagens com milhas por destino</h1>'
            f'<p class="lead">{e(descricao)}</p>{"".join(blocos)}{chamada("o seu próximo destino")}</main>' + RODAPE)


def main():
    guias = ler('guias.json', {}).get('destinos', [])
    if not guias:
        return print('Sem guias: nada a fazer.')
    termo = ler('termometro.json', {})
    por_iata = passagens_por_iata()
    cache = fotos(guias)
    por_regiao = defaultdict(list)
    for g in guias:
        por_regiao[g.get('regiao')].append(g)
    PASTA.mkdir(exist_ok=True)
    feitos = set()
    for g in guias:
        s = slug(g)
        vizinhos = [v for v in por_regiao[g.get('regiao')] if v is not g][:12]
        (PASTA / s).mkdir(exist_ok=True)
        (PASTA / s / 'index.html').write_text(pagina_destino(g, cache.get(s) or {}, por_iata.get(g.get('aeroporto_iata') or '', []), termo, vizinhos),
                                              encoding='utf-8')
        feitos.add(s)
    for velha in PASTA.iterdir():  # destino que saiu do guia
        if velha.is_dir() and velha.name not in feitos:
            for f in velha.iterdir():
                f.unlink()
            velha.rmdir()
    (PASTA / 'index.html').write_text(pagina_lista(guias, por_iata), encoding='utf-8')

    hoje = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    urls = [(SITE + '/', '1.0'), (SITE + '/destinos/', '0.8')] + [(f'{SITE}/destinos/{s}/', '0.6') for s in sorted(feitos)]
    (RAIZ / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
                                      ''.join(f'<url><loc>{u}</loc><lastmod>{hoje}</lastmod><priority>{p}</priority></url>\n' for u, p in urls) +
                                      '</urlset>\n', encoding='utf-8')
    (RAIZ / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nDisallow: /resumo/\nDisallow: /servidor/\nDisallow: /ferramentas/\n\nSitemap: {SITE}/sitemap.xml\n',
                                     encoding='utf-8')
    print(f'{len(feitos)} páginas de destino, {sum(1 for s in feitos if (cache.get(s) or {}).get("url"))} com foto.')


if __name__ == '__main__':
    main()
