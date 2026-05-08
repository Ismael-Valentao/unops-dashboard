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
  PurchaseOrders, Authorizations, StockEntries, ADSN, StockExits,
} = require("../db/ops-repo");
const { Beneficiaries, Balances, Services: DistServices, Reconciliation: DistReconciliation, Reports: DistReports } = require("../db/distribution-repo");
const sheetCache = require("../lib/sheet-cache");
const { importPlanning, importServices } = require("../lib/distribution-bootstrap");
const { parseGuia: parseAdicionalGuia } = require("../lib/parse-adicional-guia");
const { parsePOExcel } = require("../lib/parse-po-excel");
const { parseADSNExcel } = require("../lib/parse-adsn-excel");

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

// ── MySQL gate: if DB not available, show friendly page instead of crashing ──
router.use(async (req, res, next) => {
  try {
    const { getPool } = require("../db/mysql");
    const conn = await getPool().getConnection();
    conn.release();
    next();
  } catch (e) {
    if (req.accepts("html")) {
      res.status(503).send(`<!doctype html><html><head><meta charset="utf-8"><title>MySQL indisponível</title>
        <style>body{font-family:system-ui,sans-serif;max-width:640px;margin:4rem auto;padding:2rem;background:#f8fafc}
          h1{color:#dc2626;margin:0 0 .5rem}code{background:#fff;padding:.15rem .35rem;border-radius:4px;font-size:.85rem}
          .box{background:#fff;border-left:4px solid #dc2626;padding:1rem 1.25rem;border-radius:6px;margin-top:1rem}</style>
        </head><body>
        <h1>⚠️ MySQL indisponível</h1>
        <p>O sistema interno (<code>/admin/*</code>) precisa de uma base MySQL que não está acessível.</p>
        <div class="box">
          <strong>Erro:</strong> ${e.code || e.message}
        </div>
        <p style="margin-top:1.25rem">O dashboard público continua a funcionar normalmente.</p>
        <p><a href="/">← Voltar ao dashboard público</a></p>
        </body></html>`);
    } else {
      res.status(503).json({ error: "MySQL indisponível", code: e.code || e.message });
    }
  }
});

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
  const departures = await Departures.list();

  // Build actionable alerts
  const alerts = [];
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  // Trucks expected for >24h
  trucks.forEach((t) => {
    if (t.status === "expected" && t.created_at) {
      const ageDays = (now - new Date(t.created_at.replace(" ", "T")).getTime()) / dayMs;
      if (ageDays > 1) alerts.push({
        severity: "warning",
        msg: `Camiao ${t.plate} esperado ha ${Math.round(ageDays)} dia(s)`,
        link: "/admin/trucks/" + t.id,
      });
    }
  });
  // Trucks arrived but with no cargo
  trucks.forEach((t) => {
    if (t.status === "arrived" && t.cargo_count === 0) alerts.push({
      severity: "info",
      msg: `Camiao ${t.plate} chegou mas nao tem carga registada`,
      link: "/admin/trucks/" + t.id,
    });
  });
  // Departures in transit for >7d
  departures.forEach((d) => {
    if (d.status === "in_transit" && d.departed_at) {
      const ageDays = (now - new Date(d.departed_at.replace(" ", "T")).getTime()) / dayMs;
      if (ageDays > 7) alerts.push({
        severity: "warning",
        msg: `Saida do camiao ${d.plate} em transito ha ${Math.round(ageDays)} dia(s) sem confirmacao`,
        link: "/admin/departures",
      });
    }
  });

  res.json({
    trucks: {
      total: trucks.length,
      expected: trucks.filter((t) => t.status === "expected").length,
      arrived: trucks.filter((t) => t.status === "arrived" || t.status === "unloading").length,
      unloaded: trucks.filter((t) => t.status === "unloaded").length,
      with_cargo: trucks.filter((t) => t.cargo_count > 0).length,
    },
    departures: {
      in_transit: departures.filter((d) => d.status === "in_transit").length,
      delivered_today: departures.filter((d) =>
        d.status === "delivered" && d.delivered_at &&
        d.delivered_at.slice(0, 10) === new Date().toISOString().slice(0, 10)
      ).length,
    },
    stock,
    requisitions: {
      total: reqs.length,
      pending: reqs.filter((r) => r.status === "pending").length,
      partial: reqs.filter((r) => r.status === "partial").length,
    },
    alerts,
    recent_movements: recent,
  });
});

// ── Truck cargo (for departure UI to show available items) ─
router.get("/api/trucks/:id/cargo", async (req, res) => {
  res.json(await Stock.truckCargo(req.params.id));
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
// Load truck — source can be 'warehouse' or another 'truck'
router.post("/api/trucks/:id/load", express.json(), async (req, res) => {
  const targetId = Number(req.params.id);
  const { source_type, source_id, items } = req.body;
  if (!source_type || !["warehouse", "truck"].includes(source_type)) {
    return jsonError(res, 400, "source_type deve ser 'warehouse' ou 'truck'");
  }
  if (!source_id) return jsonError(res, 400, "source_id obrigatorio");
  if (source_type === "truck" && Number(source_id) === targetId) {
    return jsonError(res, 400, "Camiao origem deve ser diferente do destino");
  }
  if (!Array.isArray(items) || items.length === 0) {
    return jsonError(res, 400, "items obrigatorio");
  }

  // Resolve products
  const resolved = [];
  for (const it of items) {
    const product = await Products.findById(it.product_id);
    if (!product) return jsonError(res, 400, "Produto invalido (id=" + it.product_id + ")");
    const qty = Number(it.qty);
    if (!qty || qty <= 0) return jsonError(res, 400, "Quantidade invalida para " + product.name);
    resolved.push({ product, qty, unit: it.unit || product.default_unit });
  }

  // Validate available stock at source
  if (source_type === "warehouse") {
    const available = await Stock.warehouseStock(source_id);
    for (const r of resolved) {
      const stockItem = available.find((s) => s.product_id === r.product.id || s.product === r.product.name);
      const have = stockItem ? Number(stockItem.qty) : 0;
      if (have < r.qty) {
        return jsonError(res, 400, `Stock insuficiente de ${r.product.name} no armazem (disponivel: ${have}, pedido: ${r.qty})`);
      }
    }
  } else {
    const sourceCargo = await Cargo.listByTruck(source_id);
    for (const r of resolved) {
      const lines = sourceCargo.filter((c) =>
        Number(c.qty_current) > 0 && !c.unloaded_to_warehouse_id &&
        ((c.product_id === r.product.id) || c.product === r.product.name)
      );
      const have = lines.reduce((s, c) => s + Number(c.qty_current), 0);
      if (have < r.qty) {
        return jsonError(res, 400, `Stock insuficiente de ${r.product.name} no camiao origem (disponivel: ${have}, pedido: ${r.qty})`);
      }
    }
  }

  // Apply movements
  for (const r of resolved) {
    if (source_type === "warehouse") {
      await Stock.addMovement({
        type: "warehouse_out",
        product: r.product.name, product_id: r.product.id,
        qty: r.qty, truck_id: targetId, warehouse_id: Number(source_id),
        notes: "Carregamento de camiao",
      }, req.user.id);
    } else {
      const sourceCargo = await Cargo.listByTruck(source_id);
      const lines = sourceCargo.filter((c) =>
        Number(c.qty_current) > 0 && !c.unloaded_to_warehouse_id &&
        ((c.product_id === r.product.id) || c.product === r.product.name)
      );
      let remaining = r.qty;
      for (const line of lines) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, Number(line.qty_current));
        await Cargo.updateCurrent(line.id, Number(line.qty_current) - take);
        remaining -= take;
      }
      const tid = await Transfers.create({
        from_truck_id: Number(source_id), to_truck_id: targetId,
        product: r.product.name, qty: r.qty, unit: r.unit, notes: "Carregamento entre camioes",
      }, req.user.id);
      await Stock.addMovement({
        type: "transfer_out",
        product: r.product.name, product_id: r.product.id,
        qty: r.qty, truck_id: Number(source_id), transfer_id: tid,
        notes: "Para camiao #" + targetId,
      }, req.user.id);
      await Stock.addMovement({
        type: "transfer_in",
        product: r.product.name, product_id: r.product.id,
        qty: r.qty, truck_id: targetId, transfer_id: tid,
        notes: "De camiao #" + source_id,
      }, req.user.id);
    }

    // Add cargo line to destination truck
    const newId = await Cargo.add(targetId, {
      product: r.product.name, qty: r.qty, unit: r.unit,
      notes: source_type === "warehouse" ? "Carregado de armazem" : "Carregado de camiao",
    });
    await execute("UPDATE truck_cargo SET product_id = ? WHERE id = ?", [r.product.id, newId]);
  }

  await auth.logAction(req, "load_truck", "truck", targetId,
    `${source_type}=${source_id}, ${resolved.length} itens`);
  res.json({ ok: true });
});

