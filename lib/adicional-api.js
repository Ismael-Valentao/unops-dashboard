/**
 * Cliente para a API do sistema ADICIONAL (portaldms.adicional.co.mz).
 *
 * Fluxo:
 *   1. POST /token (Basic webapi:secret + grant_type=password + user/pass)
 *      → devolve { access_token, expires_in }
 *   2. GET /api/projects?fromDate=...&toDate=... (Authorization: Bearer ...)
 *      → devolve array de serviços com ADSN/GTU/ADSE/destinatario/transportador
 *
 * Token expira tipicamente em 86399s (~24h). Fazemos cache em memória e
 * renovamos automaticamente quando faltam menos de 5 min para expirar.
 *
 * Credenciais vêm de variáveis de ambiente:
 *   - ADICIONAL_API_BASE        (default: https://dmswebapi.adicional.co.mz)
 *   - ADICIONAL_API_BASIC_AUTH  (default: d2ViYXBpOnNlY3JldA== = webapi:secret)
 *   - ADICIONAL_API_USERNAME    (obrigatório)
 *   - ADICIONAL_API_PASSWORD    (obrigatório)
 *
 * Falhas: lança Error com message + status. Caller decide o que fazer.
 */

const https = require("https");

const API_BASE = process.env.ADICIONAL_API_BASE || "https://dmswebapi.adicional.co.mz";
const BASIC_AUTH = process.env.ADICIONAL_API_BASIC_AUTH || "d2ViYXBpOnNlY3JldA==";

// Cache em memória — escopo módulo
let tokenCache = {
  token: null,
  expiresAt: 0, // ms epoch
};

/**
 * Helper HTTP — POST application/x-www-form-urlencoded ou GET com bearer.
 * Resolve com { status, headers, body (string) }.
 */
function httpRequest({ method, url, headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: {
        Accept: "application/json",
        ...headers,
      },
    };
    if (body) {
      opts.headers["Content-Length"] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf-8");
        resolve({ status: res.statusCode, headers: res.headers, body: text });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Obtém access_token. Usa cache se ainda válido (>5 min de margem).
 * Lança Error se credenciais faltarem ou se a API rejeitar.
 */
async function getToken() {
  const username = process.env.ADICIONAL_API_USERNAME;
  const password = process.env.ADICIONAL_API_PASSWORD;
  if (!username || !password) {
    throw new Error("ADICIONAL_API_USERNAME/ADICIONAL_API_PASSWORD não configurados (.env)");
  }

  // Cache hit (com 5 min de margem)
  const now = Date.now();
  if (tokenCache.token && tokenCache.expiresAt - now > 5 * 60 * 1000) {
    return tokenCache.token;
  }

  // Fetch novo token
  const body = `grant_type=password&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
  const res = await httpRequest({
    method: "POST",
    url: `${API_BASE}/token`,
    headers: {
      Authorization: `Basic ${BASIC_AUTH}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: "https://portaldms.adicional.co.mz/",
    },
    body,
  });
  if (res.status !== 200) {
    throw new Error(`Auth failed [${res.status}]: ${res.body.slice(0, 300)}`);
  }
  let parsed;
  try { parsed = JSON.parse(res.body); }
  catch (e) { throw new Error("Auth response not JSON: " + res.body.slice(0, 200)); }
  if (!parsed.access_token) {
    throw new Error("Auth response sem access_token: " + JSON.stringify(parsed).slice(0, 200));
  }
  tokenCache.token = parsed.access_token;
  tokenCache.expiresAt = now + (Number(parsed.expires_in) || 3600) * 1000;
  return tokenCache.token;
}

/**
 * Helper: data de hoje em YYYY-MM-DD (componentes locais — não UTC).
 */
function todayYmd() {
  const d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/**
 * Helper: data N dias atrás em YYYY-MM-DD.
 */
function daysAgoYmd(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/**
 * Lista serviços no período (datas YYYY-MM-DD).
 * Defaults: toDate = hoje, fromDate = 60 dias atrás.
 * Devolve array de objects (cada um = 1 ADSN com 30+ campos).
 */
async function listProjects({ fromDate, toDate } = {}) {
  // Defaults pragmáticos — toDate sempre eh hoje quando o caller não especifica
  if (!toDate)   toDate   = todayYmd();
  if (!fromDate) fromDate = daysAgoYmd(60);
  // Sanity: ambos devem matchar YYYY-MM-DD
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
    throw new Error(`fromDate/toDate inválidos: ${fromDate} / ${toDate} (esperado YYYY-MM-DD)`);
  }
  const token = await getToken();
  const url = `${API_BASE}/api/projects?fromDate=${encodeURIComponent(fromDate)}&toDate=${encodeURIComponent(toDate)}`;
  const res = await httpRequest({
    method: "GET",
    url,
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    // Token expirou entretanto — invalida cache e tenta uma vez
    tokenCache = { token: null, expiresAt: 0 };
    const t2 = await getToken();
    const res2 = await httpRequest({
      method: "GET",
      url,
      headers: { Authorization: `Bearer ${t2}` },
    });
    if (res2.status !== 200) throw new Error(`API failed [${res2.status}]: ${res2.body.slice(0, 300)}`);
    return JSON.parse(res2.body);
  }
  if (res.status !== 200) {
    throw new Error(`API failed [${res.status}]: ${res.body.slice(0, 300)}`);
  }
  return JSON.parse(res.body);
}

/**
 * Devolve o estado actual do cache de token (sem expor o token).
 * Útil para diagnostics.
 */
function tokenStatus() {
  const now = Date.now();
  return {
    has_token: !!tokenCache.token,
    expires_at: tokenCache.expiresAt ? new Date(tokenCache.expiresAt).toISOString() : null,
    expires_in_seconds: tokenCache.expiresAt ? Math.max(0, Math.floor((tokenCache.expiresAt - now) / 1000)) : 0,
    api_base: API_BASE,
    user_configured: !!process.env.ADICIONAL_API_USERNAME,
  };
}

module.exports = { listProjects, getToken, tokenStatus, todayYmd, daysAgoYmd };
