// Página Assinar / Entrar: planos, pagamento pela InfinitePay (via servidor/worker.js)
// e entrada com Google ou código de 7 números no e-mail. Avisa o resto do site com o evento "assinatura".
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, signInWithCustomToken
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

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
  const dias = estado.ativo ? Math.ceil((estado.validoAte - new Date()) / 864e5) : 0;
  $('#ass-resumo').innerHTML = estado.validoAte ? `
    <div><small>Situação</small><b>${estado.ativo ? 'Ativa' : 'Vencida'}</b></div>
    <div><small>Plano</small><b>${estado.plano === 'anual' ? 'Anual' : 'Mensal'}</b></div>
    <div><small>Válida até</small><b>${data}</b></div>
    <div><small>Faltam</small><b>${dias} ${dias === 1 ? 'dia' : 'dias'}</b></div>` : '';
}

// Histórico: pedidos pagos deste e-mail (as regras só deixam ler os próprios).
const FORMA = { pix: 'Pix', credit_card: 'Cartão' };
async function desenharHistorico(email) {
  const el = $('#ass-historico');
  el.hidden = true;
  if (!email) return;
  try {
    const s = await getDocs(query(collection(db, 'pedidos'), where('email', '==', email), where('status', '==', 'pago')));
    const pagos = s.docs.map(d => d.data()).sort((a, b) => b.pagoEm.toMillis() - a.pagoEm.toMillis());
    if (!pagos.length) return;
    el.querySelector('tbody').innerHTML = pagos.map(p => `<tr>
      <td>${p.pagoEm.toDate().toLocaleDateString('pt-BR')}</td>
      <td>${p.plano === 'anual' ? 'Anual' : 'Mensal'}</td>
      <td>${reais(p.preco)}</td>
      <td>${FORMA[p.forma] || '—'}${p.parcelas > 1 ? ` em ${p.parcelas}x` : ''}</td>
      <td>${/^https:\/\//.test(p.recibo || '') ? `<a href="${encodeURI(p.recibo)}" target="_blank" rel="noopener">Ver recibo</a>` : '—'}</td>
    </tr>`).join('');
    el.hidden = false;
  } catch (e) { /* sem histórico disponível */ }
}

onAuthStateChanged(auth, async user => {
  const estado = await lerAssinatura(user);
  desenharConta(estado);
  desenharHistorico(estado.email);
  avisar(estado);
});

// Volta do pagamento da InfinitePay.
if (new URLSearchParams(location.search).get('pagamento') === 'ok') {
  history.replaceState(null, '', `${location.pathname}#assinar`);
  location.hash = '#assinar';
  msg('Pagamento recebido! Em até 1 minuto o seu e-mail fica liberado. Entre abaixo com o mesmo e-mail do pagamento.', 'ok');
}

$('#ass-google').addEventListener('click', async () => {
  msg('');
  try { await signInWithPopup(auth, new GoogleAuthProvider()); }
  catch (e) {
    if (!auth.currentUser && !['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) msg('Não deu para entrar com o Google. Tente o código por e-mail.', 'erro');
  }
});

// Entrada por código: 1) pede o código para o e-mail; 2) digita os 7 números.
async function chamar(rota, dados) {
  const r = await fetch(`${SERVIDOR}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dados) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || 'Não deu agora. Tente de novo em instantes.');
  return d;
}
$('#ass-form-codigo').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#ass-login-email').value.trim();
  const codigo = $('#ass-codigo').value.replace(/\D/g, '');
  const botao = $('#ass-form-codigo button[type=submit]');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg('Digite o e-mail que você usou no pagamento.', 'erro');
  botao.disabled = true;
  try {
    if ($('#ass-passo-codigo').hidden) {
      const d = await chamar('/codigo', { email });
      $('#ass-passo-codigo').hidden = false;
      $('#ass-login-email').readOnly = true;
      botao.textContent = 'Entrar';
      $('#ass-codigo').focus();
      msg(`Se ${email} tiver assinatura, um código de 7 números chega em instantes. Ele vale ${d.minutos} minutos. Veja também o spam.`, 'ok');
    } else {
      if (codigo.length !== 7) { msg('O código tem 7 números.', 'erro'); return; }
      const d = await chamar('/entrar', { email, codigo });
      await signInWithCustomToken(auth, d.token);
      msg('Pronto, você entrou.', 'ok');
      voltarAoEmail();
    }
  } catch (er) {
    msg(er.message, 'erro');
  } finally { botao.disabled = false; }
});
function voltarAoEmail() {
  $('#ass-passo-codigo').hidden = true;
  $('#ass-login-email').readOnly = false;
  $('#ass-codigo').value = '';
  $('#ass-form-codigo button[type=submit]').textContent = 'Receber código no e-mail';
}
$('#ass-trocar-email').addEventListener('click', () => { voltarAoEmail(); msg(''); $('#ass-login-email').focus(); });

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
