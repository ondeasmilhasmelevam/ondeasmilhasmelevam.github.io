/* Preço bom para comprar milhas: até quanto vale pagar pelo milheiro
   (1.000 milhas ou pontos). Referência do Onde as Milhas Me Levam.
   Para atualizar, mude os valores aqui. "icone" é o arquivo em img/programas/app/ (sem .webp);
   "tipo" aparece embaixo do nome; "fundo" e "tinta" só valem se o ícone não carregar. */
window.PRECO_MILHAS_DATA = '2026-11-18'; // mude junto com os preços: aparece como "Preços revisados em ..."
// Minha carteira: quanto valem os pontos de cada pessoa.
// 1) VALOR_VENDA: melhor oferta de venda do milheiro (o que se recebe vendendo). Atualize com a lista do dia.
window.VALOR_VENDA_DATA = '2026-11-23';
window.VALOR_VENDA = {
  'Alaska Mileage Plan': 95, 'AAdvantage': 90, 'ALL Accor': 80, 'Miles & More': 75, 'ConnectMiles': 63,
  'Aeroplan': 60, 'Qatar Privilege Club': 60, 'Virgin Atlantic Flying Club': 60, 'Finnair Plus': 58,
  'Iberia Plus': 54, 'British Airways Club': 54, 'TAP Miles&Go': 46, 'LATAM Pass': 26,
  'Smiles': 16, 'Azul Fidelidade': 16, 'Aegean Miles+Bonus': 68, 'Livelo': 31, 'Esfera': 35
};
// 2) Programas sem venda, com valor de referência do milheiro.
window.VALOR_MILHEIRO_EXTRA = { 'C6 Átomos': 35 };
// 3) O resto entra pelo preço bom de compra abaixo (PRECO_MILHAS).
window.PRECO_MILHAS = [
  { nome: 'Azul Fidelidade', icone: 'azul', tipo: 'Azul', preco: 'R$ 14 ou menos', fundo: '#1D63F0', tinta: '#FFFFFF' },
  { nome: 'Smiles', icone: 'smiles', tipo: 'GOL', preco: 'R$ 16 ou menos', fundo: '#FF8A00', tinta: '#FFFFFF' },
  { nome: 'LATAM Pass', icone: 'latam', tipo: 'LATAM', preco: 'R$ 25 ou menos', fundo: '#3B1FD1', tinta: '#FFFFFF' },
  { nome: 'Avios', icone: 'avios', tipo: 'Iberia, British Airways e Qatar', preco: 'R$ 50 a 56', fundo: '#1B1F8C', tinta: '#FFFFFF' },
  { nome: 'TAP Miles&Go', icone: 'tap', tipo: 'TAP Air Portugal', preco: 'R$ 35 a 40', fundo: '#FFFFFF', tinta: '#D71920' },
  { nome: 'LifeMiles', icone: 'avianca', tipo: 'Avianca', preco: 'R$ 65 a 70', fundo: '#E1231A', tinta: '#FFFFFF' },
  { nome: 'Aeroplan', icone: 'aeroplan', tipo: 'Air Canada', preco: 'R$ 75 ou menos', fundo: '#111111', tinta: '#FFFFFF' },
  { nome: 'Miles & More', icone: 'lufthansa', tipo: 'Lufthansa', preco: 'R$ 65 a 76', fundo: '#0B1F5C', tinta: '#FFFFFF' },
  { nome: 'Livelo', icone: 'livelo', tipo: 'Banco de pontos', preco: 'R$ 31 ou menos', fundo: '#E6199A', tinta: '#FFFFFF' },
  { nome: 'Esfera', icone: 'esfera', tipo: 'Banco de pontos', preco: 'R$ 35 ou menos', fundo: '#111111', tinta: '#FFFFFF' },
  { nome: 'ConnectMiles', icone: 'copa', tipo: 'Copa Airlines', preco: 'R$ 55 a 65', fundo: '#B07A4E', tinta: '#FFFFFF' },
  { nome: 'AAdvantage', icone: 'aadvantage', tipo: 'American Airlines', preco: 'R$ 90 ou menos', fundo: '#FFFFFF', tinta: '#0078D2' },
  { nome: 'Miles+Bonus', icone: 'aegean', tipo: 'Aegean', preco: 'R$ 68', fundo: '#FFFFFF', tinta: '#1B2A6B' },
  { nome: 'Flying Blue', icone: 'flyingblue', tipo: 'Air France e KLM', preco: 'R$ 75 ou menos', fundo: '#1A1AC8', tinta: '#FFFFFF' },
  { nome: 'JAL Mileage Bank', icone: 'jal', tipo: 'Japan Airlines · via Marriott', preco: 'R$ 84 ou menos', fundo: '#FFFFFF', tinta: '#C8102E' },
  { nome: 'SUMA', icone: 'aireuropa', tipo: 'Air Europa · preço em euro', preco: '€ 10', fundo: '#0A6FC2', tinta: '#FFFFFF' }
];

window.PRECO_MILHAS.forEach(item => {
  const teto = (window.REFERENCIAS_COMPRA || {})[item.nome];
  if (teto != null) item.preco = `R$ ${teto} ou menos`;
});
