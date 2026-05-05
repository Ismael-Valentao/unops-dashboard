/**
 * AQI Dashboard – Planning Data Module
 * Loads planning Excel and provides aggregated data for Planned vs Delivered analysis.
 */
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

const PLANNING_FILE = path.join(__dirname, "data", "Planeamento_wilson_.xlsx");

// Product name mapping: Planning → Delivery (Google Sheets)
const PRODUCT_MAP = {
  "Milho":            "Maize Seeds (kg)",
  "Feijão":           "Bean Seeds (kg)",
  "Arroz":            "Rice Seeds (kg)",
  "Emamectin":        "Emamectin",
  "Imadocloprid":     "Imidacloprid",
  "MCPA":             "MCPA",
  "Sacos Hermeticos": "Hermetic bags (un)",
};

// Saco (hermetic bag) weight — each unit weighs 0.145 kg.
// Planning stores count (Peso do Volume Kg = nº unidades); we multiply to get real kg.
const SACO_KG_PER_UNIT = 0.145;
function isSacoProduct(name) {
  const l = String(name || "").toLowerCase();
  return l.includes("saco") || l.includes("hermetic");
}

// Seed segment — used to compute the seed-only execution rate independently
// of any product filter the user might apply.
const SEED_PRODUCTS = new Set(["Milho", "Feijão", "Arroz"]);
function isSeedProduct(planName) {
  return SEED_PRODUCTS.has((planName || "").trim());
}

// Reverse map for delivery → planning lookup
const PRODUCT_MAP_REV = {};
for (const [k, v] of Object.entries(PRODUCT_MAP)) {
  PRODUCT_MAP_REV[v.toLowerCase()] = k;
}

