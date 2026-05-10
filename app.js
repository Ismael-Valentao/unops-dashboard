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

// Saco hermético: 0.145 kg cada. Constante única no app — mudar aqui propaga
// a todas as conversões kg ↔ unidades. Usado pelo parseCSV (Sheet) e
// /api/logistics/compare. lib/distribution-bootstrap.js e db/distribution-repo.js
// têm a sua própria constante (mesmo valor) por estarem em módulos separados.
const SACO_KG_PER_UNIT = 0.145;

// ── Fetch CSV from Google Sheets ──────────────────────────────
function fetchCSV(url) {
  return new Promise((resolve, reject) => {
    const get = (u) => {
      // Headers para impedir caching por intermediários/CDN.
      const opts = {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "Expires": "0",
        },
      };
      https.get(u, opts, (res) => {
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

      // Convert Hermetic Bags from units (un) to kg (0.145 kg/un) so everything
      // aggregates consistently in kg. Keep the original count for reference.
      const lowerProd = String(row.product || "").toLowerCase();
      if (lowerProd.includes("hermetic") || lowerProd.includes("saco")) {
        row.delivered_qty_units = row.delivered_qty;
        row.delivered_qty = +(row.delivered_qty * SACO_KG_PER_UNIT).toFixed(3);
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
    // Cache-bust: append a timestamp query-param para impedir o CDN de Google
    // (ou intermediários) de servir uma cópia em cache. O Sheets ignora params
    // desconhecidos no /export, mas o URL único força uma chave de cache nova.
    const url = SHEET_CSV_URL + (SHEET_CSV_URL.includes("?") ? "&" : "?") + "t=" + Date.now();
    const text = await fetchCSV(url);
    cache.data = parseCSV(text);
    enrichWithADSN(cache.data);
    cache.lastUpdated = new Date().toISOString();
    console.log(`[OK] Loaded ${cache.data.length} rows at ${cache.lastUpdated}`);

    // SIDE-EFFECT: persiste rows novas/alteradas em delivery_audit para
    // termos histórico imutável mesmo se o sheet perder dados depois.
    // Falhas aqui não bloqueiam o pipeline — só logam warning.
    try {
      const { captureRows } = require("./lib/audit-capture");
      const stats = await captureRows(cache.data);
      if (stats.inserted > 0 || stats.updated_status > 0) {
        console.log(`[AUDIT] +${stats.inserted} novas, ${stats.updated_status} status mudou, ${stats.seen} já vistas (${stats.total} total)${stats.errors.length ? ", " + stats.errors.length + " erros" : ""}`);
      }
    } catch (e) {
      console.warn("[AUDIT] capture failed (non-fatal):", e.message);
    }
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

// Ranking público de batedores (transparência: pagamento por entregas submetidas)
app.get("/batedores", (_req, res) => {
  res.sendFile(path.join(__dirname, "templates", "batedores.html"));
});

// API pública (sem auth) — fonte de dados do ranking de batedores
// Calcula pagamento estimado: ~100 MZN por tonelada submetida
const { Audit: PublicAudit } = require("./db/audit-repo");
const PAYMENT_MZN_PER_TON = 100;

// Helper partilhado: parse from/to/days e devolve { data, periodLabel } pronto para exports
function parseBatedoresQuery(q) {
  const arg = (q.from && q.to) ? { from: q.from, to: q.to } : { days: Number(q.days) || 1 };
  return arg;
}
async function buildBatedoresPayload(arg) {
  const data = await PublicAudit.byDayPerSubmitter(arg);
  const submitters = (data.submitters || []).map((s, i) => ({
    rank: i + 1,
    email: s.email,
    total_kg: Math.round(s.total_kg || 0),
    total_tons: +((s.total_kg || 0) / 1000).toFixed(2),
    total_submissions: s.total || 0,
    kg_verified: Math.round(s.kg_verified || 0),
    kg_pending:  Math.round(s.kg_pending  || 0),
    kg_rejected: Math.round(s.kg_rejected || 0),
    payment_mzn: Math.round(((s.total_kg || 0) / 1000) * PAYMENT_MZN_PER_TON),
    by_day: s.by_day || {},
  }));
  const totalKg       = submitters.reduce((acc, s) => acc + s.total_kg, 0);
  const totalVerified = submitters.reduce((acc, s) => acc + s.kg_verified, 0);
  const totalPending  = submitters.reduce((acc, s) => acc + s.kg_pending, 0);
  const totalRejected = submitters.reduce((acc, s) => acc + s.kg_rejected, 0);
  const totalSubs     = submitters.reduce((acc, s) => acc + s.total_submissions, 0);
  const totalTons = +(totalKg / 1000).toFixed(2);
  return {
    days: data.days,
    day_totals: data.day_totals,
    submitters,
    summary: {
      total_batedores: submitters.length,
      total_submissions: totalSubs,
      total_kg: totalKg,
      total_tons: totalTons,
      total_kg_verified: totalVerified,
      total_kg_pending:  totalPending,
      total_kg_rejected: totalRejected,
      total_payment_mzn: Math.round(totalTons * PAYMENT_MZN_PER_TON),
      period_days: data.days.length,
      from: data.days[0],
      to:   data.days[data.days.length - 1],
      rate_mzn_per_ton: PAYMENT_MZN_PER_TON,
    },
  };
}

app.get("/api/public/batedores", async (req, res) => {
  try {
    const arg = parseBatedoresQuery(req.query);
    res.json(await buildBatedoresPayload(arg));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Excel export público — 3 sheets: Resumo / Ranking / Por Dia
app.get("/api/public/batedores/export.xlsx", async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const arg = parseBatedoresQuery(req.query);
    const payload = await buildBatedoresPayload(arg);
    const s = payload.summary;

    const wb = new ExcelJS.Workbook();
    wb.creator = "AQI Distribution";
    wb.created = new Date();

    const C_HEADER  = "FF0F4C75";
    const C_SUB     = "FF1E6BA8";
    const C_GREEN   = "FF15803D";
    const C_AMBER   = "FFB45309";
    const C_RED     = "FFB91C1C";
    const C_TOTAL   = "FFE2E8F0";
    const C_WHITE   = "FFFFFFFF";

    const fmtNum = (n) => Math.round((Number(n) || 0) * 100) / 100;

    // ── Sheet 1: Resumo ───────────────────────────────────
    const sumWs = wb.addWorksheet("Resumo");
    sumWs.columns = [{ width: 32 }, { width: 22 }];
    sumWs.getCell("A1").value = "RANKING DE BATEDORES";
    sumWs.getCell("A1").font = { bold: true, size: 14, color: { argb: C_HEADER } };
    sumWs.mergeCells("A1:B1");

    let r = 3;
    sumWs.getCell(`A${r}`).value = "Período do relatório";
    sumWs.getCell(`A${r}`).font = { bold: true, size: 11 };
    sumWs.mergeCells(`A${r}:B${r}`); r++;
    sumWs.getCell(`A${r}`).value = "De";  sumWs.getCell(`B${r}`).value = s.from; r++;
    sumWs.getCell(`A${r}`).value = "Até"; sumWs.getCell(`B${r}`).value = s.to; r++;
    sumWs.getCell(`A${r}`).value = "Dias do período"; sumWs.getCell(`B${r}`).value = s.period_days; r++;
    sumWs.getCell(`A${r}`).value = "Gerado em"; sumWs.getCell(`B${r}`).value = new Date().toLocaleString("pt-MZ"); r++;
    r++;

    sumWs.getCell(`A${r}`).value = "Resultados agregados";
    sumWs.getCell(`A${r}`).font = { bold: true, size: 11 };
    sumWs.mergeCells(`A${r}:B${r}`); r++;
    const rows = [
      ["Batedores activos", s.total_batedores],
      ["Total submissões", s.total_submissions],
      ["Total entregue (kg)", fmtNum(s.total_kg)],
      ["Total entregue (toneladas)", fmtNum(s.total_tons)],
      ["Verificado (kg)", fmtNum(s.total_kg_verified)],
      ["Pendente (kg)",   fmtNum(s.total_kg_pending)],
      ["Rejeitado (kg)",  fmtNum(s.total_kg_rejected)],
      ["Pagamento estimado (MZN)", s.total_payment_mzn],
      ["Taxa (MZN por tonelada)", s.rate_mzn_per_ton],
    ];
    for (const [k, v] of rows) {
      sumWs.getCell(`A${r}`).value = k;
      sumWs.getCell(`B${r}`).value = v;
      sumWs.getCell(`B${r}`).numFmt = typeof v === "number" ? "#,##0.00" : "@";
      r++;
    }

    // ── Sheet 2: Ranking ──────────────────────────────────
    const rkWs = wb.addWorksheet("Ranking", { views: [{ state: "frozen", ySplit: 1 }] });
    const rkHead = ["#", "Batedor (email)", "Submissões", "Total kg", "Toneladas", "Pagamento MZN", "Verificado kg", "Pendente kg", "Rejeitado kg"];
    rkHead.forEach((h, i) => {
      const c = rkWs.getCell(1, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: C_WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_HEADER } };
      c.alignment = { vertical: "middle", horizontal: "center" };
    });
    rkWs.getColumn(1).width = 5;
    rkWs.getColumn(2).width = 36;
    for (let i = 3; i <= 9; i++) rkWs.getColumn(i).width = 14;

    payload.submitters.forEach((sub, i) => {
      const row = i + 2;
      rkWs.getCell(row, 1).value = sub.rank;
      rkWs.getCell(row, 2).value = sub.email;
      rkWs.getCell(row, 3).value = sub.total_submissions;
      rkWs.getCell(row, 4).value = sub.total_kg;
      rkWs.getCell(row, 5).value = sub.total_tons;
      rkWs.getCell(row, 6).value = sub.payment_mzn;
      rkWs.getCell(row, 7).value = sub.kg_verified;
      rkWs.getCell(row, 8).value = sub.kg_pending;
      rkWs.getCell(row, 9).value = sub.kg_rejected;
      // formatos numéricos
      rkWs.getCell(row, 4).numFmt = "#,##0";
      rkWs.getCell(row, 5).numFmt = "#,##0.00";
      rkWs.getCell(row, 6).numFmt = "#,##0";
      rkWs.getCell(row, 7).numFmt = "#,##0";
      rkWs.getCell(row, 8).numFmt = "#,##0";
      rkWs.getCell(row, 9).numFmt = "#,##0";
      rkWs.getCell(row, 7).font = { color: { argb: C_GREEN } };
      rkWs.getCell(row, 8).font = { color: { argb: C_AMBER } };
      rkWs.getCell(row, 9).font = { color: { argb: C_RED } };
      // medalhas no rank
      if (sub.rank === 1) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE08B" } };
      if (sub.rank === 2) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      if (sub.rank === 3) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCD7BE" } };
      if (i % 2 === 0) {
        for (let c = 1; c <= 9; c++) {
          const cell = rkWs.getCell(row, c);
          if (!cell.fill || !cell.fill.fgColor) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
          }
        }
      }
    });
    // Totais
    if (payload.submitters.length) {
      const totRow = payload.submitters.length + 2;
      rkWs.getCell(totRow, 1).value = "";
      rkWs.getCell(totRow, 2).value = "TOTAL";
      rkWs.getCell(totRow, 3).value = s.total_submissions;
      rkWs.getCell(totRow, 4).value = s.total_kg;
      rkWs.getCell(totRow, 5).value = s.total_tons;
      rkWs.getCell(totRow, 6).value = s.total_payment_mzn;
      rkWs.getCell(totRow, 7).value = s.total_kg_verified;
      rkWs.getCell(totRow, 8).value = s.total_kg_pending;
      rkWs.getCell(totRow, 9).value = s.total_kg_rejected;
      for (let c = 1; c <= 9; c++) {
        rkWs.getCell(totRow, c).font = { bold: true };
        rkWs.getCell(totRow, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
      }
      rkWs.getCell(totRow, 4).numFmt = "#,##0";
      rkWs.getCell(totRow, 5).numFmt = "#,##0.00";
      rkWs.getCell(totRow, 6).numFmt = "#,##0";
      rkWs.getCell(totRow, 7).numFmt = "#,##0";
      rkWs.getCell(totRow, 8).numFmt = "#,##0";
      rkWs.getCell(totRow, 9).numFmt = "#,##0";
    }
    rkWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: payload.submitters.length + 1, column: 9 } };

    // ── Sheet 3: Por Dia (matriz batedor × dia) ───────────
    const ddWs = wb.addWorksheet("Por Dia", { views: [{ state: "frozen", ySplit: 1, xSplit: 2 }] });
    const days = payload.days;
    const ddHead = ["#", "Batedor", ...days, "Total kg"];
    ddHead.forEach((h, i) => {
      const c = ddWs.getCell(1, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: C_WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_HEADER } };
      c.alignment = { vertical: "middle", horizontal: "center" };
    });
    ddWs.getColumn(1).width = 5;
    ddWs.getColumn(2).width = 36;
    for (let i = 3; i <= days.length + 2; i++) ddWs.getColumn(i).width = 11;
    ddWs.getColumn(days.length + 3).width = 13;

    payload.submitters.forEach((sub, i) => {
      const row = i + 2;
      ddWs.getCell(row, 1).value = sub.rank;
      ddWs.getCell(row, 2).value = sub.email;
      // calcula max para heatmap por linha
      const vals = days.map((d) => Math.round((sub.by_day[d]?.kg) || 0));
      const max = Math.max(...vals, 1);
      vals.forEach((v, j) => {
        const cell = ddWs.getCell(row, j + 3);
        cell.value = v || (v === 0 ? "" : "");
        cell.numFmt = "#,##0";
        if (v > 0) {
          const intensity = Math.min(1, v / max);
          const rr = Math.round(255 - intensity * 100);
          const gg = Math.round(255 - intensity * 40);
          const bb = Math.round(255 - intensity * 20);
          cell.fill = {
            type: "pattern", pattern: "solid",
            fgColor: { argb: "FF" + [rr, gg, bb].map((x) => x.toString(16).padStart(2, "0")).join("") },
          };
        }
      });
      const totalCell = ddWs.getCell(row, days.length + 3);
      totalCell.value = sub.total_kg;
      totalCell.numFmt = "#,##0";
      totalCell.font = { bold: true };
    });
    // Totais por dia
    const dayTotalsRow = payload.submitters.length + 2;
    ddWs.getCell(dayTotalsRow, 1).value = "";
    ddWs.getCell(dayTotalsRow, 2).value = "TOTAL DIÁRIO";
    days.forEach((d, j) => {
      const t = payload.day_totals[d];
      ddWs.getCell(dayTotalsRow, j + 3).value = Math.round(t?.kg || 0);
      ddWs.getCell(dayTotalsRow, j + 3).numFmt = "#,##0";
    });
    ddWs.getCell(dayTotalsRow, days.length + 3).value = s.total_kg;
    ddWs.getCell(dayTotalsRow, days.length + 3).numFmt = "#,##0";
    for (let c = 1; c <= days.length + 3; c++) {
      ddWs.getCell(dayTotalsRow, c).font = { bold: true };
      ddWs.getCell(dayTotalsRow, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
    }

    const fname = `ranking-batedores_${s.from}_${s.to}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint de diagnóstico — verifica se a tela /batedores tem dados em prod.
// Devolve: existência da tabela delivery_audit, totais, contagens por janela
// temporal, timezones (Node vs MySQL), e amostra das últimas 3 linhas.
// Sem auth (público) para o user poder simplesmente abrir o URL no browser.
app.get("/api/public/batedores/diagnostic", async (_req, res) => {
  const out = {
    server: {
      now_node: new Date().toISOString(),
      now_local: new Date().toLocaleString("pt-MZ"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      cache_rows: cache.data?.length || 0,
      cache_last_updated: cache.lastUpdated || null,
    },
  };
  const { query, queryOne } = require("./db/mysql");
  try {
    const [{ db_now, db_curdate, db_tz }] = await query(
      "SELECT NOW() AS db_now, CURDATE() AS db_curdate, @@session.time_zone AS db_tz"
    );
    out.db = { now: db_now, curdate: db_curdate, time_zone: db_tz };
  } catch (e) {
    out.db = { error: "Failed to query DB time: " + e.message };
    return res.json(out);
  }

  // Tabela existe?
  try {
    const t = await queryOne(
      "SELECT COUNT(*) AS exists_table FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'delivery_audit'"
    );
    out.table_exists = Number(t?.exists_table) > 0;
  } catch (e) {
    out.table_exists_error = e.message;
  }

  if (!out.table_exists) {
    out.problem = "TABELA_NAO_EXISTE";
    out.fix = "Reinicia o serviço Node em prod — as migrações idempotentes em db/mysql.js criam delivery_audit no arranque.";
    return res.json(out);
  }

  // Contagens
  try {
    out.counts = {
      total: Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit"))?.n || 0),
      last_24h: Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)"))?.n || 0),
      last_7d:  Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)"))?.n || 0),
      today_by_detected_date:    Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_date = CURDATE()"))?.n || 0),
      today_by_delivery_date:    Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE delivery_date_iso = CURDATE()"))?.n || 0),
      today_by_coalesce:         Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE COALESCE(delivery_date_iso, detected_date) = CURDATE()"))?.n || 0),
      with_delivered_qty: Number((await queryOne("SELECT COUNT(*) AS n FROM delivery_audit WHERE delivered_qty > 0"))?.n || 0),
      distinct_submitters_total: Number((await queryOne("SELECT COUNT(DISTINCT submitted_by) AS n FROM delivery_audit WHERE submitted_by IS NOT NULL AND submitted_by <> ''"))?.n || 0),
    };
  } catch (e) {
    out.counts_error = e.message;
  }

  // Amostra das últimas 3 linhas
  try {
    out.last_3_rows = await query(
      `SELECT id, submitted_by, beneficiary_name, product, delivered_qty,
              delivery_date_iso, detected_date, detected_at, last_seen_at,
              verification_status
       FROM delivery_audit
       ORDER BY detected_at DESC
       LIMIT 3`
    );
  } catch (e) {
    out.last_3_rows_error = e.message;
  }

  // Range global de datas
  try {
    const [r] = await query(
      "SELECT MIN(detected_at) AS first_seen, MAX(detected_at) AS last_seen, MIN(delivery_date_iso) AS min_dd, MAX(delivery_date_iso) AS max_dd FROM delivery_audit"
    );
    out.date_ranges = r;
  } catch (e) {
    out.date_ranges_error = e.message;
  }

  // Diagnóstico final automático
  if (out.counts) {
    if (out.counts.total === 0) {
      out.problem = "TABELA_VAZIA";
      out.fix = "A tabela existe mas nunca capturou linhas. Verifica se refreshCache está a correr e se cache.data tem rows. Tenta GET /cron para forçar refresh.";
    } else if (out.counts.today_by_coalesce === 0 && out.counts.last_24h > 0) {
      out.problem = "DESALINHAMENTO_TIMEZONE";
      out.fix = "Há rows recentes mas nenhuma em 'hoje'. Provável diferença entre TZ do Node e do MySQL (compara server.timezone vs db.time_zone acima).";
    } else {
      out.problem = "OK";
      out.fix = "Dados aparentemente normais. Se /batedores ainda não mostra nada, confirma que o frontend está a chamar /api/public/batedores e que NODE_ENV/JS cache estão limpos.";
    }
  }

  res.json(out);
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
      // Sacos herméticos (SUSSACO): Volumes é o count real. Peso no Excel é
      // inconsistente (uns rows têm count, outros têm kg). Para sacos usar
      // sempre Volumes; outros produtos usam Peso (kg).
      const skuStr = String(s["SKU"] || "").trim();
      const isSacoSku = skuStr === "SUSSACO";
      const peso = isSacoSku ? (Number(s["Volumes"]) || 0) : (Number(s["Peso"]) || 0);

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
