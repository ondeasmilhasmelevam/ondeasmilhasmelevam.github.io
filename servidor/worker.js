// Assinatura do site: cria o link de pagamento da InfinitePay e, quando ela avisa que
// foi pago, libera o e-mail no Firestore (assinantes/{email}.validoAte).
//
// Segredos (wrangler secret put): INFINITEPAY_API_KEY e FIREBASE_SERVICE_ACCOUNT (o JSON inteiro).
// Variáveis (wrangler.toml): HANDLE, PROJETO, SITE, ORIGENS.

const PLANOS = {
  mensal: { dias: 30, preco: 2990, nome: 'Assinatura mensal' },
  anual: { dias: 365, preco: 29700, lancamento: 14850, nome: 'Assinatura anual' }
};
const API = 'https://api.checkout.infinitepay.io';

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsDe(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      if (req.method === 'POST' && url.pathname === '/checkout') return json(await checkout(await req.json(), env), 200, cors);
      if (req.method === 'POST' && url.pathname === '/webhook') return await webhook(await req.json(), env);
      if (req.method === 'GET' && url.pathname === '/precos') return json(await precos(url.searchParams.get('email'), env), 200, cors);
      return json({ erro: 'não encontrado' }, 404, cors);
    } catch (e) {
      return json({ erro: e.message || 'erro' }, e.status || 500, cors);
    }
  }
};

function corsDe(req, env) {
  const origem = req.headers.get('origin') || '';
  const ok = env.ORIGENS.split(',').map(s => s.trim()).includes(origem);
  return ok ? { 'access-control-allow-origin': origem, 'access-control-allow-methods': 'GET,POST', 'access-control-allow-headers': 'content-type', vary: 'origin' } : {};
}
const json = (d, status = 200, extra = {}) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json', ...extra } });
const falha = (msg, status = 400) => Object.assign(new Error(msg), { status });
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
  await gravarDoc(env, `pedidos/${nsu}`, { email, plano, preco, status: 'criado', criadoEm: new Date() });
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
    atualizadoEm: new Date()
  });
  await gravarDoc(env, `pedidos/${nsu}`, {
    ...pedido, status: 'pago', pagoEm: new Date(), transacao: b.transaction_nsu, slug: b.invoice_slug,
    parcelas: c.installments || 1, forma: c.capture_method || '', recibo: b.receipt_url || ''
  });
  return json({ ok: true });
}

// ---- Firestore pela API REST, com a conta de serviço (passa por cima das regras) ----
let tokenCache = { valor: '', expira: 0 };
async function token(env) {
  if (tokenCache.valor && Date.now() < tokenCache.expira) return tokenCache.valor;
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const agora = Math.floor(Date.now() / 1000);
  const b64 = o => btoa(typeof o === 'string' ? o : String.fromCharCode(...new Uint8Array(o))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const cab = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const corpo = b64(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: agora, exp: agora + 3600 }));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----|\s/g, '')), ch => ch.charCodeAt(0));
  const chave = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const assin = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', chave, new TextEncoder().encode(`${cab}.${corpo}`));
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${cab}.${corpo}.${b64(assin)}`
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
async function lerDoc(env, caminho) {
  const r = await fetch(docUrl(env, caminho), { headers: { authorization: `Bearer ${await token(env)}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw falha('Erro ao ler o banco.', 500);
  const d = await r.json();
  return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, deFs(v)]));
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
