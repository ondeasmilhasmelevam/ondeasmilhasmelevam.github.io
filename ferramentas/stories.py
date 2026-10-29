"""Publica nos stories do Instagram os melhores alertas de dados/alertas.json.

Roda dentro do plantão dos alertas (ver .github/workflows/alertas.yml), logo
depois de cada leitura do Telegram. Para não poluir os stories:
  - no máximo STORIES_POR_DIA por dia (padrão 6) e um a cada INTERVALO_MIN minutos;
  - só entre 8h e 22h de Brasília;
  - só alertas das últimas HORAS_FRESCO horas, nunca o mesmo duas vezes;
  - prioridade: promoção no último dia, promoção nova, passagem com menos milhas;
    alterna promoção e passagem quando dá.
O story não tem legenda nem link: o texto vai desenhado na imagem, com
"link na bio". A imagem fica em stories/ no próprio repositório e só as dos
últimos 2 dias são mantidas (o story some em 24 h).

A chave do Instagram (token de Instagram Login, vale 60 dias) é renovada
sozinha uma vez por semana. Como a Meta pode devolver uma chave nova, ela é
gravada de volta no segredo INSTAGRAM_TOKEN; para isso o segredo GH_SEGREDOS
precisa ter um token do GitHub com permissão de escrever segredos neste
repositório. Sem INSTAGRAM_TOKEN e INSTAGRAM_ID, não faz nada.
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
SITE = 'ondeasmilhasmelevam.github.io'
GRAPH = 'https://graph.instagram.com/v21.0'

POR_DIA = int(os.environ.get('STORIES_POR_DIA') or 6)
INTERVALO_MIN = int(os.environ.get('STORIES_INTERVALO_MIN') or 90)
HORAS_FRESCO = 6
HORARIO = (8, 22)
RENOVAR_DIAS = 7
BRASILIA = timezone(timedelta(hours=-3))

# Cores do site (estilo.css).
INK, INK2, INK3, LINHA = '#070C17', '#0C1426', '#131D33', '#1E2A42'
RICE, ASH, OURO, VERDE, VERMELHO = '#F3EEE3', '#A3ACBD', '#E2B458', '#3CCF91', '#FF8A80'
W, H = 1080, 1920


def fonte(tam, negrito=True):
    nomes = ['DejaVuSans-Bold.ttf' if negrito else 'DejaVuSans.ttf']
    pastas = ['/usr/share/fonts/truetype/dejavu', 'C:/Windows/Fonts']
    for p in pastas:
        for n in nomes:
            if Path(p, n).exists():
                return ImageFont.truetype(str(Path(p, n)), tam)
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


def escrever(d, xy, linhas, f, cor, entre=1.25):
    x, y = xy
    for l in linhas:
        d.text((x, y), l, font=f, fill=cor)
        y += int(f.size * entre)
    return y


def selo(d, xy, texto, f, fundo, cor):
    x, y = xy
    w = d.textlength(texto, font=f)
    d.rounded_rectangle((x, y, x + w + 44, y + f.size + 30), radius=(f.size + 30) // 2, fill=fundo)
    d.text((x + 22, y + 13), texto, font=f, fill=cor)
    return x + w + 44


def base():
    img = Image.new('RGB', (W, H), INK)
    d = ImageDraw.Draw(img)
    for i in range(H):  # degradê suave do topo
        t = i / H
        c = tuple(int(a + (b - a) * t) for a, b in zip((19, 29, 51), (7, 12, 23)))
        d.line([(0, i), (W, i)], fill=c)
    if LOGO.exists():
        logo = Image.open(LOGO).convert('RGB').resize((150, 150))
        mascara = Image.new('L', (150, 150), 0)
        ImageDraw.Draw(mascara).ellipse((0, 0, 150, 150), fill=255)
        img.paste(logo, (80, 150), mascara)
    d.text((255, 172), 'ONDE AS MILHAS', font=fonte(44), fill=RICE)
    d.text((255, 228), 'ME LEVAM', font=fonte(44), fill=OURO)
    return img, d


def rodape(img):
    """Botão "Link na bio" em dourado claro, com brilho em volta."""
    caixa = (130, 1550, W - 130, 1730)
    brilho = Image.new('RGBA', img.size, (0, 0, 0, 0))
    ImageDraw.Draw(brilho).rounded_rectangle(caixa, radius=90, fill=(245, 215, 136, 150))
    img.paste(brilho.filter(ImageFilter.GaussianBlur(38)), (0, 0), brilho.filter(ImageFilter.GaussianBlur(38)))
    botao = Image.new('RGB', (caixa[2] - caixa[0], caixa[3] - caixa[1]))
    bd = ImageDraw.Draw(botao)
    for i in range(botao.height):  # degradê do dourado claro para o dourado do site
        t = i / botao.height
        bd.line([(0, i), (botao.width, i)], fill=tuple(int(a + (b - a) * t) for a, b in zip((250, 226, 160), (226, 180, 88))))
    mascara = Image.new('L', botao.size, 0)
    ImageDraw.Draw(mascara).rounded_rectangle((0, 0, botao.width - 1, botao.height - 1), radius=90, fill=255)
    img.paste(botao, caixa[:2], mascara)
    d = ImageDraw.Draw(img)
    f = fonte(70)
    t = 'LINK NA BIO'
    d.text(((W - d.textlength(t, font=f)) / 2, 1598), t, font=f, fill=INK)
    aviso = 'Valores podem mudar a qualquer momento.'
    f3 = fonte(26, False)
    d.text(((W - d.textlength(aviso, font=f3)) / 2, 1800), aviso, font=f3, fill=ASH)


def centro(d, y, linhas, f, cor, entre=1.15):
    for l in linhas:
        d.text(((W - d.textlength(l, font=f)) / 2, y), l, font=f, fill=cor)
        y += int(f.size * entre)
    return y


def selo_centro(d, y, texto, fundo):
    f = fonte(32)
    w = d.textlength(texto, font=f) + 44
    selo(d, ((W - w) / 2, y), texto, f, fundo, INK)


def milhas(txt):
    n = re.search(r'([\d.]+)\s*milhas', txt or '', re.I)
    return int(n.group(1).replace('.', '')) if n else 10 ** 9


def imagem_passagem(a):
    """Só o essencial: para onde, quantas milhas e por qual programa."""
    img, d = base()
    selo_centro(d, 520, 'PASSAGEM COM MILHAS', OURO)
    f = fonte(54, False)
    y = centro(d, 660, quebrar(d, f"{a['origem']} para", f, W - 160, 1), f, ASH)
    f = fonte(104)
    y = centro(d, y + 10, quebrar(d, a['destino'], f, W - 140, 2), f, RICE)
    m = milhas(a.get('ida'))
    if m < 10 ** 9:
        y = centro(d, y + 90, ['a partir de'], fonte(40, False), ASH)
        y = centro(d, y, [f'{m:,}'.replace(',', '.')], fonte(150), OURO, 1.05)
        y = centro(d, y, ['milhas + taxas'], fonte(46), OURO)
    info = ' · '.join(x for x in (a.get('programa'), a.get('cabine')) if x)
    f = fonte(40, False)
    centro(d, y + 60, quebrar(d, info, f, W - 160, 1), f, RICE)
    rodape(img)
    return img


def destaque(titulo):
    """O número que chama atenção no título: '96.000 PONTOS', '100%', '27.500 MILHAS'."""
    m = re.search(r'(\d+\s*%)', titulo) or re.search(r'([\d.]{4,}\s*(?:MILHAS|PONTOS|AVIOS))', titulo, re.I)
    return m.group(1).upper() if m else ''


def imagem_promocao(a):
    """Selo, o número em destaque e o título curto. Nada de resumo."""
    img, d = base()
    ultimo = a.get('ultimo_dia')
    selo_centro(d, 520, 'ÚLTIMO DIA' if ultimo else 'PROMOÇÃO', VERMELHO if ultimo else OURO)
    titulo = a['titulo'].upper()
    num = destaque(titulo)
    y = 700
    if num:
        # "COM ATÉ 75% DE DESCONTO" vira "até" + "75%" em destaque + "... COM DESCONTO".
        antes = re.search(r'(ATÉ|A PARTIR DE)\s+' + re.escape(num), titulo)
        if antes:
            y = centro(d, y - 20, [antes.group(1).lower()], fonte(44, False), ASH)
        f = fonte(130)
        y = centro(d, y, quebrar(d, num, f, W - 120, 2), f, OURO, 1.05) + 40
        titulo = re.sub(r'(\s+DE)?\s+((ATÉ|A PARTIR DE)\s+)?' + re.escape(num) + r'(\s+DE\b)?', ' ', ' ' + titulo)
        if titulo.count('BÔNUS') > 1:
            titulo = re.sub(r'\s+COM BÔNUS\s*$', '', titulo)
        titulo = re.sub(r'\s+', ' ', titulo).strip(' -–:,')
    f = fonte(62)
    y = centro(d, y, quebrar(d, titulo, f, W - 160, 4), f, RICE)
    if a.get('ate'):
        centro(d, y + 60, ['Vale até ' + datetime.fromisoformat(a['ate']).strftime('%d/%m')], fonte(44, False), ASH)
    rodape(img)
    return img


def ler_json(p, padrao):
    try:
        return json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return padrao


def escolher(alertas, estado, agora):
    postados = set(estado.get('postados', []))
    recentes = agora - timedelta(hours=HORAS_FRESCO)
    novos = [a for a in alertas if a['id'] not in postados
             and datetime.fromisoformat(a['data'].replace('Z', '+00:00')) >= recentes]
    promos = [a for a in novos if a.get('tipo') == 'promocao']
    promos.sort(key=lambda a: a['data'], reverse=True)  # a mais nova primeiro,
    promos.sort(key=lambda a: not a.get('ultimo_dia'))  # mas as do último dia na frente
    passagens = sorted((a for a in novos if a.get('tipo') != 'promocao'),
                       key=lambda a: milhas(a.get('ida')) + milhas(a.get('volta')))
    ultimo = estado.get('ultimo_tipo')
    ordem = [passagens, promos] if ultimo == 'promocao' else [promos, passagens]
    for lista in ordem:
        if lista:
            return lista[0]
    return None


def gh_api(metodo, caminho, **kw):
    return requests.request(metodo, f'{GRAPH}/{caminho}', timeout=60, **kw)


def publicar(url, token, conta):
    r = gh_api('POST', f'{conta}/media', data={'image_url': url, 'media_type': 'STORIES', 'access_token': token})
    if not r.ok or 'id' not in r.json():
        raise RuntimeError(f'container: {r.status_code} {r.text[:300]}')
    criacao = r.json()['id']
    for _ in range(12):  # espera o Instagram baixar a imagem
        s = gh_api('GET', criacao, params={'fields': 'status_code', 'access_token': token}).json()
        if s.get('status_code') == 'FINISHED':
            break
        if s.get('status_code') == 'ERROR':
            raise RuntimeError(f'imagem recusada: {s}')
        time.sleep(5)
    r = gh_api('POST', f'{conta}/media_publish', data={'creation_id': criacao, 'access_token': token})
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
        print('::warning::Não deu para enviar o story ao repositório agora.')
        return False
    return True


def enviar_imagem(arq, estado):
    """Coloca a imagem no repositório para o Instagram baixar pelo endereço público."""
    if not guardar(estado, 'Imagem do story'):
        return ''
    sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=RAIZ, capture_output=True, text=True).stdout.strip()
    return f'https://raw.githubusercontent.com/{REPO}/{sha}/{arq.relative_to(RAIZ).as_posix()}'


def limpar(estado):
    """Fica só com as imagens dos últimos 2 dias de stories (o story some em 24 h)."""
    manter = set(estado.get('postados', [])[-2 * POR_DIA:])
    for f in PASTA.glob('*.jpg'):
        if f.stem not in manter:
            f.unlink()


def main():
    token = re.sub(r'\s+', '', os.environ.get('INSTAGRAM_TOKEN', ''))
    conta = re.sub(r'\s+', '', os.environ.get('INSTAGRAM_ID', ''))
    teste = '--teste' in sys.argv  # só gera imagens de exemplo (na pasta indicada), não publica
    if not teste and (not token or not conta):
        print('::notice::Instagram ainda não ligado (faltam INSTAGRAM_TOKEN e INSTAGRAM_ID); nada a fazer.')
        return
    agora = datetime.now(timezone.utc)
    estado = ler_json(ESTADO, {})
    hoje = agora.astimezone(BRASILIA).date().isoformat()
    if estado.get('dia') != hoje:
        estado.update(dia=hoje, hoje=0)
    if not teste:
        token = renovar(token, estado, agora)
        guardar(estado, 'Stories: controle atualizado')
        hora = agora.astimezone(BRASILIA).hour
        if not HORARIO[0] <= hora < HORARIO[1]:
            return print('Fora do horário dos stories.')
        if estado['hoje'] >= POR_DIA:
            return print(f'Já foram {POR_DIA} stories hoje.')
        ultimo = estado.get('ultimo_em')
        if ultimo and agora - datetime.fromisoformat(ultimo) < timedelta(minutes=INTERVALO_MIN):
            return print('Ainda cedo para o próximo story.')
    if teste:
        alertas = ler_json(ALERTAS, [])
        promos = [x for x in alertas if x.get('tipo') == 'promocao'][:3]
        passagens = [x for x in alertas if x.get('tipo') != 'promocao'][:2]
        pasta = Path(sys.argv[sys.argv.index('--teste') + 1]) if len(sys.argv) > sys.argv.index('--teste') + 1 else PASTA
        pasta.mkdir(parents=True, exist_ok=True)
        for n, item in enumerate(promos + passagens):
            if item:
                arq = pasta / f"teste-{n}.jpg"
                (imagem_promocao if item.get('tipo') == 'promocao' else imagem_passagem)(item).save(arq, quality=90)
                print(arq)
        return
    a = escolher(ler_json(ALERTAS, []), estado, agora)
    if not a:
        return print('Nenhum alerta novo para os stories.')
    PASTA.mkdir(exist_ok=True)
    limpar(estado)
    arq = PASTA / f"{a['id']}.jpg"
    img = imagem_promocao(a) if a.get('tipo') == 'promocao' else imagem_passagem(a)
    img.save(arq, 'JPEG', quality=90)
    url = enviar_imagem(arq, estado)
    if not url:
        return
    try:
        mid = publicar(url, token, conta)
    except Exception as e:
        print(f'::warning::Story não publicado: {e}')
        mid = None
    estado.setdefault('postados', []).append(a['id'])
    estado['postados'] = estado['postados'][-500:]
    if mid:
        estado['hoje'] += 1
        estado['ultimo_em'] = agora.isoformat()
        estado['ultimo_tipo'] = a.get('tipo') or 'passagem'
        print(f"Story publicado: {a.get('titulo') or a['destino']}")
    guardar(estado, 'Stories: controle atualizado')


if __name__ == '__main__':
    main()