// District name normalization (uppercase variants)
// Canonical district names — must match the normalization done on delivery rows
// in app.js (see DISTRICT_ALIASES there). Any new alias should be added in BOTH places.
const DISTRICT_ALIASES = {
  "chongoene": "Chonguene",
  "manhica": "Manhiça",
  "magude": "Magude",
  "moamba": "Moamba",
  "marracuene": "Marracuene",
  "matola": "Matola",
  "boane": "Boane",
  "namaacha": "Namaacha",
  "matutuine": "Matutuíne",
  "matutuíne": "Matutuíne",
  "chokwe": "Chókwè",
  "chókwè": "Chókwè",
  "xai-xai": "Xai-Xai",
  "xai xai": "Xai-Xai",
  "chigubo": "Chigubo",
};
function normalizeDistrict(d) {
  if (!d) return "";
  const s = String(d).trim();
  if (!s) return "";
  const key = s.toLowerCase();
  if (DISTRICT_ALIASES[key]) return DISTRICT_ALIASES[key];
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

let planningData = null;

function load() {
  if (!fs.existsSync(PLANNING_FILE)) {
    console.warn("[PLANNING] File not found:", PLANNING_FILE);
    planningData = { rows: [], byDistrict: {}, byProduct: {}, byDistrictProduct: {}, byProvince: {} };
    return;
  }

  const wb = XLSX.readFile(PLANNING_FILE);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws);

  const rows = raw.map((r) => {
    const plan = (r["Referencia"] || "").trim();
    const stored = Number(r["Peso do Volume Kg"]) || 0;
    // Sacos: stored value is count → convert to kg
    const weight_kg = isSacoProduct(plan) ? stored * SACO_KG_PER_UNIT : stored;
    return {
      product_plan:  plan,
      product_delivery: PRODUCT_MAP[plan] || plan,
      province:      (r["Morada Destino (Provincia)"] || "").trim(),
      district:      normalizeDistrict(r["Distrito"]),
      district_raw:  (r["Distrito"] || "").trim(),
      beneficiary:   (r["Nome Destino "] || r["Nome Destino"] || "").trim(),
      volumes:       Number(r["Nº Volume novo"]) || 0,
      weight_kg,
      weight_units:  isSacoProduct(plan) ? stored : null,
      posto:         (r["Posto Administrativo"] || "").trim(),
    };
  }).filter((r) => r.weight_kg > 0);

  // Aggregations
  const byDistrict = {};
  const byProduct = {};
  const byDistrictProduct = {};
  const byProvince = {};

  rows.forEach((r) => {
    const dk = r.district || r.district_raw;
    const pk = r.product_plan;
    const prvk = r.province;
    const dpk = `${dk}|||${pk}`;

    if (!byDistrict[dk]) byDistrict[dk] = { district: dk, province: r.province, planned_kg: 0, planned_vols: 0 };
    byDistrict[dk].planned_kg += r.weight_kg;
    byDistrict[dk].planned_vols += r.volumes;

    if (!byProduct[pk]) byProduct[pk] = { product_plan: pk, product_delivery: r.product_delivery, planned_kg: 0, planned_vols: 0 };
    byProduct[pk].planned_kg += r.weight_kg;
    byProduct[pk].planned_vols += r.volumes;

    if (!byDistrictProduct[dpk]) byDistrictProduct[dpk] = { district: dk, province: r.province, product_plan: pk, product_delivery: r.product_delivery, planned_kg: 0, planned_vols: 0 };
    byDistrictProduct[dpk].planned_kg += r.weight_kg;
    byDistrictProduct[dpk].planned_vols += r.volumes;

    if (!byProvince[prvk]) byProvince[prvk] = { province: prvk, planned_kg: 0, planned_vols: 0 };
    byProvince[prvk].planned_kg += r.weight_kg;
    byProvince[prvk].planned_vols += r.volumes;
  });

  planningData = {
    rows,
    byDistrict:        Object.values(byDistrict),
    byProduct:         Object.values(byProduct),
    byDistrictProduct: Object.values(byDistrictProduct),
    byProvince:        Object.values(byProvince),
    totalPlannedKg:    rows.reduce((s, r) => s + r.weight_kg, 0),
    totalPlannedVols:  rows.reduce((s, r) => s + r.volumes, 0),
    productMap:        PRODUCT_MAP,
  };

  console.log(`[PLANNING] Loaded ${rows.length} rows, ${Object.keys(byDistrict).length} districts, ${Object.keys(byProduct).length} products`);
}

function getData() {
  return planningData;
}

// Match delivery product name to planning product name
function matchProduct(deliveryProductName) {
  if (!deliveryProductName) return null;
  const lower = deliveryProductName.toLowerCase();
  // Direct reverse map
  if (PRODUCT_MAP_REV[lower]) return PRODUCT_MAP_REV[lower];
  // Fuzzy: check if delivery name contains a planning keyword
  for (const [planName, delName] of Object.entries(PRODUCT_MAP)) {
    if (lower.includes(delName.toLowerCase()) || lower.includes(planName.toLowerCase())) {
      return planName;
    }
  }
  // Try partial match on key words
  if (lower.includes("maize") || lower.includes("milho")) return "Milho";
  if (lower.includes("bean") || lower.includes("feij")) return "Feijão";
  if (lower.includes("rice") || lower.includes("arroz")) return "Arroz";
  if (lower.includes("emamectin")) return "Emamectin";
  if (lower.includes("imid") || lower.includes("imad")) return "Imadocloprid";
  if (lower.includes("mcpa")) return "MCPA";
  if (lower.includes("saco") || lower.includes("hermetic")) return "Sacos Hermeticos";
  return null;
}

