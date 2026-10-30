"""Publica no Instagram os melhores alertas de dados/alertas.json.

Roda dentro do plantão dos alertas (ver .github/workflows/alertas.yml), logo
depois de cada leitura do Telegram. Faz duas coisas, sem poluir o perfil:

Stories (1080 x 1920), um alerta por story:
  - no máximo STORIES_POR_DIA por dia (padrão 10) e um a cada STORIES_INTERVALO_MIN
    minutos (padrão 80), só entre 8h e 22h de Brasília;
  - só alertas das últimas 6 horas, nunca o mesmo duas vezes;
  - prioridade: promoção no último dia, promoção nova, passagem com menos milhas,
    alternando promoção e passagem quando dá.

Dois carrosséis no feed (1080 x 1350) por dia, de Brasília:
  - às 12h, "Melhores promoções do dia": até 6 promoções das últimas 24 horas;
  - às 19h, "Melhores passagens do dia": até 6 passagens das últimas 24 horas,
    com destinos diferentes;
  - legenda curta com a lista, "link na bio" e hashtags.

Com o segredo ANTHROPIC_API_KEY, o Claude escreve a chamada de cada imagem e a
legenda do carrossel (só com os números que estão nos alertas; o que não passar
na conferência volta para os textos fixos).

O story não tem legenda nem link: o texto vai desenhado na imagem, com o botão
"LINK NA BIO". As imagens ficam em stories/ no repositório (o Instagram baixa de
lá) e só as mais recentes são mantidas.

A chave do Instagram (token de Instagram Login, vale 60 dias) é renovada
sozinha uma vez por semana. Como a Meta pode devolver uma chave nova, ela é
gravada de volta no segredo INSTAGRAM_TOKEN; para isso o segredo GH_SEGREDOS
precisa ter um token do GitHub com permissão de escrever segredos neste
repositório. Sem INSTAGRAM_TOKEN e INSTAGRAM_ID, não faz nada.

Para ver as imagens sem publicar: python ferramentas/instagram.py --teste PASTA
"""
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont

RAIZ = Path(__file__).resolve().parent.parent
ALERTAS = RAIZ / 'dados' / 'alertas.json'
ESTADO = RAIZ / 'dados' / 'stories.json'
PASTA = RAIZ / 'stories'
LOGO = RAIZ / 'logo.jpeg'
REPO = os.environ.get('GITHUB_REPOSITORY', 'ondeasmilhasmelevam/ondeasmilhasmelevam.github.io')
GRAPH = 'https://graph.instagram.com/v21.0'

POR_DIA = int(os.environ.get('STORIES_POR_DIA') or 10)
INTERVALO_MIN = int(os.environ.get('STORIES_INTERVALO_MIN') or 80)
HORAS_FRESCO = 6
HORARIO = (8, 22)
CARROSSEIS = (('promocao', 12), ('passagem', 19))  # tipo e hora de Brasília
POR_CARROSSEL = 6
RENOVAR_DIAS = 7
BRASILIA = timezone(timedelta(hours=-3))
HASHTAGS = '#milhas #milhasaereas #pontos #passagensaereas #viagem #viajarbarato #ondeasmilhasmelevam'

# Cores do site (estilo.css).
INK, INK3, LINHA = '#070C17', '#131D33', '#1E2A42'
RICE, ASH, OURO, OURO_LT, VERMELHO = '#F3EEE3', '#A3ACBD', '#E2B458', '#F5D788', '#FF6B5E'
W = 1080
PERFIL = '@ondeasmilhasmelevam'
# Altura da imagem, onde fica a marca, o espaço do miolo e o botão "LINK NA BIO".
STORY = {'alto': 1920, 'marca': 120, 'miolo': (490, 1500), 'botao': 1570}
FEED = {'alto': 1350, 'marca': 50, 'miolo': (330, 1010), 'botao': 1040, 'compacto': True}

FONTES = Path(__file__).resolve().parent / 'fontes'
_cache = {}


def fonte(tam, peso=800, familia='Manrope'):
    """Fontes do site: Cinzel na marca, Manrope no resto (com o peso pedido)."""
    chave = (tam, peso, familia)
    if chave not in _cache:
        arq = FONTES / f'{familia}.ttf'
        if arq.exists():
            f = ImageFont.truetype(str(arq), tam)
            f.set_variation_by_axes([peso])
        else:
            f = ImageFont.load_default(tam)
        _cache[chave] = f
    return _cache[chave]


def simbolo(tam):
    """Fonte com o desenho do avião (✈); a Manrope não tem."""
    for p in ('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/DejaVuSans-Bold.ttf',
              'C:/Windows/Fonts/seguisym.ttf'):
        if Path(p).exists():
            return ImageFont.truetype(p, tam)
    return None


