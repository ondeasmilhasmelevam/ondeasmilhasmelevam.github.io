"""Publica no Instagram os melhores alertas de dados/alertas.json.

Roda dentro do plantão dos alertas (ver .github/workflows/alertas.yml), logo
depois de cada leitura do Telegram. Faz duas coisas, sem poluir o perfil:

Stories (1080 x 1920), um alerta por story, em lotes de até 5:
  - às 8h, 12h, 16h, 20h e 21h30 de Brasília (a última pega a liberação de
    Avios das 21h);
  - só alertas das últimas 12 horas, nunca o mesmo duas vezes;
  - prioridade: promoção no último dia, promoção nova, passagem com menos milhas,
    alternando promoção e passagem quando dá.

Carrossel de promoções no feed (1080 x 1350), um em cada horário (manhã 9h,
tarde 14h e noite 19h de Brasília), até 6 promoções. Passagem não vai para o
feed, só para os stories (pedido do Felipe).
  - só alertas das últimas 24 horas que ainda não foram para o feed no dia, para
    a sequência não repetir;
  - legenda curta com a lista, "link na bio" e hashtags.

Como no site, a passagem leva no alto a foto da cidade de origem e a da de
destino, divididas por um fio dourado (Wikimedia Commons), e a promoção leva a
logo do programa que está fazendo a promoção (img/programas).

Com o segredo ANTHROPIC_API_KEY, o Claude escreve a chamada de cada imagem e a
legenda do carrossel (só com os números que estão nos alertas; o que não passar
na conferência volta para os textos fixos).

O story não tem legenda nem link: o texto vai desenhado na imagem, com o botão
"LINK NA BIO". Cada story vai como vídeo de 12 s: a imagem parada com uma das
trilhas de musicas/ (trechos de 12 s das partes mais fortes de "Midnight Pulse",
música do Felipe feita no Suno). Sem ffmpeg, ou se o vídeo falhar, vai a imagem. As imagens e vídeos
ficam em stories/ no repositório (o Instagram baixa de lá; o vídeo pelo GitHub
Pages) e só os mais recentes são mantidos.

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

import hashlib
import unicodedata
from io import BytesIO

import requests
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

RAIZ = Path(__file__).resolve().parent.parent
ALERTAS = RAIZ / 'dados' / 'alertas-completo.json'  # a lista inteira, com datas (ferramentas/alertas.py)
ESTADO = RAIZ / 'dados' / 'stories.json'
PASTA = RAIZ / 'stories'
MUSICAS = RAIZ / 'musicas'
SITE = 'https://ondeasmilhasmelevam.com.br'
LOGO = RAIZ / 'logo.jpeg'
REPO = os.environ.get('GITHUB_REPOSITORY', 'ondeasmilhasmelevam/ondeasmilhasmelevam.github.io')
GRAPH = 'https://graph.instagram.com/v21.0'

LOTES_STORIES = ((8, 0), (12, 0), (16, 0), (20, 0), (21, 30))  # hora e minuto de Brasília
POR_LOTE = int(os.environ.get('STORIES_POR_LOTE') or 5)
HORAS_FRESCO = 12
HORARIO = (8, 22)
FEED = (('manhã', 9, 0), ('tarde', 14, 0), ('noite', 19, 0))
TIPOS_FEED = ('promocao',)
POR_CARROSSEL = 6
RENOVAR_DIAS = 7
BRASILIA = timezone(timedelta(hours=-3))
HASHTAGS = '#milhas #milhasaereas #pontos #passagensaereas #viagem #viajarbarato #ondeasmilhasmelevam'

# Cores do site (estilo.css).
INK, INK3, LINHA = '#070C17', '#131D33', '#1E2A42'
RICE, ASH, OURO, OURO_LT, VERMELHO = '#F3EEE3', '#A3ACBD', '#E2B458', '#F5D788', '#FF6B5E'
W = 1080
PERFIL = '@ondeasmilhasmelevam'
DOMINIO = 'ondeasmilhasmelevam.com.br'
# Altura da imagem, onde fica a marca, o espaço do miolo e o botão "LINK NA BIO".
STORY = {'alto': 1920, 'marca': 120, 'miolo': (490, 1500), 'botao': 1570}
FMT_FEED = {'alto': 1350, 'marca': 50, 'miolo': (330, 1010), 'botao': 1040, 'compacto': True}

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


# Convite do ManyChat em cada post e story: quem manda a palavra no direct (ou responde o story com ela)
# recebe o link na hora. No plano grátis do ManyChat, palavra no direct funciona em todos os posts.
PALAVRA = {'promocao': 'PROMO', 'passagem': 'ALERTA'}


def cta_tipo(tipo):
    return PALAVRA['promocao' if tipo == 'promocao' else 'passagem']


def botao(img, y, palavra=None, story=False):
    """Botão dourado com brilho: o convite do ManyChat ("MANDE PROMO NO DIRECT") ou, sem palavra, "LINK NA BIO"."""
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
    if palavra:
        t = f'RESPONDA {palavra}' if story else f'MANDE {palavra} NO DIRECT'
        tam = 66
        while d.textlength(t, font=fonte(tam, 800)) > caixa[2] - caixa[0] - 150 and tam > 36:
            tam -= 2
        f = fonte(tam, 800)
        larg = d.textlength(t, font=f)
        x = (W - larg - 70) / 2
        # balão de conversa, desenhado
        bx, by = x + 22, y + 80
        d.rounded_rectangle((bx - 24, by - 22, bx + 24, by + 14), radius=10, fill=INK)
        d.polygon([(bx - 12, by + 12), (bx - 18, by + 28), (bx + 2, by + 12)], fill=INK)
        d.text((x + 70, y + 80 - tam * 0.62), t, font=f, fill=INK)
        sub = 'neste story e receba o link na hora' if story else 'e receba o link na hora'
        centro(d, y + 190, [f'{sub}  ·  {DOMINIO}'], fonte(32, 700), OURO_LT)
    else:
        f = fonte(66, 800)
        t = 'LINK NA BIO'
        larg = d.textlength(t, font=f)
        x = (W - larg - 64) / 2
        # seta para cima, desenhada (a bio fica no alto do perfil)
        sx, sy = x + 18, y + 80
        d.polygon([(sx, sy - 30), (sx + 22, sy - 4), (sx + 8, sy - 4), (sx + 8, sy + 28), (sx - 8, sy + 28),
                   (sx - 8, sy - 4), (sx - 22, sy - 4)], fill=INK)
        d.text((x + 64, y + 38), t, font=f, fill=INK)
        centro(d, y + 190, [f'{PERFIL}  ·  {DOMINIO}'], fonte(34, 700), OURO_LT)
    centro(d, y + 240, ['Valores podem mudar a qualquer momento.'], fonte(24, 500), ASH)


def montar(miolo, fmt, cartao=True, palavra=None):
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
    botao(img, fmt['botao'], palavra, fmt is STORY)
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
         'CGR IGU NVT PVH MCP BVB RBR UDI LDB MGF JOI IOS BPS JDO CPV CXJ PNZ STM IMP RAO SJP '
         'ATM BRA BYO CAC XAP JDF OPS PET CFB CKS AUX PFB GPB FEN MOC VDC IPN UNA TFF CZS ROO JTC'.split())


def programa_termo(p):
    t = (p or '').upper()
    for chave, padrao in (('LATAM', r'LATAM'), ('Smiles', r'SMILES|GOL'), ('Azul', r'AZUL'),
                          ('Avios', r'IBERIA|AVIOS|BRITISH|QATAR|PRIVILEGE'), ('TAP', r'TAP|MILES&GO'),
                          ('Virgin', r'VIRGIN'), ('Connectmiles', r'CONNECT|COPA'), ('Suma', r'SUMA|AIR EUROPA'), ('AA', r'AADVANTAGE|AMERICAN')):
        if re.search(padrao, t):
            return chave
    return ''


def termometro():
    global TERMO
    if TERMO is None:
        TERMO = ler_json(RAIZ / 'dados' / 'termometro.json', {})
    return TERMO


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


# Programa da promoção e a logo dele (as mesmas do site: PROGRAMAS_PROMO e LOGO_PROGRAMA no app.js).
PROGRAMAS = (('Smiles', r'SMILES|\bGOL\b|PAGOL', 'smiles'), ('LATAM Pass', r'LATAM', 'latam'), ('Azul', r'AZUL', 'azul'),
             ('Livelo', r'LIVELO', 'livelo'), ('Esfera', r'ESFERA', 'esfera'), ('TAP', r'\bTAP\b', 'tap'),
             ('ALL Accor', r'ACCOR|ALL SIGNATURE|LIMITLESS', 'accor'), ('Avios', r'IBERIA|AVIOS|BRITISH|QATAR', 'avios'),
             ('Flying Blue', r'FLYING BLUE|AIR FRANCE|KLM', 'flyingblue'), ('C6', r'\bC6\b|ATOMOS', 'c6'), ('Itaú', r'ITAU', 'itau'),
             ('Revolut', r'REVOLUT', 'revolut'), ('Premmia', r'PREMMIA', 'premmia'), ('Inter', r'\bINTER\b', 'inter'),
             ('Méliuz', r'MELIUZ', 'meliuz'))
ENCURTADORES = re.compile(r'bit\.ly|tinyurl|t\.co$|l\.ead\.me|linktr\.ee|onelink|app\.link|lnk\.|cutt\.ly|rebrand\.ly|wa\.me|t\.me|dia23')
UA = {'User-Agent': 'OndeAsMilhasMeLevam/1.0 (https://ondeasmilhasmelevam.com.br; instagram)'}


def sem_acento(t):
    return ''.join(c for c in unicodedata.normalize('NFD', t or '') if unicodedata.category(c) != 'Mn').upper()


def logo_promo(a):
    """(logo RGBA ou None, nome do programa ou do parceiro, se é só o ícone do site do parceiro)."""
    t = sem_acento(f"{a.get('titulo', '')} {a.get('parceiros', '')}")
    for nome, padrao, arq in PROGRAMAS:
        if re.search(padrao, t):
            caminho = RAIZ / 'img' / 'programas' / f'{arq}.webp'
            return (Image.open(caminho).convert('RGBA') if caminho.exists() else None), nome, False
    nome = re.split(r',| e | & ', a.get('parceiros') or '')[0].strip()
    # Parceiro sem logo guardada: o ícone do site dele (como no site), se o link não for encurtado.
    for u in a.get('links') or []:
        m = re.match(r'https?://(?:www\.)?([^/]+)', u or '')
        if m and not ENCURTADORES.search(m.group(1)):
            try:
                r = requests.get('https://www.google.com/s2/favicons', params={'domain': m.group(1), 'sz': 128}, timeout=20)
                ico = Image.open(BytesIO(r.content)).convert('RGBA') if r.ok else None
                if ico and ico.width >= 64:
                    return ico, nome, True
            except Exception:
                pass
            break
    return None, nome, False


def ticket_logo(camada, y, a):
    """Bilhete branco com a logo do programa e recortes dos lados (o "ticket" das promoções do site)."""
    logo, nome, icone = logo_promo(a)
    if logo is None and not nome:
        return y
    lw, lh = 600, 230
    x0 = (W - lw) // 2
    sombra = Image.new('RGBA', camada.size, (0, 0, 0, 0))
    ImageDraw.Draw(sombra).rounded_rectangle((x0, y + 18, x0 + lw, y + lh + 18), radius=34, fill=(0, 0, 0, 120))
    camada.alpha_composite(sombra.filter(ImageFilter.GaussianBlur(22)))
    d = ImageDraw.Draw(camada)
    d.rounded_rectangle((x0, y, x0 + lw, y + lh), radius=34, fill=(255, 255, 255, 255))
    for cx in (x0, x0 + lw):
        d.ellipse((cx - 26, y + lh / 2 - 26, cx + 26, y + lh / 2 + 26), fill=(0, 0, 0, 0))
    if logo is not None:
        com_nome = icone and nome
        k = min((lw - 140) / logo.width, (lh - (120 if com_nome else 70)) / logo.height)
        logo = logo.resize((max(1, int(logo.width * k)), max(1, int(logo.height * k))), Image.LANCZOS)
        topo = y + (lh - logo.height - (56 if com_nome else 0)) // 2
        camada.alpha_composite(logo, ((W - logo.width) // 2, int(topo)))
        if com_nome:
            f = fonte(40, 800)
            nome = quebrar(d, nome, f, lw - 100, 1)[0]
            d.text(((W - d.textlength(nome, font=f)) / 2, topo + logo.height + 10), nome, font=f, fill=INK)
    else:
        f = fonte(64, 800)
        linhas = quebrar(d, nome.upper(), f, lw - 120, 2)
        centro(d, y + (lh - len(linhas) * int(f.size * 1.1)) / 2, linhas, f, INK, 1.1)
    return y + lh


# Fotos das cidades (a mesma busca do site: Wikidata pelo código do aeroporto e Wikimedia Commons).
UF = {}
for _uf, _codigos in {
        'São Paulo': 'GRU CGH VCP SJP RAO PPB MII SJK BAU AQA SOD', 'Rio de Janeiro': 'GIG SDU CAW MEA',
        'Minas Gerais': 'CNF PLU UDI MOC IPN GVR VAG JDF', 'Espírito Santo': 'VIX', 'Bahia': 'SSA BPS IOS LEC VDC BRA FEC',
        'Pernambuco': 'REC PNZ', 'Ceará': 'FOR JJD JDO', 'Rio Grande do Norte': 'NAT MVF', 'Paraíba': 'JPA CPV', 'Alagoas': 'MCZ',
        'Sergipe': 'AJU', 'Piauí': 'THE PHB', 'Maranhão': 'SLZ IMP', 'Pará': 'BEL STM MAB ATM CKS', 'Amazonas': 'MAO TBT',
        'Amapá': 'MCP', 'Roraima': 'BVB', 'Acre': 'RBR CZS', 'Rondônia': 'PVH JPR', 'Tocantins': 'PMW', 'Goiás': 'GYN CLV RVD',
        'Distrito Federal': 'BSB', 'Mato Grosso': 'CGB ROO OPS AFL', 'Mato Grosso do Sul': 'CGR CMG DOU',
        'Paraná': 'CWB IGU LDB MGF CAC', 'Santa Catarina': 'FLN NVT JOI XAP CCM', 'Rio Grande do Sul': 'POA CXJ PFB RIA PET URG'}.items():
    for _c in _codigos.split():
        UF[_c] = _uf
_fotos = {}


def lugar(iata, nome):
    """(cidade em inglês, estado ou país) pelo código do aeroporto, no Wikidata."""
    consulta = ('SELECT ?cidade ?pais WHERE { ?ap wdt:P238 "%s"; wdt:P931 ?c. ?c rdfs:label ?cidade. FILTER(lang(?cidade) = "en") '
                'OPTIONAL { ?c wdt:P17 ?p. ?p rdfs:label ?pais. FILTER(lang(?pais) = "en") } }' % iata)
    try:
        r = requests.get('https://query.wikidata.org/sparql', params={'format': 'json', 'query': consulta}, headers=UA, timeout=30)
        b = r.json()['results']['bindings']
        x = next((x for x in b if sem_acento(x['cidade']['value']) == sem_acento(nome)), None) or (b[0] if b else None)
        if x:
            return x['cidade']['value'], UF.get(iata) or x.get('pais', {}).get('value', '')
    except Exception:
        pass
    return nome, UF.get(iata, '')


def fotos_cidade(nome, iata):
    """Endereços de vistas horizontais da cidade (1000 px de largura), na ordem da busca."""
    chave = f'{nome}|{iata}'
    if chave in _fotos:
        return _fotos[chave]
    cidade, regiao = lugar(iata, nome)
    regiao = '' if sem_acento(regiao) == sem_acento(cidade) else regiao
    lista = []
    for termo in ('skyline', 'panorama', ''):
        try:
            r = requests.get('https://commons.wikimedia.org/w/api.php', headers=UA, timeout=30, params={
                'action': 'query', 'format': 'json', 'generator': 'search', 'gsrnamespace': '6',
                'gsrsearch': re.sub(r'\s+', ' ', f'"{cidade}" {regiao} {termo} filetype:bitmap'), 'gsrlimit': '40',
                'prop': 'imageinfo', 'iiprop': 'url|size', 'iiurlwidth': '1000'})
            for pg in sorted(r.json().get('query', {}).get('pages', {}).values(), key=lambda x: x.get('index', 0)):
                i = (pg.get('imageinfo') or [{}])[0]
                if i.get('width', 0) >= 1000 and 1.25 <= i['width'] / max(i.get('height', 1), 1) <= 3.6 \
                        and i.get('thumburl') and i['thumburl'] not in lista:
                    lista.append(i['thumburl'])
        except Exception:
            pass
        if len(lista) >= 15:
            break
    _fotos[chave] = lista
    return lista


def foto(nome, iata, semente, usadas):
    """Uma das primeiras fotos da cidade (muda de story para story; nunca a mesma nas duas metades)."""
    lista = [u for u in fotos_cidade(nome, iata)[:8] if u not in usadas]
    if not lista:
        return None
    ini = int(hashlib.md5(semente.encode()).hexdigest(), 16) % len(lista)
    for u in (lista[ini:] + lista[:ini])[:4]:
        try:
            r = requests.get(u, headers=UA, timeout=40)
            r.raise_for_status()
            img = Image.open(BytesIO(r.content)).convert('RGB')
        except Exception:
            continue
        # foto antiga em preto e branco não combina com o bilhete: tenta a próxima
        if sum(img.convert('HSV').getchannel('S').resize((64, 32)).getdata()) / 2048 < 30:
            continue
        usadas.add(u)
        return img
    return None


def faixa_fotos(a, largura, altura, sombra=True):
    """Metade da origem e metade do destino, cortadas na diagonal com fio dourado (como .pass-foto no site).
    Sem sombra (e-mail): a foto não escurece embaixo."""
    usadas = set()
    fo = foto(a.get('origem', ''), a.get('origem_iata', ''), a.get('id', '') + 'o', usadas)
    fd = foto(a.get('destino', ''), a.get('destino_iata', ''), a.get('id', '') + 'd', usadas) if fo else None
    if not fd:
        return None
    faixa = Image.new('RGBA', (largura, altura), INK3)
    meia = int(largura * 0.56)
    for img, x, poligono in ((fo, 0, [(0, 0), (meia, 0), (int(meia * 0.786), altura), (0, altura)]),
                             (fd, largura - meia, [(int(meia * 0.214), 0), (meia, 0), (meia, altura), (0, altura)])):
        mascara = Image.new('L', (meia, altura), 0)
        ImageDraw.Draw(mascara).polygon(poligono, fill=255)
        faixa.paste(ImageOps.fit(img, (meia, altura), Image.LANCZOS), (x, 0), mascara)
    if sombra:  # escurece a parte de baixo, para a foto se fundir com o bilhete
        camada = Image.new('RGBA', (largura, altura), (0, 0, 0, 0))
        sd = ImageDraw.Draw(camada)
        for i in range(altura // 2):
            sd.line([(0, altura // 2 + i), (largura, altura // 2 + i)], fill=(19, 29, 51, int(240 * (i / (altura / 2)) ** 1.6)))
        faixa.alpha_composite(camada)
    ImageDraw.Draw(faixa).line((largura * 0.56, -2, largura * 0.44, altura + 2), fill=OURO, width=6)
    return faixa


def miolo_passagem(a, chamada=''):
    """Cartão de embarque: IATA grande, rota tracejada com avião e as milhas em destaque."""
    camada, d = tela()
    y, _ = pilula(d, 0, (chamada or chamada_padrao(a)).upper(), OURO)
    y += 60
    # cartão, com a foto das duas cidades no alto quando der para achar
    faixa = faixa_fotos(a, W - 140, 400)
    alto_foto = faixa.height - 40 if faixa else 0
    d.rounded_rectangle((70, y, W - 70, y + 900 + alto_foto), radius=44, fill=(19, 29, 51, 235))
    if faixa:
        mascara = Image.new('L', faixa.size, 0)
        ImageDraw.Draw(mascara).rounded_rectangle((0, 0, faixa.width - 1, faixa.height + 60), radius=44, fill=255)
        camada.paste(faixa, (70, y), mascara)
    d.rounded_rectangle((70, y, W - 70, y + 900 + alto_foto), radius=44, outline=OURO, width=3)
    topo = y + alto_foto
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
    if faixa:
        centro(d, y + 900 + alto_foto + 18, ['Fotos: Wikimedia Commons'], fonte(24, 500), ASH)
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
    y = ticket_logo(camada, y + 60, a) + 70
    d = ImageDraw.Draw(camada)
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


def miolo_capa(dia, n, tipo, periodo='hoje'):
    camada, d = tela()
    y, _ = pilula(d, 0, dia.strftime('%d/%m') + ' · ' + periodo.upper(), OURO)
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


def selo_arraste(img, mais, texto=None):
    """Primeira tela do carrossel: selo no canto avisando que há mais ofertas para arrastar."""
    d = ImageDraw.Draw(img)
    f = fonte(30, 800)
    t = texto or f'+{mais} {"oferta" if mais == 1 else "ofertas"}  →'
    larg = d.textlength(t, font=f)
    x1, y0 = W - 46, 46
    d.rounded_rectangle((x1 - larg - 52, y0, x1, y0 + 62), radius=31, fill=OURO_LT)
    d.text((x1 - larg - 26, y0 + 13), t, font=f, fill=INK)
    return img


def imagem(a, fmt, chamada=''):
    feito = miolo_promocao if a.get('tipo') == 'promocao' else miolo_passagem
    return montar(feito(a, chamada), fmt, a.get('tipo') == 'promocao', cta_tipo(a.get('tipo')))


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


def escolher(alertas, estado, agora, fora=()):
    postados = set(estado.get('postados', [])) | set(fora)
    # Passagem cara ou péssima pelo termômetro não vira story.
    novos = [a for a in alertas if a['id'] not in postados and quando(a) >= agora - timedelta(hours=HORAS_FRESCO)
             and nivel(a) not in ('caro', 'péssimo')]
    promos, passagens = separar(novos)
    ordem = [passagens, promos] if estado.get('ultimo_tipo') == 'promocao' else [promos, passagens]
    return next((lista[0] for lista in ordem if lista), None)


def escolher_carrossel(alertas, agora, tipo, usados=()):
    promos, passagens = separar([a for a in alertas if quando(a) >= agora - timedelta(hours=24) and a['id'] not in usados])
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
    linhas += ['', chamada_direct(tipo), 'Valores e disponibilidade podem mudar a qualquer momento.', '', HASHTAGS]
    return '\n'.join(linhas)


# Textos com o Claude (opcional): chamada curta de cada imagem e a legenda do carrossel.
# Sem ANTHROPIC_API_KEY, ou se a resposta não passar na conferência, usa os textos fixos.
MODELO = 'claude-sonnet-5-5'
SISTEMA = """Você escreve para o Instagram @ondeasmilhasmelevam, sobre milhas, pontos e passagens aéreas.
Recebe ofertas em JSON e devolve:
- "chamadas": uma por oferta, na mesma ordem. Cada uma com no máximo 24 caracteres, em maiúsculas, sem números
  e sem emoji, que desperte urgência ou curiosidade (ex.: CORRE QUE ACABA HOJE, PREÇO DE OCASIÃO, ACHADO DO DIA).
  Se a oferta tiver "ultimo_dia": true, a chamada fala que acaba hoje. Se tiver "termometro"
  (espetacular, muito bom ou bom), a chamada pode usar essa faixa (ex.: MUITO BOM NO TERMÔMETRO).
