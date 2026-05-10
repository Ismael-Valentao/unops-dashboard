/**
 * SMS — repositório com:
 *   - Templates    (plan / arriving / delivered / custom)
 *   - Log          (1 row por SMS tentado, com status e provider response)
 *   - Helpers      (build vars de um serviço, send-and-log)
 *
 * Schema vive em db/mysql.js (migração idempotente).
 *
 * Quando um SMS é enviado, criamos primeiro a row em sms_log com
 * status='queued', depois chamamos a API, depois actualizamos para
 * 'sent' ou 'failed'. Isto garante histórico mesmo em caso de crash.
 */

const { query, queryOne } = require("./mysql");
const { sendSms, renderTemplate, normalizePhone, getConfig } = require("../lib/easysendsms");

// ── Templates ────────────────────────────────────────────────
const Templates = {
  async list() {
    return await query("SELECT * FROM sms_templates ORDER BY FIELD(kind,'plan','arriving','delivered','custom'), name");
  },
  async byId(id) {
    return await queryOne("SELECT * FROM sms_templates WHERE id = ?", [id]);
  },
  async byKind(kind) {
    // Devolve o primeiro template enabled deste tipo (pode haver vários custom)
    return await queryOne(
      "SELECT * FROM sms_templates WHERE kind = ? AND enabled = 1 ORDER BY id ASC LIMIT 1",
      [kind]
    );
  },
  async update(id, patch, userId = null) {
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new Error("Nome obrigatório");
      sets.push("name = ?"); params.push(n);
    }
    if (patch.body !== undefined) {
      const b = String(patch.body).trim();
      if (!b) throw new Error("Corpo obrigatório");
      sets.push("body = ?"); params.push(b);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?"); params.push(patch.enabled ? 1 : 0);
    }
    if (!sets.length) return await this.byId(id);
    sets.push("updated_by = ?"); params.push(userId);
    params.push(id);
    await query(`UPDATE sms_templates SET ${sets.join(", ")} WHERE id = ?`, params);
    return await this.byId(id);
  },
  async create(input, userId = null) {
    const name = String(input.name || "").trim();
    const body = String(input.body || "").trim();
    if (!name || !body) throw new Error("Nome e corpo obrigatórios");
    const kind = ["plan", "arriving", "delivered", "custom"].includes(input.kind) ? input.kind : "custom";
    const r = await query(
      "INSERT INTO sms_templates (kind, name, body, enabled, updated_by) VALUES (?, ?, ?, 1, ?)",
      [kind, name, body, userId]
    );
    return await this.byId(r.insertId);
  },
};

// ── Log ──────────────────────────────────────────────────────
const Log = {
  /**
   * Lista log de SMS com filtros.
   *
   * @param {object} opts
   * @param {string|string[]} [opts.status]
   * @param {string} [opts.related_kind]
   * @param {string} [opts.related_id]
   * @param {string} [opts.template_kind]
   * @param {string} [opts.beneficiary_id]
   * @param {number} [opts.limit] default 200
   */
  async list(opts = {}) {
    const where = [];
    const params = [];
    if (opts.status) {
      const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
      where.push(`status IN (${arr.map(() => "?").join(",")})`);
      params.push(...arr);
    }
    if (opts.related_kind) { where.push("related_kind = ?"); params.push(opts.related_kind); }
    if (opts.related_id)   { where.push("related_id = ?");   params.push(String(opts.related_id)); }
    if (opts.template_kind) { where.push("template_kind = ?"); params.push(opts.template_kind); }
    if (opts.beneficiary_id) { where.push("beneficiary_id = ?"); params.push(opts.beneficiary_id); }
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const limit = Math.max(1, Math.min(1000, Number(opts.limit) || 200));
    return await query(
      `SELECT l.*, u.email AS sent_by_email
       FROM sms_log l
       LEFT JOIN users u ON u.id = l.sent_by
       ${w}
       ORDER BY l.created_at DESC
       LIMIT ${limit}`,
      params
    );
  },

  async counts() {
    const r = await query(
      `SELECT
         SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN dry_run = 1       THEN 1 ELSE 0 END) AS dry_runs,
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS last_24h
       FROM sms_log`
    ).catch(async () => {
      // FILTER WHERE não é universal; fallback compatível
      return await query(
        `SELECT
           SUM(CASE WHEN status = 'sent'   THEN 1 ELSE 0 END) AS sent,
           SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
           SUM(CASE WHEN dry_run = 1       THEN 1 ELSE 0 END) AS dry_runs,
           COUNT(*) AS total,
           SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS last_24h
         FROM sms_log`
      );
    });
    const row = r[0] || {};
    return {
      total:    Number(row.total)    || 0,
      sent:     Number(row.sent)     || 0,
      failed:   Number(row.failed)   || 0,
      queued:   Number(row.queued)   || 0,
      dry_runs: Number(row.dry_runs) || 0,
      last_24h: Number(row.last_24h) || 0,
    };
  },

  /** Verifica se já existe um SMS enviado com sucesso para (related, benef, kind). */
  async wasSent(related_kind, related_id, beneficiary_id, template_kind) {
    const r = await query(
      `SELECT id, sent_at FROM sms_log
       WHERE related_kind = ? AND related_id = ? AND beneficiary_id = ?
         AND template_kind = ? AND status = 'sent'
       ORDER BY sent_at DESC LIMIT 1`,
      [related_kind, String(related_id), beneficiary_id, template_kind]
    );
    return r[0] || null;
  },
};