def quebrar(d, texto, f, largura, max_linhas=None):
    """Quebra o texto em linhas que cabem na largura; corta com reticências."""
    linhas, atual = [], ''
    for palavra in texto.split():
        teste = f'{atual} {palavra}'.strip()
        if d.textlength(teste, font=f) <= largura:
            atual = teste
        else:
            if atual:
                linhas.append(atual)
            atual = palavra
    if atual:
        linhas.append(atual)
    if max_linhas and len(linhas) > max_linhas:
        linhas = linhas[:max_linhas]
        while linhas[-1] and d.textlength(linhas[-1] + '…', font=f) > largura:
            linhas[-1] = linhas[-1].rsplit(' ', 1)[0]
        linhas[-1] += '…'
    return linhas


def espacado(d, xy, texto, f, cor, espaco, ancora='centro'):
    """Texto com espaço entre as letras (a marca em Cinzel pede isso)."""
    larg = sum(d.textlength(c, font=f) for c in texto) + espaco * (len(texto) - 1)
    x, y = xy
    if ancora == 'centro':
        x -= larg / 2
    for c in texto:
        d.text((x, y), c, font=f, fill=cor)
        x += d.textlength(c, font=f) + espaco
    return larg


def centro(d, y, linhas, f, cor, entre=1.12):
    for l in linhas:
        d.text(((W - d.textlength(l, font=f)) / 2, y), l, font=f, fill=cor)
        y += int(f.size * entre)
    return y


def pilula(d, y, texto, fundo, cor=INK, tam=30, x=None, contorno=None):
    """Etiqueta arredondada; centrada se x não for dado. Devolve (y do fim, x do fim)."""
    f = fonte(tam, 800)
    w = d.textlength(texto, font=f) + tam * 1.6
    h = tam * 2
    x = (W - w) / 2 if x is None else x
    d.rounded_rectangle((x, y, x + w, y + h), radius=h / 2, fill=fundo, outline=contorno, width=3 if contorno else 0)
    d.text((x + tam * 0.8, y + (h - tam) / 2 - tam * 0.12), texto, font=f, fill=cor)
    return y + h, x + w


def brilho(img, centro_xy, raio, cor, forca=110):
    """Halo dourado suave atrás do número principal."""
    camada = Image.new('RGBA', img.size, (0, 0, 0, 0))
    x, y = centro_xy
    ImageDraw.Draw(camada).ellipse((x - raio, y - raio * 0.6, x + raio, y + raio * 0.6), fill=(*cor, forca))
    camada = camada.filter(ImageFilter.GaussianBlur(raio / 2.2))
    img.alpha_composite(camada) if img.mode == 'RGBA' else img.paste(camada, (0, 0), camada)


