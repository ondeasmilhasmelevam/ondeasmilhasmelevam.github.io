"""Publica no Instagram os melhores alertas de dados/alertas.json.

Roda dentro do plantão dos alertas (ver .github/workflows/alertas.yml), logo
depois de cada leitura do Telegram. Faz duas coisas, sem poluir o perfil:

Stories (1080 x 1920), um alerta por story:
  - no máximo STORIES_POR_DIA por dia (padrão 6) e um a cada STORIES_INTERVALO_MIN
    minutos (padrão 90), só entre 8h e 22h de Brasília;
  - só alertas das últimas 6 horas, nunca o mesmo duas vezes;
  - prioridade: promoção no último dia, promoção nova, passagem com menos milhas,
    alternando promoção e passagem quando dá.

Carrossel no feed (1080 x 1350), uma vez por dia a partir das 19h de Brasília:
  - capa "Melhores oportunidades do dia" e até 3 promoções e 3 passagens das
    últimas 24 horas (passagens com destinos diferentes);
  - legenda curta com a lista, "link na bio" e hashtags.

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

POR_DIA = int(os.environ.get('STORIES_POR_DIA') or 6)
INTERVALO_MIN = int(os.environ.get('STORIES_INTERVALO_MIN') or 90)
HORAS_FRESCO = 6
HORARIO = (8, 22)
HORA_CARROSSEL = 19
RENOVAR_DIAS = 7
BRASILIA = timezone(timedelta(hours=-3))
HASHTAGS = '#milhas #milhasaereas #pontos #passagensaereas #viagem #viajarbarato #ondeasmilhasmelevam'

# Cores do site (estilo.css).
INK, INK3, LINHA = '#070C17', '#131D33', '#1E2A42'
RICE, ASH, OURO, VERDE, VERMELHO = '#F3EEE3', '#A3ACBD', '#E2B458', '#3CCF91', '#FF8A80'
W = 1080
# Altura da imagem, onde começa o miolo e onde fica o botão "LINK NA BIO".
STORY = {'alto': 1920, 'logo': 150, 'miolo': (420, 1500), 'botao': 1550}
FEED = {'alto': 1350, 'logo': 70, 'miolo': (270, 1050), 'botao': 1090}


def fonte(tam, negrito=True):
    nome = 'DejaVuSans-Bold.ttf' if negrito else 'DejaVuSans.ttf'
    for pasta in ('/usr/share/fonts/truetype/dejavu', 'C:/Windows/Fonts'):
        if Path(pasta, nome).exists():
            return ImageFont.truetype(str(Path(pasta, nome)), tam)
    return ImageFont.load_default(tam)


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


def centro(d, y, linhas, f, cor, entre=1.15):
    for l in linhas:
        d.text(((W - d.textlength(l, font=f)) / 2, y), l, font=f, fill=cor)
        y += int(f.size * entre)
    return y


def selo(d, y, texto, fundo):
    f = fonte(32)
    w = d.textlength(texto, font=f) + 44
    x = (W - w) / 2
    d.rounded_rectangle((x, y, x + w, y + f.size + 30), radius=(f.size + 30) // 2, fill=fundo)
    d.text((x + 22, y + 13), texto, font=f, fill=INK)
    return y + f.size + 30


def montar(miolo, fmt):
    """Fundo, logo, o miolo centrado no espaço livre e o botão "LINK NA BIO"."""
    alto = fmt['alto']
    img = Image.new('RGB', (W, alto), INK)
    d = ImageDraw.Draw(img)
    for i in range(alto):  # degradê suave do topo
        t = i / alto
        d.line([(0, i), (W, i)], fill=tuple(int(a + (b - a) * t) for a, b in zip((19, 29, 51), (7, 12, 23))))
    y = fmt['logo']
    if LOGO.exists():
        logo = Image.open(LOGO).convert('RGB').resize((150, 150))
        mascara = Image.new('L', (150, 150), 0)
        ImageDraw.Draw(mascara).ellipse((0, 0, 150, 150), fill=255)
        img.paste(logo, (80, y), mascara)
    d.text((255, y + 22), 'ONDE AS MILHAS', font=fonte(44), fill=RICE)
    d.text((255, y + 78), 'ME LEVAM', font=fonte(44), fill=OURO)
    # O miolo é desenhado à parte; aqui ele é aparado, encolhido se precisar e centrado.
    caixa = miolo.getbbox()
    if caixa:
        miolo = miolo.crop((0, caixa[1], W, caixa[3]))
        topo, fim = fmt['miolo']
        if miolo.height > fim - topo:
            k = (fim - topo) / miolo.height
            miolo = miolo.resize((int(W * k), fim - topo), Image.LANCZOS)
        img.paste(miolo, ((W - miolo.width) // 2, topo + (fim - topo - miolo.height) // 2), miolo)
    botao(img, fmt['botao'])
    return img


def botao(img, y):
    """Botão "LINK NA BIO" em dourado claro, com brilho em volta."""
    caixa = (130, y, W - 130, y + 170)
    brilho = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(brilho).rounded_rectangle(caixa, radius=85, fill=(245, 215, 136, 150))
    brilho = brilho.filter(ImageFilter.GaussianBlur(38))
    img.paste(brilho, (0, 0), brilho)
    faixa = Image.new('RGB', (caixa[2] - caixa[0], caixa[3] - caixa[1]))
    fd = ImageDraw.Draw(faixa)
    for i in range(faixa.height):  # degradê do dourado claro para o dourado do site
        t = i / faixa.height
        fd.line([(0, i), (faixa.width, i)], fill=tuple(int(a + (b - a) * t) for a, b in zip((250, 226, 160), (226, 180, 88))))
    mascara = Image.new('L', faixa.size, 0)
    ImageDraw.Draw(mascara).rounded_rectangle((0, 0, faixa.width - 1, faixa.height - 1), radius=85, fill=255)
    img.paste(faixa, caixa[:2], mascara)
    d = ImageDraw.Draw(img)
    centro(d, y + 44, ['LINK NA BIO'], fonte(70), INK)
    centro(d, y + 220, ['Valores podem mudar a qualquer momento.'], fonte(26, False), ASH)


def tela():
    camada = Image.new('RGBA', (W, 1500), (0, 0, 0, 0))
    return camada, ImageDraw.Draw(camada)


def milhas(txt):
    n = re.search(r'([\d.]+)\s*milhas', txt or '', re.I)
    return int(n.group(1).replace('.', '')) if n else 10 ** 9


def miolo_passagem(a):
    """Só o essencial: para onde, quantas milhas e por qual programa."""
    camada, d = tela()
    y = selo(d, 0, 'PASSAGEM COM MILHAS', OURO) + 80
    f = fonte(54, False)
    y = centro(d, y, quebrar(d, f"{a['origem']} para", f, W - 160, 1), f, ASH)
    f = fonte(104)
    y = centro(d, y + 10, quebrar(d, a['destino'], f, W - 140, 2), f, RICE)
    m = milhas(a.get('ida'))
    if m < 10 ** 9:
        y = centro(d, y + 70, ['a partir de'], fonte(40, False), ASH)
        y = centro(d, y, [f'{m:,}'.replace(',', '.')], fonte(150), OURO, 1.05)
        y = centro(d, y, ['milhas + taxas'], fonte(46), OURO)
    info = ' · '.join(x for x in (a.get('programa'), a.get('cabine')) if x)
    f = fonte(40, False)
    centro(d, y + 50, quebrar(d, info, f, W - 160, 1), f, RICE)
    return camada


def destaque(titulo):
    """O número que chama atenção no título: '96.000 PONTOS', '100%', '27.500 MILHAS'."""
    m = re.search(r'(\d+\s*%)', titulo) or re.search(r'([\d.]{4,}\s*(?:MILHAS|PONTOS|AVIOS))', titulo, re.I)
    return m.group(1).upper() if m else ''


def miolo_promocao(a):
    """Selo, o número em destaque e o título curto. Nada de resumo."""
    camada, d = tela()
    ultimo = a.get('ultimo_dia')
    y = selo(d, 0, 'ÚLTIMO DIA' if ultimo else 'PROMOÇÃO', VERMELHO if ultimo else OURO) + 90
    titulo = a['titulo'].upper()
    num = destaque(titulo)
    if num:
        # "COM ATÉ 75% DE DESCONTO" vira "até" + "75%" em destaque + "... COM DESCONTO".
        antes = re.search(r'(ATÉ|A PARTIR DE)\s+' + re.escape(num), titulo)
        if antes:
            y = centro(d, y, [antes.group(1).lower()], fonte(44, False), ASH)
        f = fonte(130)
        y = centro(d, y, quebrar(d, num, f, W - 120, 2), f, OURO, 1.05) + 40
        titulo = re.sub(r'(\s+DE)?\s+((ATÉ|A PARTIR DE)\s+)?' + re.escape(num) + r'(\s+DE\b)?', ' ', ' ' + titulo)
        if titulo.count('BÔNUS') > 1:
            titulo = re.sub(r'\s+COM BÔNUS\s*$', '', titulo)
        titulo = re.sub(r'\s+', ' ', titulo).strip(' -–:,')
    f = fonte(62)
    y = centro(d, y, quebrar(d, titulo, f, W - 160, 4), f, RICE)
    if a.get('ate'):
        centro(d, y + 50, ['Vale até ' + datetime.fromisoformat(a['ate']).strftime('%d/%m')], fonte(44, False), ASH)
    return camada


def miolo_capa(dia, n):
    camada, d = tela()
    y = selo(d, 0, dia.strftime('%d/%m'), OURO) + 80
    y = centro(d, y, ['MELHORES', 'OPORTUNIDADES', 'DO DIA'], fonte(96), RICE, 1.1)
    y = centro(d, y + 50, [f'{n} achados de milhas e pontos'], fonte(42, False), ASH)
    centro(d, y + 70, ['arraste para o lado  →'], fonte(46), OURO)
    return camada


def imagem(a, fmt):
    return montar(miolo_promocao(a) if a.get('tipo') == 'promocao' else miolo_passagem(a), fmt)


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
                       key=lambda a: milhas(a.get('ida')) + milhas(a.get('volta')))
    return promos, passagens


def escolher(alertas, estado, agora):
    postados = set(estado.get('postados', []))
    novos = [a for a in alertas if a['id'] not in postados and quando(a) >= agora - timedelta(hours=HORAS_FRESCO)]
    promos, passagens = separar(novos)
    ordem = [passagens, promos] if estado.get('ultimo_tipo') == 'promocao' else [promos, passagens]
    return next((lista[0] for lista in ordem if lista), None)


def escolher_carrossel(alertas, agora):
    promos, passagens = separar([a for a in alertas if quando(a) >= agora - timedelta(hours=24)])
    destinos, viagens = set(), []
    for a in passagens:
        if a['destino'] not in destinos:
            destinos.add(a['destino'])
            viagens.append(a)
    return promos[:3] + viagens[:3]


PEQUENAS = {'a', 'à', 'ao', 'até', 'com', 'da', 'das', 'de', 'do', 'dos', 'e', 'em', 'na', 'no', 'o', 'ou', 'para', 'por'}


def titulo_legivel(t):
    """'COMPRA DE MILHAS SMILES COM 75% DE DESCONTO' → 'Compra de Milhas Smiles com 75% de Desconto'."""
    palavras = t.lower().split()
    return ' '.join(p if i and p in PEQUENAS else p[:1].upper() + p[1:] for i, p in enumerate(palavras))


def legenda(itens, dia):
    linhas = [f"✈️ Melhores oportunidades de hoje ({dia.strftime('%d/%m')})", '']
    for a in itens:
        if a.get('tipo') == 'promocao':
            linhas.append(f"💸 {titulo_legivel(a['titulo'])}")
        else:
            m = milhas(a.get('ida'))
            preco = f" a partir de {m:,} milhas".replace(',', '.') if m < 10 ** 9 else ''
            linhas.append(f"🛫 {a['origem']} → {a['destino']}:{preco} ({a.get('programa', '')})")
    linhas += ['', 'Detalhes e links: link na bio 👆', 'Valores e disponibilidade podem mudar a qualquer momento.', '', HASHTAGS]
    return '\n'.join(linhas)


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
    urls = enviar([(f"{a['id']}.jpg", imagem(a, STORY))], estado, 'Imagem do story')
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


def carrossel(alertas, estado, agora, conta, token):
    dia = agora.astimezone(BRASILIA)
    if dia.hour < HORA_CARROSSEL or estado.get('carrossel_dia') == estado['dia']:
        return
    itens = escolher_carrossel(alertas, agora)
    if len(itens) < 2:
        return
    estado['carrossel_dia'] = estado['dia']  # uma tentativa por dia, mesmo se falhar
    telas = [('feed-0.jpg', montar(miolo_capa(dia, len(itens)), FEED))]
    telas += [(f'feed-{n}.jpg', imagem(a, FEED)) for n, a in enumerate(itens, 1)]
    urls = enviar(telas, estado, 'Imagens do carrossel do dia')
    if not urls:
        return
    try:
        filhos = [criar(conta, token, image_url=u, is_carousel_item='true') for u in urls]
        cid = criar(conta, token, media_type='CAROUSEL', children=','.join(filhos), caption=legenda(itens, dia))
        publicar(conta, token, cid)
    except Exception as e:
        return print(f'::warning::Carrossel não publicado: {e}')
    print(f'Carrossel do dia publicado com {len(itens)} oportunidades.')


def teste(pasta):
    """Gera stories e o carrossel de exemplo com os alertas atuais, sem publicar."""
    pasta.mkdir(parents=True, exist_ok=True)
    alertas = ler_json(ALERTAS, [])
    agora = max((quando(a) for a in alertas), default=datetime.now(timezone.utc))
    promos, passagens = separar(alertas)
    for n, a in enumerate(promos[:2] + passagens[:2]):
        imagem(a, STORY).save(pasta / f'story-{n}.jpg', quality=90)
    itens = escolher_carrossel(alertas, agora)
    montar(miolo_capa(agora.astimezone(BRASILIA), len(itens)), FEED).save(pasta / 'feed-0.jpg', quality=90)
    for n, a in enumerate(itens, 1):
        imagem(a, FEED).save(pasta / f'feed-{n}.jpg', quality=90)
    (pasta / 'legenda.txt').write_text(legenda(itens, agora.astimezone(BRASILIA)), encoding='utf-8')
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
        carrossel(alertas, estado, agora, conta, token)
        story(alertas, estado, agora, conta, token)
    guardar(estado, 'Instagram: controle atualizado')


if __name__ == '__main__':
    main()
