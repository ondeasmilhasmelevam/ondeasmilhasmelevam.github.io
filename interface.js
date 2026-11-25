/* Apresentação e próximos passos. Os fluxos de conta e pagamento continuam nos módulos originais. */
(() => {
  const $ = s => document.querySelector(s);
  const links = {
    transferencias: [['Calcular a transferência', '#calculadoras'], ['Ver promoções no ar', '#promocoes']],
    comprar: [['Avaliar uma compra', '#calculadoras'], ['Ver transferências', '#transferencias']],
    programas: [['Preparar meus cadastros', '#cadastros'], ['Entender como emitir', '#guia']],
    cadastros: [['Consultar salas VIP', '#salas'], ['Consultar restaurantes', '#restaurantes']],
    salas: [['Aplicativos de aeroporto', '#cadastros'], ['Restaurantes no aeroporto', '#restaurantes']],
    restaurantes: [['Aplicativos de aeroporto', '#cadastros'], ['Salas VIP', '#salas']],
    direitos: [['Encontrar atendimento', '#contatos']],
    contatos: [['Direitos do passageiro', '#direitos']],
    guia: [['Preparar meus cadastros', '#cadastros'], ['Quando a data abre?', '#abertura']],
    quanto: [['Avaliar o preço em milhas', '#termometro'], ['Buscar oportunidades', '#passagens']],
    termometro: [['Tabela por destino', '#quanto'], ['Ver passagens', '#passagens']],
    calculadoras: [['Referências do milheiro', '#comprar'], ['Transferências disponíveis', '#transferencias']],
    'ranking-sec': [['Ajustar gasto e renda no comparador', '#simulador'], ['Como calculamos', '#como']],
    'vencedor-sec': [['Como calculamos', '#como']],
    como: [['Voltar ao comparador', '#simulador']],
    hoje: [['Ver todas as passagens', '#passagens'], ['Ver promoções', '#promocoes']]
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
  const hoje = $('#menu a[href="#hoje"]'); if (hoje) { hoje.querySelector('span').textContent = 'Resumo do dia'; hoje.title = 'Resumo do dia'; }
  const ranking = $('#menu a[href="#ranking-sec"]'); if (ranking) { ranking.querySelector('span').textContent = 'Ranking do comparador'; ranking.title = 'Ranking do comparador'; }
  // Planos antes das estatísticas e dos depoimentos; mantém elementos e listeners de assinatura.
  const planos = $('.ass-planos'); if (planos) $('#assinar .sec-head')?.after(planos);
  const cadHead = $('#cadastros .banner-titulo'); if (cadHead) cadHead.textContent = 'Cadastros, aplicativos e seguros';
  const cadNote = $('#cadastros .sec-note'); if (cadNote) cadNote.textContent = 'Prepare os aplicativos de aeroporto, os portais de seguro e os programas de pontos. Abra os links oficiais e marque os cadastros que já fez; a lista fica salva neste navegador. Faça agora, mesmo nos programas que ainda não usa: muita promoção só vale para quem já tem conta, algumas pedem um tempo mínimo de cadastro e, no dia da promoção, o site costuma ficar lento.';
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
  dispatchEvent(new HashChangeEvent('hashchange'));
})();
