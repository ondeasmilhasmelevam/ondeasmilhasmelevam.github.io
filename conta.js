/* Minha carteira (saldos, vencimentos, emissões e avisos), primeiros passos do assinante,
   "dá para emitir" nos cartões de passagem e a página "Quando tem bônus".
   Os dados de cada assinante ficam no servidor (GET/POST /conta → contas/{email} no Firestore). */
(() => {
  const SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev';
  const $ = s => document.querySelector(s);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Math.round(n).toLocaleString('pt-BR');
  const reais = n => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
  const nomeProg = t => (window.OAMMLProgramas ? window.OAMMLProgramas.normalizar(t) : String(t || '').trim());
  const hojeISO = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const dataBR = d => (d ? d.split('-').reverse().join('/') : '');
  const assinatura = () => window.oammlAssinatura || {};

  /* ---------- Dados de apoio: transferências, preços e promoções ---------- */
  let transf = null, promosAgora = null;
  const pontosPorMilha = t => { const m = String(t || '').match(/^\s*(\d+(?:[.,]\d+)?)\s*:\s*(\d+(?:[.,]\d+)?)/); return m ? +m[1].replace(',', '.') / +m[2].replace(',', '.') : null; };
  async function json(url) { try { const r = await fetch(url, { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch (e) { return null; } }
  async function apoio() {
    if (!transf) transf = await json('dados/transferencias.json');
    if (!promosAgora) {
      const lista = await json('dados/alertas.json');
      promosAgora = (Array.isArray(lista) ? lista : []).filter(p => p.tipo === 'promocao' && p.titulo && !(p.ate && Date.parse(p.ate) < Date.now()))
        .map(p => ({ ...lerBonus(p.titulo), data: p.data, ate: p.ate, titulo: p.titulo })).filter(b => b.destino);
    }
  }
  // Preço bom do milheiro (precos.js): "até R$ 16" → 16.
  function milheiroRef(prog) {
    const n = norm(nomeProg(prog)), P = window.PRECO_MILHAS || [];
    const alvo = /IBERIA|BRITISH|QATAR|PRIVILEGE|AVIOS/.test(n) ? 'AVIOS' : n;
    const p = P.find(x => { const k = norm(nomeProg(x.nome)); return k === alvo || k.startsWith(alvo) || alvo.startsWith(k); }) ||
      P.find(x => { const k = norm(nomeProg(x.nome)); return k.length > 4 && (alvo.includes(k) || k.includes(alvo)); });
    const v = p && /^R\$/.test(String(p.preco).trim()) && (String(p.preco).match(/\d+/g) || []);
    return v ? Math.max(...v.map(Number)) : null;
  }

  // Valor dos pontos: melhor oferta de venda (precos.js); sem venda, valor de referência ou preço bom de compra;
  // bancos sem nenhum dos dois contam pelo destino mais barato da transferência.
  const comE = a => a.length > 1 ? `${a.slice(0, -1).join(", ")} e ${a[a.length - 1]}` : a.join("");
  const daTabela = (tab, n) => { const e = Object.entries(tab || {}).find(([k]) => nomeProg(k) === nomeProg(n)); return e ? e[1] : null; };
  function valorSaldos() {
    const itens = Object.entries(conta.saldos).filter(([, q]) => q > 0);
    let valor = 0; const porCompra = [], viaTransf = [], fora = [];
    for (const [n, q] of itens) {
      let ref = daTabela(window.VALOR_VENDA, n) || daTabela(window.VALOR_MILHEIRO_EXTRA, n);
      if (!ref) { ref = milheiroRef(n); if (ref) porCompra.push(n); }
      if (!ref) {
        const o = ((transf && transf.origens) || []).find(x => nomeProg(x.nome) === nomeProg(n));
        const cands = o ? o.destinos.map(d => { const r = daTabela(window.VALOR_VENDA, d.programa) || milheiroRef(d.programa), pr = pontosPorMilha(d.proporcao); return r && pr ? r / pr : null; }).filter(Boolean) : [];
        if (cands.length) { ref = Math.min(...cands); viaTransf.push(n); }
      }
      if (ref) valor += q / 1000 * ref; else fora.push(n);
    }
    if (!itens.length) return '<small>Preencha quanto tem em cada programa. Só você vê esses números.</small>';
    const total = itens.reduce((t, [, q]) => t + q, 0);
    const d = String(window.VALOR_VENDA_DATA || '').split('-').reverse().join('/');
    const notas = [];
    if (valor) notas.push(`Conta feita com a melhor oferta de venda do milheiro${d ? ` (ofertas de ${d})` : ''}.`);
    if (porCompra.length) notas.push(`${comE(porCompra)} ${porCompra.length > 1 ? 'entram' : 'entra'} pelo preço bom de compra, por não ter oferta de venda na lista.`);
    if (viaTransf.length) notas.push(`${comE(viaTransf)} ${viaTransf.length > 1 ? 'entram' : 'entra'} pelo que vale${viaTransf.length > 1 ? 'm' : ''} transferido${viaTransf.length > 1 ? 's' : ''} para a companhia mais barata.`);
    if (fora.length) notas.push(`Fora da conta do valor, por não ter referência: ${comE(fora)}.`);
    return `<b>${fmt(total)}</b> pontos e milhas no total${valor ? ` · valem cerca de <b>${esc(reais(valor))}</b>` : ''}<small>${esc(notas.join(' '))}</small>`;
  }
  const BANCOS = [['Livelo'], ['Esfera'], ['Pontos Itaú', 'ITAU|IUPP'], ['C6 Átomos', 'C6|ATOMOS'], ['Inter Loop', '\\bINTER\\b'], ['BTG Pactual', 'BTG'],
    ['Nubank', 'NUBANK|ULTRAVIOLETA'], ['XP', '\\bXP\\b'], ['Nomad'], ['Sicoob Coopera', 'SICOOB'], ['Sicredi'], ['BRB Curtaí / DUX', 'BRB|CURTAI|\\bDUX\\b'],
    ['Genial'], ['Revolut (RevPoints)', 'REVOLUT'], ['ALL Accor', '\\bACCOR\\b'], ['Marriott Bonvoy', 'MARRIOTT'], ['PicPay'], ['Portobank'], ['Premmia'],
    ['Bradesco'], ['Santander'], ['Caixa'], ['Banco do Brasil']].map(([n, re]) => ({ nome: n, re: new RegExp(re || norm(n)) }));
  const AEREOS = [['Azul Fidelidade', 'AZUL'], ['Smiles', 'SMILES'], ['LATAM Pass', 'LATAM'], ['TAP Miles&Go', '\\bTAP\\b'], ['Iberia Plus', 'IBERIA'],
    ['British Airways Club', 'BRITISH'], ['Qatar Privilege Club', 'QATAR'], ['Flying Blue', 'FLYING BLUE|AIR FRANCE|\\bKLM\\b'], ['AAdvantage', 'AADVANTAGE|AMERICAN AIRLINES'],
    ['Aeroplan', 'AEROPLAN|AIR CANADA'], ['Emirates Skywards', 'EMIRATES'], ['Turkish Miles&Smiles', 'TURKISH'], ['Copa ConnectMiles', 'CONNECTMILES|\\bCOPA\\b'],
    ['Avianca LifeMiles', 'LIFEMILES|AVIANCA'], ['Finnair Plus', 'FINNAIR'], ['Air Europa SUMA', '\\bSUMA\\b|AIR EUROPA'], ['Etihad Guest', 'ETIHAD'],
    ['United MileagePlus', 'UNITED'], ['Livelo', 'LIVELO']].map(([n, re]) => ({ nome: n, re: new RegExp(re) }));
  // Lê um título de promoção: "LIVELO PARA AZUL FIDELIDADE: ATÉ 130% DE BÔNUS" → { origem: Livelo, destino: Azul Fidelidade, pct: 130 }.
  function lerBonus(titulo) {
    const t = norm(titulo);
    if (!/BONUS/.test(t) || !/TRANSFER/.test(t) || /CLUBE|ASSINATURA|ASSINE|COMPRA DE|COMPRE /.test(t)) return {};
    const pcts = (t.match(/(\d{2,3})\s*%/g) || []).map(x => parseInt(x, 10)).filter(n => n >= 5 && n <= 400);
    const achados = re => { const m = re.exec(t); return m ? m.index : -1; };
    const aereos = AEREOS.filter(a => a.nome !== 'Livelo').map(a => ({ ...a, i: achados(a.re) })).filter(a => a.i >= 0).sort((a, b) => a.i - b.i);
    const bancos = BANCOS.map(b => ({ ...b, i: achados(b.re) })).filter(b => b.i >= 0).sort((a, b) => a.i - b.i);
    let destino = aereos[0] && aereos[0].nome, origem = bancos[0] && bancos[0].nome;
    if (!destino && bancos.length > 1) { origem = bancos[0].nome; destino = bancos[1].nome; } // ex.: Esfera para ALL Accor
    if (destino === 'Livelo' && bancos.length) origem = bancos.find(b => b.nome !== 'Livelo')?.nome || origem;
    return destino && origem && destino !== origem ? { origem, destino, pct: pcts.length ? Math.max(...pcts) : null } : {};
  }

  /* ---------- Conta do assinante (servidor) ---------- */
  let conta = null, carregando = null, salvarTimer = 0;
  const vazia = () => ({ saldos: {}, vencimentos: [], emissoes: [], avisos: 'hora', resumo: true, passosFechado: false, bonusAviso: true });
  async function chamar(metodo, corpo) {
    const tk = window.oammlToken ? await window.oammlToken() : '';
    if (!tk) throw new Error('sem login');
    const r = await fetch(`${SERVIDOR}/conta`, { method: metodo, headers: { authorization: `Bearer ${tk}`, ...(corpo ? { 'content-type': 'application/json' } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro || 'falhou');
    return d;
  }
  function carregarConta() {
    if (!assinatura().ativo) { conta = null; return Promise.resolve(null); }
    if (!carregando) carregando = chamar('GET').then(d => { conta = { ...vazia(), ...d }; return conta; }).catch(() => { conta = conta || vazia(); return conta; });
    return carregando;
  }
  function salvar(msg = 'Salvo') {
    clearTimeout(salvarTimer);
    const st = $('#ct-status');
    if (st) st.textContent = 'Salvando…';
    salvarTimer = setTimeout(async () => {
      try { await chamar('POST', conta); if (st) st.textContent = `${msg} ✓`; }
      catch (e) { if (st) st.textContent = 'Não deu para salvar agora. Tente de novo em instantes.'; }
      marcarCartoes(); desenharPassos();
    }, 700);
  }
  const chaveSaldo = p => Object.keys(conta.saldos).find(k => nomeProg(k) === nomeProg(p)) || nomeProg(p);
  const saldoProg = p => conta.saldos[chaveSaldo(p)] || 0;
  const temSaldo = () => conta && Object.values(conta.saldos || {}).some(v => v > 0);

  /* ---------- "Dá para emitir" nos cartões de passagem ---------- */
  const milhasDe = t => { const m = /(\d{1,3}(?:\.\d{3})+|\d+)/.exec(t || ''); return m ? +m[1].replace(/\./g, '') : 0; };
  function alcance(prog, total) {
    const p = nomeProg(prog), saldo = conta.saldos[p] || 0;
    if (!total) return null;
    if (saldo >= total) return { tipo: 'tem', txt: `Você tem ${fmt(saldo)} no ${p}: dá para emitir` };
    const falta = total - saldo;
    const caminhos = ((transf && transf.origens) || []).map(o => {
      const d = o.destinos.find(x => nomeProg(x.programa) === p), tem = conta.saldos[nomeProg(o.nome)] || 0, prop = d && pontosPorMilha(d.proporcao);
      if (!d || !prop || !tem) return null;
      const bonus = (promosAgora || []).filter(b => nomeProg(b.destino) === p && nomeProg(b.origem) === nomeProg(o.nome) && b.pct).map(b => b.pct)[0] || 0;
      const precisa = Math.ceil(falta * prop / (1 + bonus / 100));
      return { banco: o.nome, precisa, tem, bonus };
    }).filter(Boolean).sort((a, b) => (b.tem >= b.precisa) - (a.tem >= a.precisa) || a.precisa - b.precisa);
    const c = caminhos.find(x => x.tem >= x.precisa);
    if (c) return { tipo: 'transfere', txt: `${saldo ? `Você tem ${fmt(saldo)} no ${p}. ` : ''}Transferindo ${fmt(c.precisa)} pontos da ${c.banco} para o ${p}${c.bonus ? ` (com o bônus de ${c.bonus}% de agora)` : ''}, dá para emitir` };
    if (saldo) return { tipo: 'falta', txt: `Você tem ${fmt(saldo)} no ${p}: faltam ${fmt(falta)} milhas` };
    return null;
  }
  function marcarCartoes() {
    document.querySelectorAll('.pass-carteira').forEach(el => {
      const ok = assinatura().ativo && conta;
      let html = '';
      if (ok && temSaldo()) {
        const a = alcance(el.dataset.prog, +el.dataset.milhas || 0);
        if (a) html += `<span class="pc-alcance ${a.tipo}">${a.tipo === 'tem' ? '✅' : a.tipo === 'transfere' ? '💳' : '🧭'} ${esc(a.txt)}${+el.dataset.volta ? ' (ida e volta)' : ''}</span>`;
      }
      if (ok) html += `<button type="button" class="pc-emiti" data-emiti>✈️ Emiti esta passagem</button>`;
      el.innerHTML = html;
      el.hidden = !html;
    });
  }
  let obsTimer = 0;
  new MutationObserver(ms => {
    if (!ms.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && (n.matches?.('.pass-carteira') || n.querySelector?.('.pass-carteira:empty'))))) return;
    clearTimeout(obsTimer); obsTimer = setTimeout(marcarCartoes, 60);
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-emiti]'); if (!b) return;
    const el = b.closest('.pass-carteira');
    prefill = { data: hojeISO(), rota: el.dataset.rota, programa: nomeProg(el.dataset.prog), cabine: el.dataset.cabine, milhas: +el.dataset.milhas || '', taxas: +el.dataset.taxas || '', pessoas: 1 };
    location.hash = '#carteira';
    setTimeout(() => { const f = $('#ct-emissao'); if (f) f.closest('.ct-bloco').scrollIntoView({ block: 'start', behavior: 'smooth' }); }, 600);
  });

  /* ---------- Página Minha carteira ---------- */
  let prefill = null;
  const PADRAO = ['Livelo', 'Esfera', 'Smiles', 'LATAM Pass', 'Azul Fidelidade'];
  function opcoesProgramas(sel = '') {
    const bancos = ((transf && transf.origens) || []).map(o => o.nome);
    const aereos = [...new Set(((transf && transf.origens) || []).flatMap(o => o.destinos.map(d => nomeProg(d.programa))))].filter(n => !bancos.map(nomeProg).includes(n)).sort((a, b) => a.localeCompare(b, 'pt'));
    const op = n => `<option${nomeProg(n) === nomeProg(sel) ? ' selected' : ''}>${esc(nomeProg(n))}</option>`;
    return `<option value="">Escolha…</option><optgroup label="Bancos e cartões">${bancos.map(op).join('')}</optgroup><optgroup label="Companhias aéreas">${aereos.map(op).join('')}</optgroup>`;
  }
  function desenharCarteira() {
    const fechado = $('#ct-fechado'), aberto = $('#ct-aberto');
    if (!fechado) return;
    const ativo = !!assinatura().ativo;
    fechado.hidden = ativo; aberto.hidden = !ativo;
    if (!ativo || !conta) return;
    // Saldos: os que a pessoa tem + os mais comuns vazios para começar.
    const nomes = [...new Set([...Object.keys(conta.saldos), ...(temSaldo() ? [] : PADRAO.map(nomeProg))])];
    $('#ct-saldos').innerHTML = nomes.map(n => `<label class="ct-saldo"><span>${esc(n)}</span><input type="number" inputmode="numeric" min="0" step="500" data-saldo="${esc(n)}" value="${conta.saldos[n] || ''}" placeholder="0"></label>`).join('');
    $('#ct-add-prog').innerHTML = opcoesProgramas();
    // Quanto valem os pontos (pelo preço bom de compra de cada um).
    $('#ct-valor').innerHTML = valorSaldos();
    desenharBonusMeus();
    desenharDaParaEmitir();
    // Vencimentos
    $('#ct-venc-lista').innerHTML = conta.vencimentos.length ? conta.vencimentos.map((v, i) => {
      const dias = Math.round((Date.parse(v.data) - Date.parse(hojeISO())) / 864e5);
      return `<li class="${dias <= 30 ? 'perto' : ''}"><div><b>${v.pontos ? `${fmt(v.pontos)} · ` : ''}${esc(v.programa)}</b><span>vencem em ${esc(dataBR(v.data))} · ${dias < 0 ? 'já venceu' : dias === 0 ? 'hoje' : `daqui a ${dias} dias`}</span></div><button type="button" data-tirar-venc="${i}">Tirar</button></li>`;
    }).join('') : '<li class="vazio">Nenhum vencimento marcado.</li>';
    $('#ct-venc-prog').innerHTML = opcoesProgramas();
    // Avisos
    document.querySelectorAll('input[name="ct-avisos"]').forEach(r => { r.checked = r.value === conta.avisos; });
    $('#ct-resumo').checked = conta.resumo !== false;
    $('#ct-bonus-aviso').checked = conta.bonusAviso !== false;
    desenharEmissoes();
    if (prefill) {
      const f = $('#ct-emissao');
      $('#ct-em-prog').innerHTML = opcoesProgramas(prefill.programa);
      Object.entries(prefill).forEach(([k, v]) => { const c = f.elements[k]; if (c && k !== 'programa') c.value = v; });
      f.closest('details').open = true;
      prefill = null;
      textoDesconto();
    } else if (!$('#ct-em-prog').options.length) $('#ct-em-prog').innerHTML = opcoesProgramas();
  }
  function desenharBonusMeus() {
    const caixa = $('#ct-bonus-meus'); if (!caixa) return;
    const vistos = new Set();
    const itens = (promosAgora || []).filter(b => b.origem && saldoProg(b.origem) > 0)
      .filter(b => { const k = `${nomeProg(b.origem)}>${nomeProg(b.destino)}`; if (vistos.has(k)) return false; vistos.add(k); return true; })
      .map(b => {
        const tem = saldoProg(b.origem);
        const o = ((transf && transf.origens) || []).find(x => nomeProg(x.nome) === nomeProg(b.origem));
        const d = o && o.destinos.find(x => nomeProg(x.programa) === nomeProg(b.destino));
        const prop = d && pontosPorMilha(d.proporcao);
        const viram = prop ? Math.floor(tem / prop * (1 + (b.pct || 0) / 100)) : 0;
        const fim = b.ate ? dataBR(String(b.ate).slice(0, 10)) : '';
        return `<li><div><b>🔥 ${esc(b.origem)} → ${esc(b.destino)}${b.pct ? ` · até ${b.pct}% de bônus` : ''}</b><span>Você tem ${fmt(tem)} pontos na ${esc(b.origem)}${viram ? `: com o bônus, viram até ${fmt(viram)} milhas ${esc(b.destino)}` : ''}.${fim ? ` Vale até ${esc(fim)}.` : ''}</span></div></li>`;
      });
    caixa.closest('.ct-bloco').hidden = !itens.length;
    caixa.innerHTML = itens.join('');
  }
  function desenharDaParaEmitir() {
    const el = $('#ct-emitir');
    if (!temSaldo()) { el.innerHTML = '<p class="ct-vazio">Assim que você preencher os saldos, mostramos aqui as passagens no ar que já dá para emitir com os seus pontos.</p>'; return; }
    const lista = (window.oammlPassagens || []).map(p => {
      const total = milhasDe(p.ida) + (p.volta ? milhasDe(p.volta) : 0);
      return { p, a: alcance(p.programa, total) };
    }).filter(x => x.a && x.a.tipo !== 'falta').sort((a, b) => (a.a.tipo === 'tem' ? 0 : 1) - (b.a.tipo === 'tem' ? 0 : 1) || b.p.data.localeCompare(a.p.data)).slice(0, 6);
    el.innerHTML = lista.length && window.oammlPassagemHtml
      ? `<p class="ct-nota">${lista.length === 6 ? 'As 6 mais recentes' : `${lista.length} ${lista.length === 1 ? 'passagem' : 'passagens'}`} no ar que cabem nos seus pontos (direto ou transferindo).</p><ul class="passagens">${lista.map(x => window.oammlPassagemHtml(x.p)).join('')}</ul>`
      : '<p class="ct-vazio">Nenhuma passagem no ar agora cabe nos seus pontos. Quando aparecer, ela ganha o selo verde "dá para emitir" na página Passagens.</p>';
    marcarCartoes();
  }
  // "Descontar do meu saldo": mostra quanto sai e de qual programa.
  function textoDesconto() {
    const f = $('#ct-emissao'), alvo = $('#ct-em-desc'); if (!f || !alvo || !conta) return;
    const prog = f.elements.programa.value, milhas = Math.round(+f.elements.milhas.value || 0), tem = prog ? saldoProg(prog) : 0;
    const caixa = alvo.closest('label');
    caixa.hidden = !prog || !milhas || !tem;
    alvo.textContent = `Descontar ${fmt(Math.min(milhas, tem))} milhas do meu saldo no ${nomeProg(prog)} (hoje ${fmt(tem)})`;
  }
  document.addEventListener('input', e => { if (e.target.closest('#ct-emissao')) textoDesconto(); });
  document.addEventListener('change', e => { if (e.target.closest('#ct-emissao')) textoDesconto(); });
  function desenharEmissoes() {
    const em = [...conta.emissoes].sort((a, b) => (b.data || '').localeCompare(a.data || ''));
    const calc = e => {
      const mil = e.milheiro || milheiroRef(e.programa) || 0;
      const custo = e.milhas / 1000 * mil + e.taxas;
      return { mil, custo, eco: e.dinheiro ? e.dinheiro - custo : null };
    };
    const tot = em.reduce((s, e) => { const c = calc(e); s.milhas += e.milhas; s.taxas += e.taxas; if (c.eco != null) { s.eco += c.eco; s.com++; } return s; }, { milhas: 0, taxas: 0, eco: 0, com: 0 });
    $('#ct-em-resumo').innerHTML = em.length ? `<div><small>Emissões</small><b>${em.length}</b></div><div><small>Milhas usadas</small><b>${fmt(tot.milhas)}</b></div><div><small>Taxas pagas</small><b>${esc(reais(tot.taxas))}</b></div>${tot.com ? `<div class="ct-eco"><small>Economia estimada</small><b>${esc(reais(tot.eco))}</b></div>` : ''}` : '';
    $('#ct-em-lista').innerHTML = em.length ? em.map(e => {
      const c = calc(e), i = conta.emissoes.indexOf(e);
      return `<li><div><b>${esc(e.rota)}</b><span>${esc(dataBR(e.data))} · ${esc(e.programa)}${e.cabine ? ` · ${esc(e.cabine)}` : ''} · ${fmt(e.milhas)} milhas${e.taxas ? ` + ${esc(reais(e.taxas))}` : ''}${e.pessoas > 1 ? ` · ${e.pessoas} pessoas` : ''}</span>
        ${c.eco != null ? `<span class="${c.eco >= 0 ? 'ok' : 'ruim'}">Em dinheiro: ${esc(reais(e.dinheiro))} · com milhas: ${esc(reais(c.custo))}${c.mil ? ` (milheiro a R$ ${esc(String(c.mil))})` : ''} → ${c.eco >= 0 ? `economizou ${esc(reais(c.eco))}` : `pagou ${esc(reais(-c.eco))} a mais`}</span>` : '<span>Informe o preço em dinheiro para calcular a economia.</span>'}</div>
        <button type="button" data-tirar-em="${i}">Tirar</button></li>`;
    }).join('') : '<li class="vazio">Nenhuma emissão anotada ainda. Use o botão "Emiti esta passagem" nos cartões ou preencha acima.</li>';
  }
  document.addEventListener('input', e => {
    const s = e.target.closest('[data-saldo]'); if (!s || !conta) return;
    const n = Math.max(0, Math.round(+s.value || 0));
    if (n) conta.saldos[s.dataset.saldo] = n; else delete conta.saldos[s.dataset.saldo];
    salvar();
    clearTimeout(desenharTimer); desenharTimer = setTimeout(() => {
      const ativo = document.activeElement; const nome = ativo && ativo.dataset ? ativo.dataset.saldo : null;
      $('#ct-valor').innerHTML = valorSaldos();
      desenharBonusMeus();
      desenharDaParaEmitir();
      if (nome) { const de = document.querySelector(`[data-saldo="${CSS.escape(nome)}"]`); if (de && de !== ativo) de.focus(); }
    }, 600);
  });
  let desenharTimer = 0;
  document.addEventListener('change', e => {
    if (!conta) return;
    if (e.target.id === 'ct-add-prog' && e.target.value) {
      const n = nomeProg(e.target.value);
      if (!(n in conta.saldos)) conta.saldos[n] = 0;
      const lista = $('#ct-saldos');
      if (!lista.querySelector(`[data-saldo="${CSS.escape(n)}"]`)) lista.insertAdjacentHTML('beforeend', `<label class="ct-saldo"><span>${esc(n)}</span><input type="number" inputmode="numeric" min="0" step="500" data-saldo="${esc(n)}" placeholder="0"></label>`);
      lista.querySelector(`[data-saldo="${CSS.escape(n)}"]`).focus();
      e.target.value = '';
    }
    if (e.target.name === 'ct-avisos') { conta.avisos = e.target.value; salvar('Preferência salva'); }
    if (e.target.id === 'ct-resumo') { conta.resumo = e.target.checked; salvar('Preferência salva'); }
    if (e.target.id === 'ct-bonus-aviso') { conta.bonusAviso = e.target.checked; salvar('Preferência salva'); }
  });
  document.addEventListener('submit', e => {
    if (!conta) return;
    if (e.target.id === 'ct-venc') {
      e.preventDefault();
      const f = e.target, programa = f.elements.programa.value, data = f.elements.data.value;
      if (!programa || !data) { $('#ct-status').textContent = 'Escolha o programa e a data do vencimento.'; return; }
      conta.vencimentos.push({ programa, pontos: Math.round(+f.elements.pontos.value || 0), data });
      conta.vencimentos.sort((a, b) => a.data.localeCompare(b.data));
      f.reset(); desenharCarteira(); salvar('Vencimento salvo');
    }
    if (e.target.id === 'ct-emissao') {
      e.preventDefault();
      const f = e.target, v = k => f.elements[k].value;
      if (!v('rota') || !+v('milhas') || !v('programa')) { $('#ct-status').textContent = 'Preencha a rota, o programa e as milhas.'; return; }
      conta.emissoes.push({ data: v('data') || hojeISO(), rota: v('rota'), programa: v('programa'), cabine: v('cabine'), milhas: Math.round(+v('milhas')), taxas: Math.round(+v('taxas') || 0),
        dinheiro: Math.round(+v('dinheiro') || 0), milheiro: +String(v('milheiro')).replace(',', '.') || 0, pessoas: Math.max(1, Math.round(+v('pessoas') || 1)), descontado: 0 });
      const em = conta.emissoes[conta.emissoes.length - 1], tem = saldoProg(em.programa);
      if (f.elements.descontar && f.elements.descontar.checked && tem && !$('#ct-em-desc').closest('label').hidden) {
        em.descontado = Math.min(em.milhas, tem);
        const k = chaveSaldo(em.programa), resta = tem - em.descontado;
        if (resta) conta.saldos[k] = resta; else delete conta.saldos[k];
      }
      const msg = em.descontado ? `Emissão anotada e ${fmt(em.descontado)} milhas descontadas do ${nomeProg(em.programa)}` : 'Emissão anotada';
      f.reset(); f.elements.data.value = hojeISO(); desenharCarteira(); textoDesconto(); salvar(msg);
    }
  });
  document.addEventListener('click', e => {
    if (!conta) return;
    const tv = e.target.closest('[data-tirar-venc]'), te = e.target.closest('[data-tirar-em]');
    if (tv) { conta.vencimentos.splice(+tv.dataset.tirarVenc, 1); desenharCarteira(); salvar(); }
    if (te) {
      const [em] = conta.emissoes.splice(+te.dataset.tirarEm, 1);
      if (em && em.descontado) { const k = chaveSaldo(em.programa); conta.saldos[k] = (conta.saldos[k] || 0) + em.descontado; }
      desenharCarteira(); salvar(em && em.descontado ? `Emissão tirada e ${fmt(em.descontado)} milhas devolvidas ao ${nomeProg(em.programa)}` : 'Emissão tirada');
    }
    if (e.target.closest('#pp-fechar')) { conta.passosFechado = true; salvar('Pronto'); desenharPassos(); }
  });

  /* ---------- Primeiros passos do assinante ---------- */
  async function temPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return false;
      const reg = await navigator.serviceWorker.getRegistration();
      return !!(reg && await reg.pushManager.getSubscription());
    } catch (e) { return false; }
  }
  const instalado = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  async function desenharPassos() {
    const caixas = document.querySelectorAll('.pp-caixa');
    if (!caixas.length) return;
    const ativo = !!assinatura().ativo && conta && !conta.passosFechado;
    if (!ativo) { caixas.forEach(c => { c.hidden = true; }); return; }
    const passos = [
      { ok: (window.oammlRadares ? window.oammlRadares() : 0) > 0, t: 'Marque as rotas que você quer', d: 'Até 5 rotas na Rota Vigiada. Avisamos quando aparecer passagem nelas.', link: '#radar', b: 'Marcar rotas' },
      { ok: await temPush(), t: 'Ligue o aviso no celular', d: 'A passagem boa some em horas. Com o aviso, você fica sabendo na hora.', link: '#radar', b: 'Ligar aviso' },
      { ok: temSaldo(), t: 'Conte quais pontos você tem', d: 'Com os seus saldos, cada passagem mostra se já dá para emitir.', link: '#carteira', b: 'Preencher' },
      { ok: instalado(), t: 'Coloque o site na tela inicial', d: 'Abre como app, mais rápido, e o aviso no iPhone só funciona assim.', link: '#instalar', b: 'Ver como' }
    ];
    const feitos = passos.filter(p => p.ok).length;
    const html = `<div class="pp-topo"><div><p class="eyebrow">Primeiros passos</p><h3>${feitos === passos.length ? 'Tudo pronto!' : `Falta${passos.length - feitos > 1 ? 'm' : ''} ${passos.length - feitos} ${passos.length - feitos > 1 ? 'passos' : 'passo'} para aproveitar tudo`}</h3></div>
        <button type="button" id="pp-fechar" class="pp-fechar" aria-label="Não mostrar mais">Não mostrar mais</button></div>
      <div class="pp-barra" aria-hidden="true"><i style="width:${feitos / passos.length * 100}%"></i></div>
      <ol class="pp-lista">${passos.map(p => `<li class="${p.ok ? 'ok' : ''}"><span class="pp-check" aria-hidden="true">${p.ok ? '✓' : ''}</span><div><b>${esc(p.t)}</b><small>${esc(p.d)}</small></div>${p.ok ? '<em>Feito</em>' : `<a class="cta cta-b" href="${p.link}">${esc(p.b)}</a>`}</li>`).join('')}</ol>`;
    caixas.forEach(c => { c.innerHTML = html; c.hidden = feitos === passos.length && c.dataset.onde === 'inicio'; });
  }

  /* ---------- Página "Quando tem bônus" ---------- */
  let bonusFeito = false;
  async function desenharBonus() {
    if (bonusFeito || !$('#bn-lista')) return;
    bonusFeito = true;
    await apoio();
    const hist = await json('dados/promos-historico.json') || {};
    const DIA = 864e5;
    // Campanhas: o mesmo caminho em até 5 dias conta uma vez só (vários avisos da mesma promoção).
    const brutas = Object.values(hist).map(p => ({ ...lerBonus(p.titulo), t: Date.parse(p.data) })).filter(b => b.destino && b.t).sort((a, b) => a.t - b.t);
    const camp = [];
    for (const b of brutas) {
      const igual = camp.find(c => c.origem === b.origem && c.destino === b.destino && b.t - c.fim <= 5 * DIA);
      if (igual) { igual.fim = b.t; igual.pct = Math.max(igual.pct || 0, b.pct || 0) || null; } else camp.push({ ...b, fim: b.t });
    }
    const desde = brutas.length ? brutas[0].t : Date.now();
    const semanas = Math.max(1, (Date.now() - desde) / (7 * DIA));
    const porDestino = {};
    camp.forEach(c => { (porDestino[c.destino] = porDestino[c.destino] || []).push(c); });
    const agora = (promosAgora || []);
    const costuma = destino => ((transf && transf.origens) || []).map(o => { const d = o.destinos.find(x => nomeProg(x.programa) === nomeProg(destino)); return d && d.bonus && !/sem /i.test(d.bonus) ? `${o.nome}: ${d.bonus}` : null; }).filter(Boolean).slice(0, 3);
    const cards = Object.entries(porDestino).map(([destino, l]) => {
      const ult = l[l.length - 1], maior = Math.max(0, ...l.map(c => c.pct || 0));
      const origens = [...new Set(l.map(c => c.origem))];
      const noAr = agora.filter(b => nomeProg(b.destino) === nomeProg(destino));
      // Em quantas semanas do período teve pelo menos uma campanha (de qualquer banco).
      const semComBonus = new Set(l.map(c => Math.floor((c.t - desde) / (7 * DIA)))).size, total = Math.max(1, Math.ceil(semanas));
      // Com poucas semanas de dados, a tabela de transferências (o que costuma acontecer) também conta: vale a mais forte.
      const tabela = norm(costuma(destino).join(' '));
      const freq = Math.max(semComBonus / total, /TODA SEMANA/.test(tabela) ? 0.6 : /COM FREQUENCIA|TODO MES/.test(tabela) ? 0.3 : 0);
      const leitura = freq >= 0.6 ? { c: 'freq', t: 'Bônus frequente', d: 'Aparece quase toda semana. Não vale transferir sem bônus: espere a próxima campanha.' }
        : freq >= 0.25 ? { c: 'medio', t: 'Bônus de vez em quando', d: 'Aparece algumas vezes por mês. Se não estiver com pressa, vale esperar um bom.' }
          : { c: 'raro', t: 'Bônus raro', d: 'Aparece pouco. Quando surgir um bom e você tiver plano de usar, aproveite.' };
      return { destino, n: l.length + (noAr.length ? 100 : 0), html: `<article class="bn-card">
        <header><h3>${esc(destino)}</h3>${noAr.length ? `<span class="bn-agora">🔥 No ar: ${esc(noAr[0].origem)}${noAr[0].pct ? `, até ${noAr[0].pct}%` : ''}</span>` : ''}</header>
        <p class="bn-leitura ${leitura.c}"><b>${leitura.t}</b> ${leitura.d}</p>
        <dl>
          <div><dt>Semanas com bônus</dt><dd>${semComBonus} de ${total} <small>· ${l.length} ${l.length === 1 ? 'campanha' : 'campanhas'}</small></dd></div>
          <div><dt>Maior bônus visto</dt><dd>${maior ? `${maior}%` : '—'}</dd></div>
          <div><dt>Última</dt><dd>${new Date(ult.t).toLocaleDateString('pt-BR')} <small>· ${esc(ult.origem)}${ult.pct ? `, ${ult.pct}%` : ''}</small></dd></div>
          <div><dt>Vem de</dt><dd><small>${esc(origens.join(', '))}</small></dd></div>
        </dl>
        ${costuma(destino).length ? `<p class="bn-costuma"><b>Costuma ser:</b> ${costuma(destino).map(esc).join(' · ')}</p>` : ''}
      </article>` };
    }).sort((a, b) => b.n - a.n);
    $('#bn-lista').innerHTML = cards.map(c => c.html).join('') || '<p class="ct-vazio">Ainda juntando dados. Volte em alguns dias.</p>';
    $('#bn-desde').textContent = `Contamos ${camp.length} campanhas de bônus em transferência desde ${new Date(desde).toLocaleDateString('pt-BR')}. Quanto mais semanas, mais certeira fica a leitura.`;
  }

  /* ---------- Ligações ---------- */
  async function atualizar() {
    if (!assinatura().ativo) { conta = null; carregando = null; desenharCarteira(); desenharPassos(); marcarCartoes(); return; }
    await Promise.all([apoio(), carregarConta()]);
    desenharCarteira(); desenharPassos(); marcarCartoes();
  }
  document.addEventListener('assinatura', () => { carregando = null; atualizar(); });
  document.addEventListener('passagens', () => { marcarCartoes(); if (location.hash === '#carteira' && conta) desenharDaParaEmitir(); });
  document.addEventListener('radar-mudou', desenharPassos);
  addEventListener('hashchange', () => {
    if (location.hash === '#carteira') desenharCarteira();
    if (location.hash === '#bonus') desenharBonus();
    if (location.hash === '#inicio' || !location.hash) desenharPassos();
  });
  if (location.hash === '#bonus') desenharBonus();
  atualizar();
  window.oammlBonusDoTitulo = lerBonus;
})();
