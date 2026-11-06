// Assinatura do site: cria o link de pagamento da InfinitePay e, quando ela avisa que
// foi pago, libera o e-mail no Firestore (assinantes/{email}.validoAte).
//
// Também faz a entrada por código: manda 7 números para o e-mail de quem já assinou (EmailJS)
// e, com o código certo, devolve um token para o site entrar no Firebase com aquele e-mail.
// E guarda as datas e links das passagens (POST /alertas, vindo do GitHub) para só assinantes lerem.
//
// Vendas: conta visitas e passos do funil por origem (POST /evento, sem cookie e sem dado pessoal),
// guarda quem pede o alerta grátis da semana (POST /lead, GET /sair para cancelar), dá a cada
// assinante um link de indicação que rende 7 dias (GET /indicacao) e mostra tudo no painel
// do dono (GET /metricas, só para os e-mails de ADMINS).
// Depoimentos: quem assina (ou já assinou) conta o que achou (POST /depoimento); só aparece no
// site (GET /depoimentos) depois que o dono aprova no painel (GET /depoimentos/todos, POST /depoimento/moderar).
// Não manda e-mail ao dono: os novos esperam na parte de depoimentos do painel.
//
// Segredos (wrangler secret put): INFINITEPAY_API_KEY, FIREBASE_SERVICE_ACCOUNT (o JSON inteiro),
// EMAILJS_PRIVATE_KEY e SEATS_AERO_KEY. Com GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REFRESH_TOKEN, os e-mails
// saem direto pelo Gmail da marca (API do Gmail, uns 500 por dia) em vez do EmailJS (200 por mês); (busca de disponibilidade em milhas, GET /voos). Variáveis (wrangler.toml): HANDLE, PROJETO, SITE, ORIGENS, SELF, EMAILJS_*.

const PLANOS = {
  mensal: { dias: 30, preco: 2990, nome: 'Assinatura mensal' },
  anual: { dias: 365, preco: 29700, lancamento: 14850, nome: 'Assinatura anual' }
};
const API = 'https://api.checkout.infinitepay.io';

