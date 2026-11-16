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
