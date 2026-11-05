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

// Indicação: o assinante ganha 7 dias por amigo que assinar pelo link dele.
async function desenharIndicacao(estado) {
  const el = $('#ass-indica');
  el.hidden = true;
  if (!estado.ativo || !auth.currentUser) return;
  try {
    const r = await fetch(`${SERVIDOR}/indicacao`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    const d = await r.json();
    if (!r.ok || !d.codigo) return;
    const link = `https://ondeasmilhasmelevam.github.io/?ref=${d.codigo}`;
    const texto = `Estou usando o Onde as Milhas Me Levam para achar passagens com milhas antes de esgotarem. Dá uma olhada: ${link}`;
    el.innerHTML = `<p><b>Indique e ganhe ${d.dias} dias.</b> Cada amigo que assinar pelo seu link soma ${d.dias} dias à sua assinatura.${d.indicados ? ` Até agora: <b>${d.indicados} ${d.indicados === 1 ? 'amigo' : 'amigos'}</b>, <b>${d.diasGanhos} dias</b> ganhos.` : ''}</p>
      <div class="indica-link"><input type="text" readonly value="${link}" aria-label="Seu link de indicação">
      <button type="button" class="cta cta-b" id="indica-copiar">Copiar link</button>
      <a class="cta cta-a" href="https://wa.me/?text=${encodeURIComponent(texto)}" target="_blank" rel="noopener">Mandar no WhatsApp</a></div>`;
    el.hidden = false;
    $('#indica-copiar').addEventListener('click', async e => {
      try { await navigator.clipboard.writeText(link); e.target.textContent = 'Copiado!'; }
      catch (er) { el.querySelector('input').select(); }
    });
  } catch (e) { /* sem indicação agora */ }
}

// Painel do dono (#painel): o servidor só responde para os e-mails da lista ADMINS.
let painelDias = 30;
const ORIGEM_NOME = { direto: 'Direto / sem origem', instagram: 'Instagram', google: 'Google', indicacao: 'Indicação', email: 'E-mail', telegram: 'Telegram',
  whatsapp: 'WhatsApp', facebook: 'Facebook', site: 'Outros sites', bing: 'Bing', youtube: 'YouTube', tiktok: 'TikTok' };
async function desenharPainel() {
  const el = $('#painel-conteudo');
  if (!auth.currentUser) return;
  let d;
  try {
    const r = await fetch(`${SERVIDOR}/metricas?dias=${painelDias}`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    d = await r.json();
    if (!r.ok) { el.innerHTML = `<p class="passagens-vazio">${r.status === 403 ? 'Este painel é só do dono do site. Entre com o Google do e-mail da marca.' : 'Não deu para carregar agora.'}</p>`; return; }
  } catch (e) { el.innerHTML = '<p class="passagens-vazio">Não deu para carregar agora.</p>'; return; }
  const COLS = [['visita', 'Visitas'], ['gratis_ver', 'Viram alerta grátis'], ['lead', 'Cadastros grátis'], ['assinar_ver', 'Viram assinar'], ['assinar_clique', 'Clicaram assinar'], ['checkout', 'Abriram pagamento'], ['pago', 'Pagaram'], ['receita', 'Receita']];
  const porOrigem = {}, porDia = [];
  const total = Object.fromEntries(COLS.map(([k]) => [k, 0]));
  Object.entries(d.porDia).sort().reverse().forEach(([dia, campos]) => {
    const linha = Object.fromEntries(COLS.map(([k]) => [k, 0]));
    Object.entries(campos).forEach(([campo, n]) => {
      const col = COLS.find(([k]) => campo.startsWith(`${k}_`));
      if (!col || campo === 'pago_mensal' || campo === 'pago_anual') return;
      const origem = campo.slice(col[0].length + 1);
      (porOrigem[origem] ||= Object.fromEntries(COLS.map(([k]) => [k, 0])))[col[0]] += n;
      linha[col[0]] += n; total[col[0]] += n;
    });
    porDia.push([dia.split('-').reverse().join('/'), linha]);
  });
  const valor = (k, v) => (k === 'receita' ? reais(v) : v.toLocaleString('pt-BR'));
  const pct = (a, b) => (b ? `${(100 * a / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : '—');
  const tabela = (titulo, linhas) => `<div class="painel-tabela"><table><thead><tr><th>${titulo}</th>${COLS.map(([, n]) => `<th>${n}</th>`).join('')}</tr></thead>
    <tbody>${linhas.map(([nome, l]) => `<tr><td>${nome}</td>${COLS.map(([k]) => `<td>${valor(k, l[k])}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${COLS.length + 1}">Ainda sem dados no período.</td></tr>`}</tbody>
    <tfoot><tr><td>Total</td>${COLS.map(([k]) => `<td>${valor(k, total[k])}</td>`).join('')}</tr></tfoot></table></div>`;
  const a = d.assinantes;
  el.innerHTML = `<div class="painel-cards">
      <div><b>${a.ativos}</b><small>assinantes ativos (${a.mensal} mensal, ${a.anual} anual)</small></div>
      <div><b>${a.vencem7}</b><small>vencem nos próximos 7 dias</small></div>
      <div><b>${d.leads.ativos}</b><small>na lista do alerta grátis${d.leads.sairam ? ` (${d.leads.sairam} saíram)` : ''}</small></div>
      <div><b>${reais(total.receita)}</b><small>vendas em ${d.dias} dias</small></div>
      <div><b>${pct(total.pago, total.visita)}</b><small>das visitas viraram assinatura</small></div>
      <div><b>${d.servicoEmail === 'gmail' ? d.emailsMes : `${d.emailsMes}/200`}</b><small>${d.servicoEmail === 'gmail' ? 'e-mails pelo Gmail neste mês (limite de uns 500 por dia)' : 'e-mails do EmailJS neste mês'}</small></div>
    </div>
    ${tabela('Origem', Object.entries(porOrigem).sort((x, y) => y[1].visita - x[1].visita).map(([o, l]) => [ORIGEM_NOME[o] || o, l]))}
    ${tabela('Dia', porDia)}`;
  desenharDeposPainel();
  desenharAssinantesPainel();
}

// Depoimentos no painel: aprovar põe no site; ocultar tira.
const DEPO_SITUACAO = { pendente: 'Esperando aprovação', aprovado: 'No site', oculto: 'Oculto' };
const estrelas = n => `${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span>`;
// Quem assina: e-mail, nome, @, plano, validade e último pagamento; "Cancelar acesso" depois de estornar.
async function desenharAssinantesPainel() {
  const el = $('#painel-assinantes');
  if (!auth.currentUser) return;
  let lista;
  try {
    const r = await fetch(`${SERVIDOR}/assinantes`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!r.ok) { el.innerHTML = ''; return; }
    lista = (await r.json()).assinantes;
  } catch (e) { return; }
  const data = t => (t ? new Date(t).toLocaleDateString('pt-BR') : '—');
  const situacao = a => (a.cancelado && !a.ativo ? '<span class="ass-sit cancelado">Cancelado</span>' : a.ativo ? '<span class="ass-sit ativo">Ativo</span>' : '<span class="ass-sit vencido">Vencido</span>');
  const forma = f => ({ pix: 'Pix', credit_card: 'cartão' }[f] || f);
  const pag = p => (p ? `${reais(p.preco)}${p.forma ? ` · ${escR(forma(p.forma))}` : ''}${p.parcelas > 1 ? ` ${p.parcelas}x` : ''}<small>${data(p.pagoEm)}${p.status === 'cancelado' ? ' · cancelado' : ''}</small>` : '—');
  const ativos = lista.filter(a => a.ativo).length;
  el.innerHTML = `<h3 class="prova-sub">Assinantes · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'} de ${lista.length}</h3>` + (lista.length
    ? `<div class="quanto-rolar"><table class="quanto-tab painel-ass"><thead><tr><th>Assinante</th><th>Plano</th><th>Válido até</th><th>Pagamento</th><th></th></tr></thead><tbody>
      ${lista.map(a => `<tr data-email="${escR(a.email)}">
        <th>${a.nome ? escR(a.nome) : '<span class="ass-semnome">sem nome</span>'}<small>${escR(a.email)}${a.instagram ? ` · <a href="https://instagram.com/${escR(a.instagram)}" target="_blank" rel="noopener">@${escR(a.instagram)}</a>` : ''}${a.telefone ? ` · <a href="https://wa.me/${escR(a.telefone)}" target="_blank" rel="noopener">WhatsApp ${escR(a.telefone.replace(/^55(\d\d)(\d+)(\d{4})$/, '($1) $2-$3'))}</a>` : ''}</small></th>
        <td>${escR(a.plano === 'anual' ? 'Anual' : a.plano === 'mensal' ? 'Mensal' : a.plano || '—')}</td>
        <td>${situacao(a)}<small>${data(a.validoAte)}</small></td>
        <td>${pag(a.pagamento)}</td>
        <td>${a.ativo ? '<button type="button" class="cta cta-b" data-cancelar>Cancelar acesso</button>' : ''}${a.pagamento ? '<button type="button" class="cta cta-b" data-conferir>Conferir na InfinitePay</button>' : ''}</td>
      </tr>`).join('')}</tbody></table></div>
      <p class="sec-note">Nome e @ aparecem quando a pessoa entrou com o Google ou deixou depoimento. Estornou na InfinitePay? Use "Cancelar acesso": a InfinitePay não avisa o site do estorno.</p>`
    : '<p class="passagens-vazio">Nenhum assinante ainda.</p>');
}
$('#painel-assinantes').addEventListener('click', async e => {
  const c = e.target.closest('[data-conferir]');
  if (c) {
    c.disabled = true;
    try {
      const r = await fetch(`${SERVIDOR}/assinante/conferir?email=${encodeURIComponent(c.closest('tr').dataset.email)}`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
      const d = await r.json();
      const ip = d.infinitepay || {};
      alert(r.ok ? `${d.estornado ? 'A InfinitePay diz que este pagamento NÃO está mais pago (estornado).' : ip.paid ? 'A InfinitePay diz que este pagamento continua pago.' : 'A InfinitePay não confirmou o pagamento.'}

Resposta: ${JSON.stringify(ip)}` : d.erro || 'Não deu para conferir agora.');
    } finally { c.disabled = false; }
    return;
  }
  const b = e.target.closest('[data-cancelar]'); if (!b) return;
  const email = b.closest('tr').dataset.email;
  if (!confirm(`Cancelar o acesso de ${email} agora? Faça isso só depois de estornar o pagamento na InfinitePay.`)) return;
  b.disabled = true;
  try {
    const r = await fetch(`${SERVIDOR}/assinante/cancelar`, { method: 'POST',
      headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email }) });
    if (!r.ok) alert((await r.json().catch(() => ({}))).erro || 'Não deu para cancelar agora.');
  } finally { desenharAssinantesPainel(); }
});

async function desenharDeposPainel() {
  const el = $('#painel-depos');
  if (!auth.currentUser) return;
  let lista;
  try {
    const r = await fetch(`${SERVIDOR}/depoimentos/todos`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!r.ok) { el.innerHTML = ''; return; }
    lista = (await r.json()).depoimentos;
  } catch (e) { return; }
  const pendentes = lista.filter(d => d.status === 'pendente').length;
  el.innerHTML = `<h3 class="prova-sub">Depoimentos${pendentes ? ` · ${pendentes} esperando aprovação` : ''}</h3>` + (lista.length
    ? `<ul class="depos-lista painel">${lista.map(d => `<li class="${escR(d.status)}" data-email="${escR(d.email)}">
        <p class="depo-status">${DEPO_SITUACAO[d.status] || ''}</p>
        <p class="depo-estrelas">${estrelas(d.nota)}</p>
        <blockquote>${escR(d.texto)}</blockquote>
        <div class="depo-quem">${window.oammlFoto(d)}<p class="depo-autor"><b>${escR(d.nome)}</b>${d.cidade ? ` · ${escR(d.cidade)}` : ''}${d.instagram ? ` · @${escR(d.instagram)}` : ''} · ${escR(d.email)}</p></div>
        <div class="depo-botoes">${d.status !== 'aprovado' ? '<button type="button" class="cta cta-a" data-status="aprovado">Aprovar</button>' : ''}${d.status !== 'oculto' ? '<button type="button" class="cta cta-b" data-status="oculto">Ocultar</button>' : ''}</div>
      </li>`).join('')}</ul>`
    : '<p class="passagens-vazio">Nenhum depoimento ainda.</p>');
  window.oammlFotoErros(el);
}
$('#painel-depos').addEventListener('click', async e => {
  const b = e.target.closest('[data-status]'); if (!b) return;
  b.disabled = true;
  try {
    await fetch(`${SERVIDOR}/depoimento/moderar`, { method: 'POST',
      headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: b.closest('li').dataset.email, status: b.dataset.status }) });
  } finally { desenharDeposPainel(); }
});

// Depoimento de quem assina ou já assinou: vai para aprovação e pode virar story no Instagram da pessoa.
async function desenharDepoimento(estado, aviso = '') {
  const el = $('#ass-depo');
  el.hidden = true;
  if (!estado.validoAte || !auth.currentUser) return;
  const cab = async () => ({ authorization: `Bearer ${await auth.currentUser.getIdToken()}` });
  let meu = null;
  try { meu = (await (await fetch(`${SERVIDOR}/depoimento`, { headers: await cab() })).json()).depoimento; } catch (e) { /* formulário vazio */ }
  const SITUACAO = { pendente: 'Recebido! Aparece no site assim que for aprovado.', aprovado: 'Publicado no site. Obrigado!', oculto: 'Não foi publicado. Você pode editar e mandar de novo.' };
  const nota = meu?.nota || 5;
  el.innerHTML = `<form class="depo-form" novalidate>
      <p><b>O que você está achando do site?</b> Conte em poucas linhas, por exemplo uma passagem que emitiu graças a um alerta. Isso ajuda muito quem está pensando em assinar.</p>
      ${meu ? `<p class="depo-situacao">${SITUACAO[meu.status] || ''}</p>` : ''}
      <fieldset class="depo-nota"><legend>Sua nota</legend>${[1, 2, 3, 4, 5].map(n => `<label><input type="radio" name="nota" value="${n}"${nota === n ? ' checked' : ''}><span aria-hidden="true">★</span><i class="sr">${n} ${n === 1 ? 'estrela' : 'estrelas'}</i></label>`).join('')}</fieldset>
      <textarea name="texto" rows="4" maxlength="500" aria-label="Seu depoimento" placeholder="Ex.: Emiti São Paulo–Lisboa em executiva por 70 mil milhas no mesmo dia em que o alerta saiu.">${escR(meu?.texto || '')}</textarea>
      <div class="depo-campos">
        <input name="nome" maxlength="40" aria-label="Nome" placeholder="Como quer aparecer (ex.: Ana)" value="${escR(meu?.nome || '')}">
        <input name="cidade" maxlength="40" aria-label="Cidade" placeholder="Sua cidade (opcional)" value="${escR(meu?.cidade || '')}">
        <input name="instagram" maxlength="40" aria-label="Seu Instagram" placeholder="Seu @ no Instagram (opcional)" value="${meu?.instagram ? `@${escR(meu.instagram)}` : ''}">
      </div>
      <div class="depo-foto-campo">
        <span class="depo-foto-prev"></span>
        <div>
          <div class="depo-botoes"><label class="cta cta-b">Escolher foto<input type="file" accept="image/*" hidden></label><button type="button" class="cta cta-b" data-tirar-foto hidden>Tirar foto</button></div>
          <small>Opcional. Se você entrou com o Google, já vem a foto da sua conta; dá para trocar ou tirar.</small>
        </div>
      </div>
      <label class="lead-aceite"><input type="checkbox" name="autorizo"${meu ? ' checked' : ''}> Autorizo publicar este depoimento no site e no Instagram do Onde as Milhas Me Levam, com o nome, a cidade e o @ do Instagram acima (se informei). Meu e-mail não aparece.</label>
      <div class="depo-botoes">
        <button type="submit" class="cta cta-a">${meu ? 'Atualizar depoimento' : 'Enviar depoimento'}</button>
        ${meu ? '<button type="button" class="cta cta-b" data-depo-insta>Postar no meu Instagram</button>' : ''}
      </div>
      <p class="lead-msg${aviso ? ' ok' : ''}" role="status"${aviso ? '' : ' hidden'}>${escR(aviso)}</p>
    </form>`;
  el.hidden = false;
  const f = el.querySelector('form'), saida = f.querySelector('.lead-msg');
  const dizer = (t, ok) => { saida.textContent = t; saida.className = `lead-msg ${ok ? 'ok' : 'erro'}`; saida.hidden = false; };
  const pintar = () => f.querySelectorAll('.depo-nota label').forEach((l, i) => l.classList.toggle('on', i < +f.elements.nota.value));
  f.addEventListener('change', pintar);
  pintar();
  const fotoGoogle = /^https:\/\/lh3\.googleusercontent\.com\//.test(auth.currentUser.photoURL || '') ? auth.currentUser.photoURL : '';
  let foto = meu ? meu.foto || '' : fotoGoogle, fotoMudou = !meu && !!fotoGoogle;
  const mostrarFoto = () => {
    const prev = f.querySelector('.depo-foto-prev');
    prev.innerHTML = window.oammlFoto({ nome: f.elements.nome.value || meu?.nome, foto });
    window.oammlFotoErros(prev);
    f.querySelector('[data-tirar-foto]').hidden = !foto;
  };
  mostrarFoto();
  f.elements.nome.addEventListener('change', mostrarFoto);
  f.querySelector('input[type=file]').addEventListener('change', async e => {
    const arq = e.target.files[0];
    if (!arq) return;
    try { foto = await reduzirFoto(arq); fotoMudou = true; mostrarFoto(); }
    catch (er) { dizer('Não consegui abrir essa imagem. Tente uma foto JPG ou PNG.'); }
  });
  f.querySelector('[data-tirar-foto]').addEventListener('click', () => { foto = ''; fotoMudou = true; mostrarFoto(); });
  const dados = () => ({ nota: +f.elements.nota.value, texto: f.elements.texto.value.trim(), nome: f.elements.nome.value.trim(), cidade: f.elements.cidade.value.trim(), instagram: f.elements.instagram.value.trim().replace(/^@/, '') });
  f.addEventListener('submit', async e => {
    e.preventDefault();
    const b = f.querySelector('[type=submit]');
    b.disabled = true;
    try {
      const r = await fetch(`${SERVIDOR}/depoimento`, { method: 'POST', headers: { ...(await cab()), 'content-type': 'application/json' },
        body: JSON.stringify({ ...dados(), autorizo: f.elements.autorizo.checked, ...(fotoMudou ? { foto } : {}) }) });
      const res = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(res.erro);
      await desenharDepoimento(estado, 'Obrigado! Agora poste no seu Instagram: o botão ao lado monta a imagem. Marque @ondeasmilhasmelevam no story.');
    } catch (er) {
      dizer(er.message || 'Não deu agora. Tente de novo em instantes.');
      b.disabled = false;
    }
  });
  f.querySelector('[data-depo-insta]')?.addEventListener('click', async () => {
    const d = dados();
    if (d.texto.length < 20 || !d.nome) return dizer('Preencha o depoimento e o nome primeiro.');
    const r = await compartilharDepoimento({ ...d, foto });
    if (r === 'baixou') dizer('Imagem baixada. Abra o Instagram, crie um story com ela e marque @ondeasmilhasmelevam.', true);
  });
}

// Foto do depoimento: recorta o centro em quadrado e reduz para 256x256 (fica pequena no banco).
async function reduzirFoto(arquivo) {
  const img = await createImageBitmap(arquivo);
  const lado = Math.min(img.width, img.height), c = document.createElement('canvas');
  c.width = c.height = 256;
  c.getContext('2d').drawImage(img, (img.width - lado) / 2, (img.height - lado) / 2, lado, lado, 0, 0, 256, 256);
  return c.toDataURL('image/jpeg', 0.82);
}

// Imagem do depoimento no tamanho do story (1080x1920), com a cara do site.
function carregarImagem(src) {
  return new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
}
function linhas(x, texto, largura) {
  const saida = [];
  let atual = '';
  for (const p of texto.split(/\s+/)) {
    const teste = atual ? `${atual} ${p}` : p;
    if (x.measureText(teste).width > largura && atual) { saida.push(atual); atual = p; } else atual = teste;
  }
  if (atual) saida.push(atual);
  return saida;
}
async function imagemDepoimento(d) {
  await document.fonts.ready;
  const W = 1080, H = 1920, c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#101B34'); g.addColorStop(1, '#060A14');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const luz = x.createRadialGradient(260, 180, 0, 260, 180, 1000);
  luz.addColorStop(0, 'rgba(226,180,88,.24)'); luz.addColorStop(1, 'rgba(226,180,88,0)');
  x.fillStyle = luz; x.fillRect(0, 0, W, H);
  x.textAlign = 'center';
  const logo = await carregarImagem('logo.jpeg');
  if (logo) {
    x.save(); x.beginPath(); x.arc(W / 2, 250, 100, 0, Math.PI * 2); x.clip();
    x.drawImage(logo, W / 2 - 100, 150, 200, 200); x.restore();
    x.strokeStyle = '#E2B458'; x.lineWidth = 5; x.beginPath(); x.arc(W / 2, 250, 108, 0, Math.PI * 2); x.stroke();
  }
  x.fillStyle = '#E2B458'; x.font = '700 38px Cinzel';
  if ('letterSpacing' in x) x.letterSpacing = '6px';
  x.fillText('ONDE AS MILHAS ME LEVAM', W / 2, 440);
  if ('letterSpacing' in x) x.letterSpacing = '0px';
  x.font = '64px sans-serif';
  x.fillText('★'.repeat(d.nota), W / 2, 590);
  x.fillStyle = 'rgba(226,180,88,.35)'; x.font = '700 260px Cinzel';
  x.fillText('“', W / 2, 820);
  let tam = 58, ls;
  const foto = d.foto?.startsWith('data:') ? await carregarImagem(d.foto) : null;  // só a foto enviada: a de fora travaria o canvas
  const area = foto ? 600 : 760;
  do { x.font = `600 ${tam}px Manrope`; ls = linhas(x, d.texto, 880); tam -= 4; } while (ls.length * tam * 1.42 > area && tam > 34);
  const alto = (tam + 4) * 1.42;
  let y = 760 + Math.max(0, (area - ls.length * alto) / 2);
  x.fillStyle = '#F3EEE3';
  for (const l of ls) { y += alto; x.fillText(l, W / 2, y); }
  let yNome = Math.max(y + 110, 1600);
  if (foto) {
    x.save(); x.beginPath(); x.arc(W / 2, 1470, 75, 0, Math.PI * 2); x.clip();
    x.drawImage(foto, W / 2 - 75, 1395, 150, 150); x.restore();
    x.strokeStyle = '#E2B458'; x.lineWidth = 4; x.beginPath(); x.arc(W / 2, 1470, 80, 0, Math.PI * 2); x.stroke();
    yNome = 1620;
  }
  x.fillStyle = '#E2B458'; x.font = '800 44px Manrope';
  x.fillText(`— ${d.nome}${d.cidade ? `, ${d.cidade}` : ''}`, W / 2, yNome);
  if (d.instagram) { x.fillStyle = '#F3EEE3'; x.font = '600 36px Manrope'; x.fillText(`@${d.instagram}`, W / 2, yNome + 58); }
  x.fillStyle = '#A3ACBD'; x.font = '600 34px Manrope';
  x.fillText('@ondeasmilhasmelevam', W / 2, 1760);
  x.fillText('ondeasmilhasmelevam.github.io', W / 2, 1812);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
}
async function compartilharDepoimento(d) {
  const blob = await imagemDepoimento(d);
  const arquivo = new File([blob], 'depoimento-onde-as-milhas.jpg', { type: 'image/jpeg' });
  if (navigator.canShare && navigator.canShare({ files: [arquivo] })) {
    try { await navigator.share({ files: [arquivo], text: 'Indico o @ondeasmilhasmelevam para achar passagens com milhas.' }); return 'compartilhou'; }
    catch (e) { if (e.name === 'AbortError') return 'cancelou'; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = arquivo.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return 'baixou';
}
$('#painel-dias').addEventListener('click', e => {
  const b = e.target.closest('[data-dias]'); if (!b) return;
  painelDias = +b.dataset.dias;
  $('#painel-dias').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  desenharPainel();
});
addEventListener('hashchange', () => { if (location.hash === '#painel') desenharPainel(); });

onAuthStateChanged(auth, async user => {
  const estado = await lerAssinatura(user);
  desenharConta(estado);
  desenharIndicacao(estado);
  desenharDepoimento(estado);
  if (location.hash === '#painel') desenharPainel();
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
    $('#ass-mes-anual').textContent = reais(Math.round(p.anual / 12));
    $('#ass-de-anual').hidden = p.anual >= p.anualCheio;
    const economia = p.mensal * 12 - p.anual;
    $('#ass-economia').textContent = `Você economiza ${reais(economia)} em relação a 12 meses do mensal`;
    $('#ass-economia').hidden = economia <= 0;
  } catch (e) { /* fica o preço escrito na página */ }
}
mostrarPrecos('');

document.querySelectorAll('[data-plano]').forEach(b => b.addEventListener('click', async () => {
  msg('');
  const email = $('#ass-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('#ass-email').focus(); return msg('Digite o e-mail que vai usar para entrar no site. Só ele fica liberado.', 'erro'); }
  const digitos = $('#ass-telefone').value.replace(/\D/g, '');
  if (digitos && ![10, 11, 12, 13].includes(digitos.length)) { $('#ass-telefone').focus(); return msg('Confira o WhatsApp: DDD e número, ex.: (21) 99999-9999. Ou deixe em branco.', 'erro'); }
  if (!SERVIDOR) return msg('As assinaturas abrem em breve. Siga o Instagram para saber quando.', 'erro');
  b.disabled = true;
  if (window.oammlEvento) window.oammlEvento('assinar_clique');
  try {
    const extra = { origem: window.oammlOrigem ? window.oammlOrigem() : '', ref: window.oammlRef ? window.oammlRef() : '' };
    const telefone = $('#ass-telefone').value.trim();
    const r = await fetch(`${SERVIDOR}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plano: b.dataset.plano, email, telefone, ...extra }) });
    const d = await r.json();
    if (!r.ok || !d.url) throw new Error(d.erro);
    location.href = d.url;
  } catch (e) {
    msg(e.message || 'Não deu para abrir o pagamento agora. Tente de novo em instantes.', 'erro');
    b.disabled = false;
  }
}));
$('#ass-email').addEventListener('change', e => mostrarPrecos(e.target.value.trim()));
