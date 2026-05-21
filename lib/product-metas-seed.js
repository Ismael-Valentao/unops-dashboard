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
  // Granéis (kg) — apenas produtos da nossa jurisdição
  "Milho":              { qty: 1627925,   unit: "kg" },
  "Arroz":              { qty: 1458450,   unit: "kg" },
  "Feijão Vulgar":      { qty: 2391045,   unit: "kg" },
  "Emamectim Benzoato": { qty: 79701.5,   unit: "kg" },
  "Imidacloprid":       { qty: 65117,     unit: "kg" },
  "MCPA":               { qty: 43753.5,   unit: "kg" },
  // Removidos por estarem fora da jurisdição UNOPS/AQI:
  //   Couve, Alface, NPK 12.24.12, Enxada
};

module.exports = { METAS };
