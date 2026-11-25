/* Apresentação e próximos passos. Os fluxos de conta e pagamento continuam nos módulos originais. */
(() => {
  const $ = s => document.querySelector(s);
  const links = {
    transferencias: [['Calcular a transferência', '#calculadoras'], ['Quando tem bônus', '#bonus']],
    comprar: [['Avaliar uma compra', '#calculadoras'], ['Ver transferências', '#transferencias']],
    programas: [['Preparar meus cadastros', '#cadastros'], ['Entender como emitir', '#guia']],
    cadastros: [['Como funciona cada programa', '#programas'], ['Salas VIP e restaurantes', '#salas']],
    restaurantes: [['Aplicativos de aeroporto', '#cadastros'], ['Voltar às salas VIP', '#salas']],
    direitos: [['Telefones das companhias', '#contatos']],
    contatos: [['Seus direitos no voo', '#direitos']],
    guia: [['Preparar meus cadastros', '#cadastros'], ['Quando a data abre?', '#abertura']],
    quanto: [['Ver passagens no ar', '#passagens'], ['Histórico de preços', '#historico']],
    calculadoras: [['Até quanto pagar pelo milheiro', '#comprar'], ['Transferências disponíveis', '#transferencias']],
    'ranking-sec': [['Ajustar gasto e renda', '#simulador'], ['Como calculamos', '#como']],
    como: [['Voltar ao comparador', '#simulador']],
    internet: [['Dinheiro na viagem', '#dinheiro'], ['Meus cadastros e seguros', '#cadastros']],
    dinheiro: [['Internet e seguro viagem', '#internet'], ['Comparador de cartões', '#simulador']]
  };
  Object.entries(links).forEach(([id, itens]) => {
    const sec = document.getElementById(id); if (!sec) return;
    const nav = document.createElement('nav'); nav.className = 'proximos-passos'; nav.setAttribute('aria-label', 'Continue sua consulta');
    const label = document.createElement('b'); label.textContent = 'Continue sua consulta'; nav.append(label);
    itens.forEach(([nome, href]) => { const a = document.createElement('a'); a.textContent = nome + ' →'; a.href = href; nav.append(a); });
    sec.append(nav);
  });
  // Cada banner conserva a foto e recebe o título real, sem repetir a chamada abaixo.
  document.querySelectorAll('.aba-banner').forEach(b => {
    const head = b.nextElementSibling;
    if (!head?.classList.contains('sec-head')) return;
    const title = head.querySelector('h2'); if (!title) return;
    b.querySelector('b')?.remove(); b.querySelector('small')?.remove();
    title.classList.add('banner-titulo'); b.firstElementChild.append(title);
    b.removeAttribute('role'); b.removeAttribute('aria-label');
  });
  // Os grupos do menu (incluindo "Antes de embarcar") ficam direto no index.html.
  // Planos antes das estatísticas e dos depoimentos; mantém elementos e listeners de assinatura.
  const planos = $('.ass-planos'); if (planos) $('#assinar .sec-head')?.after(planos);
  // Os atalhos das páginas utilitárias também podem transportar o programa escolhido.
  $('#transferencias .proximos-passos a[href="#calculadoras"]')?.addEventListener('click', e => {
    const ativo = $('#transf-chips button[aria-pressed="true"]');
    const nome = ativo?.textContent.trim();
    if (nome) { e.preventDefault(); const origem = $('#transf-modo button[aria-pressed="true"]')?.dataset.modo === 'origem'; window.oammlNavegacao.ir('calculadoras', origem ? { origem: nome } : { programa: nome }); }
  });
  document.querySelectorAll('#quanto .proximos-passos a, #termometro .proximos-passos a').forEach(a => a.addEventListener('click', e => {
    const pagina = location.hash.slice(1);
    const c = window.oammlNavegacao.contexto(pagina);
    const destino = pagina === 'quanto' ? $('#quanto-busca').value : c?.destino;
    const alvo = a.getAttribute('href').slice(1);
    if (destino && ['passagens','quanto','termometro'].includes(alvo)) {
      e.preventDefault(); window.oammlNavegacao.ir(alvo, { destino, cabine: c?.cabine || '' });
    }
  }));
  // Páginas que juntam mais de uma seção: atalhos no topo para pular entre elas.
  const ROTULO = { termometro: 'Termômetro', quanto: 'Tabela por destino', bonus: 'Quando tem bônus', comprar: 'Preço do milheiro', salas: 'Salas VIP', restaurantes: 'Restaurantes VIP' };
  const grupos = {};
  document.querySelectorAll('section[data-pagina][id], div.hero[data-pagina][id]').forEach(s => { if (ROTULO[s.id]) (grupos[s.dataset.pagina] = grupos[s.dataset.pagina] || []).push(s); });
  Object.values(grupos).filter(g => g.length > 1).forEach(g => {
    const nav = document.createElement('nav'); nav.className = 'sub-abas'; nav.setAttribute('aria-label', 'Nesta página');
    nav.innerHTML = '<span>Nesta página</span>' + g.map(s => `<a href="#${s.id}">${ROTULO[s.id]}</a>`).join('');
    const alvo = g[0].querySelector('.sec-head') || g[0].querySelector('.wrap > *:first-child');
    if (alvo) alvo.after(nav);
  });
  dispatchEvent(new HashChangeEvent('hashchange'));
})();
