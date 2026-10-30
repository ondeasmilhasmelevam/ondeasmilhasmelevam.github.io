// Página Assinar / Entrar: planos, pagamento pela InfinitePay (via servidor/worker.js)
// e entrada com Google ou link no e-mail. Avisa o resto do site com o evento "assinatura".
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const app = initializeApp({
  apiKey: 'AIzaSyCDdTn2JotSDdCxp2fSlWcNV0LtZJRf7Sg',
  authDomain: 'ondeasmilhasmelevam-b5ed6.firebaseapp.com',
  projectId: 'ondeasmilhasmelevam-b5ed6',
  storageBucket: 'ondeasmilhasmelevam-b5ed6.firebasestorage.app',
  messagingSenderId: '557637836947',
  appId: '1:557637836947:web:2d39853b99030749f4ad66'
});
const auth = getAuth(app);
auth.languageCode = 'pt';
const db = getFirestore(app);

// Endereço do Worker publicado (servidor/). Vazio = cobrança ainda desligada.
const SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev';
const GUARDA_EMAIL = 'oamml-email-login';

const $ = s => document.querySelector(s);
const reais = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const msg = (texto, tipo = '') => { const el = $('#ass-msg'); el.textContent = texto; el.className = `ass-msg ${tipo}`; el.hidden = !texto; };

window.oammlAssinatura = { ativo: false, email: '', validoAte: null };
function avisar(estado) {
  window.oammlAssinatura = estado;
  document.dispatchEvent(new CustomEvent('assinatura', { detail: estado }));
}

async function lerAssinatura(user) {
  if (!user || !user.email) return { ativo: false, email: '', validoAte: null };
  const email = user.email.toLowerCase();
  try {
    const s = await getDoc(doc(db, 'assinantes', email));
    const validoAte = s.exists() && s.data().validoAte ? s.data().validoAte.toDate() : null;
    return { ativo: Boolean(validoAte && validoAte > new Date()), email, validoAte, plano: s.exists() ? s.data().plano : '' };
  } catch (e) {
    return { ativo: false, email, validoAte: null };
  }
}

function desenharConta(estado) {
  const conta = $('#ass-conta');
  if (!estado.email) { conta.hidden = true; $('#ass-entrar').hidden = false; return; }
  $('#ass-entrar').hidden = true;
  conta.hidden = false;
  const data = estado.validoAte ? estado.validoAte.toLocaleDateString('pt-BR') : '';
  $('#ass-conta-txt').innerHTML = estado.ativo
    ? `<b>Assinatura ativa</b> para <span></span> até <b>${data}</b>. Alertas completos e calculadoras liberados.`
    : estado.validoAte
      ? `Sua assinatura de <span></span> venceu em <b>${data}</b>. Renove abaixo para voltar a ver tudo.`
      : `Não encontramos assinatura para <span></span>. Assine abaixo com este mesmo e-mail.`;
  $('#ass-conta-txt span').textContent = estado.email;
  $('#ass-email').value = estado.email;
  $('#ass-conta').classList.toggle('ok', estado.ativo);
}

onAuthStateChanged(auth, async user => {
  const estado = await lerAssinatura(user);
  desenharConta(estado);
  avisar(estado);
});

// Volta do link de entrada mandado por e-mail.
if (isSignInWithEmailLink(auth, location.href)) {
  let email = '';
  try { email = localStorage.getItem(GUARDA_EMAIL) || ''; } catch (e) { /* sem armazenamento */ }
  if (!email) email = prompt('Para confirmar, digite o e-mail em que você recebeu o link:') || '';
  if (email) {
    signInWithEmailLink(auth, email.trim(), location.href)
      .then(() => { try { localStorage.removeItem(GUARDA_EMAIL); } catch (e) { /* sem armazenamento */ } msg('Pronto, você entrou.', 'ok'); })
      .catch(() => msg('Esse link já foi usado ou venceu. Peça um novo abaixo.', 'erro'))
      .finally(() => history.replaceState(null, '', `${location.pathname}#assinar`));
  }
  location.hash = '#assinar';
}

// Volta do pagamento da InfinitePay.
if (new URLSearchParams(location.search).get('pagamento') === 'ok') {
  history.replaceState(null, '', `${location.pathname}#assinar`);
  location.hash = '#assinar';
  msg('Pagamento recebido! Em até 1 minuto o seu e-mail fica liberado. Entre abaixo com o mesmo e-mail do pagamento.', 'ok');
}

$('#ass-google').addEventListener('click', async () => {
  msg('');
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) { if (e.code !== 'auth/popup-closed-by-user') msg('Não deu para entrar com o Google. Tente o link por e-mail.', 'erro'); }
});

$('#ass-form-link').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#ass-login-email').value.trim();
  if (!email) return msg('Digite o seu e-mail.', 'erro');
  const botao = e.submitter || $('#ass-form-link button');
  botao.disabled = true;
  try {
    await sendSignInLinkToEmail(auth, email, { url: `${location.origin}${location.pathname}#assinar`, handleCodeInApp: true });
    try { localStorage.setItem(GUARDA_EMAIL, email); } catch (er) { /* sem armazenamento */ }
    msg(`Mandamos um link para ${email}. Abra o e-mail neste mesmo aparelho e toque no link para entrar. Veja também o spam.`, 'ok');
  } catch (er) {
    msg('Não deu para mandar o link. Confira o e-mail e tente de novo.', 'erro');
  } finally { botao.disabled = false; }
});

$('#ass-sair').addEventListener('click', () => signOut(auth));

async function mostrarPrecos(email) {
  if (!SERVIDOR) return;
  try {
    const q = email ? `?email=${encodeURIComponent(email)}` : '';
    const p = await (await fetch(`${SERVIDOR}/precos${q}`)).json();
    $('#ass-preco-mensal').textContent = reais(p.mensal);
    $('#ass-preco-anual').textContent = reais(p.anual);
    $('#ass-parcela-anual').textContent = `ou 12x no cartão · ${reais(p.anual / 12)} por mês`;
    $('#ass-de-anual').hidden = p.anual >= p.anualCheio;
  } catch (e) { /* fica o preço escrito na página */ }
}
mostrarPrecos('');

document.querySelectorAll('[data-plano]').forEach(b => b.addEventListener('click', async () => {
  msg('');
  const email = $('#ass-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('#ass-email').focus(); return msg('Digite o e-mail que vai usar para entrar no site. Só ele fica liberado.', 'erro'); }
  if (!SERVIDOR) return msg('As assinaturas abrem em breve. Siga o Instagram para saber quando.', 'erro');
  b.disabled = true;
  try {
    const r = await fetch(`${SERVIDOR}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plano: b.dataset.plano, email }) });
    const d = await r.json();
    if (!r.ok || !d.url) throw new Error(d.erro);
    location.href = d.url;
  } catch (e) {
    msg(e.message || 'Não deu para abrir o pagamento agora. Tente de novo em instantes.', 'erro');
    b.disabled = false;
  }
}));
$('#ass-email').addEventListener('change', e => mostrarPrecos(e.target.value.trim()));
