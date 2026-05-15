/**
 * Agregação de serviços ADICIONAL por fornecedor (ShipFrom).
 *
 * Problema: o mesmo fornecedor aparece com várias grafias no DMS API:
 *   - "SEEDCO" + "SeedCo"                    → ambos account=53
 *   - "BAYER" + "BAYER Moçambique LDA"       → ambos account=2
 *   - "PHOENIX" + "Phoenix"                  → ambos account=19
 *   - "MOZSEED" + "MOZSEEDS"                 → ambos account=38
 *
 * Solução: usa ShipAcountNumber como chave canónica quando disponível.
 * Para cada chave agregamos:
 *   - canonical_name      (a grafia mais comum)
 *   - aliases             (todas as grafias distintas)
 *   - total_weight (kg)
 *   - total_volumes
 *   - count_services
 *   - by_status           (TRANSITO / FINALIZADO / CRIADO / SEM TRANSPORTE)
 *   - by_sku              (SKU → peso)
 *   - by_province         (província destino → peso)
 *   - origins             (ShipFromAddress distintos)
 *   - first_seen / last_seen (datas)
 *   - in_transit_kg / delivered_kg / pending_kg
 */

/**
 * Normaliza nome para comparação fuzzy (uppercase + sem acentos + sem
 * espaços extras + remove sufixos comuns).
 */
