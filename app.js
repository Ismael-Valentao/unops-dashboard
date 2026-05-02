require("dotenv").config();
const express = require("express");
const path = require("path");
const https = require("https");
const cookieParser = require("cookie-parser");
const { parse } = require("csv-parse/sync");
const excel = require("./excel-engine");
const snapDb = require("./snapshot-db");
const planning = require("./planning-data");
const planningUpdated = require("./planning-data-updated");
// Default = UPDATED plan. Only use the old plan when the request explicitly opts-in via ?old=1.
function pickPlanning(req) { return req.query.old === "1" ? planning : planningUpdated; }
const mysqlDb = require("./db/mysql");
const auth = require("./auth");
const adminRouter = require("./routes/admin");

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(auth.loadUser);
const PORT = process.env.PORT || 5000;

const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/" +
  "1mgPMSyWn2IoxIXW7vkCiOCOMBOCWTVjMHfZKkFwjvWM" +
  "/export?format=csv&sheet=Delivery";

const COLUMN_KEYS = [
  "delivery_id", "supplier", "province", "district",
  "beneficiary_id", "beneficiary_name", "product", "packages",
  "product_unit", "delivered_qty", "delivery_date", "submission_date",
  "delivery_note_number", "delivery_note_link", "delivery_note_link2",
  "delivery_note_link3", "submitted_by", "beneficiary_signature",
  "is_locked", "phone", "phone_alt", "verification_status",
];

// Cache partilhada com routes/admin (lib/sheet-cache.js para reconciliação)
const sheetCache = require("./lib/sheet-cache");
const cache = sheetCache.cache;

// ── Fetch CSV from Google Sheets ──────────────────────────────
function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      }).on("error", reject);
    };
    get(url);
  });
}

// District name normalization — fixes uppercase variants and known typos
// in the delivery sheet so the same district doesn't appear twice.
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
};
function normalizeDeliveryDistrict(d) {
  if (!d) return "";
  const trimmed = String(d).trim();
  if (!trimmed) return "";
  // Lowercase for lookup, strip diacritics for matching only
  const key = trimmed.toLowerCase();
  if (DISTRICT_ALIASES[key]) return DISTRICT_ALIASES[key];
  // Default: Title Case (first letter upper, rest lower)
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
}

// ── Parse CSV into structured rows ────────────────────────────
function parseCSV(text) {
  const records = parse(text, {
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  // Skip header row
  const dataRows = records.slice(1);

  return dataRows
    .map((cells) => {
      const row = {};
      COLUMN_KEYS.forEach((key, i) => {
        row[key] = (cells[i] || "").trim();
      });

      // Normalise district name (fixes uppercase + Chongoene/Chonguene typo)
      row.district_raw = row.district;
      row.district = normalizeDeliveryDistrict(row.district);

      // Numeric conversions
      row.packages = parseFloat(row.packages) || 0;
      row.delivered_qty = parseFloat(row.delivered_qty) || 0;

      // Convert Hermetic Bags from units (un) to kg (0.3 kg/un) so everything
      // aggregates consistently in kg. Keep the original count for reference.
      const lowerProd = String(row.product || "").toLowerCase();
      if (lowerProd.includes("hermetic") || lowerProd.includes("saco")) {
        row.delivered_qty_units = row.delivered_qty;
        row.delivered_qty = +(row.delivered_qty * 0.3).toFixed(2);
      }

      // Normalise backslashes in delivery note number
      row.delivery_note_number = row.delivery_note_number.replace(/\\/g, "/");
      // Typo recorrente: "GTUS98/..." (U a mais) → "GTS98/...". Aplicado à
      // entrada para que toda a UI/API downstream trabalhe com dados limpos.
      row.delivery_note_number = row.delivery_note_number.replace(/^GTUS/i, "GTS");

      // Convert dates DD/MM/YYYY to ISO for sorting
      for (const col of ["delivery_date", "submission_date"]) {
        const m = (row[col] || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        row[col + "_iso"] = m ? `${m[3]}-${m[2]}-${m[1]}` : "";
      }

      return row;
    })
    .filter((r) => r.delivery_id !== "");
}

// ── Enrich delivery rows with ADSN from logistics file ───────
function enrichWithADSN(rows) {
  try {
    const fs = require("fs");
    const filePath = path.join(__dirname, "data", "servicos.xlsx");
    if (!fs.existsSync(filePath)) return;
    const wb = XLSX_LIB.readFile(filePath);
    const servicos = XLSX_LIB.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    const adsnByGTU = {};
    for (const s of servicos) {
      const gtu = normGTU(s["Trabalho"]);
      if (gtu) adsnByGTU[gtu] = String(s["Serviço"] || "").trim();
    }
    for (const r of rows) {
      const gtu = normGTU(r.delivery_note_number);
      r.adsn = adsnByGTU[gtu] || "";
    }
  } catch (e) {
    console.warn("[ADSN] Could not enrich:", e.message);
  }
}

// ── Refresh cache ─────────────────────────────────────────────
async function refreshCache() {
  try {
    const text = await fetchCSV(SHEET_CSV_URL);
    cache.data = parseCSV(text);
    enrichWithADSN(cache.data);
    cache.lastUpdated = new Date().toISOString();
    console.log(`[OK] Loaded ${cache.data.length} rows at ${cache.lastUpdated}`);
  } catch (err) {
    console.error("[WARN] Failed to refresh data:", err.message);
  }
}

// ── Static files ──────────────────────────────────────────────
app.use("/static", express.static(path.join(__dirname, "static")));

// ── Admin (internal operations) router ────────────────────────
app.use("/admin", adminRouter);

// ── Routes ────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

// Operations team view — same dashboard with verification/errors section
app.get("/operations/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

// Legacy URL: /updated redirects to / (updated is now the default)
app.get("/updated", (_req, res) => res.redirect(301, "/"));

// Old/deprecated planning view (previous planeamento_wilson_.xlsx)
app.get("/anterior", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "index.html"));
});

// Realocação — operational view (excessos → défices)
app.get("/realocacao", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "realocacao.html"));
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "ceo-dashboard.html"));
});

