// Site como app, sem loja: no Android o Chrome deixa o site pedir a instalação (janela oficial);
// no iPhone a Apple não deixa site nenhum instalar sozinho, então mostramos o passo a passo do Safari.
// Quem já abriu pelo ícone (modo app) não vê nada disto. "Agora não" esconde o aviso por 21 dias;
// o item "Instalar o app" do menu continua lá para quando a pessoa quiser.
(() => {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  const emApp = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (emApp) { document.documentElement.classList.add('modo-app'); return; }

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/i.test(ua);
  const dentroDeApp = /Instagram|FBAN|FBAV|FB_IAB|FBIOS|Line\/|TikTok|musical_ly|Bytedance|WhatsApp|Snapchat|Pinterest/i.test(ua)
    || (android && /; wv\)/.test(ua));
  const nomeApp = (/Instagram/i.test(ua) && 'Instagram') || (/FBAN|FBAV|FB_IAB|FBIOS/i.test(ua) && 'Facebook')
    || (/TikTok|musical_ly|Bytedance/i.test(ua) && 'TikTok') || (/WhatsApp/i.test(ua) && 'WhatsApp') || '';
  const CHAVE = 'oamml-app-aviso';
  const ler = () => { try { return +localStorage.getItem(CHAVE) || 0; } catch (e) { return 0; } };
  const adiar = () => { try { localStorage.setItem(CHAVE, String(Date.now())); } catch (e) { /* sem armazenamento */ } };
  const $ = s => document.querySelector(s);

  let pedido = null; // o convite do Chrome (Android e computador)
  const icone = {
    compartilhar: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M8.5 10H6.5a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5h-2"/></svg>',
    mais: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8.5v7M8.5 12h7"/></svg>',
    pontos: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5.5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18.5" r="1.3"/></svg>',
    pontosH: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/></svg>',
    chave: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="18" height="10" rx="5"/><circle cx="16" cy="12" r="3" class="cheio"/></svg>',
  };
  const passo = (n, html) => `<li><span class="app-n">${n}</span><p>${html}</p></li>`;

  function passos() {
    if (dentroDeApp) {
      const onde = ios ? 'Safari' : 'Chrome';
      return {
        titulo: `Abra no ${onde} para instalar`,
        lista: [
          `O navegador ${nomeApp ? `do ${nomeApp}` : 'deste aplicativo'} não instala apps. Toque em <b class="app-ic">${ios ? icone.pontosH : icone.pontos}</b> no canto de cima.`,
          `Escolha <b>Abrir no ${ios ? 'navegador externo' : 'Chrome'}</b> (ou <b>Abrir no ${onde}</b>).`,
          'Lá, toque de novo em <b>Instalar o app</b> aqui no site.',
        ],
        copiar: true,
      };
    }
    if (ios) {
      return {
        titulo: 'Instale no iPhone em 3 toques',
        lista: [
          `Toque em <b class="app-ic">${icone.compartilhar}</b> <b>Compartilhar</b>. No Safari novo ele fica dentro do <b class="app-ic">${icone.pontosH}</b> da barra de baixo.`,
          `Role a lista e toque em <b class="app-ic">${icone.mais}</b> <b>Adicionar à Tela de Início</b>.`,
          `Deixe ligado <b class="app-ic">${icone.chave}</b> <b>Abrir como App da Web</b> e toque em <b>Adicionar</b>.`,
        ],
        nota: 'No iPhone o app guarda o login separado do Safari: na primeira vez, entre de novo na sua conta dentro do app.',
      };
    }
    return {
      titulo: 'Instale no Android em 3 toques',
      lista: [
        `No Chrome, toque no menu <b class="app-ic">${icone.pontos}</b> no canto de cima.`,
        `Toque em <b>Instalar app</b>. Em algumas versões aparece como <b>Adicionar à tela inicial</b>.`,
        'Confirme em <b>Instalar</b>. O ícone aparece junto dos seus apps.',
      ],
    };
  }

  // ---- folha com o passo a passo ----
  function abrirPassos() {
    const p = passos();
    let d = $('#app-passos');
    if (!d) {
      d = document.createElement('dialog');
      d.id = 'app-passos';
      d.className = 'app-passos';
      d.setAttribute('aria-labelledby', 'app-passos-t');
      document.body.appendChild(d);
      d.addEventListener('click', e => { if (e.target === d || e.target.closest('[data-fechar]')) d.close(); });
    }
    d.innerHTML = `
      <div class="app-passos-in">
        <button type="button" class="app-x" data-fechar aria-label="Fechar">✕</button>
        <img src="img/icone-192.png" alt="" width="64" height="64">
        <h2 id="app-passos-t">${p.titulo}</h2>
        <ol>${p.lista.map((t, i) => passo(i + 1, t)).join('')}</ol>
        ${p.copiar ? '<button type="button" class="app-copiar">Copiar o link do site</button>' : ''}
        ${p.nota ? `<p class="app-nota">${p.nota}</p>` : ''}
        <p class="app-nota">É o mesmo site, sem loja de aplicativos e sem ocupar espaço. Para tirar, é só apagar o ícone.</p>
        <button type="button" class="app-ok" data-fechar>Entendi</button>
      </div>`;
    const cp = d.querySelector('.app-copiar');
    if (cp) cp.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.origin + '/'); cp.textContent = 'Link copiado. Cole no navegador.'; }
      catch (e) { cp.textContent = location.host; }
    });
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
  }

  async function instalar() {
    if (pedido) {
      const p = pedido;
      pedido = null;
      p.prompt();
      const r = await p.userChoice.catch(() => null);
      if (r && r.outcome === 'accepted') esconder(); else pedido = p; // o Chrome só deixa pedir uma vez por convite
      return;
    }
    abrirPassos();
  }

  // ---- aviso de baixo ----
  function esconder() { const b = $('#app-aviso'); if (b) { b.classList.remove('on'); setTimeout(() => b.remove(), 300); } }
  function mostrarAviso() {
    if ($('#app-aviso') || Date.now() - ler() < 21 * 864e5) return;
    if (!(ios || android || pedido)) return; // no computador só quando o Chrome oferece
    const b = document.createElement('aside');
    b.id = 'app-aviso';
    b.className = 'app-aviso';
    b.setAttribute('aria-label', 'Instalar o app');
    b.innerHTML = `
      <img src="img/icone-192.png" alt="" width="48" height="48">
      <div><b>Tenha o site como app</b><span>Abre direto da tela inicial, em tela cheia. Sem loja.</span></div>
      <button type="button" class="app-sim">${pedido ? 'Instalar' : 'Como instalar'}</button>
      <button type="button" class="app-x" aria-label="Agora não">✕</button>`;
    document.body.appendChild(b);
    b.querySelector('.app-sim').addEventListener('click', () => { instalar(); });
    b.querySelector('.app-x').addEventListener('click', () => { adiar(); esconder(); });
    requestAnimationFrame(() => requestAnimationFrame(() => b.classList.add('on')));
  }
  const atualizarBotao = () => { const b = $('#app-aviso .app-sim'); if (b) b.textContent = pedido ? 'Instalar' : 'Como instalar'; };

  // ---- item do menu ----
  const item = $('#menu-instalar');
  if (item && (ios || android)) item.hidden = false;
  if (item) item.addEventListener('click', e => { e.preventDefault(); instalar(); });

  addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    pedido = e;
    if (item) item.hidden = false;
    atualizarBotao();
  });
  addEventListener('appinstalled', () => { pedido = null; adiar(); esconder(); if (item) item.hidden = true; });

  // Primeira visita: o aviso sobe depois de alguns segundos, quando a pessoa já viu a página.
  setTimeout(mostrarAviso, 5000);
  window.oammlInstalar = instalar;
})();