function normName(s) {
  return String(s || "")
    .trim().toUpperCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\bLDA\.?|\bSU\b|\bSA\b|\bSARL\b|\bTENDERS?\b|\bMO[CÇ]AMBIQUE\b|\bMZ\b|\bEI\b/g, "")
    .replace(/[,\.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Determina a chave canónica para agrupar variantes do mesmo fornecedor.
 * Preferência: ShipAcountNumber > normName(ShipFromName).
 */
function supplierKey(row) {
  const acct = String(row.ShipAcountNumber || "").trim();
  if (acct && acct !== "0") return "acct:" + acct;
  const name = String(row.ShipFromName || "").trim();
  if (name) return "name:" + normName(name);
  return "unknown";
}

/**
 * Recebe array de rows da API ADICIONAL. Devolve { suppliers, totals }.
 * suppliers ordenado por total_weight desc.
 */
function aggregateSuppliers(rows, opts = {}) {
  const statusOk = new Set((opts.statuses || ["TRANSITO", "FINALIZADO"]).map((s) => s.toUpperCase()));
  const useAllStatuses = opts.includeAllStatuses === true;

  // Aplica regras de reclassificação de fornecedor (lib/supplier-reassignments)
  // ANTES de qualquer agregação — sacos vão a MH-Tenders, Milho de Adicional
  // Chimoio/Tete vai a BAYER, Feijão de Adicional Tete vai a Renaissance.
  const { reassignRows } = require("./supplier-reassignments");
  rows = reassignRows(rows);

  const byKey = new Map(); // key → entry
  const nameCount = new Map(); // key → Map(name → count) para descobrir nome canónico

  for (const r of rows || []) {
    const status = String(r.StatusName || "").toUpperCase();
    if (!useAllStatuses && !statusOk.has(status)) continue;

    const key = supplierKey(r);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        canonical_name: "",
        aliases: new Set(),
        account_number: String(r.ShipAcountNumber || "").trim() || null,
        total_weight: 0,
        total_volumes: 0,
        count_services: 0,
        by_status: {},
        by_sku: {},      // SKU → { weight, count }
        by_province: {}, // prov → { weight, count }
        origins: new Set(),
        first_seen: null,
        last_seen: null,
        in_transit_kg: 0,
        delivered_kg: 0,
      });
      nameCount.set(key, new Map());
    }
    const x = byKey.get(key);
    const w = Number(r.Weight) || 0;

    // Conta nome para depois escolher a grafia mais comum
    const name = String(r.ShipFromName || "").trim();
    if (name) {
      x.aliases.add(name);
      const nc = nameCount.get(key);
      nc.set(name, (nc.get(name) || 0) + 1);
    }

    // Acumuladores
    x.count_services++;
    x.total_weight += w;
    x.total_volumes += Number(r.VolumesQty) || 0;
    x.by_status[status] = (x.by_status[status] || 0) + 1;
    if (status === "TRANSITO")   x.in_transit_kg += w;
    if (status === "FINALIZADO") x.delivered_kg += w;

    const sku = String(r.SKU || "(sem)").trim();
    if (!x.by_sku[sku]) x.by_sku[sku] = { weight: 0, count: 0 };
    x.by_sku[sku].weight += w;
    x.by_sku[sku].count++;

    const prov = String(r.ReceiverAddress || "(sem)").trim();
    if (!x.by_province[prov]) x.by_province[prov] = { weight: 0, count: 0 };
    x.by_province[prov].weight += w;
    x.by_province[prov].count++;

    const origin = String(r.ShipFromAddress || "").trim();
    if (origin) x.origins.add(origin);

    const created = r.CreateDate ? new Date(r.CreateDate).toISOString().slice(0, 10) : null;
    if (created) {
      if (!x.first_seen || created < x.first_seen) x.first_seen = created;
      if (!x.last_seen  || created > x.last_seen)  x.last_seen  = created;
    }
  }

  // Pós-processamento: escolhe nome canónico (a grafia mais frequente)
  const suppliers = [];
  for (const [key, x] of byKey) {
    const nc = nameCount.get(key);
    let canonical = "";
    let maxCount = -1;
    for (const [name, count] of nc) {
      if (count > maxCount) { maxCount = count; canonical = name; }
    }
    x.canonical_name = canonical || (x.account_number ? `Account ${x.account_number}` : "(sem nome)");
    x.aliases = [...x.aliases].sort();
    x.origins = [...x.origins].sort();
    // Round kg fields
    x.total_weight = Math.round(x.total_weight);
    x.in_transit_kg = Math.round(x.in_transit_kg);
    x.delivered_kg = Math.round(x.delivered_kg);
    // Convert maps to sorted arrays
    x.by_sku = Object.entries(x.by_sku)
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([sku, v]) => ({ sku, weight: Math.round(v.weight), count: v.count }));
    x.by_province = Object.entries(x.by_province)
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([province, v]) => ({ province, weight: Math.round(v.weight), count: v.count }));
    suppliers.push(x);
  }

  suppliers.sort((a, b) => b.total_weight - a.total_weight);

  // Totais agregados
  const totals = {
    suppliers: suppliers.length,
    services: suppliers.reduce((s, x) => s + x.count_services, 0),
    weight: suppliers.reduce((s, x) => s + x.total_weight, 0),
    in_transit_kg: suppliers.reduce((s, x) => s + x.in_transit_kg, 0),
    delivered_kg: suppliers.reduce((s, x) => s + x.delivered_kg, 0),
    by_sku: [],
  };

  // Agrega por SKU global (soma over fornecedores). Ordenado por peso desc.
  // Útil para KPIs "total por produto" (ex: Milho, Feijão, Arroz, etc.)
  const skuTotals = new Map();
  for (const x of suppliers) {
    for (const item of x.by_sku) {
      const cur = skuTotals.get(item.sku) || { sku: item.sku, weight: 0, count: 0 };
      cur.weight += item.weight;
      cur.count  += item.count;
      skuTotals.set(item.sku, cur);
    }
  }
  totals.by_sku = [...skuTotals.values()]
    .map((x) => ({ sku: x.sku, weight: Math.round(x.weight), count: x.count }))
    .sort((a, b) => b.weight - a.weight);

  return { suppliers, totals };
}

/**
 * Filtra um array de rows para devolver só os de um fornecedor específico.
 * Usado pelo drill-down: GET /api/admin/adicional/suppliers/:key
 */
function rowsForSupplier(rows, key, opts = {}) {
  const statusOk = new Set((opts.statuses || ["TRANSITO", "FINALIZADO"]).map((s) => s.toUpperCase()));
  const useAllStatuses = opts.includeAllStatuses === true;
  return (rows || []).filter((r) => {
    if (!useAllStatuses && !statusOk.has(String(r.StatusName || "").toUpperCase())) return false;
    return supplierKey(r) === key;
  });
}

/**
 * Detecta se um SKU/produto é "saco hermético" e deve ser apresentado
 * em UNIDADES em vez de kg (UNOPS pediu vista "Fornecido" assim).
 *
 * Tigger: SKU = SUSSACO, ou nome do produto contém "saco" ou "hermetic".
 */
function isSaco(row) {
  const sku  = String(row.SKU || "").toUpperCase();
  const name = String(row.ProductName || row.Description || "").toLowerCase();
  if (sku === "SUSSACO") return true;
  return name.includes("hermet") || name.includes("saco");
}

