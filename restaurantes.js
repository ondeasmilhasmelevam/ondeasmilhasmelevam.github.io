/* Restaurantes VIP nos aeroportos do Brasil (guia Onde as Milhas Me Levam).
   Cada restaurante diz por qual programa entra: 'dp' = Dragon Pass,
   'lkpp' = LoungeKey / Priority Pass. Para mudar a lista, edite aqui. */
window.RESTAURANTES_VIP = {
  valores: [
    { rede: 'lkpp', titulo: 'LoungeKey e Priority Pass', valor: 'US$ 27 ou 28', texto: 'Valor fixo por acesso para consumir no restaurante.' },
    { rede: 'dp', titulo: 'Dragon Pass', valor: 'US$ 32', texto: 'Valor fixo ou menu fixo com opções. Precisa do app Visa Airport.' }
  ],
  dicas: [
    { icone: 'sino', titulo: 'Vale até no desembarque', texto: 'Alguns restaurantes liberam a entrada no desembarque, além do embarque e da conexão, inclusive no exterior. Pergunte no balcão.' },
    { icone: 'relogio', titulo: 'Regra das 5 horas no Dragon Pass', texto: 'Usou um restaurante pelo Dragon Pass? Outro restaurante ou sala VIP só depois de 5 horas. Geralmente passa 1 acesso por cartão; tente com outro cartão seu.' }
  ],
  aeroportos: [
    { cidade: 'Belém', lista: [['Forneria', 'dp'], ['Heineken', 'dp', 'lkpp']] },
    { cidade: 'Belo Horizonte', sub: 'Confins · CNF', lista: [['Belo Bar', 'dp'], ['Heineken', 'dp'], ['LIQD', 'dp']] },
    { cidade: 'Brasília', lista: [['Living Heineken', 'dp']] },
    { cidade: 'Campinas', sub: 'Viracopos', lista: [['Heineken', 'dp', 'lkpp'], ['Umrry', 'dp']] },
    { cidade: 'Florianópolis', lista: [['A Saideira', 'dp'], ['Heineken', 'dp']] },
    { cidade: 'Fortaleza', lista: [['A Saideira', 'dp'], ['Living Heineken', 'dp'], ['Rokkon', 'dp'], ['Vignoli Cucina', 'dp']] },
    { cidade: 'Foz do Iguaçu', lista: [['Heineken', 'dp']] },
    { cidade: 'Goiânia', lista: [['Heineken', 'dp']] },
    { cidade: 'Ilhéus', lista: [['Vesúvio', 'dp']] },
    { cidade: 'Maceió', lista: [['Living Heineken', 'dp']] },
    { cidade: 'Porto Alegre', lista: [['Living Heineken', 'dp'], ['Rokkon', 'dp']] },
    { cidade: 'Recife', lista: [['Bonaparte', 'dp'], ['Heineken', 'dp'], ['Paço Real', 'lkpp']] },
    { cidade: 'Rio de Janeiro', sub: 'Galeão · GIG', lista: [['A Saideira', 'dp'], ['Grand Cru', 'lkpp'], ['Palaphita', 'lkpp']] },
    { cidade: 'Rio de Janeiro', sub: 'Santos Dumont · SDU', lista: [['Heineken (em breve)', 'dp']] },
    { cidade: 'Salvador', lista: [['Barzetti', 'dp'], ['Mesa de Tereza', 'dp']] },
    { cidade: 'São Luís', lista: [['Heineken', 'dp']] },
    { cidade: 'São Paulo', sub: 'Congonhas · CGH', lista: [['A Saideira', 'dp'], ['A’ Dam', 'dp'], ['Casa Qualycom', 'dp'], ['Forneria', 'dp']] },
    {
      cidade: 'São Paulo', sub: 'Guarulhos · GRU', terminais: [
        { nome: 'Terminal 1', lista: [['Heineken', 'lkpp']] },
        { nome: 'Terminal 2', lista: [['Bleriot', 'lkpp'], ['Burger Boss', 'dp'], ['Forneria', 'dp'], ['General Prime', 'dp'], ['Heineken', 'dp'], ['Rokkon', 'dp'], ['Seara', 'dp']] },
        { nome: 'Terminal 3', lista: [['Bleriot', 'lkpp'], ['General Prime', 'dp'], ['Living Heineken', 'dp'], ['Paris 6', 'lkpp'], ['Rokkon', 'dp'], ['Tryp', 'lkpp']] }
      ]
    },
    { cidade: 'Vitória', lista: [['A Saideira', 'dp'], ['Heineken', 'dp']] }
  ]
};