app.get("/api/data", (_req, res) => {
  res.json({ rows: cache.data, last_updated: cache.lastUpdated });
});

app.post("/api/refresh", async (_req, res) => {
  await refreshCache();
  res.json({ rows: cache.data, last_updated: cache.lastUpdated });
});

// ── Cron keep-alive + refresh endpoint ────────────────────────
app.get("/cron", async (_req, res) => {
  await refreshCache();
  const today = snapDb.todayStr();
  res.json({
    status: "ok",
    rows: cache.data.length,
    last_updated: cache.lastUpdated,
    snapshot_today: snapDb.hasSnapshot(today),
  });
});

// ── Verification endpoint ────────────────────────────────────
app.get("/api/verify", (_req, res) => {
  const rows = cache.data;
  const UNIT_WEIGHTS = [1, 5, 10, 12.5, 15, 50];

  // 1. Duplicate Delivery Notes
  const gtuMap = {};
  rows.forEach((r, i) => {
    const gtu = (r.delivery_note_number || "").trim();
    if (!gtu) return;
    if (!gtuMap[gtu]) gtuMap[gtu] = [];
    gtuMap[gtu].push({
      row: i + 2,
      delivery_id: r.delivery_id,
      beneficiary_name: r.beneficiary_name,
      district: r.district,
      packages: r.packages,
      delivered_qty: r.delivered_qty,
      verification_status: r.verification_status,
    });
  });

  const IGNORED_DUPLICATE_GTUS = new Set(["GTU98/202306448"]);
  const duplicateGTUs = [];
  for (const [gtu, entries] of Object.entries(gtuMap)) {
    if (entries.length > 1 && !IGNORED_DUPLICATE_GTUS.has(gtu)) {
      duplicateGTUs.push({ gtu, count: entries.length, entries });
    }
  }

  // 2. Weight mismatches: try all known unit weights, flag if NONE match
  const weightMismatches = [];
  rows.forEach((r, i) => {
    const pkgs = r.packages;
    const qty = r.delivered_qty;
    if (pkgs <= 0) return;
    const matchedUnit = UNIT_WEIGHTS.find((u) => Math.abs(qty - pkgs * u) < 0.01);
    if (!matchedUnit) {
      const closest = UNIT_WEIGHTS.reduce((best, u) => {
        const diff = Math.abs(qty - pkgs * u);
        return diff < best.diff ? { unit: u, expected: pkgs * u, diff } : best;
      }, { unit: 0, expected: 0, diff: Infinity });
      const diff = +(qty - closest.expected).toFixed(2);
      if (Math.abs(diff) < 1) return; // ignore differences < 1 kg
      weightMismatches.push({
        row: i + 2,
        delivery_id: r.delivery_id,
        gtu: r.delivery_note_number,
        beneficiary_name: r.beneficiary_name,
        district: r.district,
        product: r.product,
        packages: pkgs,
        delivered_qty: qty,
        closest_unit: closest.unit,
        expected_qty: closest.expected,
        difference: diff,
      });
    }
  });

  // 3. Delivery Note pattern: GTU98/XXXXXXXXX or GTS98/XXXXXXXXX (case-insensitive prefix)
  const DN_PATTERN = /^gt[us]98\/\d{9}$/i;
  const malformedGTUs = [];
  rows.forEach((r, i) => {
    const gtu = (r.delivery_note_number || "").trim();
    if (!gtu) {
      malformedGTUs.push({
        row: i + 2, delivery_id: r.delivery_id, gtu: "(vazio)",
        beneficiary_name: r.beneficiary_name, district: r.district,
        reason: "Delivery Note em branco",
      });
      return;
    }
    if (!DN_PATTERN.test(gtu)) {
      let reason = "";
      if (!/^gt[us]98\//i.test(gtu)) reason = "Prefixo incorrecto (esperado GTU98/ ou GTS98/)";
      else {
        const digits = gtu.replace(/^gt[us]98\//i, "");
        if (digits.length !== 9) reason = "Comprimento incorrecto (" + gtu.length + " chars, esperado 15)";
        else reason = "Caracteres invalidos apos prefixo";
      }
      malformedGTUs.push({
        row: i + 2, delivery_id: r.delivery_id, gtu,
        beneficiary_name: r.beneficiary_name, district: r.district, reason,
      });
    }
  });

  res.json({
    total_rows: rows.length,
    unique_gtus: Object.keys(gtuMap).length,
    duplicate_gtus: duplicateGTUs,
    duplicate_gtu_count: duplicateGTUs.length,
    weight_mismatches: weightMismatches,
    weight_mismatch_count: weightMismatches.length,
    malformed_gtus: malformedGTUs,
    malformed_gtu_count: malformedGTUs.length,
    gtu_pattern: "GTU98/XXXXXXXXX ou GTS98/XXXXXXXXX",
    unit_weights: UNIT_WEIGHTS,
  });
});

// ── Analytics endpoints ───────────────────────────────────────
app.get("/api/analytics", (_req, res) => {
  const rows = cache.data;
  const comparison = planning.buildComparison(rows);
  if (!comparison) return res.status(500).json({ error: "No data" });

  // Execution velocity: avg kg/day based on distinct delivery dates
  const dates = [...new Set(rows.map((r) => r.delivery_date_iso).filter(Boolean))].sort();
  const daySpan = dates.length > 1
    ? Math.max(1, (new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000 + 1)
    : 1;
  const totalDelivered = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
  const avgKgPerDay = totalDelivered / daySpan;
  const remaining = comparison.totals.planned_kg - totalDelivered;
  const estDaysLeft = avgKgPerDay > 0 ? Math.ceil(remaining / avgKgPerDay) : null;

  // Last 7 days
  const now = new Date();
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
  const d14 = new Date(now); d14.setDate(d14.getDate() - 14);
  const iso7 = d7.toISOString().slice(0, 10);
  const iso14 = d14.toISOString().slice(0, 10);
  const last7 = rows.filter((r) => r.delivery_date_iso >= iso7);
  const prev7 = rows.filter((r) => r.delivery_date_iso >= iso14 && r.delivery_date_iso < iso7);
  const last7Kg = last7.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
  const prev7Kg = prev7.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);

  // Gap analysis by product
  const gaps = comparison.by_product.map((p) => ({
    product: p.product,
    planned_kg: p.planned_kg,
    delivered_kg: p.delivered_kg,
    gap_kg: p.planned_kg - p.delivered_kg,
    pct: p.pct,
  })).sort((a, b) => b.gap_kg - a.gap_kg);

  // District urgency ranking (lowest pct first, only planned > 0)
  const urgency = comparison.by_district
    .filter((d) => d.planned_kg > 0)
    .sort((a, b) => a.pct - b.pct)
    .map((d, i) => ({ rank: i + 1, ...d }));

  // Supplier performance
  const suppliers = {};
  rows.forEach((r) => {
    const s = r.supplier || "N/A";
    if (!suppliers[s]) suppliers[s] = { supplier: s, deliveries: 0, total_kg: 0, districts: new Set() };
    suppliers[s].deliveries++;
    suppliers[s].total_kg += Number(r.delivered_qty) || 0;
    suppliers[s].districts.add(r.district);
  });
  const supplierPerf = Object.values(suppliers).map((s) => ({
    supplier: s.supplier, deliveries: s.deliveries,
    total_kg: s.total_kg, districts: s.districts.size,
  })).sort((a, b) => b.total_kg - a.total_kg);

  // Executive summary (auto-generated text)
  const execSummary = [];
  execSummary.push(`Operacao com ${comparison.totals.pct}% de execucao global (${Math.round(totalDelivered/1000)}t de ${Math.round(comparison.totals.planned_kg/1000)}t planeadas).`);
  if (avgKgPerDay > 0 && estDaysLeft) {
    execSummary.push(`Ritmo actual: ${Math.round(avgKgPerDay/1000)}t/dia. A este ritmo, faltam ~${estDaysLeft} dias para completar.`);
  }
  const worst = urgency.slice(0, 3).map((d) => d.district).join(", ");
  if (worst) execSummary.push(`Distritos mais atrasados: ${worst}.`);
  if (last7Kg > prev7Kg) execSummary.push(`Ultimos 7 dias: ${Math.round(last7Kg/1000)}t entregues (+${Math.round((last7Kg-prev7Kg)/1000)}t vs semana anterior).`);
  else if (last7Kg < prev7Kg) execSummary.push(`Ultimos 7 dias: ${Math.round(last7Kg/1000)}t entregues (${Math.round((last7Kg-prev7Kg)/1000)}t vs semana anterior). Ritmo a abrandar.`);
  else execSummary.push(`Ultimos 7 dias: ${Math.round(last7Kg/1000)}t entregues.`);

  res.json({
    velocity: { avg_kg_per_day: Math.round(avgKgPerDay), est_days_left: estDaysLeft, day_span: daySpan, active_days: dates.length },
    last7: { kg: last7Kg, deliveries: last7.length, prev_kg: prev7Kg, prev_deliveries: prev7.length },
    gaps,
    urgency,
    supplier_performance: supplierPerf,
    executive_summary: execSummary,
  });
});

// Progress over time (from snapshots)
app.get("/api/analytics/progress", (_req, res) => {
  const snaps = snapDb.listSnapshots();
  const progress = snaps.reverse().map((s) => ({
    date: s.date,
    total: s.total,
    verified: s.verified,
    pending: s.pending,
    errors: s.errors,
    total_qty: s.total_qty,
    total_packages: s.total_packages,
  }));
  res.json(progress);
});

// ── CEO Dashboard endpoint ────────────────────────────────────
app.get("/api/ceo-overview", (_req, res) => {
  const rows = cache.data;
  const comparison = planning.buildComparison(rows);
  if (!comparison) return res.status(500).json({ error: "No data" });

  const totalDelivered = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
  const totalPlanned = comparison.totals.planned_kg;
  const globalPct = comparison.totals.pct;

  // Dates
  const dates = [...new Set(rows.map((r) => r.delivery_date_iso).filter(Boolean))].sort();
  const firstDate = dates[0] || null;
  const lastDate = dates[dates.length - 1] || null;
  const daySpan = dates.length > 1 ? Math.max(1, (new Date(lastDate) - new Date(firstDate)) / 86400000 + 1) : 1;
  const avgKgPerDay = totalDelivered / daySpan;
  const remaining = totalPlanned - totalDelivered;
  const estDaysLeft = avgKgPerDay > 0 ? Math.ceil(remaining / avgKgPerDay) : null;

  // Province scorecard
  const provMap = {};
  comparison.by_district.forEach((d) => {
    const p = d.province || "N/A";
    if (!provMap[p]) provMap[p] = { province: p, planned_kg: 0, delivered_kg: 0, districts_total: 0, districts_active: 0 };
    provMap[p].planned_kg += d.planned_kg;
    provMap[p].delivered_kg += d.delivered_kg;
    provMap[p].districts_total++;
    if (d.delivered_kg > 0) provMap[p].districts_active++;
  });
  const provinces = Object.values(provMap).map((p) => ({
    ...p,
    pct: p.planned_kg > 0 ? +((p.delivered_kg / p.planned_kg) * 100).toFixed(1) : 0,
    status: p.planned_kg <= 0 ? "N/A" : (p.delivered_kg / p.planned_kg) >= 0.95 ? "Completo" : p.delivered_kg > 0 ? "Em progresso" : "Sem entregas",
  })).sort((a, b) => b.planned_kg - a.planned_kg);

  // Smart alerts with impact
  const alerts = [];
  // Duplicate GTUs
  const gtuMap = {};
  rows.forEach((r) => { const g = (r.delivery_note_number || "").trim(); if (g) { if (!gtuMap[g]) gtuMap[g] = []; gtuMap[g].push(r); } });
  let dupKg = 0, dupCount = 0;
  for (const [, entries] of Object.entries(gtuMap)) {
    if (entries.length > 1) { dupCount++; dupKg += entries.slice(1).reduce((s, e) => s + (Number(e.delivered_qty) || 0), 0); }
  }
  if (dupCount > 0) alerts.push({ severity: "critical", icon: "⚠", msg: `${dupCount} GTUs duplicados — possivel dupla contagem de ${Math.round(dupKg).toLocaleString()} kg`, impact: dupKg });
  // Errors
  const errCount = rows.filter((r) => r.verification_status === "#ERROR!").length;
  if (errCount > 0) alerts.push({ severity: "critical", icon: "🔴", msg: `${errCount} registos com #ERROR! — dados corrompidos`, impact: errCount * 1000 });
  // Worst districts
  const worstDistricts = comparison.by_district.filter((d) => d.planned_kg > 50000 && d.pct === 0).slice(0, 5);
  worstDistricts.forEach((d) => {
    alerts.push({ severity: "high", icon: "🟠", msg: `${d.district} (${d.province}): ${Math.round(d.planned_kg/1000)}t planeadas, 0% entregue`, impact: d.planned_kg });
  });
  // Weight mismatches
  let wmCount = 0;
  rows.forEach((r) => { if (r.packages > 0 && Math.abs(r.delivered_qty - r.packages * 12.5) > 0.01) wmCount++; });
  if (wmCount > 0) alerts.push({ severity: "medium", icon: "🟡", msg: `${wmCount} registos com discrepancia de peso (Pacotes x 12.5 ≠ Qtd)`, impact: wmCount * 500 });
  alerts.sort((a, b) => b.impact - a.impact);

  // Supervisor performance
  const supervisors = {};
  rows.forEach((r) => {
    const s = r.submitted_by || "N/A";
    if (!supervisors[s]) supervisors[s] = { name: s, deliveries: 0, total_kg: 0, districts: new Set(), errors: 0 };
    supervisors[s].deliveries++;
    supervisors[s].total_kg += Number(r.delivered_qty) || 0;
    supervisors[s].districts.add(r.district);
    if (r.verification_status === "#ERROR!") supervisors[s].errors++;
  });
  const supervisorList = Object.values(supervisors).map((s) => ({
    name: s.name, deliveries: s.deliveries, total_kg: s.total_kg,
    districts: s.districts.size, errors: s.errors,
  })).sort((a, b) => b.total_kg - a.total_kg);

  // Weekly briefing data
  const now = new Date();
  const d7 = new Date(now); d7.setDate(d7.getDate() - 7);
  const iso7 = d7.toISOString().slice(0, 10);
  const last7 = rows.filter((r) => r.delivery_date_iso >= iso7);
  const last7Kg = last7.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
  const newDistricts = [...new Set(last7.map((r) => r.district))];

  // Progress from snapshots
  const snaps = snapDb.listSnapshots().reverse();

  res.json({
    kpi: {
      global_pct: globalPct,
      total_planned: totalPlanned,
      total_delivered: totalDelivered,
      remaining,
      avg_kg_per_day: Math.round(avgKgPerDay),
      est_days_left: estDaysLeft,
      first_date: firstDate,
      last_date: lastDate,
      day_span: daySpan,
      total_deliveries: rows.length,
    },
    provinces,
    alerts,
    supervisors: supervisorList,
    weekly: {
      kg: last7Kg,
      deliveries: last7.length,
      districts: newDistricts,
    },
    gaps: comparison.by_product.map((p) => ({
      product: p.product, planned_kg: p.planned_kg,
      delivered_kg: p.delivered_kg, gap_kg: p.planned_kg - p.delivered_kg, pct: p.pct,
    })).sort((a, b) => b.gap_kg - a.gap_kg),
    progress: snaps.map((s) => ({ date: s.date, total: s.total, total_qty: s.total_qty })),
  });
});

// ── Planned vs Delivered endpoints ────────────────────────────
app.get("/api/planning-geography", (req, res) => {
  res.json(pickPlanning(req).getGeography());
});

// Extras from the updated planning file (Antes/Depois, Novos Benef., Kits, Duplicados)
app.get("/api/planning-updates-summary", (_req, res) => {
  const extras = planningUpdated.getExtras();
  if (!extras) return res.status(404).json({ error: "Extras não disponíveis" });
  res.json(extras);
});

// Realocação data (excessos → défices)
app.get("/api/realocacao", (_req, res) => {
  const r = planningUpdated.getRealocacao();
  if (!r) return res.status(404).json({ error: "Dados de realocação não disponíveis" });
  res.json(r);
});

// Shared helpers for cross-referencing planning revisions with deliveries
function _normName(s) { return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " "); }
function _normDist(s) { return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""); }
function _canonProduct(raw) {
  const l = String(raw || "").toLowerCase();
  if (l.includes("milho") || l.includes("maize")) return "Milho";
  if (l.includes("feij") || l.includes("bean")) return "Feijão";
  if (l.includes("arroz") || l.includes("rice")) return "Arroz";
  if (l.includes("emamectin")) return "Emamectin";
  if (l.includes("imidaclop") || l.includes("imadoclop")) return "Imidacloprid";
  if (l.includes("mcpa")) return "MCPA";
  if (l.includes("saco") || l.includes("hermetic")) return "Sacos Hermeticos";
  return String(raw || "").trim();
}

