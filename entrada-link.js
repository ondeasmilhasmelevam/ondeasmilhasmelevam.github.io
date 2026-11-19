/* Retira o segredo da URL antes dos módulos e da medição de visitas. Ele fica só em memória. */
(() => {
  const url = new URL(location.href);
  const match = /^#acesso\/([A-Za-z0-9_-]{43})$/.exec(url.hash);
  let segredo = match ? match[1] : '';
  const cortesia = url.searchParams.get('utm_campaign') === 'cortesia' || url.searchParams.get('entrada') === 'convite';
  const convite = !!match || cortesia || url.searchParams.get('entrada') === 'link';
  if (match || cortesia) {
    if (match) url.hash = 'assinar';
    url.searchParams.set('entrada', cortesia ? 'convite' : 'link');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  }
  window.oammlEntradaLink = Object.freeze({ ler: () => segredo, apagar: () => { segredo = ''; } });
  if (!convite) return;
  document.documentElement.classList.add('entrada-convite');
  document.addEventListener('DOMContentLoaded', () => {
    const aviso = document.querySelector('#ass-convite');
    if (!aviso) return;
    if (!cortesia) {
      aviso.querySelector('h2').textContent = 'Entre com seu link de acesso';
      document.querySelector('#ass-convite-descricao').textContent = 'Este link entra na conta que o recebeu. Ele não cria uma assinatura nem realiza cobranças. Você também pode usar o login por Google ou código.';
    }
    aviso.hidden = false;
    const login = document.querySelector('#ass-entrar');
    aviso.after(login);
    document.querySelector('#ass-link-card').hidden = !segredo;
    if (segredo) document.querySelector('#ass-link-card').before(document.querySelector('#ass-msg'));
  }, { once: true });
})();