// SKU → label canónico. Espelha lib/adicional-entregas.js para evitar
// dependência circular (require lá importa coisas daqui).
const SKU_LABEL = {
  MXIXMILHOKG:     "Milho",
  MXIXFEIJAOKG:    "Feijão",
  MXIXARROZKG:     "Arroz",
  AGRIFEMMA01L:    "Emamectim",
  AGRIFEMMA0125L:  "Emamectim",
  AGRIFEMTINL:     "Emamectim",
  AGRIMIDACLORP1L: "Imidacloprid",
  AGRIMIDACLORIPLT:"Imidacloprid",
  AGRIMHMCPA1L:    "MCPA",
  AGRIMHMCPALT:    "MCPA",
  SEEDARROZM50KG:  "Arroz (saco 50kg)",
  MSEEDFJNHB5KG:   "Feijão (saco 5kg)",
  MSEEDOPVZM523:   "Milho (OPV)",
  MMRMINTER25:     "Stocofer",
  SUSSACO:         "Sacos Hermét.",
};

// Reduz "Milho (OPV)" → "Milho", "Feijão (saco 5kg)" → "Feijão", etc.
// Esta é a chave usada para fazer match com as metas.
function canonicalProductFromSku(sku) {
  const lbl = SKU_LABEL[sku] || sku;
  const m = /^(.*?)\s*\(/.exec(lbl);
  return (m ? m[1] : lbl).trim();
}

/**
 * Variante de aggregateSuppliers para a vista "Fornecido":
 *   - TRANSITO + FINALIZADO numa coluna "fornecido"
 *   - CRIADO numa coluna "pendente" (guia criada mas camião ainda não foi buscar)
 *   - Sacos herméticos apresentados em UNIDADES em vez de kg
 *   - Segmentação por SKU dentro de cada fornecedor (qty por produto)
 *
 * Para cada SKU dentro de cada fornecedor devolve:
 *   forn_weight_kg, forn_volumes, forn_count, pend_weight_kg, pend_volumes,
 *   pend_count, is_saco, display_unit
 * + helpers para o frontend (display_qty_forn, display_qty_pend, pct_recebido)
 */
// SKUs escondidos na vista /admin/fornecido (decisão UNOPS — não relevantes
// para o tracking de meta vs entrega).
const HIDDEN_SKUS_FORNECIDO = new Set([
  "MMRMINTER25", // Stocofer
]);

// Fornecedores escondidos — nomes que representam armazéns intermédios,
// não fornecedores reais. Suppliers com canonical_name a bater estas
// patterns são removidos da lista final em /admin/fornecido.
// Rows não-reassignadas que ficaram pinned a estes nomes são silenciosamente
// excluídas (operação UNOPS aceitou esta limpeza).
const HIDDEN_SUPPLIER_PATTERNS = [
  /^ADICIONAL\b/i,    // ADICIONAL CHIMOIO, ADICIONAL TETE, ADICIONAL BEIRA, etc.
  /^HUB\b/i,          // HUB Xai-Xai e variantes
  /^C5$/i,            // armazém interno
  /^XAI[-\s]?XAI$/i,  // só "XAI-XAI" como nome
];

function isHiddenSupplier(canonicalName) {
  const n = String(canonicalName || "").trim();
  if (!n) return true;
  return HIDDEN_SUPPLIER_PATTERNS.some((p) => p.test(n));
}

async function aggregateFornecido(rows) {
  // Pré-carrega cache de metas (DB) — necessário porque getMetasFor() é sync
  const { primeMetasCache } = require("./supplier-metas");
  await primeMetasCache();
  // Reclassifica suppliers antes de agregar (ver supplier-reassignments.js)
  const { reassignRows } = require("./supplier-reassignments");
  rows = reassignRows(rows);
  // Filtra SKUs que não devem aparecer nesta vista
  rows = rows.filter((r) => !HIDDEN_SKUS_FORNECIDO.has(String(r.SKU || "").toUpperCase()));

  const FORN = new Set(["TRANSITO", "FINALIZADO"]);
  const PEND = new Set(["CRIADO"]);
  const byKey = new Map();
  const nameCount = new Map();

  for (const r of rows || []) {
    const status = String(r.StatusName || "").toUpperCase();
    const isForn = FORN.has(status);
    const isPend = PEND.has(status);
    if (!isForn && !isPend) continue;

    const key = supplierKey(r);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        canonical_name: "",
        aliases: new Set(),
        account_number: String(r.ShipAcountNumber || "").trim() || null,
        count_forn: 0, count_pend: 0,
        forn_kg: 0, forn_qty_un: 0,
        pend_kg: 0, pend_qty_un: 0,
        by_sku: {},
        by_province: {},
        origins: new Set(),
      });
      nameCount.set(key, new Map());
    }
    const x   = byKey.get(key);
    const w   = Number(r.Weight) || 0;
    const v   = Number(r.VolumesQty) || 0;
    const saco = isSaco(r);
    const name = String(r.ShipFromName || "").trim();

    if (name) {
      x.aliases.add(name);
      const nc = nameCount.get(key);
      nc.set(name, (nc.get(name) || 0) + 1);
    }

    if (isForn) {
      x.count_forn++;
      x.forn_kg += w;
      if (saco) x.forn_qty_un += v;
    } else {
      x.count_pend++;
      x.pend_kg += w;
      if (saco) x.pend_qty_un += v;
    }

    const sku = String(r.SKU || "(sem)").trim();
    if (!x.by_sku[sku]) {
      x.by_sku[sku] = {
        is_saco: saco,
        forn_weight_kg: 0, forn_volumes: 0, forn_count: 0,
        pend_weight_kg: 0, pend_volumes: 0, pend_count: 0,
      };
    }
    const skuEntry = x.by_sku[sku];
    skuEntry.is_saco = skuEntry.is_saco || saco;
    if (isForn) {
      skuEntry.forn_weight_kg += w;
      skuEntry.forn_volumes   += v;
      skuEntry.forn_count++;
    } else {
      skuEntry.pend_weight_kg += w;
      skuEntry.pend_volumes   += v;
      skuEntry.pend_count++;
    }

    const prov = String(r.ReceiverAddress || "(sem)").trim();
    if (!x.by_province[prov]) x.by_province[prov] = { weight: 0, count: 0 };
    x.by_province[prov].weight += w;
    x.by_province[prov].count++;

    const origin = String(r.ShipFromAddress || "").trim();
    if (origin) x.origins.add(origin);
  }

  // Constrói qty display canónico baseado em is_saco
  function makeSkuItem(sku, e) {
    const forn_qty = e.is_saco ? e.forn_volumes   : Math.round(e.forn_weight_kg);
    const pend_qty = e.is_saco ? e.pend_volumes   : Math.round(e.pend_weight_kg);
    const total   = forn_qty + pend_qty;
    const pct     = total > 0 ? Math.round((forn_qty / total) * 100) : 0;
    return {
      sku,
      is_saco: e.is_saco,
      display_unit: e.is_saco ? "un" : "kg",
      forn_qty, pend_qty, total_qty: total,
      forn_count: e.forn_count,
      pend_count: e.pend_count,
      pct_recebido: pct,
      // Raw kg/un caso o frontend queira
      forn_weight_kg: Math.round(e.forn_weight_kg),
      pend_weight_kg: Math.round(e.pend_weight_kg),
      forn_volumes:   e.forn_volumes,
      pend_volumes:   e.pend_volumes,
    };
  }

  // Carrega metas (fornecedor → produto → qty meta)
  const { getMetasFor } = require("./supplier-metas");

  const suppliers = [];
  for (const [key, x] of byKey) {
    const nc = nameCount.get(key);
    let canonical = "", maxCount = -1;
    for (const [name, count] of nc) if (count > maxCount) { maxCount = count; canonical = name; }
    x.canonical_name = canonical || (x.account_number ? `Account ${x.account_number}` : "(sem nome)");
    x.aliases = [...x.aliases].sort();
    x.origins = [...x.origins].sort();
    x.forn_kg     = Math.round(x.forn_kg);
    x.pend_kg     = Math.round(x.pend_kg);
    x.count_services = x.count_forn + x.count_pend;

    x.by_sku = Object.entries(x.by_sku)
      .map(([sku, v]) => makeSkuItem(sku, v))
      .sort((a, b) => b.total_qty - a.total_qty);
    x.by_province = Object.entries(x.by_province)
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([province, v]) => ({ province, weight: Math.round(v.weight), count: v.count }));

    // Rollup por produto canónico (Milho/Feijão/Arroz/...) — necessário
    // para comparar contra as metas, que são por produto, não por SKU.
    const productMap = new Map();
    for (const s of x.by_sku) {
      const p = canonicalProductFromSku(s.sku);
      if (!productMap.has(p)) productMap.set(p, {
        product: p, is_saco: s.is_saco,
        forn_weight_kg: 0, forn_volumes: 0, forn_count: 0,
        pend_criado_kg: 0, pend_criado_volumes: 0, pend_criado_count: 0,
        skus: [],
      });
      const pe = productMap.get(p);
      pe.is_saco = pe.is_saco || s.is_saco;
      pe.forn_weight_kg     += s.forn_weight_kg;
      pe.forn_volumes       += s.forn_volumes;
      pe.forn_count         += s.forn_count;
      pe.pend_criado_kg     += s.pend_weight_kg;
      pe.pend_criado_volumes+= s.pend_volumes;
      pe.pend_criado_count  += s.pend_count;
      pe.skus.push(s.sku);
    }

    // Anexa meta + cálculo de pendente (meta − fornecido)
    // Para fornecedores com metas em UNIDADES (sacos), mantemos tracking
    // separado para que o pct funcione correctamente.
    const metaInfo = getMetasFor(x.canonical_name);
    x.meta_match_key = metaInfo ? metaInfo.matched_key : null;
    const metas = metaInfo ? metaInfo.metas : {};
    const products = [];
    let meta_total_kg = 0, forn_total_for_meta_kg = 0;
    let meta_total_un = 0, forn_total_for_meta_un = 0;
    let has_meta_products = 0;
    const seenProducts = new Set();
    for (const [p, meta] of Object.entries(metas)) {
      const pe = productMap.get(p);
      const forn_kg = pe ? pe.forn_weight_kg : 0;
      const forn_un = pe ? pe.forn_volumes  : 0;
      // Detecta saco pela canonical name (Sacos Hermét.) — mesmo que o
      // fornecedor ainda não tenha entregado nada (productMap vazio).
      const is_saco = pe ? pe.is_saco : /sacos?\s*hermet|hermét/i.test(p);
      const display_unit = is_saco ? "un" : "kg";
      const forn_qty = is_saco ? forn_un : Math.round(forn_kg);
      const meta_qty = meta == null ? null : Number(meta);
      const meta_pendente = meta_qty == null ? null : Math.max(0, meta_qty - forn_qty);
      const meta_pct      = meta_qty == null || meta_qty === 0
        ? null
        : Math.min(999, Math.round((forn_qty / meta_qty) * 100));
      products.push({
        product: p,
        is_saco, display_unit,
        skus: pe ? pe.skus : [],
        forn_qty,
        forn_count: pe ? pe.forn_count : 0,
        criado_qty:  pe ? (is_saco ? pe.pend_criado_volumes : Math.round(pe.pend_criado_kg)) : 0,
        criado_count: pe ? pe.pend_criado_count : 0,
        meta_qty,                // null se meta indefinida
        meta_pendente,           // null se sem meta, ou max(0, meta − forn) em kg/un
        meta_pct,                // null se sem meta, ou 0..100+ se com meta
        has_meta: meta_qty != null,
      });
      seenProducts.add(p);
      if (meta_qty != null) {
        if (is_saco) {
          meta_total_un += meta_qty;
          forn_total_for_meta_un += forn_qty;
        } else {
          meta_total_kg += meta_qty;
          forn_total_for_meta_kg += forn_qty;
        }
        has_meta_products++;
      }
    }
    // Adiciona produtos que o fornecedor entregou mas NÃO tinham meta
    for (const [p, pe] of productMap) {
      if (seenProducts.has(p)) continue;
      const display_unit = pe.is_saco ? "un" : "kg";
      const forn_qty = pe.is_saco ? pe.forn_volumes : Math.round(pe.forn_weight_kg);
      products.push({
        product: p,
        is_saco: pe.is_saco, display_unit,
        skus: pe.skus,
        forn_qty,
        forn_count: pe.forn_count,
        criado_qty: pe.is_saco ? pe.pend_criado_volumes : Math.round(pe.pend_criado_kg),
        criado_count: pe.pend_criado_count,
        meta_qty: null,
        meta_pendente: null,
        meta_pct: null,
        has_meta: false,
      });
    }
    // Ordena: produtos com meta primeiro, depois por meta desc, depois por forn desc
    products.sort((a, b) => {
      if (a.has_meta !== b.has_meta) return a.has_meta ? -1 : 1;
      if (a.meta_qty !== b.meta_qty) return (b.meta_qty || 0) - (a.meta_qty || 0);
      return b.forn_qty - a.forn_qty;
    });
    x.by_product = products;
    x.meta_total_kg = meta_total_kg;
    x.meta_total_un = meta_total_un;
    x.meta_pendente_total_kg = Math.max(0, meta_total_kg - forn_total_for_meta_kg);
    x.meta_pendente_total_un = Math.max(0, meta_total_un - forn_total_for_meta_un);
    // Pct global do supplier: prefere kg quando há kg meta, senão usa un.
    // Para suppliers só de sacos (ex: MH-Tenders), pct vem dos un.
    if (meta_total_kg > 0) {
      x.meta_pct = Math.min(999, Math.round((forn_total_for_meta_kg / meta_total_kg) * 100));
    } else if (meta_total_un > 0) {
      x.meta_pct = Math.min(999, Math.round((forn_total_for_meta_un / meta_total_un) * 100));
    } else {
      x.meta_pct = null;
    }
    x.has_meta = has_meta_products > 0;

    suppliers.push(x);
  }
  // Merge suppliers que partilhem o mesmo meta_match_key — caso comum em que
  // o mesmo fornecedor aparece com 2 entradas (uma com acct, outra sem) e
  // pertence à mesma meta. Sem merge, a meta apareceria 2× nos totais.
  const mergedByMetaKey = new Map();
  const finalSuppliers = [];
  for (const x of suppliers) {
    if (!x.meta_match_key) { finalSuppliers.push(x); continue; }
    if (!mergedByMetaKey.has(x.meta_match_key)) {
      mergedByMetaKey.set(x.meta_match_key, x);
      finalSuppliers.push(x);
      continue;
    }
    // Há já um entry com esta meta_key — junta-os
    const dst = mergedByMetaKey.get(x.meta_match_key);
    dst.count_forn   += x.count_forn;
    dst.count_pend   += x.count_pend;
    dst.count_services = dst.count_forn + dst.count_pend;
    dst.forn_kg      += x.forn_kg;
    dst.pend_kg      += x.pend_kg;
    dst.forn_qty_un  += x.forn_qty_un;
    dst.pend_qty_un  += x.pend_qty_un;
    dst.aliases = [...new Set([...dst.aliases, ...x.aliases])].sort();
    dst.origins = [...new Set([...dst.origins, ...x.origins])].sort();
    // Funde by_product: para cada produto na entrada nova, soma ao destino
    const dstByProduct = new Map(dst.by_product.map((p) => [p.product, p]));
    for (const p of x.by_product) {
      if (!dstByProduct.has(p.product)) {
        dst.by_product.push(p);
        dstByProduct.set(p.product, p);
        continue;
      }
      const tp = dstByProduct.get(p.product);
      tp.forn_qty     += p.forn_qty;
      tp.forn_count   += p.forn_count;
      tp.criado_qty   += p.criado_qty;
      tp.criado_count += p.criado_count;
      tp.is_saco      = tp.is_saco || p.is_saco;
      tp.skus         = [...new Set([...tp.skus, ...p.skus])];
      // Recalcula meta_pendente e pct (meta_qty é igual nos dois — vem da mesma key)
      if (tp.meta_qty != null) {
        tp.meta_pendente = Math.max(0, tp.meta_qty - tp.forn_qty);
        tp.meta_pct      = tp.meta_qty > 0
          ? Math.min(999, Math.round((tp.forn_qty / tp.meta_qty) * 100)) : null;
      }
    }
    // Re-ordena by_product
    dst.by_product.sort((a, b) => {
      if (a.has_meta !== b.has_meta) return a.has_meta ? -1 : 1;
      if (a.meta_qty !== b.meta_qty) return (b.meta_qty || 0) - (a.meta_qty || 0);
      return b.forn_qty - a.forn_qty;
    });
    // Recalcula totals do dst (meta_total_kg/un ficam inalteradas)
    let fornForMetaKg = 0, fornForMetaUn = 0;
    for (const p of dst.by_product) {
      if (!p.has_meta) continue;
      if (p.is_saco) fornForMetaUn += p.forn_qty;
      else            fornForMetaKg += p.forn_qty;
    }
    dst.meta_pendente_total_kg = Math.max(0, dst.meta_total_kg - fornForMetaKg);
    dst.meta_pendente_total_un = Math.max(0, (dst.meta_total_un || 0) - fornForMetaUn);
    if (dst.meta_total_kg > 0) {
      dst.meta_pct = Math.min(999, Math.round((fornForMetaKg / dst.meta_total_kg) * 100));
    } else if ((dst.meta_total_un || 0) > 0) {
      dst.meta_pct = Math.min(999, Math.round((fornForMetaUn / dst.meta_total_un) * 100));
    } else dst.meta_pct = null;
  }
  // Substitui suppliers pela lista pós-merge
  suppliers.length = 0;
  suppliers.push(...finalSuppliers);

  // Ghost suppliers — entries em METAS sem qualquer match na API. Mostram
  // a meta + 0% recebido. Importante para acompanhar fornecedores que ainda
  // não começaram a entregar (ex: ETG, Wanbao, Global Agril).
  const { METAS } = require("./supplier-metas");
  const matchedKeys = new Set(suppliers.filter((s) => s.meta_match_key).map((s) => s.meta_match_key));
  for (const [metaKey, productsMeta] of Object.entries(METAS)) {
    if (matchedKeys.has(metaKey)) continue;
    // Verifica se tem pelo menos 1 meta válida (não-null)
    const validMetas = Object.entries(productsMeta).filter(([_, v]) => v != null && v > 0);
    if (!validMetas.length) continue;
    let meta_total_kg = 0, meta_total_un = 0;
    const by_product = validMetas.map(([prod, meta]) => {
      const is_saco = /sacos?\s*hermet|hermét/i.test(prod);
      const meta_qty = Number(meta);
      if (is_saco) meta_total_un += meta_qty;
      else         meta_total_kg += meta_qty;
      return {
        product: prod,
        is_saco, display_unit: is_saco ? "un" : "kg",
        skus: [],
        forn_qty: 0, forn_count: 0,
        criado_qty: 0, criado_count: 0,
        meta_qty,
        meta_pendente: meta_qty,
        meta_pct: 0,
        has_meta: true,
      };
    });
    const pct = meta_total_kg > 0 || meta_total_un > 0 ? 0 : null;
    suppliers.push({
      key: "ghost:" + metaKey,
      canonical_name: metaKey,
      aliases: [],
      account_number: null,
      count_forn: 0, count_pend: 0, count_services: 0,
      forn_kg: 0, forn_qty_un: 0,
      pend_kg: 0, pend_qty_un: 0,
      by_sku: [],
      by_product,
      by_province: [],
      origins: [],
      meta_match_key: metaKey,
      has_meta: true,
      meta_total_kg, meta_total_un,
      meta_pendente_total_kg: meta_total_kg,
      meta_pendente_total_un: meta_total_un,
      meta_pct: pct,
      is_ghost: true,  // marca para a UI distinguir
    });
  }

  // Ajustes manuais (movem qty específica entre fornecedores) — aplicados
  // ANTES dos totals globais e do sort, para que reflictam no by_product
  // global e na ordem por meta_kg.
  try {
    const { applyAdjustments } = require("./supplier-adjustments");
    applyAdjustments(suppliers);
  } catch (e) {
    // Não bloqueia se o módulo falhar — só regista
    console.warn("[fornecido] applyAdjustments falhou:", e.message);
  }

  // Remove armazéns intermédios da lista (não são fornecedores reais).
  // Rows não-reassignadas que ficaram pinned a estes nomes são excluídas.
  const filteredSuppliers = suppliers.filter((s) => !isHiddenSupplier(s.canonical_name));
  suppliers.length = 0;
  suppliers.push(...filteredSuppliers);

  // Ordena: SEMENTES primeiro (Milho/Feijão/Arroz), depois OUTROS (químicos,
  // sacos). Dentro de cada categoria: ghost (sem entregas) ao fim, e os
  // restantes por % ascendente (mais atrasados em primeiro lugar).
  const isSementesSupplier = (s) => {
    if (!s.by_product || !s.by_product.length) return false;
    return s.by_product.some((p) => p.has_meta && /^(Milho|Feij[aã]o|Arroz)/i.test(p.product));
  };
  for (const s of suppliers) s._is_sementes = isSementesSupplier(s);
  suppliers.sort((a, b) => {
    // 1. com meta vs sem meta
    if (a.has_meta !== b.has_meta) return a.has_meta ? -1 : 1;
    if (!a.has_meta) return b.forn_kg - a.forn_kg;
    // 2. sementes antes de outros
    if (a._is_sementes !== b._is_sementes) return a._is_sementes ? -1 : 1;
    // 3. ghost ao fim (já tem 0%)
    if (a.is_ghost !== b.is_ghost) return a.is_ghost ? 1 : -1;
    // 4. por % ascendente (mais atrasados primeiro). null/sem pct ao fim.
    const aPct = a.meta_pct == null ? 999 : a.meta_pct;
    const bPct = b.meta_pct == null ? 999 : b.meta_pct;
    return aPct - bPct;
  });

  // Agregados globais por PRODUTO canónico (somando todos os fornecedores).
  // Cada produto tem agora uma lista `suppliers` com nome/qty/% — usado pelo
  // frontend para mostrar quem ainda tem pendente.
  const prodTotals = new Map();
  for (const x of suppliers) {
    for (const p of x.by_product) {
      if (!prodTotals.has(p.product)) prodTotals.set(p.product, {
        product: p.product, is_saco: p.is_saco, display_unit: p.display_unit,
        forn_qty: 0, criado_qty: 0, meta_qty: 0, meta_pendente: 0,
        has_meta_any: false,
        suppliers: [],
      });
      const cur = prodTotals.get(p.product);
      cur.is_saco = cur.is_saco || p.is_saco;
      cur.forn_qty   += p.forn_qty;
      cur.criado_qty += p.criado_qty;
      if (p.meta_qty != null) {
        cur.meta_qty      += p.meta_qty;
        cur.meta_pendente += (p.meta_pendente || 0);
        cur.has_meta_any   = true;
      }
      // Detalhe por fornecedor — só guarda quem realmente tem este produto
      // (com meta OU com forn > 0; ignora linhas sem dados úteis).
      if (p.has_meta || p.forn_qty > 0) {
        cur.suppliers.push({
          name: x.canonical_name,
          meta_match_key: x.meta_match_key,
          is_ghost: !!x.is_ghost,
          has_meta: p.has_meta,
          forn_qty: p.forn_qty,
          meta_qty: p.meta_qty,
          meta_pendente: p.meta_pendente,
          meta_pct: p.meta_pct,
          display_unit: p.display_unit,
        });
      }
    }
  }
  const by_product = [...prodTotals.values()].map((x) => {
    // Ordena fornecedores: com pendente primeiro (asc % — mais atrasados),
    // depois os já completos (acima de 100%).
    x.suppliers.sort((a, b) => {
      const aPct = a.meta_pct == null ? 999 : a.meta_pct;
      const bPct = b.meta_pct == null ? 999 : b.meta_pct;
      return aPct - bPct;
    });
    return {
      ...x,
      meta_pct: x.has_meta_any && x.meta_qty > 0
        ? Math.min(999, Math.round((x.forn_qty / x.meta_qty) * 100))
        : null,
    };
  }).sort((a, b) => (b.meta_qty || b.forn_qty) - (a.meta_qty || a.forn_qty));

  const totals = {
    suppliers: suppliers.length,
    services_forn: suppliers.reduce((s, x) => s + x.count_forn, 0),
    services_pend: suppliers.reduce((s, x) => s + x.count_pend, 0),
    forn_kg:     suppliers.reduce((s, x) => s + x.forn_kg,     0),
    forn_qty_un: suppliers.reduce((s, x) => s + x.forn_qty_un, 0),
    criado_kg:   suppliers.reduce((s, x) => s + x.pend_kg,     0),  // CRIADO bruto (info)
    criado_qty_un: suppliers.reduce((s, x) => s + x.pend_qty_un, 0),
    // Metas — kg para granéis, un para sacos (separadas)
    meta_total_kg:      suppliers.reduce((s, x) => s + (x.meta_total_kg || 0), 0),
    meta_pendente_kg:   suppliers.reduce((s, x) => s + (x.meta_pendente_total_kg || 0), 0),
    meta_total_un:      suppliers.reduce((s, x) => s + (x.meta_total_un || 0), 0),
    meta_pendente_un:   suppliers.reduce((s, x) => s + (x.meta_pendente_total_un || 0), 0),
    meta_pct_global:    null,
    meta_pct_sacos:     null,
    by_product,
  };
  if (totals.meta_total_kg > 0) {
    const fornForMeta = totals.meta_total_kg - totals.meta_pendente_kg;
    totals.meta_pct_global = Math.min(999, Math.round((fornForMeta / totals.meta_total_kg) * 100));
  }
  if (totals.meta_total_un > 0) {
    const fornForMetaUn = totals.meta_total_un - totals.meta_pendente_un;
    totals.meta_pct_sacos = Math.min(999, Math.round((fornForMetaUn / totals.meta_total_un) * 100));
  }
  return { suppliers, totals };
}

module.exports = { aggregateSuppliers, aggregateFornecido, rowsForSupplier, supplierKey, normName, isSaco };