function _indexDeliveriesByKey() {
  const idx = {};
  for (const d of cache.data) {
    const key = _normName(d.beneficiary_name) + "|" + _normDist(d.district) + "|" + _canonProduct(d.product);
    if (!idx[key]) idx[key] = [];
    idx[key].push(d);
  }
  return idx;
}

// Helper: aggregates planning rows by (beneficiary + district + canonical product)
// so multiple rows for the same person/product (different kits/volumes) are merged.
function _aggregatePlanningRows(rows) {
  const map = {};
  for (const r of rows) {
    const key = _normName(r.beneficiary) + "|" + _normDist(r.district) + "|" + _canonProduct(r.product_plan);
    if (!map[key]) {
      map[key] = {
        key,
        beneficiario: r.beneficiary,
        extensionista: r.extensionista,
        extensionist_id: r.extensionist_id,
        supervisor: r.supervisor,
        provincia: r.province,
        distrito: r.district,
        posto: r.posto,
        produto: r.product_plan,
        weight_original: 0,
        weight_updated: 0,
      };
    }
    map[key].weight_original += Number(r.weight_original) || 0;
    map[key].weight_updated  += Number(r.weight_updated)  || 0;
  }
  return Object.values(map);
}

// Extensionistas removidos do plano (todas as linhas do produto com Qtd Actualizada = 0)
// que já tinham recebido algo
app.get("/api/planning-removed-beneficiaries", (_req, res) => {
  const data = planningUpdated.getData();
  if (!data || !data.removedRows) return res.json({ list: [], summary: {} });

  const normName = _normName, normDist = _normDist, canonProduct = _canonProduct;

  const delIdx = _indexDeliveriesByKey();

  // Aggregate removed rows by (benef + district + product) — only include beneficiary/product
  // where ALL planning lines were zeroed (sum of weight_updated ~= 0).
  const allGroups = _aggregatePlanningRows(data.rows.concat(data.removedRows));
  const removedGroups = allGroups.filter((g) => g.weight_updated <= 0.001 && g.weight_original > 0.001);

  const out = [];
  for (const g of removedGroups) {
    const delRows = delIdx[g.key] || [];
    if (!delRows.length) continue;

    const totalDeliv = delRows.reduce((s, d) => s + (Number(d.delivered_qty) || 0), 0);
    const dates = [...new Set(delRows.map((d) => d.delivery_date).filter(Boolean))].sort();
    const gtus = [...new Set(delRows.map((d) => d.delivery_note_number).filter(Boolean))];
    const statuses = [...new Set(delRows.map((d) => d.verification_status).filter(Boolean))];

    out.push({
      beneficiario: g.beneficiario,
      extensionista: g.extensionista,
      extensionist_id: g.extensionist_id,
      supervisor: g.supervisor,
      provincia: g.provincia,
      distrito: g.distrito,
      posto: g.posto,
      produto: g.produto,
      qtd_planeada_original: +g.weight_original.toFixed(2),
      qtd_actualizada: 0,
      qtd_entregue: +totalDeliv.toFixed(2),
      num_entregas: delRows.length,
      datas: dates,
      primeira_entrega: dates[0] || null,
      ultima_entrega: dates[dates.length - 1] || null,
      gtus,
      verificacao: statuses.join(", "),
    });
  }

  // Summary
  const byProv = {};
  const byProd = {};
  let totalDeliveredKg = 0;
  out.forEach((r) => {
    byProv[r.provincia] = (byProv[r.provincia] || 0) + r.qtd_entregue;
    byProd[r.produto] = (byProd[r.produto] || 0) + r.qtd_entregue;
    totalDeliveredKg += r.qtd_entregue;
  });
  const uniqueBenefs = new Set(out.map((r) => r.beneficiario + "|" + r.distrito)).size;

  res.json({
    list: out,
    summary: {
      total_rows: out.length,
      unique_beneficiaries: uniqueBenefs,
      total_delivered_kg: +totalDeliveredKg.toFixed(2),
      by_province: byProv,
      by_product: byProd,
    },
  });
});

