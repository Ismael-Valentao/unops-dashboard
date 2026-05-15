/**
 * Snapshot inicial das metas para fazer seed da tabela `supplier_metas`
 * na primeira corrida. Usado apenas se a tabela estiver vazia.
 *
 * Depois do seed, fonte de verdade é a tabela DB (editável via UI
 * em /admin/supplier-metas). Este ficheiro torna-se irrelevante.
 */

const METAS = {
  SEEDCO: {
    "Milho":  923560,
    "Feijão": 1620440,
    "Arroz":   222000,
  },
  BAYER: { "Milho": 488272 },
  AGT:   { "Feijão": 300000 },
  PHOENIX: {
    "Milho":  215000,
    "Arroz":   28810,
  },
  MOZSEEDS: {
    "Feijão": 290440,
    "Arroz":  700000,
  },
  RENAISSANCE: { "Feijão": 170000 },
  "SEMENTES LIMPOPO": { "Arroz": 400000 },
  MAHOMED: { "Arroz": 25000 },
  AGROMEC: { "Arroz": 20000 },
  "GLOBAL AGRIBUSINESS": { "Arroz": 10000 },
  ETG: { "Arroz": 170000 },
  WANBAO: { "Arroz": 50000 },
  AGRIFOCUS: {
    "Emamectim":    79348,
    "Imidacloprid": 65615,
    "MCPA":         41199,
  },
  SANA: { "Sacos Hermét.": 3173920 },
};

module.exports = { METAS };