router.post("/api/trucks/:id/transfer", express.json(), async (req, res) => {
  const fromId = Number(req.params.id);
  const data = { ...req.body, from_truck_id: fromId };
  const qty = Number(data.qty);
  if (!data.to_truck_id) return jsonError(res, 400, "to_truck_id obrigatorio");
  if (Number(data.to_truck_id) === fromId) return jsonError(res, 400, "Camiao destino deve ser diferente da origem");
  if (!qty || qty <= 0) return jsonError(res, 400, "Quantidade invalida");

  // Resolve product
  let product = null;
  if (data.product_id) product = await Products.findById(data.product_id);
  if (!product && data.product) {
    // Fallback: try by name (legacy)
    const all = await Products.list();
    product = all.find((p) => p.name === data.product);
  }
  if (!product) return jsonError(res, 400, "Produto invalido");

  // 1. Find matching cargo line on the source truck
  const fromCargo = await Cargo.listByTruck(fromId);
  const sourceLines = fromCargo.filter((c) =>
    Number(c.qty_current) > 0 &&
    !c.unloaded_to_warehouse_id &&
    ((c.product_id === product.id) || c.product === product.name)
  );
  const totalAvailable = sourceLines.reduce((s, c) => s + Number(c.qty_current), 0);
  if (totalAvailable < qty) {
    return jsonError(res, 400, `Stock insuficiente de ${product.name} no camiao origem (disponivel: ${totalAvailable}, pedido: ${qty})`);
  }

  // 2. Decrement from source lines (FIFO)
  let remaining = qty;
  for (const line of sourceLines) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(line.qty_current));
    await Cargo.updateCurrent(line.id, Number(line.qty_current) - take);
    remaining -= take;
  }

  // 3. Add new cargo line on destination truck
  const unit = data.unit || product.default_unit;
  const newCargoId = await Cargo.add(data.to_truck_id, {
    product: product.name, qty, unit, notes: data.notes || ("Transferido do camiao #" + fromId),
  });
  await execute("UPDATE truck_cargo SET product_id = ? WHERE id = ?", [product.id, newCargoId]);

  // 4. Record the transfer + movements
  const tid = await Transfers.create({
    ...data, product: product.name, qty, unit,
  }, req.user.id);
  await Stock.addMovement({
    type: "transfer_out", product: product.name, product_id: product.id,
    qty, truck_id: fromId, transfer_id: tid,
    notes: "Transfer to truck #" + data.to_truck_id,
  }, req.user.id);
  await Stock.addMovement({
    type: "transfer_in", product: product.name, product_id: product.id,
    qty, truck_id: Number(data.to_truck_id), transfer_id: tid,
    notes: "Transfer from truck #" + fromId,
  }, req.user.id);

  await auth.logAction(req, "transfer", "truck", fromId, `${qty} ${unit} ${product.name} -> truck ${data.to_truck_id}`);
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
router.get("/api/warehouses/:id/movements", async (req, res) => {
  res.json(await Stock.warehouseMovements(req.params.id, 50));
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
  // body: { plate, driver_name?, driver_phone?, supplier_id?, warehouse_id?, items: [{product_id, qty, unit?}] }
  // warehouse_id is OPTIONAL: if provided, cargo is unloaded immediately to that warehouse;
  // if not, cargo stays on the truck (status='arrived') ready to be re-routed.
  const { plate, driver_name, driver_phone, supplier_id, warehouse_id, items, notes } = req.body;
  if (!plate || !Array.isArray(items) || items.length === 0) {
    return jsonError(res, 400, "plate e items obrigatorios");
  }

  const unloadNow = !!warehouse_id;
  const truckStatus = unloadNow ? "unloaded" : "arrived";

  // 1. Create truck
  const truckId = await Trucks.create(
    { plate, driver_name, driver_phone, supplier_id, status: truckStatus,
      arrived_at: new Date().toISOString().slice(0,19).replace("T"," "), notes },
    req.user.id
  );
  // 2. Add cargo + (optionally) create movements warehouse_in
  for (const it of items) {
    const product = await Products.findById(it.product_id);
    if (!product) continue;
    const unit = it.unit || product.default_unit;
    const cargoId = await Cargo.add(truckId, { product: product.name, qty: it.qty, unit, notes: it.notes });
    // Always link to product
    await execute("UPDATE truck_cargo SET product_id = ? WHERE id = ?", [product.id, cargoId]);

    if (unloadNow) {
      // Mark cargo as already unloaded
      await execute(
        "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, qty_current = 0 WHERE id = ?",
        [warehouse_id, cargoId]
      );
      await Stock.addMovement({
        type: "warehouse_in",
        product: product.name, product_id: product.id,
        qty: it.qty, truck_id: truckId, warehouse_id,
        notes: "Quick receive",
      }, req.user.id);
    } else {
      // Cargo stays on the truck — register the entry as truck_in
      await Stock.addMovement({
        type: "truck_in",
        product: product.name, product_id: product.id,
        qty: it.qty, truck_id: truckId,
        notes: "Recebido (carga mantida no camiao)",
      }, req.user.id);
    }
  }
  await auth.logAction(req, "quick_receive", "truck", truckId,
    plate + (unloadNow ? " (descarregado)" : " (carga retida)"));
  res.json({ id: truckId, unloaded: unloadNow });
});

router.post("/api/trucks/:id/unload-to-warehouse", express.json(), async (req, res) => {
  const truckId = req.params.id;
  const { warehouse_id, items } = req.body;
  // items: optional [{cargo_id, qty}] for partial unload. If absent, unload everything.
  if (!warehouse_id) return jsonError(res, 400, "warehouse_id obrigatorio");
  const cargo = await Cargo.listByTruck(truckId);

  if (Array.isArray(items) && items.length > 0) {
    // Partial unload — validate first
    for (const it of items) {
      const c = cargo.find((x) => x.id === Number(it.cargo_id));
      if (!c) return jsonError(res, 400, "Carga invalida (id=" + it.cargo_id + ")");
      if (Number(it.qty) <= 0) return jsonError(res, 400, "Quantidade deve ser > 0");
      if (Number(it.qty) > Number(c.qty_current)) {
        return jsonError(res, 400, `Qtd ${it.qty} excede disponivel ${c.qty_current} para ${c.product}`);
      }
    }
    for (const it of items) {
      const c = cargo.find((x) => x.id === Number(it.cargo_id));
      const qty = Number(it.qty);
      const remaining = Number(c.qty_current) - qty;
      if (remaining <= 0.001) {
        // Fully unloaded — mark this cargo line as unloaded
        await execute(
          "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, qty_current = 0 WHERE id = ?",
          [warehouse_id, c.id]
        );
      } else {
        // Partial — keep the cargo on the truck with reduced qty, create a NEW cargo line for the unloaded portion
        await Cargo.updateCurrent(c.id, remaining);
        const newCargoId = await Cargo.add(truckId, {
          product: c.product, qty, unit: c.unit, notes: "Descarga parcial para armazem"
        });
        await execute(
          "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, product_id = ?, qty_current = 0 WHERE id = ?",
          [warehouse_id, c.product_id, newCargoId]
        );
      }
      await Stock.addMovement({
        type: "warehouse_in",
        product: c.product, product_id: c.product_id,
        qty, truck_id: truckId, warehouse_id,
        notes: "Descarga parcial",
      }, req.user.id);
    }
    // If everything was unloaded, mark truck as unloaded
    const remaining = await Cargo.listByTruck(truckId);
    const stillHas = remaining.some((c) => Number(c.qty_current) > 0 && !c.unloaded_to_warehouse_id);
    if (!stillHas) await Trucks.setStatus(truckId, "unloaded");
  } else {
    // Unload everything
    for (const c of cargo) {
      if (c.qty_current <= 0) continue;
      const qty = Number(c.qty_current);
      await execute(
        "UPDATE truck_cargo SET unloaded_to_warehouse_id = ?, qty_current = 0 WHERE id = ?",
        [warehouse_id, c.id]
      );
      await Stock.addMovement({
        type: "warehouse_in",
        product: c.product, product_id: c.product_id,
        qty, truck_id: truckId, warehouse_id,
        notes: "Descarga total",
      }, req.user.id);
    }
    await Trucks.setStatus(truckId, "unloaded");
  }
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
  // body: { truck_id, destination_*, items: [{product_id, qty, unit}], plan_id? }
  // Simplified: always uses cargo currently on the truck. No source_type.
  const { truck_id, items } = req.body;
  if (!truck_id || !Array.isArray(items) || items.length === 0) {
    return jsonError(res, 400, "truck_id e items obrigatorios");
  }

  // Validate truck cargo has enough of each item
  const truckCargo = await Cargo.listByTruck(truck_id);
  const resolved = [];
  for (const it of items) {
    const product = await Products.findById(it.product_id);
    if (!product) return jsonError(res, 400, "Produto invalido (id=" + it.product_id + ")");
    const lines = truckCargo.filter((c) =>
      Number(c.qty_current) > 0 && !c.unloaded_to_warehouse_id &&
      ((c.product_id === product.id) || c.product === product.name)
    );
    const have = lines.reduce((s, c) => s + Number(c.qty_current), 0);
    if (have < Number(it.qty)) {
      return jsonError(res, 400, `Stock insuficiente de ${product.name} no camiao (disponivel: ${have}, pedido: ${it.qty})`);
    }
    resolved.push({ product, qty: Number(it.qty), unit: it.unit || product.default_unit, notes: it.notes, lines });
  }

  // Force source_type='truck' for backwards compat with the schema
  const depBody = { ...req.body, source_type: "truck", source_warehouse_id: null };
  const depId = await Departures.create(depBody, req.user.id);

  for (const r of resolved) {
    await Departures.addItem(depId, {
      product_id: r.product.id, product_name: r.product.name,
      qty: r.qty, unit: r.unit, notes: r.notes,
    });
    // Decrement truck cargo (FIFO)
    let remaining = r.qty;
    for (const line of r.lines) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, Number(line.qty_current));
      await Cargo.updateCurrent(line.id, Number(line.qty_current) - take);
      remaining -= take;
    }
    await Stock.addMovement({
      type: "departure",
      product: r.product.name, product_id: r.product.id,
      qty: r.qty, truck_id,
      departure_id: depId,
      notes: "Saida para " + (req.body.destination_district || req.body.destination_name || "destino"),
    }, req.user.id);
  }
  // Truck is now in transit / delivering
  await Trucks.setStatus(truck_id, "transferred");
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