// Beneficiários cuja Qtd Actualizada foi REDUZIDA (> 0 mas < original) e que já receberam.
// Foca-se em detectar quem recebeu mais do que a nova meta.
// Agrega por (beneficiário + distrito + produto) para evitar contar entregas várias vezes
// quando o mesmo beneficiário tem múltiplas linhas de planeamento para o mesmo produto.
app.get("/api/planning-reduced-beneficiaries", (_req, res) => {
  const data = planningUpdated.getData();
  if (!data) return res.json({ list: [], summary: {} });

  const delIdx = _indexDeliveriesByKey();

  // Combine active rows + reducedRows into a single list, then aggregate
  // so we capture the full picture per (benef + prod).
  const allPlanning = data.rows.concat(data.removedRows || []);
  const groups = _aggregatePlanningRows(allPlanning);
  // Reduced = group where updated > 0 AND updated < original
  const reducedGroups = groups.filter((g) => g.weight_updated > 0.001 && g.weight_updated < g.weight_original - 0.001);

  const out = [];
  for (const g of reducedGroups) {
    const delRows = delIdx[g.key] || [];
    if (!delRows.length) continue;

    const totalDeliv = delRows.reduce((s, d) => s + (Number(d.delivered_qty) || 0), 0);
    const dates = [...new Set(delRows.map((d) => d.delivery_date).filter(Boolean))].sort();
    const gtus = [...new Set(delRows.map((d) => d.delivery_note_number).filter(Boolean))];

    const novaMeta = g.weight_updated;
    const excesso = Math.max(0, totalDeliv - novaMeta);

    out.push({
      beneficiario: g.beneficiario,
      extensionista: g.extensionista,
      extensionist_id: g.extensionist_id,
      supervisor: g.supervisor,
      provincia: g.provincia,
      distrito: g.distrito,
      posto: g.posto,
      produto: g.produto,
      qtd_planeada_original: +g.weight_original.toFixed(2),
      qtd_actualizada: +novaMeta.toFixed(2),
      reducao: +(g.weight_original - novaMeta).toFixed(2),
      qtd_entregue: +totalDeliv.toFixed(2),
      excesso: +excesso.toFixed(2),
      acima_da_nova_meta: totalDeliv > novaMeta + 0.001,
      num_entregas: delRows.length,
      datas: dates,
      gtus,
    });
  }

  // Split: acima da nova meta vs abaixo/igual
  const acimaMeta = out.filter((r) => r.acima_da_nova_meta);
  const abaixoMeta = out.filter((r) => !r.acima_da_nova_meta);

  const byProv = {};
  const byProd = {};
  let totalExcesso = 0;
  acimaMeta.forEach((r) => {
    byProv[r.provincia] = (byProv[r.provincia] || 0) + r.excesso;
    byProd[r.produto] = (byProd[r.produto] || 0) + r.excesso;
    totalExcesso += r.excesso;
  });
  const uniqueBenefs = new Set(acimaMeta.map((r) => r.beneficiario + "|" + r.distrito)).size;

  res.json({
    list: out,
    acima_da_nova_meta: acimaMeta,
    dentro_da_nova_meta: abaixoMeta,
    summary: {
      total_rows: out.length,
      rows_above: acimaMeta.length,
      rows_within: abaixoMeta.length,
      unique_beneficiaries_above: uniqueBenefs,
      total_excesso_kg: +totalExcesso.toFixed(2),
      by_province_excesso: byProv,
      by_product_excesso: byProd,
    },
  });
});

