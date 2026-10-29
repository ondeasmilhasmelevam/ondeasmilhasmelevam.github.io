/* Valor do milheiro usado nas contas, pela tabela do Onde as Milhas Me Levam
   (maior valor de cada faixa). Substitui o valor da planilha para o programa
   com esse nome; programa que não estiver aqui continua com o da planilha.
   O bônus de transferência continua vindo da planilha. */
window.MILHEIROS = {
  'Smiles': 16,
  'LATAM Pass': 26,
  'Azul Fidelidade': 13,
  'TAP': 40,
  'AA': 90,
  'Avios': 56
};

/* Bônus de transferência mostrado no quadro "Valores usados agora" quando
   a planilha não tem (ou para trocar o dela). null = não mostrar o programa. */
window.BONUS_CONTA = {
  'Azul Fidelidade': 1.0,   // 100%, o mínimo aceitável
  'TAP': null,
  'AA': null
};

/* Bônus mínimo para valer a pena transferir pontos do cartão para a
   companhia. "so" limita a dica a cartões desses programas de pontos e
   "nao" tira dela os cartões que não transferem para a companhia. */
window.BONUS_MINIMO = {
  programas: [
    { nome: 'TudoAzul', minimo: '100%', destino: /AZUL/, nao: /REVOLUT/ },
    { nome: 'Smiles', minimo: '80%', destino: /SMILES|GOL/ },
    { nome: 'LATAM Pass', minimo: '25%', obs: 'Com Clube Turbo LATAM, costuma chegar a 30% ou 35%.', destino: /LATAM/ },
    // No Santander, 2 pontos Esfera = 1 Avios e vale esperar 20% de bônus.
    { nome: 'Iberia Plus', minimo: '20%', destino: /IBERIA|AVIOS/, so: /SANTANDER/, unidade: 'Avios', proporcao: { SANTANDER: 0.5 } },
    // No Revolut é 1 para 1 e, no Brasil, a transferência para a Iberia não tem bônus.
    { nome: 'Iberia Plus', minimo: 'Sem bônus', obs: 'Na Revolut é 1 ponto = 1 Avios, sem promoção de bônus: dá para transferir quando precisar.', destino: /IBERIA|AVIOS/, so: /REVOLUT/, unidade: 'Avios' }
  ],
  dica: 'A estratégia pontos + dinheiro pode valer a pena mesmo com bônus menores.'
};