// Build the full Planned vs Delivered comparison
function buildComparison(deliveryRows, filters) {
  if (!planningData) return null;
  const { province, district, product, seedsOnly } = filters || {};

  // Match delivery product name to planning product
  let planProductFilter = null;
  if (product) {
    planProductFilter = matchProduct(product) || product;
  }

  // Filter planning data if needed
  let planByDistrict = planningData.byDistrict;
  let planByProduct = planningData.byProduct;
  let planByDistrictProduct = planningData.byDistrictProduct;
  let totalPlannedKg = planningData.totalPlannedKg;

  if (province || district || planProductFilter || seedsOnly) {
    // Re-aggregate from raw rows with filters
    const filtered = planningData.rows.filter((r) => {
      if (province && r.province !== province) return false;
      if (district && normalizeDistrict(r.district_raw) !== district && r.district !== district) return false;
      if (planProductFilter && r.product_plan !== planProductFilter) return false;
      if (seedsOnly && !isSeedProduct(r.product_plan)) return false;
      return true;
    });
    const byD = {}, byP = {}, byDP = {};
    filtered.forEach((r) => {
      const dk = r.district || r.district_raw;
      const pk = r.product_plan;
      const dpk = `${dk}|||${pk}`;
      if (!byD[dk]) byD[dk] = { district: dk, province: r.province, planned_kg: 0 };
      byD[dk].planned_kg += r.weight_kg;
      if (!byP[pk]) byP[pk] = { product_plan: pk, product_delivery: r.product_delivery, planned_kg: 0 };
      byP[pk].planned_kg += r.weight_kg;
      if (!byDP[dpk]) byDP[dpk] = { district: dk, province: r.province, product_plan: pk, product_delivery: r.product_delivery, planned_kg: 0 };
      byDP[dpk].planned_kg += r.weight_kg;
    });
    planByDistrict = Object.values(byD);
    planByProduct = Object.values(byP);
    planByDistrictProduct = Object.values(byDP);
    totalPlannedKg = filtered.reduce((s, r) => s + r.weight_kg, 0);
  }

  // Aggregate delivery data by district
  const delByDistrict = {};
  const delByProduct = {};
  const delByDistrictProduct = {};

  deliveryRows.forEach((r) => {
    const dk = normalizeDistrict(r.district);
    const planProduct = matchProduct(r.product);
    const pk = planProduct || r.product;
    const dpk = `${dk}|||${pk}`;
    const qty = Number(r.delivered_qty) || 0;
    const vols = Number(r.packages) || 0;

    if (!delByDistrict[dk]) delByDistrict[dk] = { delivered_kg: 0, delivered_vols: 0 };
    delByDistrict[dk].delivered_kg += qty;
    delByDistrict[dk].delivered_vols += vols;

    if (!delByProduct[pk]) delByProduct[pk] = { delivered_kg: 0, delivered_vols: 0 };
    delByProduct[pk].delivered_kg += qty;
    delByProduct[pk].delivered_vols += vols;

    if (!delByDistrictProduct[dpk]) delByDistrictProduct[dpk] = { delivered_kg: 0, delivered_vols: 0 };
    delByDistrictProduct[dpk].delivered_kg += qty;
    delByDistrictProduct[dpk].delivered_vols += vols;
  });

  function getStatus(planned, delivered) {
    if (planned <= 0) return "N/A";
    // Completo only when fully delivered (with tiny float tolerance)
    if (delivered >= planned - 0.001) return "Completo";
    if (delivered > 0) return "Em progresso";
    return "Sem entregas";
  }

  function pct(delivered, planned) {
    return planned > 0 ? +((delivered / planned) * 100).toFixed(1) : 0;
  }

  // By district
  const byDistrict = planByDistrict.map((p) => {
    const d = delByDistrict[p.district] || { delivered_kg: 0, delivered_vols: 0 };
    return {
      district: p.district, province: p.province,
      planned_kg: p.planned_kg, delivered_kg: d.delivered_kg,
      diff: +(d.delivered_kg - p.planned_kg).toFixed(1),
      pct: pct(d.delivered_kg, p.planned_kg),
      status: getStatus(p.planned_kg, d.delivered_kg),
    };
  }).sort((a, b) => b.planned_kg - a.planned_kg);

  // By product
  const byProduct = planByProduct.map((p) => {
    const d = delByProduct[p.product_plan] || { delivered_kg: 0, delivered_vols: 0 };
    return {
      product: p.product_plan, product_delivery: p.product_delivery,
      planned_kg: p.planned_kg, delivered_kg: d.delivered_kg,
      diff: +(d.delivered_kg - p.planned_kg).toFixed(1),
      pct: pct(d.delivered_kg, p.planned_kg),
      status: getStatus(p.planned_kg, d.delivered_kg),
    };
  }).sort((a, b) => b.planned_kg - a.planned_kg);

  // Details (district + product)
  const details = planByDistrictProduct.map((p) => {
    const dpk = `${p.district}|||${p.product_plan}`;
    const d = delByDistrictProduct[dpk] || { delivered_kg: 0, delivered_vols: 0 };
    return {
      district: p.district, province: p.province,
      product: p.product_plan, product_delivery: p.product_delivery,
      planned_kg: p.planned_kg, delivered_kg: d.delivered_kg,
      diff: +(d.delivered_kg - p.planned_kg).toFixed(1),
      pct: pct(d.delivered_kg, p.planned_kg),
      status: getStatus(p.planned_kg, d.delivered_kg),
    };
  }).sort((a, b) => b.planned_kg - a.planned_kg);

  const totalDelivered = deliveryRows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);

  return {
    totals: {
      planned_kg: totalPlannedKg,
      delivered_kg: totalDelivered,
      pct: pct(totalDelivered, totalPlannedKg),
      status: getStatus(totalPlannedKg, totalDelivered),
    },
    by_district: byDistrict,
    by_product: byProduct,
    details,
  };
}

