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
  };

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

module.exports = { aggregateSuppliers, rowsForSupplier, supplierKey, normName };
