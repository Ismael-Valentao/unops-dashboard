/**
 * Metas de fornecimento por fornecedor e por produto.
 *
 * Cada entrada indica quanto o fornecedor SE COMPROMETEU a entregar ao projecto.
 * Usado por /admin/fornecido para calcular "Pendente" = max(0, meta − fornecido).
 *
 * UNIDADES: kg para granéis (Milho, Feijão, Arroz). Para sacos herméticos
 * (caso venha a haver meta) usar a chave "Sacos Hermét." em UNIDADES.
 *
 * MATCH DE NOME: usa equivalência fuzzy (normName + substring nas duas
 * direcções). Os nomes na API podem variar:
 *   "SEEDCO" ↔ "SeedCo"
 *   "BAYER" ↔ "BAYER MOZAMBIQUE, LDA - TENDERS"
 *   "AGT" ↔ "AGT Foods Africa Pty, Lda"
 *   "MAHOMED" ↔ "Mahomed Agro Investimentos, SU LDA"
 *
 * EDIÇÃO: este ficheiro é editado à mão pela operação. Mudar aqui propaga
 * imediatamente a /admin/fornecido sem precisar de migração. Quando estiver
 * estável, considerar migrar para tabela DB (supplier_metas).
 */

// Metas — keys são tokens de match. Valores são objectos { Produto: qty_em_kg }.
// Quando a quantidade for "0" ou null, o produto fica registado como "meta
// pendente de definir" e a página mostra "—" em vez de calcular pendente.
const METAS = {
  SEEDCO: {
    "Milho":  923560,
    "Feijão": 1620440,
  },
  BAYER: {
    "Milho": 488272,
  },
  AGT: {
    "Feijão": 300000,
  },
  PHOENIX: {
    "Milho": 215000,
  },
  MOZSEEDS: {
    "Feijão": 290440,
  },
  RENAISSANCE: {
    "Feijão": 170000,
  },
  AGRIBUSINESS: {
    "Arroz": null,   // por definir — utilizador vai fornecer
  },
  "SEMENTES LIMPOPO": {
    "Arroz": 420000,
  },
  MAHOMED: {
    // user disse "125000" sem produto — pela API é tudo Arroz
    "Arroz": 125000,
  },
  AGROMEC: {
    "Arroz": 20000,
  },
};

/**
 * Normaliza nome para match: uppercase + sem acentos + remove sufixos
 * empresariais comuns + colapsa espaços.
 */
function normName(s) {
  return String(s || "")
    .trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[,\.]/g, " ")
    .replace(/\bLDA\.?\b|\bSU\b|\bS\.?A\.?\b|\bSARL\b|\bTENDERS?\b|\bMO[CÇ]AMBIQUE\b|\bMZ\b|\bPTY\b|\bINVESTIMENTOS\b|\bFOODS?\b|\bAFRICA\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Devolve as metas para um fornecedor, fazendo fuzzy match contra as keys
 * de METAS. Match em 3 fases (cada vez menos restritiva):
 *   1. Exact normName equality
 *   2. Supplier name contains meta key (e.g., "BAYER MOCAMBIQUE" contém "BAYER")
 *   3. Meta key contains supplier name (raro — quando supplier name é truncado)
 *
 * Devolve { Produto: kg, … } ou null se nenhum match.
 */
function getMetasFor(canonicalName) {
  if (!canonicalName) return null;
  const n = normName(canonicalName);
  if (!n) return null;
  // Phase 1: exact
  for (const [k, v] of Object.entries(METAS)) {
    if (normName(k) === n) return { matched_key: k, metas: v };
  }
  // Phase 2: supplier contains meta key (mais comum)
  for (const [k, v] of Object.entries(METAS)) {
    const nk = normName(k);
    if (nk && n.includes(nk)) return { matched_key: k, metas: v };
  }
  // Phase 3: meta key contains supplier (caso raro)
  for (const [k, v] of Object.entries(METAS)) {
    const nk = normName(k);
    if (n && nk.includes(n)) return { matched_key: k, metas: v };
  }
  return null;
}

module.exports = { METAS, getMetasFor, normName };
