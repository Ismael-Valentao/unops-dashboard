/**
 * Pre-warmer dos caches do /batedores.
 *
 * Mantém os caches da API ADICIONAL e do OneDrive MAPA UNOPS sempre
 * quentes, refrescando-os em background ANTES de o TTL expirar. Assim
 * o utilizador nunca paga o cold load (12s+ para a API + 5s para o
 * OneDrive).
 *
 * Comportamento:
 *   - 10s após o servidor arrancar: 1.ª warm-up (não bloqueia startup)
 *   - Loop API: refresca a cada (TTL − 60s); janela = LOOKBACK_DAYS
 *   - Loop OneDrive: refresca a cada (TTL − 120s); HEAD evita re-download
 *     se o ficheiro não mudou
 *
 * Cada loop tem try/catch — falha de rede não derruba o servidor. Logs
 * indicam sucesso/falha + duração + nº de rows.
 *
 * Env vars relevantes:
 *   BATEDORES_API_LOOKBACK_DAYS  (default 90)   — dias de histórico API
 *   ADICIONAL_API_CACHE_TTL_MS   (default 5min) — TTL cache API
 *   ONEDRIVE_MAPA_TTL_MS         (default 15min) — TTL cache OneDrive
 *   BATEDORES_PREWARM_DISABLED   (set=1 para desligar) — útil em dev
 */

function ymd(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

let started = false;
const stats = {
  api:    { last_run: null, last_ok: false, last_ms: 0, last_rows: 0, last_err: null, runs: 0, errors: 0 },
  mapa:   { last_run: null, last_ok: false, last_ms: 0, last_count: 0, last_err: null, runs: 0, errors: 0 },
};

async function refreshApi() {
  const adicionalApi = require("./adicional-api");
  const LOOKBACK = Number(process.env.BATEDORES_API_LOOKBACK_DAYS) || 90;
  const t = Date.now();
  stats.api.runs++;
  try {
    const today = new Date();
    const apiTo = new Date(today); apiTo.setDate(apiTo.getDate() + 1);
    const apiFrom = new Date(today); apiFrom.setDate(apiFrom.getDate() - LOOKBACK);
    const r = await adicionalApi.listProjectsChunked({
      fromDate: ymd(apiFrom), toDate: ymd(apiTo), chunkDays: 14, noCache: true,
    });
    stats.api.last_run = new Date().toISOString();
    stats.api.last_ok  = true;
    stats.api.last_ms  = Date.now() - t;
    stats.api.last_rows = r.rows.length;
    stats.api.last_err = null;
    console.log(`[prewarm] API ADICIONAL ${LOOKBACK}d: ${r.rows.length} rows in ${stats.api.last_ms}ms`);
  } catch (e) {
    stats.api.errors++;
    stats.api.last_ok  = false;
    stats.api.last_err = e.message;
    stats.api.last_run = new Date().toISOString();
    stats.api.last_ms  = Date.now() - t;
    console.warn(`[prewarm] API ADICIONAL FAILED in ${stats.api.last_ms}ms:`, e.message);
  }
}

async function refreshMapa() {
  const onedriveMapa = require("./onedrive-mapa");
  const t = Date.now();
  stats.mapa.runs++;
  try {
    const r = await onedriveMapa.getMapa({ force: true });
    stats.mapa.last_run = new Date().toISOString();
    stats.mapa.last_ok  = true;
    stats.mapa.last_ms  = Date.now() - t;
    stats.mapa.last_count = r.count;
    stats.mapa.last_err = null;
    // Distingue se foi só HEAD (rápido) vs full download (~5s) para debug
    const tag = stats.mapa.last_ms < 1500 ? "(HEAD match, sem download)" : "(download completo)";
    console.log(`[prewarm] OneDrive mapa: ${r.count} ADSN in ${stats.mapa.last_ms}ms ${tag}`);
  } catch (e) {
    stats.mapa.errors++;
    stats.mapa.last_ok  = false;
    stats.mapa.last_err = e.message;
    stats.mapa.last_run = new Date().toISOString();
    stats.mapa.last_ms  = Date.now() - t;
    console.warn(`[prewarm] OneDrive mapa FAILED in ${stats.mapa.last_ms}ms:`, e.message);
  }
}

function start() {
  if (started) return;
  if (process.env.BATEDORES_PREWARM_DISABLED === "1") {
    console.log("[prewarm] desligado (BATEDORES_PREWARM_DISABLED=1)");
    return;
  }
  started = true;

  const apiTtlMs  = Number(process.env.ADICIONAL_API_CACHE_TTL_MS || 5  * 60 * 1000);
  const mapaTtlMs = Number(process.env.ONEDRIVE_MAPA_TTL_MS       || 15 * 60 * 1000);

  // Refresca um pouco antes de TTL expirar para garantir que NUNCA expira
  // entre requests. Mínimos: 60s API, 120s OneDrive (segurança contra TTL
  // mal configurado).
  const apiIntervalMs  = Math.max(60  * 1000, apiTtlMs  - 60  * 1000);
  const mapaIntervalMs = Math.max(120 * 1000, mapaTtlMs - 120 * 1000);

  // Warm-up inicial 10s depois do startup (não bloqueia app.listen).
  // Staggered (API em t+10s, OneDrive em t+12s) para não saturar rede.
  setTimeout(() => { refreshApi().catch(() => {}); }, 10 * 1000);
  setTimeout(() => { refreshMapa().catch(() => {}); }, 12 * 1000);

  setInterval(() => { refreshApi().catch(() => {}); },  apiIntervalMs);
  setInterval(() => { refreshMapa().catch(() => {}); }, mapaIntervalMs);

  console.log(`[prewarm] iniciado: API refresh cada ${Math.round(apiIntervalMs/1000)}s, ` +
              `OneDrive refresh cada ${Math.round(mapaIntervalMs/1000)}s, ` +
              `lookback ${Number(process.env.BATEDORES_API_LOOKBACK_DAYS) || 90}d`);
}

function getStats() { return { started, stats }; }

module.exports = { start, getStats, refreshApi, refreshMapa };