// ─────────────────────────────────────────────────────────────
// Purchase Orders / Autorizações / Entradas / ADSN / Saídas
// ─────────────────────────────────────────────────────────────

// Multer config for Excel imports (memory) + entry attachments (disk)
const memUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const ENTRY_DIR = path.join(UPLOAD_DIR, "entries");
if (!fs.existsSync(ENTRY_DIR)) fs.mkdirSync(ENTRY_DIR, { recursive: true });
const entryStorage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const d = path.join(ENTRY_DIR, String(req.params.id || "tmp"));
    fs.mkdirSync(d, { recursive: true });
    cb(null, d);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    cb(null, `${ts}_${safe}`);
  },
});
const entryUpload = multer({ storage: entryStorage, limits: { fileSize: 15 * 1024 * 1024 } });

// ── Purchase Orders ────────────────────────────────────────
router.get("/purchase-orders", (_req, res) => send(res, "purchase-orders.html"));
router.get("/purchase-orders/:id", (_req, res) => send(res, "purchase-order-detail.html"));

router.get("/api/purchase-orders", ah(async (req, res) => {
  const list = await PurchaseOrders.list(req.query);
  res.json(list);
}));

router.get("/api/purchase-orders/:id", ah(async (req, res) => {
  const po = await PurchaseOrders.findById(req.params.id);
  if (!po) return jsonError(res, 404, "PO não encontrada");
  res.json(po);
}));

router.post("/api/purchase-orders/import", auth.requireRole("superadmin", "admin"), memUpload.single("file"), ah(async (req, res) => {
  if (!req.file) return jsonError(res, 400, "Ficheiro Excel necessário");
  const parsed = parsePOExcel(req.file.buffer);
  let created = 0, updated = 0, skipped = 0;

  for (const poData of parsed.orders) {
    // Match or create supplier
    let supplier = null;
    if (poData.supplier.nuit) supplier = await Suppliers.findByNuit(poData.supplier.nuit);
    if (!supplier) supplier = await Suppliers.findByName(poData.supplier.name);
    if (!supplier) {
      const sid = await Suppliers.create({
        name: poData.supplier.name,
        nuit: poData.supplier.nuit,
        client_number: poData.supplier.client_number,
      }, req.user.id);
      supplier = { id: sid };
    }

    // Check if PO exists
    const existing = await PurchaseOrders.findByNumber(poData.po_number);
    if (existing) { skipped++; continue; }

    const po_id = await PurchaseOrders.create({
      po_number: poData.po_number,
      supplier_id: supplier.id,
      supplier_nuit: poData.supplier.nuit,
      po_date: poData.po_date,
      projecto: poData.projecto,
      imported_from: req.file.originalname,
    }, req.user.id);

    for (const it of poData.items) {
      // Try to match product by code
      let product_id = null;
      const prod = await (async () => {
        const r = await require("../db/mysql").queryOne("SELECT id FROM products WHERE code = ? LIMIT 1", [it.product_code]);
        return r;
      })();
      if (prod) product_id = prod.id;

      await PurchaseOrders.addItem(po_id, {
        product_id,
        product_code: it.product_code,
        product_name: it.product_name,
        qty: it.qty,
        unit: it.unit,
      });
    }
    created++;
  }

  await auth.logAction(req, "import_po_excel", "purchase_orders", null, `${created} criadas, ${skipped} duplicadas`);
  res.json({ created, updated, skipped, total_rows: parsed.total_rows, filename: req.file.originalname });
}));

router.post("/api/purchase-orders/:id/cancel", auth.requireRole("superadmin", "admin"), ah(async (req, res) => {
  await PurchaseOrders.updateStatus(req.params.id, "cancelled");
  await auth.logAction(req, "cancel", "purchase_order", req.params.id);
  res.json({ ok: true });
}));

// ── Authorizations ─────────────────────────────────────────
router.get("/authorizations", (_req, res) => send(res, "authorizations.html"));
router.get("/authorizations/:id", (_req, res) => send(res, "authorization-detail.html"));
router.get("/authorizations/:id/print", (_req, res) => send(res, "authorization-print.html"));

router.get("/api/authorizations", ah(async (req, res) => {
  res.json(await Authorizations.list(req.query));
}));

router.get("/api/authorizations/:id", ah(async (req, res) => {
  const a = await Authorizations.findById(req.params.id);
  if (!a) return jsonError(res, 404, "Autorização não encontrada");
  res.json(a);
}));

router.post("/api/authorizations", auth.requireRole("superadmin", "admin"), express.json(), ah(async (req, res) => {
  const { po_id, truck_plate, driver_name } = req.body;
  if (!po_id) return jsonError(res, 400, "po_id obrigatório");
  if (!truck_plate) return jsonError(res, 400, "Matrícula obrigatória");
  if (!driver_name) return jsonError(res, 400, "Nome do motorista obrigatório");
  if (!req.body.items || !req.body.items.length) return jsonError(res, 400, "Pelo menos um item obrigatório");

  const result = await Authorizations.create(req.body, req.user.id);
  await auth.logAction(req, "create", "authorization", result.id, result.auth_number);
  res.json(result);
}));

router.post("/api/authorizations/:id/cancel", auth.requireRole("superadmin", "admin"), ah(async (req, res) => {
  await Authorizations.cancel(req.params.id);
  await auth.logAction(req, "cancel", "authorization", req.params.id);
  res.json({ ok: true });
}));

// ── Stock Entries ──────────────────────────────────────────
router.get("/entries", (_req, res) => send(res, "entries.html"));
router.get("/entries/:id", (_req, res) => send(res, "entry-detail.html"));

router.get("/api/entries", ah(async (req, res) => {
  res.json(await StockEntries.list(req.query));
}));

router.get("/api/entries/:id", ah(async (req, res) => {
  const e = await StockEntries.findById(req.params.id);
  if (!e) return jsonError(res, 404, "Entrada não encontrada");
  res.json(e);
}));

router.post("/api/entries", auth.requireRole("superadmin", "admin", "operator"), express.json(), ah(async (req, res) => {
  const { auth_id, items } = req.body;
  if (!auth_id) return jsonError(res, 400, "auth_id obrigatório");
  if (!items || !items.length) return jsonError(res, 400, "Pelo menos um item obrigatório");
  const result = await StockEntries.create(req.body, req.user.id);
  await auth.logAction(req, "create", "stock_entry", result.id, result.entry_number);
  res.json(result);
}));

