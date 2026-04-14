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

async function columnExists(table, column) {
  const dbName = process.env.DB_NAME || "aqi_operations";
  const row = await queryOne(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [dbName, table, column]
  );
  return !!row;
}

async function migrate() {
  // truck_cargo: add product_id and unloaded_to_warehouse_id
  if (!(await columnExists("truck_cargo", "product_id"))) {
    await getPool().query("ALTER TABLE truck_cargo ADD COLUMN product_id INT NULL AFTER truck_id");
    try { await getPool().query("ALTER TABLE truck_cargo ADD CONSTRAINT fk_tc_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated truck_cargo.product_id");
  }
  if (!(await columnExists("truck_cargo", "unloaded_to_warehouse_id"))) {
    await getPool().query("ALTER TABLE truck_cargo ADD COLUMN unloaded_to_warehouse_id INT NULL AFTER unit");
    try { await getPool().query("ALTER TABLE truck_cargo ADD CONSTRAINT fk_tc_warehouse FOREIGN KEY (unloaded_to_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated truck_cargo.unloaded_to_warehouse_id");
  }

  // stock_movements: add product_id, warehouse_id, departure_id + extend type enum
  if (!(await columnExists("stock_movements", "product_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN product_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated stock_movements.product_id");
  }
  if (!(await columnExists("stock_movements", "warehouse_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN warehouse_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.warehouse_id");
  }
  if (!(await columnExists("stock_movements", "departure_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN departure_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_departure FOREIGN KEY (departure_id) REFERENCES truck_departures(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.departure_id");
  }
  // Extend ENUM (always safe to re-run)
  await getPool().query(
    `ALTER TABLE stock_movements MODIFY COLUMN type ENUM(
      'truck_in','truck_unload','transfer_out','transfer_in','adjustment',
      'warehouse_in','warehouse_out','departure'
    ) NOT NULL`
  );

  // requisitions: add product_id
  if (!(await columnExists("requisitions", "product_id"))) {
    await getPool().query("ALTER TABLE requisitions ADD COLUMN product_id INT NULL");
    try { await getPool().query("ALTER TABLE requisitions ADD CONSTRAINT fk_req_product FOREIGN KEY (product_id) REFERENCES products(id)"); } catch (e) {}
    console.log("[DB] migrated requisitions.product_id");
  }

  // suppliers: NUIT + client_number (for PO matching)
  if (!(await columnExists("suppliers", "nuit"))) {
    await getPool().query("ALTER TABLE suppliers ADD COLUMN nuit VARCHAR(32) NULL AFTER contact_email");
    console.log("[DB] migrated suppliers.nuit");
  }
  if (!(await columnExists("suppliers", "client_number"))) {
    await getPool().query("ALTER TABLE suppliers ADD COLUMN client_number VARCHAR(32) NULL");
    console.log("[DB] migrated suppliers.client_number");
  }

  // stock_movements: add entry_id, exit_id, supplier_id + extend ENUM with new types
  if (!(await columnExists("stock_movements", "entry_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN entry_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_entry FOREIGN KEY (entry_id) REFERENCES stock_entries(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.entry_id");
  }
  if (!(await columnExists("stock_movements", "exit_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN exit_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_exit FOREIGN KEY (exit_id) REFERENCES stock_exits(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.exit_id");
  }
  if (!(await columnExists("stock_movements", "supplier_id"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN supplier_id INT NULL");
    try { await getPool().query("ALTER TABLE stock_movements ADD CONSTRAINT fk_sm_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE SET NULL"); } catch (e) {}
    console.log("[DB] migrated stock_movements.supplier_id");
  }
  // Add truck_plate for movement queries by plate (denormalized for fast search)
  if (!(await columnExists("stock_movements", "truck_plate"))) {
    await getPool().query("ALTER TABLE stock_movements ADD COLUMN truck_plate VARCHAR(32) NULL");
    await getPool().query("CREATE INDEX idx_sm_plate ON stock_movements (truck_plate)");
    console.log("[DB] migrated stock_movements.truck_plate");
  }
  // Extend ENUM with authorization_in / adsn_out (safe to re-run)
  await getPool().query(
    `ALTER TABLE stock_movements MODIFY COLUMN type ENUM(
      'truck_in','truck_unload','transfer_out','transfer_in','adjustment',
      'warehouse_in','warehouse_out','departure',
      'authorization_in','adsn_out'
    ) NOT NULL`
  );
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

  // Run incremental migrations
  await migrate();

  console.log("[DB] MySQL connected, schema ready, migrations applied");
}

async function hasAnyUser() {
  const row = await queryOne("SELECT COUNT(*) AS c FROM users");
  return row && row.c > 0;
}

module.exports = { init, query, queryOne, execute, getPool, hasAnyUser };
