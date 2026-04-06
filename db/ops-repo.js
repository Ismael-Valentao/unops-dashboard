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
      `INSERT INTO requisitions (ref_number, supplier_id, product, product_id, qty_requested, unit, status, requested_at, expected_at, notes, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [data.ref_number || null, data.supplier_id, data.product, data.product_id || null,
       data.qty_requested, data.unit, data.status || "pending",
       data.requested_at || now(), data.expected_at || null, data.notes || null, userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      `UPDATE requisitions SET ref_number=?, supplier_id=?, product=?, product_id=?, qty_requested=?, unit=?, status=?, expected_at=?, notes=? WHERE id=?`,
      [data.ref_number || null, data.supplier_id, data.product, data.product_id || null,
       data.qty_requested, data.unit, data.status, data.expected_at || null, data.notes || null, id]
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
      `INSERT INTO stock_movements (type, product, product_id, qty, truck_id, warehouse_id, transfer_id, departure_id, created_at, created_by, notes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [data.type, data.product, data.product_id || null, data.qty,
       data.truck_id || null, data.warehouse_id || null,
       data.transfer_id || null, data.departure_id || null,
       now(), userId || null, data.notes || null]
    );
  },
  async byWarehouse() {
    return query(`
      SELECT m.warehouse_id, w.name AS warehouse_name, w.code AS warehouse_code,
             m.product, m.product_id,
             COALESCE(p.default_unit, 'kg') AS unit,
             SUM(CASE WHEN m.type IN ('warehouse_in') THEN m.qty
                      WHEN m.type IN ('warehouse_out','departure') THEN -m.qty
                      ELSE 0 END) AS qty
      FROM stock_movements m
      LEFT JOIN warehouses w ON m.warehouse_id = w.id
      LEFT JOIN products p ON m.product_id = p.id
      WHERE m.warehouse_id IS NOT NULL
      GROUP BY m.warehouse_id, m.product, m.product_id
      HAVING qty > 0.001
      ORDER BY w.name, m.product
    `);
  },
  async byTruck() {
    // cargo currently in trucks that haven't been unloaded yet
    return query(`
      SELECT c.truck_id, t.plate, c.product, c.product_id, c.qty_current AS qty, c.unit
      FROM truck_cargo c
      JOIN trucks t ON c.truck_id = t.id
      WHERE c.qty_current > 0.001
        AND t.status IN ('expected','arrived','unloading')
        AND c.unloaded_to_warehouse_id IS NULL
      ORDER BY t.plate, c.product
    `);
  },
  async warehouseStock(warehouseId) {
    return query(`
      SELECT m.product, m.product_id, COALESCE(p.default_unit,'kg') AS unit,
             SUM(CASE WHEN m.type IN ('warehouse_in') THEN m.qty
                      WHEN m.type IN ('warehouse_out','departure') THEN -m.qty
                      ELSE 0 END) AS qty
      FROM stock_movements m
      LEFT JOIN products p ON m.product_id = p.id
      WHERE m.warehouse_id = ?
      GROUP BY m.product, m.product_id
      HAVING qty > 0.001
      ORDER BY m.product
    `, [warehouseId]);
  },
  async virtualStock() {
    // Total per product across all warehouses + trucks pending
    return query(`
      SELECT product, unit, SUM(qty) AS qty FROM (
        SELECT m.product, COALESCE(p.default_unit,'kg') AS unit,
               SUM(CASE WHEN m.type='warehouse_in' THEN m.qty
                        WHEN m.type IN ('warehouse_out','departure') THEN -m.qty
                        ELSE 0 END) AS qty
        FROM stock_movements m
        LEFT JOIN products p ON m.product_id = p.id
        WHERE m.warehouse_id IS NOT NULL
        GROUP BY m.product, p.default_unit
        UNION ALL
        SELECT c.product, c.unit, SUM(c.qty_current) AS qty
        FROM truck_cargo c
        JOIN trucks t ON c.truck_id = t.id
        WHERE c.qty_current > 0
          AND t.status IN ('expected','arrived','unloading')
          AND c.unloaded_to_warehouse_id IS NULL
        GROUP BY c.product, c.unit
      ) AS s
      GROUP BY product, unit
      HAVING qty > 0.001
      ORDER BY product
    `);
  },
  async movements(limit) {
    return query(
      `SELECT m.*, t.plate, w.name AS warehouse_name, u.name AS user_name
       FROM stock_movements m
       LEFT JOIN trucks t ON m.truck_id = t.id
       LEFT JOIN warehouses w ON m.warehouse_id = w.id
       LEFT JOIN users u ON m.created_by = u.id
       ORDER BY m.created_at DESC LIMIT ?`,
      [limit || 100]
    );
  },
};