router.post("/api/entries/:id/attachments", auth.requireRole("superadmin", "admin", "operator"),
  entryUpload.fields([{ name: "supplier_guide", maxCount: 5 }, { name: "signed_authorization", maxCount: 5 }, { name: "other", maxCount: 5 }]),
  ah(async (req, res) => {
    const entryId = req.params.id;
    const out = [];
    for (const kind of ["supplier_guide", "signed_authorization", "other"]) {
      const files = (req.files && req.files[kind]) || [];
      for (const f of files) {
        const rel = path.relative(path.join(__dirname, ".."), f.path).replace(/\\/g, "/");
        const id = await StockEntries.addAttachment(entryId, {
          kind, file_path: rel, original_name: f.originalname, mime_type: f.mimetype, size_bytes: f.size,
        }, req.user.id);
        out.push({ id, kind, file_path: rel });
      }
    }
    await auth.logAction(req, "upload", "stock_entry_attachment", entryId, `${out.length} ficheiros`);
    res.json({ uploaded: out });
  })
);

router.get("/api/entries/:id/attachments/:att_id/download", ah(async (req, res) => {
  const mysql = require("../db/mysql");
  const att = await mysql.queryOne(
    "SELECT * FROM stock_entry_attachments WHERE id = ? AND entry_id = ? LIMIT 1",
    [req.params.att_id, req.params.id]
  );
  if (!att) return jsonError(res, 404, "Anexo não encontrado");
  const abs = path.join(__dirname, "..", att.file_path);
  if (!fs.existsSync(abs)) return jsonError(res, 404, "Ficheiro não existe em disco");
  res.download(abs, att.original_name);
}));

// ── ADSN Services ──────────────────────────────────────────
router.get("/adsn", (_req, res) => send(res, "adsn.html"));

router.get("/api/adsn", ah(async (req, res) => {
  const [list, counts] = await Promise.all([ADSN.list(req.query), ADSN.counts()]);
  res.json({ list, counts });
}));

router.get("/api/adsn/search", ah(async (req, res) => {
  res.json(await ADSN.search(req.query.q || ""));
}));

router.get("/api/adsn/:id", ah(async (req, res) => {
  const a = await ADSN.findById(req.params.id);
  if (!a) return jsonError(res, 404, "ADSN não encontrado");
  res.json(a);
}));

router.post("/api/adsn/import", auth.requireRole("superadmin", "admin"), memUpload.single("file"), ah(async (req, res) => {
  if (!req.file) return jsonError(res, 400, "Ficheiro Excel necessário");
  const parsed = parseADSNExcel(req.file.buffer);
  let inserted = 0, duplicates = 0;
  for (const rec of parsed.records) {
    const r = await ADSN.upsert(rec, req.user.id, req.file.originalname);
    if (r.inserted) inserted++;
    else if (r.duplicate) duplicates++;
  }
  await auth.logAction(req, "import_adsn_excel", "adsn_services", null, `${inserted} inseridos, ${duplicates} duplicados`);
  res.json({ inserted, duplicates, skipped: parsed.skipped, total: parsed.total });
}));

// ── Stock Exits ────────────────────────────────────────────
router.get("/exits", (_req, res) => send(res, "exits.html"));

router.get("/api/exits", ah(async (req, res) => {
  res.json(await StockExits.list(req.query));
}));

router.get("/api/exits/:id", ah(async (req, res) => {
  const e = await StockExits.findById(req.params.id);
  if (!e) return jsonError(res, 404, "Saída não encontrada");
  res.json(e);
}));

router.post("/api/exits", auth.requireRole("superadmin", "admin", "operator"), express.json(), ah(async (req, res) => {
  const { adsn_id } = req.body;
  if (!adsn_id) return jsonError(res, 400, "adsn_id obrigatório");
  const result = await StockExits.create(req.body, req.user.id);
  await auth.logAction(req, "create", "stock_exit", result.id, result.exit_number);
  res.json(result);
}));

router.post("/api/exits/:id/cancel", auth.requireRole("superadmin", "admin"), ah(async (req, res) => {
  await StockExits.cancel(req.params.id);
  await auth.logAction(req, "cancel", "stock_exit", req.params.id);
  res.json({ ok: true });
}));

// ── Stock (v3 queries for the new flow) ────────────────────
router.get("/api/stock/current", ah(async (req, res) => {
  res.json(await Stock.currentByProduct(req.query));
}));

router.get("/api/stock/movements", ah(async (req, res) => {
  res.json(await Stock.movements(req.query));
}));

// ── Trucks loaded on a given day (default today) ───────────
router.get("/api/trucks-today", ah(async (req, res) => {
  const mysql = require("../db/mysql");
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().slice(0, 10);

  const rows = await mysql.query(
    `SELECT a.id, a.auth_number, a.truck_plate, a.driver_name, a.driver_phone,
            a.transporter_name, a.status, a.issued_at, a.pickup_date,
            po.po_number, po.supplier_id, s.name AS supplier_name,
            (SELECT GROUP_CONCAT(CONCAT(product_name, ' (', qty_to_pickup, ' ', unit, ')') SEPARATOR '; ')
             FROM pickup_auth_items WHERE auth_id = a.id) AS items_desc,
            (SELECT COALESCE(SUM(qty_to_pickup),0) FROM pickup_auth_items WHERE auth_id = a.id) AS total_qty,
            (SELECT COUNT(*) FROM stock_entries WHERE auth_id = a.id) AS entries_count
     FROM pickup_authorizations a
     LEFT JOIN purchase_orders po ON a.po_id = po.id
     LEFT JOIN suppliers s ON po.supplier_id = s.id
     WHERE DATE(a.issued_at) = ? OR DATE(a.pickup_date) = ?
     ORDER BY a.issued_at DESC`,
    [date, date]
  );

  // Fetch detailed items for category breakdown
  const authIds = rows.map((r) => r.id);
  const items = authIds.length
    ? await mysql.query(
        `SELECT auth_id, product_name, qty_to_pickup, unit
         FROM pickup_auth_items WHERE auth_id IN (${authIds.map(() => "?").join(",")})`,
        authIds
      )
    : [];

  // Categorize
  const cats = { Sementes: 0, "Químicos": 0, Sacos: 0, Outros: 0 };
  const bySupplier = {};
  items.forEach((it) => {
    const q = Number(it.qty_to_pickup) || 0;
    const name = String(it.product_name || "").toLowerCase();
    if (/milho|feij|arroz|maize|bean|rice|seed/.test(name)) cats.Sementes += q;
    else if (/emamectin|imidaclop|mcpa/.test(name)) cats["Químicos"] += q;
    else if (/saco|hermetic/.test(name)) cats.Sacos += q;
    else cats.Outros += q;
  });
  rows.forEach((r) => {
    const sup = r.supplier_name || "—";
    if (!bySupplier[sup]) bySupplier[sup] = { trucks: 0, qty: 0 };
    bySupplier[sup].trucks++;
    bySupplier[sup].qty += Number(r.total_qty) || 0;
  });

  const total_qty = rows.reduce((s, r) => s + (Number(r.total_qty) || 0), 0);
  res.json({
    date,
    trucks: rows,
    summary: {
      count: rows.length,
      total_qty,
      by_status: {
        issued:     rows.filter((r) => r.status === "issued").length,
        in_transit: rows.filter((r) => r.status === "in_transit").length,
        received:   rows.filter((r) => r.status === "received" || r.entries_count > 0).length,
        cancelled:  rows.filter((r) => r.status === "cancelled").length,
      },
      by_category: cats,
      by_supplier: Object.entries(bySupplier).map(([name, v]) => ({ supplier: name, ...v }))
        .sort((a, b) => b.qty - a.qty),
    },
  });
}));

