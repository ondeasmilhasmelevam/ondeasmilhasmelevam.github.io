/* Gestão de milhas (assinantes): clubes, compras de pontos e vendas, com o resumo do ano,
   as próximas faturas, o que falta receber e os CPFs usados. Fica salvo na conta (conta.gestao),
   pelo mesmo caminho da Minha carteira (conta.js → POST /conta). */
(() => {
  const $ = s => document.querySelector(s);
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => Math.round(n || 0).toLocaleString('pt-BR');
  const reais = (n, cent = false) => (n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: cent ? 2 : 0, maximumFractionDigits: cent ? 2 : 0 });
  const mil = n => `R$ ${(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const hoje = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10);
  const dataBR = d => (d ? d.split('-').reverse().join('/') : '');
  const num = v => +String(v ?? '').replace(/\./g, '').replace(',', '.') || 0;
  const dec = v => +String(v ?? '').replace(',', '.') || 0;
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const nomeMes = ym => `${MESES[+ym.slice(5, 7) - 1]}/${ym.slice(2, 4)}`;
  const somaMes = (ym, k) => { const d = new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + k, 1)); return d.toISOString().slice(0, 7); };
  const api = () => window.oammlConta;
  const assinante = () => !!(window.oammlAssinatura || {}).ativo;
  let filtroAno = String(new Date().getFullYear());
  let dolar = 0;
  (async () => { try { const d = await (await fetch('https://economia.awesomeapi.com.br/json/last/USD-BRL', { cache: 'no-store' })).json(); dolar = +d.USDBRL.bid || 0; } catch (e) { /* sem dólar: o campo fica para preencher */ } })();

  const g = () => {
    const c = api() && api().dados();
    if (!c) return null;
    c.gestao = c.gestao || {};
    ['clubes', 'compras', 'vendas'].forEach(k => { if (!Array.isArray(c.gestao[k])) c.gestao[k] = []; });
    return c.gestao;
  };
  const salvar = msg => api().salvar(msg);

  /* ---------- Contas ---------- */
  // Mensalidades cobradas: na data de início e a cada mês, até a data de cancelamento (ou hoje).
  function cobrancas(c, ate = hoje()) {
    if (!c.inicio) return [];
    const fim = c.fim && c.fim < ate ? c.fim : ate, out = [];
    const [y, m, d] = c.inicio.split('-').map(Number);
    for (let k = 0; k < 600; k++) {
      const dt = new Date(Date.UTC(y, m - 1 + k, 1)); const ult = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
      const s = `${dt.toISOString().slice(0, 7)}-${String(Math.min(d, ult)).padStart(2, '0')}`;
      if (s > fim) break; out.push(s);
    }
    return out;
  }
  function clube(c, ano) {
    const todas = cobrancas(c), cob = ano ? todas.filter(s => s.startsWith(ano)) : todas;
    const extraNoPeriodo = !ano || (c.inicio || '').startsWith(ano);
    const pago = cob.length * c.mensal + (extraNoPeriodo ? c.upgrade : 0);
    const pontos = cob.length * c.pontos + (extraNoPeriodo ? c.bonus + c.indicacao : 0);
    const pagoTudo = todas.length * c.mensal + c.upgrade, pontosTudo = todas.length * c.pontos + c.bonus + c.indicacao;
    return { meses: todas.length, pago, pontos, pagoTudo, pontosTudo, milheiro: pontosTudo ? pagoTudo / (pontosTudo / 1000) : 0, ativo: !c.fim || c.fim > hoje() };
  }
  function compra(c) {
    const extra = c.ppd && c.dolar ? Math.round(c.valor / c.dolar * c.ppd) : 0;
    return { extra, milheiro: c.pontos ? c.valor / (c.pontos / 1000) : 0, efetivo: c.pontos + extra ? c.valor / ((c.pontos + extra) / 1000) : 0, parcela: c.valor / Math.max(1, c.parcelas) };
  }
  // Custo médio do milheiro que a pessoa pagou num programa (compras, já com os pontos do cartão).
  function custoMedio(prog) {
    const n = api().nome(prog); let v = 0, p = 0;
    g().compras.filter(c => api().nome(c.programa) === n).forEach(c => { v += c.valor; p += c.pontos + compra(c).extra; });
    g().clubes.filter(c => api().nome(c.programa) === n).forEach(c => { const r = clube(c); v += r.pagoTudo; p += r.pontosTudo; });
    return p ? v / (p / 1000) : 0;
  }
  function venda(v) {
    const milheiro = v.milhas ? v.valor / (v.milhas / 1000) : 0;
    const custo = v.custo || 0;
    const dias = v.data && v.pagamento ? Math.round((Date.parse(v.pagamento) - Date.parse(v.data)) / 864e5) : null;
    return { milheiro, lucro: custo ? v.valor - v.milhas / 1000 * custo : null, dias, atrasada: !v.recebido && v.pagamento && v.pagamento < hoje() };
  }
  const anos = () => {
    const s = new Set([String(new Date().getFullYear())]);
    g().compras.forEach(c => c.data && s.add(c.data.slice(0, 4)));
    g().vendas.forEach(v => v.data && s.add(v.data.slice(0, 4)));
    g().clubes.forEach(c => cobrancas(c).forEach(d => s.add(d.slice(0, 4))));
    return [...s].sort().reverse();
  };

  /* ---------- Desenho ---------- */
  const titulares = () => [...new Set([...g().clubes.map(c => c.titular), ...g().compras.map(c => c.titular), ...g().vendas.map(v => v.titular)].filter(Boolean))];
  function desenhar() {
    const fechado = $('#gm-fechado'), aberto = $('#gm-aberto');
    if (!fechado) return;
    const ok = assinante() && api() && api().dados();
    fechado.hidden = !!ok; aberto.hidden = !ok;
    if (!ok) return;
    const G = g();
    $('#gm-titulares').innerHTML = titulares().map(t => `<option value="${esc(t)}">`).join('');
    document.querySelectorAll('[data-gm-prog]').forEach(s => { if (!s.options.length || s.options.length < 3) s.innerHTML = api().opcoes(); });
    const f = $('#gm-compra'); if (f && dolar && !f.elements.dolar.value) f.elements.dolar.placeholder = `hoje: ${dolar.toFixed(2).replace('.', ',')}`;
    desenharLembretes(G); desenharResumo(); desenharFaturas(); desenharCpf();
    desenharClubes(G); desenharCompras(G); desenharVendas(G);
  }
  // Clubes para cancelar: aparece no topo da página 7 dias antes (e continua até marcar "Cancelei").
  function desenharLembretes(G) {
    const h = hoje(), dias = d => Math.round((Date.parse(d) - Date.parse(h)) / 864e5);
    const itens = G.clubes.map((c, i) => ({ c, i })).filter(({ c }) => c.lembrete && clube(c).ativo && dias(c.lembrete) <= 7).sort((a, b) => a.c.lembrete.localeCompare(b.c.lembrete));
    const el = $('#gm-lembretes');
    el.hidden = !itens.length;
    el.innerHTML = itens.length ? `<b>🔔 Clube para cancelar</b>${itens.map(({ c, i }) => { const n = dias(c.lembrete);
      return `<p>Clube ${esc(c.programa)}${c.titular ? ` · ${esc(c.titular)}` : ''}: ${n < 0 ? `a data era ${esc(dataBR(c.lembrete))}` : n === 0 ? 'cancelar hoje' : `cancelar até ${esc(dataBR(c.lembrete))} (${n === 1 ? 'amanhã' : `faltam ${n} dias`})`}. <button type="button" data-gm-cancelar="${i}">Já cancelei</button></p>`; }).join('')}<small>Antes de cancelar, confira se já cumpriu o tempo mínimo da promoção: sair antes pode fazer o bônus ser estornado. Também avisamos por e-mail e no celular 3 dias antes e no dia.</small>` : '';
  }
  function desenharResumo() {
    const lista = anos();
    if (filtroAno !== 'tudo' && !lista.includes(filtroAno)) filtroAno = lista[0];
    $('#gm-anos').innerHTML = [...lista, 'tudo'].map(a => `<button type="button" class="gm-ano${a === filtroAno ? ' on' : ''}" data-gm-ano="${a}" aria-pressed="${a === filtroAno}">${a === 'tudo' ? 'Tudo' : a}</button>`).join('');
    const ano = filtroAno === 'tudo' ? '' : filtroAno, noAno = d => !ano || (d || '').startsWith(ano), G = g();
    const compras = G.compras.filter(c => noAno(c.data));
    const cCompras = compras.reduce((s, c) => s + c.valor, 0), pCompras = compras.reduce((s, c) => s + c.pontos + compra(c).extra, 0);
    const cl = G.clubes.map(c => clube(c, ano)), cClubes = cl.reduce((s, r) => s + r.pago, 0), pClubes = cl.reduce((s, r) => s + r.pontos, 0);
    const vendas = G.vendas.filter(v => noAno(v.data)), vendido = vendas.reduce((s, v) => s + v.valor, 0), mVend = vendas.reduce((s, v) => s + v.milhas, 0);
    const investido = cCompras + cClubes, lucro = vendido - investido, pontos = pCompras + pClubes;
    const receber = G.vendas.filter(v => !v.recebido), aReceber = receber.reduce((s, v) => s + v.valor, 0), atrasadas = receber.filter(v => venda(v).atrasada).length;
    const vazio = !G.compras.length && !G.clubes.length && !G.vendas.length;
    $('#gm-resumo').innerHTML = vazio ? '<p class="gm-vazio">Comece anotando um clube, uma compra de pontos ou uma venda logo abaixo. O resumo aparece aqui.</p>' : `
      <div class="gm-cards">
        <div><small>Compras de pontos</small><b>${reais(cCompras)}</b><span>${fmt(pCompras)} pontos</span></div>
        <div><small>Clubes</small><b>${reais(cClubes)}</b><span>${fmt(pClubes)} pontos</span></div>
        <div><small>Total investido</small><b>${reais(investido)}</b><span>${pontos ? `milheiro médio ${mil(investido / (pontos / 1000))}` : '—'}</span></div>
        <div><small>Vendas</small><b>${reais(vendido)}</b><span>${fmt(mVend)} milhas</span></div>
        <div class="${lucro >= 0 ? 'ok' : 'ruim'}"><small>Resultado</small><b>${lucro < 0 ? '−' : ''}${reais(Math.abs(lucro))}</b><span>vendas − investido</span></div>
        <div class="${atrasadas ? 'ruim' : ''}"><small>A receber</small><b>${reais(aReceber)}</b><span>${receber.length ? `${receber.length} venda${receber.length > 1 ? 's' : ''}${atrasadas ? ` · ${atrasadas} atrasada${atrasadas > 1 ? 's' : ''}` : ''}` : 'nada pendente'}</span></div>
      </div>
      <p class="gm-nota">${ano ? `Ano de ${ano}. ` : 'Todos os anos somados. '}O resultado tira das vendas tudo o que você gastou com compras e clubes no período. Quem compra num ano e vende no outro pode ver um ano no vermelho e o total no azul: confira também em "Tudo".</p>`;
  }
  function desenharFaturas() {
    const G = g(), ym0 = hoje().slice(0, 7), meses = [0, 1, 2].map(k => somaMes(ym0, k));
    const porMes = meses.map(ym => {
      const itens = [];
      G.compras.forEach(c => { const r = compra(c); for (let k = 1; k <= Math.max(1, c.parcelas); k++) if (somaMes(c.data.slice(0, 7), k) === ym) itens.push({ cartao: c.cartao || 'Sem cartão', valor: r.parcela, txt: `${c.programa} ${k}/${c.parcelas}` }); });
      G.clubes.forEach(c => { if (c.inicio && c.inicio.slice(0, 7) <= ym && (!c.fim || c.fim.slice(0, 7) >= ym)) itens.push({ cartao: c.cartao || 'Sem cartão', valor: c.mensal, txt: `Clube ${c.programa}` }); });
      const cartoes = {}; itens.forEach(i => { cartoes[i.cartao] = (cartoes[i.cartao] || 0) + i.valor; });
      return { ym, total: itens.reduce((s, i) => s + i.valor, 0), cartoes };
    });
    $('#gm-faturas').innerHTML = porMes.some(m => m.total) ? porMes.map(m => `<div class="gm-fatura"><small>${nomeMes(m.ym)}</small><b>${reais(m.total, true)}</b>${Object.entries(m.cartoes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span>${esc(k)}: ${reais(v, true)}</span>`).join('')}</div>`).join('')
      : '<p class="gm-vazio">Nenhuma parcela de compra nem mensalidade de clube caindo nos próximos meses.</p>';
  }
  // Limites de pessoas por programa (regras de set/2026; confirme no regulamento).
  const LIMITES = [
    { re: /SMILES/, limite: 25, regra: 'ano civil', janela: 'ano' },
    { re: /LATAM/, limite: 25, regra: '12 meses corridos', janela: '12m' },
    { re: /AZUL/, limite: 5, regra: 'lista de 5 a 8 beneficiários, conforme a categoria', janela: 'ano' }];
  function desenharCpf() {
    const G = g(), h = hoje(), umAno = new Date(Date.parse(h) - 365 * 864e5).toISOString().slice(0, 10), grupos = {};
    G.vendas.forEach(v => {
      const n = api().nome(v.programa), lim = LIMITES.find(l => l.re.test(n.toUpperCase()));
      const conta = lim ? (lim.janela === 'ano' ? v.data.startsWith(h.slice(0, 4)) : v.data >= umAno) : v.data.startsWith(h.slice(0, 4));
      if (!conta || !v.cpfs) return;
      const k = `${v.titular || ''}|${n}`; grupos[k] = grupos[k] || { titular: v.titular || '', prog: n, cpfs: 0, milhas: 0, lim }; grupos[k].cpfs += v.cpfs; grupos[k].milhas += v.milhas;
    });
    const linhas = Object.values(grupos).sort((a, b) => b.cpfs - a.cpfs);
    $('#gm-cpf').innerHTML = linhas.length ? linhas.map(l => {
      const pct = l.lim ? Math.min(100, l.cpfs / l.lim.limite * 100) : 0, resta = l.lim ? l.lim.limite - l.cpfs : null;
      return `<li><div><b>${l.titular ? `${esc(l.titular)} · ` : ''}${esc(l.prog)}</b><span>${l.cpfs} CPF${l.cpfs > 1 ? 's' : ''} · média de ${fmt(l.milhas / l.cpfs)} milhas por CPF${l.lim ? ` · conta por ${esc(l.lim.regra)}` : ''}</span>
        ${l.lim ? `<span class="gm-barra${pct >= 80 ? ' alto' : ''}" role="img" aria-label="${l.cpfs} de ${l.lim.limite}"><i style="width:${pct}%"></i></span><span class="${resta <= 3 ? 'ruim' : ''}">${resta > 0 ? `Sobram ${resta} de ${l.lim.limite}` : `Limite de ${l.lim.limite} atingido`}</span>` : ''}</div></li>`;
    }).join('') : '<li class="vazio">Os CPFs aparecem aqui conforme você anota as vendas com a quantidade de CPFs.</li>';
  }
  const tirar = (tipo, i) => `<button type="button" data-gm-tirar="${tipo}" data-i="${i}">Apagar</button>`;
  function desenharClubes(G) {
    $('#gm-clubes').innerHTML = G.clubes.length ? G.clubes.map((c, i) => ({ c, i, r: clube(c) })).sort((a, b) => b.r.ativo - a.r.ativo || (b.c.inicio || '').localeCompare(a.c.inicio || '')).map(({ c, i, r }) => {
      const ref = api().referencia(c.programa), caro = ref && r.milheiro > ref * 1.15, bom = ref && r.milheiro && r.milheiro <= ref;
      return `<li class="${r.ativo ? '' : 'gm-inativo'}"><div><b>${esc(c.programa)}${c.titular ? ` · ${esc(c.titular)}` : ''}${r.ativo ? '' : ' · cancelado'}</b>
        <span>Desde ${esc(dataBR(c.inicio))}${c.fim ? ` até ${esc(dataBR(c.fim))}` : ''} · ${reais(c.mensal, true)}/mês · ${fmt(c.pontos)} pontos/mês${c.cartao ? ` · ${esc(c.cartao)}` : ''}</span>
        <span>${r.meses} ${r.meses === 1 ? 'mês' : 'meses'} · pagou ${reais(r.pagoTudo, true)} · recebeu ${fmt(r.pontosTudo)} pontos → <b class="${caro ? 'ruim' : bom ? 'ok' : ''}">milheiro ${mil(r.milheiro)}</b>${caro ? ` · acima do preço bom (${mil(ref)})` : bom ? ' · bom preço' : ''}</span>
        ${r.ativo && c.lembrete ? `<span class="${c.lembrete <= hoje() ? 'ruim' : ''}">🔔 Lembrar de cancelar em ${esc(dataBR(c.lembrete))}</span>` : ''}
        ${c.obs ? `<span class="gm-obs">${esc(c.obs)}</span>` : ''}</div>
        <div class="gm-acoes">${r.ativo ? `<button type="button" data-gm-cancelar="${i}">Cancelei</button>` : ''}${tirar('clubes', i)}</div></li>`;
    }).join('') : '<li class="vazio">Nenhum clube anotado.</li>';
  }
  function desenharCompras(G) {
    $('#gm-compras').innerHTML = G.compras.length ? G.compras.map((c, i) => ({ c, i })).sort((a, b) => b.c.data.localeCompare(a.c.data)).map(({ c, i }) => {
      const r = compra(c);
      return `<li><div><b>${fmt(c.pontos)} ${esc(c.programa)}${c.titular ? ` · ${esc(c.titular)}` : ''}</b>
        <span>${esc(dataBR(c.data))} · ${reais(c.valor, true)}${c.parcelas > 1 ? ` em ${c.parcelas}x de ${reais(r.parcela, true)}` : ''}${c.cartao ? ` · ${esc(c.cartao)}` : ''}</span>
        <span>Milheiro ${mil(r.milheiro)}${r.extra ? ` · o cartão gerou mais ${fmt(r.extra)} pontos → <b class="ok">${mil(r.efetivo)}</b>` : ''}</span>
        ${c.obs ? `<span class="gm-obs">${esc(c.obs)}</span>` : ''}</div><div class="gm-acoes">${tirar('compras', i)}</div></li>`;
    }).join('') : '<li class="vazio">Nenhuma compra anotada.</li>';
  }
  function desenharVendas(G) {
    $('#gm-vendas').innerHTML = G.vendas.length ? G.vendas.map((v, i) => ({ v, i })).sort((a, b) => b.v.data.localeCompare(a.v.data)).map(({ v, i }) => {
      const r = venda(v);
      return `<li class="${r.atrasada ? 'gm-atrasada' : ''}"><div><b>${fmt(v.milhas)} ${esc(v.programa)}${v.titular ? ` · ${esc(v.titular)}` : ''}</b>
        <span>${esc(dataBR(v.data))}${v.comprador ? ` · para ${esc(v.comprador)}` : ''}${v.cpfs ? ` · ${v.cpfs} CPF${v.cpfs > 1 ? 's' : ''} (${fmt(v.milhas / v.cpfs)} por CPF)` : ''}</span>
        <span>${reais(v.valor, true)} · milheiro ${mil(r.milheiro)}${r.lucro != null ? ` · custo ${mil(v.custo)} → <b class="${r.lucro >= 0 ? 'ok' : 'ruim'}">${r.lucro >= 0 ? 'lucro' : 'prejuízo'} ${reais(Math.abs(r.lucro), true)}</b>` : ''}</span>
        <span class="${r.atrasada ? 'ruim' : v.recebido ? 'ok' : ''}">${v.recebido ? 'Recebido' : r.atrasada ? `Atrasado: era para ${esc(dataBR(v.pagamento))}` : v.pagamento ? `A receber em ${esc(dataBR(v.pagamento))}${r.dias != null ? ` (${r.dias} dias)` : ''}` : 'A receber'}</span>
        ${v.obs ? `<span class="gm-obs">${esc(v.obs)}</span>` : ''}</div>
        <div class="gm-acoes">${v.recebido ? '' : `<button type="button" data-gm-recebi="${i}">Recebi</button>`}${tirar('vendas', i)}</div></li>`;
    }).join('') : '<li class="vazio">Nenhuma venda anotada.</li>';
  }

  /* ---------- Formulários ---------- */
  const aviso = t => document.querySelectorAll('.ct-status').forEach(s => { s.textContent = t; });
  document.addEventListener('submit', e => {
    const f = e.target; if (!f.matches || !f.matches('#gm-clube, #gm-compra, #gm-venda')) return;
    e.preventDefault();
    const G = g(); if (!G) return;
    const v = k => (f.elements[k] ? f.elements[k].value.trim() : ''), base = { titular: v('titular').slice(0, 30), programa: v('programa'), cartao: v('cartao').slice(0, 30), obs: v('obs').slice(0, 120) };
    if (!base.programa) { aviso('Escolha o programa.'); return; }
    if (f.id === 'gm-clube') {
      const c = { ...base, inicio: v('inicio'), fim: v('fim'), lembrete: v('lembrete'), mensal: dec(v('mensal')), pontos: num(v('pontos')), bonus: num(v('bonus')), indicacao: num(v('indicacao')), upgrade: dec(v('upgrade')) };
      if (!c.inicio || !c.mensal) { aviso('Preencha a data de início e a mensalidade.'); return; }
      G.clubes.push(c); salvar('Clube anotado');
    } else if (f.id === 'gm-compra') {
      const c = { ...base, data: v('data') || hoje(), pontos: num(v('pontos')), valor: dec(v('valor')), ppd: dec(v('ppd')), dolar: dec(v('dolar')) || dolar, parcelas: Math.max(1, Math.min(24, num(v('parcelas')) || 1)) };
      if (!c.pontos || !c.valor) { aviso('Preencha os pontos e o valor pago.'); return; }
      G.compras.push(c); salvar('Compra anotada');
    } else {
      const c = { ...base, data: v('data') || hoje(), pagamento: v('pagamento'), comprador: v('comprador').slice(0, 40), cpfs: num(v('cpfs')), milhas: num(v('milhas')), valor: dec(v('valor')), custo: dec(v('custo')), recebido: f.elements.recebido.checked };
      if (!c.milhas || !c.valor) { aviso('Preencha as milhas e o valor da venda.'); return; }
      G.vendas.push(c); salvar('Venda anotada');
    }
    const prog = f.elements.programa.value, tit = f.elements.titular.value;
    f.reset(); f.elements.programa.value = prog; f.elements.titular.value = tit;
    desenhar();
  });
  // Sugestão de custo do milheiro na venda: o que você pagou em média naquele programa.
  document.addEventListener('change', e => {
    const f = e.target.closest && e.target.closest('#gm-venda');
    if (f && e.target.name === 'programa' && g()) {
      const c = custoMedio(e.target.value);
      f.elements.custo.placeholder = c ? `sua média: ${c.toFixed(2).replace('.', ',')}` : 'ex.: 17,50';
      if (c && !f.elements.custo.value) f.elements.custo.value = c.toFixed(2).replace('.', ',');
    }
  });
  document.addEventListener('click', e => {
    const b = e.target.closest && e.target.closest('[data-gm-ano],[data-gm-tirar],[data-gm-cancelar],[data-gm-recebi],#gm-exportar');
    if (!b || !g()) return;
    const G = g();
    if (b.dataset.gmAno) { filtroAno = b.dataset.gmAno; desenharResumo(); return; }
    if (b.dataset.gmTirar) {
      const tipo = b.dataset.gmTirar, item = G[tipo][+b.dataset.i];
      if (!item || !confirm('Apagar este registro? Não dá para desfazer.')) return;
      G[tipo].splice(+b.dataset.i, 1); salvar('Apagado'); desenhar(); return;
    }
    if (b.dataset.gmCancelar) { const c = G.clubes[+b.dataset.gmCancelar]; if (c) { c.fim = hoje(); salvar('Clube marcado como cancelado'); desenhar(); } return; }
    if (b.dataset.gmRecebi) { const v = G.vendas[+b.dataset.gmRecebi]; if (v) { v.recebido = true; salvar('Venda marcada como recebida'); desenhar(); } return; }
    if (b.id === 'gm-exportar') exportar(G);
  });
  function exportar(G) {
    const q = x => `"${String(x ?? '').replace(/"/g, '""')}"`, n = x => String(Math.round((x || 0) * 100) / 100).replace('.', ',');
    const linhas = [['Tipo', 'Data', 'Titular', 'Programa', 'Cartão', 'Pontos/milhas', 'Valor (R$)', 'Milheiro', 'Detalhes']];
    G.clubes.forEach(c => { const r = clube(c); linhas.push(['Clube', c.inicio, c.titular, c.programa, c.cartao, r.pontosTudo, n(r.pagoTudo), n(r.milheiro), `${r.meses} meses · ${n(c.mensal)}/mês${c.fim ? ` · cancelado em ${c.fim}` : ''} ${c.obs || ''}`]); });
    G.compras.forEach(c => { const r = compra(c); linhas.push(['Compra', c.data, c.titular, c.programa, c.cartao, c.pontos + r.extra, n(c.valor), n(r.efetivo), `${c.parcelas}x · ${r.extra} pontos do cartão ${c.obs || ''}`]); });
    G.vendas.forEach(v => { const r = venda(v); linhas.push(['Venda', v.data, v.titular, v.programa, '', v.milhas, n(v.valor), n(r.milheiro), `${v.comprador || ''} · ${v.cpfs} CPFs · ${v.recebido ? 'recebido' : `a receber ${v.pagamento || ''}`}${r.lucro != null ? ` · lucro ${n(r.lucro)}` : ''} ${v.obs || ''}`]); });
    const csv = '﻿' + linhas.map(l => l.map(q).join(';')).join('\r\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `gestao-de-milhas-${hoje()}.csv`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  document.addEventListener('conta-pronta', desenhar);
  document.addEventListener('assinatura', () => setTimeout(desenhar, 50));
  addEventListener('hashchange', () => { if (location.hash === '#gestao') desenhar(); });
  if (location.hash === '#gestao') desenhar();
})();