export default {
  // Todo dia (cron no wrangler.toml): avisos de vencimento e o e-mail da semana do alerta grátis.
  async scheduled(evento, env, ctx) {
    // 12h UTC: avisos de vencimento. Aos 30 de cada hora: um lote do alerta grátis da semana (o plano grátis da
    // Cloudflare deixa só 50 chamadas externas por execução, então manda poucos de cada vez).
    ctx.waitUntil(evento.cron === '0 12 * * *' ? avisarVencimentos(env).then(() => conferirEstornos(env)).then(() => pesquisaDezDias(env)) : semanal(env));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsDe(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method === 'POST' && url.pathname === '/checkout') return json(await checkout(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(await req.json(), env);
      if (req.method === 'GET' && url.pathname === '/precos') return json(await precos(url.searchParams.get('email'), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/codigo') return json(await pedirCodigo(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/entrar') return json(await entrar(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/alertas') return json(await guardarAlertas(req, env));
      if (req.method === 'GET' && url.pathname === '/alertas') return json(await estadoAlertas(env));
      if (req.method === 'GET' && url.pathname === '/voos') return json(await buscarVoos(req, url, env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/evento') return json(await evento(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/lead') return json(await novoLead(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/lead/perfil') return json(await perfilLead(await req.json(), env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/sair') return await sairLead(url, env);
      if (req.method === 'GET' && url.pathname === '/indicacao') return json(await minhaIndicacao(req, env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/metricas') return json(await metricas(req, url, env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/depoimentos') return json(await depoimentosPublicos(env), 200, { ...cors, 'cache-control': 'public, max-age=300' });
      if (req.method === 'GET' && url.pathname === '/depoimento') return json(await meuDepoimento(req, env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/depoimento') return json(await gravarDepoimento(req, env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/depoimentos/todos') return json(await todosDepoimentos(req, env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/assinantes') return json(await listaAssinantes(req, env), 200, cors);
      if (req.method === 'GET' && url.pathname === '/assinante/conferir') return json(await conferirUm(req, url, env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/assinante/cancelar') return json(await cancelarAssinante(req, env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/depoimento/moderar') return json(await moderarDepoimento(req, env), 200, cors);
      return json({ erro: 'não encontrado' }, 404, cors);
    } catch (e) {
      return json({ erro: e.message || 'erro' }, e.status || 500, cors);
    }
  }
};

function corsDe(req, env) {
  const origem = req.headers.get('origin') || '';
  const ok = env.ORIGENS.split(',').map(s => s.trim()).includes(origem);
  return ok ? { 'access-control-allow-origin': origem, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type,authorization', vary: 'origin' } : {};
}
const json = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...extra } });
const falha = (msg, status = 400) => Object.assign(new Error(msg), { status });
// WhatsApp opcional: só números, com DDI 55 na frente (o site pede com DDD).
const telefoneValido = t => {
  let n = String(t || '').replace(/\D/g, '');
  if (n.length === 10 || n.length === 11) n = `55${n}`;
  return /^55\d{10,11}$/.test(n) ? n : '';
};
const emailValido = e => typeof e === 'string' && e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// O primeiro ano anual sai pelo preço de lançamento; quem já teve um anual renova pelo cheio.
async function precoDe(plano, email, env) {
  const p = PLANOS[plano];
  if (plano !== 'anual') return p.preco;
  const a = await lerDoc(env, `assinantes/${email}`);
  return a && a.teveAnual ? p.preco : p.lancamento;
}

async function precos(email, env) {
  email = (email || '').trim().toLowerCase();
  const anual = emailValido(email) ? await precoDe('anual', email, env) : PLANOS.anual.lancamento;
  return { mensal: PLANOS.mensal.preco, anual, anualCheio: PLANOS.anual.preco };
}

async function checkout(body, env) {
  const plano = body && body.plano;
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!PLANOS[plano]) throw falha('Plano inválido.');
  if (!emailValido(email)) throw falha('E-mail inválido.');
  const preco = await precoDe(plano, email, env);
  const nsu = `${plano}-${crypto.randomUUID()}`;
  const origem = origemValida(body.origem), ref = /^[0-9a-f]{8}$/.test(body.ref || '') ? body.ref : '';
  const telefone = telefoneValido(body.telefone);
  await gravarDoc(env, `pedidos/${nsu}`, { email, plano, preco, status: 'criado', criadoEm: new Date(), origem, ref, telefone });
  await somar(env, `metricas/${hojeBR()}`, { [`checkout_${origem}`]: 1 }).catch(() => {});
  const r = await fetch(`${API}/links`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': env.INFINITEPAY_API_KEY },
    body: JSON.stringify({
      handle: env.HANDLE,
      items: [{ quantity: 1, price: preco, description: `${PLANOS[plano].nome} · Onde as Milhas Me Levam` }],
      order_nsu: nsu,
      redirect_url: `${env.SITE}?pagamento=ok`,
      webhook_url: `${new URL('/webhook', env.SELF).href}`,
      customer: { email },
      options: { assured_installments: 0, single_payment: true }
    })
  });
  const d = await r.json().catch(() => ({}));
  const link = d.url || d.link || d.checkout_url || (d.data && (d.data.url || d.data.link));
  if (!r.ok || !link) throw falha('Não deu para abrir o pagamento agora. Tente de novo em instantes.', 502);
  return { url: link };
}

async function webhook(b, env) {
  const nsu = b && b.order_nsu;
  if (!nsu || !b.transaction_nsu || !b.invoice_slug) return json({ ok: false }, 400);
  const pedido = await lerDoc(env, `pedidos/${nsu}`);
  if (!pedido) return json({ ok: false }, 400);
  if (pedido.status === 'pago') return json({ ok: true });
  // O aviso não vem assinado: confirma direto com a InfinitePay antes de liberar.
  const r = await fetch(`${API}/payment_check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': env.INFINITEPAY_API_KEY },
    body: JSON.stringify({ handle: env.HANDLE, order_nsu: nsu, transaction_nsu: b.transaction_nsu, slug: b.invoice_slug })
  });
  const c = await r.json().catch(() => ({}));
  if (!c.success || !c.paid || Number(c.amount) < pedido.preco) return json({ ok: false }, 400);

  const plano = PLANOS[pedido.plano];
  const atual = await lerDoc(env, `assinantes/${pedido.email}`);
  const base = Math.max(Date.now(), atual && atual.validoAte ? atual.validoAte.getTime() : 0);
  await gravarDoc(env, `assinantes/${pedido.email}`, {
    email: pedido.email,
    plano: pedido.plano,
    validoAte: new Date(base + plano.dias * 864e5),
    teveAnual: Boolean((atual && atual.teveAnual) || pedido.plano === 'anual'),
    telefone: pedido.telefone || (atual && atual.telefone) || '',
    primeiroPagamento: (atual && atual.primeiroPagamento) || new Date(),
    pesquisaEm: (atual && atual.pesquisaEm) || null,
    atualizadoEm: new Date()
  });
  await gravarDoc(env, `pedidos/${nsu}`, {
    ...pedido, status: 'pago', pagoEm: new Date(), transacao: b.transaction_nsu, slug: b.invoice_slug,
    parcelas: c.installments || 1, forma: c.capture_method || '', recibo: b.receipt_url || ''
  });
  const origem = origemValida(pedido.origem);
  await somar(env, `metricas/${hojeBR()}`, { [`pago_${origem}`]: 1, [`receita_${origem}`]: pedido.preco, [`pago_${pedido.plano}`]: 1 }).catch(() => {});
  if (pedido.ref && !atual) await premiarIndicacao(env, pedido.ref, pedido.email).catch(e => console.log('indicação:', e.message));
  return json({ ok: true });
}

// ---- Entrada por código de 7 números ----
const CODIGO_VALE_MIN = 10;
const TENTATIVAS = 5;
const sha256 = async t => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map(b => b.toString(16).padStart(2, '0')).join('');

// Só manda código para quem tem (ou já teve) assinatura; a resposta é a mesma nos dois casos.
async function pedirCodigo(body, env) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!emailValido(email)) throw falha('E-mail inválido.');
  const resposta = { ok: true, minutos: CODIGO_VALE_MIN };
  if (!(await lerDoc(env, `assinantes/${email}`))) return resposta;
  const antigo = await lerDoc(env, `codigos/${email}`);
  if (antigo && Date.now() - antigo.criadoEm.getTime() < 60e3) throw falha('Espere 1 minuto para pedir outro código.', 429);
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1e7;
  const codigo = String(n).padStart(7, '0');
  await gravarDoc(env, `codigos/${email}`, { hash: await sha256(`${email}:${codigo}`), criadoEm: new Date(), tentativas: 0 });
  if (usaGmail(env)) {
    const ok = await gmailEnviar(env, email, `Seu código de entrada: ${codigo}`,
      `Use este código para entrar no Onde as Milhas Me Levam:<br><br><span style="font-size:32px;font-weight:bold;letter-spacing:6px;color:#0c1426;">${codigo}</span><br><br>Ele vale por ${CODIGO_VALE_MIN} minutos. Se não foi você que pediu, é só ignorar este e-mail.`).catch(() => false);
    if (!ok) throw falha('Não deu para mandar o código agora. Tente de novo em instantes.', 502);
    await contarEmail(env);
    return resposta;
  }
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: env.EMAILJS_SERVICE, template_id: env.EMAILJS_TEMPLATE, user_id: env.EMAILJS_PUBLIC, accessToken: env.EMAILJS_PRIVATE_KEY,
      template_params: { email, codigo, minutos: CODIGO_VALE_MIN }
    })
  });
  if (!r.ok) throw falha('Não deu para mandar o código agora. Tente de novo em instantes.', 502);
  await contarEmail(env);
  return resposta;
}

async function entrar(body, env) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  const codigo = String((body && body.codigo) || '').replace(/\D/g, '');
  const erro = () => falha('Código errado ou vencido. Confira ou peça um novo.', 401);
  if (!emailValido(email) || codigo.length !== 7) throw erro();
  const c = await lerDoc(env, `codigos/${email}`);
  if (!c || c.tentativas >= TENTATIVAS || Date.now() - c.criadoEm.getTime() > CODIGO_VALE_MIN * 60e3) throw erro();
  if (c.hash !== await sha256(`${email}:${codigo}`)) {
    await gravarDoc(env, `codigos/${email}`, { ...c, tentativas: c.tentativas + 1 });
    throw erro();
  }
  await apagarDoc(env, `codigos/${email}`);
  return { token: await tokenDeEntrada(email, env) };
}

// Acha (ou cria) o usuário do Firebase com este e-mail já verificado e assina um token para ele.
async function tokenDeEntrada(email, env) {
  const base = `https://identitytoolkit.googleapis.com/v1/projects/${env.PROJETO}`;
  const cab = { authorization: `Bearer ${await token(env)}`, 'content-type': 'application/json' };
  const l = await (await fetch(`${base}/accounts:lookup`, { method: 'POST', headers: cab, body: JSON.stringify({ email: [email] }) })).json();
  let uid = l.users && l.users[0] && l.users[0].localId;
  if (!uid) {
    const n = await (await fetch(`${base}/accounts`, { method: 'POST', headers: cab, body: JSON.stringify({ email, emailVerified: true }) })).json();
    uid = n.localId;
  } else if (!l.users[0].emailVerified) {
    await fetch(`${base}/accounts:update`, { method: 'POST', headers: cab, body: JSON.stringify({ localId: uid, emailVerified: true }) });
  }
  if (!uid) throw falha('Não deu para entrar agora.', 500);
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const agora = Math.floor(Date.now() / 1000);
  return assinarJwt(sa, {
    iss: sa.client_email, sub: sa.client_email, uid, iat: agora, exp: agora + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit'
  });
}

// ---- Firestore e Auth pela API REST, com a conta de serviço (passa por cima das regras) ----
const b64 = o => btoa(typeof o === 'string' ? unescape(encodeURIComponent(o)) : String.fromCharCode(...new Uint8Array(o))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function assinarJwt(sa, corpo) {
  const dados = `${b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64(JSON.stringify(corpo))}`;
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), ch => ch.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return `${dados}.${b64(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(dados)))}`;
}
let tokenCache = { valor: '', expira: 0 };
async function token(env) {
  if (tokenCache.valor && Date.now() < tokenCache.expira) return tokenCache.valor;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const agora = Math.floor(Date.now() / 1000);
  const jwt = await assinarJwt(sa, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const d = await r.json();
  if (!d.access_token) throw falha('Sem acesso ao banco.', 500);
  tokenCache = { valor: d.access_token, expira: Date.now() + 50 * 60e3 };
  return d.access_token;
}
const docUrl = (env, caminho) => `https://firestore.googleapis.com/v1/projects/${env.PROJETO}/databases/(default)/documents/${caminho.split('/').map(encodeURIComponent).join('/')}`;

function paraFs(v) {
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Number.isInteger(v)) return { integerValue: String(v) };
  if (typeof v === 'number') return { doubleValue: v };
  return { stringValue: String(v ?? '') };
}
function deFs(f) {
  if ('timestampValue' in f) return new Date(f.timestampValue);
  if ('booleanValue' in f) return f.booleanValue;
  if ('integerValue' in f) return Number(f.integerValue);
  if ('doubleValue' in f) return f.doubleValue;
  return f.stringValue ?? null;
}
/* ---------- disponibilidade em milhas (seats.aero) ---------- */
// Só para assinantes: confere o token do Firebase (login do site) e a validade da assinatura.
// Cada resposta fica 30 minutos no cache do Cloudflare, para poupar o limite de 1.000 consultas por dia.
const FIREBASE_JWK = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
async function assinanteDoToken(req, env) {
  const email = await emailDoToken(req, env);
  if (!email) return null;
  const a = await lerDoc(env, `assinantes/${email}`);
  return a && a.validoAte instanceof Date && a.validoAte.getTime() > Date.now() ? email : null;
}
const IATA = t => /^[A-Z]{3}(,[A-Z]{3}){0,4}$/.test(t || '');
const DATA = t => /^\d{4}-\d{2}-\d{2}$/.test(t || '');
async function buscarVoos(req, url, env) {
  if (!env.SEATS_AERO_KEY) throw falha('Busca de disponibilidade ainda não ligada.', 503);
  if (!await assinanteDoToken(req, env).catch(() => null)) throw falha('Busca exclusiva para assinantes. Entre com o e-mail da assinatura.', 401);
  const origem = (url.searchParams.get('origem') || '').toUpperCase(), destino = (url.searchParams.get('destino') || '').toUpperCase();
  const de = url.searchParams.get('de'), ate = url.searchParams.get('ate');
  const cabine = { eco: 'economy', premium: 'premium', exe: 'business', primeira: 'first' }[url.searchParams.get('cabine')] || '';
  if (!IATA(origem) || !IATA(destino) || !DATA(de) || !DATA(ate)) throw falha('Informe origem, destino (códigos de aeroporto) e as datas.');
  if ((Date.parse(ate) - Date.parse(de)) / 864e5 > 62 || Date.parse(ate) < Date.parse(de)) throw falha('Escolha um intervalo de até 2 meses.');
  const q = new URLSearchParams({ origin_airport: origem, destination_airport: destino, start_date: de, end_date: ate, take: '500' });
  if (cabine) q.set('cabins', cabine);
  const alvo = `https://seats.aero/partnerapi/search?${q}`;
  const cache = caches.default, chaveCache = new Request(alvo);
  let r = await cache.match(chaveCache);
  if (!r) {
    const resp = await fetch(alvo, { headers: { 'Partner-Authorization': env.SEATS_AERO_KEY, accept: 'application/json' } });
    if (resp.status === 429) throw falha('Muitas buscas hoje. Tente de novo mais tarde.', 429);
    if (!resp.ok) throw falha('A busca de disponibilidade não respondeu agora. Tente de novo em instantes.', 502);
    r = new Response(await resp.text(), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=1800' } });
    await cache.put(chaveCache, r.clone());
  }
  const d = await r.json();
  const CABS = [['Y', 'eco'], ['W', 'premium'], ['J', 'exe'], ['F', 'primeira']];
  const voos = (d.data || []).map(v => ({
    data: v.Date, programa: v.Source, origem: v.Route && v.Route.OriginAirport, destino: v.Route && v.Route.DestinationAirport, distancia: v.Route && v.Route.Distance,
    cabines: Object.fromEntries(CABS.filter(([L]) => v[`${L}Available`]).map(([L, nome]) => [nome, {
      milhas: Number(v[`${L}MileageCost`]) || null, assentos: v[`${L}RemainingSeats`] || null, cias: v[`${L}Airlines`] || '', direto: !!v[`${L}Direct`] }]))
  })).filter(v => Object.keys(v.cabines).length);
  return { voos, atualizado: new Date().toISOString() };
}

// Datas e link de cada passagem, mandados pelo plantão do GitHub (ferramentas/alertas.py).
// Ficam em privado/alertas, que as regras só abrem para assinatura ativa.
// Sem senha combinada: o GitHub assina um token (OIDC) para cada execução, e aqui se confere
// que veio do plantão de alertas deste repositório, no main.
const GITHUB_OIDC = 'https://token.actions.githubusercontent.com';
const REPO = 'ondeasmilhasmelevam/ondeasmilhasmelevam.github.io';
async function doPlantao(req, env) {
  const [h, c, s] = (req.headers.get('authorization') || '').replace(/^Bearer /, '').split('.');
  if (!s) return false;
  const ler = t => JSON.parse(atob(t.replace(/-/g, '+').replace(/_/g, '/')));
  const cab = ler(h), corpo = ler(c);
  const { keys } = await (await fetch(`${GITHUB_OIDC}/.well-known/jwks`)).json();
  const jwk = keys.find(k => k.kid === cab.kid);
  if (!jwk || cab.alg !== 'RS256') return false;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const assinatura = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, assinatura, new TextEncoder().encode(`${h}.${c}`));
  return ok && corpo.iss === GITHUB_OIDC && corpo.aud === env.SELF && corpo.exp * 1000 > Date.now() &&
    corpo.repository === REPO && corpo.ref === 'refs/heads/main' &&
    String(corpo.workflow_ref || '').startsWith(`${REPO}/.github/workflows/alertas.yml@`);
}
async function guardarAlertas(req, env) {
  if (!await doPlantao(req, env).catch(() => false)) throw falha('sem permissão', 401);
  const texto = await req.text();
  if (texto.length > 900e3) throw falha('grande demais', 413);
  const completos = JSON.parse(texto);
  if (!completos || typeof completos !== 'object' || Array.isArray(completos)) throw falha('formato errado');
  const antes = await lerDoc(env, 'privado/alertas').catch(() => null);
  const conhecidos = new Set(antes ? Object.keys(JSON.parse(antes.json)) : []);
  await gravarDoc(env, 'privado/alertas', { json: texto, atualizadoEm: new Date() });
  // Na primeira carga não há "novas": tudo já estava no ar antes do radar existir.
  const novas = antes ? Object.entries(completos).filter(([id]) => !conhecidos.has(id)).map(([id, p]) => ({ id, ...p })) : [];
  const radar = await rodarRadar(env, novas, completos).catch(e => ({ erro: e.message }));
  return { ok: true, itens: Object.keys(completos).length, novas: novas.length, radar };
}

/* ---------- e-mail (modelo "mensagem" do EmailJS: assunto e corpo vêm daqui) ---------- */
const escHtml = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const botaoEmail = (texto, link) => `<a href="${escHtml(link)}" style="display:inline-block;padding:12px 22px;border-radius:999px;background:#e2b458;color:#1b1406;font-weight:bold;text-decoration:none;">${escHtml(texto)}</a>`;
// Gmail da marca: troca o refresh token por um token de acesso (vale 1 h) e manda pela API do Gmail.
const usaGmail = env => !!(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
let gmailCache = { token: '', ate: 0 };
async function gmailToken(env) {
  if (gmailCache.ate > Date.now() + 60e3) return gmailCache.token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID, client_secret: env.GMAIL_CLIENT_SECRET, refresh_token: env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' })
  });
  const d = await r.json();
  if (!r.ok || !d.access_token) throw falha('Gmail recusou a chave.', 502);
  gmailCache = { token: d.access_token, ate: Date.now() + (d.expires_in || 3600) * 1000 };
  return d.access_token;
}
const b64utf8 = t => btoa(unescape(encodeURIComponent(t)));
const layoutEmail = corpo => `<div style="background:#f3eee3;padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6dcc6;">
    <div style="background:#0c1426;padding:18px 24px;color:#e2b458;font-weight:bold;letter-spacing:3px;font-size:13px;">ONDE AS MILHAS ME LEVAM</div>
    <div style="padding:24px;color:#1b2335;font-size:15px;line-height:1.6;">${corpo}</div>
  </div>
  <p style="max-width:560px;margin:12px auto 0;color:#8a8f9c;font-size:12px;text-align:center;">ondeasmilhasmelevam.com.br</p>
</div>`;
async function gmailEnviar(env, para, assunto, html) {
  const remetente = env.GMAIL_REMETENTE || 'ondeasmilhasmelevam@gmail.com';
  const mime = [`From: =?UTF-8?B?${b64utf8('Onde as Milhas Me Levam')}?= <${remetente}>`, `To: ${para}`, `Subject: =?UTF-8?B?${b64utf8(assunto)}?=`,
    'MIME-Version: 1.0', 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64utf8(layoutEmail(html))].join('\r\n');
  const raw = btoa(mime).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST', headers: { authorization: `Bearer ${await gmailToken(env)}`, 'content-type': 'application/json' }, body: JSON.stringify({ raw })
  });
  return r.ok;
}

async function enviarEmail(env, email, assunto, corpo) {
  if (usaGmail(env)) {
    const ok = await gmailEnviar(env, email, assunto, corpo).catch(() => false);
    if (ok) await contarEmail(env);
    return ok;
  }
  const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      service_id: env.EMAILJS_SERVICE, template_id: env.EMAILJS_TEMPLATE_MSG, user_id: env.EMAILJS_PUBLIC, accessToken: env.EMAILJS_PRIVATE_KEY,
      template_params: { email, assunto, corpo }
    })
  });
  if (r.ok) await contarEmail(env);
  return r.ok;
}

/* ---------- Meu Radar ---------- */
// Cada assinante guarda até 5 rotas em radares/{email} (lista em JSON). A cada carga de passagens
// novas, as que batem entram na fila dele (radarFila/{email}); a fila vira um e-mail no máximo
// a cada 3 horas, para não lotar a caixa nem estourar o limite do EmailJS.
const RADAR_INTERVALO = 3 * 3600e3, RADAR_MAX_FILA = 30, RADAR_MAX_EMAIL = 12;
const normR = t => String(t ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
const milhasDe = t => { const m = /(\d{1,3}(?:\.\d{3})+|\d+)/.exec(t || ''); return m ? Number(m[1].replace(/\./g, '')) : Infinity; };
const ehExecutiva = c => /EXECUT|PRIMEIRA|FIRST|BUSINESS|PREMIUM/.test(normR(c));
function bateRadar(r, p) {
  const lugar = (filtro, nome, iata) => !filtro || normR(`${nome} ${iata}`).includes(normR(filtro));
  return lugar(r.origem, p.origem, p.origem_iata) && lugar(r.destino, p.destino, p.destino_iata) &&
    (!r.cabine || (r.cabine === 'exe') === ehExecutiva(p.cabine)) &&
    (!r.programa || normR(p.programa).includes(normR(r.programa))) &&
    (!r.maxMilhas || milhasDe(p.ida) <= r.maxMilhas);
}
async function listarDocs(env, colecao) {
  const docs = [];
  let pagina = '';
  do {
    const r = await fetch(`${docUrl(env, colecao)}?pageSize=300${pagina ? `&pageToken=${pagina}` : ''}`, { headers: { authorization: `Bearer ${await token(env)}` } });
    if (!r.ok) throw falha(`Erro ao listar ${colecao}.`, 500);
    const d = await r.json();
    for (const doc of d.documents || []) {
      docs.push({ id: decodeURIComponent(doc.name.split('/').pop()), ...Object.fromEntries(Object.entries(doc.fields || {}).map(([k, v]) => [k, deFs(v)])) });
    }
    pagina = d.nextPageToken || '';
  } while (pagina);
  return docs;
}
function passagemEmail(p) {
  const datas = l => (l || []).map(d => `${escHtml(d.mes)} ${escHtml(d.dias)}`).join(' · ');
  return `<div style="margin:0 0 16px;padding:12px 14px;border:1px solid #e5e2d8;border-radius:12px;">
    <strong style="font-size:16px;">${escHtml(p.origem_iata)} ${escHtml(p.origem)} → ${escHtml(p.destino_iata)} ${escHtml(p.destino)}</strong><br>
    ${escHtml([p.companhia, p.programa, p.cabine].filter(Boolean).join(' · '))}<br>
    Ida: <strong>${escHtml(p.ida)}</strong>${p.volta ? ` · Volta: <strong>${escHtml(p.volta)}</strong>` : ''}<br>
    ${p.datas_ida && p.datas_ida.length ? `Datas de ida: ${datas(p.datas_ida)}<br>` : ''}${p.datas_volta && p.datas_volta.length ? `Datas de volta: ${datas(p.datas_volta)}<br>` : ''}
    ${p.link ? `<a href="${escHtml(p.link)}" style="color:#a8761f;font-weight:bold;">Ver passagem${p.link_nome ? ` na ${escHtml(p.link_nome)}` : ''} →</a>` : ''}
  </div>`;
}
async function rodarRadar(env, novas, completos) {
  const radares = await listarDocs(env, 'radares');
  if (!radares.length) return { radares: 0 };
  const filas = new Map((await listarDocs(env, 'radarFila')).map(f => [f.id, f]));
  const agora = Date.now();
  let enviados = 0;
  for (const rad of radares) {
    let lista = [];
    try { lista = JSON.parse(rad.lista || '[]'); } catch (e) { continue; }
    const fila = filas.get(rad.id) || {};
    let ids = [];
    try { ids = JSON.parse(fila.ids || '[]'); } catch (e) { ids = []; }
    const batem = novas.filter(p => lista.some(r => bateRadar(r, p))).map(p => p.id);
    ids = [...new Set([...ids, ...batem])].filter(id => completos[id]).slice(-RADAR_MAX_FILA);
    const ultimo = fila.ultimo instanceof Date ? fila.ultimo.getTime() : 0;
    if (ids.length && agora - ultimo >= RADAR_INTERVALO) {
      const ass = await lerDoc(env, `assinantes/${rad.id}`);
      if (ass && ass.validoAte instanceof Date && ass.validoAte.getTime() > agora) {
        const itens = ids.slice(-RADAR_MAX_EMAIL).reverse().map(id => completos[id]);
        const corpo = `Olá! O seu radar achou ${ids.length === 1 ? 'uma passagem nova' : `${ids.length} passagens novas`}:<br><br>${itens.map(passagemEmail).join('')}
          Disponibilidade muda rápido: confira no site do programa antes de transferir pontos.<br><br>${botaoEmail('Ver no site', `${env.SITE}#radar`)}`;
        if (await enviarEmail(env, rad.id, `Meu Radar: ${ids.length === 1 ? '1 passagem nova' : `${ids.length} passagens novas`}`, corpo)) {
          await gravarDoc(env, `radarFila/${rad.id}`, { ids: '[]', ultimo: new Date() });
          enviados++;
          continue;
        }
      } else ids = [];
    }
    if (batem.length || ids.length !== JSON.parse(fila.ids || '[]').length) await gravarDoc(env, `radarFila/${rad.id}`, { ids: JSON.stringify(ids), ultimo: fila.ultimo instanceof Date ? fila.ultimo : new Date(0) });
  }
  return { radares: radares.length, enviados };
}

// Só para conferir se o plantão está entregando: quando chegou e quantas passagens (sem o conteúdo).
async function estadoAlertas(env) {
  const d = await lerDoc(env, 'privado/alertas');
  const todos = d ? Object.values(JSON.parse(d.json)) : [];
  return { atualizadoEm: d ? d.atualizadoEm : null, itens: todos.length, comRota: todos.filter(p => p.destino_iata).length };
}

// Avisos de vencimento: 7 dias antes, 1 dia antes e 3 dias depois de vencer (a assinatura não renova
// sozinha). Cada aviso sai uma vez por validade: "avisos" guarda "validade|etapa" dos já mandados.
// O mensal recebe a conta do anual, que sai bem mais barato por mês.
const ETAPAS_AVISO = [[7, 1], [1, 0], [-3, -10]]; // [até quantos dias antes, mais de quantos dias antes]
async function avisarVencimentos(env) {
  const agora = Date.now(), enviados = [];
  const numeros = await numerosDoSite(env);
  for (const a of await listarDocs(env, 'assinantes')) {
    const vence = a.validoAte instanceof Date ? a.validoAte.getTime() : NaN;
    if (!emailValido(a.email) || !(vence > 0)) continue;
    const dias = (vence - agora) / 864e5;
    const etapa = ETAPAS_AVISO.find(([ate, depois]) => dias <= ate && dias > depois);
    if (!etapa) continue;
    const feitos = String(a.avisos || '').split(',').filter(Boolean);
    if (a.avisoPara === a.validoAte.toISOString()) feitos.push(`${a.avisoPara}|7`); // aviso antigo, de 3 dias
    const chave = `${a.validoAte.toISOString()}|${etapa[0]}`;
    if (feitos.includes(chave)) continue;
    const data = a.validoAte.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const venceu = dias <= 0, n = Math.max(1, Math.ceil(Math.abs(dias)));
    const resumo = numeros && numeros.passagens
      ? `Nos últimos 30 dias apareceram no site <strong>${numeros.passagens} passagens com milhas</strong> e <strong>${numeros.promocoes} promoções</strong>, todas com as datas e o link de emissão na hora para quem assina.<br><br>` : '';
    let anual = '';
    if (a.plano !== 'anual') {
      const preco = await precoDe('anual', a.email, env);
      anual = `<strong>Dica:</strong> no plano anual sai por ${reaisEmail(preco)} (${reaisEmail(Math.round(preco / 12))} por mês em 12x), contra ${reaisEmail(PLANOS.mensal.preco)} todo mês no mensal.<br><br>`;
    }
    const corpo = `Olá!<br><br>${venceu
      ? `Sua assinatura do Onde as Milhas Me Levam venceu em <strong>${data}</strong>. Desde então, as datas e os links das passagens ficaram fechados para você.`
      : `Sua assinatura do Onde as Milhas Me Levam vence em <strong>${data}</strong>, daqui a ${n} ${n === 1 ? 'dia' : 'dias'}. Ela não renova sozinha.`}<br><br>
      ${resumo}${anual}Para continuar com tudo, é só renovar pelo site com este mesmo e-mail:<br><br>
      ${botaoEmail(venceu ? 'Voltar a assinar' : 'Renovar minha assinatura', `${env.SITE}?utm_source=email&utm_campaign=renovacao#assinar`)}<br><br>Se você já renovou, pode ignorar esta mensagem.`;
    const assunto = venceu ? 'Sua assinatura venceu: as passagens continuam aparecendo'
      : `Sua assinatura vence em ${n} ${n === 1 ? 'dia' : 'dias'}`;
    if (!await enviarEmail(env, a.email, assunto, corpo)) continue; // tenta de novo amanhã
    await atualizarCampos(env, `assinantes/${a.id}`, { avisos: [...feitos, chave].slice(-6).join(',') });
    enviados.push(a.email);
  }
  console.log(`avisos de vencimento: ${enviados.length}`);
  return enviados.length;
}
const reaisEmail = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
let numerosCache = { d: null, ate: 0 };
async function numerosDoSite(env) {
  if (numerosCache.ate > Date.now()) return numerosCache.d;
  try { numerosCache = { d: await (await fetch(`${env.SITE}dados/numeros.json`, { cf: { cacheTtl: 600 } })).json(), ate: Date.now() + 600e3 }; } catch (e) { return null; }
  return numerosCache.d;
}

/* ---------- Funil: contadores por dia e por origem (metricas/{AAAA-MM-DD}) ---------- */
const EVENTOS = new Set(['visita', 'assinar_ver', 'assinar_clique', 'gratis_ver', 'perfil']);
const origemValida = o => (/^[a-z0-9]{1,20}$/.test(o || '') ? o : 'direto');
const hojeBR = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
async function somar(env, caminho, campos) {
  const nome = `projects/${env.PROJETO}/databases/(default)/documents/${caminho}`;
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${env.PROJETO}/databases/(default)/documents:commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await token(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ writes: [{ transform: { document: nome, fieldTransforms: Object.entries(campos).map(([f, n]) => ({ fieldPath: f, increment: { integerValue: String(n) } })) } }] })
  });
  if (!r.ok) throw falha('Erro ao somar.', 500);
}
async function evento(body, env) {
  const e = body && body.e;
  if (!EVENTOS.has(e)) throw falha('evento desconhecido');
  await somar(env, `metricas/${hojeBR()}`, { [`${e}_${origemValida(body.o)}`]: 1 });
  return { ok: true };
}

