"""Guias de salas VIP e de programas de fidelidade (dados/guias-milhas.json).

Roda junto com o Guia de destinos (.github/workflows/guias.yml). Lê a página de cartões e
milhas do Melhores Destinos, pega os links das listas "Guias de Salas VIP" e "Guias dos
programas de fidelidade", baixa o texto de cada artigo e pede ao Claude que o reescreva com
as nossas palavras, num formato fixo. O Felipe tem autorização da plataforma para usar o
conteúdo; ele vai sem crédito e reescrito, nunca copiado.

Como no guias.py, só reescreve o artigo cujo texto mudou (guarda um hash dele).
"""
import hashlib
import html
import json
import os
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

PAGINA = 'https://www.melhoresdestinos.com.br/cartoes-e-milhas'
LISTAS = {'salas': 'Guias de Salas VIP', 'programas': 'Guias dos programas de fidelidade'}
SAIDA = Path(__file__).resolve().parent.parent / 'dados' / 'guias-milhas.json'
MODELO = 'claude-sonnet-5-5'
SIMULTANEOS = 4
SISTEMA = """Você escreve guias para o site Onde as Milhas Me Levam (milhas, pontos, cartões e passagens aéreas).
Recebe o texto de um artigo de outro site, sobre as salas VIP de um aeroporto ou sobre um programa de fidelidade,
e devolve um guia NOVO, com as suas palavras, no formato pedido.
Regras:
- Reescreva tudo: não copie frases nem expressões marcantes e não cite o site de origem, autores, leitores ou experiências pessoais do autor.
- Use só fatos do texto de origem (nomes, valores, regras, categorias, horários). Não invente nada.
- "titulo": curto, ex.: "Salas VIP do aeroporto de Guarulhos" ou "Categorias do LATAM Pass".
- "assunto": o nome do aeroporto (com a cidade) ou do programa, ex.: "LATAM Pass", "Livelo", "Guarulhos (GRU)".
- "iata": o código IATA do aeroporto; vazio para programa.
- "categorias": para programa, cada categoria/status com o "requisito" para chegar nela e os "beneficios" (frases curtas); vazio para sala VIP.
- "salas": para aeroporto, cada sala com terminal, onde fica, horário e como entrar (cartões, programas como LoungeKey, Priority Pass,
  DragonPass, status de companhia, pagando); vazio para programa. Deixe vazio o campo que o texto não informa.
- "secoes": outros assuntos úteis (como acumular, como usar, validade dos pontos, transferências, como chegar na sala...),
  cada uma com "titulo", um "texto" de 1 a 3 frases e "itens" curtos quando for lista. Até 6 seções.
- "dicas": 3 a 5 dicas práticas.
- Nada de links, cupons, chamadas como "clique aqui", "leia mais" ou "peça o seu cartão".
- Português do Brasil, frases curtas e diretas. Sem emojis."""
TEXTOS = {'type': 'array', 'items': {'type': 'string'}}
ESQUEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['titulo', 'assunto', 'iata', 'resumo', 'categorias', 'salas', 'secoes', 'dicas'],
    'properties': {
        'titulo': {'type': 'string'},
        'assunto': {'type': 'string'},
        'iata': {'type': 'string'},
        'resumo': {'type': 'string', 'description': '2 ou 3 frases'},
        'categorias': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['nome', 'requisito', 'beneficios'],
            'properties': {'nome': {'type': 'string'}, 'requisito': {'type': 'string'}, 'beneficios': TEXTOS}}},
        'salas': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['nome', 'terminal', 'onde', 'horario', 'como_entrar'],
            'properties': {'nome': {'type': 'string'}, 'terminal': {'type': 'string'}, 'onde': {'type': 'string'},
                           'horario': {'type': 'string'}, 'como_entrar': TEXTOS}}},
        'secoes': {'type': 'array', 'items': {
            'type': 'object', 'additionalProperties': False, 'required': ['titulo', 'texto', 'itens'],
            'properties': {'titulo': {'type': 'string'}, 'texto': {'type': 'string'}, 'itens': TEXTOS}}},
        'dicas': TEXTOS,
    },
}


