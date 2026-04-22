/**
 * AQI Dashboard – Planning Data Module (UPDATED / REVIEW)
 *
 * Uses the REVIEWED planning file. Key differences from planning-data.js:
 *   - file: data/Planeamento_Actualizado.xlsx
 *   - sheet: "Planeamento Adicional"
 *   - weight source: "Qtd Actualizada" (fallback to "Peso do Volume Kg" if empty)
 *   - captures Tipo de Feijão + Extensionist_ID
 *
 * Same public API as planning-data.js so the route layer can swap instances.
 */
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

const PLANNING_FILE = path.join(__dirname, "data", "Planeamento_Actualizado.xlsx");
const SHEET_NAME = "Planeamento Adicional";

const PRODUCT_MAP = {
  "Milho":            "Maize Seeds (kg)",
  "Feijão":           "Bean Seeds (kg)",
  "Arroz":            "Rice Seeds (kg)",
  "Emamectin":        "Emamectin",
  "Imadocloprid":     "Imidacloprid",
  "MCPA":             "MCPA",
  "Sacos Hermeticos": "Hermetic bags (un)",
};

const SACO_KG_PER_UNIT = 0.3;
function isSacoProduct(name) {
  const l = String(name || "").toLowerCase();
  return l.includes("saco") || l.includes("hermetic");
}
const SEED_PRODUCTS = new Set(["Milho", "Feijão", "Arroz"]);
function isSeedProduct(planName) { return SEED_PRODUCTS.has((planName || "").trim()); }
const PRODUCT_MAP_REV = {};
for (const [k, v] of Object.entries(PRODUCT_MAP)) PRODUCT_MAP_REV[v.toLowerCase()] = k;

function normalizeDistrict(d) {
  if (!d) return "";
  const s = d.trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
    .replace(/\bmoamba\b/i, "Moamba")
    .replace(/\bmanhiça\b/i, "Manhica")
    .replace(/\bnamaacha\b/i, "Namaacha")
    .replace(/\bmagude\b/i, "Magude")
    .replace(/\bboane\b/i, "Boane")
    .replace(/\bmarracuene\b/i, "Marracuene")
    .replace(/\bchókwè\b/i, "Chokwe")
    .replace(/\bchigubo\b/i, "Chigubo");
}

let planningData = null;

/**
 * Parse quantity: accepts numbers, "12.5", "12,5", returns 0 for empty/junk.
 */