- "legenda": só se "com_legenda" for true (senão, texto vazio). Legenda curta e envolvente para um carrossel:
  uma linha de gancho, depois uma linha por oferta na mesma ordem (começando com um emoji), depois um convite para
  salvar, comentar ou marcar quem viaja junto. Não fale de link na bio (o convite para o direct é colocado depois).
  No máximo 900 caracteres, sem hashtags.
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


def chamada_direct(tipo):
    return f'💬 Mande {cta_tipo(tipo)} no direct que eu te mando o link na hora!'


def rodape_legenda(tipo):
    return f'\n\n{chamada_direct(tipo)}\n\nValores e disponibilidade podem mudar a qualquer momento.\n\n' + HASHTAGS


def api(metodo, caminho, **kw):
    return requests.request(metodo, f'{GRAPH}/{caminho}', timeout=60, **kw)


def criar(conta, token, **dados):
    """Cria um container e espera o Instagram terminar de baixar e processar."""
    r = api('POST', f'{conta}/media', data={**dados, 'access_token': token})
    if not r.ok or 'id' not in r.json():
        raise RuntimeError(f'container: {r.status_code} {r.text[:300]}')
    cid = r.json()['id']
    for _ in range(60 if 'video_url' in dados else 24):  # vídeo demora mais para processar
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


