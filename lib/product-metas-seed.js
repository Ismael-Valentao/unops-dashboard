/**
 * Snapshot inicial das metas por produto (global, não por fornecedor).
 * Usado para fazer seed da tabela `product_metas` na primeira corrida.
 *
 * Estas são as metas GLOBAIS de contratação por produto, independentes
 * das supplier_metas. Mostradas no topo dos cards em /admin/fornecido.
 *
 * Depois do seed, fonte de verdade é a tabela DB (editável via UI).
 */

const METAS = {
  // Granéis (kg)
  "Milho":              { qty: 1627925,   unit: "kg" },
  "Arroz":              { qty: 1458450,   unit: "kg" },
  "Feijão Vulgar":      { qty: 2391045,   unit: "kg" },
  "Couve":              { qty: 1594030,   unit: "kg" },
  "Alface":             { qty: 1594030,   unit: "kg" },
  "NPK 12.24.12":       { qty: 7970150,   unit: "kg" },
  "Enxada":             { qty: 159403,    unit: "un" },  // unidades — ferramenta
  "Emamectim Benzoato": { qty: 79701.5,   unit: "kg" },
  "Imidacloprid":       { qty: 65117,     unit: "kg" },
  "MCPA":               { qty: 43753.5,   unit: "kg" },
};

module.exports = { METAS };