// ════════════════════════════════════════════════════════════
// DISTRIBUIÇÃO — saldo / serviços / camiões em trânsito
// ════════════════════════════════════════════════════════════
const distUploadDir = path.join(UPLOAD_DIR, "distribution");
if (!fs.existsSync(distUploadDir)) fs.mkdirSync(distUploadDir, { recursive: true });
const distUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, distUploadDir),
    filename: (_req, file, cb) => {
      const ts = Date.now();
      const safe = file.originalname.replace(/[^a-zA-Z0-9.\-_ ()]/g, "_");
      cb(null, `${ts}_${safe}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// ── Pages (HTML) ────────────────────────────────────────────
router.get("/distribuicao",        (_req, res) => send(res, "distribuicao.html"));
router.get("/guias-pdf",           (_req, res) => send(res, "guias-pdf.html"));
router.get("/servicos",              (_req, res) => send(res, "servicos.html"));
router.get("/servicos/:id",          (_req, res) => send(res, "servico-detalhe.html"));
router.get("/servicos/:id/roteiro",  (_req, res) => send(res, "servico-roteiro.html"));
router.get("/camioes",             (_req, res) => send(res, "camioes.html"));
router.get("/beneficiarios",       (_req, res) => send(res, "beneficiarios.html"));
router.get("/beneficiarios/:id",   (_req, res) => send(res, "beneficiario-detalhe.html"));
router.get("/anexar-guias",        (_req, res) => send(res, "anexar-guias.html"));
router.get("/reconciliacao",       (_req, res) => send(res, "reconciliacao.html"));
router.get("/aprovacoes",          (_req, res) => send(res, "aprovacoes.html"));
router.get("/relatorio-provincias", (_req, res) => send(res, "relatorio-provincias.html"));

// ── API ─────────────────────────────────────────────────────
router.get("/api/distribution/geography", ah(async (_req, res) => {
  res.json(await Beneficiaries.geography());
}));

router.get("/api/distribution/beneficiaries", ah(async (req, res) => {
  const { province, district, search, kind, sku } = req.query;
  const rows = await Beneficiaries.list({ province, district, search, kind, sku });
  res.json({ rows });
}));

// Lista de produtos distintos (sku + nome) para popular dropdown de filtro.
router.get("/api/distribution/products", ah(async (_req, res) => {
  res.json({ rows: await Beneficiaries.listProducts() });
}));

// Lista de origens (fornecedores) usadas em serviços, para popular o
// datalist de autocomplete na criação de serviço. Combina:
//  1. delivery_services.origem_supplier (já em uso pelo admin)
//  2. cache do Google Sheet (Origem das linhas TRANSITO/FINALIZADO)
// Deduplicado por nome canónico (trim + agrupado case-insensitive,
// nome de exibição = variação mais frequente).
router.get("/api/distribution/origens", ah(async (_req, res) => {
  const { query } = require("../db/mysql");
  const dbRows = await query(
    `SELECT origem_supplier AS name, COUNT(*) AS n
     FROM delivery_services
     WHERE origem_supplier IS NOT NULL AND origem_supplier <> ''
     GROUP BY origem_supplier`
  );
  // Adicional: contagens da Google Sheet (sheetCache compartilhado).
  let sheetSource = [];
  try {
    const sheetCache = require("../lib/sheet-cache");
    const map = new Map();
    for (const r of (sheetCache.cache.data || [])) {
      const o = String(r.supplier || "").trim();
      if (o) map.set(o, (map.get(o) || 0) + 1);
    }
    sheetSource = [...map.entries()].map(([name, n]) => ({ name, n }));
  } catch (_) { /* sem cache, ignora */ }

  // Normaliza um nome para chave de agrupamento. Remove case, acentos,
  // pontuação e sufixos comerciais comuns ("LDA", "S.A.", "Pty",
  // "Moçambique", "Tenders") iterativamente. Assim BAYER ≡ BAYER Moçambique
  // LDA, SeedCo ≡ SEEDCO, "AGT Foods Africa Pty, Lda" ≡ "AGT Foods Africa
  // Pty, Lda" (variação espaços).
  // Aliases manuais para casos onde a normalização pattern-based não chega.
  // Mapeia chave normalizada → chave canónica. Pode ser estendido conforme
  // o operador identifica equivalências.
  const ALIAS = {
    "mozseeds":         "mozseed",
    "mozambique seeds": "mozseed",
    "mozambique seed":  "mozseed",
  };

  const normalizeKey = (name) => {
    let s = String(name || "")
      .toLowerCase()
      .normalize("NFD").replace(/[̀-ͯ]/g, "")  // remove acentos
      .replace(/[,\.\-]/g, " ")                           // pontuação → espaços
      .replace(/\s+/g, " ")
      .trim();
    const SUFFIXES = [
      /\s+tenders?\s*$/, /\s+lda\.?\s*$/, /\s+ltda\.?\s*$/,
      /\s+s\s?a\s*$/,    /\s+ei\s*$/,      /\s+pty\s*$/,
      /\s+mocambique\s*$/, /\s+mozambique\s*$/,
      /\s+africa\s*$/,   // ex: "AGT Foods Africa" → "AGT Foods"
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const re of SUFFIXES) {
        const ns = s.replace(re, "").trim();
        if (ns !== s && ns.length > 0) { s = ns; changed = true; }
      }
    }
    // Remove conectores entre palavras (do, da, de, dos, das, del, della).
    // "Sementes do Limpopo" → "Sementes Limpopo".
    s = s.replace(/\b(do|da|de|dos|das|del|della)\b/g, " ")
         .replace(/\s+/g, " ").trim();
    // Aplica alias se houver mapeamento explícito
    if (ALIAS[s]) s = ALIAS[s];
    return s;
  };

  // Agrupar pela chave normalizada. Cada grupo guarda contagens por variação
  // para depois escolher a variação mais frequente (e mais curta) como display.
  const groups = new Map(); // key=normalized → { variantCounts: Map, n }
  const add = (name, n) => {
    if (!name) return;
    const key = normalizeKey(name);
    if (!key) return;
    const g = groups.get(key) || { variantCounts: new Map(), n: 0 };
    g.n += Number(n) || 0;
    g.variantCounts.set(name, (g.variantCounts.get(name) || 0) + (Number(n) || 0));
    groups.set(key, g);
  };
  for (const r of dbRows)       add(r.name, r.n);
  for (const r of sheetSource)  add(r.name, r.n);

  // Para cada grupo, escolhe display = variação mais usada
  // (em empate: a mais curta, depois a com capitalização mista).
  const score = (variant) => {
    const isMixed = /[a-z]/.test(variant) && /[A-Z]/.test(variant) ? 1 : 0;
    return { mixed: isMixed, len: variant.length };
  };
  const rows = [...groups.values()]
    .map((g) => {
      const variants = [...g.variantCounts.entries()]
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];               // maior count
          const sa = score(a[0]), sb = score(b[0]);
          if (sa.mixed !== sb.mixed) return sb.mixed - sa.mixed; // mixed-case primeiro
          return sa.len - sb.len;                                // mais curta primeiro
        });
      const [displayName] = variants[0];
      const variations = variants.slice(1).map(([v]) => v);
      return { name: displayName, n: g.n, variations };
    })
    .sort((a, b) => b.n - a.n);
  res.json({ rows });
}));

router.get("/api/distribution/beneficiaries/:id", ah(async (req, res) => {
  const profile = await Beneficiaries.profile(req.params.id);
  if (!profile) return jsonError(res, 404, "Beneficiário não encontrado");
  res.json(profile);
}));

// Busca global: pesquisa em paralelo benefs (nome/NUIT/ID), serviços
// (Nº/ADSN/GTU), matrículas. Devolve até 5 hits por categoria.
router.get("/api/distribution/search", ah(async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q || q.length < 2) return res.json({ beneficiaries: [], services: [], plates: [] });
  const { query } = require("../db/mysql");
  const like = "%" + q + "%";
  const [benefs, services, plates] = await Promise.all([
    query(
      `SELECT extensionist_id, nuit, name, province, district,
              CASE WHEN extensionist_id LIKE 'EXT-%' THEN 1 ELSE 0 END AS is_extra
       FROM beneficiaries
       WHERE name LIKE ? OR nuit LIKE ? OR extensionist_id LIKE ?
       ORDER BY name LIMIT 8`,
      [like, like, like]
    ),
    query(
      `SELECT s.id, s.service_number, s.status, s.province, s.district,
              s.truck_plate, s.total_kg, s.created_at
       FROM delivery_services s
       WHERE s.service_number LIKE ?
          OR EXISTS (
            SELECT 1 FROM delivery_service_items i
            WHERE i.service_id = s.id AND (i.external_adsn LIKE ? OR i.external_gtu LIKE ?)
          )
       ORDER BY s.created_at DESC LIMIT 8`,
      [like, like, like]
    ),
    query(
      `SELECT DISTINCT truck_plate, COUNT(*) AS n_services, MAX(created_at) AS last_used
       FROM delivery_services
       WHERE truck_plate LIKE ? OR truck_plate_2 LIKE ?
       GROUP BY truck_plate
       ORDER BY last_used DESC LIMIT 5`,
      [like, like]
    ),
  ]);
  res.json({ beneficiaries: benefs, services, plates });
}));

router.get("/api/distribution/balances", ah(async (req, res) => {
  const { province, district, sku, only_available } = req.query;
  const rows = await Balances.list({
    province, district, sku,
    onlyAvailable: only_available === "1",
    limit: req.query.limit,
  });
  res.json({ rows });
}));

router.get("/api/distribution/summary", ah(async (req, res) => {
  const { province, district, sku } = req.query;
  res.json(await Balances.summary({ province, district, sku }));
}));

// Cria um serviço de entrega.
// Body: { province, district, truck_capacity_kg, truck_plate, truck_plate_2,
//         driver_name, driver_phone, origem_supplier, notes,
//         items: [{extensionist_id, sku, qty}] }
router.post("/api/distribution/services", express.json(), auth.requireRole("operator", "admin", "superadmin"), ah(async (req, res) => {
  const { items, ...svc } = req.body || {};
  if (!Array.isArray(items) || !items.length) return jsonError(res, 400, "Pelo menos um item é obrigatório");
  try {
    const result = await DistServices.create(svc, items, req.user?.id);
    if (result.error) return res.status(400).json(result);
    await auth.logAction(req, "create", "delivery_service", result.service_id, JSON.stringify({
      service_number: result.service_number, items: items.length, total_kg: result.total_kg,
    }));
    // Auto-aprovação: se quem criou já é admin/superadmin, não faz sentido
    // entrar em fila para "aprovação admin". Aprova-se automaticamente com
    // o user_id do criador. Operadores continuam a precisar de aprovação
    // explícita acima do threshold.
    const role = req.user?.role;
    if (result.approval_status === "pending" && (role === "admin" || role === "superadmin")) {
      const ar = await DistServices.approve(result.service_id, req.user.id, "Auto-aprovado (criado por " + role + ")");
      if (ar.ok) {
        result.approval_status = "approved";
        await auth.logAction(req, "approve", "delivery_service", result.service_id, "auto-aprovado (criador é " + role + ")");
      }
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

// IMPORTANTE: rotas estáticas (pending-approval, bulk/*) ANTES da
// paramétrica /:id — caso contrário Express casa "pending-approval" ou
// "bulk" como :id e a chamada acaba a falhar com "Serviço não existe".
router.get("/api/distribution/services/pending-approval", ah(async (_req, res) => {
  res.json({ rows: await DistServices.listPendingApproval() });
}));

router.get("/api/distribution/services", ah(async (req, res) => {
  const result = await DistServices.list(req.query);
  const counts = await DistServices.dashboardCounts();
  // Compat: se for paginado (objecto), retorna {rows, total, ...}; se for array (modo legado), embrulha em {rows}
  if (Array.isArray(result)) res.json({ rows: result, counts });
  else res.json({ ...result, counts });
}));

// ── Bulk operations ────────────────────────────────────────
// Têm de estar ANTES das rotas paramétricas /:id/X (linha ~1500), senão
// Express captura "bulk" como :id e os handlers /:id/in-transit, /:id/cancel
// e /:id/approve são chamados em vez destes — resultando em "Serviço não
// existe" (preflightCheck não encontra serviço com id="bulk").
router.post("/api/distribution/services/bulk/deliver",
  express.json(),
  auth.requireRole("operator", "admin", "superadmin"),
  ah(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return jsonError(res, 400, "Nenhum serviço seleccionado");
    const result = await DistServices.bulkSetDelivered(ids);
    await auth.logAction(req, "bulk_deliver", "delivery_service", null,
      JSON.stringify({ count: ids.length, ok: result.ok.length, failed: result.failed.length }));
    res.json(result);
  })
);

router.post("/api/distribution/services/bulk/cancel",
  express.json(),
  auth.requireRole("admin", "superadmin"),
  ah(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return jsonError(res, 400, "Nenhum serviço seleccionado");
    const opts = { category: req.body?.category, reason: req.body?.reason };
    const result = await DistServices.bulkCancel(ids, opts);
    await auth.logAction(req, "bulk_cancel", "delivery_service", null,
      JSON.stringify({ count: ids.length, ok: result.ok.length, failed: result.failed.length, ...opts }));
    res.json(result);
  })
);

// Bulk approve — aprovar N serviços pendentes de uma vez (admin+)
router.post("/api/distribution/services/bulk/approve",
  express.json(),
  auth.requireRole("admin", "superadmin"),
  ah(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return jsonError(res, 400, "Nenhum serviço seleccionado");
    const result = await DistServices.bulkApprove(ids, req.user?.id, req.body?.notes);
    await auth.logAction(req, "bulk_approve", "delivery_service", null,
      JSON.stringify({ count: ids.length, ok: result.ok.length, failed: result.failed.length }));
    res.json(result);
  })
);

// Bulk in-transit — pôr N serviços em trânsito de uma vez
router.post("/api/distribution/services/bulk/in-transit",
  express.json(),
  auth.requireRole("operator", "admin", "superadmin"),
  ah(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (!ids.length) return jsonError(res, 400, "Nenhum serviço seleccionado");
    // Auto-aprovar todos os pending desta lista se o utilizador é admin+,
    // antes de bulk in-transit (cobre o caso "estava pendente, agora vou pôr todos a andar")
    const role = req.user?.role;
    if (role === "admin" || role === "superadmin") {
      const { query: q } = require("../db/mysql");
      const placeholders = ids.map(() => "?").join(",");
      const pending = await q(
        `SELECT id FROM delivery_services WHERE id IN (${placeholders}) AND approval_status = 'pending'`,
        ids
      );
      for (const p of pending) {
        await DistServices.approve(p.id, req.user.id, "Auto-aprovado em bulk in-transit (utilizador é " + role + ")");
        await auth.logAction(req, "approve", "delivery_service", p.id, "auto-aprovado em bulk in-transit");
      }
    }
    const result = await DistServices.bulkSetInTransit(ids, { force: req.body?.force });
    await auth.logAction(req, "bulk_in_transit", "delivery_service", null,
      JSON.stringify({ count: ids.length, ok: result.ok.length, failed: result.failed.length, needs_confirm: result.needs_confirm.length }));
    res.json(result);
  })
);

router.get("/api/distribution/services/:id", ah(async (req, res) => {
  const svc = await DistServices.byId(req.params.id);
  if (!svc) return jsonError(res, 404, "Serviço não encontrado");
  res.json(svc);
}));

// Roteiro do motorista — versão com detalhes de cada benef (contacto, posto,
// supervisor) para imprimir/PDF. Items agrupados por beneficiário.
router.get("/api/distribution/services/:id/roteiro", ah(async (req, res) => {
  const svc = await DistServices.byIdForRoteiro(req.params.id);
  if (!svc) return jsonError(res, 404, "Serviço não encontrado");
  res.json(svc);
}));

router.patch("/api/distribution/services/:id", express.json(), auth.requireRole("operator", "admin", "superadmin"), ah(async (req, res) => {
  const result = await DistServices.update(req.params.id, req.body || {});
  if (result.error) return res.status(400).json(result);
  await auth.logAction(req, "update", "delivery_service", req.params.id, JSON.stringify(req.body));
  res.json(result);
}));

router.get("/api/distribution/services/:id/preflight", ah(async (req, res) => {
  const result = await DistServices.preflightCheck(req.params.id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
}));

router.post("/api/distribution/services/:id/in-transit", express.json(), auth.requireRole("operator", "admin", "superadmin"), ah(async (req, res) => {
  // Se admin/superadmin tenta pôr em trânsito um serviço com aprovação
  // pendente, auto-aprova primeiro (eles têm autoridade para aprovar). Cobre
  // serviços antigos que ficaram em pending antes do auto-approve no create.
  const role = req.user?.role;
  if (role === "admin" || role === "superadmin") {
    const { query: q } = require("../db/mysql");
    const [svc] = await q("SELECT approval_status FROM delivery_services WHERE id = ?", [req.params.id]);
    if (svc && svc.approval_status === "pending") {
      await DistServices.approve(req.params.id, req.user.id, "Auto-aprovado em setInTransit (utilizador é " + role + ")");
      await auth.logAction(req, "approve", "delivery_service", req.params.id, "auto-aprovado em setInTransit");
    }
  }
  const result = await DistServices.setInTransit(req.params.id, req.body || {});
  if (result.error) return res.status(400).json(result);
  if (result.needs_confirm) return res.status(409).json(result);
  await auth.logAction(req, "in_transit", "delivery_service", req.params.id);
  res.json(result);
}));

router.post("/api/distribution/services/:id/delivered", express.json(), auth.requireRole("operator", "admin", "superadmin"), ah(async (req, res) => {
  const result = await DistServices.setDelivered(req.params.id);
  if (result.error) return res.status(400).json(result);
  await auth.logAction(req, "delivered", "delivery_service", req.params.id);
  res.json(result);
}));

// Aprovação: aprovar/rejeitar (listagem está acima, antes do :id)
router.post("/api/distribution/services/:id/approve",
  express.json(), auth.requireRole("admin", "superadmin"),
  ah(async (req, res) => {
    const r = await DistServices.approve(req.params.id, req.user?.id, req.body?.notes);
    if (r.error) return res.status(400).json(r);
    await auth.logAction(req, "approve", "delivery_service", req.params.id, req.body?.notes);
    res.json(r);
  })
);

router.post("/api/distribution/services/:id/reject",
  express.json(), auth.requireRole("admin", "superadmin"),
  ah(async (req, res) => {
    const r = await DistServices.reject(req.params.id, req.user?.id, req.body?.reason);
    if (r.error) return res.status(400).json(r);
    await auth.logAction(req, "reject", "delivery_service", req.params.id, req.body?.reason);
    res.json(r);
  })
);

// Audit log granular por serviço (Fase 12)
router.get("/api/distribution/services/:id/audit", ah(async (req, res) => {
  const { query } = require("../db/mysql");
  const rows = await query(
    `SELECT a.id, a.action, a.details, a.ip, a.created_at,
            u.name AS user_name, u.email AS user_email, u.role AS user_role
     FROM audit_log a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.entity_type = 'delivery_service' AND a.entity_id = ?
     ORDER BY a.created_at DESC LIMIT 200`,
    [req.params.id]
  );
  res.json({ rows });
}));

router.post("/api/distribution/services/:id/cancel", express.json(), auth.requireRole("admin", "superadmin"), ah(async (req, res) => {
  const result = await DistServices.cancel(req.params.id, req.body || {});
  if (result.error) return res.status(400).json(result);
  await auth.logAction(req, "cancel", "delivery_service", req.params.id, JSON.stringify(req.body || {}));
  res.json(result);
}));

// ── Relatórios de distribuição ─────────────────────────────────────────
// GET /admin/api/distribution/report/by-province
//   ?from=YYYY-MM-DD &to=YYYY-MM-DD &status=delivered|committed &sku=XYZ &province=Tete
router.get("/api/distribution/report/by-province", ah(async (req, res) => {
  const opts = {
    from: req.query.from || null,
    to: req.query.to || null,
    status: req.query.status || "delivered",
    sku: req.query.sku || null,
    province: req.query.province || null,
    district: req.query.district || null,
  };
  res.json(await DistReports.byProvince(opts));
}));

// Drill-down: distritos dentro duma província
router.get("/api/distribution/report/by-district", ah(async (req, res) => {
  if (!req.query.province) return res.status(400).json({ error: "province obrigatória" });
  const opts = {
    from: req.query.from || null,
    to: req.query.to || null,
    status: req.query.status || "delivered",
    sku: req.query.sku || null,
  };
  res.json({ rows: await DistReports.byDistrict(req.query.province, opts) });
}));

// Lista de categorias de cancelamento (para popular dropdown na UI)
router.get("/api/distribution/cancel-categories", ah(async (_req, res) => {
  res.json({ categories: DistServices.CANCEL_CATEGORIES });
}));

router.get("/api/distribution/in-transit", ah(async (_req, res) => {
  res.json({ rows: await DistServices.inTransit() });
}));

// Resumo agregado da frota — aceita os mesmos filtros que /services.
router.get("/api/distribution/fleet-summary", ah(async (req, res) => {
  res.json(await DistServices.fleetSummary(req.query));
}));

// Dashboard agregado — para o /admin home
router.get("/api/distribution/dashboard", ah(async (_req, res) => {
  res.json(await DistServices.dashboard());
}));

router.get("/api/distribution/by-plate", ah(async (req, res) => {
  const plate = String(req.query.plate || "").trim();
  if (!plate) return res.json({ rows: [] });
  res.json({ rows: await DistServices.byPlate(plate) });
}));

// ── Bootstrap (importação dos 2 Excels) ─────────────────────
router.post("/api/distribution/bootstrap/planning",
  auth.requireRole("admin", "superadmin"),
  distUpload.single("file"),
  ah(async (req, res) => {
    if (!req.file) return jsonError(res, 400, "Ficheiro não fornecido");
    try {
      const result = await importPlanning(req.file.path);
      await auth.logAction(req, "import_planning", "delivery_balances", null, JSON.stringify(result));
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  })
);

router.post("/api/distribution/bootstrap/services",
  auth.requireRole("admin", "superadmin"),
  distUpload.single("file"),
  ah(async (req, res) => {
    if (!req.file) return jsonError(res, 400, "Ficheiro não fornecido");
    try {
      const result = await importServices(req.file.path);
      await auth.logAction(req, "import_services", "delivery_services", null, JSON.stringify(result));
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  })
);

// Service → Excel: pega num serviço criado na plataforma e exporta o
// mesmo formato Excel que a página /admin/guias-pdf produz a partir de
// PDFs. Útil quando ainda não tens o PDF da ADICIONAL mas já tens o
// serviço criado e queres preparar o Excel para enviar.
//
// Nota: como o serviço foi criado internamente (sem ADSN/GTU vindos do
// sistema da ADICIONAL), as colunas "Código Serviço" e "GTU/GTS" ficam
// VAZIAS — preenches-as depois quando vier a guia oficial.
router.get("/api/distribution/services/:id/guias-excel",
  ah(async (req, res) => {
    const svc = await DistServices.byIdForRoteiro(req.params.id);
    if (!svc) return jsonError(res, 404, "Serviço não encontrado");
    // byIdForRoteiro retorna `beneficiaries` (agrupado), não `items`.
    // Re-achatamos para uma lista de items, anotados com info do beneficiário.
    const flatItems = [];
    for (const b of (svc.beneficiaries || [])) {
      for (const it of (b.items || [])) {
        flatItems.push({
          sku: it.sku,
          product_name: it.product_name,
          qty: Number(it.qty) || 0,
          unit: it.unit,
          beneficiary_name: b.beneficiary_name,
          nuit: b.nuit,
          contact: b.contact,
          district: b.district || svc.district,
          province: b.province || svc.province,
        });
      }
    }
    if (!flatItems.length) {
      return jsonError(res, 400, "Serviço não tem itens — nada para exportar.");
    }

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.creator = "AQI Dashboard — Service→Excel";
    wb.created = new Date();
    const ws = wb.addWorksheet("Guias");
    ws.columns = [
      { header: "Código Serviço",     key: "adsn",      width: 24 },
      { header: "Nome Extensionista", key: "nome",      width: 32 },
      { header: "Telf Extensionista", key: "tel",       width: 14 },
      { header: "NUIT",               key: "nuit",      width: 12 },
      { header: "Matrícula",          key: "matricula", width: 16 },
      { header: "Artigo",             key: "artigo",    width: 14 },
      { header: "GTU/GTS",            key: "gtu",       width: 18 },
      { header: "Distrito",           key: "distrito",  width: 18 },
      { header: "Volumes (kg)",       key: "volumes",   width: 14 },
      { header: "Peso (kg)",          key: "peso",      width: 14 },
    ];
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true };
      c.alignment = { horizontal: "center" };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      c.border = { bottom: { style: "thin", color: { argb: "FF94A3B8" } } };
    });

    // Sacos hermeticos = 0,145 kg/un. Para os outros (kg/L) volume = peso = qty.
    const SACO_KG = 0.145;
    let totalVolumes = 0, totalPeso = 0;

    for (const it of flatItems) {
      const isSaco = it.sku === "SUSSACO" || /saco|hermet/i.test(it.product_name || "");
      const qty = Number(it.qty) || 0;
      const volumes = isSaco ? qty : qty;               // unidade do item (un ou kg)
      const peso    = isSaco ? qty * SACO_KG : qty;     // sempre em kg-equivalente

      // Artigo no formato AQI: "MILHO KG", "FEIJAO KG", etc.
      // Normalizamos do product_name: maiúsculas, remove acentos.
      const artigoBase = (it.product_name || it.sku || "")
        .toUpperCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "");
      const artigoSuffix = it.unit ? " " + (it.unit === "un" ? "UN" : it.unit.toUpperCase()) : "";
      const artigo = artigoBase + artigoSuffix;

      ws.addRow({
        adsn:      "",                                   // ainda sem ADSN
        nome:      it.beneficiary_name || "",
        tel:       it.contact || "",
        nuit:      it.nuit || "",
        matricula: svc.truck_plate || "",
        artigo:    artigo,
        gtu:       "",                                   // ainda sem GTU
        distrito:  String(it.district || svc.district || "").toUpperCase(),
        volumes,
        peso,
      });
      totalVolumes += volumes;
      totalPeso += peso;
    }

    // Linha TOTAL no fim (estilo do exemplo)
    const totalRow = ws.addRow({ adsn: "TOTAL", volumes: totalVolumes, peso: totalPeso });
    totalRow.eachCell((c) => { c.font = { bold: true }; });
    totalRow.getCell("adsn").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };

    const safeName = String(svc.service_number).replace(/[^a-zA-Z0-9_-]/g, "_");
    const outName = `guias_${safeName}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    await wb.xlsx.write(res);
    res.end();

    await auth.logAction(req, "service_to_excel", "delivery_service", svc.id,
      JSON.stringify({ service_number: svc.service_number, items: svc.items.length }));
  })
);

