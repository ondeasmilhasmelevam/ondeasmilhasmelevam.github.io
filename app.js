(() => {
  'use strict';

  // Planilha pública mantida pelo colega. O .xlsx traz as fórmulas, então
  // a página refaz as contas com o gasto de cada visitante.
  const ID_PLANILHA = '17tS6ShE1bx1vonm9WXApKO5N_jdPePq8zwBGMnpySQE';
  const URL_PLANILHA = `https://docs.google.com/spreadsheets/d/${ID_PLANILHA}/export?format=xlsx`;
  const RESERVA = 'dados/reserva.xlsx';
  const CHAVE_CACHE = 'oamml:planilha';
  const CHAVE_PREFS = 'oamml:prefs';
  const RELER_A_CADA = 10 * 60 * 1000;

  const $ = s => document.querySelector(s);
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const brl2 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const inteiro = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const decimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const ehNum = v => typeof v === 'number' && isFinite(v);

  const PASSOS = (() => {
    const v = [];
    for (let g = 500; g <= 10000; g += 500) v.push(g);
    for (let g = 11000; g <= 30000; g += 1000) v.push(g);
    for (let g = 32500; g <= 100000; g += 2500) v.push(g);
    return v;
  })();

  const estado = { gasto: 5000, recompensa: 'todos', renda: null, esconderRestritos: false, semAnuidade: false, isentos: new Set(), abertos: new Set() };
  let livro = null, modelo = null, resultados = [];

  /* ---------- preferências e endereço ---------- */

  try {
    const p = JSON.parse(localStorage.getItem(CHAVE_PREFS) || '{}');
    if (ehNum(p.gasto)) estado.gasto = p.gasto;
    if (['todos', 'pontos', 'milhas', 'cashback'].includes(p.recompensa)) estado.recompensa = p.recompensa;
    if (ehNum(p.renda)) estado.renda = p.renda;
    estado.esconderRestritos = !!p.esconderRestritos;
    estado.semAnuidade = !!p.semAnuidade;
    if (Array.isArray(p.isentos)) estado.isentos = new Set(p.isentos.filter(x => typeof x === 'string'));
  } catch (e) { /* sem armazenamento: segue com o padrão */ }
  const daUrl = +new URLSearchParams(location.search).get('gasto');
  if (daUrl > 0) estado.gasto = Math.min(daUrl, 1e7);

  function guardarPrefs() {
    try {
      const { gasto, recompensa, renda, esconderRestritos, semAnuidade } = estado;
      localStorage.setItem(CHAVE_PREFS, JSON.stringify({ gasto, recompensa, renda, esconderRestritos, semAnuidade, isentos: [...estado.isentos] }));
    } catch (e) { /* ok */ }
    try {
      const u = new URL(location.href);
      u.searchParams.set('gasto', estado.gasto);
      history.replaceState(null, '', u);
    } catch (e) { /* página dentro de moldura */ }
  }

  /* ---------- download da planilha ---------- */

  const paraBase64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const deBase64 = txt => { const s = atob(txt), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b.buffer; };

  async function baixarAoVivo() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(URL_PLANILHA, { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.arrayBuffer();
    } finally { clearTimeout(t); }
  }

  // Cotação comercial do dólar direto da fonte; se falhar, vale a da planilha
  // (que também é automática, pelo GOOGLEFINANCE, no momento do download).
  let dolarAoVivo = null;
  async function buscarDolar() {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { cache: 'no-store', signal: ctrl.signal });
      const bid = parseFloat((await r.json()).USDBRL.bid);
      if (bid > 1 && bid < 50) dolarAoVivo = { valor: bid, quando: new Date() };
    } catch (e) { /* segue com o valor da planilha */ }
    finally { clearTimeout(t); }
  }

  async function carregar() {
    const fontes = [
      async () => { if (window.MODO_TESTE) throw new Error('teste'); return { buf: await baixarAoVivo(), origem: 'vivo', quando: new Date() }; },
      async () => { const c = JSON.parse(localStorage.getItem(CHAVE_CACHE)); return { buf: deBase64(c.dados), origem: 'cache', quando: new Date(c.quando) }; },
      async () => { if (window.RESERVA_B64) return { buf: deBase64(window.RESERVA_B64), origem: 'reserva', quando: null }; const r = await fetch(RESERVA); if (!r.ok) throw new Error('sem reserva'); return { buf: await r.arrayBuffer(), origem: 'reserva', quando: null }; }
    ];
    for (const fonte of fontes) {
      try {
        const { buf, origem, quando } = await fonte();
        const novoLivro = await Planilha.abrir(buf);
        const novoModelo = montarModelo(novoLivro);
        if (!novoModelo.cartoes.length) throw new Error('nenhum cartão lido');
        livro = novoLivro; modelo = novoModelo;
        if (origem === 'vivo') { try { localStorage.setItem(CHAVE_CACHE, JSON.stringify({ dados: paraBase64(buf), quando: quando.toISOString() })); } catch (e) { /* ok */ } }
        mostrarStatus(origem, quando);
        return true;
      } catch (e) {
        console.warn('Fonte da planilha falhou:', e);
      }
    }
    return false;
  }

  function mostrarStatus(origem, quando) {
    const el = $('#status');
    const hora = quando ? quando.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    el.className = 'foot-status ' + (origem === 'vivo' ? 'vivo' : 'velho');
    el.innerHTML = '<span class="ponto"></span>' + (window.MODO_TESTE ? `Versão de teste · dados da planilha de ${esc(window.MODO_TESTE)}` : origem === 'vivo'
      ? `Dados ao vivo · atualizados em ${esc(hora)}`
      : origem === 'cache' ? `Sem conexão com a planilha · usando a leitura de ${esc(hora)}`
        : 'Sem conexão com a planilha · usando a cópia de reserva');
  }

  /* ---------- leitura da estrutura da planilha ---------- */

  const COLUNAS = [
    ['banco', h => h.startsWith('BANCO')],
    ['programa', h => h.includes('PROGRAMA')],
    ['bandeira', h => h === 'BANDEIRA'],
    ['tipo', h => h.startsWith('TIPO')],
    ['acelerador', h => h.startsWith('ACELERADOR')],
    ['renda', h => h.startsWith('RENDA')],
    ['mensal', h => h === 'MENSAL' || h.startsWith('MENSALIDADE')],
    ['anuidade', h => h === 'ANUIDADE'],
    ['pontuaPor', h => h.startsWith('PONTUA POR')],
    ['pontuacao', h => h === 'PONTUACAO'],
    ['obs', h => h === 'OBS' || h.startsWith('OBSERV') || h.startsWith('BENEF')],
    ['pontosAno', h => h.startsWith('QUANTOS PONTOS')],
    ['transferencia', h => h.startsWith('TRANSFERENCIA')],
    ['bonus', h => h.startsWith('BONUS')],
    ['valorMilhas', h => h.startsWith('VALOR EM MILHAS')],
    ['liquido', h => h.includes('ANUIDADE E TAXAS') || h.startsWith('MILHAS -')],
    ['tarifas', h => h.startsWith('TARIFAS')]
  ];

  function montarModelo(lv) {
    const aba = lv.abas.find(a => /cart/i.test(a.nome)) || lv.abas[0];
    const { partes, colTxt } = Planilha;
    const col = {};
    for (const [ref, c] of aba.celulas) {
      if (partes(ref).r !== 1) continue;
      const h = norm(c.v);
      const regra = COLUNAS.find(([k, teste]) => !col[k] && h && teste(h));
      if (regra) col[regra[0]] = ref.replace(/\d+$/, '');
    }
    if (!col.banco || !col.liquido) throw new Error('Cabeçalho da planilha mudou');

    const cel = (letra, r) => aba.celulas.get(letra + r);
    const txt = (k, r) => col[k] ? String(cel(col[k], r)?.v ?? '').trim() : '';

    const cartoes = [];
    let r = 2;
    for (; r <= aba.maxLinha; r++) {
      const nome = txt('banco', r);
      if (!nome) break;
      const linhas = nome.split(/\n/).map(s => s.trim()).filter(Boolean);
      const est = lv.estilo(cel(col.banco, r));
      const links = [];
      for (const [ref, url] of Object.entries(aba.links)) {
        if (partes(ref).r === r && !links.includes(url)) links.push(url);
      }
      const pontuaPor = txt('pontuaPor', r);
      const np = norm(pontuaPor);
      const temCash = /CASHBACK|INVESTBACK/.test(np), temPontos = /DOLAR|REAL/.test(np);
      cartoes.push({
        linha: r,
        id: 'c' + r,
        banco: linhas[0],
        produto: linhas.slice(1).join(' '),
        nome: linhas.join(' '),
        fundo: est.fundo && est.fundo !== '#FFFFFF' ? est.fundo : '#1B2540',
        corTexto: est.fundo && est.fundo !== '#FFFFFF' ? (est.texto || '#FFFFFF') : '#FFFFFF',
        programa: txt('programa', r),
        bandeira: txt('bandeira', r).replace(/\s+/g, ' '),
        tipo: txt('tipo', r).replace(/\s+/g, ' '),
        acelerador: txt('acelerador', r),
        renda: txt('renda', r).replace(/\s+/g, ' '),
        requisito: classificarRenda(txt('renda', r)),
        obs: txt('obs', r),
        pontuaPor,
        pontuacaoPct: col.pontuacao ? !!lv.estilo(cel(col.pontuacao, r)).porcento : false,
        recompensa: temCash && !temPontos ? 'cashback' : temCash ? 'ambos' : 'milhas',
        links
      });
    }

    // Mesmo nome em várias linhas (ex.: "C6 Bank"): acrescenta a categoria.
    const repetidos = cartoes.filter(k => cartoes.filter(o => o.nome === k.nome).length > 1);
    for (const k of repetidos) {
      if (!k.produto) k.produto = k.tipo;
      k.nome += ' ' + k.tipo;
    }

    // Chave que não muda se a planilha mudar a ordem das linhas.
    for (const k of cartoes) { k.chave = norm(k.nome + '|' + (k.acelerador || '')); k.vip = lerSalasVip(k.obs); }

    // Área de parâmetros abaixo dos cartões: gasto mensal, dólar e milheiros.
    const numADireita = (linha, c0) => {
      for (let c = c0 + 1; c <= c0 + 8; c++) {
        const ref = colTxt(c) + linha, x = aba.celulas.get(ref);
        if (x && (x.f || ehNum(x.v))) return ref;
      }
      return null;
    };
    let refGasto = null, refDolar = null;
    const milheiros = [];
    for (const [ref, c] of aba.celulas) {
      const p = partes(ref);
      if (p.r <= r || typeof c.v !== 'string') continue;
      const h = norm(c.v);
      if (!h || h.startsWith('ASSINE')) continue;
      const alvo = numADireita(p.r, p.c);
      if (!alvo) continue;
      if (h.includes('GASTO MENSAL')) refGasto = alvo;
      else if (h === 'DOLAR') refDolar = alvo;
      else if (h.startsWith('VALOR DO MILHEIRO') || h === 'AVIOS') {
        const pa = partes(alvo);
        const bonus = aba.celulas.get(colTxt(pa.c + 1) + pa.r);
        milheiros.push({
          nome: h === 'AVIOS' ? 'Avios' : c.v.replace(/valor do milheiro/i, '').trim(),
          ref: alvo,
          bonusRef: bonus && (bonus.f || ehNum(bonus.v)) ? colTxt(pa.c + 1) + pa.r : null
        });
      }
    }
    if (!refGasto) throw new Error('Não achei a célula do gasto mensal');

    const historico = lerHistorico(lv.abas.find(a => /hist/i.test(a.nome)));
    return { aba, col, cartoes, refGasto, refDolar, milheiros, historico };
  }

  // Salas VIP: não há coluna própria na planilha, então o resumo sai do texto
  // de benefícios. Linhas com ⚠️ (regras e mudanças) aparecem como avisos.
  const REDES_VIP = [
    ['Priority Pass', /PRIORITY\s*PASS|PRIOTIY\s*PASS/],
    ['LoungeKey', /LOUNGE\s*KEY/],
    ['Dragon Pass (Visa Airport Companion)', /DRAGON\s*PASS|AIRPORT COMPANION/],
    ['Sala Mastercard Black (Guarulhos)', /MASTERCARD.{0,15}BLACK.{0,40}(LOUNGE|GUARULHOS|GRU|SALA)|SALAS? (VIP )?MASTERCARD.{0,4}BLACK/],
    ['Centurion Lounge (Amex)', /CENTURION LOUNGE|LOUNGES AMERICAN EXPRESS/],
    ['Delta Sky Club', /DELTA SKY CLUB/],
    ['The Club by Mastercard', /THE CLUB BY MASTERCARD/],
    ['Salas Bradesco', /BRADESCO CARTOES LOUNGE|SALAS (VIP )?(PROPRIAS )?DO BRADESCO|SALAS VIP BRADESCO/],
    ['Nomad Lounge (Guarulhos)', /NOMAD LOUNGE/],
    ['VIP Lounge Inter', /VIP LOUNGE (INTER|EXCLUSIVA)/],
    ['Lounge Ultravioleta (Guarulhos)', /LOUNGE ULTRAVIOLETA/],
    ['Sala VIP LATAM (voando LATAM)', /SALA VIP LATAM/],
    ['Visa Infinite Privilege Lounge (Guarulhos)', /VISA INFINITE PRIVILEGE LOUNGE/],
    ['Taste of Priceless (Guarulhos)', /TASTE OF PRICELESS/],
    ['Airspace Lounge', /AIRSPACE LOUNGE/]
  ];
  function mesclarVip(a, b) {
    if (!a) return { ...b };
    return {
      ilimitado: a.ilimitado || b.ilimitado,
      qtd: a.qtd && b.qtd ? Math.max(a.qtd, b.qtd) : a.qtd || b.qtd,
      conv: a.conv && b.conv ? Math.max(a.conv, b.conv) : a.conv || b.conv,
      acomp: a.acomp || b.acomp
    };
  }
  function lerSalasVip(obs) {
    const redes = new Map(), avisos = [];
    let ultima = null, geral = null, linhaAnteriorVip = false;
    for (const bruta of String(obs || '').split(/\n+/)) {
      const linha = bruta.trim();
      const n = norm(linha);
      const falaDeSala = /SALA|LOUNGE|VIP|PRIORITY|DRAGON|AIRPORT COMPANION|SKY CLUB/.test(n) || /\d+\s*ACESSOS?( GRATUITOS)? (POR|AO) ANO/.test(n);
      // linha seguinte a uma de sala VIP que só diz a quantidade (ex.: "4 acessos por ano")
      const continuacao = !falaDeSala && linhaAnteriorVip && /ACESSOS?/.test(n);
      linhaAnteriorVip = falaDeSala || continuacao;
      if (!falaDeSala && !continuacao) continue;
      const texto = linha.replace(/^(✔️|✔|✅|⚠️|⚠|•|·|-|–|\*)\s*/u, '').replace(/^\uFE0F/, '').trim();
      if (/^⚠/.test(linha)) { avisos.push(texto); continue; }
      if (/OBRIGATORI|EXIGE|GASTO MINIMO|CAUCAO/.test(n)) avisos.push(texto);
      // cada frase da linha é lida à parte, para "ilimitada" não valer para a rede vizinha
      const frases = texto.split(/(?<=\.)\s+(?=[A-ZÀ-Ú0-9])/);
      frases.forEach((frase, idx) => {
        const f = norm(frase);
        if (/ENCERROU|PERDEU|ACABOU|NUNCA FOI|INVESTID/.test(f)) return;
        const qtd = (/(\d+)\s*(ACESSOS?|VEZES)/.exec(f) || [])[1];
        const conv = /(\d+)\s*CONVIDADOS?/.exec(f);
        const info = { ilimitado: /ILIMITAD/.test(f), qtd: qtd ? +qtd : null, conv: conv ? +conv[1] : null, acomp: /ACOMPANHANTE/.test(f) };
        const achadas = REDES_VIP.filter(([, re]) => re.test(f)).map(([nome]) => nome);
        if (!achadas.length) {
          if (!(info.ilimitado || info.qtd || info.conv)) return;
          // só herda a rede da linha anterior quando a frase abre a linha
          if (ultima && idx === 0) achadas.push(ultima);
          else { if (!redes.size) geral = mesclarVip(geral, info); return; }
        }
        for (const r of achadas) { redes.set(r, mesclarVip(redes.get(r), info)); ultima = r; }
      });
    }
    if (geral && !redes.size) redes.set('Salas VIP', geral);
    const lista = [...redes].map(([rede, i]) => ({ rede, ...i }));
    return { lista, avisos, tem: lista.length > 0 };
  }
  const vipResumo = r => (r.ilimitado ? 'ilimitado' : r.qtd ? `${r.qtd} ${r.qtd === 1 ? 'acesso' : 'acessos'} por ano` : 'incluído')
    + (r.conv ? ` + ${r.conv} convidados` : r.acomp ? ' + acompanhante' : '');
  function salasHtml(k) {
    const v = k.vip;
    if (!v.tem && !v.avisos.length) return '<div class="salas"><h4>Salas VIP</h4><p class="sem-vip">A planilha não informa acesso a salas VIP para este cartão.</p></div>';
    return `<div class="salas">
        <h4>Salas VIP</h4>
        ${v.tem ? `<ul>${v.lista.map(x => `<li><b>${esc(x.rede)}</b><span>${esc(vipResumo(x))}</span></li>`).join('')}</ul>` : ''}
        ${v.avisos.map(a => `<p class="aviso-vip">${esc(a)}</p>`).join('')}
        ${v.lista.some(x => /Dragon|LoungeKey|Priority/.test(x.rede)) ? '<a class="link-rest" href="#restaurantes">Seu cartão também vale em restaurantes VIP nos aeroportos · ver lista</a>' : ''}
      </div>`;
  }

  function classificarRenda(bruto) {
    const n = norm(bruto);
    if (!n || n === '-' || n.includes('NAO EXIGIDA') || n.includes('SEM INVESTIMENTO')) return { tipo: 'livre' };
    if (n.includes('CONVITE')) return { tipo: 'convite' };
    if (n.includes('INVESTID') && !n.includes(' OU ') && !n.includes('R$')) return { tipo: 'investimento' };
    const m = /(\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?\s*(MILHOES|MILHAO|MIL\b)?/.exec(n);
    if (m) {
      let v = parseFloat(m[1].replace(/\./g, ''));
      if (m[2] === 'MIL') v *= 1e3; else if (m[2]) v *= 1e6;
      return { tipo: 'renda', valor: v };
    }
    return { tipo: 'desconhecida' };
  }

  function lerHistorico(aba) {
    if (!aba) return [];
    const { partes, colTxt } = Planilha;
    const cab = {};
    for (const [ref, c] of aba.celulas) {
      if (partes(ref).r !== 1) continue;
      const h = norm(c.v);
      if (h.startsWith('DATA DETECTADA')) cab.detectada = partes(ref).c;
      else if (h.startsWith('DATA DA MUDANCA')) cab.mudanca = partes(ref).c;
      else if (h.includes('MUDANCA') || h.includes('CARTAO')) cab.texto = partes(ref).c;
    }
    if (!cab.texto) return [];
    const val = (c, r) => c ? aba.celulas.get(colTxt(c) + r)?.v ?? '' : '';
    const data = v => {
      if (ehNum(v)) return new Date(Math.round((v - 25569) * 864e5));
      const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(v));
      return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
    };
    const out = [];
    for (let r = 2; r <= aba.maxLinha; r++) {
      const texto = String(val(cab.texto, r)).trim();
      if (!texto) continue;
      const det = val(cab.detectada, r);
      out.push({ r, texto, detectada: data(det), detectadaTxt: ehNum(det) ? '' : String(det), mudanca: String(val(cab.mudanca, r) || '').trim() });
    }
    return out.sort((a, b) => ((b.detectada?.getTime() || 0) - (a.detectada?.getTime() || 0)) || b.r - a.r);
  }

  /* ---------- contas ---------- */

  function calculadora(gasto) {
    const trocas = { [modelo.aba.nome + '!' + modelo.refGasto]: gasto };
    if (dolarAoVivo && modelo.refDolar) trocas[modelo.aba.nome + '!' + modelo.refDolar] = dolarAoVivo.valor;
    // Isenção vitalícia marcada pelo visitante: anuidade e mensalidade zeradas.
    for (const k of modelo.cartoes) {
      if (!estado.isentos.has(k.chave)) continue;
      for (const c of ['anuidade', 'mensal']) if (modelo.col[c]) trocas[modelo.aba.nome + '!' + modelo.col[c] + k.linha] = 0;
    }
    return new Planilha.Calculo(livro, trocas);
  }
  function ler(calc, cartao, chave) {
    const letra = modelo.col[chave];
    if (!letra) return null;
    try { return calc.valor(modelo.aba, letra + cartao.linha); } catch (e) { return null; }
  }

  function calcular() {
    const calc = calculadora(estado.gasto);
    resultados = modelo.cartoes.map(k => {
      const v = chave => ler(calc, k, chave);
      const r = {
        cartao: k,
        liquido: v('liquido'),
        anuidade: v('anuidade'),
        mensal: v('mensal'),
        pontuacao: v('pontuacao'),
        pontosAno: v('pontosAno'),
        bonus: v('bonus'),
        valorMilhas: v('valorMilhas'),
        tarifas: v('tarifas'),
        transferencia: String(v('transferencia') ?? '').trim()
      };
      if (!ehNum(r.anuidade) && ehNum(r.mensal)) r.anuidade = r.mensal * 12;
      return r;
    }).filter(r => ehNum(r.liquido));
    resultados.sort((a, b) => b.liquido - a.liquido);
  }

  const ehIsento = k => estado.isentos.has(k.chave);
  function visivel(r) {
    const k = r.cartao;
    const f = estado.recompensa, tipo = tipoRetorno(k);
    if (f !== 'todos' && !tipo.includes(f)) return 'filtro';
    if (ehIsento(k)) return true; // o cartão já é do visitante
    if (estado.semAnuidade && ehNum(r.anuidade) && r.anuidade > 0) return 'filtro';
    if (estado.esconderRestritos && (k.requisito.tipo === 'convite' || k.requisito.tipo === 'investimento')) return 'restrito';
    if (estado.renda && k.requisito.tipo === 'renda' && k.requisito.valor > estado.renda) return 'renda';
    return true;
  }

  // Varre gastos de 0 a 150 mil e anota onde o valor de uma coluna muda
  // (ex.: anuidade some a partir de R$ 25 mil). Só roda ao abrir um cartão.
  function faixas(cartao, chave) {
    const out = [];
    let anterior;
    for (let g = 0; g <= 150000; g += g < 20000 ? 250 : 1000) {
      let v = ler(calculadora(g), cartao, chave);
      if (chave === 'anuidade' && !ehNum(v)) { const m = ler(calculadora(g), cartao, 'mensal'); v = ehNum(m) ? m * 12 : v; }
      const chaveV = ehNum(v) ? Math.round(v * 100) / 100 : String(v ?? '');
      if (chaveV !== anterior) { out.push({ desde: g, v }); anterior = chaveV; }
    }
    return out;
  }

  /* ---------- textos ---------- */

  const moedaGasto = () => brl.format(estado.gasto);

  // Programa onde os pontos caem, como está na coluna "Programa fidelidade".
  const programaDe = k => {
    const p = String(k.programa || '').replace(/[®™]/g, '').replace(/\s+/g, ' ').trim();
    return p === '-' || norm(p) === 'PONTOS' ? '' : p;
  };
  // Cartão de companhia aérea: já acumula milhas, sem transferência.
  const ehAereo = k => {
    const p = norm(programaDe(k));
    return /LATAM|AADVANTAGE|AZUL|SMILES|TUDOAZUL|TAP MILES/.test(p) && !/LIVELO|ESFERA|ATOMOS|DOTZ/.test(p);
  };
  const unidadeDe = k => ehAereo(k) ? 'milhas' : 'pontos';
  const unidadeDestino = destino => /IBERIA|BRITISH|QATAR|AVIOS/.test(norm(destino)) ? 'Avios' : 'milhas';

  const pontuacaoTxt = r => {
    const p = r.pontuacao, k = r.cartao;
    if (!ehNum(p)) return p ? String(p) : '—';
    if (k.pontuacaoPct || k.recompensa === 'cashback') return decimal.format(p * (p < 1 ? 100 : 1)) + '% de volta';
    const np = norm(k.pontuaPor);
    const moeda = np.includes('DOLAR') ? 'US$ 1' : np.includes('REAL') ? 'R$ 1' : '';
    const u = unidadeDe(k);
    return `${decimal.format(p)} ${p === 1 ? u.slice(0, -1) : u}${moeda ? ' por ' + moeda : ''}`;
  };
  const milhasNoDestino = r => ehNum(r.bonus) ? r.bonus * 1000 : null;
  const ehCashback = r => !ehNum(r.valorMilhas) && ehNum(r.pontosAno) && r.cartao.recompensa !== 'milhas';
  function milheiroDe(destino) {
    const d = norm(destino);
    if (!d) return null;
    const calc = calculadora(estado.gasto);
    const ok = modelo.milheiros.find(m => norm(m.nome).includes(d) || d.includes(norm(m.nome).split(' ')[0]))
      || (/IBERIA|BRITISH|QATAR|AVIOS/.test(d) ? modelo.milheiros.find(m => m.nome === 'Avios') : null);
    if (!ok) return null;
    try { return { nome: ok.nome, valor: calc.valor(modelo.aba, ok.ref) }; } catch (e) { return null; }
  }

  // Tipo de retorno do cartão: pontos (Livelo, Esfera...), milhas (programa
  // da companhia aérea) e/ou cashback, conforme a coluna "Pontua por".
  function tipoRetorno(k) {
    if (k.recompensa === 'cashback') return ['cashback'];
    const base = ehAereo(k) ? 'milhas' : 'pontos';
    return k.recompensa === 'ambos' ? [base, 'cashback'] : [base];
  }

  function destinoTag(r) {
    const k = r.cartao, prog = programaDe(k), d = r.transferencia;
    if (ehAereo(k)) return `<span class="tag">Milhas${prog ? ' ' + esc(prog) : ''}</span>`;
    const nome = prog && prog.length <= 18 ? ' ' + esc(prog) : '';
    return `<span class="tag">Pontos${nome}${d ? ' → ' + esc(d) : ''}</span>`;
  }

  const podePedir = r => {
    const k = r.cartao, q = k.requisito;
    if (ehIsento(k)) return true;
    if (q.tipo === 'convite' || q.tipo === 'investimento') return false;
    if (estado.renda && q.tipo === 'renda' && q.valor > estado.renda) return false;
    return true;
  };
  function requisitoTexto(k) {
    const q = k.requisito;
    if (q.tipo === 'convite') return 'só por convite do banco';
    if (q.tipo === 'investimento') return `exige ${k.renda.toLowerCase()}`;
    if (q.tipo === 'renda') return `renda mínima de ${brl.format(q.valor)}${/OU|CLIENTE|LIMITE/.test(norm(k.renda)) ? ` (${k.renda})` : ''}`;
    if (q.tipo === 'livre') return 'sem renda mínima exigida';
    return 'a planilha não informa a renda mínima';
  }
  function porQueNao(k) {
    const q = k.requisito;
    if (q.tipo === 'convite') return 'ele é só por convite';
    if (q.tipo === 'investimento') return `ele exige ${k.renda.toLowerCase()}`;
    if (q.tipo === 'renda') return `ele pede renda mínima de ${brl.format(q.valor)}`;
    return 'ele tem exigências maiores';
  }

  function requisitoTag(k) {
    const q = k.requisito;
    if (q.tipo === 'convite') return '<span class="tag alerta">Só por convite</span>';
    if (q.tipo === 'investimento') return `<span class="tag alerta">${esc(k.renda)}</span>`;
    if (q.tipo === 'renda') return `<span class="tag cinza">Renda ${esc(brl.format(q.valor))}+</span>`;
    if (q.tipo === 'livre') return '<span class="tag verde">Sem renda mínima</span>';
    return '';
  }

  // Cartão desenhado: o corpo segue a categoria (Black, Platinum, Gold...) e a
  // cor do banco na planilha entra como detalhe.
  function acabamento(k) {
    const t = norm(k.tipo + ' ' + k.produto);
    if (t.includes('ULTRAVIOLETA')) return 'roxo';
    if (/GOLD|OURO/.test(t)) return 'ouro';
    if (/PLATIN|GRAPHENE|CROMA/.test(t) && !/BLACK/.test(t)) return 'prata';
    if (/BLACK|INFINITE|NANQUIM|GRAFITE|CARBON|WIN|PRIVILEGE|LEGEND|CENTURION/.test(t)) return 'preto';
    return 'cor';
  }
  function bandeiraSvg(k) {
    const b = norm(k.bandeira);
    if (b.includes('AMEX')) return '<svg class="bd amex" viewBox="0 0 60 38" aria-hidden="true"><rect width="60" height="38" rx="5" fill="#2E77BC"/><text x="30" y="24" text-anchor="middle" font-family="Arial,sans-serif" font-weight="800" font-size="13" fill="#fff" letter-spacing=".5">AMEX</text></svg>';
    if (b.includes('ELO') && !b.includes('VISA')) return '<svg class="bd elo" viewBox="0 0 60 38" aria-hidden="true"><circle cx="11" cy="19" r="8" fill="#FFCB05"/><circle cx="11" cy="19" r="4" fill="currentColor"/><text x="38" y="27" text-anchor="middle" font-family="Arial,sans-serif" font-weight="800" font-size="22" fill="currentColor">elo</text></svg>';
    if (b.includes('MASTER') && !b.includes('VISA')) return '<svg class="bd mc" viewBox="0 0 60 38" aria-hidden="true"><circle cx="22" cy="19" r="14" fill="#EB001B"/><circle cx="38" cy="19" r="14" fill="#F79E1B"/><path d="M30 7.5a14 14 0 0 1 0 23 14 14 0 0 1 0-23z" fill="#FF5F00"/></svg>';
    return '<svg class="bd visa" viewBox="0 0 60 38" aria-hidden="true"><text x="58" y="29" text-anchor="end" font-family="Arial Black,Arial,sans-serif" font-style="italic" font-weight="900" font-size="22" fill="currentColor" letter-spacing="-.5">VISA</text></svg>';
  }
  const SEM_CONTATO = '<svg class="nfc" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7.5a6 6 0 0 1 0 9M11.5 5a10 10 0 0 1 0 14M15 2.8a13.5 13.5 0 0 1 0 18.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

  const cartaoVisual = (k, classe = 'cartao') => {
    const est = `style="--acc:${esc(k.fundo)};--c:${esc(k.fundo)};--t:${esc(k.corTexto)}"`;
    const ac = acabamento(k);
    if (classe === 'mini') return `<span class="mini ${ac}" ${est} aria-hidden="true"><span>${esc(k.banco)}</span>${bandeiraSvg(k)}</span>`;
    return `<div class="cartao ${ac}" ${est} role="img" aria-label="Cartão ${esc(k.nome)}, ${esc(k.bandeira)}">
        <div class="cartao-topo">
          <div><div class="cartao-banco">${esc(k.banco)}</div>${k.produto ? `<div class="cartao-produto">${esc(k.produto)}</div>` : ''}</div>
          ${SEM_CONTATO}
        </div>
        <span class="chip"><i></i></span>
        <div class="cartao-pe"><span>${k.tipo === k.produto ? '' : esc(k.tipo)}</span>${bandeiraSvg(k)}</div>
      </div>`;
  };

  // usados na página de conferência dos desenhos
  window.desenharCartao = cartaoVisual;
  window.cartoesDaPlanilha = () => modelo ? modelo.cartoes : [];

  function contaHtml(r) {
    const linhas = [];
    const g12 = estado.gasto * 12;
    if (ehCashback(r)) {
      linhas.push(['Cashback no ano', brl.format(r.pontosAno)]);
    } else {
      const k = r.cartao, prog = programaDe(k), u = unidadeDe(k);
      const U = u.charAt(0).toUpperCase() + u.slice(1);
      if (ehNum(r.pontosAno)) linhas.push([`${U}${prog ? ' ' + esc(prog) : ''} no ano (${esc(pontuacaoTxt(r))})`, `${inteiro.format(r.pontosAno)} ${u}`]);
      const destino = r.transferencia, mil = milheiroDe(destino);
      // Sem a coluna de bônus (ex.: Revolut), deduz as milhas pelo valor em reais.
      const md = milhasNoDestino(r) || (ehNum(r.valorMilhas) && mil && ehNum(mil.valor) && mil.valor > 0 ? Math.round(r.valorMilhas / mil.valor * 1000) : null);
      if (md && destino && !ehAereo(k)) {
        const taxa = ehNum(r.pontosAno) && r.pontosAno > 0 ? md / r.pontosAno : 1;
        const bonus = taxa > 1.01 ? ` com ${inteiro.format((taxa - 1) * 100)}% de bônus`
          : taxa < 0.99 ? ` (1 ${u.slice(0, -1)} vale ${decimal.format(taxa)} ${unidadeDestino(destino) === 'Avios' ? 'Avios' : 'milha'})` : '';
        linhas.push([`Transferidos para ${esc(destino)}${bonus}`, `${inteiro.format(md)} ${unidadeDestino(destino)}`]);
      }
      if (ehNum(r.valorMilhas)) linhas.push([`Valor em reais${mil && ehNum(mil.valor) ? ` (milheiro ${esc(mil.nome)} a ${brl2.format(mil.valor)})` : ''}`, brl.format(r.valorMilhas)]);
    }
    const anu = ehNum(r.anuidade) ? r.anuidade : 0;
    linhas.push([ehIsento(r.cartao) ? 'Anuidade (sua isenção vitalícia)' : 'Anuidade no seu gasto', anu > 0 ? '− ' + brl.format(anu) : 'Grátis', anu > 0 ? 'menos' : '']);
    if (ehNum(r.tarifas) && r.tarifas > 0) linhas.push(['Tarifas extras', '− ' + brl.format(r.tarifas), 'menos']);
    linhas.push(['Sobra por ano', brl.format(r.liquido), 'total']);
    return `<ul class="conta">${linhas.map(([a, b, c]) => `<li class="${c || ''}"><span>${a}</span><span>${b}</span></li>`).join('')}</ul>`;
  }

  /* ---------- tela ---------- */

  function desenhar() {
    if (!modelo) return;
    calcular();
    const lista = [], ocultos = { restrito: 0, renda: 0, filtro: 0 };
    for (const r of resultados) { const v = visivel(r); if (v === true) lista.push(r); else ocultos[v]++; }

    // Vencedor
    const venc = $('#vencedor');
    if (!lista.length) {
      venc.innerHTML = '<p class="vazio">Nenhum cartão atende a esses filtros. Tente liberar algum deles acima.</p>';
    } else {
      // O destaque é o melhor cartão que a pessoa pode pedir: fora os só por
      // convite, os de investimento alto e os de renda acima da informada.
      const r = lista.find(podePedir) || lista[0], k = r.cartao;
      const vice = lista.find(x => x !== r && podePedir(x));
      const acima = lista[0] !== r ? lista[0] : null;
      const pct = r.liquido / (estado.gasto * 12) * 100;
      venc.innerHTML = `<article class="vencedor">
        ${cartaoVisual(k)}
        <div>
          <span class="vencedor-tag">★ Melhor para ${esc(moedaGasto())}/mês${ehIsento(k) ? ' · é o seu' : ''}</span>
          <h2>${esc(k.nome)}</h2>
          <p class="sub">${esc([k.programa, k.bandeira].filter(x => x && x !== '-').join(' · '))}</p>
          <p class="requisito">${ehIsento(k) ? 'Você já tem este cartão.' : `<b>Para pedir:</b> ${esc(requisitoTexto(k))}. A aprovação depende da análise de crédito do banco.`}</p>
          <div class="valor-grande num">${esc(brl.format(r.liquido))}<small>por ano</small></div>
          <p class="valor-extra">Equivale a <b>${esc(decimal.format(pct))}% de volta</b> em tudo que você passa no cartão, ou ${esc(brl.format(r.liquido / 12))} por mês.</p>
          ${contaHtml(r)}
          ${salasHtml(k)}
          <div class="cta-row">
            <button type="button" class="cta cta-a" data-abrir="${k.id}">Ver benefícios</button>
            ${k.links[0] ? `<a class="cta cta-b" href="${esc(k.links[0])}" target="_blank" rel="noopener">Site oficial ↗</a>` : ''}
          </div>
          ${vice ? `<p class="vice">Em seguida: <b>${esc(vice.cartao.nome)}</b>, ${esc(brl.format(vice.liquido))}/ano (${esc(brl.format(r.liquido - vice.liquido))} a menos).</p>` : ''}
          ${acima ? `<p class="vice acima">Rende mais o <b>${esc(acima.cartao.nome)}</b> (${esc(brl.format(acima.liquido))}/ano), mas ${esc(porQueNao(acima.cartao))}.</p>` : ''}
          ${comparacaoHtml(r, lista)}
        </div>
      </article>`;
    }

    // Ranking
    const maior = Math.max(1, ...lista.map(r => r.liquido));
    $('#ranking').innerHTML = lista.map((r, i) => {
      const k = r.cartao, aberto = estado.abertos.has(k.id);
      const anu = ehNum(r.anuidade) ? r.anuidade : null;
      const tags = [
        ehIsento(k) ? '<span class="tag verde">Sua isenção vitalícia</span>' : '',
        ehIsento(k) ? '' : anu === 0 ? '<span class="tag verde">Anuidade grátis</span>' : anu ? `<span class="tag cinza">Anuidade ${esc(brl.format(anu))}</span>` : '',
        k.recompensa === 'cashback' ? '<span class="tag">Cashback</span>' : k.recompensa === 'ambos' ? `${destinoTag(r)}<span class="tag">ou cashback</span>` : destinoTag(r),
        k.acelerador && k.acelerador !== '-' ? `<span class="tag">${esc(k.acelerador.length < 20 ? k.acelerador : 'Promoção')}</span>` : '',
        requisitoTag(k)
      ].join('');
      return `<li class="item${i < 3 ? ' top' : ''}${aberto ? ' aberto' : ''}" id="${k.id}">
        <button type="button" class="item-linha" aria-expanded="${aberto}" aria-controls="${k.id}-d">
          <span class="pos">${i + 1}</span>
          ${cartaoVisual(k, 'mini')}
          <span class="item-corpo">
            <span class="item-nome">${esc(k.nome)}</span>
            <span class="item-desc">${esc(pontuacaoTxt(r))}${k.programa && k.programa !== '-' ? ' · ' + esc(k.programa) : ''}</span>
            <span class="tags">${tags}</span>
          </span>
          <span class="item-valor">
            <b class="${r.liquido < 0 ? 'neg' : ''}">${esc(brl.format(r.liquido))}</b>
            <small>por ano</small>
            <span class="barra"><i style="width:${Math.max(0, r.liquido / maior * 100).toFixed(1)}%"></i></span>
          </span>
          <span class="seta" aria-hidden="true"></span>
        </button>
        <div class="detalhe" id="${k.id}-d" ${aberto ? '' : 'hidden'}>${aberto ? detalheHtml(r) : ''}</div>
      </li>`;
    }).join('');

    const partesNota = [`Mostrando ${lista.length} de ${modelo.cartoes.length} cartões, com valores para ${moedaGasto()} por mês, já descontada a anuidade.`];
    const nOcultos = ocultos.restrito + ocultos.renda;
    $('#ranking-nota').innerHTML = esc(partesNota.join(' ')) + (nOcultos ? ` <span class="ocultos">${[
      ocultos.restrito ? `${ocultos.restrito} só por convite ou investimento alto (<button type="button" data-mostrar-restritos>mostrar</button>)` : '',
      ocultos.renda ? `${ocultos.renda} pedem renda acima da sua` : ''
    ].filter(Boolean).join(' · ')} fora da lista.</span>` : '');

    $('#carregando').hidden = true;
  }

  // Os cartões com isenção vitalícia do visitante contra o melhor da lista.
  function comparacaoHtml(melhor, lista) {
    const meus = resultados.filter(x => ehIsento(x.cartao));
    if (!meus.length) return '';
    return `<div class="meus">
      <h3>Seus cartões com isenção vitalícia</h3>
      <ul>${meus.map(m => {
        const pos = lista.indexOf(m) + 1;
        const onde = pos ? `${pos}º lugar` : 'fora deste filtro';
        const fim = m === melhor
          ? '<em class="ok">É o melhor para você com esse gasto. Continue usando.</em>'
          : `<em>O 1º colocado rende <b>${esc(brl.format(melhor.liquido - m.liquido))} a mais</b> por ano.</em>`;
        return `<li><span><b>${esc(m.cartao.nome)}</b> · ${onde} · ${esc(brl.format(m.liquido))}/ano</span>${fim}</li>`;
      }).join('')}</ul>
    </div>`;
  }

  function detalheHtml(r) {
    const k = r.cartao;
    const beneficios = k.obs.split(/\n+/).map(s => s.trim()).filter(Boolean).map(l => {
      const aviso = /^⚠/.test(l);
      const sub = /^[•·\-–]/.test(l);
      const t = l.replace(/^(✔️|✔|✅|⚠️|⚠|•|·|-|–|\*)\s*/u, '').replace(/^️/, '').trim();
      if (aviso && k.vip.avisos.includes(t)) return ''; // já aparece no quadro de salas VIP
      return t ? `<li class="${aviso ? 'aviso' : sub ? 'sub' : ''}">${esc(t)}</li>` : '';
    }).join('');

    const fAnu = ehIsento(k) ? [] : faixas(k, 'anuidade').filter(f => ehNum(f.v));
    const fPts = faixas(k, 'pontuacao');
    const regraAnu = fAnu.length > 1
      ? `<p><b>Anuidade muda com o gasto:</b> ${fAnu.map(f => `${f.desde === 0 ? 'abaixo de ' + brl.format(fAnu[1].desde) : 'a partir de ' + brl.format(f.desde)}/mês: ${f.v > 0 ? brl.format(f.v) + '/ano' : 'grátis'}`).join(' · ')}</p>` : '';
    const regraPts = fPts.length > 1
      ? `<p><b>Pontuação muda com o gasto:</b> ${fPts.map(f => `${f.desde === 0 ? 'abaixo de ' + brl.format(fPts[1].desde) : 'a partir de ' + brl.format(f.desde)}: ${esc(pontuacaoTxt({ pontuacao: f.v, cartao: k }))}`).join(' · ')}</p>` : '';

    const ficha = [
      ['Programa', k.programa],
      ['Bandeira', k.bandeira],
      ['Categoria', k.tipo],
      ['Exige', k.renda],
      ['Pontuação', pontuacaoTxt(r)],
      ['Transfere para', r.transferencia],
      ['Anuidade no seu gasto', ehNum(r.anuidade) ? (r.anuidade > 0 ? brl.format(r.anuidade) : 'Grátis') : '']
    ].filter(([, v]) => v && v !== '-');

    const nomeLink = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'site'; } };

    return `<div>
        ${salasHtml(k)}
        <h4>Benefícios</h4>
        ${beneficios ? `<ul class="beneficios">${beneficios}</ul>` : '<p class="sec-note">Sem observações na planilha.</p>'}
      </div>
      <div>
        <h4>Ficha</h4>
        <dl class="ficha">${ficha.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
        ${regraAnu || regraPts ? `<div class="faixas">${regraAnu}${regraPts}</div>` : ''}
        <h4 style="margin-top:18px">Como chegamos no valor</h4>
        ${contaHtml(r)}
        <label class="chave chave-detalhe"><input type="checkbox" data-isento="${esc(k.chave)}" ${ehIsento(k) ? 'checked' : ''}><span></span>Tenho isenção vitalícia de anuidade deste cartão</label>
        ${k.links.length ? `<div class="fontes">${k.links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(nomeLink(u))}</a>`).join('')}</div>` : ''}
      </div>`;
  }

  function desenharNovidades() {
    const lista = modelo.historico;
    const ul = $('#lista-novidades'), btn = $('#mais-novidades');
    if (!lista.length) { $('#novidades').hidden = true; return; }
    $('#novidades').hidden = false;
    const todas = btn.dataset.todas === '1';
    const mostrar = todas ? lista : lista.slice(0, 6);
    ul.innerHTML = mostrar.map(n => {
      const i = n.texto.indexOf(':');
      const titulo = i > 0 && i < 50 ? n.texto.slice(0, i) : 'Mudança de regra';
      const corpo = i > 0 && i < 50 ? n.texto.slice(i + 1).trim() : n.texto;
      const data = n.detectada ? n.detectada.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : n.detectadaTxt;
      const quando = n.mudanca && !/^n[aã]o especificad/i.test(n.mudanca) ? `<span class="quando">Vale desde: ${esc(n.mudanca)}</span>` : '';
      return `<li class="novidade"><time>${esc(data)}</time><h3>${esc(titulo)}</h3><p>${esc(corpo.charAt(0).toUpperCase() + corpo.slice(1))}</p>${quando}</li>`;
    }).join('');
    btn.hidden = lista.length <= 6;
    btn.textContent = todas ? 'Mostrar menos' : `Ver todas as ${lista.length} mudanças`;
  }

  /* ---------- restaurantes VIP ---------- */

  const REDE_ROTULO = { dp: 'DP', lkpp: 'LK/PP' };
  const REDE_NOME = { dp: 'Dragon Pass', lkpp: 'LoungeKey / Priority Pass' };
  const selo = r => `<span class="selo ${r}" title="${REDE_NOME[r]}">${REDE_ROTULO[r]}</span>`;
  const ICONES = {
    sino: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v3.5L4.5 16h15L18 12.5V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0" fill="currentColor"/></svg>',
    relogio: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="M12 7v5l3.5 2" stroke="#0C1426" stroke-width="2" fill="none" stroke-linecap="round"/></svg>'
  };
  let redeRest = 'todos';

  function desenharRestaurantes() {
    const R = window.RESTAURANTES_VIP;
    if (!R) { $('#restaurantes').hidden = true; return; }
    $('#rest-valores').innerHTML = R.valores.map(v => `<div class="rest-valor ${v.rede}">
        <p>${REDE_ROTULO[v.rede]} · ${esc(v.titulo)}</p><b>${esc(v.valor)}</b><span>${esc(v.texto)}</span></div>`).join('');
    $('#rest-dicas').innerHTML = R.dicas.map(d => `<div class="rest-dica">${ICONES[d.icone] || ''}<div><b>${esc(d.titulo)}</b><p>${esc(d.texto)}</p></div></div>`).join('');
    const busca = norm($('#rest-busca').value);
    const serve = item => redeRest === 'todos' || item.slice(1).includes(redeRest);
    const linha = item => `<li><span>${esc(item[0])}</span><span class="selos">${item.slice(1).map(selo).join('')}</span></li>`;
    const cards = R.aeroportos.map(a => {
      const doLugar = norm(a.cidade + ' ' + (a.sub || ''));
      const bate = item => !busca || doLugar.includes(busca) || norm(item[0]).includes(busca);
      const grupos = (a.terminais || [{ nome: '', lista: a.lista }])
        .map(t => ({ nome: t.nome, lista: t.lista.filter(i => serve(i) && bate(i)) }))
        .filter(t => t.lista.length);
      if (!grupos.length) return '';
      return `<article class="aero">
          <h3><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6.5a2.5 2.5 0 0 1 0 5z" fill="currentColor"/></svg>${esc(a.cidade)}</h3>
          ${a.sub ? `<p class="aero-sub">${esc(a.sub)}</p>` : ''}
          ${grupos.map(g => `${g.nome ? `<p class="terminal">${esc(g.nome)}</p>` : ''}<ul>${g.lista.map(linha).join('')}</ul>`).join('')}
        </article>`;
    }).filter(Boolean);
    $('#rest-grade').innerHTML = cards.length ? cards.join('') : '<p class="vazio">Nenhum restaurante encontrado com essa busca.</p>';
    document.querySelectorAll('#rest-rede button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === redeRest)));
  }
  $('#rest-busca').addEventListener('input', desenharRestaurantes);
  $('#rest-rede').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { redeRest = b.dataset.v; desenharRestaurantes(); } });

  function desenharPrecos() {
    const P = window.PRECO_MILHAS;
    if (!P || !P.length) { $('#comprar').hidden = true; return; }
    $('#precos').innerHTML = P.map(p => `<li>
        <span class="preco-logo" style="background:${esc(p.fundo)};color:${esc(p.tinta)}">${esc(p.nome)}${p.detalhe ? `<i style="background:${esc(p.detalhe)}"></i>` : ''}</span>
        <b>${esc(p.preco)}</b>
      </li>`).join('');
  }

  function desenharParametros() {
    const calc = calculadora(estado.gasto);
    const val = ref => { try { return calc.valor(modelo.aba, ref); } catch (e) { return null; } };
    const linhas = [];
    const dolar = modelo.refDolar && val(modelo.refDolar);
    if (ehNum(dolar)) linhas.push([dolarAoVivo ? 'Dólar comercial (agora)' : 'Dólar', brl2.format(dolar)]);
    for (const m of modelo.milheiros) {
      const v = val(m.ref), b = m.bonusRef && val(m.bonusRef);
      if (ehNum(v)) linhas.push([`Milheiro ${m.nome}`, brl2.format(v) + (ehNum(b) && b > 0 ? ` · bônus ${inteiro.format(b * 100)}%` : '')]);
    }
    linhas.push(['Cartões comparados', inteiro.format(modelo.cartoes.length)]);
    $('#parametros').innerHTML = linhas.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('');
  }

  /* ---------- controles ---------- */

  const campo = $('#gasto'), faixa = $('#gasto-faixa'), campoRenda = $('#renda');
  const passoMaisPerto = g => PASSOS.reduce((m, v, i) => Math.abs(v - g) < Math.abs(PASSOS[m] - g) ? i : m, 0);
  faixa.max = PASSOS.length - 1;

  function sincronizarControles(origem) {
    if (origem !== 'campo') campo.value = inteiro.format(estado.gasto);
    if (origem !== 'faixa') faixa.value = passoMaisPerto(estado.gasto);
    faixa.setAttribute('aria-valuetext', brl.format(estado.gasto));
    document.querySelectorAll('#atalhos button').forEach(b => b.setAttribute('aria-pressed', String(+b.dataset.v === estado.gasto)));
    document.querySelectorAll('#recompensa button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === estado.recompensa)));
    $('#restritos').checked = estado.esconderRestritos;
    $('#sem-anuidade').checked = estado.semAnuidade;
    if (document.activeElement !== campoRenda) campoRenda.value = estado.renda ? inteiro.format(estado.renda) : '';
  }

  let espera;
  function mudou(origem) {
    sincronizarControles(origem);
    clearTimeout(espera);
    espera = setTimeout(() => { desenhar(); desenharParametros(); guardarPrefs(); }, 60);
  }

  const soDigitos = s => +String(s).replace(/\D/g, '') || 0;
  campo.addEventListener('input', () => {
    const g = Math.min(soDigitos(campo.value), 1e7);
    const fim = campo.selectionStart === campo.value.length;
    campo.value = g ? inteiro.format(g) : '';
    if (fim) campo.setSelectionRange(campo.value.length, campo.value.length);
    if (g > 0) { estado.gasto = g; mudou('campo'); }
  });
  campo.addEventListener('blur', () => { campo.value = inteiro.format(estado.gasto); });
  campo.addEventListener('focus', () => campo.select());
  faixa.addEventListener('input', () => { estado.gasto = PASSOS[+faixa.value]; mudou('faixa'); });
  $('#atalhos').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { estado.gasto = +b.dataset.v; mudou(); } });
  $('#recompensa').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { estado.recompensa = b.dataset.v; mudou(); } });
  $('#recompensa').addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const bs = [...document.querySelectorAll('#recompensa button')];
    const i = (bs.findIndex(b => b.dataset.v === estado.recompensa) + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length;
    estado.recompensa = bs[i].dataset.v; bs[i].focus(); mudou();
  });
  campoRenda.addEventListener('input', () => {
    const v = soDigitos(campoRenda.value);
    campoRenda.value = v ? inteiro.format(v) : '';
    estado.renda = v || null; mudou();
  });
  $('#restritos').addEventListener('change', e => { estado.esconderRestritos = e.target.checked; mudou(); });
  $('#sem-anuidade').addEventListener('change', e => { estado.semAnuidade = e.target.checked; mudou(); });

  /* ---------- cartões com isenção vitalícia ---------- */

  function desenharIsencao() {
    if (!modelo) return;
    const marcados = modelo.cartoes.filter(ehIsento);
    $('#isencao-resumo').textContent = marcados.length
      ? `${marcados.length} ${marcados.length === 1 ? 'cartão marcado' : 'cartões marcados'} · anuidade conta como zero`
      : 'Marque e veja se ainda vale usar ele';
    $('#isencao-chips').innerHTML = marcados.map(k =>
      `<button type="button" class="chip-isento" data-tirar="${esc(k.chave)}" aria-label="Tirar ${esc(k.nome)}">${esc(k.nome)} <span aria-hidden="true">×</span></button>`).join('');
    if ($('#isencao-painel').hidden) return;
    const busca = norm($('#isencao-busca').value);
    const lista = [...modelo.cartoes]
      .filter((k, i, a) => a.findIndex(o => o.chave === k.chave) === i)
      .filter(k => !busca || norm(k.nome + ' ' + k.programa + ' ' + k.bandeira).includes(busca))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    $('#isencao-lista').innerHTML = lista.length ? lista.map(k => `<li><label>
        <input type="checkbox" data-isento="${esc(k.chave)}" ${ehIsento(k) ? 'checked' : ''}>
        ${cartaoVisual(k, 'mini')}
        <span><b>${esc(k.nome)}</b><small>${esc([k.tipo, k.acelerador && k.acelerador !== '-' ? k.acelerador : ''].filter(Boolean).join(' · '))}</small></span>
      </label></li>`).join('') : '<li class="nada">Nenhum cartão com esse nome.</li>';
  }
  function marcarIsento(chave, sim) {
    if (sim) estado.isentos.add(chave); else estado.isentos.delete(chave);
    desenharIsencao();
    mudou();
  }
  $('#isencao-abrir').addEventListener('click', () => {
    const painel = $('#isencao-painel');
    painel.hidden = !painel.hidden;
    $('#isencao-abrir').setAttribute('aria-expanded', String(!painel.hidden));
    desenharIsencao();
    if (!painel.hidden) $('#isencao-busca').focus();
  });
  $('#isencao-busca').addEventListener('input', desenharIsencao);
  document.addEventListener('change', e => {
    const c = e.target.closest('[data-isento]');
    if (c) marcarIsento(c.dataset.isento, c.checked);
  });

  function abrirCartao(id, rolar) {
    const li = document.getElementById(id);
    if (!li) return;
    const r = resultados.find(x => x.cartao.id === id);
    const abrir = !estado.abertos.has(id) || rolar;
    if (abrir) estado.abertos.add(id); else estado.abertos.delete(id);
    li.classList.toggle('aberto', abrir);
    li.querySelector('.item-linha').setAttribute('aria-expanded', String(abrir));
    const d = li.querySelector('.detalhe');
    d.hidden = !abrir;
    if (abrir && r) d.innerHTML = detalheHtml(r);
    if (rolar) li.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', e => {
    const linha = e.target.closest('.item-linha');
    if (linha) { abrirCartao(linha.closest('.item').id); return; }
    const ab = e.target.closest('[data-abrir]');
    if (ab) { abrirCartao(ab.dataset.abrir, true); return; }
    const tirar = e.target.closest('[data-tirar]');
    if (tirar) { marcarIsento(tirar.dataset.tirar, false); return; }
    if (e.target.closest('[data-mostrar-restritos]')) { estado.esconderRestritos = false; mudou(); return; }
    if (e.target.id === 'mais-novidades') {
      const btn = e.target;
      btn.dataset.todas = btn.dataset.todas === '1' ? '0' : '1';
      desenharNovidades();
    }
  });

  // Aba ativa na barra conforme a rolagem
  const abas = [...document.querySelectorAll('.tabs a')];
  const obs = new IntersectionObserver(ents => {
    for (const en of ents) if (en.isIntersecting) abas.forEach(a => a.setAttribute('aria-current', String(a.getAttribute('href') === '#' + en.target.id)));
  }, { rootMargin: '-40% 0px -55% 0px' });
  ['simulador', 'ranking-sec', 'restaurantes', 'novidades', 'como'].forEach(id => { const el = document.getElementById(id); if (el) obs.observe(el); });

  /* ---------- início ---------- */

  async function iniciar() {
    sincronizarControles();
    desenharRestaurantes();
    desenharPrecos();
    const [ok] = await Promise.all([carregar(), buscarDolar()]);
    if (!ok) {
      $('#carregando').innerHTML = 'Não foi possível ler a planilha de cartões agora. Tente de novo em alguns minutos.';
      return;
    }
    desenhar(); desenharNovidades(); desenharParametros(); desenharIsencao();
    setInterval(async () => {
      if (document.hidden) return;
      const [ok2] = await Promise.all([carregar(), buscarDolar()]);
      if (ok2) { desenhar(); desenharNovidades(); desenharParametros(); }
    }, RELER_A_CADA);
  }
  iniciar();
})();