def fazer_video(jpg, mp4):
    """Imagem parada + trilha, no formato que o story aceita (H.264, AAC 48 kHz, 9:16)."""
    trilhas = sorted(MUSICAS.glob('*.m4a'))
    if not trilhas:
        return False
    trilha = trilhas[int(hashlib.md5(jpg.name.encode()).hexdigest(), 16) % len(trilhas)]
    try:
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', '30', '-i', str(jpg), '-i', str(trilha),
                        '-t', '12', '-vf', 'scale=1080:1920,format=yuv420p', '-c:v', 'libx264', '-tune', 'stillimage',
                        '-preset', 'veryfast', '-crf', '26', '-c:a', 'aac', '-ar', '48000', '-b:a', '128k',
                        '-shortest', '-movflags', '+faststart', str(mp4)], check=True, timeout=120)
        return True
    except (OSError, subprocess.SubprocessError) as e:
        print(f'::warning::Vídeo do story não saiu, vai a imagem: {e}')
        mp4.unlink(missing_ok=True)
        return False


def no_ar(url, espera=420):
    """Espera o GitHub Pages publicar o arquivo (o vídeo não vai pelo raw.githubusercontent)."""
    fim = time.time() + espera
    while time.time() < fim:
        try:
            if requests.head(url, timeout=20).status_code == 200:
                return True
        except requests.RequestException:
            pass
        time.sleep(15)
    return False


