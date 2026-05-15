/**
 * Metas de fornecimento por fornecedor e por produto.
 *
 * Fonte de verdade: tabela `supplier_metas` em MySQL (editável via
 * /admin/supplier-metas). Este módulo lê e expõe um cache em memória com
 * TTL curta para não martelar a DB.
 *
 * Match de nome é fuzzy (normName + substring nas duas direcções).
 * Os nomes na API podem variar:
 *   "SEEDCO" ↔ "SeedCo"
 *   "BAYER" ↔ "BAYER MOZAMBIQUE, LDA - TENDERS"
 *   "MAHOMED" ↔ "Mahomed Agro Investimentos, SU LDA"
 *   "SANA" ↔ "SANA (organizações MH-Tenders)"
 *   "GLOBAL AGRIBUSINESS" ↔ "GLOBAL AGRIBUSINESS, EI - TENDERS"
 *
 * UNIDADES: kg para granéis (Milho, Feijão, Arroz, Emamectim, Imidacloprid,
 * MCPA). Para "Sacos Hermét." qty é em UNIDADES (un). NULL = "por definir".
 */

const { query } = require("../db/mysql");

let _cache = { metas: null, expiresAt: 0 };
const CACHE_TTL_MS = 30 * 1000; // 30s — actualizações UI propagam quase imediato

/**
 * Carrega metas da DB e cacheia. Devolve o objecto METAS:
 *   { SEEDCO: { "Milho": 923560, "Feijão": 1620440, ... }, ... }
 */
async function _loadMetasFromDb() {
  if (_cache.metas && Date.now() < _cache.expiresAt) return _cache.metas;
  try {
    const rows = await query(
      "SELECT meta_key, product, qty FROM supplier_metas WHERE active = 1 ORDER BY meta_key, product"
    );
    const m = {};
    for (const r of rows) {
      if (!m[r.meta_key]) m[r.meta_key] = {};
      m[r.meta_key][r.product] = r.qty == null ? null : Number(r.qty);
    }
    _cache = { metas: m, expiresAt: Date.now() + CACHE_TTL_MS };
    return m;
  } catch (e) {
    // Fallback ao seed se DB falhar (migração ainda não correu, etc.)
    console.warn("[supplier-metas] DB load falhou, usando seed:", e.message);
    try {
      const { METAS } = require("./supplier-metas-seed");
      return METAS;
    } catch (_) {
      return {};
    }
  }
}

/**
 * Invalida cache — chamado pelo endpoint de edição quando o utilizador
 * grava mudanças, para que o próximo request veja já os novos valores.
 */
function invalidateMetasCache() {
  _cache = { metas: null, expiresAt: 0 };
}

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
 * Devolve as metas para um fornecedor — versão ASYNC (lê da DB).
 * Fuzzy match em 3 fases, prefere keys mais longas para evitar conflitos
 * (ex: "GLOBAL AGRIBUSINESS" antes de "AGRIBUSINESS").
 */
async function getMetasForAsync(canonicalName) {
  if (!canonicalName) return null;
  const n = normName(canonicalName);
  if (!n) return null;
  const METAS = await _loadMetasFromDb();
  // Phase 1: exact
  for (const [k, v] of Object.entries(METAS)) {
    if (normName(k) === n) return { matched_key: k, metas: v };
  }
  // Phase 2: supplier contains meta key — preferir keys longas primeiro
  const entries = Object.entries(METAS).map(([k, v]) => [k, v, normName(k)]);
  entries.sort((a, b) => b[2].length - a[2].length);
  for (const [k, v, nk] of entries) {
    if (nk && n.includes(nk)) return { matched_key: k, metas: v };
  }
  // Phase 3: meta key contains supplier
  for (const [k, v, nk] of entries) {
    if (n && nk.includes(n)) return { matched_key: k, metas: v };
  }
  return null;
}

/**
 * Versão SÍNCRONA — usa o cache se disponível, senão lança erro.
 * Usado por código legacy (aggregateSuppliers) que ainda é sync.
 * Chamadores devem garantir que o cache foi pré-carregado via primeMetasCache().
 */
function getMetasFor(canonicalName) {
  if (!_cache.metas) return null;
  if (!canonicalName) return null;
  const n = normName(canonicalName);
  if (!n) return null;
  const METAS = _cache.metas;
  for (const [k, v] of Object.entries(METAS)) {
    if (normName(k) === n) return { matched_key: k, metas: v };
  }
  const entries = Object.entries(METAS).map(([k, v]) => [k, v, normName(k)]);
  entries.sort((a, b) => b[2].length - a[2].length);
  for (const [k, v, nk] of entries) {
    if (nk && n.includes(nk)) return { matched_key: k, metas: v };
  }
  for (const [k, v, nk] of entries) {
    if (n && nk.includes(n)) return { matched_key: k, metas: v };
  }
  return null;
}

/**
 * Pré-carrega o cache. Chamadores async devem chamar isto antes de usar
 * getMetasFor() / METAS sync.
 */
async function primeMetasCache() {
  return _loadMetasFromDb();
}

/**
 * Acesso ao objecto METAS completo (para iteração — ex: ghost suppliers).
 * Devolve o cache se disponível, senão {}.
 */
function METAS_proxy() {
  return _cache.metas || {};
}

module.exports = {
  get METAS() { return METAS_proxy(); },
  getMetasFor,
  getMetasForAsync,
  primeMetasCache,
  invalidateMetasCache,
  normName,
};
