/* Lê a planilha pública do Google no formato .xlsx (que traz as fórmulas)
   e refaz as contas trocando células — aqui, o gasto mensal do visitante.
   Assim, se a planilha mudar uma regra (anuidade, faixa de pontos, valor do
   milheiro), a página acompanha sem precisar mexer no código. */
(function (global) {
  'use strict';

  class ErroCelula extends Error {
    constructor(codigo) { super(codigo); this.codigo = codigo; }
  }
  // Algo que o motor não sabe calcular: a célula volta ao valor salvo na planilha.
  class NaoSuportado extends Error {}

  const colNum = s => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
  const colTxt = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - 1 - m) / 26; } return s; };
  const partes = ref => { const m = /^([A-Z]+)(\d+)$/.exec(ref.replace(/\$/g, '')); return { c: colNum(m[1]), r: +m[2] }; };

  const xml = txt => new DOMParser().parseFromString(txt, 'application/xml');
  const filho = (el, nome) => { if (!el) return null; for (const f of el.children) if (f.localName === nome) return f; return null; };
  const filhos = (el, nome) => el ? [...el.children].filter(f => f.localName === nome) : [];

  /* ---------- Fórmulas: tokens, árvore e cálculo ---------- */

  const RE = {
    esp: /^\s+/,
    str: /^"((?:[^"]|"")*)"/,
    ref: /^(?:('(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(\$?[A-Z]{1,3}\$?\d+)(?::(\$?[A-Z]{1,3}\$?\d+))?(?![\w(])/,
    num: /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/,
    nome: /^[A-Za-z_][\w.]*/,
    op: /^(?:>=|<=|<>|[-+*/^&=<>%(),;])/
  };

  function tokens(f) {
    const out = [];
    let i = 0;
    while (i < f.length) {
      const r = f.slice(i);
      let m;
      if ((m = RE.esp.exec(r))) { i += m[0].length; continue; }
      if ((m = RE.str.exec(r))) out.push({ t: 'str', v: m[1].replace(/""/g, '"'), raw: m[0] });
      else if ((m = RE.ref.exec(r))) out.push({ t: 'ref', aba: m[1] ? m[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null, a: m[2], b: m[3] || null, raw: m[0] });
      else if ((m = RE.num.exec(r))) out.push({ t: 'num', v: parseFloat(m[0]), raw: m[0] });
      else if ((m = RE.nome.exec(r))) out.push({ t: 'nome', v: m[0].toUpperCase(), raw: m[0] });
      else if ((m = RE.op.exec(r))) out.push({ t: 'op', v: m[0] === ';' ? ',' : m[0], raw: m[0] });
      else throw new NaoSuportado('caractere ' + r[0]);
      i += m[0].length;
    }
    return out;
  }

  // Fórmula compartilhada: a planilha guarda só a primeira e as outras são
  // "a mesma, deslocada". Refaz o deslocamento das referências sem $.
  function deslocar(f, dl, dc) {
    const mover = ref => ref.replace(/(\$?)([A-Z]+)(\$?)(\d+)/, (_, cf, c, lf, l) =>
      cf + (cf ? c : colTxt(colNum(c) + dc)) + lf + (lf ? l : +l + dl));
    return tokens(f).map(tk => {
      if (tk.t !== 'ref') return tk.raw;
      const prefixo = tk.raw.slice(0, tk.raw.length - (tk.a.length + (tk.b ? tk.b.length + 1 : 0)));
      return prefixo + mover(tk.a) + (tk.b ? ':' + mover(tk.b) : '');
    }).join(' ');
  }

  function analisar(f) {
    const tk = tokens(f);
    let p = 0;
    const op = v => tk[p] && tk[p].t === 'op' && tk[p].v === v;
    const esperar = v => { if (!op(v)) throw new NaoSuportado('esperava ' + v); p++; };
    const COMP = ['=', '<>', '<', '>', '<=', '>='];

    function comp() { let a = conc(); while (tk[p] && tk[p].t === 'op' && COMP.includes(tk[p].v)) { const o = tk[p++].v; a = { k: 'bin', o, a, b: conc() }; } return a; }
    function conc() { let a = soma(); while (op('&')) { p++; a = { k: 'bin', o: '&', a, b: soma() }; } return a; }
    function soma() { let a = mult(); while (op('+') || op('-')) { const o = tk[p++].v; a = { k: 'bin', o, a, b: mult() }; } return a; }
    function mult() { let a = pot(); while (op('*') || op('/')) { const o = tk[p++].v; a = { k: 'bin', o, a, b: pot() }; } return a; }
    function pot() { let a = un(); while (op('^')) { p++; a = { k: 'bin', o: '^', a, b: un() }; } return a; }
    function un() { if (op('-')) { p++; return { k: 'neg', a: un() }; } if (op('+')) { p++; return un(); } return pos(); }
    function pos() { let a = prim(); while (op('%')) { p++; a = { k: 'pct', a }; } return a; }
    function prim() {
      const t = tk[p++];
      if (!t) throw new NaoSuportado('fim inesperado');
      if (t.t === 'num' || t.t === 'str') return { k: 'val', v: t.v };
      if (t.t === 'ref') return { k: t.b ? 'faixa' : 'ref', aba: t.aba, a: t.a.replace(/\$/g, ''), b: t.b && t.b.replace(/\$/g, '') };
      if (t.t === 'nome') {
        if (op('(')) {
          p++;
          const args = [];
          if (!op(')')) {
            do { args.push(op(',') || op(')') ? { k: 'val', v: null } : comp()); } while (op(',') && ++p);
          }
          esperar(')');
          return { k: 'fn', n: t.v, args };
        }
        if (t.v === 'TRUE') return { k: 'val', v: true };
        if (t.v === 'FALSE') return { k: 'val', v: false };
        throw new NaoSuportado('nome ' + t.v);
      }
      if (t.t === 'op' && t.v === '(') { const e = comp(); esperar(')'); return e; }
      throw new NaoSuportado('símbolo ' + t.raw);
    }

    const arvore = comp();
    if (p < tk.length) throw new NaoSuportado('sobrou ' + tk[p].raw);
    return arvore;
  }

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof ErroCelula) throw v;
    if (Array.isArray(v)) throw new ErroCelula('#VALUE!');
    const m = /^([-+]?\d+(?:[.,]\d+)?)(%?)$/.exec(String(v).replace(/\s/g, ''));
    if (m) { const n = parseFloat(m[1].replace(',', '.')); return m[2] ? n / 100 : n; }
    throw new ErroCelula('#VALUE!');
  }
  const texto = v => v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
  function verdade(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (v === null || v === '') return false;
    if (v instanceof ErroCelula) throw v;
    const s = String(v).toUpperCase();
    if (s === 'TRUE') return true;
    if (s === 'FALSE') return false;
    throw new ErroCelula('#VALUE!');
  }
  function comparar(o, a, b) {
    if (a === null) a = typeof b === 'string' ? '' : 0;
    if (b === null) b = typeof a === 'string' ? '' : 0;
    const peso = x => typeof x === 'number' ? 1 : typeof x === 'string' ? 2 : 3;
    let d;
    if (peso(a) !== peso(b)) d = peso(a) - peso(b);
    else if (typeof a === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); d = x < y ? -1 : x > y ? 1 : 0; }
    else d = Number(a) - Number(b);
    return { '=': d === 0, '<>': d !== 0, '<': d < 0, '>': d > 0, '<=': d <= 0, '>=': d >= 0 }[o];
  }
  const numeros = lista => {
    const out = [];
    for (const v of lista) {
      if (Array.isArray(v)) { for (const x of v) { if (x instanceof ErroCelula) throw x; if (typeof x === 'number') out.push(x); } }
      else out.push(num(v));
    }
    return out;
  };
  const arred = (n, d, modo) => { const f = 10 ** d; const x = Math.abs(n) * f; return Math.sign(n) * (modo === 'cima' ? Math.ceil(x - 1e-9) : modo === 'baixo' ? Math.floor(x + 1e-9) : Math.round(x)) / f; };

  const FUNCOES = {
    IF: a => verdade(a[0]()) ? (a[1] ? a[1]() : true) : (a[2] ? a[2]() : false),
    IFS: a => { for (let i = 0; i + 1 < a.length; i += 2) if (verdade(a[i]())) return a[i + 1](); throw new ErroCelula('#N/A'); },
    IFERROR: a => { try { const v = a[0](); if (v instanceof ErroCelula) throw v; return v; } catch (e) { if (e instanceof ErroCelula) return a[1] ? a[1]() : ''; throw e; } },
    IFNA: a => { try { return a[0](); } catch (e) { if (e instanceof ErroCelula && e.codigo === '#N/A') return a[1] ? a[1]() : ''; throw e; } },
    AND: a => a.every(x => { const v = x(); return Array.isArray(v) ? v.every(verdade) : verdade(v); }),
    OR: a => a.some(x => { const v = x(); return Array.isArray(v) ? v.some(verdade) : verdade(v); }),
    NOT: a => !verdade(a[0]()),
    SUM: a => numeros(a.map(x => x())).reduce((s, n) => s + n, 0),
    MIN: a => { const n = numeros(a.map(x => x())); return n.length ? Math.min(...n) : 0; },
    MAX: a => { const n = numeros(a.map(x => x())); return n.length ? Math.max(...n) : 0; },
    AVERAGE: a => { const n = numeros(a.map(x => x())); if (!n.length) throw new ErroCelula('#DIV/0!'); return n.reduce((s, x) => s + x, 0) / n.length; },
    ABS: a => Math.abs(num(a[0]())),
    INT: a => Math.floor(num(a[0]())),
    ROUND: a => arred(num(a[0]()), a[1] ? num(a[1]()) : 0),
    ROUNDUP: a => arred(num(a[0]()), a[1] ? num(a[1]()) : 0, 'cima'),
    ROUNDDOWN: a => arred(num(a[0]()), a[1] ? num(a[1]()) : 0, 'baixo'),
    // Função exclusiva do Google (ex.: GOOGLEFINANCE). O arquivo baixado traz
    // o resultado dela como segundo argumento do IFERROR em volta.
    '__XLUDF.DUMMYFUNCTION': () => { throw new ErroCelula('#N/A'); }
  };

  class Calculo {
    // trocas: { 'NomeDaAba!E56': 5000 }
    constructor(livro, trocas) {
      this.livro = livro;
      this.trocas = trocas || {};
      this.memo = new Map();
      this.andamento = new Set();
    }

    valor(aba, ref) {
      const v = this.celula(aba, ref);
      return v;
    }

    celula(aba, ref) {
      const chave = aba.nome + '!' + ref;
      if (chave in this.trocas) return this.trocas[chave];
      if (this.memo.has(chave)) { const v = this.memo.get(chave); if (v instanceof ErroCelula) throw v; return v; }
      const c = aba.celulas.get(ref);
      if (!c) return null;
      if (!c.f) { if (c.v instanceof ErroCelula) throw c.v; return c.v; }
      if (this.andamento.has(chave)) throw new ErroCelula('#REF!');
      this.andamento.add(chave);
      let v;
      try {
        if (c.arvore === undefined) { try { c.arvore = analisar(c.f); } catch (e) { c.arvore = null; } }
        if (!c.arvore) throw new NaoSuportado('fórmula');
        v = this.avaliar(c.arvore, aba);
        if (Array.isArray(v)) v = v[0] ?? null;
      } catch (e) {
        if (e instanceof NaoSuportado) v = c.v;
        else if (e instanceof ErroCelula) v = e;
        else throw e;
      } finally {
        this.andamento.delete(chave);
      }
      this.memo.set(chave, v);
      if (v instanceof ErroCelula) throw v;
      return v;
    }

    avaliar(n, aba) {
      switch (n.k) {
        case 'val': return n.v;
        case 'ref': return this.celula(this.alvo(n.aba, aba), n.a);
        case 'faixa': {
          const alvo = this.alvo(n.aba, aba), a = partes(n.a), b = partes(n.b), out = [];
          for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++)
            for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) {
              try { out.push(this.celula(alvo, colTxt(c) + r)); } catch (e) { if (e instanceof ErroCelula) out.push(e); else throw e; }
            }
          return out;
        }
        case 'neg': return -num(this.avaliar(n.a, aba));
        case 'pct': return num(this.avaliar(n.a, aba)) / 100;
        case 'bin': {
          const a = this.avaliar(n.a, aba), b = this.avaliar(n.b, aba);
          if (a instanceof ErroCelula) throw a;
          if (b instanceof ErroCelula) throw b;
          switch (n.o) {
            case '&': return texto(a) + texto(b);
            case '+': return num(a) + num(b);
            case '-': return num(a) - num(b);
            case '*': return num(a) * num(b);
            case '/': { const d = num(b); if (d === 0) throw new ErroCelula('#DIV/0!'); return num(a) / d; }
            case '^': return num(a) ** num(b);
            default: return comparar(n.o, a, b);
          }
        }
        case 'fn': {
          const f = FUNCOES[n.n];
          if (!f) throw new NaoSuportado('função ' + n.n);
          return f(n.args.map(x => () => this.avaliar(x, aba)));
        }
      }
      throw new NaoSuportado('nó ' + n.k);
    }

    alvo(nome, atual) {
      if (!nome) return atual;
      const a = this.livro.aba(nome);
      if (!a) throw new ErroCelula('#REF!');
      return a;
    }
  }

  /* ---------- Leitura do arquivo .xlsx ---------- */

  function lerEstilos(doc) {
    if (!doc) return [];
    const cor = el => { const rgb = el && el.getAttribute('rgb'); return rgb ? '#' + rgb.slice(-6) : null; };
    const fills = filhos(doc.getElementsByTagName('fills')[0], 'fill').map(f => {
      const p = filho(f, 'patternFill');
      return p && p.getAttribute('patternType') === 'solid' ? cor(filho(p, 'fgColor')) : null;
    });
    const fonts = filhos(doc.getElementsByTagName('fonts')[0], 'font').map(f => cor(filho(f, 'color')));
    const formatos = {};
    for (const n of doc.getElementsByTagName('numFmt')) formatos[n.getAttribute('numFmtId')] = n.getAttribute('formatCode');
    return filhos(doc.getElementsByTagName('cellXfs')[0], 'xf').map(x => {
      const id = x.getAttribute('numFmtId');
      const fmt = formatos[id] || { 9: '0%', 10: '0.00%' }[id] || '';
      return { fundo: fills[+x.getAttribute('fillId')] || null, texto: fonts[+x.getAttribute('fontId')] || null, porcento: fmt.includes('%') };
    });
  }

  async function abrir(buffer) {
    const zip = await JSZip.loadAsync(buffer);
    const ler = async caminho => { const f = zip.file(caminho); return f ? xml(await f.async('string')) : null; };
    const relacoes = async caminho => {
      const doc = await ler(caminho), out = {};
      if (doc) for (const r of doc.getElementsByTagName('Relationship')) out[r.getAttribute('Id')] = r.getAttribute('Target');
      return out;
    };

    const wb = await ler('xl/workbook.xml');
    if (!wb || !wb.getElementsByTagName('sheet').length) throw new Error('Arquivo não parece uma planilha');
    const relWb = await relacoes('xl/_rels/workbook.xml.rels');
    const docStrings = await ler('xl/sharedStrings.xml');
    const strings = docStrings ? filhos(docStrings.documentElement, 'si').map(si =>
      [...si.getElementsByTagName('t')].filter(t => t.parentNode.localName !== 'rPh').map(t => t.textContent).join('')) : [];
    const estilos = lerEstilos(await ler('xl/styles.xml'));

    const abas = [];
    for (const s of wb.getElementsByTagName('sheet')) {
      const alvo = relWb[s.getAttribute('r:id')];
      if (!alvo) continue;
      const caminho = alvo.startsWith('/') ? alvo.slice(1) : 'xl/' + alvo;
      const doc = await ler(caminho);
      if (!doc) continue;

      const celulas = new Map(), mestres = {}, pendentes = [];
      let maxLinha = 0;
      for (const c of doc.getElementsByTagName('c')) {
        const ref = c.getAttribute('r'), t = c.getAttribute('t');
        const fEl = filho(c, 'f'), vEl = filho(c, 'v');
        let v = null;
        if (t === 'inlineStr') v = filho(c, 'is')?.textContent ?? null;
        else if (vEl) {
          const bruto = vEl.textContent;
          v = t === 's' ? strings[+bruto] : t === 'str' ? bruto : t === 'b' ? bruto === '1' : t === 'e' ? new ErroCelula(bruto) : parseFloat(bruto);
        }
        const cel = { v, s: +(c.getAttribute('s') || 0) };
        if (fEl) {
          const txt = fEl.textContent;
          if (fEl.getAttribute('t') === 'shared') {
            if (txt) { mestres[fEl.getAttribute('si')] = { f: txt, ref }; cel.f = txt; }
            else pendentes.push([cel, fEl.getAttribute('si'), ref]);
          } else if (txt) cel.f = txt;
        }
        celulas.set(ref, cel);
        maxLinha = Math.max(maxLinha, partes(ref).r);
      }
      for (const [cel, si, ref] of pendentes) {
        const m = mestres[si];
        if (!m) continue;
        const a = partes(m.ref), b = partes(ref);
        try { cel.f = deslocar(m.f, b.r - a.r, b.c - a.c); } catch (e) { /* fica o valor salvo */ }
      }

      const links = {};
      const nomeArq = caminho.split('/').pop();
      const relAba = await relacoes(caminho.replace(nomeArq, '_rels/' + nomeArq + '.rels'));
      for (const h of doc.getElementsByTagName('hyperlink')) {
        const url = relAba[h.getAttribute('r:id')];
        if (url && /^https?:/i.test(url)) links[h.getAttribute('ref')] = url;
      }

      abas.push({ nome: s.getAttribute('name'), celulas, links, maxLinha });
    }

    return {
      abas,
      aba: nome => abas.find(a => a.nome === nome),
      estilo: cel => (cel && estilos[cel.s]) || {}
    };
  }

  global.Planilha = { abrir, Calculo, ErroCelula, partes, colTxt, colNum, analisar };
})(window);