/* ---------- Limite do EmailJS (200 por mês no plano grátis) ---------- */
// Código de entrada, avisos e Meu Radar vêm antes: o e-mail do alerta grátis só sai até COTA_LEADS.
const COTA_LEADS = 150;
// Pelo Gmail o limite é por dia (uns 500): a cota do mês fica alta; LOTE_SEMANAL por hora dá no máximo ~220 por dia.
const LOTE_SEMANAL = 9;
const cotaLeads = env => (usaGmail(env) ? 12000 : COTA_LEADS);
const mesBR = () => hojeBR().slice(0, 7);
const contarEmail = env => somar(env, `metricas/emails-${mesBR()}`, { enviados: 1 }).catch(() => {});
async function emailsDoMes(env) {
  const d = await lerDoc(env, `metricas/emails-${mesBR()}`).catch(() => null);
  return (d && d.enviados) || 0;
}

/* ---------- Alerta grátis da semana (leads/{email}) ---------- */
const hmac = async (env, texto) => {
  const chave = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.EMAILJS_PRIVATE_KEY || env.PROJETO), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(texto)))].map(b => b.toString(16).padStart(2, '0')).join('');
};
const linkSair = async (env, email) => `${new URL('/sair', env.SELF).href}?e=${encodeURIComponent(email)}&t=${(await hmac(env, `sair:${email}`)).slice(0, 24)}`;
function destaquesEmail(lista, env) {
  const nivel = n => (n ? ` · <span style="color:#a8761f;font-weight:bold;">${escHtml(n)} no termômetro</span>` : '');
  const foto = d => (/^img\/rotas\/[A-Z]{3}-[A-Z]{3}\.jpg$/.test(d.foto || '')
    ? `<img src="${escHtml(env.SITE + d.foto)}" width="512" alt="${escHtml(`${d.origem} e ${d.destino}`)}" style="display:block;width:100%;max-width:512px;height:auto;border:0;border-radius:12px 12px 0 0;">` : '');
  const grupo = d => (/^(Nacional|Internacional|Executiva)$/.test(d.grupo || '')
    ? `<span style="display:inline-block;margin:0 0 6px;padding:2px 9px;border-radius:999px;background:${d.grupo === 'Executiva' ? '#efe6ff;color:#6b3fb5' : '#f6ecd6;color:#8a6116'};font-size:11px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">${d.grupo}</span><br>` : '');
  return (lista || []).map(d => `<div style="margin:0 0 14px;border:1px solid #e5e2d8;border-radius:12px;overflow:hidden;">${foto(d)}<div style="padding:12px 14px;">
    ${grupo(d)}<strong style="font-size:16px;">${escHtml(d.origem)} (${escHtml(d.origem_iata)}) → ${escHtml(d.destino)} (${escHtml(d.destino_iata)})</strong><br>
    A partir de <strong>${Number(d.milhas).toLocaleString('pt-BR')} milhas</strong> + taxas o trecho · ${escHtml([d.programa, d.cabine].filter(Boolean).join(' · '))}${nivel(d.nivel)}<br>
    <span style="color:#777;">Datas e link de emissão: só para assinantes</span>
  </div></div>`).join('');
}
async function emailDaSemana(env, email, primeiro, lead = null) {
  const n = await numerosDoSite(env);
  const semana = (n && n.semana) || {};
  const geral = (semana.destaques && semana.destaques.length ? semana.destaques : (n && n.destaques) || []).slice(0, 5);
  const { lista, aero } = paraOLead(semana, geral, lead);
  if (!lista.length) return false;
  const assinar = `${env.SITE}?utm_source=email&utm_campaign=semanal#assinar`;
  const corpo = `Olá!<br><br>${primeiro ? 'Pronto, você vai receber toda semana as melhores passagens com milhas que apareceram no site. Para começar, ' : ''}${semana.passagens
      ? `nos últimos 7 dias apareceram <strong>${semana.passagens} passagens com milhas</strong>. ${aero.length ? `Separamos primeiro as que saem de ${escHtml(aero.join(', '))}:` : 'Algumas das melhores:'}` : 'algumas das melhores passagens com milhas dos últimos dias:'}<br><br>
    ${destaquesEmail(lista, env)}
    Passagem boa some em horas. Quem assina vê cada uma na hora em que ela aparece, com todas as datas e o link direto para emitir, e ainda recebe o Meu Radar com as rotas que escolher.<br><br>
    ${botaoEmail('Ver os planos', assinar)}<br><br>
    <span style="color:#777;font-size:12px;">Você recebe este e-mail porque pediu o alerta grátis no site Onde as Milhas Me Levam. <a href="${escHtml(await linkSair(env, email))}" style="color:#777;">Não quero mais receber</a>.</span>`;
  return enviarEmail(env, email, primeiro ? 'Seu alerta grátis de passagens com milhas' : `As melhores passagens com milhas da semana`, corpo);
}
async function novoLead(body, env) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!emailValido(email)) throw falha('Digite um e-mail válido.');
  if (body.aceite !== true) throw falha('Marque que aceita receber o e-mail.');
  const antes = await lerDoc(env, `leads/${email}`);
  const chave = (await hmac(env, `perfil:${email}`)).slice(0, 24);  // libera as perguntas de personalização deste e-mail
  if (antes && antes.ativo) return { ok: true, ja: true, chave };
  const origem = origemValida(body.origem);
  const lead = { email, origem, ativo: true, criadoEm: (antes && antes.criadoEm) || new Date(), ultimoEnvio: new Date(0) };
  await gravarDoc(env, `leads/${email}`, lead);
  await somar(env, `metricas/${hojeBR()}`, { [`lead_${origem}`]: 1 }).catch(() => {});
  if (await emailsDoMes(env) < cotaLeads(env) && await emailDaSemana(env, email, true)) await atualizarCampos(env, `leads/${email}`, { ultimoEnvio: new Date() });
  return { ok: true, chave };
}

