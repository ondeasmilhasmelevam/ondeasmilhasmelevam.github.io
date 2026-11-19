/* Planejador de caminhos: voos registrados e rede conferida, sem confundir com assentos disponíveis. */
(() => {
  const normal = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const PAISES = { 'estados unidos da america': 'Estados Unidos', 'estados unidos': 'Estados Unidos', eua: 'Estados Unidos', usa: 'Estados Unidos', 'united states': 'Estados Unidos', 'united states of america': 'Estados Unidos', 'reino unido': 'Reino Unido', uk: 'Reino Unido', 'united kingdom': 'Reino Unido', holanda: 'Países Baixos', 'paises baixos': 'Países Baixos', netherlands: 'Países Baixos', qatar: 'Catar', catar: 'Catar', 'coreia do sul': 'Coreia do Sul', 'south korea': 'Coreia do Sul', cingapura: 'Singapura', singapura: 'Singapura', singapore: 'Singapura', 'africa do sul': 'África do Sul', 'new zealand': 'Nova Zelândia', 'nova zelandia': 'Nova Zelândia', australia: 'Austrália', japan: 'Japão', japao: 'Japão', brasil: 'Brasil', brazil: 'Brasil' };
  const paisNome = t => PAISES[normal(t)] || String(t || '').trim();
  const CIDADES = { 'new york': 'nova york', 'nova iorque': 'nova york', nyc: 'nova york', seoul: 'seul', tokyo: 'toquio', london: 'londres', bangcoc: 'bangkok', banguecoque: 'bangkok', amsterdam: 'amsterda' };
  function resolverLocais(base, texto) {
    const bruto = String(texto || '').trim(), t = normal(bruto), A = base.aeroportos;
    if (!t) return [];
    if (!PAISES[t] && A[bruto.toUpperCase()]) return [bruto.toUpperCase()];
    const codigo = /\(([A-Z]{3})\)$/.exec(bruto.toUpperCase());
    if (codigo && A[codigo[1]]) return [codigo[1]];
    const pais = normal(paisNome(bruto)), cidade = CIDADES[t] || t;
    const paises = Object.keys(A).filter(i => normal(paisNome(A[i].pais)) === pais);
    if (paises.length) return paises;
    // Bali/Denpasar, nomes dos aeroportos e cidades com pontuação diferente.
    const termos = cidade.split(' ').filter(Boolean);
    return Object.keys(A).filter(i => (CIDADES[normal(A[i].cidade)] || normal(A[i].cidade)) === cidade || (cidade.length >= 3 && termos.every(t => normal(`${CIDADES[normal(A[i].cidade)] || A[i].cidade} ${A[i].nome || ''}`).split(' ').includes(t))));
  }
  function paresMilhas(grafo, origens, destinos, programa = '') {
    const O = new Set(origens), D = new Set(destinos), progs = grafo.fontes.map(f => OAMMLProgramas.normalizar(f[1]));
    let mascara = -1;
    if (programa) mascara = progs.reduce((m, n, b) => OAMMLProgramas.buscar(n)?.id === programa || grafo.fontes[b][0] === programa ? m | (1 << b) : m, 0);
    return grafo.e.flatMap(([oi, di, m]) => {
      const de = grafo.a[oi]?.[0], para = grafo.a[di]?.[0], usados = m & mascara;
      return usados && O.has(de) && D.has(para) && de !== para ? [{ de, para, programas: [...new Set(progs.filter((_, b) => usados & (1 << b)))] }] : [];
    });
  }
  // Uma aresta representa uma pesquisa vendida por um programa, não um voo
  // sem escala. Percorre toda a rede, em páginas, sem inventar a volta.
  function* caminhosMilhas(grafo, origens, destinos, programa = '') {
    const fontes = grafo.fontes.map(f => OAMMLProgramas.normalizar(f[1])), D = new Set(destinos);
    const mascara = programa ? fontes.reduce((m, n, b) => OAMMLProgramas.buscar(n)?.id === programa || grafo.fontes[b][0] === programa ? m | (1 << b) : m, 0) : -1;
    const saidas = {}, reverso = {};
    for (const [oi, di, m] of grafo.e) {
      const de = grafo.a[oi]?.[0], para = grafo.a[di]?.[0], bits = m & mascara;
      if (!de || !para || de === para || !bits) continue;
      (saidas[de] ||= []).push({ de, para, programas: [...new Set(fontes.filter((_, b) => bits & (1 << b)))] });
      (reverso[para] ||= new Set()).add(de);
    }
    const alcance = Object.fromEntries(destinos.map(i => [i, 0])); let fronteira = destinos;
    for (let n = 1; n <= 3; n++) {
      const proxima = [];
      for (const d of fronteira) for (const o of reverso[d] || []) if (alcance[o] === undefined) { alcance[o] = n; proxima.push(o); }
      fronteira = proxima;
    }
    function* andar(atual, passos, nos, tamanho) {
      for (const par of saidas[atual] || []) {
        if (nos.includes(par.para)) continue;
        const caminho = [...passos, par];
        if (caminho.length === tamanho) { if (D.has(par.para)) yield caminho; }
        else if (!D.has(par.para) && alcance[par.para] !== undefined && caminho.length + alcance[par.para] <= tamanho) yield* andar(par.para, caminho, [...nos, par.para], tamanho);
      }
    }
    // Primeiro os pares completos; depois pontos para dividir em 2 ou 3 pesquisas.
    for (let n = 1; n <= 3; n++) for (const o of origens) if (alcance[o] !== undefined && alcance[o] <= n) yield* andar(o, [], [o], n);
  }
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
  function prepararBusca(base, f, hoje) {
    const A = base.aeroportos, saidas = {}, reverso = {}, prog = base.programas[f.programa];
    for (const t of base.trechos) {
      if (!A[t.de] || !A[t.para] || (f.companhia && grupoCia(t.cia) !== grupoCia(f.companhia)) || (f.alianca && base.companhias[t.cia]?.alianca !== f.alianca) || (prog && !prog.companhias.includes(t.cia))) continue;
      // No modo de planejamento, preserva apenas trechos ainda presentes na base atual.
      // A máscara não representa dias de operação e nunca é exibida como calendário.
      const dias = f.conhecidos ? (t.periodos.some(p => p[1] >= hoje) ? 0x7fffffff : 0) : diasNoMes(t, f.mes, hoje);
      if (!dias) continue;
      const r = { ...t, dias, km: distancia(A[t.de], A[t.para]) };
      (saidas[t.de] ||= []).push(r); (reverso[t.para] ||= new Set()).add(t.de);
    }
    return { saidas, reverso };
  }
  function pesquisar(base, f, hoje = new Date().toISOString().slice(0, 10), preparada) {
    if (!/^\d{4}-\d{2}$/.test(f.mes || '') || !base.aeroportos[f.destino]) return [];
    const A = base.aeroportos, { saidas, reverso } = preparada || prepararBusca(base, f, hoje);
    const max = Math.max(1, Math.min(4, Number(f.conexoes ?? 2) + 1)), alcance = { [f.destino]: 0 };
    let fronteira = [f.destino];
    for (let n = 1; n <= max; n++) {
      const proxima = [];
      for (const a of fronteira) for (const o of reverso[a] || []) if (alcance[o] === undefined) { alcance[o] = n; proxima.push(o); }
      fronteira = proxima;
    }
    const selecionadas = f.origens ? new Set(f.origens) : null;
    const origens = Object.keys(A).filter(i => selecionadas ? selecionadas.has(i) : f.origem ? i === f.origem : A[i].br && (!f.uf || A[i].uf === f.uf));
    const encontrados = [], vistos = new Set(); let visitas = 0;
    for (const origem of origens) {
      if (origem === f.destino || alcance[origem] === undefined) continue;
      // Brasil–Oceania via Oriente Médio pode superar 2x a distância direta.
      // Distância ordena os resultados; não deve excluir esses caminhos reais.
      const limiteKm = distancia(A[origem], A[f.destino]) * 2.6 + 100;
      function andar(atual, trechos, nos, dias, km) {
        if (++visitas > 250000) return;
        for (const r of saidas[atual] || []) {
          const proxDias = dias & r.dias, proxKm = km + r.km;
          if (!proxDias || nos.includes(r.para) || proxKm > limiteKm) continue;
          if (r.para !== f.destino && (alcance[r.para] === undefined || trechos.length + 1 + alcance[r.para] > max)) continue;
          const caminho = [...trechos, r];
          if (r.para === f.destino) {
            const chave = caminho.map(x => `${x.de}-${x.para}-${grupoCia(x.cia)}`).join('/');
            if (!vistos.has(chave)) { vistos.add(chave); encontrados.push({ origem, destino: f.destino, trechos: caminho, km: proxKm, dias: f.conhecidos ? null : proxDias, confirmacaoPendente: !!f.conhecidos }); }
          } else if (caminho.length < max) andar(r.para, caminho, [...nos, r.para], proxDias, proxKm);
        }
      }
      andar(origem, [], [origem], 0x7fffffff, 0);
    }
    return encontrados.sort((a, b) => a.trechos.length - b.trechos.length || a.km - b.km || a.origem.localeCompare(b.origem)).slice(0, 80);
  }
  globalThis.OAMMLMalha = { pesquisar, diasNoMes, distancia, resolverLocais, paresMilhas, caminhosMilhas, paisNome };
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s), esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!$('#malha-cadastro') || !$('#malha-global-resultados') || !$('#malha-trocar') || !$('#malha-rede-status')) {
    if ($('#malha-resumo')) $('#malha-resumo').textContent = 'O mapa recebeu uma atualização. Atualize a página ou reabra o app para carregar a busca mundial.';
    return;
  }
  let base = null, carregando = null, resultados = [], atual = null, mundo = null, fonteSeats = null, seatsPromessa = null;
  let redeIterador = null, redeCaminhos = [], catalogoLista = [], catalogoExibidos = 0;
  const estado = { vista: 'planejar' }; let buscaAtual = 0;
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
    carregando = Promise.all(['dados/malha-aerea.json', 'dados/aeroportos-mundiais.json'].map(u => fetch(u, { cache: 'no-cache' }).then(r => { if (!r.ok) throw Error('cadastro'); return r.json(); }))).then(([j, cadastro]) => {
      if (j.versao !== 1 || !j.trechos?.length) throw Error('base');
      if (cadastro.versao !== 1 || !cadastro.aeroportos || Object.keys(cadastro.aeroportos).length < 5000) throw Error('cadastro');
      const paises = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
      for (const [i, a] of Object.entries(cadastro.aeroportos)) {
        if (!/^[A-Z]{3}$/.test(i) || !Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
        let pais = a.pais;
        try { if (/^[A-Z]{2}$/.test(a.iso)) pais = paises.of(a.iso) || pais; } catch { /* preserva a fonte */ }
        j.aeroportos[i] = { ...a, ...j.aeroportos[i], pais: pais || 'País não informado' };
      }
      base = j; montar(); $('#malha-tentar').hidden = true;
      carregarRede().then(() => {
        // Os números de cobertura são atualizados por carregarRede().
      }).catch(() => { $('#malha-rede-status').textContent = `${Object.keys(base.aeroportos).length.toLocaleString('pt-BR')} aeroportos no cadastro mundial. A rede de programas não respondeu agora; tente novamente ao pesquisar.`; });
    }).catch(e => { erro(); throw e; }).finally(() => { carregando = null; });
    return carregando;
  }
  function montarProgramas() {
    const selecionado = $('#malha-prog').value;
    $('#malha-prog').innerHTML = '<option value="">Qualquer programa</option>' + Object.entries(base.programas).sort((a, b) => a[1].nome.localeCompare(b[1].nome, 'pt')).map(([id, p]) => `<option value="${esc(id)}">${esc(OAMMLProgramas.normalizar(p.nome))}</option>`).join('');
    $('#malha-prog').value = selecionado;
  }
  function montarLocais() {
    const paises = [...new Set(Object.values(base.aeroportos).map(a => paisNome(a.pais)))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'pt'));
    for (const [campo, lista] of [['#malha-origem', '#malha-origens'], ['#malha-destino', '#malha-destinos']]) {
      const t = normal($(campo).value), p = normal(paisNome($(campo).value)), termos = t.split(' ').filter(Boolean);
      const itens = Object.keys(base.aeroportos).filter(i => termos.every(t => normal(`${nome(i)} ${base.aeroportos[i].nome || ''} ${paisNome(base.aeroportos[i].pais)}`).includes(t))).sort((a, b) => nome(a).localeCompare(nome(b), 'pt')).slice(0, 100);
      $(lista).innerHTML = paises.filter(n => !t || normal(n).includes(t) || normal(n) === p).map(n => `<option value="${esc(n)}">País · aeroportos presentes na base</option>`).join('') + itens.map(i => `<option value="${esc(nome(i))}">${esc(paisNome(base.aeroportos[i].pais))} · ${i}</option>`).join('');
    }
  }
  function montar() {
    const aeroportos = Object.keys(base.aeroportos).sort((a, b) => nome(a).localeCompare(nome(b), 'pt'));
    montarLocais();
    $('#malha-uf').innerHTML = '<option value="">Todos os estados</option>' + [...new Set(aeroportos.filter(i => base.aeroportos[i].br).map(i => base.aeroportos[i].uf).filter(Boolean))].sort().map(u => `<option>${esc(u)}</option>`).join('');
    const nomesCias = Object.fromEntries(base.trechos.map(t => [grupoCia(t.cia), grupoCia(t.cia) === 'LATAM' ? 'LATAM' : base.companhias[t.cia]?.nome || t.cia]));
    $('#malha-cia').innerHTML = '<option value="">Qualquer companhia</option>' + Object.keys(nomesCias).sort((a, b) => nomesCias[a].localeCompare(nomesCias[b], 'pt')).map(c => `<option value="${esc(c)}">${esc(nomesCias[c])}</option>`).join('');
    montarProgramas();
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    $('#malha-mes').value = hoje.slice(0, 7); $('#malha-mes').min = hoje.slice(0, 7);
    $('#malha-atualizada').textContent = `Malha operacional conferida em ${base.baseEm.split('-').reverse().join('/')}. A cobertura de voos operados é parcial; a rede mundial de milhas amplia as possibilidades de pesquisa.`;
    if (Date.now() - new Date(base.baseEm + 'T12:00:00Z') > 3 * 864e5) $('#malha-atualizada').textContent += ' A atualização está atrasada; confirme a programação com a companhia.';
    novidades(); $('#malha-resumo').textContent = 'Escolha origem e destino por país, cidade ou aeroporto, em qualquer região. Origem vazia usa o Brasil como padrão.';
  }
  function carregarRede() {
    if (fonteSeats) return Promise.resolve(fonteSeats);
    if (!seatsPromessa) seatsPromessa = (async () => {
      const resp = await fetch('https://oamml-assinatura.ondeasmilhasmelevam.workers.dev/grafo', { headers: { authorization: `Bearer ${await window.oammlToken()}` } });
      if (!resp.ok) throw Error('rede');
      const j = await resp.json();
      if (!Array.isArray(j.a) || !Array.isArray(j.e) || !Array.isArray(j.fontes)) throw Error('formato');
      const nomesPaises = new Intl.DisplayNames(['pt-BR'], { type: 'region' });
      for (const [i, lat, lon, iso, cidade] of j.a) {
        if (base.aeroportos[i] || !/^[A-Z]{3}$/.test(i) || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        let pais = 'País não informado';
        try { if (/^[A-Z]{2}$/.test(iso)) pais = nomesPaises.of(iso) || iso; } catch { /* mantém localização sem atribuir país errado */ }
        base.aeroportos[i] = { cidade: cidade || i, lat, lon, pais, br: iso === 'BR', uf: '' };
      }
      for (const [fonte, n] of j.fontes) {
        const nome = OAMMLProgramas.normalizar(n), id = OAMMLProgramas.buscar(nome)?.id || fonte;
        if (!base.programas[id]) base.programas[id] = { nome, companhias: [], somenteRede: true, nota: 'Programa presente na rede mundial de milhas. A lista de operadoras elegíveis ainda não foi conferida nesta malha operacional.' };
      }
      fonteSeats = j; montarLocais(); montarProgramas(); $('#malha-rede-status').textContent = `${Object.keys(base.aeroportos).length.toLocaleString('pt-BR')} aeroportos no cadastro mundial · ${j.a.length.toLocaleString('pt-BR')} na rede de milhas · ${j.e.length.toLocaleString('pt-BR')} pares de viagem · ${j.fontes.length} programas. Aeroporto cadastrado não significa voo ou assento disponível.${Object.values(j.coletas || {}).some(c => c.status !== 'atualizado') ? ' Alguns programas usam a última coleta preservada ou estão sem resposta; a cobertura está indicada nas opções.' : ''}`; return j;
    })().catch(e => { seatsPromessa = null; throw e; });
    return seatsPromessa;
  }
  function abrirDisponibilidade(de, para) {
    const mes = $('#malha-mes').value, hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    window.oammlNavegacao.ir('passagens', { origem: de, destino: para });
    $('#seats-origem').value = de; $('#seats-destino').value = para;
    const [a, m] = mes.split('-').map(Number);
    $('#seats-de').value = `${mes}-01` < hoje ? hoje : `${mes}-01`;
    $('#seats-ate').value = `${mes}-${String(new Date(Date.UTC(a, m, 0)).getUTCDate()).padStart(2, '0')}`;
    $('#seats').open = true; $('#seats').scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  function mostrarRedeGlobal(origens, destinos, f) {
    const el = $('#malha-global-resultados'); redeCaminhos = []; redeIterador = null;
    const completa = origens.length === 1 && destinos.length === 1 ? `<div class="malha-card malha-completa"><h3>Consultar a viagem completa</h3><p>${esc(nome(origens[0]))} → ${esc(nome(destinos[0]))}</p><p>Procure os itinerários observados no mês escolhido e veja os voos e conexões de cada resultado. A consulta considera os programas com cobertura na fonte.</p><button type="button" class="cta cta-a" data-rede-completa="${origens[0]}-${destinos[0]}">Consultar voos da viagem completa</button><div class="malha-voos" id="malha-viagem-completa" aria-live="polite"></div></div>` : '<p>Para consultar os voos de uma viagem completa, escolha um aeroporto específico de origem e destino. A lista de aeroportos reconhecidos acima permite refinar a escolha.</p>';
    if (!fonteSeats) { el.innerHTML = completa + '<h3>Rede mundial de programas</h3><p>A rede não respondeu agora. O cadastro de aeroportos continua disponível. Tente novamente em instantes.</p>'; return; }
    if (f.companhia || f.alianca) { el.innerHTML = completa + '<h3>Rede mundial de programas</h3><p>Retire os filtros de companhia e aliança para explorar os programas nesta rede. Ela não informa quem opera cada voo; os itinerários disponíveis trazem os voos e conexões.</p>'; return; }
    redeIterador = caminhosMilhas(fonteSeats, origens, destinos, f.programa);
    el.innerHTML = completa + '<h3>Opções na rede mundial de milhas</h3><p>Primeiro aparecem os pares completos encontrados nos programas; depois, opções para dividir a viagem em até três pesquisas. Cada pesquisa pode conter conexões. Dividir a viagem pode exigir bilhetes separados, nova retirada de bagagem e mais tempo de intervalo. Não confirma operação ou assentos no mês escolhido.</p><p>Use “Consultar voos e conexões” para conferir os itinerários observados no período. Use “Mostrar mais opções” para continuar explorando a rede.</p><ul class="malha-resultados" id="malha-rede-lista"></ul><p id="malha-rede-contagem" role="status"></p><button type="button" class="cta cta-b" data-rede-mais>Mostrar mais opções</button>';
    maisRede();
  }
  function maisRede() {
    if (!redeIterador) return;
    const html = []; let acabou = false;
    for (let i = 0; i < 24; i++) {
      const item = redeIterador.next(); if (item.done) { acabou = true; break; }
      const caminho = item.value, n = redeCaminhos.length; redeCaminhos.push(caminho);
      html.push(`<li class="malha-card"><div class="malha-card-topo"><span class="malha-selo">${caminho.length === 1 ? 'Par completo na rede' : 'Dividir em ' + caminho.length + ' pesquisas'}</span></div><h3>${esc(nome(caminho[0].de))} → ${esc(nome(caminho.at(-1).para))}</h3>${caminho.length > 1 ? '<p class="malha-via">Pontos para dividir: ' + caminho.slice(0, -1).map(p => esc(nome(p.para))).join(' → ') + '</p>' : ''}${caminho.map((p, k) => `<div class="malha-pesquisa"><p><b>${esc(p.de)} → ${esc(p.para)}</b> · ${esc(p.programas.join(' · '))}</p><button type="button" class="cta cta-b" data-rede-consulta="${n}" data-rede-par="${k}">Consultar voos e conexões</button><button type="button" class="cta cta-b" data-global-de="${esc(p.de)}" data-global-para="${esc(p.para)}">Abrir busca de disponibilidade</button><div class="malha-voos" id="malha-voos-${n}-${k}" aria-live="polite"></div></div>`).join('')}</li>`);
    }
    $('#malha-rede-lista').insertAdjacentHTML('beforeend', html.join(''));
    $('#malha-rede-contagem').textContent = redeCaminhos.length ? `${redeCaminhos.length} opções exibidas${acabou ? ' · fim dos caminhos encontrados nesta rede, em até três pesquisas.' : ' · há mais páginas para explorar.'}` : 'Não há caminho para estes aeroportos na cobertura atual dos programas consultados. O cadastro do aeroporto e a cobertura de rotas são coisas diferentes.';
    $('[data-rede-mais]').hidden = acabou;
    if (redeCaminhos.length && !resultados.length) $('#malha-resumo').textContent = 'Há opções para pesquisar esta viagem na rede de milhas abaixo. A base operacional ainda não reúne os trechos para desenhar o trajeto; consulte os voos para conferir as conexões.';
  }
  function mostrarCadastro(origens, destinos) {
    const rede = new Set((fonteSeats?.a || []).map(a => a[0]));
    catalogoLista = [...new Set([...origens, ...destinos])].sort((a, b) => nome(a).localeCompare(nome(b), 'pt'));
    catalogoExibidos = 0;
    $('#malha-cadastro').innerHTML = `<details><summary>${origens.length} ${origens.length === 1 ? 'aeroporto' : 'aeroportos'} de origem e ${destinos.length} de destino reconhecidos · ver cadastro</summary><p>Todos os aeroportos reconhecidos nesta consulta estão nesta lista, inclusive os que não têm rotas nas fontes conectadas. Clique para escolher um aeroporto específico.</p><ul class="malha-aeroportos" id="malha-cadastro-lista"></ul><button type="button" class="cta cta-b" data-cadastro-mais>Mostrar mais aeroportos</button></details>`;
    maisCadastro(rede);
  }
  function maisCadastro(rede = new Set((fonteSeats?.a || []).map(a => a[0]))) {
    const fim = Math.min(catalogoExibidos + 40, catalogoLista.length);
    const html = catalogoLista.slice(catalogoExibidos, fim).map(i => `<li><b>${esc(nome(i))}</b><small>${esc(paisNome(base.aeroportos[i].pais))} · ${rede.has(i) ? 'Presente na rede de milhas' : 'Sem cobertura de milhas nesta fonte'}</small><div><button type="button" data-cadastro-origem="${i}">Usar como origem</button><button type="button" data-cadastro-destino="${i}">Usar como destino</button></div></li>`).join('');
    $('#malha-cadastro-lista').insertAdjacentHTML('beforeend', html); catalogoExibidos = fim;
    $('[data-cadastro-mais]').hidden = fim === catalogoLista.length;
  }
  async function consultarVoos(botao, proxima) {
    const n = +botao.dataset.redeConsulta, k = +botao.dataset.redePar, completa = botao.dataset.redeCompleta?.split('-');
    const par = completa ? { de: completa[0], para: completa[1] } : redeCaminhos[n]?.[k]; if (!par) return;
    const el = completa ? $('#malha-viagem-completa') : $(`#malha-voos-${n}-${k}`), mes = $('#malha-mes').value;
    if (el.dataset.consultando) return;
    const [ano, m] = mes.split('-').map(Number), hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const de = `${mes}-01` < hoje ? hoje : `${mes}-01`, ate = `${mes}-${String(new Date(Date.UTC(ano, m, 0)).getUTCDate()).padStart(2, '0')}`;
    if (de > ate) { el.textContent = 'Escolha um mês atual ou futuro para consultar disponibilidade.'; return; }
    el.dataset.consultando = '1'; botao.disabled = true; if (!proxima) el.textContent = 'Consultando voos observados e programas no período…';
    try {
      const q = new URLSearchParams({ origem: par.de, destino: par.para, de, ate });
      if (proxima) { q.set('skip', proxima.skip); q.set('cursor', proxima.cursor); }
      const resp = await fetch(`https://oamml-assinatura.ondeasmilhasmelevam.workers.dev/voos?${q}`, { headers: { authorization: `Bearer ${await window.oammlToken()}` } });
      const j = await resp.json(); if (!resp.ok) throw Error(j.erro || 'A consulta não respondeu agora.');
      if (!el.isConnected) return;
      if (!proxima) el.innerHTML = '<p>Resultados observados na fonte para este mês; confirme no programa antes de emitir. Clique em um resultado para ver os voos e as conexões.</p><ul class="malha-datas"></ul>';
      const selecionado = $('#malha-prog').value, voos = (j.voos || []).filter(v => !selecionado || (OAMMLProgramas.buscar(v.programa)?.id || v.programa) === selecionado), lista = el.querySelector('ul');
      lista.insertAdjacentHTML('beforeend', voos.map(v => `<li><b>${esc(String(v.data || '').split('-').reverse().join('/'))} · ${esc(OAMMLProgramas.normalizar(v.programa))}</b><small>${esc(Object.entries(v.cabines || {}).map(([c, d]) => `${({eco:'Econômica',premium:'Premium',exe:'Executiva',primeira:'Primeira'})[c] || c}: ${d.milhas ? d.milhas.toLocaleString('pt-BR') + ' milhas' : 'valor a conferir'}`).join(' · '))}</small>${v.id ? `<button type="button" class="cta cta-b" data-viagem-id="${esc(v.id)}" data-viagem-de="${par.de}" data-viagem-para="${par.para}">Ver voos e conexões deste resultado</button><div class="malha-detalhes-voo"></div>` : '<small>A fonte não forneceu os detalhes dos voos deste resultado.</small>'}</li>`).join(''));
      el.querySelector('[data-voos-mais]')?.remove();
      if (!voos.length && !proxima) lista.innerHTML = '<li>Nenhum assento encontrado na cobertura consultada para este mês. Isso não elimina a possibilidade de voo pago ou emissão por outras fontes.</li>';
      if (j.proxima) { const b = document.createElement('button'); b.type = 'button'; b.className = 'cta cta-b'; b.textContent = 'Mais datas e resultados'; b.dataset.voosMais = '1'; b.addEventListener('click', () => consultarVoos(botao, j.proxima)); el.appendChild(b); }
    } catch (e) { if (el.isConnected) { const p = document.createElement('p'); p.textContent = e.message; el.appendChild(p); } }
    finally { botao.disabled = false; delete el.dataset.consultando; }
  }
  async function consultarTrajetos(botao) {
    const el = botao.nextElementSibling; botao.disabled = true; el.textContent = 'Conferindo os segmentos do itinerário…';
    try {
      const resp = await fetch(`https://oamml-assinatura.ondeasmilhasmelevam.workers.dev/voos/trajetos?id=${encodeURIComponent(botao.dataset.viagemId)}`, { headers: { authorization: `Bearer ${await window.oammlToken()}` } });
      const j = await resp.json(); if (!resp.ok) throw Error(j.erro || 'Não foi possível carregar as conexões.');
      if (!el.isConnected) return;
      const viagens = (j.viagens || []).filter(v => v.trechos?.[0]?.de === botao.dataset.viagemDe && v.trechos.at(-1)?.para === botao.dataset.viagemPara);
      el.innerHTML = viagens.length ? viagens.map((v, n) => `<div class="malha-itinerario"><b>${esc(v.cabine)} · ${v.milhas ? Number(v.milhas).toLocaleString('pt-BR') + ' milhas' : 'Valor a confirmar'}</b><ol>${v.trechos.map(t => `<li><b>${esc(nomeOuCodigo(t.de))} → ${esc(nomeOuCodigo(t.para))}</b><small>Voo ${esc(t.voo)} · partida ${esc(String(t.partida).replace('T', ' ').replace(/Z$/, ''))} · chegada ${esc(String(t.chegada).replace('T', ' ').replace(/Z$/, ''))} (horários locais)</small></li>`).join('')}</ol><small>Itinerário observado; operação e disponibilidade podem mudar.</small>${v.trechos.every(t => base.aeroportos[t.de] && base.aeroportos[t.para]) ? `<button type="button" class="cta cta-b" data-itinerario="${n}">Ver este itinerário no mapa</button>` : ''}</div>`).join('') : '<p>A fonte não forneceu os segmentos deste resultado. Não vamos deduzir conexões a partir do par de aeroportos.</p>';
      el.querySelectorAll('[data-itinerario]').forEach(b => b.addEventListener('click', () => {
        const v = viagens[+b.dataset.itinerario];
        desenhar({ origem: v.trechos[0].de, destino: v.trechos.at(-1).para, observado: true, trechos: v.trechos.map(t => ({ ...t, cia: String(t.voo).slice(0, 2), tipo: 'observado', verificadoEm: (v.atualizado || hojeLocal()).slice(0, 10), periodos: [] })) });
      }));
    } catch (e) { el.textContent = e.message; } finally { botao.disabled = false; }
  }
  const hojeLocal = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const nomeOuCodigo = i => base.aeroportos[i] ? nome(i) : i;
  async function executar(e) {
    e?.preventDefault(); if (!base) return;
    const busca = ++buscaAtual;
    resultados = []; atual = null;
    $('#malha-resultados').innerHTML = ''; $('#malha-global-resultados').innerHTML = ''; $('#malha-cadastro').innerHTML = ''; $('#malha-mapa-caixa').hidden = true;
    $('#malha-resumo').textContent = 'Conferindo origem e destino…';
    try { await carregarRede(); if (busca !== buscaAtual) return; } catch { /* a malha operacional segue disponível */ }
    const origemTxt = $('#malha-origem').value.trim(), destinoTxt = $('#malha-destino').value.trim();
    let origens = origemTxt ? resolverLocais(base, origemTxt) : Object.keys(base.aeroportos).filter(i => base.aeroportos[i].br);
    if (normal(paisNome(origemTxt || 'Brasil')) === 'brasil' && $('#malha-uf').value) origens = origens.filter(i => base.aeroportos[i].uf === $('#malha-uf').value);
    const destinos = resolverLocais(base, destinoTxt);
    mostrarCadastro(origens, destinos);
    if (!origens.length || !destinos.length) { $('#malha-resumo').textContent = 'Não reconhecemos uma das localidades no cadastro carregado. Informe país, cidade ou código de aeroporto. Isso não significa que não exista voo para esse lugar.'; return; }
    const f = { origens, uf: $('#malha-uf').value, mes: $('#malha-mes').value, companhia: $('#malha-cia').value, alianca: $('#malha-alianca').value, programa: $('#malha-prog').value, conexoes: $('#malha-conexoes').value };
    $('#malha-parceiras-nota').textContent = f.programa ? base.programas[f.programa].nota || 'Parceiras conferidas no programa. A possibilidade de resgate depende das regras, da rota e dos assentos liberados.' : 'O filtro usa as parceiras já conferidas; cobertura em expansão. Azul pelo Mundo é um canal de resgate do Azul Fidelidade.';
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    let encontrados = [];
    async function buscarCaminhos(filtros) {
      const preparada = prepararBusca(base, filtros, hoje), caminhos = [];
    for (let i = 0; i < destinos.length; i++) {
      caminhos.push(...pesquisar(base, { ...filtros, destino: destinos[i] }, hoje, preparada));
      // Devolve o controle à tela em buscas amplas, inclusive no celular.
      if (i % 8 === 7) { await new Promise(resolve => setTimeout(resolve, 0)); if (busca !== buscaAtual) return; }
    }
      return caminhos;
    }
    encontrados = await buscarCaminhos(f);
    if (busca !== buscaAtual || !encontrados) return;
    if (!encontrados.length) encontrados = await buscarCaminhos({ ...f, conhecidos: true });
    if (busca !== buscaAtual || !encontrados) return;
    resultados = encontrados.sort((a, b) => a.trechos.length - b.trechos.length || a.km - b.km).slice(0, 60);
    atual = null;
    const nOrigens = new Set(resultados.map(r => r.origem)).size;
    $('#malha-resumo').textContent = resultados[0]?.confirmacaoPendente ? 'Encontramos caminhos conhecidos, mas a base ainda não confirma todos os trechos no mês escolhido. Eles aparecem abaixo como opções para planejar; confirme a operação, os horários e os assentos antes de reservar.' : resultados.length ? `${resultados.length === 60 ? 'Até 60' : resultados.length} ${resultados.length === 1 ? 'caminho' : 'caminhos'} na base para esse período, saindo de ${nOrigens} ${nOrigens === 1 ? 'aeroporto' : 'aeroportos'}. Selecione um para ver o trajeto.` : 'A base atual não reúne trechos suficientes para desenhar um caminho com estes filtros. Isso é uma limitação da cobertura, não uma confirmação de que a rota não existe. Consulte também a rede de programas abaixo.';
    $('#malha-mapa-caixa').hidden = true;
    mostrarRedeGlobal(origens, destinos, f);
    $('#malha-resultados').innerHTML = resultados.map((r, n) => {
      const cias = [...new Set(r.trechos.map(t => grupoCia(t.cia) === 'LATAM' ? 'LATAM' : base.companhias[t.cia]?.nome || t.cia))], rede = r.trechos.some(t => t.tipo === 'rede');
      const hojeData = hoje, futura = r.trechos.some(t => t.periodos.every(p => p[0] > hojeData));
      return `<li class="malha-card"><div class="malha-card-topo"><span class="malha-selo${futura ? ' futura' : ''}">${r.confirmacaoPendente ? 'Mês a confirmar' : futura ? 'Inclui início futuro' : 'Malha consultada'}</span><span>${r.trechos.length === 1 ? 'Sem conexão' : r.trechos.length === 2 ? '1 conexão' : r.trechos.length - 1 + ' conexões'}</span></div><h3>${esc(nome(r.origem))} <span>→</span> ${esc(nome(r.destino))}</h3><p class="malha-via">${r.trechos.length > 1 ? 'Via ' + r.trechos.slice(0, -1).map(t => esc(nome(t.para))).join(' → ') : 'Trecho direto registrado'}</p><p>${esc(cias.join(' + '))}</p><small>${r.confirmacaoPendente ? 'Caminho conhecido na base atual. Operação no mês escolhido e compatibilidade das conexões ainda não confirmadas.' : rede ? 'Inclui trecho da rede internacional conferida; horários a confirmar.' : 'Trechos registrados com operação no período escolhido.'}</small>${f.programa ? `<small>Parceiras de ${esc(base.programas[f.programa].nome)}. ${f.programa === 'finnair' && new Set(r.trechos.filter(t => t.cia !== 'AY').map(t => grupoCia(t.cia))).size > 1 ? 'Parceiras diferentes podem exigir emissões separadas. ' : ''}Regras e assentos com milhas precisam de consulta.</small>` : ''}<div class="malha-acoes"><button type="button" class="cta cta-a" data-malha-trajeto="${n}">Ver trajeto no mapa</button><button type="button" class="cta cta-b" data-malha-milhas="${n}">Programas na base de milhas</button></div><div class="malha-seats" id="malha-seats-${n}" hidden aria-live="polite"></div></li>`;
    }).join('');
  }
  function novidades() {
    const hoje = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const novos = base.trechos.filter(t => base.aeroportos[t.de].br && !base.aeroportos[t.para].br && t.periodos.every(p => p[0] > hoje)).map(t => ({ ...t, inicio: t.periodos.reduce((a, p) => p[0] < a ? p[0] : a, '9999') })).sort((a, b) => a.inicio.localeCompare(b.inicio));
    $('#malha-novidades').innerHTML = `<h3>Próximos períodos na base operacional</h3><p>Registros ligados ao Brasil disponíveis nesta fonte. Inclui estreias, retomadas e mudanças de temporada registradas. Um período futuro, sozinho, não significa uma rota inédita.</p><ul>${novos.slice(0, 6).map(t => `<li><b>${esc(t.de)} → ${esc(t.para)}</b><span>${esc(base.companhias[t.cia]?.nome || t.cia)}</span><small>A partir de ${t.inicio.split('-').reverse().join('/')}</small></li>`).join('') || '<li>Nenhum novo período internacional identificado nesta consulta.</li>'}</ul>`;
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
    r.trechos.forEach(t => svg.append('path').datum({ type: 'LineString', coordinates: [xy(t.de), xy(t.para)] }).attr('class', 'malha-linha' + (!r.observado && t.periodos.every(p => p[0] > new Date().toISOString().slice(0, 10)) ? ' futura' : '')).attr('d', path));
    const marcados = [];
    nos.forEach((i, n) => {
      const [x, y] = proj(xy(i)), perto = marcados.some(p => Math.abs(x - p[0]) < 55 && Math.abs(y - p[1]) < 24);
      marcados.push([x, y]); svg.append('circle').attr('cx', x).attr('cy', y).attr('r', 5).attr('class', 'malha-ponto');
      svg.append('text').attr('x', x).attr('y', y + (perto ? 22 : -12)).attr('text-anchor', 'middle').attr('class', 'malha-rotulo').text(i);
    });
    $('#malha-mapa-status').textContent = (r.observado ? 'Itinerário observado: ' : r.confirmacaoPendente ? 'Caminho conhecido · mês a confirmar: ' : '') + nos.map(i => nome(i)).join(' → ');
    $('#malha-trechos').innerHTML = '<ol>' + r.trechos.map(t => `<li><b>${esc(nome(t.de))} → ${esc(nome(t.para))}</b><span>${esc(base.companhias[t.cia]?.nome || t.cia)}${base.companhias[t.cia]?.alianca ? ' · ' + esc(base.companhias[t.cia].alianca) : ''}</span><small>${r.observado ? 'Voo ' + esc(t.voo) + ' · itinerário observado' : t.tipo === 'rede' ? 'Rede internacional conferida' : 'Operação registrada'} · conferido em ${t.verificadoEm.split('-').reverse().join('/')}</small></li>`).join('') + '</ol><p>' + (r.confirmacaoPendente ? 'A base não confirma todos estes trechos no mês escolhido. ' : '') + 'São caminhos para planejar a viagem. Horários de conexão, emissão no mesmo bilhete, regras de trânsito e disponibilidade precisam ser conferidos antes de reservar.</p>';
    $('#malha-mapa-caixa').scrollIntoView({ behavior: 'auto', block: 'start' });
  }
  async function programasMilhas(n, botao) {
    const el = $(`#malha-seats-${n}`), r = resultados[n]; if (!r) return;
    el.hidden = false; el.textContent = 'Consultando a base de rotas com milhas…'; botao.disabled = true;
    try {
      await carregarRede();
      const idx = new Map(fonteSeats.a.map((a, i) => [a[0], i])), oi = idx.get(r.origem), di = idx.get(r.destino), par = fonteSeats.e.find(([a, b]) => a === oi && b === di);
      const progs = par ? [...new Set(fonteSeats.fontes.filter((f, b) => par[2] & (1 << b)).map(f => OAMMLProgramas.normalizar(f[1])))] : [];
      el.textContent = progs.length ? 'Rota encontrada na base de milhas: ' + progs.join(' · ') + '. Esse registro pode ter outro trajeto ou companhia. Não confirma assentos nem a emissão do caminho desenhado.' : 'Não encontramos o par de aeroportos na base de milhas consultada. Isso não exclui outros programas ou disponibilidade no site da companhia.';
      const link = document.createElement('a'); link.className = 'cta cta-b'; link.textContent = 'Buscar alertas desta rota'; link.href = window.oammlNavegacao.url('passagens', { origem: r.origem, destino: r.destino }); el.appendChild(link);
    } catch { el.textContent = 'Não foi possível consultar a base de milhas agora. Tente novamente; os caminhos da malha aérea permanecem disponíveis.'; }
    finally { botao.disabled = false; }
  }
  document.querySelectorAll('[data-mapa-vista]').forEach(b => b.addEventListener('click', () => vista(b.dataset.mapaVista)));
  $('#malha-form').addEventListener('submit', executar);
  for (const id of ['#malha-origem', '#malha-destino']) $(id).addEventListener('input', () => { if (base) montarLocais(); });
  $('#malha-trocar').addEventListener('click', () => {
    if (!$('#malha-destino').value.trim()) { $('#malha-destino').focus(); return; }
    const de = $('#malha-origem').value.trim() || 'Brasil';
    $('#malha-origem').value = $('#malha-destino').value; $('#malha-destino').value = de;
    buscaAtual++; resultados = []; $('#malha-resultados').innerHTML = ''; $('#malha-global-resultados').innerHTML = ''; $('#malha-cadastro').innerHTML = ''; $('#malha-mapa-caixa').hidden = true;
    $('#malha-resumo').textContent = 'Origem e destino trocados. Confira o mês e clique em Encontrar caminhos para pesquisar esse sentido.';
    if (base) montarLocais();
  });
  $('#malha-global-resultados').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-global-de')) abrirDisponibilidade(b.dataset.globalDe, b.dataset.globalPara);
    else if (b.hasAttribute('data-rede-mais')) maisRede();
    else if (b.hasAttribute('data-rede-consulta') || b.hasAttribute('data-rede-completa')) consultarVoos(b);
    else if (b.hasAttribute('data-viagem-id')) consultarTrajetos(b);
  });
  $('#malha-cadastro').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-cadastro-mais')) maisCadastro();
    else { const de = b.dataset.cadastroOrigem; $(de ? '#malha-origem' : '#malha-destino').value = nome(de || b.dataset.cadastroDestino); montarLocais(); $('#malha-resumo').textContent = 'Aeroporto selecionado. Clique em Encontrar caminhos para atualizar a pesquisa.'; }
  });
  $('#malha-tentar').addEventListener('click', () => carregar().catch(() => {}));
  $('#malha-resultados').addEventListener('click', e => { const m = e.target.closest('[data-malha-milhas]'), t = e.target.closest('[data-malha-trajeto]'); if (m) programasMilhas(+m.dataset.malhaMilhas, m); if (t && resultados[+t.dataset.malhaTrajeto]) desenhar(resultados[+t.dataset.malhaTrajeto]); });
  function abrir() {
    if (!location.hash.startsWith('#mapa') || !window.oammlPodeVerMapa?.()) return;
    if (/^#mapa\/[A-Z]{3}/.test(location.hash)) vista('historico'); else if (estado.vista === 'planejar') carregar().catch(() => {});
  }
  addEventListener('hashchange', abrir); document.addEventListener('assinatura', abrir); abrir();
})();
