// Página Assinar / Entrar: planos, pagamento pela InfinitePay (via servidor/worker.js)
// e entrada com Google ou código de 7 números no e-mail. Avisa o resto do site com o evento "assinatura".
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, signInWithCustomToken
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

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
// Token do login, para o servidor confirmar que é assinante (busca de disponibilidade).
window.oammlToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : null);
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
    const ativo = Boolean(validoAte && validoAte > new Date());
    return { ativo, email, validoAte, plano: s.exists() ? s.data().plano : '', alertas: ativo ? await lerAlertas() : {} };
  } catch (e) {
    return { ativo: false, email, validoAte: null };
  }
}

// Datas e link de cada passagem ({id: {datas_ida, datas_volta, link}}), gravados pelo servidor.
async function lerAlertas() {
  try {
    const s = await getDoc(doc(db, 'privado', 'alertas'));
    return s.exists() ? JSON.parse(s.data().json) : {};
  } catch (e) { return {}; }
}
// Passagens novas chegam a cada poucos minutos; quem assina recebe as datas delas também.
setInterval(async () => {
  if (!window.oammlAssinatura.ativo || document.hidden) return;
  avisar({ ...window.oammlAssinatura, alertas: await lerAlertas() });
}, 5 * 60e3);

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

// Meu Radar: até 5 rotas por assinante em radares/{email}; o servidor manda o e-mail quando bate.
const RADAR_MAX = 5;
let radares = [];
const normR = t => String(t ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
const milhasDe = t => { const m = /(\d{1,3}(?:\.\d{3})+|\d+)/.exec(t || ''); return m ? Number(m[1].replace(/\./g, '')) : Infinity; };
const ehExecutiva = c => /EXECUT|PRIMEIRA|FIRST|BUSINESS|PREMIUM/.test(normR(c));
function bateRadar(r, p) {
  const lugar = (filtro, nome, iata) => !filtro || normR(`${nome} ${iata}`).includes(normR(filtro));
  return lugar(r.origem, p.origem, p.origem_iata) && lugar(r.destino, p.destino, p.destino_iata) &&
    (!r.cabine || (r.cabine === 'exe') === ehExecutiva(p.cabine)) &&
    (!r.programa || normR(p.programa).includes(normR(r.programa))) &&
    (!r.maxMilhas || milhasDe(p.ida) <= r.maxMilhas);
}
const radarTexto = r => [
  `${r.origem || 'Qualquer origem'} → ${r.destino || 'qualquer destino'}`,
  [r.cabine === 'exe' ? 'Executiva ou Primeira' : r.cabine === 'eco' ? 'Econômica' : '', r.programa, r.maxMilhas ? `até ${r.maxMilhas.toLocaleString('pt-BR')} milhas` : ''].filter(Boolean).join(' · ') || 'qualquer cabine e programa'
];
const escR = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const msgRadar = t => { const el = $('#radar-msg'); el.textContent = t; el.hidden = !t; };
function desenharRadar() {
  const estado = window.oammlAssinatura;
  $('#radar-fechado').hidden = !!estado.ativo;
  $('#radar-aberto').hidden = !estado.ativo;
  if (!estado.ativo) return;
  $('#radar-conta').textContent = `${radares.length} de ${RADAR_MAX}`;
  $('#radar-lista').innerHTML = radares.length ? radares.map((r, i) => {
    const [a, b] = radarTexto(r);
    return `<li><span><b>${escR(a)}</b><br><span>${escR(b)}</span></span><button type="button" data-tirar="${i}">Tirar</button></li>`;
  }).join('') : '<li class="vazio">Nenhum radar ainda. Adicione o primeiro acima.</li>';
  const achados = (window.oammlPassagens || []).filter(p => radares.some(r => bateRadar(r, p)));
  $('#radar-achados').innerHTML = window.oammlPassagemHtml ? achados.map(window.oammlPassagemHtml).join('') : '';
  $('#radar-achados-n').textContent = radares.length ? `${achados.length}` : '';
  $('#radar-achados-vazio').hidden = !radares.length || !!achados.length;
}
async function lerRadares(email) {
  radares = [];
  if (!email) return;
  try {
    const s = await getDoc(doc(db, 'radares', email));
    radares = s.exists() ? JSON.parse(s.data().lista || '[]') : [];
  } catch (e) { radares = []; }
}
async function gravarRadares() {
  const email = window.oammlAssinatura.email;
  await setDoc(doc(db, 'radares', email), { lista: JSON.stringify(radares), atualizadoEm: serverTimestamp() });
}
$('#radar-form').addEventListener('submit', async e => {
  e.preventDefault();
  const r = {
    origem: $('#radar-origem').value.trim().slice(0, 40), destino: $('#radar-destino').value.trim().slice(0, 40),
    cabine: $('#radar-cabine').value, programa: $('#radar-programa').value, maxMilhas: Math.max(0, Math.round(+$('#radar-milhas').value || 0)) || null
  };
  if (/^qualquer$/i.test(r.origem)) r.origem = '';
  if (/^qualquer$/i.test(r.destino)) r.destino = '';
  if (!r.origem && !r.destino) return msgRadar('Diga ao menos de onde sai ou para onde quer ir.');
  if (radares.length >= RADAR_MAX) return msgRadar(`São até ${RADAR_MAX} radares. Tire um para pôr outro.`);
  radares.push(r);
  try {
    await gravarRadares();
    msgRadar('Radar salvo. Avisamos por e-mail quando aparecer passagem assim.');
    e.target.reset();
  } catch (er) { radares.pop(); msgRadar('Não deu para salvar agora. Tente de novo em instantes.'); }
  desenharRadar();
});
$('#radar-lista').addEventListener('click', async e => {
  const b = e.target.closest('[data-tirar]'); if (!b) return;
  const tirado = radares.splice(+b.dataset.tirar, 1);
  try { await gravarRadares(); msgRadar(''); } catch (er) { radares.splice(+b.dataset.tirar, 0, ...tirado); msgRadar('Não deu para tirar agora. Tente de novo.'); }
  desenharRadar();
});
document.addEventListener('passagens', desenharRadar);

onAuthStateChanged(auth, async user => {
  const estado = await lerAssinatura(user);
  desenharConta(estado);
  desenharHistorico(estado.email);
  await lerRadares(estado.ativo ? estado.email : '');
  avisar(estado);
  desenharRadar();
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
