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
function aggregateFornecido(rows) {
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
    x.total_kg       = x.forn_kg + x.pend_kg;
    x.pct_recebido   = x.total_kg > 0 ? Math.round((x.forn_kg / x.total_kg) * 100) : 0;
    x.by_sku = Object.entries(x.by_sku)
      .map(([sku, v]) => makeSkuItem(sku, v))
      .sort((a, b) => b.total_qty - a.total_qty);
    x.by_province = Object.entries(x.by_province)
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([province, v]) => ({ province, weight: Math.round(v.weight), count: v.count }));
    suppliers.push(x);
  }
  // Ordena por total (forn + pend) — mostra os fornecedores mais relevantes primeiro
  suppliers.sort((a, b) => b.total_kg - a.total_kg);

  // Agregados globais por SKU (somando todos os fornecedores)
  const skuTotals = new Map();
  for (const x of suppliers) {
    for (const s of x.by_sku) {
      const cur = skuTotals.get(s.sku) || {
        sku: s.sku, is_saco: s.is_saco,
        forn_weight_kg: 0, forn_volumes: 0, forn_count: 0,
        pend_weight_kg: 0, pend_volumes: 0, pend_count: 0,
      };
      cur.forn_weight_kg += s.forn_weight_kg;
      cur.forn_volumes   += s.forn_volumes;
      cur.forn_count     += s.forn_count;
      cur.pend_weight_kg += s.pend_weight_kg;
      cur.pend_volumes   += s.pend_volumes;
      cur.pend_count     += s.pend_count;
      skuTotals.set(s.sku, cur);
    }
  }
  const by_sku = [...skuTotals.values()]
    .map((x) => makeSkuItem(x.sku, x))
    .sort((a, b) => b.total_qty - a.total_qty);

  const totals = {
    suppliers: suppliers.length,
    services_forn: suppliers.reduce((s, x) => s + x.count_forn, 0),
    services_pend: suppliers.reduce((s, x) => s + x.count_pend, 0),
    forn_kg:     suppliers.reduce((s, x) => s + x.forn_kg,     0),
    forn_qty_un: suppliers.reduce((s, x) => s + x.forn_qty_un, 0),
    pend_kg:     suppliers.reduce((s, x) => s + x.pend_kg,     0),
    pend_qty_un: suppliers.reduce((s, x) => s + x.pend_qty_un, 0),
    by_sku,
  };
  return { suppliers, totals };
}

module.exports = { aggregateSuppliers, aggregateFornecido, rowsForSupplier, supplierKey, normName, isSaco };
