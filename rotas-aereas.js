/* Planejador de caminhos: voos registrados e rede conferida, sem confundir com assentos disponíveis. */
(() => {
  const normal = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const grupoCia = id => ['LA', 'JJ', 'LP', '4C', 'XL', '4M', 'PZ'].includes(id) ? 'LATAM' : id;
  const distancia = (a, b) => {
    const rad = x => x * Math.PI / 180, p = rad(b.lat - a.lat), l = rad(b.lon - a.lon);
    return 12742 * Math.asin(Math.min(1, Math.sqrt(Math.sin(p / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(l / 2) ** 2)));
  };
  function diasNoMes(t, mes, hoje) {
    const [ano, m] = mes.split('-').map(Number), fim = new Date(Date.UTC(ano, m, 0)).getUTCDate();
    let mascara = 0;
    for (let d = 1; d <= fim; d++) {
      const dia = `${mes}-${String(d).padStart(2, '0')}`, semana = (new Date(Date.UTC(ano, m - 1, d)).getUTCDay() + 6) % 7;
      if (dia >= hoje && t.periodos.some(([a, b, ds]) => dia >= a && dia <= b && (ds & (1 << semana)))) mascara |= 1 << (d - 1);
    }
    return mascara;
  }
  function pesquisar(base, f, hoje = new Date().toISOString().slice(0, 10)) {
    if (!/^\d{4}-\d{2}$/.test(f.mes || '') || !base.aeroportos[f.destino]) return [];
    const A = base.aeroportos, saidas = {}, reverso = {}, prog = base.programas[f.programa];
    for (const t of base.trechos) {
      if (!A[t.de] || !A[t.para] || (f.companhia && grupoCia(t.cia) !== grupoCia(f.companhia)) || (f.alianca && base.companhias[t.cia]?.alianca !== f.alianca) || (prog && !prog.companhias.includes(t.cia))) continue;
      const dias = diasNoMes(t, f.mes, hoje);
      if (!dias) continue;
      const r = { ...t, dias, km: distancia(A[t.de], A[t.para]) };
      (saidas[t.de] ||= []).push(r); (reverso[t.para] ||= new Set()).add(t.de);
    }
    const max = Math.max(1, Math.min(3, Number(f.conexoes ?? 2) + 1)), alcance = { [f.destino]: 0 };
    let fronteira = [f.destino];
    for (let n = 1; n <= max; n++) {
      const proxima = [];
      for (const a of fronteira) for (const o of reverso[a] || []) if (alcance[o] === undefined) { alcance[o] = n; proxima.push(o); }
      fronteira = proxima;
    }
    const origens = Object.keys(A).filter(i => f.origem ? i === f.origem : A[i].br && (!f.uf || A[i].uf === f.uf));
    const encontrados = [], vistos = new Set(); let visitas = 0;
    for (const origem of origens) {
      if (origem === f.destino || alcance[origem] === undefined) continue;
      const limiteKm = distancia(A[origem], A[f.destino]) * 1.8 + 100;
      function andar(atual, trechos, nos, dias, km) {
        if (++visitas > 250000) return;
        for (const r of saidas[atual] || []) {
          const proxDias = dias & r.dias, proxKm = km + r.km;
          if (!proxDias || nos.includes(r.para) || proxKm > limiteKm) continue;
          if (r.para !== f.destino && (alcance[r.para] === undefined || trechos.length + 1 + alcance[r.para] > max)) continue;
          const caminho = [...trechos, r];
          if (r.para === f.destino) {
            const chave = caminho.map(x => `${x.de}-${x.para}-${x.cia}`).join('/');
            if (!vistos.has(chave)) { vistos.add(chave); encontrados.push({ origem, destino: f.destino, trechos: caminho, km: proxKm, dias: proxDias }); }
          } else if (caminho.length < max) andar(r.para, caminho, [...nos, r.para], proxDias, proxKm);
        }
      }
      andar(origem, [], [origem], 0x7fffffff, 0);
    }
    return encontrados.sort((a, b) => a.trechos.length - b.trechos.length || a.km - b.km || a.origem.localeCompare(b.origem)).slice(0, 80);
  }
  globalThis.OAMMLMalha = { pesquisar, diasNoMes, distancia };
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s), esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let base = null, carregando = null, resultados = [], atual = null, mundo = null, fonteSeats = null, seatsPromessa = null;
  const estado = { vista: 'planejar' };
  const nome = i => `${base.aeroportos[i].cidade}${base.aeroportos[i].uf ? ' · ' + base.aeroportos[i].uf : ''} (${i})`;
  function vista(v) {
    estado.vista = v;
    $('#malha-planejar').hidden = v !== 'planejar'; $('#mapa-historico').hidden = v !== 'historico';
    document.querySelectorAll('[data-mapa-vista]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mapaVista === v)));
    if (v === 'historico') document.dispatchEvent(new Event('mapa-historico'));
    else carregar().catch(() => {});
  }
  function erro() {
    $('#malha-resumo').textContent = 'Não foi possível carregar a malha agora. Tente novamente; o histórico de alertas continua disponível na outra aba.';
    $('#malha-tentar').hidden = false;
  }
  function carregar() {
    if (base) return Promise.resolve();
    if (carregando) return carregando;
    carregando = fetch('dados/malha-aerea.json', { cache: 'no-cache' }).then(r => { if (!r.ok) throw Error('malha'); return r.json(); }).then(j => {
      if (j.versao !== 1 || !j.trechos?.length) throw Error('base');
      base = j; montar(); $('#malha-tentar').hidden = true;
    }).catch(e => { erro(); throw e; }).finally(() => { carregando = null; });
    return carregando;
  }
  function montar() {
    const aeroportos = Object.keys(base.aeroportos).sort((a, b) => nome(a).localeCompare(nome(b), 'pt'));
    $('#malha-origens').innerHTML = aeroportos.filter(i => base.aeroportos[i].br).map(i => `<option value="${i}">${esc(nome(i))}</option>`).join('');
    const paises = new Set(aeroportos.map(i => base.aeroportos[i].pais));
    $('#malha-destinos').innerHTML = aeroportos.map(i => `<option value="${i}">${esc(nome(i))} · ${esc(base.aeroportos[i].pais)}</option>`).join('') + [...paises].sort().map(p => `<option value="${esc(p)}">Todos os aeroportos na base deste país</option>`).join('');
    $('#malha-uf').innerHTML = '<option value="">Todos os estados</option>' + [...new Set(aeroportos.filter(i => base.aeroportos[i].br).map(i => base.aeroportos[i].uf).filter(Boolean))].sort().map(u => `<option>${esc(u)}</option>`).join('');
    const nomesCias = Object.fromEntries(base.trechos.map(t => [grupoCia(t.cia), grupoCia(t.cia) === 'LATAM' ? 'LATAM' : base.companhias[t.cia]?.nome || t.cia]));
    $('#malha-cia').innerHTML = '<option value="">Qualquer companhia</option>' + Object.keys(nomesCias).sort((a, b) => nomesCias[a].localeCompare(nomesCias[b], 'pt')).map(c => `<option value="${esc(c)}">${esc(nomesCias[c])}</option>`).join('');
    $('#malha-prog').innerHTML = '<option value="">Qualquer programa</option>' + Object.entries(base.programas).sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'pt')).map(([id, p]) => `<option value="${esc(id)}">${esc(OAMMLProgramas.normalizar(p.nome))}</option>`).join('');
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    $('#malha-mes').value = hoje.slice(0, 7); $('#malha-mes').min = hoje.slice(0, 7);
    $('#malha-atualizada').textContent = `Base conferida em ${base.baseEm.split('-').reverse().join('/')}. Saídas do Brasil e conexões selecionadas no exterior; cobertura em expansão.`;
    if (Date.now() - new Date(base.baseEm + 'T12:00:00Z') > 3 * 864e5) $('#malha-atualizada').textContent += ' A atualização está atrasada; confirme a programação com a companhia.';
    novidades(); $('#malha-resumo').textContent = 'Escolha para onde quer ir. Deixe a origem vazia para descobrir as saídas do Brasil.';
  }
  const aeroportoDe = (texto, soBrasil = false) => {
    const t = normal(texto), iata = texto.trim().toUpperCase();
    if (base.aeroportos[iata] && (!soBrasil || base.aeroportos[iata].br)) return iata;
    const encontrados = Object.keys(base.aeroportos).filter(i => (!soBrasil || base.aeroportos[i].br) && normal(nome(i)) === t);
    return encontrados.length === 1 ? encontrados[0] : '';
  };
  function executar(e) {
    e?.preventDefault(); if (!base) return;
    const origemTxt = $('#malha-origem').value.trim(), origem = aeroportoDe(origemTxt, true), destinoTxt = $('#malha-destino').value.trim(), direto = aeroportoDe(destinoTxt);
    if (origemTxt && !origem) { $('#malha-resumo').textContent = 'Escolha uma origem da lista ou informe o código do aeroporto, como GRU. Para pesquisar por estado, deixe a origem vazia.'; return; }
    const destinos = direto ? [direto] : Object.keys(base.aeroportos).filter(i => normal(base.aeroportos[i].pais) === normal(destinoTxt) || normal(base.aeroportos[i].cidade) === normal(destinoTxt));
    if (!destinoTxt || !destinos.length) { $('#malha-resumo').textContent = 'Escolha uma cidade, país ou aeroporto da lista. Ex.: Seul, ICN ou Tailândia.'; return; }
    const f = { origem, uf: $('#malha-uf').value, mes: $('#malha-mes').value, companhia: $('#malha-cia').value, alianca: $('#malha-alianca').value, programa: $('#malha-prog').value, conexoes: $('#malha-conexoes').value };
    $('#malha-parceiras-nota').textContent = f.programa ? base.programas[f.programa].nota || 'Parceiras conferidas no programa. A possibilidade de resgate depende das regras, da rota e dos assentos liberados.' : 'O filtro usa as parceiras já conferidas; cobertura em expansão. Azul pelo Mundo é um canal de resgate do Azul Fidelidade.';
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    resultados = destinos.flatMap(destino => pesquisar(base, { ...f, destino }, hoje)).sort((a, b) => a.trechos.length - b.trechos.length || a.km - b.km).slice(0, 60);
    atual = null;
    const nOrigens = new Set(resultados.map(r => r.origem)).size;
    $('#malha-resumo').textContent = resultados.length ? `${resultados.length === 60 ? 'Até 60' : resultados.length} ${resultados.length === 1 ? 'caminho' : 'caminhos'} na base para esse período, saindo de ${nOrigens} ${nOrigens === 1 ? 'aeroporto' : 'aeroportos'}. Selecione um para ver o trajeto.` : 'Nenhum caminho encontrado com estes filtros na cobertura atual. Isso não significa que a rota não exista. Tente mais conexões, outro mês ou retire o filtro de programa.';
    $('#malha-mapa-caixa').hidden = true;
    $('#malha-resultados').innerHTML = resultados.map((r, n) => {
      const cias = [...new Set(r.trechos.map(t => base.companhias[t.cia]?.nome || t.cia))], rede = r.trechos.some(t => t.tipo === 'rede');
      const hojeData = hoje, futura = r.trechos.some(t => t.periodos.every(p => p[0] > hojeData));
      return `<li class="malha-card"><div class="malha-card-topo"><span class="malha-selo${futura ? ' futura' : ''}">${futura ? 'Inclui início futuro' : 'Malha consultada'}</span><span>${r.trechos.length === 1 ? 'Sem conexão' : r.trechos.length === 2 ? '1 conexão' : r.trechos.length - 1 + ' conexões'}</span></div><h3>${esc(nome(r.origem))} <span>→</span> ${esc(nome(r.destino))}</h3><p class="malha-via">${r.trechos.length > 1 ? 'Via ' + r.trechos.slice(0, -1).map(t => esc(nome(t.para))).join(' → ') : 'Trecho direto registrado'}</p><p>${esc(cias.join(' + '))}</p><small>${rede ? 'Inclui trecho da rede internacional conferida; horários a confirmar.' : 'Trechos registrados com operação no período escolhido.'}</small>${f.programa ? `<small>Parceiras de ${esc(base.programas[f.programa].nome)}. ${f.programa === 'finnair' && new Set(r.trechos.filter(t => t.cia !== 'AY').map(t => t.cia)).size > 1 ? 'Parceiras diferentes podem exigir emissões separadas. ' : ''}Regras e assentos com milhas precisam de consulta.</small>` : ''}<div class="malha-acoes"><button type="button" class="cta cta-a" data-malha-trajeto="${n}">Ver trajeto no mapa</button><button type="button" class="cta cta-b" data-malha-milhas="${n}">Programas na base de milhas</button></div><div class="malha-seats" id="malha-seats-${n}" hidden aria-live="polite"></div></li>`;
    }).join('');
  }
  function novidades() {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const novos = base.trechos.filter(t => base.aeroportos[t.de].br && !base.aeroportos[t.para].br && t.periodos.every(p => p[0] > hoje)).map(t => ({ ...t, inicio: t.periodos.reduce((a, p) => p[0] < a ? p[0] : a, '9999') })).sort((a, b) => a.inicio.localeCompare(b.inicio));
    $('#malha-novidades').innerHTML = `<h3>Próximos períodos de operação</h3><p>Inclui estreias, retomadas e mudanças de temporada registradas. Um período futuro, sozinho, não significa uma rota inédita.</p><ul>${novos.slice(0, 6).map(t => `<li><b>${esc(t.de)} → ${esc(t.para)}</b><span>${esc(base.companhias[t.cia]?.nome || t.cia)}</span><small>A partir de ${t.inicio.split('-').reverse().join('/')}</small></li>`).join('') || '<li>Nenhum novo período internacional identificado nesta consulta.</li>'}</ul>`;
  }
  async function bibliotecas() {
    for (const [nome, src] of [['d3', 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js'], ['topojson', 'https://cdn.jsdelivr.net/npm/topojson-client@3.1.0/dist/topojson-client.min.js']]) if (!window[nome]) await new Promise((ok, erro) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = erro; document.head.appendChild(s); });
    if (!mundo) { const r = await fetch('https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'); if (!r.ok) throw Error('mapa'); mundo = await r.json(); }
  }
  async function desenhar(r) {
    atual = r; $('#malha-mapa-caixa').hidden = false; $('#malha-mapa-status').textContent = 'Carregando o mapa do trajeto…';
    $('#malha-trechos').textContent = r.trechos.map(t => `${nome(t.de)} → ${nome(t.para)} · ${base.companhias[t.cia]?.nome || t.cia}`).join(' | ');
    try { await bibliotecas(); } catch { $('#malha-mapa-status').textContent = 'O desenho do mapa não carregou. Os trechos detalhados continuam disponíveis abaixo.'; return; }
    if (atual !== r) return;
    const svg = d3.select('#malha-mapa'), largura = 1000, altura = 470, proj = d3.geoNaturalEarth1().fitExtent([[25, 25], [975, 445]], { type: 'Sphere' }), path = d3.geoPath(proj);
    svg.selectAll('*').remove(); svg.attr('viewBox', `0 0 ${largura} ${altura}`);
    svg.append('path').datum({ type: 'Sphere' }).attr('class', 'malha-oceano').attr('d', path);
    svg.append('path').datum(topojson.feature(mundo, mundo.objects.countries)).attr('class', 'malha-terra').attr('d', path);
    const nos = [r.origem, ...r.trechos.map(t => t.para)], xy = i => [base.aeroportos[i].lon, base.aeroportos[i].lat];
    r.trechos.forEach(t => svg.append('path').datum({ type: 'LineString', coordinates: [xy(t.de), xy(t.para)] }).attr('class', 'malha-linha' + (t.periodos.every(p => p[0] > new Date().toISOString().slice(0, 10)) ? ' futura' : '')).attr('d', path));
    const marcados = [];
    nos.forEach((i, n) => {
      const [x, y] = proj(xy(i)), perto = marcados.some(p => Math.abs(x - p[0]) < 55 && Math.abs(y - p[1]) < 24);
      marcados.push([x, y]); svg.append('circle').attr('cx', x).attr('cy', y).attr('r', 5).attr('class', 'malha-ponto');
      svg.append('text').attr('x', x).attr('y', y + (perto ? 22 : -12)).attr('text-anchor', 'middle').attr('class', 'malha-rotulo').text(i);
    });
    $('#malha-mapa-status').textContent = nos.map(i => nome(i)).join(' → ');
    $('#malha-trechos').innerHTML = '<ol>' + r.trechos.map(t => `<li><b>${esc(nome(t.de))} → ${esc(nome(t.para))}</b><span>${esc(base.companhias[t.cia]?.nome || t.cia)}${base.companhias[t.cia]?.alianca ? ' · ' + esc(base.companhias[t.cia].alianca) : ''}</span><small>${t.tipo === 'rede' ? 'Rede internacional conferida' : 'Operação registrada'} · conferido em ${t.verificadoEm.split('-').reverse().join('/')}</small></li>`).join('') + '</ol><p>São caminhos para planejar a viagem. Horários de conexão, emissão no mesmo bilhete, regras de trânsito e disponibilidade precisam ser conferidos antes de reservar.</p>';
    $('#malha-mapa-caixa').scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  async function programasMilhas(n, botao) {
    const el = $(`#malha-seats-${n}`), r = resultados[n]; if (!r) return;
    el.hidden = false; el.textContent = 'Consultando a base de rotas com milhas…'; botao.disabled = true;
    try {
      if (!fonteSeats) {
        seatsPromessa ||= (async () => { const resp = await fetch('https://oamml-assinatura.ondeasmilhasmelevam.workers.dev/grafo', { headers: { authorization: `Bearer ${await window.oammlToken()}` } }); if (!resp.ok) throw Error('seats'); return resp.json(); })().catch(e => { seatsPromessa = null; throw e; });
        fonteSeats = await seatsPromessa;
      }
      const idx = new Map(fonteSeats.a.map((a, i) => [a[0], i])), oi = idx.get(r.origem), di = idx.get(r.destino), par = fonteSeats.e.find(([a, b]) => a === oi && b === di);
      const progs = par ? [...new Set(fonteSeats.fontes.filter((f, b) => par[2] & (1 << b)).map(f => OAMMLProgramas.normalizar(f[1])))] : [];
      el.textContent = progs.length ? 'Rota encontrada na base de milhas: ' + progs.join(' · ') + '. Esse registro pode ter outro trajeto ou companhia. Não confirma assentos nem a emissão do caminho desenhado.' : 'Não encontramos o par de aeroportos na base de milhas consultada. Isso não exclui outros programas ou disponibilidade no site da companhia.';
      const link = document.createElement('a'); link.className = 'cta cta-b'; link.textContent = 'Buscar alertas desta rota'; link.href = window.oammlNavegacao.url('passagens', { origem: r.origem, destino: r.destino }); el.appendChild(link);
    } catch { el.textContent = 'Não foi possível consultar a base de milhas agora. Tente novamente; os caminhos da malha aérea permanecem disponíveis.'; }
    finally { botao.disabled = false; }
  }
  document.querySelectorAll('[data-mapa-vista]').forEach(b => b.addEventListener('click', () => vista(b.dataset.mapaVista)));
  $('#malha-form').addEventListener('submit', executar);
  $('#malha-tentar').addEventListener('click', () => carregar().catch(() => {}));
  $('#malha-resultados').addEventListener('click', e => { const m = e.target.closest('[data-malha-milhas]'), t = e.target.closest('[data-malha-trajeto]'); if (m) programasMilhas(+m.dataset.malhaMilhas, m); if (t && resultados[+t.dataset.malhaTrajeto]) desenhar(resultados[+t.dataset.malhaTrajeto]); });
  function abrir() {
    if (!location.hash.startsWith('#mapa') || !window.oammlPodeVerMapa?.()) return;
    if (/^#mapa\/[A-Z]{3}/.test(location.hash)) vista('historico'); else if (estado.vista === 'planejar') carregar().catch(() => {});
  }
  addEventListener('hashchange', abrir); document.addEventListener('assinatura', abrir); abrir();
})();
