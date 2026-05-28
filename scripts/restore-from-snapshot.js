/**
 * Restaurar delivery_audit a partir de um snapshot diário.
 *
 * USO:
 *   node scripts/restore-from-snapshot.js 2026-05-27       # preview (dry-run)
 *   node scripts/restore-from-snapshot.js 2026-05-27 --apply
 *
 * Cenários de uso:
 *   - audit-capture marcou ~1100 rows como deleted_at por engano
 *     (sheet remota corrompida, falha de rede, etc.)
 *   - quer ver o estado de delivery_audit num dia específico
 *
 * Comportamento (com --apply):
 *   - Para cada row no snapshot da data dada:
 *     - Se delivery_audit tem dedup_key → UPDATE (ressuscita: deleted_at = NULL,
 *       last_seen_at = NOW(), refresh dos campos do snapshot)
 *     - Se NÃO tem → INSERT (raro: row apagada FISICAMENTE, vamos restaurar)
 *   - Não toca rows em delivery_audit que NÃO estavam no snapshot (preserva
 *     submissões mais recentes).
 *
 * Sem --apply: imprime quantas rows seriam afectadas, sem mexer em nada.
 */

const path = require("path");
process.chdir(path.join(__dirname, ".."));
require("dotenv").config();

const { query, getPool } = require("../db/mysql");

async function main() {
  const dateArg = process.argv[2];
  const apply = process.argv.includes("--apply");

  if (!dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
    console.error("USO: node scripts/restore-from-snapshot.js YYYY-MM-DD [--apply]");
    process.exit(1);
  }

  // 1. Stats do snapshot
  const [snap] = await getPool().query(
    "SELECT COUNT(*) AS n FROM delivery_audit_snapshots WHERE snapshot_date = ?",
    [dateArg]
  );
  const snapCount = snap[0].n;
  if (snapCount === 0) {
    console.error(`Não há snapshot para a data ${dateArg}.`);
    const [dates] = await getPool().query(
      "SELECT snapshot_date, COUNT(*) AS n FROM delivery_audit_snapshots GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT 10"
    );
    console.log("Datas disponíveis:");
    console.table(dates);
    process.exit(2);
  }
  console.log(`Snapshot ${dateArg}: ${snapCount} rows`);

  // 2. Estado actual de delivery_audit
  const [cur] = await getPool().query(
    "SELECT COUNT(*) AS active, SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS deleted FROM delivery_audit"
  );
  console.log(`delivery_audit actual: ${cur[0].active - cur[0].deleted} activas, ${cur[0].deleted} deleted`);

  // 3. Quantas seriam ressuscitadas?
  const [diff] = await getPool().query(
    `SELECT
       SUM(CASE WHEN da.deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS would_undelete,
       SUM(CASE WHEN da.id IS NULL THEN 1 ELSE 0 END) AS would_insert,
       SUM(CASE WHEN da.deleted_at IS NULL THEN 1 ELSE 0 END) AS already_active
     FROM delivery_audit_snapshots ss
     LEFT JOIN delivery_audit da ON da.dedup_key = ss.dedup_key
     WHERE ss.snapshot_date = ?`,
    [dateArg]
  );
  console.log("\nImpacto do restore:");
  console.table([{
    "ressuscitaria (un-delete)": Number(diff[0].would_undelete) || 0,
    "inseriria (faltam fisicamente)": Number(diff[0].would_insert) || 0,
    "já activas (sem mudança)": Number(diff[0].already_active) || 0,
  }]);

  if (!apply) {
    console.log("\n--- DRY RUN ---");
    console.log("Para aplicar, corra de novo com --apply:");
    console.log(`   node scripts/restore-from-snapshot.js ${dateArg} --apply`);
    process.exit(0);
  }

  console.log("\n--- APPLY ---");
  // UNDELETE — rows em DB que estavam deleted_at, mas existiam no snapshot
  const [undel] = await getPool().query(
    `UPDATE delivery_audit da
     INNER JOIN delivery_audit_snapshots ss ON ss.dedup_key = da.dedup_key
     SET da.deleted_at = NULL, da.last_seen_at = NOW()
     WHERE ss.snapshot_date = ? AND da.deleted_at IS NOT NULL`,
    [dateArg]
  );
  console.log(`UPDATE: ${undel.affectedRows} rows ressuscitadas (un-delete)`);

  // INSERT — rows do snapshot que já não existem fisicamente em delivery_audit
  const [ins] = await getPool().query(
    `INSERT INTO delivery_audit
       (dedup_key, gtu, adsn, beneficiary_name, extensionist_id, nuit,
        product, delivered_qty, packages, unit, district, province,
        submitted_by, delivery_date_iso, verification_status,
        detected_at, last_seen_at, raw_data)
     SELECT
       ss.dedup_key, ss.gtu, ss.adsn, ss.beneficiary_name, ss.extensionist_id, ss.nuit,
       ss.product, ss.delivered_qty, ss.packages, ss.unit, ss.district, ss.province,
       ss.submitted_by, ss.delivery_date_iso, ss.verification_status,
       COALESCE(ss.detected_at, NOW()), NOW(), ss.raw_data
     FROM delivery_audit_snapshots ss
     LEFT JOIN delivery_audit da ON da.dedup_key = ss.dedup_key
     WHERE ss.snapshot_date = ? AND da.id IS NULL`,
    [dateArg]
  );
  console.log(`INSERT: ${ins.affectedRows} rows restauradas fisicamente`);

  console.log("\n[OK] Restore concluído.");
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e.message); process.exit(99); });