// PDF → Excel: extrai todas as guias do PDF (ADICIONAL Guia Transporte) e
// devolve um Excel com a tabela "Guias" no formato que a equipa AQI usa.
// Aceita 1 PDF; pode aceitar N e concatenar resultados (todas as guias num
// só Excel) — útil para múltiplos camiões/dias.
//
// Body: multipart com campo "files" (1 ou N PDFs)
// Response: ficheiro .xlsx para download (não JSON)
router.post("/api/distribution/guias-pdf-to-excel",
  auth.requireRole("viewer", "operator", "admin", "superadmin"),
  distUpload.array("files", 20),
  ah(async (req, res) => {
    if (!req.files || !req.files.length) return jsonError(res, 400, "Nenhum PDF fornecido");
    const fs = require("fs");

    // 1. Parse cada PDF e agrega deliveries
    const allDeliveries = [];
    const fileSummary = [];
    for (const f of req.files) {
      try {
        const buf = fs.readFileSync(f.path);
        const result = await parseAdicionalGuia(buf);
        for (const d of (result.deliveries || [])) {
          allDeliveries.push({ ...d, _source_file: f.originalname });
        }
        fileSummary.push({
          file: f.originalname,
          deliveries: result.deliveries.length,
          warnings: result.warnings.length,
        });
      } catch (e) {
        fileSummary.push({ file: f.originalname, error: e.message });
      } finally {
        try { fs.unlinkSync(f.path); } catch (_) { /* ignore */ }
      }
    }

    if (!allDeliveries.length) {
      return jsonError(res, 400, "Nenhuma guia (ADSN) detectada nos PDFs. Verifica se o ficheiro é a Guia Transporte ADICIONAL.");
    }

    // 2. Construir Excel no formato igual ao guias_*.xlsx do utilizador
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    wb.creator = "AQI Dashboard — PDF→Excel";
    wb.created = new Date();
    const ws = wb.addWorksheet("Guias");
    ws.columns = [
      { header: "Código Serviço",     key: "adsn",      width: 24 },
      { header: "Nome Extensionista", key: "nome",      width: 32 },
      { header: "Telf Extensionista", key: "tel",       width: 14 },
      { header: "NUIT",               key: "nuit",      width: 12 },
      { header: "Matrícula",          key: "matricula", width: 16 },
      { header: "Artigo",             key: "artigo",    width: 14 },
      { header: "GTU/GTS",            key: "gtu",       width: 18 },
      { header: "Distrito",           key: "distrito",  width: 18 },
      { header: "Volumes (kg)",       key: "volumes",   width: 14 },
      { header: "Peso (kg)",          key: "peso",      width: 14 },
    ];
    // Estilo header
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true };
      c.alignment = { horizontal: "center" };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      c.border = { bottom: { style: "thin", color: { argb: "FF94A3B8" } } };
    });

    // 3. Adicionar linhas — distrito em UPPERCASE para casar com formato AQI
    let totalVolumes = 0, totalPeso = 0;
    for (const d of allDeliveries) {
      ws.addRow({
        adsn:      d.adsn || "",
        nome:      d.destinatario || "",
        tel:       d.telefone_destinatario || "",
        nuit:      d.nuit || "",
        matricula: d.matricula || "",
        artigo:    d.sku_label || "",
        gtu:       d.gtu || "",
        distrito:  (d.distrito || "").toUpperCase(),
        volumes:   d.volumes || d.qty || 0,
        peso:      d.peso || d.qty || 0,
      });
      totalVolumes += Number(d.volumes || d.qty || 0);
      totalPeso += Number(d.peso || d.qty || 0);
    }
    // Linha TOTAL no fim (estilo do exemplo)
    const totalRow = ws.addRow({
      adsn: "TOTAL",
      volumes: totalVolumes,
      peso: totalPeso,
    });
    totalRow.eachCell((c) => { c.font = { bold: true }; });
    totalRow.getCell("adsn").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEF3C7" } };

    // 4. Nome do ficheiro: deriva do 1º ficheiro (ou genérico)
    const baseName = req.files.length === 1
      ? req.files[0].originalname.replace(/\.pdf$/i, "")
      : `guias_extraidas_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
    const outName = `guias_${baseName.replace(/[^a-zA-Z0-9_-]/g, "_")}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);
    await wb.xlsx.write(res);
    res.end();

    // Audit log
    await auth.logAction(req, "guias_pdf_to_excel", null, null,
      JSON.stringify({ files: fileSummary, total_deliveries: allDeliveries.length }));
  })
);