// ── Send + log ───────────────────────────────────────────────

/**
 * Envia 1 SMS e regista no log. Idempotente em caso de erro: a row
 * é sempre criada (com status='failed' se a API falhar).
 *
 * @param {object} input
 * @param {string} input.to
 * @param {string} input.text
 * @param {string} [input.template_kind]
 * @param {number} [input.template_id]
 * @param {string} [input.beneficiary_id]
 * @param {string} [input.beneficiary_name]
 * @param {string} [input.related_kind]
 * @param {string} [input.related_id]
 * @param {number} [input.sent_by]   — userId
 */
async function sendAndLog(input) {
  const cfg = getConfig();
  // 1. Cria row 'queued'
  const insert = await query(
    `INSERT INTO sms_log
       (template_id, template_kind, beneficiary_id, beneficiary_name,
        phone_raw, phone_normalized, message, status, related_kind, related_id, sent_by, dry_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    [
      input.template_id || null,
      input.template_kind || "adhoc",
      input.beneficiary_id || null,
      input.beneficiary_name || null,
      input.to,
      normalizePhone(input.to, cfg.prefix),
      input.text,
      input.related_kind || null,
      input.related_id ? String(input.related_id) : null,
      input.sent_by || null,
      cfg.dryRun ? 1 : 0,
    ]
  );
  const logId = insert.insertId;

  // 2. Tenta enviar via API
  const r = await sendSms({ to: input.to, text: input.text });

  // 3. Actualiza com resultado
  if (r.ok) {
    await query(
      `UPDATE sms_log SET status='sent', provider_id=?, provider_response=?, sent_at=NOW(),
                          phone_normalized = COALESCE(?, phone_normalized)
       WHERE id = ?`,
      [r.providerId || null, r.providerResponse || null, r.normalizedTo || null, logId]
    );
  } else {
    await query(
      `UPDATE sms_log SET status='failed', error_message=?, provider_response=?, sent_at=NOW(),
                          phone_normalized = COALESCE(?, phone_normalized)
       WHERE id = ?`,
      [r.error || "unknown", r.providerResponse || null, r.normalizedTo || null, logId]
    );
  }

  return {
    log_id: logId,
    ok: r.ok,
    error: r.error || null,
    provider_id: r.providerId || null,
    normalizedTo: r.normalizedTo || null,
    dry_run: !!cfg.dryRun,
  };
}

/**
 * Constrói as variáveis para o template a partir de um serviço (e benef).
 *
 * @param {object} svc — delivery_services row + items grouped per benef
 * @param {object} benef — { extensionist_id, beneficiary_name, contact, items, total_kg, ... }
 * @returns {object} vars para renderTemplate
 */
function buildServiceVars(svc, benef) {
  const itemsTxt = (benef.items || []).map((it) => {
    const qty = Number(it.qty) || 0;
    const u = it.unit || "kg";
    const name = it.product_name || it.sku || "";
    return `${name} ${qty}${u}`;
  }).join(", ");

  return {
    nome: (benef.beneficiary_name || "").split(/\s+/).slice(0, 2).join(" ") || "extensionista",
    nome_completo: benef.beneficiary_name || "",
    items: itemsTxt || "—",
    qty: Number(benef.total_kg) || 0,
    produto: (benef.items && benef.items[0]) ? (benef.items[0].product_name || benef.items[0].sku) : "",
    matricula: svc.truck_plate || "—",
    distrito: benef.district || svc.district || "—",
    provincia: benef.province || svc.province || "—",
    motorista: svc.driver_name || "—",
    motorista_tel: svc.driver_phone ? formatMzPhone(svc.driver_phone) : "",
    servico: svc.service_number || "",
    data: new Date().toLocaleDateString("pt-MZ"),
  };
}

/**
 * Constrói as variáveis para o template de SUPERVISOR.
 *
 * Supervisor é uma pessoa diferente do extensionista — coordena vários
 * extensionistas numa zona. Cada beneficiary tem `supervisor_name` e
 * `supervisor_phone`. Para um serviço, derivamos os supervisores únicos
 * agregando os benefs por (supervisor_name, supervisor_phone).
 *
 * @param {object} svc — delivery_services com beneficiaries[]
 * @param {object} sup — { name, phone, benefs: [...] }
 *   benefs é o array de benefs SOB este supervisor
 * @returns {object} vars para renderTemplate
 */
function buildSupervisorVars(svc, sup) {
  const benefs = sup.benefs || [];
  const totalKg = benefs.reduce((s, b) => s + (Number(b.total_kg) || 0), 0);
  const districts = [...new Set(benefs.map((b) => b.district).filter(Boolean))];
  const distritoTxt = districts.length === 1 ? districts[0] : districts.join(", ");
  return {
    nome: (sup.name || "").split(/\s+/).slice(0, 2).join(" ") || "supervisor",
    nome_completo: sup.name || "",
    n_extensionistas: benefs.length,
    total_kg: Math.round(totalKg),
    distrito: distritoTxt || svc.district || "—",
    provincia: svc.province || "—",
    matricula: svc.truck_plate || "—",
    motorista: svc.driver_name || "—",
    motorista_tel: svc.driver_phone ? formatMzPhone(svc.driver_phone) : "",
    servico: svc.service_number || "",
    data: new Date().toLocaleDateString("pt-MZ"),
  };
}

/**
 * Extrai supervisores únicos do serviço com os benefs sob cada um.
 *
 * @param {object} svc — com beneficiaries[]
 * @returns {Array<{ name, phone, benefs: [...] }>}
 */
function extractSupervisors(svc) {
  const map = new Map(); // key "name|phone" → supervisor
  for (const b of (svc.beneficiaries || [])) {
    const name = (b.supervisor_name || "").trim();
    const phone = (b.supervisor_phone || "").trim();
    if (!name && !phone) continue;            // benef sem supervisor → skip
    if (!phone) continue;                      // sem telefone, não há como notificar
    const key = `${name}|${phone}`;
    if (!map.has(key)) map.set(key, { name, phone, benefs: [] });
    map.get(key).benefs.push(b);
  }
  return [...map.values()];
}

function formatMzPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length === 9) return d.slice(0, 2) + " " + d.slice(2, 5) + " " + d.slice(5);
  if (d.length === 12 && d.startsWith("258")) return "+258 " + d.slice(3, 5) + " " + d.slice(5, 8) + " " + d.slice(8);
  return raw;
}

module.exports = {
  Templates,
  Log,
  sendAndLog,
  buildServiceVars,
  buildSupervisorVars,
  extractSupervisors,
  // Re-exports úteis
  renderTemplate,
};
