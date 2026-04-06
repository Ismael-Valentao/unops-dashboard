/**
 * MySQL connection pool + helpers.
 * Uses env vars: DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.
 */
const mysql = require("mysql2/promise");
const fs = require("fs");
const path = require("path");

let pool = null;

function getPool() {
  if (pool) return pool;
  pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "aqi_operations",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    multipleStatements: true,
    charset: "utf8mb4",
    dateStrings: true,
  });
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params || []);
  return rows;
}

async function queryOne(sql, params) {
  const rows = await query(sql, params);
  return rows[0] || null;
}

async function execute(sql, params) {
  const [result] = await getPool().execute(sql, params || []);
  return result;
}

async function init() {
  // Test connection
  const conn = await getPool().getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }

  // Run schema (multipleStatements is enabled)
  const schemaPath = path.join(__dirname, "schema.sql");
  const schema = fs.readFileSync(schemaPath, "utf-8");
  // Split statements and run individually so foreign keys resolve in order
  const statements = schema.split(/;\s*[\r\n]/).map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    try {
      await getPool().query(stmt);
    } catch (e) {
      console.error("[DB] Failed to run:", stmt.slice(0, 80), "...");
      console.error("    ", e.message);
      throw e;
    }
  }
  console.log("[DB] MySQL connected and schema ready");
}

async function hasAnyUser() {
  const row = await queryOne("SELECT COUNT(*) AS c FROM users");
  return row && row.c > 0;
}

module.exports = { init, query, queryOne, execute, getPool, hasAnyUser };
