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

// Metas — keys são tokens de match. Valores são objectos { Produto: qty }.
// Para granéis (Milho/Feijão/Arroz/Emamectim/Imidacloprid/MCPA) qty é em kg.
// Para "Sacos Hermét." qty é em UNIDADES (un).
// Quando a quantidade for null, o produto fica registado como "meta por
// definir" e a página mostra "—" em vez de calcular pendente.
const METAS = {
  SEEDCO: {
    "Milho":  923560,
    "Feijão": 1620440,
    "Arroz":   222000,
  },
  BAYER: {
    "Milho": 488272,
  },
  AGT: {
    "Feijão": 300000,
  },
  PHOENIX: {
    "Milho":  215000,
    "Arroz":   28810,
  },
  MOZSEEDS: {
    "Feijão": 290440,
    "Arroz":  700000,
  },
  RENAISSANCE: {
    "Feijão": 170000,
  },
  AGRIBUSINESS: {
    "Arroz": null,         // por definir
  },
  "SEMENTES LIMPOPO": {
    "Arroz": 400000,       // (era 420.000)
  },
  MAHOMED: {
    "Arroz": 25000,        // (era 125.000) — actualizado pela operação
  },
  AGROMEC: {
    "Arroz": 20000,
  },
  // ── Novos fornecedores ─────────────────────────────────────────
  "GLOBAL AGRIL": {
    "Arroz": 10000,
  },
  ETG: {
    "Arroz": 170000,
  },
  WANBAO: {
    "Arroz": 50000,
  },
  AGRIFOCUS: {
    "Emamectim":    79348,
    "Imidacloprid": 65615,
    "MCPA":         41199,
  },
  // MH Tenders — todos os sacos herméticos são reassignados aqui pelo
  // supplier-reassignments. Meta em UNIDADES (un), não kg.
  "MH-TENDERS": {
    "Sacos Hermét.": 3173920,
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
