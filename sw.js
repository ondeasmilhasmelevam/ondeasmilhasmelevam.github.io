/* Service worker do app instalado. Não guarda nada em cache: o site continua vindo sempre da rede,
   do mesmo jeito que no navegador (os ?v= do index seguem valendo). Só entra quando a internet cai,
   para mostrar um aviso em vez da tela de erro do celular. */
const SEM_REDE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sem internet · Onde as Milhas Me Levam</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#070C17;color:#F3EEE3;font:16px/1.6 system-ui,sans-serif;text-align:center;padding:24px}
img{width:96px;height:96px;border-radius:50%;box-shadow:0 0 0 2px rgba(226,180,88,.55)}h1{font-size:20px;margin:18px 0 6px}p{color:#A3ACBD;margin:0 0 20px}
button{font:inherit;font-weight:700;padding:12px 22px;border-radius:12px;border:0;background:#E2B458;color:#070C17}</style></head>
<body><main><img src="/img/icone-192.png" alt=""><h1>Sem internet agora</h1><p>As passagens chegam assim que o sinal voltar.</p>
<button onclick="location.reload()">Tentar de novo</button></main></body></html>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.mode !== 'navigate') return; // imagens, scripts e dados: o navegador busca normalmente
  e.respondWith(fetch(e.request).catch(() => new Response(SEM_REDE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
});

// Notificação da Rota Vigiada (o servidor manda {titulo, texto, url, tag}); tocar abre a rota no site/app.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (er) { d = { texto: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.titulo || 'Onde as Milhas Me Levam', {
    body: d.texto || 'Tem passagem nova na sua Rota Vigiada.', icon: '/img/icone-192.png', badge: '/img/icone-maskable-192.png',
    tag: d.tag || undefined, data: { url: d.url || '/#radar' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(lista => {
    const aberta = lista.find(c => new URL(c.url).origin === self.location.origin);
    if (aberta) return aberta.focus().then(c => (c && c.navigate ? c.navigate(url) : null));
    return self.clients.openWindow(url);
  }));
});
