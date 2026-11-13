// Funil de vendas: de onde a pessoa veio (Instagram, Google, indicação...), contadores de
// visita e dos passos até assinar (servidor/worker.js, POST /evento: sem cookie e sem dado
// pessoal, só um número por dia e por origem), o formulário do alerta grátis da semana e os
// números de prova social (dados/numeros.json, feito pelo robô das passagens).
(() => {
  const SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev';
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sem armazenamento */ } };
  const ler = k => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const sessao = k => { try { if (sessionStorage.getItem(k)) return false; sessionStorage.setItem(k, '1'); } catch (e) { /* conta mesmo assim */ } return true; };
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Origem: a primeira de cada 30 dias vale (quem chega pelo Instagram e volta pelo Google conta para o Instagram).
  const busca = new URLSearchParams(location.search);
  const ref = (busca.get('ref') || '').toLowerCase();
  let origem = (busca.get('utm_source') || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  if (/^[0-9a-f]{8}$/.test(ref)) { guardar('oamml-ref', { codigo: ref, em: Date.now() }); origem = origem || 'indicacao'; }
  if (!origem && document.referrer) {
    const host = (() => { try { return new URL(document.referrer).hostname; } catch (e) { return ''; } })();
    if (host && host !== location.hostname) {
      origem = [['instagram', /instagram/], ['facebook', /facebook|fb\.com/], ['telegram', /t\.me|telegram/], ['whatsapp', /whatsapp|wa\.me/],
        ['google', /google\./], ['bing', /bing\./], ['youtube', /youtube/], ['tiktok', /tiktok/]].find(([, re]) => re.test(host))?.[0] || 'site';
    }
  }
  const antes = ler('oamml-origem');
  if (!antes || Date.now() - antes.em > 30 * 864e5) guardar('oamml-origem', { o: origem || 'direto', em: Date.now() });
  window.oammlOrigem = () => (ler('oamml-origem') || {}).o || 'direto';
  window.oammlRef = () => { const r = ler('oamml-ref'); return r && Date.now() - r.em < 30 * 864e5 ? r.codigo : ''; };
  // O link fica limpo para quem copiar e mandar adiante.
  if (busca.has('ref') || [...busca.keys()].some(k => k.startsWith('utm_'))) {
    ['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'].forEach(k => busca.delete(k));
    history.replaceState(null, '', `${location.pathname}${busca.toString() ? `?${busca}` : ''}${location.hash}`);
  }

  window.oammlEvento = e => {
    if (/localhost|127\.0\.0\.1/.test(location.hostname)) return;
    const corpo = JSON.stringify({ e, o: window.oammlOrigem() });
    try { if (navigator.sendBeacon && navigator.sendBeacon(`${SERVIDOR}/evento`, corpo)) return; } catch (er) { /* tenta o fetch */ }
    fetch(`${SERVIDOR}/evento`, { method: 'POST', body: corpo, keepalive: true }).catch(() => {});
  };
  if (sessao('oamml-visita')) window.oammlEvento('visita');
  const paginaVista = () => {
    if (location.hash === '#assinar' && sessao('oamml-v-assinar')) window.oammlEvento('assinar_ver');
    if (location.hash === '#gratis' && sessao('oamml-v-gratis')) window.oammlEvento('gratis_ver');
  };
  addEventListener('hashchange', paginaVista);
  paginaVista();

  // Alerta grátis da semana: qualquer form[data-lead] da página.
  document.addEventListener('submit', async ev => {
    const f = ev.target.closest('form[data-lead]');
    if (!f) return;
    ev.preventDefault();
    const email = f.querySelector('input[type=email]').value.trim();
    const aceite = f.querySelector('input[type=checkbox]').checked;
    const msg = f.querySelector('.lead-msg'), botao = f.querySelector('button');
    const dizer = (t, ok) => { msg.textContent = t; msg.className = `lead-msg ${ok ? 'ok' : 'erro'}`; msg.hidden = false; };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return dizer('Digite um e-mail válido.');
    if (!aceite) return dizer('Marque que aceita receber o e-mail da semana.');
    botao.disabled = true;
    try {
      const r = await fetch(`${SERVIDOR}/lead`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, aceite, origem: window.oammlOrigem() }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro);
      dizer(d.ja ? 'Esse e-mail já está na lista. Toda semana chega um novo.' : 'Pronto! O primeiro e-mail já está a caminho (veja também o spam).', true);
      f.reset();
      if (d.chave) perguntas(f, email, d.chave);
    } catch (er) {
      dizer(er.message || 'Não deu agora. Tente de novo em instantes.');
    } finally { botao.disabled = false; }
  });
  // Depois do cadastro: 4 perguntas opcionais para o e-mail da semana trazer o que combina com a pessoa.
  const AEROPORTOS = [['GRU', 'São Paulo'], ['CGH', 'Congonhas'], ['VCP', 'Campinas'], ['GIG', 'Rio (Galeão)'], ['SDU', 'Rio (Santos Dumont)'],
    ['BSB', 'Brasília'], ['CNF', 'Belo Horizonte'], ['CWB', 'Curitiba'], ['POA', 'Porto Alegre'], ['FLN', 'Florianópolis'],
    ['SSA', 'Salvador'], ['REC', 'Recife'], ['FOR', 'Fortaleza'], ['NAT', 'Natal'], ['BEL', 'Belém'], ['MAO', 'Manaus'],
    ['VIX', 'Vitória'], ['GYN', 'Goiânia'], ['CGB', 'Cuiabá'], ['MCZ', 'Maceió']];
  const REGIOES = [['brasil', 'Brasil'], ['america-do-sul', 'América do Sul'], ['america-do-norte', 'EUA e Canadá'], ['caribe', 'Caribe'], ['europa', 'Europa'], ['qualquer', 'Qualquer lugar']];
  const PROGRAMAS = [['livelo', 'Livelo'], ['esfera', 'Esfera'], ['smiles', 'Smiles'], ['latam', 'LATAM Pass'], ['azul', 'Azul Fidelidade'], ['tap', 'TAP'], ['avios', 'Avios'], ['nenhum', 'Ainda não tenho']];
  const CABINES = [['eco', 'Econômica'], ['exe', 'Executiva'], ['tanto', 'Tanto faz']];
  const chips = (nome, itens, tipo = 'checkbox') => `<div class="perg-chips">${itens.map(([v, t]) => `<label class="perg-chip"><input type="${tipo}" name="${nome}" value="${v}"><span>${esc(t)}${nome === 'aeroportos' ? ` <b>${v}</b>` : ''}</span></label>`).join('')}</div>`;
  function perguntas(f, email, chave) {
    const caixa = document.createElement('form');
    caixa.className = 'perguntas';
    caixa.innerHTML = `<p class="perg-tit"><b>Quer receber só o que combina com você?</b><small>4 perguntas rápidas, todas opcionais. Dá para marcar mais de uma.</small></p>
      <fieldset><legend>De quais aeroportos você costuma sair?</legend>${chips('aeroportos', AEROPORTOS)}
        <input class="perg-outro" name="outro" maxlength="23" placeholder="Outro? Digite a sigla, ex.: JPA, IGU" aria-label="Outros aeroportos (siglas)"></fieldset>
      <fieldset><legend>Para onde você sonha ir?</legend>${chips('regioes', REGIOES)}</fieldset>
      <fieldset><legend>Onde você tem pontos ou milhas?</legend>${chips('programas', PROGRAMAS)}</fieldset>
      <fieldset><legend>Como prefere voar?</legend>${chips('cabine', CABINES, 'radio')}</fieldset>
      <div class="perg-botoes"><button class="cta cta-a" type="submit">Salvar minhas preferências</button><button class="cta cta-b" type="button" data-pular>Agora não</button></div>
      <p class="lead-msg" role="status" hidden></p>`;
    f.after(caixa);
    f.hidden = true;
    caixa.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const marcados = n => [...caixa.querySelectorAll(`input[name=${n}]:checked`)].map(i => i.value);
    const fechar = t => { caixa.innerHTML = `<p class="lead-msg ok">${esc(t)}</p>`; };
    caixa.querySelector('[data-pular]').addEventListener('click', () => fechar('Tudo certo! Você recebe as melhores passagens da semana. Se quiser personalizar depois, é só se cadastrar de novo.'));
    caixa.addEventListener('submit', async ev => {
      ev.preventDefault();
      const outros = (caixa.elements.outro.value.toUpperCase().match(/\b[A-Z]{3}\b/g) || []);
      const corpo = { email, chave, aeroportos: [...marcados('aeroportos'), ...outros], regioes: marcados('regioes'), programas: marcados('programas'), cabine: marcados('cabine')[0] || '' };
      const b = caixa.querySelector('button[type=submit]');
      b.disabled = true;
      try {
        const r = await fetch(`${SERVIDOR}/lead/perfil`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo) });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro);
        if (window.oammlEvento) window.oammlEvento('perfil');
        fechar(corpo.aeroportos.length ? `Pronto! A partir do próximo e-mail, você recebe primeiro as passagens saindo de ${corpo.aeroportos.join(', ')}.` : 'Pronto! Suas preferências foram salvas.');
      } catch (er) {
        const m = caixa.querySelector('.lead-msg'); m.textContent = er.message || 'Não deu agora. Tente de novo.'; m.className = 'lead-msg erro'; m.hidden = false; b.disabled = false;
      }
    });
  }

  // Quem já assina não precisa do alerta grátis.
  document.addEventListener('assinatura', e => {
    document.querySelectorAll('[data-lead-caixa], [data-so-visitante]').forEach(el => { el.hidden = !!e.detail.ativo; });
  });

  // Foto do depoimento: a que a pessoa mandou ou a da conta Google dela; sem foto (ou se não carregar), a inicial.
  window.oammlFoto = d => {
    const inicial = esc((d.nome || '?').trim().charAt(0).toUpperCase());
    return d.foto ? `<img class="depo-foto" src="${esc(d.foto)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-inicial="${inicial}">` : `<span class="depo-foto inicial">${inicial}</span>`;
  };
  window.oammlFotoErros = raiz => raiz.querySelectorAll('img.depo-foto[data-inicial]').forEach(img => img.addEventListener('error', () => {
    const s = document.createElement('span');
    s.className = 'depo-foto inicial';
    s.textContent = img.dataset.inicial;
    img.replaceWith(s);
  }, { once: true }));

  // Início: selo compacto com a nota média e uma frase por vez (troca sozinha; para no mouse e com movimento reduzido).
  function desenharDepoDestaque(lista) {
    const el = document.querySelector('[data-depo-destaque]');
    if (!el || !lista.length) return;
    const itens = lista.slice(0, 6);
    const media = lista.reduce((t, d) => t + (Number(d.nota) || 5), 0) / lista.length;
    const cheias = Math.round(media);
    el.innerHTML = `<div class="ini-depo-nota"><b>${media.toFixed(1).replace('.', ',')}</b>
        <span class="ini-depo-estrelas" aria-label="${media.toFixed(1).replace('.', ',')} de 5 estrelas">${'★'.repeat(cheias)}<i>${'★'.repeat(5 - cheias)}</i></span>
        <small>${lista.length} ${lista.length === 1 ? 'avaliação' : 'avaliações'} de assinantes</small></div>
      <div class="ini-depo-giro" aria-live="polite">${itens.map((d, i) => `<figure class="ini-depo-item${i ? '' : ' ativo'}"${i ? ' aria-hidden="true"' : ''}>
        <blockquote title="${esc(d.texto)}">${esc(d.texto)}</blockquote>
        <figcaption>${window.oammlFoto(d)}<span><b>${esc(d.nome)}</b>${d.cidade ? ` · ${esc(d.cidade)}` : ''}</span></figcaption></figure>`).join('')}</div>
      ${itens.length > 1 ? `<div class="ini-depo-pontos">${itens.map((d, i) => `<button type="button" aria-label="Depoimento ${i + 1}"${i ? '' : ' aria-current="true"'}></button>`).join('')}</div>` : ''}`;
    el.hidden = false;
    window.oammlFotoErros(el);
    if (itens.length < 2) return;
    let atual = 0, parado = false;
    const mostrar = i => {
      atual = (i + itens.length) % itens.length;
      el.querySelectorAll('.ini-depo-item').forEach((f, j) => { f.classList.toggle('ativo', j === atual); f.toggleAttribute('aria-hidden', j !== atual); });
      el.querySelectorAll('.ini-depo-pontos button').forEach((b, j) => b.toggleAttribute('aria-current', j === atual));
    };
    el.querySelectorAll('.ini-depo-pontos button').forEach((b, j) => b.addEventListener('click', () => mostrar(j)));
    el.addEventListener('mouseenter', () => { parado = true; });
    el.addEventListener('mouseleave', () => { parado = false; });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    setInterval(() => { if (!parado && !document.hidden) mostrar(atual + 1); }, 6500);
  }

  // Depoimentos de assinantes, só os aprovados pelo dono (servidor/worker.js, GET /depoimentos).
  (async () => {
    const caixas = document.querySelectorAll('[data-depoimentos]');
    if (!caixas.length && !document.querySelector('[data-depo-destaque]')) return;
    let lista;
    try { lista = (await (await fetch(`${SERVIDOR}/depoimentos`)).json()).depoimentos; } catch (e) { return; }
    if (!lista || !lista.length) return;
    const html = `<p class="prova-tit">O que dizem os assinantes</p><ul class="depos-lista">${lista.slice(0, 6).map(d => `<li>
        <p class="depo-estrelas" aria-label="${d.nota} de 5 estrelas">${'★'.repeat(d.nota)}<span>${'★'.repeat(5 - d.nota)}</span></p>
        <blockquote>${esc(d.texto)}</blockquote>
        <div class="depo-quem">${window.oammlFoto(d)}<p class="depo-autor"><b>${esc(d.nome)}</b>${d.cidade ? ` · ${esc(d.cidade)}` : ''}${d.instagram ? ` · <a href="https://www.instagram.com/${esc(d.instagram)}/" target="_blank" rel="noopener nofollow">@${esc(d.instagram)}</a>` : ''}</p></div></li>`).join('')}</ul>`;
    caixas.forEach(el => { el.innerHTML = html; el.hidden = false; window.oammlFotoErros(el); });
    desenharDepoDestaque(lista);
  })();

  // Prova social: números dos últimos 30 dias e as melhores achadas.
  const milhas = n => Number(n).toLocaleString('pt-BR');
  const NIVEL = { espetacular: '🔥 espetacular', 'muito bom': 'muito bom', bom: 'bom' };
  (async () => {
    let n;
    try { n = await (await fetch('dados/numeros.json', { cache: 'no-cache' })).json(); } catch (e) { return; }
    if (!n || !n.passagens) return;
    const blocos = [[n.passagens, 'passagens com milhas'], [n.destinos, 'destinos diferentes'], [n.executiva, 'em executiva ou primeira'], [n.promocoes, 'promoções de pontos']];
    document.querySelectorAll('[data-prova]').forEach(el => {
      el.innerHTML = `<p class="prova-tit">Nos últimos ${n.dias} dias, aqui no site</p>
        <div class="prova-nums">${blocos.map(([v, t]) => `<div><b>${milhas(v)}</b><small>${t}</small></div>`).join('')}</div>`;
      el.hidden = false;
    });
    const html = (n.destaques || []).map(d => `<li>
          <p class="prova-rota"><b>${esc(d.origem_iata)}</b> ${esc(d.origem)} <i>✈</i> <b>${esc(d.destino_iata)}</b> ${esc(d.destino)}</p>
          <p class="prova-milhas"><b>${milhas(d.milhas)}</b> milhas + taxas o trecho</p>
          <p class="prova-meta">${esc([d.programa, d.cabine].filter(Boolean).join(' · '))}${NIVEL[d.nivel] ? ` · <span>${esc(NIVEL[d.nivel])} no termômetro</span>` : ''}</p>
        </li>`).join('');
    document.querySelectorAll('[data-destaques]').forEach(el => { el.innerHTML = html; });
  })();
})();