def enviar(imagens, estado, msg, com_video=False):
    """Salva as imagens em stories/ e devolve os endereços públicos (fixos no commit).
    Com com_video, devolve pares (imagem, vídeo ou None)."""
    PASTA.mkdir(exist_ok=True)
    for f in [*PASTA.glob('*.jpg'), *PASTA.glob('*.mp4')]:  # o Instagram já baixou os anteriores
        f.unlink()
    videos = set()
    for nome, img in imagens:
        img.save(PASTA / nome, 'JPEG', quality=90)
        if com_video and fazer_video(PASTA / nome, PASTA / nome.replace('.jpg', '.mp4')):
            videos.add(nome)
    if not guardar(estado, msg):
        return []
    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=RAIZ, capture_output=True, text=True).stdout.strip()
    urls = [f'https://raw.githubusercontent.com/{REPO}/{sha}/stories/{nome}' for nome, _ in imagens]
    if not com_video:
        return urls
    return [(u, f"{SITE}/stories/{nome.replace('.jpg', '.mp4')}?v={sha[:8]}" if nome in videos else None)
            for u, (nome, _) in zip(urls, imagens)]


def horario_pendente(agora, estado, chave, horarios):
    """O último horário do dia que já chegou e ainda não foi feito; marca os anteriores como feitos."""
    dia = agora.astimezone(BRASILIA)
    feitos = estado.setdefault(chave, [])
    vencidos = [f'{h:02d}:{m:02d}' for h, m in horarios if (dia.hour, dia.minute) >= (h, m)]
    if not vencidos or vencidos[-1] in feitos:
        return None
    feitos.extend(v for v in vencidos if v not in feitos)
    return vencidos[-1]