def fundo(alto):
    """Azul-noite do site com luz dourada no alto e pontos de "mapa" bem discretos."""
    img = Image.new('RGB', (W, alto), INK)
    d = ImageDraw.Draw(img)
    for i in range(alto):
        t = i / alto
        d.line([(0, i), (W, i)], fill=tuple(int(a + (b - a) * t) for a, b in zip((16, 27, 52), (6, 10, 20))))
    luz = Image.new('RGBA', (W, alto), (0, 0, 0, 0))
    ImageDraw.Draw(luz).ellipse((-200, -alto * 0.25, W + 200, alto * 0.3), fill=(226, 180, 88, 38))
    luz = luz.filter(ImageFilter.GaussianBlur(160))
    img.paste(luz, (0, 0), luz)
    pontos = Image.new('RGBA', (W, alto), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pontos)
    for yy in range(40, alto, 46):
        for xx in range(30 + (yy // 46 % 2) * 23, W, 46):
            pd.ellipse((xx - 2, yy - 2, xx + 2, yy + 2), fill=(243, 238, 227, 14))
    img.paste(pontos, (0, 0), pontos)
    return img


def marca(img, y, compacto=False):
    """Logo e o nome da marca centrados, em Cinzel dourado com espaçamento."""
    d = ImageDraw.Draw(img)
    lado = 120 if compacto else 160
    if LOGO.exists():
        logo = Image.open(LOGO).convert('RGB').resize((lado, lado), Image.LANCZOS)
        mascara = Image.new('L', (lado, lado), 0)
        ImageDraw.Draw(mascara).ellipse((0, 0, lado, lado), fill=255)
        d.ellipse(((W - lado) / 2 - 6, y - 6, (W + lado) / 2 + 6, y + lado + 6), outline=OURO, width=3)
        img.paste(logo, ((W - lado) // 2, y), mascara)
    y += lado + (22 if compacto else 34)
    tam = 40 if compacto else 50
    espacado(d, (W / 2, y), 'ONDE AS MILHAS', fonte(tam, 800, 'Cinzel'), RICE, tam * 0.16)
    y += int(tam * 1.18)
    espacado(d, (W / 2, y), 'ME LEVAM', fonte(tam, 900, 'Cinzel'), OURO, tam * 0.3)
    y += int(tam * 1.3) + 10
    # filete dourado com losango no meio
    d.line((W / 2 - 160, y, W / 2 - 18, y), fill=OURO, width=2)
    d.line((W / 2 + 18, y, W / 2 + 160, y), fill=OURO, width=2)
    d.polygon([(W / 2, y - 9), (W / 2 + 9, y), (W / 2, y + 9), (W / 2 - 9, y)], fill=OURO)


def botao(img, y):
    """Botão "LINK NA BIO" em dourado claro com brilho, seta para cima e o @ do perfil."""
    caixa = (150, y, W - 150, y + 160)
    halo = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(halo).rounded_rectangle(caixa, radius=80, fill=(245, 215, 136, 170))
    halo = halo.filter(ImageFilter.GaussianBlur(40))
    img.paste(halo, (0, 0), halo)
    faixa = Image.new('RGB', (caixa[2] - caixa[0], caixa[3] - caixa[1]))
    fd = ImageDraw.Draw(faixa)
    for i in range(faixa.height):
        t = i / faixa.height
        fd.line([(0, i), (faixa.width, i)], fill=tuple(int(a + (b - a) * t) for a, b in zip((252, 230, 168), (222, 172, 78))))
    mascara = Image.new('L', faixa.size, 0)
    ImageDraw.Draw(mascara).rounded_rectangle((0, 0, faixa.width - 1, faixa.height - 1), radius=80, fill=255)
    img.paste(faixa, caixa[:2], mascara)
    d = ImageDraw.Draw(img)
    f = fonte(66, 800)
    t = 'LINK NA BIO'
    larg = d.textlength(t, font=f)
    x = (W - larg - 64) / 2
    # seta para cima, desenhada (a bio fica no alto do perfil)
    sx, sy = x + 18, y + 80
    d.polygon([(sx, sy - 30), (sx + 22, sy - 4), (sx + 8, sy - 4), (sx + 8, sy + 28), (sx - 8, sy + 28),
               (sx - 8, sy - 4), (sx - 22, sy - 4)], fill=INK)
    d.text((x + 64, y + 38), t, font=f, fill=INK)
    centro(d, y + 190, [PERFIL], fonte(34, 700), OURO_LT)
    centro(d, y + 240, ['Valores podem mudar a qualquer momento.'], fonte(24, 500), ASH)


def montar(miolo, fmt, cartao=True):
    """Fundo, marca, o miolo centrado no espaço livre e o botão."""
    img = fundo(fmt['alto'])
    marca(img, fmt['marca'], fmt.get('compacto'))
    caixa = miolo.getchannel('A').point(lambda v: 255 if v > 90 else 0).getbbox()  # só o conteúdo, sem o halo
    if caixa:
        topo, fim = fmt['miolo']
        # cartão de vidro com fio dourado em volta da oferta; ela cresce para ocupar o espaço livre
        folga = 64 if cartao else 0
        larg, alt = caixa[2] - caixa[0], caixa[3] - caixa[1]
        k = min((fim - topo - 2 * folga) / alt, (W - 140 - 2 * folga) / larg, 1.25)
        miolo = miolo.resize((int(miolo.width * k), int(miolo.height * k)), Image.LANCZOS)
        y = topo + (fim - topo - int(alt * k)) // 2
        if cartao:  # a passagem já vem desenhada como bilhete
            vidro = Image.new('RGBA', img.size, (0, 0, 0, 0))
            ImageDraw.Draw(vidro).rounded_rectangle((70, y - folga, W - 70, y + int(alt * k) + folga), radius=48,
                                                    fill=(255, 255, 255, 12), outline=(226, 180, 88, 90), width=2)
            img.paste(vidro, (0, 0), vidro)
        # cola a camada inteira (com o halo), alinhando o conteúdo no centro
        img.alpha_composite(miolo, (int(W / 2 - (caixa[0] + larg / 2) * k), int(y - caixa[1] * k)))             if img.mode == 'RGBA' else img.paste(miolo, (int(W / 2 - (caixa[0] + larg / 2) * k), int(y - caixa[1] * k)), miolo)
    botao(img, fmt['botao'])
    return img


def tela():
    camada = Image.new('RGBA', (W, 1700), (0, 0, 0, 0))
    return camada, ImageDraw.Draw(camada)


def milhas(txt):
    n = re.search(r'([\d.]+)\s*milhas', txt or '', re.I)
    return int(n.group(1).replace('.', '')) if n else 10 ** 9


def numero(m):
    return f'{m:,}'.replace(',', '.')


# Termômetro de milhas (dados/termometro.json), o mesmo da página do site.
TERMO = None
BONS = ('espetacular', 'muito bom', 'bom')
BR = set('GRU GIG CGH SDU BSB CNF PLU VCP POA REC FOR SSA CWB FLN BEL MAO NAT MCZ VIX GYN CGB JPA AJU THE SLZ PMW '
         'CGR IGU NVT PVH MCP BVB RBR UDI LDB MGF JOI IOS BPS JDO CPV CXJ PNZ STM IMP RAO SJP'.split())


def programa_termo(p):
    t = (p or '').upper()
    for chave, padrao in (('LATAM', r'LATAM'), ('Smiles', r'SMILES|GOL'), ('Azul', r'AZUL'),
                          ('Avios', r'IBERIA|AVIOS|BRITISH|QATAR|PRIVILEGE'), ('TAP', r'TAP|MILES&GO'),
                          ('Virgin', r'VIRGIN'), ('Connectmiles', r'CONNECT|COPA'), ('Suma', r'SUMA|AIR EUROPA'), ('AA', r'AADVANTAGE|AMERICAN')):
        if re.search(padrao, t):
            return chave
    return ''


def nivel(a):
    # Faixa do termômetro da passagem ('muito bom', 'caro'...) ou ''.
    global TERMO
    if TERMO is None:
        TERMO = ler_json(RAIZ / 'dados' / 'termometro.json', {})
    if a.get('tipo') == 'promocao' or a.get('origem_iata') not in BR:
        return ''
    regiao = next((r for r in TERMO.get('regioes', []) if a.get('destino_iata') in r.get('aeroportos', [])), None)
    exe = re.search(r'execut|primeira|first|business|premium', a.get('cabine') or '', re.I)
    faixas = regiao and regiao['cabines'].get('exe' if exe else 'eco')
    prog = programa_termo(a.get('programa'))
    m = re.search(r'([\d.]+)\s*(?:milhas|pontos|avios)', a.get('ida') or '', re.I)
    if not faixas or not prog or not m:
        return ''
    qtd = int(m.group(1).replace('.', ''))
    com = [n for n in TERMO['niveis'] if prog in faixas.get(n, {})]
    achou = next((n for n in com if qtd <= faixas[n][prog]), '')
    return achou or ('péssimo' if com and com[-1] == 'péssimo' else '')


def chamada_padrao(a):
    if a.get('tipo') == 'promocao':
        return 'ÚLTIMO DIA!' if a.get('ultimo_dia') else 'PROMOÇÃO NO AR'
    n = nivel(a)
    if n in BONS:
        return f'{n.upper()} NO TERMÔMETRO'
    return 'PASSAGEM COM MILHAS' if n else 'PASSAGEM BARATA'


def miolo_passagem(a, chamada=''):
    """Cartão de embarque: IATA grande, rota tracejada com avião e as milhas em destaque."""
    camada, d = tela()
    y, _ = pilula(d, 0, (chamada or chamada_padrao(a)).upper(), OURO)
    y += 60
    # cartão
    topo = y
    d.rounded_rectangle((70, topo, W - 70, topo + 900), radius=44, fill=(19, 29, 51, 235), outline=OURO, width=3)
    for cx in (70, W - 70):  # recortes laterais do bilhete
        d.ellipse((cx - 34, topo + 420 - 34, cx + 34, topo + 420 + 34), fill=(0, 0, 0, 0))
    for xx in range(130, W - 130, 34):  # picote
        d.line((xx, topo + 420, xx + 16, topo + 420), fill=(163, 172, 189, 120), width=3)
    fi = fonte(140, 800)
    o, de = a.get('origem_iata', ''), a.get('destino_iata', '')
    d.text((130, topo + 70), o, font=fi, fill=RICE)
    d.text((W - 130 - d.textlength(de, font=fi), topo + 70), de, font=fi, fill=RICE)
    # rota tracejada com o avião no meio
    x1, x2, ym = 130 + d.textlength(o, font=fi) + 30, W - 130 - d.textlength(de, font=fi) - 30, topo + 160
    for xx in range(int(x1), int(x2), 22):
        d.line((xx, ym, min(xx + 11, x2), ym), fill=OURO, width=4)
    fs = simbolo(70)
    if fs:
        d.rectangle(((x1 + x2) / 2 - 46, ym - 40, (x1 + x2) / 2 + 46, ym + 40), fill=(19, 29, 51, 255))
        d.text(((x1 + x2) / 2 - d.textlength('✈', font=fs) / 2, ym - 44), '✈', font=fs, fill=OURO)
    fc = fonte(36, 600)
    no = quebrar(d, a['origem'], fc, 380, 2)
    nd = quebrar(d, a['destino'], fc, 380, 2)
    for i, l in enumerate(no):
        d.text((130, topo + 255 + i * 44), l, font=fc, fill=ASH)
    for i, l in enumerate(nd):
        d.text((W - 130 - d.textlength(l, font=fc), topo + 255 + i * 44), l, font=fc, fill=ASH)
    # milhas
    m = milhas(a.get('ida'))
    yy = topo + 470
    if m < 10 ** 9:
        yy = centro(d, yy, ['A PARTIR DE'], fonte(30, 800), ASH) + 4
        f = fonte(170, 800)
        brilho(camada, (W / 2, yy + 100), 300, (226, 180, 88), 70)
        d = ImageDraw.Draw(camada)
        yy = centro(d, yy, [numero(m)], f, OURO, 1.08)
        yy = centro(d, yy + 6, ['milhas + taxas · trecho'], fonte(38, 700), OURO_LT)
    fichas = [x for x in (a.get('programa'), a.get('cabine')) if x]
    if fichas:
        fp = fonte(30, 700)
        larg = sum(d.textlength(x, font=fp) + 56 for x in fichas) + 20 * (len(fichas) - 1)
        x = (W - larg) / 2
        for t in fichas:
            _, x = pilula(d, yy + 40, t, (0, 0, 0, 0), RICE, 30, x, contorno=LINHA)
            x += 20
    return camada


def destaque(titulo):
    """O número que chama atenção no título: '96.000 PONTOS', '100%', '27.500 MILHAS'."""
    m = re.search(r'(\d+\s*%)', titulo) or re.search(r'([\d.]{4,}\s*(?:MILHAS|PONTOS|AVIOS))', titulo, re.I)
    return m.group(1).upper() if m else ''


def miolo_promocao(a, chamada=''):
    """Chamada, o número com brilho, o título curto e a validade."""
    camada, d = tela()
    ultimo = a.get('ultimo_dia')
    y, _ = pilula(d, 0, (chamada or chamada_padrao(a)).upper(), VERMELHO if ultimo else OURO,
                  RICE if ultimo else INK)
    y += 80
    titulo = a['titulo'].upper()
    num = destaque(titulo)
    if num:
        # "COM ATÉ 75% DE DESCONTO" vira "até" + "75%" em destaque + "... COM DESCONTO".
        antes = re.search(r'(ATÉ|A PARTIR DE)\s+' + re.escape(num), titulo)
        if antes:
            y = centro(d, y, [antes.group(1)], fonte(36, 800), ASH)
        partes = num.split()
        brilho(camada, (W / 2, y + 120), 360, (226, 180, 88), 80)
        d = ImageDraw.Draw(camada)
        f = fonte(210 if len(partes[0]) <= 4 else 170, 800)
        y = centro(d, y - 10, [partes[0]], f, OURO, 1.1)
        if len(partes) > 1:
            y = centro(d, y, [' '.join(partes[1:])], fonte(64, 800), OURO_LT, 1.1)
        y += 40
        titulo = re.sub(r'(\s+DE)?\s+((ATÉ|A PARTIR DE)\s+)?' + re.escape(num) + r'(\s+DE\b)?', ' ', ' ' + titulo)
        if titulo.count('BÔNUS') > 1:
            titulo = re.sub(r'\s+COM BÔNUS\s*$', '', titulo)
        titulo = re.sub(r'\s+', ' ', titulo).strip(' -–:,')
    f = fonte(58, 800)
    y = centro(d, y, quebrar(d, titulo, f, W - 180, 4), f, RICE, 1.15)
    if a.get('ate'):
        pilula(d, y + 50, 'VALE ATÉ ' + datetime.fromisoformat(a['ate']).strftime('%d/%m'), (0, 0, 0, 0),
               OURO_LT, 30, contorno=OURO)
    return camada


def miolo_capa(dia, n, tipo):
    camada, d = tela()
    y, _ = pilula(d, 0, dia.strftime('%d/%m') + ' · HOJE', OURO)
    y = centro(d, y + 80, ['AS MELHORES'], fonte(70, 800), ASH)
    brilho(camada, (W / 2, y + 160), 380, (226, 180, 88), 70)
    d = ImageDraw.Draw(camada)
    promo = tipo == 'promocao'
    y = centro(d, y, ['PROMOÇÕES' if promo else 'PASSAGENS'], fonte(118, 800), RICE, 1.05)
    y = centro(d, y, ['DO DIA'], fonte(150, 800), OURO, 1.08)
    sub = f'{n} promoções de milhas e pontos' if promo else f'{n} passagens com milhas'
    y = centro(d, y + 40, [sub], fonte(40, 600), RICE)
    centro(d, y + 60, ['ARRASTE PARA O LADO  →'], fonte(38, 800), OURO_LT)
    return camada


def imagem(a, fmt, chamada=''):
    feito = miolo_promocao if a.get('tipo') == 'promocao' else miolo_passagem
    return montar(feito(a, chamada), fmt, a.get('tipo') == 'promocao')


def ler_json(p, padrao):
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return padrao


def quando(a):
    return datetime.fromisoformat(a['data'].replace('Z', '+00:00'))


def separar(alertas):
    """Promoções (último dia na frente, depois as mais novas) e passagens (menos milhas primeiro)."""
    promos = sorted((a for a in alertas if a.get('tipo') == 'promocao'), key=lambda a: a['data'], reverse=True)
    promos.sort(key=lambda a: not a.get('ultimo_dia'))
    passagens = sorted((a for a in alertas if a.get('tipo') != 'promocao'),
                       key=lambda a: (BONS.index(nivel(a)) if nivel(a) in BONS else 9,
                                      milhas(a.get('ida')) + milhas(a.get('volta'))))
    return promos, passagens


def escolher(alertas, estado, agora):
    postados = set(estado.get('postados', []))
    # Passagem cara ou péssima pelo termômetro não vira story.
    novos = [a for a in alertas if a['id'] not in postados and quando(a) >= agora - timedelta(hours=HORAS_FRESCO)
             and nivel(a) not in ('caro', 'péssimo')]
    promos, passagens = separar(novos)
    ordem = [passagens, promos] if estado.get('ultimo_tipo') == 'promocao' else [promos, passagens]
    return next((lista[0] for lista in ordem if lista), None)


def escolher_carrossel(alertas, agora, tipo):
    promos, passagens = separar([a for a in alertas if quando(a) >= agora - timedelta(hours=24)])
    if tipo == 'promocao':
        return promos[:POR_CARROSSEL]
    destinos, viagens = set(), []
    for a in passagens:
        if a['destino'] not in destinos and nivel(a) not in ('caro', 'péssimo'):
            destinos.add(a['destino'])
            viagens.append(a)
    return viagens[:POR_CARROSSEL]


PEQUENAS = {'a', 'à', 'ao', 'até', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'no', 'o', 'ou', 'para', 'por'}


def titulo_legivel(t):
    """'COMPRA DE MILHAS SMILES COM 75% DE DESCONTO' → 'Compra de Milhas Smiles com 75% de Desconto'."""
    palavras = t.lower().split()
    return ' '.join(p if i and p in PEQUENAS else p[:1].upper() + p[1:] for i, p in enumerate(palavras))


def legenda(itens, dia, tipo):
    nome = '💸 Melhores promoções' if tipo == 'promocao' else '✈️ Melhores passagens com milhas'
    linhas = [f"{nome} de hoje ({dia.strftime('%d/%m')})", '']
    for a in itens:
        if a.get('tipo') == 'promocao':
            linhas.append(f"💸 {titulo_legivel(a['titulo'])}")
        else:
            m = milhas(a.get('ida'))
            preco = f" a partir de {m:,} milhas".replace(',', '.') if m < 10 ** 9 else ''
            linhas.append(f"🛫 {a['origem']} → {a['destino']}:{preco} ({a.get('programa', '')})")
    linhas += ['', 'Detalhes e links: link na bio 👆', 'Valores e disponibilidade podem mudar a qualquer momento.', '', HASHTAGS]
    return '\n'.join(linhas)


# Textos com o Claude (opcional): chamada curta de cada imagem e a legenda do carrossel.
# Sem ANTHROPIC_API_KEY, ou se a resposta não passar na conferência, usa os textos fixos.
MODELO = 'claude-opus-5-5'
SISTEMA = """Você escreve para o Instagram @ondeasmilhasmelevam, sobre milhas, pontos e passagens aéreas.
Recebe ofertas em JSON e devolve:
- "chamadas": uma por oferta, na mesma ordem. Cada uma com no máximo 24 caracteres, em maiúsculas, sem números
  e sem emoji, que desperte urgência ou curiosidade (ex.: CORRE QUE ACABA HOJE, PREÇO DE OCASIÃO, ACHADO DO DIA).
  Se a oferta tiver "ultimo_dia": true, a chamada fala que acaba hoje. Se tiver "termometro"
  (espetacular, muito bom ou bom), a chamada pode usar essa faixa (ex.: MUITO BOM NO TERMÔMETRO).
- "legenda": só se "com_legenda" for true (senão, texto vazio). Legenda curta e envolvente para um carrossel:
  uma linha de gancho, depois uma linha por oferta na mesma ordem (começando com um emoji), depois um convite para
  salvar, comentar ou marcar quem viaja junto, e por fim "Link na bio 👆". No máximo 900 caracteres, sem hashtags.
Use só os números, nomes e datas que estão nos dados: nunca invente valores, bônus, datas ou condições.
Português do Brasil, tom animado mas confiável."""


def dados_ia(a):
    campos = ('tipo', 'titulo', 'ultimo_dia', 'validade', 'origem', 'destino', 'companhia', 'cabine', 'programa', 'ida', 'volta')
    d = {k: a[k] for k in campos if a.get(k)}
    if nivel(a) in BONS:
        d['termometro'] = nivel(a)
    return d


def numeros(texto):
    return {re.sub(r'\D', '', n) for n in re.findall(r'\d[\d.,]*', texto)}


def textos_ia(itens, com_legenda=False):
    """{'chamadas': [...], 'legenda': '...'} vindos do Claude, já conferidos; {} se não der."""
    chave = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not chave or not itens:
        return {}
    try:
        import anthropic
    except ImportError:
        return {}
    entrada = {'com_legenda': com_legenda, 'ofertas': [dados_ia(a) for a in itens]}
    esquema = {'type': 'object', 'additionalProperties': False, 'required': ['chamadas', 'legenda'],
               'properties': {'chamadas': {'type': 'array', 'items': {'type': 'string'}}, 'legenda': {'type': 'string'}}}
    cliente = anthropic.Anthropic(api_key=chave, timeout=120)
    try:
        r = cliente.beta.messages.create(
            model=MODELO, max_tokens=4000, system=SISTEMA,
            betas=['server-side-fallback-2026-07-01'], fallbacks='default',
            output_config={'effort': 'low', 'format': {'type': 'json_schema', 'schema': esquema}},
            messages=[{'role': 'user', 'content': json.dumps(entrada, ensure_ascii=False)}])
    except anthropic.APIStatusError as e:
        print(f'::warning::Claude respondeu {e.status_code}; usando os textos fixos.')
        return {}
    except anthropic.APIConnectionError:
        print('::warning::Sem conexão com o Claude; usando os textos fixos.')
        return {}
    if r.stop_reason != 'end_turn':
        return {}
    try:
        saida = json.loads(next(b.text for b in r.content if b.type == 'text'))
    except (StopIteration, ValueError):
        return {}
    # Conferência: nada de número que não esteja nos dados, e chamadas curtas.
    validos = numeros(json.dumps(entrada, ensure_ascii=False))
    chamadas = [c.strip().upper() if len(c.strip()) <= 26 and not re.search(r'\d', c) else ''
                for c in saida.get('chamadas', [])][:len(itens)]
    legenda = saida.get('legenda', '').strip()
    if not com_legenda or len(legenda) > 1200 or not numeros(legenda) <= validos:
        legenda = ''
    return {'chamadas': chamadas + [''] * (len(itens) - len(chamadas)), 'legenda': legenda}


RODAPE_LEGENDA = '\n\nValores e disponibilidade podem mudar a qualquer momento.\n\n' + HASHTAGS


def api(metodo, caminho, **kw):
    return requests.request(metodo, f'{GRAPH}/{caminho}', timeout=60, **kw)


def criar(conta, token, **dados):
    """Cria um container e espera o Instagram terminar de baixar e processar."""
    r = api('POST', f'{conta}/media', data={**dados, 'access_token': token})
    if not r.ok or 'id' not in r.json():
        raise RuntimeError(f'container: {r.status_code} {r.text[:300]}')
    cid = r.json()['id']
    for _ in range(24):
        s = api('GET', cid, params={'fields': 'status_code', 'access_token': token}).json()
        if s.get('status_code') == 'FINISHED':
            return cid
        if s.get('status_code') == 'ERROR':
            raise RuntimeError(f'imagem recusada: {s}')
        time.sleep(5)
    return cid


def publicar(conta, token, cid):
    r = api('POST', f'{conta}/media_publish', data={'creation_id': cid, 'access_token': token})
    if not r.ok or 'id' not in r.json():
        raise RuntimeError(f'publicar: {r.status_code} {r.text[:300]}')
    return r.json()['id']


def renovar(token, estado, agora):
    """Estende a chave por mais 60 dias, uma vez por semana. Devolve a chave em uso."""
    ultima = estado.get('token_renovado')
    if ultima and agora - datetime.fromisoformat(ultima) < timedelta(days=RENOVAR_DIAS):
        return token
    r = requests.get('https://graph.instagram.com/refresh_access_token',
                     params={'grant_type': 'ig_refresh_token', 'access_token': token}, timeout=60)
    dados = r.json() if r.content else {}
    novo = dados.get('access_token')
    if not r.ok or not novo:
        msg = (dados.get('error') or {}).get('message', r.text[:200])
        print(f'::warning::Não renovei a chave do Instagram agora: {msg}')
        return token
    estado['token_renovado'] = agora.isoformat()
    estado['token_vence'] = (agora + timedelta(seconds=int(dados.get('expires_in', 0)))).isoformat()
    if novo != token:
        gravar_segredo(novo)
    print(f"Chave do Instagram renovada; vence em {estado['token_vence'][:10]}.")
    return novo


def gravar_segredo(novo):
    pat = os.environ.get('GH_SEGREDOS', '').strip()
    if not pat:
        print('::warning::A Meta mandou uma chave nova, mas falta o segredo GH_SEGREDOS para guardá-la. '
              'A chave antiga continua valendo até vencer.')
        return
    r = subprocess.run(['gh', 'secret', 'set', 'INSTAGRAM_TOKEN', '--repo', REPO, '--body', novo],
                       env={**os.environ, 'GH_TOKEN': pat}, capture_output=True, text=True)
    if r.returncode:
        print('::warning::Não consegui gravar a chave nova no segredo INSTAGRAM_TOKEN.')


def guardar(estado, msg):
    """Grava dados/stories.json e as imagens no repositório (commit e push)."""
    ESTADO.write_text(json.dumps(estado, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    git = lambda *a: subprocess.run(['git', *a], cwd=RAIZ, capture_output=True, text=True)
    git('add', '-A', 'stories', 'dados/stories.json')
    if not git('diff', '--cached', '--quiet').returncode:
        return True
    git('commit', '-q', '-m', msg)
    if git('pull', '-q', '--rebase').returncode or git('push', '-q').returncode:
        print('::warning::Não deu para enviar as imagens ao repositório agora.')
        return False
    return True


def enviar(imagens, estado, msg):
    """Salva as imagens em stories/ e devolve os endereços públicos (fixos no commit)."""
    PASTA.mkdir(exist_ok=True)
    for f in PASTA.glob('*.jpg'):  # o Instagram já baixou as anteriores
        f.unlink()
    for nome, img in imagens:
        img.save(PASTA / nome, 'JPEG', quality=90)
    if not guardar(estado, msg):
        return []
    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=RAIZ, capture_output=True, text=True).stdout.strip()
    return [f'https://raw.githubusercontent.com/{REPO}/{sha}/stories/{nome}' for nome, _ in imagens]


def story(alertas, estado, agora, conta, token):
    if estado['hoje'] >= POR_DIA:
        return
    ultimo = estado.get('ultimo_em')
    if ultimo and agora - datetime.fromisoformat(ultimo) < timedelta(minutes=INTERVALO_MIN):
        return
    a = escolher(alertas, estado, agora)
    if not a:
        return
    chamada = (textos_ia([a]).get('chamadas') or [''])[0]
    urls = enviar([(f"{a['id']}.jpg", imagem(a, STORY, chamada))], estado, 'Imagem do story')
    if not urls:
        return
    estado.setdefault('postados', []).append(a['id'])
    estado['postados'] = estado['postados'][-500:]
    try:
        publicar(conta, token, criar(conta, token, image_url=urls[0], media_type='STORIES'))
    except Exception as e:
        return print(f'::warning::Story não publicado: {e}')
    estado['hoje'] += 1
    estado['ultimo_em'] = agora.isoformat()
    estado['ultimo_tipo'] = a.get('tipo') or 'passagem'
    print(f"Story publicado: {a.get('titulo') or a['destino']}")


def carrossel(alertas, estado, agora, conta, token, tipo, hora):
    dia = agora.astimezone(BRASILIA)
    chave = f'carrossel_{tipo}_dia'
    if dia.hour < hora or estado.get(chave) == estado['dia']:
        return
    itens = escolher_carrossel(alertas, agora, tipo)
    if len(itens) < 2:
        return
    estado[chave] = estado['dia']  # uma tentativa por dia, mesmo se falhar
    ia = textos_ia(itens, com_legenda=True)
    chamadas = ia.get('chamadas') or [''] * len(itens)
    texto = ia['legenda'] + RODAPE_LEGENDA if ia.get('legenda') else legenda(itens, dia, tipo)
    telas = [(f'feed-{tipo}-0.jpg', montar(miolo_capa(dia, len(itens), tipo), FEED))]
    telas += [(f'feed-{tipo}-{n}.jpg', imagem(a, FEED, c)) for n, (a, c) in enumerate(zip(itens, chamadas), 1)]
    urls = enviar(telas, estado, f'Imagens do carrossel de {tipo} do dia')
    if not urls:
        return
    try:
        filhos = [criar(conta, token, image_url=u, is_carousel_item='true') for u in urls]
        cid = criar(conta, token, media_type='CAROUSEL', children=','.join(filhos), caption=texto)
        publicar(conta, token, cid)
    except Exception as e:
        return print(f'::warning::Carrossel não publicado: {e}')
    print(f'Carrossel de {tipo} publicado com {len(itens)} oportunidades.')


def teste(pasta):
    """Gera stories e os carrosséis de exemplo com os alertas atuais, sem publicar."""
    pasta.mkdir(parents=True, exist_ok=True)
    alertas = ler_json(ALERTAS, [])
    agora = max((quando(a) for a in alertas), default=datetime.now(timezone.utc))
    promos, passagens = separar(alertas)
    for n, a in enumerate(promos[:2] + passagens[:2]):
        imagem(a, STORY).save(pasta / f'story-{n}.jpg', quality=90)
    for tipo, _ in CARROSSEIS:
        itens = escolher_carrossel(alertas, agora, tipo)
        ia = textos_ia(itens, com_legenda=True)
        chamadas = ia.get('chamadas') or [''] * len(itens)
        montar(miolo_capa(agora.astimezone(BRASILIA), len(itens), tipo), FEED).save(pasta / f'feed-{tipo}-0.jpg', quality=90)
        for n, (a, c) in enumerate(zip(itens, chamadas), 1):
            imagem(a, FEED, c).save(pasta / f'feed-{tipo}-{n}.jpg', quality=90)
        texto = ia['legenda'] + RODAPE_LEGENDA if ia.get('legenda') else legenda(itens, agora.astimezone(BRASILIA), tipo)
        (pasta / f'legenda-{tipo}.txt').write_text(texto, encoding='utf-8')
    print(pasta)


def main():
    if '--teste' in sys.argv:
        resto = sys.argv[sys.argv.index('--teste') + 1:]
        return teste(Path(resto[0]) if resto else PASTA)
    token = re.sub(r'\s+', '', os.environ.get('INSTAGRAM_TOKEN', ''))
    conta = re.sub(r'\s+', '', os.environ.get('INSTAGRAM_ID', ''))
    if not token or not conta:
        return print('::notice::Instagram ainda não ligado (faltam INSTAGRAM_TOKEN e INSTAGRAM_ID); nada a fazer.')
    agora = datetime.now(timezone.utc)
    estado = ler_json(ESTADO, {})
    hoje = agora.astimezone(BRASILIA).date().isoformat()
    if estado.get('dia') != hoje:
        estado.update(dia=hoje, hoje=0)
    token = renovar(token, estado, agora)
    if HORARIO[0] <= agora.astimezone(BRASILIA).hour < HORARIO[1]:
        alertas = ler_json(ALERTAS, [])
        for tipo, hora in CARROSSEIS:
            carrossel(alertas, estado, agora, conta, token, tipo, hora)
        story(alertas, estado, agora, conta, token)
    guardar(estado, 'Instagram: controle atualizado')


if __name__ == '__main__':
    main()
