/**
 * audit-repo — queries da tabela delivery_audit (versão pro).
 *
 * Endpoints:
 *   - counts()                      → KPIs gerais (com WoW comparison)
 *   - rankSubmitters(opts)          → ranking + sparkline 7d + verif time
 *   - timeline(days)                → submissões/dia
 *   - listByUser(email)             → linhas de 1 utilizador
 *   - list(filters)                 → lista geral com filtros + pagination
 *   - lostRows(daysGap)             → linhas que desapareceram do sheet
 *   - missingDate()                 → linhas sem delivery_date
 *   - missingDateBySubmitter()      → % missing por submetedor
 *   - topDistricts() / topProducts()
 *   - anomalies()                   → utilizadores fora do padrão
 *   - statusHistory(auditId)
 *   - districtHeat()                → para mapa
 *   - planVsActual()                → cruza delivery_balances com audit
 */

const { query, queryOne } = require("./mysql");

// ── KPIs ────────────────────────────────────────────────────
async function counts() {
  const [r] = await query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN verification_status = 'Verified'              THEN 1 ELSE 0 END) AS verified,
       SUM(CASE WHEN verification_status = 'Pending Verification'  THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN verification_status = 'Rejected'              THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN verification_status = 'Not Reachable'         THEN 1 ELSE 0 END) AS not_reachable,
       SUM(CASE WHEN verification_status = 'Partially Verified'    THEN 1 ELSE 0 END) AS partial,
       SUM(CASE WHEN detected_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS last_24h,
       SUM(CASE WHEN detected_date = CURDATE() THEN 1 ELSE 0 END) AS today,
       SUM(CASE WHEN delivery_date_iso IS NULL OR delivery_date_iso = '' THEN 1 ELSE 0 END) AS no_date,
       SUM(CASE WHEN last_seen_at < DATE_SUB(NOW(), INTERVAL 2 DAY) THEN 1 ELSE 0 END) AS lost,
       COUNT(DISTINCT submitted_by) AS submitters,
       COUNT(DISTINCT district) AS districts,
       SUM(CASE WHEN detected_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY) THEN 1 ELSE 0 END) AS this_week,
       SUM(CASE WHEN detected_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
                AND detected_date <  DATE_SUB(CURDATE(), INTERVAL 7 DAY)  THEN 1 ELSE 0 END) AS prev_week
     FROM delivery_audit
     WHERE deleted_at IS NULL`
  );
  const num = (k) => Number((r || {})[k]) || 0;
  const thisWeek = num("this_week");
  const prevWeek = num("prev_week");
  const wowDelta = prevWeek > 0 ? ((thisWeek - prevWeek) / prevWeek) * 100 : (thisWeek > 0 ? 100 : 0);
  return {
    total: num("total"), verified: num("verified"), pending: num("pending"),
    rejected: num("rejected"), not_reachable: num("not_reachable"), partial: num("partial"),
    last_24h: num("last_24h"), today: num("today"), no_date: num("no_date"), lost: num("lost"),
    submitters: num("submitters"), districts: num("districts"),
    this_week: thisWeek, prev_week: prevWeek,
    wow_delta_pct: Math.round(wowDelta * 10) / 10,
  };
}

// ── Ranking de submetedores com sparkline + verif time ─────
async function rankSubmitters(opts = {}) {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 50));
  const rows = await query(
    `SELECT
       submitted_by AS email,
       COUNT(*) AS total,
       SUM(CASE WHEN verification_status = 'Verified'             THEN 1 ELSE 0 END) AS verified,
       SUM(CASE WHEN verification_status = 'Pending Verification' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN verification_status = 'Rejected'             THEN 1 ELSE 0 END) AS rejected,
       SUM(CASE WHEN verification_status = 'Not Reachable'        THEN 1 ELSE 0 END) AS not_reachable,
       SUM(CASE WHEN verification_status = 'Partially Verified'   THEN 1 ELSE 0 END) AS partial,
       SUM(CASE WHEN detected_date = CURDATE() THEN 1 ELSE 0 END) AS today,
       MIN(detected_at) AS first_seen,
       MAX(detected_at) AS last_seen,
       SUM(delivered_qty) AS qty_total,
       SUM(CASE WHEN delivery_date_iso IS NULL OR delivery_date_iso = '' THEN 1 ELSE 0 END) AS no_date,
       AVG(CASE WHEN status_changed_at IS NOT NULL AND verification_status = 'Verified'
                THEN TIMESTAMPDIFF(HOUR, detected_at, status_changed_at) END) AS avg_verif_hours
     FROM delivery_audit
     WHERE submitted_by IS NOT NULL AND submitted_by <> ''
       AND deleted_at IS NULL
     GROUP BY submitted_by
     ORDER BY total DESC
     LIMIT ${limit}`
  );

  // Sparkline 7d para cada submetedor — 1 query por todos
  const emails = rows.map((r) => r.email);
  if (emails.length) {
    const placeholders = emails.map(() => "?").join(",");
    const spark = await query(
      `SELECT submitted_by AS email, detected_date, COUNT(*) AS n
       FROM delivery_audit
       WHERE submitted_by IN (${placeholders})
         AND detected_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
         AND deleted_at IS NULL
       GROUP BY submitted_by, detected_date`,
      emails
    );
    const byEmail = new Map();
    for (const s of spark) {
      if (!byEmail.has(s.email)) byEmail.set(s.email, {});
      byEmail.get(s.email)[String(s.detected_date)] = Number(s.n);
    }
    // Constrói array de 7 valores [-6, -5, ..., 0] para cada email
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (const r of rows) {
      const map = byEmail.get(r.email) || {};
      const arr = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        arr.push(map[key] || 0);
      }
      r.sparkline = arr;
    }
  }
  return rows;
}

// ── Timeline diária ────────────────────────────────────────
async function timeline(days = 30) {
  const d = Math.max(1, Math.min(180, Number(days) || 30));
  return await query(
    `SELECT detected_date AS date,
            COUNT(*) AS total,
            COUNT(DISTINCT submitted_by) AS submitters,
            SUM(CASE WHEN verification_status = 'Verified'             THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN verification_status = 'Pending Verification' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN verification_status = 'Rejected'             THEN 1 ELSE 0 END) AS rejected
     FROM delivery_audit
     WHERE detected_date >= DATE_SUB(CURDATE(), INTERVAL ${d} DAY)
       AND deleted_at IS NULL
     GROUP BY detected_date ORDER BY detected_date ASC`
  );
}

// ── Lista detalhada com filtros + pagination ────────────────
async function list(opts = {}) {
  const where = [];
  const params = [];
  if (opts.submitter) { where.push("submitted_by = ?");          params.push(opts.submitter); }
  if (opts.status)    { where.push("verification_status = ?");   params.push(opts.status); }
  if (opts.district)  { where.push("district = ?");              params.push(opts.district); }
  if (opts.product) {
    where.push("product LIKE ?");
    params.push("%" + opts.product + "%");
  }
  // Filtra por delivery_date_iso (alinhado com byDayPerSubmitter). Rows sem data
  // preenchida no formulário ficam fora do drill-down — esperado, são excluídas
  // do ranking também. Para ver rows sem data usa a tab "Sem data" do admin.
  if (opts.from)      { where.push("delivery_date_iso >= ?"); params.push(opts.from); }
  if (opts.to)        { where.push("delivery_date_iso <= ?"); params.push(opts.to); }
  if (opts.q) {
    const term = "%" + opts.q + "%";
    where.push("(gtu LIKE ? OR adsn LIKE ? OR beneficiary_name LIKE ?)");
    params.push(term, term, term);
  }
  // Por default exclui rows marcadas como deleted (submissões apagadas da
  // sheet). Para ver rows apagadas (auditoria), passa opts.include_deleted=true.
  if (!opts.include_deleted) where.push("deleted_at IS NULL");
  const w = where.length ? "WHERE " + where.join(" AND ") : "";

  // Pagination
  const page = Math.max(1, Number(opts.page) || 1);
  const pageSize = Math.max(1, Math.min(500, Number(opts.pageSize) || 50));
  const offset = (page - 1) * pageSize;

  const [{ total }] = await query(`SELECT COUNT(*) AS total FROM delivery_audit ${w}`, params);
  const rows = await query(
    `SELECT id, dedup_key, gtu, adsn, beneficiary_name, extensionist_id,
            product, delivered_qty, packages, unit, district, province,
            submitted_by, delivery_date_iso, verification_status,
            detected_at, detected_date, status_changed_at, last_seen_at
     FROM delivery_audit ${w}
     ORDER BY detected_at DESC
     LIMIT ${pageSize} OFFSET ${offset}`,
    params
  );
  return {
    rows, total: Number(total) || 0, page, pageSize,
    totalPages: Math.ceil((Number(total) || 0) / pageSize),
  };
}

// ── Linhas perdidas (last_seen_at antigo) ───────────────────
async function lostRows(opts = {}) {
  const days = Math.max(1, Math.min(60, Number(opts.daysGap) || 2));
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
  const rows = await query(
    `SELECT *,
            DATEDIFF(NOW(), last_seen_at) AS days_lost
     FROM delivery_audit
     WHERE last_seen_at < DATE_SUB(NOW(), INTERVAL ${days} DAY)
     ORDER BY last_seen_at DESC
     LIMIT ${limit}`
  );
  return rows;
}

// ── Linhas sem delivery_date ───────────────────────────────
async function missingDate(opts = {}) {
  const limit = Math.max(1, Math.min(2000, Number(opts.limit) || 500));
  return await query(
    `SELECT * FROM delivery_audit
     WHERE delivery_date_iso IS NULL OR delivery_date_iso = ''
     ORDER BY detected_at DESC
     LIMIT ${limit}`
  );
}

async function missingDateBySubmitter() {
  return await query(
    `SELECT submitted_by AS email,
            COUNT(*) AS total,
            SUM(CASE WHEN delivery_date_iso IS NULL OR delivery_date_iso = '' THEN 1 ELSE 0 END) AS no_date,
            ROUND(100 * SUM(CASE WHEN delivery_date_iso IS NULL OR delivery_date_iso = '' THEN 1 ELSE 0 END)
                  / COUNT(*), 1) AS pct_no_date
     FROM delivery_audit
     WHERE submitted_by IS NOT NULL AND submitted_by <> ''
     GROUP BY submitted_by
     HAVING no_date > 0
     ORDER BY pct_no_date DESC, no_date DESC
     LIMIT 50`
  );
}

// ── Top distritos / produtos ───────────────────────────────
async function topDistricts(limit = 15) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 15));
  return await query(
    `SELECT district, province, COUNT(*) AS total,
            SUM(delivered_qty) AS qty_total,
            COUNT(DISTINCT submitted_by) AS submitters
     FROM delivery_audit
     WHERE district IS NOT NULL AND district <> ''
       AND deleted_at IS NULL
     GROUP BY district, province
     ORDER BY total DESC LIMIT ${lim}`
  );
}

async function topProducts(limit = 10) {
  const lim = Math.max(1, Math.min(50, Number(limit) || 10));
  return await query(
    `SELECT product, unit, COUNT(*) AS total,
            SUM(delivered_qty) AS qty_total
     FROM delivery_audit
     WHERE product IS NOT NULL AND product <> ''
       AND deleted_at IS NULL
     GROUP BY product, unit
     ORDER BY total DESC LIMIT ${lim}`
  );
}

// ── Anomalias (utilizadores fora do padrão) ─────────────────
async function anomalies() {
  // Heurística simples:
  //   - High burst: hoje > 3× a média dos últimos 7 dias
  //   - Inactive: usualmente activo, sem submeter há >3 dias
  return await query(
    `WITH daily AS (
       SELECT submitted_by,
              detected_date,
              COUNT(*) AS n
       FROM delivery_audit
       WHERE submitted_by IS NOT NULL AND submitted_by <> ''
         AND detected_date >= DATE_SUB(CURDATE(), INTERVAL 14 DAY)
         AND deleted_at IS NULL
       GROUP BY submitted_by, detected_date
     ),
     stats AS (
       SELECT submitted_by,
              AVG(n) AS avg_per_day,
              MAX(detected_date) AS last_active,
              COUNT(DISTINCT detected_date) AS active_days_14d
       FROM daily
       GROUP BY submitted_by
     ),
     today_count AS (
       SELECT submitted_by, COUNT(*) AS today_n
       FROM delivery_audit
       WHERE detected_date = CURDATE()
       GROUP BY submitted_by
     )
     SELECT s.submitted_by AS email,
            s.avg_per_day, s.active_days_14d, s.last_active,
            COALESCE(t.today_n, 0) AS today_n,
            DATEDIFF(CURDATE(), s.last_active) AS days_inactive,
            CASE
              WHEN COALESCE(t.today_n, 0) > GREATEST(s.avg_per_day * 3, 5) THEN 'high_burst'
              WHEN s.active_days_14d >= 5 AND DATEDIFF(CURDATE(), s.last_active) >= 3 THEN 'inactive'
            END AS flag
     FROM stats s
     LEFT JOIN today_count t ON t.submitted_by = s.submitted_by
     HAVING flag IS NOT NULL
     ORDER BY (flag = 'high_burst') DESC, days_inactive DESC
     LIMIT 20`
  );
}

// ── Histórico de mudanças de status ─────────────────────────
async function statusHistory(auditId) {
  return await query(
    `SELECT * FROM delivery_audit_history
     WHERE audit_id = ?
     ORDER BY changed_at DESC`,
    [auditId]
  );
}

// ── Matriz batedor × dia ──────────────────────────────────
// Devolve uma vista cruzada onde cada submetedor tem:
//   { email, total_kg, total, by_day: { '2026-05-08': {kg, n, kg_verified, kg_pending, kg_rejected}, ... } }
// + meta com a lista de dias do período (eixo X)
//
// O campo principal é "kg" (total entregue). "n" (número de submissões) fica como
// secundário para tooltips e drill-down.
async function byDayPerSubmitter(arg = 14) {
  // Aceita duas formas:
  //   • Number (legacy): N dias até hoje
  //   • Object: { days } (mesmo que number) OU { from, to } (datas absolutas YYYY-MM-DD)
  const opts = typeof arg === "number" ? { days: arg } : (arg || {});

  // Helper local para gerar YYYY-MM-DD a partir de Date (componentes LOCAIS)
  const ymd = (dt) => {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const dd = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  };

  // Constrói a lista de dias do eixo X
  let dayList = [];
  let fromDate, toDate;
  if (opts.from && opts.to) {
    // Modo datas absolutas
    fromDate = String(opts.from).slice(0, 10);
    toDate   = String(opts.to).slice(0, 10);
    if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
    const a = new Date(fromDate + "T00:00:00");
    const b = new Date(toDate + "T00:00:00");
    let safety = 0;
    for (let d = new Date(a); d <= b && safety < 400; d.setDate(d.getDate() + 1)) {
      dayList.push(ymd(d));
      safety++;
    }
    // cap a 365 dias para evitar abuso
    if (dayList.length > 365) dayList = dayList.slice(-365);
    fromDate = dayList[0];
    toDate   = dayList[dayList.length - 1];
  } else {
    // Modo "últimos N dias"
    const d = Math.max(1, Math.min(90, Number(opts.days) || 14));
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = d - 1; i >= 0; i--) {
      const dt = new Date(today);
      dt.setDate(dt.getDate() - i);
      dayList.push(ymd(dt));
    }
    fromDate = dayList[0];
    toDate   = dayList[dayList.length - 1];
  }

  // 1. Linhas raw: 1 row por (submitter, day)
  // Usa SOMENTE delivery_date_iso (data real da entrega no formulário).
  // Rows sem delivery_date_iso preenchido são EXCLUÍDAS — caso contrário, em
  // arranques frios da DB (ex. primeira captura em prod), todas essas rows
  // caíam para detected_date=hoje e inflavam massivamente o "hoje" do ranking.
  // Em dev isto não aparecia porque a captura era progressiva ao longo de dias.
  const rows = await query(
    `SELECT submitted_by AS email,
            delivery_date_iso AS date,
            COUNT(*) AS n,
            COALESCE(SUM(delivered_qty), 0) AS kg,
            COALESCE(SUM(CASE WHEN verification_status = 'Verified'             THEN delivered_qty ELSE 0 END), 0) AS kg_verified,
            COALESCE(SUM(CASE WHEN verification_status = 'Pending Verification' THEN delivered_qty ELSE 0 END), 0) AS kg_pending,
            COALESCE(SUM(CASE WHEN verification_status = 'Rejected'             THEN delivered_qty ELSE 0 END), 0) AS kg_rejected
     FROM delivery_audit
     WHERE submitted_by IS NOT NULL AND submitted_by <> ''
       AND delivery_date_iso IS NOT NULL
       AND delivery_date_iso BETWEEN ? AND ?
       AND deleted_at IS NULL
     GROUP BY submitted_by, delivery_date_iso`,
    [fromDate, toDate]
  );

  // 3. Agrupar por email
  const byEmail = new Map();
  for (const r of rows) {
    const date = r.date instanceof Date ? ymd(r.date) : String(r.date);
    if (!byEmail.has(r.email)) {
      byEmail.set(r.email, {
        email: r.email,
        total: 0, total_kg: 0,
        kg_verified: 0, kg_pending: 0, kg_rejected: 0,
        by_day: {},
      });
    }
    const entry = byEmail.get(r.email);
    entry.by_day[date] = {
      n: Number(r.n) || 0,
      kg: Number(r.kg) || 0,
      kg_verified: Number(r.kg_verified) || 0,
      kg_pending: Number(r.kg_pending) || 0,
      kg_rejected: Number(r.kg_rejected) || 0,
    };
    entry.total       += Number(r.n) || 0;
    entry.total_kg    += Number(r.kg) || 0;
    entry.kg_verified += Number(r.kg_verified) || 0;
    entry.kg_pending  += Number(r.kg_pending)  || 0;
    entry.kg_rejected += Number(r.kg_rejected) || 0;
  }

  // 4. Meta: totais por dia (linha "Total" no fim)
  const dayTotals = {};
  for (const day of dayList) {
    let n = 0, kg = 0, kgV = 0, kgP = 0, kgR = 0;
    for (const u of byEmail.values()) {
      const c = u.by_day[day];
      if (c) { n += c.n; kg += c.kg; kgV += c.kg_verified; kgP += c.kg_pending; kgR += c.kg_rejected; }
    }
    dayTotals[day] = { n, kg, kg_verified: kgV, kg_pending: kgP, kg_rejected: kgR };
  }

  return {
    days: dayList,
    submitters: [...byEmail.values()].sort((a, b) => b.total_kg - a.total_kg),
    day_totals: dayTotals,
  };
}

// ── District heat (para mapa) ───────────────────────────────
async function districtHeat() {
  return await query(
    `SELECT district, province, COUNT(*) AS total,
            SUM(CASE WHEN verification_status = 'Verified' THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN verification_status = 'Pending Verification' THEN 1 ELSE 0 END) AS pending,
            COUNT(DISTINCT submitted_by) AS submitters
     FROM delivery_audit
     WHERE district IS NOT NULL AND district <> ''
       AND deleted_at IS NULL
     GROUP BY district, province
     ORDER BY total DESC`
  );
}

// ── Plano (MAAP) vs Real (audit) ───────────────────────────
async function planVsActual() {
  // Cruza beneficiaries planeados (delivery_balances) com audit por
  // distrito + produto (canónicos) — mostra falta entregar e excessos
  return await query(
    `SELECT
       b.district,
       b.province,
       CASE
         WHEN db.product_name LIKE '%Milho%' THEN 'Milho'
         WHEN db.product_name LIKE '%Feij%' THEN 'Feijão'
         WHEN db.product_name LIKE '%Arroz%' THEN 'Arroz'
         ELSE COALESCE(db.product_name, db.sku)
       END AS produto,
       SUM(db.planned_qty) AS planeado,
       COALESCE(SUM(da.delivered_qty), 0) AS submetido,
       SUM(db.planned_qty) - COALESCE(SUM(da.delivered_qty), 0) AS falta_kg,
       COUNT(DISTINCT db.extensionist_id) AS n_planeados,
       COUNT(DISTINCT da.extensionist_id) AS n_submetidos
     FROM delivery_balances db
     INNER JOIN beneficiaries b ON b.extensionist_id = db.extensionist_id
     LEFT JOIN delivery_audit da
       ON da.district = b.district
       AND CASE
         WHEN db.product_name LIKE '%Milho%' THEN 'Milho'
         WHEN db.product_name LIKE '%Feij%' THEN 'Feijão'
         WHEN db.product_name LIKE '%Arroz%' THEN 'Arroz'
         ELSE COALESCE(db.product_name, db.sku)
       END = CASE
         WHEN da.product LIKE '%Maize%' OR da.product LIKE '%Milho%' THEN 'Milho'
         WHEN da.product LIKE '%Bean%'  OR da.product LIKE '%Feij%'  THEN 'Feijão'
         WHEN da.product LIKE '%Rice%'  OR da.product LIKE '%Arroz%' THEN 'Arroz'
         ELSE da.product
       END
     WHERE db.planned_qty > 0
     GROUP BY b.district, b.province, produto
     HAVING produto IN ('Milho', 'Feijão', 'Arroz')
     ORDER BY planeado DESC`
  );
}

const Audit = {
  counts, rankSubmitters, timeline, list,
  lostRows, missingDate, missingDateBySubmitter,
  topDistricts, topProducts, anomalies,
  statusHistory, districtHeat, planVsActual,
  byDayPerSubmitter,
};

module.exports = { Audit };