def stories(alertas, estado, agora, conta, token):
    lote = horario_pendente(agora, estado, 'lotes_stories', LOTES_STORIES)
    if not lote:
        return
    itens = []
    for _ in range(POR_LOTE):
        a = escolher(alertas, estado, agora, [x['id'] for x in itens])
        if not a:
            break
        itens.append(a)
        estado['ultimo_tipo'] = a.get('tipo') or 'passagem'
    if not itens:
        return print(f'Stories das {lote}: nenhum alerta novo nos grupos.')
    chamadas = textos_ia(itens).get('chamadas') or [''] * len(itens)
    pares = enviar([(f"{a['id']}.jpg", imagem(a, STORY, c)) for a, c in zip(itens, chamadas)], estado,
                   f'Imagens dos stories das {lote}', com_video=True)
    if not pares:
        return
    pronto = any(v for _, v in pares) and no_ar(next(v for _, v in pares if v).split('?')[0])
    feitos = 0
    for a, (u, v) in zip(itens, pares):
        estado.setdefault('postados', []).append(a['id'])
        try:
            try:
                if not (pronto and v):
                    raise RuntimeError('sem vídeo')
                cid = criar(conta, token, video_url=v, media_type='STORIES')
            except Exception as e:
                if v:
                    print(f'::warning::Story em vídeo não saiu, vai a imagem: {e}')
                cid = criar(conta, token, image_url=u, media_type='STORIES')
            publicar(conta, token, cid)
            feitos += 1
        except Exception as e:
            print(f'::warning::Story não publicado: {e}')
    estado['postados'] = estado['postados'][-500:]
    estado['hoje'] = estado.get('hoje', 0) + feitos
    estado['ultimo_em'] = agora.isoformat()
    print(f'Stories das {lote}: {feitos} publicados.')