function parseQty(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  const s = String(v).replace(/\s/g, "").replace(",", ".");
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function load() {
  if (!fs.existsSync(PLANNING_FILE)) {
    console.warn("[PLANNING-UPDATED] File not found:", PLANNING_FILE);
    planningData = { rows: [], byDistrict: [], byProduct: [], byDistrictProduct: [], byProvince: [] };
    return;
  }

  const wb = XLSX.readFile(PLANNING_FILE);
  const ws = wb.Sheets[SHEET_NAME] || wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { defval: "" });

  const rows = raw.map((r) => {
    const prodPlan = String(r["Referencia"] || "").trim();
    const isSaco = isSacoProduct(prodPlan);
    const qtdActRaw = parseQty(r["Qtd Actualizada"]);
    const pesoOrigRaw = parseQty(r["Peso do Volume Kg"]);
    const hasUpdatedCol = r["Qtd Actualizada"] !== "" && r["Qtd Actualizada"] !== null && r["Qtd Actualizada"] !== undefined;
    // Convert sacos from count to kg (0.3 kg/un)
    const qtdAct = isSaco ? qtdActRaw * SACO_KG_PER_UNIT : qtdActRaw;
    const pesoOrig = isSaco ? pesoOrigRaw * SACO_KG_PER_UNIT : pesoOrigRaw;
    const weight_kg = hasUpdatedCol ? qtdAct : pesoOrig;

    return {
      product_plan:     prodPlan,
      product_delivery: PRODUCT_MAP[prodPlan] || prodPlan,
      province:         String(r["Morada Destino (Provincia)"] || "").trim(),
      district:         normalizeDistrict(r["Distrito"]),
      district_raw:     String(r["Distrito"] || "").trim(),
      posto:            String(r["Posto Administrativo"] || "").trim(),
      beneficiary:      String(r["Nome Destino "] || r["Nome Destino"] || "").trim(),
      volumes:          parseQty(r["Nº Volume novo"]),
      weight_kg,
      weight_original:  pesoOrig,
      weight_updated:   qtdAct,
      weight_was_updated: hasUpdatedCol,
      tipo_feijao:      (function() {
        const raw = String(r["Tipo de Feijão"] || r["Tipo de Feijao"] || "").trim();
        // Feijão sem tipo definido → assume Vulgar
        if (prodPlan === "Feijão" && !raw) return "Vulgar";
        return raw;
      })(),
      extensionist_id:  String(r["Extensionist_ID"] || "").trim(),
      extensionista:    String(r["Nome do Extensionista"] || "").trim(),
      supervisor:       String(r["Nome do Supervisor"] || "").trim(),
    };
  });
  // Removed rows = beneficiários com Qtd Actualizada = 0 explicitamente (foram retirados do plano).
  const removedRows = rows.filter((r) => r.weight_was_updated && r.weight_updated <= 0.001 && r.weight_original > 0.001);
  // Reduced rows = Qtd Actualizada > 0 MAS < Peso original (meta reduziu mas não foi a 0)
  const reducedRows = rows.filter((r) => r.weight_was_updated && r.weight_updated > 0.001 && r.weight_updated < r.weight_original - 0.001);
  // Keep only active rows (weight_kg > 0) for aggregations
  rows.splice(0, rows.length, ...rows.filter((r) => r.weight_kg > 0));

  // Aggregations
  const byDistrict = {}, byProduct = {}, byDistrictProduct = {}, byProvince = {};
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
    removedRows,
    reducedRows,
    byDistrict: Object.values(byDistrict),
    byProduct: Object.values(byProduct),
    byDistrictProduct: Object.values(byDistrictProduct),
    byProvince: Object.values(byProvince),
    totalPlannedKg: rows.reduce((s, r) => s + r.weight_kg, 0),
    totalPlannedVols: rows.reduce((s, r) => s + r.volumes, 0),
    productMap: PRODUCT_MAP,
  };

  console.log(`[PLANNING-UPDATED] Loaded ${rows.length} rows, ${Object.keys(byDistrict).length} districts, ${Object.keys(byProduct).length} products (using Qtd Actualizada)`);
}

function getData() { return planningData; }

function matchProduct(deliveryProductName) {
  if (!deliveryProductName) return null;
  const lower = deliveryProductName.toLowerCase();
  if (PRODUCT_MAP_REV[lower]) return PRODUCT_MAP_REV[lower];
  for (const [planName, delName] of Object.entries(PRODUCT_MAP)) {
    if (lower.includes(delName.toLowerCase()) || lower.includes(planName.toLowerCase())) return planName;
  }
  if (lower.includes("maize") || lower.includes("milho")) return "Milho";
  if (lower.includes("bean") || lower.includes("feij")) return "Feijão";
  if (lower.includes("rice") || lower.includes("arroz")) return "Arroz";
  if (lower.includes("emamectin")) return "Emamectin";
  if (lower.includes("imid") || lower.includes("imad")) return "Imadocloprid";
  if (lower.includes("mcpa")) return "MCPA";
  if (lower.includes("saco") || lower.includes("hermetic")) return "Sacos Hermeticos";
  return null;
}

