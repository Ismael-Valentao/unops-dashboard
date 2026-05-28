/**
 * Snapshots diários de delivery_audit.
 *
 * Clona o estado de delivery_audit (apenas rows com deleted_at IS NULL)
 * para a tabela delivery_audit_snapshots, etiquetando todas com a data
 * do snapshot. Permite reconstruir o "estado da Sheet" em qualquer dia
 * histórico, mesmo que a sheet remota mude/perca dados ou que o
 * audit-capture marque rows como deleted_at por engano (já aconteceu
 * quando a UNOPS criou aba duplicada "Delivery" e o sweep marcou
 * ~1100 rows como apagadas).
 *
 * Chamado pelo scheduler em app.js todos os dias às 00:00. Idempotente:
 * a UNIQUE (snapshot_date, dedup_key) garante que executar 2× no mesmo
 * dia faz UPDATE em vez de duplicar.
 *
 * Retenção: 365 dias por defeito (configurável via env
 * AUDIT_SNAPSHOT_RETENTION_DAYS). Rotação corre no fim de cada captura.
 */

const { query, getPool } = require("../db/mysql");

/**
 * Snapshot do estado actual de delivery_audit para a data dada.
 * Idempotente.
 *
 * @param {string} [dateStr] — "YYYY-MM-DD"; default = hoje (timezone local)
 * @returns {Promise<{snapshot_date, rows_captured, took_ms}>}
 */
async function captureDailySnapshot(dateStr) {
  const t0 = Date.now();
  const date = dateStr || _todayIso();

  // INSERT ... SELECT clona o snapshot da delivery_audit activa.
  // ON DUPLICATE KEY UPDATE permite re-correr no mesmo dia (refresh).
  const sql = `
    INSERT INTO delivery_audit_snapshots
      (snapshot_date, dedup_key, audit_id, gtu, adsn, beneficiary_name,
       extensionist_id, nuit, product, delivered_qty, packages, unit,
       district, province, submitted_by, delivery_date_iso,
       verification_status, detected_at, raw_data, captured_at)
    SELECT
      ?, dedup_key, id, gtu, adsn, beneficiary_name,
      extensionist_id, nuit, product, delivered_qty, packages, unit,
      district, province, submitted_by, delivery_date_iso,
      verification_status, detected_at, raw_data, NOW()
    FROM delivery_audit
    WHERE deleted_at IS NULL
    ON DUPLICATE KEY UPDATE
      audit_id            = VALUES(audit_id),
      gtu                 = VALUES(gtu),
      adsn                = VALUES(adsn),
      beneficiary_name    = VALUES(beneficiary_name),
      extensionist_id     = VALUES(extensionist_id),
      nuit                = VALUES(nuit),
      product             = VALUES(product),
      delivered_qty       = VALUES(delivered_qty),
      packages            = VALUES(packages),
      unit                = VALUES(unit),
      district            = VALUES(district),
      province            = VALUES(province),
      submitted_by        = VALUES(submitted_by),
      delivery_date_iso   = VALUES(delivery_date_iso),
      verification_status = VALUES(verification_status),
      detected_at         = VALUES(detected_at),
      raw_data            = VALUES(raw_data),
      captured_at         = NOW()
  `;
  const [res] = await getPool().query(sql, [date]);
  const rowsCaptured = res.affectedRows || 0;

  // Rotação (retenção) — apaga snapshots mais velhos que N dias
  const retentionDays = Number(process.env.AUDIT_SNAPSHOT_RETENTION_DAYS) || 365;
  try {
    const [del] = await getPool().query(
      "DELETE FROM delivery_audit_snapshots WHERE snapshot_date < DATE_SUB(?, INTERVAL ? DAY)",
      [date, retentionDays]
    );
    if (del.affectedRows > 0) {
      console.log(`[snapshot] rotação: ${del.affectedRows} rows antigas removidas (> ${retentionDays}d)`);
    }
  } catch (e) {
    console.warn("[snapshot] rotação falhou (non-fatal):", e.message);
  }

  const took = Date.now() - t0;
  console.log(`[snapshot] ${date}: ${rowsCaptured} rows clonadas de delivery_audit em ${took}ms`);
  return { snapshot_date: date, rows_captured: rowsCaptured, took_ms: took };
}

/**
 * Conta quantos snapshots existem, por data — útil para diagnóstico.
 */
async function listSnapshotDates() {
  const rows = await query(
    `SELECT snapshot_date, COUNT(*) AS rows_count, MAX(captured_at) AS last_captured_at
     FROM delivery_audit_snapshots
     GROUP BY snapshot_date
     ORDER BY snapshot_date DESC
     LIMIT 30`
  );
  return rows;
}

/**
 * Devolve as rows de snapshot de uma data específica. Útil para
 * restauração manual via script CLI.
 */
async function getSnapshotForDate(dateStr) {
  return query(
    "SELECT * FROM delivery_audit_snapshots WHERE snapshot_date = ? ORDER BY id",
    [dateStr]
  );
}

function _todayIso() {
  const d = new Date();
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

module.exports = { captureDailySnapshot, listSnapshotDates, getSnapshotForDate };