def carrossel(alertas, estado, agora, conta, token, tipo, periodo):
    dia = agora.astimezone(BRASILIA)
    usados = estado.setdefault('feed_usados', [])
    itens = escolher_carrossel(alertas, agora, tipo, set(usados))
    if len(itens) < 2:
        return print(f'Carrossel de {tipo} ({periodo}): menos de 2 alertas novos, fica para o próximo horário.')
    usados.extend(a['id'] for a in itens)
    ia = textos_ia(itens, com_legenda=True)
    chamadas = ia.get('chamadas') or [''] * len(itens)
    texto = ia['legenda'] + rodape_legenda(tipo) if ia.get('legenda') else legenda(itens, dia, tipo)
    # sem capa: abre direto na melhor oferta (a capa repetida deixava o perfil todo igual)
    telas = [(f'feed-{tipo}-{n}.jpg', imagem(a, FMT_FEED, c)) for n, (a, c) in enumerate(zip(itens, chamadas), 1)]
    selo_arraste(telas[0][1], len(itens) - 1)
    urls = enviar(telas, estado, f'Imagens do carrossel de {tipo} ({periodo})')
    if not urls:
        return
    try:
        filhos = [criar(conta, token, image_url=u, is_carousel_item='true') for u in urls]
        cid = criar(conta, token, media_type='CAROUSEL', children=','.join(filhos), caption=texto)
        publicar(conta, token, cid)
    except Exception as e:
        return print(f'::warning::Carrossel não publicado: {e}')
    print(f'Carrossel de {tipo} ({periodo}) publicado com {len(itens)} oportunidades.')


def feed(alertas, estado, agora, conta, token):
    hora = horario_pendente(agora, estado, 'horarios_feed', [(h, m) for _, h, m in FEED])
    if not hora:
        return
    periodo = next(nome for nome, h, m in FEED if f'{h:02d}:{m:02d}' == hora)
    for tipo in TIPOS_FEED:
        carrossel(alertas, estado, agora, conta, token, tipo, periodo)


# ---------- Carrossel educativo da semana (domingo 11h): só dados conferidos do Termômetro do site ----------
# Gira entre as regiões ("quanto pagar em milhas para a Europa") e o preço do milheiro. Cada tela mostra até
# quantas milhas, por trecho e sem taxas, uma passagem é espetacular, muito boa ou boa em cada programa.
EDUCATIVO_DIA, EDUCATIVO_HORA = 6, 11  # domingo, 11h de Brasília
NOME_REGIAO = {'europa': 'a Europa', 'america-do-norte': 'os EUA', 'caribe': 'o Caribe',
               'america-do-sul-sul': 'Chile, Argentina e Uruguai', 'america-do-sul-norte': 'Colômbia, Peru e Equador'}
COR_NIVEL = {'espetacular': '#FF8A4C', 'muito bom': '#3FCF8E', 'bom': '#9BE38D'}