// Perguntas depois do cadastro: de onde sai, para onde quer ir, onde tem pontos e como prefere voar.
const REGIOES_LEAD = ['brasil', 'america-do-sul', 'america-do-norte', 'caribe', 'europa', 'qualquer'];
const PROGRAMAS_LEAD = ['livelo', 'esfera', 'smiles', 'latam', 'azul', 'tap', 'avios', 'nenhum'];
const lista = (v, ok, max) => [...new Set((Array.isArray(v) ? v : []).map(x => String(x).trim()).filter(ok))].slice(0, max);
async function perfilLead(body, env) {
  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!emailValido(email) || body.chave !== (await hmac(env, `perfil:${email}`)).slice(0, 24)) throw falha('Cadastre o e-mail primeiro.', 403);
  if (!(await lerDoc(env, `leads/${email}`))) throw falha('Cadastre o e-mail primeiro.', 404);
  const aeroportos = lista(body.aeroportos, x => /^[A-Z]{3}$/.test(x), 8);
  const regioes = lista(body.regioes, x => REGIOES_LEAD.includes(x), 6);
  const programas = lista(body.programas, x => PROGRAMAS_LEAD.includes(x), 8);
  const cabine = ['eco', 'exe', 'tanto'].includes(body.cabine) ? body.cabine : '';
  await atualizarCampos(env, `leads/${email}`, { perfilAeroportos: aeroportos.join(','), perfilRegioes: regioes.join(','), perfilProgramas: programas.join(','), perfilCabine: cabine, perfilEm: new Date() });
  return { ok: true };
}
// As 5 do e-mail: primeiro as que combinam com as respostas (saindo dos aeroportos dela, para as regiões e na cabine
// que escolheu), depois completa com as melhores gerais da semana, sem repetir destino.
function paraOLead(semana, geral, lead) {
  const aero = String((lead && lead.perfilAeroportos) || '').split(',').filter(Boolean);
  const regs = String((lead && lead.perfilRegioes) || '').split(',').filter(Boolean);
  const cab = (lead && lead.perfilCabine) || '';
  if (!aero.length && !regs.length && !cab) return { lista: geral, aero: [] };
  const exe = d => /execut|primeira|first|business|premium/i.test(d.cabine || '');
  const pontos = d => {
    if (aero.length && !aero.includes(d.origem_iata)) return -1;
    if (regs.length && !regs.includes('qualquer') && !regs.includes(d.regiao)) return -1;
    return (cab === 'exe' ? (exe(d) ? 2 : 0) : cab === 'eco' ? (exe(d) ? -1 : 1) : 1) + (aero.includes(d.origem_iata) ? 2 : 0);
  };
  const minhas = (semana.candidatas || []).map((d, i) => ({ d, p: pontos(d), i })).filter(x => x.p >= 0)
    .sort((a, b) => b.p - a.p || a.i - b.i).slice(0, 5).map(x => ({ ...x.d, grupo: aero.includes(x.d.origem_iata) ? `Saindo de ${x.d.origem_iata}` : 'Para você' }));
  const vistos = new Set(minhas.map(d => d.destino_iata));
  return { lista: [...minhas, ...geral.filter(d => !vistos.has(d.destino_iata))].slice(0, 5), aero: minhas.length ? aero : [] };
}
async function sairLead(url, env) {
  const email = String(url.searchParams.get('e') || '').toLowerCase();
  const ok = emailValido(email) && url.searchParams.get('t') === (await hmac(env, `sair:${email}`)).slice(0, 24);
  if (ok && await lerDoc(env, `leads/${email}`)) await atualizarCampos(env, `leads/${email}`, { ativo: false, saiuEm: new Date() });
  const texto = ok ? 'Pronto. Você não vai mais receber o alerta grátis da semana.' : 'Link inválido. Responda o e-mail pedindo para sair, que tiramos você da lista.';
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Onde as Milhas Me Levam</title>
    <body style="font-family:system-ui,sans-serif;background:#070c17;color:#f3eee3;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;text-align:center">
    <div><p style="font-size:18px">${texto}</p><p><a style="color:#e2b458" href="${escHtml(env.SITE)}">Voltar ao site</a></p></div>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
// Uma vez por semana para cada pessoa da lista (quem já assina não recebe), até a cota do mês.
async function semanal(env) {
  let enviados = 0, cota = Math.min(cotaLeads(env) - await emailsDoMes(env), LOTE_SEMANAL);
  const agora = Date.now();
  const leads = (await listarDocs(env, 'leads')).filter(l => l.ativo && emailValido(l.email))
    .filter(l => agora - (l.ultimoEnvio instanceof Date ? l.ultimoEnvio.getTime() : 0) >= 7 * 864e5 - 3600e3)
    .sort((a, b) => (a.ultimoEnvio || 0) - (b.ultimoEnvio || 0));
  for (const l of leads) {
    if (cota <= 0) break;
    const ass = await lerDoc(env, `assinantes/${l.email}`);
    if (ass && ass.validoAte instanceof Date && ass.validoAte.getTime() > agora) continue;
    if (!await emailDaSemana(env, l.email, false, l)) break; // sem envio hoje (cota do EmailJS ou fora do ar)
    await atualizarCampos(env, `leads/${l.id}`, { ultimoEnvio: new Date() });
    enviados++; cota--;
  }
  console.log(`alerta grátis da semana: ${enviados} enviados, ${leads.length} na fila`);
  return enviados;
}

/* ---------- Indicação: o assinante que traz alguém ganha 7 dias quando ele paga ---------- */
const DIAS_INDICACAO = 7;
async function emailDoToken(req, env) {
  const [h, c, s] = (req.headers.get('authorization') || '').replace(/^Bearer /, '').split('.');
  if (!s) return null;
  const ler = t => JSON.parse(atob(t.replace(/-/g, '+').replace(/_/g, '/')));
  const cab = ler(h), corpo = ler(c);
  const { keys } = await (await fetch(FIREBASE_JWK, { cf: { cacheTtl: 3600 } })).json();
  const jwk = keys.find(k => k.kid === cab.kid);
  if (!jwk || cab.alg !== 'RS256') return null;
  const chave = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const assinatura = Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), x => x.charCodeAt(0));
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', chave, assinatura, new TextEncoder().encode(`${h}.${c}`));
  if (!ok || corpo.iss !== `https://securetoken.google.com/${env.PROJETO}` || corpo.aud !== env.PROJETO || corpo.exp * 1000 < Date.now() || !corpo.email_verified) return null;
  return String(corpo.email || '').toLowerCase();
}
async function minhaIndicacao(req, env) {
  const email = await emailDoToken(req, env);
  const a = email && await lerDoc(env, `assinantes/${email}`);
  if (!a) throw falha('Entre com o e-mail da assinatura.', 401);
  const codigo = (await hmac(env, `ref:${email}`)).slice(0, 8);
  let ind = await lerDoc(env, `indicacoes/${codigo}`);
  if (!ind) await gravarDoc(env, `indicacoes/${codigo}`, ind = { email, indicados: 0, diasGanhos: 0, criadoEm: new Date() });
  return { codigo, indicados: ind.indicados || 0, diasGanhos: ind.diasGanhos || 0, dias: DIAS_INDICACAO };
}
async function premiarIndicacao(env, ref, novoEmail) {
  const ind = await lerDoc(env, `indicacoes/${ref}`);
  if (!ind || ind.email === novoEmail) return;
  const dono = await lerDoc(env, `assinantes/${ind.email}`);
  if (!dono) return;
  const base = Math.max(Date.now(), dono.validoAte instanceof Date ? dono.validoAte.getTime() : 0);
  const validoAte = new Date(base + DIAS_INDICACAO * 864e5);
  await atualizarCampos(env, `assinantes/${ind.email}`, { validoAte, atualizadoEm: new Date() });
  await atualizarCampos(env, `indicacoes/${ref}`, { indicados: (ind.indicados || 0) + 1, diasGanhos: (ind.diasGanhos || 0) + DIAS_INDICACAO });
  await somar(env, `metricas/${hojeBR()}`, { indicacao_paga: 1 }).catch(() => {});
  const data = validoAte.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  await enviarEmail(env, ind.email, `Você ganhou ${DIAS_INDICACAO} dias de assinatura`,
    `Olá!<br><br>Alguém que você indicou acabou de assinar o Onde as Milhas Me Levam. Obrigado! Como prometido, sua assinatura ganhou <strong>${DIAS_INDICACAO} dias</strong> e agora vale até <strong>${data}</strong>.<br><br>Continue indicando: cada amigo que assinar rende mais ${DIAS_INDICACAO} dias.<br><br>${botaoEmail('Ver meu link de indicação', `${env.SITE}#assinar`)}`);
}

/* ---------- Depoimentos: só de quem assina ou já assinou, e só aparecem depois de aprovados ---------- */
const DEPO_TEXTO = 500, DEPO_NOME = 40;
const limpo = (t, max) => String(t ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
const depoPublico = d => ({ nome: d.nome, cidade: d.cidade || '', instagram: d.instagram || '', foto: d.foto || '', nota: d.nota, texto: d.texto, data: d.criadoEm instanceof Date ? d.criadoEm.toISOString().slice(0, 10) : '' });
async function depoimentosPublicos(env) {
  const todos = await listarDocs(env, 'depoimentos');
  return { depoimentos: todos.filter(d => d.status === 'aprovado').sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0)).map(depoPublico) };
}
async function clienteDoToken(req, env) {
  const email = await emailDoToken(req, env);
  if (!email || !(await lerDoc(env, `assinantes/${email}`))) throw falha('Só quem assina (ou já assinou) pode deixar depoimento.', 401);
  return email;
}
async function meuDepoimento(req, env) {
  const d = await lerDoc(env, `depoimentos/${await clienteDoToken(req, env)}`);
  return { depoimento: d ? { ...depoPublico(d), status: d.status } : null };
}
async function gravarDepoimento(req, env) {
  const email = await clienteDoToken(req, env);
  const b = await req.json();
  const nome = limpo(b.nome, DEPO_NOME), cidade = limpo(b.cidade, DEPO_NOME), texto = limpo(b.texto, DEPO_TEXTO);
  const nota = Math.round(Number(b.nota));
  const instagram = String(b.instagram ?? '').trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/.*$/, '');
  if (instagram && !/^[A-Za-z0-9._]{1,30}$/.test(instagram)) throw falha('Esse @ do Instagram não parece certo.');
  if (!nome) throw falha('Diga como quer aparecer (por exemplo, seu primeiro nome).');
  if (texto.length < 20) throw falha('Conte um pouco mais: pelo menos uma frase.');
  if (!(nota >= 1 && nota <= 5)) throw falha('Escolha de 1 a 5 estrelas.');
  if (b.autorizo !== true) throw falha('Marque que autoriza publicar o depoimento.');
  const antes = await lerDoc(env, `depoimentos/${email}`);
  // Foto: a enviada (o site manda já reduzida, 256x256 JPEG) ou a da conta Google; '' tira, sem o campo mantém a anterior.
  let foto = b.foto === undefined ? (antes?.foto || '') : String(b.foto || '');
  const fotoGoogle = /^https:\/\/lh3\.googleusercontent\.com\/[A-Za-z0-9_\-/=.%]+$/.test(foto) && foto.length < 600;
  if (foto && !fotoGoogle && (foto.length > 120000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(foto))) throw falha('Essa foto não deu certo. Tente outra.');
  await gravarDoc(env, `depoimentos/${email}`, { email, nome, cidade, instagram, foto, texto, nota, autorizo: true, status: 'pendente',
    criadoEm: antes?.criadoEm || new Date(), atualizadoEm: new Date() });
  return { ok: true };
}
async function exigirAdmin(req, env) {
  const email = await emailDoToken(req, env);
  const admins = String(env.ADMINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!email || !admins.includes(email)) throw falha('Só para o dono do site.', 403);
  return email;
}
async function todosDepoimentos(req, env) {
  await exigirAdmin(req, env);
  const todos = await listarDocs(env, 'depoimentos');
  return { depoimentos: todos.sort((a, b) => (b.atualizadoEm || 0) - (a.atualizadoEm || 0)).map(d => ({ ...depoPublico(d), email: d.id, status: d.status })) };
}
async function moderarDepoimento(req, env) {
  await exigirAdmin(req, env);
  const { email, status } = await req.json();
  if (!['aprovado', 'oculto', 'pendente'].includes(status) || !emailValido(email)) throw falha('Pedido inválido.');
  if (!(await lerDoc(env, `depoimentos/${email}`))) throw falha('Depoimento não encontrado.', 404);
  await atualizarCampos(env, `depoimentos/${email}`, { status, moderadoEm: new Date() });
  return { ok: true };
}

