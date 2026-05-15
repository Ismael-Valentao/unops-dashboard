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
 *   - Junta TRANSITO + FINALIZADO num único bucket "Fornecido" (sem segmentação)
 *   - Sacos herméticos apresentados em UNIDADES (Volumes) em vez de kg
 *   - Mantém by_sku detalhado com {sku, qty, unit} adaptado por SKU
 *   - count_services, by_province, account/aliases iguais à fornecida normal
 */
function aggregateFornecido(rows) {
  const RELEVANT = new Set(["TRANSITO", "FINALIZADO"]);
  const byKey = new Map();
  const nameCount = new Map();

  for (const r of rows || []) {
    const status = String(r.StatusName || "").toUpperCase();
    if (!RELEVANT.has(status)) continue;

    const key = supplierKey(r);
    if (!byKey.has(key)) {
      byKey.set(key, {
        key,
        canonical_name: "",
        aliases: new Set(),
        account_number: String(r.ShipAcountNumber || "").trim() || null,
        count_services: 0,
        fornecido_kg:      0,   // soma kg de todos os produtos (incluindo Weight de SACOs)
        fornecido_qty_un:  0,   // soma unidades só de SACOs
        fornecido_qty_kg:  0,   // soma kg de produtos NÃO-saco
        by_sku: {},             // SKU → {weight_kg, volumes, count, is_saco}
        by_province: {},
        origins: new Set(),
        first_seen: null,
        last_seen: null,
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

    x.count_services++;
    x.fornecido_kg += w;
    if (saco) x.fornecido_qty_un += v;
    else      x.fornecido_qty_kg += w;

    const sku = String(r.SKU || "(sem)").trim();
    if (!x.by_sku[sku]) x.by_sku[sku] = { weight_kg: 0, volumes: 0, count: 0, is_saco: saco };
    x.by_sku[sku].weight_kg += w;
    x.by_sku[sku].volumes   += v;
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

  const suppliers = [];
  for (const [key, x] of byKey) {
    const nc = nameCount.get(key);
    let canonical = "", maxCount = -1;
    for (const [name, count] of nc) if (count > maxCount) { maxCount = count; canonical = name; }
    x.canonical_name = canonical || (x.account_number ? `Account ${x.account_number}` : "(sem nome)");
    x.aliases = [...x.aliases].sort();
    x.origins = [...x.origins].sort();
    x.fornecido_kg     = Math.round(x.fornecido_kg);
    x.fornecido_qty_kg = Math.round(x.fornecido_qty_kg);
    x.fornecido_qty_un = Math.round(x.fornecido_qty_un);
    x.by_sku = Object.entries(x.by_sku)
      .sort((a, b) => (b[1].is_saco ? b[1].volumes : b[1].weight_kg) -
                      (a[1].is_saco ? a[1].volumes : a[1].weight_kg))
      .map(([sku, v]) => ({
        sku,
        is_saco: v.is_saco,
        weight_kg: Math.round(v.weight_kg),
        volumes:   v.volumes,
        count:     v.count,
        // Display canónico para o frontend
        display_qty:  v.is_saco ? v.volumes : Math.round(v.weight_kg),
        display_unit: v.is_saco ? "un" : "kg",
      }));
    x.by_province = Object.entries(x.by_province)
      .sort((a, b) => b[1].weight - a[1].weight)
      .map(([province, v]) => ({ province, weight: Math.round(v.weight), count: v.count }));
    suppliers.push(x);
  }
  // Ordena por fornecido_kg (proxy bom para "volume total" mesmo com sacos)
  suppliers.sort((a, b) => b.fornecido_kg - a.fornecido_kg);

  // Agregados globais por SKU
  const skuTotals = new Map();
  for (const x of suppliers) {
    for (const s of x.by_sku) {
      const cur = skuTotals.get(s.sku) || { sku: s.sku, is_saco: s.is_saco, weight_kg: 0, volumes: 0, count: 0 };
      cur.weight_kg += s.weight_kg;
      cur.volumes   += s.volumes;
      cur.count     += s.count;
      skuTotals.set(s.sku, cur);
    }
  }
  const by_sku = [...skuTotals.values()]
    .map((x) => ({
      ...x,
      display_qty:  x.is_saco ? x.volumes : x.weight_kg,
      display_unit: x.is_saco ? "un" : "kg",
    }))
    .sort((a, b) => (b.is_saco ? b.volumes : b.weight_kg) -
                    (a.is_saco ? a.volumes : a.weight_kg));

  const totals = {
    suppliers: suppliers.length,
    services:  suppliers.reduce((s, x) => s + x.count_services, 0),
    fornecido_kg:     suppliers.reduce((s, x) => s + x.fornecido_kg,     0),
    fornecido_qty_kg: suppliers.reduce((s, x) => s + x.fornecido_qty_kg, 0),
    fornecido_qty_un: suppliers.reduce((s, x) => s + x.fornecido_qty_un, 0),
    by_sku,
  };
  return { suppliers, totals };
}

module.exports = { aggregateSuppliers, aggregateFornecido, rowsForSupplier, supplierKey, normName, isSaco };
