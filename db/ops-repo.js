/**
 * Operations repository — CRUD per entity.
 */
const { query, queryOne, execute } = require("./mysql");

const now = () => new Date().toISOString().slice(0, 19).replace("T", " ");

// ── Users ───────────────────────────────────────────────────
const Users = {
  async findByEmail(email) {
    return queryOne("SELECT * FROM users WHERE email = ? LIMIT 1", [email]);
  },
  async findById(id) {
    return queryOne("SELECT id, email, name, role, active, created_at, last_login FROM users WHERE id = ?", [id]);
  },
  async list() {
    return query("SELECT id, email, name, role, active, created_at, last_login FROM users ORDER BY created_at DESC");
  },
  async create({ email, password_hash, name, role, created_by }) {
    const r = await execute(
      "INSERT INTO users (email, password_hash, name, role, active, created_at, created_by) VALUES (?,?,?,?,1,?,?)",
      [email, password_hash, name, role, now(), created_by || null]
    );
    return r.insertId;
  },
  async updatePassword(id, password_hash) {
    return execute("UPDATE users SET password_hash = ? WHERE id = ?", [password_hash, id]);
  },
  async setActive(id, active) {
    return execute("UPDATE users SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  },
  async touchLogin(id) {
    return execute("UPDATE users SET last_login = ? WHERE id = ?", [now(), id]);
  },
  async count() {
    const r = await queryOne("SELECT COUNT(*) AS c FROM users");
    return r ? r.c : 0;
  },
};

// ── Sessions ────────────────────────────────────────────────
const Sessions = {
  async create({ token, user_id, expires_at, ip, user_agent }) {
    return execute(
      "INSERT INTO sessions (token, user_id, expires_at, created_at, ip, user_agent) VALUES (?,?,?,?,?,?)",
      [token, user_id, expires_at, now(), ip || null, user_agent || null]
    );
  },
  async find(token) {
    return queryOne(
      `SELECT s.*, u.email, u.name, u.role, u.active
       FROM sessions s JOIN users u ON s.user_id = u.id
       WHERE s.token = ? AND s.expires_at > NOW() AND u.active = 1 LIMIT 1`,
      [token]
    );
  },
  async destroy(token) {
    return execute("DELETE FROM sessions WHERE token = ?", [token]);
  },
  async cleanup() {
    return execute("DELETE FROM sessions WHERE expires_at < NOW()");
  },
};

// ── Suppliers ───────────────────────────────────────────────
const Suppliers = {
  async list() {
    return query("SELECT * FROM suppliers ORDER BY name");
  },
  async findById(id) {
    return queryOne("SELECT * FROM suppliers WHERE id = ?", [id]);
  },
  async create(data, userId) {
    const r = await execute(
      "INSERT INTO suppliers (name, contact_name, contact_phone, contact_email, notes, created_at, created_by) VALUES (?,?,?,?,?,?,?)",
      [data.name, data.contact_name || null, data.contact_phone || null, data.contact_email || null, data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      "UPDATE suppliers SET name=?, contact_name=?, contact_phone=?, contact_email=?, notes=? WHERE id=?",
      [data.name, data.contact_name || null, data.contact_phone || null, data.contact_email || null, data.notes || null, id]
    );
  },
  async remove(id) {
    return execute("DELETE FROM suppliers WHERE id = ?", [id]);
  },
};

// ── Requisitions ────────────────────────────────────────────
const Requisitions = {
  async list() {
    return query(`SELECT r.*, s.name AS supplier_name FROM requisitions r
                  LEFT JOIN suppliers s ON r.supplier_id = s.id
                  ORDER BY r.requested_at DESC`);
  },
  async findById(id) {
    return queryOne(`SELECT r.*, s.name AS supplier_name FROM requisitions r
                     LEFT JOIN suppliers s ON r.supplier_id = s.id
                     WHERE r.id = ?`, [id]);
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO requisitions (ref_number, supplier_id, product, qty_requested, unit, status, requested_at, expected_at, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [data.ref_number || null, data.supplier_id, data.product, data.qty_requested, data.unit, data.status || "pending",
       data.requested_at || now(), data.expected_at || null, data.notes || null, userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      `UPDATE requisitions SET ref_number=?, supplier_id=?, product=?, qty_requested=?, unit=?, status=?, expected_at=?, notes=? WHERE id=?`,
      [data.ref_number || null, data.supplier_id, data.product, data.qty_requested, data.unit, data.status, data.expected_at || null, data.notes || null, id]
    );
  },
  async remove(id) {
    return execute("DELETE FROM requisitions WHERE id = ?", [id]);
  },
};

// ── Trucks ──────────────────────────────────────────────────
const Trucks = {
  async list(filters) {
    const where = [];
    const params = [];
    if (filters && filters.status) { where.push("t.status = ?"); params.push(filters.status); }
    if (filters && filters.supplier_id) { where.push("t.supplier_id = ?"); params.push(filters.supplier_id); }
    const sql = `SELECT t.*, s.name AS supplier_name,
                        (SELECT COUNT(*) FROM truck_cargo c WHERE c.truck_id = t.id) AS cargo_count,
                        (SELECT COUNT(*) FROM truck_attachments a WHERE a.truck_id = t.id) AS attachment_count
                 FROM trucks t LEFT JOIN suppliers s ON t.supplier_id = s.id
                 ${where.length ? "WHERE " + where.join(" AND ") : ""}
                 ORDER BY t.created_at DESC`;
    return query(sql, params);
  },
  async findById(id) {
    return queryOne(`SELECT t.*, s.name AS supplier_name, r.ref_number AS req_ref
                     FROM trucks t
                     LEFT JOIN suppliers s ON t.supplier_id = s.id
                     LEFT JOIN requisitions r ON t.requisition_id = r.id
                     WHERE t.id = ?`, [id]);
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO trucks (plate, driver_name, driver_phone, supplier_id, requisition_id, status, arrived_at, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [data.plate, data.driver_name || null, data.driver_phone || null,
       data.supplier_id || null, data.requisition_id || null,
       data.status || "expected", data.arrived_at || null, data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      `UPDATE trucks SET plate=?, driver_name=?, driver_phone=?, supplier_id=?, requisition_id=?, status=?, arrived_at=?, unloaded_at=?, notes=? WHERE id=?`,
      [data.plate, data.driver_name || null, data.driver_phone || null, data.supplier_id || null,
       data.requisition_id || null, data.status, data.arrived_at || null, data.unloaded_at || null, data.notes || null, id]
    );
  },
  async setStatus(id, status, extra) {
    if (status === "unloaded") {
      return execute("UPDATE trucks SET status = ?, unloaded_at = ? WHERE id = ?", [status, now(), id]);
    }
    return execute("UPDATE trucks SET status = ? WHERE id = ?", [status, id]);
  },
  async remove(id) {
    return execute("DELETE FROM trucks WHERE id = ?", [id]);
  },
};

// ── Truck Cargo ─────────────────────────────────────────────
const Cargo = {
  async listByTruck(truckId) {
    return query("SELECT * FROM truck_cargo WHERE truck_id = ?", [truckId]);
  },
  async findById(id) {
    return queryOne("SELECT * FROM truck_cargo WHERE id = ?", [id]);
  },
  async add(truckId, data) {
    const r = await execute(
      "INSERT INTO truck_cargo (truck_id, product, qty_initial, qty_current, unit, notes) VALUES (?,?,?,?,?,?)",
      [truckId, data.product, data.qty, data.qty, data.unit, data.notes || null]
    );
    return r.insertId;
  },
  async updateCurrent(id, qty_current) {
    return execute("UPDATE truck_cargo SET qty_current = ? WHERE id = ?", [qty_current, id]);
  },
  async remove(id) {
    return execute("DELETE FROM truck_cargo WHERE id = ?", [id]);
  },
};

// ── Truck Attachments ───────────────────────────────────────
const Attachments = {
  async listByTruck(truckId) {
    return query("SELECT * FROM truck_attachments WHERE truck_id = ? ORDER BY uploaded_at DESC", [truckId]);
  },
  async findById(id) {
    return queryOne("SELECT * FROM truck_attachments WHERE id = ?", [id]);
  },
  async create(truckId, file, userId) {
    const r = await execute(
      `INSERT INTO truck_attachments (truck_id, file_path, original_name, mime_type, size_bytes, uploaded_at, uploaded_by)
       VALUES (?,?,?,?,?,?,?)`,
      [truckId, file.path, file.originalname, file.mimetype, file.size, now(), userId || null]
    );
    return r.insertId;
  },
  async remove(id) {
    return execute("DELETE FROM truck_attachments WHERE id = ?", [id]);
  },
};

// ── Cargo Transfers ─────────────────────────────────────────
const Transfers = {
  async listByTruck(truckId) {
    return query(
      `SELECT ct.*, t1.plate AS from_plate, t2.plate AS to_plate
       FROM cargo_transfers ct
       JOIN trucks t1 ON ct.from_truck_id = t1.id
       JOIN trucks t2 ON ct.to_truck_id = t2.id
       WHERE ct.from_truck_id = ? OR ct.to_truck_id = ?
       ORDER BY ct.transferred_at DESC`,
      [truckId, truckId]
    );
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO cargo_transfers (from_truck_id, to_truck_id, product, qty, unit, transferred_at, transferred_by, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [data.from_truck_id, data.to_truck_id, data.product, data.qty, data.unit, now(), userId || null, data.notes || null]
    );
    return r.insertId;
  },
};

// ── Stock Movements + Virtual Stock ─────────────────────────
const Stock = {
  async addMovement(data, userId) {
    return execute(
      `INSERT INTO stock_movements (type, product, qty, truck_id, transfer_id, created_at, created_by, notes)
       VALUES (?,?,?,?,?,?,?,?)`,
      [data.type, data.product, data.qty, data.truck_id || null, data.transfer_id || null, now(), userId || null, data.notes || null]
    );
  },
  async virtualStock() {
    // Stock virtual = soma de todos os truck_cargo de camiões com status='unloaded' menos transferências out
    return query(`
      SELECT product, unit, SUM(qty_current) AS qty
      FROM truck_cargo c
      JOIN trucks t ON c.truck_id = t.id
      WHERE t.status IN ('unloaded','arrived','unloading')
      GROUP BY product, unit
      ORDER BY product
    `);
  },
  async movements(limit) {
    return query(
      `SELECT m.*, t.plate, u.name AS user_name
       FROM stock_movements m
       LEFT JOIN trucks t ON m.truck_id = t.id
       LEFT JOIN users u ON m.created_by = u.id
       ORDER BY m.created_at DESC LIMIT ?`,
      [limit || 100]
    );
  },
};

// ── Audit ───────────────────────────────────────────────────
const Audit = {
  async log(userId, action, entity_type, entity_id, details, ip) {
    return execute(
      "INSERT INTO audit_log (user_id, action, entity_type, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?)",
      [userId || null, action, entity_type || null, entity_id || null, details || null, ip || null, now()]
    );
  },
  async list(limit) {
    return query(
      `SELECT a.*, u.name AS user_name, u.email AS user_email
       FROM audit_log a LEFT JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC LIMIT ?`,
      [limit || 200]
    );
  },
};

module.exports = { Users, Sessions, Suppliers, Requisitions, Trucks, Cargo, Attachments, Transfers, Stock, Audit };
