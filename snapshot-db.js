/**
 * AQI Dashboard – SQLite Snapshot Storage
 * Stores daily snapshots of delivery data for historical navigation.
 */
const Database = require("better-sqlite3");
const path = require("path");
const zlib = require("zlib");

const DB_PATH = path.join(__dirname, "data", "snapshots.db");
let db;

function init() {
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      date        TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL,
      row_count   INTEGER NOT NULL DEFAULT 0,
      data        BLOB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS snapshot_summary (
      date                  TEXT PRIMARY KEY,
      total                 INTEGER NOT NULL DEFAULT 0,
      verified              INTEGER NOT NULL DEFAULT 0,
      pending               INTEGER NOT NULL DEFAULT 0,
      errors                INTEGER NOT NULL DEFAULT 0,
      total_qty             REAL NOT NULL DEFAULT 0,
      total_packages        REAL NOT NULL DEFAULT 0,
      unique_beneficiaries  INTEGER NOT NULL DEFAULT 0
    );
  `);

  console.log("[DB] Snapshot database ready at", DB_PATH);
}

// ── Save a snapshot ───────────────────────────────────────────
function saveSnapshot(date, rows) {
  if (!rows || rows.length === 0) return false;

  const json = JSON.stringify(rows);
  const compressed = zlib.gzipSync(json);
  const now = new Date().toISOString();

  // Compute summary
  const total = rows.length;
  const verified = rows.filter((r) => r.verification_status === "Verified").length;
  const pending = rows.filter((r) => r.verification_status === "Pending Verification").length;
  const errors = rows.filter((r) => r.verification_status === "#ERROR!").length;
  const totalQty = rows.reduce((s, r) => s + (Number(r.delivered_qty) || 0), 0);
  const totalPkgs = rows.reduce((s, r) => s + (Number(r.packages) || 0), 0);
  const uniqueBen = new Set(rows.map((r) => r.beneficiary_id).filter(Boolean)).size;

  const upsertSnapshot = db.prepare(`
    INSERT INTO snapshots (date, created_at, row_count, data)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      created_at = excluded.created_at,
      row_count = excluded.row_count,
      data = excluded.data
  `);

  const upsertSummary = db.prepare(`
    INSERT INTO snapshot_summary (date, total, verified, pending, errors, total_qty, total_packages, unique_beneficiaries)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      total = excluded.total,
      verified = excluded.verified,
      pending = excluded.pending,
      errors = excluded.errors,
      total_qty = excluded.total_qty,
      total_packages = excluded.total_packages,
      unique_beneficiaries = excluded.unique_beneficiaries
  `);

  const tx = db.transaction(() => {
    upsertSnapshot.run(date, now, total, compressed);
    upsertSummary.run(date, total, verified, pending, errors, totalQty, totalPkgs, uniqueBen);
  });

  tx();
  console.log(`[DB] Snapshot saved for ${date}: ${total} rows, ${(compressed.length / 1024).toFixed(1)}KB`);
  return true;
}

// ── Get a snapshot ────────────────────────────────────────────
function getSnapshot(date) {
  const row = db.prepare("SELECT * FROM snapshots WHERE date = ?").get(date);
  if (!row) return null;

  const json = zlib.gunzipSync(row.data).toString("utf-8");
  const data = JSON.parse(json);
  return {
    date: row.date,
    created_at: row.created_at,
    row_count: row.row_count,
    rows: data,
  };
}

// ── List all snapshots (summary only) ─────────────────────────
function listSnapshots() {
  return db.prepare(`
    SELECT s.date, s.created_at, s.row_count,
           sm.total, sm.verified, sm.pending, sm.errors,
           sm.total_qty, sm.total_packages, sm.unique_beneficiaries
    FROM snapshots s
    LEFT JOIN snapshot_summary sm ON s.date = sm.date
    ORDER BY s.date DESC
  `).all();
}

// ── Check if snapshot exists for a date ───────────────────────
function hasSnapshot(date) {
  const row = db.prepare("SELECT 1 FROM snapshots WHERE date = ?").get(date);
  return !!row;
}

// ── Get today's date string ───────────────────────────────────
function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = { init, saveSnapshot, getSnapshot, listSnapshots, hasSnapshot, todayStr };