/* ---------- Painel do dono ---------- */
// Quem assina: nome e @ do depoimento (se deixou) ou o nome da conta Google; o último pagamento de cada um.
async function listaAssinantes(req, env) {
  await exigirAdmin(req, env);
  const [assinantes, depos, pedidos] = await Promise.all([listarDocs(env, 'assinantes'), listarDocs(env, 'depoimentos'), listarDocs(env, 'pedidos')]);
  const google = {};
  const emails = assinantes.map(a => a.id);
  for (let i = 0; i < emails.length; i += 100) {
    try {
      const l = await (await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.PROJETO}/accounts:lookup`, {
        method: 'POST', headers: { authorization: `Bearer ${await token(env)}`, 'content-type': 'application/json' }, body: JSON.stringify({ email: emails.slice(i, i + 100) })
      })).json();
      for (const u of l.users || []) if (u.email && u.displayName) google[u.email.toLowerCase()] = u.displayName;
    } catch (e) { /* sem nome do Google */ }
  }
  const depo = Object.fromEntries(depos.map(d => [d.id, d]));
  const pagos = pedidos.filter(p => p.status === 'pago' || p.status === 'cancelado').sort((a, b) => (b.pagoEm || 0) - (a.pagoEm || 0));
  const agora = Date.now();
  return { assinantes: assinantes.map(a => {
    const p = pagos.find(x => x.email === a.id);
    const vence = a.validoAte instanceof Date ? a.validoAte.getTime() : 0;
    return { email: a.id, nome: (depo[a.id] && depo[a.id].nome) || google[a.id] || '', instagram: (depo[a.id] && depo[a.id].instagram) || '', telefone: a.telefone || '',
      plano: a.plano || '', validoAte: vence ? new Date(vence).toISOString() : null, ativo: vence > agora, cancelado: !!a.canceladoEm,
      pagamento: p ? { preco: p.preco, forma: p.forma || '', parcelas: p.parcelas || 1, pagoEm: p.pagoEm instanceof Date ? p.pagoEm.toISOString() : null, status: p.status } : null };
  }).sort((a, b) => (b.ativo - a.ativo) || String(b.validoAte).localeCompare(String(a.validoAte))) };
}
// Depois de estornar no app da InfinitePay (ela não avisa o estorno): tira o acesso na hora.
async function cancelarAssinante(req, env) {
  await exigirAdmin(req, env);
  const email = String((await req.json()).email || '').trim().toLowerCase();
  if (!emailValido(email)) throw falha('E-mail inválido.');
  if (!(await lerDoc(env, `assinantes/${email}`))) throw falha('Assinante não encontrado.', 404);
  await tirarAcesso(env, email);
  return { ok: true };
}
async function tirarAcesso(env, email) {
  await atualizarCampos(env, `assinantes/${email}`, { validoAte: new Date(), canceladoEm: new Date(), teveAnual: false });
  const pedido = (await listarDocs(env, 'pedidos')).filter(p => p.email === email && p.status === 'pago').sort((a, b) => (b.pagoEm || 0) - (a.pagoEm || 0))[0];
  if (pedido) await atualizarCampos(env, `pedidos/${pedido.id}`, { status: 'cancelado', canceladoEm: new Date() });
}

// Pergunta de novo à InfinitePay se um pagamento continua pago (a mesma consulta do webhook).
async function consultarPagamento(env, p) {
  const r = await fetch(`${API}/payment_check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Api-Key': env.INFINITEPAY_API_KEY },
    body: JSON.stringify({ handle: env.HANDLE, order_nsu: p.id, transaction_nsu: p.transacao, slug: p.slug })
  });
  return { http: r.status, ...(await r.json().catch(() => ({}))) };
}
// Estorno: só tira o acesso quando a InfinitePay responde com certeza que o pagamento deixou de estar pago.
const estornado = c => c.success === true && (c.paid === false || (Number(c.paid_amount) === 0 && c.paid_amount !== undefined));
// Todo dia: confere os pagamentos dos últimos 10 dias (prazo da garantia) e tira o acesso de quem foi estornado.
async function conferirEstornos(env) {
  const limite = Date.now() - 10 * 864e5;
  const recentes = (await listarDocs(env, 'pedidos')).filter(p => p.status === 'pago' && p.transacao && p.slug && p.pagoEm instanceof Date && p.pagoEm.getTime() > limite);
  for (const p of recentes.slice(0, 10)) {
    const c = await consultarPagamento(env, p).catch(() => ({}));
    if (estornado(c)) await tirarAcesso(env, p.email).catch(e => console.log('estorno:', e.message));
  }
}
// 10 dias depois do primeiro pagamento (já fora da garantia de 7): um e-mail perguntando o que a pessoa está achando, com o botão para
// avaliar (vai para aprovação no painel, como os depoimentos). Responder o e-mail cai no Gmail da marca.
async function pesquisaDezDias(env) {
  const agora = Date.now();
  // Quem assinou antes deste aviso existir não tem primeiroPagamento: vale o pedido pago mais antigo.
  const pagos = (await listarDocs(env, 'pedidos')).filter(p => p.status === 'pago' && p.pagoEm instanceof Date);
  const inicio = a => (a.primeiroPagamento instanceof Date ? a.primeiroPagamento.getTime()
    : Math.min(...pagos.filter(p => p.email === a.id).map(p => p.pagoEm.getTime())));
  const alvo = (await listarDocs(env, 'assinantes')).filter(a => !a.pesquisaEm && !a.canceladoEm && emailValido(a.email || a.id)
    && agora - inicio(a) >= 10 * 864e5 && agora - inicio(a) < 17 * 864e5
    && a.validoAte instanceof Date && a.validoAte.getTime() > agora);
  for (const a of alvo.slice(0, 5)) {
    const email = a.email || a.id;
    const corpo = `Olá!<br><br>Já faz 10 dias que você assina o Onde as Milhas Me Levam. Queremos saber: <strong>o que você está achando?</strong><br><br>
      Já encontrou alguma passagem boa? Sentiu falta de alguma rota, programa ou ferramenta? Tem algo que podemos melhorar?<br><br>
      É só <strong>responder este e-mail</strong> contando, que a gente lê tudo. E se estiver gostando, deixe sua avaliação no site: ela ajuda outras pessoas a decidir.<br><br>
      ${botaoEmail('Deixar minha avaliação', `${env.SITE}?utm_source=email&utm_campaign=pesquisa10#assinar`)}<br><br>
      Obrigado por estar com a gente!`;
    if (await enviarEmail(env, email, 'O que você está achando do Onde as Milhas Me Levam?', corpo)) await atualizarCampos(env, `assinantes/${email}`, { pesquisaEm: new Date() });
  }
}

// Painel: mostra a resposta crua da InfinitePay para o último pagamento de um e-mail (para conferir estornos).
async function conferirUm(req, url, env) {
  await exigirAdmin(req, env);
  const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
  const p = (await listarDocs(env, 'pedidos')).filter(x => x.email === email && x.transacao).sort((a, b) => (b.pagoEm || 0) - (a.pagoEm || 0))[0];
  if (!p) throw falha('Nenhum pagamento deste e-mail.', 404);
  const c = await consultarPagamento(env, p);
  return { pedido: p.id, status: p.status, forma: p.forma, infinitepay: c, estornado: estornado(c) };
}

async function metricas(req, url, env) {
  await exigirAdmin(req, env);
  const dias = Math.min(90, Math.max(1, Number(url.searchParams.get('dias')) || 30));
  const datas = [...Array(dias)].map((_, i) => new Date(Date.now() - 3 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
  const porDia = {};
  for (let i = 0; i < datas.length; i += 10) {
    await Promise.all(datas.slice(i, i + 10).map(async d => { const m = await lerDoc(env, `metricas/${d}`); if (m) porDia[d] = m; }));
  }
  const agora = Date.now();
  const assinantes = await listarDocs(env, 'assinantes');
  const ativos = assinantes.filter(a => a.validoAte instanceof Date && a.validoAte.getTime() > agora);
  const leads = await listarDocs(env, 'leads');
  return {
    dias, porDia, emailsMes: await emailsDoMes(env), cotaLeads: cotaLeads(env), servicoEmail: usaGmail(env) ? 'gmail' : 'emailjs',
    assinantes: { ativos: ativos.length, mensal: ativos.filter(a => a.plano !== 'anual').length, anual: ativos.filter(a => a.plano === 'anual').length,
      vencem7: ativos.filter(a => a.validoAte.getTime() - agora < 7 * 864e5).length, vencidos: assinantes.length - ativos.length },
    leads: { ativos: leads.filter(l => l.ativo).length, sairam: leads.filter(l => !l.ativo).length, preferencias: preferenciasLeads(leads.filter(l => l.ativo)) }
  };
}

// Painel: o que os leads responderam (quantos responderam e os mais escolhidos de cada pergunta).
function preferenciasLeads(leads) {
  const conta = campo => Object.entries(leads.reduce((m, l) => { String(l[campo] || '').split(',').filter(Boolean).forEach(x => { m[x] = (m[x] || 0) + 1; }); return m; }, {}))
    .sort((a, b) => b[1] - a[1]).slice(0, 8);
  return { responderam: leads.filter(l => l.perfilEm).length, aeroportos: conta('perfilAeroportos'), regioes: conta('perfilRegioes'), programas: conta('perfilProgramas'), cabine: conta('perfilCabine') };
}

// Muda só os campos informados (gravarDoc troca o documento inteiro).
async function atualizarCampos(env, caminho, dados) {
  const fields = Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, paraFs(v)]));
  const mascara = Object.keys(dados).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const r = await fetch(`${docUrl(env, caminho)}?${mascara}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${await token(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw falha('Erro ao gravar no banco.', 500);
}

async function lerDoc(env, caminho) {
  const r = await fetch(docUrl(env, caminho), { headers: { authorization: `Bearer ${await token(env)}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw falha('Erro ao ler o banco.', 500);
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, deFs(v)]));
}
async function apagarDoc(env, caminho) {
  await fetch(docUrl(env, caminho), { method: 'DELETE', headers: { authorization: `Bearer ${await token(env)}` } });
}
async function gravarDoc(env, caminho, dados) {
  const fields = Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, paraFs(v)]));
  const r = await fetch(docUrl(env, caminho), {
    method: 'PATCH',
    headers: { authorization: `Bearer ${await token(env)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ fields })
  });
  if (!r.ok) throw falha('Erro ao gravar no banco.', 500);
}
