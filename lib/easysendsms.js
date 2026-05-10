/**
 * Wrapper para a API REST da easysendsms.app
 *
 * Endpoint: https://restapi.easysendsms.app/v1/rest/sms/send
 * Auth:     header `apikey`
 * Body:     { from, to, text, type:"0" } (type=0 → text plain)
 *
 * Configuração via env:
 *   EASYSENDSMS_API_KEY    — chave da conta
 *   EASYSENDSMS_SENDER     — sender ID registado (default "Adicional")
 *   EASYSENDSMS_BASE_URL   — opcional (override do endpoint)
 *   SMS_DEFAULT_PREFIX     — prefixo para números 9 dígitos (default "258")
 *   SMS_DELAY_MS           — pausa entre envios em bulk (default 200ms)
 *   SMS_DRY_RUN            — se "1", NÃO chama a API (só simula); útil em testes
 *
 * O wrapper:
 *   - Normaliza números (remove não-dígitos, prepende prefixo se 9 dígitos)
 *   - Faz retry mínimo (1 vez) em erros de rede
 *   - Retorna { ok, providerId, providerResponse, normalizedTo, error }
 */

const API_URL_DEFAULT = "https://restapi.easysendsms.app/v1/rest/sms/send";

// Carrega config do .env (passa-se variáveis do node process)
function getConfig() {
  return {
    apiKey:  process.env.EASYSENDSMS_API_KEY || "",
    sender:  process.env.EASYSENDSMS_SENDER  || "Adicional",
    baseUrl: process.env.EASYSENDSMS_BASE_URL || API_URL_DEFAULT,
    prefix:  process.env.SMS_DEFAULT_PREFIX  || "258",
    delayMs: Number(process.env.SMS_DELAY_MS) || 200,
    dryRun:  process.env.SMS_DRY_RUN === "1",
  };
}

/**
 * Normaliza um nº de telefone:
 *   - Remove tudo que não for dígito
 *   - Se tiver 9 dígitos (formato MZ local), prepende prefixo (default 258)
 *   - Devolve null para inputs claramente inválidos (< 9 dígitos)
 */
function normalizePhone(raw, prefix = "258") {
  if (raw == null) return null;
  let n = String(raw).replace(/\D/g, "");
  if (!n) return null;
  if (n.length === 9) n = prefix + n;
  // Aceita números entre 9 e 15 dígitos pós-normalização
  if (n.length < 11 || n.length > 15) return null;
  return n;
}

/**
 * Envia 1 SMS.
 *
 * @param {object} input
 * @param {string} input.to    — nº (será normalizado)
 * @param {string} input.text  — corpo da mensagem
 * @param {string} [input.from] — sender (override do default)
 * @returns {Promise<{ ok, providerId?, providerResponse?, normalizedTo, error? }>}
 */
async function sendSms({ to, text, from }) {
  const cfg = getConfig();
  const normalizedTo = normalizePhone(to, cfg.prefix);
  if (!normalizedTo) {
    return { ok: false, normalizedTo: null, error: "Número inválido: " + to };
  }
  if (!text || !String(text).trim()) {
    return { ok: false, normalizedTo, error: "Mensagem vazia" };
  }
  const sender = from || cfg.sender;

  // Modo dry-run: simula sucesso sem chamar a API. Útil em testes.
  if (cfg.dryRun) {
    return {
      ok: true,
      normalizedTo,
      providerId: "dry-run-" + Date.now(),
      providerResponse: "[DRY RUN] " + text.slice(0, 60),
      dryRun: true,
    };
  }

  if (!cfg.apiKey) {
    return { ok: false, normalizedTo, error: "EASYSENDSMS_API_KEY não configurada" };
  }

  // Lazy-load fetch (Node 18+ tem global; antes via node-fetch)
  const fetchFn = (typeof fetch !== "undefined")
    ? fetch
    : (...args) => import("node-fetch").then(({ default: f }) => f(...args));

  const body = JSON.stringify({
    from: sender,
    to:   normalizedTo,
    text: String(text),
    type: "0",
  });

  // 1 retry em caso de erro de rede
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchFn(cfg.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: cfg.apiKey },
        body,
      });
      const responseText = await res.text();
      if (!res.ok) {
        return { ok: false, normalizedTo, error: `HTTP ${res.status}: ${responseText}`, providerResponse: responseText };
      }
      // O resultado pode ser JSON {status, messageIds, ...} (API REST nova),
      // {error, description} (em caso de falha) ou texto livre (legacy).
      let providerId = null;
      try {
        const json = JSON.parse(responseText);
        if (json.error) {
          return { ok: false, normalizedTo, error: `${json.error}: ${json.description || ""}`, providerResponse: responseText };
        }
        // Status diferente de "OK" → falha (mesmo com HTTP 200)
        if (json.status && String(json.status).toUpperCase() !== "OK") {
          return { ok: false, normalizedTo, error: `status=${json.status}`, providerResponse: responseText };
        }
        // Extrai message id: messageIds[0] é o formato actual da API REST.
        // Strip do prefixo "OK: " que a API anexa no UUID.
        if (Array.isArray(json.messageIds) && json.messageIds.length) {
          providerId = String(json.messageIds[0]).replace(/^OK:\s*/i, "");
        } else if (json.id || json.messageId) {
          providerId = json.id || json.messageId;
        }
      } catch (_) {
        if (String(responseText).trim().startsWith("ERROR")) {
          return { ok: false, normalizedTo, error: responseText.trim(), providerResponse: responseText };
        }
        // Resposta texto livre — assume sucesso e usa o conteúdo como provider id
        providerId = String(responseText).trim() || null;
      }
      return { ok: true, normalizedTo, providerId, providerResponse: responseText };
    } catch (e) {
      lastErr = e;
      if (attempt === 1) {
        // pequena pausa antes do retry
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
    }
  }
  return { ok: false, normalizedTo, error: "Falha de rede: " + (lastErr?.message || "desconhecido") };
}

/**
 * Envia SMS para vários destinatários, com pause entre envios.
 *
 * @param {Array<{to: string, text: string, meta?: object}>} messages
 * @param {function} [onProgress]  — callback (i, total, result)
 */
async function sendBulk(messages, onProgress) {
  const cfg = getConfig();
  const results = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const r = await sendSms({ to: msg.to, text: msg.text, from: msg.from });
    const enriched = { ...r, meta: msg.meta || null, originalTo: msg.to };
    results.push(enriched);
    if (typeof onProgress === "function") onProgress(i + 1, messages.length, enriched);
    if (i < messages.length - 1) {
      await new Promise((r) => setTimeout(r, cfg.delayMs));
    }
  }
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  return { results, ok, failed, total: results.length };
}

/**
 * Renderiza um template SMS substituindo placeholders {nome}, {qty}, etc.
 * Placeholders desconhecidos são substituídos por "" (não deixa "{x}" no texto).
 */
function renderTemplate(body, vars) {
  if (!body) return "";
  return String(body).replace(/\{(\w+)\}/g, (_, key) => {
    const v = vars && vars[key];
    return v == null ? "" : String(v);
  });
}

module.exports = {
  sendSms,
  sendBulk,
  normalizePhone,
  renderTemplate,
  getConfig,
};
