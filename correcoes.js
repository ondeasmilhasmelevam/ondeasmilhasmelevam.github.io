/* Correções do site por cima da planilha do colega (o arquivo dele não muda).
   A chave é o nome do cartão como aparece no site (sem acentos, maiúsculas).
   - pontuacao: pontos por US$ 1 em compras nacionais (troca o número da planilha);
   - exterior: pontos por US$ 1 em compras internacionais (aparece na ficha; a conta usa a nacional);
   - gastoNoLugarDoDolar: a fórmula da planilha usa a célula do dólar onde devia usar a do gasto;
   - isencaoInvestindo: quanto investir no banco para não pagar anuidade (campo do simulador);
   - mensal: parcela mensal da anuidade por faixa de gasto, do maior gasto para o menor: [[gasto mínimo, parcela], ...];
     a última faixa vale para qualquer gasto (troca a fórmula da planilha; a anuidade é a parcela × 12);
   - obsTroca: trechos das observações da planilha que mudaram: [[texto antigo, texto novo], ...]
     (se o colega mudar o texto, a troca simplesmente não acontece).
   Conferido em 31/10/2026 nos sites dos bancos e em sites de cartões; Altus, Altus Liv, Caixa Ícone e
   Caixa Elo Diners conferidos de novo em 10/11/2026 nas páginas oficiais do BB e da Caixa. */
window.CORRECOES = {
  conferido: '2026-11-10',
  cartoes: {
    // bb.com.br/site/private/cartoes/altus: R$ 4.000 (12x R$ 333,33) desde 13/07/2026; 50% a partir de R$ 25 mil; isenção a partir de R$ 40 mil.
    'BANCO DO BRASIL ALTUS': {
      exterior: 5,
      mensal: [[40000, 0], [25000, 166.67], [0, 333.33]],
      obsTroca: [
        ['Promoção prorrogada até 30/09/2026', 'Promoção até 31/12/2026'],
        ['Faturas com valor acima de R$ 25 mil você isenta a anuidade', ' Anuidade de R$ 4.000 (12x R$ 333,33): 50% de desconto com faturas a partir de R$ 25 mil e isenção a partir de R$ 40 mil ou com R$ 5 milhões investidos no BB']
      ]
    },
    // bb.com.br/site/estilo/cartoes/altus-liv: R$ 3.600 (12x R$ 300); 50% acima de R$ 15 mil; isenção a partir de R$ 25 mil.
    'BANCO DO BRASIL ALTUS LIV': {
      gastoNoLugarDoDolar: true, exterior: 4, // nacional: 3 até R$ 15 mil, 3,5 até R$ 25 mil, 4 acima
      mensal: [[25000, 0], [15000, 150], [0, 300]],
      obsTroca: [['Isenção de anuidade com gastos mensais a partir de 25.000 ou mantendo 2 milhões investidos no BB.',
        'Anuidade de R$ 3.600 (12x R$ 300): 50% de desconto com gasto mensal acima de R$ 15 mil e isenção a partir de R$ 25 mil ou com R$ 2 milhões investidos no BB.']]
    },
    // caixa.gov.br .../credito/icone: R$ 1.650 (12x R$ 137,50); Private: isenção no primeiro ano. A planilha já tem as faixas certas.
    'CAIXA ICONE': {
      obsTroca: [['Clientes Private têm isenção total.', 'Anuidade de R$ 1.650 (12x R$ 137,50); clientes Private têm isenção no primeiro ano.']]
    },
    'SANTANDER UNIQUE': { pontuacao: 2.2, exterior: 3 },
    'SANTANDER UNLIMITED': { exterior: 3.6 },
    'XP INVESTIMENTOS PRIVILEGE': { pontuacao: 5, exterior: 7 },
    'C6 BANK GRAPHENE WORLD LEGEND': { pontuacao: 5, exterior: 8 },
    // caixa.gov.br .../credito/elodiners: 3 e 4 pontos; R$ 1.440 (12x R$ 120); 50% a partir de R$ 7 mil; 100% a partir de R$ 14 mil.
    'CAIXA ELO DINERS': {
      pontuacao: 3, exterior: 4,
      mensal: [[14000, 0], [7000, 60], [0, 120]],
      obsTroca: [
        ['2,5 pontos para cada 1 dólar gasto em compras nacionais e 3,5 pontos em compras internacionais', '3 pontos para cada 1 dólar gasto em compras nacionais e 4 pontos em compras internacionais'],
        ['Valor da anuidade de volta em crédito da fatura gastando a partir de 10.000 por mês. Fatura de 5.000 tem 50% de desconto.',
          'Anuidade de R$ 1.440 (12x R$ 120), de volta na fatura gastando a partir de R$ 14 mil por mês; a partir de R$ 7 mil, 50% de desconto.']
      ]
    }
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
    { cartao: 'BANCO DO BRASIL ALTUS', valor: 5000000 },
    { cartao: 'UNICRED IMPAR', valor: 3000000 },
    { cartao: 'ITAU THE ONE', valor: 5000000 },
    { cartao: 'BRADESCO AETERNUM', valor: 5000000 },
    { cartao: 'C6 BANK GRAPHENE WORLD LEGEND', valor: 5000000 }
  ]
};
