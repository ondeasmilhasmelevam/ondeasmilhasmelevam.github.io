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

  const estado = { gasto: 5000, recompensa: 'todos', renda: null, esconderRestritos: false, semAnuidade: false, isentos: new Set(), abertos: new Set(),
    limite: 10, verRestritos: false, verAcimaRenda: false };
  // O ranking começa com os 10 melhores; cada clique em "ver mais" abre outros 10.
  const POR_PAGINA = 10;
  let listaVisivel = [];
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
    // Se ainda repetir (ex.: três "C6 Bank C6 normal"), o plano da coluna
    // Acelerador diferencia: "(C6 + Bônus)", "(sem assinatura)"...
    const aindaRepetidos = cartoes.filter(k => cartoes.filter(o => o.nome === k.nome).length > 1);
    for (const k of aindaRepetidos) {
      const a = (k.acelerador || '').trim();
      if (!a || a === '-') continue;
      k.nome += /^SEM$/i.test(a) ? ' (sem assinatura)' : /^[\d.,]+$/.test(a) ? ' (com acelerador)' : ` (${a})`;
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
  // Quando transferir: só para cartões que acumulam pontos (não milhas
  // direto nem cashback puro). A Iberia só aparece para Santander e Revolut.
  // Ao lado do bônus, as milhas que os pontos do ano viram com esse bônus.
  // Link de indicação (extras.js → indicacao), identificado como tal.
  function indicacaoHtml(k) {
    const extra = (window.EXTRAS || {})[norm(k.nome.replace(/\s*\([^)]*\)$/, ''))];
    const i = extra && extra.indicacao;
    if (!i || !i.link) return '';
    return `<div class="indicacao">
        <p class="indicacao-tag">Link de indicação</p>
        <b>${esc(i.titulo || 'Use o meu código')}</b>
        ${i.beneficio ? `<p>${esc(i.beneficio)}</p>` : ''}
        <div class="indicacao-acoes">
          <a class="cta cta-a" href="${esc(i.link)}" target="_blank" rel="noopener sponsored">${esc(i.botao || 'Abrir conta')} ↗</a>
          ${i.codigo ? `<button type="button" class="codigo" data-copiar="${esc(i.codigo)}" aria-label="Copiar o código ${esc(i.codigo)}"><span>Código</span><strong>${esc(i.codigo)}</strong><em>copiar</em></button>` : ''}
        </div>
      </div>`;
  }

  function transferirHtml(r) {
    const B = window.BONUS_MINIMO, k = r.cartao, destino = r.transferencia;
    if (!B || ehAereo(k) || k.recompensa === 'cashback') return '';
    const origem = norm(programaDe(k) + ' ' + k.banco);
    const lista = B.programas.filter(p => (!p.so || p.so.test(origem)) && !(p.nao && p.nao.test(origem)));
    if (!lista.length) return '';
    const d = norm(destino || '');
    const pontos = ehNum(r.pontosAno) && r.pontosAno > 0 ? r.pontosAno : null;
    const milhas = p => {
      if (!pontos) return null;
      const chave = Object.keys(p.proporcao || {}).find(c => origem.includes(c));
      const prop = chave ? p.proporcao[chave] : 1;
      return Math.round(pontos * prop * (1 + (parseFloat(p.minimo) || 0) / 100));
    };
    return `<div class="transferir">
        <h4>Quando transferir seus pontos</h4>
        <p class="transferir-nota">Espere uma promoção com pelo menos este bônus antes de mandar os pontos para a companhia${pontos ? `. Com os seus ${inteiro.format(pontos)} pontos do ano, você teria:` : ':'}</p>
        <ul>${lista.map(p => {
          const m = milhas(p), seu = d && p.destino.test(d);
          return `<li class="${seu ? 'seu' : ''}">
          <span><b>${esc(p.nome)}</b>${seu ? '<em>destino usado na conta</em>' : ''}${p.obs ? `<small>${esc(p.obs)}</small>` : ''}</span>
          <span class="transferir-num"><strong>${esc(p.minimo)}</strong>${m ? `<span>≈ ${inteiro.format(m)} ${esc(p.unidade || 'milhas')}</span>` : ''}</span></li>`;
        }).join('')}</ul>
        ${B.dica ? `<p class="transferir-dica">${esc(B.dica)}</p>` : ''}
      </div>`;
  }

  function salasHtml(k) {
    const v = k.vip;
    if (!v.tem && !v.avisos.length) return '';
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

  function milheiroProprio(nome) {
    const M = window.MILHEIROS || {};
    const chave = Object.keys(M).find(k => norm(k) === norm(nome));
    return chave && ehNum(M[chave]) ? M[chave] : null;
  }

  function calculadora(gasto) {
    const trocas = { [modelo.aba.nome + '!' + modelo.refGasto]: gasto };
    if (dolarAoVivo && modelo.refDolar) trocas[modelo.aba.nome + '!' + modelo.refDolar] = dolarAoVivo.valor;
    // Valor do milheiro definido pelo site (milheiros.js) no lugar do da planilha.
    for (const m of modelo.milheiros) {
      const v = milheiroProprio(m.nome);
      if (v !== null) trocas[modelo.aba.nome + '!' + m.ref] = v;
    }
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
    // Com a renda informada, ficam de fora os só por convite e os de investimento alto (até pedir para ver).
    const escondeRestritos = estado.esconderRestritos || (estado.renda && !estado.verRestritos);
    if (escondeRestritos && (k.requisito.tipo === 'convite' || k.requisito.tipo === 'investimento')) return 'restrito';
    if (estado.renda && !estado.verAcimaRenda && k.requisito.tipo === 'renda' && k.requisito.valor > estado.renda) return 'renda';
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
          <p class="requisito">${ehIsento(k) ? 'Você já tem este cartão.' : `${k.requisito.tipo === 'desconhecida' ? '' : `<b>Para pedir:</b> ${esc(requisitoTexto(k))}. `}A aprovação depende da análise de crédito do banco.`}</p>
          <div class="valor-grande num">${esc(brl.format(r.liquido))}<small>por ano</small></div>
          <p class="valor-extra">Equivale a <b>${esc(decimal.format(pct))}% de volta</b> em tudo que você passa no cartão, ou ${esc(brl.format(r.liquido / 12))} por mês.</p>
          ${contaHtml(r)}
          ${indicacaoHtml(k)}
          ${transferirHtml(r)}
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
    listaVisivel = lista;
    const mostrados = lista.slice(0, estado.limite);
    const maior = Math.max(1, ...lista.map(r => r.liquido));
    $('#ranking').innerHTML = mostrados.map((r, i) => {
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
            <span class="item-desc">${esc([pontuacaoTxt(r), programaDe(k)].filter(x => x && x !== '—').join(' · '))}</span>
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

    const faltam = lista.length - mostrados.length;
    const btnMais = $('#ranking-mais');
    btnMais.hidden = !faltam && lista.length <= POR_PAGINA;
    btnMais.dataset.acao = faltam ? 'mais' : 'menos';
    btnMais.textContent = faltam ? `Ver mais ${Math.min(POR_PAGINA, faltam)} cartões (faltam ${faltam})` : `Mostrar só os ${POR_PAGINA} melhores`;

    const paraQuem = estado.renda && !estado.verAcimaRenda ?` para a sua renda de ${brl.format(estado.renda)}` : '';
    const partesNota = [`Os ${mostrados.length} melhores de ${lista.length} cartões${paraQuem}, com valores para ${moedaGasto()} por mês, já descontada a anuidade.`];
    if (!estado.renda) partesNota.push('Informe sua renda no simulador para ver só os cartões que você consegue pedir.');
    const nOcultos = ocultos.restrito + ocultos.renda;
    $('#ranking-nota').innerHTML = esc(partesNota.join(' ')) + (nOcultos ? ` <span class="ocultos">${[
      ocultos.restrito ? `${ocultos.restrito} só por convite ou investimento alto (<button type="button" data-mostrar-restritos>mostrar</button>)` : '',
      ocultos.renda ? `${ocultos.renda} pedem renda acima da sua (<button type="button" data-ver-acima>mostrar</button>)` : ''
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
    // Informações do site oficial que a planilha não tem (extras.js)
    const extra = (window.EXTRAS || {})[norm(k.nome.replace(/\s*\([^)]*\)$/, ''))];
    const extrasHtml = extra && extra.beneficios && extra.beneficios.length
      ? extra.beneficios.map(b => `<li class="extra">${esc(b)} <a href="${esc(extra.link || '#')}" target="_blank" rel="noopener">${esc(extra.fonte || 'site oficial')}</a></li>`).join('') : '';
    const todosBeneficios = beneficios + extrasHtml;

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
    ].filter(([, v]) => v && !/^[-?—\s]+$/.test(String(v)));

    const nomeLink = url => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return 'site'; } };

    return `<div>
        ${salasHtml(k)}
        ${todosBeneficios ? `<h4>Benefícios</h4><ul class="beneficios">${todosBeneficios}</ul>` : ''}
      </div>
      <div>
        <h4>Ficha</h4>
        <dl class="ficha">${ficha.map(([a, b]) => `<div><dt>${esc(a)}</dt><dd>${esc(b)}</dd></div>`).join('')}</dl>
        ${regraAnu || regraPts ? `<div class="faixas">${regraAnu}${regraPts}</div>` : ''}
        <h4 style="margin-top:18px">Como chegamos no valor</h4>
        ${contaHtml(r)}
        ${transferirHtml(r)}
        ${indicacaoHtml(k)}
        <label class="chave chave-detalhe"><input type="checkbox" data-isento="${esc(k.chave)}" ${ehIsento(k) ? 'checked' : ''}><span></span>Tenho isenção vitalícia de anuidade deste cartão</label>
        ${k.links.length ? `<div class="fontes">${k.links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(nomeLink(u))}</a>`).join('')}</div>` : ''}
      </div>`;
  }

  function desenharNovidades() {
    // A planilha repete a mesma mudança do cartão em várias datas: de início, só a mais recente de cada cartão;
    // "Ver todas" mostra o histórico inteiro.
    const lista = modelo.historico;
    const nomeDe = n => { const i = n.texto.indexOf(':'); return norm(i > 0 && i < 50 ? n.texto.slice(0, i) : n.texto); };
    const vistas = new Set();
    const recentes = lista.filter(n => !vistas.has(nomeDe(n)) && vistas.add(nomeDe(n)));
    const ul = $('#lista-novidades'), btn = $('#mais-novidades');
    if (!lista.length) { $('#novidades').hidden = true; return; }
    $('#novidades').hidden = false;
    const todas = btn.dataset.todas === '1';
    const mostrar = todas ? lista : recentes;
    ul.innerHTML = mostrar.map(n => {
      const i = n.texto.indexOf(':');
      const titulo = i > 0 && i < 50 ? n.texto.slice(0, i) : 'Mudança de regra';
      const corpo = i > 0 && i < 50 ? n.texto.slice(i + 1).trim() : n.texto;
      const data = n.detectada ? n.detectada.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : n.detectadaTxt;
      const quando = n.mudanca && !/^n[aã]o especificad/i.test(n.mudanca) ? `<span class="quando">Vale desde: ${esc(n.mudanca)}</span>` : '';
      return `<li class="novidade"><time>${esc(data)}</time><h3>${esc(titulo)}</h3><p>${esc(corpo.charAt(0).toUpperCase() + corpo.slice(1))}</p>${quando}</li>`;
    }).join('');
    btn.hidden = lista.length <= recentes.length;
    btn.textContent = todas ? 'Mostrar só a mais recente de cada cartão' : `Ver o histórico completo (${lista.length} registros)`;
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

  // Avisos para viajantes (avisos.js): em destaque no topo de Novidades.
  function desenharAvisos() {
    const hoje = new Date().toISOString().slice(0, 10);
    const lista = (window.AVISOS || []).filter(a => !a.ate || a.ate >= hoje);
    $('#avisos').innerHTML = lista.map(a => {
      const desde = /^\d{4}-\d{2}-\d{2}$/.test(a.desde || '') ? new Date(a.desde + 'T12:00:00').toLocaleDateString('pt-BR') : '';
      return `<article class="aviso-viagem">
          <p class="aviso-tag">Aviso para viajantes${desde ? ` · vale a partir de ${esc(desde)}` : ''}</p>
          <h3>${esc(a.titulo)}</h3>
          <p>${esc(a.resumo)}</p>
          ${a.itens && a.itens.length ? `<ul>${a.itens.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : ''}
          ${a.link ? `<a href="${esc(a.link)}" target="_blank" rel="noopener">Ver no site oficial${a.fonte ? ` · ${esc(a.fonte)}` : ''} ↗</a>` : ''}
        </article>`;
    }).join('');
  }

  // Notícias de cartões de outros sites: só título, data e link para a fonte.
  // O arquivo é atualizado pelo GitHub (ferramentas/noticias.py).
  let noticias = [];
  const filtroNoticia = { tema: '', todas: false };
  async function desenharNoticias() {
    try {
      const r = await fetch('dados/noticias.json', { cache: 'no-store' });
      const lista = r.ok ? await r.json() : [];
      if (!Array.isArray(lista) || !lista.length) return;
      noticias = lista;
      mostrarNoticias();
      $('#noticias').hidden = false;
    } catch (e) { /* sem notícias: a seção fica escondida */ }
  }
  function mostrarNoticias() {
    const lista = noticias.filter(n => !filtroNoticia.tema || (n.tema || 'cartoes') === filtroNoticia.tema);
    $('#noticias-tema').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tema === filtroNoticia.tema)));
    const btn = $('#mais-noticias');
    btn.hidden = lista.length <= 12;
    btn.textContent = filtroNoticia.todas ? 'Mostrar menos' : `Ver todas as ${lista.length} notícias`;
    {
      $('#lista-noticias').innerHTML = (filtroNoticia.todas ? lista : lista.slice(0, 12)).map(n => {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(n.data || '') ? new Date(n.data + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
        return `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">
            <span class="noticia-meta">${esc([d, n.fonte].filter(Boolean).join(' · '))}</span>
            <b>${esc(n.titulo)}</b>
            <span class="noticia-ler">Ler no ${esc(n.fonte || 'site de origem')} ↗</span>
          </a></li>`;
      }).join('');
    }
  }
  $('#noticias-tema').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { Object.assign(filtroNoticia, { tema: b.dataset.tema, todas: false }); mostrarNoticias(); } });
  $('#mais-noticias').addEventListener('click', () => { filtroNoticia.todas = !filtroNoticia.todas; mostrarNoticias(); });

  // Termômetro de milhas (dados/termometro.json): faixas por região, cabine e
  // programa, calculadora do milheiro e o selo que aparece nas passagens.
  let termometro = null;
  const termo = { regiao: '', cabine: 'eco' };
  const NOME_CABINE = { eco: 'Econômica', exe: 'Executiva' };
  const CLASSE_NIVEL = { espetacular: 'n-esp', 'muito bom': 'n-top', bom: 'n-otimo', normal: 'n-normal', caro: 'n-caro', 'péssimo': 'n-pess' };
  const BR = new Set('GRU GIG CGH SDU BSB CNF PLU VCP POA REC FOR SSA CWB FLN BEL MAO NAT MCZ VIX GYN CGB JPA AJU THE SLZ PMW CGR IGU NVT PVH MCP BVB RBR UDI LDB MGF JOI IOS BPS JDO CPV CXJ PNZ STM IMP RAO SJP'.split(' '));
  const programaTermo = p => {
    const t = norm(p);
    return /LATAM/.test(t) ? 'LATAM' : /SMILES|GOL/.test(t) ? 'Smiles' : /AZUL/.test(t) ? 'Azul'
      : /IBERIA|AVIOS|BRITISH|QATAR|PRIVILEGE/.test(t) ? 'Avios' : /TAP|MILES&GO/.test(t) ? 'TAP'
      : /VIRGIN/.test(t) ? 'Virgin' : /CONNECT|COPA/.test(t) ? 'Connectmiles' : /SUMA|AIR EUROPA/.test(t) ? 'Suma' : /AADVANTAGE|AMERICAN/.test(t) ? 'AA' : '';
  };
  const numeroMilhas = t => { const m = String(t || '').match(/([\d.]+)\s*(?:milhas|pontos|avios)/i); return m ? +m[1].replace(/\./g, '') : 0; };
  // Faixa da passagem: a melhor faixa cujo limite do programa cobre as milhas do trecho.
  function nivelPassagem(p) {
    if (!termometro || !BR.has(p.origem_iata)) return '';
    const regiao = termometro.regioes.find(r => r.aeroportos.includes(p.destino_iata));
    const faixas = regiao && regiao.cabines[ehExecutiva(p.cabine) ? 'exe' : 'eco'];
    const prog = programaTermo(p.programa), milhas = numeroMilhas(p.ida);
    if (!faixas || !prog || !milhas) return '';
    const comPrograma = termometro.niveis.filter(n => faixas[n] && faixas[n][prog]);
    const nivel = comPrograma.find(n => milhas <= faixas[n][prog]);
    if (nivel) return nivel;
    return comPrograma.at(-1) === 'péssimo' ? 'péssimo' : '';
  }
  const fmtMil = n => (n >= 1000 && n % 1000 === 0 ? `${n / 1000} mil` : n.toLocaleString('pt-BR'));
  function mostrarTermometro() {
    const t = termometro, regiao = t.regioes.find(r => r.id === termo.regiao) || t.regioes[0];
    termo.regiao = regiao.id;
    if (!regiao.cabines[termo.cabine]) termo.cabine = Object.keys(regiao.cabines)[0];
    const botoes = (itens, atual, attr) => itens.map(([id, nome]) => `<button type="button" data-${attr}="${esc(id)}" aria-pressed="${id === atual}">${esc(nome)}</button>`).join('');
    $('#termo-regiao').innerHTML = botoes(t.regioes.map(r => [r.id, r.nome]), termo.regiao, 'regiao');
    $('#termo-cabine').innerHTML = botoes(Object.keys(regiao.cabines).map(c => [c, NOME_CABINE[c] || c]), termo.cabine, 'cabine');
    $('#termo-cidades').textContent = regiao.cidades ? `Chegando por ${regiao.cidades}.` : '';
    const faixas = regiao.cabines[termo.cabine];
    $('#termo-faixas').innerHTML = t.niveis.filter(n => faixas[n]).map(n => `<div class="termo-faixa">
        <span class="${CLASSE_NIVEL[n]}">${esc(n)}</span>
        <ul>${Object.entries(faixas[n]).map(([prog, v]) => `<li><b>${fmtMil(v)}</b> ${esc(t.programas[prog] || prog)}</li>`).join('')}</ul>
      </div>`).join('');
  }
  const MOEDA = { BRL: 'R$', EUR: '€', GBP: '£' };
  function mostrarMilheiro() {
    const lista = termometro.milheiro, item = lista[+$('#milheiro-programa').value] || lista[0];
    const preco = parseFloat(String($('#milheiro-preco').value).replace(',', '.'));
    const sim = `${MOEDA[item.moeda] || ''} `;
    const valor = v => sim + v.toLocaleString('pt-BR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    const r = $('#milheiro-resposta');
    if (!(preco > 0)) {
      r.className = 'termo-resposta';
      r.textContent = `Para ${item.programa}, o milheiro vale a pena até ${valor(item.teto)}.`;
    } else if (preco <= item.teto) {
      r.className = 'termo-resposta ok';
      r.textContent = `Vale a pena: ${valor(preco)} está dentro do teto de ${valor(item.teto)} para ${item.programa}.`;
    } else {
      r.className = 'termo-resposta espera';
      r.textContent = `Melhor esperar: ${valor(preco)} passa do teto de ${valor(item.teto)}. As boas promoções costumam voltar.`;
    }
    if (item.dica) r.textContent += ` ${item.dica}`;
  }
  async function desenharTermometro() {
    try {
      const r = await fetch('dados/termometro.json', { cache: 'no-store' });
      termometro = r.ok ? await r.json() : null;
    } catch (e) { termometro = null; }
    if (!termometro || !termometro.regioes || !termometro.regioes.length) { $('#termometro').hidden = true; return; }
    $('#termo-dicas').innerHTML = (termometro.dicas || []).map(d => `<li>${esc(d)}</li>`).join('');
    const lista = termometro.milheiro || [];
    $('#milheiro-programa').innerHTML = lista.map((m, i) => `<option value="${i}">${esc(m.programa)}</option>`).join('');
    $('#milheiro-tetos').innerHTML = lista.map(m => `<li><b>${esc(m.programa)}</b> até ${MOEDA[m.moeda] || ''} ${m.teto.toLocaleString('pt-BR')}</li>`).join('');
    mostrarTermometro();
    mostrarMilheiro();
    mostrarPassagens();
  }
  $('#termo-regiao').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { termo.regiao = b.dataset.regiao; mostrarTermometro(); } });
  $('#termo-cabine').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { termo.cabine = b.dataset.cabine; mostrarTermometro(); } });
  $('#milheiro-programa').addEventListener('change', mostrarMilheiro);
  $('#milheiro-preco').addEventListener('input', mostrarMilheiro);

  // Combos de economia (dados/combos.json): passos numerados e uma calculadora por combo.
  let combos = [], euro = { valor: 6.3, aoVivo: false };
  const MILHEIRO_DE = { Avios: 'Avios', 'milhas Smiles': 'Smiles' };
  const reais = v => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  function contaCombo(c, gasto) {
    let cashMin = 0, cashMax = 0, valorMilhas = 0;
    const linhas = [];
    for (const p of c.passos) {
      const g = p.ganho;
      if (!g) continue;
      if (g.tipo === 'cashback') {
        cashMin += gasto * g.min / 100; cashMax += gasto * g.max / 100;
        linhas.push(`<li><b>${reais(gasto * g.min / 100)} a ${reais(gasto * g.max / 100)}</b> de cashback</li>`);
      } else {
        const qtd = Math.round(g.moeda === 'EUR' ? gasto / euro.valor * g.por : gasto * g.por);
        const milheiro = (window.MILHEIROS || {})[MILHEIRO_DE[g.programa]];
        const valor = milheiro ? qtd / 1000 * milheiro : 0;
        valorMilhas += valor;
        linhas.push(`<li><b>${qtd.toLocaleString('pt-BR')} ${esc(g.programa)}</b>${g.rotulo ? ` ${esc(g.rotulo)}` : ''}${valor ? `, que valem cerca de ${reais(valor)}` : ''}</li>`);
      }
    }
    const total = cashMin === cashMax ? reais(cashMin + valorMilhas) : `${reais(cashMin + valorMilhas)} a ${reais(cashMax + valorMilhas)}`;
    return `<ul>${linhas.join('')}</ul><p class="combo-total">No fim, volta <b>${total}</b> em dinheiro e milhas.</p>`;
  }
  function comboHtml(c) {
    const quando = new Date(c.conferido + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const temConta = c.passos.some(p => p.ganho);
    return `<article class="combo" data-combo="${esc(c.id)}">
        <header><h3>${esc(c.titulo)}</h3><span class="combo-data">Conferido em ${esc(quando)}</span></header>
        <p class="combo-chamada">${esc(c.chamada)}</p>
        <ol class="combo-passos">${c.passos.map(p => `<li><b>${esc(p.titulo)}</b><span>${esc(p.texto)}</span></li>`).join('')}</ol>
        ${temConta ? `<div class="combo-calc">
          <label>Quanto você vai gastar? <span class="combo-campo">R$ <input type="number" min="0" step="50" value="2000" inputmode="numeric" aria-label="Valor do gasto em reais"></span></label>
          <div class="combo-resultado" aria-live="polite"></div>
          ${c.passos.some(p => p.ganho && p.ganho.moeda === 'EUR') ? `<p class="combo-nota">Com o euro a ${euro.valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}${euro.aoVivo ? ' (agora)' : ' (aproximado)'}. As milhas valem pelo milheiro da tabela do site.</p>` : ''}
        </div>` : ''}
        <details class="combo-atencao"><summary>Antes de fazer, atenção</summary><ul>${c.atencao.map(a => `<li>${esc(a)}</li>`).join('')}</ul>
          <p class="combo-fontes">Fontes: ${c.fontes.map(f => `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nome)}</a>`).join(' · ')}</p></details>
      </article>`;
  }
  function atualizarCombo(el) {
    const c = combos.find(x => x.id === el.dataset.combo), campo = el.querySelector('input');
    if (!c || !campo) return;
    const gasto = parseFloat(campo.value);
    el.querySelector('.combo-resultado').innerHTML = gasto > 0 ? contaCombo(c, gasto) : '<p class="combo-total">Digite um valor maior que zero.</p>';
  }
  async function desenharCombos() {
    try {
      const [r, e] = await Promise.all([fetch('dados/combos.json', { cache: 'no-store' }),
        fetch('https://economia.awesomeapi.com.br/json/last/EUR-BRL', { cache: 'no-store' }).catch(() => null)]);
      combos = r.ok ? await r.json() : [];
      const bid = e && e.ok ? parseFloat((await e.json()).EURBRL.bid) : NaN;
      if (bid > 1 && bid < 50) euro = { valor: bid, aoVivo: true };
    } catch (err) { combos = combos || []; }
    if (!combos.length) { $('#combos').hidden = true; return; }
    $('#lista-combos').innerHTML = combos.map(comboHtml).join('');
    document.querySelectorAll('.combo').forEach(atualizarCombo);
  }
  $('#lista-combos').addEventListener('input', e => { const el = e.target.closest('.combo'); if (el) atualizarCombo(el); });

  // Guia de emissão (dados/guia.json): por companhia, onde procurar a tarifa award,
  // por qual programa emitir, quando costuma aparecer e quantos assentos libera.
  let guia = null;
  const filtroGuia = { grupo: '', busca: '', programa: '' };
  // Quem tem Avios emite por Iberia, British ou Qatar: no filtro, tudo isso é um programa só.
  const familia = n => (/Avios/.test(n) ? 'Avios (Iberia, British ou Qatar)' : n);
  const chaveCia = n => norm(n).replace(/\b(AIRLINES|AIRWAYS|AIR LINES)\b/g, '').replace(/\s+/g, '');
  function ciaHtml(e) {
    const ap = guia.aparece.find(a => chaveCia(a.cia) === chaveCia(e.cia));
    const as = guia.assentos.find(a => chaveCia(a.cia) === chaveCia(e.cia));
    const melhor = e.programas.filter(p => p.melhor).map(p => p.nome);
    const onde = e.pesquisar || guia.pesquisar[e.grupo] || [];
    const assentos = as && [['Econômica', as.eco], ['Executiva', as.exe], ['Primeira', as.first]].filter(([, v]) => v);
    return `<li><details>
        <summary><span class="guia-nome">${logosCia(e.cia)}${esc(e.cia)}</span><small>${esc(e.grupo)}</small>${melhor.length ? `<em>Emita por ${esc(melhor.join(' ou '))}</em>` : ''}</summary>
        <div class="guia-corpo">
          ${e.nota ? `<p>${esc(e.nota)}</p>` : ''}
          ${e.propria ? `<h5>Na própria companhia</h5><p>${esc(e.propria)}</p>` : ''}
          ${onde.length ? `<h5>Onde procurar a tarifa award</h5><ul>${onde.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
          ${e.programas.length ? `<h5>Por qual programa emitir</h5><ul class="guia-progs">${e.programas.map(p => `<li${p.melhor ? ' class="melhor"' : ''}><b>${esc(p.nome)}</b>${p.melhor ? '<em>melhor opção</em>' : ''}${p.obs ? `<span>${esc(p.obs)}</span>` : ''}</li>`).join('')}</ul>` : ''}
          ${ap ? `<h5>Quando costuma aparecer</h5><dl class="guia-cab">${Object.entries(ap.cabines).map(([c, t]) => `<dt>${esc(c)}</dt><dd>${esc(t)}</dd>`).join('')}</dl>${ap.obs ? `<p class="guia-obs">${esc(ap.obs)}</p>` : ''}` : ''}
          ${assentos && assentos.length ? `<h5>Assentos award por voo, no máximo</h5><p class="guia-assentos">${assentos.map(([c, v]) => `<span>${esc(c)} <b>${esc(v)}</b></span>`).join('')}</p>${as.obs ? `<p class="guia-obs">${esc(as.obs)}</p>` : ''}` : ''}
        </div>
      </details></li>`;
  }
  function mostrarGuia() {
    const busca = norm(filtroGuia.busca);
    const grupos = [...new Set(guia.emitir.map(e => e.grupo))];
    $('#guia-grupos').innerHTML = [['', 'Todas'], ...grupos.map(g => [g, g])].map(([id, nome]) =>
      `<button type="button" data-grupo="${esc(id)}" aria-pressed="${id === filtroGuia.grupo}">${esc(nome)}</button>`).join('');
    const prog = filtroGuia.programa;
    const lista = guia.emitir.filter(e => (!filtroGuia.grupo || e.grupo === filtroGuia.grupo) && (!busca || norm(e.cia).includes(busca))
      && (!prog || e.programas.some(p => familia(p.nome) === prog)));
    const dicas = filtroGuia.grupo && guia.pesquisar[filtroGuia.grupo];
    $('#guia-pesquisa').textContent = [
      prog ? `Com pontos em ${prog}, dá para emitir ${lista.length} ${lista.length === 1 ? 'companhia' : 'companhias'}${filtroGuia.grupo ? ` da ${filtroGuia.grupo}` : ''}.` : '',
      dicas ? `Na ${filtroGuia.grupo}, a busca é parecida para todas as companhias: ${dicas.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
    $('#guia-cias').innerHTML = lista.map(ciaHtml).join('');
    $('#guia-vazio').hidden = !!lista.length;
    if (busca && lista.length === 1) $('#guia-cias details').open = true;
  }
  function mostrarCancelamento() {
    const c = guia.cancelamento[+$('#canc-programa').value] || guia.cancelamento[0];
    $('#canc-regras').innerHTML = `<ul>${c.regras.map(r => `<li class="n${r.n}">${esc(r.t)}</li>`).join('')}</ul>`;
  }
  async function desenharGuia() {
    try {
      const r = await fetch('dados/guia.json', { cache: 'no-store' });
      guia = r.ok ? await r.json() : null;
    } catch (e) { guia = null; }
    if (!guia || !guia.emitir) { $('#guia').hidden = true; return; }
    const progs = [...new Set(guia.emitir.flatMap(e => e.programas.map(p => familia(p.nome))))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    $('#guia-programa').insertAdjacentHTML('beforeend', progs.map(p => `<option>${esc(p)}</option>`).join(''));
    mostrarGuia();
    $('#canc-programa').innerHTML = guia.cancelamento.map((c, i) => `<option value="${i}">${esc(c.programa)}</option>`).join('');
    mostrarCancelamento();
    if (guia.bonus && guia.bonus.length) {
      $('#bonus-lista').innerHTML = guia.bonus.map(b => `<li><b>${esc(b.programa)}</b><span>${esc(b.minimo)}</span>${b.obs ? `<small>${esc(b.obs)}</small>` : ''}</li>`).join('');
      $('#bonus-bloco').hidden = false;
    }
  }
  $('#guia-busca').addEventListener('input', e => { filtroGuia.busca = e.target.value; mostrarGuia(); });
  $('#guia-grupos').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { filtroGuia.grupo = b.dataset.grupo; mostrarGuia(); } });
  $('#guia-programa').addEventListener('change', e => { filtroGuia.programa = e.target.value; mostrarGuia(); });
  $('#canc-programa').addEventListener('change', mostrarCancelamento);

  // Passagens e promoções dos grupos de alertas do Telegram (ferramentas/alertas.py).
  // O arquivo já vem só com o que ainda vale; aqui o prazo é conferido de novo,
  // para o item sumir na hora certa mesmo se a atualização atrasar.
  const PRAZO_PASSAGEM = 48 * 3600e3, POR_VEZ = 12;
  const filtroPassagem = { tipo: 'passagem', busca: '', cabine: '', todas: false };
  let passagens = [];
  function haQuanto(ms) {
    const min = Math.max(1, Math.round(ms / 60e3));
    return min < 60 ? `há ${min} min` : min < 48 * 60 ? `há ${Math.round(min / 60)} h` : `há ${Math.round(min / 1440)} dias`;
  }
  const ehExecutiva = c => /execut|primeira|first|business|premium/i.test(c || '');
  const ehPromocao = p => p.tipo === 'promocao';
  // Promoção com validade vale até o fim desse dia; as outras, 48 h depois de postadas.
  const venceEm = p => (ehPromocao(p) && !isNaN(Date.parse(p.ate)) ? Date.parse(p.ate) : Date.parse(p.data) + PRAZO_PASSAGEM);
  const diaBR = t => new Date(t).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const ultimoDia = (p, agora) => (!isNaN(Date.parse(p.ate)) ? diaBR(Date.parse(p.ate)) === diaBR(agora) : p.ultimo_dia && agora - Date.parse(p.data) < 86400e3);
  const httpOk = u => /^https?:\/\//.test(u || '');
  function datasHtml(rotulo, lista) {
    if (!lista || !lista.length) return '';
    return `<div class="pass-datas"><span>${rotulo}</span><ul>${lista.map(d => `<li><b>${esc(d.mes)}</b> ${esc(d.dias)}</li>`).join('')}</ul></div>`;
  }
  // Ícone da companhia ao lado do nome, pelo código IATA (ícones do Google Voos).
  const IATA_CIA = [[/LATAM|\bLAN\b/, 'LA'], [/AZUL/, 'AD'], [/\bGOL\b/, 'G3'], [/TAP/, 'TP'], [/QATAR/, 'QR'], [/AIR FRANCE/, 'AF'],
    [/SOUTH AFRICAN/, 'SA'], [/COPA/, 'CM'], [/ETIHAD/, 'EY'], [/AMERICAN/, 'AA'], [/ROYAL AIR MAROC/, 'AT'], [/AIR CANADA/, 'AC'],
    [/JAPAN AIRLINES/, 'JL'], [/AVIANCA/, 'AV'], [/TURKISH/, 'TK'], [/KOREAN/, 'KE'], [/FINNAIR/, 'AY'], [/SWISS/, 'LX'],
    [/IBERIA/, 'IB'], [/BRITISH/, 'BA'], [/LUFTHANSA/, 'LH'], [/KLM/, 'KL'], [/DELTA/, 'DL'], [/UNITED/, 'UA'], [/EMIRATES/, 'EK'],
    [/AIR EUROPA/, 'UX'], [/AEROLINEAS|AEROLÍNEAS/, 'AR'], [/AEROMEXICO|AEROMÉXICO/, 'AM'], [/ETHIOPIAN/, 'ET'], [/VIRGIN/, 'VS'],
    [/ITA AIRWAYS/, 'AZ'], [/AIR CHINA/, 'CA'], [/SINGAPORE/, 'SQ'], [/QANTAS/, 'QF'], [/CATHAY/, 'CX'], [/\bANA\b|ALL NIPPON/, 'NH'],
    [/SKY AIRLINE/, 'H2'], [/JETSMART/, 'JA'], [/ARAJET/, 'DM'], [/BOLIVIANA/, 'OB'], [/PARANAIR/, 'ZP'],
    [/AIR NEW ZEALAND/, 'NZ'], [/ASIANA/, 'OZ'], [/AUSTRIAN/, 'OS'], [/BRUSSELS/, 'SN'], [/EGYPT/, 'MS'], [/\bLOT\b/, 'LO'],
    [/THAI/, 'TG'], [/\bEVA\b/, 'BR'], [/ROYAL JORDANIAN/, 'RJ'], [/MALAYSIA/, 'MH'], [/SRILANKAN|SRI LANKAN/, 'UL'], [/FIJI/, 'FJ'],
    [/ALASKA/, 'AS'], [/CHINA EASTERN/, 'MU'], [/CHINA AIRLINES/, 'CI'], [/SAUDIA/, 'SV'], [/KENYA/, 'KQ'], [/MIDDLE EAST/, 'ME'],
    [/XIAMEN/, 'MF'], [/AIR INDIA/, 'AI'], [/AEGEAN/, 'A3'], [/OMAN/, 'WY'], [/CROATIA/, 'OU'], [/SHENZHEN/, 'ZH'], [/CZECH/, 'OK'],
    [/AER LINGUS/, 'EI'], [/\bSAS\b|SCANDINAVIAN/, 'SK'], [/ICELANDAIR/, 'FI'], [/AIR TRANSAT/, 'TS'], [/VOLARIS/, 'Y4'], [/WINGO/, 'P5']];
  function logosCia(nome) {
    const t = norm(nome);
    const codigos = [...new Set(t.split('+').map(parte => (IATA_CIA.find(([re]) => re.test(parte)) || [])[1]).filter(Boolean))];
    return codigos.map(c => `<img class="pass-logo" src="https://www.gstatic.com/flights/airline_logos/70px/${c}.png" alt="" width="22" height="22" loading="lazy" onerror="this.remove()">`).join('');
  }
  function passagemHtml(p, agora) {
    const nivel = nivelPassagem(p);
    const selo = ['espetacular', 'muito bom', 'bom'].includes(nivel)
      ? `<a class="pass-selo ${CLASSE_NIVEL[nivel]}" href="#termometro" title="Pelo termômetro de milhas">${nivel === 'espetacular' ? '🔥 ' : ''}${esc(nivel)}</a>` : '';
    return `<li class="${ehExecutiva(p.cabine) ? 'exe' : ''}">
        <p class="pass-meta"><time datetime="${esc(p.data)}">${haQuanto(agora - new Date(p.data))}</time>${p.cabine ? ` · ${esc(p.cabine)}` : ''}${selo}</p>
        <h3 class="pass-rota">
          <span><b>${esc(p.origem_iata)}</b>${esc(p.origem)}</span>
          <i aria-label="para">✈</i>
          <span><b>${esc(p.destino_iata)}</b>${esc(p.destino)}</span>
        </h3>
        <p class="pass-cia">${logosCia(p.companhia)}${esc(p.companhia)}${p.programa ? ` · <b>${esc(p.programa)}</b>` : ''}</p>
        <dl class="pass-valores">
          <div><dt>Ida</dt><dd>${esc(p.ida)}</dd></div>
          ${p.volta ? `<div><dt>Volta</dt><dd>${esc(p.volta)}</dd></div>` : ''}
        </dl>
        ${datasHtml('Datas de ida', p.datas_ida)}${datasHtml('Datas de volta', p.datas_volta)}
        <a class="cta cta-a pass-link" href="${esc(p.link)}" target="_blank" rel="noopener">Ver passagem${p.link_nome ? ` na ${esc(p.link_nome)}` : ''} ↗</a>
      </li>`;
  }
  function promocaoHtml(p, agora) {
    const links = (p.links || []).filter(httpOk);
    const site = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return 'site'; } };
    return `<li class="promo">
        <p class="pass-meta"><time datetime="${esc(p.data)}">${haQuanto(agora - new Date(p.data))}</time>${p.validade ? ` · até ${esc(p.validade)}` : ''}</p>
        ${ultimoDia(p, agora) || p.selo ? `<p class="promo-selos">${ultimoDia(p, agora) ? '<span class="urgente">Último dia</span>' : ''}${p.selo ? `<span>${esc(p.selo)}</span>` : ''}</p>` : ''}
        <h3 class="promo-titulo">${esc(p.titulo)}</h3>
        ${p.resumo ? `<p class="promo-resumo">${esc(p.resumo)}</p>` : ''}
        ${p.detalhes && p.detalhes.length ? `<details class="promo-detalhes"><summary>Como funciona</summary><ul>${p.detalhes.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>` : ''}
        ${p.parceiros ? `<p class="pass-cia">Parceiros: <b>${esc(p.parceiros)}</b></p>` : ''}
        <div class="promo-links">${links.map((u, i) => `<a class="cta ${i ? 'cta-b' : 'cta-a'} pass-link" href="${esc(u)}" target="_blank" rel="noopener">${links.length > 1 ? `Abrir ${esc(site(u))}` : 'Ver promoção'} ↗</a>`).join('')}</div>
      </li>`;
  }
  function mostrarPassagens() {
    const agora = Date.now(), f = filtroPassagem;
    const promo = f.tipo === 'promocao';
    const busca = norm(f.busca);
    const vivas = passagens.filter(p => agora < venceEm(p));
    const doTipo = vivas.filter(p => ehPromocao(p) === promo);
    const lista = doTipo.filter(p => promo
      ? (!busca || norm([p.titulo, p.parceiros, p.resumo].join(' ')).includes(busca))
      : (!f.cabine || (f.cabine === 'exe') === ehExecutiva(p.cabine)) &&
        (!busca || norm([p.origem, p.origem_iata, p.destino, p.destino_iata].join(' ')).includes(busca)));
    const mostrar = f.todas ? lista : lista.slice(0, POR_VEZ);
    $('#lista-passagens').innerHTML = mostrar.map(p => promo ? promocaoHtml(p, agora) : passagemHtml(p, agora)).join('');
    $('#passagens-cabine').hidden = promo;
    const campo = $('#passagens-busca');
    campo.placeholder = promo ? 'Buscar programa ou loja, ex.: Livelo' : 'Buscar cidade ou aeroporto, ex.: GRU';
    campo.setAttribute('aria-label', campo.placeholder.replace(/, ex\..*/, ''));
    const qtd = t => vivas.filter(p => ehPromocao(p) === (t === 'promocao')).length;
    $('#passagens-tipo').querySelectorAll('button').forEach(x => {
      x.setAttribute('aria-pressed', String(x.dataset.tipo === f.tipo));
      x.querySelector('small').textContent = qtd(x.dataset.tipo);
    });
    const nomeTipo = promo ? 'promoção' : 'passagem';
    const vazio = $('#passagens-vazio');
    vazio.hidden = !!lista.length;
    vazio.textContent = doTipo.length ? `Nenhuma ${nomeTipo} com esse filtro agora.` : `Nenhuma ${nomeTipo} nas últimas 48 horas. As próximas aparecem aqui assim que forem publicadas.`;
    const btn = $('#mais-passagens');
    btn.hidden = lista.length <= POR_VEZ;
    btn.textContent = f.todas ? 'Mostrar menos' : `Ver todas as ${lista.length} ${promo ? 'promoções' : 'passagens'}`;
  }
  async function desenharPassagens() {
    try {
      const r = await fetch('dados/alertas.json', { cache: 'no-store' });
      const lista = r.ok ? await r.json() : [];
      if (Array.isArray(lista)) {
        passagens = lista.filter(p => p && !isNaN(Date.parse(p.data)) &&
          (ehPromocao(p) ? p.titulo && (p.links || []).some(httpOk) : p.origem_iata && httpOk(p.link)));
      }
    } catch (e) { /* mantém os que já estavam na tela */ }
    mostrarPassagens();
  }
  $('#passagens-busca').addEventListener('input', e => { filtroPassagem.busca = e.target.value; mostrarPassagens(); });
  $('#passagens-tipo').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    Object.assign(filtroPassagem, { tipo: b.dataset.tipo, busca: '', todas: false });
    $('#passagens-busca').value = '';
    mostrarPassagens();
  });
  $('#passagens-cabine').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    filtroPassagem.cabine = b.dataset.cabine;
    $('#passagens-cabine').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    mostrarPassagens();
  });
  $('#mais-passagens').addEventListener('click', () => { filtroPassagem.todas = !filtroPassagem.todas; mostrarPassagens(); });

  // Telefones das companhias e programas: planilha do Felipe (Nome, Telefone),
  // lida ao vivo; se o Google não responder, vale a cópia em dados/contatos.csv.
  const URL_CONTATOS = 'https://docs.google.com/spreadsheets/d/1i6xbxNXBqKnGIJCXnQpQpRY0n2BQdjZDnP82fECtirs/export?format=csv&gid=0';
  let contatos = [];
  function lerCsv(txt) {
    const linhas = [];
    let campo = '', linha = [], aspas = false;
    for (let i = 0; i < txt.length; i++) {
      const c = txt[i];
      if (aspas) {
        if (c === '"' && txt[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') aspas = false; else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === ',') { linha.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && txt[i + 1] === '\n') i++; linha.push(campo); linhas.push(linha); linha = []; campo = ''; }
      else campo += c;
    }
    if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
    return linhas;
  }
  // Link de ligar (ou de WhatsApp) a partir do número como está na planilha.
  function linkTelefone(nome, tel) {
    const d = tel.replace(/\D/g, '');
    if (/whats/i.test(nome)) return { href: `https://wa.me/${d}`, zap: true };
    // DDD + número (10 ou 11 dígitos, sem 0800/0300/4003...) ganha o +55.
    const ddd = /^[1-9][1-9]\d{8,9}$/.test(d) && !/^(300|400|800)/.test(d);
    return { href: `tel:${ddd ? '+55' + d : d}`, zap: false };
  }
  function montarContatos(txt) {
    const linhas = lerCsv(txt).slice(1).filter(l => (l[0] || '').trim() && (l[1] || '').trim());
    const grupos = new Map();
    for (const [nomeBruto, tel] of linhas) {
      // "TAP - SAC para..." e "Iberia (WhatsApp)" ficam junto da TAP e da Iberia.
      const nomeLimpo = nomeBruto.trim();
      const [base, ...resto] = nomeLimpo.split(/\s+-\s+|\s*\(/);
      const chave = norm(base.replace(/\s+Brasil$/i, ''));
      if (!grupos.has(chave)) grupos.set(chave, { nome: base.replace(/\s+Brasil$/i, '').trim(), numeros: [] });
      grupos.get(chave).numeros.push({ tel: tel.trim(), rotulo: resto.join(' ').replace(/\)$/, '').trim(), ...linkTelefone(nomeLimpo, tel) });
    }
    return [...grupos.values()].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  function mostrarContatos() {
    const busca = norm($('#contatos-busca').value);
    const lista = contatos.filter(c => !busca || norm(c.nome + ' ' + c.numeros.map(n => n.rotulo).join(' ')).includes(busca));
    $('#lista-contatos').innerHTML = lista.map(c => `<li>
        <h3>${esc(c.nome)}</h3>
        <ul>${c.numeros.map(n => `<li><a class="${n.zap ? 'zap' : ''}" href="${esc(n.href)}"${n.zap ? ' target="_blank" rel="noopener"' : ''}>${esc(n.tel)}${n.rotulo ? ` <small>${esc(n.rotulo)}</small>` : ''}</a></li>`).join('')}</ul>
      </li>`).join('');
    $('#contatos-vazio').hidden = !!lista.length || !contatos.length;
  }
  async function desenharContatos() {
    for (const url of [URL_CONTATOS, 'dados/contatos.csv']) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) continue;
        const lista = montarContatos(await r.text());
        if (lista.length) { contatos = lista; break; }
      } catch (e) { /* tenta a cópia */ }
    }
    $('#contatos').hidden = !contatos.length;
    mostrarContatos();
  }
  $('#contatos-busca').addEventListener('input', mostrarContatos);

  // Calendário de oportunidades: planilha do Felipe em grade (nome do mês e,
  // logo abaixo, as datas do mês numa célula, separadas por linha em branco).
  const URL_DATAS = 'https://docs.google.com/spreadsheets/d/1AYr5xj9Ydud3Y5onEEEb-k6QfwEU7JZyZyLszyn-iOA/export?format=csv&gid=0';
  const MESES = ['JANEIRO', 'FEVEREIRO', 'MARCO', 'ABRIL', 'MAIO', 'JUNHO', 'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  function montarCalendario(txt) {
    const g = lerCsv(txt), meses = MESES.map(() => []);
    g.forEach((linha, i) => linha.forEach((cel, j) => {
      const m = MESES.indexOf(norm(cel));
      if (m < 0) return;
      // As datas ficam na primeira célula preenchida abaixo do nome do mês.
      for (let k = i + 1; k < Math.min(g.length, i + 6); k++) {
        const v = (g[k][j] || '').trim();
        if (MESES.includes(norm(v))) break;
        if (v) { meses[m] = v.split(/\n\s*\n/).map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean); break; }
      }
    }));
    return meses.map(itens => itens.map(t => {
      const d = t.match(/^Dias?\s+(\d{1,2}(?:\s*(?:e|a|,)\s*\d{1,2})*)\s*[-–]\s*(.+)$/i);
      return d ? { dia: d[1].replace(/\s+/g, ' '), texto: d[2], primeiro: +d[1].match(/\d+/)[0] } : { dia: '', texto: t, primeiro: 0 };
    }));
  }
  async function desenharCalendario() {
    let meses = null;
    for (const url of [URL_DATAS, 'dados/datas.csv']) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) continue;
        const m = montarCalendario(await r.text());
        if (m.some(x => x.length)) { meses = m; break; }
      } catch (e) { /* tenta a cópia */ }
    }
    if (!meses) return;
    const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const mesAtual = hoje.getMonth(), diaHoje = hoje.getDate();
    const nomeMes = m => new Date(2000, m, 1).toLocaleDateString('pt-BR', { month: 'long' });
    $('#lista-calendario').innerHTML = MESES.map((_, n) => (mesAtual + n) % 12).map(m => {
      const agora = m === mesAtual;
      const itens = meses[m].map(x => {
        const passou = agora && x.primeiro && x.primeiro < diaHoje;
        const falta = agora && x.primeiro ? x.primeiro - diaHoje : -1;
        const aviso = falta === 0 ? 'hoje' : falta > 0 && falta <= 7 ? `em ${falta} dia${falta > 1 ? 's' : ''}` : '';
        return `<li class="${passou ? 'passou' : ''}"><b>${x.dia ? esc(x.dia) : 'mês'}</b><span>${esc(x.texto)}${aviso ? `<em>${aviso}</em>` : ''}</span></li>`;
      }).join('');
      return `<li class="${agora ? 'agora' : ''}">
          <h4>${esc(nomeMes(m))}${agora ? '<span>Este mês</span>' : ''}</h4>
          ${itens ? `<ul>${itens}</ul>` : '<p class="sem">Sem data marcada.</p>'}
        </li>`;
    }).join('');
    $('#calendario').hidden = false;
  }

  // Quanto pagar numa passagem: planilha do Felipe, aba em reais (gid=0) e aba MILHAS.
  const ID_QUANTO = '1UVCaLldcH1CfOJNFmZPlXzCmijKxePTPArduYoKscW8';
  const FONTES_QUANTO = {
    reais: [`https://docs.google.com/spreadsheets/d/${ID_QUANTO}/export?format=csv&gid=0`, 'dados/precos-reais.csv'],
    milhas: [`https://docs.google.com/spreadsheets/d/${ID_QUANTO}/gviz/tq?tqx=out:csv&headers=0&sheet=MILHAS`, 'dados/precos-milhas.csv'],
  };
  const NIVEIS = { TOP: 'top', OTIMO: 'otimo', NORMAL: 'normal', CARO: 'caro' };
  const quanto = { tipo: 'reais', reais: [], eco: [], exe: [] };
  const limpa = t => String(t || '').replace(/\s+/g, ' ').trim();
  async function lerFonte(urls) {
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (r.ok) { const g = lerCsv(await r.text()); if (g.length > 2) return g; }
      } catch (e) { /* tenta a cópia */ }
    }
    return [];
  }
  // Acha a linha "CONTINENTE ..." e lê as colunas de nível (TOP, ÓTIMO, NORMAL, CARO) de cada bloco.
  function lerTabela(g, inicioCol, padrao) {
    const h = g.findIndex(l => norm(l[0]) === 'CONTINENTE');
    if (h < 0) return [];
    const cab = g[h].map(c => NIVEIS[norm(c)]);
    const cols = padrao.map((nivel, i) => ({ col: inicioCol + i, nivel: cab[inicioCol + i] || nivel }));
    const vistos = new Set();
    return g.slice(h + 1).filter(l => limpa(l[0]) && limpa(l[1])).map(l => ({
      continente: limpa(l[0]), linha: l,
    })).filter(x => { const k = x.linha.join('|'); if (vistos.has(k)) return false; vistos.add(k); return true; })
      .map(x => ({ continente: x.continente, linha: x.linha, cols }));
  }
  function montarQuanto(reais, milhas) {
    quanto.reais = lerTabela(reais, 3, ['top', 'otimo', 'normal', 'caro']).map(({ continente, linha, cols }) => {
      const pais = limpa(linha[1]), cidade = limpa(linha[2]);
      const temCidade = cidade && cidade !== '-';
      return { continente, destino: temCidade ? cidade : pais, sub: temCidade && pais !== cidade ? pais : '',
        valores: cols.map(c => ({ nivel: c.nivel, itens: [limpa(linha[c.col])] })) };
    });
    const programas = t => String(t || '').split('\n').map(limpa).filter(x => x && x !== '-').map(x => {
      const m = x.match(/^([^:]+):\s*(.+)$/);
      return m ? { prog: m[1].trim(), valor: m[2].trim() } : { prog: '', valor: x };
    });
    const linhasMilhas = lerTabela(milhas, 2, ['top', 'otimo', 'normal', 'caro', 'top', 'normal', 'caro']);
    const destinoMilhas = linha => { const partes = String(linha[1]).split('\n').map(limpa).filter(Boolean); return partes.length > 1 ? { destino: partes.slice(1).join(' '), sub: partes[0] } : { destino: partes[0], sub: '' }; };
    quanto.eco = linhasMilhas.map(({ continente, linha, cols }) => ({ continente, ...destinoMilhas(linha),
      valores: cols.slice(0, 4).map(c => ({ nivel: c.nivel, itens: programas(linha[c.col]) })) }));
    quanto.exe = linhasMilhas.map(({ continente, linha, cols }) => ({ continente, ...destinoMilhas(linha),
      valores: cols.slice(4).map(c => ({ nivel: c.nivel, itens: programas(linha[c.col]) })) }))
      .filter(x => x.valores.some(v => v.itens.length));
  }
  const NOME_NIVEL = { top: 'Top', otimo: 'Ótimo', normal: 'Normal', caro: 'Caro' };
  function mostrarQuanto() {
    const lista = quanto[quanto.tipo] || [];
    const busca = norm($('#quanto-busca').value);
    const vis = lista.filter(x => !busca || norm([x.destino, x.sub, x.continente].join(' ')).includes(busca));
    const grupos = [];
    vis.forEach(x => { let g = grupos.find(y => y.nome === x.continente); if (!g) grupos.push(g = { nome: x.continente, itens: [] }); g.itens.push(x); });
    const niveis = lista[0] ? lista[0].valores.map(v => v.nivel) : [];
    const celula = v => {
      if (!v.itens.length) return `<td class="c-${v.nivel}">–</td>`;
      if (quanto.tipo === 'reais') return `<td class="c-${v.nivel}">${esc(v.itens[0].replace(/,00$/, ''))}</td>`;
      return `<td class="c-${v.nivel}"><ul>${v.itens.map(i => `<li>${i.prog ? `<b>${esc(i.prog)}</b>` : ''}${esc(i.valor)}</li>`).join('')}</ul></td>`;
    };
    $('#quanto-tabelas').innerHTML = grupos.map(g => `<div class="quanto-grupo">
        <h3>${esc(g.nome)}</h3>
        <div class="quanto-rolar"><table class="quanto-tab">
          <thead><tr><th>Destino</th>${niveis.map(n => `<th><span class="n-${n}">${NOME_NIVEL[n]}</span></th>`).join('')}</tr></thead>
          <tbody>${g.itens.map(x => `<tr><th>${esc(x.destino)}${x.sub ? `<small>${esc(x.sub)}</small>` : ''}</th>${x.valores.map(celula).join('')}</tr>`).join('')}</tbody>
        </table></div>
      </div>`).join('');
    $('#quanto-vazio').hidden = !!vis.length || !lista.length;
    $('#quanto-tipo').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tipo === quanto.tipo)));
  }
  async function desenharQuanto() {
    const [reais, milhas] = await Promise.all([lerFonte(FONTES_QUANTO.reais), lerFonte(FONTES_QUANTO.milhas)]);
    montarQuanto(reais, milhas);
    if (!quanto.reais.length && !quanto.eco.length) { $('#quanto').hidden = true; return; }
    if (!quanto.reais.length) quanto.tipo = 'eco';
    mostrarQuanto();
  }
  $('#quanto-tipo').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { quanto.tipo = b.dataset.tipo; mostrarQuanto(); } });
  $('#quanto-busca').addEventListener('input', mostrarQuanto);

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
    const linha = (a, b, sub) => `<div><dt>${esc(a)}${sub ? `<small>${esc(sub)}</small>` : ''}</dt><dd>${esc(b)}</dd></div>`;
    const titulo = (t, nota) => `<div class="grupo"><dt>${esc(t)}${nota ? `<small>${esc(nota)}</small>` : ''}</dt></div>`;
    let html = '';
    const dolar = modelo.refDolar && val(modelo.refDolar);
    if (ehNum(dolar)) html += linha(dolarAoVivo ? 'Dólar comercial (agora)' : 'Dólar', brl2.format(dolar));
    html += linha('Cartões comparados', inteiro.format(modelo.cartoes.length));

    const progs = modelo.milheiros.map(m => ({ nome: m.nome, v: val(m.ref), b: m.bonusRef ? val(m.bonusRef) : null })).filter(p => ehNum(p.v));
    html += titulo('Quanto vale o milheiro', 'Valor de 1.000 milhas usado para passar as milhas para reais.');
    for (const p of progs) html += linha(p.nome, brl2.format(p.v));

    html += titulo('Bônus de transferência na conta', 'Quando o cartão dá pontos (Livelo, Esfera…), a conta considera a transferência com este bônus.');
    const BC = window.BONUS_CONTA || {};
    for (const p of progs) {
      const chave = Object.keys(BC).find(k => norm(k) === norm(p.nome));
      if (chave && BC[chave] === null) continue; // programa que não precisa aparecer
      const b = chave ? BC[chave] : p.b;
      const bonus = ehNum(b) && b > 0 ? b : 0;
      const avios = /AVIOS/.test(norm(p.nome));
      const recebe = Math.round(10000 * (avios ? 0.5 : 1) * (1 + bonus));
      const exemplo = avios
        ? `Santander: 2 pontos = 1 Avios · 10 mil pontos = ${inteiro.format(recebe)} Avios`
        : `10 mil pontos = ${inteiro.format(recebe)} milhas`;
      html += linha(p.nome, bonus ? `${inteiro.format(bonus * 100)}%` : 'sem bônus', exemplo);
    }
    $('#parametros').innerHTML = html;
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
    estado.limite = POR_PAGINA;
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
    estado.renda = v || null; estado.verRestritos = estado.verAcimaRenda = false; mudou();
  });
  $('#ranking-mais').addEventListener('click', e => {
    if (e.target.dataset.acao === 'menos') {
      estado.limite = POR_PAGINA; desenhar();
      $('#ranking-sec').scrollIntoView({ block: 'start' });
    } else { estado.limite += POR_PAGINA; desenhar(); }
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
      .filter(k => !busca || norm([k.nome, k.banco, k.programa, k.bandeira, k.tipo].join(' ')).includes(busca))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    $('#isencao-lista').innerHTML = lista.length ? lista.map(k => `<li><label>
        <input type="checkbox" data-isento="${esc(k.chave)}" ${ehIsento(k) ? 'checked' : ''}>
        ${cartaoVisual(k, 'mini')}
        <span><b>${esc(k.nome)}</b><small>${esc([[k.bandeira, k.tipo].filter(x => x && x !== '-').join(' '), k.acelerador && k.acelerador !== '-' ? k.acelerador : ''].filter(Boolean).join(' · '))}</small></span>
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
    // Cartão que está depois dos que aparecem: abre a lista até ele.
    const pos = listaVisivel.findIndex(x => x.cartao.id === id);
    if (!document.getElementById(id) && pos >= estado.limite) { estado.limite = Math.ceil((pos + 1) / POR_PAGINA) * POR_PAGINA; desenhar(); }
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
    if (rolar && paginaDe(li) !== paginaAtual) {
      history.pushState(null, '', '#ranking-sec');
      mostrarPagina('ranking-sec', false);
    }
    if (rolar) li.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', e => {
    const linha = e.target.closest('.item-linha');
    if (linha) { abrirCartao(linha.closest('.item').id); return; }
    const ab = e.target.closest('[data-abrir]');
    if (ab) { abrirCartao(ab.dataset.abrir, true); return; }
    const copiar = e.target.closest('[data-copiar]');
    if (copiar) {
      const ok = () => { const em = copiar.querySelector('em'); if (em) { em.textContent = 'copiado!'; setTimeout(() => { em.textContent = 'copiar'; }, 2000); } };
      navigator.clipboard?.writeText(copiar.dataset.copiar).then(ok, () => {
        const r = document.createRange(); r.selectNodeContents(copiar.querySelector('strong')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      });
      return;
    }
    const tirar = e.target.closest('[data-tirar]');
    if (tirar) { marcarIsento(tirar.dataset.tirar, false); return; }
    if (e.target.closest('[data-mostrar-restritos]')) { estado.esconderRestritos = false; estado.verRestritos = true; mudou(); return; }
    if (e.target.closest('[data-ver-acima]')) { estado.verAcimaRenda = true; mudou(); return; }
    if (e.target.id === 'mais-novidades') {
      const btn = e.target;
      btn.dataset.todas = btn.dataset.todas === '1' ? '0' : '1';
      desenharNovidades();
    }
  });

  // Cada aba do topo é uma página: mostra só as seções dela (data-pagina).
  // O endereço continua o mesmo; o #da-aba diz qual página abrir (dá para mandar o link).
  const abas = [...document.querySelectorAll('.tabs a')];
  const paginas = [...document.querySelectorAll('[data-pagina]')];
  const TITULO = document.title;
  let paginaAtual = '';
  const paginaDe = el => (el && el.closest('[data-pagina]') || {}).dataset?.pagina;
  function mostrarPagina(alvo, rolar = true) {
    const el = alvo && document.getElementById(alvo);
    const pagina = paginaDe(el) || 'simulador';
    paginaAtual = pagina;
    paginas.forEach(p => p.classList.toggle('fora', p.dataset.pagina !== pagina));
    let ativa = null;
    abas.forEach(a => {
      const ok = paginaDe(document.getElementById(a.getAttribute('href').slice(1))) === pagina;
      a.setAttribute('aria-current', String(ok));
      if (ok) ativa = a;
    });
    document.title = pagina === 'simulador' || !ativa ? TITULO : `${ativa.textContent} · Onde as Milhas Me Levam`;
    $('#menu-atual').textContent = ativa ? ativa.textContent : 'Menu';
    abrirMenu(false);
    if (!rolar) return;
    if (el && !el.hasAttribute('data-pagina') && el.id !== 'topo') el.scrollIntoView({ block: 'start' });
    else scrollTo(0, 0);
  }
  // Menu: o botão abre e fecha a lista; clicar fora, apertar Esc ou escolher a página fecha.
  function abrirMenu(abrir) {
    $('#menu').classList.toggle('aberto', abrir);
    $('#menu-btn').setAttribute('aria-expanded', String(abrir));
  }
  $('#menu-btn').addEventListener('click', () => abrirMenu(!$('#menu').classList.contains('aberto')));
  document.addEventListener('click', e => { if (!e.target.closest('#menu, #menu-btn')) abrirMenu(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') abrirMenu(false); });
  addEventListener('hashchange', () => mostrarPagina(location.hash.slice(1)));
  // Clicar na aba da página em que já está volta ao topo dela.
  abas.forEach(a => a.addEventListener('click', () => { abrirMenu(false); if (a.getAttribute('href') === location.hash) scrollTo({ top: 0, behavior: 'smooth' }); }));
  mostrarPagina(location.hash.slice(1));

  /* ---------- início ---------- */

  async function iniciar() {
    sincronizarControles();
    desenharRestaurantes();
    desenharPrecos();
    desenharNoticias();
    desenharPassagens();
    desenharContatos();
    desenharCalendario();
    desenharQuanto();
    desenharTermometro();
    desenharGuia();
    desenharCombos();
    setInterval(() => { if (!document.hidden) desenharPassagens(); else mostrarPassagens(); }, 3 * 60e3);
    desenharAvisos();
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