function buildComparison(deliveryRows, filters) {
  if (!planningData) return null;
  const { province, district, product, seedsOnly, feijaoType } = filters || {};
  let planProductFilter = product ? (matchProduct(product) || product) : null;
  // Feijão type filter: "Vulgar", "Nhemba" → apply within Feijão rows only
  function matchesFeijaoType(r) {
    if (!feijaoType) return true;
    if (r.product_plan !== "Feijão") return true; // only applies to Feijão rows
    const t = String(r.tipo_feijao || "").toLowerCase();
    if (feijaoType === "Vulgar") return t === "vulgar" || t === "" || t.includes("vulgar");
    if (feijaoType === "Nhemba") return t === "nhemba" || t.includes("nhemba");
    return true;
  }

  let planByDistrict = planningData.byDistrict;
  let planByProduct = planningData.byProduct;
  let planByDistrictProduct = planningData.byDistrictProduct;
  let totalPlannedKg = planningData.totalPlannedKg;

  if (province || district || planProductFilter || seedsOnly || feijaoType) {
    const filtered = planningData.rows.filter((r) => {
      if (province && r.province !== province) return false;
      if (district && normalizeDistrict(r.district_raw) !== district && r.district !== district) return false;
      if (planProductFilter && r.product_plan !== planProductFilter) return false;
      if (seedsOnly && !isSeedProduct(r.product_plan)) return false;
      if (!matchesFeijaoType(r)) return false;
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

  const delByDistrict = {}, delByProduct = {}, delByDistrictProduct = {};
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

  const getStatus = (p, d) => p <= 0 ? "N/A" : (d >= p - 0.001 ? "Completo" : (d > 0 ? "Em progresso" : "Sem entregas"));
  const pct = (d, p) => p > 0 ? +((d / p) * 100).toFixed(1) : 0;

  const byDistrictResult = planByDistrict.map((p) => {
    const d = delByDistrict[p.district] || { delivered_kg: 0 };
    return {
      district: p.district, province: p.province,
      planned_kg: p.planned_kg, delivered_kg: d.delivered_kg,
      diff: +(d.delivered_kg - p.planned_kg).toFixed(1),
      pct: pct(d.delivered_kg, p.planned_kg),
      status: getStatus(p.planned_kg, d.delivered_kg),
    };
  }).sort((a, b) => b.planned_kg - a.planned_kg);

  const byProductResult = planByProduct.map((p) => {
    const d = delByProduct[p.product_plan] || { delivered_kg: 0 };
    return {
      product: p.product_plan, product_delivery: p.product_delivery,
      planned_kg: p.planned_kg, delivered_kg: d.delivered_kg,
      diff: +(d.delivered_kg - p.planned_kg).toFixed(1),
      pct: pct(d.delivered_kg, p.planned_kg),
      status: getStatus(p.planned_kg, d.delivered_kg),
    };
  }).sort((a, b) => b.planned_kg - a.planned_kg);

  const details = planByDistrictProduct.map((p) => {
    const dpk = `${p.district}|||${p.product_plan}`;
    const d = delByDistrictProduct[dpk] || { delivered_kg: 0 };
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
    by_district: byDistrictResult,
    by_product: byProductResult,
    details,
  };
}

function buildSeedsTotals(deliveryRowsNoProductFilter, filters) {
  if (!planningData) return null;
  const { province, district } = filters || {};
  let plannedKg = 0;
  planningData.rows.forEach((r) => {
    if (province && r.province !== province) return;
    if (district && normalizeDistrict(r.district_raw) !== district && r.district !== district) return;
    if (!isSeedProduct(r.product_plan)) return;
    plannedKg += r.weight_kg;
  });
  let deliveredKg = 0;
  (deliveryRowsNoProductFilter || []).forEach((r) => {
    const planName = matchProduct(r.product);
    if (!isSeedProduct(planName)) return;
    deliveredKg += Number(r.delivered_qty) || 0;
  });
  const p = plannedKg > 0 ? +((deliveredKg / plannedKg) * 100).toFixed(1) : 0;
  return {
    planned_kg: plannedKg, delivered_kg: deliveredKg, pct: p,
    status: plannedKg <= 0 ? "N/A" : (deliveredKg >= plannedKg - 0.001 ? "Completo" : (deliveredKg > 0 ? "Em progresso" : "Sem entregas")),
  };
}

// ── Extras: Províncias Antes/Depois, Novos Beneficiários, Kits, Duplicados ──
let extras = null;

function loadExtras() {
  if (!fs.existsSync(PLANNING_FILE)) return null;
  const wb = XLSX.readFile(PLANNING_FILE);

  function sheetAsArrays(name) {
    const ws = wb.Sheets[name];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", raw: false });
  }

  // ── Totais por Província (Antes/Depois/Variação por Kit 1/Kit 2/Total) ──
  // Header at row 1: [Província, Kit1, Kit2, Total, Kit1, Kit2, Total, Kit1, Kit2, Total]
  const provRaw = sheetAsArrays("Totais por Província");
  const provSummary = [];
  for (let i = 2; i < provRaw.length; i++) {
    const r = provRaw[i] || [];
    const name = String(r[0] || "").trim();
    if (!name || /^notas?:|•/i.test(name) || name === "") break;
    if (/^total/i.test(name)) { provSummary.push({ province: name, isTotal: true, ...parseKitRow(r) }); continue; }
    provSummary.push({ province: name, isTotal: false, ...parseKitRow(r) });
  }

  // ── Novos Beneficiários ──
  const novosRaw = XLSX.utils.sheet_to_json(wb.Sheets["Novos Beneficiários"] || {}, { defval: "" });
  const novos = novosRaw.map((r) => ({
    extensionist_id: String(r["Extensionist ID"] || "").trim(),
    extensionista: String(r["Extensionista"] || "").trim(),
    contacto: String(r["Contacto Extensionista"] || "").trim(),
    supervisor: String(r["Supervisor"] || "").trim(),
    provincia: String(r["Província"] || "").trim(),
    distrito: String(r["Distrito"] || "").trim(),
    localidade: String(r["Localidade"] || "").trim(),
    kit: String(r["Kit"] || "").trim(),
    qtd_anterior: Number(r["Qtd Anterior"]) || 0,
    qtd_actualizada: Number(r["Qtd Actualizada"]) || 0,
    variacao: Number(r["Variação"]) || 0,
  })).filter((r) => r.extensionista);

  // ── Composição dos Kits ──
  const kitsRaw = sheetAsArrays("Composição dos Kits");
  const kits = [];
  let kitsHeaderIdx = kitsRaw.findIndex((r) => /insumo/i.test(String(r[0] || "")));
  if (kitsHeaderIdx >= 0) {
    for (let i = kitsHeaderIdx + 1; i < kitsRaw.length; i++) {
      const r = kitsRaw[i] || [];
      const insumo = String(r[0] || "").trim();
      if (!insumo) continue;
      kits.push({
        insumo,
        unidade: String(r[1] || "").trim(),
        kit1: String(r[2] || "").trim(),
        kit2: String(r[3] || "").trim(),
        observacao: String(r[4] || "").trim(),
      });
    }
  }

  // ── Sheet4: Nomes potencialmente duplicados ──
  const dupRaw = sheetAsArrays("Sheet4");
  const dupCounts = {};
  dupRaw.forEach((r) => {
    const n = String(r[0] || "").trim();
    if (n) dupCounts[n] = (dupCounts[n] || 0) + 1;
  });
  const duplicates = Object.entries(dupCounts).map(([name, count]) => ({ name, count }));

  extras = {
    provinceSummary: provSummary,
    newBeneficiaries: novos,
    kits,
    flaggedNames: duplicates,
  };

  console.log(`[PLANNING-UPDATED] Extras: ${provSummary.length} provs, ${novos.length} novos benef., ${kits.length} kits, ${duplicates.length} nomes marcados`);
  return extras;
}

function parseKitRow(r) {
  const num = (v) => {
    const s = String(v || "").trim().replace(/\s/g, "").replace(/,/g, "");
    if (/^\(.*\)$/.test(s)) return -Number(s.slice(1, -1)) || 0; // (839) → -839
    const n = Number(s);
    return isNaN(n) ? 0 : n;
  };
  return {
    antes: { kit1: num(r[1]), kit2: num(r[2]), total: num(r[3]) },
    depois: { kit1: num(r[4]), kit2: num(r[5]), total: num(r[6]) },
    variacao: { kit1: num(r[7]), kit2: num(r[8]), total: num(r[9]) },
  };
}

function getExtras() { return extras; }

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
  for (const [prov, dists] of Object.entries(map)) districtsByProvince[prov] = [...dists].sort();
  return { provinces, districtsByProvince };
}

module.exports = { load, loadExtras, getData, getExtras, buildComparison, buildSeedsTotals, normalizeDistrict, matchProduct, isSeedProduct, getGeography };
