/**
 * Metas globais por PRODUTO (não por fornecedor).
 *
 * Usado pelo topo dos cards em /admin/fornecido — sobrepõe o cálculo
 * antigo (que era a soma das supplier_metas) com um valor explícito por
 * produto.
 *
 * Fonte: tabela `product_metas` na DB. Cache em memória 30s.
 *
 * Match fuzzy: normaliza nome (sem acentos, lowercase) e procura por
 * substring nas duas direcções para apanhar variantes:
 *   "Feijão" (canonical do SKU MAP)  ↔  "Feijão Vulgar" (na tabela)
 *   "Emamectim" (canonical)          ↔  "Emamectim Benzoato"
 */

const { query } = require("../db/mysql");

let _cache = { metas: null, expiresAt: 0 };
const CACHE_TTL_MS = 30 * 1000;

function _norm(s) {
  return String(s || "")
    .trim().toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

async function _loadFromDb() {
  if (_cache.metas && Date.now() < _cache.expiresAt) return _cache.metas;
  try {
    const rows = await query(
      "SELECT product, qty, unit, note FROM product_metas WHERE active = 1"
    );
    const m = {};
    for (const r of rows) {
      m[r.product] = {
        qty: r.qty == null ? null : Number(r.qty),
        unit: r.unit,
        note: r.note,
      };
    }
    _cache = { metas: m, expiresAt: Date.now() + CACHE_TTL_MS };
    return m;
  } catch (e) {
    // Fallback ao seed se DB falhar
    try {
      const { METAS } = require("./product-metas-seed");
      return METAS;
    } catch (_) { return {}; }
  }
}

function invalidateProductMetasCache() {
  _cache = { metas: null, expiresAt: 0 };
}

/** Devolve a meta para um produto canónico (Milho/Feijão/etc.) ou null. */
async function getProductMetaAsync(canonicalName) {
  if (!canonicalName) return null;
  const cn = _norm(canonicalName);
  const metas = await _loadFromDb();
  // 1) Match exacto
  for (const [k, v] of Object.entries(metas)) {
    if (_norm(k) === cn) return { ...v, matched_key: k };
  }
  // 2) Match: key da tabela CONTÉM o canónico ("Feijão Vulgar" contém "Feijão")
  for (const [k, v] of Object.entries(metas)) {
    if (_norm(k).includes(cn)) return { ...v, matched_key: k };
  }
  // 3) Match: canónico CONTÉM a key da tabela (raro)
  for (const [k, v] of Object.entries(metas)) {
    if (cn.includes(_norm(k))) return { ...v, matched_key: k };
  }
  return null;
}

/** Versão sync — requer cache primed. */
function getProductMeta(canonicalName) {
  if (!_cache.metas) return null;
  if (!canonicalName) return null;
  const cn = _norm(canonicalName);
  const metas = _cache.metas;
  for (const [k, v] of Object.entries(metas)) {
    if (_norm(k) === cn) return { ...v, matched_key: k };
  }
  for (const [k, v] of Object.entries(metas)) {
    if (_norm(k).includes(cn)) return { ...v, matched_key: k };
  }
  for (const [k, v] of Object.entries(metas)) {
    if (cn.includes(_norm(k))) return { ...v, matched_key: k };
  }
  return null;
}

async function primeProductMetasCache() {
  return _loadFromDb();
}

function listAllProductMetas() {
  return _cache.metas ? { ..._cache.metas } : {};
}

module.exports = {
  getProductMeta,
  getProductMetaAsync,
  primeProductMetasCache,
  invalidateProductMetasCache,
  listAllProductMetas,
};