// ── Products ────────────────────────────────────────────────
const Products = {
  async list(includeInactive) {
    return query(
      includeInactive
        ? "SELECT * FROM products ORDER BY name"
        : "SELECT * FROM products WHERE active = 1 ORDER BY name"
    );
  },
  async findById(id) {
    return queryOne("SELECT * FROM products WHERE id = ?", [id]);
  },
  async findByCode(code) {
    return queryOne("SELECT * FROM products WHERE code = ?", [code]);
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO products (code, name, category, default_unit, active, notes, created_at, created_by)
       VALUES (?,?,?,?,1,?,?,?)`,
      [data.code || null, data.name, data.category || null, data.default_unit, data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      "UPDATE products SET code=?, name=?, category=?, default_unit=?, notes=? WHERE id=?",
      [data.code || null, data.name, data.category || null, data.default_unit, data.notes || null, id]
    );
  },
  async setActive(id, active) {
    return execute("UPDATE products SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  },
};

// ── Warehouses ──────────────────────────────────────────────
const Warehouses = {
  async list(includeInactive) {
    return query(
      includeInactive
        ? "SELECT * FROM warehouses ORDER BY name"
        : "SELECT * FROM warehouses WHERE active = 1 ORDER BY name"
    );
  },
  async findById(id) {
    return queryOne("SELECT * FROM warehouses WHERE id = ?", [id]);
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO warehouses (code, name, province, district, address, manager_name, manager_phone, active, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
      [data.code || null, data.name, data.province || null, data.district || null,
       data.address || null, data.manager_name || null, data.manager_phone || null,
       data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      `UPDATE warehouses SET code=?, name=?, province=?, district=?, address=?,
       manager_name=?, manager_phone=?, notes=? WHERE id=?`,
      [data.code || null, data.name, data.province || null, data.district || null,
       data.address || null, data.manager_name || null, data.manager_phone || null,
       data.notes || null, id]
    );
  },
  async setActive(id, active) {
    return execute("UPDATE warehouses SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
  },
};

// ── Departures ──────────────────────────────────────────────
const Departures = {
  async list(filters) {
    const where = [];
    const params = [];
    if (filters && filters.status) { where.push("d.status = ?"); params.push(filters.status); }
    if (filters && filters.truck_id) { where.push("d.truck_id = ?"); params.push(filters.truck_id); }
    return query(
      `SELECT d.*, t.plate, w.name AS warehouse_name,
              (SELECT COUNT(*) FROM departure_cargo dc WHERE dc.departure_id = d.id) AS items_count
       FROM truck_departures d
       JOIN trucks t ON d.truck_id = t.id
       LEFT JOIN warehouses w ON d.source_warehouse_id = w.id
       ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY d.departed_at DESC`,
      params
    );
  },
  async findById(id) {
    const dep = await queryOne(
      `SELECT d.*, t.plate, w.name AS warehouse_name, p.name AS plan_name
       FROM truck_departures d
       JOIN trucks t ON d.truck_id = t.id
       LEFT JOIN warehouses w ON d.source_warehouse_id = w.id
       LEFT JOIN delivery_plans p ON d.plan_id = p.id
       WHERE d.id = ?`,
      [id]
    );
    if (dep) {
      dep.items = await query("SELECT * FROM departure_cargo WHERE departure_id = ?", [id]);
    }
    return dep;
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO truck_departures (truck_id, source_type, source_warehouse_id,
        destination_province, destination_district, destination_name, destination_contact,
        plan_id, status, departed_at, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [data.truck_id, data.source_type, data.source_warehouse_id || null,
       data.destination_province || null, data.destination_district || null,
       data.destination_name || null, data.destination_contact || null,
       data.plan_id || null, data.status || "in_transit",
       data.departed_at || now(), data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async addItem(departureId, item) {
    return execute(
      `INSERT INTO departure_cargo (departure_id, product_id, product_name, qty, unit, notes)
       VALUES (?,?,?,?,?,?)`,
      [departureId, item.product_id, item.product_name, item.qty, item.unit, item.notes || null]
    );
  },
  async setStatus(id, status, deliveredAt) {
    if (status === "delivered") {
      return execute("UPDATE truck_departures SET status=?, delivered_at=? WHERE id=?", [status, deliveredAt || now(), id]);
    }
    return execute("UPDATE truck_departures SET status=? WHERE id=?", [status, id]);
  },
};

// ── Plans ───────────────────────────────────────────────────
const Plans = {
  async list() {
    return query(
      `SELECT p.*, (SELECT COUNT(*) FROM plan_items i WHERE i.plan_id = p.id) AS items_count
       FROM delivery_plans p ORDER BY p.created_at DESC`
    );
  },
  async findById(id) {
    const p = await queryOne("SELECT * FROM delivery_plans WHERE id = ?", [id]);
    if (p) {
      p.items = await query(
        `SELECT i.*, w.name AS warehouse_name FROM plan_items i
         LEFT JOIN warehouses w ON i.source_warehouse_id = w.id
         WHERE i.plan_id = ?`,
        [id]
      );
    }
    return p;
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO delivery_plans (ref_number, name, target_province, target_district, target_date, status, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [data.ref_number || null, data.name, data.target_province || null,
       data.target_district || null, data.target_date || null,
       data.status || "draft", data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async addItem(planId, item) {
    return execute(
      `INSERT INTO plan_items (plan_id, product_id, product_name, qty, unit, source_warehouse_id, beneficiary, status, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [planId, item.product_id, item.product_name, item.qty, item.unit,
       item.source_warehouse_id || null, item.beneficiary || null,
       item.status || "draft", item.notes || null]
    );
  },
  async setStatus(id, status) {
    return execute("UPDATE delivery_plans SET status = ? WHERE id = ?", [status, id]);
  },
  async setItemsStatus(planId, status) {
    return execute("UPDATE plan_items SET status = ? WHERE plan_id = ?", [status, planId]);
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

module.exports = {
  Users, Sessions, Suppliers, Requisitions, Trucks, Cargo,
  Attachments, Transfers, Stock, Audit,
  Products, Warehouses, Departures, Plans,
};
