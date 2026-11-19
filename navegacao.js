/* URLs de viagem compartilháveis. Nenhum dado de conta ou de assinatura vai na URL. */
(() => {
  const campos = ['origem', 'destino', 'cabine', 'programa', 'cidade', 'escopo', 'ordem', 'busca'];
  const paginas = new Set(['passagens', 'radar', 'termometro', 'quanto', 'calculadoras', 'historico']);
  function contexto(pagina) {
    const q = new URLSearchParams(location.search);
    if (q.get('viagem') !== pagina) return null;
    return Object.fromEntries(campos.map(k => [k, (q.get(k) || '').slice(0, 80)]));
  }
  function url(pagina, dados = {}) {
    if (!paginas.has(pagina)) throw new Error('Página de viagem inválida');
    const u = new URL(location.href);
    campos.concat('viagem').forEach(k => u.searchParams.delete(k));
    u.searchParams.set('viagem', pagina);
    campos.forEach(k => { if (dados[k]) u.searchParams.set(k, String(dados[k]).slice(0, 80)); });
    u.hash = pagina;
    return u.pathname + u.search + u.hash;
  }
  function ir(pagina, dados = {}) {
    const destino = url(pagina, dados);
    if (destino !== location.pathname + location.search + location.hash) history.pushState(null, '', destino);
    document.dispatchEvent(new Event('navegacao-viagem'));
  }
  function salvar(pagina, dados) {
    if (location.hash !== '#' + pagina) return;
    history.replaceState(null, '', url(pagina, dados));
  }
  window.oammlNavegacao = { contexto, url, ir, salvar };
  document.addEventListener('navegacao-viagem', () => dispatchEvent(new HashChangeEvent('hashchange')));
  let ultimoHash = location.hash;
  addEventListener('hashchange', () => { ultimoHash = location.hash; });
  addEventListener('popstate', () => { if (location.hash === ultimoHash) document.dispatchEvent(new Event('navegacao-viagem')); });
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-viagem]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || u.pathname !== location.pathname || !paginas.has(u.hash.slice(1))) return;
    e.preventDefault();
    if (u.href !== location.href) history.pushState(null, '', u.pathname + u.search + u.hash);
    document.dispatchEvent(new Event('navegacao-viagem'));
  });
  // O retorno é estritamente local e temporário, apenas para retomar uma ferramenta após entrar.
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || window.oammlAssinatura?.ativo) return;
    const a = e.target.closest('a[href="#assinar"]');
    if (!a || !/^#(?:radar|historico|mapa|rota\/|calculadoras)/.test(location.hash)) return;
    try { sessionStorage.setItem('oamml-retorno', JSON.stringify({ url: location.pathname + location.search + location.hash, em: Date.now() })); } catch (_) {}
  });
  document.addEventListener('assinatura', e => {
    if (!e.detail?.ativo || location.hash !== '#assinar') return;
    try {
      const item = JSON.parse(sessionStorage.getItem('oamml-retorno') || 'null');
      sessionStorage.removeItem('oamml-retorno');
      if (!item || Date.now() - item.em > 30 * 60e3) return;
      const u = new URL(item.url, location.origin);
      if (u.origin !== location.origin || !/^#(?:radar|historico|mapa|rota\/|calculadoras)/.test(u.hash)) return;
      history.pushState(null, '', u.pathname + u.search + u.hash);
      dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (_) {}
  });
})();