app.get("/api/planned-vs-delivered", (req, res) => {
  const { province, district, product, seeds_only } = req.query;
  const SEED_NAMES = new Set(["Maize Seeds (kg)", "Common Bean Seeds (kg)", "Bean Seeds (kg)", "Rice Seeds (kg)"]);
  let rows = cache.data;
  if (province) rows = rows.filter((r) => r.province === province);
  if (district) rows = rows.filter((r) => r.district === district);
  // Keep a copy WITHOUT the product filter for the seeds-segment computation
  const rowsNoProduct = rows.slice();
  if (seeds_only === "1") rows = rows.filter((r) => SEED_NAMES.has(r.product));
  else if (product) rows = rows.filter((r) => r.product === product);

  const seedsFilter = seeds_only === "1";
  const plan = pickPlanning(req);
  const result = plan.buildComparison(rows, { province, district, product: seedsFilter ? undefined : product, seedsOnly: seedsFilter });
  if (!result) return res.status(500).json({ error: "Planning data not loaded" });
  result.totals_seeds = plan.buildSeedsTotals(rowsNoProduct, { province, district });
  res.json(result);
});

app.get("/api/export/planeado-vs-entregue", async (_req, res) => {
  try {
    const comparison = planning.buildComparison(cache.data);
    if (!comparison) return res.status(500).json({ error: "No planning data" });
    const result = await excel.exportPlaneadoVsEntregue(comparison);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
    res.send(Buffer.from(result.buf));
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Snapshot endpoints ────────────────────────────────────────
app.get("/api/snapshots", (_req, res) => {
  res.json(snapDb.listSnapshots());
});

app.get("/api/snapshots/:date", (req, res) => {
  const snap = snapDb.getSnapshot(req.params.date);
  if (!snap) return res.status(404).json({ error: "Snapshot not found" });
  res.json({ rows: snap.rows, last_updated: snap.created_at, snapshot_date: snap.date });
});

app.post("/api/snapshots/save-now", (_req, res) => {
  const today = snapDb.todayStr();
  if (cache.data.length === 0) return res.status(400).json({ error: "No data to save" });
  snapDb.saveSnapshot(today, cache.data);
  res.json({ saved: true, date: today, rows: cache.data.length });
});

// ── Excel export endpoints (professional formatting via exceljs) ──
function sendBuf(res, { buf, filename }) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(Buffer.from(buf));
}

app.post("/api/export/tabela", async (req, res) => {
  try {
    let rows = cache.data;
    if (req.body.delivery_ids && Array.isArray(req.body.delivery_ids)) {
      const idSet = new Set(req.body.delivery_ids);
      rows = rows.filter((r) => idSet.has(r.delivery_id));
    }
    const result = await excel.exportTabela(rows, req.body.columns);
    sendBuf(res, result);
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/export/duplicados", async (_req, res) => {
  try { sendBuf(res, await excel.exportDuplicados(cache.data)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/export/peso", async (_req, res) => {
  try { sendBuf(res, await excel.exportPeso(cache.data)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/export/padrao", async (_req, res) => {
  try { sendBuf(res, await excel.exportPadrao(cache.data)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get("/api/export/relatorio-completo", async (_req, res) => {
  try { sendBuf(res, await excel.exportRelatorioCompleto(cache.data)); }
  catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── Shared logistics helpers ─────────────────────────────────
const XLSX_LIB = require("xlsx");

// Normalize GTU: GTS→GTU, remove extra slash, pad suffix to 5 digits
function normGTU(raw) {
  let g = String(raw || "").trim().replace(/\\/g, "/");
  // Tipos de input: GTUS98/... (com U a mais — provável typo do operador) → GTS98/...
  g = g.replace(/^GTUS/i, "GTS");
  g = g.replace(/^GTS/i, "GTU");
  // GTU98/2023/6433 → GTU98/202306433 (extra slash + short suffix)
  g = g.replace(/^(GTU\d+\/\d{4})\/(\d+)$/i, (_, prefix, num) => prefix + num.padStart(5, "0"));
  // GTU98/20236449 → GTU98/202306449 (no slash, year glued to short suffix: 4-digit suffix → pad to 5)
  g = g.replace(/^(GTU\d+\/\d{4})(\d{4})$/i, (_, prefix, num) => prefix + "0" + num);
  return g;
}

// ── Logistics cross-reference ────────────────────────────────

const SKU_MAP = {
  MXIXMILHOKG: "Milho", MXIXFEIJAOKG: "Feijão", MXIXARROZKG: "Arroz",
  AGRIFEMTINL: "Emamectin", AGRIMIDACLORIPLT: "Imidacloprid", AGRIMHMCPALT: "MCPA",
  SUSSACO: "Sacos Herméticos", MMRMINTER25: "Sacos Herméticos",
  SEEDARROZM50KG: "Arroz", MSEEDFJNHB5KG: "Feijão", MSEEDOPVZM523: "Milho",
  AGRIFEMMA0125L: "Emamectin",
};

app.get("/api/logistics/compare", (_req, res) => {
  try {
    const filePath = path.join(__dirname, "data", "servicos.xlsx");
    const fs = require("fs");
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Ficheiro de serviços não encontrado (data/servicos.xlsx)" });
    }
    const wb = XLSX_LIB.readFile(filePath);
    const servicos = XLSX_LIB.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "" });

    // Index delivery rows by normalized GTU
    const delivByGTU = {};
    for (const d of cache.data) {
      const gtu = normGTU(d.delivery_note_number);
      if (!gtu) continue;
      if (!delivByGTU[gtu]) delivByGTU[gtu] = [];
      delivByGTU[gtu].push(d);
    }

    // Index logistics rows by normalized GTU for reverse lookup
    const logByGTU = {};
    for (const s of servicos) {
      const gtu = normGTU(s["Trabalho"]);
      if (gtu) logByGTU[gtu] = s;
    }

    const all = [];
    const concluidos = [];   // FINALIZADO + no dashboard = tudo OK
    const porFechar = [];    // no dashboard mas NÃO finalizado no logístico = precisa fechar
    const semEntrega = [];   // FINALIZADO no logístico mas SEM registo no dashboard
    const emTransito = [];   // TRANSITO/CRIADO e sem entrega no dashboard
    let matched = 0;
    let pesoConcluidos = 0, pesoPorFechar = 0, pesoSemEntrega = 0, pesoEmTransito = 0;

    for (const s of servicos) {
      const gtu = normGTU(s["Trabalho"]);
      // Only process série 98 (GTU98 / GTS98)
      if (!/^GTU98\//i.test(gtu)) continue;
      const delRows = delivByGTU[gtu] || [];
      const entregue = delRows.length > 0;
      const totalDeliv = delRows.reduce((sum, d) => sum + (Number(d.delivered_qty) || 0), 0);
      const produto = SKU_MAP[s["SKU"]] || s["SKU"] || "";
      const estado = String(s["Estado"] || "").toUpperCase();
      const peso = Number(s["Peso"]) || 0;

      if (entregue) matched++;

      const row = {
        adsn: String(s["Serviço"] || "").trim(),
        gtu,
        estado_logistico: estado,
        entregue_dashboard: entregue,
        destinatario: String(s["Destinatario"] || "").trim(),
        provincia: String(s["Provincia"] || "").trim(),
        distrito: String(s["Distrito"] || "").trim(),
        produto,
        peso,
        volumes: Number(s["Volumes"]) || 0,
        matricula: String(s["Matricula"] || "").trim(),
        origem: String(s["Origem"] || "").trim(),
        qtd_entregue: totalDeliv,
        verificacao: delRows.length ? delRows[0].verification_status : "",
      };

      all.push(row);

      if (estado === "FINALIZADO" && entregue) {
        concluidos.push(row); pesoConcluidos += peso;
      } else if (estado === "FINALIZADO" && !entregue) {
        semEntrega.push(row); pesoSemEntrega += peso;
      } else if (entregue && estado !== "FINALIZADO") {
        porFechar.push(row); pesoPorFechar += peso;
      } else if (estado === "TRANSITO" && !entregue) {
        emTransito.push(row); pesoEmTransito += peso;
      }
    }

    // Deliveries in dashboard with NO matching logistics row at all
    const semCorrespondencia = [];
    let pesoSemCorresp = 0;
    for (const d of cache.data) {
      const gtu = normGTU(d.delivery_note_number);
      if (!gtu || logByGTU[gtu]) continue;
      const peso = Number(d.delivered_qty) || 0;
      const row = {
        adsn: "",
        gtu,
        estado_logistico: "NÃO ENCONTRADO",
        entregue_dashboard: true,
        destinatario: d.beneficiary_name || "",
        provincia: d.province || "",
        distrito: d.district || "",
        produto: d.product || "",
        peso,
        volumes: Number(d.packages) || 0,
        matricula: "",
        origem: "",
        qtd_entregue: peso,
        verificacao: d.verification_status || "",
      };
      semCorrespondencia.push(row);
      pesoSemCorresp += peso;
    }

    const fmt = (n) => Math.round(n * 10) / 10;
    res.json({
      summary: {
        total: servicos.length,
        matched,
        concluidos: concluidos.length, peso_concluidos: fmt(pesoConcluidos),
        por_fechar: porFechar.length, peso_por_fechar: fmt(pesoPorFechar),
        sem_entrega: semEntrega.length, peso_sem_entrega: fmt(pesoSemEntrega),
        em_transito: emTransito.length, peso_em_transito: fmt(pesoEmTransito),
        sem_correspondencia: semCorrespondencia.length, peso_sem_correspondencia: fmt(pesoSemCorresp),
      },
      concluidos,
      por_fechar: porFechar,
      sem_entrega: semEntrega,
      em_transito: emTransito,
      sem_correspondencia: semCorrespondencia,
      all,
    });
  } catch (e) {
    console.error("[Logistics]", e);
    res.status(500).json({ error: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
async function main() {
  // Init modules
  snapDb.init();
  planning.load();
  planningUpdated.load();
  planningUpdated.loadExtras();
  planningUpdated.loadRealocacao();

  // Try MySQL — but don't crash the app if it's not available (admin will be disabled)
  try {
    await mysqlDb.init();
  } catch (e) {
    console.warn("[DB] MySQL not available - /admin disabled:", e.message);
  }

  console.log("Fetching initial data from Google Sheets...");
  await refreshCache();

  // Save initial snapshot for today if none exists
  const today = snapDb.todayStr();
  if (!snapDb.hasSnapshot(today) && cache.data.length > 0) {
    snapDb.saveSnapshot(today, cache.data);
  }

  // Background data refresh every 5 minutes
  setInterval(refreshCache, 5 * 60 * 1000);

  // Snapshot scheduler: check every minute, save at 22:00
  let lastSnapshotDate = "";
  setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dateStr = snapDb.todayStr();

    if (hour === 22 && minute === 0 && lastSnapshotDate !== dateStr) {
      if (cache.data.length > 0) {
        snapDb.saveSnapshot(dateStr, cache.data);
        lastSnapshotDate = dateStr;
      }
    }
  }, 60 * 1000);

  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}

main();
