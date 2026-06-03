/**
 * One-off: cria tabela delivery_audit_snapshots em PROD (Hostinger).
 *
 * Conecta directamente usando credenciais de .env.prod (não toca o
 * servidor local nem altera DB_PROFILE). Idempotente: CREATE TABLE
 * IF NOT EXISTS — se a tabela já existe, não faz nada.
 *
 * USO: node scripts/create-snapshot-table-prod.js
 */

const path = require("path");
process.chdir(path.join(__dirname, ".."));

// Carrega .env.prod (NÃO .env) — credenciais Hostinger
require("dotenv").config({ path: ".env.prod", override: true });

const mysql = require("mysql2/promise");

(async () => {
  console.log("=== Conectar a PROD ===");
  console.log("Host:", process.env.DB_HOST, "| DB:", process.env.DB_NAME, "| User:", process.env.DB_USER);

  const conn = await mysql.createConnection({
    host:     process.env.DB_HOST,
    port:     Number(process.env.DB_PORT) || 3306,
    user:     process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    connectTimeout: 15000,
  });
  console.log("[OK] Ligado.");

  // 1. Existe já?
  const [before] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'delivery_audit_snapshots'",
    [process.env.DB_NAME]
  );
  if (before[0].n > 0) {
    console.log("\n[INFO] Tabela delivery_audit_snapshots JÁ existe em prod. Skip CREATE.");
  } else {
    console.log("\n[INFO] Tabela ainda não existe. A criar...");
  }

  // 2. CREATE TABLE IF NOT EXISTS — mesmo SQL que db/mysql.js
  await conn.query(`
    CREATE TABLE IF NOT EXISTS delivery_audit_snapshots (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      snapshot_date DATE NOT NULL,
      dedup_key VARCHAR(80) NOT NULL,
      audit_id INT NOT NULL,
      gtu VARCHAR(64) NULL,
      adsn VARCHAR(64) NULL,
      beneficiary_name VARCHAR(255) NULL,
      extensionist_id VARCHAR(32) NULL,
      nuit VARCHAR(32) NULL,
      product VARCHAR(128) NULL,
      delivered_qty DECIMAL(14,3) NULL,
      packages DECIMAL(14,3) NULL,
      unit VARCHAR(16) NULL,
      district VARCHAR(64) NULL,
      province VARCHAR(64) NULL,
      submitted_by VARCHAR(255) NULL,
      delivery_date_iso VARCHAR(20) NULL,
      verification_status VARCHAR(64) NULL,
      detected_at DATETIME NULL,
      raw_data JSON NULL,
      captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_snapshot_dedup (snapshot_date, dedup_key),
      INDEX idx_snap_date (snapshot_date),
      INDEX idx_snap_audit (audit_id),
      INDEX idx_snap_gtu (gtu),
      INDEX idx_snap_submitter (submitted_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 3. Confirma
  const [after] = await conn.query(
    "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'delivery_audit_snapshots'",
    [process.env.DB_NAME]
  );
  console.log("[OK] Tabela existe:", after[0].n === 1);

  // 4. Stats
  const [stats] = await conn.query("SELECT COUNT(*) AS rows_in FROM delivery_audit_snapshots");
  console.log("Rows actuais:", stats[0].rows_in);

  // 5. Para comparação, conta delivery_audit em prod
  const [audit] = await conn.query("SELECT COUNT(*) AS total, SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END) AS active FROM delivery_audit");
  console.log("\ndelivery_audit em PROD:", audit[0].active, "activas /", audit[0].total, "totais");
  console.log("→ Quando o servidor prod for restartado, o catch-up vai capturar ~" + audit[0].active + " rows.");

  await conn.end();
  console.log("\n[OK] Done.");
})().catch((e) => { console.error("ERRO:", e.message); process.exit(1); });