// Multi-PDF upload — auto-routes cada PDF para o serviço em trânsito
// que tenha matching truck_plate (ou primeiro hit por match parcial).
router.post("/api/distribution/attach-guias-bulk",
  auth.requireRole("operator", "admin", "superadmin"),
  distUpload.array("files", 50),
  ah(async (req, res) => {
    if (!req.files || !req.files.length) return jsonError(res, 400, "Nenhum PDF fornecido");
    const fs = require("fs");
    const { parseGuia: parseAdicionalGuia } = require("../lib/parse-adicional-guia");
    const results = [];

    // Carrega serviços in_transit + delivered uma vez
    const candidates = await DistServices.list({ status: undefined, limit: 5000 });
    const candArray = Array.isArray(candidates) ? candidates : (candidates.rows || []);
    const candByPlate = new Map();
    candArray.forEach((s) => {
      if (s.truck_plate) {
        const k = s.truck_plate.replace(/\s+/g, "").toUpperCase();
        if (!candByPlate.has(k)) candByPlate.set(k, []);
        candByPlate.get(k).push(s);
      }
    });

    for (const file of req.files) {
      try {
        const buf = fs.readFileSync(file.path);
        const parsed = await parseAdicionalGuia(buf);
        const pdfPlate = (parsed.deliveries[0]?.matricula || "").replace(/\s+/g, "").toUpperCase();
        // Match: plate exacta primeiro, depois parcial
        let svc = null;
        if (pdfPlate) {
          const exact = candByPlate.get(pdfPlate);
          if (exact?.length) svc = exact.find((s) => s.status === "in_transit") || exact[0];
          if (!svc) {
            // parcial — primeira plate em candidatos cuja primeira placa está contida no pdf
            for (const [k, arr] of candByPlate.entries()) {
              if (pdfPlate.includes(k.split("/")[0]) || k.includes(pdfPlate.split("/")[0])) {
                svc = arr.find((s) => s.status === "in_transit") || arr[0]; break;
              }
            }
          }
        }
        if (!svc) {
          results.push({ file: file.originalname, error: "Nenhum serviço com matrícula matching", pdf_plate: pdfPlate });
          continue;
        }
        const r = await DistServices.attachGuiaDeliveries(svc.id, parsed.deliveries, { aggregator: parsed.aggregator });
        results.push({
          file: file.originalname,
          service_id: svc.id,
          service_number: svc.service_number,
          plate: svc.truck_plate,
          matched: r.matched.length,
          unmatched: r.unmatched.length,
          skipped: r.skipped_status.length,
        });
      } catch (e) {
        results.push({ file: file.originalname, error: e.message });
      }
    }

    await auth.logAction(req, "attach_guias_bulk", "delivery_service", null,
      JSON.stringify({ files: req.files.length, ok: results.filter((r) => !r.error).length }));
    res.json({ results });
  })
);

