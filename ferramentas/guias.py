"""Monta o Guia de destinos (dados/guias.json) a partir dos guias do Melhores Destinos.

Roda sozinho no GitHub (ver .github/workflows/guias.yml). Lê a lista de destinos
nacionais e internacionais, baixa o texto de cada guia e pede ao Claude que o
reescreva com as nossas palavras, num formato fixo (resumo, melhor época, quantos
dias, destaques, dicas, aeroporto). O Felipe tem autorização da plataforma para usar
o conteúdo; ele vai sem crédito e reescrito, nunca copiado.

Só reescreve o que mudou: guarda um resumo (hash) do texto de origem e, se for igual
ao da última vez, mantém o guia que já existe. Cada execução reescreve no máximo
MAXIMO_POR_VEZ guias, para a conta e o tempo ficarem sob controle.
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

INDICE = 'https://guia.melhoresdestinos.com.br/'
SAIDA = Path(__file__).resolve().parent.parent / 'dados' / 'guias.json'
MAXIMO_POR_VEZ = int(os.environ.get('GUIAS_POR_VEZ') or 40)
# Links do índice que não são guia de destino (artigos, hotéis, ingressos...).
FORA = re.compile(r'^(blog/|categorias/|onde-ficar|ingresso|cupom|que-moeda|passeios|melhores-|dicas|seguro|chip|aluguel|hoteis|o-que-fazer)')
MODELO = 'claude-opus-5-5'
SISTEMA = """Você escreve o Guia de destinos do site Onde as Milhas Me Levam (milhas, pontos e passagens aéreas).
Recebe o texto de um guia de viagem de outro site e devolve um guia NOVO, com as suas palavras, no formato pedido.
Regras:
- Reescreva tudo: não copie frases nem expressões marcantes do texto de origem e não cite o site de origem, autores ou leitores.
- Use só fatos que estão no texto de origem (clima, época, atrações, documentos, moeda). Não invente preços, horários nem nomes.
- "aeroporto_iata": o código IATA do aeroporto mais usado para chegar ao destino (pode ser de uma cidade próxima, ex.: Jericoacoara -> JJD). Use o seu conhecimento se o texto não disser.
- "regiao": no Brasil, a região do país (Norte, Nordeste, Centro-Oeste, Sudeste, Sul); fora, o continente ou a região (Caribe, América do Sul, América do Norte, Europa, Ásia, África, Oriente Médio, Oceania).
- Português do Brasil, frases curtas e diretas, tom de quem já viajou e quer ajudar. Sem emojis."""
ESQUEMA = {
    'type': 'object', 'additionalProperties': False,
    'required': ['regiao', 'pais', 'resumo', 'melhor_epoca', 'quantos_dias', 'destaques', 'dicas', 'aeroporto_iata', 'moeda', 'idioma', 'documentos'],
    'properties': {
        'regiao': {'type': 'string'},
        'pais': {'type': 'string', 'description': 'País do destino, em português'},
        'resumo': {'type': 'string', 'description': '2 ou 3 frases sobre por que ir'},
        'melhor_epoca': {'type': 'string', 'description': 'Quando ir e por quê, em 1 ou 2 frases'},
        'quantos_dias': {'type': 'string', 'description': 'Ex.: 4 a 5 dias'},
        'destaques': {'type': 'array', 'items': {'type': 'string'}, 'description': '4 a 6 atrações ou experiências, uma frase curta cada'},
        'dicas': {'type': 'array', 'items': {'type': 'string'}, 'description': '3 a 5 dicas práticas (transporte, dinheiro, clima, reservas)'},
        'aeroporto_iata': {'type': 'string'},
        'moeda': {'type': 'string', 'description': 'Moeda local; vazio no Brasil'},
        'idioma': {'type': 'string', 'description': 'Idioma local; vazio no Brasil'},
        'documentos': {'type': 'string', 'description': 'Documento para brasileiros entrarem (passaporte, RG, visto); vazio no Brasil'},
    },
}


def baixar(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (OndeAsMilhasMeLevam guias)'})
    return urllib.request.urlopen(req, timeout=40).read().decode('utf-8', 'replace')


def destinos():
    """[(slug, nome, 'nacional'|'internacional')] na ordem do índice."""
    pagina = baixar(INDICE)
    ini_nac = pagina.find('id="destinos-nacionais"')
    ini_int = pagina.find('id="destinos-internacionais"')
    if ini_nac < 0 or ini_int < 0:
        raise RuntimeError('o índice mudou: não achei as seções de destinos')
    lista, vistos = [], set()
    for m in re.finditer(r'<a[^>]+href="https://guia\.melhoresdestinos\.com\.br/([^"#?]+\.html)"[^>]*>(.*?)</a>', pagina, re.S):
        slug, nome = m.group(1), re.sub(r'<[^>]+>|\s+', ' ', html.unescape(m.group(2))).strip()
        if m.start() < ini_nac or not nome or FORA.match(slug) or slug in vistos:
            continue
        vistos.add(slug)
        lista.append((slug, nome, 'internacional' if m.start() > ini_int else 'nacional'))
    return lista


def texto_do_guia(pagina):
    """Texto principal: do título (h1) até a lista de outros destinos do rodapé."""
    ini = pagina.find('<h1')
    fim = min([i for i in (pagina.find('Veja tudo sobre', ini), pagina.find('Destino Internacionais', ini)) if i > 0] or [len(pagina)])
    trecho = re.sub(r'<(script|style)[^>]*>.*?</\1>', ' ', pagina[ini:fim], flags=re.S)
    trecho = re.sub(r'<(h[1-4]|p|li)[^>]*>', '\n', trecho)
    texto = html.unescape(re.sub(r'<[^>]+>', ' ', trecho))
    texto = re.sub(r'[ \t]+', ' ', texto)
    return re.sub(r'\n\s*\n+', '\n', texto).strip()[:16000]


def reescrever(cliente, anthropic, nome, tipo, texto):
    r = cliente.beta.messages.create(
        model=MODELO, max_tokens=6000, system=SISTEMA,
        betas=['server-side-fallback-2026-07-01'], fallbacks='default',
        output_config={'effort': 'low', 'format': {'type': 'json_schema', 'schema': ESQUEMA}},
        messages=[{'role': 'user', 'content': f'Destino: {nome} ({tipo})\n\nTexto de origem:\n{texto}'}])
    if r.stop_reason != 'end_turn':
        return None
    saida = json.loads(next(b.text for b in r.content if b.type == 'text'))
    # Conferência simples: listas com tamanho razoável e IATA com 3 letras.
    saida['destaques'] = [d.strip() for d in saida['destaques'] if d.strip()][:6]
    saida['dicas'] = [d.strip() for d in saida['dicas'] if d.strip()][:5]
    iata = saida['aeroporto_iata'].strip().upper()
    saida['aeroporto_iata'] = iata if re.fullmatch(r'[A-Z]{3}', iata) else ''
    if len(saida['resumo']) < 40 or len(saida['destaques']) < 2:
        return None
    return saida


def main():
    chave = os.environ.get('ANTHROPIC_API_KEY', '').strip()
    if not chave:
        print('::warning::Sem ANTHROPIC_API_KEY; o guia não foi atualizado.')
        return
    import anthropic
    cliente = anthropic.Anthropic(api_key=chave, timeout=180)
    try:
        antigos = {g['slug']: g for g in json.loads(SAIDA.read_text(encoding='utf-8'))['destinos']}
    except Exception:
        antigos = {}
    lista = destinos()
    print(f'{len(lista)} destinos no índice ({sum(1 for d in lista if d[2] == "nacional")} nacionais).')
    novos, feitos = [], 0
    for slug, nome, tipo in lista:
        velho = antigos.get(slug)
        try:
            texto = texto_do_guia(baixar(INDICE + slug))
        except Exception as e:
            print(f'Falhou {nome}: {e}', file=sys.stderr)
            if velho:
                novos.append(velho)
            continue
        marca = hashlib.sha256(texto.encode()).hexdigest()[:16]
        if velho and velho.get('marca') == marca:
            novos.append({**velho, 'nome': velho['nome']})
            continue
        if feitos >= MAXIMO_POR_VEZ or len(texto) < 400:
            if velho:
                novos.append(velho)
            continue
        try:
            g = reescrever(cliente, anthropic, nome, tipo, texto)
        except (anthropic.APIStatusError, anthropic.APIConnectionError, ValueError, StopIteration, KeyError) as e:
            print(f'::warning::Não reescreveu {nome}: {type(e).__name__}')
            g = None
        if g:
            feitos += 1
            # O índice deles põe alguns destinos do Brasil no fim da lista internacional: vale o país.
            tipo = 'nacional' if g['pais'].strip().lower() == 'brasil' else 'internacional'
            novos.append({'slug': slug, 'nome': nome.title() if nome.isupper() else nome, 'tipo': tipo, 'marca': marca,
                          'atualizado': date.today().isoformat(), **g})
        elif velho:
            novos.append(velho)
    SAIDA.parent.mkdir(exist_ok=True)
    SAIDA.write_text(json.dumps({'atualizado': date.today().isoformat(), 'destinos': novos}, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'{len(novos)} guias no arquivo; {feitos} reescritos agora.')


if __name__ == '__main__':
    main()
