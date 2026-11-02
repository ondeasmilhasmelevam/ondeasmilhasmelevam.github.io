"""Gera as trilhas dos stories (musicas/trilha-N.m4a): música feita aqui mesmo, nota por nota,
sem sample nem trecho de ninguém, então não tem direito autoral de terceiros nem custo.

Roda uma vez à mão (precisa de numpy e do ffmpeg): python ferramentas/trilhas.py
O instagram.py só usa os arquivos prontos. Cada trilha tem 12 s, no clima lo-fi de viagem:
acordes suaves, baixo, um dedilhado e bateria leve, com começo e fim em fade.
"""
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np

SAIDA = Path(__file__).resolve().parent.parent / 'musicas'
TAXA = 48000
DURACAO = 12.0
NOTAS = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}

# (bpm, acordes: nota fundamental e intervalos em semitons)
TRILHAS = [
    (88, [('C', (0, 4, 7, 11)), ('A', (0, 3, 7, 10)), ('F', (0, 4, 7, 11)), ('G', (0, 4, 7, 9))]),
    (82, [('D', (0, 4, 7, 11)), ('B', (0, 3, 7, 10)), ('G', (0, 4, 7, 11)), ('A', (0, 4, 7, 10))]),
    (92, [('F', (0, 4, 7, 11)), ('E', (0, 3, 7, 10)), ('D', (0, 3, 7, 10)), ('C', (0, 4, 7, 11))]),
    (78, [('A', (0, 3, 7, 10, 14)), ('F', (0, 4, 7, 11)), ('C', (0, 4, 7, 11)), ('G', (0, 4, 7, 9))]),
]


def freq(nota, oitava, semitons=0):
    n = NOTAS[nota] + semitons + 12 * (oitava + 1)
    return 440.0 * 2 ** ((n - 69) / 12)


def envelope(n, ataque, queda):
    t = np.arange(n) / TAXA
    return np.minimum(1, t / max(ataque, 1e-4)) * np.exp(-t / queda)


def somar(faixa, inicio, som):
    i = int(inicio * TAXA)
    fim = min(len(faixa), i + len(som))
    if i < fim:
        faixa[i:fim] += som[:fim - i]


def pad(f, dur):
    t = np.arange(int(dur * TAXA)) / TAXA
    s = sum(a * np.sin(2 * np.pi * f * h * d * t) for h, a in ((1, 1), (2, .25), (3, .08)) for d in (0.998, 1.002))
    sobe = np.minimum(1, t / 0.6)
    desce = np.minimum(1, (dur - t) / 0.5).clip(0)
    return s * sobe * desce * 0.05


def dedilhado(f, dur, rng):
    """Corda dedilhada (Karplus-Strong)."""
    n, p = int(dur * TAXA), max(2, int(TAXA / f))
    buf = rng.uniform(-1, 1, p)
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % p]
        buf[i % p] = 0.5 * (buf[i % p] + buf[(i + 1) % p]) * 0.996
    return out * 0.17


def baixo(f, dur):
    t = np.arange(int(dur * TAXA)) / TAXA
    return (np.sin(2 * np.pi * f * t) + 0.2 * np.sin(4 * np.pi * f * t)) * envelope(len(t), 0.01, 0.35) * 0.24


def bumbo():
    t = np.arange(int(0.35 * TAXA)) / TAXA
    fase = 2 * np.pi * (45 * t + (110 / 18) * (1 - np.exp(-18 * t)))
    return np.sin(fase) * np.exp(-t / 0.12) * 0.4


def ruido(dur, queda, corte, rng, volume):
    n = int(dur * TAXA)
    r = rng.uniform(-1, 1, n)
    if corte:  # passa-alta simples: tira o grave do chiado
        r = r - np.convolve(r, np.ones(corte) / corte, 'same')
    return r * envelope(n, 0.001, queda) * volume


def passa_baixa(x, a):
    y = np.empty_like(x)
    acc = 0.0
    for i, v in enumerate(x):
        acc += a * (v - acc)
        y[i] = acc
    return y


def gerar(n, bpm, acordes):
    rng = np.random.default_rng(7 + n)
    faixa = np.zeros(int(DURACAO * TAXA))
    tempo = 60 / bpm
    compasso = 4 * tempo
    for c in range(int(DURACAO / compasso) + 1):
        raiz, intervalos = acordes[c % len(acordes)]
        ini = c * compasso
        for s in intervalos:
            somar(faixa, ini, pad(freq(raiz, 3, s), compasso + 0.4))
        for b in (0, 2.5):
            somar(faixa, ini + b * tempo, baixo(freq(raiz, 2), tempo * 1.4))
        ordem = [intervalos[i % len(intervalos)] for i in (0, 2, 1, 3, 2, 1, 3, 2)]
        for k, s in enumerate(ordem):
            if rng.random() < 0.85:
                somar(faixa, ini + k * tempo / 2 + rng.uniform(0, 0.015), dedilhado(freq(raiz, 4, s), 0.9, rng))
        for b in (0, 2.5):
            somar(faixa, ini + b * tempo, bumbo())
        for b in (1, 3):
            somar(faixa, ini + b * tempo, ruido(0.25, 0.07, 8, rng, 0.16))
        for k in range(8):
            somar(faixa, ini + k * tempo / 2 + (0.03 if k % 2 else 0), ruido(0.06, 0.015, 3, rng, 0.05 if k % 2 else 0.08))
    faixa = passa_baixa(faixa, 0.5)  # som mais quente, de fita
    faixa += rng.normal(0, 0.002, len(faixa)) * (rng.random(len(faixa)) < 0.002) * 40  # estalinhos de vinil
    t = np.arange(len(faixa)) / TAXA
    faixa *= np.minimum(1, t / 0.4) * np.minimum(1, (DURACAO - t) / 1.8).clip(0)
    faixa = faixa / np.max(np.abs(faixa)) * 0.85
    estereo = np.stack([faixa, np.roll(faixa, 240) * 0.96 + faixa * 0.04], axis=1)
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / 'x.wav'
        with wave.open(str(wav), 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(TAXA)
            w.writeframes((estereo * 32767).astype('<i2').tobytes())
        destino = SAIDA / f'trilha-{n}.m4a'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-c:a', 'aac', '-b:a', '128k', str(destino)], check=True)
    print(destino.name)


if __name__ == '__main__':
    SAIDA.mkdir(exist_ok=True)
    for n, (bpm, acordes) in enumerate(TRILHAS, 1):
        gerar(n, bpm, acordes)