/**
 * Compute the seeds-only totals using rows filtered by province/district only
 * (i.e. ignoring any product filter). This always reflects the full seed
 * segment: Milho + Feijao + Arroz combined.
 */
function buildSeedsTotals(deliveryRowsNoProductFilter, filters) {
  if (!planningData) return null;
  const { province, district } = filters || {};

  // Planning side — sum all seed products under the chosen province/district
  let plannedKg = 0;
  planningData.rows.forEach((r) => {
    if (province && r.province !== province) return;
    if (district && normalizeDistrict(r.district_raw) !== district && r.district !== district) return;
    if (!isSeedProduct(r.product_plan)) return;
    plannedKg += r.weight_kg;
  });

  // Delivery side — sum delivered_qty for rows whose product maps to a seed
  let deliveredKg = 0;
  (deliveryRowsNoProductFilter || []).forEach((r) => {
    const planName = matchProduct(r.product);
    if (!isSeedProduct(planName)) return;
    deliveredKg += Number(r.delivered_qty) || 0;
  });

  const p = plannedKg > 0 ? +((deliveredKg / plannedKg) * 100).toFixed(1) : 0;
  return {
    planned_kg: plannedKg,
    delivered_kg: deliveredKg,
    pct: p,
    status: plannedKg <= 0 ? "N/A"
      : (deliveredKg >= plannedKg - 0.001 ? "Completo"
        : (deliveredKg > 0 ? "Em progresso" : "Sem entregas")),
  };
}

function getGeography() {
  if (!planningData) return { provinces: [], districtsByProvince: {} };
  const map = {};
  planningData.rows.forEach((r) => {
    const prov = r.province;
    const dist = r.district || r.district_raw;
    if (!prov || !dist) return;
    if (!map[prov]) map[prov] = new Set();
    map[prov].add(dist);
  });
  const provinces = Object.keys(map).sort();
  const districtsByProvince = {};
  for (const [prov, dists] of Object.entries(map)) {
    districtsByProvince[prov] = [...dists].sort();
  }
  return { provinces, districtsByProvince };
}

module.exports = { load, getData, buildComparison, buildSeedsTotals, normalizeDistrict, matchProduct, isSeedProduct, getGeography };