def temas_educativos():
    termo = termometro() or {}
    return [('regiao', r) for r in termo.get('regioes', []) if r.get('id') in NOME_REGIAO] + [('milheiro', termo.get('milheiro', []))]


def miolo_texto(sobre, titulo, linhas_titulo_cor=OURO):
    camada, d = tela()
    y = 60
    if sobre:
        y = pilula(d, y, sobre, OURO_LT, tam=28)[0] + 40
    y = centro(d, y, titulo, fonte(78, 800), RICE, 1.08)
    return camada, d, y + 30


def tela_regiao_capa(r, cab):
    camada, d, y = miolo_texto('GUIA RÁPIDO DE MILHAS', ['QUANTO PAGAR', 'EM MILHAS PARA', NOME_REGIAO[r['id']].upper() + '?'])
    y = centro(d, y + 10, ['Ida, por pessoa, sem as taxas', 'Econômica' if cab == 'eco' else 'Executiva'], fonte(38, 600), ASH)
    centro(d, y + 40, ['ARRASTE PARA VER POR PROGRAMA  →'], fonte(30, 800), OURO)
    return camada


def tela_programa(r, cab, prog, faixas):
    termo = termometro() or {}
    nome = termo.get('programas', {}).get(prog, prog)
    camada, d, y = miolo_texto(f"{NOME_REGIAO[r['id']].upper()} · {'ECONÔMICA' if cab == 'eco' else 'EXECUTIVA'}", [nome.split(' (')[0].upper()])
    for nivel_, teto in faixas:
        f = fonte(40, 800)
        rot = nivel_.upper()
        d.rounded_rectangle((170, y, W - 170, y + 130), radius=30, fill=INK3, outline=COR_NIVEL[nivel_], width=3)
        d.text((210, y + 22), rot, font=fonte(28, 800), fill=COR_NIVEL[nivel_])
        d.text((210, y + 60), f'até {numero(teto)} milhas', font=f, fill=RICE)
        y += 160
    centro(d, y + 10, ['Achou nessa faixa? Emita rápido: some em horas.'], fonte(30, 600), ASH)
    return camada


def tela_milheiro_capa():
    camada, d, y = miolo_texto('GUIA RÁPIDO DE MILHAS', ['QUANTO PAGAR', 'NO MILHEIRO?'])
    y = centro(d, y + 10, ['O teto para comprar 1.000 pontos', 'ou milhas sem pagar caro'], fonte(38, 600), ASH)
    centro(d, y + 40, ['ARRASTE PARA VER  →'], fonte(30, 800), OURO)
    return camada


def tela_milheiro(itens):
    camada, d, y = miolo_texto('PREÇO MÁXIMO DO MILHEIRO', ['ATÉ QUANTO PAGAR'])
    y = centro(d, y - 10, ['por 1.000 pontos ou milhas'], fonte(32, 600), ASH) + 20
    simbolo = {'BRL': 'R$', 'EUR': '€', 'GBP': '£'}
    for m in itens:
        d.rounded_rectangle((150, y, W - 150, y + 100), radius=26, fill=INK3, outline=LINHA, width=2)
        d.text((190, y + 28), m['programa'], font=fonte(36, 700), fill=RICE)
        v = f"{simbolo.get(m.get('moeda'), '')} {m['teto']}"
        f = fonte(42, 800)
        d.text((W - 190 - d.textlength(v, font=f), y + 24), v, font=f, fill=OURO)
        y += 118
    return camada


def carrossel_educativo(tema):
    """Telas e legenda do carrossel educativo do tema."""
    tipo, dado = tema
    if tipo == 'regiao':
        cab = 'eco'
        porprog = {}
        for nivel_ in ('espetacular', 'muito bom', 'bom'):
            for prog, teto in (dado['cabines'].get(cab, {}).get(nivel_) or {}).items():
                porprog.setdefault(prog, []).append((nivel_, teto))
        progs = sorted(porprog, key=lambda p: -len(porprog[p]))[:5]
        telas = [tela_regiao_capa(dado, cab)] + [tela_programa(dado, cab, p, porprog[p]) for p in progs]
        nome = NOME_REGIAO[dado['id']]
        linhas = [f'✈️ Quanto pagar em milhas para {nome}?', '',
                  'Salve este post: é a régua para saber se uma passagem está boa de verdade (ida, por pessoa, sem taxas, econômica).', '']
        for p in progs:
            melhor = porprog[p][0]
            linhas.append(f"• {(termometro() or {}).get('programas', {}).get(p, p)}: {melhor[0]} até {numero(melhor[1])} milhas")
    else:
        itens = [m for m in dado if m.get('teto')][:9]
        telas = [tela_milheiro_capa(), tela_milheiro(itens[:5])] + ([tela_milheiro(itens[5:9])] if len(itens) > 5 else [])
        linhas = ['💸 Até quanto pagar no milheiro?', '', 'Salve este post antes de comprar pontos ou milhas:', '']
        simbolo = {'BRL': 'R$', 'EUR': '€', 'GBP': '£'}
        linhas += [f"• {m['programa']}: até {simbolo.get(m.get('moeda'), '')} {m['teto']}" for m in itens]
    linhas += ['', 'Marque quem está juntando milhas com você 👇', '', chamada_direct('passagem'), '', HASHTAGS]
    imgs = [montar(t, FMT_FEED, False, 'ALERTA') for t in telas]
    selo_arraste(imgs[0], len(imgs) - 1, 'Arraste  →')
    return imgs, '\n'.join(linhas)


