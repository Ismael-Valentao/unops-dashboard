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
  async findByNuit(nuit) {
    if (!nuit) return null;
    return queryOne("SELECT * FROM suppliers WHERE nuit = ? LIMIT 1", [nuit]);
  },
  async findByName(name) {
    return queryOne("SELECT * FROM suppliers WHERE name = ? LIMIT 1", [name]);
  },
  async create(data, userId) {
    const r = await execute(
      "INSERT INTO suppliers (name, contact_name, contact_phone, contact_email, nuit, client_number, notes, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)",
      [data.name, data.contact_name || null, data.contact_phone || null, data.contact_email || null, data.nuit || null, data.client_number || null, data.notes || null, now(), userId || null]
    );
    return r.insertId;
  },
  async update(id, data) {
    return execute(
      "UPDATE suppliers SET name=?, contact_name=?, contact_phone=?, contact_email=?, nuit=?, client_number=?, notes=? WHERE id=?",
      [data.name, data.contact_name || null, data.contact_phone || null, data.contact_email || null, data.nuit || null, data.client_number || null, data.notes || null, id]
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
                        (SELECT COUNT(*) FROM truck_cargo c
                         WHERE c.truck_id = t.id AND c.qty_current > 0
                           AND c.unloaded_to_warehouse_id IS NULL) AS cargo_count,
                        (SELECT COUNT(*) FROM truck_attachments a WHERE a.truck_id = t.id) AS attachment_count,
                        (SELECT COALESCE(SUM(c.qty_current), 0) FROM truck_cargo c
                         WHERE c.truck_id = t.id AND c.qty_current > 0
                           AND c.unloaded_to_warehouse_id IS NULL) AS qty_on_board
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
  async warehouseMovements(warehouseId, limit) {
    return query(
      `SELECT m.*, t.plate, u.name AS user_name
       FROM stock_movements m
       LEFT JOIN trucks t ON m.truck_id = t.id
       LEFT JOIN users u ON m.created_by = u.id
       WHERE m.warehouse_id = ?
       ORDER BY m.created_at DESC LIMIT ?`,
      [warehouseId, limit || 50]
    );
  },
  async truckCargo(truckId) {
    // Available cargo currently in the truck (not yet unloaded)
    return query(
      `SELECT c.*, p.name AS product_name_catalog, p.default_unit
       FROM truck_cargo c
       LEFT JOIN products p ON c.product_id = p.id
       WHERE c.truck_id = ? AND c.qty_current > 0 AND c.unloaded_to_warehouse_id IS NULL`,
      [truckId]
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

// ── Purchase Orders ─────────────────────────────────────────
const PurchaseOrders = {
  async list(filters) {
    const f = filters || {};
    const where = [];
    const params = [];
    if (f.supplier_id) { where.push("po.supplier_id = ?"); params.push(f.supplier_id); }
    if (f.status) { where.push("po.status = ?"); params.push(f.status); }
    if (f.q) { where.push("(po.po_number LIKE ? OR s.name LIKE ?)"); params.push("%" + f.q + "%", "%" + f.q + "%"); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    return query(
      `SELECT po.*, s.name AS supplier_name,
              (SELECT COUNT(*) FROM po_items WHERE po_id = po.id) AS item_count,
              (SELECT COALESCE(SUM(qty),0) FROM po_items WHERE po_id = po.id) AS total_qty,
              (SELECT COALESCE(SUM(qty_received),0) FROM po_items WHERE po_id = po.id) AS total_received
       FROM purchase_orders po
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ${whereSql}
       ORDER BY po.created_at DESC LIMIT 500`,
      params
    );
  },
  async findById(id) {
    const po = await queryOne(
      `SELECT po.*, s.name AS supplier_name, s.nuit AS supplier_nuit_current, s.client_number AS supplier_client_number
       FROM purchase_orders po LEFT JOIN suppliers s ON po.supplier_id = s.id
       WHERE po.id = ?`,
      [id]
    );
    if (!po) return null;
    po.items = await query(
      `SELECT pi.*, p.code AS product_code_catalog, p.name AS product_name_catalog
       FROM po_items pi LEFT JOIN products p ON pi.product_id = p.id
       WHERE pi.po_id = ? ORDER BY pi.id`,
      [id]
    );
    return po;
  },
  async findByNumber(number) {
    return queryOne("SELECT * FROM purchase_orders WHERE po_number = ?", [number]);
  },
  async create(data, userId) {
    const r = await execute(
      `INSERT INTO purchase_orders (po_number, supplier_id, supplier_nuit, po_date, projecto, notes, status, imported_from, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [
        data.po_number, data.supplier_id, data.supplier_nuit || null,
        data.po_date || null, data.projecto || null, data.notes || null,
        data.status || "issued", data.imported_from || null, now(), userId || null,
      ]
    );
    return r.insertId;
  },
  async addItem(po_id, item) {
    const r = await execute(
      `INSERT INTO po_items (po_id, product_id, product_code, product_name, qty, unit, qty_authorized, qty_received)
       VALUES (?,?,?,?,?,?,0,0)`,
      [po_id, item.product_id || null, item.product_code || null, item.product_name, item.qty, item.unit || "kg"]
    );
    return r.insertId;
  },
  async updateStatus(id, status) {
    return execute("UPDATE purchase_orders SET status = ? WHERE id = ?", [status, id]);
  },
  async recomputeStatus(id) {
    const items = await query("SELECT qty, qty_received FROM po_items WHERE po_id = ?", [id]);
    if (!items.length) return;
    const totalQty = items.reduce((s, i) => s + Number(i.qty), 0);
    const totalReceived = items.reduce((s, i) => s + Number(i.qty_received), 0);
    let status;
    if (totalReceived <= 0.001) status = "issued";
    else if (totalReceived >= totalQty - 0.001) status = "received";
    else status = "partial";
    await this.updateStatus(id, status);
  },
};

// ── Pickup Authorizations ──────────────────────────────────
const Authorizations = {
  async list(filters) {
    const f = filters || {};
    const where = [];
    const params = [];
    if (f.status) { where.push("a.status = ?"); params.push(f.status); }
    if (f.plate) { where.push("a.truck_plate LIKE ?"); params.push("%" + f.plate + "%"); }
    if (f.po_id) { where.push("a.po_id = ?"); params.push(f.po_id); }
    if (f.supplier_id) { where.push("po.supplier_id = ?"); params.push(f.supplier_id); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    return query(
      `SELECT a.*, po.po_number, po.supplier_id, s.name AS supplier_name,
              (SELECT COALESCE(SUM(qty_to_pickup),0) FROM pickup_auth_items WHERE auth_id = a.id) AS total_qty
       FROM pickup_authorizations a
       LEFT JOIN purchase_orders po ON a.po_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ${whereSql}
       ORDER BY a.issued_at DESC LIMIT 500`,
      params
    );
  },
  async findById(id) {
    const auth = await queryOne(
      `SELECT a.*, po.po_number, po.supplier_id, po.projecto, po.po_date,
              s.name AS supplier_name, s.nuit AS supplier_nuit, s.contact_name AS supplier_contact,
              s.contact_phone AS supplier_phone
       FROM pickup_authorizations a
       LEFT JOIN purchase_orders po ON a.po_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       WHERE a.id = ?`,
      [id]
    );
    if (!auth) return null;
    auth.items = await query(
      `SELECT ai.*, pi.product_code, pi.qty AS po_qty
       FROM pickup_auth_items ai
       LEFT JOIN po_items pi ON ai.po_item_id = pi.id
       WHERE ai.auth_id = ? ORDER BY ai.id`,
      [id]
    );
    return auth;
  },
  async nextNumber() {
    const year = new Date().getFullYear();
    const prefix = `AUTH-${year}-`;
    const row = await queryOne(
      "SELECT auth_number FROM pickup_authorizations WHERE auth_number LIKE ? ORDER BY id DESC LIMIT 1",
      [prefix + "%"]
    );
    let seq = 1;
    if (row) {
      const m = row.auth_number.match(/-(\d+)$/);
      if (m) seq = Number(m[1]) + 1;
    }
    return prefix + String(seq).padStart(4, "0");
  },
  async create(data, userId) {
    const auth_number = await this.nextNumber();
    const r = await execute(
      `INSERT INTO pickup_authorizations
       (auth_number, po_id, transporter_name, truck_plate, driver_name, driver_phone, driver_id_doc, pickup_date, status, notes, issued_at, issued_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        auth_number, data.po_id, data.transporter_name || null,
        data.truck_plate, data.driver_name, data.driver_phone || null,
        data.driver_id_doc || null, data.pickup_date || null,
        data.status || "issued", data.notes || null, now(), userId || null,
      ]
    );
    const auth_id = r.insertId;
    // Add items
    for (const it of (data.items || [])) {
      await execute(
        `INSERT INTO pickup_auth_items (auth_id, po_item_id, product_id, product_name, qty_to_pickup, unit)
         VALUES (?,?,?,?,?,?)`,
        [auth_id, it.po_item_id, it.product_id || null, it.product_name, it.qty_to_pickup, it.unit || "kg"]
      );
      // Increment qty_authorized on po_item
      await execute(
        "UPDATE po_items SET qty_authorized = qty_authorized + ? WHERE id = ?",
        [it.qty_to_pickup, it.po_item_id]
      );
    }
    await PurchaseOrders.updateStatus(data.po_id, "in_pickup");
    return { id: auth_id, auth_number };
  },
  async updateStatus(id, status) {
    return execute("UPDATE pickup_authorizations SET status = ? WHERE id = ?", [status, id]);
  },
  async cancel(id) {
    const items = await query("SELECT po_item_id, qty_to_pickup FROM pickup_auth_items WHERE auth_id = ?", [id]);
    for (const it of items) {
      await execute("UPDATE po_items SET qty_authorized = GREATEST(0, qty_authorized - ?) WHERE id = ?", [it.qty_to_pickup, it.po_item_id]);
    }
    return this.updateStatus(id, "cancelled");
  },
};

// ── Stock Entries (confirms an Authorization → stock in) ─────
const StockEntries = {
  async list(filters) {
    const f = filters || {};
    const where = [];
    const params = [];
    if (f.auth_id) { where.push("e.auth_id = ?"); params.push(f.auth_id); }
    if (f.supplier_id) { where.push("po.supplier_id = ?"); params.push(f.supplier_id); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    return query(
      `SELECT e.*, a.auth_number, a.truck_plate, a.driver_name,
              po.po_number, po.supplier_id, s.name AS supplier_name,
              (SELECT COALESCE(SUM(qty_received),0) FROM stock_entry_items WHERE entry_id = e.id) AS total_qty
       FROM stock_entries e
       LEFT JOIN pickup_authorizations a ON e.auth_id = a.id
       LEFT JOIN purchase_orders po ON a.po_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       ${whereSql}
       ORDER BY e.received_at DESC LIMIT 500`,
      params
    );
  },
  async findById(id) {
    const entry = await queryOne(
      `SELECT e.*, a.auth_number, a.truck_plate, a.driver_name, a.driver_phone, a.transporter_name,
              po.po_number, po.supplier_id, s.name AS supplier_name, s.nuit AS supplier_nuit
       FROM stock_entries e
       LEFT JOIN pickup_authorizations a ON e.auth_id = a.id
       LEFT JOIN purchase_orders po ON a.po_id = po.id
       LEFT JOIN suppliers s ON po.supplier_id = s.id
       WHERE e.id = ?`,
      [id]
    );
    if (!entry) return null;
    entry.items = await query(
      `SELECT ei.*, ai.qty_to_pickup
       FROM stock_entry_items ei
       LEFT JOIN pickup_auth_items ai ON ei.auth_item_id = ai.id
       WHERE ei.entry_id = ? ORDER BY ei.id`,
      [id]
    );
    entry.attachments = await query(
      "SELECT * FROM stock_entry_attachments WHERE entry_id = ? ORDER BY uploaded_at",
      [id]
    );
    return entry;
  },
  async nextNumber() {
    const year = new Date().getFullYear();
    const prefix = `ENT-${year}-`;
    const row = await queryOne(
      "SELECT entry_number FROM stock_entries WHERE entry_number LIKE ? ORDER BY id DESC LIMIT 1",
      [prefix + "%"]
    );
    let seq = 1;
    if (row) {
      const m = row.entry_number.match(/-(\d+)$/);
      if (m) seq = Number(m[1]) + 1;
    }
    return prefix + String(seq).padStart(4, "0");
  },
  async create(data, userId) {
    const entry_number = await this.nextNumber();
    const auth = await queryOne(
      `SELECT a.po_id, a.truck_plate, po.supplier_id
       FROM pickup_authorizations a
       LEFT JOIN purchase_orders po ON a.po_id = po.id
       WHERE a.id = ?`,
      [data.auth_id]
    );
    if (!auth) throw new Error("Autorização não encontrada");

    const r = await execute(
      "INSERT INTO stock_entries (entry_number, auth_id, received_at, received_by, notes) VALUES (?,?,?,?,?)",
      [entry_number, data.auth_id, now(), userId || null, data.notes || null]
    );
    const entry_id = r.insertId;

    for (const it of (data.items || [])) {
      if (!it.qty_received || it.qty_received <= 0) continue;
      await execute(
        `INSERT INTO stock_entry_items (entry_id, auth_item_id, product_id, product_name, qty_received, unit)
         VALUES (?,?,?,?,?,?)`,
        [entry_id, it.auth_item_id, it.product_id || null, it.product_name, it.qty_received, it.unit || "kg"]
      );
      // Update po_items.qty_received
      const ai = await queryOne("SELECT po_item_id FROM pickup_auth_items WHERE id = ?", [it.auth_item_id]);
      if (ai) {
        await execute("UPDATE po_items SET qty_received = qty_received + ? WHERE id = ?", [it.qty_received, ai.po_item_id]);
      }
      // Stock movement
      await execute(
        `INSERT INTO stock_movements (type, product, product_id, qty, entry_id, supplier_id, truck_plate, created_at, created_by, notes)
         VALUES ('authorization_in', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [it.product_name, it.product_id || null, it.qty_received, entry_id, auth.supplier_id || null, auth.truck_plate || null, now(), userId || null, `Entrada ${entry_number}`]
      );
    }

    await Authorizations.updateStatus(data.auth_id, "received");
    await PurchaseOrders.recomputeStatus(auth.po_id);
    return { id: entry_id, entry_number };
  },
  async addAttachment(entry_id, { kind, file_path, original_name, mime_type, size_bytes }, userId) {
    const r = await execute(
      `INSERT INTO stock_entry_attachments (entry_id, kind, file_path, original_name, mime_type, size_bytes, uploaded_at, uploaded_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [entry_id, kind, file_path, original_name, mime_type || null, size_bytes || null, now(), userId || null]
    );
    return r.insertId;
  },
};

// ── ADSN Services (exit codes from main system) ──────────────
const ADSN = {
  async list(filters) {
    const f = filters || {};
    const where = [];
    const params = [];
    if (f.status) { where.push("status = ?"); params.push(f.status); }
    if (f.q) { where.push("(adsn_code LIKE ? OR gtu LIKE ? OR destinatario LIKE ?)"); params.push("%" + f.q + "%", "%" + f.q + "%", "%" + f.q + "%"); }
    if (f.provincia) { where.push("provincia = ?"); params.push(f.provincia); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    return query(
      `SELECT * FROM adsn_services ${whereSql} ORDER BY imported_at DESC LIMIT 1000`,
      params
    );
  },
  async findById(id) {
    return queryOne("SELECT * FROM adsn_services WHERE id = ?", [id]);
  },
  async findByCode(code) {
    return queryOne("SELECT * FROM adsn_services WHERE adsn_code = ?", [code]);
  },
  async search(q) {
    return query(
      `SELECT id, adsn_code, gtu, destinatario, distrito, product_name, peso_kg, status
       FROM adsn_services
       WHERE status = 'pending' AND (adsn_code LIKE ? OR gtu LIKE ? OR destinatario LIKE ?)
       ORDER BY imported_at DESC LIMIT 30`,
      ["%" + q + "%", "%" + q + "%", "%" + q + "%"]
    );
  },
  async upsert(row, userId, fileName) {
    // Ignore duplicates (UNIQUE on adsn_code)
    try {
      const r = await execute(
        `INSERT INTO adsn_services
         (adsn_code, gtu, tipo, projecto, origem, destinatario, destinatario_contact, provincia, distrito, sku, product_name, peso_kg, volumes, status, imported_at, imported_by, imported_from)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
        [
          row.adsn_code, row.gtu || null, row.tipo || null, row.projecto || null,
          row.origem || null, row.destinatario || null, row.destinatario_contact || null,
          row.provincia || null, row.distrito || null, row.sku || null,
          row.product_name || null, row.peso_kg || 0, row.volumes || 0,
          now(), userId || null, fileName || null,
        ]
      );
      return { inserted: true, id: r.insertId };
    } catch (e) {
      if (e.code === "ER_DUP_ENTRY") return { inserted: false, duplicate: true };
      throw e;
    }
  },
  async updateStatus(id, status) {
    return execute("UPDATE adsn_services SET status = ? WHERE id = ?", [status, id]);
  },
  async counts() {
    const rows = await query("SELECT status, COUNT(*) AS c FROM adsn_services GROUP BY status");
    const out = { pending: 0, dispatched: 0, cancelled: 0 };
    rows.forEach((r) => { out[r.status] = r.c; });
    return out;
  },
};

// ── Stock Exits (one per ADSN) ───────────────────────────────
const StockExits = {
  async list(filters) {
    const f = filters || {};
    const where = [];
    const params = [];
    if (f.plate) { where.push("e.truck_plate LIKE ?"); params.push("%" + f.plate + "%"); }
    if (f.from) { where.push("e.dispatched_at >= ?"); params.push(f.from); }
    if (f.to) { where.push("e.dispatched_at <= ?"); params.push(f.to); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    return query(
      `SELECT e.*, a.adsn_code, a.gtu, a.destinatario, a.provincia, a.distrito,
              a.product_name, a.peso_kg
       FROM stock_exits e
       LEFT JOIN adsn_services a ON e.adsn_id = a.id
       ${whereSql}
       ORDER BY e.dispatched_at DESC LIMIT 500`,
      params
    );
  },
  async findById(id) {
    return queryOne(
      `SELECT e.*, a.adsn_code, a.gtu, a.destinatario, a.destinatario_contact,
              a.provincia, a.distrito, a.product_name, a.sku, a.peso_kg, a.volumes
       FROM stock_exits e
       LEFT JOIN adsn_services a ON e.adsn_id = a.id
       WHERE e.id = ?`,
      [id]
    );
  },
  async nextNumber() {
    const year = new Date().getFullYear();
    const prefix = `OUT-${year}-`;
    const row = await queryOne(
      "SELECT exit_number FROM stock_exits WHERE exit_number LIKE ? ORDER BY id DESC LIMIT 1",
      [prefix + "%"]
    );
    let seq = 1;
    if (row) {
      const m = row.exit_number.match(/-(\d+)$/);
      if (m) seq = Number(m[1]) + 1;
    }
    return prefix + String(seq).padStart(4, "0");
  },
  async create(data, userId) {
    const adsn = await ADSN.findById(data.adsn_id);
    if (!adsn) throw new Error("ADSN não encontrado");
    if (adsn.status === "dispatched") throw new Error("Este ADSN já foi despachado");
    if (adsn.status === "cancelled") throw new Error("Este ADSN foi cancelado");

    // Validate stock availability for this product
    const available = await Stock.availableByProductName(adsn.product_name);
    if (available < Number(adsn.peso_kg) - 0.001) {
      throw new Error(`Stock insuficiente de ${adsn.product_name} (disponível: ${available}, pedido: ${adsn.peso_kg})`);
    }

    const exit_number = await this.nextNumber();
    const r = await execute(
      `INSERT INTO stock_exits
       (exit_number, adsn_id, truck_plate, driver_name, driver_phone, transporter_name, dispatched_at, dispatched_by, notes)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        exit_number, data.adsn_id, data.truck_plate || null, data.driver_name || null,
        data.driver_phone || null, data.transporter_name || null,
        data.dispatched_at || now(), userId || null, data.notes || null,
      ]
    );
    const exit_id = r.insertId;

    // Stock movement
    await execute(
      `INSERT INTO stock_movements (type, product, qty, exit_id, truck_plate, created_at, created_by, notes)
       VALUES ('adsn_out', ?, ?, ?, ?, ?, ?, ?)`,
      [adsn.product_name, adsn.peso_kg, exit_id, data.truck_plate || null, now(), userId || null, `Saída ${exit_number} (ADSN ${adsn.adsn_code})`]
    );

    await ADSN.updateStatus(data.adsn_id, "dispatched");
    return { id: exit_id, exit_number };
  },
  async cancel(id) {
    const exit = await queryOne("SELECT adsn_id FROM stock_exits WHERE id = ?", [id]);
    if (!exit) return;
    // Reverse stock movement (add adjustment)
    const mv = await queryOne("SELECT product, qty FROM stock_movements WHERE exit_id = ? AND type = 'adsn_out' LIMIT 1", [id]);
    if (mv) {
      await execute(
        `INSERT INTO stock_movements (type, product, qty, created_at, notes)
         VALUES ('adjustment', ?, ?, ?, ?)`,
        [mv.product, mv.qty, now(), `Reversão de saída cancelada (exit_id=${id})`]
      );
    }
    await ADSN.updateStatus(exit.adsn_id, "pending");
    return execute("DELETE FROM stock_exits WHERE id = ?", [id]);
  },
};

// Add helper to existing Stock for availability check by product name
Stock.availableByProductName = async function(productName) {
  const r = await queryOne(
    `SELECT COALESCE(SUM(CASE
       WHEN type IN ('authorization_in','warehouse_in','truck_in') THEN qty
       WHEN type IN ('adsn_out','warehouse_out','departure','transfer_out','truck_unload') THEN -qty
       WHEN type = 'adjustment' THEN qty
       ELSE 0 END), 0) AS available
     FROM stock_movements WHERE product = ?`,
    [productName]
  );
  return Number(r ? r.available : 0);
};

// Extended stock queries
Stock.currentByProduct = async function(filters) {
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.supplier_id) { where.push("supplier_id = ?"); params.push(f.supplier_id); }
  if (f.plate) { where.push("truck_plate LIKE ?"); params.push("%" + f.plate + "%"); }
  if (f.from) { where.push("created_at >= ?"); params.push(f.from); }
  if (f.to) { where.push("created_at <= ?"); params.push(f.to); }
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  return query(
    `SELECT product, product_id,
            SUM(CASE
              WHEN type IN ('authorization_in','warehouse_in','truck_in') THEN qty
              WHEN type IN ('adsn_out','warehouse_out','departure','transfer_out','truck_unload') THEN -qty
              WHEN type = 'adjustment' THEN qty
              ELSE 0 END) AS qty_available
     FROM stock_movements ${whereSql}
     GROUP BY product, product_id
     HAVING qty_available > 0
     ORDER BY product`,
    params
  );
};

Stock.movements = async function(filters) {
  const f = filters || {};
  const where = [];
  const params = [];
  if (f.plate) { where.push("m.truck_plate LIKE ?"); params.push("%" + f.plate + "%"); }
  if (f.supplier_id) { where.push("m.supplier_id = ?"); params.push(f.supplier_id); }
  if (f.product_id) { where.push("m.product_id = ?"); params.push(f.product_id); }
  if (f.type) { where.push("m.type = ?"); params.push(f.type); }
  if (f.from) { where.push("m.created_at >= ?"); params.push(f.from); }
  if (f.to) { where.push("m.created_at <= ?"); params.push(f.to); }
  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  return query(
    `SELECT m.*, u.name AS user_name, s.name AS supplier_name,
            e.entry_number, x.exit_number
     FROM stock_movements m
     LEFT JOIN users u ON m.created_by = u.id
     LEFT JOIN suppliers s ON m.supplier_id = s.id
     LEFT JOIN stock_entries e ON m.entry_id = e.id
     LEFT JOIN stock_exits x ON m.exit_id = x.id
     ${whereSql}
     ORDER BY m.created_at DESC LIMIT 500`,
    params
  );
};

module.exports = {
  Users, Sessions, Suppliers, Requisitions, Trucks, Cargo,
  Attachments, Transfers, Stock, Audit,
  Products, Warehouses, Departures, Plans,
  PurchaseOrders, Authorizations, StockEntries, ADSN, StockExits,
};
