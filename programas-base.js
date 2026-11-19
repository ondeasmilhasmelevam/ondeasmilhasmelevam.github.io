/* Nomes de programas compartilhados pelo site e pelo servidor. Moeda Avios não é um programa único. */
(() => {
  const lista = [
    ['turkish', 'Turkish Miles&Smiles', 'turkish|miles\\s*&\\s*smiles', 'Star Alliance'],
    ['latam', 'LATAM Pass', 'latam', ''],
    ['azul', 'Azul Fidelidade', 'tudo\\s*azul|azul', ''],
    ['smiles', 'Smiles', '\\bsmiles\\b|gol\\s*smiles', ''],
    ['tap', 'TAP Miles&Go', '\\btap\\b|miles\\s*(?:&|and|e)\\s*go', 'Star Alliance'],
    ['finnair', 'Finnair Plus', 'finnair', 'oneworld'],
    ['suma', 'SUMA (Air Europa)', '\\bsuma\\b|air\\s*europa', 'SkyTeam'],
    ['ana', 'ANA Mileage Club', '\\bana\\b|all\\s*nippon', 'Star Alliance'],
    ['qatar', 'Qatar Privilege Club', 'qatar|privilege\\s*club', 'oneworld'],
    ['iberia', 'Iberia Club', 'iberia', 'oneworld'],
    ['british', 'British Airways Club', 'british|executive\\s*club', 'oneworld'],
    ['american', 'AAdvantage', 'aadvantage|american\\s*airlines|^american$', 'oneworld'],
    ['flyingblue', 'Flying Blue', 'flying\\s*blue|air\\s*france|\\bklm\\b', 'SkyTeam'],
    ['aeroplan', 'Aeroplan', 'aeroplan|air\\s*canada', 'Star Alliance'],
    ['connectmiles', 'ConnectMiles', 'connect\\s*miles|\\bcopa\\b', 'Star Alliance'],
    ['united', 'United MileagePlus', 'united|mileage\\s*plus', 'Star Alliance'],
    ['emirates', 'Emirates Skywards', 'emirates|skywards', ''],
    ['etihad', 'Etihad Guest', 'etihad', ''],
    ['singapore', 'KrisFlyer', 'singapore|kris\\s*flyer', 'Star Alliance'],
    ['lufthansa', 'Miles & More', 'lufthansa|miles\\s*&\\s*more', 'Star Alliance'],
    ['delta', 'Delta SkyMiles', 'delta|sky\\s*miles', 'SkyTeam'],
    ['virgin', 'Virgin Atlantic Flying Club', 'virgin\\s*atlantic|flying\\s*club', 'SkyTeam'],
    ['alaska', 'Atmos Rewards', 'alaska|atmos\\s*rewards|mileage\\s*plan', 'oneworld'],
    ['ethiopian', 'ShebaMiles', 'ethiopian|sheba\\s*miles', 'Star Alliance'],
    ['saudia', 'Saudia AlFursan', 'saudia|al\\s*fursan', 'SkyTeam'],
    ['eurobonus', 'SAS EuroBonus', 'euro\\s*bonus|^sas$', 'SkyTeam'],
    ['aeromexico', 'Aeroméxico Rewards', 'aeromexico|club\\s*premier', 'SkyTeam'],
    ['qantas', 'Qantas Frequent Flyer', 'qantas', 'oneworld'],
    ['velocity', 'Velocity', 'velocity|virgin\\s*australia', ''],
    ['jetblue', 'JetBlue TrueBlue', 'jetblue|true\\s*blue', ''],
    ['avios', 'Avios (programa não informado)', '^avios(?:\\s*\\(programa nao informado\\))?$', '']
  ].map(([id, nome, padrao, alianca]) => ({ id, nome, alianca, re: new RegExp(padrao, 'i') }));
  const limpar = t => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  const buscar = t => lista.find(p => p.id === limpar(t).toLowerCase() || p.re.test(limpar(t)));
  const normalizar = t => buscar(t)?.nome || String(t || '').trim();
  const combinar = objeto => {
    const saida = {};
    for (const [nome, valor] of Object.entries(objeto || {})) {
      const k = normalizar(nome), a = saida[k] || [0, ''];
      saida[k] = [a[0] + (+valor[0] || 0), valor[1] > a[1] ? valor[1] : a[1]];
    }
    return saida;
  };
  const estatisticas = objeto => {
    const saida = {};
    for (const [nome, g] of Object.entries(objeto || {})) {
      const k = normalizar(nome), antes = saida[k];
      if (!antes) { saida[k] = { ...g }; continue; }
      if (+g.min < +antes.min) { antes.min = g.min; antes.minEm = g.minEm; }
      antes.n = (+antes.n || 0) + (+g.n || 0);
      if ((g.ult || '') > (antes.ult || '')) antes.ult = g.ult;
    }
    return saida;
  };
  globalThis.OAMMLProgramas = { lista, buscar, normalizar, combinar, estatisticas };
})();
