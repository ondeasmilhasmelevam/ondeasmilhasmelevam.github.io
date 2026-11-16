// Mapa de rotas (#mapa e #mapa/GRU-LIS): as rotas que tiveram alerta nos últimos 12 meses.
// Rotas e contagens vêm do servidor (/malha, sem preço); coordenadas dos aeroportos em dados/aeroportos.json.
// O mapa (d3 + contorno dos países do Natural Earth) só é baixado quando a pessoa abre a página.
(() => {
  const SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev';
  const LIBS = ['https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js', 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js'];
  const MUNDO = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json';
  const MUNDO_LEVE = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json';
  const CENTRO_GLOBO = { asia: [[60, 5], [140, 45], [100, 25]], africa: [[-20, -30], [45, 30], [15, 0]] };
  const VISTAS = { mundo: [[-122, -48], [62, 62]], tudo: null, brasil: [[-74, -34], [-34, 5]], europa: [[-75, -35], [32, 60]], eua: [[-125, -35], [-34, 50]], africa: [[-60, -36], [52, 38]], asia: [[-55, -35], [145, 55]] };
  const $ = s => document.querySelector(s);
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => Number(n).toLocaleString('pt-BR');
  const NOME_CAB = { economica: 'Econômica', executiva: 'Executiva', 'primeira-classe': 'Primeira Classe', 'economica-premium': 'Econômica Premium', primeira: 'Primeira Classe' };
  const bandeira = iso => iso && iso.length === 2 ? String.fromCodePoint(...[...iso.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : '';
  let pronto = null, D = null, est = { de: '', para: '', cab: '' }, z = null, svg, g, proj, caminho, k = 1;

  const carregarScript = src => new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
  function iniciar() {
    if (pronto) return pronto;
    pronto = (async () => {
      for (const src of LIBS) await carregarScript(src);
      const [malha, aeros, mundo, nomesPt] = await Promise.all([
        (async () => { const r = await fetch(`${SERVIDOR}/malha`, { headers: { authorization: `Bearer ${window.oammlToken ? await window.oammlToken() : ''}` } }); if (!r.ok) throw new Error('malha'); return r.json(); })(),
        fetch('dados/aeroportos.json', { cache: 'no-cache' }).then(r => r.json()),
        fetch(MUNDO_LEVE).then(r => r.json()),
        fetch('dados/paises-pt.json').then(r => r.json()).catch(() => ({}))
      ]);
      montarDados(malha, aeros);
      geo.leve = contornos(mundo);
      geo.paises = nomesDosPaises(mundo, nomesPt);
      desenharBase();
      fetch(MUNDO).then(r => r.json()).then(m => { geo.detalhe = contornos(m); if (!movendo) posicionar(); }).catch(() => {});
    })().catch(e => { $('#mapa-carregando').textContent = 'Não deu para carregar o mapa agora. Tente de novo em instantes.'; pronto = null; throw e; });
    return pronto;
  }

  // Junta ida e volta numa linha só (o traço mostra o total) e soma os alertas de cada aeroporto.
  function montarDados(malha, aeros) {
    const nomes = {}, rotas = [];
    for (const [oi, di, o, d, cab, n, ult, sl] of malha.rotas || []) {
      if (!aeros[oi] || !aeros[di] || oi === di) continue;
      nomes[oi] = nomes[oi] || o; nomes[di] = nomes[di] || d;
      rotas.push({ oi, di, cab, n, ult, sl: sl || (cab === 'eco' ? 'economica' : 'executiva'), cabNome: NOME_CAB[sl] || (sl ? sl.replace(/-/g, ' ') : '') });
    }
    D = { rotas, nomes, aeros, gerado: malha.gerado };
    $('#mapa-aeros').innerHTML = Object.keys(nomes).sort((a, b) => (nomes[a] || '').localeCompare(nomes[b] || '', 'pt'))
      .map(i => `<option value="${i}">${esc(nomes[i])}</option>`).join('');
  }
  const daCabine = r => !est.cab || r.cab === est.cab;
  function pares() {
    const m = new Map();
    for (const r of D.rotas.filter(daCabine)) {
      const br = i => (D.aeros[i] || [])[2] === 'BR';
      const [a, b] = br(r.oi) !== br(r.di) ? (br(r.oi) ? [r.oi, r.di] : [r.di, r.oi]) : [r.oi, r.di].sort(), ch = `${a}-${b}`;
      const p = m.get(ch) || m.set(ch, { a, b, n: 0 }).get(ch);
      p.n += r.n;
    }
    return [...m.values()];
  }
  function porAeroporto() {
    const m = {};
    for (const r of D.rotas.filter(daCabine)) {
      for (const i of [r.oi, r.di]) { m[i] = m[i] || { n: 0, destinos: new Set() }; m[i].n += r.n; }
      m[r.oi].destinos.add(r.di);
    }
    return m;
  }
  const xy = i => proj([D.aeros[i][1], D.aeros[i][0]]);
  const nomeDe = i => D.nomes[i] || (GR && GR.nome[i]) || i;
  // dados do aeroporto: do site ou, se faltar, da rede de trechos (lat, lon, país, nome do país)
  const aeroInfo = i => D.aeros[i] || (GR && GR.pos[i] ? [GR.pos[i][0], GR.pos[i][1], GR.pos[i][2], new Intl.DisplayNames(['pt-BR'], { type: 'region' }).of(GR.pos[i][2] || 'ZZ') || ''] : [0, 0, '', '']);

  // Dois jeitos de ver: globo (gira com o dedo ou o mouse, padrão) e mapa plano (zoom e arrasto).
  let modo = 'globo', base = 1, agendado = false, movendo = false, parou = 0, inercia = null;
  const geo = { leve: null, detalhe: null };
  // Terra numa forma só (bem mais leve que 240 países separados), o Brasil por cima e as fronteiras.
  // Nome de cada país no centro do seu maior pedaço (a França não vai parar na Guiana); os maiores primeiro.
  function nomesDosPaises(m, nomes) {
    return topojson.feature(m, m.objects.countries).features.filter(f => nomes[f.id]).map(f => {
      const partes = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.map(c => ({ type: 'Polygon', coordinates: c })) : [f.geometry];
      const maior = partes.reduce((a, b) => (d3.geoArea(b) > d3.geoArea(a) ? b : a));
      return { nome: nomes[f.id], c: d3.geoCentroid(maior), area: d3.geoArea(maior) };
    }).sort((a, b) => b.area - a.area);
  }
  const contornos = m => ({ terra: topojson.merge(m, m.objects.countries.geometries), br: topojson.feature(m, { type: 'GeometryCollection', geometries: m.objects.countries.geometries.filter(x => x.id === '076') }), fronteira: topojson.mesh(m, m.objects.countries, (a, b) => a !== b) });
  const coord = i => (D.aeros[i] ? [D.aeros[i][1], D.aeros[i][0]] : GR && GR.pos[i] ? [GR.pos[i][1], GR.pos[i][0]] : [0, 0]);
  const linhaDe = p => ({ type: 'LineString', coordinates: [coord(p.a), coord(p.b)] });
  const visivel = c => modo !== 'globo' || d3.geoDistance(c, [-proj.rotate()[0], -proj.rotate()[1]]) < Math.PI / 2 - 0.03;

  function desenharBase() {
    const caixa = $('#mapa-caixa');
    caixa.classList.toggle('globo', modo === 'globo');
    svg = d3.select('#mapa-svg');
    const W = caixa.clientWidth, H = W < 600 ? Math.round(W * (modo === 'globo' ? 1 : 0.82)) : Math.round(Math.min(Math.max(W * 0.52, 380), 640));
    svg.attr('viewBox', `0 0 ${W} ${H}`).style('height', H + 'px');
    if (modo === 'globo') {
      proj = d3.geoOrthographic().clipAngle(90).precision(0.6).fitExtent([[22, 22], [W - 22, H - 22]], { type: 'Sphere' }).rotate([45, 8, 0]);
    } else {
      proj = d3.geoNaturalEarth1().fitExtent([[8, 8], [W - 8, H - 8]], { type: 'Sphere' });
    }
    base = proj.scale(); k = 1;
    caminho = d3.geoPath(proj);
    svg.on('.zoom', null).on('.drag', null).on('wheel', null);
    svg.selectAll('*').remove();
    const defs = svg.append('defs');
    const halo = defs.append('radialGradient').attr('id', 'mapa-halo');
    halo.append('stop').attr('offset', '0.86').attr('class', 'mh0');
    halo.append('stop').attr('offset', '1').attr('class', 'mh1');
    const luz = defs.append('radialGradient').attr('id', 'mapa-luz').attr('cx', '35%').attr('cy', '30%');
    luz.append('stop').attr('offset', '0').attr('class', 'ml0');
    luz.append('stop').attr('offset', '1').attr('class', 'ml1');
    svg.append('rect').attr('class', 'mapa-mar').attr('width', W).attr('height', H);
    g = svg.append('g');
    if (modo === 'globo') g.append('circle').attr('class', 'mapa-halo');
    g.append('path').datum({ type: 'Sphere' }).attr('class', 'geo mapa-esfera');
    g.append('path').datum(d3.geoGraticule10()).attr('class', 'geo mapa-grade-l');
    g.append('path').attr('class', 'mundo mapa-pais').attr('data-c', 'terra');
    g.append('path').attr('class', 'mundo mapa-pais br').attr('data-c', 'br');
    g.append('path').attr('class', 'mundo mapa-fronteira').attr('data-c', 'fronteira');
    if (modo === 'globo') g.append('path').datum({ type: 'Sphere' }).attr('class', 'geo mapa-luz');
    g.append('g').attr('class', 'mapa-paises-n').selectAll('text').data(geo.paises || []).join('text')
      .attr('class', 'mapa-pais-n').attr('text-anchor', 'middle').text(d => d.nome);
    g.append('g').attr('class', 'mapa-rotas');
    g.append('g').attr('class', 'mapa-escalas');
    g.append('g').attr('class', 'mapa-aeros');
    g.append('g').attr('class', 'mapa-rotulos');
    if (modo === 'mapa') {
      z = d3.zoom().scaleExtent([1, 12]).translateExtent([[0, 0], [W, H]]).on('zoom', e => {
        k = e.transform.k; g.attr('transform', e.transform); ajustarEscala();
      });
      svg.call(z).on('dblclick.zoom', null);
    } else {
      z = null;
      let vel = [0, 0];
      const girar = (dx, dy) => {
        const r = proj.rotate(), f = 0.28 * base / proj.scale();
        proj.rotate([r[0] + dx * f, Math.max(-80, Math.min(80, r[1] - dy * f)), 0]);
        agendar();
      };
      svg.call(d3.drag()
        .on('start', () => { if (inercia) { inercia.stop(); inercia = null; } vel = [0, 0]; })
        .on('drag', e => { vel = [e.dx, e.dy]; girar(e.dx, e.dy); })
        .on('end', () => {
          // solta e o globo continua girando um pouco, freando aos poucos
          if (Math.hypot(vel[0], vel[1]) < 1.5 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
          inercia = d3.timer(() => { vel = [vel[0] * 0.92, vel[1] * 0.92]; girar(vel[0], vel[1]); if (Math.hypot(vel[0], vel[1]) < 0.2) { inercia.stop(); inercia = null; } });
        }));
      svg.on('wheel', e => { e.preventDefault(); escala(e.deltaY < 0 ? 1.15 : 1 / 1.15); }, { passive: false });
    }
    $('#mapa-carregando').hidden = true;
    desenharRotas();
    if (!est.de) vista('mundo', false); else enquadrarSelecao(false);
  }
  function escala(f) {
    if (modo === 'mapa') return z && svg.transition().duration(300).call(z.scaleBy, f);
    proj.scale(Math.max(base * 0.9, Math.min(base * 7, proj.scale() * f)));
    agendar();
  }
  function agendar() {
    movendo = true;
    clearTimeout(parou);
    parou = setTimeout(() => { movendo = false; posicionar(); }, 180); // parou: desenha com o contorno detalhado
    if (agendado) return;
    agendado = true;
    requestAnimationFrame(() => { agendado = false; posicionar(); });
  }
  // Põe tudo no lugar para a projeção atual (no globo, roda a cada giro; no plano, uma vez).
  function posicionar() {
    if (modo === 'globo') {
      const [tx, ty] = proj.translate();
      g.select('.mapa-halo').attr('cx', tx).attr('cy', ty).attr('r', proj.scale() * 1.09);
    }
    // Girando: contorno leve e só as rotas em destaque; parado: tudo, com o contorno detalhado.
    const leve = modo === 'globo' && movendo;
    const c = (leve ? geo.leve : geo.detalhe || geo.leve);
    proj.precision(leve ? 1.5 : 0.6);
    g.selectAll('.geo').attr('d', caminho);
    g.selectAll('.mundo').attr('d', function () { return caminho(c[this.dataset.c]); });
    g.selectAll('.mapa-escala').attr('d', e => caminho({ type: 'LineString', coordinates: [coord(e[0]), coord(e[1])] }) || '');
    g.selectAll('.mapa-escala-pt').each(function (d) { d.xy = proj(coord(d.i)); d.ve = visivel(coord(d.i)); })
      .attr('cx', d => d.xy[0]).attr('cy', d => d.xy[1]).style('display', d => d.ve ? null : 'none');
    g.selectAll('.mapa-escala-n').each(function (d) { d.xy = proj(coord(d.i)); d.ve = visivel(coord(d.i)); })
      .attr('x', d => d.xy[0]).attr('y', d => d.xy[1] - 9).style('display', d => d.ve ? null : 'none');
    g.selectAll('.mapa-rota').each(function (p) {
      const esconder = p.estado === 'oculta' || (leve && p.estado === 'fraca');
      this.style.display = esconder ? 'none' : '';
      if (!esconder) this.setAttribute('d', caminho(linhaDe(p)) || '');
    });
    g.selectAll('.mapa-aero').each(function (d) { d.xy = proj(coord(d.i)); d.ve = visivel(coord(d.i)); })
      .attr('cx', d => d.xy[0]).attr('cy', d => d.xy[1]).style('display', d => d.ve ? null : 'none');
    g.selectAll('.mapa-rotulo').each(function (d) { d.xy = proj(coord(d.i)); d.ve = visivel(coord(d.i)); })
      .attr('x', d => d.xy[0]).attr('y', d => d.xy[1]);
    g.selectAll('.mapa-pais-n').each(function (d) { d.xy = proj(d.c); d.ve = visivel(d.c); })
      .attr('x', d => d.xy[0]).attr('y', d => d.xy[1]);
    ajustarEscala();
  }
  function ajustarEscala() {
    const kk = modo === 'globo' ? Math.max(1, proj.scale() / base) : k, fator = modo === 'globo' ? 1 : k;
    g.selectAll('.mapa-aero').attr('r', d => d.r / Math.sqrt(fator));
    // Rótulos: os mais importantes primeiro; um rótulo só aparece se não encostar em outro já posto.
    const postos = [], sel0 = est.de;
    g.selectAll('.mapa-rotulo').attr('font-size', 10.5 / fator).attr('dy', d => -(d.r + 4) / Math.sqrt(fator))
      .style('display', d => {
        if (d.ve === false) return 'none';
        const quer = d.sel || (d.liga && (kk >= 1.6 || d.n >= 6)) || (d.hub && !(sel0 && !d.liga)) || (kk >= 2.2 && d.n >= 20) || (kk >= 3.2 && d.n >= 6) || kk >= 5;
        if (!quer) return 'none';
        const x = d.xy[0] * fator, y = d.xy[1] * fator, cx = [x - 16, y - 22, x + 16, y - 6];
        if (!d.sel && postos.some(b => cx[0] < b[2] && cx[2] > b[0] && cx[1] < b[3] && cx[3] > b[1])) return 'none';
        postos.push(cx);
        return null;
      });
    // Nomes dos países: só ao aproximar; quanto mais perto, menores os países que ganham nome.
    // Não cobrem as siglas dos aeroportos nem se encostam.
    const minimo = kk < 1.3 ? Infinity : 0.03 / (kk * kk);
    g.selectAll('.mapa-pais-n').attr('font-size', 10.5 / fator).style('display', d => {
      if (d.ve === false || d.area < minimo) return 'none';
      const w = d.nome.length * 3.6 + 6, x = d.xy[0] * fator, y = d.xy[1] * fator, cx = [x - w, y - 9, x + w, y + 4];
      if (postos.some(b => cx[0] < b[2] && cx[2] > b[0] && cx[1] < b[3] && cx[3] > b[1])) return 'none';
      postos.push(cx);
      return null;
    });
  }

  function desenharRotas() {
    const P = pares(), A = porAeroporto();
    const maxN = d3.max(P, p => p.n) || 1, maxA = d3.max(Object.values(A), a => a.n) || 1;
    const larg = d3.scaleSqrt().domain([1, maxN]).range([0.5, 3.6]);
    const raio = d3.scaleSqrt().domain([1, maxA]).range([1.8, 5.5]);
    const sel = est.de, alvo = est.para;
    // Sem nada marcado, as linhas ficam apagadas: o globo mostra só os aeroportos. Elas acendem ao marcar.
    // Com origem e destino marcados, só a rota (e o caminho escolhido) aparece; com só a origem, as rotas dela.
    const liga = p => !sel ? 'oculta' : alvo ? ((p.a === sel || p.b === sel) && (p.a === alvo || p.b === alvo) ? 'foco' : 'oculta') : (p.a === sel || p.b === sel) ? 'ativa' : 'fraca';
    const ordem = P.map(p => ({ ...p, estado: liga(p) })).sort((x, y) => ['oculta', 'fraca', 'normal', 'ativa', 'foco'].indexOf(x.estado) - ['oculta', 'fraca', 'normal', 'ativa', 'foco'].indexOf(y.estado) || x.n - y.n);
    g.select('.mapa-rotas').selectAll('path').data(ordem, p => `${p.a}-${p.b}`).join('path')
      .attr('class', p => `mapa-rota ${p.estado}`)
            .attr('stroke-width', p => p.estado === 'foco' ? Math.max(larg(p.n), 2.6) : larg(p.n))
      .on('mousemove', (e, p) => dica(e, `<b>${p.a} ⇄ ${p.b}</b><span>${esc(nomeDe(p.a))} ⇄ ${esc(nomeDe(p.b))}</span><small>${fmt(p.n)} ${p.n === 1 ? 'alerta' : 'alertas'} em 12 meses</small>`))
      .on('mouseleave', () => { $('#mapa-tip').hidden = true; })
      .on('click', (e, p) => { e.stopPropagation(); escolher(sel === p.b ? p.b : p.a, sel === p.b ? p.a : p.b); });
    const pontos = Object.entries(A).map(([i, a]) => ({ i, n: a.n, nd: a.destinos.size, r: raio(a.n), xy: xy(i), ve: true }))
      .sort((x, y) => x.n - y.n);
    const nivel = n => n >= 100 ? 'n4' : n >= 30 ? 'n3' : n >= 7 ? 'n2' : 'n1';
    const ligados = sel ? new Set(P.filter(p => p.a === sel || p.b === sel).flatMap(p => [p.a, p.b])) : null;
    // Hubs: os 8 aeroportos do Brasil e os 8 de fora com mais alertas. Só eles têm nome na visão geral; o resto aparece ao aproximar ou ao marcar.
    const porN = [...pontos].sort((x, y) => y.n - x.n), noBr = d => (D.aeros[d.i] || [])[2] === 'BR';
    const hubs = new Set([...porN.filter(noBr).slice(0, 8), ...porN.filter(d => !noBr(d)).slice(0, 8)].map(d => d.i));
    g.select('.mapa-aeros').selectAll('circle').data(pontos, d => d.i).join('circle')
      .attr('class', d => `mapa-aero${hubs.has(d.i) ? ' hub' : ''}${ligados && ligados.has(d.i) ? ' liga' : ''}${d.i === sel ? ' de' : ''}${d.i === alvo ? ' para' : ''}${ligados && !ligados.has(d.i) ? ' apagado' : ''}`)
      .on('mousemove', (e, d) => dica(e, `<b>${esc(nomeDe(d.i))} · ${d.i}</b><small>${fmt(d.n)} ${d.n === 1 ? 'alerta' : 'alertas'} · ${d.nd} ${d.nd === 1 ? 'destino' : 'destinos'} com alerta saindo daqui</small>`))
      .on('mouseleave', () => { $('#mapa-tip').hidden = true; })
      .on('click', (e, d) => { e.stopPropagation(); clicarAeroporto(d.i); });
    const rot = pontos.map(d => ({ ...d, sel: d.i === sel || d.i === alvo, hub: hubs.has(d.i), liga: !!(ligados && ligados.has(d.i)) }))
      .sort((x, y) => (y.sel - x.sel) || (y.liga - x.liga) || (y.n - x.n));
    g.select('.mapa-rotulos').selectAll('text').data(rot, d => d.i).join('text')
      .attr('class', d => `mapa-rotulo${d.sel ? ' sel' : d.liga ? ' liga' : d.hub ? ' hub' : ''}`)
      .attr('text-anchor', 'middle').text(d => d.i);
    posicionar();
    legenda(maxN);
    painel(A);
  }
  function legenda() {
    $('#mapa-leg').innerHTML = `<span><i class="lg-hub"></i>hub principal</span><span><i class="lg-aero"></i>aeroporto com alerta</span><span><i class="lg-liga"></i>marcado e destinos</span>`;
  }
  function dica(e, html) {
    const t = $('#mapa-tip'), c = $('#mapa-caixa').getBoundingClientRect();
    t.innerHTML = html; t.hidden = false;
    const x = e.clientX - c.left, y = e.clientY - c.top, w = t.offsetWidth;
    t.style.left = Math.min(Math.max(x - w / 2, 6), c.width - w - 6) + 'px';
    t.style.top = Math.max(y - t.offsetHeight - 14, 6) + 'px';
  }

  // Seleção: primeiro clique escolhe a origem, o segundo o destino; clicar de novo na origem limpa.
  function clicarAeroporto(i) {
    if (!est.de || (est.de && est.para)) return escolher(i, est.de && est.para && i !== est.de ? '' : '');
    if (i === est.de) return escolher('', '');
    escolher(est.de, i);
  }
  function escolher(de, para, enquadrar = true) {
    est.de = de; est.para = para; escolhida = null;
    if (g) g.select('.mapa-escalas').selectAll('*').remove();
    $('#mapa-de').value = de; $('#mapa-para').value = para;
    const hash = de ? `#mapa/${de}${para ? '-' + para : ''}` : '#mapa';
    if (location.hash !== hash) history.replaceState(null, '', hash);
    desenharRotas();
    if (enquadrar) enquadrarSelecao();
  }
  function enquadrarSelecao(animar = true) {
    if (!est.de) return;
    const P = pares().filter(p => p.a === est.de || p.b === est.de).filter(p => !est.para || p.a === est.para || p.b === est.para);
    irPara([est.de, ...(est.para ? [est.para] : P.flatMap(p => [p.a, p.b]))].map(coord), animar);
  }
  function irPara(pts, animar = true) {
    if (!svg) return;
    const W = +svg.attr('viewBox').split(' ')[2], H = +svg.attr('viewBox').split(' ')[3];
    if (modo === 'globo') {
      let rot = [45, 8, 0], esc = base;
      if (pts && pts.length) {
        const c = d3.geoCentroid({ type: 'MultiPoint', coordinates: pts });
        const raioAng = Math.max(0.08, ...pts.map(p => d3.geoDistance(c, p)));
        rot = [-c[0], -c[1], 0];
        esc = Math.max(base, Math.min(base * 6, 0.8 * base / Math.sin(Math.min(raioAng + 0.12, Math.PI / 2))));
      }
      const r0 = proj.rotate();
      rot[0] = r0[0] + ((((rot[0] - r0[0]) % 360) + 540) % 360 - 180); // gira pelo caminho mais curto
      if (!animar) { proj.rotate(rot).scale(esc); posicionar(); return; }
      const ir = d3.interpolate(r0, rot), is = d3.interpolate(proj.scale(), esc);
      svg.transition().duration(1100).ease(d3.easeCubicInOut).tween('giro', () => t => { proj.rotate(ir(t)).scale(is(t)); agendar(); });
      return;
    }
    const alvo = animar ? svg.transition().duration(750) : svg;
    if (!pts || !pts.length) { alvo.call(z.transform, d3.zoomIdentity); return; }
    const xy2 = pts.map(p => proj(p)), xs = xy2.map(p => p[0]), ys = xy2.map(p => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const kk = Math.max(1, Math.min(8, 0.72 / Math.max((x1 - x0) / W, (y1 - y0) / H, 0.06)));
    alvo.call(z.transform, d3.zoomIdentity.translate(W / 2, H / 2).scale(kk).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
  }
  // "Mundo" enquadra Américas, Europa, África e Oriente Médio, onde estão quase todas as rotas; o botão ⤢ mostra o planeta inteiro.
  function vista(nome, animar = true) {
    document.querySelectorAll('#mapa-vistas button[data-v]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === nome)));
    const v = VISTAS[nome];
    // No globo, Brasil e Ásia não cabem no mesmo lado: a vista da Ásia gira até lá (e a da África a centraliza).
    if (modo === 'globo' && CENTRO_GLOBO[nome]) return irPara(CENTRO_GLOBO[nome], animar);
    irPara(v ? [v[0], v[1], [(v[0][0] + v[1][0]) / 2, v[0][1]], [(v[0][0] + v[1][0]) / 2, v[1][1]]] : null, animar);
  }

  // Painel ao lado do mapa: visão geral, uma origem ou uma rota.
  function painel(A) {
    const el = $('#mapa-painel'), cabTxt = c => c === 'eco' ? 'Econômica' : 'Executiva/Primeira';
    const linkRota = r => `#rota/${r.oi}-${r.di}-${r.sl}`;
    if (!est.de) {
      const P = pares().sort((a, b) => b.n - a.n), tot = d3.sum(P, p => p.n);
      const origens = Object.entries(A).map(([i, a]) => [i, D.rotas.filter(daCabine).filter(r => r.oi === i).reduce((s, r) => s + r.n, 0)]).sort((a, b) => b[1] - a[1]).slice(0, 6);
      el.innerHTML = `<p class="mp-kicker">Últimos 12 meses</p><div class="mp-nums"><div><b>${fmt(P.length)}</b><small>rotas com alerta</small></div><div><b>${fmt(tot)}</b><small>alertas</small></div><div><b>${fmt(Object.keys(A).length)}</b><small>aeroportos</small></div></div>
        <div class="mp-colunas"><div><h3>Rotas com mais alertas</h3><ol class="mp-lista">${P.slice(0, 8).map(p => `<li><button type="button" data-de="${p.a}" data-para="${p.b}"><span>${p.a} ⇄ ${p.b}<small>${esc(nomeDe(p.a))} ⇄ ${esc(nomeDe(p.b))}</small></span><b>${fmt(p.n)}</b></button></li>`).join('')}</ol></div>
        <div><h3>De onde mais sai alerta</h3><ol class="mp-lista">${origens.map(([i, n]) => `<li><button type="button" data-de="${i}"><span>${esc(nomeDe(i))}<small>${i} · ${esc(D.aeros[i][3] || '')}</small></span><b>${fmt(n)}</b></button></li>`).join('')}</ol></div></div>
        <p class="mp-dica">Toque num aeroporto do mapa para ver para onde saem alertas dali.</p>`;
      return;
    }
    const de = est.de, ad = aeroInfo(de);
    if (!est.para) {
      const saindo = D.rotas.filter(daCabine).filter(r => r.oi === de);
      const porDest = {}; saindo.forEach(r => { const p = porDest[r.di] || (porDest[r.di] = { n: 0, cabs: new Set(), ult: '' }); p.n += r.n; p.cabs.add(r.cab); if (r.ult > p.ult) p.ult = r.ult; });
      const lista = Object.entries(porDest).sort((a, b) => b[1].n - a[1].n);
      el.innerHTML = `<p class="mp-kicker">Saindo de</p><h3 class="mp-tit">${esc(nomeDe(de))} <small>${de} · ${esc(ad[3] || '')}</small></h3>
        <div class="mp-nums"><div><b>${fmt(lista.length)}</b><small>destinos com alerta</small></div><div><b>${fmt(d3.sum(lista, ([, p]) => p.n))}</b><small>alertas</small></div></div>
        ${lista.length ? `<ol class="mp-lista">${lista.slice(0, 14).map(([i, p]) => `<li><button type="button" data-de="${de}" data-para="${i}"><span>${esc(nomeDe(i))}<small>${i} · ${esc(D.aeros[i][3] || '')} · ${[...p.cabs].map(cabTxt).join(' e ')}</small></span><b>${fmt(p.n)}</b></button></li>`).join('')}</ol>${lista.length > 14 ? `<p class="mp-dica">E mais ${lista.length - 14} destinos no mapa.</p>` : ''}`
          : '<p class="mp-dica">Nenhum alerta saindo daqui nos últimos 12 meses com esse filtro.</p>'}
        <p class="mp-dica">Toque num destino da lista ou do mapa para ver a rota.</p>`;
      return;
    }
    const para = est.para, ap = aeroInfo(para);
    const km = Math.round(d3.geoDistance(coord(de), coord(para)) * 6371);
    const horas = km / 830 + 0.5, hTxt = `${Math.floor(horas)}h${String(Math.round((horas % 1) * 60)).padStart(2, '0')}`;
    const ida = D.rotas.filter(daCabine).filter(r => r.oi === de && r.di === para), volta = D.rotas.filter(daCabine).filter(r => r.oi === para && r.di === de);
    const nIda = d3.sum(ida, r => r.n), nVolta = d3.sum(volta, r => r.n);
    const ultimo = ida.reduce((u, r) => r.ult > u ? r.ult : u, '');
    const quando = ultimo ? (() => { const n = Math.round((Date.now() - new Date(ultimo + 'T12:00:00')) / 864e5); return n <= 0 ? 'hoje' : n === 1 ? 'ontem' : `há ${n} dias`; })() : '';
    el.innerHTML = `<p class="mp-kicker">Rota</p>
      <h3 class="mp-tit">${de} <i>→</i> ${para}</h3><p class="mp-sub">${esc(nomeDe(de))}, ${esc(ad[3] || '')} → ${esc(nomeDe(para))}, ${esc(ap[3] || '')}</p>
      <div class="mp-nums"><div><b>${fmt(km)} km</b><small>distância em linha reta</small></div><div><b>${hTxt}</b><small>voo direto estimado</small></div><div><b>${fmt(nIda)}</b><small>alertas em 12 meses</small></div></div>
      ${nIda ? `<p class="mp-dica">Último alerta ${quando}. ${ida.map(r => `${esc(r.cabNome || cabTxt(r.cab))}: ${fmt(r.n)}`).join(' · ')}</p>
        <div class="mp-acoes">${ida.map(r => `<a class="cta cta-a" href="${linkRota(r)}">📈 Histórico da rota${ida.length > 1 ? ` (${esc((r.cabNome || cabTxt(r.cab)).toLowerCase())})` : ''}</a>`).join('')}</div>`
        : `<p class="mp-dica">Nenhum alerta nesse sentido nos últimos 12 meses${est.cab ? ' com essa cabine' : ''}.</p><div class="mp-acoes"><a class="cta cta-a" href="#radar">🔔 Me avise quando aparecer</a></div>`}
      ${nVolta ? `<button type="button" class="mp-volta" data-de="${para}" data-para="${de}">No sentido ${para} → ${de}: ${fmt(nVolta)} ${nVolta === 1 ? 'alerta' : 'alertas'}. Ver esse sentido →</button>` : ''}
      <p class="mp-nota">Distância em linha reta e tempo estimado a 830 km/h, sem escalas. Os horários reais dependem da companhia.</p>
      <div class="mp-escalas" id="mp-escalas"><h3>Por onde ir com milhas</h3><p class="mp-dica">Procurando caminhos…</p></div>`;
    porOndeIr(de, para);
  }

  // "Por onde ir": rede de trechos que os programas vendem com milhas (seats.aero, montada pelo robô 1x por dia).
  let GR = null, grPromessa = null, escolhida = null;
  function carregarGrafo() {
    if (grPromessa) return grPromessa;
    grPromessa = (async () => {
      const r = await fetch(`${SERVIDOR}/grafo`, { headers: { authorization: `Bearer ${window.oammlToken ? await window.oammlToken() : ''}` } });
      if (!r.ok) throw new Error(r.status === 404 ? 'montando' : 'erro');
      const j = await r.json();
      const pos = {}, nome = {}, sai = {};
      j.a.forEach(([i, lat, lon, iso, cidade]) => { pos[i] = [lat, lon, iso]; nome[i] = cidade; });
      j.e.forEach(([o, d, m, km]) => { const a = j.a[o][0], b = j.a[d][0]; (sai[a] = sai[a] || new Map()).set(b, { m, km }); });
      GR = { pos, nome, sai, fontes: j.fontes, gerado: j.gerado };
      return GR;
    })().catch(e => { grPromessa = null; throw e; });
    return grPromessa;
  }
  const programas = m => GR.fontes.filter((f, b) => m & (1 << b)).map(f => f[1]);
  const kmEntre = (a, b) => Math.round(d3.geoDistance(coord(a), coord(b)) * 6371);
  const cidade = i => (D.nomes[i] || (GR && GR.nome[i]) || i);
  // A rede do seats.aero traz pares de origem e destino que cada programa vende (o voo pode ter conexão).
  // Mostramos: quem vende a rota inteira e, para montar por partes, os hubs onde dá para trocar de trecho.
  function caminhos(de, para) {
    const sai = GR.sai, direto = sai[de] && sai[de].get(para);
    const linha = kmEntre(de, para), lista = [];
    for (const [h, t1] of sai[de] || []) {
      if (h === para) continue;
      const t2 = sai[h] && sai[h].get(para);
      if (!t2) continue;
      const km = kmEntre(de, h) + kmEntre(h, para);
      if (km > linha * 1.35) continue; // volta grande demais
      const comum = t1.m & t2.m, nComum = programas(comum).length;
      lista.push({ via: h, comum, m1: t1.m, m2: t2.m, km, nComum, tipo: comum ? 'mesmo' : 'separado' });
    }
    // primeiro onde dá para emitir os dois trechos no mesmo programa (e em mais programas), depois o menor desvio
    lista.sort((a, b) => (b.nComum > 0) - (a.nComum > 0) || b.nComum - a.nComum || a.km - b.km);
    return { direto: direto ? { via: null, comum: direto.m, km: linha, tipo: 'direto' } : null, lista: lista.slice(0, 6).map(c => ({ ...c, mais: Math.round((c.km / linha - 1) * 100) })) };
  }
  async function porOndeIr(de, para) {
    const el = () => $('#mp-escalas');
    try { await carregarGrafo(); } catch (e) {
      if (el()) el().innerHTML = `<h3>Por onde ir com milhas</h3><p class="mp-dica">${e.message === 'montando' ? 'A rede de trechos ainda está sendo montada. Volte daqui a pouco.' : 'Não deu para carregar os caminhos agora.'}</p>`;
      return;
    }
    if (est.de !== de || est.para !== para || !el()) return;
    const { direto, lista } = caminhos(de, para);
    const todos = [...(direto ? [direto] : []), ...lista];
    escolhida = null; desenharEscala();
    const chips = m => programas(m).map(n => `<span class="mp-chip">${esc(n)}</span>`).join('');
    el().innerHTML = `<h3>Por onde ir com milhas</h3>
      ${direto ? `<div class="mp-direto"><p><b>Programas que vendem ${de} → ${para} com milhas</b></p><div class="mp-chips">${chips(direto.comum)}</div>
        <small>Podem ser voos sem escala ou com conexão, conforme as parceiras de cada programa.</small></div>`
        : `<p class="mp-dica">Nenhum programa da nossa base vende ${de} → ${para} numa emissão só.${lista.length ? ' Dá para montar em dois trechos:' : ''}</p>`}
      ${lista.length ? `<p class="mp-sub2">${direto ? 'Ou montando em dois trechos, trocando em um hub:' : ''}</p><ol class="mp-caminhos">${lista.map((c, n) => `<li><button type="button" data-n="${n + (direto ? 1 : 0)}">
        <span class="mp-via">via <b>${esc(cidade(c.via))}</b> <small>${c.via}</small></span>
        <span class="mp-prog">${c.tipo === 'separado' ? `${esc(programas(c.m1).slice(0, 2).join(', '))} + ${esc(programas(c.m2).slice(0, 2).join(', '))} <em>(2 emissões)</em>` : `${esc(programas(c.comum).slice(0, 3).join(', '))}${c.nComum > 3 ? ` e mais ${c.nComum - 3}` : ''}`}</span>
        <span class="mp-km">${fmt(c.km)} km${c.mais > 0 ? ` · +${c.mais}%` : ''}</span></button></li>`).join('')}</ol>` : ''}
      ${todos.length ? `<p class="mp-nota">Dados do seats.aero, atualizados todo dia: pares de cidades que cada programa vende com milhas. Toque num hub para ver o caminho no mapa. Disponibilidade, taxas e regras mudam: confira no programa na hora de emitir.</p>`
        : '<p class="mp-dica">Não achamos caminho na rede dos programas. Tente um aeroporto vizinho da mesma região.</p>'}`;
    el().querySelectorAll('button[data-n]').forEach(b => b.addEventListener('click', () => {
      el().querySelectorAll('button[data-n]').forEach(x => x.classList.toggle('on', x === b));
      escolhida = todos[+b.dataset.n]; desenharEscala();
    }));
    // de início mostra a rota inteira (se algum programa vende) ou o melhor hub
    escolhida = todos[0] || null; desenharEscala();
    const primeiro = el().querySelector('button[data-n="0"]'); if (primeiro) primeiro.classList.add('on');
  }
  function desenharEscala() {
    if (!g) return;
    const c = escolhida, de = est.de, para = est.para;
    const trechos = c ? (c.via ? [[de, c.via], [c.via, para]] : [[de, para]]) : [];
    g.select('.mapa-escalas').selectAll('path').data(trechos).join('path').attr('class', 'mapa-escala');
    const pts = [...(c && c.via ? [{ i: c.via }] : []), ...(para && !D.aeros[para] ? [{ i: para }] : [])];
    g.select('.mapa-escalas').selectAll('circle').data(pts).join('circle').attr('class', 'mapa-escala-pt').attr('r', 5);
    g.select('.mapa-escalas').selectAll('text').data(pts).join('text').attr('class', 'mapa-escala-n').attr('text-anchor', 'middle').text(d => d.i);
    g.selectAll('.mapa-rota.foco').classed('com-escala', !!(c && c.via));
    posicionar();
  }

  // Controles
  const iataDe = v => { const t = String(v || '').trim().toUpperCase(); if (D && D.aeros[t] && D.nomes[t]) return t; const n = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); return D ? (Object.keys(D.nomes).find(i => (D.nomes[i] || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase() === n) || '') : ''; };
  $('#mapa-painel').addEventListener('click', e => { const b = e.target.closest('button[data-de]'); if (b) escolher(b.dataset.de, b.dataset.para || ''); });
  $('#mapa-de').addEventListener('change', e => escolher(iataDe(e.target.value), est.para));
  $('#mapa-para').addEventListener('change', async e => {
    const v = e.target.value.trim().toUpperCase();
    let p = iataDe(v);
    if (!p && /^[A-Z]{3}$/.test(v)) { try { await carregarGrafo(); if (GR.pos[v]) p = v; } catch (er) { /* fica sem */ } }
    if (est.de) escolher(est.de, p); else e.target.value = '';
  });
  $('#mapa-trocar').addEventListener('click', () => { if (est.de && est.para) escolher(est.para, est.de); });
  $('#mapa-limpar').addEventListener('click', () => { escolher('', '', false); vista('mundo'); });
  $('#mapa-cabine').addEventListener('change', e => { est.cab = e.target.value; if (D) desenharRotas(); });
  $('#mapa-vistas').addEventListener('click', e => { const b = e.target.closest('button[data-v]'); if (b) vista(b.dataset.v); });
  $('#mapa-modo').addEventListener('click', e => {
    const b = e.target.closest('button[data-m]'); if (!b || b.dataset.m === modo) return;
    modo = b.dataset.m;
    document.querySelectorAll('#mapa-modo button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (geo.leve) desenharBase();
  });
  $('#mapa-mais').addEventListener('click', () => svg && escala(1.6));
  $('#mapa-menos').addEventListener('click', () => svg && escala(1 / 1.6));
  $('#mapa-tudo').addEventListener('click', () => vista('tudo'));

  async function abrir() {
    const m = /^#mapa(?:\/([A-Z]{3})(?:-([A-Z]{3}))?)?$/.exec(location.hash);
    if (!m) return;
    const pode = !!(window.oammlPodeVerMapa && window.oammlPodeVerMapa());
    $('#mapa-fechado').hidden = pode;
    $('#mapa-aberto').hidden = !pode;
    if (!pode) return;
    try { await iniciar(); } catch (e) { return; }
    const [, de = '', para = ''] = m;
    let p2 = para && D.aeros[para] ? para : '';
    if (para && !p2) { try { await carregarGrafo(); if (GR.pos[para]) p2 = para; } catch (e) { /* fica sem */ } }
    if (de !== est.de || p2 !== est.para) escolher(de && D.aeros[de] ? de : '', p2);
    else desenharRotas();
  }
  let largura = 0;
  addEventListener('resize', () => {
    const w = ($('#mapa-caixa') || {}).clientWidth || 0;
    if (!D || !svg || !w || Math.abs(w - largura) < 40 || !location.hash.startsWith('#mapa')) return;
    largura = w;
    if (geo.leve) desenharBase();
  });
  addEventListener('hashchange', abrir);
  document.addEventListener('assinatura', abrir); // o login pode terminar depois de a página abrir
  abrir();
})();
