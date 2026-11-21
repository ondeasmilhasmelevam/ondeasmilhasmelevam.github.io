// Página Assinar / Entrar: planos, pagamento pela InfinitePay (via servidor/worker.js)
// e entrada com Google ou código de 7 números no e-mail. Avisa o resto do site com o evento "assinatura".
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  initializeAuth, browserLocalPersistence, indexedDBLocalPersistence, browserPopupRedirectResolver,
  onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signOut, signInWithCustomToken
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
// Login guardado primeiro no localStorage: no iPhone, o app instalado perde o acesso ao IndexedDB quando volta
// do segundo plano e o login "sumia". Quem já estava logado no IndexedDB é migrado sozinho pelo Firebase.
const auth = initializeAuth(app, { persistence: [browserLocalPersistence, indexedDBLocalPersistence], popupRedirectResolver: browserPopupRedirectResolver });
auth.languageCode = 'pt';
const db = getFirestore(app);

// Endereço do Worker publicado (servidor/). Vazio = cobrança ainda desligada.
const SERVIDOR = 'https://oamml-assinatura.ondeasmilhasmelevam.workers.dev';

const $ = s => document.querySelector(s);
const reais = c => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const prazoCortesia = d => (Number(d) === 365 ? '1 ano' : Number(d) === 180 ? '6 meses' : `${d} dias`);
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
    let s = await getDoc(doc(db, 'assinantes', email));
    // Dono do site: o servidor libera tudo como assinante na primeira visita (e mantém liberado).
    if (email === 'ondeasmilhasmelevam@gmail.com' && !(s.exists() && s.data().plano === 'dono')) {
      await fetch(`${SERVIDOR}/metricas?dias=1`, { headers: { authorization: `Bearer ${await user.getIdToken()}` } }).catch(() => null);
      s = await getDoc(doc(db, 'assinantes', email));
    }
    // Cortesia ganha e ainda não usada: o primeiro acesso começa a contar os dias (e avisa o dono).
    if (s.exists() && s.data().cortesiaPendente === true) {
      const ativacao = await fetch(`${SERVIDOR}/cortesia/ativar`, { method: 'POST', headers: { authorization: `Bearer ${await user.getIdToken()}` } }).catch(() => null);
      if (!ativacao?.ok) return { ativo: false, email, validoAte: null, pendente: true, erroAcesso: 'Sua cortesia está reservada, mas não foi possível ativá-la agora. Verifique seu acesso novamente; não é necessário pagar.' };
      s = await getDoc(doc(db, 'assinantes', email));
    }
    const validoAte = s.exists() && s.data().validoAte ? s.data().validoAte.toDate() : null;
    const ativo = Boolean(validoAte && validoAte > new Date());
    return { ativo, email, validoAte, plano: s.exists() ? s.data().plano : '', alertas: ativo ? await lerAlertas() : {} };
  } catch (e) {
    return { ativo: false, email, validoAte: null, erroAcesso: 'Não foi possível verificar seu acesso agora. Tente novamente antes de escolher um plano.' };
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
  const entradaConvite = document.documentElement.classList.contains('entrada-convite');
  const data = estado.validoAte ? estado.validoAte.toLocaleDateString('pt-BR') : '';
  $('#ass-revalidar').hidden = !estado.erroAcesso && !entradaConvite;
  $('#ass-conta-txt').innerHTML = estado.erroAcesso
    ? `${escR(estado.erroAcesso)}<br>Conta: <span></span>`
    : estado.ativo
    ? `<b>Assinatura ativa</b> para <span></span> até <b>${data}</b>. Alertas completos e calculadoras liberados.`
    : entradaConvite
      ? estado.validoAte
        ? `O acesso de <span></span> terminou em <b>${data}</b>. Se você recebeu uma nova cortesia, toque em Verificar meu acesso novamente. Para usar outro e-mail, saia desta conta e entre com o endereço que recebeu o convite.`
        : `Não encontramos cortesia ou assinatura para <span></span>. Confira se este é o e-mail que recebeu o convite. Se for outro, saia desta conta e entre com o endereço correto.`
    : estado.validoAte
      ? `Sua assinatura de <span></span> venceu em <b>${data}</b>. Renove abaixo para voltar a ver tudo.`
      : `Não encontramos assinatura para <span></span>. Assine abaixo com este mesmo e-mail.`;
  $('#ass-conta-txt span').textContent = estado.email;
  $('#ass-email').value = estado.email;
  $('#ass-conta').classList.toggle('ok', estado.ativo);
  const dias = estado.ativo ? Math.ceil((estado.validoAte - new Date()) / 864e5) : 0;
  $('#ass-resumo').innerHTML = estado.validoAte ? `
    <div><small>Situação</small><b>${estado.ativo ? 'Ativa' : 'Vencida'}</b></div>
    <div><small>Plano</small><b>${estado.plano === 'anual' ? 'Anual' : estado.plano === 'cortesia' ? 'Cortesia' : estado.plano === 'dono' ? 'Dono' : 'Mensal'}</b></div>
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
// "São Paulo" ou "São Paulo (todos os aeroportos)" no radar vale para todos os aeroportos da cidade.
const CIDADES_RADAR = Object.fromEntries([['São Paulo', ['GRU', 'CGH', 'VCP']], ['Rio de Janeiro', ['GIG', 'SDU']], ['Belo Horizonte', ['CNF', 'PLU']], ['Brasília', ['BSB']], ['Porto Alegre', ['POA']], ['Curitiba', ['CWB']], ['Florianópolis', ['FLN']], ['Salvador', ['SSA']], ['Recife', ['REC']], ['Fortaleza', ['FOR']], ['Natal', ['NAT']], ['Maceió', ['MCZ']], ['João Pessoa', ['JPA']], ['Aracaju', ['AJU']], ['São Luís', ['SLZ']], ['Teresina', ['THE']], ['Belém', ['BEL']], ['Manaus', ['MAO']], ['Goiânia', ['GYN']], ['Cuiabá', ['CGB']], ['Campo Grande', ['CGR']], ['Vitória', ['VIX']], ['Uberlândia', ['UDI']], ['Londrina', ['LDB']], ['Navegantes', ['NVT']], ['Foz do Iguaçu', ['IGU']]].map(([n, i]) => [n.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase(), i]));
const lugarRadar = (filtro, nome, iata) => {
  if (!filtro) return true;
  const c = CIDADES_RADAR[normR(filtro).replace(/\s*\(.*\)\s*$/, '')];
  return c ? c.includes(iata) : normR(`${nome} ${iata}`).includes(normR(filtro));
};
const programaRadar = t => normR(OAMMLProgramas.normalizar(t));
function bateRadar(r, p) {
  const lugar = lugarRadar;
  return lugar(r.origem, p.origem, p.origem_iata) && lugar(r.destino, p.destino, p.destino_iata) &&
    (!r.cabine || (r.cabine === 'exe') === ehExecutiva(p.cabine)) &&
    (!r.programa || programaRadar(p.programa).includes(programaRadar(r.programa))) &&
    (!r.maxMilhas || milhasDe(p.ida) <= r.maxMilhas);
}
const radarTexto = r => [
  `${r.origem || 'Qualquer origem'} → ${r.destino || 'qualquer destino'}`,
  [r.cabine === 'exe' ? 'Executiva ou Primeira' : r.cabine === 'eco' ? 'Econômica' : '', r.programa, r.maxMilhas ? `até ${r.maxMilhas.toLocaleString('pt-BR')} milhas` : ''].filter(Boolean).join(' · ') || 'qualquer cabine e programa'
];
const escR = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const slugCab = c => String(c || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '') || 'sem-cabine';
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
  }).join('') : '<li class="vazio">Nenhuma rota vigiada ainda. Adicione a primeira acima.</li>';
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
  if (radares.length >= RADAR_MAX) return msgRadar(`São até ${RADAR_MAX} rotas vigiadas. Tire uma para pôr outra.`);
  radares.push(r);
  try {
    await gravarRadares();
    msgRadar('Rota salva. Avisamos por e-mail quando aparecer passagem assim.');
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
    const link = `https://ondeasmilhasmelevam.com.br/?ref=${d.codigo}`;
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

// Chaves com validade: o GitHub não renova sozinho. O painel avisa com antecedência para não esquecer.
const CHAVES = [
  { nome: 'Chave do robô (robo-oamml)', vence: '2027-11-14', uso: 'deixa o robô ler e gravar o repositório privado. Depois de gerar a nova, troque o segredo PRIVADO_TOKEN no repositório do site.' },
  { nome: 'Chave "Renovar chave do Instagram"', vence: '2027-10-30', uso: 'deixa o robô renovar sozinho a chave do Instagram. Depois de gerar a nova, troque o segredo GH_SEGREDOS no repositório do site.' },
];
function painelChaves() {
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const itens = CHAVES.map(c => {
    const [a, m, d] = c.vence.split('-').map(Number);
    const faltam = Math.round((new Date(a, m - 1, d) - hoje) / 864e5);
    const nivel = faltam <= 15 ? 'urgente' : faltam <= 60 ? 'atencao' : 'ok';
    const quando = faltam < 0 ? `venceu há ${-faltam} ${faltam === -1 ? 'dia' : 'dias'}` : faltam === 0 ? 'vence hoje' : `faltam ${faltam.toLocaleString('pt-BR')} ${faltam === 1 ? 'dia' : 'dias'}`;
    return { ...c, faltam, nivel, quando, data: `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${a}` };
  }).sort((x, y) => x.faltam - y.faltam);
  const pior = itens[0].nivel;
  const titulo = pior === 'ok' ? 'Chaves com validade · tudo em dia' : pior === 'atencao' ? 'Renovar chave em breve' : 'Renovar chave agora';
  return `<div class="painel-chaves ${pior}" role="${pior === 'ok' ? 'note' : 'alert'}"><h3>${titulo}</h3>
    ${itens.map(c => `<p class="${c.nivel}"><b>${escR(c.nome)}</b> vence em <b>${c.data}</b> · <span>${c.quando}</span><small>Ela ${escR(c.uso)}</small></p>`).join('')}
    <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener">Abrir as chaves no GitHub</a></div>`;
}

// Painel do dono (#painel): o servidor só responde para os e-mails da lista ADMINS.
let painelDias = 30;
const ORIGEM_NOME = { direto: 'Direto / sem origem', instagram: 'Instagram', google: 'Google', indicacao: 'Indicação', email: 'E-mail', telegram: 'Telegram',
  whatsapp: 'WhatsApp', facebook: 'Facebook', site: 'Outros sites', bing: 'Bing', youtube: 'YouTube', tiktok: 'TikTok' };
async function desenharPainel() {
  const el = $('#painel-conteudo');
  if ((auth.currentUser?.email || '').toLowerCase() !== DONO) return limparPainel();
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
  el.innerHTML = `${painelChaves()}<div class="painel-cards">
      <div><b>${a.ativos}</b><small>assinantes ativos (${a.mensal} mensal, ${a.anual} anual)</small></div>
      <div><b>${a.vencem7}</b><small>vencem nos próximos 7 dias</small></div>
      <div><b>${d.leads.ativos}</b><small>na lista do alerta grátis${d.leads.sairam ? ` (${d.leads.sairam} saíram)` : ''}</small></div>
      <div><b>${reais(total.receita)}</b><small>vendas em ${d.dias} dias</small></div>
      <div><b>${pct(total.pago, total.visita)}</b><small>das visitas viraram assinatura</small></div>
      <div><b>${d.servicoEmail === 'gmail' ? d.emailsMes : `${d.emailsMes}/200`}</b><small>${d.servicoEmail === 'gmail' ? 'e-mails pelo Gmail neste mês (limite de uns 500 por dia)' : 'e-mails do EmailJS neste mês'}</small></div>
    </div>
    ${d.leads.preferencias && d.leads.preferencias.responderam ? `<div class="painel-prefs"><p><b>O que os leads responderam</b> · ${d.leads.preferencias.responderam} ${d.leads.preferencias.responderam === 1 ? 'pessoa respondeu' : 'pessoas responderam'}</p>
      ${[['aeroportos', 'Saem de'], ['regioes', 'Querem ir para'], ['programas', 'Têm pontos em'], ['cabine', 'Preferem voar']].map(([k, t]) => d.leads.preferencias[k].length ? `<p><span>${t}:</span> ${d.leads.preferencias[k].map(([v, n]) => `${escR(v)} (${n})`).join(' · ')}</p>` : '').join('')}</div>` : ''}
    ${painelFunil(total)}
    ${painelLinha('Visitas no site por dia', porDia.slice().reverse().map(([dia, l]) => [dia, l.visita]))}
    ${painelInstagram(d.instagram)}
    ${painelYoutube(d.google)}
    ${painelBusca(d.google)}
    ${tabela('Origem', Object.entries(porOrigem).sort((x, y) => y[1].visita - x[1].visita).map(([o, l]) => [ORIGEM_NOME[o] || o, l]))}
    ${tabela('Dia', porDia)}`;
  desenharDeposPainel();
  desenharAssinantesPainel();
  desenharCortesiasPainel();
  desenharCampanhaPainel();
}

// Gráficos do painel (SVG simples, sem biblioteca).
function painelLinha(titulo, pontos, cor = 'var(--ouro)') {
  if (pontos.length < 2) return '';
  const W = 600, H = 120, max = Math.max(1, ...pontos.map(([, v]) => v || 0));
  const xy = pontos.map(([, v], i) => [i * W / (pontos.length - 1), H - 8 - (H - 16) * (v || 0) / max]);
  const linha = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return `<div class="painel-grafico"><small>${escR(titulo)} · máximo ${max.toLocaleString('pt-BR')}</small>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${escR(titulo)}">
      <polygon points="0,${H} ${linha} ${W},${H}" fill="${cor}" opacity=".15"/><polyline points="${linha}" fill="none" stroke="${cor}" stroke-width="2.5" vector-effect="non-scaling-stroke"/>
    </svg><div class="painel-eixo"><span>${escR(pontos[0][0])}</span><span>${escR(pontos[pontos.length - 1][0])}</span></div></div>`;
}
function painelFunil(t) {
  const etapas = [['visita', 'Visitaram o site'], ['gratis_ver', 'Viram o alerta grátis'], ['lead', 'Cadastraram no grátis'], ['assinar_ver', 'Viram a assinatura'],
    ['checkout', 'Abriram o pagamento'], ['pago', 'Assinaram']];
  const topo = Math.max(1, t.visita || 0);
  return `<div class="painel-funil"><h3>Do visitante ao assinante</h3>${etapas.map(([k, nome], i) => {
    const v = t[k] || 0, ant = i ? (t[etapas[i - 1][0]] || 0) : 0;
    return `<div><span style="width:${Math.max(2, 100 * v / topo)}%"></span><b>${v.toLocaleString('pt-BR')}</b> ${nome}${i && ant ? ` <small>${Math.round(100 * v / ant)}% da etapa anterior</small>` : ''}</div>`;
  }).join('')}</div>`;
}
function painelYoutube(g) {
  const y = g && g.youtube;
  if (!y) return '<div class="painel-ig"><h3>YouTube</h3><p class="passagens-vazio">Ainda não ligado. Rode ferramentas/google_painel.py uma vez para ver os números do canal aqui.</p></div>';
  const n = v => Number(v || 0).toLocaleString('pt-BR');
  const dias = y.porDia || [], semana = dias.slice(-7).reduce((a, x) => a + x.views, 0), ganhou = dias.reduce((a, x) => a + x.ganhou - x.perdeu, 0);
  return `<div class="painel-ig"><h3>YouTube <small>${escR(y.nome)}</small></h3>
    <div class="painel-cards"><div><b>${n(y.inscritos)}</b><small>inscritos (${ganhou >= 0 ? '+' : ''}${n(ganhou)} em 28 dias)</small></div>
      <div><b>${n(semana)}</b><small>visualizações em 7 dias</small></div><div><b>${n(y.views)}</b><small>visualizações no total</small></div>
      <div><b>${n(y.videos)}</b><small>vídeos no canal</small></div></div>
    ${painelLinha('Visualizações por dia no YouTube', dias.map(x => [x.d.split('-').reverse().slice(0, 2).join('/'), x.views]), '#ff4e45')}
    ${(y.recentes || []).length ? `<div class="painel-tabela"><table><thead><tr><th>Quando</th><th>Vídeo</th><th>Situação</th><th>Visualizações</th><th>Curtidas</th><th>Comentários</th></tr></thead><tbody>
      ${y.recentes.map(v => `<tr><td>${new Date(v.quando).toLocaleDateString('pt-BR')}</td><td><a href="https://youtube.com/shorts/${escR(v.id)}" target="_blank" rel="noopener">${escR(v.titulo)}</a></td>
        <td>${v.publico === 'public' ? 'Público' : v.publico === 'private' ? '<b class="ruim">Privado</b>' : escR(v.publico)}</td><td>${n(v.views)}</td><td>${n(v.curtidas)}</td><td>${n(v.comentarios)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
}
function painelBusca(g) {
  const b = g && g.busca;
  if (!b) return '';
  const n = v => Number(v || 0).toLocaleString('pt-BR');
  const tot = b.porDia.reduce((a, x) => ({ c: a.c + x.cliques, v: a.v + x.vezes }), { c: 0, v: 0 });
  return `<div class="painel-ig"><h3>Google <small>buscas nos últimos 28 dias (o Google mostra com 2 a 3 dias de atraso)</small></h3>
    <div class="painel-cards"><div><b>${n(tot.v)}</b><small>vezes que o site apareceu numa busca</small></div><div><b>${n(tot.c)}</b><small>cliques vindos do Google</small></div></div>
    ${painelLinha('Vezes que o site apareceu no Google por dia', b.porDia.map(x => [x.d.split('-').reverse().slice(0, 2).join('/'), x.vezes]), '#6fd6a6')}
    ${b.buscas.length ? `<div class="painel-tabela"><table><thead><tr><th>O que as pessoas buscaram</th><th>Apareceu</th><th>Cliques</th><th>Posição média</th></tr></thead><tbody>
      ${b.buscas.map(x => `<tr><td>${escR(x.q)}</td><td>${n(x.vezes)}</td><td>${n(x.cliques)}</td><td>${x.posicao}</td></tr>`).join('')}</tbody></table></div>` : '<p class="passagens-vazio">O Google ainda está conhecendo o site: as buscas aparecem aqui em 1 a 3 semanas.</p>'}
    ${b.paginas.length ? `<div class="painel-tabela"><table><thead><tr><th>Página</th><th>Apareceu</th><th>Cliques</th></tr></thead><tbody>
      ${b.paginas.map(x => `<tr><td><a href="${escR(x.p)}" target="_blank" rel="noopener">${escR(x.p)}</a></td><td>${n(x.vezes)}</td><td>${n(x.cliques)}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>`;
}

// Instagram no painel: números que o robô lê da API a cada 3 horas (sem precisar entrar no Instagram).
const PAISES = { BR: 'Brasil', US: 'Estados Unidos', IN: 'Índia', PT: 'Portugal', AR: 'Argentina', ES: 'Espanha', IT: 'Itália', FR: 'França', DE: 'Alemanha', GB: 'Reino Unido', MX: 'México', CO: 'Colômbia', CL: 'Chile', PY: 'Paraguai', UY: 'Uruguai', JP: 'Japão', CA: 'Canadá' };
const GENERO = { M: 'Homens', F: 'Mulheres', U: 'Não informado' };
function painelInstagram(ig) {
  if (!ig) return '<div class="painel-ig"><h3>Instagram</h3><p class="passagens-vazio">Os números do Instagram aparecem aqui depois da próxima volta do robô (até 3 horas).</p></div>';
  const n = v => Number(v || 0).toLocaleString('pt-BR');
  const p = ig.periodos || {}, s7 = p['7'] || {}, s28 = p['28'] || {}, s1 = p['1'] || {};
  const serie = Object.entries(ig.serie || {}).sort();
  const hoje = (ig.perfil || {}).followers_count || 0;
  const ha = dias => { const alvo = new Date(Date.now() - dias * 864e5).toISOString().slice(0, 10); const x = serie.filter(([d]) => d <= alvo).pop(); return x ? hoje - x[1] : null; };
  const delta = v => (v == null ? 'medindo desde hoje' : `${v >= 0 ? '+' : ''}${n(v)}`);
  const publico = (ig.publico || {});
  const lista = (k, nomes) => (publico[k] || []).map(([v, q]) => `${escR((nomes && nomes[v]) || v)} (${n(q)})`).join(' · ');
  const posts = (ig.posts || []).map(x => `<tr><td>${new Date(x.quando).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${escR({ REELS: 'Reel', FEED: 'Post', STORY: 'Story', CAROUSEL_ALBUM: 'Carrossel' }[x.tipo] || x.tipo || '')}</td>
    <td><a href="${escR(x.link)}" target="_blank" rel="noopener">${escR(x.texto || 'ver post')}</a></td>
    <td>${n(x.reach)}</td><td>${n(x.views)}</td><td>${n(x.curtidas)}</td><td>${n(x.comentarios)}</td><td>${n(x.saved)}</td><td>${n(x.shares)}</td></tr>`).join('');
  return `<div class="painel-ig"><h3>Instagram <small>@${escR((ig.perfil || {}).username || 'ondeasmilhasmelevam')} · atualizado ${new Date(ig.atualizadoEm || ig.em).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</small></h3>
    <div class="painel-cards">
      <div><b>${n(hoje)}</b><small>seguidores · ${delta(ha(7))} em 7 dias · ${delta(ha(30))} em 30</small></div>
      <div><b>${n(s7.reach)}</b><small>contas alcançadas em 7 dias (${n(s28.reach)} em 28)</small></div>
      <div><b>${n(s7.views)}</b><small>visualizações em 7 dias</small></div>
      <div><b>${n(s7.profile_views)}</b><small>visitas ao perfil em 7 dias</small></div>
      <div><b>${n(s7.profile_links_taps)}</b><small>cliques no link do perfil em 7 dias</small></div>
      <div><b>${n(s7.accounts_engaged)}</b><small>contas que interagiram em 7 dias (${n(s7.total_interactions)} interações)</small></div>
      <div><b>${n(s7.seguiu)}</b><small>começaram a seguir em 7 dias${s7.deixou ? ` · ${n(s7.deixou)} deixaram` : ''}</small></div>
      <div><b>${n(s1.reach)}</b><small>alcance nas últimas 24 horas</small></div>
    </div>
    ${painelLinha('Seguidores no Instagram por dia', serie.slice(-60).map(([d, v]) => [d.split('-').reverse().slice(0, 2).join('/'), v]), '#d6249f')}
    ${Object.keys(publico).length ? `<div class="painel-prefs"><p><b>Quem segue</b></p>
      ${publico.country ? `<p><span>Países:</span> ${lista('country', PAISES)}</p>` : ''}${publico.city ? `<p><span>Cidades:</span> ${lista('city')}</p>` : ''}
      ${publico.age ? `<p><span>Idade:</span> ${lista('age')}</p>` : ''}${publico.gender ? `<p><span>Gênero:</span> ${lista('gender', GENERO)}</p>` : ''}</div>` : ''}
    ${posts ? `<div class="painel-tabela"><table><thead><tr><th>Quando</th><th>Tipo</th><th>Post</th><th>Alcance</th><th>Visualizações</th><th>Curtidas</th><th>Comentários</th><th>Salvos</th><th>Compart.</th></tr></thead><tbody>${posts}</tbody></table></div>` : ''}
  </div>`;
}

// Depoimentos no painel: aprovar põe no site; ocultar tira.
const DEPO_SITUACAO = { pendente: 'Esperando aprovação', aprovado: 'No site', oculto: 'Oculto' };
const estrelas = n => `${'★'.repeat(n)}<span>${'★'.repeat(5 - n)}</span>`;
// Campanha do mês (página #cortesia): quem respondeu CORTESIA no story pede com nome, e-mail, @ e WhatsApp.
(async () => {
  const f = $('#cortesia-form'), aviso = $('#cortesia-aviso');
  let c = {};
  try { c = await (await fetch(`${SERVIDOR}/campanha`)).json(); } catch (e) { /* mostra o aviso abaixo */ }
  if (!c.aberta) {
    aviso.textContent = c.proxima ? `A campanha deste mês já encerrou. A próxima abre em ${new Date(c.proxima).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}: fique de olho nos stories!` : 'Não deu para abrir agora. Tente de novo em instantes.';
    aviso.hidden = false;
    return;
  }
  f.hidden = false;
  f.addEventListener('submit', async ev => {
    ev.preventDefault();
    const m = f.querySelector('.lead-msg'), b = f.querySelector('button');
    const dizer = (t, ok) => { m.textContent = t; m.className = `lead-msg ${ok ? 'ok' : 'erro'}`; m.hidden = false; };
    b.disabled = true;
    try {
      const r = await fetch(`${SERVIDOR}/campanha/pedir`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        nome: f.elements.nome.value, email: f.elements.email.value, instagram: f.elements.instagram.value, telefone: f.elements.telefone.value,
        postou: f.elements.postou.checked, aceite: f.elements.aceite.checked }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.erro);
      [...f.querySelectorAll('.cortesia-campos, .lead-aceite')].forEach(x => { x.hidden = true; }); b.hidden = true;
      dizer('Pedido recebido! A gente confere o seu story e, aprovado, você recebe um e-mail com o acesso.', true);
    } catch (er) { dizer(er.message || 'Não deu agora. Tente de novo em instantes.'); b.disabled = false; }
  });
})();

// Painel: pedidos da campanha. O dono confere o perfil (story e seguidores) e escolhe 7, 15 ou 30 dias.
async function desenharCampanhaPainel() {
  const el = $('#painel-campanha');
  if (!auth.currentUser) return;
  let d;
  try {
    const r = await fetch(`${SERVIDOR}/campanha/pedidos`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!r.ok) { el.innerHTML = ''; return; }
    d = await r.json();
  } catch (e) { return; }
  const pend = d.pedidos.filter(p => p.status === 'pendente');
  const data = t => (t ? new Date(t).toLocaleDateString('pt-BR') : '');
  el.innerHTML = `<h3 class="prova-sub">Campanha de cortesia · ${d.campanha.aberta ? `aberta até ${data(d.campanha.ate)}` : `próxima em ${data(d.campanha.proxima)}`}${pend.length ? ` · ${pend.length} ${pend.length === 1 ? 'pedido esperando' : 'pedidos esperando'}` : ''}</h3>
    ${d.pedidos.length ? `<ul class="cortesias">${d.pedidos.slice(0, 40).map(p => `<li class="${p.status === 'pendente' ? 'pendente' : ''}" data-email="${escR(p.email)}">
      <p><b>${escR(p.nome)}</b> · <a href="https://instagram.com/${escR(p.instagram)}" target="_blank" rel="noopener">@${escR(p.instagram)}</a> · ${escR(p.email)}${p.telefone ? ` · <a href="https://wa.me/${escR(p.telefone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''} <small>${data(p.criadoEm)}</small></p>
      ${p.status === 'pendente' ? `<div class="depo-botoes"><select aria-label="Dias de cortesia"><option value="7">7 dias</option><option value="15" selected>15 dias</option><option value="30">30 dias</option><option value="90">90 dias</option><option value="180">6 meses</option><option value="365">1 ano</option></select>
        <button type="button" class="cta cta-a" data-aprovar>Aprovar</button><button type="button" class="cta cta-b" data-recusar>Recusar</button></div>`
        : `<p><span class="ass-sit ${p.status === 'aprovado' ? 'ativo' : 'cancelado'}">${p.status === 'aprovado' ? `Aprovado · ${prazoCortesia(p.dias)}` : 'Recusado'}</span></p>`}
    </li>`).join('')}</ul>` : '<p class="passagens-vazio">Nenhum pedido ainda. O story da campanha sai no dia 1º de cada mês.</p>'}`;
}
$('#painel-campanha').addEventListener('click', async e => {
  const li = e.target.closest('li[data-email]'); if (!li) return;
  const aprovar = !!e.target.closest('[data-aprovar]');
  if (!aprovar && !e.target.closest('[data-recusar]')) return;
  const dias = li.querySelector('select').value;
  if (!confirm(aprovar ? `Liberar ${prazoCortesia(dias)} para ${li.dataset.email}?` : `Recusar o pedido de ${li.dataset.email}?`)) return;
  e.target.disabled = true;
  try {
    const r = await fetch(`${SERVIDOR}/campanha/decidir`, { method: 'POST', headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: li.dataset.email, aprovar, dias }) });
    if (!r.ok) alert((await r.json().catch(() => ({}))).erro || 'Não deu agora.');
  } finally { desenharCampanhaPainel(); desenharCortesiasPainel(); desenharAssinantesPainel(); }
});

// Cortesia: o dono dá X dias grátis direto para o e-mail da pessoa; ela recebe um e-mail com o passo a passo.
function renovarCortesiaHtml(c) {
  if (c.pendente || !c.ate || !(new Date(c.ate).getTime() <= Date.now())) return '';
  return `<button type="button" class="cta cta-b" data-renovar="${escR(c.email)}" data-nome="${escR(c.nome || '')}" data-telefone="${escR(c.telefone || '')}" data-prazo="${escR(c.dias)}">Renovar cortesia</button>`;
}
async function desenharCortesiasPainel() {
  const el = $('#painel-cortesias');
  if (!auth.currentUser) return;
  let lista;
  try {
    const r = await fetch(`${SERVIDOR}/cortesias`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!r.ok) { el.innerHTML = ''; return; }
    lista = (await r.json()).cortesias;
  } catch (e) { return; }
  const data = t => (t ? new Date(t).toLocaleDateString('pt-BR') : '');
  el.innerHTML = `<h3 class="prova-sub">Dar cortesia</h3>
    <form class="cortesia-nova" id="cortesia-nova">
      <input name="nome" maxlength="60" placeholder="Nome da pessoa" aria-label="Nome da pessoa">
      <input name="email" type="email" placeholder="E-mail da pessoa" aria-label="E-mail da pessoa" required>
      <input name="telefone" type="tel" maxlength="20" placeholder="WhatsApp (opcional)" aria-label="WhatsApp da pessoa (opcional)">
      <select name="dias" aria-label="Dias de cortesia"><option value="7">7 dias</option><option value="15" selected>15 dias</option><option value="30">30 dias</option><option value="90">90 dias</option><option value="180">6 meses</option><option value="365">1 ano</option></select>
      <button class="cta cta-a" type="submit">Dar cortesia</button>
      <p class="lead-msg" role="status" hidden></p>
    </form>
    ${lista.length ? `<ul class="cortesias">${lista.map(c => `<li><p><b>${prazoCortesia(c.dias)}</b> · ${c.nome ? `${escR(c.nome)} · ` : ''}${escR(c.email)}${c.telefone ? ` · <a href="https://wa.me/${escR(c.telefone)}" target="_blank" rel="noopener">WhatsApp</a>` : ''} <small>dada em ${data(c.criadoEm)} · ${c.pendente ? `<em class="cort-espera">ainda não ativou</em>${c.reenviadoEm ? ` · e-mail reenviado em ${data(c.reenviadoEm)}` : ''}` : `${c.ativadaEm ? `ativou em ${data(c.ativadaEm)}, ` : ''}até ${data(c.ate)}`}</small></p><div class="cort-reenviar">${c.pendente ? `<button type="button" class="cta cta-b" data-reenviar="${escR(c.email)}">Reenviar e-mail</button>` : ''}<button type="button" class="cta cta-b cort-excluir" data-excluir="${escR(c.id)}" data-email="${escR(c.email)}" data-dias="${escR(c.dias)}" data-estado="${c.pendente ? 'pendente' : c.ate && new Date(c.ate).getTime() > Date.now() ? 'ativa' : 'encerrada'}">Excluir</button>${renovarCortesiaHtml(c)}<span role="status"></span></div></li>`).join('')}</ul>` : ''}`;
}
$('#painel-cortesias').addEventListener('click', e => {
  const b = e.target.closest('[data-renovar]');
  if (!b) return;
  const f = $('#cortesia-nova');
  f.elements.email.value = b.dataset.renovar;
  f.elements.nome.value = b.dataset.nome || '';
  f.elements.telefone.value = b.dataset.telefone || '';
  f.elements.dias.value = ['7','15','30','90','180','365'].includes(b.dataset.prazo) ? b.dataset.prazo : '15';
  const m = f.querySelector('.lead-msg');
  m.textContent = 'Confira os dados, escolha o novo período e confirme em Dar cortesia. Os dias começam na próxima entrada, ou são somados se já houver acesso ativo.';
  m.className = 'lead-msg'; m.hidden = false;
  f.scrollIntoView({ block: 'center', behavior: 'smooth' });
  f.elements.dias.focus({ preventScroll: true });
});
$('#painel-cortesias').addEventListener('click', async e => {
  const b = e.target.closest('[data-reenviar]');
  if (!b) return;
  const aviso = b.parentElement.querySelector('[role=status]');
  b.disabled = true; aviso.textContent = 'Enviando...'; aviso.className = '';
  try {
    const r = await fetch(`${SERVIDOR}/cortesia/reenviar`, { method: 'POST', headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: b.dataset.reenviar }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro);
    b.textContent = 'E-mail reenviado'; aviso.textContent = `Peça para olhar também o spam de ${b.dataset.reenviar}.`;
  } catch (er) { aviso.textContent = er.message || 'Não deu agora. Tente de novo.'; aviso.className = 'erro'; b.disabled = false; }
});
$('#painel-cortesias').addEventListener('click', async e => {
  const b = e.target.closest('[data-excluir]');
  if (!b) return;
  const { excluir: id, email, dias, estado } = b.dataset;
  const efeito = estado === 'pendente' ? 'O convite deixa de valer e os dias não serão liberados.'
    : estado === 'ativa' ? `O prazo de ${prazoCortesia(dias)} sai do acesso dessa pessoa agora. O que ela pagou continua valendo.`
    : 'A cortesia já terminou, então só o registro sai da lista.';
  if (!confirm(`Excluir a cortesia de ${email}? ${efeito} Não dá para desfazer.`)) return;
  const aviso = b.parentElement.querySelector('[role=status]');
  b.disabled = true; aviso.textContent = 'Excluindo...'; aviso.className = '';
  try {
    const r = await fetch(`${SERVIDOR}/cortesia/excluir`, { method: 'POST', headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro);
    desenharCortesiasPainel(); desenharAssinantesPainel();
  } catch (er) { aviso.textContent = er.message || 'Não deu agora. Tente de novo.'; aviso.className = 'erro'; b.disabled = false; }
});
$('#painel-cortesias').addEventListener('submit', async e => {
  if (e.target.id !== 'cortesia-nova') return;
  e.preventDefault();
  const f = e.target, b = f.querySelector('button'), m = f.querySelector('.lead-msg');
  const email = f.elements.email.value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { m.textContent = 'Digite o e-mail da pessoa.'; m.className = 'lead-msg erro'; m.hidden = false; return; }
  if (!confirm(`Dar ${f.elements.dias.value} dias grátis para ${email}? A pessoa recebe um e-mail e os dias só começam a contar quando ela entrar no site pela primeira vez (quem já tem acesso ganha os dias somados na hora).`)) return;
  b.disabled = true;
  try {
    const r = await fetch(`${SERVIDOR}/cortesia`, { method: 'POST', headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ nome: f.elements.nome.value, email, telefone: f.elements.telefone.value, dias: f.elements.dias.value }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.erro);
    alert(`${d.pendente ? 'Cortesia dada. Os dias começam a contar no primeiro acesso da pessoa, e você recebe um e-mail quando ela ativar.' : `Cortesia somada: acesso até ${new Date(d.ate).toLocaleDateString('pt-BR')}.`}${d.enviado ? ' O e-mail foi enviado; peça para conferir também o spam.' : ' O e-mail não saiu agora: avise a pessoa para entrar no site com esse e-mail.'}`);
    desenharCortesiasPainel(); desenharAssinantesPainel();
  } catch (er) { m.textContent = er.message || 'Não deu agora.'; m.className = 'lead-msg erro'; m.hidden = false; b.disabled = false; }
});

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
  const situacao = a => (a.pendente && !a.ativo ? '<span class="ass-sit">Cortesia: falta o 1º acesso</span>' : a.cancelado && !a.ativo ? '<span class="ass-sit cancelado">Cancelado</span>' : a.ativo ? '<span class="ass-sit ativo">Ativo</span>' : '<span class="ass-sit vencido">Vencido</span>');
  const forma = f => ({ pix: 'Pix', credit_card: 'cartão' }[f] || f);
  const pag = p => (p ? `${reais(p.preco)}${p.forma ? ` · ${escR(forma(p.forma))}` : ''}${p.parcelas > 1 ? ` ${p.parcelas}x` : ''}<small>${data(p.pagoEm)}${p.status === 'cancelado' ? ' · cancelado' : ''}</small>` : '—');
  const ativos = lista.filter(a => a.ativo).length;
  el.innerHTML = `<h3 class="prova-sub">Assinantes · ${ativos} ${ativos === 1 ? 'ativo' : 'ativos'} de ${lista.length}</h3>` + (lista.length
    ? `<div class="quanto-rolar"><table class="quanto-tab painel-ass"><thead><tr><th>Assinante</th><th>Plano</th><th>Válido até</th><th>Pagamento</th><th></th></tr></thead><tbody>
      ${lista.map(a => `<tr data-email="${escR(a.email)}">
        <th>${a.nome ? escR(a.nome) : '<span class="ass-semnome">sem nome</span>'}<small>${escR(a.email)}${a.instagram ? ` · <a href="https://instagram.com/${escR(a.instagram)}" target="_blank" rel="noopener">@${escR(a.instagram)}</a>` : ''}${a.telefone ? ` · <a href="https://wa.me/${escR(a.telefone)}" target="_blank" rel="noopener">WhatsApp ${escR(a.telefone.replace(/^55(\d\d)(\d+)(\d{4})$/, '($1) $2-$3'))}</a>` : ''}</small></th>
        <td>${escR(a.plano === 'anual' ? 'Anual' : a.plano === 'mensal' ? 'Mensal' : a.plano === 'cortesia' ? 'Cortesia' : a.plano || '—')}</td>
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
  x.fillText('ondeasmilhasmelevam.com.br', W / 2, 1812);
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
addEventListener('hashchange', () => {
  if (location.hash !== '#painel') return;
  if ((auth.currentUser?.email || '').toLowerCase() !== DONO) { location.hash = '#inicio'; return; }
  desenharPainel();
});

// Aba Painel no menu: aparece só para o e-mail do dono (quem decide o acesso é o servidor, pela lista ADMINS).
const DONO = 'ondeasmilhasmelevam@gmail.com';
// Trocou de conta (ou saiu): apaga o que o painel mostrou na conta anterior antes de qualquer coisa.
function limparPainel() {
  ['#painel-campanha', '#painel-cortesias', '#painel-assinantes', '#painel-depos'].forEach(id => { const el = $(id); if (el) el.innerHTML = ''; });
  $('#painel-conteudo').innerHTML = '<p class="passagens-vazio">Este painel é só do dono do site.</p>';
}
let versaoConta = 0;
async function sincronizarConta(user) {
  const versao = ++versaoConta;
  const dono = (user?.email || '').toLowerCase() === DONO;
  $('#menu-painel').hidden = !dono;
  $('#painel').hidden = !dono; // para quem não é o dono, a página do painel nem existe
  if (!dono) { limparPainel(); if (location.hash === '#painel') location.hash = '#inicio'; }
  const estado = await lerAssinatura(user);
  if (versao !== versaoConta) return;
  estado.nome = (user && user.displayName) || ''; // barra superior: nome de quem entrou com o Google
  desenharConta(estado);
  desenharIndicacao(estado);
  desenharDepoimento(estado);
  if (location.hash === '#painel') desenharPainel();
  desenharHistorico(estado.email);
  await lerRadares(estado.ativo ? estado.email : '');
  if (versao !== versaoConta) return;
  avisar(estado);
  desenharRadar();
}
onAuthStateChanged(auth, sincronizarConta);
$('#ass-revalidar').addEventListener('click', async () => {
  const b = $('#ass-revalidar'); b.disabled = true;
  try { await sincronizarConta(auth.currentUser); } finally { b.disabled = false; }
});

// Volta do pagamento da InfinitePay.
if (new URLSearchParams(location.search).get('pagamento') === 'ok') {
  // Tira o ?pagamento=ok sem hash e só então muda o hash: assim o hashchange abre a página Assinar,
  // onde fica a mensagem (antes o hash já vinha pronto e a pessoa ficava no Início sem ver o aviso).
  history.replaceState(null, '', location.pathname);
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
  if (!r.ok) { const erro = new Error(d.erro || 'Não deu agora. Tente de novo em instantes.'); erro.status = r.status; throw erro; }
  return d;
}
$('#ass-entrar-link').addEventListener('click', async () => {
  const b = $('#ass-entrar-link');
  const segredo = window.oammlEntradaLink?.ler();
  if (!segredo) { $('#ass-entrar').hidden = false; $('#ass-login-email').focus(); return msg('Peça um novo link ou entre com Google ou código por e-mail.'); }
  b.disabled = true; msg('Conferindo seu link de acesso…');
  let validado = false;
  try {
    const d = await chamar('/acesso/entrar', { segredo });
    validado = true;
    window.oammlEntradaLink.apagar();
    await signInWithCustomToken(auth, d.token);
    $('#ass-link-card').hidden = true;
    msg('Você entrou. Aguarde a confirmação do seu acesso.', 'ok');
  } catch (e) {
    if (e.status === 401 || validado) { window.oammlEntradaLink.apagar(); $('#ass-link-card').hidden = true; }
    $('#ass-entrar').hidden = false;
    msg(validado ? 'O link foi validado, mas não foi possível concluir o login neste aparelho. Entre com Google ou código por e-mail.' : e.message, 'erro');
  } finally { b.disabled = false; }
});
$('#ass-pedir-link').addEventListener('click', async () => {
  const email = $('#ass-login-email').value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { $('#ass-login-email').focus(); return msg('Digite o e-mail que recebeu o convite ou o e-mail da sua assinatura.', 'erro'); }
  const b = $('#ass-pedir-link'); b.disabled = true;
  try {
    const d = await chamar('/acesso/pedir', { email });
    msg(`Se este e-mail tiver assinatura ou cortesia, o link chega em instantes e vale ${d.minutos} minutos. Veja também o spam. Se acabou de pedir, aguarde 1 minuto antes de tentar novamente.`, 'ok');
  } catch (e) { msg(e.message, 'erro'); }
  finally { b.disabled = false; }
});
$('#ass-form-codigo').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#ass-login-email').value.trim();
  const codigo = $('#ass-codigo').value.replace(/\D/g, '');
  const botao = $('#ass-form-codigo button[type=submit]');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return msg('Digite o e-mail do pagamento ou o endereço que recebeu o convite.', 'erro');
  botao.disabled = true;
  try {
    if ($('#ass-passo-codigo').hidden) {
      const d = await chamar('/codigo', { email });
      $('#ass-passo-codigo').hidden = false;
      $('#ass-login-email').readOnly = true;
      botao.textContent = 'Entrar';
      $('#ass-codigo').focus();
      msg(`Se ${email} tiver assinatura ou cortesia, um código de 7 números chega em instantes. Ele vale ${d.minutos} minutos. Veja também o spam.`, 'ok');
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
    $('#ass-parcela-mensal').textContent = `Pix ou cartão · ${reais(p.mensal * 12)} em 12 meses`;
    $('#ass-preco-anual').textContent = reais(p.anual);
    $('#ass-mes-anual').textContent = reais(Math.round(p.anual / 12));
    $('#ass-de-anual').hidden = p.anual >= p.anualCheio;
    const economia = p.mensal * 12 - p.anual;
    $('#ass-economia').textContent = `Você economiza ${reais(economia)} em relação a 12 meses do mensal`;
    $('#ass-economia').hidden = economia <= 0;
    // Prazo do preço de lançamento: o servidor diz até quando vale; depois disso, o selo volta ao normal.
    const ate = p.lancamentoAte ? new Date(Date.parse(p.lancamentoAte) - 1) : null;
    $('#ass-selo-anual').textContent = ate && p.anual < p.anualCheio
      ? `Melhor preço · 50% off até ${ate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })}` : 'Melhor preço';
    // Os planos do Início usam os mesmos preços.
    const valores = { mensal: p.mensal, anual: p.anual, 'anual-mes': Math.round(p.anual / 12) };
    document.querySelectorAll('[data-preco]').forEach(el => { if (valores[el.dataset.preco]) el.textContent = reais(valores[el.dataset.preco]); });
    document.querySelectorAll('[data-preco-selo]').forEach(el => {
      el.textContent = ate && p.anual < p.anualCheio ? `Anual · 50% off até ${ate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' })}` : 'Anual';
    });
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

// Histórico de preços (só assinantes): o servidor soma cada passagem vista em privado/historico.
let historicoRotas = null;
const MESES_HIST = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const ordemMes = m => { const [a, b] = String(m).split('/'); return (+b || 0) * 12 + MESES_HIST.indexOf(a); };
const mesComAno = ([m]) => /^[A-Z][a-z]{2}\/\d{2}$/.test(m) && MESES_HIST.includes(m.slice(0, 3)); // só "Nov/26"; descarta "novembro" sem ano
const milHist = v => Number(v).toLocaleString('pt-BR');
const normHist = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const haDias = d => { const n = Math.round((Date.now() - new Date(d + 'T12:00:00')) / 864e5); return n <= 0 ? 'hoje' : n === 1 ? 'ontem' : `há ${n} dias`; };
async function carregarHistorico() {
  if (historicoRotas || !auth.currentUser) return;
  try {
    const r = await fetch(`${SERVIDOR}/historico`, { headers: { authorization: `Bearer ${await auth.currentUser.getIdToken()}` } });
    if (!r.ok) throw new Error();
    historicoRotas = Object.values((await r.json()).rotas || {}).map(r => ({ ...r, p: OAMMLProgramas.estatisticas(r.p) }));
  } catch (e) { historicoRotas = null; $('#hist-info').textContent = 'Não deu para carregar o histórico agora. Tente de novo em instantes.'; }
}
// Visão "Por programa": tenho este programa, qual o menor preço que ele já deu, por região e cabine?
// Junta ida e volta da mesma rota (a ponta de fora do Brasil é o destino) e mostra o menor visto por trecho,
// o valor aproximado em reais (milheiro de referência), de onde saiu, quantas vezes e quando.
let histModo = 'rota', histProg = '', histAeros = null, histAbertos = new Set();
const REGIAO_PAIS = (() => {
  const g = { 'América do Sul': 'AR CL UY PY BO PE CO EC VE GY SR', 'América do Norte': 'US CA MX',
    'América Central e Caribe': 'PA CR CU DO JM AW CW BS PR SV GT HN NI BZ BB TT LC SX BQ KY TC VG VI MQ GP HT',
    'Europa': 'PT ES FR IT GB DE NL CH AT BE IE GR FI DK SE NO CZ HU PL HR IS LU MT RO BG RS SI SK EE LV LT MC CY AL ME BA MK',
    'África': 'ZA MA EG ET AO MZ NA MU TZ KE CV SN NG GH TN SC MG RW BW ZW CM CI DZ',
    'Oriente Médio': 'AE QA SA IL JO OM BH KW TR LB', 'Ásia': 'JP CN HK SG TH KR IN MY ID PH LK MV VN TW MO KH NP',
    'Oceania': 'AU NZ FJ PF NC' };
  const m = {};
  for (const [r, cs] of Object.entries(g)) cs.split(' ').forEach(c => { m[c] = r; });
  return m;
})();
const ORDEM_REGIAO = ['Europa', 'América do Norte', 'América do Sul', 'América Central e Caribe', 'África', 'Oriente Médio', 'Ásia', 'Oceania', 'Brasil', 'Outros']; // internacionais primeiro; nacionais no fim
async function aerosHist() {
  if (histAeros) return histAeros;
  try { histAeros = await (await fetch('dados/aeroportos.json')).json(); } catch (e) { histAeros = {}; }
  return histAeros;
}
function porPrograma() {
  // Aeroportos que faltam (ou vêm sem país) em dados/aeroportos.json
  const EXTRA = { AMS: 'NL', MOC: 'BR', SJP: 'BR', CXJ: 'BR', CKS: 'BR', UBA: 'BR', RIA: 'BR', URG: 'BR', LEC: 'BR', ITB: 'BR', PET: 'BR', SJU: 'PR', CUZ: 'PE', JED: 'SA' };
  const A = histAeros || {}, pais = i => (A[i] || [])[2] || EXTRA[i] || '';
  const progs = {};
  for (const r of historicoRotas) {
    const exe = !/econ/i.test(r.c || '');
    const oBR = pais(r.oi) === 'BR', dBR = pais(r.di) === 'BR';
    // destino = a ponta de fora do Brasil; voo nacional: o destino do alerta
    let [dest, destNome, saida] = oBR || !dBR ? [r.di, r.d, r.oi] : [r.oi, r.o, r.di];
    if (dest === 'SCS' && /santa cruz/i.test(destNome)) dest = 'VVI'; // alerta que veio com o código de Shetland
    const regiao = oBR && dBR ? 'Brasil' : REGIAO_PAIS[pais(dest)] || 'Outros';
    for (const [nome, g] of Object.entries(r.p || {})) {
      const P = progs[nome] ||= { nome, linhas: {}, n: 0 };
      const k = `${regiao}|${exe ? 'exe' : 'eco'}|${dest}`;
      const L = P.linhas[k] ||= { regiao, exe, dest, destNome, saidas: new Set(), min: Infinity, minEm: '', minDe: '', n: 0, ult: '' };
      L.saidas.add(saida);
      if (+g.min < L.min) { L.min = +g.min; L.minEm = g.minEm || g.ult; L.minDe = saida; }
      L.n += +g.n || 0;
      if ((g.ult || '') > L.ult) L.ult = g.ult;
      P.n += +g.n || 0;
    }
  }
  return Object.values(progs).map(P => ({ ...P, destinos: new Set(Object.values(P.linhas).map(l => l.dest)).size }))
    .sort((a, b) => b.destinos - a.destinos);
}
async function desenharPorPrograma() {
  await Promise.all([aerosHist(), tetos()]);
  const progs = porPrograma(), cab = $('#hist-cabine').value;
  if (!progs.length) { $('#hist-lista').innerHTML = '<li class="passagens-vazio">Ainda sem histórico.</li>'; return; }
  if (!progs.some(p => p.nome === histProg)) histProg = progs[0].nome;
  $('#hist-progs').innerHTML = progs.map(p => `<button type="button" data-v="${escR(p.nome)}" aria-pressed="${p.nome === histProg}">${escR(p.nome)} <small>${p.destinos}</small></button>`).join('');
  const P = progs.find(p => p.nome === histProg), teto = tetoDeProg(P.nome);
  const linhas = Object.values(P.linhas).filter(l => !cab || (cab === 'eco' ? !l.exe : l.exe));
  $('#hist-info').textContent = `${P.nome}: ${P.destinos} destinos e ${milHist(P.n)} passagens vistas. Menor preço por trecho, sem taxas.${teto ? ` Em reais pelo milheiro de referência (R$ ${teto}).` : ''} É histórico: confirme a data no site do programa.`;
  const blocos = ORDEM_REGIAO.map(reg => [reg, linhas.filter(l => l.regiao === reg)]).filter(([, ls]) => ls.length);
  const linhaHtml = l => {
    const saidas = [...l.saidas], cabine = l.exe ? 'executiva' : 'economica';
    return `<li class="hp-linha">
      <div class="hp-dest"><b>${escR(l.destNome)} <small>${escR(l.dest)}</small></b>
        <span>saindo de ${saidas.slice(0, 4).map(escR).join(', ')}${saidas.length > 4 ? ` e mais ${saidas.length - 4}` : ''}</span></div>
      <div class="hp-min"><b>${milHist(l.min)}</b>${teto ? `<small>≈ ${brR(Math.round(l.min / 1000 * teto))}</small>` : ''}</div>
      <div class="hp-info"><span>menor em ${escR(diaBr(l.minEm))}${l.minDe ? `, saindo de ${escR(l.minDe)}` : ''}</span>
        <span>${l.n} ${l.n === 1 ? 'vez' : 'vezes'} · última ${haDias(l.ult)} · <a href="#rota/${escR(l.minDe || saidas[0])}-${escR(l.dest)}-${cabine}">ver a rota →</a></span></div>
    </li>`;
  };
  $('#hist-lista').innerHTML = blocos.map(([reg, ls]) => {
    const cabs = [['Econômica', ls.filter(l => !l.exe)], ['Executiva ou Primeira', ls.filter(l => l.exe)]].filter(([, x]) => x.length);
    return `<li class="hp-regiao"><h3>${escR(reg)} <small>${ls.length} ${ls.length === 1 ? 'destino' : 'destinos'}</small></h3>
      ${cabs.map(([nomeCab, x]) => {
        const chave = `${P.nome}|${reg}|${nomeCab}`, todos = histAbertos.has(chave);
        x.sort((a, b) => a.min - b.min);
        return `<div class="hp-cab"><p class="hp-cab-t">${nomeCab}</p><ul>${(todos ? x : x.slice(0, 6)).map(linhaHtml).join('')}</ul>
          ${x.length > 6 ? `<button type="button" class="hp-mais" data-chave="${escR(chave)}">${todos ? 'mostrar só os 6 melhores' : `ver os outros ${x.length - 6}`}</button>` : ''}</div>`;
      }).join('')}</li>`;
  }).join('') || '<li class="passagens-vazio">Nenhum destino com esse filtro.</li>';
}
document.addEventListener('click', e => {
  const m = e.target.closest('#hist-modo button'), p = e.target.closest('#hist-progs button'), mais = e.target.closest('.hp-mais');
  if (m) { histModo = m.dataset.modo; desenharPrecosRota(); }
  else if (p) { histProg = p.dataset.v; desenharPrecosRota(); }
  else if (mais) { const k = mais.dataset.chave; histAbertos.has(k) ? histAbertos.delete(k) : histAbertos.add(k); desenharPrecosRota(); }
});
async function desenharPrecosRota() {
  const ativo = !!(window.oammlAssinatura || {}).ativo || (auth.currentUser?.email || '').toLowerCase() === DONO;
  $('#hist-fechado').hidden = ativo;
  $('#hist-aberto').hidden = !ativo;
  if (!ativo || location.hash !== '#historico') return;
  if (!historicoRotas) { $('#hist-info').textContent = 'Carregando o histórico...'; await carregarHistorico(); }
  if (!historicoRotas) return;
  document.querySelectorAll('#hist-modo button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.modo === histModo)));
  $('#hist-progs').hidden = histModo !== 'programa';
  $('#hist-busca-rot').hidden = histModo === 'programa';
  if (histModo === 'programa') return desenharPorPrograma();
  const busca = normHist($('#hist-busca').value.trim()), cab = $('#hist-cabine').value;
  const noAr = new Set((window.oammlPassagens || []).map(p => `${p.origem_iata}-${p.destino_iata}`));
  const lista = historicoRotas.filter(r => (!busca || normHist(`${r.o} ${r.oi} ${r.d} ${r.di}`).includes(busca)) &&
    (!cab || (cab === 'eco' ? /econ/i.test(r.c) : !/econ/i.test(r.c))))
    .sort((a, b) => b.n - a.n || (b.ult || '').localeCompare(a.ult || ''));
  $('#hist-info').textContent = `${lista.length} ${lista.length === 1 ? 'rota' : 'rotas'}${lista.length > 60 ? ' (mostrando as 60 que mais aparecem; busque para achar a sua)' : ''}. Preços por trecho, sem taxas.`;
  $('#hist-lista').innerHTML = lista.slice(0, 60).map(r => {
    const progs = Object.entries(r.p).sort((a, b) => a[1].min - b[1].min);
    const meses = Object.entries(r.m || {}).filter(mesComAno).sort((a, b) => ordemMes(a[0]) - ordemMes(b[0]));
    const maxMes = Math.max(1, ...meses.map(([, n]) => n));
    return `<li class="hist-rota">
      <div class="hist-topo"><b>${escR(r.o)} <small>${escR(r.oi)}</small> → ${escR(r.d)} <small>${escR(r.di)}</small></b>
        <span>${escR(r.c || 'Cabine não informada')} · vista ${r.n}x · última ${haDias(r.ult)}${noAr.has(`${r.oi}-${r.di}`) ? ` · <a data-viagem href="${escR(window.oammlNavegacao.url('passagens', { origem: r.oi, destino: r.di, cabine: /econ/i.test(r.c) ? 'eco' : 'exe' }))}">no ar agora</a>` : ''} · <a href="#rota/${escR(r.oi)}-${escR(r.di)}-${slugCab(r.c)}">ver a rota →</a></span></div>
      <table class="hist-progs"><thead><tr><th>Programa</th><th>Menor preço visto</th><th>Quando</th><th>Vezes</th></tr></thead><tbody>
        ${progs.map(([nome, g]) => `<tr><td>${escR(nome)}</td><td class="num"><b>${milHist(g.min)}</b></td><td>${haDias(g.minEm || g.ult)}</td><td class="num">${g.n}</td></tr>`).join('')}
      </tbody></table>
      ${meses.length ? `<div class="hist-meses"><small>Meses com data aberta</small>${meses.map(([m, n]) =>
        `<span style="--f:${(0.25 + 0.75 * n / maxMes).toFixed(2)}" title="${n} ${n === 1 ? 'vez' : 'vezes'}">${escR(m)}</span>`).join('')}</div>` : ''}
    </li>`;
  }).join('') || '<li class="passagens-vazio">Nenhuma rota com esse filtro ainda. O histórico cresce a cada passagem que o robô encontra.</li>';
}
document.addEventListener('assinatura', desenharPrecosRota);
window.addEventListener('hashchange', desenharPrecosRota);
$('#hist-busca').addEventListener('input', desenharPrecosRota);
$('#hist-cabine').addEventListener('change', desenharPrecosRota);
desenharPrecosRota();

// Página da rota (#rota/GRU-MIA-economica), só assinantes: o servidor devolve o resumo da rota,
// cada alerta já visto (pontos do gráfico), o que está no ar agora (com datas e link) e rotas parecidas.
const rotaCache = {};
let rotaTeto = null, rotaFiltro = '', rotaUn = 'mi', rotaDados = null;
// Mapa de rotas (mapa.js) usa estes dois: quem pode ver e o token para o servidor.
window.oammlPodeVerMapa = () => !!(window.oammlAssinatura || {}).ativo || (auth.currentUser?.email || '').toLowerCase() === DONO;
window.oammlToken = async () => (auth.currentUser ? auth.currentUser.getIdToken() : '');
window.oammlLinkRota = p => `#rota/${p.origem_iata}-${p.destino_iata}-${slugCab(p.cabine)}`;
const progRota = t => { const n = String(t || '').toUpperCase(); return /SMILES/.test(n) ? 'Smiles' : /LATAM/.test(n) ? 'LATAM Pass' : /AZUL/.test(n) ? 'Azul Fidelidade' : String(t || '?'); };
const brR = v => 'R$ ' + Number(v).toLocaleString('pt-BR');
const diaBr = d => { const [a, m, dd] = String(d).slice(0, 10).split('-'); return `${dd}/${m}/${a.slice(2)}`; };
async function tetos() {
  if (rotaTeto) return rotaTeto;
  try {
    const t = await (await fetch('dados/termometro.json', { cache: 'no-cache' })).json();
    if (window.oammlAplicarTetos) window.oammlAplicarTetos(t);
    rotaTeto = Object.fromEntries((t.milheiro || []).filter(m => m.moeda === 'BRL').map(m => [m.programa, m.teto]));
  } catch (e) { rotaTeto = {}; }
  return rotaTeto;
}
function tetoDeProg(p) {
  const n = String(p || '').toUpperCase(), T = rotaTeto || {};
  return /SMILES/.test(n) ? T['Smiles'] : /LATAM/.test(n) ? T['LATAM Pass'] : /AZUL/.test(n) ? T['Azul Fidelidade'] : /AEROPLAN/.test(n) ? T['Aeroplan'] : /TAP|MILES ?& ?GO/.test(n) ? (T['TAP Miles&Go'] || window.MILHEIROS?.TAP || null) : /AADVANTAGE/.test(n) ? (T.AAdvantage || window.MILHEIROS?.AA || null) : /IBERIA|AVIOS|QATAR|BRITISH/.test(n) ? T['Iberia (Avios)'] : null;
}
async function desenharRota(forcar = false) {
  const m = /^#rota\/([A-Z]{3}-[A-Z]{3}-[a-z-]+)$/.exec(location.hash);
  if (!m) return;
  const ativo = !!(window.oammlAssinatura || {}).ativo || (auth.currentUser?.email || '').toLowerCase() === DONO;
  $('#rota-fechado').hidden = ativo;
  $('#rota-aberta').hidden = !ativo;
  const [oi, di] = m[1].split('-');
  $('#rota-h2').textContent = `Histórico da rota ${oi} → ${di}`;
  if (!ativo) return;
  const chave = m[1];
  $('#rota-tentar').hidden = true;
  if (forcar === true || !rotaCache[chave] || Date.now() - rotaCache[chave].em > 300000) {
    $('#rota-info').textContent = 'Carregando a rota...'; $('#rota-corpo').hidden = true;
    try {
      const [r] = await Promise.all([fetch(`${SERVIDOR}/historico/rota?c=${encodeURIComponent(chave)}`, { cache: 'no-store', headers: { authorization: `Bearer ${auth.currentUser ? await auth.currentUser.getIdToken() : ''}` } }), tetos()]);
      if (!r.ok) throw new Error();
      rotaCache[chave] = { dados: await r.json(), em: Date.now() };
    } catch (e) {
      if (location.hash !== `#rota/${chave}`) return;
      $('#rota-info').textContent = 'Não deu para carregar a rota agora. Você pode tentar novamente.';
      $('#rota-tentar').hidden = false;
      return;
    }
  }
  if (location.hash !== `#rota/${chave}`) return; // a pessoa já mudou de página
  if (rotaDados?.chave !== chave) rotaFiltro = '';
  rotaDados = rotaCache[chave].dados;
  const D = rotaDados, R = D.rota;
  if (R) R.p = OAMMLProgramas.estatisticas(R.p);
  D.pts = (D.pts || []).map(p => [...p.slice(0, 4), OAMMLProgramas.normalizar(p[4])]);
  const pts = (D.pts || []).map(([id, data, ida, volta, prog]) => {
    const mi = Math.round((ida + (volta || ida)) / 2), teto = tetoDeProg(prog);
    return { id, t: new Date(data + 'Z').getTime(), data, mi, r: teto ? Math.round(mi / 1000 * teto) : null, teto, prog: progRota(prog), tipo: volta ? 'ida e volta' : 'só ida' };
  }).sort((a, b) => b.t - a.t);
  // alerta muito fora do normal (tarifa cara que entrou no grupo) não entra nas contas nem no gráfico
  const med = [...pts.map(p => p.mi)].sort((a, b) => a - b)[Math.floor((pts.length - 1) / 2)] || 0;
  pts.forEach(p => { p.fora = pts.length >= 4 && p.mi > med * 2.5; });
  D.lista = pts;
  if (!pts.length && !R) { $('#rota-info').textContent = 'Ainda não há alertas desta rota no histórico.'; $('#rota-corpo').hidden = true; return; }
  $('#rota-info').textContent = '';
  $('#rota-corpo').hidden = false;
  const nomeO = R ? R.o : oi, nomeD = R ? R.d : di, cab = R ? R.c : '';
  $('#rota-radar').href = window.oammlNavegacao.url('radar', { origem: oi, destino: di, cabine: /executiva|primeira/i.test(chave) ? 'exe' : /economica/i.test(chave) ? 'eco' : '' });
  $('#rota-radar').setAttribute('data-viagem', '');
  $('#rota-cab').textContent = (cab || 'Cabine não informada').toUpperCase();
  $('#rota-titulo').innerHTML = `${escR(nomeO)} <small>(${oi})</small> <i>✈</i> ${escR(nomeD)} <small>(${di})</small>`;
  const n = R ? R.n : pts.length, desde = R ? R.desde : (pts[pts.length - 1] || {}).data;
  $('#rota-meta').textContent = `${n} ${n === 1 ? 'alerta' : 'alertas'} desde ${desde ? diaBr(desde) : '—'}${R && R.ult ? ' · último ' + haDias(R.ult) : ''}`;
  const progs = {}; pts.forEach(p => { progs[p.prog] = (progs[p.prog] || 0) + 1; });
  $('#rota-chips').innerHTML = [['', 'Todos os programas'], ...Object.entries(progs).sort((a, b) => b[1] - a[1]).map(([p, k]) => [p, `${p} · ${k}`])]
    .map(([v, t]) => `<button type="button" data-p="${escR(v)}" aria-pressed="${v === rotaFiltro}">${escR(t)}</button>`).join('');
  const meses = Object.entries((R && R.m) || {}).filter(mesComAno).sort((a, b) => ordemMes(a[0]) - ordemMes(b[0]));
  const maxMes = Math.max(1, ...meses.map(([, k]) => k));
  $('#rota-meses').innerHTML = meses.length ? `<div class="hist-meses"><small>Meses de viagem que mais aparecem com data aberta</small>${meses.map(([mm, k]) =>
    `<span style="--f:${(0.25 + 0.75 * k / maxMes).toFixed(2)}" title="${k} ${k === 1 ? 'vez' : 'vezes'}">${escR(mm)}</span>`).join('')}</div>` : '';
  $('#rota-parecidas').innerHTML = (D.parecidas || []).map(p => `<a href="#rota/${escR(p.c)}">${p.volta ? '<span class="rota-tag">VOLTA</span>' : ''}<b>${escR(p.o)} → ${escR(p.d)}</b>
      <small>${p.n} ${p.n === 1 ? 'alerta' : 'alertas'}</small><span>a partir de ${milHist(p.min)} milhas</span></a>`).join('') || '<p class="rota-nota">Nenhuma rota parecida no histórico ainda.</p>';
  rotaTudo();
}
const rotaLista = () => (rotaDados.lista || []).filter(a => !rotaFiltro || a.prog === rotaFiltro);
function rotaTudo() { rotaResumo(); rotaGrafico(); rotaAlertas(); rotaOfertas(); }
function rotaOfertas() {
  const lista = (rotaDados?.noAr || []).filter(p => !rotaFiltro || OAMMLProgramas.normalizar(p.programa || p.link_nome) === rotaFiltro);
  $('#rota-noar').innerHTML = `<div class="rota-ofertas-cab"><div><h3 class="rota-tit">Alertas recentes</h3><p>Valores e datas registrados no alerta. Confirme a disponibilidade no programa.</p></div><button type="button" class="rota-atualizar" data-rota-atualizar>Atualizar alertas</button></div>` + (lista.length ? `<ul class="rota-noar">${lista.map((p,i)=>`<li class="rota-oferta"><header><div><b>${escR(OAMMLProgramas.normalizar(p.programa || p.link_nome))}</b>${p.companhia ? `<small>${escR(p.companhia)}</small>` : ''}</div><span>${p.data ? 'Alerta de ' + diaBr(p.data) : 'Alerta recente'}</span></header><div class="rota-oferta-precos"><div><small>Ida</small><b>${escR(p.ida || 'Consultar valor')}</b></div>${p.volta ? `<div><small>Volta</small><b>${escR(p.volta)}</b></div>` : ''}</div><details class="rota-escolher-datas" data-oferta="${i}"><summary>Escolher datas e pesquisar <span aria-hidden="true">＋</span></summary><div class="rota-calendario-conteudo"></div></details></li>`).join('')}</ul>` : '<p class="rota-nota">Não há alertas recentes para este programa e rota. O histórico abaixo continua disponível.</p>');
  $('#rota-noar').querySelector('[data-rota-atualizar]').addEventListener('click', async e => { const b=e.currentTarget; b.disabled=true; b.textContent='Atualizando…'; try { await desenharRota(true); } finally { b.disabled=false; b.textContent='Atualizar alertas'; } });
  $('#rota-noar').querySelectorAll('details[data-oferta]').forEach(d => d.addEventListener('toggle', () => {
    if (!d.open || d.dataset.montado) return;
    const p=lista[+d.dataset.oferta], [origem, destino]=(rotaDados.chave || '').split('-');
    const publico={...p, origem_iata:p.origem_iata || origem, destino_iata:p.destino_iata || destino};
    const el=d.querySelector('.rota-calendario-conteudo');
    if (window.oammlCalendarioAlerta) { el.innerHTML=window.oammlCalendarioAlerta(publico,p); d.dataset.montado='1'; }
    else el.textContent='O calendário ainda está carregando. Feche e abra as datas novamente.';
  }));
}
function rotaResumo() {
  const A = rotaLista(), ok = A.filter(a => !a.fora), comR = ok.filter(a => a.r);
  if (!A.length) { $('#rota-cards').innerHTML = ''; $('#rota-bom').innerHTML = ''; $('#rota-veredito').innerHTML = ''; return; }
  const menor = comR.length ? comR.reduce((x, a) => a.r < x.r ? a : x) : (ok.length ? ok : A).reduce((x, a) => a.mi < x.mi ? a : x);
  const base = ok.length ? ok : A;
  const media = Math.round(base.reduce((s, a) => s + a.mi, 0) / base.length / 100) * 100;
  const mediaR = comR.length ? Math.round(comR.reduce((s, a) => s + a.r, 0) / comR.length) : null;
  const rec = A[0];
  const card = (rot, mi, r, a, cls = '') => `<article class="${cls}"><b>${milHist(mi)} <small>milhas/trecho</small></b><span>${r ? brR(r) + ' em milhas' : ''}</span><em>${rot}</em>${a ? `<small>${escR(a.prog)} · ${diaBr(a.data)}</small>` : ''}</article>`;
  $('#rota-cards').innerHTML = card('Menor custo já visto', menor.mi, menor.r, menor, 'ok') + card('Média do período', media, mediaR) + card('Alerta mais recente', rec.mi, rec.r, rec);
  const rs = comR.map(a => a.r).sort((x, y) => x - y);
  const tipico = rs.length ? rs[Math.floor((rs.length - 1) / 2)] : null;
  const bom = rs.length >= 4 ? rs[Math.max(0, Math.floor(rs.length / 4) - 1)] : null;
  const ultBom = bom ? ok.find(a => a.r && a.r <= bom) : null;
  $('#rota-bom').innerHTML = `<div><b>${tipico ? brR(tipico) : '—'}</b><small>preço típico da rota</small></div>
    <div class="ok"><b>${bom ? 'até ' + brR(bom) : '—'}</b><small>preço bom (25% mais baratos)</small></div>
    <div><b>${ultBom ? diaBr(ultBom.data) : '—'}</b><small>último preço bom</small></div>
    <div><b>${new Set(A.map(a => a.prog)).size}</b><small>programa(s) com alerta</small></div>`;
  const v = $('#rota-veredito');
  if (!bom || !rec.r) {
    v.className = 'rota-veredito'; v.innerHTML = `<span>📊</span><div><b>Ainda poucos alertas para dizer</b><p>Com ${A.length} ${A.length === 1 ? 'alerta' : 'alertas'} aqui, os números ainda não são confiáveis. Veja todos os programas juntos ou volte daqui a alguns dias.</p></div>`;
  } else if (rec.r <= bom) {
    v.className = 'rota-veredito bom'; v.innerHTML = `<span>✅</span><div><b>O alerta mais recente está em preço bom</b><p>${brR(rec.r)} em milhas por trecho, entre os 25% mais baratos que já apareceram nesta rota.</p></div>`;
  } else if (rec.r <= tipico) {
    v.className = 'rota-veredito'; v.innerHTML = `<span>🤔</span><div><b>Abaixo do típico, mas ainda não é preço bom</b><p>O alerta mais recente (${brR(rec.r)}) está ${Math.round((rec.r / bom - 1) * 100)}% acima do preço bom. Se aparecer até ${brR(bom)}, vale emitir.</p></div>`;
  } else {
    v.className = 'rota-veredito caro'; v.innerHTML = `<span>⏳</span><div><b>Acima do normal: vale esperar</b><p>O alerta mais recente (${brR(rec.r)}) está ${Math.round((rec.r / tipico - 1) * 100)}% acima do típico desta rota. Preço bom aqui é até ${brR(bom)}; ative o aviso para saber quando aparecer.</p></div>`;
  }
}
function rotaGrafico() {
  const svg = $('#rota-svg'), tip = $('#rota-tip'), area = svg.parentElement;
  tip.hidden = true;
  if ($('#rota-corpo').hidden || !area.clientWidth) return;
  const val = d => rotaUn === 'mi' ? d.mi : d.r;
  const txt = v => rotaUn === 'mi' ? milHist(v) + ' milhas' : brR(v);
  const curto = v => rotaUn === 'mi' ? (v >= 1000 ? Math.round(v / 1000) + 'k' : String(v)) : brR(v);
  const eixo = v => rotaUn === 'mi' ? Math.round(v / 1000) + 'k' : 'R$ ' + (v >= 1000 ? (v / 1000).toFixed(1).replace('.', ',') + 'k' : Math.round(v));
  const W = area.clientWidth, H = W < 560 ? 250 : 300, L = 52, Rm = 22, T = 26, B = 32;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.style.height = H + 'px';
  const todos = rotaLista(), pts = todos.filter(d => !d.fora && val(d) != null).sort((a, b) => a.t - b.t);
  const fora = todos.filter(d => d.fora).length;
  $('#rota-graf-nota').textContent = `Cada ponto é um alerta da rota (por trecho, sem taxas). Passe o mouse ou toque para ver os detalhes.${fora ? ` ${fora} ${fora === 1 ? 'alerta muito acima do normal ficou' : 'alertas muito acima do normal ficaram'} fora do gráfico e das contas.` : ''}`;
  if (!pts.length) { svg.innerHTML = ''; $('#rota-graf-ultimo').innerHTML = ''; $('#rota-graf-leg').innerHTML = ''; return; }
  const vs = pts.map(val), lo = Math.min(...vs), hi = Math.max(...vs), pad = (hi - lo) * 0.18 || hi * 0.1;
  const ord = [...vs].sort((a, b) => a - b);
  const bom = ord.length >= 4 ? ord[Math.max(0, Math.floor(ord.length / 4) - 1)] : null; // faixa de preço bom: os 25% mais baratos
  const y0 = Math.max(0, lo - pad), y1 = hi + pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const X = t => pts.length === 1 ? (L + W - Rm) / 2 : L + (t - t0) / (t1 - t0 || 1) * (W - L - Rm);
  const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
  const melhor = pts.reduce((x, d) => (val(d) < val(x) ? d : x), pts[0]), ultimo = pts[pts.length - 1];
  const xy = d => [X(d.t), Y(val(d))];
  let s = '<defs><linearGradient id="rota-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="ar0"/><stop offset="1" class="ar1"/></linearGradient></defs>';
  for (let i = 0; i <= 4; i++) { const v = y0 + (y1 - y0) * i / 4; s += `<line class="gr" x1="${L}" x2="${W - Rm}" y1="${Y(v)}" y2="${Y(v)}"/><text class="ax" x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${eixo(v)}</text>`; }
  if (bom != null) {
    const yb = Y(bom), ym = Math.min(Y(lo) + 6, H - B);
    s += `<rect class="faixa" x="${L}" y="${yb}" width="${W - Rm - L}" height="${Math.max(ym - yb, 4)}"/><line class="faixa-top" x1="${L}" x2="${W - Rm}" y1="${yb}" y2="${yb}"/>`;
  }
  const linha = pts.map((d, i) => (i ? 'L' : 'M') + X(d.t).toFixed(1) + ' ' + Y(val(d)).toFixed(1)).join(' ');
  if (pts.length > 1) s += `<path class="area" d="${linha} L${X(t1).toFixed(1)} ${H - B} L${X(t0).toFixed(1)} ${H - B} Z"/>`;
  s += `<path class="ln" d="${linha}"/>`;
  // datas no eixo: a do menor preço em destaque; as outras sem encostar nela
  const xm = X(melhor.t);
  let ult = -99;
  pts.forEach(d => { const x = X(d.t); if (x - ult > 58 && Math.abs(x - xm) > 46) { s += `<text class="ax" x="${x}" y="${H - 9}" text-anchor="middle">${diaBr(d.data).slice(0, 5)}</text>`; ult = x; } });
  s += `<text class="ax forte" x="${xm}" y="${H - 9}" text-anchor="middle">${diaBr(melhor.data).slice(0, 5)}</text><line class="guia" x1="${xm}" x2="${xm}" y1="${Y(val(melhor)) + 9}" y2="${H - B}"/>`;
  s += `<line class="cruz" y1="${T}" y2="${H - B}" visibility="hidden"/>`;
  pts.forEach((d, i) => { const [x, y] = xy(d); s += `<circle class="pt${d === melhor ? ' best' : ''}${d === ultimo ? ' ult' : ''}" cx="${x}" cy="${y}" r="${d === melhor ? 6.5 : d === ultimo ? 5.5 : 4}" data-i="${i}"/>`; });
  // etiqueta do menor preço (caixa dourada) e valor do último alerta
  const [mx, my] = xy(melhor), rot = curto(val(melhor)), larg = rot.length * 7.4 + 16;
  const bx = Math.min(Math.max(mx - larg / 2, L), W - Rm - larg), by = my + 14 + 22 <= H - B ? my + 14 : my - 36;
  s += `<rect class="etq" x="${bx}" y="${by}" width="${larg}" height="22" rx="6"/><text class="etq-t" x="${bx + larg / 2}" y="${by + 15}" text-anchor="middle">${rot}</text>`;
  if (ultimo !== melhor) { const [ux, uy] = xy(ultimo); s += `<text class="val" x="${Math.min(ux, W - Rm - 4)}" y="${uy - 11}" text-anchor="${ux > W - 70 ? 'end' : 'middle'}">${curto(val(ultimo))}</text>`; }
  svg.innerHTML = s;
  // cabeçalho: último alerta e quanto está acima do menor; legenda embaixo
  const dif = val(melhor) ? Math.round((val(ultimo) / val(melhor) - 1) * 100) : 0;
  $('#rota-graf-ultimo').innerHTML = `<small>Último alerta</small><b>${txt(val(ultimo))}</b><span class="${dif <= 0 ? 'ok' : ''}">${dif <= 0 ? 'é o menor do período' : `+${dif}% do menor`}</span>`;
  $('#rota-graf-leg').innerHTML = `<span><i class="lg-ln"></i>Preço de cada alerta</span><span><i class="lg-pt"></i>Menor do período</span>${bom != null ? `<span><i class="lg-fx"></i>Preço bom: até ${txt(bom)} (os 25% mais baratos)</span>` : ''}`;
  const cruz = svg.querySelector('.cruz');
  const mostrar = k => {
    const d = pts[k], [x, y] = xy(d);
    cruz.setAttribute('visibility', 'visible'); cruz.setAttribute('x1', x); cruz.setAttribute('x2', x);
    svg.querySelectorAll('.pt').forEach(p => p.classList.toggle('on', +p.dataset.i === k));
    const outro = rotaUn === 'mi' ? (d.r ? brR(d.r) + ' em milhas' : '') : milHist(d.mi) + ' milhas';
    tip.innerHTML = `<b>${txt(val(d))}</b><span>${outro} · por trecho</span><span>${escR(d.prog)} · ${d.tipo}</span><small>${diaBr(d.data)} às ${d.data.slice(11, 16)}</small>${d === melhor ? `<em>⭐ ${rotaUn === 'mi' ? 'menos milhas' : 'menor custo'} do período</em>` : bom != null && val(d) <= bom ? '<em>✅ na faixa de preço bom</em>' : ''}`;
    tip.hidden = false;
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(Math.max(x - tw / 2, 4), W - tw - 4) + 'px';
    tip.style.top = Math.max(y - tip.offsetHeight - 14, 0) + 'px';
  };
  svg.onpointermove = e => { const r = svg.getBoundingClientRect(), mx2 = (e.clientX - r.left) * W / r.width; let k = 0, dm = 1e9; pts.forEach((d, i) => { const dd = Math.abs(X(d.t) - mx2); if (dd < dm) { dm = dd; k = i; } }); mostrar(k); };
  svg.onpointerleave = () => { tip.hidden = true; cruz.setAttribute('visibility', 'hidden'); svg.querySelectorAll('.pt').forEach(c => c.classList.remove('on')); };
}
function rotaAlertas() {
  const A = rotaLista(), comR = A.filter(a => a.r && !a.fora);
  const menor = comR.length ? comR.reduce((x, a) => a.r < x.r ? a : x) : null;
  $('#rota-lista').innerHTML = A.map(a => `<li${a.fora ? ' class="fora"' : ''}><div><b>${milHist(a.mi)} milhas</b><small>por trecho · ${a.tipo}</small></div>
    <div><span>${escR(a.prog)}</span><small>${diaBr(a.data)}</small></div>
    <div class="r">${a.r ? brR(a.r) : '—'}<small>${a.fora ? 'muito acima do normal' : a.teto ? 'milheiro R$ ' + a.teto : ''}</small></div>
    ${a === menor ? '<span class="rota-estrela">⭐ menor custo</span>' : ''}</li>`).join('') || '<li class="passagens-vazio">Nenhum alerta com esse filtro.</li>';
}
$('#rota-chips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !rotaDados) return;
  rotaFiltro = b.dataset.p;
  $('#rota-chips').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  rotaTudo();
});
document.querySelectorAll('.rota-tog button').forEach(b => b.addEventListener('click', () => {
  rotaUn = b.dataset.u;
  document.querySelectorAll('.rota-tog button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
  if (rotaDados) rotaGrafico();
}));
// Compartilhar: o link /r/GRU-LIS.html (feito pelo robô) mostra a rota e a foto do destino no WhatsApp e leva a esta página.
// Rota sem página própria ainda usa o endereço desta página. No celular abre a lista de apps; no computador, copia.
$('#rota-copiar').addEventListener('click', async () => {
  const b = $('#rota-copiar');
  const m = location.hash.match(/^#rota\/([A-Z]{3})-([A-Z]{3})/);
  let url = location.href;
  if (m) {
    const curto = `${location.origin}/r/${m[1]}-${m[2]}.html`;
    try { if ((await fetch(curto, { method: 'HEAD', cache: 'no-store' })).ok) url = curto; } catch (e) { /* fica o endereço desta página */ }
  }
  const titulo = (document.querySelector('#rota h2') || {}).textContent || 'Rota com milhas';
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: titulo, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); b.textContent = '✅ Link copiado'; }
  catch (e) { b.textContent = url; }
  setTimeout(() => { b.textContent = '🔗 Compartilhar rota'; }, 2500);
});
addEventListener('resize', () => { if (rotaDados && location.hash.startsWith('#rota/')) rotaGrafico(); });
$('#rota-tentar').addEventListener('click', () => desenharRota(true));
document.addEventListener('assinatura', desenharRota);
window.addEventListener('hashchange', desenharRota);
desenharRota();

// Notificação no celular (Rota Vigiada): inscreve o aparelho no servidor (/push/inscrever).
// No iPhone só funciona com o site instalado na tela de início e aberto pelo ícone (regra da Apple).
const VAPID_PUBLICA = 'BIfMzD3hDjr3utuwKluSdfqiyU8nJGk4siNqn-wk3e4YlTe4kuzr-hJjdVMW6LgUln7TxO5pwmblGeAl5w1nQa4';
const pushIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const pushApp = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const chaveBytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function pushChamar(rota, dados) {
  const token = await window.oammlToken();
  const r = await fetch(`${SERVIDOR}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(dados) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.erro || 'Não deu agora. Tente de novo em instantes.');
  return d;
}
async function pushInscricao() {
  if (!pushOk) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}
async function desenharPush(msg) {
  const info = $('#push-info'), ligar = $('#push-ligar'), teste = $('#push-teste');
  if (!info) return;
  const ajuda = $('#push-ajuda'), textoAjuda = $('#push-ajuda-texto');
  if (textoAjuda) textoAjuda.innerHTML = pushIos
    ? '<ol><li>Abra pelo ícone da Tela de Início e entre na mesma conta em que salvou sua rota.</li><li>Em Ajustes → Notificações, procure também por <b>Onde as Milhas</b> (nome curto do app) ou pelo nome escolhido ao instalar. Se aparecer, ative Permitir Notificações.</li><li>Se não aparecer na lista, confira a instalação pelo Safari: Compartilhar → Adicionar à Tela de Início. Se houver a opção Abrir como App da Web, ela deve estar ligada.</li></ol><p>Se você já fez isso e o app continua ausente dos Ajustes, fale conosco em <a href="#contatos">Contatos</a>, informando sua versão do iOS e a mensagem desta tela. Ainda não é possível confirmar a causa só por esse aviso.</p>'
    : '<ol><li>No Android, abra o site pelo Chrome: menu ⋮ → Controles do site → Permissões → Notificações → Permitir. Os nomes podem variar conforme a versão.</li><li>Confira também se o sistema permite notificações para o Chrome ou para o app instalado.</li><li>No computador, use o ícone de controles ao lado do endereço para permitir as notificações deste site.</li></ol>';
  teste.hidden = true;
  ligar.hidden = false;
  if (pushIos && !pushApp) {
    info.textContent = 'No iPhone, a Apple só deixa avisar no celular com o site instalado como app. Instale, abra pelo ícone e ative aqui.';
    ligar.textContent = 'Como instalar';
    ligar.dataset.acao = 'instalar';
    return;
  }
  if (!pushOk) { info.textContent = 'Este navegador não recebe notificações. Use o Chrome (Android) ou o app instalado (iPhone).'; ligar.hidden = true; return; }
  if (Notification.permission === 'denied') {
    info.textContent = 'A permissão de notificações está negada neste aparelho. Abra “Como liberar as notificações” abaixo para conferir os próximos passos.';
    ligar.hidden = true;
    if (ajuda) ajuda.open = true;
    return;
  }
  const sub = await pushInscricao().catch(() => null);
  if (sub && Notification.permission === 'granted') {
    info.textContent = msg || 'Permissão liberada neste aparelho. Envie um teste para conferir o recebimento.';
    ligar.textContent = 'Desativar';
    ligar.dataset.acao = 'desligar';
    teste.hidden = false;
  } else {
    info.textContent = msg || 'Aviso na tela do celular assim que aparecer passagem nas suas rotas, além do e-mail.';
    ligar.textContent = 'Ativar';
    ligar.dataset.acao = 'ligar';
  }
}
$('#push-ligar').addEventListener('click', async () => {
  const b = $('#push-ligar');
  if (b.dataset.acao === 'instalar') { if (window.oammlInstalar) window.oammlInstalar(); return; }
  b.disabled = true;
  try {
    if (b.dataset.acao === 'desligar') {
      const sub = await pushInscricao();
      if (sub) { await pushChamar('/push/sair', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
      await desenharPush('Desligado neste aparelho. Os e-mails da Rota Vigiada continuam.');
      return;
    }
    if (await Notification.requestPermission() !== 'granted') { await desenharPush(); return; }
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveBytes(VAPID_PUBLICA) });
    const d = await pushChamar('/push/inscrever', { inscricao: sub.toJSON(), aparelho: pushIos ? 'iPhone' : /Android/i.test(navigator.userAgent) ? 'Android' : 'Computador' });
    await desenharPush(d.teste ? 'Inscrição salva. O serviço aceitou o envio de boas-vindas; confira se chegou neste aparelho.' : 'Inscrição salva, mas o envio de boas-vindas não foi confirmado. Use Enviar teste para tentar novamente.');
  } catch (e) {
    $('#push-info').textContent = e.message || 'Não deu para ativar agora. Tente de novo.';
  } finally { b.disabled = false; }
});
$('#push-teste').addEventListener('click', async () => {
  const b = $('#push-teste');
  b.disabled = true;
  $('#push-info').textContent = 'Enviando teste para este aparelho…';
  try {
    const sub = await pushInscricao();
    if (!sub) { await desenharPush('Este aparelho ainda não tem uma inscrição. Toque em Ativar.'); return; }
    // Testa somente a inscrição deste aparelho, vinculada à conta autenticada no servidor.
    const d = await pushChamar('/push/teste', { endpoint: sub.endpoint });
    $('#push-info').textContent = d.mensagem || (d.ok ? 'O serviço aceitou o envio do teste para pelo menos um aparelho da conta. Confira a Central de Notificações.' : 'O serviço não confirmou o envio. Confira a permissão e tente desativar e ativar neste aparelho.');
  }
  catch (e) { $('#push-info').textContent = e.message; }
  finally { b.disabled = false; }
});
document.addEventListener('assinatura', () => desenharPush());
$('#push-verificar')?.addEventListener('click', async () => {
  const b = $('#push-verificar');
  b.disabled = true;
  try { await desenharPush(); }
  catch (e) { $('#push-info').textContent = 'Não foi possível verificar agora. Tente novamente.'; }
  finally { b.disabled = false; }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') desenharPush().catch(() => {});
});
desenharPush();
