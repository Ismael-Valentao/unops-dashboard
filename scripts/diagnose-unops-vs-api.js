/**
 * Diagnóstico: compara totais TRANSITO+FINALIZADO da API ADICIONAL
 * vs total lançado no Sheet UNOPS, para um período específico.
 *
 * Mostra:
 *   - Total API (TRA+FIN)
 *   - Total Sheet UNOPS
 *   - GTUs em ambos (match)
 *   - GTUs só no Sheet (UNOPS sem ADICIONAL — não devia acontecer!)
 *   - GTUs só na API (entregue mas batedor não submeteu)
 *   - Quantidade mismatch (mesma GTU com kg diferentes)
 *
 * USAGE: node scripts/diagnose-unops-vs-api.js [fromDate] [toDate]
 *        node scripts/diagnose-unops-vs-api.js 2026-03-31 2026-05-20
 */
require("dotenv").config();
const https = require("https");
const { parse } = require("csv-parse/sync");
const api = require("../lib/adicional-api");
const { normGtu } = require("../lib/adicional-match");

const SHEET_URL =
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
const SACO_KG = 0.145;

function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const get = (u) =>
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
          return get(res.headers.location);
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        res.on("error", reject);
      }).on("error", reject);
    get(url);
  });
}

(async () => {
  const fromDate = process.argv[2] || "2026-03-31";
  const toDate   = process.argv[3] || "2026-05-20";
  console.log(`\n=== Reconcile API vs UNOPS Sheet — ${fromDate} a ${toDate} ===\n`);

  // 1. API
  const apiR = await api.listProjectsChunked({ fromDate, toDate, chunkDays: 7, noCache: true });
  const apiTraFin = apiR.rows.filter((r) =>
    ["TRANSITO", "FINALIZADO"].includes(String(r.StatusName || "").toUpperCase())
  );
  const apiByGtu = new Map();
  let apiKg = 0;
  for (const r of apiTraFin) {
    const g = normGtu(r.ClientBarCode);
    const w = Number(r.Weight) || 0;
    apiKg += w;
    if (g) apiByGtu.set(g, (apiByGtu.get(g) || 0) + w);
  }
  console.log("API ADICIONAL (TRA+FIN, filtro GTU98/GTS98):");
  console.log("  rows:                 " + apiTraFin.length);
  console.log("  GTUs distintas:       " + apiByGtu.size);
  console.log("  total kg:             " + Math.round(apiKg).toLocaleString() +
    "  (" + (apiKg / 1000).toFixed(1) + " t)");

  // 2. UNOPS Sheet — fetch + filtro por delivery_date
  console.log("\nA carregar UNOPS Sheet…");
  const text = await fetchCSV(SHEET_URL);
  const records = parse(text, { columns: false, skip_empty_lines: true, relax_column_count: true }).slice(1);
  const sheet = [];
  for (const cells of records) {
    const o = {};
    COLUMN_KEYS.forEach((k, i) => { o[k] = (cells[i] || "").trim(); });
    if (!o.delivery_id) continue;
    o.delivered_qty = parseFloat(o.delivered_qty) || 0;
    const lp = (o.product || "").toLowerCase();
    if (lp.includes("hermetic") || lp.includes("saco")) {
      o.delivered_qty = +(o.delivered_qty * SACO_KG).toFixed(3);
    }
    const raw = String(o.delivery_note_number || "").replace(/\\/g, "/").replace(/^GTUS/i, "GTS");
    o.gtu = normGtu(raw);
    const m = (o.delivery_date || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    o.iso_date = m ? `${m[3]}-${m[2]}-${m[1]}` : "";
    if (o.gtu && o.iso_date >= fromDate && o.iso_date <= toDate) sheet.push(o);
  }

  const sheetByGtu = new Map();
  let sheetKg = 0;
  for (const r of sheet) {
    sheetKg += r.delivered_qty;
    sheetByGtu.set(r.gtu, (sheetByGtu.get(r.gtu) || 0) + r.delivered_qty);
  }
  console.log("UNOPS Sheet (filtro por delivery_date no período):");
  console.log("  rows:                 " + sheet.length);
  console.log("  GTUs distintas:       " + sheetByGtu.size);
  console.log("  total kg:             " + Math.round(sheetKg).toLocaleString() +
    "  (" + (sheetKg / 1000).toFixed(1) + " t)");
  console.log("\n  Δ Sheet − API:        " + Math.round(sheetKg - apiKg).toLocaleString() + " kg");

  // 3. Reconcile por GTU
  let bothKg = 0, sheetOnlyKg = 0, apiOnlyKg = 0;
  let bothN = 0, sheetOnlyN = 0, apiOnlyN = 0;
  const sheetOnly = [], qtyMismatch = [];
  for (const [gtu, kg] of sheetByGtu) {
    if (apiByGtu.has(gtu)) {
      bothN++; bothKg += kg;
      const diff = kg - apiByGtu.get(gtu);
      if (Math.abs(diff) > 1) qtyMismatch.push({ gtu, sheet: kg, api: apiByGtu.get(gtu), diff });
    } else {
      sheetOnlyN++; sheetOnlyKg += kg;
      sheetOnly.push({ gtu, kg });
    }
  }
  for (const [gtu, kg] of apiByGtu) {
    if (!sheetByGtu.has(gtu)) { apiOnlyN++; apiOnlyKg += kg; }
  }

  console.log("\n=== Buckets ===");
  console.log("GTUs em AMBOS:           " + String(bothN).padStart(5) +
    " GTUs · sheet_kg=" + Math.round(bothKg).toLocaleString().padStart(11) + " kg");
  console.log("GTUs SO no Sheet:        " + String(sheetOnlyN).padStart(5) +
    " GTUs · kg=     " + Math.round(sheetOnlyKg).toLocaleString().padStart(11) +
    " kg  <-- UNOPS submetido SEM guia ADICIONAL no período");
  console.log("GTUs SO na API:          " + String(apiOnlyN).padStart(5) +
    " GTUs · kg=     " + Math.round(apiOnlyKg).toLocaleString().padStart(11) +
    " kg  (entregue, batedor ainda não submeteu)");

  if (qtyMismatch.length) {
    console.log("\nQty mismatch (mesma GTU, kg diferentes): " + qtyMismatch.length + " casos");
    let totalDiff = 0;
    for (const x of qtyMismatch) totalDiff += x.diff;
    console.log("  Δ acumulado destes mismatches: " + Math.round(totalDiff).toLocaleString() + " kg");
    console.log("  Top 5 mismatches por |diff|:");
    qtyMismatch.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff)).slice(0, 5).forEach((x) =>
      console.log("    " + x.gtu + "  sheet=" + Math.round(x.sheet).toLocaleString() +
        "  api=" + Math.round(x.api).toLocaleString() + "  diff=" + Math.round(x.diff).toLocaleString())
    );
  }
  if (sheetOnly.length) {
    console.log("\nTop 10 GTUs SO no Sheet (suspeitos):");
    sheetOnly.sort((a, b) => b.kg - a.kg).slice(0, 10).forEach((x) =>
      console.log("  " + x.gtu + "  " + Math.round(x.kg).toLocaleString() + " kg")
    );
  }

  console.log("\n=== Resumo da diferença ===");
  console.log("  Sheet UNOPS total:    " + Math.round(sheetKg).toLocaleString() + " kg");
  console.log("  API ADICIONAL total:  " + Math.round(apiKg).toLocaleString() + " kg");
  console.log("  Δ:                    " + Math.round(sheetKg - apiKg).toLocaleString() + " kg");
  console.log();
  console.log("  ↳ Sheet-only:         " + Math.round(sheetOnlyKg).toLocaleString() + " kg  (UNOPS sem ADICIONAL)");
  if (qtyMismatch.length) {
    let totalDiff = 0;
    for (const x of qtyMismatch) totalDiff += x.diff;
    console.log("  ↳ Qty mismatch (Δ):   " + Math.round(totalDiff).toLocaleString() + " kg");
  }
  console.log();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