def baixar(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (OndeAsMilhasMeLevam guias)'})
    return urllib.request.urlopen(req, timeout=40).read().decode('utf-8', 'replace')


def links_das_listas():
    """{'salas': [url...], 'programas': [url...]} na ordem da página."""
    pagina = baixar(PAGINA)
    saida = {}
    for chave, titulo in LISTAS.items():
        ini = pagina.find(titulo)
        if ini < 0:
            raise RuntimeError(f'a página mudou: não achei "{titulo}"')
        fim = pagina.find('<h2', ini + len(titulo))
        trecho = pagina[ini:fim if fim > 0 else len(pagina)]
        urls = []
        for u in re.findall(r'href="(https://www\.melhores(?:destinos|cartoes)\.com\.br/[^"#?]+)"', trecho):
            if u not in urls:
                urls.append(u)
        saida[chave] = urls
    return saida


def texto_do_artigo(pagina):
    """Texto de dentro do <article>, sem menus, scripts nem caixas de propaganda."""
    ini = pagina.find('<article')
    fim = pagina.find('</article>', ini)
    trecho = pagina[ini:fim] if ini >= 0 and fim > 0 else pagina
    trecho = re.sub(r'<(script|style|noscript|form|figure|aside)[^>]*>.*?</\1>', ' ', trecho, flags=re.S)
    trecho = re.sub(r'<(h[1-4]|p|li|tr)[^>]*>', '\n', trecho)
    trecho = re.sub(r'</t[dh]>', ' | ', trecho)
    texto = html.unescape(re.sub(r'<[^>]+>', ' ', trecho))
    texto = re.sub(r'[ \t]+', ' ', texto)
    return re.sub(r'\n\s*\n+', '\n', texto).strip()[:40000]


def reescrever(cliente, tipo, texto):
    with cliente.beta.messages.stream(
            model=MODELO, max_tokens=12000, system=SISTEMA,
            betas=['server-side-fallback-2026-07-01'], fallbacks='default',
            output_config={'effort': 'low', 'format': {'type': 'json_schema', 'schema': ESQUEMA}},
            messages=[{'role': 'user', 'content': f'Tipo: {"salas VIP de aeroporto" if tipo == "salas" else "programa de fidelidade"}\n\nTexto de origem:\n{texto}'}]) as fluxo:
        r = fluxo.get_final_message()
    if r.stop_reason != 'end_turn':
        return None
    g = json.loads(next(b.text for b in r.content if b.type == 'text'))
    limpa = lambda xs: [x.strip() for x in xs if x.strip()]
    g['dicas'] = limpa(g['dicas'])[:5]
    g['secoes'] = [s for s in g['secoes'] if s['titulo'].strip() and (s['texto'].strip() or limpa(s['itens']))][:6]
    iata = g['iata'].strip().upper()
    g['iata'] = iata if re.fullmatch(r'[A-Z]{3}', iata) else ''
    if len(g['resumo']) < 40:
        return None
    return g


def main():
    chave = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not chave:
        print('::warning::Sem ANTHROPIC_API_KEY; os guias de salas e programas não foram atualizados.')
        return
    import anthropic
    import concurrent.futures as cf
    cliente = anthropic.Anthropic(api_key=chave, timeout=180)
    try:
        velho = json.loads(SAIDA.read_text(encoding='utf-8'))
        antigos = {g['url']: g for k in LISTAS for g in velho.get(k, [])}
    except Exception:
        antigos = {}
    listas = links_das_listas()
    print({k: len(v) for k, v in listas.items()})
    resultado, pendentes = {}, []
    for tipo, urls in listas.items():
        for url in urls:
            try:
                texto = texto_do_artigo(baixar(url))
            except Exception as e:
                print(f'Falhou {url}: {e}', file=sys.stderr)
                if url in antigos:
                    resultado[url] = antigos[url]
                continue
            marca = hashlib.sha256(texto.encode()).hexdigest()[:16]
            if url in antigos and antigos[url].get('marca') == marca:
                resultado[url] = antigos[url]
            elif len(texto) >= 400:
                pendentes.append((tipo, url, texto, marca))

    def fazer(item):
        tipo, url, texto, marca = item
        try:
            return item, reescrever(cliente, tipo, texto)
        except (anthropic.APIStatusError, anthropic.APIConnectionError, ValueError, StopIteration, KeyError) as e:
            print(f'::warning::Não reescreveu {url}: {type(e).__name__}: {str(e)[:300]}')
            return item, None

    feitos = 0
    with cf.ThreadPoolExecutor(SIMULTANEOS) as ex:
        for (tipo, url, texto, marca), g in ex.map(fazer, pendentes):
            if g:
                feitos += 1
                resultado[url] = {'url': url, 'marca': marca, 'atualizado': date.today().isoformat(), **g}
            elif url in antigos:
                resultado[url] = antigos[url]
    # O endereço de origem fica só para saber o que mudou; o site não mostra link.
    saida = {'atualizado': date.today().isoformat(), **{k: [resultado[u] for u in urls if u in resultado] for k, urls in listas.items()}}
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps(saida, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{sum(len(v) for k, v in saida.items() if k in LISTAS)} guias no arquivo; {feitos} reescritos agora.')


if __name__ == '__main__':
    main()
