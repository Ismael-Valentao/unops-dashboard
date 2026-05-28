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

// Usa gid=0 (aba original "Delivery" com linhas detalhadas) em vez de
// sheet=Delivery, porque a UNOPS criou recentemente uma 2ª aba também
// chamada "Delivery" com um pivot semanal de invoicing — e o Sheets
// estava a devolver essa em vez das submissões individuais. gid=0 é
// estável e aponta sempre para a aba criada primeiro.
const SHEET_CSV_URL =
  "https://docs.google.com/spreadsheets/d/" +
  "1mgPMSyWn2IoxIXW7vkCiOCOMBOCWTVjMHfZKkFwjvWM" +
  "/export?format=csv&gid=0";

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
  if (q.noCache === "1" || q.fresh === "1") arg.noCache = true;
  return arg;
}
async function buildBatedoresPayload(arg) {
  const data = await PublicAudit.byDayPerSubmitter(arg);
  const submitters = (data.submitters || []).map((s, i) => ({
    rank: i + 1,
    email: s.email,
    name: s.name || null,         // ← do Excel Batedores.xlsx (null se nao encontrado)
    contact: s.contact || null,
    contact_alt: s.contact_alt || null,
    total_kg: Math.round(s.total_kg || 0),
    total_tons: +((s.total_kg || 0) / 1000).toFixed(2),
    total_submissions: s.total || 0,
    kg_verified: Math.round(s.kg_verified || 0),
    kg_pending:  Math.round(s.kg_pending  || 0),
    kg_rejected: Math.round(s.kg_rejected || 0),
    payment_mzn: Math.round(((s.total_kg || 0) / 1000) * PAYMENT_MZN_PER_TON),
    by_day: s.by_day || {},
    trucks: [],   // populado a seguir via match GTU → VehiclePlate da API ADICIONAL
  }));

  // ── Enriquecimento: matrículas dos camiões por batedor ─────────
  // Para cada submitter, agrega os camiões com que descarregou no UNOPS.
  // Match: GTU da delivery_audit ↔ ClientBarCode da ADICIONAL API.
  let payload_cache_info = { from_cache: false, age_seconds: 0 };
  try {
    const { query } = require("./db/mysql");
    const { normGtu } = require("./lib/adicional-match");
    const { normPlate } = require("./lib/adicional-viagens");
    const onedriveMapa = require("./lib/onedrive-mapa");

    // Período: usa os dias da resposta para definir a janela de fetch
    const fromIso = data.days[0];
    const toIso   = data.days[data.days.length - 1];

    // ── Janela API ADICIONAL ───────────────────────────────────
    //
    // A API ADICIONAL filtra por CreateDate (quando a guia foi criada).
    // O batedor pode submeter HOJE um GTU criado há meses. Por bench
    // empírico (scripts/_perf-bench.js): GTUs dos últimos 12 meses
    // estão concentrados nos últimos 90 dias — janela 90d devolve
    // exactamente as mesmas rows que 365d mas com 16s a menos.
    //
    // Configurável via env BATEDORES_API_LOOKBACK_DAYS (default 90).
    // Se aparecer um GTU antigo (>90d) não-mapeado, o utilizador pode
    // clicar ↻ Fresh — também não muda nada já que está fora do TTL.
    // Solução real: aumentar BATEDORES_API_LOOKBACK_DAYS no .env.
    //
    // ⚠ TODATE +1: estendemos em 1 dia para apanhar GTUs criadas HOJE
    // depois da hora do último cache. A API trata toDate como exclusive
    // midnight; mesmo com workaround em listProjects._addDay, alargar
    // aqui dá margem para timezone/clock skew.
    const LOOKBACK_DAYS = Number(process.env.BATEDORES_API_LOOKBACK_DAYS) || 90;
    const apiFromDt = new Date(toIso + "T00:00:00");
    apiFromDt.setDate(apiFromDt.getDate() - LOOKBACK_DAYS);
    const apiToDt = new Date(toIso + "T00:00:00");
    apiToDt.setDate(apiToDt.getDate() + 1);
    const ymdLocal = (d) => d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");
    const apiFromIso = ymdLocal(apiFromDt);
    const apiToIso   = ymdLocal(apiToDt);

    // ── Fetches paralelos ──────────────────────────────────────
    //
    // DB, API ADICIONAL e OneDrive MAPA são independentes. Antes
    // estavam sequenciais (DB → API → OneDrive ≈ 33s no cold).
    // Promise.all corre em paralelo → tempo total ≈ max(API) ≈ 12s.
    //
    // Cada um falha-suavemente:
    //   - DB falha → throw (não há fallback útil)
    //   - API falha → throw (igual)
    //   - OneDrive falha → mapaResult=null, items ficam sem CAM
    const auditQ = query(
      `SELECT gtu, adsn, submitted_by AS email,
              delivered_qty AS kg, beneficiary_name,
              delivery_date_iso
       FROM delivery_audit
       WHERE submitted_by IS NOT NULL AND submitted_by <> ''
         AND delivery_date_iso BETWEEN ? AND ?
         AND deleted_at IS NULL
         AND gtu IS NOT NULL AND gtu <> ''`,
      [fromIso, toIso]
    );
    const apiQ = adicionalApi.listProjectsChunked({
      fromDate: apiFromIso, toDate: apiToIso, chunkDays: 14,
      noCache: !!arg.noCache,
    });
    const mapaQ = onedriveMapa.getMapaSafe({ force: !!arg.noCache });
    const [auditRows, apiResult, mapaResult] = await Promise.all([auditQ, apiQ, mapaQ]);

    const adsnToCam = mapaResult ? mapaResult.adsnToCam : new Map();
    // mapaInfo é exposto via mapa_cache_info no return final (não usado aqui)

    // Lista plana de submissões da sheet — preserva a forma RAW da GTU
    // para que o lookupApi possa tentar match conservador (raw primeiro).
    const sheetSubmissions = [];
    for (const r of auditRows) {
      if (!r.gtu) continue;
      sheetSubmissions.push({
        email: r.email,
        kg: Number(r.kg) || 0,
        beneficiary: r.beneficiary_name || "",
        date: r.delivery_date_iso || "",
        gtu_raw: r.gtu,
      });
    }
    // Capture cache info so frontend can show "Cache 2min ago" or "Fresh"
    payload_cache_info = {
      from_cache: !!apiResult.from_cache,
      age_seconds: apiResult.cache_age_seconds || 0,
    };
    // Indexa a API por DUAS chaves para match conservador:
    //   - rawClean: uppercase + trim + sem espaços (preserva slashes/formatos)
    //   - norm:     resultado de normGtu (colapsa variantes equivalentes)
    // Lookup tenta primeiro rawClean (forma original da sheet), só faz
    // fallback para norm se o raw não encontrar — evita falsos positivos
    // por causa de normalização agressiva.
    const apiByRaw  = new Map();
    const apiByNorm = new Map();
    const cleanRaw = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, "");
    for (const r of apiResult.rows) {
      const rawClean = cleanRaw(r.ClientBarCode);
      if (!rawClean) continue;
      const plate = normPlate(r.VehiclePlate);
      if (!plate) continue;
      const data = { plate, adsn: r.ServiceCode || "" };
      apiByRaw.set(rawClean, data);
      apiByNorm.set(normGtu(r.ClientBarCode), data);
    }
    // Match conservador: raw primeiro, depois normalizado
    function lookupApi(sheetGtuRaw) {
      const rawClean = cleanRaw(sheetGtuRaw);
      if (apiByRaw.has(rawClean)) return apiByRaw.get(rawClean);
      const norm = normGtu(sheetGtuRaw);
      if (apiByNorm.has(norm)) return apiByNorm.get(norm);
      return null;
    }

    // 3. Para cada submitter, agregar por matrícula:
    //    { plate, kg, count, items: [{ extensionist, gtu, adsn, kg, date }] }
    //
    // ⚠ ADSN: usa SEMPRE o ServiceCode da API ADICIONAL (formato real
    // "ADSN11690000573400"). O campo delivery_audit.adsn está populado com
    // r.delivery_id (UUID interno do AppSheet tipo "85180c77") — não é
    // um ADSN real, NÃO USAR.
    const trucksByEmail = new Map();
    const unmatchedByEmail = new Map();  // submissões sem GTU na API
    for (const sub of sheetSubmissions) {
      const emailKey = String(sub.email || "").toLowerCase();
      const apiInfo = lookupApi(sub.gtu_raw);
      if (!apiInfo) {
        // GTU não encontrada na API — fica numa lista separada para
        // o utilizador ver a discrepância (em vez de desaparecer silenciosamente)
        if (!unmatchedByEmail.has(emailKey)) unmatchedByEmail.set(emailKey, []);
        unmatchedByEmail.get(emailKey).push({
          extensionist: sub.beneficiary,
          gtu: sub.gtu_raw,
          kg: Number(sub.kg.toFixed(2)),
          date: sub.date,
        });
        continue;
      }
      const plate = apiInfo.plate;
      // Lookup CAM-XX + destino no mapa OneDrive UNOPS (chave = ADSN)
      // Valor: { cam: "CAM-NN"|"INAUG", destino: "Chibuto"|null } ou null
      const adsnKey = String(apiInfo.adsn || "").trim().toUpperCase();
      const camInfo = adsnKey ? (adsnToCam.get(adsnKey) || null) : null;
      const cam     = camInfo ? camInfo.cam : null;
      const destino = camInfo ? camInfo.destino : null;
      if (!trucksByEmail.has(emailKey)) trucksByEmail.set(emailKey, new Map());
      const m = trucksByEmail.get(emailKey);
      const cur = m.get(plate) || {
        plate, kg: 0, count: 0, items: [],
        cams: new Set(),
        destinos: new Set(),
      };
      cur.kg    += sub.kg;
      cur.count += 1;
      if (cam) cur.cams.add(cam);
      if (destino) cur.destinos.add(destino);
      cur.items.push({
        extensionist: sub.beneficiary,
        gtu: sub.gtu_raw,
        adsn: apiInfo.adsn || "",   // sempre o ServiceCode real da API
        cam:     cam,                // CAM-XX se ADSN foi encontrado no MAPA UNOPS
        destino: destino,            // destino do camião (ex: "Chibuto")
        kg: Number(sub.kg.toFixed(2)),
        date: sub.date,
      });
      m.set(plate, cur);
    }
    // Anexa aos submitters (matrículas ordenadas por kg desc;
    // items dentro de cada matrícula ordenados por data desc)
    for (const sub of submitters) {
      const emailKey = String(sub.email || "").toLowerCase();
      const m = trucksByEmail.get(emailKey);
      if (m) {
        sub.trucks = [...m.values()]
          .map((t) => ({
            ...t,
            kg: Math.round(t.kg),
            // Lista única e ordenada de CAMs envolvidos nesta matrícula
            // (geralmente 1; pode ser >1 se o batedor descarregou items
            // que pertencem a viagens diferentes do mesmo camião físico)
            cams: [...t.cams].sort((a, b) => {
              const na = parseInt(String(a).replace(/\D/g, ""), 10);
              const nb = parseInt(String(b).replace(/\D/g, ""), 10);
              return na - nb;
            }),
            // Destinos únicos do(s) CAM(s) — geralmente 1
            destinos: [...t.destinos].sort(),
            items: t.items.sort((a, b) => String(b.date).localeCompare(String(a.date))),
          }))
          .sort((a, b) => b.kg - a.kg);
      }
      const um = unmatchedByEmail.get(emailKey);
      if (um && um.length) {
        sub.unmatched = um
          .map((u) => ({ ...u, kg: Math.round(u.kg) }))
          .sort((a, b) => String(b.date).localeCompare(String(a.date)));
        sub.unmatched_kg = sub.unmatched.reduce((s, u) => s + u.kg, 0);
      }
    }
  } catch (e) {
    console.warn("[batedores] enrich trucks failed (non-fatal):", e.message);
  }
  // Info do mapa OneDrive UNOPS (mostrado no UI: "Mapa CAM ↻ há X min")
  let mapa_cache_info = null;
  try {
    const onedriveMapa = require("./lib/onedrive-mapa");
    mapa_cache_info = onedriveMapa.getCacheInfo();
  } catch (_) { /* lib não carregada se ainda nunca foi pedido */ }
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
    cache: payload_cache_info,
    mapa: mapa_cache_info,
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
    const rkHead = ["#", "Nome", "Email", "Contacto", "Submissões", "Total kg", "Toneladas", "Pagamento MZN", "Verificado kg", "Pendente kg", "Rejeitado kg"];
    rkHead.forEach((h, i) => {
      const c = rkWs.getCell(1, i + 1);
      c.value = h;
      c.font = { bold: true, color: { argb: C_WHITE } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_HEADER } };
      c.alignment = { vertical: "middle", horizontal: "center" };
    });
    rkWs.getColumn(1).width = 5;   // #
    rkWs.getColumn(2).width = 30;  // Nome
    rkWs.getColumn(3).width = 36;  // Email
    rkWs.getColumn(4).width = 14;  // Contacto
    for (let i = 5; i <= 11; i++) rkWs.getColumn(i).width = 14;

    const NCOLS = rkHead.length; // 11
    payload.submitters.forEach((sub, i) => {
      const row = i + 2;
      rkWs.getCell(row, 1).value  = sub.rank;
      rkWs.getCell(row, 2).value  = sub.name || (sub.email || "").split("@")[0];
      rkWs.getCell(row, 3).value  = sub.email;
      rkWs.getCell(row, 4).value  = sub.contact || "";
      rkWs.getCell(row, 5).value  = sub.total_submissions;
      rkWs.getCell(row, 6).value  = sub.total_kg;
      rkWs.getCell(row, 7).value  = sub.total_tons;
      rkWs.getCell(row, 8).value  = sub.payment_mzn;
      rkWs.getCell(row, 9).value  = sub.kg_verified;
      rkWs.getCell(row, 10).value = sub.kg_pending;
      rkWs.getCell(row, 11).value = sub.kg_rejected;
      // formatos numéricos (cols 6-11)
      rkWs.getCell(row, 6).numFmt  = "#,##0";
      rkWs.getCell(row, 7).numFmt  = "#,##0.00";
      rkWs.getCell(row, 8).numFmt  = "#,##0";
      rkWs.getCell(row, 9).numFmt  = "#,##0";
      rkWs.getCell(row, 10).numFmt = "#,##0";
      rkWs.getCell(row, 11).numFmt = "#,##0";
      rkWs.getCell(row, 9).font  = { color: { argb: C_GREEN } };
      rkWs.getCell(row, 10).font = { color: { argb: C_AMBER } };
      rkWs.getCell(row, 11).font = { color: { argb: C_RED } };
      // Nome em negrito
      rkWs.getCell(row, 2).font = { bold: true };
      // medalhas no rank
      if (sub.rank === 1) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE08B" } };
      if (sub.rank === 2) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      if (sub.rank === 3) rkWs.getCell(row, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFCD7BE" } };
      if (i % 2 === 0) {
        for (let c = 1; c <= NCOLS; c++) {
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
      rkWs.getCell(totRow, 1).value  = "";
      rkWs.getCell(totRow, 2).value  = "TOTAL";
      rkWs.getCell(totRow, 3).value  = "";
      rkWs.getCell(totRow, 4).value  = "";
      rkWs.getCell(totRow, 5).value  = s.total_submissions;
      rkWs.getCell(totRow, 6).value  = s.total_kg;
      rkWs.getCell(totRow, 7).value  = s.total_tons;
      rkWs.getCell(totRow, 8).value  = s.total_payment_mzn;
      rkWs.getCell(totRow, 9).value  = s.total_kg_verified;
      rkWs.getCell(totRow, 10).value = s.total_kg_pending;
      rkWs.getCell(totRow, 11).value = s.total_kg_rejected;
      for (let c = 1; c <= NCOLS; c++) {
        rkWs.getCell(totRow, c).font = { bold: true };
        rkWs.getCell(totRow, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
      }
      rkWs.getCell(totRow, 6).numFmt  = "#,##0";
      rkWs.getCell(totRow, 7).numFmt  = "#,##0.00";
      rkWs.getCell(totRow, 8).numFmt  = "#,##0";
      rkWs.getCell(totRow, 9).numFmt  = "#,##0";
      rkWs.getCell(totRow, 10).numFmt = "#,##0";
      rkWs.getCell(totRow, 11).numFmt = "#,##0";
    }
    rkWs.autoFilter = { from: { row: 1, column: 1 }, to: { row: payload.submitters.length + 1, column: NCOLS } };

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
    ddWs.getColumn(2).width = 55;  // Nome <email> precisa de espaço
    for (let i = 3; i <= days.length + 2; i++) ddWs.getColumn(i).width = 11;
    ddWs.getColumn(days.length + 3).width = 13;

    payload.submitters.forEach((sub, i) => {
      const row = i + 2;
      ddWs.getCell(row, 1).value = sub.rank;
      // Nome + email para identificação clara
      const displayLabel = sub.name ? (sub.name + " <" + sub.email + ">") : sub.email;
      ddWs.getCell(row, 2).value = displayLabel;
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
// Sem auth (público) para o user poder simplesmente abrir o URL no browser.
// VERSÃO 2: defensivo a sério — cada query separada com try/catch independente,
// expõe destino DB (host/user/db) sem password, e dump completo dos erros.
app.get("/api/public/batedores/diagnostic", async (_req, res) => {
  // Helper: serializa erro de mysql2 expondo todos os campos úteis
  const dumpErr = (e) => ({
    message: e?.message || "(empty)",
    code: e?.code || null,
    errno: e?.errno || null,
    sqlState: e?.sqlState || null,
    sqlMessage: e?.sqlMessage || null,
    name: e?.name || null,
    stack: (e?.stack || "").split("\n").slice(0, 3).join(" | "),
  });
  // Helper: chama um SQL de forma segura, devolve { ok, value } | { ok:false, error }
  const safe = async (label, fn) => {
    try { return { ok: true, value: await fn() }; }
    catch (e) { return { ok: false, label, error: dumpErr(e) }; }
  };

  const out = {
    server: {
      now_node: new Date().toISOString(),
      now_local: new Date().toLocaleString("pt-MZ"),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      node_version: process.version,
      node_env: process.env.NODE_ENV || "(unset)",
      cache_rows: cache.data?.length || 0,
      cache_last_updated: cache.lastUpdated || null,
    },
    // Mostra para onde o Node está a tentar ligar (sem password)
    db_target: {
      host: process.env.DB_HOST || "(default localhost)",
      port: process.env.DB_PORT || "(default 3306)",
      user: process.env.DB_USER || "(default root)",
      database: process.env.DB_NAME || "(default aqi_operations)",
      password_set: process.env.DB_PASSWORD ? "yes" : "no/empty",
    },
    db: {},
    counts: {},
    errors: [],
  };

  const { query, queryOne } = require("./db/mysql");

  // 1. Conexão básica
  let r = await safe("ping", () => query("SELECT 1 AS ok"));
  out.db.ping = r.ok ? "ok" : "FAILED";
  if (!r.ok) out.errors.push(r);
  // Se nem o ping funciona, ainda tentamos os outros para mostrar pattern de erro
  if (!r.ok) {
    out.problem = "DB_UNREACHABLE";
    out.fix = "Não consegue ligar ao MySQL. Verifica .env (DB_HOST/PORT/USER/PASSWORD/NAME) e se o IP da app está na whitelist da Hostinger (cPanel → Bases de Dados Remotas).";
    return res.json(out);
  }

  // 2. Tempo do servidor MySQL
  r = await safe("now", () => queryOne("SELECT NOW() AS db_now"));
  if (r.ok) out.db.now = r.value?.db_now;
  else      out.errors.push(r);

  // 3. Data actual do MySQL
  r = await safe("curdate", () => queryOne("SELECT CURDATE() AS db_curdate"));
  if (r.ok) out.db.curdate = r.value?.db_curdate;
  else      out.errors.push(r);

  // 4. Timezone (algumas hosts shared bloqueiam @@session.time_zone — não é crítico)
  r = await safe("timezone", () => queryOne("SELECT @@session.time_zone AS tz, @@global.time_zone AS gtz"));
  if (r.ok) out.db.time_zone = r.value;
  else      out.db.time_zone_unavailable = r.error?.message || "blocked";

  // 5. Nome efectivo da base de dados (resolve aliases)
  r = await safe("dbname", () => queryOne("SELECT DATABASE() AS db, USER() AS \"user\""));
  if (r.ok) out.db.effective = r.value;
  else      out.errors.push(r);

  // 6. Tabela existe?
  r = await safe("table_exists", () => queryOne(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'delivery_audit'"
  ));
  out.table_exists = r.ok ? Number(r.value?.n) > 0 : null;
  if (!r.ok) out.errors.push(r);

  if (out.table_exists === false) {
    out.problem = "TABELA_NAO_EXISTE";
    out.fix = "A tabela delivery_audit não existe nesta DB. Reinicia o serviço Node em prod — as migrações idempotentes em db/mysql.js criam-na no arranque. Se não criar, verifica se o utilizador DB_USER tem permissão CREATE TABLE.";
    return res.json(out);
  }
  if (out.table_exists === null) {
    out.problem = "PERMISSAO_INFORMATION_SCHEMA";
    out.fix = "Não consegue ler information_schema. Tenta SELECT * FROM delivery_audit LIMIT 1 manualmente para confirmar se existe ou não.";
    // continua mesmo assim
  }

  // 7. Contagens (cada uma com try/catch — para nenhuma derrubar o resto)
  const queries = {
    total:                 "SELECT COUNT(*) AS n FROM delivery_audit",
    last_24h:              "SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)",
    last_7d:               "SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)",
    today_by_detected:     "SELECT COUNT(*) AS n FROM delivery_audit WHERE detected_date = CURDATE()",
    today_by_delivery:     "SELECT COUNT(*) AS n FROM delivery_audit WHERE delivery_date_iso = CURDATE()",
    today_by_coalesce:     "SELECT COUNT(*) AS n FROM delivery_audit WHERE COALESCE(delivery_date_iso, detected_date) = CURDATE()",
    with_qty:              "SELECT COUNT(*) AS n FROM delivery_audit WHERE delivered_qty > 0",
    distinct_submitters:   "SELECT COUNT(DISTINCT submitted_by) AS n FROM delivery_audit WHERE submitted_by IS NOT NULL AND submitted_by <> ''",
  };
  for (const [k, sql] of Object.entries(queries)) {
    const rr = await safe("count_" + k, () => queryOne(sql));
    out.counts[k] = rr.ok ? Number(rr.value?.n || 0) : null;
    if (!rr.ok) out.errors.push(rr);
  }

  // 8. Amostra das últimas 3 linhas
  r = await safe("last_3_rows", () => query(
    `SELECT id, submitted_by, beneficiary_name, product, delivered_qty,
            delivery_date_iso, detected_date, detected_at, last_seen_at,
            verification_status
     FROM delivery_audit
     ORDER BY detected_at DESC
     LIMIT 3`
  ));
  if (r.ok) out.last_3_rows = r.value;
  else      out.errors.push(r);

  // 9. Range global
  r = await safe("date_ranges", () => queryOne(
    "SELECT MIN(detected_at) AS first_seen, MAX(detected_at) AS last_seen, MIN(delivery_date_iso) AS min_dd, MAX(delivery_date_iso) AS max_dd FROM delivery_audit"
  ));
  if (r.ok) out.date_ranges = r.value;
  else      out.errors.push(r);

  // Auto-diagnóstico
  if (!out.problem) {
    if (out.counts.total === 0) {
      out.problem = "TABELA_VAZIA";
      out.fix = "Tabela existe mas vazia. Tenta GET /cron para forçar refresh+capture, depois recarrega este diagnóstico. Se continuar vazia, verifica logs por '[AUDIT] capture failed'.";
    } else if (out.counts.today_by_coalesce === 0 && out.counts.last_24h > 0) {
      out.problem = "DESALINHAMENTO_TIMEZONE";
      out.fix = "Há rows nas últimas 24h mas nenhuma em 'hoje'. Provável diferença Node TZ ('" + out.server.timezone + "') vs MySQL TZ. Adiciona TZ='Africa/Maputo' ao .env do Node ou força datas absolutas no /batedores.";
    } else {
      out.problem = "OK";
      out.fix = "Dados normais. Se /batedores não mostra, confirma que o browser não tem cache JS antigo (Ctrl+Shift+R).";
    }
  }
  res.json(out);
});

app.get("/api/data", (_req, res) => {
  res.json({ rows: cache.data, last_updated: cache.lastUpdated });
});

// ── Integração ADICIONAL DMS API ────────────────────────────
// Diagnostic + smoke test para a integração com a API de Servicos
// do sistema ADICIONAL (portaldms.adicional.co.mz). Permite ao
// operador testar credenciais e ver a lista de servicos disponivel
// antes de configurar sync automatico.
const adicionalApi = require("./lib/adicional-api");

// GET /api/admin/adicional/status — diagnostico sem chamar /api/projects
app.get("/api/admin/adicional/status", auth.requireRole("admin", "superadmin"), async (_req, res) => {
  try {
    const status = adicionalApi.tokenStatus();
    // Tenta obter token (refresh se preciso) — confirma que creds funcionam
    let tokenOk = false, tokenErr = null;
    try { await adicionalApi.getToken(); tokenOk = true; }
    catch (e) { tokenErr = e.message; }
    res.json({
      ...status,
      token_fetch_ok: tokenOk,
      token_fetch_error: tokenErr,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/entregas[?fromDate=&toDate=&chunkDays=&status=&province=&district=&supplier=&q=]
// Vista flat de TODAS as entregas: API + Sheet match + Batedores (nome/contacto).
// Filtros server-side. Pronto para mostrar numa tabela tipo Excel ou exportar.
app.get("/api/admin/adicional/entregas", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const entLib = require("./lib/adicional-entregas");
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
    const includeAll = req.query.includeAllStatuses === "1";

    // 1. API ADICIONAL (chunked)
    const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays });
    let apiRows = apiResult.rows;
    if (!includeAll) {
      const RELEVANT = new Set(["TRANSITO", "FINALIZADO"]);
      apiRows = apiRows.filter((r) => RELEVANT.has(String(r.StatusName || "").toUpperCase()));
    }

    // 2. Sheet (delivery_audit) — só rows não apagadas
    const { query } = require("./db/mysql");
    const sheetRows = await query(
      `SELECT gtu, beneficiary_name, delivered_qty, unit, product, submitted_by,
              delivery_date_iso, district, province
       FROM delivery_audit
       WHERE deleted_at IS NULL`
    );

    // 3. Batedores: mapa email → {name, contact}
    const batedoresMap = new Map();
    try {
      const bts = await query("SELECT email, name, contact, contact_alt FROM batedores");
      for (const b of bts) {
        batedoresMap.set(String(b.email || "").toLowerCase(), {
          name: b.name, contact: b.contact, contact_alt: b.contact_alt,
        });
      }
    } catch (_) { /* tabela inexistente — fica vazio */ }

    // 4. Beneficiários (extensionistas): mapa nuit → {name, contact}
    const beneficiariesMap = new Map();
    try {
      const bens = await query("SELECT nuit, name, contact FROM beneficiaries WHERE nuit IS NOT NULL AND nuit <> ''");
      for (const b of bens) {
        beneficiariesMap.set(String(b.nuit).trim(), { name: b.name, contact: b.contact });
      }
    } catch (_) { /* idem */ }

    // 5. Anexos a partir do cache.data (links + assinatura por GTU normalizada)
    const { normGtu: _normGtu } = require("./lib/adicional-match");
    const _attachmentsByGtu = new Map();
    for (const r of (cache.data || [])) {
      const _gtu = _normGtu(r.delivery_note_number);
      if (!_gtu) continue;
      const _links = [r.delivery_note_link, r.delivery_note_link2, r.delivery_note_link3]
        .map((s) => String(s || "").trim())
        .filter(Boolean);
      const _sig = String(r.beneficiary_signature || "").trim() || null;
      if (_links.length || _sig) _attachmentsByGtu.set(_gtu, { links: _links, signature: _sig });
    }

    // 6. Build entregas
    let entregas = entLib.buildEntregas({ apiRows, sheetRows, batedoresMap, beneficiariesMap, attachmentsByGtu: _attachmentsByGtu });

    // 6. Filtros server-side (string match case-insensitive)
    const norm = (s) => String(s || "").toLowerCase();
    if (req.query.status) {
      const want = norm(req.query.status);
      entregas = entregas.filter((e) => norm(e.status) === want);
    }
    if (req.query.province) {
      const want = norm(req.query.province);
      entregas = entregas.filter((e) => norm(e.province) === want);
    }
    if (req.query.district) {
      const want = norm(req.query.district);
      entregas = entregas.filter((e) => norm(e.district) === want);
    }
    if (req.query.supplier) {
      const want = norm(req.query.supplier);
      entregas = entregas.filter((e) => norm(e.supplier).includes(want));
    }
    if (req.query.batedor) {
      const want = norm(req.query.batedor);
      entregas = entregas.filter((e) =>
        norm(e.batedor_name).includes(want) || norm(e.batedor_email).includes(want));
    }
    if (req.query.q) {
      const want = norm(req.query.q);
      entregas = entregas.filter((e) =>
        norm(e.adsn).includes(want) ||
        norm(e.gtu).includes(want) ||
        norm(e.ext_name).includes(want) ||
        norm(e.driver).includes(want));
    }

    // Sort por data desc (mais recentes primeiro)
    entregas.sort((a, b) => String(b.create_date).localeCompare(String(a.create_date)));

    // Sumário
    const totalKg = entregas.reduce((s, e) => s + e.weight_kg, 0);
    const matched = entregas.filter((e) => e.sheet_matched).length;

    res.json({
      period: apiResult.period,
      filters_applied: {
        status: req.query.status || null,
        province: req.query.province || null,
        district: req.query.district || null,
        supplier: req.query.supplier || null,
        batedor: req.query.batedor || null,
        q: req.query.q || null,
        includeAllStatuses: includeAll,
      },
      count: entregas.length,
      total_kg: Math.round(totalKg),
      total_ton: Number((totalKg / 1000).toFixed(2)),
      with_batedor: matched,
      without_batedor: entregas.length - matched,
      rows: entregas,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Viagens (agrupado por ADSE — vista tipo Excel) ──
//
// Pipeline partilhado entre /viagens (full load) e /viagens/refresh
// (recarrega 1 ADSE):
//   1. apiRows (da API ADICIONAL) → filtragem por status relevante
//   2. enrichment (sheet_audit + batedores + beneficiários + supervisores + anexos)
//   3. buildEntregas (1 row por ADSN) → groupByViagem (1 row por ADSE)

// Carrega maps de enriquecimento a partir da DB + cache.data.
// Usado pelo full load e pelo refresh single-ADSE.
async function loadEnrichmentMaps() {
  const { query } = require("./db/mysql");
  const sheetRows = await query(
    `SELECT gtu, beneficiary_name, delivered_qty, unit, product, submitted_by,
            delivery_date_iso, district, province
     FROM delivery_audit WHERE deleted_at IS NULL`
  );
  const batedoresMap = new Map();
  try {
    const bts = await query("SELECT email, name, contact, contact_alt FROM batedores");
    for (const b of bts) batedoresMap.set(String(b.email || "").toLowerCase(), b);
  } catch (_) {}
  const beneficiariesMap = new Map();
  try {
    const bens = await query("SELECT nuit, name, contact FROM beneficiaries WHERE nuit IS NOT NULL AND nuit <> ''");
    for (const b of bens) beneficiariesMap.set(String(b.nuit).trim(), { name: b.name, contact: b.contact });
  } catch (_) {}
  const supervisorMap = new Map();
  try {
    const sups = await query(
      `SELECT nuit, supervisor_phone, supervisor_name
       FROM beneficiaries
       WHERE nuit IS NOT NULL AND nuit <> ''
         AND supervisor_phone IS NOT NULL AND supervisor_phone <> ''`
    );
    for (const s of sups) {
      const label = s.supervisor_name
        ? `${s.supervisor_name} / ${s.supervisor_phone}`
        : String(s.supervisor_phone);
      supervisorMap.set(String(s.nuit).trim(), label);
    }
  } catch (_) {}
  // Anexos (delivery_note_link* + beneficiary_signature) — só existem no
  // cache.data parseado do Google Sheet UNOPS (delivery_audit não os persiste).
  const { normGtu } = require("./lib/adicional-match");
  const attachmentsByGtu = new Map();
  for (const r of (cache.data || [])) {
    const gtu = normGtu(r.delivery_note_number);
    if (!gtu) continue;
    const links = [r.delivery_note_link, r.delivery_note_link2, r.delivery_note_link3]
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    const sig = String(r.beneficiary_signature || "").trim() || null;
    if (links.length || sig) attachmentsByGtu.set(gtu, { links, signature: sig });
  }
  return { sheetRows, batedoresMap, beneficiariesMap, supervisorMap, attachmentsByGtu };
}

// Aplica buildEntregas + groupByViagem a um conjunto de apiRows.
// Filtra estatutos relevantes (excepto se includeAll). NÃO aplica filtros
// adicionais (province/district/supplier/etc.) — esses são feitos
// client-side ou no caller.
async function buildViagensFromApiRows(apiRows, opts = {}) {
  const entLib = require("./lib/adicional-entregas");
  const viaLib = require("./lib/adicional-viagens");
  const includeAll = opts.includeAllStatuses === true;
  if (!includeAll) {
    const RELEVANT = new Set(["TRANSITO", "FINALIZADO"]);
    apiRows = apiRows.filter((r) => RELEVANT.has(String(r.StatusName || "").toUpperCase()));
  }
  const { sheetRows, batedoresMap, beneficiariesMap, supervisorMap, attachmentsByGtu } = await loadEnrichmentMaps();
  const entregas = entLib.buildEntregas({ apiRows, sheetRows, batedoresMap, beneficiariesMap, attachmentsByGtu });
  return viaLib.groupByViagem(entregas, supervisorMap);
}

// Helper para /viagens — fetch full + groupByViagem + filtros legacy server-side.
// Os filtros foram movidos para client-side (rerender no browser); mantidos
// aqui para compatibilidade caso algum chamador antigo ainda envie query params.
async function buildViagensDataset(req) {
  const fromDate = req.query.fromDate || undefined;
  const toDate   = req.query.toDate   || undefined;
  const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
  const includeAll = req.query.includeAllStatuses === "1";
  const noCache  = req.query.noCache === "1" || req.query.fresh === "1";

  const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays, noCache });
  const result = await buildViagensFromApiRows(apiResult.rows, { includeAllStatuses: includeAll });
  // Expõe estado do cache para o frontend mostrar "Cache 2min" / "Fresh"
  result._cache = {
    from_cache: !!apiResult.from_cache,
    age_seconds: apiResult.cache_age_seconds || 0,
  };

  // Filtros server-side legacy (a UI moderna filtra client-side em rerender())
  const norm = (s) => String(s || "").toLowerCase();
  let viagens = result.viagens;
  if (req.query.province) {
    const want = norm(req.query.province);
    viagens = viagens.filter((v) => norm(v.destino_provincia) === want);
  }
  if (req.query.district) {
    const want = norm(req.query.district);
    viagens = viagens.filter((v) => norm(v.destino_distrito) === want);
  }
  if (req.query.supplier) {
    const want = norm(req.query.supplier);
    viagens = viagens.filter((v) => norm(v.fornecedor).includes(want));
  }
  if (req.query.batedor) {
    const want = norm(req.query.batedor);
    viagens = viagens.filter((v) =>
      norm(v.batedor).includes(want) || norm(v.batedor_email).includes(want));
  }
  if (req.query.status) {
    const want = norm(req.query.status);
    viagens = viagens.filter((v) => norm(v.status) === want);
  }

  return { period: apiResult.period, viagens, summary: result.summary };
}

// GET /api/admin/adicional/viagens — JSON com viagens agrupadas
app.get("/api/admin/adicional/viagens", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const result = await buildViagensDataset(req);
    res.json({
      period: result.period,
      cache: result._cache,
      summary: { ...result.summary, viagens: result.viagens.length },
      viagens: result.viagens,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/viagens/refresh?adse=ADSE...&date=YYYY-MM-DD
// Recarrega APENAS 1 ADSE — fetch limitado a ±1 dia da data, depois filtra
// para a ADSE específica. Usado pelo botão 🔄 em cada card de viagem (UI).
// Resposta: { viagem: {...} } (mesma shape dos items de /viagens).
app.get("/api/admin/adicional/viagens/refresh", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const adse = String(req.query.adse || "").trim();
    const dateStr = String(req.query.date || "").trim();
    const includeAll = req.query.includeAllStatuses === "1";
    if (!adse) return res.status(400).json({ error: "Parâmetro 'adse' obrigatório" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ error: "Parâmetro 'date' obrigatório (YYYY-MM-DD)" });
    }
    // Janela ±2 dias da data — cobre ADSEs cuja CreateDate caia perto do limite
    const d = new Date(dateStr + "T00:00:00");
    const fromD = new Date(d); fromD.setDate(fromD.getDate() - 2);
    const toD   = new Date(d); toD.setDate(toD.getDate() + 2);
    const fmtYmd = (x) => x.getFullYear() + "-" +
      String(x.getMonth() + 1).padStart(2, "0") + "-" +
      String(x.getDate()).padStart(2, "0");

    // 1. Refresh do Sheet UNOPS em paralelo com o fetch da API — apanha
    //    novas GTUs submetidas desde o último refresh do cache.
    //    Se falhar, continua com o cache actual (não bloqueia o refresh).
    const sheetPromise = refreshCache().catch((e) => {
      console.warn("[viagens/refresh] sheet refresh falhou:", e.message);
    });

    // 2. noCache: o utilizador clicou refresh — quer dados FRESCOS, ignora o cache.
    const apiResult = await adicionalApi.listProjectsChunked({
      fromDate: fmtYmd(fromD), toDate: fmtYmd(toD), chunkDays: 7, noCache: true,
    });
    // 3. Garante que o sheet UNOPS terminou antes de construir as viagens
    //    (precisamos do cache.data actualizado para o match GTU).
    await sheetPromise;

    // Filtra para a ADSE pedida (ParentServiceCode)
    const apiRows = apiResult.rows.filter((r) =>
      String(r.ParentServiceCode || "").trim() === adse
    );
    if (!apiRows.length) {
      return res.status(404).json({
        error: `ADSE '${adse}' não encontrada na janela ${fmtYmd(fromD)}…${fmtYmd(toD)}`,
      });
    }
    // Propaga rows frescas para o cache principal — assim um reload completo
    // posterior (dentro do TTL) já mostra a versão actualizada desta ADSE.
    const touched = adicionalApi.updateCacheRows(apiRows);
    const result = await buildViagensFromApiRows(apiRows, { includeAllStatuses: includeAll });
    const viagem = result.viagens[0];
    if (!viagem) {
      return res.status(404).json({ error: `ADSE '${adse}' sem viagens após filtro de status.` });
    }
    res.json({ viagem, cache_rows_updated: touched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/viagens/export.xlsx — Excel idêntico ao mapa
app.get("/api/admin/adicional/viagens/export.xlsx", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const result = await buildViagensDataset(req);

    const wb = new ExcelJS.Workbook();
    wb.creator = "AQI Dashboard";
    wb.created = new Date();

    // Para fidelidade ao mapa, agrupa viagens por STATUS_GROUP:
    //   ENTREGUE/Parcial → sheet "ENTREGUES"
    //   Em trânsito       → sheet "TRANSITO"
    // (Sem misturar. Replica o formato exacto: header CAM-X / col headers /
    //  data / totais / linha vazia / próximo camião)
    const groupTransito = result.viagens.filter((v) => v.status === "Em trânsito");
    const groupEntregue = result.viagens.filter((v) => v.status === "ENTREGUE" || v.status === "Parcial");

    function renderSheet(ws, viagens, title) {
      const C_HEADER = "FF0F4C75";
      const C_TOTAL  = "FFE2E8F0";
      const C_WHITE  = "FFFFFFFF";
      const C_OK     = "FFDCFCE7";
      const C_MISS   = "FFFEF3C7";
      // Larguras das colunas (col 4 = GTU/GTS, col 5 = Sistema)
      const colWidths = [18, 12, 22, 22, 14, 26, 16, 26, 14, 28, 18, 12, 14, 11, 11, 9, 22];
      colWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      let r = 1;
      // Título global
      ws.getCell(r, 1).value = title;
      ws.getCell(r, 1).font = { bold: true, size: 14, color: { argb: C_HEADER } };
      ws.mergeCells(r, 1, r, 6);
      r++;
      ws.getCell(r, 1).value = `Total: ${result.summary.total_kg.toLocaleString("pt-PT")} kg (${result.summary.total_ton} t) em ${viagens.length} viagens`;
      ws.getCell(r, 1).font = { italic: true, color: { argb: "FF64748B" } };
      r += 2;

      for (const v of viagens) {
        // Header da viagem: "CAM-XX  Destino  N.NNN T  · Produtos · UNOPS"
        const nUnops = v.items.filter((it) => it.sheet_matched).length;
        const nTotal = v.items.length;
        // Produtos carregados (pode haver mais de um): "Milho 18.5t · Feijão 4t"
        const produtosStr = (v.products || [])
          .map((p) => `${p.product} ${p.ton}t`)
          .join(" · ");
        ws.getCell(r, 1).value =
          `${v.cam_label}   ${v.destino_distrito}   ${v.total_ton} T` +
          (produtosStr ? `   ·   ${produtosStr}` : "") +
          `   ·   UNOPS ${nUnops}/${nTotal}`;
        ws.getCell(r, 1).font = { bold: true, size: 12, color: { argb: C_WHITE } };
        ws.getCell(r, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_HEADER } };
        ws.mergeCells(r, 1, r, 6);
        // Origem / Transportador no resto da row
        ws.getCell(r, 7).value = `ORIGEM: ${v.fornecedor} · TRANSPORTADOR: ${v.transportador}`;
        ws.getCell(r, 7).font = { italic: true, color: { argb: C_WHITE } };
        ws.getCell(r, 7).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_HEADER } };
        ws.mergeCells(r, 7, r, 17);
        r++;

        // Header das colunas
        const headers = [
          "MATRICULA", "DATA SAIDA", "Código Serviço", "GTU/GTS", "Sistema",
          "Nome Extensionista", "Telf Extensionista", "BATEDOR", "Telef Batedor",
          "Telf Supervisor", "Distrito", "NUIT", "Artigo", "Volumes (un)",
          "Peso (kg)", "Ton", "Observações/ESTADO",
        ];
        headers.forEach((h, i) => {
          const c = ws.getCell(r, i + 1);
          c.value = h;
          c.font = { bold: true, color: { argb: C_WHITE } };
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E6BA8" } };
          c.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        });
        r++;

        // Linhas de dados (1 por item)
        for (const it of v.items) {
          ws.getCell(r, 1).value  = it.truck_plate;
          ws.getCell(r, 2).value  = it.create_date ? new Date(it.create_date) : null;
          if (ws.getCell(r, 2).value) ws.getCell(r, 2).numFmt = "dd/mm/yyyy";
          ws.getCell(r, 3).value  = it.adsn;
          ws.getCell(r, 4).value  = it.gtu || "";
          // Sistema: UNOPS+ADIC (matched) ou Só ADIC (não matched)
          const sysCell = ws.getCell(r, 5);
          sysCell.value = it.sheet_matched ? "UNOPS + ADIC" : "Só ADIC";
          sysCell.fill = {
            type: "pattern", pattern: "solid",
            fgColor: { argb: it.sheet_matched ? C_OK : C_MISS },
          };
          sysCell.font = { bold: true, color: { argb: it.sheet_matched ? "FF166534" : "FF92400E" } };
          sysCell.alignment = { horizontal: "center" };
          ws.getCell(r, 6).value  = it.ext_name;
          ws.getCell(r, 7).value  = it.ext_contact || "";
          ws.getCell(r, 8).value  = it.batedor_name || it.batedor_email || "";
          ws.getCell(r, 9).value  = it.batedor_contact || "";
          ws.getCell(r, 10).value = v.supervisor_phone || "";
          ws.getCell(r, 11).value = it.district;
          ws.getCell(r, 12).value = it.ext_nuit || "";
          ws.getCell(r, 13).value = it.product;
          ws.getCell(r, 14).value = it.volumes || 0;
          ws.getCell(r, 15).value = it.weight_kg || 0;
          ws.getCell(r, 16).value = it.weight_ton || 0;
          ws.getCell(r, 14).numFmt = "#,##0";
          ws.getCell(r, 15).numFmt = "#,##0.00";
          ws.getCell(r, 16).numFmt = "#,##0.000";
          ws.getCell(r, 17).value = it.status === "FINALIZADO" ? "ENTREGUE" : (it.status === "TRANSITO" ? "Em transito" : it.status);
          r++;
        }

        // Total da viagem (col 14-16)
        ws.getCell(r, 13).value = "TOTAL";
        ws.getCell(r, 13).font = { bold: true, italic: true };
        ws.getCell(r, 13).alignment = { horizontal: "right" };
        ws.getCell(r, 14).value = v.total_volumes;
        ws.getCell(r, 15).value = v.total_kg;
        ws.getCell(r, 16).value = v.total_ton;
        ws.getCell(r, 14).numFmt = "#,##0";
        ws.getCell(r, 15).numFmt = "#,##0.00";
        ws.getCell(r, 16).numFmt = "#,##0.000";
        for (let c = 13; c <= 16; c++) {
          ws.getCell(r, c).font = { bold: true };
          ws.getCell(r, c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: C_TOTAL } };
        }
        r += 2; // linha em branco entre camiões
      }
    }

    if (groupEntregue.length) {
      renderSheet(wb.addWorksheet("ENTREGUES"), groupEntregue, "ENTREGUES");
    }
    if (groupTransito.length) {
      renderSheet(wb.addWorksheet("TRANSITO"), groupTransito, "TRANSITO");
    }
    if (!groupEntregue.length && !groupTransito.length) {
      const ws = wb.addWorksheet("Vazio");
      ws.getCell(1, 1).value = "Sem viagens para os filtros aplicados.";
    }

    const fname = `viagens_${result.period.fromDate}_${result.period.toDate}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/suppliers[?fromDate=&toDate=&chunkDays=&includeAllStatuses=]
// Agrega serviços ADICIONAL por fornecedor (canonical key = ShipAcountNumber).
// Devolve lista de fornecedores ordenada por peso entregue (kg),
// com breakdown por SKU, província, status, aliases de nome, etc.
app.get("/api/admin/adicional/suppliers", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const supLib = require("./lib/adicional-suppliers");
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
    const includeAll = req.query.includeAllStatuses === "1";

    const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays });
    const result = supLib.aggregateSuppliers(apiResult.rows, { includeAllStatuses: includeAll });

    res.json({
      period: apiResult.period,
      api: { total: apiResult.rows.length, chunks: apiResult.chunks_total, chunks_failed: apiResult.chunks_failed },
      filter: { include_all_statuses: includeAll, statuses_considered: includeAll ? "(todos)" : ["TRANSITO", "FINALIZADO"] },
      totals: result.totals,
      suppliers: result.suppliers,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── System / DB status ────────────────────────────────────────────
// GET /api/admin/system/db-status — devolve info do DB activo (sem password)
app.get("/api/admin/system/db-status", auth.requireRole("admin", "superadmin", "operator", "viewer"), async (req, res) => {
  try {
    const { getActiveDbInfo, query } = require("./db/mysql");
    const info = getActiveDbInfo();
    // Sanity check: faz uma query trivial para confirmar que a ligação está viva
    let alive = false;
    try {
      await query("SELECT 1");
      alive = true;
    } catch (_) {}
    res.json({ ...info, alive });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Supplier Metas CRUD ───────────────────────────────────────────
// GET /api/admin/supplier-metas — lista
app.get("/api/admin/supplier-metas", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { query } = require("./db/mysql");
    const rows = await query(
      `SELECT id, meta_key, product, qty, unit, note, active,
              created_at, updated_at
       FROM supplier_metas
       ORDER BY active DESC, meta_key, product`
    );
    res.json({ rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/supplier-metas — upsert (INSERT ... ON DUPLICATE KEY UPDATE)
// body: { meta_key, product, qty (nullable), unit (kg/un), note? }
app.post("/api/admin/supplier-metas", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { query } = require("./db/mysql");
    const { invalidateMetasCache } = require("./lib/supplier-metas");
    const meta_key = String(req.body.meta_key || "").trim().toUpperCase();
    const product = String(req.body.product || "").trim();
    const qty = req.body.qty == null || req.body.qty === "" ? null : Number(req.body.qty);
    const unit = String(req.body.unit || "kg").toLowerCase() === "un" ? "un" : "kg";
    const note = String(req.body.note || "").trim() || null;
    const active = req.body.active === false ? 0 : 1;
    if (!meta_key || !product) {
      return res.status(400).json({ error: "meta_key e product são obrigatórios" });
    }
    if (qty != null && (isNaN(qty) || qty < 0)) {
      return res.status(400).json({ error: "qty deve ser número ≥ 0 ou vazio" });
    }
    const userId = req.user?.id || null;
    await query(
      `INSERT INTO supplier_metas (meta_key, product, qty, unit, note, active, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         qty = VALUES(qty), unit = VALUES(unit), note = VALUES(note),
         active = VALUES(active), updated_by = VALUES(updated_by)`,
      [meta_key, product, qty, unit, note, active, userId, userId]
    );
    invalidateMetasCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/supplier-metas/batch — substitui TODAS as metas de 1 supplier
// Body: { meta_key, products: [{ product, qty (nullable), unit?, note? }] }
// - Upsert (INSERT...ON DUPLICATE KEY UPDATE) cada produto na lista
// - Soft-delete (active=0) os produtos que existiam mas não estão na lista nova
// Útil para o modal de edição multi-produto em /admin/supplier-metas.
app.post("/api/admin/supplier-metas/batch", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { query } = require("./db/mysql");
    const { invalidateMetasCache } = require("./lib/supplier-metas");
    const meta_key = String(req.body.meta_key || "").trim().toUpperCase();
    const products = Array.isArray(req.body.products) ? req.body.products : null;
    if (!meta_key || !products) {
      return res.status(400).json({ error: "meta_key + products[] obrigatórios" });
    }
    const userId = req.user?.id || null;
    const keptProducts = new Set();
    let inserted = 0, updated = 0;

    for (const p of products) {
      const product = String(p.product || "").trim();
      if (!product) continue;
      const qty = p.qty == null || p.qty === "" ? null : Number(p.qty);
      const unit = String(p.unit || "kg").toLowerCase() === "un" ? "un" : "kg";
      const note = String(p.note || "").trim() || null;
      if (qty != null && (isNaN(qty) || qty < 0)) {
        return res.status(400).json({ error: `qty inválida para ${product}` });
      }
      const result = await query(
        `INSERT INTO supplier_metas (meta_key, product, qty, unit, note, active, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
           qty = VALUES(qty), unit = VALUES(unit), note = VALUES(note),
           active = 1, updated_by = VALUES(updated_by)`,
        [meta_key, product, qty, unit, note, userId, userId]
      );
      if (result.affectedRows === 1) inserted++;
      else updated++;
      keptProducts.add(product);
    }
    // Soft-delete: produtos que existiam para esta meta_key mas não estão
    // na lista nova ficam active=0
    const existing = await query(
      "SELECT id, product FROM supplier_metas WHERE meta_key = ? AND active = 1",
      [meta_key]
    );
    let deactivated = 0;
    for (const row of existing) {
      if (!keptProducts.has(row.product)) {
        await query("UPDATE supplier_metas SET active = 0, updated_by = ? WHERE id = ?",
          [userId, row.id]);
        deactivated++;
      }
    }
    invalidateMetasCache();
    res.json({ ok: true, inserted, updated, deactivated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/supplier-metas/:id — soft delete (active = 0)
app.delete("/api/admin/supplier-metas/:id", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const { query } = require("./db/mysql");
    const { invalidateMetasCache } = require("./lib/supplier-metas");
    await query("UPDATE supplier_metas SET active = 0, updated_by = ? WHERE id = ?",
      [req.user?.id || null, req.params.id]);
    invalidateMetasCache();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/fornecido[?fromDate=&toDate=&chunkDays=]
// Vista "Fornecido" — junta TRANSITO+FINALIZADO num bucket único + sacos
// herméticos apresentados em UNIDADES em vez de kg. Status CRIADO é ignorado.
app.get("/api/admin/adicional/fornecido", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const supLib = require("./lib/adicional-suppliers");
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
    const noCache = req.query.noCache === "1" || req.query.fresh === "1";

    const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays, noCache });

    // Constrói o Set de GTUs já lançados na app UNOPS (sheet "Delivery",
    // coluna "Delivery Note Number"). Sem este set, aggregateFornecido
    // trata tudo como já-na-app (app_qty=forn_qty, pend_app_qty=0).
    const { normGtu } = require("./lib/adicional-match");
    const unopsGtus = new Set();
    for (const row of cache.data || []) {
      const g = row.delivery_note_number;
      if (!g) continue;
      const n = normGtu(g);
      if (n) unopsGtus.add(n);
    }

    const result = await supLib.aggregateFornecido(apiResult.rows, { unopsGtus });

    res.json({
      period: apiResult.period,
      cache: {
        from_cache: !!apiResult.from_cache,
        age_seconds: apiResult.cache_age_seconds || 0,
      },
      api: { total: apiResult.rows.length, chunks: apiResult.chunks_total, chunks_failed: apiResult.chunks_failed },
      unops_sheet: { total_gtus: unopsGtus.size },
      totals: result.totals,
      suppliers: result.suppliers,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/suppliers/:key/services[?fromDate=&toDate=&chunkDays=&includeAllStatuses=]
// Drill-down: serviços individuais de 1 fornecedor (lista de ADSNs).
// key = "acct:53" ou "name:NORMALIZED" (devolvido por /suppliers).
app.get("/api/admin/adicional/suppliers/:key/services", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const supLib = require("./lib/adicional-suppliers");
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
    const includeAll = req.query.includeAllStatuses === "1";

    const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays });
    const rows = supLib.rowsForSupplier(apiResult.rows, req.params.key, { includeAllStatuses: includeAll });

    // Ordena por data desc + devolve campos essenciais
    rows.sort((a, b) => String(b.CreateDate || "").localeCompare(String(a.CreateDate || "")));
    res.json({
      period: apiResult.period,
      key: req.params.key,
      count: rows.length,
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/adicional/reconcile[?fromDate=&toDate=&chunkDays=&bucket=]
// Cruza GTU+nome+qty entre ADICIONAL DMS API e delivery_audit (Google Sheet).
// Devolve sumário + buckets (matched/qty_mismatch/name_mismatch/api_only/sheet_only).
// ?bucket=NAME limita o response a esse bucket (para paginação manual).
app.get("/api/admin/adicional/reconcile", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const adMatch = require("./lib/adicional-match");
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;

    // 1. ADICIONAL API (chunked) — só TRANSITO + FINALIZADO interessam.
    // CRIADO = ainda no armazem, sem entrega real possivel → ignora.
    // EXPEDIÇÃO SEM TRANSPORTE = idem (camião ainda não saiu).
    // Operador pode forçar inclusão de todos com ?includeAllStatuses=1.
    const apiResult = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays });
    const RELEVANT_STATUSES = new Set(["TRANSITO", "FINALIZADO"]);
    const includeAll = req.query.includeAllStatuses === "1";
    const apiFilteredRows = includeAll
      ? apiResult.rows
      : apiResult.rows.filter((r) => RELEVANT_STATUSES.has(String(r.StatusName || "").toUpperCase()));

    // 2. delivery_audit (já filtrado por deleted_at IS NULL — não inclui apagados)
    const { query } = require("./db/mysql");
    const dateFilter = [];
    const dateParams = [];
    if (apiResult.period.fromDate) {
      dateFilter.push("(delivery_date_iso >= ? OR detected_date >= ?)");
      dateParams.push(apiResult.period.fromDate, apiResult.period.fromDate);
    }
    if (apiResult.period.toDate) {
      dateFilter.push("(delivery_date_iso <= ? OR detected_date <= ?)");
      dateParams.push(apiResult.period.toDate, apiResult.period.toDate);
    }
    const where = "deleted_at IS NULL" +
      (dateFilter.length ? " AND " + dateFilter.join(" AND ") : "");
    const sheetRows = await query(
      `SELECT gtu, adsn, beneficiary_name, product, delivered_qty, unit,
              district, province, submitted_by, delivery_date_iso, detected_date,
              verification_status
       FROM delivery_audit
       WHERE ${where}`,
      dateParams
    );

    // 3. Reconcilia (só sobre rows TRANSITO+FINALIZADO)
    const result = adMatch.reconcile(apiFilteredRows, sheetRows);

    // Contagem por status (para o operador ver porque é que api_only é tão alto)
    const byStatus = {};
    apiResult.rows.forEach((r) => {
      const s = String(r.StatusName || "(sem)").toUpperCase();
      byStatus[s] = (byStatus[s] || 0) + 1;
    });

    const out = {
      period: apiResult.period,
      api: {
        total: apiResult.rows.length,
        relevant: apiFilteredRows.length,
        filtered_out: apiResult.rows.length - apiFilteredRows.length,
        by_status: byStatus,
        statuses_considered: includeAll ? "(todos)" : Array.from(RELEVANT_STATUSES),
        chunks: apiResult.chunks_total,
        chunks_failed: apiResult.chunks_failed,
      },
      sheet: { count: sheetRows.length },
      summary: result.summary,
    };
    const bucket = String(req.query.bucket || "").toLowerCase();
    if (["matched","qty_mismatch","name_mismatch","api_only","sheet_only"].includes(bucket)) {
      out[bucket] = result[bucket];
    } else {
      // Default: devolve só primeiras 50 de cada bucket para não rebentar o JSON
      out.matched        = result.matched.slice(0, 50);
      out.qty_mismatch   = result.qty_mismatch;        // este interessa todo (auditoria)
      out.name_mismatch  = result.name_mismatch;       // idem
      out.api_only       = result.api_only.slice(0, 50);
      out.sheet_only     = result.sheet_only;          // suspeitos — todo
      out.note = "matched + api_only truncados aos primeiros 50. Use ?bucket=NAME para o detalhe completo.";
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split("\n").slice(0, 3) });
  }
});

// GET /api/admin/adicional/projects[?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD&chunkDays=N]
//     Defaults: toDate = hoje, fromDate = 60d atrás, chunkDays = 7
//     A API ADICIONAL pode timeout em windows grandes (>30d), por isso
//     o cliente divide automaticamente em chunks de 7d (configurável)
//     e faz retry com backoff. Devolve sempre o universo unificado.
//     [&raw=1] — devolve a array completa de servicos crus
app.get("/api/admin/adicional/projects", auth.requireRole("admin", "superadmin"), async (req, res) => {
  try {
    const fromDate = req.query.fromDate || undefined;
    const toDate   = req.query.toDate   || undefined;
    const chunkDays = req.query.chunkDays ? Number(req.query.chunkDays) : undefined;
    const result = await adicionalApi.listProjectsChunked({ fromDate, toDate, chunkDays });
    const arr = result.rows;
    if (req.query.raw === "1") {
      return res.json({ ...result, rows: arr });
    }

    // Sumário rápido
    const byStatus = {}, byPlan = {}, bySku = {}, byProvince = {}, byDistrict = {};
    let totalWeight = 0, totalVolumes = 0;
    for (const r of arr) {
      byStatus[r.StatusName || "(sem)"]      = (byStatus[r.StatusName || "(sem)"] || 0) + 1;
      byPlan[r.InvoicePlanName || "(sem)"]   = (byPlan[r.InvoicePlanName || "(sem)"] || 0) + 1;
      bySku[r.SKU || "(sem)"]                = (bySku[r.SKU || "(sem)"] || 0) + 1;
      byProvince[r.ReceiverAddress || "(sem)"]  = (byProvince[r.ReceiverAddress || "(sem)"] || 0) + 1;
      byDistrict[r.ReceiverPostalPlace || "(sem)"] = (byDistrict[r.ReceiverPostalPlace || "(sem)"] || 0) + 1;
      totalWeight += Number(r.Weight) || 0;
      totalVolumes += Number(r.VolumesQty) || 0;
    }
    res.json({
      period: result.period,
      chunks: { total: result.chunks_total, ok: result.chunks_ok, failed: result.chunks_failed },
      errors: result.errors,
      count: arr.length,
      totals: { weight: totalWeight, volumes: totalVolumes },
      by_status: byStatus,
      by_plan: byPlan,
      by_sku: bySku,
      by_province: byProvince,
      by_district: byDistrict,
      sample: arr[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

  // Pre-warm dos caches da /batedores (API ADICIONAL + OneDrive MAPA UNOPS)
  // → mantém os dados sempre quentes em background; utilizador nunca paga
  //   cold load. Detalhes em lib/batedores-prewarm.js.
  try {
    require("./lib/batedores-prewarm").start();
  } catch (e) {
    console.warn("[prewarm] falhou ao iniciar (non-fatal):", e.message);
  }

  app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
  });
}

main();
