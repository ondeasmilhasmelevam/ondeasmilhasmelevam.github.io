/* Correções do site por cima da planilha do colega (o arquivo dele não muda).
   A chave é o nome do cartão como aparece no site (sem acentos, maiúsculas).
   - pontuacao: pontos por US$ 1 em compras nacionais (troca o número da planilha);
   - exterior: pontos por US$ 1 em compras internacionais (aparece na ficha; a conta usa a nacional);
   - gastoNoLugarDoDolar: a fórmula da planilha usa a célula do dólar onde devia usar a do gasto.
   Conferido em 31/10/2026 nos sites dos bancos e em sites de cartões. */
window.CORRECOES = {
  conferido: '2026-10-31',
  cartoes: {
    'BANCO DO BRASIL ALTUS LIV': { gastoNoLugarDoDolar: true, exterior: 4 }, // nacional: 3 até R$ 15 mil, 3,5 até R$ 25 mil, 4 acima
    'SANTANDER UNIQUE': { pontuacao: 2.2, exterior: 3 },
    'SANTANDER UNLIMITED': { exterior: 3.6 },
    'XP INVESTIMENTOS PRIVILEGE': { pontuacao: 5, exterior: 7 },
    'C6 BANK GRAPHENE WORLD LEGEND': { pontuacao: 5, exterior: 8 },
    'CAIXA ELO DINERS': { pontuacao: 3, exterior: 4 }
  },
  // Cartões que saem da lista do site.
  fora: ['BANESE BANESE CARD']
};