def educativo(estado, agora, conta, token):
    dia = agora.astimezone(BRASILIA)
    semana = dia.strftime('%G-%V')
    if dia.weekday() != EDUCATIVO_DIA or dia.hour < EDUCATIVO_HORA or estado.get('educativo_semana') == semana:
        return
    temas = temas_educativos()
    if not temas:
        return
    n = estado.get('educativo_n', 0)
    imgs, texto = carrossel_educativo(temas[n % len(temas)])
    urls = enviar([(f'feed-edu-{i}.jpg', im) for i, im in enumerate(imgs)], estado, 'Imagens do carrossel educativo')
    if not urls:
        return
    try:
        filhos = [criar(conta, token, image_url=u, is_carousel_item='true') for u in urls]
        publicar(conta, token, criar(conta, token, media_type='CAROUSEL', children=','.join(filhos), caption=texto))
    except Exception as e:
        return print(f'::warning::Carrossel educativo não publicado: {e}')
    estado.update(educativo_semana=semana, educativo_n=n + 1)
    print('Carrossel educativo publicado.')



# ---------- Story da campanha de cortesia (dia 1º de cada mês) ----------
# Quem responde CORTESIA recebe pelo ManyChat o link do pedido (site #cortesia, aberto do dia 1 ao 7).
def story_cortesia():
    camada, d = tela()
    y = pilula(d, 120, 'CAMPANHA DO MÊS · VAGAS LIMITADAS', OURO_LT, tam=30)[0] + 60
    y = centro(d, y, ['GANHE ATÉ'], fonte(70, 800), RICE)
    y = centro(d, y, ['30 DIAS'], fonte(190, 800, 'Cinzel'), OURO, 1.0)
    y = centro(d, y, ['GRÁTIS'], fonte(90, 800), RICE) + 30
    y = centro(d, y, ['no site com as melhores passagens', 'com milhas, na hora em que aparecem'], fonte(40, 600), ASH) + 60
    for n, t in enumerate(['Responda CORTESIA aqui', 'Poste nos seus stories e', 'marque @ondeasmilhasmelevam', 'Preencha o pedido no link'], 1):
        if n == 3:
            y = centro(d, y - 8, [t], fonte(40, 800), OURO_LT) + 22
            continue
        rot = f"{n if n < 3 else n - 1}. {t}"
        y = centro(d, y, [rot], fonte(44, 800), RICE) + (8 if n == 2 else 22)
    return montar(camada, STORY, False, 'CORTESIA')


def campanha_cortesia(estado, agora, conta, token):
    dia = agora.astimezone(BRASILIA)
    mes = dia.strftime('%Y-%m')
    if dia.day != 1 or estado.get('campanha_mes') == mes:
        return
    urls = enviar([('story-cortesia.jpg', story_cortesia())], estado, 'Story da campanha de cortesia')
    if not urls:
        return
    try:
        publicar(conta, token, criar(conta, token, image_url=urls[0], media_type='STORIES'))
    except Exception as e:
        return print(f'::warning::Story da campanha não publicado: {e}')
    estado['campanha_mes'] = mes
    print('Story da campanha de cortesia publicado.')


def teste(pasta):
    """Gera stories e os carrosséis de exemplo com os alertas atuais, sem publicar."""
    pasta.mkdir(parents=True, exist_ok=True)
    alertas = ler_json(ALERTAS, []) or ler_json(RAIZ / 'dados' / 'alertas.json', [])
    agora = max((quando(a) for a in alertas), default=datetime.now(timezone.utc))
    promos, passagens = separar(alertas)
    for n, a in enumerate(promos[:2] + passagens[:2]):
        imagem(a, STORY).save(pasta / f'story-{n}.jpg', quality=90)
    for tipo in TIPOS_FEED:
        itens = escolher_carrossel(alertas, agora, tipo)
        ia = textos_ia(itens, com_legenda=True)
        chamadas = ia.get('chamadas') or [''] * len(itens)
        for n, (a, c) in enumerate(zip(itens, chamadas), 1):
            tela = imagem(a, FMT_FEED, c)
            (selo_arraste(tela, len(itens) - 1) if n == 1 else tela).save(pasta / f'feed-{tipo}-{n}.jpg', quality=90)
        texto = ia['legenda'] + rodape_legenda(tipo) if ia.get('legenda') else legenda(itens, agora.astimezone(BRASILIA), tipo)
        (pasta / f'legenda-{tipo}.txt').write_text(texto, encoding='utf-8')
    story_cortesia().convert('RGB').save(pasta / 'story-cortesia.jpg', quality=90)
    for t, tema in enumerate(temas_educativos()):
        imgs, texto = carrossel_educativo(tema)
        for i, im in enumerate(imgs):
            im.convert('RGB').save(pasta / f'edu-{t}-{i}.jpg', quality=90)
        (pasta / f'legenda-edu-{t}.txt').write_text(texto, encoding='utf-8')
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
        estado.update(dia=hoje, hoje=0, lotes_stories=[], horarios_feed=[], feed_usados=[])
    for velho in ('carrossel_dia', 'carrossel_promocao_dia', 'carrossel_passagem_dia'):
        estado.pop(velho, None)
    token = renovar(token, estado, agora)
    if HORARIO[0] <= agora.astimezone(BRASILIA).hour < HORARIO[1]:
        alertas = ler_json(ALERTAS, [])
        stories(alertas, estado, agora, conta, token)
        feed(alertas, estado, agora, conta, token)
        educativo(estado, agora, conta, token)
        campanha_cortesia(estado, agora, conta, token)
    guardar(estado, 'Instagram: controle atualizado')


if __name__ == '__main__':
    main()
