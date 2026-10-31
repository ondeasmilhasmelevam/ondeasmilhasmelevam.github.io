/* Correções do site por cima da planilha do colega (o arquivo dele não muda).
   A chave é o nome do cartão como aparece no site (sem acentos, maiúsculas).
   - pontuacao: pontos por US$ 1 em compras nacionais (troca o número da planilha);
   - exterior: pontos por US$ 1 em compras internacionais (aparece na ficha; a conta usa a nacional);
   - gastoNoLugarDoDolar: a fórmula da planilha usa a célula do dólar onde devia usar a do gasto;
   - isencaoInvestindo: quanto investir no banco para não pagar anuidade (campo do simulador).
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
  fora: ['BANESE BANESE CARD'],
  // Anuidade zerada para quem tem pelo menos "valor" investido no banco (tirado das observações da planilha).
  // "trecho" separa cartões com o mesmo nome; "gastoMin" quando a regra pede gasto e investimento juntos.
  isencaoInvestindo: [
    { cartao: 'NUBANK CROMA', valor: 30000 },
    { cartao: 'BTG+ BLACK', valor: 40000 },
    { cartao: 'NUBANK ULTRAVIOLETA', valor: 50000 },
    { cartao: 'PICPAY CARD', valor: 50000 },
    { cartao: 'C6 BANK', trecho: 'investe a partir de R$ 50 mil', valor: 50000 },
    { cartao: 'SANTANDER UNIQUE', valor: 50000, gastoMin: 8000 },
    { cartao: 'BANESCARD', valor: 150000 },
    { cartao: 'PORTO SEGURO', valor: 200000 },
    { cartao: 'BTG ULTRABLUE', valor: 400000 },
    { cartao: 'BANCO DO BRASIL ALTUS LIV', valor: 2000000 },
    { cartao: 'UNICRED IMPAR', valor: 3000000 },
    { cartao: 'ITAU THE ONE', valor: 5000000 },
    { cartao: 'BRADESCO AETERNUM', valor: 5000000 },
    { cartao: 'C6 BANK GRAPHENE WORLD LEGEND', valor: 5000000 }
  ]
};
