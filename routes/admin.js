/**
 * Admin routes — internal operations system.
 * Mounted at /admin in app.js.
 */
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const router = express.Router();

const auth = require("../auth");
const { execute } = require("../db/mysql");
const {
  Users, Suppliers, Requisitions, Trucks, Cargo,
  Attachments, Transfers, Stock, Audit,
  Products, Warehouses, Departures, Plans,
} = require("../db/ops-repo");

// Async error wrapper - never crashes the server
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    console.error("[admin] route error:", err.message);
    if (res.headersSent) return next(err);
    if (req.accepts("html")) {
      res.status(500).send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
        <h1>Erro do sistema interno</h1>
        <p><strong>${err.message}</strong></p>
        <p>Verifica que o MySQL esta a correr e que a base de dados <code>aqi_operations</code> existe.</p>
        <p><a href="/">Voltar ao dashboard publico</a></p>
        </body></html>`);
    } else {
      res.status(500).json({ error: err.message });
    }
  });
}

// ── Multer config for uploads ──────────────────────────────
const UPLOAD_DIR = path.join(__dirname, "..", "data", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const truckDir = path.join(UPLOAD_DIR, "trucks", String(req.params.id));
    fs.mkdirSync(truckDir, { recursive: true });
    cb(null, truckDir);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// ── Helpers ─────────────────────────────────────────────────
function send(res, file) {
  res.sendFile(path.join(__dirname, "..", "templates", "admin", file));
}

function jsonError(res, status, msg) {
  return res.status(status).json({ error: msg });
}

// ── Setup (first time) ──────────────────────────────────────
router.get("/setup", async (_req, res) => {
  if (!(await auth.setupNeeded())) return res.redirect("/admin/login");
  send(res, "setup.html");
});

router.post("/setup", express.json(), async (req, res) => {
  if (!(await auth.setupNeeded())) return jsonError(res, 403, "Setup ja efectuado");
  const { email, password, name } = req.body;
  if (!email || !password || !name) return jsonError(res, 400, "Todos os campos sao obrigatorios");
  if (password.length < 8) return jsonError(res, 400, "Password deve ter pelo menos 8 caracteres");
  try {
    const id = await auth.createInitialSuperadmin({ email, password, name });
    const token = await auth.createSession(id, req.ip, req.headers["user-agent"]);
    auth.setSessionCookie(res, token);
    await auth.logAction(req, "setup", "user", id, "Initial superadmin created");
    res.json({ ok: true, redirect: "/admin" });
  } catch (e) {
    jsonError(res, 500, e.message);
  }
});

// ── Login ───────────────────────────────────────────────────
router.get("/login", async (req, res) => {
  if (await auth.setupNeeded()) return res.redirect("/admin/setup");
  if (req.user) return res.redirect("/admin");
  send(res, "login.html");
});

router.post("/login", express.json(), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return jsonError(res, 400, "Email e password obrigatorios");
  const user = await Users.findByEmail(email);
  if (!user || !user.active) return jsonError(res, 401, "Credenciais invalidas");
  const ok = await auth.verifyPassword(password, user.password_hash);
  if (!ok) return jsonError(res, 401, "Credenciais invalidas");
  const token = await auth.createSession(user.id, req.ip, req.headers["user-agent"]);
  auth.setSessionCookie(res, token);
  await Users.touchLogin(user.id);
  await auth.logAction({ user: { id: user.id }, ip: req.ip }, "login", "user", user.id);
  res.json({ ok: true, redirect: "/admin" });
});

router.post("/logout", async (req, res) => {
  if (req.sessionToken) await auth.destroySession(req.sessionToken);
  auth.clearSessionCookie(res);
  res.redirect("/admin/login");
});

// ── All routes below require auth ───────────────────────────
router.use(auth.requireAuth);

// ── Dashboard ───────────────────────────────────────────────
router.get("/", (_req, res) => send(res, "dashboard.html"));

// ── User APIs ───────────────────────────────────────────────
router.get("/api/me", (req, res) => res.json(req.user));

router.get("/api/dashboard", async (_req, res) => {
  const trucks = await Trucks.list();
  const stock = await Stock.virtualStock();
  const reqs = await Requisitions.list();
  const recent = await Stock.movements(20);
  res.json({
    trucks: {
      total: trucks.length,
      expected: trucks.filter((t) => t.status === "expected").length,
      arrived: trucks.filter((t) => t.status === "arrived" || t.status === "unloading").length,
      unloaded: trucks.filter((t) => t.status === "unloaded").length,
    },
    stock,
    requisitions: {
      total: reqs.length,
      pending: reqs.filter((r) => r.status === "pending").length,
      partial: reqs.filter((r) => r.status === "partial").length,
    },
    recent_movements: recent,
  });
});

// ── Suppliers ───────────────────────────────────────────────
router.get("/suppliers", (_req, res) => send(res, "suppliers.html"));

router.get("/api/suppliers", async (_req, res) => {
  res.json(await Suppliers.list());
});
router.post("/api/suppliers", express.json(), async (req, res) => {
  const id = await Suppliers.create(req.body, req.user.id);
  await auth.logAction(req, "create", "supplier", id, req.body.name);
  res.json({ id });
});
router.put("/api/suppliers/:id", express.json(), async (req, res) => {
  await Suppliers.update(req.params.id, req.body);
  await auth.logAction(req, "update", "supplier", req.params.id);
  res.json({ ok: true });
});
router.delete("/api/suppliers/:id", auth.requireRole("superadmin", "admin"), async (req, res) => {
  await Suppliers.remove(req.params.id);
  await auth.logAction(req, "delete", "supplier", req.params.id);
  res.json({ ok: true });
});

// ── Requisitions ────────────────────────────────────────────
router.get("/requisitions", (_req, res) => send(res, "requisitions.html"));

router.get("/api/requisitions", async (_req, res) => {
  res.json(await Requisitions.list());
});
router.post("/api/requisitions", express.json(), async (req, res) => {
  const id = await Requisitions.create(req.body, req.user.id);
  await auth.logAction(req, "create", "requisition", id);
  res.json({ id });
});
router.put("/api/requisitions/:id", express.json(), async (req, res) => {
  await Requisitions.update(req.params.id, req.body);
  await auth.logAction(req, "update", "requisition", req.params.id);
  res.json({ ok: true });
});
router.delete("/api/requisitions/:id", auth.requireRole("superadmin", "admin"), async (req, res) => {
  await Requisitions.remove(req.params.id);
  await auth.logAction(req, "delete", "requisition", req.params.id);
  res.json({ ok: true });
});

// ── Trucks ──────────────────────────────────────────────────
router.get("/trucks", (_req, res) => send(res, "trucks.html"));
router.get("/trucks/:id", (_req, res) => send(res, "truck-detail.html"));

router.get("/api/trucks", async (req, res) => {
  res.json(await Trucks.list(req.query));
});
router.get("/api/trucks/:id", async (req, res) => {
  const truck = await Trucks.findById(req.params.id);
  if (!truck) return jsonError(res, 404, "not found");
  truck.cargo = await Cargo.listByTruck(req.params.id);
  truck.attachments = await Attachments.listByTruck(req.params.id);
  truck.transfers = await Transfers.listByTruck(req.params.id);
  res.json(truck);
});
router.post("/api/trucks", express.json(), async (req, res) => {
  const id = await Trucks.create(req.body, req.user.id);
  await auth.logAction(req, "create", "truck", id, req.body.plate);
  res.json({ id });
});
router.put("/api/trucks/:id", express.json(), async (req, res) => {
  await Trucks.update(req.params.id, req.body);
  await auth.logAction(req, "update", "truck", req.params.id);
  res.json({ ok: true });
});
router.post("/api/trucks/:id/status", express.json(), async (req, res) => {
  await Trucks.setStatus(req.params.id, req.body.status);
  if (req.body.status === "unloaded") {
    // Stock movements: each cargo item becomes a truck_unload movement
    const cargo = await Cargo.listByTruck(req.params.id);
    for (const c of cargo) {
      await Stock.addMovement({ type: "truck_unload", product: c.product, qty: c.qty_current, truck_id: req.params.id }, req.user.id);
    }
  }
  await auth.logAction(req, "status", "truck", req.params.id, req.body.status);
  res.json({ ok: true });
});
router.delete("/api/trucks/:id", auth.requireRole("superadmin", "admin"), async (req, res) => {
  await Trucks.remove(req.params.id);
  await auth.logAction(req, "delete", "truck", req.params.id);
  res.json({ ok: true });
});

// Cargo
router.post("/api/trucks/:id/cargo", express.json(), async (req, res) => {
  const id = await Cargo.add(req.params.id, req.body);
  await Stock.addMovement({ type: "truck_in", product: req.body.product, qty: req.body.qty, truck_id: req.params.id }, req.user.id);
  await auth.logAction(req, "add_cargo", "truck", req.params.id, req.body.product + " " + req.body.qty);
  res.json({ id });
});
router.delete("/api/cargo/:id", async (req, res) => {
  await Cargo.remove(req.params.id);
  await auth.logAction(req, "remove_cargo", "cargo", req.params.id);
  res.json({ ok: true });
});

// Attachments
router.post("/api/trucks/:id/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return jsonError(res, 400, "Nenhum ficheiro");
  const id = await Attachments.create(req.params.id, req.file, req.user.id);
  await auth.logAction(req, "upload", "truck", req.params.id, req.file.originalname);
  res.json({ id });
});
router.get("/files/:fileId", async (req, res) => {
  const att = await Attachments.findById(req.params.fileId);
  if (!att) return res.status(404).send("Nao encontrado");
  res.download(att.file_path, att.original_name);
});
router.delete("/api/attachments/:id", async (req, res) => {
  const att = await Attachments.findById(req.params.id);
  if (att && fs.existsSync(att.file_path)) fs.unlinkSync(att.file_path);
  await Attachments.remove(req.params.id);
  await auth.logAction(req, "delete_attachment", "attachment", req.params.id);
  res.json({ ok: true });
});

// Transfers
router.post("/api/trucks/:id/transfer", express.json(), async (req, res) => {
  const data = { ...req.body, from_truck_id: Number(req.params.id) };
  const tid = await Transfers.create(data, req.user.id);
  await Stock.addMovement({ type: "transfer_out", product: data.product, qty: data.qty, truck_id: data.from_truck_id, transfer_id: tid }, req.user.id);
  await Stock.addMovement({ type: "transfer_in", product: data.product, qty: data.qty, truck_id: data.to_truck_id, transfer_id: tid }, req.user.id);
  await auth.logAction(req, "transfer", "truck", req.params.id, `${data.qty} ${data.unit} -> truck ${data.to_truck_id}`);
  res.json({ id: tid });
});

// ── Stock ───────────────────────────────────────────────────
router.get("/stock", (_req, res) => send(res, "stock.html"));
router.get("/api/stock", async (_req, res) => {
  res.json({
    virtual: await Stock.virtualStock(),
    movements: await Stock.movements(50),
  });
});

// ── Users (superadmin only) ─────────────────────────────────
router.get("/users", auth.requireRole("superadmin"), (_req, res) => send(res, "users.html"));

router.get("/api/users", auth.requireRole("superadmin"), async (_req, res) => {
  res.json(await Users.list());
});
router.post("/api/users", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || !name || !role) return jsonError(res, 400, "Campos obrigatorios em falta");
  if (password.length < 8) return jsonError(res, 400, "Password com minimo 8 chars");
  const exists = await Users.findByEmail(email);
  if (exists) return jsonError(res, 409, "Email ja existe");
  const hash = await auth.hashPassword(password);
  const id = await Users.create({ email, password_hash: hash, name, role, created_by: req.user.id });
  await auth.logAction(req, "create", "user", id, email);
  res.json({ id });
});
router.post("/api/users/:id/password", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 8) return jsonError(res, 400, "Password invalida");
  const hash = await auth.hashPassword(password);
  await Users.updatePassword(req.params.id, hash);
  await auth.logAction(req, "reset_password", "user", req.params.id);
  res.json({ ok: true });
});
router.post("/api/users/:id/active", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  await Users.setActive(req.params.id, req.body.active);
  await auth.logAction(req, "set_active", "user", req.params.id, String(req.body.active));
  res.json({ ok: true });
});

// ── Audit ───────────────────────────────────────────────────
router.get("/audit", auth.requireRole("superadmin", "admin"), (_req, res) => send(res, "audit.html"));
router.get("/api/audit", auth.requireRole("superadmin", "admin"), async (_req, res) => {
  res.json(await Audit.list(200));
});

// ── Products (catalog) ─────────────────────────────────────
router.get("/products", (_req, res) => send(res, "products.html"));

router.get("/api/products", async (req, res) => {
  res.json(await Products.list(req.query.all === "1"));
});
router.post("/api/products", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  const id = await Products.create(req.body, req.user.id);
  await auth.logAction(req, "create", "product", id, req.body.name);
  res.json({ id });
});
router.put("/api/products/:id", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  await Products.update(req.params.id, req.body);
  await auth.logAction(req, "update", "product", req.params.id);
  res.json({ ok: true });
});
router.post("/api/products/:id/active", auth.requireRole("superadmin"), express.json(), async (req, res) => {
  await Products.setActive(req.params.id, req.body.active);
  await auth.logAction(req, "set_active", "product", req.params.id, String(req.body.active));
  res.json({ ok: true });
});

// ── Warehouses ─────────────────────────────────────────────
router.get("/warehouses", (_req, res) => send(res, "warehouses.html"));
router.get("/warehouses/:id", (_req, res) => send(res, "warehouse-detail.html"));

router.get("/api/warehouses", async (req, res) => {
  res.json(await Warehouses.list(req.query.all === "1"));
});
router.get("/api/warehouses/:id", async (req, res) => {
  const w = await Warehouses.findById(req.params.id);
  if (!w) return jsonError(res, 404, "not found");
  w.stock = await Stock.warehouseStock(req.params.id);
  res.json(w);
});
router.get("/api/warehouses/:id/stock", async (req, res) => {
  res.json(await Stock.warehouseStock(req.params.id));
});
router.post("/api/warehouses", auth.requireRole("superadmin", "admin"), express.json(), async (req, res) => {
  const id = await Warehouses.create(req.body, req.user.id);
  await auth.logAction(req, "create", "warehouse", id, req.body.name);
  res.json({ id });
});
router.put("/api/warehouses/:id", auth.requireRole("superadmin", "admin"), express.json(), async (req, res) => {
  await Warehouses.update(req.params.id, req.body);
  await auth.logAction(req, "update", "warehouse", req.params.id);
  res.json({ ok: true });
});
router.post("/api/warehouses/:id/active", auth.requireRole("superadmin", "admin"), express.json(), async (req, res) => {
  await Warehouses.setActive(req.params.id, req.body.active);
  res.json({ ok: true });
});

// ── Trucks: Quick Receive + Unload to Warehouse ────────────
router.post("/api/trucks/quick-receive", express.json(), async (req, res) => {
  // body: { plate, driver_name?, driver_phone?, supplier_id?, warehouse_id, items: [{product_id, qty, unit?}] }
  const { plate, driver_name, driver_phone, supplier_id, warehouse_id, items, notes } = req.body;
  if (!plate || !warehouse_id || !Array.isArray(items) || items.length === 0) {
    return jsonError(res, 400, "plate, warehouse_id e items obrigatorios");
  }

  // 1. Create truck
  const truckId = await Trucks.create(
    { plate, driver_name, driver_phone, supplier_id, status: "unloaded", arrived_at: new Date().toISOString().slice(0,19).replace("T"," "), notes },
    req.user.id
  );
  // 2. Add cargo + create movements warehouse_in
  for (const it of items) {
    const product = await Products.findById(it.product_id);
    if (!product) continue;
    const unit = it.unit || product.default_unit;
    const cargoId = await Cargo.add(truckId, { product: product.name, qty: it.qty, unit, notes: it.notes });
    // Mark cargo as already unloaded
    await execute(
      "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, product_id = ?, qty_current = 0 WHERE id = ?",
      [warehouse_id, product.id, cargoId]
    );
    await Stock.addMovement({
      type: "warehouse_in",
      product: product.name, product_id: product.id,
      qty: it.qty, truck_id: truckId, warehouse_id,
      notes: "Quick receive",
    }, req.user.id);
  }
  // 3. Mark truck unloaded
  await Trucks.setStatus(truckId, "unloaded");
  await auth.logAction(req, "quick_receive", "truck", truckId, plate);
  res.json({ id: truckId });
});

router.post("/api/trucks/:id/unload-to-warehouse", express.json(), async (req, res) => {
  const truckId = req.params.id;
  const { warehouse_id } = req.body;
  if (!warehouse_id) return jsonError(res, 400, "warehouse_id obrigatorio");
  const cargo = await Cargo.listByTruck(truckId);
  for (const c of cargo) {
    if (c.qty_current <= 0) continue;
    await execute(
      "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, qty_current = 0 WHERE id = ?",
      [warehouse_id, c.id]
    );
    await Stock.addMovement({
      type: "warehouse_in",
      product: c.product, product_id: c.product_id,
      qty: c.qty_current, truck_id: truckId, warehouse_id,
      notes: "Unload to warehouse",
    }, req.user.id);
  }
  await Trucks.setStatus(truckId, "unloaded");
  await auth.logAction(req, "unload_to_warehouse", "truck", truckId, "warehouse=" + warehouse_id);
  res.json({ ok: true });
});

// ── Departures ─────────────────────────────────────────────
router.get("/departures", (_req, res) => send(res, "departures.html"));

router.get("/api/departures", async (req, res) => {
  res.json(await Departures.list(req.query));
});
router.get("/api/departures/:id", async (req, res) => {
  const d = await Departures.findById(req.params.id);
  if (!d) return jsonError(res, 404, "not found");
  res.json(d);
});
router.post("/api/departures", express.json(), async (req, res) => {
  // body: { truck_id, source_type, source_warehouse_id?, destination_*, items: [{product_id, qty, unit}], plan_id? }
  const { truck_id, source_type, source_warehouse_id, items } = req.body;
  if (!truck_id || !source_type || !Array.isArray(items) || items.length === 0) {
    return jsonError(res, 400, "campos obrigatorios em falta");
  }
  if (source_type === "warehouse" && !source_warehouse_id) {
    return jsonError(res, 400, "source_warehouse_id obrigatorio quando source=warehouse");
  }
  const depId = await Departures.create(req.body, req.user.id);
  for (const it of items) {
    const product = await Products.findById(it.product_id);
    if (!product) continue;
    const unit = it.unit || product.default_unit;
    await Departures.addItem(depId, {
      product_id: product.id, product_name: product.name,
      qty: it.qty, unit, notes: it.notes,
    });
    if (source_type === "warehouse") {
      // Decrease warehouse stock
      await Stock.addMovement({
        type: "departure",
        product: product.name, product_id: product.id,
        qty: it.qty, truck_id,
        warehouse_id: source_warehouse_id,
        departure_id: depId,
        notes: "Departure to " + (req.body.destination_district || ""),
      }, req.user.id);
    } else {
      // Decrease truck cargo
      const truckCargo = await Cargo.listByTruck(truck_id);
      const match = truckCargo.find((c) => (c.product_id === product.id) || c.product === product.name);
      if (match && match.qty_current >= it.qty) {
        await Cargo.updateCurrent(match.id, Number(match.qty_current) - Number(it.qty));
      }
      await Stock.addMovement({
        type: "departure",
        product: product.name, product_id: product.id,
        qty: it.qty, truck_id,
        departure_id: depId,
        notes: "Direct departure from truck",
      }, req.user.id);
    }
  }
  // Update truck status
  if (source_type === "warehouse") {
    // Truck is being loaded for delivery; mark as in_transit via departure
  } else {
    await Trucks.setStatus(truck_id, "transferred");
  }
  await auth.logAction(req, "create_departure", "departure", depId, "truck=" + truck_id);
  res.json({ id: depId });
});
router.post("/api/departures/:id/delivered", express.json(), async (req, res) => {
  await Departures.setStatus(req.params.id, "delivered");
  await auth.logAction(req, "deliver", "departure", req.params.id);
  res.json({ ok: true });
});
router.post("/api/departures/:id/cancel", express.json(), async (req, res) => {
  await Departures.setStatus(req.params.id, "cancelled");
  await auth.logAction(req, "cancel", "departure", req.params.id);
  res.json({ ok: true });
});

// ── Plans ──────────────────────────────────────────────────
router.get("/plans", (_req, res) => send(res, "plans.html"));
router.get("/plans/:id", (_req, res) => send(res, "plan-detail.html"));

router.get("/api/plans", async (_req, res) => {
  res.json(await Plans.list());
});
router.get("/api/plans/:id", async (req, res) => {
  const p = await Plans.findById(req.params.id);
  if (!p) return jsonError(res, 404, "not found");
  res.json(p);
});
router.post("/api/plans", auth.requireRole("superadmin", "admin"), express.json(), async (req, res) => {
  const planId = await Plans.create(req.body, req.user.id);
  if (Array.isArray(req.body.items)) {
    for (const item of req.body.items) {
      const product = await Products.findById(item.product_id);
      if (!product) continue;
      await Plans.addItem(planId, {
        product_id: product.id, product_name: product.name,
        qty: item.qty, unit: item.unit || product.default_unit,
        source_warehouse_id: item.source_warehouse_id,
        beneficiary: item.beneficiary, notes: item.notes,
      });
    }
  }
  await auth.logAction(req, "create", "plan", planId, req.body.name);
  res.json({ id: planId });
});
router.post("/api/plans/:id/reserve", auth.requireRole("superadmin", "admin"), async (req, res) => {
  await Plans.setStatus(req.params.id, "reserved");
  await Plans.setItemsStatus(req.params.id, "reserved");
  await auth.logAction(req, "reserve", "plan", req.params.id);
  res.json({ ok: true });
});
router.post("/api/plans/:id/cancel", auth.requireRole("superadmin", "admin"), async (req, res) => {
  await Plans.setStatus(req.params.id, "cancelled");
  await Plans.setItemsStatus(req.params.id, "cancelled");
  await auth.logAction(req, "cancel", "plan", req.params.id);
  res.json({ ok: true });
});

// Update existing /api/stock to return new structure
router.get("/api/stock-v2", async (_req, res) => {
  res.json({
    by_warehouse: await Stock.byWarehouse(),
    by_truck: await Stock.byTruck(),
    totals: await Stock.virtualStock(),
    movements: await Stock.movements(50),
  });
});

module.exports = router;
