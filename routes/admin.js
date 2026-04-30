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
const { Beneficiaries, Balances, Services: DistServices } = require("../db/distribution-repo");
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
router.get("/servicos",            (_req, res) => send(res, "servicos.html"));
router.get("/servicos/:id",        (_req, res) => send(res, "servico-detalhe.html"));
router.get("/camioes",             (_req, res) => send(res, "camioes.html"));
router.get("/beneficiarios",       (_req, res) => send(res, "beneficiarios.html"));
router.get("/beneficiarios/:id",   (_req, res) => send(res, "beneficiario-detalhe.html"));

// ── API ─────────────────────────────────────────────────────
router.get("/api/distribution/geography", ah(async (_req, res) => {
  res.json(await Beneficiaries.geography());
}));

router.get("/api/distribution/beneficiaries", ah(async (req, res) => {
  const { province, district, search, kind } = req.query;
  const rows = await Beneficiaries.list({ province, district, search, kind });
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
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}));

router.get("/api/distribution/services", ah(async (req, res) => {
  const rows = await DistServices.list(req.query);
  const counts = await DistServices.dashboardCounts();
  res.json({ rows, counts });
}));

router.get("/api/distribution/services/:id", ah(async (req, res) => {
  const svc = await DistServices.byId(req.params.id);
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

router.post("/api/distribution/services/:id/cancel", express.json(), auth.requireRole("admin", "superadmin"), ah(async (req, res) => {
  const result = await DistServices.cancel(req.params.id, req.body?.reason);
  if (result.error) return res.status(400).json(result);
  await auth.logAction(req, "cancel", "delivery_service", req.params.id, req.body?.reason);
  res.json(result);
}));

router.get("/api/distribution/in-transit", ah(async (_req, res) => {
  res.json({ rows: await DistServices.inTransit() });
}));

// Resumo agregado da frota — aceita os mesmos filtros que /services.
router.get("/api/distribution/fleet-summary", ah(async (req, res) => {
  res.json(await DistServices.fleetSummary(req.query));
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