// Reconciliação: cruza GTUs do Google Sheet com nossos service_items
router.get("/api/distribution/reconcile-gtu", ah(async (_req, res) => {
  const sheetRows = sheetCache.cache.data || [];
  const result = await DistReconciliation.vsSheet(sheetRows);
  res.json({
    ...result,
    sheet_last_updated: sheetCache.cache.lastUpdated,
    sheet_total_rows: sheetRows.length,
  });
}));

// Anexar Guia ADICIONAL (PDF) → extrai ADSN+GTU+NUIT e atribui aos items.
// Usa-se DEPOIS do serviço estar em trânsito (operador descarrega PDF do
// sistema da outra empresa).
router.post("/api/distribution/services/:id/attach-guia",
  auth.requireRole("operator", "admin", "superadmin"),
  distUpload.single("file"),
  ah(async (req, res) => {
    if (!req.file) return jsonError(res, 400, "PDF não fornecido");
    const dryRun = req.query.dry_run === "1";
    try {
      const fs = require("fs");
      const buf = fs.readFileSync(req.file.path);
      const parsed = await parseAdicionalGuia(buf);

      if (dryRun) return res.json({ dry_run: true, parsed });

      const result = await DistServices.attachGuiaDeliveries(
        req.params.id,
        parsed.deliveries,
        { aggregator: parsed.aggregator }
      );
      await auth.logAction(req, "attach_guia", "delivery_service", req.params.id,
        JSON.stringify({ matched: result.matched.length, unmatched: result.unmatched.length, file: req.file.originalname }));
      res.json({
        ...result,
        stats: parsed.stats,
        aggregator: parsed.aggregator,
      });
    } catch (e) {
      console.error("[attach-guia] error:", e);
      res.status(500).json({ error: e.message });
    }
  })
);

module.exports = router;
